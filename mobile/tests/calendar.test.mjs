// 日历聚合、今日分组与统计的测试。
//
// 重点覆盖：任务按**截止时间的北京时间自然日**归组、未设置 DDL 的任务不进入任何一天、
// 月历网格以周一开头且为 6×7、课程按真实教学周展开、逾期统计。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketToday,
  buildCalendarMonth,
  calendarGridStart,
  computeTaskStats,
  getDaySummary,
  groupDeadlinesByDate,
  groupOverdueByDate,
  listMeetingsInRange,
} from '../src/domain/calendar.ts'
import { weekdayOfDateKey } from '../src/domain/datetime.ts'

const SEMESTER_START = '2026-09-07'

function makeTask(overrides = {}) {
  return {
    id: 1,
    title: '任务',
    description: null,
    courseId: null,
    type: 'HOMEWORK',
    status: 'TODO',
    priority: 3,
    deadline: null,
    estimatedMinutes: null,
    submitRequirement: null,
    submitMethod: null,
    completedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeCourse(overrides = {}) {
  return {
    id: 1,
    code: 'CS201',
    name: '数据结构',
    instructor: null,
    semester: null,
    color: null,
    note: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSchedule(overrides = {}) {
  return {
    id: 1,
    courseId: 1,
    weekday: 4,
    startTime: '08:00',
    endTime: '09:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: '1-16',
    semesterStartDate: SEMESTER_START,
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'ALL',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

/* --------------------------- 月历网格 --------------------------- */

test('月历网格从该月 1 号所在周的周一开始', () => {
  // 2026-10-01 是周四 → 网格应从 2026-09-28（周一）开始
  assert.equal(weekdayOfDateKey('2026-10-01'), 4)
  assert.equal(calendarGridStart(2026, 10), '2026-09-28')
  assert.equal(calendarGridStart(2026, 9), '2026-08-31', '2026-09-01 是周二 → 前一周周一')
  assert.equal(calendarGridStart(2026, 6), '2026-06-01', '2026-06-01 本身就是周一')
  assert.equal(calendarGridStart(2026, 13), null, '非法月份返回 null')
})

test('月历固定 6×7 = 42 格，每格标出是否属于本月', () => {
  const month = buildCalendarMonth({ year: 2026, month: 10, schedules: [], courses: [], tasks: [], today: '2026-10-15' })
  assert.equal(month.cells.length, 42)

  const inMonth = month.cells.filter((cell) => cell.inMonth)
  assert.equal(inMonth.length, 31, '10 月有 31 天')
  assert.equal(inMonth[0].dateKey, '2026-10-01')
  assert.equal(inMonth[30].dateKey, '2026-10-31')

  const todayCell = month.cells.find((cell) => cell.dateKey === '2026-10-15')
  assert.equal(todayCell.isToday, true)
  assert.equal(month.cells.filter((cell) => cell.isToday).length, 1, '只有一天是今天')
})

test('月历格子里的课程数与 DDL 数来自真实数据', () => {
  const schedule = makeSchedule({ weekday: 4 })
  const tasks = [
    makeTask({ id: 1, deadline: '2026-10-15T22:00:00+08:00' }),
    makeTask({ id: 2, deadline: '2026-10-15T23:59:00+08:00' }),
    makeTask({ id: 3, deadline: '2026-10-20T10:00:00+08:00' }),
  ]
  const month = buildCalendarMonth({
    year: 2026,
    month: 10,
    schedules: [schedule],
    courses: [makeCourse()],
    tasks,
    today: '2026-10-01',
  })

  const d15 = month.cells.find((cell) => cell.dateKey === '2026-10-15')
  assert.equal(d15.deadlineCount, 2, '10-15 两条 DDL')
  assert.equal(d15.meetingCount, 1, '10-15 是周四，有一节课')

  const d16 = month.cells.find((cell) => cell.dateKey === '2026-10-16')
  assert.equal(d16.meetingCount, 0, '周五没有课')

  const d20 = month.cells.find((cell) => cell.dateKey === '2026-10-20')
  assert.equal(d20.deadlineCount, 1)
})

/* ------------------- 任务按北京时间自然日归组 ------------------- */

test('任务按截止时间的北京时间自然日归组，UTC 边界不会串天', () => {
  const tasks = [
    makeTask({ id: 1, deadline: '2026-10-15T23:30:00+08:00' }),
    makeTask({ id: 2, deadline: '2026-10-15T15:59:00Z' }), // = 北京 10-15 23:59
    makeTask({ id: 3, deadline: '2026-10-15T16:00:00Z' }), // = 北京 10-16 00:00
  ]
  const grouped = groupDeadlinesByDate(tasks)
  assert.deepEqual([...grouped.keys()].sort(), ['2026-10-15', '2026-10-16'])
  assert.deepEqual(
    grouped.get('2026-10-15').map((entry) => entry.task.id),
    [1, 2],
  )
  assert.deepEqual(
    grouped.get('2026-10-16').map((entry) => entry.task.id),
    [3],
  )
})

test('没有 DDL 的任务不出现在任何一天上（不猜时间）', () => {
  const grouped = groupDeadlinesByDate([makeTask({ id: 1, deadline: null })])
  assert.equal(grouped.size, 0)
})

test('只到日期的 DDL 归到用户选的那一天，并在当天内不显示逾期', () => {
  const tasks = [
    makeTask({ id: 1, deadline: '2026-10-15' }),
    makeTask({ id: 2, deadline: '2026-10-15T22:00:00+08:00' }),
  ]
  const grouped = groupDeadlinesByDate(tasks)
  assert.deepEqual([...grouped.keys()], ['2026-10-15'])
  assert.deepEqual(
    grouped.get('2026-10-15').map((entry) => entry.task.id),
    [2, 1],
    '同一天里精确时刻排在只到日期之前',
  )

  const dateOnlyTasks = [makeTask({ id: 1, deadline: '2026-10-15' })]
  const duringDay = new Date('2026-10-15T23:59:59+08:00')
  assert.equal(groupOverdueByDate(dateOnlyTasks, duringDay).size, 0, '当天内不算逾期')
  const afterDay = new Date('2026-10-16T00:00:00+08:00')
  assert.equal(groupOverdueByDate(dateOnlyTasks, afterDay).get('2026-10-15'), true, '跨过零点才算逾期')
})

test('今日/统计把只到日期当作当天截止，跨天才逾期', () => {
  const duringDay = new Date('2026-10-15T12:00:00+08:00')
  const tasks = [makeTask({ id: 1, deadline: '2026-10-15' })]
  const buckets = bucketToday(tasks, duringDay)
  assert.deepEqual(buckets.overdue.map((task) => task.id), [])
  assert.deepEqual(buckets.dueToday.map((task) => task.id), [1])

  const afterDay = new Date('2026-10-16T08:00:00+08:00')
  const afterBuckets = bucketToday(tasks, afterDay)
  assert.deepEqual(afterBuckets.overdue.map((task) => task.id), [1])
  assert.deepEqual(afterBuckets.dueToday, [])

  const statsDuring = computeTaskStats(tasks, duringDay)
  assert.equal(statsDuring.overdue, 0)
  assert.equal(statsDuring.today, 1)
  const statsAfter = computeTaskStats(tasks, afterDay)
  assert.equal(statsAfter.overdue, 1)
})

test('已取消的任务不进日历，已完成的任务仍显示在它截止的那天', () => {
  const grouped = groupDeadlinesByDate([
    makeTask({ id: 1, status: 'CANCELLED', deadline: '2026-10-15T22:00:00+08:00' }),
    makeTask({ id: 2, status: 'DONE', deadline: '2026-10-15T22:00:00+08:00' }),
  ])
  assert.deepEqual(
    grouped.get('2026-10-15').map((entry) => entry.task.id),
    [2],
  )
})

test('同一天的多个 DDL 按时间升序排列', () => {
  const grouped = groupDeadlinesByDate([
    makeTask({ id: 1, deadline: '2026-10-15T22:00:00+08:00' }),
    makeTask({ id: 2, deadline: '2026-10-15T09:00:00+08:00' }),
    makeTask({ id: 3, deadline: '2026-10-15T18:00:00+08:00' }),
  ])
  assert.deepEqual(
    grouped.get('2026-10-15').map((entry) => entry.task.id),
    [2, 3, 1],
  )
})

test('逾期标记只给未完成且已过截止时间的任务', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  const overdue = groupOverdueByDate(
    [
      makeTask({ id: 1, deadline: '2026-10-14T10:00:00+08:00' }),
      makeTask({ id: 2, deadline: '2026-10-16T10:00:00+08:00' }),
      makeTask({ id: 3, status: 'DONE', deadline: '2026-10-14T10:00:00+08:00' }),
      makeTask({ id: 4, status: 'CANCELLED', deadline: '2026-10-14T10:00:00+08:00' }),
    ],
    now,
  )
  assert.deepEqual([...overdue.keys()], ['2026-10-14'])
})

/* --------------------------- 单日聚合 --------------------------- */

test('getDaySummary 给出当天课程（按开始时间）与截止任务', () => {
  const schedules = [
    makeSchedule({ id: 1, weekday: 4, startTime: '10:00', endTime: '11:40' }),
    makeSchedule({ id: 2, weekday: 4, startTime: '08:00', endTime: '09:40' }),
    makeSchedule({ id: 3, weekday: 5, startTime: '14:00', endTime: '15:40' }),
  ]
  const tasks = [makeTask({ id: 1, deadline: '2026-10-15T22:00:00+08:00' })]
  const summary = getDaySummary('2026-10-15', schedules, [makeCourse()], tasks, '2026-10-15')

  assert.equal(summary.weekday, 4)
  assert.equal(summary.isToday, true)
  assert.deepEqual(
    summary.meetings.map((meeting) => meeting.schedule.id),
    [2, 1],
    '按开始时间 08:00 → 10:00 排序',
  )
  assert.equal(summary.meetings[0].course.name, '数据结构')
  assert.equal(summary.deadlines.length, 1)
})

test('getDaySummary 对没有课的日子返回空课程列表，而不是报错或编造', () => {
  const summary = getDaySummary('2026-10-15', [makeSchedule({ weekday: 5 })], [makeCourse()], [], '2026-10-15')
  assert.deepEqual(summary.meetings, [])
  assert.deepEqual(summary.deadlines, [])
})

test('listMeetingsInRange 尊重教学周范围与单双周', () => {
  const odd = makeSchedule({ id: 1, weekday: 1, weekPattern: 'ODD', startWeek: 1, endWeek: 4 })
  const meetings = listMeetingsInRange([odd], [makeCourse()], SEMESTER_START, '2026-09-28')
  assert.deepEqual(
    meetings.map((meeting) => meeting.dateKey),
    ['2026-09-07', '2026-09-21'],
    '第 1、3 周周一，第 2 周被单周规则排除',
  )
})

/* ------------------------- 今日分组与统计 ------------------------- */

test('bucketToday 把任务分成逾期 / 今天 / 即将 / 今天完成', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  const buckets = bucketToday(
    [
      makeTask({ id: 1, deadline: '2026-10-14T10:00:00+08:00' }),
      makeTask({ id: 2, deadline: '2026-10-15T22:00:00+08:00' }),
      makeTask({ id: 3, deadline: '2026-10-20T10:00:00+08:00' }),
      makeTask({ id: 4, deadline: null }),
      makeTask({ id: 5, status: 'DONE', completedAt: '2026-10-15T09:00:00+08:00' }),
      makeTask({ id: 6, status: 'DONE', completedAt: '2026-10-10T09:00:00+08:00' }),
      makeTask({ id: 7, status: 'CANCELLED', deadline: '2026-10-15T10:00:00+08:00' }),
    ],
    now,
  )
  assert.deepEqual(buckets.overdue.map((task) => task.id), [1])
  assert.deepEqual(buckets.dueToday.map((task) => task.id), [2])
  assert.deepEqual(
    buckets.upcoming.map((task) => task.id).sort(),
    [3, 4],
    '未设置 DDL 的未完成任务也出现在「接下来」里，但排在最后',
  )
  assert.equal(buckets.upcoming[buckets.upcoming.length - 1].id, 4, '未设置 DDL 排在最后')
  assert.deepEqual(buckets.doneToday.map((task) => task.id), [5], '只有今天完成的进入今天完成')
})

test('bucketToday 逾期组按截止时间升序（越早截止越靠前）', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  const buckets = bucketToday(
    [
      makeTask({ id: 1, deadline: '2026-10-13T10:00:00+08:00' }),
      makeTask({ id: 2, deadline: '2026-10-11T10:00:00+08:00' }),
      makeTask({ id: 3, deadline: '2026-10-14T10:00:00+08:00' }),
    ],
    now,
  )
  // 10-11 → 10-13 → 10-14。逾期最久的排最前面，便于先处理欠得最久的。
  assert.deepEqual(buckets.overdue.map((task) => task.id), [2, 1, 3])
})

test('computeTaskStats 的四个数字都来自真实计数', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  const stats = computeTaskStats(
    [
      makeTask({ id: 1, deadline: '2026-10-14T10:00:00+08:00' }), // 逾期
      makeTask({ id: 2, deadline: '2026-10-15T22:00:00+08:00' }), // 今天
      makeTask({ id: 3, deadline: '2026-10-18T10:00:00+08:00' }), // 7 天内
      makeTask({ id: 4, deadline: '2026-10-25T10:00:00+08:00' }), // 7 天外，不计入
      makeTask({ id: 5, status: 'DONE' }), // 已完成
      makeTask({ id: 6, status: 'CANCELLED' }), // 已取消，不计入任何一类
      makeTask({ id: 7, deadline: null }), // 未设置
    ],
    now,
  )
  assert.equal(stats.overdue, 1)
  assert.equal(stats.today, 1)
  assert.equal(stats.next7Days, 1)
  assert.equal(stats.done, 1)
  assert.equal(stats.noDeadline, 1)
  assert.equal(stats.total, 7)
})

test('统计边界：恰好第 7 天计入 7 天内，第 8 天不计入', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  const stats = computeTaskStats(
    [
      makeTask({ id: 1, deadline: '2026-10-22T10:00:00+08:00' }), // 第 7 天
      makeTask({ id: 2, deadline: '2026-10-23T10:00:00+08:00' }), // 第 8 天
    ],
    now,
  )
  assert.equal(stats.next7Days, 1)
})
