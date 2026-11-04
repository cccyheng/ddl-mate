/**
 * 任务提醒设置的**持久化层**（无 React / 无 OS 通知 / 无网络）。
 *
 * 与任务步骤清单同一个模式：
 * - 不新增表、不改 schema 版本：每个任务一条记录写进既有的 `app_settings`，
 *   键是 `task_reminder.<正整数任务ID>`，值是带版本号的紧凑 JSON；
 * - 保存时在**同一个事务**里确认父任务还在、重读旧记录、比对修订号、检查 32 条上限；
 * - 读不出来 / 版本不认识 → 拒绝写入，**绝不覆盖**那条记录；
 * - 读取只有 SELECT，不建表、不写任何东西；
 * - 删除任务时由 store 注入精确删除这一个键的清理闭包。
 */

import { APP_SETTINGS_SQL } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import { TaskRepository } from './taskRepository'
import {
  MAX_ENABLED_TASK_REMINDERS,
  TASK_REMINDER_KEY_PREFIX,
  TASK_REMINDER_VERSION,
  decodeTaskReminder,
  encodeTaskReminder,
  evaluateTaskReminderEligibility,
  isReminderLeadMinutes,
  isValidTaskId,
  taskReminderKey,
  type ReminderLeadMinutes,
  type ReminderStoredEntry,
  type TaskReminderIntent,
} from './taskReminder'

export interface TaskReminderReadValid {
  ok: true
  state: 'valid' | 'missing'
  /** `missing` 时是 `null`（默认关闭，不是错误）。 */
  intent: TaskReminderIntent | null
  revision: number
}

export interface TaskReminderReadUnavailable {
  ok: false
  code: 'PARENT_MISSING' | 'CORRUPT' | 'FUTURE' | 'INVALID_TASK' | 'NOT_READY' | 'READ_FAILED'
  reason: string
  rawExcerpt: string | null
}

export type TaskReminderLoadResult = TaskReminderReadValid | TaskReminderReadUnavailable

export interface SaveTaskReminderInput {
  taskId: number
  enabled: boolean
  leadMinutes: ReminderLeadMinutes
  /** 已保存记录的修订号；`0` = 认为还没有保存过。 */
  expectedRevision: number
}

export interface SaveTaskReminderResult {
  ok: boolean
  /** 是否**已经提交**；`false` 表示一个字节都没写。 */
  committed: boolean
  /** 提交后的新修订号；冲突时是库里当前的修订号。 */
  revision: number | null
  intent: TaskReminderIntent | null
  reason: string | null
  /** 写入已提交但读回失败时的真实原因。 */
  readbackError: string | null
}

export type TaskReminderListResult =
  | { ok: true; entries: ReminderStoredEntry[] }
  | { ok: false; reason: string }

const PARENT_MISSING = '这条任务已经不在本机了（可能已被删除），提醒设置没有保存。'
const INVALID_TASK = '任务编号不合法，提醒设置没有保存。'
const CORRUPT = '本机保存的提醒设置读不出来（格式或版本不认识），已停止保存以免覆盖它。'
const CONFLICT = '别处已经保存过这条任务的提醒设置，请先刷新看看最新版本，再决定要不要覆盖。'
const LIMIT = `已启用的任务提醒最多 ${MAX_ENABLED_TASK_REMINDERS} 条，这一条没有启用（不会静默丢掉别的提醒）。`

function excerptOf(raw: string): string {
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
}

function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

const KEY_RE = new RegExp(`^${TASK_REMINDER_KEY_PREFIX.replace('.', '\\.')}([1-9]\\d*)$`)

/**
 * 提醒设置的仓库。
 *
 * `tasks` 必须是同一个 SQLite 连接上的仓库（store 里就是这样传的），
 * 保存时才能在事务里当场确认父任务还在。
 */
export class TaskReminderRepository {
  private readonly db: SqliteDatabase
  private readonly tasks: TaskRepository
  private readonly now: () => Date

  constructor(db: SqliteDatabase, tasks?: TaskRepository, now: () => Date = () => new Date()) {
    this.db = db
    this.tasks = tasks ?? new TaskRepository(db)
    this.now = now
  }

