/**
 * 伴侣服务的 HTTP 边界测试（**不跑 OCR**，用假引擎，所以是秒级）。
 *
 * 覆盖的都是「不该发生的事」：
 * - 不存在的路径一律 404（没有任何文件服务）；
 * - 只接受 POST + application/json；
 * - 超大请求体 / 超大图片 / 非 PNG-JPEG 字节 / 非法 base64 都要被明确拒绝且**不进识别**；
 * - 并发超过上限返回 429，而不是排到内存里堆积；
 * - 健康检查不泄漏任何凭据字段（pairCode 只有显式设了环境变量才有）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PNG } from 'pngjs'

import { ImageError, decodeImage, encodeGrayPng, sniffImageFormat } from '../src/imageCodec.mjs'
import { MAX_BODY_BYTES, createOcrService, parseArgs } from '../src/server.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

/** 一张最小的合法 PNG（8×8 灰度），用来验证「真的能解码」。 */
function tinyPng(width = 8, height = 8) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 200
    png.data[i * 4 + 1] = 200
    png.data[i * 4 + 2] = 200
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

const fakeEngine = {
  calls: 0,
  async recognizeTimetable() {
    this.calls += 1
    return {
      cancelled: false,
      layout: 'week-grid',
      week: 7,
      candidates: [
        { layout: 'week-grid', name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35', location: '教三 305' },
      ],
      warnings: [],
      diagnostics: {},
      rawText: '形势与政策',
      ocrCalls: 1,
      ms: 5,
    }
  },
  async terminate() {},
}

function newService() {
  fakeEngine.calls = 0
  return createOcrService({ engine: fakeEngine, logger: silentLogger })
}

test('健康检查只返回非敏感信息', async () => {
  const service = newService()
  const result = await service.handleRequest({ method: 'GET', url: '/v1/health' })
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.service, 'ddl-mate-ocr-companion')
  assert.ok(!('token' in result.payload), '不应返回任何凭据字段')
  assert.equal(result.payload.pairCode, null, '没有显式设置配对码时不能凭空生成一个')
})

test('不存在的路径一律 404（服务端没有任何文件服务）', async () => {
  const service = newService()
  for (const url of ['/', '/index.html', '/../package.json', '/v1/ocr/timetable/../../etc/passwd', '/files/etc/hosts']) {
    const result = await service.handleRequest({ method: 'GET', url })
    assert.equal(result.status, 404, `${url} 必须是 404`)
  }
})

test('OCR 接口只接受 POST + application/json', async () => {
  const service = newService()
  const wrongMethod = await service.handleRequest({ method: 'GET', url: '/v1/ocr/timetable' })
  assert.equal(wrongMethod.status, 405)

  const wrongType = await service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    body: Buffer.from('{}'),
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.status, 415)
  assert.equal(fakeEngine.calls, 0, '被拒绝的请求不能进入识别')
})

test('合法 PNG 能识别并返回候选（JSON 里的 base64 会被正确解码）', async () => {
  const service = newService()
  const png = tinyPng()
  const result = await service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ imageBase64: png.toString('base64') })),
  })
  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.image.format, 'png')
  assert.equal(result.payload.candidates.length, 1)
  assert.equal(result.payload.candidates[0].name, '形势与政策')
  assert.equal(fakeEngine.calls, 1)
})

test('非 PNG/JPEG 字节被明确拒绝，且不会进入识别', async () => {
  const service = newService()
  const result = await service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ imageBase64: Buffer.from('HEIC-不是图片').toString('base64') })),
  })
  assert.equal(result.status, 400)
  assert.equal(result.payload.code, 'UNSUPPORTED_FORMAT')
  assert.equal(fakeEngine.calls, 0)
})

test('缺少字段 / 非法 base64 / 空数据都有可读错误', async () => {
  const service = newService()
  const cases = [
    [{}, 'BAD_REQUEST'],
    [{ imageBase64: 123 }, 'BAD_REQUEST'],
    [{ imageBase64: '!!!not-base64!!!' }, 'BAD_REQUEST'],
    [{ imageBase64: '' }, 'BAD_REQUEST'],
  ]
  for (const [payload, code] of cases) {
    const result = await service.handleRequest({
      method: 'POST',
      url: '/v1/ocr/timetable',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)),
    })
    assert.equal(result.status, 400)
    assert.equal(result.payload.code, code)
  }
  assert.equal(fakeEngine.calls, 0)
})

test('超大图片被 413 拒绝', async () => {
  const service = newService()
  const huge = 'A'.repeat(MAX_BODY_BYTES + 16)
  const result = await service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ imageBase64: huge })),
  })
  assert.equal(result.status, 413)
  assert.equal(result.payload.code, 'IMAGE_TOO_LARGE')
  assert.equal(fakeEngine.calls, 0)
})

