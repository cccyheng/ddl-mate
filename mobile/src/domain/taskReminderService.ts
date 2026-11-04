/**
 * 任务提醒的**中央串行服务**。
 *
 * 职责：
 * - 任何对账（启动、回到前台、任务改动、显式保存、手动重试）都从**最新 DB 状态**读任务与规则，
 *   绝不接受调用方传来的旧任务快照；
 * - 所有对账 / 保存 / 测试提醒都排进**同一条串行队列**，一次只执行一个，避免并发覆盖；
 * - 只取消 / 替换本应用精确命名空间里的通知；绝不调用任何全量取消接口；
 * - 列表读取失败 = 状态未知，**不**把它当成「一条通知都没有」；
 * - 取消失败就不排新通知；新建失败如实返回，供界面显示「设置已保存，提醒尚未安排」。
 *
 * 这个服务不 import React，也不 import expo-notifications：OS 能力通过注入的
 * {@link ReminderNotificationPort} 调用，纯逻辑可以在 node 测试里用假端口逐条验证。
 */

import {
  MAX_ENABLED_TASK_REMINDERS,
  TASK_REMINDER_TEST_DELAY_MS,
  buildTestReminderNotificationPayload,
  canScheduleReminder,
  canonicalReminderTriggerMs,
  evaluateTaskReminderEligibility,
  parseOwnedReminderNotification,
  planTaskReminderReconciliation,
  reminderNotificationId,
  reminderTriggerAt,
  taskReminderFingerprint,
  testReminderNotificationId,
  type OwnedReminderNotification,
  type PendingReminderNotificationInput,
  type ReminderBlockedEntry,
  type ReminderInactiveCode,
  type ReminderLeadMinutes,
  type ReminderPermissionState,
  type ReminderScheduleRequest,
  type ReminderStoredEntry,
  type ReminderTaskLike,
  type TaskReminderIntent,
} from './taskReminder'
import type { ClassReminderPayload } from './classReminder'
import type { FocusReminderPayload } from './focusReminder'
import type {
  SaveTaskReminderInput,
  SaveTaskReminderResult,
  TaskReminderListResult,
  TaskReminderLoadResult,
} from './taskReminderRepository'

/* --------------------------------- 端口 --------------------------------- */

export interface ReminderScheduleContent {
  identifier: string
  title: string
  body: string
  triggerAtMs: number
  data: ReminderScheduleRequest['data'] | ReturnType<typeof buildTestReminderNotificationPayload> | ClassReminderPayload | FocusReminderPayload
}

export interface ReminderNotificationPort {
  /** 读取当前权限；原生模块不可用 / 读取失败时返回 `unavailable`，绝不抛出到 App 顶层。 */
  getPermission: () => Promise<ReminderPermissionState>
  /** 只有用户显式开启 / 测试提醒时才调用；启动和刷新**绝不**弹权限。 */
  requestPermission: () => Promise<ReminderPermissionState>
  /** 读系统里所有已排队通知（包括别的 App / 本 App 其它模块的），由服务自行过滤。 */
  listPending: () => Promise<readonly PendingReminderNotificationInput[]>
  schedule: (content: ReminderScheduleContent) => Promise<void>
  /** 只取消一个精确 ID。 */
  cancel: (identifier: string) => Promise<void>
}

export interface TaskReminderServiceDeps {
  port: ReminderNotificationPort
  /** 最新任务（只读；必须来自 DB，不是界面快照）。 */
  readTasks: () => Promise<ReminderTaskLike[]>
  /** 最新规则（只读；失败必须返回 `ok: false`，不能当成空列表）。 */
  readEntries: () => Promise<TaskReminderListResult>
  /** 某条任务当前的规则（只读）。 */
  loadReminder: (taskId: number) => Promise<TaskReminderLoadResult>
  /** 某条任务当前详情（只读）；不存在返回 `null`。 */
  getTask: (taskId: number) => Promise<ReminderTaskLike | null>
  /** 走 store 的写队列保存规则。 */
  saveReminder: (input: SaveTaskReminderInput) => Promise<SaveTaskReminderResult>
  /** 精确删除孤儿规则键（任务已不存在时）。 */
  removeReminder: (taskId: number) => Promise<unknown>
  now?: () => Date
  maxEnabled?: number
  /** 本机通知路由代次；排程时写进载荷，恢复后旧通知会被拒绝。 */
  getNotificationGeneration?: () => number
}

