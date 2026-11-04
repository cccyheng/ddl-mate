/**
 * 日历分组与今日聚合 —— 纯函数层。
 *
 * 核心约束：
 * - 任务按 **deadline 的北京时间自然日** 归组（`isoToShanghaiDateKey`），
 *   手机时区设为 UTC 或纽约都不会把 10-15 23:30 的任务挪到 10-16；
 * - 未设置 DDL 的任务**不会**被塞进任何一天（不猜时间），只出现在任务列表的「未设置」分组；
 * - 课程按 `occursOn` 的真实教学周规则展开，学期范围与单双周都会被尊重。
 */

import {
  addDaysToDateKey,
  compareByDeadline,
  dateKeyToDayNumber,
  dayNumberToDateKey,
  deadlineToShanghaiDateKey,
  isDeadlineOverdue,
  isoToShanghaiDateKey,
  isValidDateKey,
  shanghaiToday,
  weekdayOfDateKey,
  type Weekday,
} from './datetime'
import { occursOn, type ScheduleWeekRule } from './scheduleRules'
import type { Course, Schedule, Task } from './types'

export interface Meeting {
  schedule: Schedule
  course: Course | null
  /** 该课表当天是否有课（由 occursOn 判定）。 */
  dateKey: string
}

export interface TaskDeadline {
  task: Task
  dateKey: string
}

export interface DaySummary {
  dateKey: string
  weekday: Weekday | null
  isToday: boolean
  meetings: Meeting[]
  deadlines: TaskDeadline[]
}

export interface MonthCell {
  dateKey: string
  day: number
  inMonth: boolean
  isToday: boolean
  meetingCount: number
  deadlineCount: number
  hasOverdue: boolean
}

export interface CalendarMonth {
  year: number
  month: number
  /** 6×7 网格，从该月 1 号所在周的周一开始（周一为一周第一天）。 */
  cells: MonthCell[]
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** `year-month-01` 形式的月初 key（month 为 1-12）。 */
export function monthStartKey(year: number, month: number): string {
  return `${year}-${pad2(month)}-01`
}

/** 月历网格起点：该月 1 号所在周的周一。 */
export function calendarGridStart(year: number, month: number): string | null {
  const first = monthStartKey(year, month)
  if (!isValidDateKey(first)) return null
  const weekday = weekdayOfDateKey(first)
  if (weekday === null) return null
  return addDaysToDateKey(first, -(weekday - 1))
}

export interface CalendarInput {
  year: number
  month: number
  schedules: readonly Schedule[]
  courses: readonly Course[]
  tasks: readonly Task[]
  today?: string
  now?: Date
}

/** 组件共用的 6×7 月历网格。 */
export function buildCalendarMonth(input: CalendarInput): CalendarMonth {
  const today = input.today ?? shanghaiToday()
  const gridStart = calendarGridStart(input.year, input.month)
  const cells: MonthCell[] = []
  if (!gridStart) return { year: input.year, month: input.month, cells }

  const coursesById = new Map(input.courses.map((course) => [course.id, course]))
  const meetingsByDate = groupMeetingsByDate(input.schedules, coursesById, gridStart, 42)
  const deadlinesByDate = groupDeadlinesByDate(input.tasks)
  const overdueByDate = groupOverdueByDate(input.tasks, input.now ?? new Date())

  for (let offset = 0; offset < 42; offset += 1) {
    const dateKey = addDaysToDateKey(gridStart, offset)
    if (!dateKey) continue
    const dayNumber = dateKeyToDayNumber(dateKey)
    const day = dayNumber === null ? 0 : Number(dateKey.slice(8, 10))
    cells.push({
      dateKey,
      day,
      inMonth: Number(dateKey.slice(5, 7)) === input.month && Number(dateKey.slice(0, 4)) === input.year,
      isToday: dateKey === today,
      meetingCount: meetingsByDate.get(dateKey)?.length ?? 0,
      deadlineCount: deadlinesByDate.get(dateKey)?.length ?? 0,
      hasOverdue: overdueByDate.get(dateKey) ?? false,
    })
  }
  return { year: input.year, month: input.month, cells }
}

/** 某个日期区间内所有真实上课记录（按日期升序）。 */
export function listMeetingsInRange(
  schedules: readonly Schedule[],
  courses: readonly Course[],
  fromDateKey: string,
  toDateKey: string,
): Meeting[] {
  const coursesById = new Map(courses.map((course) => [course.id, course]))
  const result: Meeting[] = []
  for (const schedule of schedules) {
    for (const dateKey of weekdaysInRange(fromDateKey, toDateKey)) {
      if (occursOn(schedule as unknown as ScheduleWeekRule, dateKey)) {
        result.push({ schedule, course: coursesById.get(schedule.courseId) ?? null, dateKey })
      }
    }
  }
  result.sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? -1 : 1
    return a.schedule.startTime.localeCompare(b.schedule.startTime)
  })
  return result
}

function* weekdaysInRange(fromDateKey: string, toDateKey: string): Generator<string> {
  const from = dateKeyToDayNumber(fromDateKey)
  const to = dateKeyToDayNumber(toDateKey)
  if (from === null || to === null || from > to) return
  for (let day = from; day <= to; day += 1) yield dayNumberToDateKey(day)
}

