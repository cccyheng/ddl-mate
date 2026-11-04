/**
 * 伴侣**服务层**（`createOcrService.handleRequest`）的通知路由边界测试。
 *
 * 注意：这里的 HTTP wrapper 是测试自己的最小包装，**不是生产 `startServer`**。
 * 生产服务器的超时 / 断开 / 请求体限制 / 容量语义由
 * `tests/noticeStartServer.test.mjs` 直接在 `startServer` 上验证。
 *
 * 这里覆盖：
 * - 成功 / 空文字 / 请求体上限 / 错误 Content-Type / 非法图片；
 * - 客户端断开与「服务端超时」都不能变成 200 成功，也不能提前释放并发容量；
 * - 通知与课表**共用**并发上限（跨路由 429）；
 * - 健康检查 advertise `noticeOcr`，课表与归档接口保持原行为。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'

import { PNG } from 'pngjs'

import { MAX_BODY_BYTES, createOcrService } from '../src/server.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

function tinyPng(width = 8, height = 8) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 180
    png.data[i * 4 + 1] = 180
    png.data[i * 4 + 2] = 180
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png)
}

const PNG_BASE64 = tinyPng().toString('base64')

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 按应用真实行为读请求体：超过 MAX_BODY_BYTES 直接 413 并断开。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('body too large')
        error.code = 'BODY_TOO_LARGE'
        // 先暂停读取、让外层写回 413，而不是直接把 socket 掐断（真实服务器也一样先回错误）。
        req.pause()
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 启动一个和 `startServer` 同形态的临时 HTTP 服务（随机端口）。
 * `timeoutMs` 用来模拟真实服务器的单请求超时；`requestId` 可选。
 */
async function withServer(engine, run, options = {}) {
  const service = createOcrService({ engine, logger: silentLogger })
  const server = http.createServer((req, res) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
    let settled = false
    const done = (status, payload) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) return
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }
    req.on('aborted', () => controller.abort())
    req.on('error', () => controller.abort())
    res.on('close', () => {
      if (!settled) controller.abort()
    })

    const isGet = req.method === 'GET' || req.method === 'HEAD'
    const bodyPromise = isGet ? Promise.resolve(Buffer.alloc(0)) : readBody(req, MAX_BODY_BYTES)
    bodyPromise
      .then((body) =>
        service.handleRequest({
          method: req.method,
          url: req.url,
          body,
          headers: req.headers,
          signal: controller.signal,
          requestId: req.headers['x-test-request-id'] ?? null,
        }),
      )
      .then((result) => done(result.status, result.payload))
      .catch((cause) => {
        if (cause?.code === 'BODY_TOO_LARGE') {
          done(413, { ok: false, code: 'IMAGE_TOO_LARGE', message: '请求体超过上限。' })
          return
        }
        if (controller.signal.aborted) {
          clearTimeout(timer)
          return
        }
        done(500, { ok: false, code: 'INTERNAL', message: '服务内部错误。' })
      })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`, service)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await service.close()
  }
}

function noticeEngine(overrides = {}) {
  const state = { noticeCalls: 0, timetableCalls: 0, cancelled: 0 }
  const engine = {
    state,
    async recognizeNotice(_image, options = {}) {
      state.noticeCalls += 1
      if (options.isCancelled?.()) {
        state.cancelled += 1
        return { cancelled: true, rawText: '', empty: true, warnings: [], ms: 1, ocrCalls: 1 }
      }
      return {
        cancelled: false,
        rawText: '2026年10月18日 09:12 张老师\n数据结构作业：请于2026年10月20日 22:00前提交。',
        empty: false,
        warnings: [],
        ms: 7,
        ocrCalls: 1,
      }
    },
    async recognizeTimetable() {
      state.timetableCalls += 1
      return {
        cancelled: false,
        layout: 'week-grid',
        week: 7,
        candidates: [{ name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35' }],
        warnings: [],
        diagnostics: {},
        ms: 2,
      }
    },
    async terminate() {},
    ...overrides,
  }
  return engine
}

test('健康检查 advertise noticeOcr；GET 归档接口仍然可用', async () => {
  const engine = noticeEngine()
  await withServer(engine, async (base) => {
    const health = await (await fetch(`${base}/v1/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.noticeOcr, true)
    assert.equal(health.service, 'ddl-mate-ocr-companion')

    const archive = await fetch(`${base}/v1/archive/sources`)
    assert.equal(archive.status, 200)
    const payload = await archive.json()
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.sources))
  })
})

test('POST notice 成功：200 + 原始文字 + 图片元数据 + 请求号', async () => {
  const engine = noticeEngine()
  await withServer(engine, async (base) => {
    const response = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-request-id': 'req-123' },
      body: JSON.stringify({ imageBase64: PNG_BASE64 }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.rawText, '2026年10月18日 09:12 张老师\n数据结构作业：请于2026年10月20日 22:00前提交。')
    assert.equal(payload.requestId, 'req-123')
    assert.equal(payload.image.format, 'png')
    assert.equal(payload.image.width, 8)
    assert.equal(engine.state.noticeCalls, 1)
  })
})

test('POST notice 空文字：200 成功但明确 empty，不伪造候选', async () => {
  const engine = noticeEngine({
    async recognizeNotice() {
      return { cancelled: false, rawText: '', empty: true, warnings: ['没有识别到文字'], ms: 1, ocrCalls: 1 }
    },
  })
  await withServer(engine, async (base) => {
    const response = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: PNG_BASE64 }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.rawText, '')
    assert.equal(payload.empty, true)
    assert.equal(payload.candidates, undefined, '通知路由不能返回课表候选')
  })
})

