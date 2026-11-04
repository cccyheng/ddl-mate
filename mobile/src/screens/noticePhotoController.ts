/**
 * 「一张通知截图 → 本机电脑 OCR → 可编辑文字 → 既有的通知核对页」的**运行状态机**。
 *
 * 这个文件不依赖 React / React Native / Expo，因此所有生命周期边界都能在 Node 里
 * 用真异步测试（见 `tests/noticePhotoController.test.mjs`）。
 *
 * 硬约束（逐条对应授权书）：
 * 1. **选图后不自动识别**：只归档原图，必须用户再点「识别文字」；
 * 2. **归档早于 OCR**：只要真的选到了图，第一步就是把原图字节存进既有截图库
 *    （`archiveOriginal`）；归档失败要**如实显示**并允许重试，绝不谎称已保存；
 * 3. **取消 / 换图 / 卸载之后，旧结果一律作废**：每一轮有自己的 generation 与
 *    `AbortController`，迟到的响应只允许记历史，**不允许**改当前状态；
 * 4. **同步 busy 闸门**：选择 / 归档 / 准备 / 识别 / 采用文字之前先同步置位，
 *    连点两次不会发起两次调用；
 * 5. **不丢用户已改的文字**：识别文字非空时，换图 / 重新识别都要先明确确认；
 *    确认之前原文字原样保留，绝不静默清空、绝不截断；
 * 6. **不伪造进度**：只有文字状态（正在准备 / 正在识别），没有百分比、没有自动保存。
 */

import { MAX_NOTICE_SOURCE_CHARS, noticeSourceLengthError } from '../domain/noticeImport'
import { OcrClientError, resolveOcrEndpoint } from '../domain/photoOcrClient'
import type { NoticeOcrImage, NoticeOcrResponse } from '../domain/noticeOcrClient'

export type NoticePhotoPhase = 'idle' | 'picking' | 'archiving' | 'preparing' | 'recognizing' | 'done' | 'error'

export interface NoticePhotoError {
  message: string
  code: string
  retryable: boolean
}

export interface NoticePhotoState {
  phase: NoticePhotoPhase
  busy: boolean
  /** 纯文字状态（不是百分比）。 */
  statusText: string
  photoUri: string | null
  photoWidth: number | null
  photoHeight: number | null
  /** 原图归档到截图库后的尝试 id；`null` = 还没存住或正在存。 */
  archivedAttemptId: number | null
  /** 原图是否真的已经落盘（界面据此说「已保存」还是「没能保存」）。 */
  archivedOriginal: boolean
  archiveError: string | null
  /** 当前可编辑的识别文字（用户改动只活在这里）。 */
  text: string
  /** 最近一次 OCR 原始输出（用于「改过没有」的提示，不参与保存）。 */
  recognizedText: string | null
  requestId: string | null
  diagnosticsMode: boolean
  warnings: string[]
  image: NoticeOcrImage | null
  ocrMs: number | null
  /** 服务端明确说这张图里没有文字。 */
  empty: boolean
  error: NoticePhotoError | null
}

export interface NoticePhotoToast {
  text: string
  tone: 'success' | 'error'
}

export type NoticePhotoSource = { width?: number | null; height?: number | null; mimeType?: string | null }

export type NoticePhotoPickResult =
  | { status: 'picked'; uri: string; source?: NoticePhotoSource }
  | { status: 'cancelled' }
  | { status: 'permission'; message: string; canAskAgain: boolean }
  | { status: 'error'; message: string }

export interface NoticePhotoPrepared {
  base64: string
  mimeType: string
  width: number | null
  height: number | null
  byteLength: number
}

export interface NoticePhotoArchiveResult {
  ok: boolean
  attemptId: number | null
  message: string | null
}

export interface NoticePhotoRecordInput {
  attemptId: number | null
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED'
  rawText?: string
  requestId?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  warnings?: readonly string[] | null
  durationMs?: number | null
  image?: NoticeOcrImage | null
}

