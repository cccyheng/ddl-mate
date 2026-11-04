/**
 * 教学周判定 —— 全应用唯一的「某天是否上这门课」规则，与后端
 * `backend/src/main/java/com/ddlmate/service/ScheduleRules.java` 语义一一对应（纯函数，可测试）。
 *
 * 规则：
 * 1. 星期必须匹配（1=周一 … 7=周日）；
 * 2. 没有「学期第一周周一」或「起止教学周」（旧数据）→ 视为每周都上，不做教学周限制；
 * 3. 否则教学周序号 = ⌊(日期 − 学期第一周周一) / 7⌋ + 1，必须落在 [startWeek, endWeek]；
 * 4. 再按周次规律过滤：ALL 全要，ODD 只保留**奇数教学周**，EVEN 只保留**偶数教学周**。
 *
 * 注意：ODD/EVEN 是**相对学期第一周**的奇偶，不是 ISO 自然周奇偶，两者在学期起点不是
 * ISO 第 1 周时会完全不同。
 */

import {
  addDaysToDateKey,
  dateKeyToDayNumber,
  dayNumberToDateKey,
  isMonday,
  isValidDateKey,
  weekdayOfDateKey,
  type Weekday,
} from './datetime'
import { MAX_TEACHING_WEEK, MIN_TEACHING_WEEK } from './teachingWeekRange'

export type WeekPattern = 'ALL' | 'ODD' | 'EVEN'

export const weekPatternLabels: Record<WeekPattern, string> = {
  ALL: '每周',
  ODD: '单周',
  EVEN: '双周',
}

/** 未知/空值一律按 ALL 处理（与后端 `null` 视为 ALL 一致）。 */
export function normalizeWeekPattern(value: unknown): WeekPattern {
  const raw = String(value ?? '').trim().toUpperCase()
  if (raw === 'ODD' || raw === 'EVEN') return raw
  return 'ALL'
}

export interface ScheduleWeekRule {
  /** 星期，1=周一 … 7=周日。 */
  weekday: number
  /** 学期第一周周一（`YYYY-MM-DD`）；缺省表示无教学周信息。 */
  semesterStartDate?: string | null
  startWeek?: number | null
  endWeek?: number | null
  weekPattern?: WeekPattern | string | null
}

/**
 * 教学周序号（学期第一周 = 1）。日期早于学期起点时返回 0 或负数。
 * 学期起点必须是周一；不是周一时返回 null（调用方应拒绝该数据）。
 */
export function teachingWeek(semesterStartMonday: string, dateKey: string): number | null {
  if (!isValidDateKey(semesterStartMonday) || !isValidDateKey(dateKey)) return null
  if (!isMonday(semesterStartMonday)) return null
  const start = dateKeyToDayNumber(semesterStartMonday)
  const target = dateKeyToDayNumber(dateKey)
  if (start === null || target === null) return null
  return Math.floor((target - start) / 7) + 1
}

/** 该教学周是否满足周次规律。 */
export function matchesWeekPattern(weekIndex: number, pattern: unknown): boolean {
  switch (normalizeWeekPattern(pattern)) {
    case 'ODD':
      return weekIndex % 2 === 1
    case 'EVEN':
      return weekIndex % 2 === 0
    default:
      return true
  }
}

/**
 * 指定教学周范围内是否**至少有一周**符合周次规律。
 *
 * 这是表单/仓库保存前拦截「第 7–7 周 + 双周」这类**空规则**的纯函数：
 * 范围与规律都合法，但筛完一周课都没有。它只回答「有没有可上课的周」，
 * 不修改、不扩展用户选的范围（没有可上课的周时由调用方明确报错）。
 */
export function hasApplicableWeekInRange(
  startWeek: number,
  endWeek: number,
  weekPattern?: WeekPattern | string | null,
): boolean {
  if (!Number.isInteger(startWeek) || !Number.isInteger(endWeek)) return false
  if (startWeek < MIN_TEACHING_WEEK || endWeek > MAX_TEACHING_WEEK || startWeek > endWeek) return false
  const pattern = normalizeWeekPattern(weekPattern)
  if (pattern === 'ALL') return true
  for (let week = startWeek; week <= endWeek; week += 1) {
    if (matchesWeekPattern(week, pattern)) return true
  }
  return false
}

