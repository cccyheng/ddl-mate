/**
 * 照片识别（OCR）伴侣服务的客户端 —— 手机侧唯一会发网络请求的模块。
 *
 * 设计边界（与任务书一致）：
 * - 只发到**用户自己配置的本机电脑地址**（同一 Wi-Fi），不经过任何第三方服务；
 * - 超时、断网、服务没启动、图片过大、格式不支持、识别失败都映射成**可读的中文错误**，
 *   并带上 `retryable`，界面据此决定「重试」还是「换一张图」；
 * - 取消（用户离开页面）后回来的结果一律丢弃，不写进界面状态；
 * - **没有把地址写死在代码里**：默认地址由 Expo/Metro 的局域网主机名推断，用户可改。
 */

import { canonicalClock } from './scheduleSession'

/** 识别出来的一条候选（服务端字段，全部可能为 null —— 缺字段就是缺，不猜）。 */
export interface OcrCandidate {
  layout?: string
  name?: string | null
  weekday?: number | null
  startTime?: string | null
  endTime?: string | null
  periodStart?: number | null
  periodEnd?: number | null
  startWeek?: number | null
  endWeek?: number | null
  weekPattern?: string | null
  location?: string | null
  teacher?: string | null
  /**
   * 截图里课程名后面括号中的那串数字 —— **选课序号**（例如 `9913000172.08`）。
   *
   * 它**不是**学校课程代码，更不是 App 生成的 `AUTO-01` 内部编号。
   * 服务端一直把它放在这个字段里传过来（归档响应
   * `.tools/photo/phone-20261012-202526/response.json` 的每个候选都有），
   * 之前只是这一层没有声明，值就被丢掉了。声明出来之后由
   * `photoImport.rowFromCandidate` 原样搬到 `PhotoImportRow.selectionSerial`，
   * **绝不**写进 `courses.code`。
   */
  courseCode?: string | null
  rawText?: string | null
  warnings?: string[]
}

export interface OcrResponse {
  layout: string
  week: number | null
  candidates: OcrCandidate[]
  warnings: string[]
  diagnostics: Record<string, unknown>
  rawText: string
  ocrCalls: number | null
  ms: number | null
  image: { width: number; height: number; format: string; bytes: number } | null
  /**
   * 这次识别的请求号（伴侣服务开启本地诊断时才有）。
   *
   * 用途只有一个：真机失败时，可以拿这个号去本机诊断目录里找到
   * 「手机实际发出去的那张图」和当时的结果。缺失就是没开诊断，不是错误。
   */
  requestId: string | null
  /** 伴侣服务是否开着本地诊断模式（只影响提示文案，不影响识别结果）。 */
  diagnosticsMode: boolean
}

export type OcrErrorCode =
  | 'NO_ENDPOINT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'IMAGE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'BAD_REQUEST'
  | 'BUSY'
  | 'SERVICE'
  | 'BAD_RESPONSE'
  /** 服务可用，但这张图里没读到课程结构（例如只读到表头/时间栏文字）。 */
  | 'NO_STRUCTURE'

export class OcrClientError extends Error {
  readonly code: OcrErrorCode
  readonly retryable: boolean
  readonly detail: string | null

  constructor(code: OcrErrorCode, message: string, options: { retryable?: boolean; detail?: string | null } = {}) {
    super(message)
    this.name = 'OcrClientError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.detail = options.detail ?? null
  }
}

/** 主机名白名单：IPv4 或普通的域名/主机名。
 *
 * 用来挡住「用户把别的协议粘进来」这类输入：`ftp://192.168.1.5:8082` 在补上
 * `http://` 之后会被 URL 解析成主机名 `ftp`，如果不校验就会得到 `http://ftp` 这种
 * 看着合法、其实打不开的地址。
 */
const HOSTNAME_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/i

/** 端点规范化：补 `http://`、只保留协议+主机+端口、拒绝非法输入。 */
export function normalizeEndpoint(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  // 写了非 http(s) 协议的一律拒绝，而不是在它前面再糊一个 http://。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return null
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname) return null
    if (!HOSTNAME_RE.test(url.hostname)) return null
    // 拒绝带凭据的地址：不在产品范围，也避免把密码写进手机数据库。
    if (url.username || url.password) return null
    // `url.host` **已经包含端口**，这里必须用 hostname 重新拼一次，
    // 否则会得到 `http://192.168.31.73:8082:8082` 这种完全连不上的地址。
    const port = url.port ? `:${url.port}` : ''
    return `${url.protocol}//${url.hostname}${port}`
  } catch {
    return null
  }
}

