/**
 * 任务截止提醒 —— **纯规则层**（无 React / 无 SQLite / 无 expo-notifications）。
 *
 * 这里只回答四类问题，方便单独测试：
 * 1. 一条规则怎么编码 / 解码（版本化 JSON、提前量、修订号）；
 * 2. 一条任务当前**能不能**安排提醒（没有 DDL、已过期、已完成 / 取消、提醒时刻已过）；
 * 3. 一条本地通知的稳定 ID / 载荷 / 指纹是什么（只认本应用自己的命名空间）；
 * 4. 给定「最新任务 + 已保存规则 + 系统里真实排队的通知」，**应该**取消 / 新建 / 替换哪些。
 *
 * 真正的 OS 调用、SQLite 读写、权限提示都在别的模块里。这样规则可以逐条断言，
 * 不会出现「测试只验证了实现自己的镜像」。
 */

import {
  SHANGHAI_OFFSET_MINUTES,
  SHANGHAI_ZONE,
  isDateOnlyDeadline,
  isoToEpochMs,
  shanghaiDeadlineLabel,
} from './datetime'
import type { TaskStatus } from './types'

export const TASK_REMINDER_VERSION = 1 as const
export const TASK_REMINDER_KEY_PREFIX = 'task_reminder.'
export const TASK_REMINDER_NOTIFICATION_PREFIX = 'ddlmate.task-reminder.v1.'
export const TASK_REMINDER_TEST_NOTIFICATION_PREFIX = 'ddlmate.task-reminder.v1.test.'
export const TASK_REMINDER_NOTIFICATION_KIND = 'ddlmate.task-reminder.v1' as const
export const TASK_REMINDER_TEST_NOTIFICATION_KIND = 'ddlmate.task-reminder-test.v1' as const
/** 与授权书一致：同时最多 32 条已启用的任务提醒。 */
export const MAX_ENABLED_TASK_REMINDERS = 32
/** 测试提醒固定 10 秒后触发；不是任务规则，也不会进入 32 条上限。 */
export const TASK_REMINDER_TEST_DELAY_MS = 10_000

export const REMINDER_LEAD_OPTIONS = [
  { value: 30, label: '提前 30 分钟' },
  { value: 180, label: '提前 3 小时' },
  { value: 1440, label: '提前 1 天' },
  { value: 4320, label: '提前 3 天' },
] as const

export type ReminderLeadMinutes = (typeof REMINDER_LEAD_OPTIONS)[number]['value']

const LEAD_VALUES: readonly number[] = REMINDER_LEAD_OPTIONS.map((option) => option.value)

export function isReminderLeadMinutes(value: unknown): value is ReminderLeadMinutes {
  return typeof value === 'number' && Number.isSafeInteger(value) && LEAD_VALUES.includes(value)
}

export function reminderLeadLabel(value: number): string {
  return REMINDER_LEAD_OPTIONS.find((option) => option.value === value)?.label ?? `提前 ${value} 分钟`
}

/** 只接受**正整数**任务 ID；绝不拼 `task_reminder.NaN` 之类的键。 */
export function isValidTaskId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function taskReminderKey(taskId: number): string | null {
  if (!isValidTaskId(taskId)) return null
  return `${TASK_REMINDER_KEY_PREFIX}${taskId}`
}

export function reminderNotificationId(taskId: number): string | null {
  if (!isValidTaskId(taskId)) return null
  return `${TASK_REMINDER_NOTIFICATION_PREFIX}${taskId}`
}

export function testReminderNotificationId(taskId: number): string | null {
  if (!isValidTaskId(taskId)) return null
  return `${TASK_REMINDER_TEST_NOTIFICATION_PREFIX}${taskId}`
}

/* ------------------------------- 规则记录 ------------------------------- */

export interface TaskReminderIntent {
  version: typeof TASK_REMINDER_VERSION
  taskId: number
  enabled: boolean
  leadMinutes: ReminderLeadMinutes
  revision: number
  updatedAt: string
}

export type TaskReminderDecode =
  | { ok: true; intent: TaskReminderIntent }
  | { ok: false; code: 'CORRUPT' | 'FUTURE'; reason: string }

export function encodeTaskReminder(intent: TaskReminderIntent): string {
  return JSON.stringify({
    version: TASK_REMINDER_VERSION,
    taskId: intent.taskId,
    enabled: intent.enabled,
    leadMinutes: intent.leadMinutes,
    revision: intent.revision,
    updatedAt: intent.updatedAt,
  })
}

