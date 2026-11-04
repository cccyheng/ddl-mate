/**
 * 照片导入课表 —— **一次事务写完整批**（新建课程 + 课表）的仓库。
 *
 * 复核定稿对这一步的硬约束：
 * 1. **只有一个动作**：界面点了「导入」之后，才允许写数据库；识别过程绝不写任何东西；
 * 2. **一条事务**：整批课程与课表在同一个 `BEGIN IMMEDIATE` / `COMMIT` 里，
 *    任何一行不合法就**整批不写**，不会留下「导入了一半」的课表；
 * 3. **不重复**：同一天同一时段已经存在的课表直接跳过并计数（重复点导入 / 失败重试都不会堆重复行）；
 * 4. **保守复用课程**：同名课程直接复用，不新建；只有确实没有同名课程时才新建；
 * 5. **写后端 0 次**：这里只有手机本机 SQLite，没有任何网络调用；
 * 6. **提交后读回失败不谎报失败**：返回 `committed: true` 与 `readbackError`，
 *    界面提示「已保存，只是列表没刷新」，绝不引导用户再点一次导入（那会重复写入）。
 */

import {
  isInternalCourseCode,
  normalizeCourseCodeForCompare,
  normalizeCourseDraft,
  normalizeCourseNameForCompare,
  normalizeScheduleDraft,
} from './courseDraft'
import { allocateInternalCourseCode } from './courseImportCode'
import { NotFoundError, ValidationError } from './errors'
import { isStructuralLabel } from './headerLabels'
import { isSameSessionSlot } from './scheduleSession'
import type { Course, CourseDraft, Schedule, ScheduleDraft } from './types'
import type { SqliteDatabase } from '../db/types'

/** 一条待导入的候选（界面里用户已确认/修改过的内容）。 */
export interface ScheduleImportCandidate {
  /** 界面上的行号（从 1 开始），仅用于错误定位与展示。 */
  rowNumber: number
  /** 是否勾选导入；false 的行完全不参与校验，也不写库。 */
  include: boolean
  course: CourseDraft
  schedule: ScheduleDraft
  /** 识别出的原始名称等，用于提示；不参与任何判定。 */
  note?: string
  /**
   * 这一行来自哪一次截图归档（`screenshot_attempts.id`）。
   *
   * 有值时导入会写一条持久的 `screenshot_refs`，让「课程 / 课表 → 原始截图」
   * 关掉 App 也还在。没有（手工新建的课表）时完全不写引用。
   */
  originAttemptId?: number | null
  /** 这次导入用的是哪一条识别结果（`ocr_results.id`），用于登记候选行。 */
  originResultId?: number | null
  /** 识别结果里的行序号（与 `originResultId` 一起定位「导入的就是这一行」）。 */
  originRowIndex?: number | null
}

export interface ScheduleImportRequest {
  candidates: readonly ScheduleImportCandidate[]
  /**
   * 本次导入来源的那张截图。
   *
   * 会写 `screenshot_refs`（`IMPORTED_FROM`），把整批导入与截图绑起来；
   * 逐行还会挂 `COURSE` / `SCHEDULE` 引用，方便从课程详情回看原图。
   */
  originAttemptId?: number | null
}

export interface ImportedCourseResult {
  course: Course
  /** 这次是真的新建了课程，还是复用了同名课程。 */
  reused: boolean
}

/**
 * 一门课的**老师姓名冲突**：识别/编辑给了老师，但不能写进这条课程记录。
 *
 * 只会在两种情况下产生，且**两种情况都不写库**（保持记录不被破坏）：
 * - 库里（或同一批里先写入的那条）已经有非空老师，这次识别/编辑给了**不同**的老师；
 * - 这门课在同一批里出现多次，先出现的那一行先写下了老师，后面的行给了不同的人。
 *
 * 界面拿到它之后必须明确告诉用户「保留了哪个、忽略了哪个」，
 * 由用户决定是改课程表单，还是把同一门课拆成两条 —— 但绝不静默丢弃。
 */
