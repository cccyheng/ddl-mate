/**
 * 学习周报 —— **纯统计层**（不依赖 React / 数据库 / 网络 / 设备时钟）。
 *
 * 这一层只回答「当前这份本机快照里，上海时间某一周真实发生了什么」：
 * - 本周完成：**现在**状态是 DONE，且 `completedAt` 的上海日期落在所选周、不晚于现在；
 * - 本周到期：`deadline` 的上海日期落在所选周的任务（不含已取消）；
 * - 已逾期：本周到期、现在仍是待办 / 进行中、且已过截止时刻的任务；
 * - 按课程拆分：以 `courseId` 为键（同名课程不会合并），缺课程 / 未关联课程单独成组。
 *
 * 刻意**不**做的事：
 * - 不拿 `updatedAt` 当完成时间（编辑一下任务就会伪造出「本周完成」）；
 * - 不保存任何历史快照：删掉任务、把 DONE 改回 TODO 之后，周报就按当前数据变化；
 * - 不估算学习时长、不造连续天数 / 评分 / AI 总结。
 *
 * 时间口径与全 App 一致：`Asia/Shanghai`。`now` 由调用方注入，因此测试可固定时间，
 * 页面也能用聚焦时钟在跨零点 / 回前台时重算。
 */

import {
  addDaysToDateKey,
  compareByDeadline,
  deadlineToShanghaiDateKey,
  isDateOnlyDeadline,
  isDeadlineOverdue,
  isoToEpochMs,
  isoToShanghaiDateKey,
  mondayOfDateKey,
  shanghaiToday,
  weekdayOfDateKey,
  type Weekday,
} from './datetime'
import type { Course, Task } from './types'

/** 可回看的历史周数（含当前周）。更早的周不再提供，避免无限翻页。 */
export const LEARNING_REPORT_HISTORY_WEEKS = 52

/** 任务明细每页条数（有界渲染，不一次性铺开整周任务）。 */
export const LEARNING_REPORT_PAGE_SIZE = 20

export const LEARNING_REPORT_WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

/** 一个上海自然周（周一 00:00 至周日结束）。 */
export interface LearningWeek {
  startDateKey: string
  endDateKey: string
}

/** 某个上海日期所在自然周；日期非法返回 `null`。 */
export function learningWeekOf(dateKey: string): LearningWeek | null {
  const monday = mondayOfDateKey(String(dateKey ?? '').trim())
  if (!monday) return null
  const endDateKey = addDaysToDateKey(monday, 6)
  if (!endDateKey) return null
  return { startDateKey: monday, endDateKey }
}

/** 「现在」所在的上海自然周；`now` 非法返回 `null`。 */
export function currentLearningWeek(now: Date): LearningWeek | null {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null
  return learningWeekOf(shanghaiToday(now))
}

/** 以某个周的周一为基准前后平移；输入非法 / 结果越界返回 `null`。 */
export function shiftLearningWeek(weekStartDateKey: string, deltaWeeks: number): LearningWeek | null {
  if (!Number.isInteger(deltaWeeks)) return null
  const week = learningWeekOf(weekStartDateKey)
  if (!week) return null
  const shifted = addDaysToDateKey(week.startDateKey, deltaWeeks * 7)
  return shifted ? learningWeekOf(shifted) : null
}

/** 当前可选的周范围：当前周 + 之前 51 周，共 {@link LEARNING_REPORT_HISTORY_WEEKS} 周。 */
export interface LearningWeekHistoryBounds {
  current: LearningWeek
  earliest: LearningWeek
}

export function learningWeekHistoryBounds(now: Date): LearningWeekHistoryBounds | null {
  const current = currentLearningWeek(now)
  if (!current) return null
  const earliest = shiftLearningWeek(current.startDateKey, -(LEARNING_REPORT_HISTORY_WEEKS - 1))
  if (!earliest) return null
  return { current, earliest }
}

