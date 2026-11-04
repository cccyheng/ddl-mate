/**
 * **生产服务器** `startServer` 的通知路由测试（不是复制一份 HTTP wrapper）。
 *
 * 为了让测试既快又可控，`startServer` 增加了最小可选注入：
 * - `engine`：默认仍是真实 `OcrEngine`；
 * - `requestTimeoutMs`：默认仍是 `REQUEST_TIMEOUT_MS`（180s）。
 *
 * 覆盖：
 * - 成功路径与请求号；
 * - 服务端超时后，即使引擎**忽略取消信号**并迟到返回成功，也绝不能变成 HTTP 200；
 * - 客户端断开后，容量保留到引擎真正结束才释放；
 * - 超大请求体不进入引擎（生产服务器可能先断开连接，也可能回 413，测试如实接受两者）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PNG } from 'pngjs'

import { MAX_BODY_BYTES, startServer } from '../src/server.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

function tinyPngBase64(width = 8, height = 8) {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = 180
    png.data[i * 4 + 1] = 180
    png.data[i * 4 + 2] = 180
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png).toString('base64')
}

const IMAGE = tinyPngBase64()

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function noticeEngine(overrides = {}) {
  const state = { noticeCalls: 0, timetableCalls: 0 }
  return {
    state,
    async recognizeNotice() {
      state.noticeCalls += 1
      return {
        cancelled: false,
        rawText: '2026年10月8日 09:12 张老师\n第三次作业请在 2026年10月20日 22:00 前提交到学习通。',
        empty: false,
        warnings: [],
        ms: 5,
        ocrCalls: 1,
      }
    },
    async recognizeTimetable() {
      state.timetableCalls += 1
      return {
        cancelled: false,
        layout: 'week-grid',
        candidates: [{ name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35' }],
        warnings: [],
        diagnostics: {},
        ms: 2,
      }
    },
    async terminate() {},
    ...overrides,
  }
}

async function withStartServer(options, run) {
  const handle = await startServer(['--localhost', '--port', '0'], silentLogger, options)
  const { port } = handle.server.address()
  try {
    await run(`http://127.0.0.1:${port}`, handle)
  } finally {
    await handle.close()
  }
}

test('生产 startServer：通知成功返回 200，带 rawText 与请求号；健康检查 advertise noticeOcr', async () => {
  const engine = noticeEngine()
  await withStartServer({ engine }, async (base) => {
    const health = await (await fetch(`${base}/v1/health`)).json()
    assert.equal(health.ok, true)
    assert.equal(health.noticeOcr, true)

    const response = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: IMAGE }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.match(payload.rawText, /2026年10月20日/)
    assert.ok(payload.requestId, '生产服务器应给通知请求一个请求号')
    assert.equal(response.headers.get('x-ocr-request-id'), payload.requestId)
    assert.equal(engine.state.noticeCalls, 1)
  })
})

test('生产 startServer 超时：引擎忽略取消并迟到返回成功，也绝不能变成 HTTP 200', async () => {
  const gate = deferred()
  const engine = noticeEngine({
    async recognizeNotice() {
      // 故意**忽略** isCancelled，迟到返回一个“成功”结果。
      await gate.promise
      return {
        cancelled: false,
        rawText: '超时之后才返回的成功结果',
        empty: false,
        warnings: [],
        ms: 1,
        ocrCalls: 1,
      }
    },
  })
  await withStartServer({ engine, requestTimeoutMs: 30 }, async (base, handle) => {
    const pending = fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: IMAGE }),
      signal: AbortSignal.timeout(5_000),
    })
    // 等超时发生；此时引擎还挂着。
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(handle.service.stats().active, 1, '引擎还没结束，容量不能提前释放')
    gate.resolve()
    const response = await pending
    assert.notEqual(response.status, 200, '超时不能返回成功')
    const payload = await response.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'CANCELLED')
    assert.equal(handle.service.stats().active, 0, '引擎结束后才释放容量')
  })
})

test('生产 startServer 客户端断开：容量保留到引擎真正结束，服务随后仍可用', async () => {
  const gate = deferred()
  let started = false
  const engine = noticeEngine({
    async recognizeNotice() {
      started = true
      await gate.promise
      return { cancelled: false, rawText: '迟到结果', empty: false, warnings: [], ms: 1, ocrCalls: 1 }
    },
  })
  await withStartServer({ engine, requestTimeoutMs: 30_000 }, async (base, handle) => {
    const controller = new AbortController()
    const pending = fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: IMAGE }),
      signal: controller.signal,
    })
    pending.catch(() => undefined)
    for (let index = 0; index < 200 && !started; index += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(started, true)
    assert.equal(handle.service.stats().active, 1)

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(handle.service.stats().active, 1, '客户端断开不能提前释放容量')

    gate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(handle.service.stats().active, 0)

    const health = await fetch(`${base}/v1/health`)
    assert.equal(health.status, 200)
  })
})

test('生产 startServer 超大请求体：不进入引擎；可能回 413 或直接断开（不谎称已验证 413）', async () => {
  const engine = noticeEngine()
  await withStartServer({ engine }, async (base) => {
    let response = null
    let clientError = null
    try {
      response = await fetch(`${base}/v1/ocr/notice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: 'A'.repeat(MAX_BODY_BYTES + 16) }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (cause) {
      // 生产 readBody 在超限时会销毁请求；socket 先关时 fetch 会失败，这是可接受的受控断开。
      clientError = cause
    }
    if (response) {
      assert.equal(response.status, 413)
    } else {
      assert.ok(clientError instanceof Error, '要么得到 413，要么得到明确的连接失败')
      assert.match(
        `${clientError.name}: ${clientError.message}`,
        /fetch|socket|abort|terminat|closed/i,
        '连接失败必须是可识别的网络错误，不能是无声挂起',
      )
    }
    assert.equal(engine.state.noticeCalls, 0, '超限请求绝不能进入引擎')
  })
})
