/**
 * 「批量识别通知截图」的**运行状态机**（不依赖 React / Expo，可在 Node 里真异步测试）。
 *
 * 公开 API（授权书要求尽早暴露，便于独立复核）：
 * - `createBatchNoticeOperation(deps)` → {@link BatchNoticeOperation}
 * - `getState()` / `subscribe(listener)`：只读快照与订阅
 * - `requestPick({ confirmReplace? })`：显式选一批相册图（最多 8 张）；选完**只归档，不识别**
 * - `retryArchive(itemId)`：对某一张**归档失败**的原图显式重试保存（不触发识别）
 * - `startRun({ confirmReplace? })`：按顺序识别所有 pending / failed / cancelled 项
 * - `cancel()`：中止当前这一张并停止推进；已完成的结果与手改文字都保留
 * - `retryItem(itemId, { confirmReplace? })`：只重试 failed / cancelled / empty 的单张
 * - `setText(itemId, value)` / `adoptText(itemId)`：逐张编辑与核对
 * - `focus()`：从子页面返回时重新允许采用
 * - `activate()` / `dispose()`：React StrictMode 的 setup → cleanup → setup
 *
 * 硬约束：
 * 1. **本文件不写任务**：没有 `importNoticeCandidates`、没有任务仓库依赖；
 *    任务只能由用户在每张图打开的既有 NoticeImport 里核对并保存。
 * 2. 选图后**不自动 OCR**；只有显式 `startRun` / `retryItem` 才发识别请求。
 * 3. 归档失败 ≠ 识别失败：两者分开记录，归档失败绝不显示成「已保存」。
 * 4. 所有异步结果带 generation；取消 / 换批 / dispose 之后，迟到结果不能改新状态。
 * 5. 同步 busy 闸门覆盖选图、归档、准备 + 整轮识别、采用；双击只发一次。
 * 6. 识别历史写入失败时**不改动识别结论、不清空文字**，只单独标「历史没写进去」。
 */

import { MAX_NOTICE_SOURCE_CHARS, noticeSourceLengthError } from '../domain/noticeImport'
import type { NoticeOcrImage, NoticeOcrResponse } from '../domain/noticeOcrClient'
import { OcrClientError, resolveOcrEndpoint } from '../domain/photoOcrClient'

/** 一批最多 8 张（与 picker 的 selectionLimit 同口径，也在界面文案里写出）。 */
export const BATCH_NOTICE_MAX_IMAGES = 8

/** 单张图进入核对页的文字上限（与既有通知导入完全一致，绝不截断）。 */
export const BATCH_NOTICE_MAX_TEXT_CHARS = MAX_NOTICE_SOURCE_CHARS

export type BatchNoticeItemStatus = 'pending' | 'running' | 'success' | 'empty' | 'failed' | 'cancelled'
export type BatchNoticeArchiveStatus = 'pending' | 'archiving' | 'archived' | 'failed'
export type BatchNoticePhase = 'idle' | 'picking' | 'archiving' | 'ready' | 'running' | 'cancelled'
export type BatchNoticeBusyAction = 'pick' | 'archive' | 'run' | 'adopt'

export interface BatchNoticeSource {
  width?: number | null
  height?: number | null
  mimeType?: string | null
}

export interface BatchNoticeError {
  message: string
  code: string
  retryable: boolean
}

export interface BatchNoticeToast {
  text: string
  tone: 'success' | 'error'
}

export interface BatchNoticeItem {
  /** 本批内稳定 id（`batch-1`、`batch-2`…）；换批会生成全新一批。 */
  id: string
  /** 1 起的展示序号，与 id 一起保持稳定。 */
  index: number
  uri: string
  source: BatchNoticeSource | null
  /** 原图归档状态（与 OCR 状态彼此独立）。 */
  archiveStatus: BatchNoticeArchiveStatus
  archivedAttemptId: number | null
  /** 归档后的本机 URI（只用于查看器；拿不到时为 null）。 */
  archivedUri: string | null
  archiveError: string | null
  status: BatchNoticeItemStatus
  /** 最近一次 OCR 的原始文字（可能是空串）。 */
  rawText: string | null
  /** 用户可编辑文字（采用时逐字使用，不 trim、不截断）。 */
  text: string
  requestId: string | null
  empty: boolean
  warnings: string[]
  image: NoticeOcrImage | null
  ocrMs: number | null
  /** 识别失败的原因（归档失败不写在这里）。 */
  error: BatchNoticeError | null
  /** 识别结果已经保留、但截图库历史没有写进去时的单独提示。 */
  historyError: string | null
  /** 已经打开过核对页（只能说明「已打开核对」，不代表任务已保存）。 */
  reviewOpened: boolean
}

export interface BatchNoticeRunProgress {
  /** 本轮计划识别的张数。 */
  total: number
  /** 本轮已经处理完的张数（失败也算处理完；取消不算）。 */
  done: number
}

export interface BatchNoticeState {
  phase: BatchNoticePhase
  busy: boolean
  busyAction: BatchNoticeBusyAction | null
  /** 纯文字进度（不是百分比）。 */
  statusText: string
  items: BatchNoticeItem[]
  activeItemId: string | null
  notice: BatchNoticeToast | null
  error: BatchNoticeError | null
  run: BatchNoticeRunProgress | null
  openedReviewItemId: string | null
}

export interface BatchNoticePickAsset {
  uri: string
  source?: BatchNoticeSource
}

