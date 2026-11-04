/**
 * 「现在正在上课 / 下一节课」的**纯函数**判定。
 *
 * 为什么单独一层：月视图、某一天详情、首页「今日课表」都要显示「正在上课 / 下一节」，
 * 如果各自写一遍，很容易在某些页面上出现「不是今天也显示正在上课」这种假状态。
 * 这里把规则收成一个可穷举测试的函数，界面只负责展示。
 *
 * 判定口径（与全 App 一致）：
 * - 时间一律按 **Asia/Shanghai** 墙上时间（`shanghaiNowWallClock` / `shanghaiToday`）；
 * - 「今天有课」由调用方用 `occursOn`（学期范围 + 单双周）筛出来，这里不重复实现；
 * - 时钟按 **分钟** 比较（`HH:mm` → 分钟），因此：
 *   - 恰好等于开始时间 → **正在上课**；
 *   - 恰好等于结束时间 → **已经下课**（区间是 `[start, end)`）；
 * - 课程不会跨午夜（表单限制开始 < 结束且都是 `HH:mm`），所以不做跨天特例；
 * - 同时段多门课：`active` 全部列出，`next` 只给**最早开始**的那一节；
 *   开始时间相同则按结束时间、再按 id 稳定排序（结果可复现）。
 */

import { clockToMinutes } from './calendarClock'

export interface LiveSessionLike {
  id: number
  courseId: number
  weekday: number
  /** `HH:mm`。 */
  startTime: string
  endTime: string
  /** 可选：地点 / 节次，界面展示用，不参与判定。 */
  location?: string | null
  periodStart?: number | null
  periodEnd?: number | null
}

export interface LiveCourseLike {
  id: number
  name: string
  code: string
}

export interface LiveSession {
  session: LiveSessionLike
  course: LiveCourseLike | null
  startMinutes: number
  endMinutes: number
}

export type LivePhase =
  /** 这一天没有课（或今天没课）。 */
  | 'none'
  /** 现在还没到第一节课。 */
  | 'before-first'
  /** 正在上课。 */
  | 'in-class'
  /** 课间（有下一节）。 */
  | 'between'
  /** 今天的课都上完了。 */
  | 'after-last'

export interface LiveTimetable {
  phase: LivePhase
  /** 正在上课的全部课时（可能不止一门）。 */
  active: LiveSession[]
  /** 下一节（如果有）。 */
  next: LiveSession | null
  /** 距离下一节开始还有多少分钟（`next` 为 null 时也是 `null`）。 */
  minutesUntilNext: number | null
  /** 传入的这一批课时（已按开始时间排序，便于界面直接用）。 */
  sessions: LiveSession[]
}

/** `HH:mm` → 当天第几分钟；不合法返回 `null`（不猜时间）。见 `calendarClock`。 */
export { clockToMinutes } from './calendarClock'

const EMPTY: LiveTimetable = {
  phase: 'none',
  active: [],
  next: null,
  minutesUntilNext: null,
  sessions: [],
}

/**
 * 计算某一批课时在 `nowMinutes`（当天第几分钟）这一时刻的状态。
 *
 * 调用方负责把「今天真实有课的课时」传进来（`dateKey` 用 `occursOn` 过滤过），
 * 因此这里**不会**把别的日期的课当成「正在上课」。
 */
export function computeLiveTimetable(
  sessions: readonly LiveSessionLike[],
  courses: readonly LiveCourseLike[],
  nowMinutes: number,
): LiveTimetable {
  if (!Number.isFinite(nowMinutes)) return EMPTY
  const courseById = new Map(courses.map((course) => [course.id, course]))
  const prepared: LiveSession[] = []
  for (const session of sessions) {
    const startMinutes = clockToMinutes(session.startTime)
    const endMinutes = clockToMinutes(session.endTime)
    // 时间缺失 / 不合法 / 结束不晚于开始的记录：跳过而不是猜一个时间。
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue
    prepared.push({ session, course: courseById.get(session.courseId) ?? null, startMinutes, endMinutes })
  }
  prepared.sort((left, right) => {
    if (left.startMinutes !== right.startMinutes) return left.startMinutes - right.startMinutes
    if (left.endMinutes !== right.endMinutes) return left.endMinutes - right.endMinutes
    return left.session.id - right.session.id
  })
  if (prepared.length === 0) return EMPTY

  // 区间是 [start, end)：正好到结束时间就算下课。
  const active = prepared.filter((entry) => nowMinutes >= entry.startMinutes && nowMinutes < entry.endMinutes)
  const next = prepared.find((entry) => entry.startMinutes > nowMinutes) ?? null
  const minutesUntilNext = next ? next.startMinutes - nowMinutes : null

  let phase: LivePhase
  if (active.length > 0) phase = 'in-class'
  else if (next) phase = prepared.some((entry) => entry.endMinutes <= nowMinutes) ? 'between' : 'before-first'
  else phase = 'after-last'

  return { phase, active, next, minutesUntilNext, sessions: prepared }
}

/** 「还有多久」的中文短标签（`12 分钟` / `1 小时 05 分`）。 */
export function countdownLabel(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${String(rest).padStart(2, '0')} 分`
}
