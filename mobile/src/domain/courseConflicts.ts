/**
 * 课表冲突检查（**纯函数**，无 React / 无数据库 / 无网络 / 无通知 / 无 AI）。
 *
 * 回答的问题只有一个：
 *
 * > 从指定的上海自然日起 **14 天（含当天）** 里，哪两条课表在同一天有**真实重叠**的上课时间？
 *
 * 口径与全 App 一致，刻意**不重新实现**任何已有规则：
 * - 「某天是否上这门课」直接调用 `scheduleRules.occursOn`（学期首周一 / 起止周 / 单双周）；
 * - 时刻先做严格校验（非零秒不能被静默丢弃），再用 `scheduleSession.canonicalClock`
 *   规范化、用 `calendarClock.clockToMinutes` 转成分钟数；
 * - 教学周组合用 `scheduleRules.validateTermRange` 校验。
 *
 * 因此这里没有第二套「单双周」或「第几周」公式，也不会猜测坏数据：
 * 时间非法、结束不晚于开始、星期非法、教学周只填了一半 / 锚点不是周一 / 起止周反转、
 * 单双周值无法识别 —— 这些记录**整条跳过**，并在 `warnings` 里逐条说明原因。
 * 旧数据「教学周全空」仍然按既有语义当作每周都上（这是 `occursOn` 的既定行为），
 * 但**部分填写**（例如只有学期首周一）不会被当成旧数据兜底，而是明确报无效。
 *
 * 冲突判定是**严格重叠**：`max(开始) < min(结束)` 才算冲突；
 * 一条 08:00–09:00 与一条 09:00–10:00 只是相邻，不算冲突。
 * 每一对无序课表在同一天只输出一次；同一条课表（相同 id）不会和自己配对。
 *
 * 「同一门课的两条不同课表记录」**会**冲突（真实场景：重复导入 / 同一门课分两段），
 * 所以这里按**课表记录**判断，而不是按课程去重。
 */

import { addDaysToDateKey, isValidDateKey, weekdayOfDateKey, type Weekday } from './datetime'
import { clockToMinutes } from './calendarClock'
import { canonicalClock } from './scheduleSession'
import { describeWeekRule, occursOn, validateTermRange, type WeekPattern } from './scheduleRules'
import type { Course, Schedule } from './types'

/** 固定检查窗口：含起点当天在内共 14 个上海自然日。 */
export const COURSE_CONFLICTS_WINDOW_DAYS = 14

/** 某条课表为什么没有参与检查（逐条可见，绝不静默丢弃）。 */
export type CourseConflictWarningKind =
  | 'INVALID_RECORD'
  | 'INVALID_WEEKDAY'
  | 'INVALID_TIME'
  | 'INVALID_WEEK_RULE'

export interface CourseConflictWarning {
  /** 课表 id；数据坏到读不出 id 时为 `null`。 */
  scheduleId: number | null
  /** 这门课的 id；读不出时为 `null`。 */
  courseId: number | null
  kind: CourseConflictWarningKind
  /** 可直接展示的中文原因。 */
  message: string
}

/** 参与冲突比较的一条课表（保留原始记录，便于界面跳转与测试核对）。 */
export interface CourseConflictEntry {
  /** 原始课表记录；本模块只读，不修改。 */
  schedule: Schedule
  scheduleId: number
  /** 课程记录不存在时为 `null`（课表仍参与比较）。 */
  course: Course | null
  courseId: number | null
  /** 课程缺失时的安全兜底名，不会编造真实课程名。 */
  courseName: string
  /** `Course.instructor` 的实际值；未填写时 `null`。 */
  teacher: string | null
  /** `Schedule.location` 的实际值；未填写时 `null`。 */
  location: string | null
  startTime: string
  endTime: string
  weekday: number
  /** 人话周次说明（与课程详情页同一套 `describeWeekRule`）。 */
  weekLabel: string
  /** 课程记录已不在本机：仍参与时段比较，但不应提供课程详情链接。 */
  courseMissing: boolean
}

export interface CourseConflictPair {
  /** 稳定键：`日期|较小课表id|较大课表id`。 */
  key: string
  dateKey: string
  weekday: Weekday | null
  /** 重叠区间（`HH:mm`）。 */
  overlapStart: string
  overlapEnd: string
  overlapStartMinutes: number
  overlapEndMinutes: number
  /** 重叠分钟数，严格大于 0。 */
  overlapMinutes: number
  /** 按课表 id 升序排列的两条记录，保证输出稳定。 */
  left: CourseConflictEntry
  right: CourseConflictEntry
}