/**
 * 解码一条规则。
 *
 * - **版本号大于当前版本** → `FUTURE`，只读不改（旧 App 不认识新结构，绝不覆盖）；
 * - 结构、类型、任务 ID、提前量、修订号任何一项不合法 → `CORRUPT`，同样保留原值；
 * - `expectedTaskId` 必须与记录里的 `taskId` 一致（防止键被手工改过、张冠李戴）。
 */
export function decodeTaskReminder(raw: unknown, expectedTaskId?: number): TaskReminderDecode {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(raw ?? ''))
  } catch {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置读不出来（不是有效的记录）。' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置格式不对。' }
  }
  const version = parsed.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置缺少可识别的版本号。' }
  }
  if (version > TASK_REMINDER_VERSION) {
    return { ok: false, code: 'FUTURE', reason: '本机保存的提醒设置来自更新的版本，已停止读写以免覆盖它。' }
  }
  const taskId = parsed.taskId
  if (!isValidTaskId(taskId)) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置没有有效的任务编号。' }
  }
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置与任务对不上，已停止使用以免张冠李戴。' }
  }
  if (typeof parsed.enabled !== 'boolean') {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置缺少开关状态。' }
  }
  if (!isReminderLeadMinutes(parsed.leadMinutes)) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置里的提前量不认识。' }
  }
  if (typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置缺少有效的修订号。' }
  }
  if (typeof parsed.updatedAt !== 'string' || parsed.updatedAt.length === 0) {
    return { ok: false, code: 'CORRUPT', reason: '本机保存的提醒设置缺少写入时间。' }
  }
  return {
    ok: true,
    intent: {
      version: TASK_REMINDER_VERSION,
      taskId,
      enabled: parsed.enabled,
      leadMinutes: parsed.leadMinutes,
      revision: parsed.revision,
      updatedAt: parsed.updatedAt,
    },
  }
}

/* -------------------------------- 权限 --------------------------------- */

export type ReminderPermissionStatus =
  | 'granted'
  | 'provisional'
  | 'denied'
  | 'undetermined'
  | 'unavailable'

export interface ReminderPermissionState {
  status: ReminderPermissionStatus
  canAskAgain: boolean
  /** 原生模块不可用 / 读取权限失败时的可读原因。 */
  detail: string | null
}

export function canScheduleReminder(permission: ReminderPermissionState): boolean {
  return permission.status === 'granted' || permission.status === 'provisional'
}

export function permissionIsQuiet(permission: ReminderPermissionState): boolean {
  return permission.status === 'provisional'
}

export function reminderPermissionLabel(permission: ReminderPermissionState): string {
  switch (permission.status) {
    case 'granted':
      return '通知权限已允许'
    case 'provisional':
      return '通知权限为安静通知（不会响铃，只在通知中心显示）'
    case 'denied':
      return '通知权限未允许'
    case 'undetermined':
      return '还没有询问过通知权限'
    default:
      return '这台设备上暂时不能使用本地通知'
  }
}

/* ------------------------------- 可安排性 ------------------------------- */

export interface ReminderTaskLike {
  id: number
  title: string
  deadline: string | null
  status: TaskStatus
}

export type ReminderInactiveCode =
  | 'TASK_MISSING'
  | 'NO_DEADLINE'
  | 'DATE_ONLY_DEADLINE'
  | 'INVALID_DEADLINE'
  | 'TASK_DONE'
  | 'TASK_CANCELLED'
  | 'REMINDER_PAST'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_UNDETERMINED'
  | 'NATIVE_UNAVAILABLE'
  | 'LIMIT_REACHED'
  | 'READ_FAILED'

export interface ReminderEligibility {
  eligible: boolean
  code: ReminderInactiveCode | null
  reason: string | null
  deadlineMs: number | null
  triggerAtMs: number | null
}

const NO_DEADLINE_REASON = '这条任务还没有截止时间，无法在截止前提醒。'
const DATE_ONLY_DEADLINE_REASON =
  '这条任务的截止时间只记到日期，没有具体时刻，无法安排定时提醒。想提醒的话，编辑任务补上 HH:mm 即可。'
const INVALID_DEADLINE_REASON = '这条任务的截止时间读不出来，先修好时间再设置提醒。'

