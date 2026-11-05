import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultTotalMinutes, examKindOf, MAX_SESSIONS, planSmartRevision } from '../src/domain/smartRevision.js'

const base = { exam: { title: '数据结构 期末考试', date: '2026-12-20' }, today: '2026-11-30' }

test('exam kind and default totals', () => {
  assert.equal(examKindOf('数据结构 期末考试'), 'final')
  assert.equal(examKindOf('高数 期中考试'), 'midterm')
  assert.equal(examKindOf('小测'), 'other')
  assert.equal(defaultTotalMinutes('final', 'hard'), 900)
})

test('normal final: starts 14 days before, ends with a light review the day before, gets denser near the exam', () => {
  const r = planSmartRevision({ ...base, dailyBudget: 120 })
  assert.equal(r.ok, true)
  assert.equal(r.startDate, '2026-12-06')
  const last = r.sessions.at(-1)
  assert.equal(last.date, '2026-12-19')
  assert.match(last.title, /考前回顾/)
  assert.ok(Math.abs(r.plannedMinutes - 600) <= 60)
  const firstHalf = r.sessions.filter((s) => s.date < '2026-12-13').length
  const secondHalf = r.sessions.filter((s) => s.date >= '2026-12-13').length
  assert.ok(secondHalf > firstHalf, `expected denser near the exam: ${firstHalf} vs ${secondHalf}`)
  assert.ok(r.sessions.every((s) => s.minutes <= 120))
  // 同一天最多两次常规复习 + 一次考前回顾
  const perDay = {}
  for (const s of r.sessions) perDay[s.date] = (perDay[s.date] || 0) + 1
  assert.ok(Object.values(perDay).every((n) => n <= 3))
})

test('busy days get less; another exam day gets nothing; the day before it is halved', () => {
  const busy = {
    '2026-12-15': { exams: ['线性代数 期末考试'] },
    '2026-12-14': { examTomorrow: ['线性代数 期末考试'] },
    '2026-12-17': { taskMinutes: 120 },
  }
  const r = planSmartRevision({ ...base, dailyBudget: 120, busy })
  assert.ok(!r.sessions.some((s) => s.date === '2026-12-15'))
  assert.ok(!r.sessions.some((s) => s.date === '2026-12-17'))
  const before = r.sessions.filter((s) => s.date === '2026-12-14').reduce((n, s) => n + s.minutes, 0)
  assert.ok(before <= 60)
})

test('not enough free time gives a clear warning instead of overbooking', () => {
  const r = planSmartRevision({ ...base, today: '2026-12-17', dailyBudget: 60, difficulty: 'hard' })
  assert.equal(r.ok, true)
  assert.ok(r.plannedMinutes <= 3 * 60)
  assert.match(r.warnings[0], /还差约/)
})

test('topics: first pass in order, then spaced practice, final review last', () => {
  const topics = ['线性表', '栈和队列', '树', '图', '排序']
  const r = planSmartRevision({ ...base, topics, dailyBudget: 120 })
  const regular = r.sessions.filter((s) => s.phase !== 'final')
  const learned = regular.filter((s) => s.phase === 'learn').map((s) => s.topic).join('、')
  for (const t of topics) assert.ok(learned.includes(t), `topic ${t} should be covered in the first pass`)
  const practiced = regular.filter((s) => s.phase === 'practice').map((s) => s.topic).join('、')
  for (const t of topics) assert.ok(practiced.includes(t), `topic ${t} should also be practised`)
  assert.ok(regular.some((s) => s.topic.startsWith('练习回顾：线性表')))
  const firstPractice = regular.findIndex((s) => s.phase === 'practice')
  const lastLearn = regular.map((s) => s.phase).lastIndexOf('learn')
  assert.ok(firstPractice > lastLearn)
})

test('without topics the default phases are used', () => {
  const r = planSmartRevision({ ...base })
  assert.ok(r.sessions[0].topic.includes('梳理知识框架'))
  assert.ok(r.sessions.some((s) => s.topic.includes('错题回顾')))
})

test('limits and failures', () => {
  assert.equal(planSmartRevision({ ...base, exam: { title: 'x', date: null } }).ok, false)
  assert.equal(planSmartRevision({ ...base, today: '2026-12-20' }).ok, false)
  const huge = planSmartRevision({ ...base, totalMinutes: 6000, sessionMinutes: 20, dailyBudget: 720, today: '2026-10-01', startDate: '2026-10-01' })
  assert.ok(huge.sessions.length <= MAX_SESSIONS)
  assert.match(huge.warnings[0], /最多 30 次/)
  const full = planSmartRevision({ ...base, today: '2026-12-18', busy: { '2026-12-18': { taskMinutes: 500 }, '2026-12-19': { taskMinutes: 500 } } })
  assert.equal(full.ok, false)
})
