/**
 * 原生浮窗滚轮（日期 / 时钟）的纯逻辑。
 *
 * 这里**不碰 React Native**，只负责四件容易出错的事：
 * - 日期滚轮的年份范围、闰年与每月天数钳制（1900–2199，与 `datetime.ts` 同一口径）；
 * - 打开弹层时的初值建议：有值就回到当前值，没有值才用「今天 / 现在」的建议，
 *   但建议只存在弹层草稿里，**确认之前绝不调用 onChange**；
 * - 日期与时刻分开确认：选日期不补时刻（任务可以只记到日期），选时刻保留日期；
 * - 清除口径：清除时刻保留日期；清除日期会把整个值清空，
 *   绝不把「有时刻没日期」硬凑成一个看着有效的截止时间。
 *
 * 界面的滚轮/吸附/无障碍在 `ui/timeWheel.tsx`，这里保持可被 Node 直接测试。
 */

import { daysInMonth, isValidCalendarDate } from './datetime'
import { joinWallClock, padClockText, splitWallClock } from './wallClockInput'

/** 与 `datetime.isValidCalendarDate()` 相同的支持范围，不在界面里另写一份。 */
export const WHEEL_MIN_YEAR = 1900
export const WHEEL_MAX_YEAR = 2199

export interface WheelDateParts {
  year: number
  month: number
  day: number
}

export interface WheelClockParts {
  hour: number
  minute: number
}

function range(from: number, to: number): readonly number[] {
  return Object.freeze(Array.from({ length: to - from + 1 }, (_, index) => from + index))
}

/** 年 / 月 / 日 / 时 / 分滚轮的完整候选，界面与测试共用同一组。 */
export const WHEEL_YEARS: readonly number[] = range(WHEEL_MIN_YEAR, WHEEL_MAX_YEAR)
export const WHEEL_MONTHS: readonly number[] = range(1, 12)
export const WHEEL_HOURS: readonly number[] = range(0, 23)
/** 24 小时制的每一分钟都在（不是 5 分钟一跳）。 */
export const WHEEL_MINUTES: readonly number[] = range(0, 59)

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 日期滚轮值 → `YYYY-MM-DD`。 */
export function formatWheelDate(parts: WheelDateParts): string {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/** 时钟滚轮值 → 补零的 `HH:mm`。 */
export function formatWheelClock(parts: WheelClockParts): string {
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`
}

/** `YYYY-MM-DD` → 滚轮值；不存在的日期（2026-02-30 / 2027-02-29）返回 null。 */
export function parseWheelDate(value: string): WheelDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!isValidCalendarDate(year, month, day)) return null
  return { year, month, day }
}

/** `H:mm` / `HH:mm` → 滚轮值；小时或分钟越界返回 null。 */
export function parseWheelClock(value: string): WheelClockParts | null {
  const padded = padClockText(String(value ?? '').trim())
  const match = /^(\d{2}):(\d{2})$/.exec(padded)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/**
 * 把日期钳制到真实存在的日历日。
 *
 * 滚轮换月/换年时先钳制再交给界面，避免出现「2 月 31 日」这种只在草稿里
 * 存在、确认后才被保存层拒绝的中间态。
 */
export function clampWheelDate(parts: WheelDateParts): WheelDateParts {
  const year = Math.min(WHEEL_MAX_YEAR, Math.max(WHEEL_MIN_YEAR, Math.trunc(parts.year) || WHEEL_MIN_YEAR))
  const month = Math.min(12, Math.max(1, Math.trunc(parts.month) || 1))
  const maxDay = daysInMonth(year, month) || 1
  const day = Math.min(maxDay, Math.max(1, Math.trunc(parts.day) || 1))
  return { year, month, day }
}

/** 某年某月的日滚轮候选（1..真实天数）。 */
export function wheelDaysForMonth(year: number, month: number): readonly number[] {
  return range(1, daysInMonth(year, month) || 1)
}

/**
 * 打开日期弹层时的初值建议。
 *
 * 当前值优先；当前值为空/非法时才回退到调用方给的日期（任务表单用「今天」）。
 * 这里只计算草稿，不产生任何写入。
 */
export function initialWheelDate(value: string, fallbackDateKey: string): WheelDateParts {
  return parseWheelDate(value) ?? parseWheelDate(fallbackDateKey) ?? { year: 2000, month: 1, day: 1 }
}

/** 打开时钟弹层时的初值建议；同样只算草稿，不写回。 */
export function initialWheelClock(value: string, fallbackClock: string): WheelClockParts {
  return parseWheelClock(value) ?? parseWheelClock(fallbackClock) ?? { hour: 0, minute: 0 }
}

/**
 * 只替换日期，保留原来的时刻。
 *
 * 原来只有日期时结果仍是裸日期 —— **不会**因为选了一次日期就补上时刻。
 *
 * 这里刻意用与界面展示一致的 `splitWallClock`：像 `22:00` 这种没有日期的旧半截值，
 * 界面上时刻格是空的，选日期时就不能偷偷把 `22:00` 带进来伪造一个完整截止时间。
 */
export function withWallClockDate(value: string, nextDateKey: string): string {
  const { time } = splitWallClock(value)
  return joinWallClock(nextDateKey, time)
}

/** 只替换时刻，保留原来的日期；日期为空时结果就是时刻，交给既有校验报错。 */
export function withWallClockTime(value: string, nextClock: string): string {
  const { date } = splitWallClockValue(value)
  return joinWallClock(date, padClockText(nextClock))
}

/** 清除时刻（可空 DDL 的「只记到日期」）：保留日期，不清掉用户选的哪一天。 */
export function clearWallClockTime(value: string): string {
  const { date, time } = splitWallClockValue(value)
  if (!time) return date
  return joinWallClock(date, '')
}

/**
 * 清除日期。
 *
 * 如果同时还有时刻，这里**连时刻一起清掉**：否则会剩下一个「有时刻没日期」的
 * 半截值，既不能被保存，也不是用户想要的「某天某时」。清成空表示未设置，
 * 绝不用今天/明天或 00:00 伪造一个看起来有效的截止时间。
 */
export function clearWallClockDate(_value: string): string {
  return ''
}

/**
 * 比 `splitWallClock` 多认一种值：只有时刻（`22:00`）。
 *
 * 旧草稿/外部调用可能留下这种半截值；分开确认时不要把 `22:00` 误当成日期，
 * 也不要在清时刻时把它原样保留成日期。
 */
function splitWallClockValue(value: string): { date: string; time: string } {
  const raw = String(value ?? '').trim()
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    return { date: '', time: padClockText(raw) }
  }
  return splitWallClock(raw)
}