export interface TeacherConflict {
  courseId: number
  courseName: string
  /** 实际保留在课程记录里的老师（**唯一**写进库的值）。 */
  keptTeacher: string
  /** 被忽略的识别/编辑结果（没有写进库）。 */
  ignoredTeacher: string
}

export interface ScheduleImportOutcome {
  /** 本次真正写入并读回的课表行。 */
  schedules: Schedule[]
  /** 涉及的课程（新建或复用）。 */
  courses: ImportedCourseResult[]
  /** 因为「同一天同一时段已存在」被跳过的行数。 */
  skippedDuplicates: number
  /** 提交是否已经发生（true 时即使读回失败也不要重试导入）。 */
  committed: boolean
  readbackError: Error | null
  /**
   * 已经建立 / 尝试建立的截图关联数量（0 = 这次导入没有截图来源，或关联阶段没跑）。
   *
   * 关联失败**不影响**导入结论：数据已经提交，只如实报告条数。
   */
  screenshotLinks: number
  /**
   * 老师姓名冲突（已保留库里的值，被忽略的值只在这里如实报告）。
   *
   * 空数组 = 没有冲突。绝不因为冲突而拒绝导入，也绝不改写已经存在的老师。
   */
  teacherConflicts: TeacherConflict[]
}

/**
 * 课程名归一化：只用于「是不是同一门课」的比较，不改变用户输入的显示。
 *
 * 用 `normalizeCourseNameForCompare`（跨 OCR 排版变体）：真实截图上同一门课可能在
 * 一个格子里是 `大学物理(B-2)`、另一个格子里是 `大学物理B-2`（括号被拆行丢掉），
 * 只去空格的旧口径会把它们当成两门课，导致导入后多出一门重复课程。
 */
function normalizeCourseKey(name: string): string {
  return normalizeCourseNameForCompare(name)
}

/**
 * 两个课程代码是不是**等价到可以合并**。
 *
 * 规则（保守）：
 * - 代码本身等价（忽略大小写与连字符等排版差异）→ 可以合并；
 * - 至少有一边是照片导入自动生成的内部编号（`AUTO-01`）→ 可以合并
 *   （内部编号不承载用户意图，用户手写的真实代码优先）；
 * - 两边都是用户手写的**不同**代码 → **不合并**：宁可让用户看到两条，
 *   也不要把用户明确区分的两门课悄悄并成一门。
 */
function courseCodesCanMerge(left: string, right: string): boolean {
  if (normalizeCourseCodeForCompare(left) === normalizeCourseCodeForCompare(right)) return true
  return isInternalCourseCode(left) || isInternalCourseCode(right)
}

/** 选课序号归一化（大小写、空格、全角差异都不该造成「不同的课」）。 */
export function normalizeSelectionSerial(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s/g, '')
    .toLowerCase()
}

/**
 * 两边的**选课序号**是否冲突到不能合并。
 *
 * 这是本轮复核对点名要修的行为：旧规则只看课程代码，而照片导入的每一行代码都是
 * `AUTO-nn`，于是「同名 + 选课序号不同」的两门课会被静默并成一门，
 * 用户看到 15 门而实际选了 16 门。
 *
 * 规则（尽量少打断用户，但绝不静默合并真正不同的课）：
 * - 任一边没有序号 → 不冲突（信息不足时保持原有的合并行为，避免把同一门课拆成两条）；
 * - 两边都有且不同 → **冲突，不合并**（宁可让用户看到两条，也不要把两门课并掉）；
 * - 相等 → 不冲突（这就是同一门课的再次导入，必须幂等复用）。
 */
export function selectionSerialsConflict(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeSelectionSerial(left)
  const b = normalizeSelectionSerial(right)
  if (a.length === 0 || b.length === 0) return false
  return a !== b
}

/** 老师姓名归一化：只用于「是不是同一个老师」的比较，不改变写进库的原文。 */
export function normalizeTeacherForCompare(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/\s/g, '')
    .toLowerCase()
}

