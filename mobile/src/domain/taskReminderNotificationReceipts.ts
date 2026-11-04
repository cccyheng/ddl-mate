/**
 * 任务提醒点击的**已消费回执**（纯规则，无 SQLite / React / 原生模块）。
 *
 * 为什么需要它：`expo-notifications` 的 last response 在 iOS 上可能一直保留，
 * 而盲目调用 `clearLastNotificationResponse()` 又会把用户刚点的**下一条**通知
 * （甚至别的模块的通知）一起清掉。因此这里改用「已消费回执」：
 * - 不删除原生 last response；
 * - 每次成功交付后写一条有界回执；
 * - 重启后先查回执，同一条已展示通知不会重复导航；
 * - A → B → A 时 A 的回执仍在（保留多条，不是只记一个 token）。
 *
 * 没有有效展示时间的点击**不写持久回执**（否则同一个稳定 ID 会永久吞掉以后的
 * 新通知）；这种情况由控制器做短时内存去重，只覆盖监听器 + last 的重复事件。
 */

export const TASK_REMINDER_RECEIPT_KEY = 'task_reminder.notification_receipts.v1'
export const TASK_REMINDER_RECEIPT_VERSION = 1
/** 只保留最近 32 条；A → B → A 仍能覆盖，且不会无限增长。 */
export const MAX_TASK_REMINDER_RECEIPTS = 32

export interface TaskReminderNotificationReceipt {
  version: typeof TASK_REMINDER_RECEIPT_VERSION
  /** 由通知 ID + 展示时间 + 已验证载荷证据 + 动作构成；缺失展示时间时不落盘。 */
  token: string
  taskId: number
  identifier: string
  deliveryDate: number | null
  /** 正式提醒是载荷 fingerprint；测试提醒是已验证的 triggerAtMs。 */
  evidence: string
  actionIdentifier: string
  consumedAt: string
}

export type NotificationReceiptsDecode =
  | { ok: true; receipts: TaskReminderNotificationReceipt[] }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isValidReceipt(value: unknown): value is TaskReminderNotificationReceipt {
  if (!isRecord(value)) return false
  if (value.version !== TASK_REMINDER_RECEIPT_VERSION) return false
  if (!isNonEmptyString(value.token, 512)) return false
  if (!isPositiveInteger(value.taskId)) return false
  if (!isNonEmptyString(value.identifier, 160)) return false
  if (value.deliveryDate !== null) {
    if (typeof value.deliveryDate !== 'number' || !Number.isFinite(value.deliveryDate)) return false
  }
  if (!isNonEmptyString(value.evidence, 320)) return false
  if (!isNonEmptyString(value.actionIdentifier, 160)) return false
  if (!isNonEmptyString(value.consumedAt, 64)) return false
  if (!Number.isFinite(Date.parse(value.consumedAt))) return false
  return true
}

/** 严格解码；坏记录 / 未来版本返回原因，调用方必须 fail closed（不得覆盖）。 */
export function decodeTaskReminderNotificationReceipts(raw: string): NotificationReceiptsDecode {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: '本机保存的通知点击记录不是有效 JSON。' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: '本机保存的通知点击记录格式不认识。' }
  if (parsed.version !== TASK_REMINDER_RECEIPT_VERSION) {
    return { ok: false, reason: '本机保存的通知点击记录版本不认识。' }
  }
  if (!Array.isArray(parsed.receipts)) return { ok: false, reason: '本机保存的通知点击记录缺少回执列表。' }
  if (parsed.receipts.length > MAX_TASK_REMINDER_RECEIPTS * 4) {
    return { ok: false, reason: '本机保存的通知点击记录条数异常。' }
  }
  const receipts: TaskReminderNotificationReceipt[] = []
  const seen = new Set<string>()
  for (const entry of parsed.receipts) {
    if (!isValidReceipt(entry)) return { ok: false, reason: '本机保存的通知点击记录里有坏条目。' }
    if (seen.has(entry.token)) continue
    seen.add(entry.token)
    receipts.push(entry)
  }
  return { ok: true, receipts: receipts.slice(0, MAX_TASK_REMINDER_RECEIPTS) }
}

export function encodeTaskReminderNotificationReceipts(
  receipts: readonly TaskReminderNotificationReceipt[],
): string {
  return JSON.stringify({
    version: TASK_REMINDER_RECEIPT_VERSION,
    receipts: receipts.slice(0, MAX_TASK_REMINDER_RECEIPTS),
  })
}

/** 新回执放最前面；重复 token 不新增；超过上限丢最旧的。 */
export function appendTaskReminderNotificationReceipt(
  receipts: readonly TaskReminderNotificationReceipt[],
  receipt: TaskReminderNotificationReceipt,
): TaskReminderNotificationReceipt[] {
  if (receipts.some((entry) => entry.token === receipt.token)) return [...receipts]
  return [receipt, ...receipts].slice(0, MAX_TASK_REMINDER_RECEIPTS)
}
