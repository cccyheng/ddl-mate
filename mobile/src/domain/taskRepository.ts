/**
 * 任务仓库：所有 SQL 都走**参数化绑定**，不做字符串拼接。
 *
 * - 新建/更新走 `normalizeTaskDraft`，非法日期永远到不了数据库；
 * - `completed_at` 只在状态变为 DONE 时写入，改回未完成会清空；
 * - 删除任务会级联删除它的来源文本（`task_sources`），这是唯一会丢数据的写操作，
 *   UI 必须在调用前做二次确认；
 * - `listAll()` 返回真实数据，仓库**不会**插入任何示例任务。
 */

import {
  compareByDeadline,
  deadlineToEpochMs,
  deadlineToShanghaiDateKey,
  shanghaiToday,
} from '../domain/datetime'
import { NotFoundError, ValidationError } from '../domain/errors'
import { normalizeTaskDraft, type NormalizedTask } from '../domain/taskDraft'
import type { Task, TaskDraft, TaskSource, TaskStatus } from '../domain/types'
import type { SqlValue, SqliteDatabase } from '../db/types'

/**
 * 写入结果。
 *
 * 关键点是 `committed`：事务一旦提交就为 true，即使随后的「读回」失败也不会变回 false。
 * 界面必须据此区分两种情况：
 * - `committed: false` → 抛出异常，真的没写进去，可以重试保存；
 * - `committed: true` 但 `task` 为 null → **已经保存成功**，只是读不回来，
 *   只提示刷新，绝不能引导用户再点一次保存（否则会产生重复任务）。
 */
export interface SaveOutcome {
  kind: 'insert' | 'update'
  id: number
  task: Task | null
  committed: boolean
  readbackError: Error | null
}

interface TaskRow {
  id: number
  title: string
  description: string | null
  course_id: number | null
  type: string
  status: string
  priority: number
  deadline: string | null
  estimated_minutes: number | null
  submit_requirement: string | null
  submit_method: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

interface SourceRow {
  id: number
  task_id: number
  kind: string
  raw_text: string
  created_at: string
}

function toTask(row: TaskRow): Task {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    courseId: row.course_id === null ? null : Number(row.course_id),
    type: row.type as Task['type'],
    status: row.status as TaskStatus,
    priority: Number(row.priority) as Task['priority'],
    deadline: row.deadline,
    estimatedMinutes: row.estimated_minutes === null ? null : Number(row.estimated_minutes),
    submitRequirement: row.submit_requirement,
    submitMethod: row.submit_method,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSource(row: SourceRow): TaskSource {
  return {
    id: Number(row.id),
    taskId: Number(row.task_id),
    kind: row.kind as TaskSource['kind'],
    rawText: row.raw_text,
    createdAt: row.created_at,
  }
}

export interface TaskListOptions {
  keyword?: string
  courseId?: number | null
  status?: TaskStatus | 'OPEN' | 'ALL'
  includeDone?: boolean
  orderBy?: 'deadline' | 'created' | 'priority'
}

const TASK_COLUMNS = `id, title, description, course_id, type, status, priority, deadline,
  estimated_minutes, submit_requirement, submit_method, completed_at, created_at, updated_at`

export class TaskRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date
  /**
   * 删除任务时要**在同一个事务里**一起清理的「任务专属数据」。
   *
   * 目前只有任务步骤清单（存在 `app_settings` 的 `task_steps.<id>` 键里）。
   * 为什么不在这里直接写 `DELETE FROM app_settings`：
   * - 任务仓库不该知道键值表里都有哪些键（那是设置 / 步骤模块的知识）；
   * - 由 store 注入「精确删这一个键」的闭包，既保证原子性，
   *   又不会出现 `LIKE 'task_steps.%'` 那种可能误删别处的批量删除。
   *
   * 默认 `null` = 不清理（行为与以前完全一致，既有测试与调用点不受影响）；
   * store 引导时会用 {@link setRemoveCleanup} 装上真实的清理动作。
   */
  private cleanupOnRemove: ((taskId: number) => Promise<unknown>) | null

  // 显式字段赋值，不用 TypeScript 的参数属性（`constructor(private x)`）：
  // 参数属性是**需要真正转译**的语法，Node 的 strip-only 模式不支持，
  // 写成显式赋值后源码就能被 Node 直接加载，测试因此不需要额外的构建步骤。
  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
    this.cleanupOnRemove = null
  }

