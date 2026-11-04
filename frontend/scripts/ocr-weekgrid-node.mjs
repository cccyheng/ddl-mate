// 用 Node 跑"产品里的周视图流水线"（src/ocr/weekGridOcr.js），验证与浏览器同一份实现。
//
// 为什么需要它：本机沙箱禁止启动浏览器（Playwright spawn EPERM），但几何与文本规则是纯函数、
// OCR 引擎在 Node 也能跑，于是用"原始 RGBA 转储 + 假 canvas + 本地 tesseract.js"完整跑一遍
// 产品模块，作为离线证据；真实浏览器验收仍由 Codex 执行。
//
// 与浏览器的差异只有两点：canvas 用假的（把像素存起来），PNG 编码换成 Node 的最小实现。
//
// 用法：
//   node scripts/ocr-weekgrid-node.mjs ..\..\.tools\photo\real.rgba ..\..\.tools\photo\real.json [--expected <json>] [--psm N]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { createWorker } from 'tesseract.js'

import { TESSERACT_PARAMS } from '../src/ocr/ocrConfig.js'
import { recognizeWeekGrid } from '../src/ocr/weekGridOcr.js'

const here = dirname(fileURLToPath(import.meta.url))
const langPath = join(here, '..', 'public', 'tesseract', 'lang')

// ---------------------------------------------------------------- 最小灰度 PNG 编码器
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}
function encodeGrayPng(gray, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- 假 canvas（浏览器里是 <canvas>）
function createFakeCanvas() {
  const canvas = { width: 0, height: 0, gray: null, grayWidth: 0, grayHeight: 0 }
  canvas.getContext = () => ({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: (image) => {
      const gray = new Uint8ClampedArray(image.width * image.height)
      for (let i = 0; i < gray.length; i += 1) gray[i] = image.data[i * 4]
      canvas.gray = gray
      canvas.grayWidth = image.width
      canvas.grayHeight = image.height
    },
  })
  return canvas
}

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2)
const dataPath = argv[0]
const metaPath = argv[1]
const expectedIndex = argv.indexOf('--expected')
const expectedPath = expectedIndex >= 0 ? argv[expectedIndex + 1] : null
const quiet = argv.includes('--quiet')

const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const raw = readFileSync(dataPath)
const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
const imageData = { data, width: meta.width, height: meta.height }

const worker = await createWorker('chi_sim+eng', 1, { langPath, cacheMethod: 'none' })

let ocrCalls = 0
async function recognize(canvas, { psm } = {}) {
  ocrCalls += 1
  await worker.setParameters({ ...TESSERACT_PARAMS, tessedit_pageseg_mode: String(psm || '6') })
  const png = encodeGrayPng(canvas.gray, canvas.grayWidth, canvas.grayHeight)
  const out = await worker.recognize(png, {}, { blocks: true, text: true })
  return out.data
}

const stages = []
const result = await recognizeWeekGrid(imageData, {
  recognize,
  createCanvas: createFakeCanvas,
  onStage: (text, ratio) => stages.push(`${text}(${(ratio * 100).toFixed(0)}%)`),
  isCancelled: () => false,
})
await worker.terminate()

console.log(`matched=${result.matched} week=${result.week ?? '?'} ocrCalls=${ocrCalls}`)
if (result.diagnostics) console.log('diagnostics:', JSON.stringify(result.diagnostics))
if (stages.length) console.log('stages:', stages[0], '…', stages[stages.length - 1])
if (result.reason) console.log('reason:', result.reason)
for (const warning of result.warnings || []) console.log(`  提示：${warning}`)

console.log(`\n候选 ${result.candidates?.length ?? 0} 条：`)
for (const candidate of result.candidates || []) {
  console.log(
    `  周${candidate.weekday ?? '?'} 第${candidate.periodStart ?? '?'}-${candidate.periodEnd ?? '?'}节 ` +
      `${candidate.startTime ?? '??:??'}-${candidate.endTime ?? '??:??'} 起止周${candidate.startWeek ?? '?'}-${candidate.endWeek ?? '?'}(${candidate.weekPattern ?? '-'}) ` +
      `「${candidate.name}」@「${candidate.location ?? ''}」${candidate.warnings?.length ? ' ⚠' + candidate.warnings.length : ''}`,
  )
}

if (expectedPath) {
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  const normalize = (value) =>
    String(value ?? '')
      .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[\s()（）\-—–·、,，.。]/g, '')
      .toLowerCase()
  const candidates = result.candidates || []
  const remaining = [...candidates]
  let nameHits = 0
  let timeHits = 0
  let locationHits = 0
  const details = []
  for (const item of expected.courses) {
    const index = remaining.findIndex(
      (candidate) =>
        candidate.weekday === item.weekday &&
        candidate.periodStart === item.periodStart &&
        normalize(candidate.name) === normalize(item.name),
    )
    if (index < 0) {
      details.push(`  BAD 周${item.weekday} 第${item.periodStart}节 期望「${item.name}」未命中`)
      continue
    }
    const found = remaining.splice(index, 1)[0]
    nameHits += 1
    if (found.startTime === item.startTime && found.endTime === item.endTime) timeHits += 1
    if (normalize(found.location) === normalize(item.location)) locationHits += 1
    details.push(`  OK  周${item.weekday} 第${item.periodStart}节 「${found.name}」`)
  }
  const perWeekday = (list) =>
    [1, 2, 3, 4, 5, 6, 7].map((day) => list.filter((item) => item.weekday === day).length).join('/')
  console.log(
    `\n对照目视抄录（仅报告，不参与识别）：块 ${candidates.length}/${expected.expectedBlockCount}` +
      `（分布 ${perWeekday(candidates)} vs 期望 ${perWeekday(expected.courses)}），` +
      `名称+星期+节次命中 ${nameHits}/${expected.expectedBlockCount}，时刻命中 ${timeHits}，地点命中 ${locationHits}`,
  )
  if (!quiet) console.log(details.join('\n'))
}