/**
 * 原生 CAP 秒精度策略（iOS CALENDAR / Android DATE 的回读都只保证到秒）。
 *
 * 把「想提醒的时刻」规范化到**下一个整秒**：
 * - 绝不早于请求时刻（不会提前打扰）；
 * - 最多 +999ms；
 * - 所有地方（可安排性 / 指纹 / 载荷 / 原生排程 / 测试提醒 / 回读比较）
 *   都使用这一个规范值，因此 exact 比较不会因为 `Date.now().321` 之类的小数毫秒
 *   永远对不上。
 *
 * 这不是「容差」：比较仍然是精确相等，只是先统一到同一个秒精度规范值。
 */
export function canonicalReminderTriggerMs(triggerAtMs: number): number {
  if (!Number.isFinite(triggerAtMs)) return triggerAtMs
  return Math.ceil(triggerAtMs / 1_000) * 1_000
}

export function reminderTriggerAt(deadline: unknown, leadMinutes: number): number | null {
  if (!isReminderLeadMinutes(leadMinutes)) return null
  // 只到日期的 DDL 没有可提醒的具体时刻；绝不替用户猜一个 23:59。
  if (isDateOnlyDeadline(deadline)) return null
  const deadlineMs = isoToEpochMs(deadline)
  if (deadlineMs === null) return null
  return canonicalReminderTriggerMs(deadlineMs - leadMinutes * 60_000)
}

/** 把 epoch 毫秒按**北京时间**格式化成可读标签（`2026-10-15 21:30 周四`）。 */
export function formatReminderMoment(triggerAtMs: number): string {
  return shanghaiDeadlineLabel(new Date(triggerAtMs).toISOString())
}

/**
 * 判断某个提前量在**当前时刻**能不能启用。
 *
 * 注意：`triggerAtMs <= now` 一律判为过去，绝不安排一条「立刻补发」的过期提醒，
 * 也不会在刷新时把它重新排到未来。
 */
export function evaluateTaskReminderEligibility(
  task: ReminderTaskLike | null,
  leadMinutes: unknown,
  nowMs: number,
): ReminderEligibility {
  if (!task) {
    return {
      eligible: false,
      code: 'TASK_MISSING',
      reason: '这条任务已经不在本机了（可能已被删除），提醒不会安排。',
      deadlineMs: null,
      triggerAtMs: null,
    }
  }
  if (task.status === 'DONE') {
    return {
      eligible: false,
      code: 'TASK_DONE',
      reason: '任务已经完成，提醒不会生效；标记回未完成后可重新安排。',
      deadlineMs: isoToEpochMs(task.deadline),
      triggerAtMs: null,
    }
  }
  if (task.status === 'CANCELLED') {
    return {
      eligible: false,
      code: 'TASK_CANCELLED',
      reason: '任务已经取消，提醒不会生效；恢复为未完成后可重新安排。',
      deadlineMs: isoToEpochMs(task.deadline),
      triggerAtMs: null,
    }
  }
  if (!task.deadline) {
    return {
      eligible: false,
      code: 'NO_DEADLINE',
      reason: NO_DEADLINE_REASON,
      deadlineMs: null,
      triggerAtMs: null,
    }
  }
  if (isDateOnlyDeadline(task.deadline)) {
    return {
      eligible: false,
      code: 'DATE_ONLY_DEADLINE',
      reason: DATE_ONLY_DEADLINE_REASON,
      deadlineMs: null,
      triggerAtMs: null,
    }
  }
  const deadlineMs = isoToEpochMs(task.deadline)
  if (deadlineMs === null) {
    return {
      eligible: false,
      code: 'INVALID_DEADLINE',
      reason: INVALID_DEADLINE_REASON,
      deadlineMs: null,
      triggerAtMs: null,
    }
  }
  if (!isReminderLeadMinutes(leadMinutes)) {
    return {
      eligible: false,
      code: 'REMINDER_PAST',
      reason: '请选择一个有效的提前量。',
      deadlineMs,
      triggerAtMs: null,
    }
  }
  const triggerAtMs = canonicalReminderTriggerMs(deadlineMs - leadMinutes * 60_000)
  if (triggerAtMs <= nowMs) {
    return {
      eligible: false,
      code: 'REMINDER_PAST',
      reason: `按「${reminderLeadLabel(leadMinutes)}」算出的提醒时刻（${formatReminderMoment(triggerAtMs)}）已经过去，换一个更短的提前量。`,
      deadlineMs,
      triggerAtMs,
    }
  }
  return { eligible: true, code: null, reason: null, deadlineMs, triggerAtMs }
}