/** 某日期是否落在周内（输入都应是合法的 `YYYY-MM-DD`）。 */
export function isDateKeyInLearningWeek(dateKey: string, week: LearningWeek): boolean {
  return dateKey >= week.startDateKey && dateKey <= week.endDateKey
}

/* --------------------------------- 类型 --------------------------------- */

export interface LearningReportCompletedEntry {
  task: Task
  /** 完成时间换算到上海后的自然日。 */
  dateKey: string
  /** 完成时刻（epoch 毫秒）；只到日期的完成时间取当天 00:00，仅用于先后排序与 `<=now` 判定。 */
  epochMs: number
}

export interface LearningReportDay {
  dateKey: string
  weekday: Weekday
  /** 这一天完成的条数（与 `completedTasks.length` 永远一致）。 */
  completedCount: number
  completedTasks: Task[]
  /** 这一天到期的任务数（不含已取消）。 */
  dueCount: number
  /** 这一天到期、现在仍未完成且已逾期的任务数。 */
  overdueCount: number
}

export interface LearningReportCourseGroup {
  /** 分组键：课程 id；`null` = 未关联课程。 */
  courseId: number | null
  /** 当前课程表里的名字；课程已不存在 / 未关联时为 `null`。 */
  courseName: string | null
  /** 任务写了 courseId，但当前课程表里找不到这门课。 */
  missingCourse: boolean
  dueTotal: number
  dueDone: number
  dueOpen: number
  overdue: number
  tasks: Task[]
}

export interface LearningReportCourseTotals {
  dueTotal: number
  dueDone: number
  dueOpen: number
  overdue: number
}

export interface LearningReportTotals {
  /** 当前快照里状态为 DONE 的任务总数（不含已取消）。 */
  done: number
  completedThisWeek: number
  /** 当前 DONE，但 completedAt 缺失 / 无法识别。 */
  doneMissingCompletion: number
  /** 当前 DONE，completedAt 合法但不在所选周。 */
  doneOutsideWeek: number
  /** 当前 DONE，completedAt 在上海所选周内，但时刻晚于 now（异常数据）。 */
  doneFutureThisWeek: number
  dueTotal: number
  dueDone: number
  dueOpen: number
  overdue: number
}

export interface LearningReportAnalysis {
  week: LearningWeek
  days: LearningReportDay[]
  /** 本周完成，按完成时刻升序（同一时刻按 id）。 */
  completedThisWeek: LearningReportCompletedEntry[]
  doneMissingCompletion: Task[]
  doneOutsideWeek: Task[]
  doneFutureThisWeek: Task[]
  dueTasks: Task[]
  dueDone: Task[]
  dueOpen: Task[]
  overdueNow: Task[]
  /** 本周到期完成率（0..1）；本周到期为 0 时是 `null`，界面显示「—」，绝不是 100%。 */
  dueCompletionRate: number | null
  /** 与 {@link dueCompletionRate} 对应的整数百分比；无数据时 `null`。 */
  dueCompletionPercent: number | null
  courseGroups: LearningReportCourseGroup[]
  courseTotals: LearningReportCourseTotals
  /** 非取消任务的截止日期无法识别；它们不会进入「本周到期」。 */
  malformedDeadline: Task[]
  totals: LearningReportTotals
}

export interface LearningReportInput {
  tasks: readonly Task[]
  courses: readonly Course[]
  /** 所选周的任意一天；会归一到该周周一。非法日期返回 `null`。 */
  weekStartDateKey: string
  now: Date
}

/* ------------------------------- 完成时间 ------------------------------- */

interface CompletionInfo {
  dateKey: string
  epochMs: number
}

/**
 * 解析 `completedAt`。
 *
 * - 带偏移的 ISO 按上海一侧取日期与真实时刻；
 * - 只到日期的值按「上海当天 00:00」参与先后比较（不编造具体完成时刻，
 *   只表示「这一天完成了」）；日期合法且在所选周内仍可计入本周完成；
 * - 空串 / 无偏移的墙上时间 / 不存在的日期一律视为不可用。
 */