/* --------------------------------- 类型 --------------------------------- */

export interface ReminderOperationFailure {
  taskId: number
  action: 'schedule' | 'cancel' | 'replace' | 'orphan-cleanup'
  identifier: string
  message: string
}

export interface TaskReminderReconcileReport {
  ok: boolean
  reason: string | null
  atMs: number
  permission: ReminderPermissionState
  /** 真正在系统里**确认**排好的任务 ID（列表回读匹配指纹与时刻）。 */
  scheduledTaskIds: number[]
  /** 已调用 OS 新建、但列表回读没确认到的任务 ID（不谎报「已安排」）。 */
  acceptedTaskIds: number[]
  cancelledIdentifiers: string[]
  unchangedTaskIds: number[]
  blocked: ReminderBlockedEntry[]
  failures: ReminderOperationFailure[]
  orphanTaskIds: number[]
  /** 列表回读是否成功；失败时排队状态是「未知」，不能当成空。 */
  verified: boolean
  foreignPendingCount: number
}

export type ReminderOsState = 'queued' | 'stale' | 'not-queued' | 'unknown' | 'off'

export interface PendingReadResult {
  ok: boolean
  pending: OwnedReminderNotification[]
  foreignCount: number
  reason: string | null
}

export interface TaskReminderInspection {
  taskId: number
  task: ReminderTaskLike | null
  intentState: 'missing' | 'valid' | 'corrupt' | 'future' | 'task-missing'
  intent: TaskReminderIntent | null
  revision: number
  readReason: string | null
  permission: ReminderPermissionState
  eligibility: ReturnType<typeof evaluateTaskReminderEligibility>
  osState: ReminderOsState
  /** 系统里实际那条（只在 `queued` / `stale` 时有值）。 */
  pending: OwnedReminderNotification | null
  pendingReason: string | null
  lastError: string | null
  atMs: number
}

export interface SaveTaskReminderServiceOutcome {
  save: SaveTaskReminderResult
  permission: ReminderPermissionState
  report: TaskReminderReconcileReport | null
  inspection: TaskReminderInspection | null
  /** 规则已经保存，但 OS 没有确认排好（界面必须说「设置已保存，提醒尚未安排」）。 */
  savedButNotScheduled: boolean
  reason: string | null
}

export interface TestReminderOutcome {
  ok: boolean
  queued: boolean
  verified: boolean
  identifier: string | null
  triggerAtMs: number | null
  permission: ReminderPermissionState
  reason: string | null
}

export interface TaskReminderServiceSnapshot {
  permission: ReminderPermissionState
  lastError: string | null
  lastReconciledAtMs: number | null
  lastReport: TaskReminderReconcileReport | null
  busy: boolean
}

export interface OwnedNotificationCancelReport {
  ok: boolean
  cancelled: string[]
  failures: Array<{ identifier: string; reason: string }>
  reason: string | null
}

export interface TaskReminderService {
  reconcile: (reason: string) => Promise<TaskReminderReconcileReport>
  /** 任务写库成功后调用；同步失败只记录，不影响任务保存结果。 */
  notifyTaskChange: (reason: string) => Promise<TaskReminderReconcileReport | null>
  inspectTask: (taskId: number) => Promise<TaskReminderInspection>
  saveSettings: (input: SaveTaskReminderInput) => Promise<SaveTaskReminderServiceOutcome>
  testReminder: (taskId: number) => Promise<TestReminderOutcome>
  getSnapshot: () => TaskReminderServiceSnapshot
  subscribe: (listener: () => void) => () => void
  /**
   * 备份 / 恢复期间同步暂停对账：置位后等当前这次对账做完（barrier），
   * 之后排队的对账会在真正操作 OS 之前直接放弃，因此不会在恢复提交后再排旧提醒。
   */
  suspendForBackup: (reason: string) => Promise<void>
  /** 取消暂停（备份成功、或恢复失败且旧通知已确认取消后）。 */
  resumeAfterBackup: () => void
  /**
   * 只取消**本应用精确命名空间**里的排队通知（正式提醒 + 测试提醒），
   * 绝不碰别的 App 的通知。不做数据库写入。
   */
  cancelAllOwnedNotifications: (reason: string) => Promise<OwnedNotificationCancelReport>
  isBackupSuspended: () => boolean
}

/* --------------------------------- 工具 --------------------------------- */

