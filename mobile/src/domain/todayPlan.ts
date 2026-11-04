/**
 * 今日学习计划 —— **纯算法层**（无 React / 无数据库 / 无网络 / 无 AI）。
 *
 * 这一份代码要回答的问题只有一个：
 *
 * > 今天我给自己划出的这些学习时段里，**按照我选中的任务和每任务的计划分钟数**，
 * > 能不能排出一份具体到「几点到几点做哪个任务」的计划；排不进去的分钟数是多少、为什么。
 *
 * 它刻意**不是**的东西：
 * - 不是 AI，也不是「全局最优」：这是一条**规则明确的贪心**（按 DDL 最早 → 优先级高 → id 小），
 *   先到先排，排满为止；提前动手 / 手动调整永远由用户自己做；
 * - 不猜用户的空闲时间：学习时段**必须由用户显式给出**（1–4 段，`HH:mm`，同一天，空白 = 没有时段）；
 * - 不测量进度：`DOING` 任务的剩余工作量**没有被测过**，计划分钟数一律由用户输入；
 * - 不改数据：本文件是纯函数，输入对象**不会被改写**（有专门的单测锁定这一点）。
 *
 * 时间口径与全 App 一致：**Asia/Shanghai 墙上时间**。设备时区是 UTC 或纽约都不影响结果。
 * 「现在」必须由调用方注入（`now: Date`），因此测试可以复现任何边界。
 *
 * 排布规则（改这里之前先读一遍）：
 * 1. 学习时段先归一化（去空行 → 校验 → 按开始时间排序）；**重叠输入直接拒绝**，
 *    相邻（`08:00-09:00` 接 `09:00-10:00`）是允许的。
 * 2. 「现在」**向上取整到下一分钟**，并且**按上海当天**换算（不看设备时区）。
 *    当天的最后一分钟向上取整会得到 `24:00`，表示当天剩余容量为 **0**；
 *    绝不会回头把白天的时段重新打开。
 * 3. 目标日期必须是「**由注入的 now 得到的那个上海自然日**」；昨天的计划 / 跨零点后的旧草稿
 *    直接判为不可排（`DATE_NOT_TODAY`），而不是照旧排一遍。
 * 4. 当天真实有课的课表（`occursOn` 判定教学周 / 单双周；学期范围外、别的星期几都不算）
 *    按**整节课区间**视为占用 —— 课间休息也照样算忙（保守）。
 * 5. 忙区间先**合并重叠与相邻**，再从学习时段里减掉。
 * 6. 选择项先做**严格校验**：任务 id 必须是正整数、分钟数必须是 1–1440 的整数、
 *    同一个任务不能重复选中、最多 30 个。任何一条不满足 → **整份计划不可排**
 *    （零块 + 明确原因），绝不「警告一下继续排一半」。
 * 7. 任务按「最早 DDL → 优先级高 → id 小」排序；**没有 DDL 的排在最后**。
 * 8. 每个任务在自己 DDL 之前（含 DDL 那一分钟，按**分钟向下取整**）的空闲缺口里顺序填充，
 *    允许跨多个缺口 / 多节课拆成多块；每块最少 1 分钟、必须是正整数分钟。
 * 9. 一个任务排满后，**后面的任务继续用剩下的空闲缺口**（不丢容量）。
 * 10. `已排 + 未排 = 计划分钟数` 恒等；`verifyTodayPlan` 逐条自检
 *     （块不重叠、落在真实空闲缺口内、不碰忙区间、不早于 now、不晚于 DDL）。
 */

import {
  deadlineToEpochMs,
  deadlineToShanghaiDateKey,
  isDateOnlyDeadline,
  shanghaiToday,
  type Weekday,
} from './datetime'
import { clockToMinutes } from './calendarClock'
import { listMeetingsInRange } from './calendar'
import type { Course, Schedule, Task } from './types'

/* --------------------------------- 常量 --------------------------------- */

export const MAX_STUDY_WINDOWS = 4
export const MAX_SELECTED_TASKS = 30
export const PLAN_MINUTES_MIN = 1
export const PLAN_MINUTES_MAX = 1440
export const MINUTES_PER_DAY = 1440
/** 保存下来的计划最多留多少块（防御性上限；超出即判定为不可用）。 */
export const MAX_SAVED_BLOCKS = 480
/** 存储格式版本（校验用；版本不认识就报「不可用」，绝不猜着解析）。 */
export const TODAY_PLAN_STORAGE_VERSION = 1

/* ------------------------------- 输入 / 输出 ------------------------------- */

export interface PlanMinuteRange {
  start: number
  end: number
}

export interface StudyWindowInput {
  start: string
  end: string
}

export interface NormalizedStudyWindow {
  start: string
  end: string
  startMinute: number
  endMinute: number
}

export interface PlanSelection {
  taskId: number
  /** 用户显式输入的整数分钟（1..1440）；**绝不**自动来自 `estimatedMinutes`。 */
  minutes: number
}

export type UnscheduledReason =
  | 'NO_WINDOW'
  | 'INSUFFICIENT_TIME'
  | 'DEADLINE_PASSED'
  | 'DEADLINE_NOW'
  | 'INVALID_DEADLINE'
  | 'MISSING_TASK'
  | 'INACTIVE_TASK'
  | 'INVALID_TARGET'
  /** 目标日期不是「由注入 now 得到的上海今天」（昨天的计划 / 跨零点的旧草稿）。 */
  | 'DATE_NOT_TODAY'
  /** 整份输入不合法（时段重叠、选择项重复 / 类型不对 / 超过上限），一条都不排。 */
  | 'INVALID_INPUT'

export interface UnscheduledInfo {
  reason: UnscheduledReason
  text: string
}

export interface PlanBlock {
  taskId: number
  taskTitle: string
  windowLabel: string
  startTime: string
  endTime: string
  startMinute: number
  endMinute: number
  minutes: number
}

export interface PlanTaskOutcome {
  taskId: number
  taskTitle: string
  courseId: number | null
  courseName: string | null
  status: Task['status']
  deadline: string | null
  targetMinutes: number
  scheduledMinutes: number
  unscheduledMinutes: number
  unscheduled: UnscheduledInfo | null
  blockCount: number
}

export interface TodayPlanContext {
  tasks: readonly Task[]
  schedules: readonly Schedule[]
  courses: readonly Course[]
}

export interface StudyWindowIssue {
  index: number
  field: 'start' | 'end' | 'range' | 'overlap'
  message: string
}

export interface StudyWindowValidation {
  ok: boolean
  windows: NormalizedStudyWindow[]
  issues: StudyWindowIssue[]
}