export function parseTaskCompletion(value: unknown): CompletionInfo | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  if (isDateOnlyDeadline(raw)) {
    const epochMs = Date.parse(`${raw}T00:00:00+08:00`)
    return Number.isFinite(epochMs) ? { dateKey: raw, epochMs } : null
  }
  const dateKey = isoToShanghaiDateKey(raw)
  const epochMs = isoToEpochMs(raw)
  if (!dateKey || epochMs === null) return null
  return { dateKey, epochMs }
}

/* ------------------------------- 截止日期 ------------------------------- */

type DeadlineInfo =
  | { kind: 'none' }
  | { kind: 'malformed' }
  | { kind: 'valid'; dateKey: string }

function readDeadlineInfo(value: unknown): DeadlineInfo {
  const raw = String(value ?? '').trim()
  if (!raw) return { kind: 'none' }
  const dateKey = deadlineToShanghaiDateKey(raw)
  if (!dateKey) return { kind: 'malformed' }
  return { kind: 'valid', dateKey }
}

/* ------------------------------- 排序工具 ------------------------------- */

function compareById(a: Task, b: Task): number {
  return a.id - b.id
}

function compareDueTasks(a: Task, b: Task): number {
  const byDeadline = compareByDeadline(a, b)
  return byDeadline !== 0 ? byDeadline : compareById(a, b)
}

function compareCompletion(a: LearningReportCompletedEntry, b: LearningReportCompletedEntry): number {
  return a.epochMs - b.epochMs || compareById(a.task, b.task)
}

function completionMsOf(task: Task): number {
  return parseTaskCompletion(task.completedAt)?.epochMs ?? 0
}

function compareOutsideWeekCompletion(a: Task, b: Task): number {
  return completionMsOf(a) - completionMsOf(b) || compareById(a, b)
}

function compareCourseGroups(a: LearningReportCourseGroup, b: LearningReportCourseGroup): number {
  const aUnassociated = a.courseId === null
  const bUnassociated = b.courseId === null
  // 未关联课程固定排在最后，避免它被误当成某门真实课程。
  if (aUnassociated !== bUnassociated) return aUnassociated ? 1 : -1
  if (a.courseId === null || b.courseId === null) return 0
  // 课程表里还存在的课排在「课程已不存在」之前。
  if (a.missingCourse !== b.missingCourse) return a.missingCourse ? 1 : -1
  if (!a.missingCourse && a.courseName !== null && b.courseName !== null) {
    // 用确定的码元比较，避免不同运行环境的 locale 排序产生漂移。
    if (a.courseName < b.courseName) return -1
    if (a.courseName > b.courseName) return 1
  }
  return a.courseId - b.courseId
}

/* -------------------------------- 主分析 -------------------------------- */

/**
 * 对一份任务 / 课程快照做单个上海周的只读分析。
 *
 * 所有计数都从同一组列表派生（`dueDone`、`dueOpen`、`overdueNow` 是
 * `dueTasks` 的子集），因此界面上的数字与点进去看到的任务必然对得上。
 * 输入非法（周日期或 now 无法解析）返回 `null`，由调用方显示错误而不是猜一个周。
 */