  /** 公开读取：父任务不在就不是「这条任务的设置」；坏记录如实返回、绝不改写。 */
  async loadReminder(taskId: number): Promise<TaskReminderLoadResult> {
    if (!isValidTaskId(taskId)) {
      return { ok: false, code: 'INVALID_TASK', reason: INVALID_TASK, rawExcerpt: null }
    }
    const key = taskReminderKey(taskId)
    if (key === null) {
      return { ok: false, code: 'INVALID_TASK', reason: INVALID_TASK, rawExcerpt: null }
    }
    try {
      const parent = await this.tasks.getById(taskId)
      if (!parent) {
        return { ok: false, code: 'PARENT_MISSING', reason: '这条任务已经不在本机了（可能已被删除）。', rawExcerpt: null }
      }
      const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])
      if (!row) return { ok: true, state: 'missing', intent: null, revision: 0 }
      const raw = String(row.value)
      const decoded = decodeTaskReminder(raw, taskId)
      if (!decoded.ok) {
        return {
          ok: false,
          code: decoded.code,
          reason: decoded.reason,
          rawExcerpt: excerptOf(raw),
        }
      }
      return { ok: true, state: 'valid', intent: decoded.intent, revision: decoded.intent.revision }
    } catch (cause) {
      return {
        ok: false,
        code: 'READ_FAILED',
        reason: `读取提醒设置失败：${cause instanceof Error ? cause.message : String(cause)}`,
        rawExcerpt: null,
      }
    }
  }

  /**
   * 只读列出全部规则（供中央对账读取最新 DB 状态）。
   *
   * 列表失败返回 `ok: false` —— 调用方必须把它当成「不知道」，
   * **绝不能**当成「一条规则都没有」而取消所有通知。
   */
  async listReminders(): Promise<TaskReminderListResult> {
    try {
      const rows = await this.db.getAllAsync<{ key: string; value: string }>(
        "SELECT key, value FROM app_settings WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC;",
        [`${escapeLikePrefix(TASK_REMINDER_KEY_PREFIX)}%`],
      )
      const entries: ReminderStoredEntry[] = []
      for (const row of rows) {
        const match = KEY_RE.exec(String(row.key))
        if (!match) continue
        const taskId = Number(match[1])
        if (!isValidTaskId(taskId)) continue
        const raw = String(row.value)
        const decoded = decodeTaskReminder(raw, taskId)
        if (decoded.ok) {
          entries.push({ taskId, state: 'valid', intent: decoded.intent, reason: null })
        } else {
          entries.push({ taskId, state: decoded.code === 'FUTURE' ? 'future' : 'corrupt', intent: null, reason: decoded.reason })
        }
      }
      return { ok: true, entries }
    } catch (cause) {
      return { ok: false, reason: `读取提醒设置失败：${cause instanceof Error ? cause.message : String(cause)}` }
    }
  }

  /**
   * 保存（或替换）一条规则 —— **唯一会写库的入口**。
   *
   * 全部在同一个事务里：父任务仍在 → 旧记录可读 → 修订号一致 →（启用时）未超过 32 条
   * → 写入并修订号 +1。任何一步不满足都零写入。`enabled: false` 也写一条记录，
   * 这样用户显式关闭的意图也能持久化，并且能明确取消系统里已经排好的通知。
   */
  async saveReminder(input: SaveTaskReminderInput): Promise<SaveTaskReminderResult> {
    const taskId = input?.taskId
    if (!isValidTaskId(taskId)) {
      return { ok: false, committed: false, revision: null, intent: null, reason: INVALID_TASK, readbackError: null }
    }
    if (typeof input.enabled !== 'boolean' || !isReminderLeadMinutes(input.leadMinutes)) {
      return {
        ok: false,
        committed: false,
        revision: null,
        intent: null,
        reason: '提醒设置不完整，请重新选择提前量。',
        readbackError: null,
      }
    }
    const expectedRevision = input.expectedRevision
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return {
        ok: false,
        committed: false,
        revision: null,
        intent: null,
        reason: '提醒设置的版本号不合法，请刷新后再试。',
        readbackError: null,
      }
    }
    const key = taskReminderKey(taskId)
    if (key === null) {
      return { ok: false, committed: false, revision: null, intent: null, reason: INVALID_TASK, readbackError: null }
    }

    const committed: { intent: TaskReminderIntent | null } = { intent: null }
    let rejection: SaveTaskReminderResult | null = null

    try {
      await this.db.withTransactionAsync(async () => {
        const parent = await this.tasks.getById(taskId)
        if (!parent) {
          rejection = {
            ok: false,
            committed: false,
            revision: null,
            intent: null,
            reason: PARENT_MISSING,
            readbackError: null,
          }
          return
        }

        const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])
        let existingRevision = 0
        if (row) {
          const decoded = decodeTaskReminder(String(row.value), taskId)
          if (!decoded.ok) {
            rejection = {
              ok: false,
              committed: false,
              revision: null,
              intent: null,
              reason: decoded.code === 'FUTURE' ? decoded.reason : CORRUPT,
              readbackError: null,
            }
            return
          }
          existingRevision = decoded.intent.revision
        }

        if (existingRevision !== expectedRevision) {
          rejection = {
            ok: false,
            committed: false,
            revision: existingRevision,
            intent: null,
            reason: CONFLICT,
            readbackError: null,
          }
          return
        }

        if (input.enabled) {
          /**
           * 启用必须在**事务里**按最新任务再校验一次：没有 DDL / DDL 坏了 /
           * 已完成 / 已取消 / 算出来的提醒时刻已经过去，一律零写入。
           * 关闭不校验这些条件 —— 用户任何时候都必须能关掉一条已经失效的提醒。
           */
          const eligibility = evaluateTaskReminderEligibility(parent, input.leadMinutes, this.now().getTime())
          if (!eligibility.eligible) {
            rejection = {
              ok: false,
              committed: false,
              revision: existingRevision,
              intent: null,
              reason: eligibility.reason ?? '当前任务不能启用提醒。',
              readbackError: null,
            }
            return
          }
          const enabled = await this.countEnabledForExistingTasks(taskId)
          if (enabled >= MAX_ENABLED_TASK_REMINDERS) {
            rejection = {
              ok: false,
              committed: false,
              revision: existingRevision,
              intent: null,
              reason: LIMIT,
              readbackError: null,
            }
            return
          }
        }

        const nextRevision = existingRevision + 1
        const intent: TaskReminderIntent = {
          version: TASK_REMINDER_VERSION,
          taskId,
          enabled: input.enabled,
          leadMinutes: input.leadMinutes,
          revision: nextRevision,
          updatedAt: this.now().toISOString(),
        }
        await this.db.runAsync(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [key, encodeTaskReminder(intent), intent.updatedAt],
        )
        committed.intent = intent
      })
    } catch (cause) {
      return {
        ok: false,
        committed: false,
        revision: null,
        intent: null,
        reason: `保存提醒设置失败：${cause instanceof Error ? cause.message : String(cause)}`,
        readbackError: null,
      }
    }

    if (rejection) return rejection
    const committedIntent = committed.intent
    if (!committedIntent) {
      return {
        ok: false,
        committed: false,
        revision: null,
        intent: null,
        reason: '保存没有完成，请再试一次。',
        readbackError: null,
      }
    }

    // 写入已经提交 → 读回失败只记 readbackError，绝不改写 committed 这个事实。
    try {
      const readBack = await this.loadReminder(taskId)
      if (!readBack.ok) {
        return {
          ok: true,
          committed: true,
          revision: committedIntent.revision,
          intent: committedIntent,
          reason: null,
          readbackError: readBack.reason,
        }
      }
      return {
        ok: true,
        committed: true,
        revision: committedIntent.revision,
        intent: readBack.intent ?? committedIntent,
        reason: null,
        readbackError: null,
      }
    } catch (cause) {
      return {
        ok: true,
        committed: true,
        revision: committedIntent.revision,
        intent: committedIntent,
        reason: null,
        readbackError: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  /** 任务被删除时只删它自己那一个键（由 `TaskRepository.remove` 在事务里调用）。 */
  async removeReminderForTask(taskId: number): Promise<number> {
    const key = taskReminderKey(taskId)
    if (key === null) return 0
    const result = await this.db.runAsync('DELETE FROM app_settings WHERE key = ?;', [key])
    return result.changes
  }

  /**
   * 数「真正会占名额」的已启用规则：记录可读、已启用、且父任务**仍然存在**。
   * 孤儿记录不占名额（它本来就会被对账清理）。
   */
  private async countEnabledForExistingTasks(excludeTaskId: number): Promise<number> {
    const rows = await this.db.getAllAsync<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key LIKE ? ESCAPE '\\';",
      [`${escapeLikePrefix(TASK_REMINDER_KEY_PREFIX)}%`],
    )
    const taskRows = await this.db.getAllAsync<{ id: number }>('SELECT id FROM tasks;')
    const taskIds = new Set(taskRows.map((row) => Number(row.id)))
    let count = 0
    for (const row of rows) {
      const match = KEY_RE.exec(String(row.key))
      if (!match) continue
      const taskId = Number(match[1])
      if (!isValidTaskId(taskId) || taskId === excludeTaskId) continue
      if (!taskIds.has(taskId)) continue
      const decoded = decodeTaskReminder(String(row.value), taskId)
      if (!decoded.ok) continue
      if (decoded.intent.enabled) count += 1
    }
    return count
  }
}

/** 确保 `app_settings` 存在（只做 IF NOT EXISTS；正常读取路径不调用）。 */
export async function ensureTaskReminderStorage(db: SqliteDatabase): Promise<void> {
  await db.execAsync(APP_SETTINGS_SQL)
}