const UNAVAILABLE_PERMISSION: ReminderPermissionState = {
  status: 'unavailable',
  canAskAgain: false,
  detail: '这台设备上暂时不能读取本地通知权限。',
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

async function readPermissionSafely(port: ReminderNotificationPort): Promise<ReminderPermissionState> {
  try {
    return await port.getPermission()
  } catch (cause) {
    return { status: 'unavailable', canAskAgain: false, detail: errorMessage(cause) }
  }
}

async function requestPermissionSafely(port: ReminderNotificationPort): Promise<ReminderPermissionState> {
  try {
    return await port.requestPermission()
  } catch (cause) {
    return { status: 'unavailable', canAskAgain: false, detail: errorMessage(cause) }
  }
}

function parsePending(raw: readonly PendingReminderNotificationInput[]): PendingReadResult {
  const pending: OwnedReminderNotification[] = []
  let foreignCount = 0
  for (const item of raw) {
    const parsed = parseOwnedReminderNotification(item)
    if (parsed) pending.push(parsed)
    else foreignCount += 1
  }
  return { ok: true, pending, foreignCount, reason: null }
}

async function readPendingSafely(port: ReminderNotificationPort): Promise<PendingReadResult> {
  try {
    const raw = await port.listPending()
    return parsePending(raw)
  } catch (cause) {
    return { ok: false, pending: [], foreignCount: 0, reason: `读取系统已排队通知失败：${errorMessage(cause)}` }
  }
}

function verifyScheduled(
  pending: OwnedReminderNotification[],
  requests: readonly ReminderScheduleRequest[],
): number[] {
  const byId = new Map(pending.map((item) => [item.identifier, item]))
  const verified: number[] = []
  for (const request of requests) {
    const actual = byId.get(request.identifier)
    if (!actual || actual.test) continue
    if (actual.fingerprint !== request.data.fingerprint) continue
    if (actual.triggerAtMs === null) continue
    if (actual.triggerAtMs !== request.triggerAtMs) continue
    verified.push(request.taskId)
  }
  return verified.sort((left, right) => left - right)
}

/* --------------------------------- 服务 --------------------------------- */

export function createTaskReminderService(deps: TaskReminderServiceDeps): TaskReminderService {
  const now = deps.now ?? (() => new Date())
  const maxEnabled = deps.maxEnabled ?? MAX_ENABLED_TASK_REMINDERS
  const getNotificationGeneration = deps.getNotificationGeneration ?? (() => 0)
  const listeners = new Set<() => void>()
  let queue: Promise<unknown> = Promise.resolve()
  let lastError: string | null = null
  let lastReconciledAtMs: number | null = null
  let lastReport: TaskReminderReconcileReport | null = null
  let busyCount = 0
  let permissionCache: ReminderPermissionState = { status: 'undetermined', canAskAgain: true, detail: null }
  /** 备份 / 恢复期间的同步闸门：置位后不再安排 / 替换任何通知。 */
  let backupSuspended = false
  let backupSuspendReason: string | null = null
  /** 暂停期间被丢弃的对账请求；恢复时必须补一次最新 DB 对账。 */
  let pendingResumeReconcile = false

  function snapshot(): TaskReminderServiceSnapshot {
    return {
      permission: permissionCache,
      lastError,
      lastReconciledAtMs,
      lastReport,
      busy: busyCount > 0,
    }
  }

  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // 订阅方自己的异常不能打断对账 / 保存。
      }
    }
  }

  function setLastError(value: string | null): void {
    lastError = value
    emit()
  }

  function runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      busyCount += 1
      emit()
      try {
        return await action()
      } finally {
        busyCount = Math.max(0, busyCount - 1)
        emit()
      }
    }
    const chained = queue.then(run, run)
    queue = chained.then(
      () => undefined,
      () => undefined,
    )
    return chained
  }

  async function readStateFresh(): Promise<
    | { ok: true; tasks: ReminderTaskLike[]; entries: ReminderStoredEntry[] }
    | { ok: false; reason: string; tasks: ReminderTaskLike[]; entries: ReminderStoredEntry[] }
  > {
    let tasks: ReminderTaskLike[]
    try {
      tasks = await deps.readTasks()
    } catch (cause) {
      return { ok: false, reason: `读取任务失败：${errorMessage(cause)}`, tasks: [], entries: [] }
    }
    let entries: TaskReminderListResult
    try {
      entries = await deps.readEntries()
    } catch (cause) {
      return { ok: false, reason: `读取提醒设置失败：${errorMessage(cause)}`, tasks, entries: [] }
    }
    if (!entries.ok) return { ok: false, reason: entries.reason, tasks, entries: [] }
    return { ok: true, tasks, entries: entries.entries }
  }

  /**
   * 轮到真正调用 OS 之前，用**此刻的最新任务**再校验一次。
   *
   * 对账开始时会读一次最新任务，但权限 / 系统列表 / 取消 / 任务写入都可能在等待期间
   * 改变状态；如果直接排一条已经过期或已经改期的通知，iOS / Android 可能把它当成
   * 「立即补发」。因此每次 schedule / replace 前都：
   * 1. 重新读任务；
   * 2. 重新算可安排性与绝对触发时刻；
   * 3. 确认任务标题 / DDL / 触发时刻仍与计划一致；
   * 4. 把**实际排程时刻**写进内容数据，供回读 `timeInterval.seconds` 时重建绝对时间。
   */
  async function revalidateSchedule(
    request: ReminderScheduleRequest,
  ): Promise<{ ok: true; request: ReminderScheduleRequest } | { ok: false; reason: string }> {
    const before = now().getTime()
    if (!Number.isFinite(request.triggerAtMs) || request.triggerAtMs <= before) {
      return { ok: false, reason: '提醒时刻在等待系统响应时已经过去，没有安排。' }
    }
    let task: ReminderTaskLike | null
    try {
      task = await deps.getTask(request.taskId)
    } catch (cause) {
      return { ok: false, reason: `安排提醒前读取任务失败：${errorMessage(cause)}` }
    }
    if (!task) return { ok: false, reason: '任务已经不在本机，没有安排提醒。' }
    if (task.deadline !== request.data.deadline || task.title !== request.data.title) {
      return { ok: false, reason: '任务在等待系统响应时发生了变化，没有安排旧提醒；下次对账会按新状态安排。' }
    }
    const checkAt = now().getTime()
    const eligibility = evaluateTaskReminderEligibility(task, request.data.leadMinutes, checkAt)
    if (!eligibility.eligible) {
      return { ok: false, reason: eligibility.reason ?? '任务当前不再适合安排提醒。' }
    }
    if (eligibility.triggerAtMs !== request.triggerAtMs) {
      return { ok: false, reason: '任务的提醒时刻已经变化，没有安排旧提醒；下次对账会按新状态安排。' }
    }
    // 最后一次检查：优先保证「绝不排已经过去的时刻」。
    const lastCheckMs = now().getTime()
    if (request.triggerAtMs <= lastCheckMs) {
      return { ok: false, reason: '提醒时刻在等待中已经过去，没有安排。' }
    }
    return { ok: true, request }
  }

  function suspendedReport(reason: string): TaskReminderReconcileReport {
    pendingResumeReconcile = true
    const atMs = now().getTime()
    const report: TaskReminderReconcileReport = {
      ok: false,
      reason: backupSuspendReason ?? `备份 / 恢复进行中（${reason}），提醒对账已暂停。`,
      atMs,
      permission: permissionCache,
      scheduledTaskIds: [],
      acceptedTaskIds: [],
      cancelledIdentifiers: [],
      unchangedTaskIds: [],
      blocked: [],
      failures: [],
      orphanTaskIds: [],
      verified: false,
      foreignPendingCount: 0,
    }
    lastReport = report
    lastReconciledAtMs = atMs
    return report
  }

  async function reconcileInner(reason: string): Promise<TaskReminderReconcileReport> {
    if (backupSuspended) return suspendedReport(reason)
    const atMs = now().getTime()
    const permission = await readPermissionSafely(deps.port)
    permissionCache = permission
    const fresh = await readStateFresh()
    if (!fresh.ok) {
      const report: TaskReminderReconcileReport = {
        ok: false,
        reason: fresh.reason,
        atMs,
        permission,
        scheduledTaskIds: [],
        acceptedTaskIds: [],
        cancelledIdentifiers: [],
        unchangedTaskIds: [],
        blocked: [],
        failures: [],
        orphanTaskIds: [],
        verified: false,
        foreignPendingCount: 0,
      }
      lastReport = report
      lastReconciledAtMs = atMs
      setLastError(fresh.reason)
      return report
    }

    const pending = await readPendingSafely(deps.port)
    if (!pending.ok) {
      const report: TaskReminderReconcileReport = {
        ok: false,
        reason: pending.reason,
        atMs,
        permission,
        scheduledTaskIds: [],
        acceptedTaskIds: [],
        cancelledIdentifiers: [],
        unchangedTaskIds: [],
        blocked: [],
        failures: [],
        orphanTaskIds: [],
        verified: false,
        foreignPendingCount: 0,
      }
      lastReport = report
      lastReconciledAtMs = atMs
      setLastError(pending.reason)
      return report
    }

    const plan = planTaskReminderReconciliation({
      tasks: fresh.tasks,
      entries: fresh.entries,
      pending: pending.pending,
      permission,
      nowMs: atMs,
      maxEnabled,
      deliveryGeneration: getNotificationGeneration(),
    })

    const failures: ReminderOperationFailure[] = []
    const cancelledIdentifiers: string[] = []
    const acceptedRequests: ReminderScheduleRequest[] = []

    for (const taskId of plan.orphanTaskIds) {
      try {
        await deps.removeReminder(taskId)
      } catch (cause) {
        failures.push({
          taskId,
          action: 'orphan-cleanup',
          identifier: reminderNotificationId(taskId) ?? '',
          message: `清理已删除任务的提醒设置失败：${errorMessage(cause)}`,
        })
      }
    }

    for (const operation of plan.operations) {
      if (operation.kind === 'cancel') {
        try {
          await deps.port.cancel(operation.identifier)
          cancelledIdentifiers.push(operation.identifier)
        } catch (cause) {
          failures.push({
            taskId: operation.taskId,
            action: 'cancel',
            identifier: operation.identifier,
            message: `取消系统提醒失败：${errorMessage(cause)}`,
          })
        }
        continue
      }
      if (operation.kind === 'replace') {
        try {
          await deps.port.cancel(operation.identifier)
          cancelledIdentifiers.push(operation.identifier)
        } catch (cause) {
          // 旧通知没取消成功就绝不排新的，避免同一任务出现两条。
          failures.push({
            taskId: operation.taskId,
            action: 'replace',
            identifier: operation.identifier,
            message: `替换提醒前取消失败，新的提醒没有安排：${errorMessage(cause)}`,
          })
          continue
        }
        const revalidated = await revalidateSchedule(operation.request)
        if (!revalidated.ok) {
          failures.push({
            taskId: operation.taskId,
            action: 'replace',
            identifier: operation.identifier,
            message: revalidated.reason,
          })
          continue
        }
        try {
          await deps.port.schedule(revalidated.request)
          acceptedRequests.push(revalidated.request)
        } catch (cause) {
          failures.push({
            taskId: operation.taskId,
            action: 'schedule',
            identifier: operation.identifier,
            message: `安排提醒失败：${errorMessage(cause)}`,
          })
        }
        continue
      }
      const revalidated = await revalidateSchedule(operation.request)
      if (!revalidated.ok) {
        failures.push({
          taskId: operation.taskId,
          action: 'schedule',
          identifier: operation.request.identifier,
          message: revalidated.reason,
        })
        continue
      }
      try {
        await deps.port.schedule(revalidated.request)
        acceptedRequests.push(revalidated.request)
      } catch (cause) {
        failures.push({
          taskId: operation.taskId,
          action: 'schedule',
          identifier: operation.request.identifier,
          message: `安排提醒失败：${errorMessage(cause)}`,
        })
      }
    }

    let verified = acceptedRequests.length === 0
    let scheduledTaskIds: number[] = []
    let finalPendingReason: string | null = null
    if (acceptedRequests.length > 0) {
      const after = await readPendingSafely(deps.port)
      verified = after.ok
      if (after.ok) {
        scheduledTaskIds = verifyScheduled(after.pending, acceptedRequests)
      } else {
        finalPendingReason = after.reason
      }
    }

    const firstFailure = failures[0]?.message ?? finalPendingReason
    lastReport = {
      ok: failures.length === 0 && verified,
      reason: firstFailure,
      atMs,
      permission,
      scheduledTaskIds,
      acceptedTaskIds: acceptedRequests.map((request) => request.taskId).sort((left, right) => left - right),
      cancelledIdentifiers,
      unchangedTaskIds: plan.unchanged.map((item) => item.taskId),
      blocked: plan.blocked,
      failures,
      orphanTaskIds: plan.orphanTaskIds,
      verified,
      foreignPendingCount: pending.foreignCount,
    }
    lastReconciledAtMs = atMs
    setLastError(firstFailure)
    if (reason.length > 0) {
      // 只用于调试语义；报告本身已经包含原因，不把 reason 写进用户可见文案。
    }
    return lastReport
  }

  async function inspectTaskInner(taskId: number): Promise<TaskReminderInspection> {
    const atMs = now().getTime()
    const permission = await readPermissionSafely(deps.port)
    permissionCache = permission
    const task = await deps.getTask(taskId).catch(() => null)
    let loaded: TaskReminderLoadResult
    try {
      loaded = await deps.loadReminder(taskId)
    } catch (cause) {
      // 保存已经提交、但随后规则读不出来：这里必须变成「读回失败」，
      // 不能把异常抛回调用方，否则界面会把已提交的保存说成失败。
      loaded = { ok: false, code: 'READ_FAILED', reason: `读取提醒设置失败：${errorMessage(cause)}`, rawExcerpt: null }
    }
    const pending = await readPendingSafely(deps.port)
    const identifier = reminderNotificationId(taskId)

    let intentState: TaskReminderInspection['intentState'] = 'missing'
    let intent: TaskReminderIntent | null = null
    let revision = 0
    let readReason: string | null = null
    if (!loaded.ok) {
      if (loaded.code === 'PARENT_MISSING' || loaded.code === 'INVALID_TASK') {
        intentState = 'task-missing'
      } else if (loaded.code === 'FUTURE') {
        intentState = 'future'
      } else {
        intentState = 'corrupt'
      }
      readReason = loaded.reason
    } else if (loaded.state === 'valid' && loaded.intent) {
      intentState = 'valid'
      intent = loaded.intent
      revision = loaded.revision
    }

    const lead = intent?.leadMinutes ?? 30
    const eligibility = evaluateTaskReminderEligibility(task, lead, atMs)
    let osState: ReminderOsState = 'off'
    let matched: OwnedReminderNotification | null = null
    let pendingReason: string | null = pending.reason
    const own = pending.ok && identifier ? pending.pending.find((item) => item.identifier === identifier && !item.test) ?? null : null
    if (!pending.ok) {
      osState = 'unknown'
    } else if (!intent || !intent.enabled) {
      osState = own ? 'stale' : 'off'
      matched = own
      if (own) pendingReason = '系统里还排着一条已经关闭的提醒，重试对账可以取消它。'
    } else if (own) {
      matched = own
      const expectedFingerprint =
        task && eligibility.eligible && eligibility.triggerAtMs !== null
          ? taskReminderFingerprint({
              taskId,
              deadline: String(task.deadline),
              leadMinutes: intent.leadMinutes,
              title: task.title,
              triggerAtMs: eligibility.triggerAtMs,
            })
          : null
      const same =
        expectedFingerprint !== null &&
        own.fingerprint === expectedFingerprint &&
        own.triggerAtMs !== null &&
        eligibility.triggerAtMs !== null &&
        own.triggerAtMs === eligibility.triggerAtMs
      osState = same && canScheduleReminder(permission) ? 'queued' : 'stale'
      if (!same) pendingReason = '系统里排着的提醒与当前任务不一致，重试对账会替换它。'
    } else {
      osState = 'not-queued'
      if (!eligibility.eligible) pendingReason = eligibility.reason
      else if (!canScheduleReminder(permission)) pendingReason = '提醒设置已保存，但通知权限未允许，尚未安排。'
    }

    return {
      taskId,
      task,
      intentState,
      intent,
      revision,
      readReason,
      permission,
      eligibility,
      osState,
      pending: matched,
      pendingReason,
      lastError,
      atMs,
    }
  }

  async function saveSettingsInner(input: SaveTaskReminderInput): Promise<SaveTaskReminderServiceOutcome> {
    const save = await deps.saveReminder(input)
    let permission = await readPermissionSafely(deps.port)
    if (save.committed && input.enabled && permission.status === 'undetermined' && permission.canAskAgain) {
      permission = await requestPermissionSafely(deps.port)
    }
    permissionCache = permission
    let report: TaskReminderReconcileReport | null = null
    let reconcileError: string | null = null
    if (save.committed) {
      try {
        report = await reconcileInner('settings-save')
      } catch (cause) {
        reconcileError = `设置已保存，但提醒同步失败：${errorMessage(cause)}`
      }
    }
    let inspection: TaskReminderInspection | null = null
    let inspectionError: string | null = null
    try {
      inspection = await inspectTaskInner(input.taskId)
    } catch (cause) {
      inspectionError = `设置已保存，但读取提醒状态失败：${errorMessage(cause)}`
    }

    let savedButNotScheduled = false
    let reason: string | null = null
    if (!save.ok) {
      reason = save.reason
    } else if (inspection) {
      const scheduled =
        inspection.osState === 'queued' &&
        inspection.intent !== null &&
        inspection.intent.enabled
      savedButNotScheduled = save.committed && input.enabled && !scheduled
      if (savedButNotScheduled) {
        reason =
          report?.reason ??
          inspection.pendingReason ??
          (inspection.permission.status === 'denied'
            ? '设置已保存，但通知权限未允许，提醒还没有安排。'
            : '设置已保存，提醒尚未安排，可以重试。')
      } else if (report && report.failures.length > 0) {
        // 关闭 / 替换时取消失败也要如实显示，不能因为规则保存成功就说一切正常。
        reason = report.reason ?? '设置已保存，但系统里的通知操作失败，可以重试。'
      } else if (!input.enabled && inspection.osState === 'stale') {
        reason = inspection.pendingReason ?? '提醒已关闭，但系统里那条通知还没有确认取消。'
      } else if (!input.enabled && inspection.osState !== 'off') {
        // 规则已经关闭，但系统列表读不出来 / 状态未知：不能声称已经取消。
        reason =
          report?.reason ??
          inspection.pendingReason ??
          '提醒已关闭，但暂时无法确认系统里的通知是否已取消，可以重试。'
      }
    } else {
      // 规则已经提交，但状态读不回来：这是「读回失败」，不是「保存失败」。
      savedButNotScheduled = save.committed && input.enabled
      reason =
        reconcileError ??
        inspectionError ??
        (input.enabled
          ? '设置已保存，但暂时读不到提醒状态；提醒可能尚未安排，可以重试。'
          : '设置已保存，但暂时读不到提醒状态；请重试确认系统通知是否已取消。')
    }
    if (save.committed && reconcileError && reason === null) reason = reconcileError
    if (save.committed && save.readbackError) {
      const readbackReason = `设置已保存，但读回提醒设置失败：${save.readbackError}`
      reason = reason ? `${reason} ${readbackReason}` : readbackReason
    }
    return { save, permission, report, inspection, savedButNotScheduled, reason }
  }

  async function testReminderInner(taskId: number): Promise<TestReminderOutcome> {
    const task = await deps.getTask(taskId).catch(() => null)
    let permission = await readPermissionSafely(deps.port)
    if (!task) {
      permissionCache = permission
      return {
        ok: false,
        queued: false,
        verified: false,
        identifier: null,
        triggerAtMs: null,
        permission,
        reason: '这条任务已经不在本机了，无法测试提醒。',
      }
    }
    if (permission.status === 'undetermined' && permission.canAskAgain) {
      permission = await requestPermissionSafely(deps.port)
    }
    permissionCache = permission
    if (!canScheduleReminder(permission)) {
      return {
        ok: false,
        queued: false,
        verified: false,
        identifier: testReminderNotificationId(taskId),
        triggerAtMs: null,
        permission,
        reason:
          permission.status === 'denied'
            ? '通知权限未允许，无法测试提醒。可以到手机设置里允许通知后再试。'
            : permission.detail ?? '这台设备上暂时不能使用本地通知。',
      }
    }
    const identifier = testReminderNotificationId(taskId)
    if (!identifier) {
      return {
        ok: false,
        queued: false,
        verified: false,
        identifier: null,
        triggerAtMs: null,
        permission,
        reason: '任务编号不合法，无法测试提醒。',
      }
    }
    const previous = await readPendingSafely(deps.port)
    if (!previous.ok) {
      return {
        ok: false,
        queued: false,
        verified: false,
        identifier,
        triggerAtMs: null,
        permission,
        reason: previous.reason ?? '读取系统通知失败，无法安全替换上一次测试提醒。',
      }
    }
    // 只替换**测试提醒**自己的那条；不碰任务提醒，也不碰别的通知。
    const existingTest = previous.pending.find((item) => item.test && item.identifier === identifier)
    if (existingTest) {
      try {
        await deps.port.cancel(identifier)
      } catch (cause) {
        return {
          ok: false,
          queued: false,
          verified: false,
          identifier,
          triggerAtMs: null,
          permission,
          reason: `上一次测试提醒还没取消成功，这次没有再安排：${errorMessage(cause)}`,
        }
      }
    }
    const triggerAtMs = canonicalReminderTriggerMs(now().getTime() + TASK_REMINDER_TEST_DELAY_MS)
    const data = buildTestReminderNotificationPayload(taskId, triggerAtMs, getNotificationGeneration())
    try {
      await deps.port.schedule({
        identifier,
        title: '测试提醒',
        body: `这是一条测试提醒，约 ${TASK_REMINDER_TEST_DELAY_MS / 1000} 秒后出现。\n任务：${task.title}\n实际送达取决于手机的通知设置。`,
        triggerAtMs,
        data,
      })
    } catch (cause) {
      return {
        ok: false,
        queued: false,
        verified: false,
        identifier,
        triggerAtMs,
        permission,
        reason: `测试提醒没有安排成功：${errorMessage(cause)}`,
      }
    }
    const after = await readPendingSafely(deps.port)
    let verified = false
    if (after.ok) {
      const actual = after.pending.find((item) => item.test && item.identifier === identifier)
      verified =
        Boolean(actual) &&
        actual!.triggerAtMs !== null &&
        actual!.triggerAtMs === triggerAtMs
    }
    return {
      ok: true,
      queued: true,
      verified,
      identifier,
      triggerAtMs,
      permission,
      reason: verified
        ? '测试提醒已经交给系统，约 10 秒后检查手机；这不代表已经确认送达。'
        : '测试提醒已经交给系统，但暂时无法从系统列表确认；约 10 秒后检查手机。',
    }
  }

  return {
    reconcile: (reason) => runExclusive(() => reconcileInner(reason)),
    notifyTaskChange: (reason) =>
      runExclusive(() => reconcileInner(reason)).catch((cause) => {
        setLastError(`任务改动后的提醒对账失败：${errorMessage(cause)}`)
        return null
      }),
    inspectTask: (taskId) => runExclusive(() => inspectTaskInner(taskId)),
    saveSettings: (input) => runExclusive(() => saveSettingsInner(input)),
    testReminder: (taskId) => runExclusive(() => testReminderInner(taskId)),
    getSnapshot: snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    suspendForBackup: async (reason) => {
      // 先同步置位，再排一个 barrier：已经在跑的那一次对账会先做完，
      // 之后排队的对账在 reconcileInner 入口就会放弃。
      backupSuspended = true
      backupSuspendReason = reason.trim().length > 0 ? reason : '备份 / 恢复进行中'
      await runExclusive(async () => undefined)
    },
    resumeAfterBackup: () => {
      backupSuspended = false
      backupSuspendReason = null
      const shouldReconcile = pendingResumeReconcile
      pendingResumeReconcile = false
      emit()
      /**
       * 暂停期间可能已经有任务改动排队，它们的对账在 reconcileInner 入口被丢弃。
       * 释放暂停时必须补一次**最新 DB** 对账，否则用户会静默保留旧的系统通知。
       * 用服务自己的串行队列排队，不阻塞调用方，也不会与正在执行的对账交错。
       */
      if (shouldReconcile) {
        void runExclusive(() => reconcileInner('resume-after-backup')).catch((cause) => {
          setLastError(`恢复提醒对账失败：${errorMessage(cause)}`)
        })
      }
    },
    cancelAllOwnedNotifications: (reason) =>
      runExclusive(async () => {
        const pending = await readPendingSafely(deps.port)
        if (!pending.ok) {
          return {
            ok: false,
            cancelled: [],
            failures: [],
            reason: pending.reason ?? '读取系统已排队通知失败。',
          }
        }
        const cancelled: string[] = []
        const failures: Array<{ identifier: string; reason: string }> = []
        for (const item of pending.pending) {
          try {
            await deps.port.cancel(item.identifier)
            cancelled.push(item.identifier)
          } catch (cause) {
            failures.push({ identifier: item.identifier, reason: errorMessage(cause) })
          }
        }
        return {
          ok: failures.length === 0,
          cancelled,
          failures,
          reason:
            failures.length === 0
              ? null
              : `${reason || '恢复数据'}时未能取消 ${failures.length} 条本应用通知：${failures[0]!.reason}`,
        }
      }),
    isBackupSuspended: () => backupSuspended,
  }
}

export { reminderTriggerAt }