/**
 * 核对页里的「同名课程但老师不同」检测（纯函数，与仓库层判据一致）。
 *
 * 为什么必须在核对页就提醒：同一门课在图上出现多段时，仓库层只会保留先写入的那个老师，
 * 后面的会被忽略（不写库、不覆盖）。如果界面不说，用户会以为每位老师都存进去了。
 *
 * 判据与仓库层的 `ensureCourse` **完全对齐**（少了任何一条都会报出仓库不会发生的冲突）：
 * - 课程名（归一化后）相同；
 * - 课程代码可合并（两边都是用户手写的**不同**真实代码 = 两门课，见 `courseCodesCanMerge`；
 *   缺 `code` 的旧行按「内部 / 未知」处理，不因此拒绝合并）；
 * - 选课序号不冲突（序号不同 = 两门不同的课，老师不同是正常的，不该报冲突）；
 * - 两边都有非空老师，且归一化后不同。
 */
export function findTeacherConflicts(
  rows: readonly TeacherConflictRow[],
): Map<string, string[]> {
  const teacherOf = (row: TeacherConflictRow): string => String(row.teacher ?? '').trim()
  const conflicts = new Map<string, string[]>()
  for (const row of rows) {
    const name = normalizeCourseNameForCompare(row.name)
    const teacher = teacherOf(row)
    if (!name || !teacher) continue
    const others = rows.filter(
      (other) =>
        other !== row &&
        normalizeCourseNameForCompare(other.name) === name &&
        courseCodesCanMergeForRow(row, other) &&
        !selectionSerialsConflict(row.selectionSerial, other.selectionSerial) &&
        teacherOf(other).length > 0,
    )
    if (others.length === 0) continue
    const differs = others.some(
      (other) => normalizeTeacherForCompare(teacherOf(other)) !== normalizeTeacherForCompare(teacher),
    )
    if (!differs) continue
    conflicts.set(row.id, [...new Set([teacher, ...others.map(teacherOf)])])
  }
  return conflicts
}

/** `findTeacherConflicts` 只需要行上的这几个字段（`PhotoImportRow` 结构性满足）。 */
export interface TeacherConflictRow {
  id: string
  name: string
  teacher: string
  selectionSerial: string
  /**
   * 内部课程代码。**旧导航参数里的行可能没有这个字段** → 按「内部 / 未知」处理
   * （与照片导入的 `AUTO-nn` 同义），绝不因为缺字段就把同一门课拆成两门。
   */
  code?: string
}

/**
 * `findTeacherConflicts` 用的「代码可合并」判据：与 `courseCodesCanMerge` 同一套规则，
 * 只是把缺失的代码当作内部 / 未知（旧行）而不是空字符串。
 */
function courseCodesCanMergeForRow(left: TeacherConflictRow, right: TeacherConflictRow): boolean {
  const a = typeof left.code === 'string' ? left.code.trim() : ''
  const b = typeof right.code === 'string' ? right.code.trim() : ''
  // 有一边不知道代码（旧行）→ 信息不足，保守地按「可合并」处理（与序号缺失的规则一致）。
  if (a.length === 0 || b.length === 0) return true
  return courseCodesCanMerge(a, b)
}