/** 该课表是否在指定日期上课（全应用唯一判定入口）。 */
export function occursOn(schedule: ScheduleWeekRule, dateKey: string): boolean {
  if (!schedule || !isValidDateKey(dateKey)) return false
  const weekday = weekdayOfDateKey(dateKey)
  if (weekday === null || Number(schedule.weekday) !== weekday) return false

  const { semesterStartDate, startWeek, endWeek } = schedule
  const hasTerm =
    typeof semesterStartDate === 'string' &&
    isValidDateKey(semesterStartDate) &&
    Number.isInteger(startWeek) &&
    Number.isInteger(endWeek)

  if (!hasTerm) {
    // 旧数据：没有教学周信息 → 每周都上
    return true
  }

  const weekIndex = teachingWeek(semesterStartDate as string, dateKey)
  if (weekIndex === null) return false
  const from = Number(startWeek)
  const to = Number(endWeek)
  if (weekIndex < from || weekIndex > to) return false
  return matchesWeekPattern(weekIndex, schedule.weekPattern)
}

/** 学期起止教学周校验：1 ≤ 起始 ≤ 结束 ≤ 53，且必须成对给出。 */
export interface TermRangeInput {
  semesterStartDate?: string | null
  startWeek?: number | string | null
  endWeek?: number | string | null
  /** 周次规律；给了就同时校验「范围里是否真的有一周可上」。 */
  weekPattern?: WeekPattern | string | null
}

export interface TermValidation {
  ok: boolean
  /** 校验失败的具体原因（中文，可直接展示）。 */
  message?: string
  semesterStartDate: string | null
  startWeek: number | null
  endWeek: number | null
}

/**
 * 学期/教学周组合校验。
 *
 * - 全空 → 允许（旧数据，按每周上课）；
 * - 只填学期起点或只填起止周 → 拒绝，绝不猜另一侧；
 * - 学期起点必须是**真实存在的周一**。
 */
export function validateTermRange(input: TermRangeInput): TermValidation {
  const rawStart = input.semesterStartDate == null ? '' : String(input.semesterStartDate).trim()
  const hasStart = rawStart.length > 0
  const hasStartWeek = input.startWeek !== null && input.startWeek !== undefined && String(input.startWeek).trim() !== ''
  const hasEndWeek = input.endWeek !== null && input.endWeek !== undefined && String(input.endWeek).trim() !== ''

  const empty: TermValidation = { ok: true, semesterStartDate: null, startWeek: null, endWeek: null }
  if (!hasStart && !hasStartWeek && !hasEndWeek) return empty

  if (!hasStart) {
    return {
      ...empty,
      ok: false,
      message: '填写了起止教学周，还需要填写“学期第一周周一”。',
    }
  }
  if (!isValidDateKey(rawStart)) {
    return { ...empty, ok: false, message: '“学期第一周周一”不是真实存在的日期（格式 YYYY-MM-DD）。' }
  }
  if (!isMonday(rawStart)) {
    return { ...empty, ok: false, message: `“学期第一周周一”必须是周一，${rawStart} 是${weekdayNameOf(rawStart)}。` }
  }
  if (!hasStartWeek || !hasEndWeek) {
    return { ...empty, ok: false, message: '起始周与结束周必须同时填写。' }
  }

  const startWeek = Number(input.startWeek)
  const endWeek = Number(input.endWeek)
  if (!Number.isInteger(startWeek) || !Number.isInteger(endWeek)) {
    return { ...empty, ok: false, message: '起止教学周必须是整数。' }
  }
  if (startWeek < MIN_TEACHING_WEEK || endWeek > MAX_TEACHING_WEEK || startWeek > endWeek) {
    return {
      ...empty,
      ok: false,
      message: `教学周范围非法：${startWeek}-${endWeek}（要求 ${MIN_TEACHING_WEEK} ≤ 起始周 ≤ 结束周 ≤ ${MAX_TEACHING_WEEK}）。`,
    }
  }
  const pattern = normalizeWeekPattern(input.weekPattern)
  if (!hasApplicableWeekInRange(startWeek, endWeek, pattern)) {
    return {
      ...empty,
      ok: false,
      message:
        `第 ${startWeek}${startWeek === endWeek ? '' : `-${endWeek}`} 周里没有${weekPatternLabels[pattern]}的周次，` +
        '没有可上课的周。请调整范围，或把周次规律改成“每周”。',
    }
  }
  return { ok: true, semesterStartDate: rawStart, startWeek, endWeek }
}

