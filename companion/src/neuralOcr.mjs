import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toGray, otsuThreshold } from '../../frontend/src/ocr/imageOps.js'
import { encodeGrayPng } from './imageCodec.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const modelHash = '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'

/** Split detected cells by ink rows. Coordinates always come from the image's table geometry. */
export function extractCellLines(image, cells) {
  const lines = []
  for (const [cellIndex, cell] of cells.entries()) {
    const crop = toGray(image.data, image.width, image.height, {
      x: cell.x0 + 1, y: cell.y0 + 1, width: cell.width - 2, height: cell.height - 2,
    })
    const threshold = otsuThreshold(crop.gray)
    const bands = []
    let start = -1, last = -1
    for (let y = 0; y < crop.height; y++) {
      let ink = 0
      for (let x = 0; x < crop.width; x++) if (crop.gray[y * crop.width + x] <= threshold) ink++
      if (ink > 2 && ink < crop.width * 0.9) {
        if (start < 0) start = y
        last = y
      } else if (start >= 0 && y - last > 1) {
        bands.push([start, last]); start = -1
      }
    }
    if (start >= 0) bands.push([start, last])
    const cellLines = []
    for (const [top, bottom] of bands) {
      if (bottom - top < 4) continue
      let left = crop.width, right = 0
      for (let y = top; y <= bottom; y++) for (let x = 0; x < crop.width; x++) {
        if (crop.gray[y * crop.width + x] <= threshold) { left = Math.min(left, x); right = Math.max(right, x) }
      }
      if (right - left < 5) continue
      const x0 = Math.max(0, left - 2), x1 = Math.min(crop.width, right + 3)
      const y0 = Math.max(0, top - 2), y1 = Math.min(crop.height, bottom + 3)
      const width = x1 - x0, height = y1 - y0
      const gray = new Uint8Array(width * height)
      for (let y = 0; y < height; y++) gray.set(crop.gray.subarray((y0 + y) * crop.width + x0, (y0 + y) * crop.width + x1), y * width)
      const previous = cellLines.at(-1)
      // A very short wrapped suffix is unreliable as a standalone recognition line.
      // Join its pixels to the preceding full-width line; no characters are inferred.
      if (previous && previous.width >= crop.width * 0.75 && width <= crop.width * 0.2 &&
          top - previous.bottom <= height * 1.5 && height >= previous.height * 0.6) {
        const joinedWidth = previous.width + width + 3, joinedHeight = Math.max(height, previous.height)
        const joined = new Uint8Array(joinedWidth * joinedHeight).fill(255)
        for (let y = 0; y < previous.height; y++) joined.set(previous.gray.subarray(y * previous.width, (y + 1) * previous.width), y * joinedWidth)
        for (let y = 0; y < height; y++) joined.set(gray.subarray(y * width, (y + 1) * width), y * joinedWidth + previous.width + 3)
        cellLines[cellLines.length - 1] = { gray: joined, width: joinedWidth, height: joinedHeight, bottom }
      } else cellLines.push({ gray, width, height, bottom })
    }
    for (const line of cellLines) {
      lines.push({ id: String(lines.length), cellIndex, png: encodeGrayPng(line.gray, line.width, line.height).toString('base64') })
      if (lines.length > 1000) throw new Error('Too many text lines')
    }
  }
  return lines
}

/** Optional, explicitly configured local runtime. No downloads or package installation at service startup. */
export function loadNeuralConfig() {
  const directory = join(root, '.tools/neural-ocr')
  try {
    const config = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8'))
    const python = config.python
    const runtime = join(directory, 'runtime')
    const model = join(directory, 'models/ch_PP-OCRv5_rec_mobile.onnx')
    if (typeof python !== 'string' || !existsSync(python) || !existsSync(join(runtime, 'onnxruntime')) || !existsSync(model)) return null
    if (createHash('sha256').update(readFileSync(model)).digest('hex') !== modelHash) return null
    return { python, runtime, model }
  } catch { return null }
}

export async function recognizeCellDetails(config, image, cells, { isCancelled = () => false } = {}) {
  const lines = extractCellLines(image, cells)
  if (!lines.length) return cells.map(() => ({ text: '', confidence: 0 }))
  if (isCancelled()) throw new Error('Recognition cancelled')
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(config.python, ['-I', join(root, 'companion/src/neuralOcr.py'), config.runtime, config.model], {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ORT_DISABLE_TELEMETRY: '1', PYTHONIOENCODING: 'utf-8' },
    })
    const chunks = []
    let size = 0, failed = false
    const stop = (reason) => { if (!failed) { failed = true; child.kill(); reject(new Error(reason)) } }
    const timeout = setTimeout(() => stop('Local text recognition timed out'), 60_000)
    const cancellation = setInterval(() => { if (isCancelled()) stop('Recognition cancelled') }, 100)
    const cleanup = () => { clearTimeout(timeout); clearInterval(cancellation) }
    child.on('error', () => { cleanup(); stop('Local text recognizer unavailable') })
    child.stdin.on('error', () => { /* close/error reports the failure without leaking user text */ })
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 8_000_000) stop('Recognizer response too large'); else chunks.push(chunk) })
    child.stderr.resume()
    child.on('close', code => {
      cleanup()
      if (failed) return
      if (code !== 0) return reject(new Error('Local text recognition failed'))
      try { resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('Invalid local recognition response')) }
    })
    child.stdin.end(JSON.stringify({ lines: lines.map(({ id, png }) => ({ id, png })) }))
  })
  const byId = new Map(result.lines.map(line => [line.id, line]))
  return cells.map((_, cellIndex) => {
    const recognized = lines.filter(line => line.cellIndex === cellIndex).map(line => byId.get(line.id)).filter(Boolean)
    return {
      text: recognized.map(line => line.text).join('\n'),
      confidence: recognized.length ? recognized.reduce((sum, line) => sum + line.confidence, 0) / recognized.length : 0,
    }
  })
}