/**
 * 由 Expo/Metro 的 `hostUri` 推断伴侣服务地址。
 *
 * 在 Expo Go 里，JS 是从电脑上的 Metro（默认 8081）加载的，`hostUri` 就是
 * 「电脑在局域网里的地址:8081」。伴侣服务跑在**同一台电脑**上，因此把端口换成
 * 伴侣端口即可 —— 这样用户不需要手抄 IP，也不需要在代码里写死某个地址。
 *
 * 不可靠时（模拟器、`localhost`、没有 hostUri）返回 `null`，界面提示用户手填。
 */
export function endpointFromHostUri(hostUri: string | null | undefined, port = 8082): string | null {
  const text = String(hostUri ?? '').trim()
  if (!text) return null
  const host = text.split('/')[0] ?? ''
  const hostname = host.split(':')[0] ?? ''
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return null
  if (!/^[0-9a-zA-Z.-]+$/.test(hostname)) return null
  return `http://${hostname}:${port}`
}

/** 取消信号的**兼容形状**：既接受真正的 `AbortSignal`，也接受 `{ cancelled }` 这种轮询式替身。 */
export type CancelSignal = AbortSignal | { cancelled: boolean }

export interface RecognizeOptions {
  imageBase64: string
  /** 兼容旧调用方；服务端忽略这个字段。 */
  mimeType?: string
  timeoutMs?: number
  signal?: CancelSignal
  /**
   * 真正的 `AbortSignal`（可选）。
   *
   * 调用方如果直接持有 `AbortController`，把它一起传进来就能在 abort 的**同一刻**结束请求；
   * 只给 `signal`（轮询式）也能工作，但会慢一个轮询周期。
   */
  abortSignal?: AbortSignal
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 200_000
/** 超时上限：再慢也不让界面无限转圈。 */
const MAX_TIMEOUT_MS = 300_000
/** 每上传 1MB 额外给的识别时间（本机 OCR 与图片大小强相关）。 */
const TIMEOUT_PER_MB_MS = 4_000

/**
 * 按图片大小算一个**合理但不无限**的识别超时。
 *
 * 之前是一个写死的 200 秒常量：小图要干等，大图又可能不够。
 * 这里按 base64 长度换算字节数线性放大，并夹在 `[DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS]` 内，
 * 保证「小图快点给结论、大图给足时间、任何情况都有上限」。
 */
export function recognizeTimeoutMs(imageBase64: string): number {
  const bytes = Math.floor((String(imageBase64 ?? '').replace(/\s/g, '').length * 3) / 4)
  const scaled = DEFAULT_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * TIMEOUT_PER_MB_MS
  return Math.max(DEFAULT_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, scaled))
}

/** 是否已经被要求取消（真实 AbortSignal 与 `{ cancelled }` 替身都支持）。 */
export function isCancelledSignal(signal: CancelSignal | undefined): boolean {
  if (!signal) return false
  if ('cancelled' in signal && typeof (signal as { cancelled: boolean }).cancelled === 'boolean') {
    return (signal as { cancelled: boolean }).cancelled
  }
  const abort = signal as AbortSignal
  return typeof abort.aborted === 'boolean' ? abort.aborted : false
}

/**
 * 把「外部取消信号」变成一条可竞速的拒绝理由。
 *
 * 为什么要主动竞速而不是只依赖 `fetch` 的 abort：
 * 在 RN/Hermes 上 abort 有时只在**下一次事件循环**才反映成 `AbortError`，
 * 那样界面会先一步把「这次没结果」当成网络失败。主动竞速保证取消立刻生效。
 */
