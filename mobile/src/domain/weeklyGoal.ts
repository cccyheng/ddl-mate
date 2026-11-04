import { focusDayStart, focusTotal, type FocusStore } from './focusTime'

export const WEEKLY_GOAL_KEY = 'learning.weekly-goals.v1'
export type WeeklyGoals = { version: 1; revision: number; weeks: Record<string, number> }
export const emptyWeeklyGoals = (): WeeklyGoals => ({ version: 1, revision: 0, weeks: {} })
export function goalWeek(now: number): string {
  const local = new Date(now + 8 * 3600000)
  local.setUTCDate(local.getUTCDate() - (local.getUTCDay() + 6) % 7)
  return local.toISOString().slice(0, 10)
}
function validWeek(key: string): boolean {
  const date = new Date(`${key}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === key && date.getUTCDay() === 1
}
function validMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 15 && value <= 10080 && value % 15 === 0
}
export function decodeWeeklyGoals(raw: string | null): WeeklyGoals {
  if (raw === null) return emptyWeeklyGoals()
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('学习目标数据无法读取。') }
  const s = value as WeeklyGoals
  if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || s.revision >= Number.MAX_SAFE_INTEGER ||
    !s.weeks || typeof s.weeks !== 'object' || Array.isArray(s.weeks) || Object.keys(s.weeks).length > 520 ||
    Object.keys(s).some(k => !['version', 'revision', 'weeks'].includes(k)) ||
    Object.entries(s.weeks).some(([week, minutes]) => !validWeek(week) || !validMinutes(minutes))) throw new Error('学习目标数据无效。')
  return s
}
export function changeWeeklyGoal(s: WeeklyGoals, week: string, minutes: number | null, now = Date.now()): WeeklyGoals {
  if (!validWeek(week) || week !== goalWeek(now)) throw new Error('已进入新的一周，请重新读取后设置本周目标。')
  if (minutes !== null && !validMinutes(minutes)) throw new Error('目标请选择 15 分钟至 168 小时，以 15 分钟为一格。')
  const next = decodeWeeklyGoals(JSON.stringify(s))
  if (minutes === null) delete next.weeks[week]
  else next.weeks[week] = minutes
  next.revision++
  return decodeWeeklyGoals(JSON.stringify(next))
}
export function weeklyGoalProgress(goals: WeeklyGoals, focus: FocusStore, week: string, now: number) {
  if (!validWeek(week)) throw new Error('学习周日期无效。')
  const start = focusDayStart(week), elapsedMs = focusTotal(focus, start, start + 7 * 86400000, now)
  const targetMinutes = goals.weeks[week] ?? null
  const remainingMs = targetMinutes === null ? null : Math.max(0, targetMinutes * 60000 - elapsedMs)
  return { targetMinutes, elapsedMs, remainingMs, percent: targetMinutes === null ? null : Math.min(100, Math.floor(elapsedMs / (targetMinutes * 60000) * 100)) }
}
export function goalDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  return [hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟'
}
