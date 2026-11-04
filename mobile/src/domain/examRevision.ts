/** Pure exam calendar and revision preview rules. Preview never writes tasks. */
import {
  dateKeyToDayNumber, dayNumberToDateKey, deadlineToShanghaiDateKey,
  isDeadlineOverdue, shanghaiToday, weekdayOfDateKey,
} from './datetime'
import type { Task } from './types'

export const EXAM_REVISION_LIMITS = { maxSessions: 30, maxRangeDays: 90, maxTopics: 30, maxTopicLength: 100 } as const
export type ExamPhase = 'upcoming' | 'today' | 'overdue' | 'undated' | 'done' | 'cancelled'
export interface ExamSummary {
  task: Task
  date: string | null
  days: number | null
  phase: ExamPhase
  label: string
}
function currentDay(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('无法读取当前日期，请稍后重试。')
  return shanghaiToday(now)
}
export function describeExam(task: Task, now: Date): ExamSummary {
  if (task.type !== 'EXAM') throw new Error('这条任务不是考试。')
  const today = currentDay(now)
  const date = deadlineToShanghaiDateKey(task.deadline) || null
  const dayNumber = date ? dateKeyToDayNumber(date) : null
  const days = dayNumber === null ? null : dayNumber - dateKeyToDayNumber(today)!
  let phase: ExamPhase, label: string
  if (task.status === 'DONE') { phase = 'done'; label = '已完成' }
  else if (task.status === 'CANCELLED') { phase = 'cancelled'; label = '已取消' }
  else if (days === null) { phase = 'undated'; label = '待设置考试日期' }
  else if (isDeadlineOverdue(task.deadline, now)) {
    phase = 'overdue'; label = days < 0 ? `考试日期已过 ${-days} 天` : '考试时间已过'
  } else if (days === 0) { phase = 'today'; label = '今天考试' }
  else { phase = 'upcoming'; label = `距考试 ${days} 天` }
  return { task, date, days, phase, label }
}
export function listExams(tasks: readonly Task[], now: Date): ExamSummary[] {
  currentDay(now)
  const rank: Record<ExamPhase, number> = { today: 0, upcoming: 1, undated: 2, overdue: 3, done: 4, cancelled: 5 }
  return tasks.filter(task => task.type === 'EXAM').map(task => describeExam(task, now)).sort((a, b) =>
    rank[a.phase] - rank[b.phase] || (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.task.id - b.task.id)
}

export interface RevisionInput {
  startDate: string
  endDate: string
  weekdays: readonly number[]
  topics: readonly string[]
  minutes: number
}
export interface RevisionSession { date: string; topic: string; title: string; minutes: number }
export interface RevisionPreview {
  examId: number
  examSignature: string
  today: string
  input: RevisionInput
  sessions: RevisionSession[]
  fingerprint: string
}
export type RevisionPreviewResult = { ok: true; preview: RevisionPreview } | { ok: false; reason: string }

/** Relevant exam fields are checked again inside the eventual save transaction. */
export function examRevisionSignature(exam: Task): string {
  return JSON.stringify([exam.id, exam.type, exam.status, exam.title, exam.courseId, exam.deadline, exam.updatedAt])
}
export function buildRevisionPreview(exam: Task | null, raw: RevisionInput, now: Date): RevisionPreviewResult {
  const fail = (reason: string): RevisionPreviewResult => ({ ok: false, reason })
  if (!exam || exam.type !== 'EXAM') return fail('考试已不存在或类型已改变，请返回重新选择。')
  if (exam.status === 'DONE' || exam.status === 'CANCELLED') return fail('这场考试已完成或取消，不能再安排复习。')
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return fail('无法读取当前日期，请稍后重试。')
  const today = currentDay(now), todayNumber = dateKeyToDayNumber(today)!
  const examNumber = dateKeyToDayNumber(deadlineToShanghaiDateKey(exam.deadline))
  if (examNumber === null) return fail('请先给考试设置有效日期。')
  if (examNumber <= todayNumber) return fail('考试已到当天或已经过去，没有可安排的考前日期。')
  const start = dateKeyToDayNumber(raw.startDate), end = dateKeyToDayNumber(raw.endDate)
  if (start === null || end === null) return fail('请选择有效的开始和结束日期。')
  if (start < todayNumber) return fail('开始日期已经过去，请重新选择并预览。')
  if (end < start) return fail('结束日期不能早于开始日期。')
  if (end >= examNumber) return fail('复习结束日期最晚为考试前一天。')
  if (end - start + 1 > EXAM_REVISION_LIMITS.maxRangeDays) return fail('每份安排最多覆盖 90 天。')
  if (!Array.isArray(raw.weekdays) || !raw.weekdays.length || raw.weekdays.length > 7 ||
      raw.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return fail('请至少选择一个有效的星期。')
  if (!Array.isArray(raw.topics) || !raw.topics.length || raw.topics.length > EXAM_REVISION_LIMITS.maxTopics ||
      raw.topics.some(topic => typeof topic !== 'string' || !topic.trim() || topic.trim().length > EXAM_REVISION_LIMITS.maxTopicLength)) {
    return fail('请填写 1–30 个复习主题，每个主题最多 100 字。')
  }
  if (!Number.isInteger(raw.minutes) || raw.minutes < 1 || raw.minutes > 1440) return fail('每次预计用时需为 1–1440 分钟。')
  const weekdays = [...new Set(raw.weekdays)].sort((a, b) => a - b), topics = raw.topics.map(topic => topic.trim())
  const dates: string[] = []
  for (let day = start; day <= end; day++) {
    const date = dayNumberToDateKey(day)
    if (weekdays.includes(weekdayOfDateKey(date)!)) dates.push(date)
  }
  if (!dates.length) return fail('所选范围里没有这些星期，请调整日期或星期。')
  if (dates.length > EXAM_REVISION_LIMITS.maxSessions) return fail('每次最多安排 30 次复习，请缩短日期范围或减少星期。')
  if (topics.length > dates.length) return fail('复习日期少于主题数量，请增加日期或合并主题。')
  // Repeat in entered order when there are more dates than topics; no topic is silently dropped.
  const sessions = dates.map((date, index) => {
    const topic = topics[index % topics.length]!
    return { date, topic, title: `复习：${topic}`, minutes: raw.minutes }
  })
  const input: RevisionInput = { startDate: dayNumberToDateKey(start), endDate: dayNumberToDateKey(end), weekdays, topics, minutes: raw.minutes }
  const examSignature = examRevisionSignature(exam)
  const fingerprint = JSON.stringify([examSignature, today, input, sessions])
  return { ok: true, preview: { examId: exam.id, examSignature, today, input, sessions, fingerprint } }
}
