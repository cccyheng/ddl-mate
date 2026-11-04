import { addDaysToDateKey, isoToEpochMs, shanghaiToday } from './datetime'
import { occursOn } from './scheduleRules'
import type { Course, Schedule } from './types'

export const CLASS_REMINDER_KEY = 'class_reminder.v1'
export const CLASS_REMINDER_PREFIX = 'ddlmate.class-reminder.v1.'
export const CLASS_REMINDER_KIND = 'ddlmate.class-reminder.v1'
export const CLASS_REMINDER_TEST_ID = `${CLASS_REMINDER_PREFIX}test`
export const CLASS_REMINDER_LEADS = [5, 10, 15, 30] as const
export const CLASS_REMINDER_DAYS = 14
export const CLASS_REMINDER_LIMIT = 24
export interface ClassReminderSettings { version: 1; enabled: boolean; leadMinutes: number }
export const defaultClassReminderSettings = (): ClassReminderSettings => ({ version: 1, enabled: false, leadMinutes: 10 })
export function decodeClassReminderSettings(raw: string | null): ClassReminderSettings {
  if (raw === null) return defaultClassReminderSettings()
  const x = JSON.parse(raw)
  if (!x || Object.keys(x).sort().join(',') !== 'enabled,leadMinutes,version' || x.version !== 1 ||
    typeof x.enabled !== 'boolean' || !CLASS_REMINDER_LEADS.some(v => v === x.leadMinutes)) {
    throw new Error('上课前提醒设置无法读取，请重新保存设置。')
  }
  return { version: 1, enabled: x.enabled, leadMinutes: x.leadMinutes }
}
export interface ClassReminderPayload {
  kind: typeof CLASS_REMINDER_KIND
  generation: number
  courseId: number
  scheduleId: number
  dateKey: string
  startTime: string
  fingerprint: string
  test: boolean
}
export interface ClassReminderCandidate {
  identifier: string; title: string; body: string; triggerAtMs: number
  data: ClassReminderPayload
}
export interface ClassReminderSource {
  settings: ClassReminderSettings; schedules: Schedule[]; courses: Course[]; generation: number
}
export function ownsClassReminderId(id: string): boolean {
  return id === CLASS_REMINDER_TEST_ID || /^ddlmate\.class-reminder\.v1\.[1-9]\d*\.\d{4}-\d{2}-\d{2}$/.test(id)
}
export function parseClassReminderTap(identifier: string, value: unknown, generation: number): ClassReminderPayload | null {
  if (!value || typeof value !== 'object' || !ownsClassReminderId(identifier)) return null
  const d = value as ClassReminderPayload
  if (d.kind !== CLASS_REMINDER_KIND || d.generation !== generation || typeof d.fingerprint !== 'string') return null
  if (identifier === CLASS_REMINDER_TEST_ID) return d.test === true && d.courseId === 0 ? d : null
  if (d.test !== false || !Number.isSafeInteger(d.courseId) || d.courseId <= 0 || !Number.isSafeInteger(d.scheduleId) || d.scheduleId <= 0) return null
  if (identifier !== `${CLASS_REMINDER_PREFIX}${d.scheduleId}.${d.dateKey}` || isoToEpochMs(`${d.dateKey}T${d.startTime}:00+08:00`) === null) return null
  return d
}
/** Same date/teaching-week predicate as the course and calendar screens. Past lead times are never backfilled. */
export function buildClassReminderCandidates(source: ClassReminderSource, nowMs: number): ClassReminderCandidate[] {
  if (!Number.isFinite(nowMs) || !source.settings.enabled) return []
  const settings = decodeClassReminderSettings(JSON.stringify(source.settings))
  const today = shanghaiToday(new Date(nowMs)), courses = new Map(source.courses.map(c => [c.id, c]))
  const result: ClassReminderCandidate[] = []
  for (let day = 0; day < CLASS_REMINDER_DAYS; day++) {
    const dateKey = addDaysToDateKey(today, day)
    if (!dateKey) continue
    for (const schedule of source.schedules) {
      const course = courses.get(schedule.courseId)
      if (!course || !occursOn(schedule, dateKey)) continue
      const start = isoToEpochMs(`${dateKey}T${schedule.startTime}:00+08:00`)
      if (start === null) continue
      const triggerAtMs = start - settings.leadMinutes * 60_000
      if (triggerAtMs <= nowMs) continue
      const identifier = `${CLASS_REMINDER_PREFIX}${schedule.id}.${dateKey}`
      const title = `即将上课 · ${course.name}`
      const body = `${dateKey} ${schedule.startTime}–${schedule.endTime} · ${schedule.location || '地点未填写'}${course.instructor ? ` · ${course.instructor}` : ''}`
      const fingerprint = JSON.stringify([source.generation, schedule.courseId, title, body, triggerAtMs])
      result.push({ identifier, title, body, triggerAtMs, data: { kind: CLASS_REMINDER_KIND, generation: source.generation,
        courseId: course.id, scheduleId: schedule.id, dateKey, startTime: schedule.startTime, fingerprint, test: false } })
    }
  }
  return result.sort((a, b) => a.triggerAtMs - b.triggerAtMs || a.data.scheduleId - b.data.scheduleId)
}