export function cancellationRejection(signal: CancelSignal | undefined): {
  promise: Promise<never>
  dispose: () => void
} {
  let dispose = (): void => undefined
  const promise = new Promise<never>((_resolve, reject) => {
    if (!signal) return
    if (isCancelledSignal(signal)) {
      reject(new OcrClientError('CANCELLED', '这次识别已经取消。', { retryable: true }))
      return
    }
    const target = signal as AbortSignal
    if (typeof target.addEventListener !== 'function') return
    const onAbort = (): void => {
      reject(new OcrClientError('CANCELLED', '这次识别已经取消。', { retryable: true }))
    }
    target.addEventListener('abort', onAbort)
    dispose = () => target.removeEventListener?.('abort', onAbort)
  })
  // 竞速用的 Promise 可能永远不 settle（没取消时）；这里吞掉未处理拒绝，避免它变成 unhandled rejection。
  promise.catch(() => undefined)
  return { promise, dispose }
}

/** 把一次 HTTP 响应映射成结构化错误（区分「能重试」与「必须改输入」）。 */
export async function toClientError(response: Response): Promise<OcrClientError> {
  let payload: { code?: string; message?: string } = {}
  try {
    payload = (await response.json()) as { code?: string; message?: string }
  } catch {
    payload = {}
  }
  const message = payload.message ?? `服务返回 ${response.status}。`
  switch (payload.code) {
    case 'IMAGE_TOO_LARGE':
      return new OcrClientError('IMAGE_TOO_LARGE', message, { retryable: false })
    case 'UNSUPPORTED_FORMAT':
      return new OcrClientError('UNSUPPORTED_FORMAT', message, { retryable: false })
    case 'STRUCTURE_NOT_FOUND':
      // 服务是好的，是这张图没读到课程结构：让用户换一张/裁剪，而不是反复重试同一张。
      return new OcrClientError('NO_STRUCTURE', message, { retryable: false, detail: payload.code })
    case 'BAD_REQUEST':
    case 'BAD_JSON':
      return new OcrClientError('BAD_REQUEST', message, { retryable: false })
    case 'BUSY':
      return new OcrClientError('BUSY', message, { retryable: true })
    default:
      return new OcrClientError(response.status >= 500 ? 'SERVICE' : 'BAD_REQUEST', message, {
        retryable: response.status >= 500,
      })
  }
}

/** 等待一小段时间（重试退避用；测试里可以注入零延迟）。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 解析出本次请求要用的服务地址（预检 / 识别 / 设置页共用）。
 *
 * 返回结构化原因而不是 `null`：界面要能说清「是没填地址」还是「填的地址格式不对」，
 * 而不是笼统地「没有结果」。
 */
export function resolveOcrEndpoint(
  endpoint: string | null | undefined,
): { ok: true; endpoint: string } | { ok: false; reason: 'empty' | 'invalid' } {
  const text = String(endpoint ?? '').trim()
  if (text.length === 0) return { ok: false, reason: 'empty' }
  const normalized = normalizeEndpoint(text)
  if (!normalized) return { ok: false, reason: 'invalid' }
  return { ok: true, endpoint: normalized }
}

/**
 * 调用伴侣服务识别一张图片。
 *
 * 失败一律抛 `OcrClientError`：界面按 `code` 与 `retryable` 决定提示什么、给不给重试按钮。
 * 取消（用户离开页面 / 新一轮请求覆盖旧请求）会抛 `CANCELLED`，**不会**被说成超时。
 */