export interface NoticePhotoDeps {
  state?: Partial<NoticePhotoState>
  pickFromLibrary: () => Promise<NoticePhotoPickResult>
  captureFromCamera: () => Promise<NoticePhotoPickResult>
  preparePhoto: (uri: string, source: NoticePhotoSource | undefined) => Promise<NoticePhotoPrepared>
  archiveOriginal: (
    uri: string,
    source: NoticePhotoSource | undefined,
    attemptSource: 'LIBRARY' | 'CAMERA',
  ) => Promise<NoticePhotoArchiveResult>
  recognize: (
    endpoint: string,
    options: { imageBase64: string; mimeType: string; abortSignal: AbortSignal },
  ) => Promise<NoticeOcrResponse>
  recordResult: (input: NoticePhotoRecordInput) => void | Promise<void>
  getEndpoint: () => string | null
  getInferredEndpoint: () => string | null
  emit?: (event: { type: 'toast'; toast: NoticePhotoToast } | { type: 'error'; error: NoticePhotoError }) => void
  onAttemptFinished?: () => void
  /** 测试里把「让加载文案可见一小会儿」调成 0。 */
  minVisibleMs?: number
}

export type NoticePhotoStartResult =
  | 'started'
  | 'busy'
  | 'needs-replace-confirm'
  | 'needs-photo'
  | 'needs-endpoint'
  | 'too-long'
  | 'already-archived'

export type NoticePhotoAdoptResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'busy' | 'empty' | 'too-long' | 'already-open'; message: string }

export interface NoticePhotoOperation {
  getState: () => NoticePhotoState
  subscribe: (listener: () => void) => () => void
  requestPick: (
    kind: 'library' | 'camera',
    options?: { confirmReplace?: boolean },
  ) => NoticePhotoStartResult
  retryArchive: () => Promise<NoticePhotoStartResult>
  requestRecognize: (options?: { confirmReplace?: boolean }) => NoticePhotoStartResult
  cancel: () => boolean
  setText: (value: string) => void
  adoptText: () => NoticePhotoAdoptResult
  focus: () => void
  dispose: () => void
  attach: () => void
  readonly busy: boolean
}

export function createInitialNoticePhotoState(overrides: Partial<NoticePhotoState> = {}): NoticePhotoState {
  return {
    phase: 'idle',
    busy: false,
    statusText: '',
    photoUri: null,
    photoWidth: null,
    photoHeight: null,
    archivedAttemptId: null,
    archivedOriginal: false,
    archiveError: null,
    text: '',
    recognizedText: null,
    requestId: null,
    diagnosticsMode: false,
    warnings: [],
    image: null,
    ocrMs: null,
    empty: false,
    error: null,
    ...overrides,
  }
}

/* ------------------------------- 纯判定函数 ------------------------------- */

/** 有未带走的识别文字 / 结果（离开页面前要确认）。 */
export function hasUnsavedNoticePhotoDraft(state: Pick<NoticePhotoState, 'text'>): boolean {
  return String(state.text ?? '').trim().length > 0
}

/**
 * 采用文字前的纯判定：空文字 / 超过 10000 字都不允许进入核对页。
 *
 * 超长时给出「手动缩短或分两次」的中文说明，**绝不**替用户截断。
 */
export function noticePhotoAdoption(
  state: Pick<NoticePhotoState, 'text'>,
): { allowed: true; text: string } | { allowed: false; reason: 'empty' | 'too-long'; message: string } {
  const text = String(state.text ?? '')
  if (text.trim().length === 0) {
    return { allowed: false, reason: 'empty', message: '还没有可用的文字：请先选中一张通知截图并点「识别文字」。' }
  }
  const lengthError = noticeSourceLengthError(text)
  if (lengthError) {
    return {
      allowed: false,
      reason: 'too-long',
      message: `${lengthError} 请先手动删减到 ${MAX_NOTICE_SOURCE_CHARS} 字以内，或分成两次识别与导入；应用不会替你截断。`,
    }
  }
  return { allowed: true, text }
}

