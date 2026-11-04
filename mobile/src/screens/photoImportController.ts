/**
 * 拍照导入课表 —— **可测试的运行状态机**（不依赖 React / React Native / Expo）。
 *
 * 这个文件修的是用户实际遇到的 bug：**选完照片没有任何结果、也没有反应**。
 * 根因不止一个，所以这里把整条生命周期收进一个显式的对象里：
 *
 * 1. **每次尝试完全独立（attempt-owned）**：每次选择/识别都有自己的 `attemptId` 与
 *    `AbortController`，`settle()` 只允许**属于自己那一次尝试**去收尾。
 *    否则会出现这种串台：A 还在识别 → 用户离开（A 被取消并 settle）→ 用户回来发起 B →
 *    A 的 `finally` 把 **B** 的 busy / controller 清掉（B 的结果被丢弃或者界面卡死）。
 *    旧实现还有一个更隐蔽的版本：取消读取器读的是**共享的**可变 controller，
 *    于是「重新聚焦 / 新开一轮」会把旧请求的取消状态又变回「没取消」，迟到的结果照样写进界面。
 * 2. **取消 ≠ 静默**：用户离开页面时**真的** `abort()`，并且把界面从 busy 里放出来，
 *    回到页面能看到可以重试，而不是永远转圈或假装无事发生。
 * 3. **系统弹窗不算离开**：iOS 的权限弹窗 / 相册选择器会让页面失去焦点。
 *    在「选择器还开着」的窗口内，失焦只降级成**延后取消**：选择器回来后如果用户其实还在这一页，
 *    流程继续；如果用户真的走了（没有回到这一页），流程立刻结束并释放 busy。
 * 4. **永远不会永远 busy**：无论成功、失败、取消、超时，都会把自己那次尝试收掉。
 * 5. **不会重复启动**：选择器 / 识别在跑的时候再点按钮直接返回，不排队、不并发。
 * 6. **上一张图的结果不会被当成新图的结果**：开始新一轮时先把 `rows` / `response` 清掉。
 */

import { OcrClientError, resolveOcrEndpoint, type CancelSignal, type OcrResponse } from '../domain/photoOcrClient'
import { toPhotoError, type PhotoSourceInfo } from '../domain/photoFiles'
import { rowFromCandidate, type PhotoImportRow } from '../domain/photoImport'

/* --------------------------------- 公共类型 -------------------------------- */

export type PhotoImportStage = 'idle' | 'preparing' | 'checking' | 'uploading' | 'processing' | 'done'

export const PHOTO_IMPORT_STAGE_TEXT: Record<PhotoImportStage, string> = {
  idle: '',
  preparing: '正在准备这张照片…',
  checking: '正在确认电脑上的识别服务是否可用…',
  uploading: '正在把照片送到你自己电脑上的识别服务…',
  processing: '电脑正在识别这张课表…',
  done: '',
}

export interface PhotoImportState {
  stage: PhotoImportStage
  progress: string
  /** 已经准备好的本机图片（用于预览）。 */
  photoUri: string | null
  photoBytes: number | null
  photoWidth: number | null
  photoHeight: number | null
  sourceWidth: number | null
  sourceHeight: number | null
  /** 实际发出去的编码：`png`（无损）或 `jpeg`。 */
  photoFormat: 'png' | 'jpeg' | null
  /** 是否因为超过上传上限而缩小过（用于界面说明，不隐藏降质）。 */
  photoScaled: boolean
  rows: PhotoImportRow[]
  response: OcrResponse | null
  endpointUsed: string | null
  /**
   * 这次识别的请求号（伴侣服务开着本地诊断时才有）。
   *
   * 只用于「真机出错时能对上电脑上的原始捕获」，不参与任何业务判断；
   * 界面只在有值且诊断模式开着时显示一行短标签。
   */
  requestId: string | null
  /** 伴侣服务是否开着本地诊断模式（决定要不要显示请求号）。 */
  diagnosticsMode: boolean
  /**
   * 这张图在**软件截图库**里的尝试 id（识别之前就已经归档并登记）。
   *
   * 有值时：识别结果与之后的导入都能挂回原图（关掉 App 也还在）。
   * 为 `null` 且 `archiveError` 不为空时：归档失败，识别照常但**这张图没存住**。
   */
  archivedAttemptId: number | null
  /** 归档失败的可读原因；`null` 表示归档成功或还没开始。 */
  archiveError: string | null
  /** 原图是否真的落盘成功（界面据此说「已保存到截图库」还是「没能保存」）。 */
  archivedOriginal: boolean
  error: { message: string; code: string; retryable: boolean } | null
  busy: boolean
}