/* --------------------------- 通知 ID / 载荷 / 指纹 --------------------------- */

const MAIN_ID_RE = /^ddlmate\.task-reminder\.v1\.([1-9]\d*)$/
const TEST_ID_RE = /^ddlmate\.task-reminder\.v1\.test\.([1-9]\d*)$/

export interface ReminderFingerprintInput {
  taskId: number
  deadline: string
  leadMinutes: ReminderLeadMinutes
  title: string
  triggerAtMs: number
}

/** FNV-1a 32 位；只用于稳定比较，不做安全用途。 */
export function stableHash32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 稳定指纹：任务 ID、截止时间、提前量、标题、绝对触发时刻任一变化都会变。
 *
 * 刷新时只有指纹与触发时刻都相同才视为「已经排好，不重复安排」。
 */
export function taskReminderFingerprint(input: ReminderFingerprintInput): string {
  const material = [
    'v1',
    String(input.taskId),
    input.deadline,
    String(input.leadMinutes),
    String(input.triggerAtMs),
    input.title,
  ].join('\u001f')
  return `v1-${stableHash32(material)}`
}

export interface ReminderNotificationPayload {
  kind: typeof TASK_REMINDER_NOTIFICATION_KIND
  version: 1
  taskId: number
  leadMinutes: ReminderLeadMinutes
  triggerAtMs: number
  deadline: string
  title: string
  fingerprint: string
  /** 排程时的本机路由代次；恢复后本机代次 +1，旧通知点击会被拒绝。 */
  deliveryGeneration: number
}

export interface TestReminderNotificationPayload {
  kind: typeof TASK_REMINDER_TEST_NOTIFICATION_KIND
  version: 1
  taskId: number
  triggerAtMs: number
  /** 与正式提醒同一套恢复边界。 */
  deliveryGeneration: number
}

export function buildReminderNotificationPayload(
  task: ReminderTaskLike,
  leadMinutes: ReminderLeadMinutes,
  triggerAtMs: number,
  deliveryGeneration = 0,
): ReminderNotificationPayload {
  const deadline = String(task.deadline)
  return {
    kind: TASK_REMINDER_NOTIFICATION_KIND,
    version: 1,
    taskId: task.id,
    leadMinutes,
    triggerAtMs,
    deadline,
    title: task.title,
    fingerprint: taskReminderFingerprint({
      taskId: task.id,
      deadline,
      leadMinutes,
      title: task.title,
      triggerAtMs,
    }),
    deliveryGeneration: Number.isSafeInteger(deliveryGeneration) && deliveryGeneration >= 0 ? deliveryGeneration : 0,
  }
}

export function buildTestReminderNotificationPayload(
  taskId: number,
  triggerAtMs: number,
  deliveryGeneration = 0,
): TestReminderNotificationPayload {
  return {
    kind: TASK_REMINDER_TEST_NOTIFICATION_KIND,
    version: 1,
    taskId,
    triggerAtMs,
    deliveryGeneration: Number.isSafeInteger(deliveryGeneration) && deliveryGeneration >= 0 ? deliveryGeneration : 0,
  }
}

export type ReminderPayloadParse =
  | { ok: true; payload: ReminderNotificationPayload }
  | { ok: true; test: true; payload: TestReminderNotificationPayload }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 严格解析本应用写入的载荷；任何多余/缺失/类型不对都拒绝（不猜测）。 */
