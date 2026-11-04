/**
 * 任务步骤清单的**持久化层**（无 React / 无网络 / 无 AI）。
 *
 * 设计约束（逐条来自授权书，改这里之前先读一遍）：
 * - **不新增表、不改 schema 版本**：每个任务一条记录，写进既有的 `app_settings`
 *   键值表，键是 `task_steps.<正整数任务ID>`（见 {@link taskStepsKey}），
 *   值是**带版本号的紧凑 JSON** `{ version, taskId, revision, steps }`；
 * - **一次事务**：读既有记录（含破损检查）→ 确认父任务还在 → 比对版本号 →
 *   校验整份步骤 → 写回，全程同一个事务，因此「保存时任务刚好被删掉」
 *   不可能写进半条记录；
 * - **乐观锁**：`expectedRevision`（新清单为 `0`）与库里不一致就拒绝，
 *   绝不静默覆盖别处刚保存的那一版；
 * - **零写入的拒绝**：父任务不存在、记录读不出来、结构不合法、步骤不合法、
 *   版本冲突 —— 一律**一个字节都不写**；
 * - **脏数据不崩也不改写**：JSON 解析不了 / 版本不认识 / 结构不合法 → 返回可读的
 *   不可用原因，**绝不修改或删除**那条记录，也**不承诺**「保存就能替换它」；
 * - **读取绝不写库**：`loadSteps` 只有 `SELECT`，不会创建 `app_settings`
 *   （那张表由 App 启动时的迁移负责；这里也不做 `CREATE TABLE`）；
 * - **提交后读回失败不改写「已提交」**：返回 `committed: true` + 真实 `readbackError`，
 *   由界面提示「已保存但暂时无法读取」，而不是让用户再点一次保存。
 */

import { APP_SETTINGS_SQL, taskStepsKey } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import { TaskRepository } from './taskRepository'
import {
  TASK_STEPS_UNREADABLE_REASON,
  decodeTaskSteps,
  encodeTaskSteps,
  isValidTaskId,
  validateTaskSteps,
  type TaskStep,
} from './taskSteps'

/** 读取结果：`revision` + 步骤；没保存过是 `revision: 0` + 空数组（正常状态）。 */
export interface TaskStepsReadResult {
  ok: true
  steps: TaskStep[]
  revision: number
}

/** 读取失败（父任务不在 / 坏 JSON / 版本不认识 / 结构不合法）；原始记录原样保留。 */
export interface TaskStepsUnavailable {
  ok: false
  /** 失败类别：父任务不在 / 记录读不出来 / 任务编号不合法 / 数据库还没准备好。 */
  code: 'PARENT_MISSING' | 'CORRUPT' | 'INVALID_TASK' | 'NOT_READY'
  reason: string
  /** 库里那条原始值的片段（只用于诊断，界面不必展示）。 */
  rawExcerpt: string | null
}

export type TaskStepsLoadResult = TaskStepsReadResult | TaskStepsUnavailable

export interface SaveTaskStepsInput {
  taskId: number
  steps: readonly TaskStep[]
  /** 已保存清单的版本号；`0` = 认为还没有保存过（新清单）。 */
  expectedRevision: number
}

export interface SaveTaskStepsResult {
  ok: boolean
  /** 写入是否**已经提交**；`false` 表示一个字节都没写。 */
  committed: boolean
  /** 提交后的新版本号；**被冲突拒绝**时是库里当前的版本号（只用于提示，绝不写库）。 */
  revision: number | null
  /** 被拒绝时的原因（中文，可直接展示）。 */
  reason: string | null
  /** **写入已提交**但随后的读回失败时的真实错误。 */
  readbackError: string | null
}

const PARENT_MISSING_MESSAGE = '这条任务已经不在本机了（可能已被删除），步骤清单没有保存。'
const CORRUPT_MESSAGE = '本机保存的步骤清单读不出来（格式或版本不认识），已停止保存以免覆盖它。'
const CONFLICT_MESSAGE = '别处已经保存过这条任务的步骤，请先刷新看看最新版本，再决定要不要覆盖。'
const MALFORMED_MESSAGE = '这段步骤不合法，请改好之后再保存。'

function excerptOf(raw: string): string {
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
}

type StepRecord =
  | { kind: 'missing' }
  | { kind: 'valid'; revision: number; steps: TaskStep[] }
  | { kind: 'corrupt' }

/**
 * 任务步骤清单的仓库。
 *
 * `db` 只用来读写 `app_settings` 里那一个键；父任务是否存在、删除任务时怎么清理，
 * 都通过**注入**的 `tasks` 仓库完成（同一个 SQLite 连接，因此能参与同一个事务）。
 */
