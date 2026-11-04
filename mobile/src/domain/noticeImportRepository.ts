/**
 * 通知原文 → 待办任务：**一次事务写完整批**的仓库。
 *
 * 与 `ScheduleImportRepository` 同一套纪律，针对这条流程再加三条：
 *
 * 1. **只在用户点「保存」时写库**：解析、勾选、编辑全程零写入；
 * 2. **原子**：整批任务行 + 它们的原始通知原文（`task_sources`）都在**一个事务**里，
 *    任何一步失败整批回滚 —— 不会出现「原文没写进去、任务却留下了」的半成品，
 *    也不会出现「写了一半、界面还说失败」；
 * 3. **幂等**：重复点保存、提交成功后重试、把同一份原文再导入一次，
 *    只跳过**原文 + 全部有意义字段都完全相同**的那些行；
 *    同标题但截止时间 / 课程 / 提交要求 / 原文不同的，**照旧新建**。
 *
 * 刻意**不**在循环里调用 `TaskRepository.create`：它每次都会自己开一个事务，
 * 30 行就是 30 个事务，中途失败会留下半批数据。这里复用 `normalizeTaskDraft`
 * 与同一套列清单，在一个事务里批量插入。
 *
 * 提交后读回失败**绝不谎报「没保存」**：`committed: true` + `readbackError`，
 * 界面据此提示「已经保存，只是列表没刷新」，并且**不允许**再点一次保存。
 */

import { NotFoundError, ValidationError } from './errors'
import { MAX_NOTICE_SOURCE_CHARS, MAX_NOTICE_TASKS, noticeRowToTaskDraft, type NoticeImportRow } from './noticeImport'
import { normalizeTaskDraft, type NormalizedTask } from './taskDraft'
import type { Task, TaskDraft, TaskPriority, TaskType } from './types'
import type { SqlValue, SqliteDatabase } from '../db/types'

const TASK_COLUMNS = `id, title, description, course_id, type, status, priority, deadline,
  estimated_minutes, submit_requirement, submit_method, completed_at, created_at, updated_at`

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

export interface NoticeImportRequest {
  /**
   * 用户粘贴的**完整原文**（含消息头）。
   *
   * 会原样写进每一条新建任务的 `task_sources`（`ORIGINAL_TEXT`），
   * 关掉 App 再打开仍然读得回来。
   */
  sourceText: string
  /** 勾选并可能编辑过的候选行（未勾选的行完全不参与校验与写入）。 */
  rows: readonly NoticeImportRow[]
  /** 可选：来源名称（界面展示用，不参与判定）。 */
  sourceName?: string
  /** 覆盖单次上限（测试用；默认 {@link MAX_NOTICE_TASKS}）。 */
  maxTasks?: number
  /** 覆盖原文字数上限（测试用；默认 {@link MAX_NOTICE_SOURCE_CHARS}）。 */
  maxSourceChars?: number
}

/** 本次真正新建的一条任务（含它自己那一段原文）。 */
export interface NoticeImportCreated {
  task: Task
  /** 这条任务的来源段原文（读回失败时为 `null`）。 */
  taskId: number
  taskNumber: number
  segmentText: string
}

/** 因为「原文 + 全部字段完全一致」被跳过的行。 */
export interface NoticeImportDuplicate {
  taskNumber: number
  title: string
  /** 已存在的那条任务 id（可能是本批前面刚建的，也可能是库里早就有的）。 */
  existingTaskId: number | null
  segmentText: string
}

export interface NoticeImportRejection {
  taskNumber: number
  message: string
}

export interface NoticeImportOutcome {
  /** 本次新建的任务（顺序与勾选顺序一致）。 */
  created: NoticeImportCreated[]
  /** 新建出来的任务 id（即使读回失败也在）。 */
  createdIds: number[]
  /** 被跳过的完全重复行数。 */
  duplicateCount: number
  duplicates: NoticeImportDuplicate[]
  /** 明显的拒绝（例如原文字数超限时逐行说明）。 */
  rejected: NoticeImportRejection[]
  /** 是否已经提交；`true` 之后**任何情况下都不允许重试保存**。 */
  committed: boolean
  /** 提交后的读回错误（提交仍然成功，只是列表暂时读不回来）。 */
  readbackError: Error | null
}

interface PreparedRow {
  taskNumber: number
  normalized: NormalizedTask
  /** 写进 `task_sources` 的原文（完整原文，不截断）。 */
  sourceText: string
  segmentText: string
  dedupeKey: string
  /**
   * 已经存在完全一致的记录时，这里是被跳过的原因（已存在的那条任务 id，本批内重复则为 `null`）。
   * `undefined` = 本行需要写入。
   */
  skipBecauseOf?: number | null
}

