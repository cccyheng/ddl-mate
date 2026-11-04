/**
 * 任务提醒通知点击 → 任务详情：**纯路由控制器**（无 React / 无原生模块）。
 *
 * 原生 API、数据库读取都由 hook / store 注入，因此 Node 测试可以完整覆盖冷启动、
 * 持久回执、A→B→A、编辑中暂缓、删除任务、读取失败重试与卸载竞态。
 *
 * 安全边界：
 * - 只认 `domain/taskReminder.ts` 的严格命名空间 + 载荷；ID 与载荷任务 ID 必须一致；
 * - 只认系统默认点击动作；不解析 URL / 任意路由名，只把正整数任务 ID 交给导航；
 * - 不调用 `clearLastNotificationResponse`（避免误清用户刚点的新通知 / 别的模块通知）；
 * - 只有导航**已经被接受**后才写持久回执；回执有界（32 条），支持重启去重；
 * - 没有有效展示时间的点击不写持久回执，只用短时内存去重，避免永久吞掉未来通知。
 */

import {
  parseOwnedReminderNotification,
  parseReminderNotificationPayload,
  type OwnedReminderNotification,
} from '../domain/taskReminder'
import type { TaskReminderNotificationReceipt } from '../domain/taskReminderNotificationReceipts'

export interface TaskReminderNotificationsApi {
  DEFAULT_ACTION_IDENTIFIER: string
  getLastNotificationResponse: () => unknown | Promise<unknown>
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    remove: () => void
  }
}

/**
 * 供本机诊断使用的**结构化事件**（不含通知正文 / 原始载荷）。
 *
 * 只描述状态机走到哪一步，UI 可以安全地把它显示给用户。
 */
export type TaskReminderNotificationTapSource = 'listener' | 'cold'

export type TaskReminderNotificationTapEvent =
  | { stage: 'received'; source: TaskReminderNotificationTapSource }
  | { stage: 'rejected'; source: TaskReminderNotificationTapSource; reason: string }
  | { stage: 'recognized'; source: TaskReminderNotificationTapSource; taskId: number; test: boolean }
  | { stage: 'deferred'; taskId: number; editing: boolean; navigationReady: boolean }
  | { stage: 'opened'; taskId: number }
  | { stage: 'missing'; taskId: number }
  | { stage: 'deduped'; taskId: number; reason: string }
  | { stage: 'stale-generation'; taskId: number; deliveredGeneration: number; currentGeneration: number }
  | { stage: 'failed'; taskId: number | null; reason: string }
  | { stage: 'receipt'; taskId: number; ok: boolean; stored: boolean; reason: string | null }
  | { stage: 'listener'; state: 'registered' | 'removed' | 'failed' }
  | { stage: 'cold-read'; state: 'ok' | 'empty' | 'failed' }

export interface TaskReminderNotificationTap {
  taskId: number
  identifier: string
  /** 测试提醒与正式提醒都跳同一条任务详情；只用于诊断 / 测试断言。 */
  test: boolean
  title: string | null
  /** 排程时的本机路由代次；恢复后本机代次变化，旧点击不得打开复用 ID。 */
  deliveryGeneration: number
  deliveryDate: number | null
  /** 正式提醒是载荷 fingerprint；测试提醒是已验证的 triggerAtMs。 */
  evidence: string
  actionIdentifier: string
  /** 有有效展示时间时的持久回执 token；没有则 `null`（不落盘）。 */
  durableToken: string | null
  /** 没有展示时间时的短时内存去重 key。 */
  memoryToken: string
  /**
   * 稳定 token（独立 oracle 使用）：有展示时间时等同 `durableToken`，
   * 否则等同 `memoryToken`。只由已验证字段构成。
   */
  token: string
}

export interface TaskReminderTaskLookup {
  ok: boolean
  task: { id: number; title: string } | null
  reason: string | null
}

export interface TaskReminderNotificationReceiptsPort {
  hasConsumed: (token: string) => Promise<{ ok: boolean; consumed: boolean; reason: string | null }>
  recordConsumption: (
    receipt: TaskReminderNotificationReceipt,
  ) => Promise<{ ok: boolean; stored: boolean; reason: string | null }>
}

export type TaskReminderNotificationNotice =
  | {
      kind: 'pending'
      taskId: number
      title: string | null
      blockedByEditing: boolean
      blockedByBackup: boolean
      waitingForReady: boolean
    }
  | { kind: 'missing'; taskId: number; title: string | null; detail: string | null }
  | { kind: 'error'; message: string; canRetry: boolean }
  | { kind: 'warning'; message: string }

