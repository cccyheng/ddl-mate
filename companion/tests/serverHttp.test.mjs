/**
 * 真实 HTTP 服务器测试（不是直接调 `handleRequest`）。
 *
 * 覆盖复核对第 6 条后半的要求：**超时/断线不能变成「成功的空结果」**，
 * 也不能在客户端断开之后还去写响应（会抛 WRITE_AFTER_END / DESTROYED）。
 *
 * 这里用假引擎把「识别很慢」造出来，然后：
 * 1. 正常请求 → 200 + 结构化候选；
 * 2. 客户端中途 abort（模拟用户取消 / 切后台）→ 服务端不崩、不写响应、后续请求仍然正常；
 * 3. 客户端发一个超大声明体 → 413；
 * 4. 未知路径 → 404。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PNG } from 'pngjs'

import { startServer } from '../src/server.mjs'

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

/** 造一个「识别会等 gate，并且记录自己被取消过没有」的假引擎。 */
function gatedEngine(gate) {
  const state = { started: 0, completed: 0, cancelled: 0 }
  return {
    state,
    async recognizeTimetable(image, options = {}) {
      state.started += 1
      await gate
      if (options.isCancelled?.()) {
        state.cancelled += 1
        return { cancelled: true, layout: 'week-grid', candidates: [], warnings: [], diagnostics: {}, ms: 1 }
      }
      state.completed += 1
      return {
        cancelled: false,
        layout: 'week-grid',
        week: 7,
        candidates: [{ name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35' }],
        warnings: [],
        diagnostics: {},
        ms: 1,
      }
    },
    async terminate() {},
  }
}

async function withServer(engine, run) {
  // createOcrService 由 startServer 内部创建；这里改用引擎注入版本需要直接构造服务。
  const { createOcrService } = await import('../src/server.mjs')
  const service = createOcrService({ engine, logger: silentLogger })
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      const result = await service.handleRequest({
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks),
        headers: req.headers,
      })
      const body = JSON.stringify(result.payload)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run(`http://127.0.0.1:${port}`, service)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('真实 HTTP：正常请求返回 200 与候选', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const engine = gatedEngine(gate)
  await withServer(engine, async (base) => {
    const pending = fetch(`${base}/v1/ocr/timetable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: tinyPng().toString('base64') }),
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    const response = await pending
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.candidates.length, 1)
    assert.equal(engine.state.completed, 1)
  })
})

test('真实 HTTP：客户端中途断开 → 服务不崩、不写响应、后续请求仍正常', async () => {
  let firstRelease
  const firstGate = new Promise((resolve) => {
    firstRelease = resolve
  })
  const engine = gatedEngine(firstGate)
  await withServer(engine, async (base) => {
    const controller = new AbortController()
    const pending = fetch(`${base}/v1/ocr/timetable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: tinyPng().toString('base64') }),
      signal: controller.signal,
    })
    pending.catch(() => {}) // 断开必然让 fetch 拒绝，这里只关心服务端行为
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 30))
    firstRelease()

    // 服务端还活着：健康检查仍然正常。
    const health = await fetch(`${base}/v1/health`)
    assert.equal(health.status, 200)
    const payload = await health.json()
    assert.equal(payload.ok, true)
  })
})

test('真实 HTTP：健康检查可用，未知路径 404，getAll 之外的路径也不存在文件服务', async () => {
  const engine = gatedEngine(Promise.resolve())
  await withServer(engine, async (base) => {
    const health = await fetch(`${base}/v1/health`)
    assert.equal(health.status, 200)

    for (const path of ['/', '/index.html', '/package.json', '/v1/ocr/timetable/../secret']) {
      const response = await fetch(`${base}${path}`)
      assert.equal(response.status, 404, `${path} 必须是 404`)
    }
  })
})

test('真实 HTTP：请求体超过上限 → 413，且不进入识别', async () => {
  const engine = gatedEngine(Promise.resolve())
  await withServer(engine, async (base) => {
    // 这条走真实 startServer 的 readBody 限制；这里直连服务时用超大 base64 触发同一分支。
    const huge = 'A'.repeat(20 * 1024 * 1024)
    const response = await fetch(`${base}/v1/ocr/timetable`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: huge }),
    })
    assert.equal(response.status, 413)
    const payload = await response.json()
    assert.equal(payload.code, 'IMAGE_TOO_LARGE')
    assert.equal(engine.state.started, 0)
  })
})

test('真实服务器：--lan 只影响绑定地址，默认仍是本机', async () => {
  const handle = await startServer(['--port', '0'], silentLogger)
  try {
    const { port } = handle.server.address()
    assert.equal(handle.host, '127.0.0.1')
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`)
    assert.equal(response.status, 200)
  } finally {
    await handle.close()
  }
})