function groupMeetingsByDate(
  schedules: readonly Schedule[],
  coursesById: Map<number, Course>,
  fromDateKey: string,
  days: number,
): Map<string, Meeting[]> {
  const toDateKey = addDaysToDateKey(fromDateKey, days - 1)
  const map = new Map<string, Meeting[]>()
  if (!toDateKey) return map
  for (const meeting of listMeetingsInRange(schedules, [...coursesById.values()], fromDateKey, toDateKey)) {
    const bucket = map.get(meeting.dateKey)
    if (bucket) bucket.push(meeting)
    else map.set(meeting.dateKey, [meeting])
  }
  return map
}

/** 任务按北京时间自然日归组；没有 DDL 的任务不进入任何一天。 */
export function groupDeadlinesByDate(tasks: readonly Task[]): Map<string, TaskDeadline[]> {
  const map = new Map<string, TaskDeadline[]>()
  for (const task of tasks) {
    if (task.status === 'CANCELLED') continue
    if (!task.deadline) continue
    // 只到日期的 DDL 直接归到用户选的那一天，不经过时间戳解析。
    const dateKey = deadlineToShanghaiDateKey(task.deadline)
    if (!dateKey) continue
    const entry: TaskDeadline = { task, dateKey }
    const bucket = map.get(dateKey)
    if (bucket) bucket.push(entry)
    else map.set(dateKey, [entry])
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => compareByDeadline(a.task, b.task))
  }
  return map
}

/** 逾期未完成的任务按「原 DDL 所在自然日」归组（用于日历红点）。 */
export function groupOverdueByDate(tasks: readonly Task[], now: Date = new Date()): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const task of tasks) {
    if (task.status === 'DONE' || task.status === 'CANCELLED') continue
    if (!task.deadline) continue
    if (!isDeadlineOverdue(task.deadline, now)) continue
    const dateKey = deadlineToShanghaiDateKey(task.deadline)
    if (dateKey) map.set(dateKey, true)
  }
  return map
}

/** 某一天的真实聚合：课程（按开始时间）+ 截止任务（按时间排序）。 */
export function getDaySummary(
  dateKey: string,
  schedules: readonly Schedule[],
  courses: readonly Course[],
  tasks: readonly Task[],
  today: string = shanghaiToday(),
): DaySummary {
  const meetings = listMeetingsInRange(schedules, courses, dateKey, dateKey)
  const deadlines = groupDeadlinesByDate(tasks).get(dateKey) ?? []
  return {
    dateKey,
    weekday: weekdayOfDateKey(dateKey),
    isToday: dateKey === today,
    meetings,
    deadlines,
  }
}

export interface TaskStats {
  overdue: number
  today: number
  next7Days: number
  done: number
  total: number
  noDeadline: number
}

/** 首页统计：全部来自真实数据，没有假进度/假连续天数。 */
export function computeTaskStats(tasks: readonly Task[], now: Date = new Date()): TaskStats {
  const today = shanghaiToday(now)
  const todayPlus7 = addDaysToDateKey(today, 7)
  let overdue = 0
  let dueToday = 0
  let next7Days = 0
  let done = 0
  let noDeadline = 0

  for (const task of tasks) {
    if (task.status === 'DONE') {
      done += 1
      continue
    }
    if (task.status === 'CANCELLED') continue
    if (!task.deadline) {
      noDeadline += 1
      continue
    }
    const dateKey = deadlineToShanghaiDateKey(task.deadline)
    if (!dateKey) continue
    if (isDeadlineOverdue(task.deadline, now)) {
      overdue += 1
      continue
    }
    if (dateKey === today) dueToday += 1
    else if (todayPlus7 !== null && dateKey > today && dateKey <= todayPlus7) next7Days += 1
  }

  return { overdue, today: dueToday, next7Days, done, total: tasks.length, noDeadline }
}

export interface TodayBucket {
  overdue: Task[]
  dueToday: Task[]
  upcoming: Task[]
  doneToday: Task[]
}

/**
 * 「今天」页的排序结果：逾期在前、今天截止其次，各自按截止时间升序。
 * 未设置 DDL 的未完成任务放在 `upcoming` 末尾（不猜时间，但也不隐藏）。
 */
export function bucketToday(tasks: readonly Task[], now: Date = new Date()): TodayBucket {
  const today = shanghaiToday(now)
  const overdue: Task[] = []
  const dueToday: Task[] = []
  const upcoming: Task[] = []
  const doneToday: Task[] = []

  for (const task of tasks) {
    if (task.status === 'DONE') {
      if (task.completedAt && isoToShanghaiDateKey(task.completedAt) === today) doneToday.push(task)
      continue
    }
    if (task.status === 'CANCELLED') continue
    if (!task.deadline) {
      upcoming.push(task)
      continue
    }
    const dateKey = deadlineToShanghaiDateKey(task.deadline)
    if (isDeadlineOverdue(task.deadline, now)) overdue.push(task)
    else if (dateKey === today) dueToday.push(task)
    else if (dateKey > today) upcoming.push(task)
  }

  overdue.sort(compareByDeadline)
  dueToday.sort(compareByDeadline)
  upcoming.sort(compareByDeadline)
  return { overdue, dueToday, upcoming, doneToday }
}