export function parseReminderNotificationPayload(data: unknown): ReminderPayloadParse {
  if (!isRecord(data)) return { ok: false, reason: '通知载荷不是对象。' }
  if (data.kind === TASK_REMINDER_NOTIFICATION_KIND) {
    if (data.version !== 1) return { ok: false, reason: '通知载荷版本不认识。' }
    if (!isValidTaskId(data.taskId)) return { ok: false, reason: '通知载荷没有有效任务编号。' }
    const deliveryGeneration =
      data.deliveryGeneration === undefined
        ? 0
        : typeof data.deliveryGeneration === 'number' &&
            Number.isSafeInteger(data.deliveryGeneration) &&
            data.deliveryGeneration >= 0
          ? data.deliveryGeneration
          : null
    if (deliveryGeneration === null) return { ok: false, reason: '通知载荷的代次不可用。' }
    if (!isReminderLeadMinutes(data.leadMinutes)) return { ok: false, reason: '通知载荷提前量不认识。' }
    if (typeof data.triggerAtMs !== 'number' || !Number.isFinite(data.triggerAtMs)) {
      return { ok: false, reason: '通知载荷没有有效触发时刻。' }
    }
    if (typeof data.deadline !== 'string' || isoToEpochMs(data.deadline) === null) {
      return { ok: false, reason: '通知载荷没有有效截止时间。' }
    }
    if (typeof data.title !== 'string' || data.title.length === 0) {
      return { ok: false, reason: '通知载荷没有任务标题。' }
    }
    if (typeof data.fingerprint !== 'string' || data.fingerprint.length === 0) {
      return { ok: false, reason: '通知载荷没有指纹。' }
    }
    return {
      ok: true,
      payload: {
        kind: TASK_REMINDER_NOTIFICATION_KIND,
        version: 1,
        taskId: data.taskId,
        leadMinutes: data.leadMinutes,
        triggerAtMs: data.triggerAtMs,
        deadline: data.deadline,
        title: data.title,
        fingerprint: data.fingerprint,
        deliveryGeneration,
      },
    }
  }
  if (data.kind === TASK_REMINDER_TEST_NOTIFICATION_KIND) {
    if (data.version !== 1) return { ok: false, reason: '测试通知载荷版本不认识。' }
    if (!isValidTaskId(data.taskId)) return { ok: false, reason: '测试通知载荷没有有效任务编号。' }
    const deliveryGeneration =
      data.deliveryGeneration === undefined
        ? 0
        : typeof data.deliveryGeneration === 'number' &&
            Number.isSafeInteger(data.deliveryGeneration) &&
            data.deliveryGeneration >= 0
          ? data.deliveryGeneration
          : null
    if (deliveryGeneration === null) return { ok: false, reason: '测试通知载荷的代次不可用。' }
    if (typeof data.triggerAtMs !== 'number' || !Number.isFinite(data.triggerAtMs)) {
      return { ok: false, reason: '测试通知载荷没有有效触发时刻。' }
    }
    return {
      ok: true,
      test: true,
      payload: {
        kind: TASK_REMINDER_TEST_NOTIFICATION_KIND,
        version: 1,
        taskId: data.taskId,
        triggerAtMs: data.triggerAtMs,
        deliveryGeneration,
      },
    }
  }
  return { ok: false, reason: '通知载荷不属于任务提醒。' }
}

/**
 * 从 Expo 的 `NotificationTrigger` 回读里取**原生真实**的绝对毫秒。
 *
 * 关键点（来自安装的 SDK 57 iOS 源码）：
 * - iOS 用 CALENDAR trigger 排程，回读是 `{ type:'calendar', dateComponents }`，
 *   其中带完整 year/month/day/hour/minute/second + timeZone，可精确换算；
 * - `repeats: true` 一律不可验证（一次性的截止提醒不能用重复 trigger 证明）；
 * - `timeInterval` **不可**用「JS 排程时刻 + seconds」重建：seconds 是原生侧按
 *   `Date()` 计算的，JS 到原生的 bridge / 动态 import 延迟会让结果偏小；
 * - `type:'unknown'` / 其它 type 即使带 timestamp 也一律不可验证；
 * - Android 的 `date` 回读是绝对 timestamp，可精确比较；
 * - 缺失 / 非上海时区的 calendar 组件不猜。
 */