export interface PhotoImportToast {
  text: string
  tone: 'success' | 'error'
}

/** 一次「选照片 / 拍照」的结果。 */
export type PhotoPickResult =
  | { status: 'picked'; uri: string; source?: PhotoSourceInfo }
  | { status: 'cancelled' }
  | { status: 'permission'; message: string; canAskAgain: boolean }
  | { status: 'error'; message: string }

export interface PhotoImportAdapter {
  /** 相册选择（内部包含权限申请）。 */
  pickFromLibrary: () => Promise<PhotoPickResult>
  /** 相机（内部包含权限申请）。 */
  captureFromCamera: () => Promise<PhotoPickResult>
  /** 手机侧压缩/转码。 */
  preparePhoto: (uri: string, source?: PhotoSourceInfo) => Promise<{
    uri: string
    base64: string
    byteLength: number
    mimeType: string
    width: number | null
    height: number | null
    sourceWidth: number | null
    sourceHeight: number | null
    resized: boolean
    scale: number
    quality: number
    format: 'png' | 'jpeg'
    preservedSource: boolean
    attempts: number
  }>
  /** 健康预检（短超时，失败不阻塞识别，只提示）。 */
  checkHealth: (endpoint: string, timeoutMs?: number) => Promise<boolean>
  /** 真正的识别调用。 */
  recognize: (
    endpoint: string | null,
    options: { imageBase64: string; mimeType: string; signal: CancelSignal; abortSignal: AbortSignal },
  ) => Promise<OcrResponse>
  /** 订阅 store 快照变化（可选）。 */
  subscribe?: (listener: () => void) => { unsubscribe: () => void }
  getEndpoint: () => string | null
  getInferredEndpoint: () => string | null
  /** 自己这台电脑上的地址还没保存时，一键检测并把可用的地址存下来。 */
  configureEndpoint?: (candidate: string) => Promise<{ ok: boolean; endpoint: string | null; message: string }>
  /** 回到本页时重新读一次 store 快照（列表 / 校准 / 地址）。 */
  refreshStore: () => Promise<void>
  /**
   * **识别之前**把原图归档进软件截图库并登记一次尝试。
   *
   * 返回 `ok: false` 时识别照常进行（用的是内存里的字节），只是这张图以后回看不了；
   * 控制器把原因放进 `archiveError` 让界面如实说明，绝不假装保存成功。
   * 未注入时（例如只测生命周期的最小替身）跳过归档，状态里标成「没有保存」。
   */
  archiveOriginal?: (
    uri: string,
    source: PhotoSourceInfo | undefined,
    attemptSource: 'LIBRARY' | 'CAMERA',
  ) => Promise<{ ok: boolean; attemptId: number | null; message: string | null }>
  /**
   * 把这一次识别结果（成功 / 失败 / 取消）登记进截图库。
   *
   * `attemptId` 为 `null`（归档那一步就没成功）时调用方应直接跳过：没有尝试记录，
   * 结果也就无处可挂。这个回调**不允许抛异常**（控制器不 await 它的失败）。
   */
  recordResult?: (input: {
    attemptId: number | null
    status: 'SUCCESS' | 'FAILED' | 'CANCELLED'
    response?: OcrResponse
    rawText?: string
    errorCode?: string
    errorMessage?: string
    candidates?: readonly OcrCandidateLike[]
  }) => void | Promise<void>
  /** 一次识别结束后（可用来刷新截图库列表）。 */
  onAttemptFinished?: () => void
  /**
   * 一次识别**成功并已经拿到候选行**之后的通知（截图库「重新识别」用它跳核对页）。
   *
   * 只在结果已经落历史、且这一轮仍然属于当前界面时触发。
   */
  onDone?: (input: {
    attemptId: number | null
    rows: PhotoImportRow[]
    week: number | null
    requestId: string | null
  }) => void
}

/**
 * 控制器只关心「候选行里有没有这几项」，因此不 import `OcrCandidate` 的具体形状
 * （避免把 OCR 客户端的实现细节绑进状态机）。结构性类型 ⇒ 真类型也满足。
 */
export interface OcrCandidateLike {
  name?: string | null
  weekday?: number | null
  startTime?: string | null
  endTime?: string | null
  startWeek?: number | null
  endWeek?: number | null
  weekPattern?: string | null
  location?: string | null
  courseCode?: string | null
  rawText?: string | null
  warnings?: string[]
}

