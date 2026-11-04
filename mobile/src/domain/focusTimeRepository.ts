import { applyFocusAction, decodeFocus, FOCUS_KEY, type FocusAction, type FocusStore } from './focusTime'
import type { AppSettingsRepository } from './settingsRepository'

export async function loadFocus(settings: Pick<AppSettingsRepository, 'get'>): Promise<FocusStore> {
  return decodeFocus(await settings.get(FOCUS_KEY))
}
/** Caller must use the shared serial write queue and restore-generation guard. One atomic SQLite UPSERT. */
export async function saveFocusAction(settings: Pick<AppSettingsRepository, 'get' | 'set'>, revision: number, action: FocusAction, now = Date.now()): Promise<FocusStore> {
  const current = await loadFocus(settings)
  if (current.revision !== revision) throw new Error('专注状态已更新，请重新读取后操作。')
  const next = applyFocusAction(current, action, now)
  await settings.set(FOCUS_KEY, JSON.stringify(next))
  return next
}
