/**
 * 「一张通知截图 → 本机电脑上的纯文字」客户端。
 *
 * 与 `photoOcrClient.ts` 共用同一套**端点规范化、取消、超时、HTTP 错误语义**：
 * - 只发到用户自己配置的同一 Wi-Fi 电脑地址，不经过任何第三方；
 * - 取消 / 超时 / 断网 / 服务没启动 / 图片过大都映射成可读中文错误 + `retryable`；
 * - 取消后迟到的响应一律丢弃；所有计时器与监听器都在 `finally` 里清理；
 * - 响应严格校验：`rawText` 必须是字符串。**绝不**把对象 / 数字强转成文字，
 *   也绝不因为 `rawText` 为空就伪造候选 —— 空就是空，由界面如实显示。
 *
 * 这条链路不解析课表、不写数据库：任务只在既有的 NoticeImport 核对页里、
 * 用户明确勾选并保存时才写入。
 */

import {
  OcrClientError,
  cancellationRejection,
  isCancelledSignal,
  recognizeTimeoutMs,
  resolveOcrEndpoint,
  toClientError,
  type CancelSignal,
} from './photoOcrClient'

/** 通知识别返回的图片元数据（只用于界面说明，不参与任何业务判断）。 */
export interface NoticeOcrImage {
  width: number
  height: number
  format: string
  bytes: number
}

export interface NoticeOcrResponse {
  /** 按阅读顺序保留换行的纯文字；可能为空串（图里确实没有字）。 */
  rawText: string
  /** 伴侣服务开启本地诊断时才有；用于在电脑上定位这一次请求。 */
  requestId: string | null
  image: NoticeOcrImage | null
  warnings: string[]
  ms: number | null
  ocrCalls: number | null
  diagnosticsMode: boolean
  /** 服务端明确说「没有读到任何文字」；也兼容旧服务（按 `rawText` 为空推断）。 */
  empty: boolean
}

export interface RecognizeNoticeOptions {
  kind?: 'notice' | 'exams'
  imageBase64: string
  /** 兼容旧调用方；服务端忽略这个字段。 */
  mimeType?: string
  timeoutMs?: number
  /** 轮询式取消信号（与 `photoOcrClient` 同一形状）。 */
  signal?: CancelSignal
  /** 真正的 `AbortSignal`：abort 的同一刻结束请求。 */
  abortSignal?: AbortSignal
  fetchImpl?: typeof fetch
}

function isNoticeImage(value: unknown): value is NoticeOcrImage {
  if (!value || typeof value !== 'object') return false
  const image = value as Record<string, unknown>
  return (
    typeof image.width === 'number' &&
    typeof image.height === 'number' &&
    typeof image.format === 'string' &&
    typeof image.bytes === 'number'
  )
}

/**
 * 调用伴侣服务的 `POST /v1/ocr/notice`。
 *
 * 失败一律抛 `OcrClientError`，界面按 `code` 与 `retryable` 决定提示什么、给不给重试。
 */