/**
 * 去重键：**原文 + 全部有意义字段**。
 *
 * 三条硬约束（独立复核点名）：
 *  1. 用 `JSON.stringify` 序列化**元组**，不用「拼一个带分隔符的字符串」：
 *     用户原文里完全可能出现 `|`、换行甚至 NUL，拼接键会让不同内容撞成同一个键；
 *  2. **不含生命周期字段**（`status` / `completedAt`）：用户把导入的任务标记成「已完成」
 *     之后再导入同一份原文，必须**跳过**这条已有任务，而不是再建一条 TODO 把它「复活」；
 *  3. **含原文本身**：同一段文字但原文不同的两次导入要各自保留（只看标题会误合并）。
 *
 * **原文只取一份口径**：写库时留档的是**逐字**原文（含前后空白），
 * 但去重比较时两边都用 `normalizedOriginalText`（`trim` 之后那一条）——
 * 这样「写入时算出的键」与「从库里读回时算出的键」永远一致，
 * 不会因为一边 trim、一边不 trim 而永远判定「不重复」（独立复核复现过）。
 *
 * 有意义的字段：原文、标题、说明、课程、类型、优先级、截止时间、预计用时、提交要求、提交方式。
 * 优先级与预计用时是用户能改的真实字段，所以**留在键里**：改了优先级就是另一条任务。
 */
function dedupeKeyOf(sourceText: string, normalizedOriginalText: string | null, normalized: DedupeFields): string {
  return JSON.stringify([
    sourceText,
    normalized.title,
    normalized.description ?? '',
    normalized.courseId,
    normalized.type,
    normalized.priority,
    normalized.deadline ?? '',
    normalized.estimatedMinutes,
    normalized.submitRequirement ?? '',
    normalized.submitMethod ?? '',
    normalizedOriginalText ?? '',
  ])
}

/** `dedupeKeyOf` 需要的那几个字段（`NormalizedTask` 与数据库行都能满足）。 */
interface DedupeFields {
  title: string
  description: string | null
  courseId: number | null
  type: TaskType
  /** 注意：`status` / `completedAt` **刻意不在**去重键里（见 `dedupeKeyOf` 的说明）。 */
  priority: TaskPriority
  deadline: string | null
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
}

