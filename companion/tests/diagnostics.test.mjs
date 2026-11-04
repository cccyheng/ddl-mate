/**
 * 本地诊断捕获的边界测试（**默认关闭、只保留最近一次、只写一个目录、不含敏感字段**）。
 *
 * 这些测试保证诊断功能不会"顺手"变成一个新的数据出口，也不会把识别拖坏：
 * - 不显式给目录时，服务行为与以前完全一致，一个文件都不写；
 * - 只有 POST OCR 会更新固定文件（`latest-image.bin` / `latest-response.json` /
 *   `latest-summary.json`），健康检查再多次也不写、不占用；
 * - 无论多少次请求、甚至"重启"（重新创建写入器），目录里永远只有这三个文件；
 * - 捕获内容里不出现 token / 地址 / 凭据这类字段（即使调用方误传）；
 * - 写盘失败（目录不可写）**不能**把一次正常识别变成 500。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { PNG } from 'pngjs'

import { DIAGNOSTICS_FILES, createDiagnostics, redact } from '../src/diagnostics.mjs'
import { createOcrService } from '../src/server.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ddl-diag-'))
}

/** 8×8 的合法 PNG（与 server.test.mjs 里的构造方式一致）。 */
function tinyPngBase64() {
  const png = new PNG({ width: 8, height: 8 })
  for (let i = 0; i < 8 * 8; i += 1) {
    png.data[i * 4] = 200
    png.data[i * 4 + 1] = 200
    png.data[i * 4 + 2] = 200
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png).toString('base64')
}

function tinyPngBuffer() {
  return Buffer.from(tinyPngBase64(), 'base64')
}

const okEngine = {
  async recognizeTimetable() {
    return {
      cancelled: false,
      layout: 'week-grid',
      week: 7,
      candidates: [{ name: '数据结构' }],
      warnings: [],
      diagnostics: { coverage: 0.4 },
      rawText: '数据结构',
      ocrCalls: 3,
      ms: 10,
    }
  },
  async terminate() {},
}

function postOcr(service, requestId = null) {
  return service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ imageBase64: tinyPngBase64() })),
    requestId,
  })
}

test('没有给目录时诊断是关闭的，不会写任何文件', () => {
  const diagnostics = createDiagnostics({ dir: null })
  assert.equal(diagnostics.enabled, false)
  assert.equal(diagnostics.available, false)
  assert.equal(diagnostics.dir, null)
  assert.equal(diagnostics.nextRequestId(), null)
  assert.deepEqual(diagnostics.capture({ requestId: 'x' }), { written: false, reason: 'disabled', available: false })
})