/** 同一门课的同一个冲突可能被多行重复触发；报告前按「课程 + 保留 + 忽略」去重。 */
function dedupeTeacherConflicts(list: readonly TeacherConflict[]): TeacherConflict[] {
  const seen = new Set<string>()
  const result: TeacherConflict[] = []
  for (const conflict of list) {
    const key = [
      conflict.courseId,
      normalizeTeacherForCompare(conflict.keptTeacher),
      normalizeTeacherForCompare(conflict.ignoredTeacher),
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(conflict)
  }
  return result
}

export class ScheduleImportRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
  }

  /**
   * 把一批候选写入本机 SQLite。
   *
   * 抛出 `ValidationError` 时**一定什么都没写**（校验在 BEGIN 之前完成，
   * 事务内任何失败也会 ROLLBACK），界面据此保留用户已改好的内容让用户重试。
   */
  async importCandidates(request: ScheduleImportRequest): Promise<ScheduleImportOutcome> {
    const included = (request.candidates ?? []).filter((candidate) => candidate.include)
    if (included.length === 0) {
      throw new ValidationError('没有勾选任何要导入的课表。', {
        candidates: '请至少勾选一行，或先取消这次导入。',
      })
    }

    // 1) 整批纯校验：任何一行不合法，整批都不写，并把行号告诉界面。
    const prepared: Array<{
      rowNumber: number
      course: ReturnType<typeof normalizeCourseDraft>
      schedule: ReturnType<typeof normalizeScheduleDraft>
      originAttemptId: number | null
      originResultId: number | null
      originRowIndex: number | null
    }> = []
    const fieldErrors: Record<string, string> = {}

    for (const candidate of included) {
      const rowKey = (field: string): string => `row:${candidate.rowNumber}:${field}`
      // 仓库层最后一道守卫：表头/时间栏文字绝不能进数据库。
      // 界面校验（`validateRow`）已经拦过一次，这里再拦一次的原因是：
      // 仓库是**唯一真正写库**的入口，任何调用方（将来的批量导入、脚本、回归测试）
      // 都不该有办法把「周一」「08:00」这种标签写成课程。
      if (isStructuralLabel(String(candidate.course?.name ?? '').trim())) {
        fieldErrors[rowKey('name')] =
          `第 ${candidate.rowNumber} 行：课程名是课表的表头或时间栏文字（星期 / 日期 / 节次 / 时刻），不能导入。`
        continue
      }
      let course: ReturnType<typeof normalizeCourseDraft>
      let schedule: ReturnType<typeof normalizeScheduleDraft>
      try {
        course = normalizeCourseDraft(candidate.course)
      } catch (cause) {
        if (!(cause instanceof ValidationError)) throw cause
        for (const [field, message] of Object.entries(cause.fields)) {
          fieldErrors[rowKey(field)] = `第 ${candidate.rowNumber} 行：${message}`
        }
        continue
      }
      try {
        schedule = normalizeScheduleDraft(candidate.schedule)
      } catch (cause) {
        if (!(cause instanceof ValidationError)) throw cause
        for (const [field, message] of Object.entries(cause.fields)) {
          fieldErrors[rowKey(field)] = `第 ${candidate.rowNumber} 行：${message}`
        }
        continue
      }
      prepared.push({
        rowNumber: candidate.rowNumber,
        course,
        schedule,
        originAttemptId: Number.isInteger(candidate.originAttemptId) ? Number(candidate.originAttemptId) : null,
        originResultId: Number.isInteger(candidate.originResultId) ? Number(candidate.originResultId) : null,
        originRowIndex: Number.isInteger(candidate.originRowIndex) ? Number(candidate.originRowIndex) : null,
      })
    }

    // 2) 同一批里「同一天 + 同一时段 + 同一课程」重复也要拦下来。
    //
    // 关键修正（独立复核证明的真实缺陷）：**同名但选课序号不同的两门课，是两门课**。
    // 旧口径只看归一化课程名 + 时段，于是「同名不同序号」的第二行会被说成
    // 「和第一行重复」而整批被拒 —— 与解析器 / 复用规则（序号冲突则不合并）自相矛盾。
    // 这里统一按同一套判据：序号冲突 → 不同课程 → 不参与同批重复判定。
    // 真正的重复（同序号 / 都没有序号）仍然照样拦下来，保护强度不变。
    for (let index = 0; index < prepared.length; index += 1) {
      for (let other = index + 1; other < prepared.length; other += 1) {
        const left = prepared[index]!
        const right = prepared[other]!
        if (normalizeCourseKey(left.course.name) !== normalizeCourseKey(right.course.name)) continue
        if (selectionSerialsConflict(left.course.selectionSerial, right.course.selectionSerial)) continue
        if (!isSameSessionSlot(left.schedule, right.schedule)) continue
        const message = `第 ${right.rowNumber} 行与第 ${left.rowNumber} 行是同一门课、同一天同一时段，请删掉其中一行。`
        fieldErrors[`row:${right.rowNumber}:schedule`] = message
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw new ValidationError('导入内容还有问题需要修改，本次没有写入任何数据。', fieldErrors)
    }

    // 3) 单事务写入。校验已经全部通过，事务里任何失败都 ROLLBACK。
    //
    // **截图关联也在同一个事务里**（独立复核证明的真实缺陷）：关联是用户明确要求的
    // 核心数据，绝不能出现「课表提交了、关联静默丢了几条、界面还说导入成功」。
    // 放进同一事务之后，关联失败 = 整批回滚 = 什么都没写，用户可以安全重试。
    const nowIso = this.nowIso()
    let skippedDuplicates = 0
    const createdIds: number[] = []
    /**
     * 本次导入**已经用过 / 已经预留**的内部代码。
     *
     * 必须显式维护：这一批的插入在同一个事务里，读到的是事务开始前的旧库，
     * 光靠读库无法发现「同一批里前几行刚新建的课程」；不预留就会出现两条新课程撞同一个 `AUTO-nn`。
     */
    const usedCodes = new Set<string>(
      (await this.db.getAllAsync<{ code: string | null }>('SELECT code FROM courses;')).map((row) =>
        String(row.code ?? '').trim().toUpperCase(),
      ),
    )
    /** 创建出来的课表 ↔ 来源行 / 截图（同一事务里写关联用）。 */
    const createdLinks: Array<{
      scheduleId: number
      courseId: number
      originAttemptId: number | null
      originResultId: number | null
      originRowIndex: number | null
    }> = []
    const writtenCourses = new Map<number, ImportedCourseResult>()
    let screenshotLinks = 0
    /**
     * 老师姓名冲突：保留库里的值，把被忽略的值如实收集起来。
     *
     * 收集在事务外声明（事务回滚时这个数组也会随异常被丢弃），只用于**报告**，不参与写入判定。
     */
    const teacherConflicts: TeacherConflict[] = []

    /** 写一条截图引用；`(attempt, kind, id, relation)` 已存在就跳过（幂等）。 */
    const insertRef = async (attemptId: number, kind: string, targetId: number, relation: string): Promise<void> => {
      const existing = await this.db.getFirstAsync<{ id: number }>(
        `SELECT id FROM screenshot_refs
          WHERE attempt_id = ? AND target_kind = ? AND target_id = ? AND relation = ? LIMIT 1;`,
        [attemptId, kind, targetId, relation],
      )
      if (existing) return
      await this.db.runAsync(
        `INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at)
         VALUES (?, ?, ?, ?, ?);`,
        [attemptId, kind, targetId, relation, nowIso],
      )
      screenshotLinks += 1
    }

    await this.db.execAsync('BEGIN IMMEDIATE;')
    try {
      for (const row of prepared) {
        const course = await this.ensureCourse(row.course, writtenCourses, usedCodes, nowIso, teacherConflicts)
        const existingSessions = await this.loadSessions(course.course.id)
        const duplicated = existingSessions.some((session) => isSameSessionSlot(session, row.schedule))
        if (duplicated) {
          skippedDuplicates += 1
          continue
        }
        const inserted = await this.db.runAsync(
          `INSERT INTO schedules
             (course_id, weekday, start_time, end_time, location, period_start, period_end, week_range,
              semester_start_date, start_week, end_week, week_pattern, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            course.course.id,
            row.schedule.weekday,
            row.schedule.startTime,
            row.schedule.endTime,
            row.schedule.location,
            row.schedule.periodStart,
            row.schedule.periodEnd,
            row.schedule.weekRange,
            row.schedule.semesterStartDate,
            row.schedule.startWeek,
            row.schedule.endWeek,
            row.schedule.weekPattern,
            nowIso,
            nowIso,
          ],
        )
        createdIds.push(inserted.lastInsertRowId)
        createdLinks.push({
          scheduleId: inserted.lastInsertRowId,
          courseId: course.course.id,
          originAttemptId: row.originAttemptId,
          originResultId: row.originResultId,
          originRowIndex: row.originRowIndex,
        })
      }

      // 3b) 同一事务里写截图关联与候选行登记。
      const batchAttemptId = Number.isInteger(request.originAttemptId) ? Number(request.originAttemptId) : null
      for (const link of createdLinks) {
        if (link.originAttemptId === null) continue
        await insertRef(link.originAttemptId, 'SCHEDULE', link.scheduleId, 'IMPORTED_SCHEDULE')
        await insertRef(link.originAttemptId, 'COURSE', link.courseId, 'IMPORTED_COURSE')
      }
      if (batchAttemptId !== null) {
        // 整批来源：挂在**第一条**这次导入的课表上（用户能从课表直接回到那张原图）。
        const anchor = createdLinks[0]
        if (anchor) await insertRef(batchAttemptId, 'SCHEDULE', anchor.scheduleId, 'IMPORTED_FROM')
      }
      for (const link of createdLinks) {
        if (link.originResultId === null || link.originRowIndex === null) continue
        await this.db.runAsync('UPDATE ocr_candidate_rows SET imported = 1 WHERE result_id = ? AND row_index = ?;', [
          link.originResultId,
          link.originRowIndex,
        ])
      }

      await this.db.execAsync('COMMIT;')
    } catch (cause) {
      try {
        await this.db.execAsync('ROLLBACK;')
      } catch {
        // 回滚失败不掩盖原始错误
      }
      // 回滚之后没有任何引用真的留下，因此计数必须归零 —— 绝不上报「写了 N 条」。
      screenshotLinks = 0
      throw cause
    }

    const outcome = await this.readback([...writtenCourses.values()], createdIds, skippedDuplicates, screenshotLinks)
    return { ...outcome, teacherConflicts: dedupeTeacherConflicts(teacherConflicts) }
  }

  /**
   * 同一门课复用；确实没有才新建。事务内复用同一个 Map，避免同一批里重复建同名课程。
   *
   * 「同一门课」的判定有**三层**，越靠后越严格：
   * 1. 归一化课程名（跨 OCR 排版变体）必须相同；
   * 2. 课程代码可合并（`AUTO-nn` 视为「没有用户意图的占位代码」）；
   * 3. **选课序号不冲突**：两边都有序号且不同 → 这是两门同名的不同课，**不合并**。
   *
   * 已有课程的名字与代码**一律以库里的为准**，绝不覆盖；只有两类信息会补写：
   * - 「库里的序号为空、这次识别出了序号」→ 补上那串数字；
   * - 「库里的老师为空、这次识别/编辑给了老师」→ 补上老师姓名。
   * 两者都**只补空值**：库里已经有老师时绝不覆盖，冲突只记进 `teacherConflicts` 如实报告。
   */
  private async ensureCourse(
    draft: ReturnType<typeof normalizeCourseDraft>,
    written: Map<number, ImportedCourseResult>,
    usedCodes: Set<string>,
    nowIso: string,
    teacherConflicts: TeacherConflict[],
  ): Promise<ImportedCourseResult> {
    const key = normalizeCourseKey(draft.name)
    for (const entry of written.values()) {
      if (normalizeCourseKey(entry.course.name) !== key) continue
      if (!courseCodesCanMerge(entry.course.code, draft.code)) continue
      if (selectionSerialsConflict(entry.course.selectionSerial, draft.selectionSerial)) continue
      // 同一批里这门课已经写过：老师只在「还没写过」时补，不同就报冲突，绝不改写。
      await this.mergeTeacher(entry, draft.instructor, nowIso, teacherConflicts)
      return entry
    }
    const rows = await this.db.getAllAsync<{
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
    }>(
      'SELECT id, code, name, instructor, semester, color, note, selection_serial, created_at, updated_at FROM courses ORDER BY id ASC;',
    )
    const existing = rows.find(
      (row) =>
        normalizeCourseKey(row.name) === key &&
        courseCodesCanMerge(String(row.code ?? ''), draft.code) &&
        !selectionSerialsConflict(row.selection_serial, draft.selectionSerial),
    )
    if (existing) {
      // 复核对要求：**绝不能覆盖已有课程的代码**。截图导入时手机侧给的代码通常是
      // 自动内部编号（`AUTO-01`），如果这门课已经存在，必须沿用库里那个真实代码。
      let selectionSerial = existing.selection_serial
      if (
        normalizeSelectionSerial(selectionSerial).length === 0 &&
        normalizeSelectionSerial(draft.selectionSerial).length > 0
      ) {
        // 库里没记过序号、这次图上给了：补上它（只补空值，不改已有值）。
        selectionSerial = draft.selectionSerial
        await this.db.runAsync('UPDATE courses SET selection_serial = ?, updated_at = ? WHERE id = ?;', [
          selectionSerial,
          nowIso,
          Number(existing.id),
        ])
      }
      /*
       * 老师姓名：只补空值，绝不覆盖。
       *
       * - 库里为空 + 这次识别/编辑给了老师 → 补上（这不是覆盖用户输入，是补一条证据）；
       * - 库里已有老师 + 这次给了**不同**的人 → **不写库**，只记一条冲突让界面说清楚；
       * - 归一化后相同（空格 / 全半角差异）→ 什么都不用做。
       * 空字符串永远不会把库里已有的老师抹掉。
       */
      let instructor = existing.instructor
      const keptTeacher = String(existing.instructor ?? '').trim()
      const incomingTeacher = String(draft.instructor ?? '').trim()
      if (incomingTeacher.length > 0) {
        if (keptTeacher.length === 0) {
          instructor = incomingTeacher
          await this.db.runAsync('UPDATE courses SET instructor = ?, updated_at = ? WHERE id = ?;', [
            instructor,
            nowIso,
            Number(existing.id),
          ])
        } else if (normalizeTeacherForCompare(keptTeacher) !== normalizeTeacherForCompare(incomingTeacher)) {
          teacherConflicts.push({
            courseId: Number(existing.id),
            courseName: existing.name,
            keptTeacher,
            ignoredTeacher: incomingTeacher,
          })
        }
      }
      const result: ImportedCourseResult = {
        course: {
          id: Number(existing.id),
          code: existing.code,
          name: existing.name,
          instructor,
          semester: existing.semester,
          color: existing.color,
          note: existing.note,
          selectionSerial,
          createdAt: existing.created_at,
          updatedAt:
            selectionSerial === existing.selection_serial && instructor === existing.instructor
              ? existing.updated_at
              : nowIso,
        },
        reused: true,
      }
      written.set(result.course.id, result)
      return result
    }
    /*
     * 新建课程时的代码：草稿给了（照片导入通常是 `AUTO-01`）就用它；真的空着才在这里分配一个。
     *
     * 为什么要分配而不是留空：代码是内部字段但**必须唯一**，留空会让两门新课程在库里
     * 变成同一个「空代码」，后续按代码匹配 / 合并时相互污染。分配时同时避开
     * 库里已有的代码与**这一批前面几行已经用掉的代码**。
     */
    const newCourseCode =
      draft.code.trim().length > 0 ? draft.code : allocateInternalCourseCode(usedCodes)
    usedCodes.add(newCourseCode.trim().toUpperCase())
    const inserted = await this.db.runAsync(
      `INSERT INTO courses (code, name, instructor, semester, color, note, selection_serial, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        newCourseCode,
        draft.name,
        draft.instructor,
        draft.semester,
        draft.color,
        draft.note,
        draft.selectionSerial,
        nowIso,
        nowIso,
      ],
    )
    const result: ImportedCourseResult = {
      course: {
        id: inserted.lastInsertRowId,
        code: newCourseCode,
        name: draft.name,
        instructor: draft.instructor,
        semester: draft.semester,
        color: draft.color,
        note: draft.note,
        selectionSerial: draft.selectionSerial,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      reused: false,
    }
    written.set(result.course.id, result)
    return result
  }

  /**
   * 同一批里这门课已经写过一条：决定这次识别/编辑的老师要不要补写。
   *
   * - 这次没有老师（空串）→ 什么都不做（绝不把已有老师抹成空）；
   * - 之前那条还是空 → 补上，并同步更新库里刚插入的那一行；
   * - 两边都有且不同 → 保留先写入的，把被忽略的记进 `teacherConflicts`（不改库）。
   */
  private async mergeTeacher(
    entry: ImportedCourseResult,
    incoming: string | null | undefined,
    nowIso: string,
    teacherConflicts: TeacherConflict[],
  ): Promise<void> {
    const next = String(incoming ?? '').trim()
    if (next.length === 0) return
    const kept = String(entry.course.instructor ?? '').trim()
    if (kept.length === 0) {
      entry.course.instructor = next
      entry.course.updatedAt = nowIso
      await this.db.runAsync('UPDATE courses SET instructor = ?, updated_at = ? WHERE id = ?;', [
        next,
        nowIso,
        entry.course.id,
      ])
      return
    }
    if (normalizeTeacherForCompare(kept) === normalizeTeacherForCompare(next)) return
    teacherConflicts.push({
      courseId: entry.course.id,
      courseName: entry.course.name,
      keptTeacher: kept,
      ignoredTeacher: next,
    })
  }

  /**
   * 读回某门课已有的时段，用于「同一天同一时段 + 同一教学周范围」判重。
   *
   * 必须把 `week_pattern` / `semester_start_date` / `start_week` / `end_week` 一起读出来：
   * 只看时刻会把「单周一条、双周一条」这种**合法的两条**误判成重复而丢掉一条。
   */
  private async loadSessions(courseId: number): Promise<
    Array<{
      weekday: number
      startTime: string
      endTime: string
      weekPattern: string
      semesterStartDate: string | null
      startWeek: number | null
      endWeek: number | null
    }>
  > {
    const rows = await this.db.getAllAsync<{
      weekday: number
      start_time: string
      end_time: string
      week_pattern: string
      semester_start_date: string | null
      start_week: number | null
      end_week: number | null
    }>(
      `SELECT weekday, start_time, end_time, week_pattern, semester_start_date, start_week, end_week
         FROM schedules WHERE course_id = ?;`,
      [courseId],
    )
    return rows.map((row) => ({
      weekday: Number(row.weekday),
      startTime: row.start_time,
      endTime: row.end_time,
      weekPattern: row.week_pattern,
      semesterStartDate: row.semester_start_date,
      startWeek: row.start_week === null ? null : Number(row.start_week),
      endWeek: row.end_week === null ? null : Number(row.end_week),
    }))
  }

  /** 提交后读回；失败只记录在 `readbackError` 里，绝不抛异常（事务已经提交了）。 */
  private async readback(
    courses: ImportedCourseResult[],
    createdIds: readonly number[],
    skippedDuplicates: number,
    screenshotLinks = 0,
  ): Promise<Omit<ScheduleImportOutcome, 'teacherConflicts'>> {
    try {
      if (createdIds.length === 0) {
        return { schedules: [], courses, skippedDuplicates, committed: true, readbackError: null, screenshotLinks }
      }
      const placeholders = createdIds.map(() => '?').join(', ')
      const rows = await this.db.getAllAsync<{
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
      }>(
        `SELECT id, course_id, weekday, start_time, end_time, location, period_start, period_end,
                week_range, semester_start_date, start_week, end_week, week_pattern, created_at, updated_at
           FROM schedules WHERE id IN (${placeholders}) ORDER BY weekday ASC, start_time ASC, id ASC;`,
        createdIds,
      )
      const schedules: Schedule[] = rows.map((row) => ({
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
      }))
      if (schedules.length === createdIds.length) {
        return { schedules, courses, skippedDuplicates, committed: true, readbackError: null, screenshotLinks }
      }
      return {
        schedules,
        courses,
        skippedDuplicates,
        committed: true,
        screenshotLinks,
        readbackError: new NotFoundError(
          `导入已提交，但有 ${createdIds.length - schedules.length} 条课表读不回来。`,
        ),
      }
    } catch (cause) {
      return {
        schedules: [],
        courses,
        skippedDuplicates,
        committed: true,
        screenshotLinks,
        readbackError: cause instanceof Error ? cause : new Error(`导入已提交，但读回失败：${String(cause)}`),
      }
    }
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}
