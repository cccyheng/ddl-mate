/**
 * 课程与课表仓库。
 *
 * **删除保护是硬约束**：`removeCourse()` 默认拒绝删除仍被任务或课表引用的课程，
 * 抛 `CourseInUseError` 并把引用计数交给 UI 去显式确认；只有调用方传入
 * `{ confirmed: true }` 才会真正执行，且执行时：
 * - 课表随课程级联删除（课表脱离课程没有意义）；
 * - **任务全部保留**，只是 `course_id` 置空（`ON DELETE SET NULL`），
 *   绝不静默销毁用户的任务数据。
 */

import { NotFoundError, CourseInUseError, ValidationError } from '../domain/errors'
import {
  normalizeCourseDraft,
  normalizeScheduleDraft,
  type NormalizedCourse,
  type NormalizedSchedule,
} from '../domain/courseDraft'
import { allocateInternalCourseCode } from '../domain/courseImportCode'
import { weekdayName } from '../domain/datetime'
import { weekdayErrorKey } from '../domain/scheduleMultidayDraft'
import { isSameSessionSlot } from '../domain/scheduleSession'
import type { Course, CourseDraft, Schedule, ScheduleDraft } from '../domain/types'
import type { SqlValue, SqliteDatabase } from '../db/types'

interface CourseRow {
  id: number
  code: string
  name: string
  instructor: string | null
  semester: string | null
  color: string | null
  note: string | null
  selection_serial: string | null
  created_at: string
  updated_at: string
}

interface ScheduleRow {
  id: number
  course_id: number
  weekday: number
  start_time: string
  end_time: string
  location: string | null
  period_start: number | null
  period_end: number | null
  week_range: string | null
  semester_start_date: string | null
  start_week: number | null
  end_week: number | null
  week_pattern: string
  created_at: string
  updated_at: string
}

