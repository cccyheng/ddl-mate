/**
 * 网页内提醒调度：截止前提醒 + 上课前提醒。
 *
 * 规则全部来自手机端（提前量、可提醒条件、上课日期判定），差别只有「怎么提醒」：
 * - 网页**只在页面开着时**提醒（浏览器关掉就不会响），这一点在提醒页写明；
 * - 已授权时用系统通知，否则在页面右下角弹出提示；
 * - 页面关着时错过的提醒不补发（与手机端「过去的不回填」一致）。
 */
import { reactive } from 'vue'
import { buildClassReminderCandidates, decodeClassReminderSettings } from '@domain/classReminder'
import { decodeTaskReminder, evaluateTaskReminderEligibility, reminderLeadLabel } from '@domain/taskReminder'
import { settingsApi } from '@/api'
import { loadAllCourses, loadAllSchedules, loadAllTasks, toDomainCourse, toDomainSchedule, toDomainTask } from '@/domain/adapters'
import { SETTING_KEYS } from '@/domain/settingKeys'
import { readPreference, writePreference } from '@/utils/preferences'

/** 只排未来 24 小时内的提醒；更远的由定时重新读取时再排。 */
const HORIZON_MS = 24 * 3600 * 1000
const REFRESH_MS = 5 * 60 * 1000
const FIRED_KEY = 'reminders.fired'

export const reminderState = reactive({
  toasts: [],
  upcoming: [],
  lastError: '',
  supported: typeof window !== 'undefined' && 'Notification' in window,
})

let timers = []
let refreshTimer = null
let started = false

function firedSet() {
  try {
    return new Set(JSON.parse(readPreference(FIRED_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

function markFired(id) {
  const set = firedSet()
  set.add(id)
  // 只保留最近 300 条，避免本机存储无限增长
  writePreference(FIRED_KEY, JSON.stringify([...set].slice(-300)))
}

export function dismissToast(id) {
  reminderState.toasts = reminderState.toasts.filter((t) => t.id !== id)
}

export function notify({ id, title, body, link }) {
  if (reminderState.supported && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: id })
      n.onclick = () => {
        window.focus()
        if (link) window.location.assign(link)
      }
    } catch {
      // 某些浏览器不允许在页面里直接 new Notification，退回页内提示
    }
  }
  reminderState.toasts = [...reminderState.toasts.filter((t) => t.id !== id), { id, title, body, link }]
}

async function collect(now) {
  const [tasks, reminderRows, classRow] = await Promise.all([
    loadAllTasks(),
    settingsApi.listByPrefix('task_reminder.'),
    settingsApi.get(SETTING_KEYS.CLASS_REMINDER),
  ])
  const byId = new Map(tasks.map((t) => [t.id, toDomainTask(t)]))
  const items = []
  for (const row of reminderRows) {
    const decoded = decodeTaskReminder(row.value)
    if (!decoded.ok || !decoded.intent.enabled) continue
    const task = byId.get(decoded.intent.taskId) ?? null
    const check = evaluateTaskReminderEligibility(task, decoded.intent.leadMinutes, now)
    if (!check.eligible) continue
    items.push({
      id: `task.${task.id}.${check.triggerAtMs}`,
      at: check.triggerAtMs,
      title: `DDL 提醒 · ${task.title}`,
      body: `${reminderLeadLabel(decoded.intent.leadMinutes)}：截止 ${task.deadline.slice(0, 16).replace('T', ' ')}`,
      link: `/tasks/${task.id}`,
    })
  }
  let classSettings = null
  try {
    classSettings = decodeClassReminderSettings(classRow.value ?? null)
  } catch {
    classSettings = null
  }
  if (classSettings?.enabled) {
    const courses = await loadAllCourses()
    const schedules = await loadAllSchedules(courses)
    const candidates = buildClassReminderCandidates(
      {
        settings: classSettings,
        schedules: schedules.map(toDomainSchedule),
        courses: courses.map(toDomainCourse),
        generation: 0,
      },
      now,
    )
    for (const c of candidates) {
      items.push({ id: c.identifier, at: c.triggerAtMs, title: c.title, body: c.body, link: `/courses/${c.data.courseId}` })
    }
  }
  return items.sort((a, b) => a.at - b.at)
}

export async function refreshReminders() {
  timers.forEach((t) => window.clearTimeout(t))
  timers = []
  const now = Date.now()
  try {
    const items = await collect(now)
    const fired = firedSet()
    reminderState.upcoming = items.slice(0, 20)
    reminderState.lastError = ''
    for (const item of items) {
      if (item.at - now > HORIZON_MS || fired.has(item.id)) continue
      timers.push(
        window.setTimeout(() => {
          markFired(item.id)
          notify(item)
        }, Math.max(0, item.at - now)),
      )
    }
  } catch (err) {
    reminderState.lastError = err.message
  }
}

/** App 挂载时调用一次；之后每 5 分钟、以及提醒设置变更时重新读取。 */
export function startReminderScheduler() {
  if (started || typeof window === 'undefined') return
  started = true
  refreshReminders()
  refreshTimer = window.setInterval(refreshReminders, REFRESH_MS)
  window.addEventListener('ddlmate:reminders-changed', refreshReminders)
}

export function remindersChanged() {
  window.dispatchEvent(new Event('ddlmate:reminders-changed'))
}

export function stopReminderScheduler() {
  timers.forEach((t) => window.clearTimeout(t))
  window.clearInterval(refreshTimer)
  window.removeEventListener('ddlmate:reminders-changed', refreshReminders)
  started = false
}