test('识别过程中抛出的非预期错误被包成 500，不会把堆栈吐给手机', async () => {
  const engine = {
    async recognizeTimetable() {
      throw new Error('内部细节不应该出现在响应里')
    },
    async terminate() {},
  }
  const service = createOcrService({ engine, logger: silentLogger })
  const result = await service.handleRequest({
    method: 'POST',
    url: '/v1/ocr/timetable',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ imageBase64: tinyPng().toString('base64') })),
  })
  assert.equal(result.status, 500)
  assert.equal(result.payload.code, 'OCR_FAILED')
  assert.ok(!JSON.stringify(result.payload).includes('内部细节'), '不能泄漏内部错误文本')
})

test('并发超过上限返回 429', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const engine = {
    async recognizeTimetable() {
      await gate
      return { cancelled: false, layout: 'week-grid', candidates: [], warnings: [], diagnostics: {}, ms: 1 }
    },
    async terminate() {},
  }
  const service = createOcrService({ engine, logger: silentLogger })
  const call = () =>
    service.handleRequest({
      method: 'POST',
      url: '/v1/ocr/timetable',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ imageBase64: tinyPng().toString('base64') })),
    })

  const first = call()
  const second = call()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const third = await call()
  assert.equal(third.status, 429)
  assert.equal(third.payload.code, 'BUSY')
  release()
  assert.equal((await first).status, 200)
  assert.equal((await second).status, 200)
  assert.equal(service.stats().rejected, 1)
})

test('图片解码：灰度 PNG 往返、格式嗅探、像素上限', () => {
  const gray = new Uint8ClampedArray(4 * 3).fill(128)
  const encoded = encodeGrayPng(gray, 4, 3)
  assert.equal(sniffImageFormat(encoded), 'png')
  const decoded = decodeImage(encoded)
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 3)
  assert.equal(decoded.data[0], 128)
  assert.equal(decoded.data[3], 255, 'RGBA 的 alpha 必须是 255')

  assert.equal(sniffImageFormat(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null)
  assert.throws(() => decodeImage(Buffer.from('not-an-image')), ImageError)
})

test('PNG：先看头部尺寸再解码，超大声明被直接拒绝（不会先分配整块缓冲）', () => {
  // 手工造一个「头部声明 50000×50000」的假 PNG：只有一个 IHDR，没有任何像素数据。
  // 旧实现会先 PNG.sync.read()，那张图按头部尺寸要分配 10GB；现在必须在解码前拒绝。
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(50000, 0)
  ihdr.writeUInt32BE(50000, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const length = Buffer.alloc(4)
  length.writeUInt32BE(13, 0)
  const crc = Buffer.alloc(4)
  const fake = Buffer.concat([signature, length, Buffer.from('IHDR', 'ascii'), ihdr, crc])

  assert.equal(sniffImageFormat(fake), 'png', '声明是 PNG，所以会走 PNG 分支')
  try {
    decodeImage(fake)
    assert.fail('超大声明必须在解码前被拒绝')
  } catch (cause) {
    assert.ok(cause instanceof ImageError, `应当是 ImageError，实际 ${cause}`)
    assert.equal(cause.code, 'IMAGE_TOO_LARGE')
    assert.match(cause.message, /单边最长|像素总数超过上限/)
  }
})

test('JPEG：头部尺寸超限同样在解码前被拒绝', () => {
  // SOI + SOF0(声明 40000×40000) —— 只有头部，没有真实的压缩数据。
  const soi = Buffer.from([0xff, 0xd8])
  const sof = Buffer.alloc(2 + 2 + 1 + 2 + 2)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(8, 2)
  sof[4] = 8 // 精度
  sof.writeUInt16BE(40000, 5) // 高度
  sof.writeUInt16BE(40000, 7) // 宽度
  const fake = Buffer.concat([soi, sof, Buffer.from([0xff, 0xd9])])

  assert.equal(sniffImageFormat(fake), 'jpeg')
  try {
    decodeImage(fake)
    assert.fail('超大声明必须在解码前被拒绝')
  } catch (cause) {
    assert.ok(cause instanceof ImageError, `应当是 ImageError，实际 ${cause}`)
    assert.equal(cause.code, 'IMAGE_TOO_LARGE')
  }
})

test('命令行参数：默认本机、--lan 才暴露、端口校验、未知参数报错', () => {
  const defaults = parseArgs([])
  assert.equal(defaults.lan, false)
  assert.equal(defaults.port, 8082)
  assert.equal(defaults.host, null)
  // 诊断默认关闭：不显式给目录就不能产生任何诊断文件。
  assert.equal(defaults.diagnosticsDir, null)
  assert.equal(parseArgs(['--lan']).lan, true)
  assert.equal(parseArgs(['--lan', '--port', '8090']).port, 8090)
  assert.throws(() => parseArgs(['--port', '70000']), /0–65535/)
  assert.throws(() => parseArgs(['--unknown']), /无法识别的参数/)
})

test('命令行参数：本地诊断只需要显式目录；旧的次数上限参数已不再需要', () => {
  const args = parseArgs(['--lan', '--diagnostics-dir', '.tools/ocr-diagnostics'])
  assert.equal(args.diagnosticsDir, '.tools/ocr-diagnostics')
  assert.throws(() => parseArgs(['--diagnostics-dir']), /需要一个目录路径/)
  assert.throws(() => parseArgs(['--diagnostics-limit', '3']), /只保留最近一次/)
})
