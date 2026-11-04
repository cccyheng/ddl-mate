import type { AppSettingsRepository } from './settingsRepository'
import { changeWeeklyGoal, decodeWeeklyGoals, WEEKLY_GOAL_KEY } from './weeklyGoal'

export async function loadWeeklyGoals(settings: Pick<AppSettingsRepository, 'get'>) {
  return decodeWeeklyGoals(await settings.get(WEEKLY_GOAL_KEY))
}
/** Caller serializes through AppStore's restore-aware shared queue. One atomic UPSERT. */
export async function saveWeeklyGoal(settings: Pick<AppSettingsRepository, 'get' | 'set'>, revision: number, week: string, minutes: number | null, now = Date.now()) {
  const state = await loadWeeklyGoals(settings)
  if (state.revision !== revision) throw new Error('学习目标已更新，请关闭设置并重新读取。')
  const next = changeWeeklyGoal(state, week, minutes, now)
  await settings.set(WEEKLY_GOAL_KEY, JSON.stringify(next))
  return next
}