export interface PhotoImportOperation {
  getState: () => PhotoImportState
  subscribe: (listener: () => void) => () => void
  pickFromLibrary: () => Promise<void>
  captureFromCamera: () => Promise<void>
  /** 用**同一张已经选过的图**再识别一次。 */
  retryLastPhoto: () => Promise<void>
  /**
   * 用一张**已经存在于截图库**的原图重新识别（截图库页用）。
   *
   * 与 `retryLastPhoto` 的区别：这里不经过选择器，直接对一份已知的归档文件
   * 归档（新尝试）→ 转码 → 识别；因此同样有取消、超时、结果登记与"不覆盖旧历史"。
   */
  recognizeArchived: (uri: string) => Promise<void>
  /** 一键检测并保存本机推断出来的识别服务地址。 */
  configureInferredEndpoint: () => Promise<void>
  /** 页面获得焦点（清掉「用户已离开」标记）。 */
  focus: () => void
  /** 页面失去焦点；选择器还开着时只标记延后取消。 */
  blur: () => void
  /** 真正卸载时调用：停下来并释放（之后再 `attach()` 可以继续用）。 */
  dispose: () => void
  /** 重新挂上界面（React StrictMode 的 setup → cleanup → setup 会走到这里）。 */
  attach: () => void
  /** 是否已经挂上（诊断 / 测试用）。 */
  readonly attached: boolean
  readonly active: boolean
}

export interface PhotoImportDeps extends PhotoImportAdapter {
  /**
   * 初始状态（可只给关心的字段）。
   *
   * 不给就用一份完整默认值：调用方（例如只关心生命周期的测试替身）
   * 不必把每个界面字段都抄一遍，也不会因为后来新增字段就崩。
   */
  state?: Partial<PhotoImportState>
  /** 事件出口，由界面接管（弹提示 / 记日志）。 */
  emit: (event: { type: 'toast'; toast: PhotoImportToast } | { type: 'error'; error: PhotoImportState['error'] }) => void
  /** 测试里把最小可见时间调成 0。 */
  minVisibleMs?: number
}

/** 一份完整的初始状态（所有字段都有明确默认值）。 */
export function createInitialPhotoImportState(overrides: Partial<PhotoImportState> = {}): PhotoImportState {
  return {
    stage: 'idle',
    progress: '',
    photoUri: null,
    photoBytes: null,
    photoWidth: null,
    photoHeight: null,
    sourceWidth: null,
    sourceHeight: null,
    photoFormat: null,
    photoScaled: false,
    rows: [],
    response: null,
    endpointUsed: null,
    requestId: null,
    diagnosticsMode: false,
    archivedAttemptId: null,
    archiveError: null,
    archivedOriginal: false,
    error: null,
    busy: false,
    ...overrides,
  }
}

/* --------------------------------- 小工具 --------------------------------- */

/**
 * 把「这次尝试自己的取消状态」暴露成一个只读布尔。
 *
 * **只能闭包捕获自己那次尝试的 `AbortController`**：旧实现读的是共享的可变 controller，
 * 于是重新聚焦 / 开新一轮时，旧请求的 `cancelled` 又变回 false，迟到的结果会污染新界面。
 */
export function createCancelReader(isCancelled: () => boolean): CancelSignal {
  const reader: { cancelled: boolean } = {
    get cancelled() {
      return isCancelled()
    },
  }
  return reader
}

function errorFrom(cause: unknown, fallback: string): { message: string; code: string; retryable: boolean } {
  const clientError = toPhotoError(cause, fallback)
  return { message: clientError.message, code: clientError.code, retryable: clientError.retryable }
}

function isCancelledCode(code: string): boolean {
  return code === 'CANCELLED'
}
function isNoEndpointCode(code: string): boolean {
  return code === 'NO_ENDPOINT'
}

/** 一次尝试的私有句柄：它只属于这一轮，绝不碰别人的状态。 */
interface Attempt {
  id: number
  controller: AbortController
  /** 已经收尾过一次就不再重复收尾（否则会误清掉下一轮）。 */
  settled: boolean
  /**
   * 用户在这一轮里离开了（或者选择器还开着时就失焦了）。
   *
   * 记在**尝试自己**身上，而不是读全局的 `userAway` / `deferredAbort`：
   * 全局标记会在开新一轮时被清掉，于是旧那一轮又会以为自己还"有效"。
   */
  abandoned: boolean
}

/* --------------------------------- 状态机实现 ------------------------------- */

