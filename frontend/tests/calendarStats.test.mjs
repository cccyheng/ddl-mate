import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeMonth } from '../src/utils/calendarStats.js'

test('空月份：有安排的天数为 0（不能等于 days.size）', () => {
  const days = new Map([
    ['2026-10-01', { tasks: [], schedules: [] }],
    ['2026-10-02', { tasks: [], schedules: [] }],
    ['2026-10-03', { tasks: [], schedules: [] }],
  ])
  const stats = summarizeMonth(days)
  assert.equal(days.size, 3)
  assert.equal(stats.activeDays, 0, '整月都返回但没有任何安排时必须是 0 天')
  assert.equal(stats.taskCount, 0)
  assert.equal(stats.courseCount, 0)
})

test('只统计真有课程或 DDL 的日期', () => {
  const days = new Map([
    ['2026-10-01', { tasks: [], schedules: [] }],
    ['2026-10-02', { tasks: [{ id: 1 }], schedules: [] }],
    ['2026-10-03', { tasks: [], schedules: [{ id: 2 }, { id: 3 }] }],
    ['2026-10-04', { tasks: [{ id: 4 }], schedules: [{ id: 5 }] }],
  ])
  const stats = summarizeMonth(days)
  assert.equal(stats.activeDays, 3)
  assert.equal(stats.taskCount, 2)
  assert.equal(stats.courseCount, 3)
})

test('兼容空 Map 与对象，并容忍缺字段', () => {
  assert.deepEqual(summarizeMonth(new Map()), { taskCount: 0, courseCount: 0, activeDays: 0 })
  assert.deepEqual(summarizeMonth({}), { taskCount: 0, courseCount: 0, activeDays: 0 })
  assert.equal(summarizeMonth({ '2026-10-05': {} }).activeDays, 0)
})