export async function recognizeTimetableImage(
  endpoint: string | null,
  options: RecognizeOptions,
): Promise<OcrResponse> {
  const resolved = resolveOcrEndpoint(endpoint)
  if (!resolved.ok) {
    throw new OcrClientError(
      'NO_ENDPOINT',
      resolved.reason === 'empty'
        ? '还没有设置这台电脑的识别服务地址。请到「识别服务设置」里填写。'
        : '识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。',
      { retryable: false },
    )
  }
  const base = resolved.endpoint
  if (!options.imageBase64 || options.imageBase64.length === 0) {
    throw new OcrClientError('BAD_REQUEST', '没有读到图片内容，请重新拍照或选择一张图片。', { retryable: false })
  }

  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? recognizeTimeoutMs(options.imageBase64)
  /** 区分「到时间了」和「用户走了」：两者都会 abort，但要说不同的话。 */
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const poll = setInterval(() => {
    if (isCancelledSignal(options.signal)) controller.abort()
  }, 100)
  // 调用方直接给了 AbortSignal 时，abort **同一刻**就结束这次请求（不用等轮询）。
  const externalSignal = options.abortSignal
  const onExternalAbort = (): void => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener?.('abort', onExternalAbort)
  }
  const cancelRace = cancellationRejection(options.signal ?? externalSignal)

  try {
    const response = await Promise.race([
      doFetch(`${base}/v1/ocr/timetable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageBase64: options.imageBase64, mimeType: options.mimeType ?? 'image/jpeg' }),
        signal: controller.signal,
      }),
      cancelRace.promise,
    ])
    // 竞速可能先返回响应，但此刻用户已经离开了 —— 结果直接丢弃，不能写进界面状态。
    if (isCancelledSignal(options.signal) || controller.signal.aborted) {
      if (!timedOut) throw new OcrClientError('CANCELLED', '这次识别已经取消。', { retryable: true })
    }
    if (!response.ok) throw await toClientError(response)
    const payload = (await response.json()) as OcrResponse & { ok?: boolean }
    if (!payload || !Array.isArray(payload.candidates)) {
      throw new OcrClientError('BAD_RESPONSE', '识别服务返回的内容看不懂，请确认 App 与服务版本一致。', {
        retryable: true,
      })
    }
    return {
      layout: payload.layout ?? 'unknown',
      week: typeof payload.week === 'number' ? payload.week : null,
      candidates: payload.candidates,
      warnings: payload.warnings ?? [],
      diagnostics: payload.diagnostics ?? {},
      rawText: payload.rawText ?? '',
      ocrCalls: payload.ocrCalls ?? null,
      ms: payload.ms ?? null,
      image: payload.image ?? null,
      requestId: typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : null,
      diagnosticsMode: payload.diagnosticsMode === true,
    }
  } catch (cause) {
    if (cause instanceof OcrClientError) throw cause
    // 先判「是不是取消」：取消也可能表现成 AbortError，绝不能被翻译成「超时」。
    if (isCancelledSignal(options.signal) || (controller.signal.aborted && !timedOut)) {
      throw new OcrClientError('CANCELLED', '这次识别已经取消。', { retryable: true })
    }
    const isAbort = cause instanceof Error && cause.name === 'AbortError'
    if (timedOut || isAbort) {
      throw new OcrClientError('TIMEOUT', '这台电脑太久没有响应（可能正在识别上一张图）。请稍后重试。', {
        retryable: true,
      })
    }
    throw new OcrClientError(
      'NETWORK',
      '连不上这台电脑上的识别服务。请确认电脑与手机在同一个 Wi-Fi，并且电脑上的识别服务已经启动。',
      { retryable: true, detail: cause instanceof Error ? cause.message : String(cause) },
    )
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    cancelRace.dispose()
    externalSignal?.removeEventListener?.('abort', onExternalAbort)
  }
}

/** 健康检查：用来在设置页告诉用户「连上了 / 连不上」，不参与识别。 */
export async function checkCompanionHealth(
  endpoint: string | null,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; service: string; version: string } | { ok: false; error: OcrClientError }> {
  const resolved = resolveOcrEndpoint(endpoint)
  if (!resolved.ok) {
    return {
      ok: false,
      error: new OcrClientError(
        'NO_ENDPOINT',
        resolved.reason === 'empty' ? '还没有填写识别服务地址。' : '识别服务地址格式不对，先改好再测。',
        { retryable: false },
      ),
    }
  }
  const base = resolved.endpoint
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6_000)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${base}/v1/health`, { signal: controller.signal })
    if (!response.ok) {
      return { ok: false, error: new OcrClientError('SERVICE', `服务返回 ${response.status}。`, { retryable: true }) }
    }
    const payload = (await response.json()) as { ok?: boolean; service?: string; serviceVersion?: string }
    if (!payload?.ok) {
      return {
        ok: false,
        error: new OcrClientError('BAD_RESPONSE', '这不是 DDL Mate 的识别服务。', { retryable: false }),
      }
    }
    return { ok: true, service: payload.service ?? 'unknown', version: payload.serviceVersion ?? '?' }
  } catch (cause) {
    return {
      ok: false,
      error:
        cause instanceof Error && cause.name === 'AbortError'
          ? new OcrClientError('TIMEOUT', '健康检查超时。', { retryable: true })
          : new OcrClientError('NETWORK', '连不上识别服务。', {
              retryable: true,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 识别出的时间文本规范化（服务端偶尔会给出 `8:00`）。 */
export function normalizedOcrClock(value: string | null | undefined): string | null {
  return canonicalClock(value ?? null)
}