export interface TodayPlanFingerprint {
  date: string
  windows: string[]
  selections: Array<{ taskId: number; minutes: number }>
  /** 与「排布有关」的任务 / 课表 / 课程字段摘要（不含无关的 updatedAt）。 */
  contextDigest: string
  algorithmVersion: string
}

export interface TodayPlanInput {
  date: string
  now: Date
  windows: readonly StudyWindowInput[]
  selections: readonly PlanSelection[]
  tasks: readonly Task[]
  schedules: readonly Schedule[]
  courses: readonly Course[]
}

/** 计划块的最小身份（保存前重算比对用：**不含**任何「生成时刻」这类偶然字段）。 */
export interface PlanBlockIdentity {
  taskId: number
  startMinute: number
  endMinute: number
  minutes: number
  startTime: string
  endTime: string
}

export interface TodayPlan {
  date: string
  /** 排布用的「现在」锚点（毫秒）：预览与保存都用它，时间推进不会让块自己挪位。 */
  anchorEpochMs: number
  windowLabels: string[]
  blocks: PlanBlock[]
  outcomes: PlanTaskOutcome[]
  scheduledMinutes: number
  unscheduledMinutes: number
  targetMinutes: number
  hasUnscheduled: boolean
  emptyPlan: boolean
  /** 空闲缺口（裁到未来、已减掉课表）；`verifyTodayPlan` 用它检查块是否落在真实可用区间里。 */
  freeSlots: NormalizedStudyWindow[]
  /** 忙区间（已合并、clipped）。 */
  busyIntervals: NormalizedStudyWindow[]
  /** 输入级错误（非法输入 / 非今天）：有值时一块都不排。 */
  inputErrors: string[]
  fingerprint: TodayPlanFingerprint
  warnings: string[]
}