export function analyzeLearningReport(input: LearningReportInput): LearningReportAnalysis | null {
  const now = input.now
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null
  const week = learningWeekOf(input.weekStartDateKey)
  if (!week) return null

  const nowMs = now.getTime()
  const coursesById = new Map<number, Course>()
  for (const course of input.courses) coursesById.set(course.id, course)

  const days: LearningReportDay[] = []
  const dayByDate = new Map<string, LearningReportDay>()
  for (let offset = 0; offset < 7; offset += 1) {
    const dateKey = addDaysToDateKey(week.startDateKey, offset)
    if (!dateKey) return null
    const weekday = weekdayOfDateKey(dateKey)
    if (weekday === null) return null
    const day: LearningReportDay = {
      dateKey,
      weekday,
      completedCount: 0,
      completedTasks: [],
      dueCount: 0,
      overdueCount: 0,
    }
    days.push(day)
    dayByDate.set(dateKey, day)
  }

  const completedThisWeek: LearningReportCompletedEntry[] = []
  const doneMissingCompletion: Task[] = []
  const doneOutsideWeek: Task[] = []
  const doneFutureThisWeek: Task[] = []
  const dueTasks: Task[] = []
  const malformedDeadline: Task[] = []
  let doneTotal = 0

  for (const task of input.tasks) {
    if (task.status === 'CANCELLED') continue

    const deadlineInfo = readDeadlineInfo(task.deadline)
    if (deadlineInfo.kind === 'malformed') malformedDeadline.push(task)
    if (deadlineInfo.kind === 'valid' && isDateKeyInLearningWeek(deadlineInfo.dateKey, week)) {
      dueTasks.push(task)
    }

    if (task.status !== 'DONE') continue
    doneTotal += 1

    const completion = parseTaskCompletion(task.completedAt)
    if (!completion) {
      doneMissingCompletion.push(task)
      continue
    }
    if (!isDateKeyInLearningWeek(completion.dateKey, week)) {
      doneOutsideWeek.push(task)
      continue
    }
    if (completion.epochMs > nowMs) {
      doneFutureThisWeek.push(task)
      continue
    }
    completedThisWeek.push({ task, dateKey: completion.dateKey, epochMs: completion.epochMs })
  }

  // 到期队列：完成 / 未完成都来自同一个 `dueTasks`，保证比例与明细一致。
  dueTasks.sort(compareDueTasks)
  const dueDone = dueTasks.filter((task) => task.status === 'DONE')
  const dueOpen = dueTasks.filter((task) => task.status !== 'DONE')
  const overdueNow = dueOpen.filter((task) => isDeadlineOverdue(task.deadline, now))

  // 本周完成：按完成时刻升序；每日条形图与明细共用这一份。
  completedThisWeek.sort(compareCompletion)
  for (const entry of completedThisWeek) {
    const day = dayByDate.get(entry.dateKey)
    if (!day) continue
    day.completedTasks.push(entry.task)
  }
  for (const day of days) day.completedCount = day.completedTasks.length

  // 每天的到期 / 逾期计数来自已排序的到期队列。
  for (const task of dueTasks) {
    const info = readDeadlineInfo(task.deadline)
    if (info.kind !== 'valid') continue
    const day = dayByDate.get(info.dateKey)
    if (!day) continue
    day.dueCount += 1
    if (task.status !== 'DONE' && isDeadlineOverdue(task.deadline, now)) day.overdueCount += 1
  }

  doneMissingCompletion.sort(compareById)
  doneOutsideWeek.sort(compareOutsideWeekCompletion)
  doneFutureThisWeek.sort(compareById)
  malformedDeadline.sort(compareById)

  const groupMap = new Map<number | null, LearningReportCourseGroup>()
  for (const task of dueTasks) {
    const courseId = task.courseId ?? null
    let group = groupMap.get(courseId)
    if (!group) {
      const course = courseId === null ? null : (coursesById.get(courseId) ?? null)
      group = {
        courseId,
        courseName: course?.name ?? null,
        missingCourse: courseId !== null && course === null,
        dueTotal: 0,
        dueDone: 0,
        dueOpen: 0,
        overdue: 0,
        tasks: [],
      }
      groupMap.set(courseId, group)
    }
    group.tasks.push(task)
  }
  const courseGroups = [...groupMap.values()]
  for (const group of courseGroups) {
    group.tasks.sort(compareDueTasks)
    group.dueTotal = group.tasks.length
    group.dueDone = group.tasks.filter((task) => task.status === 'DONE').length
    group.dueOpen = group.dueTotal - group.dueDone
    group.overdue = group.tasks.filter(
      (task) => task.status !== 'DONE' && isDeadlineOverdue(task.deadline, now),
    ).length
  }
  courseGroups.sort(compareCourseGroups)

  const courseTotals = courseGroups.reduce<LearningReportCourseTotals>(
    (totals, group) => ({
      dueTotal: totals.dueTotal + group.dueTotal,
      dueDone: totals.dueDone + group.dueDone,
      dueOpen: totals.dueOpen + group.dueOpen,
      overdue: totals.overdue + group.overdue,
    }),
    { dueTotal: 0, dueDone: 0, dueOpen: 0, overdue: 0 },
  )

  const dueCompletionRate = dueTasks.length === 0 ? null : dueDone.length / dueTasks.length
  const dueCompletionPercent = dueCompletionRate === null ? null : Math.round(dueCompletionRate * 100)

  return {
    week,
    days,
    completedThisWeek,
    doneMissingCompletion,
    doneOutsideWeek,
    doneFutureThisWeek,
    dueTasks,
    dueDone,
    dueOpen,
    overdueNow,
    dueCompletionRate,
    dueCompletionPercent,
    courseGroups,
    courseTotals,
    malformedDeadline,
    totals: {
      done: doneTotal,
      completedThisWeek: completedThisWeek.length,
      doneMissingCompletion: doneMissingCompletion.length,
      doneOutsideWeek: doneOutsideWeek.length,
      doneFutureThisWeek: doneFutureThisWeek.length,
      dueTotal: dueTasks.length,
      dueDone: dueDone.length,
      dueOpen: dueOpen.length,
      overdue: overdueNow.length,
    },
  }
}