/* --------------------------------- 状态机 --------------------------------- */

interface Attempt {
  generation: number
  controller: AbortController
  /** 这一轮是否已经收尾（防止旧轮的 finally 清掉新轮）。 */
  settled: boolean
}

export function createNoticePhotoOperation(deps: NoticePhotoDeps): NoticePhotoOperation {
  const minVisibleMs = deps.minVisibleMs ?? 500
  let state = createInitialNoticePhotoState(deps.state)
  const listeners = new Set<() => void>()

  let mounted = true
  let busy = false
  /** 单调递增；任何异步结果都必须带着自己的 generation 回来。 */
  let generation = 0
  /** 当前 OCR 请求自己的 controller（归档 / 准备阶段为 null）。 */
  let activeAttempt: Attempt | null = null
  /** 已经选中的图片信息（归档重试与 OCR 重试复用同一份）。 */
  let selected: {
    uri: string
    source: { width?: number | null; height?: number | null; mimeType?: string | null } | undefined
    attemptSource: 'LIBRARY' | 'CAMERA'
  } | null = null
  /** 采用文字之后、回到本页之前，阻止同一个按钮被连点两次。 */
  let adoptGuard = false
  /**
   * 这一轮识别进行中，用户是否又改过文字。
   *
   * 识别结果回来时如果为真，**保留用户当前文字**，不拿 OCR 结果覆盖它；
   * 原始 OCR 文字仍会记录到 `recognizedText` 与截图库历史里。
   */
  let editedDuringRecognition = false

  const update = (changes: Partial<NoticePhotoState>): void => {
    state = { ...state, ...changes }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅者异常不能影响状态机本身。
      }
    }
  }

  const emitError = (error: NoticePhotoError): void => {
    try {
      deps.emit?.({ type: 'error', error })
    } catch {
      // 事件出口不允许影响流程。
    }
  }

  const isCurrent = (token: number): boolean => mounted && token === generation

  const holdForMinimum = async (startedAt: number): Promise<void> => {
    const remaining = minVisibleMs - (Date.now() - startedAt)
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  }

  /** 只记录历史，不改当前界面状态（旧轮收尾时用）。 */
  const recordHistory = (
    input: Omit<NoticePhotoRecordInput, 'attemptId'> & { attemptId: number | null },
  ): void => {
    try {
      const maybe = deps.recordResult(input) as unknown
      if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
        void (maybe as Promise<unknown>).catch(() => undefined)
      }
    } catch {
      // 历史记录失败不影响识别结果本身。
    }
    try {
      deps.onAttemptFinished?.()
    } catch {
      // 收尾回调同样不允许影响流程。
    }
  }

  /** 收掉当前 attempt：abort 请求，并（可选）如实登记一次取消历史。 */
  const abortAttempt = (record: boolean): void => {
    const attempt = activeAttempt
    activeAttempt = null
    if (!attempt || attempt.settled) return
    attempt.settled = true
    attempt.controller.abort()
    if (record && state.archivedAttemptId !== null) {
      recordHistory({
        attemptId: state.archivedAttemptId,
        status: 'CANCELLED',
        requestId: state.requestId,
        errorCode: 'CANCELLED',
        errorMessage: '用户取消了这次通知文字识别。',
      })
    }
  }

  /**
   * 归档当前选中的原图；`token` 是这一轮的 generation。
   *
   * `unlockBusy: false` 用于「识别流程内部重试归档」：这时整个识别操作还没结束，
   * 绝不能因为归档子步骤收尾就把 busy 放开，否则用户能在 preparePhoto 等待期间
   * 重新选图 / 再次识别，导致两次操作交错。
   */
  const archiveSelected = async (
    token: number,
    announce: boolean,
    options: { unlockBusy?: boolean } = {},
  ): Promise<void> => {
    const unlockBusy = options.unlockBusy !== false
    if (!selected) return
    if (!isCurrent(token)) return
    busy = true
    update({
      busy: true,
      phase: 'archiving',
      statusText: '正在把原图原样保存到截图库…',
      archiveError: null,
      error: null,
    })
    try {
      const outcome = await deps.archiveOriginal(selected.uri, selected.source, selected.attemptSource)
      if (!isCurrent(token)) return
      if (outcome.ok) {
        update({
          archivedAttemptId: outcome.attemptId,
          archivedOriginal: true,
          archiveError: null,
        })
        if (announce) {
          deps.emit?.({
            type: 'toast',
            toast: { text: '原图已经保存到截图库（不缩小、不裁剪）。', tone: 'success' },
          })
        }
      } else {
        const message = outcome.message ?? '这张图没能保存到截图库。'
        update({ archivedAttemptId: outcome.attemptId, archivedOriginal: false, archiveError: message })
        emitError({ message: `这张图没能保存到截图库：${message}`, code: 'ARCHIVE_FAILED', retryable: true })
      }
    } catch (cause) {
      if (!isCurrent(token)) return
      const message = cause instanceof Error ? cause.message : String(cause)
      update({ archivedOriginal: false, archiveError: message })
      emitError({ message: `这张图没能保存到截图库：${message}`, code: 'ARCHIVE_FAILED', retryable: true })
    } finally {
      if (isCurrent(token) && unlockBusy) {
        busy = false
        update({
          busy: false,
          phase: state.text.trim().length > 0 ? 'done' : 'idle',
          statusText: '',
        })
      }
    }
  }

  const performPick = async (
    kind: 'library' | 'camera',
    options: { confirmReplace?: boolean } | undefined,
  ): Promise<void> => {
    if (busy) return
    const token = ++generation
    busy = true
    update({ busy: true, phase: 'picking', statusText: kind === 'camera' ? '正在打开相机…' : '正在打开相册…', error: null })
    let picked: NoticePhotoPickResult
    try {
      picked = kind === 'camera' ? await deps.captureFromCamera() : await deps.pickFromLibrary()
    } catch (cause) {
      if (isCurrent(token)) {
        busy = false
        update({
          busy: false,
          phase: state.text.trim().length > 0 ? 'done' : 'idle',
          statusText: '',
          error: { message: `打开${kind === 'camera' ? '相机' : '相册'}失败：${cause instanceof Error ? cause.message : String(cause)}`, code: 'BAD_REQUEST', retryable: true },
        })
      }
      return
    }
    if (!isCurrent(token)) return

    if (picked.status === 'cancelled') {
      // 用户自己取消选择器：不是错误，也不是一次新选择 —— 原图 / 文字 / 归档状态全部保持。
      busy = false
      update({ busy: false, phase: state.text.trim().length > 0 ? 'done' : 'idle', statusText: '' })
      return
    }
    if (picked.status === 'permission') {
      busy = false
      const message = picked.canAskAgain
        ? `${picked.message}（这是系统权限提示，允许之后可以再点一次。）`
        : `${picked.message} 如果系统不再弹窗，请到手机系统设置里为 Expo Go 打开${kind === 'camera' ? '相机' : '照片'}权限。`
      update({ busy: false, phase: 'idle', statusText: '', error: { message, code: 'PERMISSION', retryable: picked.canAskAgain } })
      return
    }
    if (picked.status === 'error') {
      busy = false
      update({ busy: false, phase: state.text.trim().length > 0 ? 'done' : 'idle', statusText: '', error: { message: picked.message, code: 'PICK_FAILED', retryable: true } })
      return
    }

    // 只有真的选到了图，才替换当前选择；文字是否清空取决于用户是否明确确认过替换。
    const mayReplaceText = options?.confirmReplace === true || state.text.trim().length === 0
    selected = {
      uri: picked.uri,
      source: picked.source,
      attemptSource: kind === 'camera' ? 'CAMERA' : 'LIBRARY',
    }
    update({
      photoUri: picked.uri,
      photoWidth: picked.source?.width ?? null,
      photoHeight: picked.source?.height ?? null,
      archivedAttemptId: null,
      archivedOriginal: false,
      archiveError: null,
      error: null,
      busy: false,
      phase: 'idle',
      statusText: '',
      ...(mayReplaceText
        ? {
            text: '',
            recognizedText: null,
            requestId: null,
            diagnosticsMode: false,
            warnings: [],
            image: null,
            ocrMs: null,
            empty: false,
          }
        : {}),
    })
    busy = false
    // 选完图立刻归档原图（**不自动 OCR**）。
    await archiveSelected(token, false)
  }

  const runRecognition = async (endpoint: string, token: number): Promise<void> => {
    const startedAt = Date.now()
    busy = true
    // 新一轮识别开始：之前那一轮「识别期间改字」的标记不能带进来。
    editedDuringRecognition = false
    const attempt: Attempt = { generation: token, controller: new AbortController(), settled: false }
    activeAttempt = attempt
    update({
      busy: true,
      phase: 'preparing',
      statusText: '正在准备要识别的图片…',
      error: null,
    })
    try {
      // 归档还没成功时，先重试一次归档（不重复落盘同一张图：已成功时直接跳过）。
      // 关键：这次子步骤**不能**释放 busy —— 整个「归档 + 准备 + OCR」同属一轮操作。
      if (!state.archivedOriginal) {
        await archiveSelected(token, false, { unlockBusy: false })
        if (!isCurrent(token)) return
      }
      if (!selected) return
      if (attempt.controller.signal.aborted) return
      update({ busy: true, phase: 'preparing', statusText: '正在准备要识别的图片…' })
      const prepared = await deps.preparePhoto(selected.uri, selected.source)
      if (!isCurrent(token) || attempt.controller.signal.aborted) return
      update({ busy: true, phase: 'recognizing', statusText: '电脑正在识别这张通知截图…' })
      const response = await deps.recognize(endpoint, {
        imageBase64: prepared.base64,
        mimeType: prepared.mimeType,
        abortSignal: attempt.controller.signal,
      })
      if (!isCurrent(token) || attempt.settled) return
      attempt.settled = true
      activeAttempt = null
      busy = false
      // 识别期间用户改过字：保留用户当前文字，原始识别结果只记到 recognizedText / 历史。
      const preserveDraft = editedDuringRecognition
      update({
        busy: false,
        phase: 'done',
        statusText: '',
        // 用户已经明确确认替换（或原来没有文字），这里才允许写回新文字。
        text: preserveDraft ? state.text : response.rawText,
        recognizedText: response.rawText,
        requestId: response.requestId,
        diagnosticsMode: response.diagnosticsMode,
        warnings: Array.isArray(response.warnings) ? response.warnings : [],
        image: response.image,
        ocrMs: response.ms,
        empty: preserveDraft ? false : response.empty === true || response.rawText.length === 0,
        error: null,
      })
      editedDuringRecognition = false
      if (preserveDraft) {
        deps.emit?.({
          type: 'toast',
          toast: {
            text: '识别完成；你在识别期间改过文字，已经保留你的当前草稿，原始识别结果也单独记录下来了。',
            tone: 'success',
          },
        })
      } else if (response.rawText.length === 0) {
        deps.emit?.({
          type: 'toast',
          toast: { text: '识别完成，但这张图里没有读到任何文字。可以换一张更清晰的截图再试。', tone: 'error' },
        })
      }
      recordHistory({
        attemptId: state.archivedAttemptId,
        status: 'SUCCESS',
        rawText: response.rawText,
        requestId: response.requestId,
        warnings: response.warnings,
        durationMs: response.ms,
        image: response.image,
      })
    } catch (cause) {
      if (!isCurrent(token) || attempt.settled) return
      attempt.settled = true
      activeAttempt = null
      busy = false
      const clientError =
        cause instanceof OcrClientError
          ? cause
          : new OcrClientError('SERVICE', cause instanceof Error ? cause.message : String(cause), { retryable: true })
      if (clientError.code === 'CANCELLED') {
        // 取消不是失败：保留已经改好的文字，只回到可重试状态。
        update({ busy: false, phase: state.text.trim().length > 0 ? 'done' : 'idle', statusText: '', error: null })
        recordHistory({
          attemptId: state.archivedAttemptId,
          status: 'CANCELLED',
          requestId: state.requestId,
          errorCode: 'CANCELLED',
          errorMessage: clientError.message,
        })
        return
      }
      update({
        busy: false,
        phase: 'error',
        statusText: '',
        // **不清空**文字与图片：网络失败之后，用户已经改好的内容仍然在。
        error: { message: clientError.message, code: clientError.code, retryable: clientError.retryable },
      })
      recordHistory({
        attemptId: state.archivedAttemptId,
        status: 'FAILED',
        requestId: state.requestId,
        errorCode: clientError.code,
        errorMessage: clientError.message,
      })
    } finally {
      if (isCurrent(token)) {
        busy = false
        update({ busy: false, statusText: state.phase === 'recognizing' ? '' : state.statusText })
      }
      await holdForMinimum(startedAt)
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    requestPick: (kind, options) => {
      if (busy) return 'busy'
      if (state.text.trim().length > 0 && options?.confirmReplace !== true) return 'needs-replace-confirm'
      void performPick(kind, options)
      return 'started'
    },
    retryArchive: async () => {
      if (busy) return 'busy'
      if (!selected || !state.photoUri) return 'needs-photo'
      if (state.archivedOriginal) return 'already-archived'
      const token = ++generation
      await archiveSelected(token, true)
      return 'started'
    },
    requestRecognize: (options) => {
      if (busy) return 'busy'
      if (!selected || !state.photoUri) return 'needs-photo'
      if (state.text.trim().length > 0 && options?.confirmReplace !== true) return 'needs-replace-confirm'
      const resolved = resolveOcrEndpoint(deps.getEndpoint() ?? deps.getInferredEndpoint())
      if (!resolved.ok) {
        const message =
          resolved.reason === 'empty'
            ? '还没有设置这台电脑的文字识别服务地址。请先打开「识别服务设置」填写（手机与电脑要连同一个 Wi-Fi）。'
            : '文字识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。'
        update({ error: { message, code: 'NO_ENDPOINT', retryable: false }, phase: 'idle', busy: false, statusText: '' })
        return 'needs-endpoint'
      }
      const token = ++generation
      void runRecognition(resolved.endpoint, token)
      return 'started'
    },
    cancel: () => {
      if (!busy) return false
      if (state.phase !== 'preparing' && state.phase !== 'recognizing') return false
      // 先让这一轮失效，再 abort：迟到的响应回来时 generation 已经不同。
      generation += 1
      abortAttempt(true)
      busy = false
      update({ busy: false, phase: state.text.trim().length > 0 ? 'done' : 'idle', statusText: '已取消这次识别。', error: null })
      return true
    },
    setText: (value) => {
      // 识别进行中用户仍可能通过硬件键盘 / 无障碍输入改字：记下来，
      // 识别结果回来时保留用户文字，而不是把它覆盖掉。
      if (activeAttempt !== null) editedDuringRecognition = true
      update({ text: String(value ?? ''), error: null })
    },
    adoptText: () => {
      if (busy) return { ok: false, reason: 'busy', message: '正在处理这张图，请等这一轮结束再采用文字。' }
      if (adoptGuard) {
        return { ok: false, reason: 'already-open', message: '已经打开了核对页；回到这一页后可以再次采用。' }
      }
      const adoption = noticePhotoAdoption(state)
      if (!adoption.allowed) return { ok: false, reason: adoption.reason, message: adoption.message }
      adoptGuard = true
      return { ok: true, text: adoption.text }
    },
    focus: () => {
      adoptGuard = false
    },
    dispose: () => {
      mounted = false
      generation += 1
      abortAttempt(true)
      busy = false
      adoptGuard = false
    },
    attach: () => {
      mounted = true
      busy = false
      adoptGuard = false
      update({ busy: false, statusText: '' })
    },
    get busy() {
      return busy
    },
  }
}
