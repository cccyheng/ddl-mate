/**
 * 通知 OCR 客户端：端点 / 严格响应校验 / 取消 / 超时 / HTTP 错误语义。
 *
 * 全部用注入的 `fetchImpl`，不会真的发网络请求。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OcrClientError,
  normalizeEndpoint,
  resolveOcrEndpoint,
} from '../src/domain/photoOcrClient.ts'
import { recognizeNoticeImage } from '../src/domain/noticeOcrClient.ts'

const ENDPOINT = 'http://192.168.31.73:8082'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('端点规范化与课表客户端完全共用', () => {
  assert.equal(normalizeEndpoint('192.168.31.73:8082'), ENDPOINT)
  assert.deepEqual(resolveOcrEndpoint(''), { ok: false, reason: 'empty' })
  assert.deepEqual(resolveOcrEndpoint('ftp://192.168.31.73:8082'), { ok: false, reason: 'invalid' })
})

test('正常响应：rawText 原样返回（包括换行与前后空白），请求号 / 图片 / 警告都保留', async () => {
  const wanted = '  第一行通知\n第二行：2026年10月20日 22:00 前提交\n'
  let seenUrl = null
  let seenBody = null
  const response = await recognizeNoticeImage(ENDPOINT, {
    imageBase64: 'AAAA',
    timeoutMs: 1_000,
    fetchImpl: async (url, init) => {
      seenUrl = String(url)
      seenBody = JSON.parse(String(init.body))
      return jsonResponse({
        ok: true,
        rawText: wanted,
        requestId: 'req-9',
        image: { width: 900, height: 1200, format: 'png', bytes: 1234 },
        warnings: ['一条提示', 42],
        ms: 12,
        ocrCalls: 2,
        diagnosticsMode: true,
      })
    },
  })
  assert.equal(seenUrl, `${ENDPOINT}/v1/ocr/notice`)
  assert.equal(seenBody.imageBase64, 'AAAA')
  assert.equal(response.rawText, wanted, '不能 trim / 不能截断')
  assert.equal(response.requestId, 'req-9')
  assert.deepEqual(response.image, { width: 900, height: 1200, format: 'png', bytes: 1234 })
  assert.deepEqual(response.warnings, ['一条提示'], '非字符串 warning 被丢弃，不强行转换')
  assert.equal(response.diagnosticsMode, true)
  assert.equal(response.empty, false)
})

test('空文字是合法结果：不编造候选、不报错', async () => {
  const response = await recognizeNoticeImage(ENDPOINT, {
    imageBase64: 'AAAA',
    timeoutMs: 1_000,
    fetchImpl: async () =>
      jsonResponse({ ok: true, rawText: '', requestId: null, warnings: ['没有识别到文字'], ms: 1 }),
  })
  assert.equal(response.rawText, '')
  assert.equal(response.empty, true)
  assert.equal(response.requestId, null)
})

test('严格校验：rawText 不是字符串就报 BAD_RESPONSE，绝不 String() 强转', async () => {
  for (const bad of [
    { ok: true, rawText: { text: '伪造对象' } },
    { ok: true, rawText: 123 },
    { ok: true, rawText: null },
    { ok: true },
  ]) {
    await assert.rejects(
      () =>
        recognizeNoticeImage(ENDPOINT, {
          imageBase64: 'AAAA',
          timeoutMs: 1_000,
          fetchImpl: async () => jsonResponse(bad),
        }),
      (cause) => cause instanceof OcrClientError && cause.code === 'BAD_RESPONSE',
    )
  }
})

test('没有端点：明确的中文可操作错误，不发请求', async () => {
  let called = 0
  await assert.rejects(
    () =>
      recognizeNoticeImage(null, {
        imageBase64: 'AAAA',
        fetchImpl: async () => {
          called += 1
          return jsonResponse({ ok: true, rawText: '' })
        },
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'NO_ENDPOINT',
  )
  assert.equal(called, 0)
})

test('超时：抛 TIMEOUT，不会误报成取消；计时器清理后不再挂住', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 5,
        fetchImpl: (url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          }),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'TIMEOUT' && cause.retryable === true,
  )
})

test('外部取消：抛 CANCELLED，而不是超时；迟到的成功响应会被丢弃', async () => {
  const controller = new AbortController()
  const pending = recognizeNoticeImage(ENDPOINT, {
    imageBase64: 'AAAA',
    timeoutMs: 5_000,
    abortSignal: controller.signal,
    fetchImpl: () => new Promise(() => undefined),
  })
  const timer = setTimeout(() => controller.abort(), 5)
  try {
    await assert.rejects(
      () => pending,
      (cause) => cause instanceof OcrClientError && cause.code === 'CANCELLED',
    )
  } finally {
    clearTimeout(timer)
  }
})

test('HTTP 错误映射：BUSY 可重试，图片过大不可重试', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () => jsonResponse({ code: 'BUSY', message: '这电脑正在识别上一张。' }, 429),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'BUSY' && cause.retryable === true,
  )
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () => jsonResponse({ code: 'IMAGE_TOO_LARGE', message: '太大了。' }, 413),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'IMAGE_TOO_LARGE' && cause.retryable === false,
  )
})

test('HTTP 200 但 ok:false 不能伪装成功（即使 rawText 是字符串）', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({ ok: false, rawText: 'not a successful result' }),
        }),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'BAD_RESPONSE',
  )
})

test('取消发生在 body 解码期间：必须抛 CANCELLED，不能返回成功', async () => {
  const controller = new AbortController()
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        abortSignal: controller.signal,
        fetchImpl: async () => ({
          ok: true,
          json: async () => {
            controller.abort()
            return { ok: true, rawText: '迟到的成功结果' }
          },
        }),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'CANCELLED',
  )
})

test('超时发生在 body 解码期间：必须抛 TIMEOUT，不能返回成功', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 10,
        fetchImpl: async () => ({
          ok: true,
          json: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40))
            return { ok: true, rawText: '超时之后才读完' }
          },
        }),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'TIMEOUT',
  )
})

test('旧版伴侣服务 404：给出「需要更新电脑服务」的明确说明', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () => jsonResponse({ code: 'NOT_FOUND', message: '没有这个接口。' }, 404),
      }),
    (cause) =>
      cause instanceof OcrClientError &&
      cause.code === 'BAD_RESPONSE' &&
      cause.retryable === false &&
      /版本较旧|更新/.test(cause.message),
  )
})

test('电脑侧 499（取消 / 超时）按可重试超时处理，不伪装成功', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () =>
          jsonResponse({ ok: false, code: 'CANCELLED', message: '这次识别在完成前被取消。' }, 499),
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'TIMEOUT' && cause.retryable === true,
  )
})

test('网络失败：抛 NETWORK 且可重试', async () => {
  await assert.rejects(
    () =>
      recognizeNoticeImage(ENDPOINT, {
        imageBase64: 'AAAA',
        timeoutMs: 1_000,
        fetchImpl: async () => {
          throw new TypeError('fetch failed')
        },
      }),
    (cause) => cause instanceof OcrClientError && cause.code === 'NETWORK' && cause.retryable === true,
  )
})