test('只写三个固定文件，并且原图字节按收到的样子保存（无 .tmp 残留）', () => {
  const dir = tempDir()
  try {
    const diagnostics = createDiagnostics({ dir, logger: silentLogger })
    assert.equal(diagnostics.enabled, true)
    assert.equal(diagnostics.available, true)
    const requestId = diagnostics.nextRequestId()
    assert.match(requestId, /^req-\d{4}-\d{2}-\d{2}T[\d-]+Z-\d{3}$/)

    const result = diagnostics.capture({
      requestId,
      imageBytes: Buffer.from([1, 2, 3, 4]),
      image: { width: 2, height: 2, format: 'png', bytes: 4 },
      response: {
        ok: true,
        layout: 'week-grid',
        candidates: [{ name: '形势与政策' }],
        warnings: [],
        diagnostics: { coverage: 0.4 },
        endpoint: 'http://192.168.1.9:8082',
        token: 'secret-value',
      },
    })
    assert.equal(result.written, true)

    const files = readdirSync(dir).sort()
    assert.deepEqual(files, [DIAGNOSTICS_FILES.image, DIAGNOSTICS_FILES.response, DIAGNOSTICS_FILES.summary].sort())
    assert.ok(!files.some((name) => name.endsWith('.tmp')), '不能留下 .tmp 临时文件')

    const summary = JSON.parse(readFileSync(join(dir, DIAGNOSTICS_FILES.summary), 'utf8'))
    assert.equal(summary.requestId, requestId)
    assert.equal(summary.candidateCount, 1)
    assert.deepEqual(summary.candidateNames, ['形势与政策'])
    assert.equal(summary.image.width, 2)

    assert.deepEqual(readFileSync(join(dir, DIAGNOSTICS_FILES.image)), Buffer.from([1, 2, 3, 4]))

    const responseText = readFileSync(join(dir, DIAGNOSTICS_FILES.response), 'utf8')
    assert.ok(!responseText.includes('192.168.1.9'), '诊断文件里不能出现地址')
    assert.ok(!responseText.includes('secret-value'), '诊断文件里不能出现凭据')
    assert.ok(!responseText.includes('endpoint'), '连字段名都不要写进去')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('大量请求 + "重启"（重新创建写入器）之后，目录里仍然只有三个固定文件，且是最近一次', () => {
  const dir = tempDir()
  try {
    let diagnostics = createDiagnostics({ dir, logger: silentLogger })
    for (let i = 0; i < 5; i += 1) {
      const requestId = diagnostics.nextRequestId()
      diagnostics.capture({
        requestId,
        imageBytes: Buffer.from([i]),
        image: { width: 1, height: 1, format: 'png', bytes: 1 },
        response: { ok: true, candidates: [{ name: `第${i}次` }] },
      })
    }
    const expected = [DIAGNOSTICS_FILES.image, DIAGNOSTICS_FILES.response, DIAGNOSTICS_FILES.summary].sort()
    assert.deepEqual(readdirSync(dir).sort(), expected)
    assert.deepEqual(readFileSync(join(dir, DIAGNOSTICS_FILES.image)), Buffer.from([4]))

    // 模拟服务重启：同一个目录再建一个写入器，继续覆盖同一批文件。
    diagnostics = createDiagnostics({ dir, logger: silentLogger })
    const lastId = diagnostics.nextRequestId()
    diagnostics.capture({
      requestId: lastId,
      imageBytes: Buffer.from([9]),
      image: { width: 1, height: 1, format: 'png', bytes: 1 },
      response: { ok: true, candidates: [{ name: '重启后' }] },
    })
    assert.deepEqual(readdirSync(dir).sort(), expected)
    assert.deepEqual(readFileSync(join(dir, DIAGNOSTICS_FILES.image)), Buffer.from([9]))
    const summary = JSON.parse(readFileSync(join(dir, DIAGNOSTICS_FILES.summary), 'utf8'))
    assert.equal(summary.requestId, lastId)
    assert.deepEqual(summary.candidateNames, ['重启后'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('诊断目录建不出来时不抛错，只把 available 置为 false', () => {
  const dir = tempDir()
  try {
    // 用"目录位置上已经有一个同名文件"来制造 mkdir 失败。
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not-a-directory')
    const diagnostics = createDiagnostics({ dir: blocked, logger: silentLogger })
    assert.equal(diagnostics.enabled, true)
    assert.equal(diagnostics.available, false)
    const result = diagnostics.capture({ requestId: 'x', imageBytes: Buffer.from([1]), image: {}, response: {} })
    assert.equal(result.written, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('redact：递归去掉敏感键，保留业务字段', () => {
  const value = redact({
    ok: true,
    imageBase64: 'AAAA',
    image: { width: 1, height: 1, bytes: 1 },
    nested: { pairCode: '1234', endpoint: 'http://x', url: 'http://y', keep: 'yes' },
  })
  assert.equal(value.ok, true)
  assert.equal(value.image.width, 1)
  assert.equal(value.nested.keep, 'yes')
  assert.ok(!('pairCode' in value.nested))
  assert.ok(!('endpoint' in value.nested))
  assert.ok(!('url' in value.nested))
})

test('服务层：只读到表头/时间栏（引擎抛错）→ 422 + 明确文案，并且把失败也写进诊断', async () => {
  const dir = tempDir()
  try {
    const layoutError = new Error('只读到课表的表头与时间栏文字')
    layoutError.name = 'OcrLayoutError'
    layoutError.code = 'STRUCTURE_NOT_FOUND'
    layoutError.layout = 'grid-rows'
    layoutError.headerOnly = 2

    const engine = {
      async recognizeTimetable() {
        throw layoutError
      },
      async terminate() {},
    }
    const diagnostics = createDiagnostics({ dir, logger: silentLogger })
    const service = createOcrService({ engine, logger: silentLogger, diagnostics })
    const requestId = diagnostics.nextRequestId()

    const result = await postOcr(service, requestId)

    assert.equal(result.status, 422, '结构识别失败不能被说成 500，也不能假装成功')
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.code, 'STRUCTURE_NOT_FOUND')
    assert.match(result.payload.message, /表头与时间栏/)
    assert.equal(result.payload.requestId, requestId)

    const summary = JSON.parse(readFileSync(join(dir, DIAGNOSTICS_FILES.summary), 'utf8'))
    assert.equal(summary.error.code, 'STRUCTURE_NOT_FOUND')
    assert.equal(summary.layout, 'grid-rows')
    assert.equal(summary.headerOnly, 2)
    // 失败那一次的原图也在：真机排查最关键的就是这张图。
    assert.deepEqual(readFileSync(join(dir, DIAGNOSTICS_FILES.image)), tinyPngBuffer())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('引擎层：整图回退只读到表头时会抛 OcrLayoutError（已解码图片 → 引擎 → 服务）', async () => {
  const { OcrEngine } = await import('../src/ocrEngine.mjs')
  const { HEADER_ONLY_MESSAGE } = await import('../../frontend/src/ocr/structuralLabels.js')

  const engine = new OcrEngine()
  // 替换掉真正的 Tesseract 调用：按裁图宽高比返回"表头 / 时间栏"文字，
  // 精确模拟真机上"只读准表头、课程方块一个都没读出来"的那次识别。
  engine.recognizeGray = async (gray, width, height) => {
    const ratio = width / Math.max(1, height)
    const text = ratio >= 3 ? '周一 周二 周三 周四 周五 周六 周日' : '1 08:00 08:45 2 08:50 09:35'
    return { text, confidence: 92, blocks: [] }
  }
  try {
    await assert.rejects(
      () => engine.recognizeTimetable({ data: new Uint8ClampedArray(60 * 60 * 4), width: 60, height: 60 }),
      (cause) => {
        assert.equal(cause?.code, 'STRUCTURE_NOT_FOUND')
        assert.equal(cause?.message, HEADER_ONLY_MESSAGE)
        return true
      },
    )
  } finally {
    await engine.terminate()
  }
})

test('服务层：成功响应带 requestId 与诊断开关；健康检查不写文件也不消耗请求号', async () => {
  const dir = tempDir()
  try {
    const diagnostics = createDiagnostics({ dir, logger: silentLogger })
    const service = createOcrService({ engine: okEngine, logger: silentLogger, diagnostics })
    const requestId = diagnostics.nextRequestId()
    const result = await postOcr(service, requestId)
    assert.equal(result.status, 200)
    assert.equal(result.payload.requestId, requestId)
    assert.equal(result.payload.diagnosticsMode, true)
    assert.equal(result.payload.candidates.length, 1)

    const before = readdirSync(dir).sort()
    // 15 次健康检查：一个文件都不该新增 / 变化，也不该让后面的识别写不进去。
    for (let i = 0; i < 15; i += 1) {
      const health = await service.handleRequest({ method: 'GET', url: '/v1/health' })
      assert.equal(health.payload.diagnosticsMode, true)
      assert.ok(!JSON.stringify(health.payload).includes(basename(dir)), '健康检查里不能出现诊断目录')
    }
    assert.deepEqual(readdirSync(dir).sort(), before)

    const secondId = diagnostics.nextRequestId()
    const second = await postOcr(service, secondId)
    assert.equal(second.status, 200)
    const summary = JSON.parse(readFileSync(join(dir, DIAGNOSTICS_FILES.summary), 'utf8'))
    assert.equal(summary.requestId, secondId, '健康检查不能把"最近一次识别"挤掉')
    assert.deepEqual(readdirSync(dir).sort(), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('服务层：目录建不出来时识别照常成功（不会变成 500）', async () => {
  const dir = tempDir()
  try {
    // 目录位置上已经是一个文件 → mkdir 失败；但识别必须照常。
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'not-a-directory')
    const diagnostics = createDiagnostics({ dir: blocked, logger: silentLogger })
    assert.equal(diagnostics.available, false)
    const service = createOcrService({ engine: okEngine, logger: silentLogger, diagnostics })

    const result = await postOcr(service, 'req-test')
    assert.equal(result.status, 200, '诊断不可用不能影响识别')
    assert.equal(result.payload.ok, true)
    assert.equal(result.payload.candidates.length, 1)
    assert.equal(result.payload.diagnosticsMode, false, '要如实报告诊断不可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('服务层：写入瞬间失败（目录被删）时识别仍然成功，只把诊断标记为不可用', async () => {
  const dir = tempDir()
  try {
    const captureDir = join(dir, 'diagnostics')
    const diagnostics = createDiagnostics({ dir: captureDir, logger: silentLogger })
    assert.equal(diagnostics.available, true)
    // 目录建好之后再删掉：capture() 里的 writeFileSync 会抛 ENOENT。
    rmSync(captureDir, { recursive: true, force: true })

    const service = createOcrService({ engine: okEngine, logger: silentLogger, diagnostics })
    const result = await postOcr(service, 'req-test')
    assert.equal(result.status, 200, '写盘失败被吞掉，识别结果照常返回')
    assert.equal(result.payload.ok, true)
    assert.equal(result.payload.candidates.length, 1)
    assert.equal(result.payload.diagnosticsMode, false, '写失败后要如实报告诊断不可用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认关闭时，响应里 diagnosticsMode 为 false 且不写文件', async () => {
  const service = createOcrService({ engine: okEngine, logger: silentLogger })
  const result = await postOcr(service)
  assert.equal(result.status, 200)
  assert.equal(result.payload.diagnosticsMode, false)
  assert.equal(result.payload.requestId, null)
})