test('POST notice 边界：错误 Content-Type 415、非法图片 400、超大请求体 413，都不进引擎', async () => {
  const engine = noticeEngine()
  await withServer(engine, async (base) => {
    const wrongType = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(wrongType.status, 415)

    const invalid = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: Buffer.from('HEIC-不是图片').toString('base64') }),
    })
    assert.equal(invalid.status, 400)
    assert.equal((await invalid.json()).code, 'UNSUPPORTED_FORMAT')

    const huge = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'A'.repeat(MAX_BODY_BYTES + 16) }),
    })
    assert.equal(huge.status, 413)
    assert.equal(engine.state.noticeCalls, 0)
  })
})

test('客户端断开：取消信号真实传到引擎；容量在引擎结束前不释放', async () => {
  const gate = deferred()
  let engineStarted = false
  let observedCancel = false
  const engine = noticeEngine({
    async recognizeNotice(_image, options = {}) {
      engineStarted = true
      await gate.promise
      observedCancel = options.isCancelled?.() === true
      return { cancelled: observedCancel, rawText: '', empty: true, warnings: [], ms: 1, ocrCalls: 1 }
    },
  })
  await withServer(engine, async (base, service) => {
    const controller = new AbortController()
    const pending = fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: PNG_BASE64 }),
      signal: controller.signal,
    })
    pending.catch(() => {})
    for (let index = 0; index < 200 && !engineStarted; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(engineStarted, true)
    assert.equal(service.stats().active, 1, '识别进行中应占用容量')

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(service.stats().active, 1, '客户端断开后、引擎结束前不能提前释放容量')

    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(observedCancel, true)
    assert.equal(service.stats().active, 0, '引擎结束后才释放容量')

    // 服务仍可正常处理后续请求。
    const health = await fetch(`${base}/v1/health`)
    assert.equal(health.status, 200)
  })
})

test('服务端超时：不返回 200 成功；超时后容量正确释放', async () => {
  const gate = deferred()
  const engine = noticeEngine({
    async recognizeNotice(_image, options = {}) {
      await gate.promise
      return { cancelled: options.isCancelled?.() === true, rawText: '', empty: true, warnings: [], ms: 1, ocrCalls: 1 }
    },
  })
  await withServer(
    engine,
    async (base, service) => {
      const pending = fetch(`${base}/v1/ocr/notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: PNG_BASE64 }),
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
      gate.resolve()
      const response = await pending
      assert.notEqual(response.status, 200, '超时不能返回成功')
      const payload = await response.json()
      assert.equal(payload.ok, false)
      assert.equal(payload.code, 'CANCELLED')
      assert.equal(service.stats().active, 0)
    },
    { timeoutMs: 20 },
  )
})

test('跨路由并发：通知与课表共用 2 个容量，第 3 个请求 429', async () => {
  const noticeGate = deferred()
  const timetableGate = deferred()
  let started = 0
  const engine = noticeEngine({
    async recognizeNotice() {
      started += 1
      await noticeGate.promise
      return { cancelled: false, rawText: '', empty: true, warnings: [], ms: 1, ocrCalls: 1 }
    },
    async recognizeTimetable() {
      started += 1
      await timetableGate.promise
      return { cancelled: false, layout: 'week-grid', candidates: [], warnings: [], diagnostics: {}, ms: 1 }
    },
  })
  await withServer(engine, async (base) => {
    const post = (route) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: PNG_BASE64 }),
      })
    const first = post('/v1/ocr/notice')
    const second = post('/v1/ocr/timetable')
    for (let index = 0; index < 200 && started < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(started, 2)

    const third = await post('/v1/ocr/notice')
    assert.equal(third.status, 429)
    assert.equal((await third.json()).code, 'BUSY')

    noticeGate.resolve()
    timetableGate.resolve()
    assert.equal((await first).status, 200)
    assert.equal((await second).status, 200)
  })
})

test('回归：课表路由行为不变（返回 candidates / layout / week）', async () => {
  const engine = noticeEngine()
  await withServer(engine, async (base) => {
    const response = await fetch(`${base}/v1/ocr/timetable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: PNG_BASE64 }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.layout, 'week-grid')
    assert.equal(payload.week, 7)
    assert.equal(payload.candidates.length, 1)
    assert.equal(engine.state.timetableCalls, 1)
    assert.equal(engine.state.noticeCalls, 0)
  })
})

test('handleNotice：信号在启动前已取消 → 不调用引擎，返回 499 而不是成功', async () => {
  const engine = noticeEngine()
  const service = createOcrService({ engine, logger: silentLogger })
  try {
    const controller = new AbortController()
    controller.abort()
    const result = await service.handleRequest({
      method: 'POST',
      url: '/v1/ocr/notice',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ imageBase64: PNG_BASE64 })),
      signal: controller.signal,
    })
    assert.equal(result.status, 499)
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.code, 'CANCELLED')
    assert.equal(engine.state.noticeCalls, 0, '已经取消的请求不能启动引擎')
  } finally {
    await service.close()
  }
})

test('handleNotice：引擎返回非字符串 rawText → 500 OCR_FAILED，绝不强转成空文字成功', async () => {
  const engine = noticeEngine({
    async recognizeNotice() {
      return { cancelled: false, rawText: 12345, empty: false, warnings: [], ms: 1, ocrCalls: 1 }
    },
  })
  const service = createOcrService({ engine, logger: silentLogger })
  try {
    const result = await service.handleRequest({
      method: 'POST',
      url: '/v1/ocr/notice',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ imageBase64: PNG_BASE64 })),
    })
    assert.equal(result.status, 500)
    assert.equal(result.payload.ok, false)
    assert.equal(result.payload.code, 'OCR_FAILED')
    assert.ok(!JSON.stringify(result.payload).includes('12345'))
  } finally {
    await service.close()
  }
})
