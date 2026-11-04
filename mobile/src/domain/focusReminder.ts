import { focusDeadline, type FocusStore } from './focusTime'
export const FOCUS_REMINDER_KIND = 'ddlmate.focus-reminder.v1'
const PREFIX = `${FOCUS_REMINDER_KIND}.`
export interface FocusReminderPayload {
  kind: typeof FOCUS_REMINDER_KIND; generation: number; sessionId: number
  phase: 'focus' | 'rest'; startedAt: number; deadline: number; fingerprint: string
}
export function ownsFocusReminder(id: string): boolean { return /^ddlmate\.focus-reminder\.v1\.\d+\.[1-9]\d*\.(focus|rest)$/.test(id) }
export function focusReminderCandidate(store: FocusStore, generation: number) {
  const active = store.active, deadline = active ? focusDeadline(active) : null
  if (!store.reminderEnabled || !active?.timer || deadline === null) return null
  const phase = active.timer.kind, triggerAtMs = Math.ceil(deadline / 1000) * 1000
  const fingerprint = JSON.stringify([generation, active.id, phase, active.startedAt, triggerAtMs])
  const data: FocusReminderPayload = { kind: FOCUS_REMINDER_KIND, generation, sessionId: active.id, phase,
    startedAt: active.startedAt, deadline: triggerAtMs, fingerprint }
  return { identifier: `${PREFIX}${generation}.${active.id}.${phase}`, triggerAtMs, data,
    title: phase === 'rest' ? '休息结束，准备好再出发' : '这一轮专注完成了',
    body: phase === 'rest' ? '回到番茄钟，自主开始下一轮专注。' : `${active.title} · 打开番茄钟，确认保存并休息一下。` }
}
export function parseFocusReminderTap(id: string, value: unknown, generation: number): FocusReminderPayload | null {
  if (!ownsFocusReminder(id) || !value || typeof value !== 'object') return null
  const d = value as FocusReminderPayload
  if (d.kind !== FOCUS_REMINDER_KIND || d.generation !== generation || !Number.isSafeInteger(d.generation) || d.generation < 0 ||
    !Number.isSafeInteger(d.sessionId) || d.sessionId < 1 || !Number.isSafeInteger(d.startedAt) || d.startedAt < 0 ||
    !Number.isSafeInteger(d.deadline) || d.deadline < d.startedAt || !['focus', 'rest'].includes(d.phase)) return null
  if (id !== `${PREFIX}${generation}.${d.sessionId}.${d.phase}` || d.fingerprint !== JSON.stringify([generation, d.sessionId, d.phase, d.startedAt, d.deadline])) return null
  return d
}