export class TaskStepsRepository {
  private readonly db: SqliteDatabase
  private readonly tasks: TaskRepository
  private readonly now: () => Date

  /**
   * `tasks` 必须与 `db` 是**同一个连接**（store 里就是这样传的）：
   * 保存时要在事务里当场确认父任务还在，跨连接做不到这一点。
   * 省略时自建一个只读用途的 `TaskRepository`，便于单独测试。
   */
  constructor(db: SqliteDatabase, tasks?: TaskRepository, now: () => Date = () => new Date()) {
    this.db = db
    this.tasks = tasks ?? new TaskRepository(db)
    this.now = now
  }

  /**
   * 读取某个任务的步骤清单。
   *
   * - 父任务不存在 → `code: 'PARENT_MISSING'` 的不可用结果（**绝不**把一条孤儿记录
   *   当成「这条任务的清单」展示给用户）；
   * - 没保存过 → `{ ok: true, steps: [], revision: 0 }`（正常状态，不是错误）；
   * - 不可用（坏 JSON / 版本不认识 / 结构不合法）→ `{ ok: false, code: 'CORRUPT', reason }`，
   *   **绝不**修改或删除那条记录；
   * - 任务 ID 不是正整数 → `code: 'INVALID_TASK'`（根本不去拼键）。
   *
   * 这是**公开**的读取入口，所以父任务是否存在必须在这里检查，
   * 不能只靠界面手里的任务快照（它可能比数据库旧）。
   */
  async loadSteps(taskId: number): Promise<TaskStepsLoadResult> {
    if (!isValidTaskId(taskId)) {
      return { ok: false, code: 'INVALID_TASK', reason: PARENT_MISSING_MESSAGE, rawExcerpt: null }
    }
    const key = taskStepsKey(taskId)
    if (key === null) {
      return { ok: false, code: 'INVALID_TASK', reason: PARENT_MISSING_MESSAGE, rawExcerpt: null }
    }
    // 父任务不在：这条记录（如果有）是孤儿，不能当作用户的清单。
    const parent = await this.tasks.getById(taskId)
    if (!parent) {
      return { ok: false, code: 'PARENT_MISSING', reason: PARENT_MISSING_MESSAGE, rawExcerpt: null }
    }
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])
    if (!row) return { ok: true, steps: [], revision: 0 }
    const raw = String(row.value)
    const decoded = decodeTaskSteps(raw)
    /**
     * 记录里的 `taskId` 必须与**键里的**任务 ID 一致：否则这条记录是被拼出来的
     * （例如键被手工改过），把它当作这条任务的清单就会张冠李戴。
     */
    if (!decoded.ok || decoded.taskId !== taskId) {
      return { ok: false, code: 'CORRUPT', reason: TASK_STEPS_UNREADABLE_REASON, rawExcerpt: excerptOf(raw) }
    }
    return { ok: true, steps: decoded.steps, revision: decoded.revision }
  }

  /**
   * 保存（或替换）某个任务的步骤清单 —— **唯一会写库的入口**。
   *
   * 步骤（**全部在同一个事务里**，任何一步失败都一个字节都不写）：
   * 1. 校验父任务 ID 与整份步骤（标题 1–120 字、最多 30 步、ID 不重复）；
   * 2. 事务里确认父任务**仍然存在**：不存在 → 拒绝（零写入）；
   * 3. 事务里读既有记录：坏 JSON / 结构不合法 → 拒绝（不覆盖用户的数据）；
   * 4. 版本比对：`expectedRevision` 与库里不一致 → 拒绝，并回传**当前版本号**
   *    让界面能明确提示「别处有更新、请载入最新」；
   * 5. 写入（版本 +1），再读回校验；读回失败时如实返回 `readbackError`（写入已提交）。
   *
   * 注意：保存步骤**不会**碰 `tasks` 表的任何字段 —— 父任务的状态、DDL、
   * 预计用时都不会因为「步骤全做完了」而改变。
   */
  async saveSteps(input: SaveTaskStepsInput): Promise<SaveTaskStepsResult> {
    const taskId = input?.taskId
    if (!isValidTaskId(taskId)) {
      return { ok: false, committed: false, revision: null, reason: PARENT_MISSING_MESSAGE, readbackError: null }
    }
    const key = taskStepsKey(taskId)
    if (key === null) {
      return { ok: false, committed: false, revision: null, reason: PARENT_MISSING_MESSAGE, readbackError: null }
    }
    /**
     * **不**给缺失的 `steps` 补 `[]`：`[]` 是「用户显式清空」的合法输入，
     * 而「没传 steps / 传了 null」是畸形调用。两者混为一谈会让一次畸形保存
     * 悄悄把用户已经保存的整份清单清掉。这里要求 `steps` 真的是数组，
     * 显式的空数组仍然原样通过。
     */
    const validation = validateTaskSteps(input?.steps)
    if (!validation.ok) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: validation.reason ?? MALFORMED_MESSAGE,
        readbackError: null,
      }
    }
    const steps = validation.steps
    const expectedRevision = input.expectedRevision

    let committedRevision: number | null = null
    let rejection: SaveTaskStepsResult | null = null

    try {
      await this.db.withTransactionAsync(async () => {
        // 1) 事务里确认父任务还在（否则清单一写完就成了孤儿记录）。
        const parent = await this.tasks.getById(taskId)
        if (!parent) {
          rejection = { ok: false, committed: false, revision: null, reason: PARENT_MISSING_MESSAGE, readbackError: null }
          return
        }
        // 2) 读既有记录（破损即拒绝，绝不覆盖）。
        const record = await this.readRecord(key, taskId)
        if (record.kind === 'corrupt') {
          rejection = { ok: false, committed: false, revision: null, reason: CORRUPT_MESSAGE, readbackError: null }
          return
        }
        const existingRevision = record.kind === 'valid' ? record.revision : 0
        // 3) 乐观版本：把库里的版本号一起回传，界面才能给出「载入最新」的出路。
        if (existingRevision !== expectedRevision) {
          rejection = {
            ok: false,
            committed: false,
            revision: existingRevision,
            reason: CONFLICT_MESSAGE,
            readbackError: null,
          }
          return
        }
        // 4) 写入（只存规范结构；版本 +1）。
        const nextRevision = existingRevision + 1
        await this.db.runAsync(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [key, encodeTaskSteps(taskId, nextRevision, steps), this.now().toISOString()],
        )
        committedRevision = nextRevision
      })
    } catch (cause) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: `保存步骤失败：${cause instanceof Error ? cause.message : String(cause)}`,
        readbackError: null,
      }
    }

    if (rejection) return rejection
    if (committedRevision === null) {
      return { ok: false, committed: false, revision: null, reason: '保存没有完成，请再试一次。', readbackError: null }
    }

    // 写入已经提交 → 明确读回一次；读回失败也**不**改写「已提交」这个事实。
    try {
      const readBack = await this.loadSteps(taskId)
      if (!readBack.ok) {
        return { ok: true, committed: true, revision: committedRevision, reason: null, readbackError: readBack.reason }
      }
      return { ok: true, committed: true, revision: committedRevision, reason: null, readbackError: null }
    } catch (cause) {
      return {
        ok: true,
        committed: true,
        revision: committedRevision,
        reason: null,
        readbackError: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }

  /**
   * 任务被删除时，**只删它自己那一个键**（`task_steps.<id>`）。
   *
   * 刻意不做任何前缀批量删除：`LIKE 'task_steps.%'` 那种写法一旦条件写错，
   * 就会连带删掉别的任务的清单。这里键是精确拼出来的正整数 ID，删不到别处。
   *
   * 由 {@link TaskRepository.remove} 在**同一个事务里**调用，
   * 因此「任务删掉了、清单还留着」这种半成品状态不会出现。
   */
  async removeStepsForTask(taskId: number): Promise<number> {
    const key = taskStepsKey(taskId)
    if (key === null) return 0
    const result = await this.db.runAsync('DELETE FROM app_settings WHERE key = ?;', [key])
    return result.changes
  }

  /** 读一条记录并判定它的状态（不写库）。 */
  private async readRecord(key: string, taskId: number): Promise<StepRecord> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [key])
    if (!row) return { kind: 'missing' }
    const decoded = decodeTaskSteps(String(row.value))
    if (!decoded.ok || decoded.taskId !== taskId) return { kind: 'corrupt' }
    return { kind: 'valid', revision: decoded.revision, steps: decoded.steps }
  }
}

/**
 * 确保 `app_settings` 键值表存在（与 `AppSettingsRepository.ensureDailyPlanStorage` 同一句 SQL）。
 *
 * 只做 `CREATE TABLE IF NOT EXISTS`，不删列、不改列、不动任何一行数据。
 * **只应该在启动引导里调用**：正常读取路径绝不建表、绝不写库。
 */
export async function ensureTaskStepsStorage(db: SqliteDatabase): Promise<void> {
  await db.execAsync(APP_SETTINGS_SQL)
}