function toTask(row: TaskRow): Task {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    courseId: row.course_id === null ? null : Number(row.course_id),
    type: row.type as Task['type'],
    status: row.status as Task['status'],
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

export class NoticeImportRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date
  /**
   * 正在进行的导入。
   *
   * 仓库层也自己拦一次「同一实例上的并发导入」：store 里已经串行化了，
   * 但如果将来有别的调用方（脚本 / 测试 / 新界面）绕过队列直接调用，
   * 两次 import 会各自读到「提交前的库」，幂等判定双双落空、写出重复任务。
   * 这里宁可明确报错也不冒重复写入的风险。
   */
  private inFlight = false

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
  }

  /**
   * 把勾选的候选一次性写进本机 SQLite。
   *
   * 抛 `ValidationError` 时**一定什么都没写**（校验全在 `BEGIN` 之前完成），
   * 界面据此保留用户改好的内容让用户重试。
   */
  async importNoticeCandidates(request: NoticeImportRequest): Promise<NoticeImportOutcome> {
    if (this.inFlight) {
      throw new ValidationError('上一次保存还没有结束，本次没有写入任何数据。', {
        selection: '请等这次保存结束后再点。',
      })
    }
    this.inFlight = true
    try {
      return await this.runImport(request)
    } finally {
      this.inFlight = false
    }
  }

  private async runImport(request: NoticeImportRequest): Promise<NoticeImportOutcome> {
    const sourceText = String(request?.sourceText ?? '')
    const maxTasks = Number.isInteger(request?.maxTasks) ? Math.max(1, Number(request?.maxTasks)) : MAX_NOTICE_TASKS
    const maxSourceChars = Number.isInteger(request?.maxSourceChars)
      ? Math.max(1, Number(request?.maxSourceChars))
      : MAX_NOTICE_SOURCE_CHARS
    const rows = request?.rows ?? []
    const selected = rows.filter((row) => row?.selected)

    if (selected.length === 0) {
      throw new ValidationError('没有勾选任何要保存的候选项，本次没有写入任何数据。', {
        selection: '请至少勾选一条候选，或先取消这次导入。',
      })
    }
    if (selected.length > maxTasks) {
      throw new ValidationError(
        `一次最多保存 ${maxTasks} 条待办（当前勾选 ${selected.length} 条），本次没有写入任何数据。`,
        { selection: `请先取消勾选 ${selected.length - maxTasks} 条，再保存。` },
      )
    }
    // 注意：这里**只**用 trim 判断「是不是空」，绝不 trim 之后再写库 ——
    // 用户粘贴时带的前后空白与消息头都属于原文本身，必须逐字留档（独立复核点名）。
    if (sourceText.trim().length === 0) {
      throw new ValidationError('原文是空的，本次没有写入任何数据。', {
        sourceText: '请先粘贴通知原文，再点「提取任务」。',
      })
    }
    const lengthError =
      sourceText.length > maxSourceChars
        ? `原文 ${sourceText.length} 字，超过单次上限 ${maxSourceChars} 字：请分成两次导入，应用不会替你截断原文。`
        : null
    if (lengthError) {
      throw new ValidationError(lengthError, { sourceText: lengthError })
    }

    const courseIds = await this.loadCourseIds()

    // 1) 整批纯校验：任何一行不合法，整批都不写，并把行号告诉界面。
    const prepared: PreparedRow[] = []
    const fieldErrors: Record<string, string> = {}
    for (const row of selected) {
      const rowKey = (field: string): string => `row:${row.rowIndex}:${field}`
      const draft = rowToDraft(row, sourceText)
      if (row.courseMissing) {
        fieldErrors[rowKey('courseId')] =
          `第 ${row.rowIndex} 行：解析时关联的课程在本机已经找不到了，请重新选择课程或改成「不关联课程」。`
        continue
      }
      if (row.courseId !== null && !courseIds.has(row.courseId)) {
        fieldErrors[rowKey('courseId')] =
          `第 ${row.rowIndex} 行：选择的课程在本机已经找不到了（可能刚被删除），请重新选择课程。`
        continue
      }
      let normalized: NormalizedTask
      try {
        // 通知导入仍要求精确到分钟：只有日期没有时刻的候选不在这里放宽。
        normalized = normalizeTaskDraft(draft, { allowDateOnly: false })
      } catch (cause) {
        if (!(cause instanceof ValidationError)) throw cause
        for (const [field, message] of Object.entries(cause.fields)) {
          fieldErrors[rowKey(field)] = `第 ${row.rowIndex} 行：${message}`
        }
        continue
      }
      prepared.push({
        taskNumber: row.rowIndex,
        normalized,
        sourceText,
        segmentText: String(row.segmentText ?? ''),
        // 写入与读回必须用同一份「原文口径」：这里用 `normalizeTaskDraft` 归一化后的原文
        // （即 `trim` 后的那一条），与 `loadExistingKeys` 的算法完全一致。
        dedupeKey: dedupeKeyOf(sourceText, normalized.originalText, normalized),
      })
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new ValidationError('导入内容还有问题需要修改，本次没有写入任何数据。', fieldErrors)
    }

    // 2) 去重判定：库里已有的 + 本批刚写入的（同一个事务里读不到刚插入的行，必须显式维护）。
    // 只跳过**原文与全部有意义字段完全一致**的行；同标题但时间 / 课程 / 提交要求 / 原文不同的照旧新建。
    const existingKeys = await this.loadExistingKeys()
    const duplicates: NoticeImportDuplicate[] = []
    for (const preparedRow of prepared) {
      const known = existingKeys.get(preparedRow.dedupeKey)
      if (known === undefined) {
        existingKeys.set(preparedRow.dedupeKey, null)
        continue
      }
      preparedRow.skipBecauseOf = known
      duplicates.push({
        taskNumber: preparedRow.taskNumber,
        title: preparedRow.normalized.title,
        existingTaskId: known,
        segmentText: preparedRow.segmentText,
      })
    }

    const toWrite = prepared.filter((preparedRow) => preparedRow.skipBecauseOf === undefined)

    // 3) 单事务写入：任务行 + 它的原文，一起成功或一起回滚。
    const nowIso = this.now().toISOString()
    const createdIds: number[] = []
    const createdMeta: Array<{ id: number; taskNumber: number; segmentText: string }> = []

    await this.db.execAsync('BEGIN IMMEDIATE;')
    try {
      for (const preparedRow of toWrite) {
        const inserted = await this.insertTask(preparedRow.normalized, nowIso)
        createdIds.push(inserted.lastInsertRowId)
        createdMeta.push({
          id: inserted.lastInsertRowId,
          taskNumber: preparedRow.taskNumber,
          segmentText: preparedRow.segmentText,
        })
        // 原文**逐字**留档：用用户粘贴的完整原文，而不是 `normalizeTaskDraft` 里
        // `trimOrNull` 之后的版本。前后空白与空行同样属于用户输入。
        if (preparedRow.sourceText.trim().length > 0) {
          await this.insertSource(inserted.lastInsertRowId, preparedRow.sourceText, nowIso)
        }
      }
      await this.db.execAsync('COMMIT;')
    } catch (cause) {
      try {
        await this.db.execAsync('ROLLBACK;')
      } catch {
        // 回滚失败不掩盖原始错误
      }
      // 回滚之后什么都没写：绝不谎报「已保存 N 条」，调用方可以安全重试。
      throw cause
    }

    return this.readback(createdIds, createdMeta, duplicates)
  }

  /** 现有的课程 id（外键保护：课程删掉之后不能把任务写到一个不存在的课程上）。 */
  private async loadCourseIds(): Promise<Set<number>> {
    const rows = await this.db.getAllAsync<{ id: number }>('SELECT id FROM courses;')
    return new Set(rows.map((row) => Number(row.id)))
  }

  /**
   * 库里已有的「原文 + 字段」指纹 → 任务 id。
   *
   * 把 `task_sources` 与任务行连起来读：任何一条历史任务只要原文与字段完全一致，
   * 这次的重复导入就会被跳过（不会堆第二条一模一样的任务）。
   */
  private async loadExistingKeys(): Promise<Map<string, number | null>> {
    const rows = await this.db.getAllAsync<{
      task_id: number
      raw_text: string
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
    }>(
      `SELECT s.task_id AS task_id, s.raw_text AS raw_text,
              t.title AS title, t.description AS description, t.course_id AS course_id,
              t.type AS type, t.status AS status, t.priority AS priority, t.deadline AS deadline,
              t.estimated_minutes AS estimated_minutes, t.submit_requirement AS submit_requirement,
              t.submit_method AS submit_method
         FROM task_sources s
         JOIN tasks t ON t.id = s.task_id;`,
    )
    const keys = new Map<string, number | null>()
    for (const row of rows) {
      const rawText = String(row.raw_text ?? '')
      const key = dedupeKeyOf(rawText, rawText.trim().length > 0 ? rawText.trim() : null, {
        title: row.title,
        description: row.description,
        courseId: row.course_id === null ? null : Number(row.course_id),
        type: row.type as TaskType,
        priority: Number(row.priority) as TaskPriority,
        deadline: row.deadline,
        estimatedMinutes: row.estimated_minutes === null ? null : Number(row.estimated_minutes),
        submitRequirement: row.submit_requirement,
        submitMethod: row.submit_method,
      })
      if (!keys.has(key)) keys.set(key, Number(row.task_id))
    }
    return keys
  }

  private async insertTask(normalized: NormalizedTask, nowIso: string): Promise<{ lastInsertRowId: number }> {
    const completedAt = normalized.status === 'DONE' ? nowIso : null
    return this.db.runAsync(
      `INSERT INTO tasks
        (title, description, course_id, type, status, priority, deadline,
         estimated_minutes, submit_requirement, submit_method, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
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
        nowIso,
      ] satisfies SqlValue[],
    )
  }

  private async insertSource(taskId: number, rawText: string, nowIso: string): Promise<void> {
    await this.db.runAsync(
      'INSERT INTO task_sources (task_id, kind, raw_text, created_at) VALUES (?, ?, ?, ?);',
      [taskId, 'ORIGINAL_TEXT', rawText, nowIso],
    )
  }

  /**
   * 提交后读回。
   *
   * 读回失败**不**改变「已经提交」这个事实：返回已知 id + `readbackError`，
   * 界面提示「已保存，只是列表没刷新」，并且不允许再点保存（否则会重复写入）。
   */
  private async readback(
    ids: readonly number[],
    meta: ReadonlyArray<{ id: number; taskNumber: number; segmentText: string }>,
    duplicates: readonly NoticeImportDuplicate[],
  ): Promise<NoticeImportOutcome> {
    const base = {
      createdIds: [...ids],
      duplicateCount: duplicates.length,
      duplicates: [...duplicates],
      rejected: [] as NoticeImportRejection[],
      committed: true,
    }
    try {
      const created: NoticeImportCreated[] = []
      for (const entry of meta) {
        const row = await this.db.getFirstAsync<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?;`, [entry.id])
        if (!row) {
          throw new NotFoundError(`任务 #${entry.id} 保存后读不回来。`)
        }
        created.push({ task: toTask(row), taskId: entry.id, taskNumber: entry.taskNumber, segmentText: entry.segmentText })
      }
      return { ...base, created, readbackError: null }
    } catch (cause) {
      return {
        ...base,
        created: [],
        readbackError: cause instanceof Error ? cause : new Error(`保存已提交，但读回失败：${String(cause)}`),
      }
    }
  }
}

/**
 * 行草稿 → `TaskDraft`：与界面上的校验用**同一个**口径（`noticeRowToTaskDraft`）。
 *
 * `originalText` 固定填**完整原文**（不是那一段）：原文是用户的正式输入，
 * 必须逐字留档，包含消息头。
 */
function rowToDraft(row: NoticeImportRow, sourceText: string): TaskDraft {
  return { ...noticeRowToTaskDraft(row), originalText: sourceText }
}