export interface CourseConflictsInput {
  schedules: readonly Schedule[]
  courses: readonly Course[]
  /** 检查窗口的起点（`YYYY-MM-DD`，上海自然日）。 */
  fromDateKey: string
}

export interface CourseConflictsAvailable {
  status: 'ok'
  windowDays: typeof COURSE_CONFLICTS_WINDOW_DAYS
  fromDateKey: string
  toDateKey: string
  /** 全部冲突对，按日期 / 重叠开始 / 课表 id 稳定升序。 */
  pairs: CourseConflictPair[]
  /** 冲突**对**数（不是课程数，也不是冲突条数）。 */
  pairCount: number
  /** 有冲突的**不同日期**数。 */
  dateCount: number
  /** 有冲突的日期（升序、去重）。 */
  conflictDates: string[]
  warnings: CourseConflictWarning[]
  /** 被跳过的课表条数（= warnings.length）。 */
  skippedCount: number
  /** 输入课表总条数。 */
  scheduleCount: number
  /** 通过校验、真正参与比较的课表条数。 */
  validScheduleCount: number
  /** 课程记录缺失、但仍参与比较的课表条数。 */
  missingCourseCount: number
  /** 有跳过项或缺失课程：用户看到的「没有冲突」只覆盖可比较部分。 */
  hasIncompleteData: boolean
}

export interface CourseConflictsUnavailable {
  status: 'unavailable'
  windowDays: typeof COURSE_CONFLICTS_WINDOW_DAYS
  fromDateKey: null
  toDateKey: null
  /** 为什么不能给出结论（明确不是「没有冲突」）。 */
  reason: string
  pairs: []
  pairCount: 0
  dateCount: 0
  conflictDates: []
  warnings: []
  skippedCount: 0
  scheduleCount: number
  validScheduleCount: 0
  missingCourseCount: 0
  hasIncompleteData: true
}

export type CourseConflictsResult = CourseConflictsAvailable | CourseConflictsUnavailable

interface ValidSchedule {
  entry: CourseConflictEntry
  /** 传给 `occursOn` 的规范化规则；教学周全空时三个字段都是 `null`。 */
  rule: {
    weekday: number
    semesterStartDate: string | null
    startWeek: number | null
    endWeek: number | null
    weekPattern: WeekPattern
  }
  startMinutes: number
  endMinutes: number
}

/** 课表 id / 课程 id 必须是正的安全整数；0、负数、小数、NaN、Infinity 都不算有效 id。 */
function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function asTrimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

function courseNameOf(course: Course | null): string {
  if (!course) return '未知课程（可能已删除）'
  return asTrimmedText(course.name) ?? '未命名课程'
}

/**
 * 单双周读取：
 * - 真正的 `null` / `undefined` / 空白字符串才是旧数据，按 `ALL`；
 * - 字符串只认 ALL / ODD / EVEN（大小写不敏感）；
 * - 数字、布尔值、对象等**非文本值不是旧数据**，必须报无效，绝不能当成每周。
 */
function readWeekPattern(value: unknown): WeekPattern | null {
  if (value === null || value === undefined) return 'ALL'
  if (typeof value !== 'string') return null
  const raw = value.trim().toUpperCase()
  if (raw === '' || raw === 'ALL') return 'ALL'
  if (raw === 'ODD' || raw === 'EVEN') return raw
  return null
}

/**
 * 严格读取课表时刻。
 *
 * 为什么不直接 `canonicalClock`：它会**静默丢掉秒**，于是 `08:00:99` 会被当成 08:00，
 * 这对「严格重叠」是错误的。这里先做本地校验：
 * - 接受 `HH:mm` 与 `H:mm`；
 * - 兼容旧数据的 `HH:mm:ss`，但**只接受 00 秒**；非零秒无法安全忽略，直接判无效；
 * - 其余交给既有 `canonicalClock` 再规范化一次。
 */
function readStrictClock(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (!match) return null
  const seconds = match[3]
  if (seconds !== undefined && Number(seconds) !== 0) return null
  return canonicalClock(text)
}

/**
 * 校验一条课表。
 *
 * 刻意先做独立校验，而不是直接把任何对象丢给 `occursOn`：
 * `occursOn` 对「教学周只填了一半」会按旧数据（每周都上）兜底，这在冲突检查里会把
 * 一条坏记录当成真实课程，从而报出假冲突。这里必须先判定「这条记录本身可不可用」。
 */