export function triggerAtMsFromNotificationTrigger(trigger: unknown): number | null {
  if (typeof trigger === 'number' && Number.isFinite(trigger)) return trigger
  if (trigger instanceof Date) return trigger.getTime()
  if (!isRecord(trigger)) return null

  // 先拒绝重复触发：calendar / date 都可能在 repeats:true 时出现。
  // 这一条必须在任何 timestamp / dateComponents 解析之前，避免「有字段就信」。
  if (trigger.repeats === true) return null

  if (trigger.type === 'calendar') {
    const components = trigger.dateComponents
    if (!isRecord(components)) return null
    const timeZone = components.timeZone
    // 只接受明确的上海时区；其它 / 缺失时区不猜。
    if (timeZone !== SHANGHAI_ZONE) return null
    const year = components.year
    const month = components.month
    const day = components.day
    const hour = components.hour
    const minute = components.minute
    const second = components.second ?? 0
    if (
      typeof year !== 'number' ||
      typeof month !== 'number' ||
      typeof day !== 'number' ||
      typeof hour !== 'number' ||
      typeof minute !== 'number' ||
      typeof second !== 'number'
    ) {
      return null
    }
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      !Number.isInteger(second)
    ) {
      return null
    }
    // iOS DateComponents.month 是 1–12。
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
    const utc = Date.UTC(year, month - 1, day, hour, minute, second)
    // 再用同一个日历校验，拒绝 2026-02-30 这种「Date.UTC 会滚动」的组件。
    const check = new Date(utc)
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day ||
      check.getUTCHours() !== hour ||
      check.getUTCMinutes() !== minute ||
      check.getUTCSeconds() !== second
    ) {
      return null
    }
    return utc - SHANGHAI_OFFSET_MINUTES * 60_000
  }

  // 只有 Android 的明确 `date`（或没有 type 的旧绝对时间字段）才接受 timestamp。
  // `timeInterval` / `unknown` / `push` / `location` 等一律不可验证。
  if (typeof trigger.type === 'string' && trigger.type !== 'date') return null
  for (const key of ['value', 'date', 'timestamp', 'time'] as const) {
    const candidate = trigger[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

export interface PendingReminderNotificationInput {
  identifier: string
  data: unknown
  trigger?: unknown
  title?: string | null
}

export interface OwnedReminderNotification {
  identifier: string
  taskId: number
  test: boolean
  fingerprint: string | null
  triggerAtMs: number | null
  title: string | null
  /** 载荷里的本机路由代次；旧载荷按 0。 */
  deliveryGeneration: number
}

/**
 * 只认**本应用精确命名空间 + 有效载荷**的排队通知。
 *
 * 字符串前缀不够：必须 ID 形如 `ddlmate.task-reminder.v1.<正整数>`（测试提醒是
 * `...v1.test.<正整数>`），且载荷属于本应用、任务编号与 ID 一致。任何不满足的
 * 通知都当作**别人的通知**，保留不动。
 */
export function parseOwnedReminderNotification(input: PendingReminderNotificationInput): OwnedReminderNotification | null {
  const identifier = String(input.identifier ?? '')
  const main = MAIN_ID_RE.exec(identifier)
  const test = TEST_ID_RE.exec(identifier)
  if (!main && !test) return null
  const taskId = Number((main ?? test)![1])
  if (!isValidTaskId(taskId)) return null
  const parsed = parseReminderNotificationPayload(input.data)
  if (!parsed.ok) return null
  if (parsed.payload.taskId !== taskId) return null
  if (test) {
    if (!('test' in parsed) || !parsed.test) return null
    return {
      identifier,
      taskId,
      test: true,
      fingerprint: null,
      triggerAtMs: triggerAtMsFromNotificationTrigger(input.trigger),
      title: input.title ?? null,
      deliveryGeneration: parsed.payload.deliveryGeneration,
    }
  }
  if ('test' in parsed) return null
  return {
    identifier,
    taskId,
    test: false,
    fingerprint: parsed.payload.fingerprint,
    // 绝不回退到载荷里的 triggerAtMs：那只证明「我们曾经想排」，不证明系统里
    // 实际排着什么。只有原生 trigger（iOS calendar / Android date）能精确重建。
    triggerAtMs: triggerAtMsFromNotificationTrigger(input.trigger),
    title: parsed.payload.title,
    deliveryGeneration: parsed.payload.deliveryGeneration,
  }
}

/* ------------------------------- 对账计划 ------------------------------- */

export interface ReminderStoredEntry {
  taskId: number
  state: 'valid' | 'corrupt' | 'future'
  intent: TaskReminderIntent | null
  reason: string | null
}

export interface ReminderScheduleRequest {
  identifier: string
  taskId: number
  title: string
  body: string
  triggerAtMs: number
  data: ReminderNotificationPayload
}

export type ReminderOperation =
  | { kind: 'cancel'; identifier: string; taskId: number; reason: string }
  | { kind: 'schedule'; taskId: number; request: ReminderScheduleRequest; reason: string }
  | { kind: 'replace'; taskId: number; identifier: string; request: ReminderScheduleRequest; reason: string }

export interface ReminderBlockedEntry {
  taskId: number
  code: ReminderInactiveCode
  reason: string
}

export interface ReconcilePlan {
  operations: ReminderOperation[]
  blocked: ReminderBlockedEntry[]
  unchanged: Array<{ taskId: number; identifier: string }>
  /** 任务已经不在本机、只留下规则 / 通知的任务编号（调用方据此精确清理规则键）。 */
  orphanTaskIds: number[]
}

export interface ReconcilePlanInput {
  tasks: readonly ReminderTaskLike[]
  entries: readonly ReminderStoredEntry[]
  pending: readonly OwnedReminderNotification[]
  permission: ReminderPermissionState
  nowMs: number
  maxEnabled?: number
  /** 当前本机路由代次；已排队通知的代次不同就必须替换。 */
  deliveryGeneration?: number
}

const PERMISSION_BLOCK_REASON: Record<'denied' | 'undetermined' | 'unavailable', string> = {
  denied: '通知权限未允许，提醒已经设置但还没有交给系统；允许通知后可重试。',
  undetermined: '还没有允许通知，提醒已经设置但还没有交给系统。',
  unavailable: '这台设备上暂时不能使用本地通知，提醒还没有安排。',
}

function notificationBody(task: ReminderTaskLike, leadMinutes: ReminderLeadMinutes): string {
  return `${task.title}\n截止：${shanghaiDeadlineLabel(task.deadline)}\n${reminderLeadLabel(leadMinutes)}提醒`
}

/**
 * 生成**应当执行**的操作。纯函数：不读写数据库、不碰 OS。
 *
 * 关键约束：
 * - 只处理已保存且已启用的规则；没启用过的任务不会因为刷新被自动打开；
 * - 任务删除 / DONE / CANCELLED / 没有 DDL / 提醒时刻已过 → 取消本应用自己那条；
 * - 权限不够时**不新建**，但已排队的通知保留（权限恢复后按指纹判断，不重复排）；
 * - 已排队且指纹 + 触发时刻一致 → 不动；不一致 → 先取消再排（取消失败就不排）；
 * - 规则读不出来（损坏 / 未来版本）→ 不动它的通知，也不覆盖记录；
 * - 任何 foreign 通知都不在输入里（调用方必须先按命名空间解析）。
 */
export function planTaskReminderReconciliation(input: ReconcilePlanInput): ReconcilePlan {
  const maxEnabled = input.maxEnabled ?? MAX_ENABLED_TASK_REMINDERS
  const deliveryGeneration =
    typeof input.deliveryGeneration === 'number' && Number.isSafeInteger(input.deliveryGeneration) && input.deliveryGeneration >= 0
      ? input.deliveryGeneration
      : 0
  const taskById = new Map(input.tasks.map((task) => [task.id, task]))
  const pendingById = new Map(input.pending.map((item) => [item.identifier, item]))
  const entryByTask = new Map(input.entries.map((entry) => [entry.taskId, entry]))
  const operations: ReminderOperation[] = []
  const blocked: ReminderBlockedEntry[] = []
  const unchanged: Array<{ taskId: number; identifier: string }> = []
  const orphanTaskIds = new Set<number>()
  const unreadableTaskIds = new Set<number>()
  /** 已经被某个规则处理过的通知 ID；剩下的才算「没有规则却还排着」。 */
  const handledIdentifiers = new Set<string>()

  const sortedEntries = [...input.entries].sort((left, right) => left.taskId - right.taskId)
  const validEnabled = sortedEntries.filter(
    (entry) => entry.state === 'valid' && entry.intent !== null && entry.intent.enabled,
  )
  const activeTaskIds = new Set(validEnabled.slice(0, maxEnabled).map((entry) => entry.taskId))

  for (const entry of sortedEntries) {
    if (entry.state !== 'valid' || !entry.intent) {
      // 损坏 / 未来版本：保留原记录，也不动它可能对应的通知（不知道它想要什么）。
      unreadableTaskIds.add(entry.taskId)
      blocked.push({
        taskId: entry.taskId,
        code: 'READ_FAILED',
        reason: entry.reason ?? '这条提醒设置读不出来，已停止安排以免覆盖它。',
      })
      continue
    }
    const intent = entry.intent
    const task = taskById.get(entry.taskId) ?? null
    const identifier = reminderNotificationId(entry.taskId)
    if (identifier === null) continue
    const pending = pendingById.get(identifier) ?? null
    if (pending && !pending.test) handledIdentifiers.add(identifier)

    if (!task) {
      orphanTaskIds.add(entry.taskId)
      if (pending && !pending.test) {
        operations.push({
          kind: 'cancel',
          identifier,
          taskId: entry.taskId,
          reason: '任务已经不在本机，取消它留下的提醒。',
        })
      }
      blocked.push({ taskId: entry.taskId, code: 'TASK_MISSING', reason: '任务已经不在本机。' })
      continue
    }

    if (!intent.enabled) {
      if (pending && !pending.test) {
        operations.push({
          kind: 'cancel',
          identifier,
          taskId: entry.taskId,
          reason: '提醒已经关闭，取消系统里还排着的那一条。',
        })
      }
      continue
    }

    if (!activeTaskIds.has(entry.taskId)) {
      if (pending && !pending.test) {
        operations.push({
          kind: 'cancel',
          identifier,
          taskId: entry.taskId,
          reason: '已启用的提醒超过 32 条上限，这一条没有生效。',
        })
      }
      blocked.push({ taskId: entry.taskId, code: 'LIMIT_REACHED', reason: '已启用的提醒最多 32 条。' })
      continue
    }

    const eligibility = evaluateTaskReminderEligibility(task, intent.leadMinutes, input.nowMs)
    if (!eligibility.eligible) {
      if (pending && !pending.test) {
        operations.push({
          kind: 'cancel',
          identifier,
          taskId: entry.taskId,
          reason: eligibility.reason ?? '这条提醒当前不生效。',
        })
      }
      blocked.push({ taskId: entry.taskId, code: eligibility.code ?? 'REMINDER_PAST', reason: eligibility.reason ?? '' })
      continue
    }

    if (!canScheduleReminder(input.permission)) {
      const code: ReminderInactiveCode =
        input.permission.status === 'denied'
          ? 'PERMISSION_DENIED'
          : input.permission.status === 'undetermined'
            ? 'PERMISSION_UNDETERMINED'
            : 'NATIVE_UNAVAILABLE'
      blocked.push({ taskId: entry.taskId, code, reason: PERMISSION_BLOCK_REASON[input.permission.status as 'denied'] })
      continue
    }

    const triggerAtMs = eligibility.triggerAtMs as number
    const payload = buildReminderNotificationPayload(task, intent.leadMinutes, triggerAtMs, deliveryGeneration)
    const request: ReminderScheduleRequest = {
      identifier,
      taskId: entry.taskId,
      title: `任务提醒：${task.title}`,
      body: notificationBody(task, intent.leadMinutes),
      triggerAtMs,
      data: payload,
    }

    if (pending && !pending.test) {
      const same =
        pending.fingerprint === payload.fingerprint &&
        (pending.deliveryGeneration ?? 0) === deliveryGeneration &&
        pending.triggerAtMs !== null &&
        Math.abs(pending.triggerAtMs - triggerAtMs) < 1_000
      if (same) {
        unchanged.push({ taskId: entry.taskId, identifier })
      } else {
        operations.push({
          kind: 'replace',
          taskId: entry.taskId,
          identifier,
          request,
          reason: '任务内容或提醒时间变了，替换系统里旧的那一条。',
        })
      }
    } else {
      operations.push({
        kind: 'schedule',
        taskId: entry.taskId,
        request,
        reason: '按最新的任务与提前量安排提醒。',
      })
    }
  }

  // 系统里还排着、但已经没有任何有效启用规则的本应用通知：只有「任务不存在」或
  // 「根本没有规则 / 规则明确关闭」才清理；读不出来的规则一律不动。
  const knownEntryTaskIds = new Set(input.entries.map((entry) => entry.taskId))
  for (const pending of input.pending) {
    if (pending.test || handledIdentifiers.has(pending.identifier)) continue
    const identifier = reminderNotificationId(pending.taskId)
    if (identifier !== pending.identifier) continue
    if (unreadableTaskIds.has(pending.taskId)) continue
    const entry = entryByTask.get(pending.taskId)
    if (!entry && taskById.has(pending.taskId)) {
      // 任务还在但规则键不存在：没有用户意图，属于遗留通知。
      operations.push({
        kind: 'cancel',
        identifier,
        taskId: pending.taskId,
        reason: '这条任务没有提醒设置，清理遗留的系统通知。',
      })
      continue
    }
    if (!taskById.has(pending.taskId)) {
      orphanTaskIds.add(pending.taskId)
      operations.push({
        kind: 'cancel',
        identifier,
        taskId: pending.taskId,
        reason: '任务已经不在本机，取消它留下的提醒。',
      })
      continue
    }
    if (!knownEntryTaskIds.has(pending.taskId)) {
      operations.push({
        kind: 'cancel',
        identifier,
        taskId: pending.taskId,
        reason: '没有对应的提醒设置，清理遗留的系统通知。',
      })
    }
  }

  return {
    operations,
    blocked,
    unchanged,
    orphanTaskIds: [...orphanTaskIds].sort((left, right) => left - right),
  }
}