export async function recognizeNoticeImage(
  endpoint: string | null,
  options: RecognizeNoticeOptions,
): Promise<NoticeOcrResponse> {
  const resolved = resolveOcrEndpoint(endpoint)
  if (!resolved.ok) {
    throw new OcrClientError(
      'NO_ENDPOINT',
      resolved.reason === 'empty'
        ? '还没有设置这台电脑的文字识别服务地址。请到「识别服务设置」里填写（手机与电脑要连同一个 Wi-Fi）。'
        : '文字识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。',
      { retryable: false },
    )
  }
  const base = resolved.endpoint
  if (typeof options.imageBase64 !== 'string' || options.imageBase64.length === 0) {
    throw new OcrClientError('BAD_REQUEST', '没有读到图片内容，请重新选择一张通知截图。', { retryable: false })
  }

  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = Math.max(0, options.timeoutMs ?? recognizeTimeoutMs(options.imageBase64))
  /** 区分「到时间了」和「用户走了」：两者都会 abort，但要说不同的话。 */
  let timedOut = false

  /**
   * 整个操作的截止时间（**不只是 fetch**）。
   *
   * 关键点：`fetch` 已经返回、正在 `response.json()` 读 body 时，注入的 / 真实网络实现
   * 仍可能忽略 abort 并慢慢解码。这里用一个**会拒绝的** timeout promise 和每一次
   * await 竞速，保证「响应在超时之后才读完」绝不会变成成功。
   */
  let rejectTimeout: (cause: OcrClientError) => void = () => undefined
  const timeoutRace = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  // 竞速失败方可能永远不再被 await；提前吞掉，避免变成 unhandled rejection。
  timeoutRace.catch(() => undefined)
  const timer = setTimeout(() => {
    timedOut = true
    const cause = new OcrClientError(
      'TIMEOUT',
      '这台电脑太久没有响应（可能正在识别上一张图）。请稍后重试。',
      { retryable: true },
    )
    // 先 abort（让支持 abort 的实现尽快停下），再拒绝竞速：两者都算「超时」。
    controller.abort()
    rejectTimeout(cause)
  }, timeoutMs)
  const poll = setInterval(() => {
    if (isCancelledSignal(options.signal)) controller.abort()
  }, 100)
  const externalSignal = options.abortSignal
  const onExternalAbort = (): void => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener?.('abort', onExternalAbort)
  }
  const cancelRace = cancellationRejection(options.signal ?? externalSignal)

  /** 每个 await 都同时和「超时」「取消」竞速。 */
  const race = <T,>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, cancelRace.promise as Promise<T>, timeoutRace])
  /** 给可能被竞速抛下的 Promise 挂一个吞错，避免 unhandled rejection。 */
  const settleSafely = <T,>(promise: Promise<T>): Promise<T> => {
    promise.catch(() => undefined)
    return promise
  }

  const timeoutError = (): OcrClientError =>
    new OcrClientError('TIMEOUT', '这台电脑太久没有响应（可能正在识别上一张图）。请稍后重试。', {
      retryable: true,
    })
  const cancelledError = (): OcrClientError =>
    new OcrClientError('CANCELLED', '这次文字识别已经取消。', { retryable: true })

  try {
    const response = await race(
      settleSafely(
        doFetch(`${base}/v1/ocr/${options.kind === 'exams' ? 'exams' : 'notice'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ imageBase64: options.imageBase64, mimeType: options.mimeType ?? 'image/jpeg' }),
          signal: controller.signal,
        }),
      ),
    )
    // 竞速可能先拿到响应，但此刻用户已经取消 / 已经超时：结果直接丢弃。
    if (timedOut) throw timeoutError()
    if (isCancelledSignal(options.signal) || (controller.signal.aborted && !timedOut)) throw cancelledError()
    if (!response.ok) {
      // 旧版伴侣服务没有 /v1/ocr/notice：给出「需要更新电脑服务」的明确说明，
      // 而不是让用户看到一句笼统的「服务返回 404」。
      if (response.status === 404) {
        throw new OcrClientError(
          'BAD_RESPONSE',
          '这台电脑上的识别服务版本较旧，不支持通知文字识别。请更新电脑上的伴侣服务后再试。',
          { retryable: false },
        )
      }
      // 499 是本服务对「客户端断开 / 服务端超时」的明确状态：从手机侧收到它，
      // 说明电脑上的识别没能在时限内完成，按可重试超时处理。
      if (response.status === 499) throw timeoutError()
      // 错误响应体也可能卡住：同样和超时 / 取消竞速。
      const errorPromise = settleSafely(Promise.resolve(toClientError(response)))
      throw await race(errorPromise)
    }

    if (typeof response.json !== 'function') {
      throw new OcrClientError('BAD_RESPONSE', '文字识别服务返回的内容看不懂，请确认 App 与服务版本一致。', {
        retryable: true,
      })
    }

    let payload: unknown
    // body 解码也和超时 / 取消竞速，而不是只保护 fetch。
    const jsonPromise = settleSafely(Promise.resolve().then(() => response.json()))
    try {
      payload = await race(jsonPromise)
    } catch (cause) {
      if (cause instanceof OcrClientError) throw cause
      if (timedOut) throw timeoutError()
      if (isCancelledSignal(options.signal) || (controller.signal.aborted && !timedOut)) throw cancelledError()
      throw new OcrClientError('BAD_RESPONSE', '文字识别服务返回的内容看不懂，请确认 App 与服务版本一致。', {
        retryable: true,
      })
    }
    // 读完 body 之后、返回之前再判一次：取消 / 超时可能恰好发生在这个间隙。
    if (timedOut) throw timeoutError()
    if (isCancelledSignal(options.signal) || (controller.signal.aborted && !timedOut)) throw cancelledError()

    if (!payload || typeof payload !== 'object') {
      throw new OcrClientError('BAD_RESPONSE', '文字识别服务返回的内容看不懂，请确认 App 与服务版本一致。', {
        retryable: true,
      })
    }
    const record = payload as Record<string, unknown>
    // **必须显式成功**：HTTP 200 但 `ok:false` 不能伪装成功。
    if (record.ok !== true) {
      const message =
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : '文字识别服务没有返回成功结果。请确认 App 与服务版本一致。'
      throw new OcrClientError('BAD_RESPONSE', message, { retryable: true })
    }
    // 严格校验：rawText 必须是字符串。对象 / 数字一律拒绝，绝不 `String(...)` 强转。
    if (typeof record.rawText !== 'string') {
      throw new OcrClientError(
        'BAD_RESPONSE',
        '文字识别服务没有返回纯文字结果（可能是旧版服务）。请让电脑上的识别服务升级后再试。',
        { retryable: true },
      )
    }
    const rawText = record.rawText
    // 服务端明确标了取消（客户端断开 / 超时）：绝不能当成「识别成功的空文字」。
    if (record.cancelled === true) throw cancelledError()
    return {
      rawText,
      requestId: typeof record.requestId === 'string' && record.requestId ? record.requestId : null,
      image: isNoticeImage(record.image) ? record.image : null,
      warnings: Array.isArray(record.warnings)
        ? record.warnings.filter((warning): warning is string => typeof warning === 'string')
        : [],
      ms: typeof record.ms === 'number' ? record.ms : null,
      ocrCalls: typeof record.ocrCalls === 'number' ? record.ocrCalls : null,
      diagnosticsMode: record.diagnosticsMode === true,
      empty: rawText.length === 0 || record.empty === true,
    }
  } catch (cause) {
    if (cause instanceof OcrClientError) throw cause
    // 先判「超时」与「取消」：取消也可能表现成 AbortError，绝不能被翻译成网络失败。
    if (timedOut) throw timeoutError()
    if (isCancelledSignal(options.signal) || (controller.signal.aborted && !timedOut)) {
      throw cancelledError()
    }
    const isAbort = cause instanceof Error && cause.name === 'AbortError'
    if (isAbort) {
      // 没有超时、也不是外部取消，但底层以 AbortError 结束：按超时处理更贴近事实。
      throw timeoutError()
    }
    throw new OcrClientError(
      'NETWORK',
      '连不上这台电脑上的文字识别服务。请确认电脑与手机在同一个 Wi-Fi，并且电脑上的识别服务已经启动。',
      { retryable: true, detail: cause instanceof Error ? cause.message : String(cause) },
    )
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    cancelRace.dispose()
    externalSignal?.removeEventListener?.('abort', onExternalAbort)
  }
}