/* -------------------------------- 基础工具 -------------------------------- */

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 分钟数 → `HH:mm`（1440 会显示成 `24:00`）。 */
export function minuteToClock(minute: number): string {
  const safe = Math.max(0, Math.min(MINUTES_PER_DAY, Math.trunc(minute)))
  return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`
}

/** `HH:mm` → 当天分钟；不合法返回 `null`。 */
export function clockToMinuteStrict(value: unknown): number | null {
  return clockToMinutes(String(value ?? ''))
}

function windowLabelOf(window: { start: string; end: string }): string {
  return `${window.start}-${window.end}`
}

/**
 * 把某一刻换算成「上海自然日 + 当天分钟（向下取整）」。
 *
 * 千万不要用 `epochMs / 60000` 直接取整：那是 **UTC** 的分钟数，
 * 会算出与上海相差 8 小时的「当天第几分钟」，把计划排到完全错误的时间上。
 */
export function shanghaiMinuteOfDay(at: Date | number): { dateKey: string; minute: number; epochMs: number } | null {
  const epochMs = typeof at === 'number' ? at : at.getTime()
  if (!Number.isFinite(epochMs)) return null
  const dateKey = shanghaiToday(new Date(epochMs))
  if (!dateKey) return null
  const dayStartMs = Date.parse(`${dateKey}T00:00:00+08:00`)
  if (!Number.isFinite(dayStartMs)) return null
  const minute = Math.floor((epochMs - dayStartMs) / 60_000)
  if (minute < 0 || minute >= MINUTES_PER_DAY) return null
  return { dateKey, minute, epochMs }
}

/** 「这一分钟」的起点（毫秒）。 */
export function minuteEpochMs(dateKey: string, minute: number): number | null {
  const dayStartMs = Date.parse(`${dateKey}T00:00:00+08:00`)
  if (!Number.isFinite(dayStartMs)) return null
  return dayStartMs + minute * 60_000
}

/**
 * 「现在」向上取整到下一分钟（**按上海当天换算**）。
 *
 * - `10:00:00.001` → `10:01`（那一分钟只剩不到 1 秒，算成「有一分钟可用」是假的）；
 * - **正好整分**（`10:00:00.000`）→ 保持这一分钟；
 * - 当天最后一分钟（`23:59:30`）→ `1440`，表示**当天已经没有剩余容量**；
 *   调用方用「目标日期是否等于 now 的上海日期」来拒绝跨天，绝不会回头打开白天的时段。
 *
 * 实现上刻意用**整数毫秒**做除法：直接对浮点分钟数取整会被 `Date.parse` 的
 * 亚毫秒误差影响，把一个正好在整分上的时刻推到下一分钟。
 *
 * `now` 非法（`Invalid Date`）时返回 `null`，**不用 `Date.now()` 兜底**。
 */
export function ceilToNextMinute(now: Date): { epochMs: number; dateKey: string; minute: number } | null {
  const epochMs = now.getTime()
  if (!Number.isFinite(epochMs)) return null
  const dateKey = shanghaiToday(now)
  if (!dateKey) return null
  const dayStartMs = Date.parse(`${dateKey}T00:00:00+08:00`)
  if (!Number.isFinite(dayStartMs)) return null
  const elapsedMs = epochMs - dayStartMs
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return null
  const minute = Math.ceil(elapsedMs / 60_000)
  if (!Number.isFinite(minute) || minute < 0) return null
  return { epochMs, dateKey, minute: Math.min(minute, MINUTES_PER_DAY) }
}

/**
 * DDL 的「最后可安排到的分钟」：按分钟**向下取整**，且必须在上海当天之内。
 *
 * 只到日期的 DDL 返回 `minute = 1440`（当天结束），因此计划可以排满这一天，
 * 而不是被当成 00:00 或 23:59 的精确时刻。
 */
export function floorToMinuteOfShanghaiDay(value: unknown): { dateKey: string; minute: number } | null {
  if (isDateOnlyDeadline(value)) {
    return { dateKey: String(value).trim(), minute: MINUTES_PER_DAY }
  }
  const epochMs = deadlineToEpochMs(value)
  if (epochMs === null) return null
  const dateKey = deadlineToShanghaiDateKey(value)
  if (!dateKey) return null
  const dayStartMs = Date.parse(`${dateKey}T00:00:00+08:00`)
  if (!Number.isFinite(dayStartMs)) return null
  const minute = Math.floor((epochMs - dayStartMs) / 60_000)
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) return null
  return { dateKey, minute }
}

/* ------------------------------ 学习时段校验 ------------------------------ */

/** 校验并归一化用户输入的学习时段（规则见文件头）。 */
export function validateStudyWindows(input: readonly StudyWindowInput[]): StudyWindowValidation {
  const issues: StudyWindowIssue[] = []
  const raw: Array<{ index: number; startMinute: number; endMinute: number }> = []
  const overLimitMessage = `最多只能填 ${MAX_STUDY_WINDOWS} 段学习时段，请先合并或删掉多余的。`

  const list = Array.isArray(input) ? input : []
  const filledCount = list.filter(
    (entry) => String(entry?.start ?? '').trim().length > 0 || String(entry?.end ?? '').trim().length > 0,
  ).length
  if (filledCount > MAX_STUDY_WINDOWS) {
    return { ok: false, windows: [], issues: [{ index: MAX_STUDY_WINDOWS, field: 'range', message: overLimitMessage }] }
  }

  list.forEach((entry, index) => {
    const startText = String(entry?.start ?? '').trim()
    const endText = String(entry?.end ?? '').trim()
    if (startText.length === 0 && endText.length === 0) return
    if (startText.length === 0 || endText.length === 0) {
      issues.push({ index, field: startText.length === 0 ? 'start' : 'end', message: '开始与结束时间都要填（格式 HH:mm）。' })
      return
    }
    const startMinute = clockToMinutes(startText)
    const endMinute = clockToMinutes(endText)
    if (startMinute === null) {
      issues.push({ index, field: 'start', message: `开始时间「${startText}」不是合法时间（要写成 08:00 这种 HH:mm）。` })
      return
    }
    if (endMinute === null) {
      issues.push({ index, field: 'end', message: `结束时间「${endText}」不是合法时间（要写成 09:30 这种 HH:mm）。` })
      return
    }
    if (startMinute >= endMinute) {
      issues.push({
        index,
        field: 'range',
        message: `结束时间必须晚于开始时间（${startText}–${endText}）；本页不支持跨天时段。`,
      })
      return
    }
    raw.push({ index, startMinute, endMinute })
  })

  const sorted = [...raw].sort((a, b) => a.startMinute - b.startMinute || a.index - b.index)
  for (let cursor = 1; cursor < sorted.length; cursor += 1) {
    const previous = sorted[cursor - 1]!
    const current = sorted[cursor]!
    if (current.startMinute < previous.endMinute) {
      issues.push({
        index: current.index,
        field: 'overlap',
        message:
          `学习时段与第 ${previous.index + 1} 段重叠（${minuteToClock(previous.startMinute)}–${minuteToClock(previous.endMinute)} ` +
          `与 ${minuteToClock(current.startMinute)}–${minuteToClock(current.endMinute)}）。请改成互不重叠的时段（首尾相接可以）。`,
      })
    }
  }

  if (issues.length > 0) return { ok: false, windows: [], issues }

  const windows: NormalizedStudyWindow[] = sorted.map((entry) => ({
    start: minuteToClock(entry.startMinute),
    end: minuteToClock(entry.endMinute),
    startMinute: entry.startMinute,
    endMinute: entry.endMinute,
  }))
  return { ok: true, windows, issues: [] }
}

/* ------------------------------ 选择项严格校验 ------------------------------ */

export interface SelectionValidation {
  /**
   * 整份列表能不能用：`false` = **一个块都不排**（超限 / 编号类型不对 / 重复）。
   * 注意 `selections` 仍然会带上「能解析出来的那些条目」，
   * 这样界面和计划结果里**每一个选择项都有结论**，不会有条目被静默吞掉。
   */
  ok: boolean
  selections: PlanSelection[]
  errors: string[]
}

function isPositiveSafeIntegerId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 选择项的**形状**严格校验（任务 id 必须是正整数、不能重复、不能超过 30 条）。
 *
 * 这一层只关心「这份列表本身能不能用」：任何一条不满足 → **整份计划不可排**（零块），
 * 而且真正排布时也只认 `ok === true` 的结果。
 * 「分钟数」不在这一层判定（见 {@link normalizePlanMinutes}）：分钟数写错只是**那个任务**
 * 排不进去（`INVALID_TARGET`），不应该把其它任务一起废掉。
 *
 * **不做任何 `Number()` 兜底**：`true`、`'1e2'`、`[60]` 这类值一律拒绝 ——
 * `Number()` 一下会把 `true` 变成 `1`、把 `[60]` 变成 `60`，
 * 于是悄悄接受一个用户从没填过的值（历史缺陷，复核点名过）。
 */
export function validatePlanSelections(input: unknown): SelectionValidation {
  if (!Array.isArray(input)) return { ok: false, selections: [], errors: ['选择的任务列表格式不对。'] }
  const errors: string[] = []
  const selections: PlanSelection[] = []
  const seen = new Set<number>()
  if (input.length > MAX_SELECTED_TASKS) {
    errors.push(`最多只能选 ${MAX_SELECTED_TASKS} 个任务，现在有 ${input.length} 个。`)
  }
  input.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      errors.push(`第 ${index + 1} 个选择项格式不对。`)
      return
    }
    const rawId = (entry as { taskId?: unknown }).taskId
    if (!isPositiveSafeIntegerId(rawId)) {
      errors.push(`第 ${index + 1} 个选择项的任务编号不合法（必须是正整数，不能是字符串或布尔值）。`)
      return
    }
    const taskId = rawId as number
    const rawMinutes = (entry as { minutes?: unknown }).minutes
    // 形状层只要求「能解析成 1–1440 的整数」；解析不出来时先记 0（排布层会标 INVALID_TARGET）。
    const minutes = normalizePlanMinutes(rawMinutes) ?? 0
    if (seen.has(taskId)) {
      errors.push(`任务 #${taskId} 被重复选中了，请只保留一条。`)
      // 保留第一次出现的那条结论（同一个任务只报告一次，不重复计数）。
      return
    }
    seen.add(taskId)
    selections.push({ taskId, minutes })
  })
  return { ok: errors.length === 0, selections, errors }
}

/** 合法的计划分钟数（1..1440 的整数）；非法返回 `null`（不做 `Number()` 兜底）。 */
export function normalizePlanMinutes(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= PLAN_MINUTES_MIN && value <= PLAN_MINUTES_MAX ? value : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const parsed = Number(text)
  return Number.isInteger(parsed) && parsed >= PLAN_MINUTES_MIN && parsed <= PLAN_MINUTES_MAX ? parsed : null
}

/* ------------------------------- 区间运算 ------------------------------- */

function clampRange(range: PlanMinuteRange, from: number, to: number): PlanMinuteRange | null {
  const start = Math.max(range.start, from)
  const end = Math.min(range.end, to)
  return end > start ? { start, end } : null
}

