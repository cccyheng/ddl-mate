import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutDay, mondayOf, monthsOfWeek, parseDateKey, timeAxis, toMinutes, weekDays } from '../src/utils/weekTimetable.js'

test('monday of a week and the 7 day keys', () => {
  const monday = mondayOf(new Date(2026, 10, 5)) // 周四
  assert.deepEqual(weekDays(monday).map((d) => d.key), [
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08',
  ])
  assert.equal(mondayOf(new Date(2026, 10, 8)).getDate(), 2) // 周日仍属于本周
})

test('weeks spanning two months request both months', () => {
  assert.deepEqual(monthsOfWeek(new Date(2026, 10, 30)), [{ year: 2026, month: 11 }, { year: 2026, month: 12 }])
  assert.deepEqual(monthsOfWeek(new Date(2026, 11, 28)), [{ year: 2026, month: 12 }, { year: 2027, month: 1 }])
  assert.deepEqual(monthsOfWeek(new Date(2026, 10, 2)), [{ year: 2026, month: 11 }])
})

test('date keys and minutes parse strictly', () => {
  assert.equal(parseDateKey('2026-02-30'), null)
  assert.equal(parseDateKey('2026-11-05').getDate(), 5)
  assert.equal(toMinutes('08:05:00'), 485)
  assert.equal(toMinutes('nope'), null)
})

test('time axis grows to cover early and late classes', () => {
  assert.deepEqual(timeAxis([]).hours.length, 10)
  const axis = timeAxis([{ startTime: '07:30', endTime: '09:00' }, { startTime: '19:00', endTime: '20:40' }])
  assert.equal(axis.start, 7 * 60)
  assert.equal(axis.end, 21 * 60)
})

test('overlapping classes are placed side by side, others take the full width', () => {
  const axis = { start: 480, end: 1080 }
  const placed = layoutDay([
    { id: 1, startTime: '08:00', endTime: '09:40' },
    { id: 2, startTime: '09:00', endTime: '10:00' },
    { id: 3, startTime: '14:00', endTime: '15:40' },
    { id: 4, startTime: '10:00', endTime: '09:00' }, // 无效时间被忽略
  ], axis)
  const byId = Object.fromEntries(placed.map((p) => [p.id, p]))
  assert.equal(placed.length, 3)
  assert.equal(byId[1].lane, 0)
  assert.equal(byId[2].lane, 1)
  assert.equal(byId[1].lanes, 2)
  assert.equal(byId[3].lanes, 1)
  assert.equal(byId[1].top, 0)
  assert.ok(Math.abs(byId[3].top - 360 / 600) < 1e-9)
})