export interface TaskReminderNotificationState {
  notice: TaskReminderNotificationNotice | null
  editing: boolean
  navigationReady: boolean
}

export interface TaskReminderNotificationRouterDeps {
  loadNotifications: () => Promise<TaskReminderNotificationsApi>
  /** 只读、最新 DB 查询；不得写任务数据。 */
  lookupTaskFresh: (taskId: number) => Promise<TaskReminderTaskLookup>
  receipts: TaskReminderNotificationReceiptsPort
  /** 导航层在当前未就绪时应抛错；控制器不会在错误后写回执。 */
  navigateToTask: (taskId: number) => void | Promise<void>
  navigateToTaskList: () => void
  isEditing: () => boolean
  isNavigationReady: () => boolean
  /** 当前本机通知路由代次；缺省 0（旧测试 / 旧调用方）。 */
  getNotificationGeneration?: () => number
  now?: () => number
  /** 没有展示时间时的短时去重窗口；默认 5 秒，只用于监听器 + last 的重复事件。 */
  ephemeralDedupeMs?: number
  onDiagnostic?: (message: string) => void
  /** 本机诊断：只收结构化状态，不收通知正文。 */
  onTapEvent?: (event: TaskReminderNotificationTapEvent) => void
}

export interface TaskReminderNotificationRouter {
  getState: () => TaskReminderNotificationState
  subscribe: (listener: () => void) => () => void
  start: () => Promise<void>
  markNavigationReady: () => void
  setEditing: (editing: boolean) => void
  /** 备份 / 恢复期间暂缓所有通知导航；结束后再交付（旧代次会被拒绝）。 */
  setBackupBusy: (busy: boolean) => void
  /** 读取失败 / 导航失败后重试，不依赖新的原生事件。 */
  retry: () => Promise<void>
  dismiss: () => void
  /** 任务已删除时的安全出口：只在非编辑状态调用。 */
  openTaskList: () => boolean
  dispose: () => void
}

/**
 * 编辑中的路由：这些页面可能有未保存草稿。按**当前聚焦路由**保守暂缓，
 * 不主动导航、不返回、不弹草稿确认；等用户自己离开到其它路由后再交付。
 */
export const TASK_REMINDER_EDITING_ROUTES: readonly string[] = [
  // TaskDetail 自身也有「追加原文」草稿 + 确认框：路由复用 / 换 id 前保守暂缓。
  'TaskDetail',
  'TaskForm',
  'CourseForm',
  'ScheduleForm',
  'NoticeImport',
  'NoticePhoto',
  'BatchNotice',
  'PhotoReview',
  'TaskReminder',
  'TaskSteps',
  'TodayPlan',
  'ExamRevision',
  'ExamPhoto',
  'ExamPhotoReview',
  'Pressure',
]

export function isTaskReminderEditingRoute(routeName: string | null | undefined): boolean {
  return typeof routeName === 'string' && TASK_REMINDER_EDITING_ROUTES.includes(routeName)
}

interface NavigationStateLike {
  index?: number
  routes?: Array<{ name?: string; state?: NavigationStateLike }>
}

/**
 * 从导航状态取「最深当前路由」的名字。
 *
 * 通知跳转的目标是 **Tasks 栈**，而它可能是隐藏标签（例如用户正在日历）。
 * 只看 `getCurrentRoute()` 会漏掉隐藏的 Tasks 表单；这里从 root state 找 Tasks，
 * 再下钻它的当前路由，避免通知导航把隐藏草稿页 pop / 覆盖。
 */
export function currentRouteNameFromState(state: unknown): string | null {
  if (!isRecord(state)) return null
  const routes = state.routes
  if (!Array.isArray(routes) || routes.length === 0) return null
  const index = typeof state.index === 'number' && Number.isInteger(state.index) ? state.index : routes.length - 1
  const route = routes[index]
  if (!isRecord(route)) return null
  const nested = currentRouteNameFromState(route.state)
  if (nested) return nested
  return typeof route.name === 'string' ? route.name : null
}

/** 找根状态里的 Tasks 标签，返回其任务栈当前路由名（隐藏标签也算）。 */
export function taskStackCurrentRouteName(rootState: unknown): string | null {
  if (!isRecord(rootState) || !Array.isArray(rootState.routes)) return null
  const tasks = rootState.routes.find((route) => isRecord(route) && route.name === 'Tasks')
  if (!isRecord(tasks)) return null
  return currentRouteNameFromState(tasks.state)
}