function weekdayNameOf(dateKey: string): string {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const weekday = weekdayOfDateKey(dateKey)
  return weekday ? (names[weekday - 1] as string) : '未知'
}

/** 学期最后一天（学期起点 + 结束周的第 7 天），用于日历范围与说明文案。 */
export function termLastDate(semesterStartMonday: string, endWeek: number): string | null {
  if (!isValidDateKey(semesterStartMonday) || !isMonday(semesterStartMonday)) return null
  if (!Number.isInteger(endWeek) || endWeek < 1) return null
  return addDaysToDateKey(semesterStartMonday, endWeek * 7 - 1)
}

/** 人话描述某条课表的教学周规则（用于详情页与测试断言）。 */
export function describeWeekRule(schedule: ScheduleWeekRule): string {
  const weekday = weekdayNameOfKey(schedule.weekday)
  const hasTerm =
    typeof schedule.semesterStartDate === 'string' &&
    isValidDateKey(schedule.semesterStartDate) &&
    Number.isInteger(schedule.startWeek) &&
    Number.isInteger(schedule.endWeek)
  if (!hasTerm) return `${weekday} · 每周（未设置教学周）`
  const pattern = normalizeWeekPattern(schedule.weekPattern)
  const suffix = pattern === 'ALL' ? '每周' : weekPatternLabels[pattern]
  return `${weekday} · 第 ${schedule.startWeek}-${schedule.endWeek} 周 · ${suffix}`
}

/**
 * 表单里的紧凑周次摘要：`第 1–16 周 · 每周` / `第 7 周 · 单周`。
 * 未选全时明确说「还没有选择完整的起止周」，不猜、不补默认值。
 */
export function describeWeekRangeSelection(
  startWeek: number | string | null | undefined,
  endWeek: number | string | null | undefined,
  weekPattern?: WeekPattern | string | null,
): string {
  const rawStart = String(startWeek ?? '').trim()
  const rawEnd = String(endWeek ?? '').trim()
  const start = Number(rawStart)
  const end = Number(rawEnd)
  const complete = rawStart.length > 0 && rawEnd.length > 0 && Number.isInteger(start) && Number.isInteger(end)
  if (!complete) return '还没有选择完整的起止周'
  if (start < MIN_TEACHING_WEEK || end > MAX_TEACHING_WEEK || start > end) {
    return `第 ${start}–${end} 周 · 范围无效`
  }
  const pattern = normalizeWeekPattern(weekPattern)
  const range = start === end ? `第 ${start} 周` : `第 ${start}–${end} 周`
  if (!hasApplicableWeekInRange(start, end, pattern)) {
    return `${range} · ${weekPatternLabels[pattern]}（没有可上课的周次）`
  }
  return `${range} · ${weekPatternLabels[pattern]}`
}

function weekdayNameOfKey(weekday: number): string {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  return names[Number(weekday) - 1] ?? '未知'
}

/** 指定日期区间内所有上课日期（升序），用于日历与「未来 N 天」查询。 */
export function occurringDatesInRange(
  schedule: ScheduleWeekRule,
  fromDateKey: string,
  toDateKey: string,
): string[] {
  const from = dateKeyToDayNumber(fromDateKey)
  const to = dateKeyToDayNumber(toDateKey)
  if (from === null || to === null || from > to) return []
  const result: string[] = []
  for (let day = from; day <= to; day += 1) {
    const dateKey = dayNumberToDateKey(day)
    if (occursOn(schedule, dateKey)) result.push(dateKey)
  }
  return result
}

export type { Weekday }