/* ------------------------------ 明细选择器 ------------------------------ */

/**
 * 周报里所有可点数字共用同一套筛选键；{@link selectLearningReportTasks}
 * 与界面上的计数都从同一份分析结果派生，避免「数字 3 条、点进去 2 条」。
 */
export type LearningReportFilter =
  | { kind: 'completedThisWeek' }
  | { kind: 'doneMissingCompletion' }
  | { kind: 'due' }
  | { kind: 'dueDone' }
  | { kind: 'dueOpen' }
  | { kind: 'overdue' }
  | { kind: 'completedDay'; weekday: Weekday }
  | { kind: 'course'; courseId: number | null }

/** 筛选对应的真实任务列表；永远返回数组（无数据时为空数组）。 */
export function selectLearningReportTasks(
  analysis: LearningReportAnalysis,
  filter: LearningReportFilter,
): Task[] {
  switch (filter.kind) {
    case 'completedThisWeek':
      return analysis.completedThisWeek.map((entry) => entry.task)
    case 'doneMissingCompletion':
      return analysis.doneMissingCompletion
    case 'due':
      return analysis.dueTasks
    case 'dueDone':
      return analysis.dueDone
    case 'dueOpen':
      return analysis.dueOpen
    case 'overdue':
      return analysis.overdueNow
    case 'completedDay': {
      const day = analysis.days.find((entry) => entry.weekday === filter.weekday)
      return day ? day.completedTasks : []
    }
    case 'course': {
      const group = analysis.courseGroups.find((entry) => entry.courseId === filter.courseId)
      return group ? group.tasks : []
    }
    default:
      return []
  }
}

/** 完成率显示：无数据时是「—」，不是 100%；有数据时四舍五入到整数百分比。 */
export function formatLearningReportRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—'
  const percent = Math.round(Math.max(0, Math.min(1, rate)) * 100)
  return `${percent}%`
}

/** 周报里用到的日期（`YYYY-MM-DD`）转成短标签 `10-12`。 */
export function shortDateKey(dateKey: string): string {
  return dateKey.length >= 10 ? dateKey.slice(5) : dateKey
}