/** 合并重叠或**相邻**的区间（相邻也合并：中间没有可利用的一分钟）。 */
export function mergeBusyIntervals(ranges: readonly PlanMinuteRange[]): PlanMinuteRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map((range) => ({ start: Math.trunc(range.start), end: Math.trunc(range.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: PlanMinuteRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

/** 从 `windows` 里减掉 `busy`，返回剩余区间（升序、互不相邻）。 */
export function subtractIntervals(
  windows: readonly PlanMinuteRange[],
  busy: readonly PlanMinuteRange[],
): PlanMinuteRange[] {
  const mergedBusy = mergeBusyIntervals(busy)
  const result: PlanMinuteRange[] = []
  for (const window of mergeBusyIntervals(windows)) {
    let cursor = window.start
    for (const block of mergedBusy) {
      if (block.end <= cursor) continue
      if (block.start >= window.end) break
      if (block.start > cursor) result.push({ start: cursor, end: Math.min(block.start, window.end) })
      cursor = Math.max(cursor, block.end)
      if (cursor >= window.end) break
    }
    if (cursor < window.end) result.push({ start: cursor, end: window.end })
  }
  return mergeBusyIntervals(result)
}

/* ------------------------------- 上下文摘要 ------------------------------- */

/**
 * 与「排布有关」的内容摘要（稳定的短字符串，不是哈希）。
 *
 * 只取真正参与排布的字段：改一个无关字段（例如提交方式）不该让预览失效。
 * 反过来，**故意不含任何时间戳**：`updatedAt` 差几毫秒不能让每一次保存都变成「已过期」。
 */
export function todayPlanContextDigest(context: TodayPlanContext): string {
  const tasks = [...context.tasks]
    .map((task) => ({
      id: Number(task.id),
      status: String(task.status ?? ''),
      deadline: task.deadline === null || task.deadline === undefined ? '' : String(task.deadline),
      priority: Number(task.priority ?? 0),
      courseId: task.courseId === null || task.courseId === undefined ? '' : String(task.courseId),
      estimate: task.estimatedMinutes === null || task.estimatedMinutes === undefined ? '' : String(task.estimatedMinutes),
      title: String(task.title ?? ''),
    }))
    .sort((a, b) => a.id - b.id)
  const schedules = [...context.schedules]
    .map((schedule) => ({
      id: Number(schedule.id),
      courseId: Number(schedule.courseId),
      weekday: Number(schedule.weekday),
      startTime: String(schedule.startTime ?? ''),
      endTime: String(schedule.endTime ?? ''),
      term: String(schedule.semesterStartDate ?? ''),
      startWeek: schedule.startWeek === null || schedule.startWeek === undefined ? '' : String(schedule.startWeek),
      endWeek: schedule.endWeek === null || schedule.endWeek === undefined ? '' : String(schedule.endWeek),
      pattern: String(schedule.weekPattern ?? ''),
    }))
    .sort((a, b) => a.id - b.id)
  const courses = [...context.courses]
    .map((course) => ({ id: Number(course.id), name: String(course.name ?? '') }))
    .sort((a, b) => a.id - b.id)
  return `T:${JSON.stringify(tasks)}|S:${JSON.stringify(schedules)}|C:${JSON.stringify(courses)}`
}

export function todayPlanFingerprint(input: {
  date: string
  windows: readonly NormalizedStudyWindow[]
  selections: readonly PlanSelection[]
  context: TodayPlanContext
}): TodayPlanFingerprint {
  return {
    date: input.date,
    windows: input.windows.map((window) => windowLabelOf(window)),
    selections: [...input.selections]
      .map((selection) => ({ taskId: Number(selection.taskId), minutes: Number(selection.minutes) }))
      .sort((a, b) => a.taskId - b.taskId || a.minutes - b.minutes),
    contextDigest: todayPlanContextDigest(input.context),
    algorithmVersion: `${TODAY_PLAN_STORAGE_VERSION}`,
  }
}

/** 两个指纹是否描述同一次输入（顺序无关）。 */
export function sameTodayPlanFingerprint(a: TodayPlanFingerprint, b: TodayPlanFingerprint): boolean {
  if (!a || !b) return false
  if (a.date !== b.date) return false
  if (a.algorithmVersion !== b.algorithmVersion) return false
  if (a.contextDigest !== b.contextDigest) return false
  if (a.windows.length !== b.windows.length) return false
  for (let index = 0; index < a.windows.length; index += 1) {
    if (a.windows[index] !== b.windows[index]) return false
  }
  if (a.selections.length !== b.selections.length) return false
  for (let index = 0; index < a.selections.length; index += 1) {
    const left = a.selections[index]!
    const right = b.selections[index]!
    if (left.taskId !== right.taskId || left.minutes !== right.minutes) return false
  }
  return true
}

/** 计划块的规范身份（预览与保存重算比对用；**不含**任何生成时刻）。 */
export function planBlockIdentity(plan: Pick<TodayPlan, 'blocks'>): PlanBlockIdentity[] {
  return [...(plan.blocks ?? [])]
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.taskId - b.taskId)
    .map((block) => ({
      taskId: block.taskId,
      startMinute: block.startMinute,
      endMinute: block.endMinute,
      minutes: block.minutes,
      startTime: block.startTime,
      endTime: block.endTime,
    }))
}

/** 两份计划的「块身份 + 每任务结果」是否一致（忽略 anchor 等偶然字段）。 */
export function samePlanResult(a: TodayPlan, b: TodayPlan): boolean {
  const left = planBlockIdentity(a)
  const right = planBlockIdentity(b)
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const one = left[index]!
    const two = right[index]!
    if (
      one.taskId !== two.taskId ||
      one.startMinute !== two.startMinute ||
      one.endMinute !== two.endMinute ||
      one.minutes !== two.minutes
    ) {
      return false
    }
  }
  if (a.outcomes.length !== b.outcomes.length) return false
  const byTask = new Map(b.outcomes.map((outcome) => [outcome.taskId, outcome]))
  for (const outcome of a.outcomes) {
    const other = byTask.get(outcome.taskId)
    if (!other) return false
    if (outcome.scheduledMinutes !== other.scheduledMinutes) return false
    if (outcome.unscheduledMinutes !== other.unscheduledMinutes) return false
    if (outcome.targetMinutes !== other.targetMinutes) return false
  }
  return a.scheduledMinutes === b.scheduledMinutes && a.unscheduledMinutes === b.unscheduledMinutes
}

/* --------------------------------- 计划生成 --------------------------------- */

const UNSCHEDULED_TEXT: Record<UnscheduledReason, string> = {
  NO_WINDOW: '今天没有可用的学习时段（没有填写，或填的时间已经过去）。',
  INSUFFICIENT_TIME: '今天剩余的空闲时间不够，先把 DDL 更早的任务排满之后就放不下了。',
  DEADLINE_PASSED: '截止时间已经过去，无法再排进今天的计划。',
  DEADLINE_NOW: '截止时间正好是现在这一刻，已经没有可安排的分钟。',
  INVALID_DEADLINE: '截止时间格式无法识别，请打开任务重新填一个真实时间。',
  MISSING_TASK: '这个任务已经不在了（可能已被删除）。',
  INACTIVE_TASK: '任务已完成或已取消，不再安排。',
  INVALID_TARGET: `计划分钟数要是 ${PLAN_MINUTES_MIN}–${PLAN_MINUTES_MAX} 之间的整数。`,
  DATE_NOT_TODAY: '这份草稿不是今天的（可能跨过了零点），请以今天重新开始。',
  INVALID_INPUT: '这份输入有错误（时段或选择项），修正之后才能生成计划。',
}

function unscheduled(reason: UnscheduledReason): UnscheduledInfo {
  return { reason, text: UNSCHEDULED_TEXT[reason] }
}

function estimateMinutesOf(task: Pick<Task, 'estimatedMinutes'>): number | null {
  const value = task?.estimatedMinutes
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 0 || value > 100_000) return null
  return value
}

interface DeadlineInfo {
  dateKey: string
  lastMinute: number
  epochMs: number
}

/**
 * 计划里每个任务的可安排边界（仓库重算比对与自检共用）。
 *
 * 返回的是**由输入推导出来的**事实（不依赖计划块），因此可以拿来检查块有没有越界。
 */
export function planTaskMetaOf(input: {
  date: string
  selections: readonly PlanSelection[]
  tasks: readonly Task[]
}): Map<number, { taskId: number; lastMinute: number; deadlineEpochMs: number | null; active: boolean }> {
  const meta = new Map<number, { taskId: number; lastMinute: number; deadlineEpochMs: number | null; active: boolean }>()
  const taskById = new Map<number, Task>()
  for (const task of input.tasks ?? []) taskById.set(Number(task.id), task)
  for (const selection of input.selections ?? []) {
    const task = taskById.get(Number(selection.taskId)) ?? null
    if (!task) {
      meta.set(Number(selection.taskId), { taskId: Number(selection.taskId), lastMinute: 0, deadlineEpochMs: null, active: false })
      continue
    }
    const active = task.status === 'TODO' || task.status === 'DOING'
    let lastMinute = MINUTES_PER_DAY
    let deadlineEpochMs: number | null = null
    if (task.deadline !== null && task.deadline !== undefined && String(task.deadline).trim().length > 0) {
      const floored = floorToMinuteOfShanghaiDay(task.deadline)
      const epoch = deadlineToEpochMs(task.deadline)
      if (floored && epoch !== null) {
        deadlineEpochMs = epoch
        lastMinute = floored.dateKey === input.date ? floored.minute : MINUTES_PER_DAY
      } else {
        lastMinute = 0
      }
    }
    meta.set(Number(selection.taskId), { taskId: Number(selection.taskId), lastMinute, deadlineEpochMs, active })
  }
  return meta
}

/** 生成今日计划（纯函数；输入对象不会被修改）。 */
export function buildTodayPlan(input: TodayPlanInput): TodayPlan {
  const date = String(input.date ?? '')
  const now = input.now
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN
  const anchor = now instanceof Date ? ceilToNextMinute(now) : null
  const selectionValidation = validatePlanSelections(input.selections)
  const windowValidation = validateStudyWindows(input.windows ?? [])

  const inputErrors: string[] = []
  let blockReason: UnscheduledReason = 'INVALID_INPUT'
  if (!Number.isFinite(nowMs) || !anchor) inputErrors.push('「现在」这个时间点不可用，请稍后再试。')
  if (!date) inputErrors.push('没有给出生效日期。')
  if (anchor && date && anchor.dateKey !== date && inputErrors.length === 0) {
    inputErrors.push(`这份计划的目标日期是 ${date}，但现在已经是 ${anchor.dateKey} 了（跨过了零点），请以今天重新开始。`)
    blockReason = 'DATE_NOT_TODAY'
  }
  if (!windowValidation.ok) inputErrors.push(...windowValidation.issues.map((issue) => issue.message))
  if (!selectionValidation.ok) inputErrors.push(...selectionValidation.errors)

  const context: TodayPlanContext = {
    tasks: input.tasks ?? [],
    schedules: input.schedules ?? [],
    courses: input.courses ?? [],
  }
  const windows = windowValidation.ok ? windowValidation.windows : []
  const selections = selectionValidation.ok ? selectionValidation.selections : []
  const fingerprint = todayPlanFingerprint({ date, windows, selections, context })

  if (inputErrors.length > 0) {
    return blockedPlan({
      date,
      context,
      windows,
      // 即使整份输入被拒，也要把**能解析出来的那些选择项**逐条给出结论（零块 + 原因），
      // 这样界面上不会出现「某个选中任务悄悄消失了」。
      selections: selections.length > 0 ? selections : selectionValidation.selections,
      inputErrors,
      reason: blockReason,
      anchorEpochMs: Number.isFinite(nowMs) ? nowMs : 0,
    })
  }

  const anchorMinute = anchor!.minute
  const nowDateKey = anchor!.dateKey
  const taskById = new Map<number, Task>()
  for (const task of context.tasks) taskById.set(Number(task.id), task)

  const scheduleBusyResult = busyFromSchedules(context.schedules, context.courses, date)
  const warnings = [...scheduleBusyResult.warnings]

  // 学习时段裁到「未来部分」。
  const dayWindows: PlanMinuteRange[] = []
  for (const window of windows) {
    const clipped = clampRange({ start: window.startMinute, end: window.endMinute }, anchorMinute, MINUTES_PER_DAY)
    if (clipped) dayWindows.push(clipped)
  }
  const mergedWindows = mergeBusyIntervals(dayWindows)
  const busyIntervals = mergeBusyIntervals(scheduleBusyResult.busy).filter(
    (range) => range.start < MINUTES_PER_DAY && range.end > 0,
  )
  const freeSlotsRanges = subtractIntervals(mergedWindows, busyIntervals)
  const freeSlots: NormalizedStudyWindow[] = freeSlotsRanges.map((range) => ({
    start: minuteToClock(range.start),
    end: minuteToClock(range.end),
    startMinute: range.start,
    endMinute: range.end,
  }))

  interface Candidate {
    selection: PlanSelection
    task: Task | null
    deadline: DeadlineInfo | null
    blocked: UnscheduledInfo | null
  }

  const candidates: Candidate[] = selections.map((selection) => {
    const task = taskById.get(selection.taskId) ?? null
    if (!task) return { selection, task: null, deadline: null, blocked: unscheduled('MISSING_TASK') }
    if (task.status !== 'TODO' && task.status !== 'DOING') {
      return { selection, task, deadline: null, blocked: unscheduled('INACTIVE_TASK') }
    }
    // 分钟数不合法（0 / 越界 / 解析不出来）→ **这个任务**排不进去，其它任务照常排。
    if (normalizePlanMinutes(selection.minutes) === null) {
      return { selection, task, deadline: null, blocked: unscheduled('INVALID_TARGET') }
    }
    if (task.deadline !== null && task.deadline !== undefined && String(task.deadline).trim().length > 0) {
      const parsed = floorToMinuteOfShanghaiDay(task.deadline)
      const deadlineEpoch = deadlineToEpochMs(task.deadline)
      if (!parsed || deadlineEpoch === null) return { selection, task, deadline: null, blocked: unscheduled('INVALID_DEADLINE') }
      if (parsed.dateKey < nowDateKey) {
        return { selection, task, deadline: null, blocked: unscheduled('DEADLINE_PASSED') }
      }
      if (parsed.dateKey === nowDateKey) {
        if (deadlineEpoch <= nowMs) {
          const blocked: UnscheduledReason = deadlineEpoch === nowMs ? 'DEADLINE_NOW' : 'DEADLINE_PASSED'
          return { selection, task, deadline: null, blocked: unscheduled(blocked) }
        }
        // 显式映射：`floorToMinuteOfShanghaiDay` 返回的是 `minute`，这里必须写成 `lastMinute`。
        const sameDay: DeadlineInfo = { dateKey: parsed.dateKey, lastMinute: parsed.minute, epochMs: deadlineEpoch }
        return { selection, task, deadline: sameDay, blocked: null }
      }
      return {
        selection,
        task,
        deadline: { dateKey: parsed.dateKey, lastMinute: MINUTES_PER_DAY, epochMs: deadlineEpoch },
        blocked: null,
      }
    }
    return { selection, task, deadline: null, blocked: null }
  })

  const runnable = candidates
    .filter((candidate) => candidate.blocked === null && candidate.task !== null)
    .sort((a, b) => {
      const left = a.deadline
      const right = b.deadline
      if (left && right) {
        if (left.epochMs !== right.epochMs) return left.epochMs - right.epochMs
      } else if (left) {
        return -1
      } else if (right) {
        return 1
      }
      const priorityDiff = Number(b.task!.priority ?? 0) - Number(a.task!.priority ?? 0)
      if (priorityDiff !== 0) return priorityDiff
      return Number(a.task!.id) - Number(b.task!.id)
    })

  const gaps: PlanMinuteRange[] = freeSlotsRanges.map((range) => ({ ...range }))
  const blocks: PlanBlock[] = []
  const allocated = new Map<number, number>()
  const blockCounts = new Map<number, number>()

  for (const candidate of runnable) {
    const task = candidate.task!
    let remaining = candidate.selection.minutes
    const lastMinute = Math.min(candidate.deadline ? candidate.deadline.lastMinute : MINUTES_PER_DAY, MINUTES_PER_DAY)

    for (let cursor = 0; cursor < gaps.length && remaining > 0; ) {
      const gap = gaps[cursor]!
      const start = Math.max(gap.start, anchorMinute)
      const end = Math.min(gap.end, lastMinute)
      if (end <= start) {
        cursor += 1
        continue
      }
      const take = Math.min(remaining, end - start)
      if (take < 1) {
        cursor += 1
        continue
      }
      blocks.push({
        taskId: task.id,
        taskTitle: task.title,
        windowLabel: windowLabelOf(findWindowFor(mergedWindows, start, start + take)),
        startTime: minuteToClock(start),
        endTime: minuteToClock(start + take),
        startMinute: start,
        endMinute: start + take,
        minutes: take,
      })
      remaining -= take
      blockCounts.set(task.id, (blockCounts.get(task.id) ?? 0) + 1)
      allocated.set(task.id, (allocated.get(task.id) ?? 0) + take)
      // 消费掉这一段：缺口头部去掉，尾部保留（后面的任务还能用）。
      if (gap.start < start) {
        gaps[cursor] = { start: gap.start, end: start }
        if (start + take < gap.end) gaps.splice(cursor + 1, 0, { start: start + take, end: gap.end })
        cursor += 1
      } else if (gap.end > start + take) {
        gaps[cursor] = { start: start + take, end: gap.end }
      } else {
        gaps.splice(cursor, 1)
      }
    }
  }

  const outcomes: PlanTaskOutcome[] = candidates.map((candidate) => {
    const task = candidate.task
    const targetMinutes = candidate.selection.minutes
    const scheduledMinutes = task ? allocated.get(task.id) ?? 0 : 0
    const course = task ? context.courses.find((entry) => Number(entry.id) === Number(task.courseId)) ?? null : null
    let info: UnscheduledInfo | null = candidate.blocked
    if (!info && scheduledMinutes < targetMinutes) {
      info = mergedWindows.length === 0 ? unscheduled('NO_WINDOW') : unscheduled('INSUFFICIENT_TIME')
    }
    return {
      taskId: candidate.selection.taskId,
      taskTitle: task ? task.title : `#${candidate.selection.taskId}`,
      courseId: task ? task.courseId : null,
      courseName: course ? course.name : null,
      status: task ? task.status : 'TODO',
      deadline: task ? task.deadline : null,
      targetMinutes,
      scheduledMinutes,
      unscheduledMinutes: targetMinutes > scheduledMinutes ? targetMinutes - scheduledMinutes : 0,
      unscheduled: info,
      blockCount: task ? blockCounts.get(task.id) ?? 0 : 0,
    }
  })

  const scheduledMinutes = outcomes.reduce((total, outcome) => total + outcome.scheduledMinutes, 0)
  const targetMinutes = outcomes.reduce((total, outcome) => total + outcome.targetMinutes, 0)
  const unscheduledMinutes = outcomes.reduce((total, outcome) => total + outcome.unscheduledMinutes, 0)

  const unknownEstimate = context.tasks.filter(
    (task) => selections.some((selection) => selection.taskId === Number(task.id)) && estimateMinutesOf(task) === null,
  )
  if (unknownEstimate.length > 0) {
    warnings.push(`有 ${unknownEstimate.length} 个选中任务没有填过预计用时：计划分钟数必须由你确认，应用不会替你估一个数。`)
  }
  const doingSelected = context.tasks.filter(
    (task) => task.status === 'DOING' && selections.some((selection) => selection.taskId === Number(task.id)),
  )
  if (doingSelected.length > 0) {
    warnings.push(`有 ${doingSelected.length} 个任务正在进行中：进行中的进度没有被测量，计划分钟数仍然以你填的为准。`)
  }

  return {
    date,
    anchorEpochMs: anchor!.epochMs,
    windowLabels: mergedWindows.map((window) =>
      windowLabelOf({ start: minuteToClock(window.start), end: minuteToClock(window.end) }),
    ),
    blocks,
    outcomes,
    scheduledMinutes,
    unscheduledMinutes,
    targetMinutes,
    hasUnscheduled: unscheduledMinutes > 0,
    emptyPlan: blocks.length === 0,
    freeSlots,
    busyIntervals: busyIntervals.map((range) => ({
      start: minuteToClock(range.start),
      end: minuteToClock(range.end),
      startMinute: range.start,
      endMinute: range.end,
    })),
    inputErrors: [],
    fingerprint,
    warnings,
  }
}

/** 输入不合法时给出的「零块」计划（绝不排一半）。 */
function blockedPlan(input: {
  date: string
  context: TodayPlanContext
  windows: NormalizedStudyWindow[]
  selections: PlanSelection[]
  inputErrors: string[]
  reason: UnscheduledReason
  anchorEpochMs: number
}): TodayPlan {
  const taskById = new Map<number, Task>()
  for (const task of input.context.tasks) taskById.set(Number(task.id), task)
  const outcomes: PlanTaskOutcome[] = input.selections.map((selection) => {
    const task = taskById.get(selection.taskId) ?? null
    // 关联了课程就把课程名一起带上（否则读回时「有 courseId 却没有名字」会被判为坏数据）。
    const course = task && task.courseId !== null ? input.context.courses.find((entry) => Number(entry.id) === Number(task.courseId)) ?? null : null
    return {
      taskId: selection.taskId,
      taskTitle: task ? task.title : `#${selection.taskId}`,
      courseId: task ? task.courseId : null,
      courseName: course ? course.name : null,
      status: task ? task.status : 'TODO',
      deadline: task ? task.deadline : null,
      targetMinutes: selection.minutes,
      scheduledMinutes: 0,
      unscheduledMinutes: selection.minutes,
      unscheduled: unscheduled(input.reason),
      blockCount: 0,
    }
  })
  return {
    date: input.date,
    anchorEpochMs: input.anchorEpochMs,
    windowLabels: [],
    blocks: [],
    outcomes,
    scheduledMinutes: 0,
    unscheduledMinutes: outcomes.reduce((total, outcome) => total + outcome.unscheduledMinutes, 0),
    targetMinutes: outcomes.reduce((total, outcome) => total + outcome.targetMinutes, 0),
    hasUnscheduled: outcomes.length > 0,
    emptyPlan: true,
    freeSlots: [],
    busyIntervals: [],
    inputErrors: input.inputErrors,
    fingerprint: todayPlanFingerprint({
      date: input.date,
      windows: input.windows,
      selections: input.selections,
      context: input.context,
    }),
    warnings: [],
  }
}

function busyFromSchedules(
  schedules: readonly Schedule[],
  courses: readonly Course[],
  dateKey: string,
): { busy: PlanMinuteRange[]; warnings: string[] } {
  const busy: PlanMinuteRange[] = []
  const warnings: string[] = []
  let skipped = 0
  for (const meeting of listMeetingsInRange(schedules, courses, dateKey, dateKey)) {
    const start = clockToMinutes(meeting.schedule.startTime)
    const end = clockToMinutes(meeting.schedule.endTime)
    if (start === null || end === null || start >= end) {
      skipped += 1
      continue
    }
    busy.push({ start, end })
  }
  if (skipped > 0) warnings.push(`有 ${skipped} 条今天的课表时间格式不完整，已跳过（不会当作占用时间）。`)
  return { busy, warnings }
}

/** 找到某个分钟区间落在哪个（已合并的）学习时段里；找不到时给一个退化标签。 */
function findWindowFor(windows: readonly PlanMinuteRange[], start: number, end: number): { start: string; end: string } {
  for (const window of windows) {
    if (start >= window.start && end <= window.end) {
      return { start: minuteToClock(window.start), end: minuteToClock(window.end) }
    }
  }
  return { start: minuteToClock(start), end: minuteToClock(end) }
}

/* ------------------------------- 结果自检 ------------------------------- */

export interface TodayPlanVerification {
  ok: boolean
  errors: string[]
}

/**
 * 对一份计划做**自检**（生产代码与测试共用）。检查的是硬不变量：
 *
 * 1. 块的起止与分钟都是**有限整数**，`minutes >= 1`，且 `end - start === minutes`；
 * 2. `HH:mm` 文案与分钟数一致；
 * 3. 块身份唯一，同一任务的块两两不重叠；
 * 4. 块落在**真实空闲缺口**里（不只是「在窗口内」——窗口里的上课时间不算可用）；
 * 5. 块不与任何忙区间相交；
 * 6. 每个任务的 `已排 + 未排 = 计划分钟数`，块合计与 outcome 一致；
 * 7. outcome 的任务 id 唯一、块的任务 id 都能对上 outcome，整份合计一致；
 * 8. 已排分钟数不超过空闲缺口总容量。
 */
export function verifyTodayPlan(plan: TodayPlan): TodayPlanVerification {
  const errors: string[] = []
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['计划对象不可用。'] }

  const slots = Array.isArray(plan.freeSlots) ? plan.freeSlots : []
  const busy = Array.isArray(plan.busyIntervals) ? plan.busyIntervals : []
  const scheduledByTask = new Map<number, number>()
  const seenIdentity = new Set<string>()
  const blocksByTask = new Map<number, PlanBlock[]>()

  for (const block of plan.blocks ?? []) {
    if (!Number.isInteger(block.taskId) || block.taskId <= 0) {
      errors.push(`块的任务编号不合法：${String(block.taskId)}。`)
    }
    if (!Number.isInteger(block.startMinute) || !Number.isInteger(block.endMinute)) {
      errors.push(`块 ${block.taskId} 的起止不是整数（${String(block.startMinute)}–${String(block.endMinute)}）。`)
      continue
    }
    if (!Number.isInteger(block.minutes) || block.minutes < 1) {
      errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 的分钟数不是正整数。`)
    }
    if (block.endMinute <= block.startMinute) {
      errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 的结束不晚于开始（零时长）。`)
    }
    if (block.endMinute - block.startMinute !== block.minutes) {
      errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 的分钟数与起止时间不一致。`)
    }
    if (minuteToClock(block.startMinute) !== block.startTime || minuteToClock(block.endMinute) !== block.endTime) {
      errors.push(`块 ${block.taskId} 的 HH:mm 文案与分钟数对不上（${block.startTime}-${block.endTime}）。`)
    }
    const identity = `${block.taskId}:${block.startMinute}`
    if (seenIdentity.has(identity)) errors.push(`块 ${identity} 出现了两次（身份不唯一）。`)
    seenIdentity.add(identity)

    const insideSlot = slots.some((slot) => block.startMinute >= slot.startMinute && block.endMinute <= slot.endMinute)
    if (slots.length === 0 || !insideSlot) {
      errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 不在真实的空闲缺口里（可能压到了上课时间）。`)
    }
    for (const range of busy) {
      if (block.startMinute < range.endMinute && block.endMinute > range.startMinute) {
        errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 与忙区间 ${range.start}-${range.end} 相交。`)
      }
    }

    const list = blocksByTask.get(block.taskId) ?? []
    list.push(block)
    blocksByTask.set(block.taskId, list)
    scheduledByTask.set(block.taskId, (scheduledByTask.get(block.taskId) ?? 0) + block.minutes)
  }

  for (const [taskId, list] of blocksByTask) {
    const sorted = [...list].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)
    for (let cursor = 1; cursor < sorted.length; cursor += 1) {
      if (sorted[cursor]!.startMinute < sorted[cursor - 1]!.endMinute) {
        errors.push(`任务 ${taskId} 的两块计划时间重叠了。`)
      }
    }
  }

  /**
   * **跨任务**也不能重叠：两个任务同时占用 18:00–18:30 是物理上不可能的，
   * 不管它们分属哪个任务。相邻（前一块 18:00–18:30、后一块 18:30–19:00）是允许的。
   */
  const allBlocks = [...(plan.blocks ?? [])]
    .filter((block) => Number.isInteger(block.startMinute) && Number.isInteger(block.endMinute))
    .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.taskId - b.taskId)
  for (let cursor = 1; cursor < allBlocks.length; cursor += 1) {
    const previous = allBlocks[cursor - 1]!
    const current = allBlocks[cursor]!
    if (current.startMinute < previous.endMinute) {
      errors.push(
        `任务 ${previous.taskId}（${previous.startTime}-${previous.endTime}）与任务 ${current.taskId}（${current.startTime}-${current.endTime}）的计划时间重叠了。`,
      )
    }
  }

  const seenOutcome = new Set<number>()
  for (const outcome of plan.outcomes ?? []) {
    if (seenOutcome.has(outcome.taskId)) errors.push(`任务 ${outcome.taskId} 出现了多条结果。`)
    seenOutcome.add(outcome.taskId)
    if (outcome.scheduledMinutes + outcome.unscheduledMinutes !== outcome.targetMinutes) {
      errors.push(
        `任务 ${outcome.taskId} 的「已排 ${outcome.scheduledMinutes} + 未排 ${outcome.unscheduledMinutes}」不等于计划分钟数 ${outcome.targetMinutes}。`,
      )
    }
    const blocks = scheduledByTask.get(outcome.taskId) ?? 0
    if (blocks !== outcome.scheduledMinutes) {
      errors.push(`任务 ${outcome.taskId} 的块合计 ${blocks} 与 outcome 的 ${outcome.scheduledMinutes} 不一致。`)
    }
    if (outcome.blockCount !== (blocksByTask.get(outcome.taskId)?.length ?? 0)) {
      errors.push(`任务 ${outcome.taskId} 的块数与 outcome 记录的 ${outcome.blockCount} 不一致。`)
    }
    // 「有没排完的分钟」与「有没有给出原因」必须一致：缺原因 / 多原因都是坏数据。
    const hasRemainder = outcome.unscheduledMinutes > 0
    if (hasRemainder && !outcome.unscheduled) {
      errors.push(`任务 ${outcome.taskId} 还有 ${outcome.unscheduledMinutes} 分钟没排，却没有给出原因。`)
    }
    if (!hasRemainder && outcome.unscheduled) {
      errors.push(`任务 ${outcome.taskId} 已经排满，却带着一条「排不下」的原因。`)
    }
  }
  for (const taskId of scheduledByTask.keys()) {
    if (!seenOutcome.has(taskId)) errors.push(`块属于任务 ${taskId}，但没有对应的结果。`)
  }

  const total = (plan.outcomes ?? []).reduce((sum, outcome) => sum + outcome.scheduledMinutes, 0)
  if (total !== plan.scheduledMinutes) errors.push(`已排分钟数合计 ${total} 与计划里的 ${plan.scheduledMinutes} 不一致。`)
  if (plan.scheduledMinutes + plan.unscheduledMinutes !== plan.targetMinutes) {
    errors.push('整份计划的「已排 + 未排」不等于计划分钟数合计。')
  }
  const capacity = slots.reduce((sum, slot) => sum + (slot.endMinute - slot.startMinute), 0)
  if (plan.scheduledMinutes > capacity) {
    errors.push(`已排分钟数 ${plan.scheduledMinutes} 超过了空闲缺口总容量 ${capacity}。`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 块是否都落在「允许的边界」内（不早于 now、不晚于各自 DDL）。
 *
 * 与 {@link verifyTodayPlan} 分开：这一条需要「任务边界」这份额外事实（由仓库从新鲜数据推导），
 * 而 `verifyTodayPlan` 只看计划对象本身。
 */
export function verifyPlanBlockBounds(
  plan: TodayPlan,
  options: { anchorMinute: number; taskMeta: Map<number, { lastMinute: number }> },
): TodayPlanVerification {
  const errors: string[] = []
  for (const block of plan.blocks ?? []) {
    if (block.startMinute < options.anchorMinute) {
      errors.push(`块 ${block.taskId} ${block.startTime} 早于「现在」那一分钟。`)
    }
    const meta = options.taskMeta.get(block.taskId)
    if (meta && block.endMinute > meta.lastMinute) {
      errors.push(`块 ${block.taskId} ${block.startTime}-${block.endTime} 超过了该任务允许安排到的 ${minuteToClock(meta.lastMinute)}。`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 计划块按开始时间排序的稳定比较。 */
export function comparePlanBlocks(a: PlanBlock, b: PlanBlock): number {
  return a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.taskId - b.taskId
}

/** 计划是否还属于「今天」（上海自然日）。 */
export function isPlanForToday(planDate: string, now: Date): boolean {
  const today = shanghaiToday(now)
  return today.length > 0 && planDate === today
}

export type { Weekday }
