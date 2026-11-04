/**
 * 教学周数字本身的取值范围 —— 与后端 `ScheduleService` 以及
 * `scheduleRules.validateTermRange()` 保持同一个口径（1 ≤ 周次 ≤ 53）。
 *
 * 单独放一个小模块，是为了让「教学周校准」与「课表周次范围」共用同一组常量，
 * 不在两个文件里各写一遍 `1` 和 `53`。
 */

export const MIN_TEACHING_WEEK = 1
export const MAX_TEACHING_WEEK = 53

/** 是否是合法的教学周序号（整数且在 1–53 之间）。 */
export function isValidTeachingWeek(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TEACHING_WEEK &&
    value <= MAX_TEACHING_WEEK
  )
}

/** 把任意输入解析成教学周序号；不合法返回 `null`（不猜默认值）。 */
export function parseTeachingWeek(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return null
  if (!/^\d{1,2}$/.test(raw)) return null
  const parsed = Number(raw)
  return isValidTeachingWeek(parsed) ? parsed : null
}