  /**
   * 装上「删任务时要一起清掉的任务专属数据」。
   *
   * 只应该在数据库引导里调用一次；传入的函数会在 {@link remove} 的事务**内部**执行，
   * 因此它要么和任务行一起成功，要么一起回滚。
   */
  setRemoveCleanup(cleanup: ((taskId: number) => Promise<unknown>) | null): void {
    this.cleanupOnRemove = cleanup
  }

  /** 全部任务（真实数据，无示例）。 */
  async listAll(): Promise<Task[]> {
    const rows = await this.db.getAllAsync<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks ORDER BY id ASC;`)
    return rows.map(toTask)
  }

  async list(options: TaskListOptions = {}): Promise<Task[]> {
    const clauses: string[] = []
    const params: SqlValue[] = []

    const keyword = options.keyword?.trim()
    if (keyword) {
      clauses.push('(title LIKE ? OR IFNULL(description, \'\') LIKE ?)')
      const like = `%${keyword}%`
      params.push(like, like)
    }
    if (options.courseId !== undefined && options.courseId !== null) {
      clauses.push('course_id = ?')
      params.push(options.courseId)
    }
    const status = options.status ?? 'ALL'
    if (status === 'OPEN') {
      clauses.push("status IN ('TODO','DOING')")
    } else if (status !== 'ALL') {
      clauses.push('status = ?')
      params.push(status)
    } else if (!options.includeDone) {
      clauses.push("status <> 'CANCELLED'")
    }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    const order =
      options.orderBy === 'created'
        ? 'created_at DESC, id DESC'
        : options.orderBy === 'priority'
          ? 'priority DESC, id DESC'
          : // 截止时间不能交给 SQL 字符串排序：裸日期表示「当天结束」，
            // 而 `23:59:59.999` 这样的精确时刻必须排在它前面。统一取回后用
            // `compareByDeadline` 比较（同一时刻再按 id 稳定排序）。
            'id ASC'

    const rows = await this.db.getAllAsync<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks${where} ORDER BY ${order};`,
      params,
    )
    const tasks = rows.map(toTask)
    if (options.orderBy === undefined || options.orderBy === 'deadline') {
      tasks.sort((a, b) => compareByDeadline(a, b) || a.id - b.id)
    }
    return tasks
  }

  async getById(id: number): Promise<Task | null> {
    const row = await this.db.getFirstAsync<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?;`, [id])
    return row ? toTask(row) : null
  }

  /**
   * 指定自然日（北京时间）截止的未取消任务，按时间升序。
   *
   * 只到日期的 DDL 也归到它自己的那一天，并按「当天结束」参与排序。
   */
  async listByShanghaiDate(dateKey: string): Promise<Task[]> {
    const all = await this.listAll()
    return all
      .filter((task) => task.status !== 'CANCELLED' && task.deadline && deadlineToShanghaiDateKey(task.deadline) === dateKey)
      .sort((a, b) => (deadlineToEpochMs(a.deadline) ?? 0) - (deadlineToEpochMs(b.deadline) ?? 0))
  }

  async listToday(): Promise<Task[]> {
    return this.listByShanghaiDate(shanghaiToday(this.now()))
  }

  /**
   * 新建任务，返回入库结果。
   *
   * **原子性**：任务行与它的原始文本（`task_sources`）必须**同一个事务**写入。
   * 之前的实现分成两条独立语句，若原文写入失败会留下一个「没有原文的孤儿任务」，
   * 而调用方已经收到异常、以为保存失败 → 用户重试就可能产生重复任务。
   * 现在任一步失败都会整体回滚，库里不会留下半成品。
   *
   * **提交后读回失败不再伪装成「保存失败」**：事务已经提交时，
   * `committed` 为 true 且返回新记录的 id，界面据此提示「已保存」并只重试刷新，
   * 不会引导用户再点一次保存造成重复任务。
   */
  async create(draft: TaskDraft): Promise<SaveOutcome> {
    let newId = 0
    await this.db.withTransactionAsync(async () => {
      newId = await this.createWithinTransaction(draft)
    })

    return this.readbackOrRepair(newId, 'insert', '新建')
  }

  /**
   * 在**调用方已经开启的事务内部**按同一套规范插入一条任务（含原始文本）。
   *
   * 为什么需要它：重复任务生成必须把「规则 + 多条任务 + 生成账本」放在
   * **一个** SQLite 事务里，任何一步失败都整体回滚；而 {@link create} 自己会
   * `withTransactionAsync`，事务里再调它会形成嵌套事务（SQLite 不允许）。
   *
   * 约定：调用方必须已经处于事务中；本方法**不**开启事务、不做提交后读回。
   * 校验与写入内容与 {@link create} 共用，避免两条创建路径漂移。
   */
  async createWithinTransaction(draft: TaskDraft): Promise<number> {
    const normalized = normalizeTaskDraft(draft)
    const nowIso = this.now().toISOString()
    const status = normalized.status
    const completedAt = status === 'DONE' ? nowIso : null

    const result = await this.db.runAsync(
      `INSERT INTO tasks
        (title, description, course_id, type, status, priority, deadline,
         estimated_minutes, submit_requirement, submit_method, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        normalized.title,
        normalized.description,
        normalized.courseId,
        normalized.type,
        status,
        normalized.priority,
        normalized.deadline,
        normalized.estimatedMinutes,
        normalized.submitRequirement,
        normalized.submitMethod,
        completedAt,
        nowIso,
        nowIso,
      ],
    )

    const newId = result.lastInsertRowId

    // 用户填了原文就必须保存；是否与 description 相同是无关的判断。
    if (normalized.originalText) {
      await this.insertSource(newId, normalized.originalText)
    }
    return newId
  }

  /**
   * 全量更新（编辑页保存）。任务行与补写的原文同样在一个事务里。
   *
   * 原文的规则是**显式**的，不再靠「和 description 比字符串」这种巧合判断：
   * - 还没有留存原文 → 用户这次填的原文会被保存；
   * - 已经留存原文 → 界面上该字段是只读的；若仍然传来不同的文本，
   *   宁可报错也不静默丢弃用户输入（需要补充请用 `appendOriginalText`）。
   */
  async update(id: number, draft: TaskDraft): Promise<SaveOutcome> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`任务 #${id} 不存在（可能已被删除）。`)

    const normalized = normalizeTaskDraft(draft)
    const nowIso = this.now().toISOString()
    const completedAt = normalized.status === 'DONE' ? (existing.completedAt ?? nowIso) : null

    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync(
        `UPDATE tasks SET
           title = ?, description = ?, course_id = ?, type = ?, status = ?, priority = ?, deadline = ?,
           estimated_minutes = ?, submit_requirement = ?, submit_method = ?, completed_at = ?, updated_at = ?
         WHERE id = ?;`,
        [
          normalized.title,
          normalized.description,
          normalized.courseId,
          normalized.type,
          normalized.status,
          normalized.priority,
          normalized.deadline,
          normalized.estimatedMinutes,
          normalized.submitRequirement,
          normalized.submitMethod,
          completedAt,
          nowIso,
          id,
        ],
      )

      if (normalized.originalText) {
        const stored = await this.getOriginalSource(id)
        if (!stored) {
          // 之前没有原文 → 这是首次留档，保存。
          await this.insertSource(id, normalized.originalText)
        } else if (stored.rawText !== normalized.originalText) {
          // 已有原文且内容不同 → 绝不静默丢弃用户这次输入，明确报错。
          throw new ValidationError('这条任务已经留存了原始通知文本。', {
            originalText: '已有留存原文，不能覆盖；如需补充请使用「追加原文」。',
          })
        }
      }
    })

    return this.readbackOrRepair(id, 'update', '保存')
  }

  /**
   * 提交后读回。读回失败时**不谎报保存失败**：返回已知的已提交 id，
   * 让界面提示「已保存，但列表刷新失败」并提供只刷新不重存的恢复路径。
   */
  private async readbackOrRepair(id: number, operation: 'insert' | 'update', label: string): Promise<SaveOutcome> {
    try {
      const task = await this.getById(id)
      if (task) return { kind: operation, id, task, committed: true, readbackError: null }
      return {
        kind: operation,
        id,
        task: null,
        committed: true,
        readbackError: new NotFoundError(`任务 #${id} ${label}后读不回来。`),
      }
    } catch (cause) {
      return {
        kind: operation,
        id,
        task: null,
        committed: true,
        readbackError:
          cause instanceof Error ? cause : new Error(`${label}已提交，但读回失败：${String(cause)}`),
      }
    }
  }

  /** 只改状态（列表上的完成/取消勾选）。 */
  async changeStatus(id: number, status: TaskStatus): Promise<Task> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`任务 #${id} 不存在（可能已被删除）。`)
    const nowIso = this.now().toISOString()
    const completedAt = status === 'DONE' ? (existing.completedAt ?? nowIso) : null
    await this.db.runAsync('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?;', [
      status,
      completedAt,
      nowIso,
      id,
    ])
    const updated = await this.getById(id)
    if (!updated) throw new NotFoundError(`任务 #${id} 状态更新后无法读回。`)
    return updated
  }

  /** 在「已完成」与「待办」之间切换；进行中/已取消会回到待办。 */
  async toggleComplete(id: number): Promise<Task> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`任务 #${id} 不存在（可能已被删除）。`)
    return this.changeStatus(id, existing.status === 'DONE' ? 'TODO' : 'DONE')
  }

  /**
   * 删除任务（级联删除来源文本 + **在同一个事务里**清理任务专属数据）。UI 必须已做二次确认。
   *
   * 以前的实现是一条独立的 `DELETE FROM tasks`：来源文本靠外键级联删除没问题，
   * 但**任务步骤清单存在 `app_settings` 里，不受外键约束**，
   * 于是「任务删掉了、它的步骤键还留着」会变成一条永远读不到的孤儿记录。
   * 现在整件事在一个事务里：要么任务、来源文本、步骤键一起消失，要么一个都不动。
   *
   * 任务不存在时（`changes === 0`）与以前一样抛 `NotFoundError`，**不会**顺手去删那条键。
   */
  async remove(id: number): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      const result = await this.db.runAsync('DELETE FROM tasks WHERE id = ?;', [id])
      if (result.changes === 0) throw new NotFoundError(`任务 #${id} 不存在（可能已被删除）。`)
      if (this.cleanupOnRemove) await this.cleanupOnRemove(id)
    })
  }

  async addSource(taskId: number, rawText: string, kind: TaskSource['kind'] = 'ORIGINAL_TEXT'): Promise<TaskSource> {
    const text = rawText.trim()
    if (text.length === 0) throw new ValidationError('原始文本不能为空。', { rawText: '请填写要留存的原文。' })
    return this.insertSource(taskId, text, kind)
  }

  /**
   * 在**已有原文之后**追加一段文本（例如后来又收到一条通知）。
   *
   * 这是「不覆盖已有原文、也不丢弃新输入」的显式入口：追加成一条新的来源记录，
   * 旧记录原样保留。与 `update` 里的只读保护配套使用。
   */
  async appendOriginalText(taskId: number, additionalText: string): Promise<TaskSource> {
    const text = additionalText.trim()
    if (text.length === 0) throw new ValidationError('追加的原文不能为空。', { rawText: '请填写要追加的原文。' })
    const existing = await this.getById(taskId)
    if (!existing) throw new NotFoundError(`任务 #${taskId} 不存在（可能已被删除）。`)
    return this.insertSource(taskId, text, 'MANUAL')
  }

  /**
   * 纯写入：不做校验，供 `create` / `update` 在**事务内部**调用。
   * 校验统一放在 `addSource` 或调用方（`normalizeTaskDraft`）里完成。
   */
  private async insertSource(
    taskId: number,
    rawText: string,
    kind: TaskSource['kind'] = 'ORIGINAL_TEXT',
  ): Promise<TaskSource> {
    const nowIso = this.now().toISOString()
    const result = await this.db.runAsync(
      'INSERT INTO task_sources (task_id, kind, raw_text, created_at) VALUES (?, ?, ?, ?);',
      [taskId, kind, rawText, nowIso],
    )
    return { id: result.lastInsertRowId, taskId, kind, rawText, createdAt: nowIso }
  }

  async listSources(taskId: number): Promise<TaskSource[]> {
    const rows = await this.db.getAllAsync<SourceRow>(
      'SELECT id, task_id, kind, raw_text, created_at FROM task_sources WHERE task_id = ? ORDER BY id ASC;',
      [taskId],
    )
    return rows.map(toSource)
  }

  async getOriginalSource(taskId: number): Promise<TaskSource | null> {
    const row = await this.db.getFirstAsync<SourceRow>(
      "SELECT id, task_id, kind, raw_text, created_at FROM task_sources WHERE task_id = ? AND kind = 'ORIGINAL_TEXT' ORDER BY id ASC LIMIT 1;",
      [taskId],
    )
    return row ? toSource(row) : null
  }

  /** 每个任务的来源原文（任务详情页一次取全，避免 N+1 查询）。 */
  async listAllOriginalSources(): Promise<Map<number, string>> {
    const rows = await this.db.getAllAsync<SourceRow>(
      "SELECT id, task_id, kind, raw_text, created_at FROM task_sources WHERE kind = 'ORIGINAL_TEXT' ORDER BY id ASC;",
    )
    const map = new Map<number, string>()
    for (const row of rows) {
      const taskId = Number(row.task_id)
      if (!map.has(taskId)) map.set(taskId, row.raw_text)
    }
    return map
  }

  /** 统计（真实计数，供首页展示）。 */
  async countAll(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM tasks;')
    return Number(row?.count ?? 0)
  }
}

export type { NormalizedTask }