export function createPhotoImportOperation(deps: PhotoImportDeps): PhotoImportOperation {
  const minVisibleMs = deps.minVisibleMs ?? 700
  let state: PhotoImportState = createInitialPhotoImportState(deps.state)
  const listeners = new Set<() => void>()

  /** 单调递增的尝试号。 */
  let attemptId = 0
  /** 当前有效的尝试（null = 空闲）。 */
  let currentAttemptId: number | null = null
  let busy = false
  let userAway = false
  let pickerOpen = 0
  let deferredAbort = false
  let mounted = true
  let lastAttempt: { uri: string; source?: PhotoSourceInfo } | null = null

  const update = (changes: Partial<PhotoImportState>): void => {
    if (!mounted) return
    state = { ...state, ...changes }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅者的异常不能影响状态机本身。
      }
    }
  }

  /** 这一轮尝试是否还允许写状态：已卸载 / 用户已离开 / 已被新尝试取代，都不允许。 */
  const canCommit = (attempt: Attempt): boolean =>
    mounted && !userAway && currentAttemptId === attempt.id && !attempt.settled

  const holdForMinimum = async (startedAt: number): Promise<void> => {
    const remaining = minVisibleMs - (Date.now() - startedAt)
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  }

  /**
   * 收尾**指定的这一次尝试**。
   *
   * 关键：只有「这一轮还是当前轮」时才允许清理全局的 busy / currentAttemptId。
   * 这样 A 的 `finally` 绝不会把 B 的状态清掉（review #2 指出的真实竞态）。
   */
  const settle = (attempt: Attempt, options: { keepResult?: boolean } = {}): void => {
    if (attempt.settled) return
    attempt.settled = true
    const isCurrent = currentAttemptId === attempt.id
    if (isCurrent) {
      currentAttemptId = null
      busy = false
      pickerOpen = 0
      deferredAbort = false
    }
    if (mounted && isCurrent) {
      update({
        busy: false,
        stage: options.keepResult && state.stage === 'done' ? 'done' : 'idle',
        progress: '',
      })
    }
  }

  /** 每次尝试的 controller：`abort` 只针对自己那一轮，绝不误伤下一轮。 */
  const attemptControllers = new Map<number, AbortController>()
  const endAttempt = (attempt: Attempt): void => {
    attemptControllers.delete(attempt.id)
  }

  /** 开一轮新的尝试：发布 busy、清掉上一张图的结果，返回自己的句柄。 */
  const beginAttempt = (patch: Partial<PhotoImportState>): Attempt => {
    attemptId += 1
    const attempt: Attempt = { id: attemptId, controller: new AbortController(), settled: false, abandoned: false }
    attemptControllers.set(attempt.id, attempt.controller)
    currentAttemptId = attempt.id
    busy = true
    deferredAbort = false
    update({
      busy: true,
      // 上一张图的结果绝不能继续显示成「这次的结果」。
      rows: [],
      response: null,
      error: null,
      endpointUsed: null,
      requestId: null,
      diagnosticsMode: false,
      progress: '',
      // 归档状态必须跟着**这一次尝试**走：否则上一张图的「已保存到截图库 #12」
      // 会挂在新选的图上，用户会以为新图也已经存住了。
      archivedAttemptId: null,
      archivedOriginal: false,
      archiveError: null,
      ...patch,
    })
    return attempt
  }

  /**
   * 选照片 / 拍照的统一入口。
   *
   * 选择器 / 权限弹窗开着的时候 stage 是 `preparing`（busy = true），
   * 所以用户连点两下不会启动两次选择器；弹窗自己导致的失焦只记为「延后取消」。
   */
  const choosePhoto = async (kind: 'library' | 'camera'): Promise<void> => {
    if (busy) return
    const attempt = beginAttempt({ stage: 'preparing', progress: PHOTO_IMPORT_STAGE_TEXT.preparing })
    pickerOpen += 1

    try {
      const picked = kind === 'camera' ? await deps.captureFromCamera() : await deps.pickFromLibrary()
      pickerOpen = Math.max(0, pickerOpen - 1)

      if (picked.status === 'cancelled') {
        // 用户自己取消了选择器：不是错误，界面回到可以再点的状态。
        return
      }
      if (picked.status === 'permission') {
        if (mounted) {
          update({
            stage: 'idle',
            progress: '',
            error: { message: picked.message, code: 'BAD_REQUEST', retryable: picked.canAskAgain },
          })
        }
        return
      }
      if (picked.status === 'error') {
        if (mounted) {
          update({ stage: 'idle', progress: '', error: { message: picked.message, code: 'BAD_REQUEST', retryable: true } })
        }
        return
      }

      // 记录「用户在这一轮里离开了」这件事：不阻止归档（图片已经选到了，
      // 属于用户的输入，必须留下来），但之后不再继续转码 / 联网 / 更新界面。
      if (userAway || deferredAbort || !mounted) attempt.abandoned = true

      // **只要真的选到了图，就先归档**（复核对点名的要求）：即使页面此刻已经被卸载，
      // 这张图仍然要落盘、留一条取消历史，而且**不发起任何识别**
      // （`recognize` 会在归档之后因 `attempt.abandoned` 提前收尾）。
      // 只有「用户自己取消了选择器 / 权限被拒 / 选择器报错」才什么都不做。
      await recognize(attempt, picked.uri, picked.source, true, kind === 'camera' ? 'CAMERA' : 'LIBRARY')
    } catch (cause) {
      pickerOpen = Math.max(0, pickerOpen - 1)
      if (canCommit(attempt)) {
        update({
          stage: 'idle',
          progress: '',
          error: errorFrom(cause, kind === 'camera' ? '打开相机失败' : '打开相册失败'),
        })
      }
    } finally {
      endAttempt(attempt)
      settle(attempt, { keepResult: true })
    }
  }

  /**
   * 一轮「已选图片」的完整生命周期。
   *
   * 顺序（复核对点名的硬要求）：
   * 1. **归档原图**：只要用户真的选到了图（`uri` 非空），**第一件事就是把原图字节落盘**
   *    并登记一次尝试 —— 排在「校验地址 / 转码 / 健康检查」之前。这样地址没配、
   *    转码失败、服务离线、用户中途取消、甚至页面被卸载，那张图都不会丢；
   * 2. 校验识别地址 → 准备上传字节 → 健康预检 → 上传识别；
   * 3. 无论走到哪一步，**只要已经归档**就登记一条结果（SUCCESS / FAILED / CANCELLED）。
   *
   * 「用户选完图就离开页面」时不再直接 return：图片已经选到了，属于用户的输入，
   * 必须留下来（`no photo picked => no archive`，但已选到就必须归档）。
   *
   * 登记结果**不看界面是否还能提交**（`canCommit`）：那是界面渲染的顾虑，
   * 不该决定「这次尝试的历史要不要留」。
   */
  const recognize = async (
    attempt: Attempt,
    uri: string,
    source: PhotoSourceInfo | undefined,
    remember: boolean,
    attemptSource: 'LIBRARY' | 'CAMERA' = 'LIBRARY',
  ): Promise<void> => {
    const startedAt = Date.now()
    update({ stage: 'preparing', progress: PHOTO_IMPORT_STAGE_TEXT.preparing })
    if (remember) lastAttempt = { uri, source }

    /**
     * 把这一次尝试的结果落盘；失败只提示，绝不产生未处理的 Promise 拒绝。
     *
     * 提示走 `deps.emit({type:'error'})` 而不是只写界面状态：页面可能已经被卸载
     * （用户在选图后离开），只写状态会永远没人看见；事件出口能把「这次没能存住」
     * 如实告诉调用方，让它落进可持久的位置。
     */
    const reportResult = (input: {
      status: 'SUCCESS' | 'FAILED' | 'CANCELLED'
      response?: OcrResponse
      rawText?: string
      errorCode?: string
      errorMessage?: string
      candidates?: readonly OcrCandidateLike[]
    }): void => {
      if (!deps.recordResult) return
      const surface = (message: string): void => {
        if (mounted) update({ archiveError: message })
        try {
          deps.emit({ type: 'error', error: { message, code: 'SCREENSHOT_STORAGE', retryable: false } })
        } catch {
          // 事件出口不允许影响流程。
        }
      }
      try {
        const maybe = deps.recordResult({ attemptId: archive.attemptId, ...input }) as unknown
        if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
          // 允许实现返回 Promise（例如先 await 一次 store 刷新）。
          void (maybe as Promise<unknown>).catch((cause: unknown) => {
            const message = cause instanceof Error ? cause.message : String(cause)
            surface(`这次识别结果没能记进截图库：${message}`)
          })
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        surface(`这次识别结果没能记进截图库：${message}`)
      }
      try {
        deps.onAttemptFinished?.()
      } catch {
        // 收尾回调同样不允许影响流程。
      }
    }

    // ---------- 第 1 步：归档原图（先落盘、先登记，早于任何校验/转码） ----------
    const archive: { attemptId: number | null; ok: boolean; error: string | null } = {
      attemptId: null,
      ok: false,
      error: null,
    }
    if (deps.archiveOriginal) {
      try {
        const archived = await deps.archiveOriginal(uri, source, attemptSource)
        archive.attemptId = archived.attemptId
        archive.ok = archived.ok
        archive.error = archived.ok ? null : (archived.message ?? '这张图没能保存到截图库。')
      } catch (cause) {
        archive.error = cause instanceof Error ? cause.message : String(cause)
      }
      // 归档结果要显示出来（这是用户最关心的「到底存住没有」）；
      // 即使这一轮已经被取消，也只是不再覆盖更新的界面状态。
      if (canCommit(attempt)) {
        update({
          archivedAttemptId: archive.attemptId,
          archivedOriginal: archive.ok,
          archiveError: archive.error,
          rows: state.rows.map((row) => ({ ...row, linkedAttemptId: archive.attemptId })),
        })
      }
      // **没存住**时必须走事件出口：页面可能已经被卸载（选完图就离开），
      // 只写界面状态会永远没人看见，而「这张图没存住」是用户必须知道的事。
      if (!archive.ok && archive.error) {
        try {
          deps.emit({
            type: 'error',
            error: { message: `这张图没能保存到截图库：${archive.error}`, code: 'SCREENSHOT_STORAGE', retryable: false },
          })
        } catch {
          // 事件出口不允许影响流程。
        }
      }
    }

    // ---------- 第 2 步：识别地址（没配也要留下原图与失败结果） ----------
    const endpoint = deps.getEndpoint() ?? deps.getInferredEndpoint()
    const resolved = resolveOcrEndpoint(endpoint)
    if (!resolved.ok) {
      const message =
        resolved.reason === 'empty'
          ? '还没有设置这台电脑的识别服务地址。请打开右上角「识别服务设置」填写（也可以先点「检测并保存推断地址」）。'
          : '识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。'
      reportResult({ status: 'FAILED', errorCode: 'NO_ENDPOINT', errorMessage: message })
      if (canCommit(attempt)) {
        update({ stage: 'idle', progress: '', error: { message, code: 'NO_ENDPOINT', retryable: false } })
      }
      return
    }

    /**
     * 这一轮是否已经被**新的尝试**取代（或页面已卸载）。
     *
     * 刻意比 `canCommit` 宽：`userAway`（用户离开页面）不该让这次尝试的历史消失，
     * 但「用户又选了另一张图」时必须立刻让位，不能把结果写到新一轮上。
     */
    const superseded = (): boolean => !mounted || currentAttemptId !== attempt.id

    // 用户已经离开这一页 / 选择器还开着时就失焦了：不再花时间转码、连服务；
    // 原图与取消记录都已经留下（归档在第一步，与界面状态无关）。
    if (superseded() || attempt.abandoned || attempt.controller.signal.aborted) {
      reportResult({ status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: '用户在这一轮结束前离开了页面。' })
      return
    }

    // ---------- 第 3 步：准备上传字节 ----------
    let prepared: Awaited<ReturnType<PhotoImportAdapter['preparePhoto']>>
    try {
      prepared = await deps.preparePhoto(uri, source)
    } catch (cause) {
      const error = errorFrom(cause, '这张照片没能处理好')
      reportResult({ status: 'FAILED', errorCode: error.code, errorMessage: error.message })
      if (canCommit(attempt)) update({ stage: 'idle', progress: '', error })
      return
    }
    if (superseded() || attempt.abandoned || attempt.controller.signal.aborted) {
      // 这一轮已经被新一轮取代 / 被取消：不再写界面，但历史已经记下了。
      reportResult({ status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: '用户在这一轮结束前离开了页面。' })
      return
    }
    if (!canCommit(attempt)) return

    update({
      photoUri: prepared.uri,
      photoBytes: prepared.byteLength,
      photoWidth: prepared.width,
      photoHeight: prepared.height,
      sourceWidth: prepared.sourceWidth,
      sourceHeight: prepared.sourceHeight,
      photoFormat: prepared.format,
      photoScaled: prepared.resized,
      endpointUsed: resolved.endpoint,
    })

    // ---------- 第 4 步：健康预检 ----------
    update({ stage: 'checking', progress: PHOTO_IMPORT_STAGE_TEXT.checking })
    let healthy = false
    try {
      healthy = await deps.checkHealth(resolved.endpoint, 6_000)
    } catch {
      healthy = false
    }
    if (superseded() || attempt.abandoned || attempt.controller.signal.aborted) {
      reportResult({ status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: '用户在这一轮结束前离开了页面。' })
      return
    }
    if (!healthy) {
      const message =
        '连不上这台电脑上的识别服务（健康检查没通过）。请确认手机与电脑在同一个 Wi-Fi、电脑上的识别服务已经启动，然后点「重试」。'
      reportResult({ status: 'FAILED', errorCode: 'NETWORK', errorMessage: message })
      update({ stage: 'idle', progress: '', error: { message, code: 'NETWORK', retryable: true } })
      deps.emit({ type: 'error', error: { message, code: 'NETWORK', retryable: true } })
      return
    }

    update({ stage: 'uploading', progress: PHOTO_IMPORT_STAGE_TEXT.uploading })

    // ---------- 第 5 步：上传识别 ----------
    try {
      // 取消状态**只**来自这一次尝试自己的 controller（外加「用户真的离开」这一条），
      // 绝不读共享的可变 controller —— 那正是旧代码里「旧请求又被当成没取消」的原因。
      const signal = createCancelReader(
        () => attempt.controller.signal.aborted || userAway || !stillCurrent(attempt),
      )
      const response = await deps.recognize(resolved.endpoint, {
        imageBase64: prepared.base64,
        mimeType: prepared.mimeType,
        // 两样都给：真正的 AbortSignal 用于**同一刻**打断请求；只读的 `cancelled` 读法
        // 用于「这一轮已经被新尝试取代」这类没有 controller abort 的收尾。
        signal,
        abortSignal: attempt.controller.signal,
      })
      const rows = response.candidates.map((candidate, index) => ({
        ...rowFromCandidate(candidate, index),
        // 每行都记住「这张原图存在截图库里的哪一次尝试」，导入时据此写持久关联。
        linkedAttemptId: archive.attemptId,
      }))
      // 结果先落库/落历史：**不**依赖界面是否还能提交。
      reportResult({
        status: 'SUCCESS',
        response,
        rawText: response.rawText,
        candidates: response.candidates,
      })
      if (!canCommit(attempt)) return
      update({
        stage: 'done',
        progress: '',
        rows,
        response,
        endpointUsed: resolved.endpoint,
        requestId: response.requestId ?? null,
        diagnosticsMode: response.diagnosticsMode === true,
        error: null,
      })
      try {
        deps.onDone?.({
          attemptId: archive.attemptId,
          rows,
          week: response.week ?? null,
          requestId: response.requestId ?? null,
        })
      } catch {
        // 通知回调失败不该影响识别结果本身。
      }
      deps.emit({
        type: 'toast',
        toast: {
          text: `识别完成：${rows.length} 条候选${response.week ? `（图片显示第 ${response.week} 教学周）` : ''}。请核对后再导入。`,
          tone: 'success',
        },
      })
    } catch (cause) {
      const clientError = toPhotoError(cause, '这次识别没有成功')
      if (isCancelledCode(clientError.code)) {
        // 取消不是「失败」：不留错误框，也不谎报超时；只把状态放回可重试。
        reportResult({ status: 'CANCELLED', errorCode: 'CANCELLED', errorMessage: clientError.message })
        if (canCommit(attempt)) update({ stage: 'idle', progress: '' })
        return
      }
      reportResult({ status: 'FAILED', errorCode: clientError.code, errorMessage: clientError.message })
      if (!canCommit(attempt)) return
      update({
        stage: 'idle',
        progress: '',
        error: { message: clientError.message, code: clientError.code, retryable: clientError.retryable },
      })
      if (isNoEndpointCode(clientError.code)) {
        deps.emit({ type: 'toast', toast: { text: '还没设置识别服务地址，先去「识别服务设置」填一下。', tone: 'error' } })
      }
    } finally {
      // 成功时保留 `done`（结果留在界面上）；失败/取消时已经在各自分支里落成 `idle`。
      // busy 由 `settle()` 统一收尾，这里只负责把进度文案清掉。
      if (canCommit(attempt) && state.stage !== 'done') update({ stage: 'idle', progress: '' })
      // 让「正在识别…」至少可见一小会儿：太快会闪一下，用户反而以为没反应。
      await holdForMinimum(startedAt)
    }
  }

  const runChoose = async (kind: 'library' | 'camera'): Promise<void> => {
    await choosePhoto(kind)
  }

  /** `canCommit` 的宽松版：只看「这一轮是否还是当前轮」，不看 cancelled 标记本身。 */
  const stillCurrent = (attempt: Attempt): boolean =>
    mounted && currentAttemptId === attempt.id && !attempt.settled

  /** 离开页面：取消当前这一轮（只 abort 自己那一轮），并让界面回到「可以重试」。 */
  const abortNow = (): void => {
    userAway = true
    const idAtAbort = currentAttemptId
    currentAttemptId = null
    busy = false
    pickerOpen = 0
    deferredAbort = false
    if (idAtAbort !== null) {
      const controller = attemptControllers.get(idAtAbort)
      if (controller) controller.abort()
    }
    if (mounted) {
      update({ busy: false, stage: state.stage === 'done' ? 'done' : 'idle', progress: '' })
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pickFromLibrary: () => runChoose('library'),
    captureFromCamera: () => runChoose('camera'),
    retryLastPhoto: async () => {
      if (busy) return
      if (!lastAttempt) {
        await runChoose('library')
        return
      }
      const sample = lastAttempt
      const attempt = beginAttempt({ stage: 'preparing' })
      try {
        await recognize(attempt, sample.uri, sample.source, false)
      } finally {
        endAttempt(attempt)
        settle(attempt, { keepResult: true })
      }
    },
    recognizeArchived: async (uri: string) => {
      if (busy) return
      if (!uri) {
        deps.emit({ type: 'toast', toast: { text: '这张截图在本机找不到了，请重新提交一次。', tone: 'error' } })
        return
      }
      // 直接对已有归档文件发起一轮完整尝试：归档（新历史）→ 转码 → 识别。
      // 复用同一条 `recognize`，因此取消、超时、结果登记、去重语义完全一致。
      const attempt = beginAttempt({ stage: 'preparing' })
      try {
        lastAttempt = { uri, source: undefined }
        await recognize(attempt, uri, undefined, false, 'LIBRARY')
      } finally {
        endAttempt(attempt)
        settle(attempt, { keepResult: true })
      }
    },
    configureInferredEndpoint: async () => {
      const inferred = deps.getInferredEndpoint()
      if (!deps.configureEndpoint || !inferred) {
        deps.emit({ type: 'toast', toast: { text: '没能在本机推断出电脑地址，请手动填写。', tone: 'error' } })
        return
      }
      const result = await deps.configureEndpoint(inferred)
      deps.emit({ type: 'toast', toast: { text: result.message, tone: result.ok ? 'success' : 'error' } })
    },
    focus: () => {
      userAway = false
      deferredAbort = false
    },
    blur: () => {
      if (pickerOpen > 0) {
        // 选择器 / 权限弹窗还开着：先记一笔，等它回来再决定（见文件头注释 3）。
        deferredAbort = true
        return
      }
      abortNow()
    },
    dispose: () => {
      mounted = false
      userAway = true
      attemptId += 1
      currentAttemptId = null
      for (const controller of attemptControllers.values()) controller.abort()
      attemptControllers.clear()
      busy = false
      pickerOpen = 0
      deferredAbort = false
    },
    attach: () => {
      // React StrictMode 会 setup → cleanup → setup：重新挂上时必须是「干净可用」的状态。
      // `dispose()` 会把 `userAway` 置真（它表示「用户已经离开」）；重新挂上时必须清掉，
      // 否则新的一轮会在真正开始前就被自己的「已离开」判断挡住。
      mounted = true
      userAway = false
      busy = false
      currentAttemptId = null
      pickerOpen = 0
      deferredAbort = false
      update({ busy: false, stage: state.stage === 'done' ? 'done' : 'idle', progress: '' })
    },
    get attached() {
      return mounted
    },
    get active() {
      return busy
    },
  }
}

