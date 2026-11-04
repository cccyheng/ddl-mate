/**
 * 任务提醒点击回执的持久化：复用既有 `app_settings`，不新增表 / 不改 schema 版本。
 *
 * 单键存储一个有界数组：`task_reminder.notification_receipts.v1`。
 * 事务内「读旧值 → 严格解码 → 追加 / 去重 → 截断到上限 → 写回」，
 * 坏记录 / 未来版本**零写入**，避免把已有回执覆盖掉。
 */

import { APP_SETTINGS_SQL } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import {
  MAX_TASK_REMINDER_RECEIPTS,
  TASK_REMINDER_RECEIPT_KEY,
  appendTaskReminderNotificationReceipt,
  decodeTaskReminderNotificationReceipts,
  encodeTaskReminderNotificationReceipts,
  type TaskReminderNotificationReceipt,
} from './taskReminderNotificationReceipts'

export type NotificationReceiptsLoad =
  | { ok: true; receipts: TaskReminderNotificationReceipt[] }
  | { ok: false; reason: string }

export interface NotificationReceiptConsumption {
  ok: boolean
  consumed: boolean
  reason: string | null
}

export interface NotificationReceiptRecordResult {
  ok: boolean
  stored: boolean
  receipts: TaskReminderNotificationReceipt[] | null
  reason: string | null
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export class TaskReminderNotificationReceiptsRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
  }

  /** 只读；键不存在 = 还没有任何已消费回执（正常状态，不是错误）。 */
  async loadReceipts(): Promise<NotificationReceiptsLoad> {
    try {
      const row = await this.db.getFirstAsync<{ value: string }>(
        'SELECT value FROM app_settings WHERE key = ?;',
        [TASK_REMINDER_RECEIPT_KEY],
      )
      if (!row) return { ok: true, receipts: [] }
      const decoded = decodeTaskReminderNotificationReceipts(String(row.value))
      if (!decoded.ok) return { ok: false, reason: decoded.reason }
      return { ok: true, receipts: decoded.receipts }
    } catch (cause) {
      return { ok: false, reason: `读取通知点击记录失败：${describe(cause)}` }
    }
  }

  /** 判断某条已展示通知是否已经成功交付过。读取失败时调用方不得假装未消费。 */
  async hasConsumed(token: string): Promise<NotificationReceiptConsumption> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
      return { ok: false, consumed: false, reason: '通知点击记录的标识不合法。' }
    }
    const loaded = await this.loadReceipts()
    if (!loaded.ok) return { ok: false, consumed: false, reason: loaded.reason }
    return { ok: true, consumed: loaded.receipts.some((entry) => entry.token === token), reason: null }
  }

  /**
   * 追加一条已消费回执。
   *
   * 只有导航**已经被接受**后调用；写入失败返回 `ok:false`，不会被界面说成已保存。
   * 已存在的 token 是幂等的：不重复写、不改顺序。
   */
  async recordConsumption(receipt: TaskReminderNotificationReceipt): Promise<NotificationReceiptRecordResult> {
    let receipts: TaskReminderNotificationReceipt[] | null = null
    let rejection: NotificationReceiptRecordResult | null = null
    let stored = false
    try {
      await this.db.withTransactionAsync(async () => {
        const row = await this.db.getFirstAsync<{ value: string }>(
          'SELECT value FROM app_settings WHERE key = ?;',
          [TASK_REMINDER_RECEIPT_KEY],
        )
        let current: TaskReminderNotificationReceipt[] = []
        if (row) {
          const decoded = decodeTaskReminderNotificationReceipts(String(row.value))
          if (!decoded.ok) {
            rejection = { ok: false, stored: false, receipts: null, reason: decoded.reason }
            return
          }
          current = decoded.receipts
        }

        const next = appendTaskReminderNotificationReceipt(current, {
          ...receipt,
          version: 1,
          consumedAt: this.now().toISOString(),
        })
        if (next.length === current.length && next.every((entry, index) => entry.token === current[index]?.token)) {
          // 已经消费过：幂等成功，不写库。
          receipts = current
          return
        }

        await this.db.runAsync(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [TASK_REMINDER_RECEIPT_KEY, encodeTaskReminderNotificationReceipts(next), this.now().toISOString()],
        )
        receipts = next
        stored = true
      })
    } catch (cause) {
      return {
        ok: false,
        stored: false,
        receipts: null,
        reason: `保存通知点击记录失败：${describe(cause)}`,
      }
    }

    if (rejection) return rejection
    if (!receipts) {
      return { ok: false, stored: false, receipts: null, reason: '通知点击记录没有保存完成。' }
    }
    return { ok: true, stored, receipts, reason: null }
  }
}

/** 确保 `app_settings` 存在（仅测试 / 极旧库的引导路径使用）。 */
export async function ensureTaskReminderNotificationReceiptStorage(db: SqliteDatabase): Promise<void> {
  await db.execAsync(APP_SETTINGS_SQL)
}

export { MAX_TASK_REMINDER_RECEIPTS }