function stateHasEditingRoute(state: unknown): boolean {
  if (!isRecord(state) || !Array.isArray(state.routes)) return false
  for (const route of state.routes) {
    if (!isRecord(route)) continue
    if (isTaskReminderEditingRoute(typeof route.name === 'string' ? route.name : null)) return true
    if (stateHasEditingRoute(route.state)) return true
  }
  return false
}

/**
 * 隐藏 Tasks 栈里**任何一层**有编辑页都算编辑中。
 *
 * 只检查「当前路由」不够：栈里可能压着 TaskForm，顶部却是别的页面；通知导航
 * 仍可能把下面的表单 pop 掉。这里保守扫描整条 Tasks 栈。
 */
export function taskStackHasEditingRoute(rootState: unknown): boolean {
  if (!isRecord(rootState) || !Array.isArray(rootState.routes)) return false
  const tasks = rootState.routes.find((route) => isRecord(route) && route.name === 'Tasks')
  if (!isRecord(tasks)) return false
  return stateHasEditingRoute(tasks.state)
}

/**
 * 只有「真的可能有未保存内容」时才算阻塞的路由。
 *
 * `TaskDetail` / `TaskReminder` 由页面自己登记**真实草稿**：干净的详情页、刚点完
 * 「测试提醒」但没改设置的提醒页不应该被静默挡下。其它表单 / 导入 / 核对页仍然
 * 按路由名保守暂缓。
 */
export const TASK_REMINDER_DRAFT_AWARE_ROUTES: readonly string[] = ['TaskDetail', 'TaskReminder', 'FocusTime', 'Today', 'LearningReport', 'TaskList']

export type NavigationDraftLookup = (routeKey: string | null | undefined) => boolean

function routeBlocksNotificationOpen(
  routeName: string | null | undefined,
  routeKey: string | null | undefined,
  isDraftDirty: NavigationDraftLookup,
): boolean {
  if (typeof routeName !== 'string') return false
  if (TASK_REMINDER_DRAFT_AWARE_ROUTES.includes(routeName)) {
    // 真正的导航状态一定带 key；没有 key 时保守暂缓，不能证明它是干净页面。
    return typeof routeKey !== 'string' || routeKey.length === 0 || isDraftDirty(routeKey)
  }
  return isTaskReminderEditingRoute(routeName)
}

export function currentRouteBlocksNotificationOpen(
  route: { name?: unknown; key?: unknown } | undefined,
  isDraftDirty: NavigationDraftLookup,
): boolean {
  if (!route) return false
  return routeBlocksNotificationOpen(
    typeof route.name === 'string' ? route.name : null,
    typeof route.key === 'string' ? route.key : null,
    isDraftDirty,
  )
}

/**
 * 隐藏 Tasks 栈里真正会阻塞通知导航的路由（含草稿感知的 TaskDetail / TaskReminder）。
 *
 * 与 `taskStackHasEditingRoute` 的区别：干净详情页不算阻塞；草稿页 / 表单 /
 * 导入核对页仍然阻塞。`taskStackHasEditingRoute` 保留为保守版本，供旧调用方 / 测试使用。
 */
export function taskStackHasBlockingRoute(
  rootState: unknown,
  isDraftDirty: NavigationDraftLookup,
): boolean {
  return taskStackBlockingRouteName(rootState, isDraftDirty) !== null
}

/** 第一个阻塞通知导航的路由名，供本机诊断显示「卡在哪一页」；没有则 `null`。 */
export function taskStackBlockingRouteName(
  rootState: unknown,
  isDraftDirty: NavigationDraftLookup,
): string | null {
  if (!isRecord(rootState) || !Array.isArray(rootState.routes)) return null
  const tasks = rootState.routes.find((route) => isRecord(route) && route.name === 'Tasks')
  if (!isRecord(tasks)) return null
  return stateBlockingRouteName(tasks.state, isDraftDirty)
}