export type BatchNoticePickResult =
  | { status: 'picked'; assets: BatchNoticePickAsset[] }
  | { status: 'cancelled' }
  | { status: 'permission'; message: string; canAskAgain: boolean }
  | { status: 'error'; message: string }

export interface BatchNoticePrepared {
  base64: string
  mimeType: string
}

export interface BatchNoticeArchiveResult {
  ok: boolean
  attemptId: number | null
  message: string | null
  /** 归档后的本机 URI；成功时应给出，界面查看器用它显示原图。 */
  archivedUri?: string | null
}

export interface BatchNoticeRecordInput {
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

export interface BatchNoticeDeps {
  state?: Partial<BatchNoticeState>
  pickFromLibrary: () => Promise<BatchNoticePickResult>
  preparePhoto: (uri: string, source: BatchNoticeSource | undefined) => Promise<BatchNoticePrepared>
  archiveOriginal: (
    uri: string,
    source: BatchNoticeSource | undefined,
    attemptSource: 'LIBRARY',
  ) => Promise<BatchNoticeArchiveResult>
  recognize: (
    endpoint: string,
    options: { imageBase64: string; mimeType: string; abortSignal: AbortSignal },
  ) => Promise<NoticeOcrResponse>
  recordResult: (input: BatchNoticeRecordInput) => void | Promise<void>
  /**
   * 只读解析「这次归档真正落盘的路径」。
   *
   * 归档端口可能只返回 attemptId（不返回路径）；这时界面不能拿相册临时 URI 冒充
   * 已保存原图。传入后控制器会用既有截图库读回真实的 `archivedPath`。
   */
  resolveArchivedPath?: (attemptId: number) => Promise<{ archivedPath: string | null } | null>
  getEndpoint: () => string | null
  getInferredEndpoint: () => string | null
  emit?: (event: { type: 'toast'; toast: BatchNoticeToast } | { type: 'error'; error: BatchNoticeError }) => void
  onAttemptFinished?: () => void
}

export type BatchNoticeStartResult =
  | 'started'
  | 'busy'
  | 'needs-replace-confirm'
  | 'needs-endpoint'
  | 'nothing'
  | 'invalid'
  | 'too-many'
  | 'already-archived'
  | 'blocked'

export type BatchNoticeAdoptResult =
  | { ok: true; text: string; itemId: string }
  | {
      ok: false
      reason: 'busy' | 'empty' | 'too-long' | 'already-open' | 'not-found' | 'blocked'
      message: string
    }

export interface BatchNoticeOperation {
  getState: () => BatchNoticeState
  subscribe: (listener: () => void) => () => void
  requestPick: (options?: { confirmReplace?: boolean }) => BatchNoticeStartResult
  retryArchive: (itemId: string) => Promise<BatchNoticeStartResult>
  startRun: (options?: { confirmReplace?: boolean }) => BatchNoticeStartResult
  retryItem: (itemId: string, options?: { confirmReplace?: boolean }) => BatchNoticeStartResult
  cancel: () => boolean
  setText: (itemId: string, value: string) => boolean
  adoptText: (itemId: string) => BatchNoticeAdoptResult
  focus: () => void
  /** React effect setup：重新挂上；**不重放**任何选图 / 归档 / 识别。 */
  activate: () => void
  /** React effect cleanup：abort 当前请求并作废所有迟到回调。 */
  dispose: () => void
  readonly attached: boolean
  readonly busy: boolean
  readonly running: boolean
}

export interface BatchNoticeProgress {
  total: number
  /** 已经得到 OCR 结论的张数（success + empty）。 */
  completed: number
  /** 还需要（或可以）再识别的张数（pending + failed + cancelled）。 */
  remaining: number
  success: number
  empty: number
  failed: number
  cancelled: number
  running: number
}

/** 纯统计：界面显示「已完成 X 张 / 待处理 Y 张」，不是百分比。 */
export function batchNoticeProgress(items: readonly BatchNoticeItem[]): BatchNoticeProgress {
  const progress: BatchNoticeProgress = {
    total: items.length,
    completed: 0,
    remaining: 0,
    success: 0,
    empty: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
  }
  for (const item of items) {
    if (item.status === 'success') {
      progress.success += 1
      progress.completed += 1
    } else if (item.status === 'empty') {
      progress.empty += 1
      progress.completed += 1
    } else if (item.status === 'failed') {
      progress.failed += 1
      progress.remaining += 1
    } else if (item.status === 'cancelled') {
      progress.cancelled += 1
      progress.remaining += 1
    } else if (item.status === 'running') {
      progress.running += 1
    } else {
      progress.remaining += 1
    }
  }
  return progress
}

/** 这一批是否还有本次会话里没带走的内容（离开 / 换批前要确认）。 */
export function hasUnsavedBatchNoticeQueue(state: Pick<BatchNoticeState, 'items'>): boolean {
  return Array.isArray(state.items) && state.items.length > 0
}

/** 单张文字能否进入既有 NoticeImport：空 / 超过 10000 字都不允许，绝不截断。 */
export function batchNoticeTextAdoption(
  text: string,
): { allowed: true; text: string } | { allowed: false; reason: 'empty' | 'too-long'; message: string } {
  const value = String(text ?? '')
  if (value.trim().length === 0) {
    return {
      allowed: false,
      reason: 'empty',
      message: '这张图还没有文字：请先识别，或手动输入这段通知的内容，再用它核对待办。',
    }
  }
  const lengthError = noticeSourceLengthError(value)
  if (lengthError) {
    return {
      allowed: false,
      reason: 'too-long',
      message: `${lengthError} 请先手动删减到 ${BATCH_NOTICE_MAX_TEXT_CHARS} 字以内；应用不会替你截断。`,
    }
  }
  return { allowed: true, text: value }
}

export function createItemFromAsset(asset: BatchNoticePickAsset, index: number): BatchNoticeItem {
  return {
    id: `batch-${index}`,
    index,
    uri: asset.uri,
    source: asset.source ?? null,
    archiveStatus: 'pending',
    archivedAttemptId: null,
    archivedUri: null,
    archiveError: null,
    status: 'pending',
    rawText: null,
    text: '',
    requestId: null,
    empty: false,
    warnings: [],
    image: null,
    ocrMs: null,
    error: null,
    historyError: null,
    reviewOpened: false,
  }
}

export function createInitialBatchNoticeState(overrides: Partial<BatchNoticeState> = {}): BatchNoticeState {
  return {
    phase: 'idle',
    busy: false,
    busyAction: null,
    statusText: '',
    items: [],
    activeItemId: null,
    notice: null,
    error: null,
    run: null,
    openedReviewItemId: null,
    ...overrides,
  }
}

function isRunEligible(status: BatchNoticeItemStatus): boolean {
  return status === 'pending' || status === 'failed' || status === 'cancelled'
}

function isPerImageRetryEligible(status: BatchNoticeItemStatus): boolean {
  return status === 'failed' || status === 'cancelled' || status === 'empty'
}

function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback
}