function validateSchedule(
  schedule: Schedule,
  coursesById: ReadonlyMap<number, Course>,
): { ok: true; value: ValidSchedule } | { ok: false; warning: CourseConflictWarning } {
  const rawId = readPositiveSafeInteger((schedule as { id?: unknown } | null)?.id)
  // 课程 id 无效时按「课程缺失」处理（仍参与检测，但不提供任何跳转），
  // 绝不去匹配一个 id 同样非法的课程对象。
  const courseId = readPositiveSafeInteger((schedule as { courseId?: unknown } | null)?.courseId)
  const warn = (
    kind: CourseConflictWarningKind,
    message: string,
    id: number | null = rawId,
  ): { ok: false; warning: CourseConflictWarning } => ({
    ok: false,
    warning: { scheduleId: id, courseId, kind, message },
  })

  if (!schedule || typeof schedule !== 'object') {
    return warn('INVALID_RECORD', '这条课表的数据不完整，未参与检查。')
  }
  if (rawId === null) {
    return warn('INVALID_RECORD', '这条课表的编号无效（需要正整数），未参与检查。', null)
  }
  const scheduleId = rawId

  const weekday = (schedule as { weekday?: unknown }).weekday
  if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    return warn('INVALID_WEEKDAY', '星期设置无效（必须是 1–7 的整数），这条课表未参与检查。')
  }

  // 严格校验（含「非零秒不可忽略」），再交给既有的分钟换算；
  // 任一失败都按「时间无效」跳过，绝不猜一个时刻。
  const startTime = readStrictClock((schedule as { startTime?: unknown }).startTime)
  const endTime = readStrictClock((schedule as { endTime?: unknown }).endTime)
  const startMinutes = startTime === null ? null : clockToMinutes(startTime)
  const endMinutes = endTime === null ? null : clockToMinutes(endTime)
  if (
    startTime === null ||
    endTime === null ||
    startMinutes === null ||
    endMinutes === null ||
    endMinutes <= startMinutes
  ) {
    return warn(
      'INVALID_TIME',
      '上课时间无效（需要 HH:mm；旧数据的 HH:mm:ss 只接受 00 秒；结束时间必须晚于开始时间），这条课表未参与检查。',
    )
  }

  const term = validateTermRange({
    semesterStartDate: (schedule as { semesterStartDate?: string | null }).semesterStartDate,
    startWeek: (schedule as { startWeek?: number | null }).startWeek,
    endWeek: (schedule as { endWeek?: number | null }).endWeek,
  })
  if (!term.ok) {
    return warn('INVALID_WEEK_RULE', term.message ?? '教学周设置不完整或无效，这条课表未参与检查。')
  }

  const weekPattern = readWeekPattern((schedule as { weekPattern?: unknown }).weekPattern)
  if (weekPattern === null) {
    return warn('INVALID_WEEK_RULE', '单双周设置无法识别（只支持每周 / 单周 / 双周），这条课表未参与检查。')
  }

  // 教学周全空是既有「旧数据 = 每周」语义；只要不是全空，就必须通过上面的成套校验。
  const rule = {
    weekday,
    semesterStartDate: term.semesterStartDate,
    startWeek: term.startWeek,
    endWeek: term.endWeek,
    weekPattern,
  }

  const course = courseId === null ? null : (coursesById.get(courseId) ?? null)
  const entry: CourseConflictEntry = {
    schedule,
    scheduleId,
    course,
    courseId,
    courseName: courseNameOf(course),
    teacher: asTrimmedText(course?.instructor),
    location: asTrimmedText((schedule as { location?: string | null }).location),
    startTime,
    endTime,
    weekday,
    weekLabel: describeWeekRule(rule),
    courseMissing: course === null,
  }

  return { ok: true, value: { entry, rule, startMinutes, endMinutes } }
}

function unavailable(reason: string, scheduleCount: number): CourseConflictsUnavailable {
  return {
    status: 'unavailable',
    windowDays: COURSE_CONFLICTS_WINDOW_DAYS,
    fromDateKey: null,
    toDateKey: null,
    reason,
    pairs: [],
    pairCount: 0,
    dateCount: 0,
    conflictDates: [],
    warnings: [],
    skippedCount: 0,
    scheduleCount,
    validScheduleCount: 0,
    missingCourseCount: 0,
    hasIncompleteData: true,
  }
}

/**
 * 生成 14 天冲突检查结果。
 *
 * 输入日期非法时返回 `status: 'unavailable'`，**不会**返回一个「0 个冲突」的成功结果：
 * 两种情况对用户的含义完全不同。
 */