function stateBlockingRouteName(state: unknown, isDraftDirty: NavigationDraftLookup): string | null {
  if (!isRecord(state) || !Array.isArray(state.routes)) return null
  for (const route of state.routes) {
    if (!isRecord(route)) continue
    const name = typeof route.name === 'string' ? route.name : null
    const key = typeof route.key === 'string' ? route.key : null
    if (routeBlocksNotificationOpen(name, key, isDraftDirty)) return name
    const nested = stateBlockingRouteName(route.state, isDraftDirty)
    if (nested) return nested
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export interface TaskReminderNotificationTapParse {
  tap: TaskReminderNotificationTap | null
  /** 拒绝原因码；只用于本机诊断，不包含通知正文。 */
  reason: string | null
}

/**
 * 严格解析，同时给出**安全的拒绝原因码**（用于本机诊断）。
 *
 * 原因码只说明「哪一步没通过」，不暴露标题 / 正文 / 原始 payload。
 */
export function parseTaskReminderNotificationTapDetailed(
  response: unknown,
  defaultActionIdentifier: string,
): TaskReminderNotificationTapParse {
  if (!isRecord(response)) return { tap: null, reason: 'bad-shape' }
  if (response.actionIdentifier !== defaultActionIdentifier) return { tap: null, reason: 'non-default-action' }
  const notification = response.notification
  if (!isRecord(notification)) return { tap: null, reason: 'bad-shape' }
  const request = notification.request
  if (!isRecord(request)) return { tap: null, reason: 'bad-shape' }
  const identifier = request.identifier
  if (typeof identifier !== 'string') return { tap: null, reason: 'bad-shape' }
  const content = request.content
  if (!isRecord(content)) return { tap: null, reason: 'bad-shape' }

  const owned: OwnedReminderNotification | null = parseOwnedReminderNotification({
    identifier,
    data: content.data,
  })
  if (!owned) return { tap: null, reason: 'not-owned' }
  const parsed = parseReminderNotificationPayload(content.data)
  if (!parsed.ok) return { tap: null, reason: 'not-owned' }

  const evidence =
    'test' in parsed ? `trigger:${parsed.payload.triggerAtMs}` : `fingerprint:${parsed.payload.fingerprint}`
  const deliveryDate =
    typeof notification.date === 'number' && Number.isFinite(notification.date) ? notification.date : null
  const actionIdentifier = String(response.actionIdentifier)
  const base = `${identifier}\u001f${evidence}\u001f${actionIdentifier}`
  return {
    tap: {
      taskId: owned.taskId,
      identifier,
      test: owned.test,
      title: 'test' in parsed ? null : parsed.payload.title,
      deliveryGeneration: parsed.payload.deliveryGeneration,
      deliveryDate,
      evidence,
      actionIdentifier,
      durableToken: deliveryDate === null ? null : `${base}\u001f${deliveryDate}`,
      memoryToken: base,
      token: deliveryDate === null ? base : `${base}\u001f${deliveryDate}`,
    },
    reason: null,
  }
}

/**
 * 把 Expo 的 `NotificationResponse` 严格解析成本应用的「打开某条任务」意图。
 * 返回 `null` 表示不是本模块可以消费的点击，调用方必须保持沉默。
 */
export function parseTaskReminderNotificationTap(
  response: unknown,
  defaultActionIdentifier: string,
): TaskReminderNotificationTap | null {
  return parseTaskReminderNotificationTapDetailed(response, defaultActionIdentifier).tap
}

const IDLE_STATE: TaskReminderNotificationState = {
  notice: null,
  editing: false,
  navigationReady: false,
}

export function createTaskReminderNotificationRouter(
  deps: TaskReminderNotificationRouterDeps,
): TaskReminderNotificationRouter {
  let state: TaskReminderNotificationState = { ...IDLE_STATE }
  const listeners = new Set<() => void>()
  let disposed = false
  let generation = 0
  let api: TaskReminderNotificationsApi | null = null
  let subscription: { remove: () => void } | null = null
  let eventSeq = 0
  let pendingTap: TaskReminderNotificationTap | null = null
  let retryTap: TaskReminderNotificationTap | null = null
  let coldReadFailed = false
  let queue: Promise<void> = Promise.resolve()
  let inFlightToken: string | null = null
  const memoryConsumed = new Set<string>()
  /** 本次进程内已成功导航、但回执可能还没写完的 token（防止重复点击重复跳）。 */
  const deliveredTokens = new Set<string>()
  const ephemeralSeen = new Map<string, number>()
  /** 内存去重也有上限，避免长时间运行 / 异常事件把 Set 撑大。 */
  const MAX_MEMORY_TOKENS = 128
  const ephemeralDedupeMs = deps.ephemeralDedupeMs ?? 5_000
  const now = deps.now ?? (() => Date.now())
  const getNotificationGeneration = deps.getNotificationGeneration ?? (() => 0)
  let backupBusy = false

  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 界面监听器自己的异常不能中断路由状态机。
      }
    }
  }

  function setState(patch: Partial<TaskReminderNotificationState>): void {
    state = { ...state, ...patch }
    emit()
  }

  function diagnostic(message: string): void {
    try {
      deps.onDiagnostic?.(message)
    } catch {
      // 诊断回调不能影响用户点击。
    }
  }

  function tapEvent(event: TaskReminderNotificationTapEvent): void {
    try {
      deps.onTapEvent?.(event)
    } catch {
      // 诊断回调不能影响用户点击。
    }
  }

  function isStale(seq: number): boolean {
    return disposed || seq !== eventSeq
  }

  function isStaleDelivery(tap: TaskReminderNotificationTap): boolean {
    return tap.deliveryGeneration !== getNotificationGeneration()
  }

  function isBlocked(): boolean {
    return backupBusy || deps.isEditing()
  }

  /** 只保留最近 128 个 token；被淘汰的旧 token 仍由持久回执兜底。 */
  function rememberBounded(set: Set<string>, token: string): void {
    if (set.has(token)) set.delete(token)
    set.add(token)
    while (set.size > MAX_MEMORY_TOKENS) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  function removeSubscription(): void {
    const current = subscription
    subscription = null
    if (current) {
      try {
        current.remove()
      } catch {
        // 已经 disposed；无需再次抛错。
      }
      tapEvent({ stage: 'listener', state: 'removed' })
    }
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function pendingNotice(tap: TaskReminderNotificationTap): TaskReminderNotificationNotice {
    return {
      kind: 'pending',
      taskId: tap.taskId,
      title: tap.title,
      blockedByEditing: deps.isEditing(),
      blockedByBackup: backupBusy,
      waitingForReady: !deps.isNavigationReady(),
    }
  }

  function setPending(tap: TaskReminderNotificationTap): void {
    pendingTap = tap
    setState({ notice: pendingNotice(tap) })
  }

  function clearActive(): void {
    pendingTap = null
    retryTap = null
    setState({ notice: null })
  }

  function fail(
    tap: TaskReminderNotificationTap,
    seq: number,
    message: string,
    code: string = 'failed',
  ): void {
    if (isStale(seq)) return
    pendingTap = tap
    retryTap = tap
    setState({ notice: { kind: 'error', message, canRetry: true } })
    tapEvent({ stage: 'failed', taskId: tap.taskId, reason: code })
  }

  function receiptOf(tap: TaskReminderNotificationTap): TaskReminderNotificationReceipt {
    return {
      version: 1,
      token: tap.durableToken ?? '',
      taskId: tap.taskId,
      identifier: tap.identifier,
      deliveryDate: tap.deliveryDate,
      evidence: tap.evidence,
      actionIdentifier: tap.actionIdentifier,
      consumedAt: new Date(now()).toISOString(),
    }
  }

  async function recordReceipt(
    tap: TaskReminderNotificationTap,
  ): Promise<{ ok: boolean; stored: boolean; reason: string | null }> {
    if (!tap.durableToken) return { ok: true, stored: false, reason: null }
    if (memoryConsumed.has(tap.durableToken)) return { ok: true, stored: false, reason: null }
    try {
      const result = await deps.receipts.recordConsumption(receiptOf(tap))
      if (!result.ok) return { ok: false, stored: false, reason: result.reason ?? '通知点击记录没有保存。' }
      rememberBounded(memoryConsumed, tap.durableToken)
      return { ok: true, stored: result.stored, reason: null }
    } catch (cause) {
      return { ok: false, stored: false, reason: `保存通知点击记录失败：${describe(cause)}` }
    }
  }

  async function rejectStaleGeneration(tap: TaskReminderNotificationTap, seq: number): Promise<void> {
    if (isStale(seq)) return
    const current = getNotificationGeneration()
    tapEvent({
      stage: 'stale-generation',
      taskId: tap.taskId,
      deliveredGeneration: tap.deliveryGeneration,
      currentGeneration: current,
    })
    const recorded = await recordReceipt(tap)
    if (isStale(seq)) return
    pendingTap = null
    retryTap = null
    setState({
      notice: {
        kind: 'warning',
        message: recorded.ok
          ? '这条提醒来自数据恢复之前，已经失效，不会再打开任务。如果任务还在，请从任务列表进入。'
          : `这条提醒来自数据恢复之前，已经失效；${recorded.reason ?? '点击记录保存失败，重启后可能再次提示。'}`,
      },
    })
  }

  async function processTap(tap: TaskReminderNotificationTap, seq: number): Promise<void> {
    if (isStale(seq)) return
    const token = tap.memoryToken
    inFlightToken = token
    try {
      await processTapInner(tap, seq)
    } finally {
      if (inFlightToken === token) inFlightToken = null
    }
  }

  async function processTapInner(tap: TaskReminderNotificationTap, seq: number): Promise<void> {
    if (isStale(seq)) return
    if (tap.durableToken && deliveredTokens.has(tap.durableToken)) {
      tapEvent({ stage: 'deduped', taskId: tap.taskId, reason: 'duplicate-delivery' })
      return
    }
    if (isStaleDelivery(tap)) {
      await rejectStaleGeneration(tap, seq)
      return
    }
    const editing = deps.isEditing()
    const navigationReady = deps.isNavigationReady()
    if (editing || backupBusy || !navigationReady) {
      tapEvent({
        stage: 'deferred',
        taskId: tap.taskId,
        editing,
        navigationReady,
      })
      setPending(tap)
      return
    }

    if (tap.durableToken && !memoryConsumed.has(tap.durableToken)) {
      let consumed
      try {
        consumed = await deps.receipts.hasConsumed(tap.durableToken)
      } catch (cause) {
        fail(tap, seq, `读取通知点击记录失败：${describe(cause)}`, 'receipt-failed')
        return
      }
      if (isStale(seq)) return
      if (!consumed.ok) {
        fail(tap, seq, consumed.reason ?? '读取通知点击记录失败。', 'receipt-failed')
        return
      }
      if (consumed.consumed) {
        tapEvent({ stage: 'deduped', taskId: tap.taskId, reason: 'already-consumed' })
        rememberBounded(memoryConsumed, tap.durableToken)
        if (pendingTap?.memoryToken === tap.memoryToken) {
          clearActive()
        } else if (state.notice?.kind === 'error') {
          // 上一次冷启动读取失败的 retry 发现它其实已经交付过：清掉过期的错误提示。
          setState({ notice: null })
        }
        return
      }
    }

    // 回执读取期间可能刚好完成了恢复：代次变化后绝不能再按旧任务 ID 打开。
    if (isStaleDelivery(tap)) {
      await rejectStaleGeneration(tap, seq)
      return
    }

    let lookup: TaskReminderTaskLookup
    try {
      lookup = await deps.lookupTaskFresh(tap.taskId)
    } catch (cause) {
      fail(tap, seq, `读取任务失败：${describe(cause)}`, 'lookup-failed')
      return
    }
    if (isStale(seq)) return
    if (isStaleDelivery(tap)) {
      await rejectStaleGeneration(tap, seq)
      return
    }
    if (!lookup.ok) {
      fail(tap, seq, lookup.reason ?? '读取任务失败，请重试。', 'lookup-failed')
      return
    }
    if (!lookup.task) {
      tapEvent({ stage: 'missing', taskId: tap.taskId })
      const recorded = await recordReceipt(tap)
      if (isStale(seq)) return
      tapEvent({
        stage: 'receipt',
        taskId: tap.taskId,
        ok: recorded.ok,
        stored: recorded.stored,
        reason: recorded.ok ? null : 'receipt-failed',
      })
      pendingTap = null
      retryTap = null
      setState({
        notice: {
          kind: 'missing',
          taskId: tap.taskId,
          title: tap.title,
          detail: recorded.ok
            ? '任务已不在本机，这条提醒不会再重复打开。'
            : `任务已不在本机；${recorded.reason ?? '点击记录保存失败，重启后可能再次提示。'}`,
        },
      })
      return
    }

    // 读取 / 回执检查期间用户可能打开了编辑页、备份 / 恢复开始了，或导航尚未就绪：
    // 继续等待，绝不抢跳。恢复完成时代次会变化，flush 时旧点击会被拒绝。
    if (isStaleDelivery(tap)) {
      await rejectStaleGeneration(tap, seq)
      return
    }
    const editingAfterLookup = deps.isEditing()
    const readyAfterLookup = deps.isNavigationReady()
    if (editingAfterLookup || backupBusy || !readyAfterLookup) {
      tapEvent({
        stage: 'deferred',
        taskId: tap.taskId,
        editing: editingAfterLookup,
        navigationReady: readyAfterLookup,
      })
      setPending(tap)
      return
    }
    // 导航调用前的最后一道检查：await 之间恢复可能已经提交。
    if (isStaleDelivery(tap)) {
      await rejectStaleGeneration(tap, seq)
      return
    }

    try {
      // 必须等导航层确认「目标任务详情真的成为当前路由」；静默失败的导航
      // 不能写持久回执，否则用户以后再也看不到这条提醒。
      await deps.navigateToTask(tap.taskId)
    } catch (cause) {
      fail(tap, seq, `打开任务详情失败：${describe(cause)}`, 'navigation-failed')
      return
    }
    if (isStale(seq)) return

    tapEvent({ stage: 'opened', taskId: tap.taskId })
    if (tap.durableToken) rememberBounded(deliveredTokens, tap.durableToken)
    pendingTap = null
    retryTap = null
    setState({ notice: null })

    const recorded = await recordReceipt(tap)
    if (isStale(seq)) return
    tapEvent({
      stage: 'receipt',
      taskId: tap.taskId,
      ok: recorded.ok,
      stored: recorded.stored,
      reason: recorded.ok ? null : 'receipt-failed',
    })
    if (!recorded.ok) {
      setState({
        notice: {
          kind: 'warning',
          message: `已打开任务详情，但${recorded.reason ?? '点击记录保存失败'}。重启后可能再次提示。`,
        },
      })
    }
  }

  function rememberEphemeral(tap: TaskReminderNotificationTap): boolean {
    if (tap.durableToken) return false
    const timestamp = now()
    for (const [key, seenAt] of ephemeralSeen) {
      if (timestamp - seenAt >= ephemeralDedupeMs) ephemeralSeen.delete(key)
    }
    const previous = ephemeralSeen.get(tap.memoryToken)
    if (previous !== undefined && timestamp - previous < ephemeralDedupeMs) return true
    ephemeralSeen.delete(tap.memoryToken)
    ephemeralSeen.set(tap.memoryToken, timestamp)
    while (ephemeralSeen.size > MAX_MEMORY_TOKENS) {
      const oldest = ephemeralSeen.keys().next().value
      if (oldest === undefined) break
      ephemeralSeen.delete(oldest)
    }
    return false
  }

  async function acceptTap(tap: TaskReminderNotificationTap, seq: number): Promise<void> {
    if (disposed || isStale(seq)) return
    if (tap.durableToken && (memoryConsumed.has(tap.durableToken) || deliveredTokens.has(tap.durableToken))) return
    if (rememberEphemeral(tap)) return

    pendingTap = tap
    retryTap = null
    await enqueue(() => processTap(tap, seq))
  }

  async function handleLive(raw: unknown): Promise<void> {
    if (disposed || !api) return
    tapEvent({ stage: 'received', source: 'listener' })
    // 必须先验证归属 / 动作，再推进 eventSeq：foreign response 不能取消正在处理的
    // 本应用有效点击。未拥有的 response 不改变本控制器任何状态。
    const parsed = parseTaskReminderNotificationTapDetailed(raw, api.DEFAULT_ACTION_IDENTIFIER)
    if (!parsed.tap) {
      tapEvent({ stage: 'rejected', source: 'listener', reason: parsed.reason ?? 'not-owned' })
      return
    }
    const tap = parsed.tap
    tapEvent({ stage: 'recognized', source: 'listener', taskId: tap.taskId, test: tap.test })
    eventSeq += 1
    await acceptTap(tap, eventSeq)
  }

  async function readColdAndAccept(run: number, seqBeforeRead: number): Promise<void> {
    if (!api) return
    let last: unknown
    try {
      last = await Promise.resolve(api.getLastNotificationResponse())
    } catch (cause) {
      // 旧冷启动的失败不能覆盖更新的 live 成功；事件序号在成功 / 失败路径都必须检查。
      if (disposed || run !== generation || seqBeforeRead !== eventSeq) return
      coldReadFailed = true
      tapEvent({ stage: 'cold-read', state: 'failed' })
      tapEvent({ stage: 'failed', taskId: null, reason: 'cold-read-failed' })
      setState({
        notice: {
          kind: 'error',
          message: `读取冷启动通知点击失败：${describe(cause)}`,
          canRetry: true,
        },
      })
      return
    }
    if (disposed || run !== generation || seqBeforeRead !== eventSeq) return
    coldReadFailed = false
    if (last == null) {
      tapEvent({ stage: 'cold-read', state: 'empty' })
      return
    }
    tapEvent({ stage: 'cold-read', state: 'ok' })
    tapEvent({ stage: 'received', source: 'cold' })
    const parsed = parseTaskReminderNotificationTapDetailed(last, api.DEFAULT_ACTION_IDENTIFIER)
    if (!parsed.tap) {
      tapEvent({ stage: 'rejected', source: 'cold', reason: parsed.reason ?? 'not-owned' })
      return
    }
    const tap = parsed.tap
    tapEvent({ stage: 'recognized', source: 'cold', taskId: tap.taskId, test: tap.test })
    eventSeq += 1
    await acceptTap(tap, eventSeq)
  }

  async function start(): Promise<void> {
    if (disposed) return
    generation += 1
    // 新 start 让上一代尚未完成的异步读 / 导航 / 排队点击全部失效。
    eventSeq += 1
    pendingTap = null
    retryTap = null
    inFlightToken = null
    const run = generation
    removeSubscription()
    try {
      const loaded = await deps.loadNotifications()
      if (disposed || run !== generation) return
      api = loaded
      // 先注册监听，再读冷启动 last；两者重叠时由 token 去重。
      subscription = loaded.addNotificationResponseReceivedListener((response) => {
        void handleLive(response)
      })
      tapEvent({ stage: 'listener', state: 'registered' })
      await readColdAndAccept(run, eventSeq)
    } catch (cause) {
      if (disposed || run !== generation) return
      coldReadFailed = true
      tapEvent({ stage: 'listener', state: 'failed' })
      tapEvent({ stage: 'failed', taskId: null, reason: 'native-unavailable' })
      setState({
        notice: {
          kind: 'error',
          message: `本机通知模块暂时不可用：${describe(cause)}`,
          canRetry: true,
        },
      })
    }
  }

  function flushPending(): void {
    if (!pendingTap || isBlocked() || !deps.isNavigationReady()) {
      if (pendingTap) setState({ notice: pendingNotice(pendingTap) })
      return
    }
    const tap = pendingTap
    if (inFlightToken === tap.memoryToken) return
    pendingTap = null
    // 捕获入队时的序号：排队期间新 live / dismiss / start 必须让这个旧闭包失效。
    const seq = eventSeq
    void enqueue(() => processTap(tap, seq))
  }

  function markNavigationReady(): void {
    if (disposed) return
    setState({ navigationReady: true })
    flushPending()
  }

  function setEditing(editing: boolean): void {
    if (disposed) return
    setState({ editing })
    if (!editing) flushPending()
    else if (pendingTap) setState({ notice: pendingNotice(pendingTap) })
  }

  function setBackupBusy(busy: boolean): void {
    if (disposed || backupBusy === busy) return
    backupBusy = busy
    if (pendingTap) setState({ notice: pendingNotice(pendingTap) })
    if (!busy) flushPending()
  }

  async function retry(): Promise<void> {
    if (disposed) return
    if (!api) {
      // 原生模块在首次加载时失败：重试要重新走动态 import + 注册 + 冷启动读取。
      await start()
      return
    }
    if (retryTap) {
      const tap = retryTap
      retryTap = null
      eventSeq += 1
      const seq = eventSeq
      await enqueue(() => processTap(tap, seq))
      return
    }
    if (coldReadFailed) {
      coldReadFailed = false
      const run = generation
      await readColdAndAccept(run, eventSeq)
    }
  }

  function dismiss(): void {
    if (disposed) return
    // 让排队中 / 正在 await 数据库的旧点击失效，避免用户关掉提示后仍被带去详情。
    eventSeq += 1
    pendingTap = null
    retryTap = null
    coldReadFailed = false
    setState({ notice: null })
  }

  function openTaskList(): boolean {
    if (disposed || isBlocked() || !deps.isNavigationReady()) return false
    try {
      deps.navigateToTaskList()
    } catch (cause) {
      diagnostic(`打开任务列表失败：${describe(cause)}`)
      return false
    }
    setState({ notice: null })
    return true
  }

  function dispose(): void {
    disposed = true
    generation += 1
    pendingTap = null
    retryTap = null
    ephemeralSeen.clear()
    memoryConsumed.clear()
    deliveredTokens.clear()
    removeSubscription()
    api = null
    listeners.clear()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start,
    markNavigationReady,
    setEditing,
    setBackupBusy,
    retry,
    dismiss,
    openTaskList,
    dispose,
  }
}