function failureOf(cause: unknown, fallback: string): BatchNoticeError {
  if (cause instanceof OcrClientError) {
    return { message: cause.message, code: cause.code, retryable: cause.retryable }
  }
  return { message: `${fallback}：${messageOf(cause, '本机处理出错')}`, code: 'SERVICE', retryable: true }
}

function itemById(items: readonly BatchNoticeItem[], itemId: string): BatchNoticeItem | null {
  return items.find((item) => item.id === itemId) ?? null
}

function patchItem(items: readonly BatchNoticeItem[], itemId: string, patch: Partial<BatchNoticeItem>): BatchNoticeItem[] {
  return items.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
}

/* --------------------------------- 状态机 --------------------------------- */

interface ActiveAttempt {
  generation: number
  itemId: string
  controller: AbortController
  /** 这一轮是否已经收尾（防止旧轮的 finally 改新状态 / 放掉新闸门）。 */
  settled: boolean
}

export function createBatchNoticeOperation(deps: BatchNoticeDeps): BatchNoticeOperation {
  let state = createInitialBatchNoticeState(deps.state)
  const listeners = new Set<() => void>()

  let mounted = true
  /** 同步 busy 闸门：读取它永远是最新值，不依赖 React state。 */
  let busy = false
  let running = false
  /** 递增的轮次：取消 / 换批 / dispose 之后，旧 OCR 结果一律作废。 */
  let generation = 0
  /**
   * 当前这一批的**队列身份**。
   *
   * 只有真正换了一批图才会递增；dispose / activate / 取消 OCR 都不变。
   * 归档文件写入无法取消，因此它的结果必须按「同一批」对账，而不能被 UI 的 generation 丢掉；
   * 新一批则一定换了身份，旧归档结果不会写进新队列。
   */
  let queueToken = 0
  /** 同一批、同一张图最多一个在途归档；重复点重试不会发第二个写请求。 */
  const archiveJobs = new Map<string, Promise<boolean>>()
  /** 正在顺序归档的队列身份；按队列记录，旧队列收尾不能放掉新队列的 busy。 */
  const archivingQueues = new Set<number>()
  let activeAttempt: ActiveAttempt | null = null
  /** 采用文字后的同步防连点（回到本页 `focus()` 时清除）。 */
  let adoptGuard = false

  const isCurrent = (token: number): boolean => mounted && token === generation

  function update(changes: Partial<BatchNoticeState>): void {
    if (!mounted) return
    state = { ...state, ...changes }
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅者异常不能影响状态机本身。
      }
    }
  }

  function setItem(itemId: string, patch: Partial<BatchNoticeItem>): void {
    update({ items: patchItem(state.items, itemId, patch) })
  }

  function emitError(error: BatchNoticeError): void {
    try {
      deps.emit?.({ type: 'error', error })
    } catch {
      // 事件出口不允许影响流程。
    }
  }

  function emitToast(toast: BatchNoticeToast): void {
    try {
      deps.emit?.({ type: 'toast', toast })
    } catch {
      // 事件出口不允许影响流程。
    }
  }

  /** 只记录历史；历史写入失败只在本项上单独说明，绝不改写 OCR 结论。 */
  async function recordHistorySafely(
    token: number,
    itemId: string,
    input: BatchNoticeRecordInput,
  ): Promise<void> {
    try {
      const maybe = deps.recordResult(input) as unknown
      if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
        await (maybe as Promise<unknown>)
      }
      if (isCurrent(token)) setItem(itemId, { historyError: null })
    } catch (cause) {
      if (isCurrent(token)) {
        const message = `识别结果已经保留，但截图库历史没有写进去：${messageOf(cause, '本机写入出错')}`
        setItem(itemId, { historyError: message })
        emitError({ message, code: 'HISTORY_WRITE_FAILED', retryable: false })
      }
    } finally {
      if (isCurrent(token)) {
        try {
          deps.onAttemptFinished?.()
        } catch {
          // 收尾回调不允许影响流程。
        }
      }
    }
  }

  /**
   * 只把归档结果写回**同一批**的同一张图。
   *
   * 归档文件写入无法 abort，所以这里刻意不看 OCR 的 generation：
   * dispose / activate / 取消 OCR 都可能发生在写文件期间，成功落盘的事实必须能在
   * 同一批里对账（否则会永远停在「正在保存」或重复保存）。换批时 `queueToken` 已变，
   * 旧结果一律不写入新队列。
   */
  function commitArchiveItem(
    queueAtStart: number,
    itemId: string,
    patch: Partial<BatchNoticeItem>,
  ): boolean {
    if (queueToken !== queueAtStart) return false
    if (!itemById(state.items, itemId)) return false
    const items = patchItem(state.items, itemId, patch)
    if (!mounted) {
      // 卸载期间也要保留真实结果，供 activate 后如实显示；只是不通知订阅者。
      state = { ...state, items }
      return true
    }
    update({ items })
    return true
  }

  function queueHasPendingArchives(): boolean {
    const prefix = `${queueToken}:`
    for (const key of archiveJobs.keys()) {
      if (key.startsWith(prefix)) return true
    }
    return false
  }

  /** 归档 job 收尾后，只有在没有下一张 / 新一轮归档时才允许放掉归档 busy。 */
  function reconcileArchiveBusy(): void {
    if (!mounted || archivingQueues.has(queueToken)) return
    if (queueHasPendingArchives()) return
    if (busy && state.busyAction === 'archive') {
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
      })
    }
  }

  /** 单张原图归档。已成功归档的**永远不重复调用**；同一张图同时只有一个在途归档。 */
  async function archiveOne(_token: number, itemId: string): Promise<boolean> {
    const item = itemById(state.items, itemId)
    if (!item) return false
    if (item.archiveStatus === 'archived' && item.archivedAttemptId !== null) return true

    const queueAtStart = queueToken
    const key = `${queueAtStart}:${itemId}`
    const existing = archiveJobs.get(key)
    if (existing) return existing

    commitArchiveItem(queueAtStart, itemId, { archiveStatus: 'archiving', archiveError: null })

    const job = (async (): Promise<boolean> => {
      try {
        const outcome = await deps.archiveOriginal(item.uri, item.source ?? undefined, 'LIBRARY')
        if (queueToken !== queueAtStart) return false
        if (outcome.ok && outcome.attemptId !== null) {
          // 优先用只读仓库读回真正落盘的路径；归档端口即使只回 attemptId 也能对账。
          // 读不到时才退回端口自己报的 archivedUri，绝不把相册临时 URI 当成已保存原图。
          let archivedUri: string | null = null
          if (deps.resolveArchivedPath) {
            try {
              const found = await deps.resolveArchivedPath(outcome.attemptId)
              const path = found?.archivedPath ?? null
              if (typeof path === 'string' && path.length > 0) archivedUri = path
            } catch {
              archivedUri = null
            }
          }
          if (
            archivedUri === null &&
            typeof outcome.archivedUri === 'string' &&
            outcome.archivedUri.length > 0
          ) {
            archivedUri = outcome.archivedUri
          }
          commitArchiveItem(queueAtStart, itemId, {
            archiveStatus: 'archived',
            archivedAttemptId: outcome.attemptId,
            archivedUri,
            archiveError: null,
          })
          return true
        }
        const message = outcome.message ?? '这张图没能保存到截图库。'
        commitArchiveItem(queueAtStart, itemId, {
          archiveStatus: 'failed',
          archivedAttemptId: outcome.attemptId,
          archivedUri: null,
          archiveError: message,
        })
        if (mounted && queueToken === queueAtStart) {
          emitError({ message: `这张图没能保存到截图库：${message}`, code: 'ARCHIVE_FAILED', retryable: true })
        }
        return false
      } catch (cause) {
        if (queueToken !== queueAtStart) return false
        const message = messageOf(cause, '本机写入出错')
        commitArchiveItem(queueAtStart, itemId, {
          archiveStatus: 'failed',
          archivedUri: null,
          archiveError: message,
        })
        if (mounted && queueToken === queueAtStart) {
          emitError({ message: `这张图没能保存到截图库：${message}`, code: 'ARCHIVE_FAILED', retryable: true })
        }
        return false
      }
    })()

    archiveJobs.set(key, job)
    try {
      return await job
    } finally {
      archiveJobs.delete(key)
      if (queueToken === queueAtStart) reconcileArchiveBusy()
    }
  }

  /** 顺序归档整批；任何一张失败都继续，下一张照常保存。 */
  async function archiveQueue(token: number): Promise<void> {
    const queueAtStart = queueToken
    archivingQueues.add(queueAtStart)
    try {
      for (const item of [...state.items]) {
        if (!isCurrent(token)) return
        if (item.archiveStatus === 'archived' && item.archivedAttemptId !== null) continue
        const index = item.index
        update({ statusText: `正在保存第 ${index}/${state.items.length} 张原图…` })
        await archiveOne(token, item.id)
        if (!isCurrent(token)) return
      }
    } finally {
      archivingQueues.delete(queueAtStart)
      // 即使本轮已经失效，也要让同一队列（dispose → activate 后）的 busy 能收尾。
      if (mounted) reconcileArchiveBusy()
    }
  }

  async function performPick(): Promise<void> {
    const token = ++generation
    busy = true
    update({
      busy: true,
      busyAction: 'pick',
      phase: 'picking',
      statusText: '正在打开相册…',
      notice: null,
      error: null,
      run: null,
      openedReviewItemId: null,
    })

    let picked: BatchNoticePickResult
    try {
      picked = await deps.pickFromLibrary()
    } catch (cause) {
      if (!isCurrent(token)) return
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: {
          message: `打开相册失败：${messageOf(cause, '系统没有返回可用结果')}`,
          code: 'PICK_FAILED',
          retryable: true,
        },
      })
      return
    }
    if (!isCurrent(token)) return

    if (picked.status === 'cancelled') {
      // 用户取消选择器：不是错误，也不改动上一批。
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
      })
      return
    }
    if (picked.status === 'permission') {
      busy = false
      const message = picked.canAskAgain
        ? `${picked.message}（允许之后可以再点一次；上一批不会被改动。）`
        : `${picked.message} 如果系统不再弹窗，请到手机系统设置里为 Expo Go 打开「照片」权限。上一批不会被改动。`
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: { message, code: 'PERMISSION', retryable: picked.canAskAgain },
      })
      return
    }
    if (picked.status === 'error') {
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: { message: picked.message, code: 'PICK_FAILED', retryable: true },
      })
      return
    }

    if (picked.assets.length === 0) {
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: { message: '系统没有返回任何图片，请重新选择。上一批没有被改动。', code: 'PICK_FAILED', retryable: true },
      })
      return
    }
    if (picked.assets.length > BATCH_NOTICE_MAX_IMAGES) {
      // 绝不静默截断 / 丢掉多出来的图：整次选择都不采用。
      const message = `你一次选择了 ${picked.assets.length} 张，超过上限 ${BATCH_NOTICE_MAX_IMAGES} 张。这次没有改动任何图片，请重新选择最多 ${BATCH_NOTICE_MAX_IMAGES} 张。`
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: { message, code: 'TOO_MANY', retryable: true },
      })
      emitError({ message, code: 'TOO_MANY', retryable: true })
      return
    }
    const missing = picked.assets.findIndex((asset) => typeof asset.uri !== 'string' || asset.uri.length === 0)
    if (missing >= 0) {
      const message = `系统没有返回第 ${missing + 1} 张图片的内容，这次没有改动任何图片，请重新选择。`
      busy = false
      update({
        busy: false,
        busyAction: null,
        phase: state.items.length > 0 ? 'ready' : 'idle',
        statusText: '',
        error: { message, code: 'PICK_FAILED', retryable: true },
      })
      return
    }

    // 到这里才真正替换上一批：取消 / 权限 / 超限都不会走到这里。
    // 换队列身份：旧一批仍在写盘的归档结果绝不能写进这一批（即使 id 同样是 batch-1）。
    queueToken += 1
    const items = picked.assets.map((asset, index) => createItemFromAsset(asset, index + 1))
    update({
      items,
      activeItemId: null,
      run: null,
      openedReviewItemId: null,
      notice: null,
      error: null,
      phase: 'archiving',
      busy: true,
      busyAction: 'archive',
      statusText: `正在保存 1/${items.length} 张原图…`,
    })

    await archiveQueue(token)
    if (!isCurrent(token)) return

    const archivedCount = state.items.filter((item) => item.archiveStatus === 'archived').length
    const failedCount = state.items.filter((item) => item.archiveStatus === 'failed').length
    busy = false
    update({
      busy: false,
      busyAction: null,
      phase: 'ready',
      statusText: failedCount > 0
        ? `已保存 ${archivedCount}/${items.length} 张原图；${failedCount} 张没保存成功，可以逐张重试。还没有识别。`
        : `已保存 ${archivedCount}/${items.length} 张原图；还没有识别。点「识别待处理图片」开始。`,
      notice: {
        tone: failedCount > 0 ? 'error' : 'success',
        text: failedCount > 0
          ? `${items.length} 张已选好；${failedCount} 张原图没有保存成功，识别前可以逐张重试保存。`
          : `${items.length} 张原图已经保存到截图库；图片本身不会被删除。`,
      },
    })
  }

  function requestPick(options?: { confirmReplace?: boolean }): BatchNoticeStartResult {
    if (!mounted) return 'blocked'
    if (busy) return 'busy'
    if (hasUnsavedBatchNoticeQueue(state) && options?.confirmReplace !== true) return 'needs-replace-confirm'
    void performPick()
    return 'started'
  }

  async function retryArchive(itemId: string): Promise<BatchNoticeStartResult> {
    if (!mounted) return 'blocked'
    if (busy) return 'busy'
    const item = itemById(state.items, itemId)
    if (!item) return 'invalid'
    if (item.archiveStatus === 'archived' && item.archivedAttemptId !== null) return 'already-archived'

    const token = ++generation
    busy = true
    update({
      busy: true,
      busyAction: 'archive',
      phase: 'archiving',
      statusText: `正在重新保存第 ${item.index} 张原图…`,
      notice: null,
      error: null,
    })
    const ok = await archiveOne(token, itemId)
    if (!isCurrent(token)) return 'started'
    busy = false
    update({
      busy: false,
      busyAction: null,
      phase: 'ready',
      statusText: '',
      notice: ok
        ? { tone: 'success', text: `第 ${item.index} 张原图已经保存到截图库。` }
        : { tone: 'error', text: `第 ${item.index} 张原图还是没有保存成功；识别结果与手改文字都没有被改动。` },
    })
    return 'started'
  }

  /** 识别一张；返回 `done` 表示继续下一张，`stopped` 表示取消 / 失效，停止推进。 */
  async function runOne(
    token: number,
    itemId: string,
    endpoint: string,
    ordinal: number,
    total: number,
  ): Promise<'done' | 'stopped'> {
    const item = itemById(state.items, itemId)
    if (!item) return 'done'
    setItem(itemId, { status: 'running', error: null, historyError: null })
    update({ activeItemId: itemId, statusText: `正在识别第 ${ordinal}/${total} 张…` })

    // 归档早于 prepare / upload；成功归档过的这张图绝不重复归档。
    if (item.archiveStatus !== 'archived' || item.archivedAttemptId === null) {
      update({ statusText: `正在保存第 ${ordinal}/${total} 张原图…` })
      await archiveOne(token, itemId)
      if (!isCurrent(token)) return 'stopped'
    }
    const afterArchive = itemById(state.items, itemId)
    if (!afterArchive) return 'done'

    let prepared: BatchNoticePrepared
    try {
      update({ statusText: `正在准备第 ${ordinal}/${total} 张图片…` })
      prepared = await deps.preparePhoto(afterArchive.uri, afterArchive.source ?? undefined)
    } catch (cause) {
      if (!isCurrent(token)) return 'stopped'
      const failure = failureOf(cause, '这张图没能准备好上传')
      setItem(itemId, { status: 'failed', error: failure, requestId: null })
      await recordHistorySafely(token, itemId, {
        attemptId: afterArchive.archivedAttemptId,
        status: 'FAILED',
        requestId: null,
        errorCode: failure.code,
        errorMessage: failure.message,
      })
      return 'done'
    }
    if (!isCurrent(token)) return 'stopped'
    if (typeof prepared.base64 !== 'string' || prepared.base64.length === 0) {
      const failure: BatchNoticeError = {
        message: '没有读到这张图片的内容，请重新选择或再试一次。',
        code: 'BAD_REQUEST',
        retryable: true,
      }
      setItem(itemId, { status: 'failed', error: failure })
      await recordHistorySafely(token, itemId, {
        attemptId: afterArchive.archivedAttemptId,
        status: 'FAILED',
        requestId: null,
        errorCode: failure.code,
        errorMessage: failure.message,
      })
      return 'done'
    }

    const attempt: ActiveAttempt = {
      generation: token,
      itemId,
      controller: new AbortController(),
      settled: false,
    }
    activeAttempt = attempt
    update({ statusText: `正在识别第 ${ordinal}/${total} 张…` })
    try {
      const response = await deps.recognize(endpoint, {
        imageBase64: prepared.base64,
        mimeType: prepared.mimeType,
        abortSignal: attempt.controller.signal,
      })
      if (!isCurrent(token) || attempt.settled) return 'stopped'
      attempt.settled = true
      activeAttempt = null
      const rawText = typeof response.rawText === 'string' ? response.rawText : ''
      const empty = rawText.length === 0 || response.empty === true
      // **先**把识别结论与文字写进状态：随后历史写入失败也不允许改写它。
      setItem(itemId, {
        status: empty ? 'empty' : 'success',
        rawText,
        text: rawText,
        requestId: response.requestId,
        empty,
        warnings: Array.isArray(response.warnings) ? response.warnings : [],
        image: response.image,
        ocrMs: response.ms,
        error: null,
        historyError: null,
      })
      await recordHistorySafely(token, itemId, {
        attemptId: afterArchive.archivedAttemptId,
        status: 'SUCCESS',
        rawText,
        requestId: response.requestId,
        warnings: response.warnings,
        durationMs: response.ms,
        image: response.image,
      })
      return 'done'
    } catch (cause) {
      if (!isCurrent(token) || attempt.settled) return 'stopped'
      attempt.settled = true
      activeAttempt = null
      const failure = failureOf(cause, '这次识别没有成功')
      if (failure.code === 'CANCELLED') {
        // 取消不是失败：保留已经改好的文字，只回到可重试的取消态。
        setItem(itemId, { status: 'cancelled', error: null })
        running = false
        busy = false
        update({
          busy: false,
          busyAction: null,
          phase: 'cancelled',
          activeItemId: null,
          run: null,
          statusText: '这次识别已经取消；已完成的图片和手动修改都保留。',
        })
        await recordHistorySafely(token, itemId, {
          attemptId: afterArchive.archivedAttemptId,
          status: 'CANCELLED',
          requestId: afterArchive.requestId,
          errorCode: 'CANCELLED',
          errorMessage: failure.message,
        })
        return 'stopped'
      }
      setItem(itemId, { status: 'failed', error: failure })
      await recordHistorySafely(token, itemId, {
        attemptId: afterArchive.archivedAttemptId,
        status: 'FAILED',
        requestId: afterArchive.requestId,
        errorCode: failure.code,
        errorMessage: failure.message,
      })
      return 'done'
    }
  }

  async function performRun(itemIds: readonly string[], endpoint: string): Promise<void> {
    const token = ++generation
    running = true
    busy = true
    update({
      busy: true,
      busyAction: 'run',
      phase: 'running',
      statusText: `准备识别 ${itemIds.length} 张…`,
      run: { total: itemIds.length, done: 0 },
      activeItemId: null,
      notice: null,
      error: null,
      openedReviewItemId: null,
    })

    let done = 0
    try {
      for (const itemId of itemIds) {
        if (!isCurrent(token)) return
        const current = itemById(state.items, itemId)
        // 目标清单已经由 startRun / retryItem 按各自允许的状态筛过；
        // 这里只确认这一项还在当前这一批里。
        if (!current) continue
        update({ run: { total: itemIds.length, done } })
        const outcome = await runOne(token, itemId, endpoint, done + 1, itemIds.length)
        if (outcome === 'stopped' || !isCurrent(token)) return
        done += 1
        update({ run: { total: itemIds.length, done } })
      }
      if (!isCurrent(token)) return
      busy = false
      running = false
      const progress = batchNoticeProgress(state.items)
      update({
        busy: false,
        busyAction: null,
        phase: 'ready',
        activeItemId: null,
        run: null,
        statusText: `识别结束：已完成 ${progress.completed} 张，待处理 ${progress.remaining} 张。`,
      })
      emitToast({
        text:
          `这一轮识别结束：成功 ${progress.success} 张` +
          `${progress.empty > 0 ? `（其中 ${progress.empty} 张没有读到文字）` : ''}，` +
          `失败/取消 ${progress.failed + progress.cancelled} 张。每张截图请分别核对并保存任务。`,
        tone: progress.failed + progress.cancelled > 0 ? 'error' : 'success',
      })
    } finally {
      // 只有本轮仍是当前轮时才清闸门：旧轮的 finally 绝不能放掉新操作的 busy。
      if (isCurrent(token)) {
        busy = false
        running = false
        update({ busy: false, busyAction: null, activeItemId: null })
      }
    }
  }

  function startRun(options?: { confirmReplace?: boolean }): BatchNoticeStartResult {
    if (!mounted) return 'blocked'
    if (busy) return 'busy'
    const eligible = state.items.filter((item) => isRunEligible(item.status))
    if (eligible.length === 0) {
      update({
        statusText: '',
        notice: {
          tone: 'error',
          text: '没有待识别的图片：只有还没识别、识别失败或已取消的图片会被识别；识别成功的不会重新识别。',
        },
      })
      return 'nothing'
    }
    const resolved = resolveOcrEndpoint(deps.getEndpoint() ?? deps.getInferredEndpoint())
    if (!resolved.ok) {
      const message =
        resolved.reason === 'empty'
          ? '还没有设置这台电脑的文字识别服务地址。请先打开「识别服务设置」填写（手机与电脑要连同一个 Wi-Fi）。'
          : '文字识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。'
      update({
        error: { message, code: 'NO_ENDPOINT', retryable: false },
        phase: state.items.length > 0 ? 'ready' : 'idle',
        busy: false,
        statusText: '',
      })
      return 'needs-endpoint'
    }
    // 手改过的文字必须明确确认才会被新的识别结果替换，绝不静默覆盖。
    if (eligible.some((item) => item.text.trim().length > 0) && options?.confirmReplace !== true) {
      return 'needs-replace-confirm'
    }
    void performRun(
      eligible.map((item) => item.id),
      resolved.endpoint,
    )
    return 'started'
  }

  function retryItem(itemId: string, options?: { confirmReplace?: boolean }): BatchNoticeStartResult {
    if (!mounted) return 'blocked'
    if (busy) return 'busy'
    const item = itemById(state.items, itemId)
    if (!item) return 'invalid'
    if (!isPerImageRetryEligible(item.status)) return 'invalid'
    const resolved = resolveOcrEndpoint(deps.getEndpoint() ?? deps.getInferredEndpoint())
    if (!resolved.ok) {
      const message =
        resolved.reason === 'empty'
          ? '还没有设置这台电脑的文字识别服务地址。请先打开「识别服务设置」填写。'
          : '文字识别服务地址格式不对（要写成 http://电脑IP:8082）。请到「识别服务设置」里改好。'
      update({
        error: { message, code: 'NO_ENDPOINT', retryable: false },
        phase: state.items.length > 0 ? 'ready' : 'idle',
        busy: false,
        statusText: '',
      })
      return 'needs-endpoint'
    }
    if (item.text.trim().length > 0 && options?.confirmReplace !== true) return 'needs-replace-confirm'
    void performRun([itemId], resolved.endpoint)
    return 'started'
  }

  /** 中止当前这张并停止推进；已完成结果与手改文字全部保留。 */
  function cancel(): boolean {
    if (!mounted || !running) return false
    const itemId = activeAttempt?.itemId ?? state.activeItemId
    const attempt = activeAttempt
    /** 只有真的发过 OCR 请求、且还在 running 的这张才需要记取消历史。 */
    const hadOcrAttempt = attempt !== null
    generation += 1
    activeAttempt = null
    if (attempt) {
      attempt.settled = true
      attempt.controller.abort()
    }
    running = false
    busy = false
    const target = itemId ? itemById(state.items, itemId) : null
    const targetWasRunning = target?.status === 'running'
    if (target && targetWasRunning) {
      setItem(target.id, { status: 'cancelled', error: null })
    }
    const progress = batchNoticeProgress(state.items)
    update({
      busy: false,
      busyAction: null,
      phase: 'cancelled',
      activeItemId: null,
      run: null,
      statusText: `已取消：已完成 ${progress.completed} 张，待处理 ${progress.remaining} 张。`,
      notice: { tone: 'success', text: '已停止这一轮识别；已经完成的结果和手动修改都保留，可以稍后点「识别待处理图片」继续。' },
    })
    if (target && targetWasRunning && hadOcrAttempt) {
      // 只给真正在途的 OCR 记取消；识别已经成功、只是历史还在写时，
      // 停止只负责「不再推进下一张」，绝不能给成功项补一条假的 CANCELLED。
      void recordHistorySafely(generation, target.id, {
        attemptId: target.archivedAttemptId,
        status: 'CANCELLED',
        requestId: target.requestId,
        errorCode: 'CANCELLED',
        errorMessage: '用户取消了第 ' + target.index + ' 张的识别。',
      })
    }
    return true
  }

  function setText(itemId: string, value: string): boolean {
    if (!mounted || busy) return false
    const item = itemById(state.items, itemId)
    if (!item || item.status === 'running') return false
    setItem(itemId, { text: String(value ?? '') })
    return true
  }

  function adoptText(itemId: string): BatchNoticeAdoptResult {
    if (!mounted) {
      return { ok: false, reason: 'blocked', message: '这一页已经关闭，请重新打开。' }
    }
    if (busy) {
      return { ok: false, reason: 'busy', message: '正在处理这一批图片，请等这一轮结束再核对。' }
    }
    if (adoptGuard) {
      return { ok: false, reason: 'already-open', message: '已经打开了核对页；回到这一页后可以再次核对。' }
    }
    const item = itemById(state.items, itemId)
    if (!item) return { ok: false, reason: 'not-found', message: '这张图片已经不在这一批里了。' }
    const adoption = batchNoticeTextAdoption(item.text)
    if (!adoption.allowed) {
      return {
        ok: false,
        reason: adoption.reason,
        message: adoption.message,
      }
    }
    adoptGuard = true
    setItem(itemId, { reviewOpened: true })
    update({ openedReviewItemId: itemId })
    return { ok: true, text: adoption.text, itemId }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    requestPick,
    retryArchive,
    startRun,
    retryItem,
    cancel,
    setText,
    adoptText,
    focus: () => {
      adoptGuard = false
    },
    activate: () => {
      if (mounted) return
      mounted = true
      generation += 1
      running = false
      activeAttempt = null
      adoptGuard = false

      const pendingArchives = queueHasPendingArchives()
      // 不重放任何选图 / 归档 / 识别。归档写文件无法 abort：
      // - 有在途归档时保留「正在保存」并继续 busy，等它按同一批对账；
      // - 没有在途 job 却还停在 archiving，才如实标成需要重试，绝不说已保存。
      const items = state.items.map((item) => {
        if (item.status === 'running') {
          return { ...item, status: 'cancelled' as const, error: null }
        }
        if (item.archiveStatus === 'archiving' && !pendingArchives) {
          return {
            ...item,
            archiveStatus: 'failed' as const,
            archivedUri: null,
            archiveError: '页面关闭时还没有确认这张原图是否保存成功，请重新保存。',
          }
        }
        return item
      })

      if (pendingArchives) {
        busy = true
        state = {
          ...state,
          items,
          busy: true,
          busyAction: 'archive',
          phase: 'archiving',
          activeItemId: null,
          run: null,
          statusText: '正在确认原图保存结果…',
        }
      } else {
        busy = false
        state = {
          ...state,
          items,
          busy: false,
          busyAction: null,
          phase: items.length > 0 ? 'ready' : 'idle',
          activeItemId: null,
          statusText: '',
        }
      }
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // 订阅者异常不能影响状态机本身。
        }
      }
    },
    dispose: () => {
      const wasRunning = running
      const currentId = activeAttempt?.itemId ?? state.activeItemId
      mounted = false
      generation += 1
      const attempt = activeAttempt
      /** 只有真的发过 OCR 请求时才登记取消历史；仅准备 / 归档中取消不算一次 OCR。 */
      const hadOcrAttempt = attempt !== null
      activeAttempt = null
      if (attempt) {
        attempt.settled = true
        attempt.controller.abort()
      }
      running = false
      busy = false
      adoptGuard = false
      let cancelledItem: BatchNoticeItem | null = null
      if (wasRunning && currentId) {
        const target = itemById(state.items, currentId)
        if (target && target.status === 'running') {
          if (hadOcrAttempt) cancelledItem = { ...target, status: 'cancelled', error: null }
          state = {
            ...state,
            items: patchItem(state.items, currentId, { status: 'cancelled', error: null }),
          }
        }
      }
      // 归档写到一半就卸载：**不要**把 archiving 改成失败，也不要丢 job。
      // 文件写入无法 abort；job 落盘后会按同一 queueToken 静默对账，activate 后显示真实结果。
      state = {
        ...state,
        busy: false,
        busyAction: null,
        activeItemId: null,
        run: null,
        statusText: wasRunning ? '这一页已经关闭；进行中的识别已取消。' : state.statusText,
      }
      listeners.clear()
      if (cancelledItem) {
        // 直接登记取消历史（不再改任何界面状态）。
        try {
          const maybe = deps.recordResult({
            attemptId: cancelledItem.archivedAttemptId,
            status: 'CANCELLED',
            requestId: cancelledItem.requestId,
            errorCode: 'CANCELLED',
            errorMessage: '页面关闭，进行中的识别已取消。',
          }) as unknown
          if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
            void (maybe as Promise<unknown>).catch(() => undefined)
          }
        } catch {
          // 历史记录失败不影响卸载。
        }
      }
    },
    get attached() {
      return mounted
    },
    get busy() {
      return busy
    },
    get running() {
      return running
    },
  }
}