function toCourse(row: CourseRow): Course {
  return {
    id: Number(row.id),
    code: row.code,
    name: row.name,
    instructor: row.instructor,
    semester: row.semester,
    color: row.color,
    note: row.note,
    selectionSerial: row.selection_serial ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: Number(row.id),
    courseId: Number(row.course_id),
    weekday: Number(row.weekday),
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    periodStart: row.period_start === null ? null : Number(row.period_start),
    periodEnd: row.period_end === null ? null : Number(row.period_end),
    weekRange: row.week_range,
    semesterStartDate: row.semester_start_date,
    startWeek: row.start_week === null ? null : Number(row.start_week),
    endWeek: row.end_week === null ? null : Number(row.end_week),
    weekPattern: (row.week_pattern as Schedule['weekPattern']) ?? 'ALL',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const COURSE_COLUMNS = 'id, code, name, instructor, semester, color, note, selection_serial, created_at, updated_at'
const SCHEDULE_COLUMNS = `id, course_id, weekday, start_time, end_time, location, period_start, period_end,
  week_range, semester_start_date, start_week, end_week, week_pattern, created_at, updated_at`

export interface CourseReferences {
  courseId: number
  taskCount: number
  scheduleCount: number
  /** 是否有任何引用；true 时删除需要显式确认。 */
  blocked: boolean
}

export interface RemoveCourseOptions {
  /** UI 已完成二次确认，允许删除（任务保留、课表删除）。 */
  confirmed?: boolean
}

/** 多天课表的一次性保存计划：精确更新既有行 + 新增其它天。 */
export interface ScheduleBatchChange {
  updates?: ReadonlyArray<{ scheduleId: number; draft: ScheduleDraft }>
  creates?: ReadonlyArray<ScheduleDraft>
}

/**
 * 课表批量保存的写入结果（与任务仓库的 `SaveOutcome` 同一套口径）。
 *
 * 关键点是 `committed`：事务一旦提交就为 true，即使随后的「读回」失败也不会变回 false。
 * 界面必须据此区分：
 * - `committed: false` → 抛出异常，真的没写进去，可以重试保存；
 * - `committed: true` 但 `schedules` 为空 → **已经保存成功**，只是读不回来，
 *   只提示刷新，绝不引导用户再点一次保存（否则会重复插入整批课表）。
 */
export interface ScheduleBatchOutcome {
  kind: 'insert' | 'update' | 'mixed'
  /** 本次写入涉及的第一条课表 id（只用于报错定位）；纯新增且无 id 时为 0。 */
  id: number
  /** 本次真正写入并读回的课表行；提交成功但读回失败时为空数组。 */
  schedules: Schedule[]
  committed: boolean
  readbackError: Error | null
}

const EMPTY_SCHEDULES: Schedule[] = []

export class CourseRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date

  // 显式字段赋值，不用 TypeScript 参数属性（Node 的 strip-only 模式不支持该语法）。
  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
  }

  async listAll(): Promise<Course[]> {
    const rows = await this.db.getAllAsync<CourseRow>(`SELECT ${COURSE_COLUMNS} FROM courses ORDER BY name ASC, id ASC;`)
    return rows.map(toCourse)
  }

  async getById(id: number): Promise<Course | null> {
    const row = await this.db.getFirstAsync<CourseRow>(`SELECT ${COURSE_COLUMNS} FROM courses WHERE id = ?;`, [id])
    return row ? toCourse(row) : null
  }

  async countAll(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM courses;')
    return Number(row?.count ?? 0)
  }

  async create(draft: CourseDraft): Promise<Course> {
    const normalized = normalizeCourseDraft(draft)
    const nowIso = this.now().toISOString()
    // 课程代码是内部字段：草稿里没有（界面不再让用户填）就自动分配一个唯一编号。
    // 老库里已有的代码一律保留用于匹配，绝不改写。
    const code = normalized.code.length > 0 ? normalized.code : await this.nextInternalCode()
    const result = await this.db.runAsync(
      `INSERT INTO courses (code, name, instructor, semester, color, note, selection_serial, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        code,
        normalized.name,
        normalized.instructor,
        normalized.semester,
        normalized.color,
        normalized.note,
        normalized.selectionSerial,
        nowIso,
        nowIso,
      ],
    )
    const created = await this.getById(result.lastInsertRowId)
    if (!created) throw new NotFoundError('课程创建后无法读回，请重试。')
    return created
  }

  /**
   * 内部代码分配：读回库里全部代码，挑一个没被占用的。
   *
   * 为什么整表读代码：课程表在手机上是**个小表**（一门课一行），
   * 而正确性要求是「新分配的号绝不与任何已有行冲突」——
   * 只比 `AUTO-` 前缀的最大值不够安全，因为老数据里可能存在形状相同但含义不同的代码。
   */
  private async nextInternalCode(): Promise<string> {
    const rows = await this.db.getAllAsync<{ code: string | null }>('SELECT code FROM courses;')
    return allocateInternalCourseCode(rows.map((row) => row.code))
  }

  /**
   * 更新课程。
   *
   * **内部代码与选课序号都不会被静默抹掉**：
   * - 代码：草稿给非空 → 写入（照片导入 / 老调用方）；草稿为空（表单已经不显示这个字段）
   *   → **保留库里已有的代码**；只有显式 `clearCode` 才清空并重新分配一个内部编号；
   * - 选课序号：草稿给了非空序号 → 写入新值；
   *   草稿明确标记 `clearSelectionSerial` → 清空；
   *   草稿序号为空且没标记清空（旧表单 / 旧调用方 / 照片导入里没识别到序号的行）
   *   → **保留**库里已有的值。
   */
  async update(id: number, draft: CourseDraft): Promise<Course> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`课程 #${id} 不存在（可能已被删除）。`)
    const normalized: NormalizedCourse = normalizeCourseDraft(draft)
    const nowIso = this.now().toISOString()
    const code =
      normalized.code.length > 0
        ? normalized.code
        : draft.clearCode === true
          ? await this.nextInternalCode()
          : existing.code
    const selectionSerial =
      normalized.selectionSerial !== null
        ? normalized.selectionSerial
        : draft.clearSelectionSerial === true
          ? null
          : existing.selectionSerial
    await this.db.runAsync(
      `UPDATE courses SET code = ?, name = ?, instructor = ?, semester = ?, color = ?, note = ?,
         selection_serial = ?, updated_at = ?
       WHERE id = ?;`,
      [
        code,
        normalized.name,
        normalized.instructor,
        normalized.semester,
        normalized.color,
        normalized.note,
        selectionSerial,
        nowIso,
        id,
      ],
    )
    const updated = await this.getById(id)
    if (!updated) throw new NotFoundError(`课程 #${id} 更新后无法读回。`)
    return updated
  }

  /**
   * 只更新选课序号（照片导入时把图上那串数字补到新建 / 已存在的课程上）。
   *
   * 刻意与 `update()` 分开：这样调用方不需要伪造一份完整 `CourseDraft`，
   * 也就不可能顺手覆盖掉用户改过的名字 / 代码 / 颜色。
   */
  async updateSelectionSerial(id: number, selectionSerial: string | null): Promise<Course> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`课程 #${id} 不存在（可能已被删除）。`)
    await this.db.runAsync('UPDATE courses SET selection_serial = ?, updated_at = ? WHERE id = ?;', [
      selectionSerial,
      this.now().toISOString(),
      id,
    ])
    const updated = await this.getById(id)
    if (!updated) throw new NotFoundError(`课程 #${id} 更新选课序号后无法读回。`)
    return updated
  }

  /** 该课程被多少任务 / 课表引用。UI 在删除前必须先查这个。 */
  async describeReferences(courseId: number): Promise<CourseReferences> {
    const taskRow = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM tasks WHERE course_id = ?;',
      [courseId],
    )
    const scheduleRow = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM schedules WHERE course_id = ?;',
      [courseId],
    )
    const taskCount = Number(taskRow?.count ?? 0)
    const scheduleCount = Number(scheduleRow?.count ?? 0)
    return { courseId, taskCount, scheduleCount, blocked: taskCount > 0 || scheduleCount > 0 }
  }

  /**
   * 删除课程。被引用且未确认时抛 `CourseInUseError`；确认后任务保留、课表删除。
   */
  async removeCourse(id: number, options: RemoveCourseOptions = {}): Promise<{ removedTasks: 0; removedSchedules: number; detachedTasks: number }> {
    const existing = await this.getById(id)
    if (!existing) throw new NotFoundError(`课程 #${id} 不存在（可能已被删除）。`)

    const references = await this.describeReferences(id)
    if (references.blocked && !options.confirmed) {
      throw new CourseInUseError(id, references.taskCount, references.scheduleCount)
    }

    const detachedTasks = references.taskCount

    // 用显式 BEGIN/COMMIT，而不是 `withTransactionAsync`：
    // 这样即使将来有调用方把这个方法包在自己的事务里，也不会出现嵌套事务。
    await this.db.execAsync('BEGIN IMMEDIATE;')
    try {
      // 课表随课程走（显式删除，不依赖 PRAGMA 设置是否生效）。
      await this.db.runAsync('DELETE FROM schedules WHERE course_id = ?;', [id])
      // 任务保留：先解除关联，再删课程，双保险。
      await this.db.runAsync('UPDATE tasks SET course_id = NULL, updated_at = ? WHERE course_id = ?;', [
        this.now().toISOString(),
        id,
      ])
      await this.db.runAsync('DELETE FROM courses WHERE id = ?;', [id])
      await this.db.execAsync('COMMIT;')
    } catch (cause) {
      try {
        await this.db.execAsync('ROLLBACK;')
      } catch {
        // 回滚失败不掩盖原始错误
      }
      throw cause
    }

    return { removedTasks: 0, removedSchedules: references.scheduleCount, detachedTasks }
  }

  /* ------------------------------- 课表 ------------------------------- */

  async listSchedules(): Promise<Schedule[]> {
    const rows = await this.db.getAllAsync<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY weekday ASC, start_time ASC, id ASC;`,
    )
    return rows.map(toSchedule)
  }

  async listSchedulesByCourse(courseId: number): Promise<Schedule[]> {
    const rows = await this.db.getAllAsync<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE course_id = ? ORDER BY weekday ASC, start_time ASC, id ASC;`,
      [courseId],
    )
    return rows.map(toSchedule)
  }

  async getSchedule(scheduleId: number): Promise<Schedule | null> {
    const row = await this.db.getFirstAsync<ScheduleRow>(
      `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?;`,
      [scheduleId],
    )
    return row ? toSchedule(row) : null
  }

  async createSchedule(courseId: number, draft: ScheduleDraft): Promise<Schedule> {
    const course = await this.getById(courseId)
    if (!course) throw new NotFoundError(`课程 #${courseId} 不存在，无法添加课表。`)
    const normalized: NormalizedSchedule = normalizeScheduleDraft(draft)
    const nowIso = this.now().toISOString()
    const result = await this.db.runAsync(
      `INSERT INTO schedules
         (course_id, weekday, start_time, end_time, location, period_start, period_end, week_range,
          semester_start_date, start_week, end_week, week_pattern, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        courseId,
        normalized.weekday,
        normalized.startTime,
        normalized.endTime,
        normalized.location,
        normalized.periodStart,
        normalized.periodEnd,
        normalized.weekRange,
        normalized.semesterStartDate,
        normalized.startWeek,
        normalized.endWeek,
        normalized.weekPattern,
        nowIso,
        nowIso,
      ],
    )
    const created = await this.getSchedule(result.lastInsertRowId)
    if (!created) throw new NotFoundError('课表创建后无法读回，请重试。')
    return created
  }

  async updateSchedule(scheduleId: number, draft: ScheduleDraft): Promise<Schedule> {
    const existing = await this.getSchedule(scheduleId)
    if (!existing) throw new NotFoundError(`课表 #${scheduleId} 不存在（可能已被删除）。`)
    const normalized = normalizeScheduleDraft(draft)
    const nowIso = this.now().toISOString()
    await this.db.runAsync(
      `UPDATE schedules SET
         weekday = ?, start_time = ?, end_time = ?, location = ?, period_start = ?, period_end = ?,
         week_range = ?, semester_start_date = ?, start_week = ?, end_week = ?, week_pattern = ?, updated_at = ?
       WHERE id = ?;`,
      [
        normalized.weekday,
        normalized.startTime,
        normalized.endTime,
        normalized.location,
        normalized.periodStart,
        normalized.periodEnd,
        normalized.weekRange,
        normalized.semesterStartDate,
        normalized.startWeek,
        normalized.endWeek,
        normalized.weekPattern,
        nowIso,
        scheduleId,
      ],
    )
    const updated = await this.getSchedule(scheduleId)
    if (!updated) throw new NotFoundError(`课表 #${scheduleId} 更新后无法读回。`)
    return updated
  }

  async removeSchedule(scheduleId: number): Promise<void> {
    const result = await this.db.runAsync('DELETE FROM schedules WHERE id = ?;', [scheduleId])
    if (result.changes === 0) throw new NotFoundError(`课表 #${scheduleId} 不存在（可能已被删除）。`)
  }

  /**
   * 多天课表的**一次性保存**（新建与编辑共用）。
   *
   * 用户可以在一次操作里选择多天，每天各有一条独立的课表行，因此这里必须满足：
   * - **单事务**：先做全部纯校验，再 `BEGIN IMMEDIATE` 写完整批；任何一步失败都 `ROLLBACK`，
   *   绝不会留下「写了一半的多天课表」；
   * - **精确更新**：`updates` 只按 id 更新指定的行，不碰同一课程里其它时间段的记录；
   * - **同一天可以有多段课**（复核定稿的关键修正）：**不再**用「这一天被占用」拒绝；
   *   只有「同一天 + 同一时段」这种**真正重复的一条**才会报错，
   *   不同时间段的第二段课（例如周日 08:00–09:35 与 10:00–11:35）必须能正常写入；
   * - **不吃掉别的记录**：更新某一条时绝不删除或改写同一天的另一条；
   * - **保留历史字段**：`period_start` / `period_end` 仍然按草稿写入，
   *   编辑既有课表时草稿会把原值原样带回，界面移除输入不会抹掉旧数据。
   *
   * 返回 `ScheduleBatchOutcome`：`committed` 为 true 表示事务已经提交，
   * 此时即便读回失败也**不再抛异常**，避免用户重试造成整批重复写入。
   */
  async applyScheduleBatch(courseId: number, change: ScheduleBatchChange = {}): Promise<ScheduleBatchOutcome> {
    const course = await this.getById(courseId)
    if (!course) throw new NotFoundError(`课程 #${courseId} 不存在，无法保存课表。`)

    const updates = change.updates ?? []
    const creates = change.creates ?? []
    if (updates.length === 0 && creates.length === 0) {
      throw new ValidationError('没有需要保存的课表。', { weekdays: '请至少选择一天上课。' })
    }

    // 1) 纯校验整批草稿：任何一天不合法，整批都不写。
    const preparedUpdates = updates.map((item) => ({
      scheduleId: item.scheduleId,
      normalized: normalizeScheduleDraft(item.draft),
    }))
    const preparedCreates = creates.map((draft) => ({ normalized: normalizeScheduleDraft(draft) }))

    // 2) 同一批里「同一天 + 同一时段」出现两次才是重复。
    //    同一天不同时段是合法的两段课，必须放行（复核定稿明确要求）。
    const claimed: Array<{ normalized: NormalizedSchedule; owner: string }> = []
    const claim = (normalized: NormalizedSchedule, owner: string): void => {
      const clash = claimed.find((entry) => isSameSessionSlot(entry.normalized, normalized))
      if (clash) {
        const message =
          `${weekdayName(normalized.weekday)} ${normalized.startTime}–${normalized.endTime} 在本次保存里` +
          `出现了两次（${clash.owner} 与 ${owner}），请合并成一条。`
        throw new ValidationError(message, { [weekdayErrorKey(normalized.weekday)]: message })
      }
      claimed.push({ normalized, owner })
    }
    for (const item of preparedUpdates) claim(item.normalized, `更新 #${item.scheduleId}`)
    for (const item of preparedCreates) claim(item.normalized, '新增')

    const nowIso = this.now().toISOString()
    const createdIds: number[] = []
    const replacedIds = preparedUpdates.map((item) => item.scheduleId)

    // 用显式 BEGIN/COMMIT（与 removeCourse 一致），避免嵌套事务。
    await this.db.execAsync('BEGIN IMMEDIATE;')
    try {
      // 3) 更新目标必须存在且属于这门课程。
      for (const item of preparedUpdates) {
        const row = await this.db.getFirstAsync<{ id: number; course_id: number }>(
          'SELECT id, course_id FROM schedules WHERE id = ?;',
          [item.scheduleId],
        )
        if (!row) throw new NotFoundError(`课表 #${item.scheduleId} 不存在（可能已被删除）。`)
        if (Number(row.course_id) !== courseId) {
          throw new NotFoundError(`课表 #${item.scheduleId} 不属于这门课程，已取消保存。`)
        }
      }

      // 4) 只拦「同一天同一时段」的既有行；同一天的不同时段一律放行。
      const updateIds = new Set(replacedIds)
      for (const item of [...preparedUpdates, ...preparedCreates]) {
        const duplicateId = await this.findDuplicateSession(courseId, item.normalized, updateIds)
        if (duplicateId !== null) throw this.duplicateSessionError(item.normalized)
      }

      // 5) 写入。
      for (const item of preparedUpdates) {
        await this.db.runAsync(
          `UPDATE schedules SET
             weekday = ?, start_time = ?, end_time = ?, location = ?, period_start = ?, period_end = ?,
             week_range = ?, semester_start_date = ?, start_week = ?, end_week = ?, week_pattern = ?, updated_at = ?
           WHERE id = ?;`,
          [
            item.normalized.weekday,
            item.normalized.startTime,
            item.normalized.endTime,
            item.normalized.location,
            item.normalized.periodStart,
            item.normalized.periodEnd,
            item.normalized.weekRange,
            item.normalized.semesterStartDate,
            item.normalized.startWeek,
            item.normalized.endWeek,
            item.normalized.weekPattern,
            nowIso,
            item.scheduleId,
          ],
        )
      }
      for (const item of preparedCreates) {
        const result = await this.db.runAsync(
          `INSERT INTO schedules
             (course_id, weekday, start_time, end_time, location, period_start, period_end, week_range,
              semester_start_date, start_week, end_week, week_pattern, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            courseId,
            item.normalized.weekday,
            item.normalized.startTime,
            item.normalized.endTime,
            item.normalized.location,
            item.normalized.periodStart,
            item.normalized.periodEnd,
            item.normalized.weekRange,
            item.normalized.semesterStartDate,
            item.normalized.startWeek,
            item.normalized.endWeek,
            item.normalized.weekPattern,
            nowIso,
            nowIso,
          ],
        )
        createdIds.push(result.lastInsertRowId)
      }

      await this.db.execAsync('COMMIT;')
    } catch (cause) {
      try {
        await this.db.execAsync('ROLLBACK;')
      } catch {
        // 回滚失败不掩盖原始错误
      }
      throw cause
    }

    // 6) 提交后读回。读回失败**不谎报保存失败**：返回已知的已提交状态，
    //    界面据此提示「已保存，只是列表没刷新」，并只重试刷新，不引导用户重存。
    const writtenIds = [...replacedIds, ...createdIds]
    const kind: ScheduleBatchOutcome['kind'] =
      preparedUpdates.length > 0 && preparedCreates.length > 0
        ? 'mixed'
        : preparedUpdates.length > 0
          ? 'update'
          : 'insert'
    return this.readbackSchedules(courseId, writtenIds, kind)
  }

  /** 提交后读回选定的课表行；任何失败都变成 `readbackError`，绝不抛异常。 */
  private async readbackSchedules(
    courseId: number,
    writtenIds: readonly number[],
    kind: ScheduleBatchOutcome['kind'],
  ): Promise<ScheduleBatchOutcome> {
    const id = writtenIds[0] ?? 0
    const label = kind === 'insert' ? '新增' : kind === 'update' ? '保存' : '批量保存'
    try {
      const written = await this.listSchedulesByCourse(courseId)
      const wanted = new Set<number>(writtenIds)
      const schedules = written.filter((schedule) => wanted.has(schedule.id))
      if (schedules.length === writtenIds.length) {
        return { kind, id, schedules, committed: true, readbackError: null }
      }
      return {
        kind,
        id,
        schedules,
        committed: true,
        readbackError: new NotFoundError(`${label}已提交，但有 ${writtenIds.length - schedules.length} 条课表读不回来。`),
      }
    } catch (cause) {
      return {
        kind,
        id,
        schedules: EMPTY_SCHEDULES,
        committed: true,
        readbackError: cause instanceof Error ? cause : new Error(`${label}已提交，但读回失败：${String(cause)}`),
      }
    }
  }

  /**
   * 同一课程里是否已有**同一天、同一时段、同一教学周范围**的课表。
   * `excludeIds` 是本次要改写/替换的行（它们自己的旧值不该跟自己比）。
   *
   * 这里把同一课程的行全部读回来、在 JS 里用与表单层/导入层**同一份**
   * `isSameSessionSlot` 判定，避免 SQL 字符串比较把 `8:00` 与 `08:00`
   * 当成不同时段，也避免漏掉「单双周 / 周次范围 / 学期起点不同」的合法并存情况。
   */
  private async findDuplicateSession(
    courseId: number,
    candidate: NormalizedSchedule,
    excludeIds: ReadonlySet<number>,
  ): Promise<number | null> {
    const rows = await this.db.getAllAsync<{
      id: number
      weekday: number
      start_time: string
      end_time: string
      week_pattern: string
      semester_start_date: string | null
      start_week: number | null
      end_week: number | null
    }>(
      `SELECT id, weekday, start_time, end_time, week_pattern, semester_start_date, start_week, end_week
         FROM schedules WHERE course_id = ?;`,
      [courseId],
    )
    for (const row of rows) {
      const id = Number(row.id)
      if (excludeIds.has(id)) continue
      if (
        isSameSessionSlot(
          {
            weekday: Number(row.weekday),
            startTime: row.start_time,
            endTime: row.end_time,
            weekPattern: row.week_pattern,
            semesterStartDate: row.semester_start_date,
            startWeek: row.start_week === null ? null : Number(row.start_week),
            endWeek: row.end_week === null ? null : Number(row.end_week),
          },
          candidate,
        )
      ) {
        return id
      }
    }
    return null
  }

  private duplicateSessionError(normalized: NormalizedSchedule): ValidationError {
    const scope =
      normalized.startWeek !== null && normalized.endWeek !== null
        ? `第 ${normalized.startWeek}–${normalized.endWeek} 周${
            normalized.weekPattern === 'ALL' ? '' : normalized.weekPattern === 'ODD' ? '（单周）' : '（双周）'
          }`
        : '每周'
    const message =
      `${weekdayName(normalized.weekday)} ${normalized.startTime}–${normalized.endTime}（${scope}）已经有这门课的` +
      `一条完全相同的课表了。请到课程详情页直接编辑那一条；如果这是同一天的另一段课、` +
      `或另一个周次范围 / 单双周，请把周次或时间改得不一样再保存。`
    return new ValidationError(message, { [weekdayErrorKey(normalized.weekday)]: message })
  }

  async countSchedules(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM schedules;')
    return Number(row?.count ?? 0)
  }

  /** 参考数据：仅供表单使用，避免在界面里硬编码枚举。 */
  static readonly weekdayValues: readonly SqlValue[] = [1, 2, 3, 4, 5, 6, 7]
}