export function buildCourseConflicts(input: CourseConflictsInput): CourseConflictsResult {
  const schedules = Array.isArray(input?.schedules) ? input.schedules : []
  const courses = Array.isArray(input?.courses) ? input.courses : []
  const scheduleCount = schedules.length
  const fromDateKey = typeof input?.fromDateKey === 'string' ? input.fromDateKey.trim() : ''

  if (!isValidDateKey(fromDateKey)) {
    return unavailable('检查起点不是真实存在的日期，无法确定 14 天范围；这不是「没有冲突」。', scheduleCount)
  }
  const toDateKey = addDaysToDateKey(fromDateKey, COURSE_CONFLICTS_WINDOW_DAYS - 1)
  if (toDateKey === null) {
    return unavailable('无法计算 14 天范围的结束日期；这不是「没有冲突」。', scheduleCount)
  }

  const coursesById = new Map<number, Course>()
  for (const course of courses) {
    const id = readPositiveSafeInteger(course?.id)
    if (id !== null) coursesById.set(id, course)
  }

  const valid: ValidSchedule[] = []
  const warnings: CourseConflictWarning[] = []
  for (const schedule of schedules) {
    const checked = validateSchedule(schedule, coursesById)
    if (!checked.ok) {
      warnings.push(checked.warning)
      continue
    }
    valid.push(checked.value)
  }

  const entriesByDate = new Map<string, ValidSchedule[]>()
  for (let offset = 0; offset < COURSE_CONFLICTS_WINDOW_DAYS; offset += 1) {
    const dateKey = addDaysToDateKey(fromDateKey, offset)
    if (dateKey === null) continue
    const occurring = valid.filter((candidate) => occursOn(candidate.rule, dateKey))
    entriesByDate.set(dateKey, occurring)
  }

  const pairs: CourseConflictPair[] = []
  const seenPairKeys = new Set<string>()
  for (const [dateKey, dayEntries] of entriesByDate) {
    const sorted = [...dayEntries].sort((left, right) => {
      if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes
      if (left.endMinutes !== right.endMinutes) return left.endMinutes - right.endMinutes
      if (left.entry.scheduleId !== right.entry.scheduleId) {
        return left.entry.scheduleId - right.entry.scheduleId
      }
      return left.entry.startTime.localeCompare(right.entry.startTime)
    })

    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const first = sorted[i] as ValidSchedule
        const second = sorted[j] as ValidSchedule
        // 同一 id 的两条记录不和自己配对（正常数据 id 唯一；坏数据也不制造自冲突）。
        if (first.entry.scheduleId === second.entry.scheduleId) continue

        const overlapStartMinutes = Math.max(first.startMinutes, second.startMinutes)
        const overlapEndMinutes = Math.min(first.endMinutes, second.endMinutes)
        // 严格重叠：相邻（结束 == 开始）不算冲突。
        if (overlapStartMinutes >= overlapEndMinutes) continue

        let left = first
        let right = second
        if (left.entry.scheduleId > right.entry.scheduleId) {
          left = second
          right = first
        }
        const key = `${dateKey}|${left.entry.scheduleId}|${right.entry.scheduleId}`
        if (seenPairKeys.has(key)) continue
        seenPairKeys.add(key)

        pairs.push({
          key,
          dateKey,
          weekday: weekdayOfDateKey(dateKey),
          overlapStart: dayNumberToClock(overlapStartMinutes),
          overlapEnd: dayNumberToClock(overlapEndMinutes),
          overlapStartMinutes,
          overlapEndMinutes,
          overlapMinutes: overlapEndMinutes - overlapStartMinutes,
          left: left.entry,
          right: right.entry,
        })
      }
    }
  }

  pairs.sort((left, right) => {
    if (left.dateKey !== right.dateKey) return left.dateKey.localeCompare(right.dateKey)
    if (left.overlapStartMinutes !== right.overlapStartMinutes) {
      return left.overlapStartMinutes - right.overlapStartMinutes
    }
    if (left.left.scheduleId !== right.left.scheduleId) {
      return left.left.scheduleId - right.left.scheduleId
    }
    return left.right.scheduleId - right.right.scheduleId
  })

  const conflictDates = [...new Set(pairs.map((pair) => pair.dateKey))]
  const missingCourseCount = valid.reduce((total, item) => total + (item.entry.courseMissing ? 1 : 0), 0)

  return {
    status: 'ok',
    windowDays: COURSE_CONFLICTS_WINDOW_DAYS,
    fromDateKey,
    toDateKey,
    pairs,
    pairCount: pairs.length,
    dateCount: conflictDates.length,
    conflictDates,
    warnings,
    skippedCount: warnings.length,
    scheduleCount,
    validScheduleCount: valid.length,
    missingCourseCount,
    hasIncompleteData: warnings.length > 0 || missingCourseCount > 0,
  }
}

function dayNumberToClock(minutes: number): string {
  const safe = Math.max(0, Math.min(24 * 60, Math.round(minutes)))
  const hour = Math.floor(safe / 60)
  const minute = safe % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