/* --------------------------------- 焦点生命周期 ------------------------------ */

/** 反复渲染时保持稳定的依赖项（`refresh` 由 store 的 `useCallback([])` 产出）。 */
export interface FocusEffectDeps {
  refresh: () => Promise<void>
}

export interface FocusEffectBinding {
  /** 进入本页 / 依赖变化时执行。 */
  onFocus: () => void
  /** 离开本页 / 依赖变化 / 卸载时执行。 */
  onCleanup: () => void
}

/**
 * 把「进入页面 / 离开页面」这件事绑到操作与**稳定依赖**上。
 *
 * 这是那个真 bug 的正面写法：旧代码把整个 `store` 对象放进 `useFocusEffect` 的依赖里，
 * 而 `store.refresh()` 会让 `store` 变成**新对象** → 焦点回调被重建 → 清理函数把正在进行的
 * 识别取消 → 组件再次刷新……循环里选完照片的结果被静默丢弃（用户看到「没反应」）。
 *
 * 返回的函数对同一组依赖是**引用稳定**的：只依赖 `refresh` 时反复渲染不会产生新的回调。
 */
export function createPhotoImportFocusBinding(
  operation: Pick<PhotoImportOperation, 'focus' | 'blur'>,
  deps: FocusEffectDeps,
): FocusEffectBinding {
  return {
    onFocus: () => {
      operation.focus()
      void deps.refresh()
    },
    onCleanup: () => {
      operation.blur()
    },
  }
}

/* --------------------------------- 错误出口 -------------------------------- */

export { OcrClientError }
