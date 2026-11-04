// 学习周报：纯统计 / 周算术 / 明细选择器测试。
//
// 覆盖授权书点名的边界：上海滚动、跨年、闰日、只到日期的截止、
// 完成时间不是修改时间、DONE 缺少完成时间、重新打开、取消、同名课程、
// 缺课程 / 未关联课程、完成率分母 0、每日计数、明细与计数完全一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isDeadlineOverdue } from '../src/domain/datetime.ts'
import {
  LEARNING_REPORT_HISTORY_WEEKS,
  analyzeLearningReport,
  currentLearningWeek,
  formatLearningReportRate,
  isDateKeyInLearningWeek,
  learningWeekHistoryBounds,
  learningWeekOf,
  parseTaskCompletion,
  selectLearningReportTasks,
  shiftLearningWeek,
} from '../src/domain/learningReport.ts'

/** 固定的「现在」：北京时间 2026-10-15（周四）20:00。 */
const NOW = new Date('2026-10-15T20:00:00+08:00')
const WEEK_START = '2026-10-12'

function task(overrides = {}) {
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
    createdAt: '2026-10-01T00:00:00+08:00',
    updatedAt: '2026-10-01T00:00:00+08:00',
    ...overrides,
  }
}

function course(id, name) {
  return {
    id,
    code: `AUTO-${id}`,
    name,
    instructor: null,
    semester: null,
    color: null,
    note: null,
    selectionSerial: null,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
  }
}

function run(tasks, courses = [], now = NOW, weekStartDateKey = WEEK_START) {
  return analyzeLearningReport({ tasks, courses, weekStartDateKey, now })
}

function ids(tasks) {
  return tasks.map((entry) => entry.id)
}

function dayOf(analysis, dateKey) {
  const day = analysis.days.find((entry) => entry.dateKey === dateKey)
  assert.ok(day, `结果里应该有 ${dateKey} 这一天`)
  return day
}

/* ------------------------------- 周与日期 ------------------------------- */

test('默认周是上海周一到周日，且任意一天都会归一到同一个周一', () => {
  const week = currentLearningWeek(NOW)
  assert.deepEqual(week, { startDateKey: '2026-10-12', endDateKey: '2026-10-18' })
  assert.deepEqual(learningWeekOf('2026-10-15'), week, '周四会归一到周一')
  assert.deepEqual(learningWeekOf('2026-10-12'), week)
  assert.deepEqual(learningWeekOf('2026-10-18'), week, '周日仍属于这一周')
  assert.equal(learningWeekOf('2026-10-19').startDateKey, '2026-10-19', '下周一进入下一周')
  assert.equal(learningWeekOf('2026-02-30'), null)
  assert.equal(learningWeekOf('not-a-date'), null)
  assert.equal(isDateKeyInLearningWeek('2026-10-12', week), true)
  assert.equal(isDateKeyInLearningWeek('2026-10-19', week), false)
})

test('设备时区不参与：UTC 的周日晚在上海已经是周一凌晨', () => {
  // 2026-10-18T16:30Z === 2026-10-19 00:30（上海，周一）
  assert.deepEqual(currentLearningWeek(new Date('2026-10-18T16:30:00Z')), {
    startDateKey: '2026-10-19',
    endDateKey: '2026-10-25',
  })
  // 2026-10-18T15:30Z === 2026-10-18 23:30（上海，周日）
  assert.deepEqual(currentLearningWeek(new Date('2026-10-18T15:30:00Z')), {
    startDateKey: '2026-10-12',
    endDateKey: '2026-10-18',
  })
  assert.equal(currentLearningWeek(new Date('invalid')), null)
})

test('跨年周与闰日周都能正确展开，不经过手机本地时区', () => {
  assert.deepEqual(learningWeekOf('2026-01-01'), {
    startDateKey: '2025-12-29',
    endDateKey: '2026-01-04',
  })
  assert.deepEqual(shiftLearningWeek('2025-12-29', -1), {
    startDateKey: '2025-12-22',
    endDateKey: '2025-12-28',
  })
  assert.deepEqual(learningWeekOf('2028-02-29'), {
    startDateKey: '2028-02-28',
    endDateKey: '2028-03-05',
  })
  assert.equal(shiftLearningWeek('2025-12-29', 1.5), null)
  assert.equal(shiftLearningWeek('2025-12-29', Number.NaN), null)
})

test('回看范围是含当前周在内的 52 周', () => {
  const bounds = learningWeekHistoryBounds(NOW)
  assert.equal(LEARNING_REPORT_HISTORY_WEEKS, 52)
  assert.equal(bounds.current.startDateKey, '2026-10-12')
  // 2026-10-12 往前 51 周 = 2025-10-20
  assert.equal(bounds.earliest.startDateKey, '2025-10-20')
  assert.equal(bounds.earliest.endDateKey, '2025-10-26')
})

/* ------------------------------- 完成 cohort ------------------------------ */

test('本周完成只认当前 DONE + 合法完成时间的上海日期；修改时间完全不参与', () => {
  const analysis = run([
    // updatedAt 在下一周，但 completedAt 在本周：仍算本周完成。
    task({ id: 1, status: 'DONE', completedAt: '2026-10-13T09:00:00+08:00', updatedAt: '2026-10-20T09:00:00+08:00' }),
    task({ id: 2, status: 'DONE', completedAt: '2026-10-12', updatedAt: '2026-10-13T00:00:00+08:00' }),
    task({ id: 3, status: 'DONE', completedAt: '2026-10-11T23:59:00+08:00' }),
    task({ id: 4, status: 'DONE', completedAt: null }),
    task({ id: 5, status: 'DONE', completedAt: 'not-a-date' }),
    // 重新打开：completedAt 还留着也不算完成。
    task({ id: 6, status: 'TODO', completedAt: '2026-10-14T10:00:00+08:00' }),
    task({ id: 7, status: 'DONE', completedAt: '2026-10-15T21:00:00+08:00' }),
    // UTC 的 10-14 16:30 = 上海 10-15 00:30，仍在本周。
    task({ id: 8, status: 'DONE', completedAt: '2026-10-14T16:30:00Z' }),
    task({ id: 9, status: 'DONE', completedAt: '2025-12-31T23:30:00+08:00' }),
    task({ id: 10, status: 'CANCELLED', completedAt: '2026-10-14T10:00:00+08:00' }),
    // completedAt 在下一周，updatedAt 在本周：不能算本周完成。
    task({ id: 11, status: 'DONE', completedAt: '2026-10-20T09:00:00+08:00', updatedAt: '2026-10-14T09:00:00+08:00' }),
  ])

  assert.deepEqual(analysis.completedThisWeek.map((entry) => entry.task.id), [2, 1, 8])
  assert.deepEqual(
    analysis.completedThisWeek.map((entry) => entry.dateKey),
    ['2026-10-12', '2026-10-13', '2026-10-15'],
  )
  assert.deepEqual(ids(analysis.doneMissingCompletion), [4, 5])
  assert.deepEqual(ids(analysis.doneOutsideWeek), [9, 3, 11])
  assert.deepEqual(ids(analysis.doneFutureThisWeek), [7])
  assert.equal(analysis.totals.done, 9, 'CANCELLED 与重新打开的 TODO 都不算 DONE 总数')
  assert.equal(
    analysis.totals.completedThisWeek +
      analysis.totals.doneMissingCompletion +
      analysis.totals.doneOutsideWeek +
      analysis.totals.doneFutureThisWeek,
    analysis.totals.done,
    '每一笔当前 DONE 都恰好落进一个完成分类',
  )
  assert.equal(analysis.doneFutureThisWeek.length, 1)
  // 每日完成与总完成一致。
  assert.equal(analysis.days.reduce((sum, day) => sum + day.completedCount, 0), 3)
  assert.deepEqual(ids(dayOf(analysis, '2026-10-12').completedTasks), [2])
  assert.deepEqual(ids(dayOf(analysis, '2026-10-13').completedTasks), [1])
  assert.deepEqual(ids(dayOf(analysis, '2026-10-15').completedTasks), [8])
})

test('完成率分母为 0 时是空数据（null / 「—」），绝不显示 100%', () => {
  const analysis = run([])
  assert.equal(analysis.dueCompletionRate, null)
  assert.equal(analysis.dueCompletionPercent, null)
  assert.equal(formatLearningReportRate(analysis.dueCompletionRate), '—')
  assert.equal(analysis.days.length, 7)
  assert.deepEqual(analysis.days.map((day) => day.weekday), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(analysis.days.every((day) => day.completedCount === 0), true)
  assert.equal(analysis.days.every((day) => day.completedTasks.length === 0), true)
  assert.equal(analysis.courseGroups.length, 0)
  assert.deepEqual(analysis.courseTotals, { dueTotal: 0, dueDone: 0, dueOpen: 0, overdue: 0 })
  assert.equal(analysis.totals.done, 0)
})

test('完成时间恰好等于 now 才算本周完成，晚一毫秒就是异常的未来时间', () => {
  const exact = run([
    task({ id: 1, status: 'DONE', completedAt: '2026-10-15T20:00:00.000+08:00' }),
  ])
  assert.deepEqual(ids(exact.completedThisWeek.map((entry) => entry.task)), [1])
  assert.deepEqual(ids(exact.doneFutureThisWeek), [])

  const future = run([
    task({ id: 1, status: 'DONE', completedAt: '2026-10-15T20:00:00.001+08:00' }),
  ])
  assert.deepEqual(future.completedThisWeek, [])
  assert.deepEqual(ids(future.doneFutureThisWeek), [1])
  assert.deepEqual(ids(future.doneMissingCompletion), [], '未来时间不是「缺失」')
})

test('本周到期全部完成时完成率才是 100%', () => {
  const analysis = run([
    task({ id: 1, status: 'DONE', deadline: '2026-10-13', completedAt: '2026-10-13T10:00:00+08:00' }),
    task({ id: 2, status: 'DONE', deadline: '2026-10-14', completedAt: null }),
  ])
  assert.equal(analysis.dueTasks.length, 2)
  assert.equal(analysis.dueDone.length, 2)
  assert.equal(analysis.overdueNow.length, 0)
  assert.equal(analysis.dueCompletionRate, 1)
  assert.equal(formatLearningReportRate(analysis.dueCompletionRate), '100%')
  assert.deepEqual(ids(analysis.doneMissingCompletion), [2], '缺完成时间仍算到期已完成，但不伪造本周完成')
  assert.equal(analysis.completedThisWeek.length, 1)
})

/* -------------------------------- 到期 cohort ------------------------------- */

test('到期 / 未完成 / 逾期互相对得上，取消与周外任务不混入', () => {
  const analysis = run([
    task({ id: 1, status: 'DONE', deadline: '2026-10-13T09:00:00+08:00', completedAt: null }),
    task({ id: 2, status: 'TODO', deadline: '2026-10-13T09:00:00+08:00' }),
    task({ id: 3, status: 'DOING', deadline: '2026-10-15' }),
    task({ id: 4, status: 'TODO', deadline: '2026-10-15T19:00:00+08:00' }),
    task({ id: 5, status: 'TODO', deadline: '2026-10-15T20:00:00+08:00' }),
    task({ id: 6, status: 'TODO', deadline: '2026-10-18' }),
    task({ id: 7, status: 'CANCELLED', deadline: '2026-10-14' }),
    task({ id: 8, status: 'TODO', deadline: '2026-10-19' }),
    task({ id: 9, status: 'DONE', deadline: '2026-10-14T12:00:00+08:00', completedAt: '2026-10-14T13:00:00+08:00' }),
    task({ id: 10, status: 'TODO', deadline: 'oops' }),
    task({ id: 11, status: 'DONE', deadline: '2026-10-16', completedAt: '2026-10-15T21:00:00+08:00' }),
    task({ id: 12, status: 'DONE', deadline: '2026-10-17', completedAt: '2026-10-11T10:00:00+08:00' }),
  ])

  assert.deepEqual(ids(analysis.dueTasks).slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 9, 11, 12])
  assert.deepEqual(ids(analysis.dueDone), [1, 9, 11, 12])
  assert.deepEqual(ids(analysis.dueOpen), [2, 4, 5, 3, 6])
  assert.deepEqual(ids(analysis.overdueNow), [2, 4])
  assert.deepEqual(ids(analysis.malformedDeadline), [10])
  assert.equal(analysis.dueTasks.length, 9)
  assert.equal(analysis.dueDone.length + analysis.dueOpen.length, analysis.dueTasks.length)
  assert.equal(analysis.overdueNow.every((entry) => analysis.dueOpen.includes(entry)), true)
  assert.equal(analysis.dueCompletionPercent, 44)
  assert.equal(formatLearningReportRate(analysis.dueCompletionRate), '44%')

  // 每日到期计数：10-13 两条、10-14 一条（已取消的不算）、10-15 三条、10-16/17/18 各一条。
  assert.equal(dayOf(analysis, '2026-10-13').dueCount, 2)
  assert.equal(dayOf(analysis, '2026-10-13').overdueCount, 1)
  assert.equal(dayOf(analysis, '2026-10-14').dueCount, 1)
  assert.equal(dayOf(analysis, '2026-10-15').dueCount, 3)
  assert.equal(dayOf(analysis, '2026-10-15').overdueCount, 1)
  assert.equal(dayOf(analysis, '2026-10-16').dueCount, 1)
  assert.equal(dayOf(analysis, '2026-10-17').dueCount, 1)
  assert.equal(dayOf(analysis, '2026-10-18').dueCount, 1)
  assert.equal(
    analysis.days.reduce((sum, day) => sum + day.dueCount, 0),
    analysis.dueTasks.length,
    '每日到期之和等于本周到期',
  )
})

test('只到日期的截止在当天结束前不算逾期，跨过上海零点才算', () => {
  const tasks = [task({ id: 1, deadline: '2026-10-15' })]
  const beforeMidnight = run(tasks, [], new Date('2026-10-15T23:59:59+08:00'))
  assert.deepEqual(ids(beforeMidnight.overdueNow), [])
  assert.equal(dayOf(beforeMidnight, '2026-10-15').overdueCount, 0)

  const atMidnight = run(tasks, [], new Date('2026-10-16T00:00:00+08:00'))
  assert.deepEqual(ids(atMidnight.overdueNow), [1])
  assert.equal(atMidnight.week.startDateKey, '2026-10-12', '10-16 仍属于 10-12 这一周')
  assert.equal(dayOf(atMidnight, '2026-10-15').overdueCount, 1)
})

test('精确时刻的逾期边界：到点不算，过一毫秒才算', () => {
  const tasks = [task({ id: 1, deadline: '2026-10-15T20:00:00+08:00' })]
  assert.deepEqual(ids(run(tasks, [], new Date('2026-10-15T19:59:59.999+08:00')).overdueNow), [])
  assert.deepEqual(ids(run(tasks, [], new Date('2026-10-15T20:00:00+08:00')).overdueNow), [])
  assert.deepEqual(ids(run(tasks, [], new Date('2026-10-15T20:00:00.001+08:00')).overdueNow), [1])
  assert.equal(isDeadlineOverdue('2026-10-15T20:00:00+08:00', new Date('2026-10-15T20:00:00+08:00')), false)
})

test('上海滚动：UTC 深夜的截止与完成都归到上海第二天', () => {
  const analysis = run([
    task({ id: 1, deadline: '2026-10-15T16:30:00Z' }),
    task({ id: 2, status: 'DONE', completedAt: '2026-10-12T16:30:00Z' }),
    task({ id: 3, status: 'DONE', completedAt: '2026-10-18T16:30:00Z' }),
  ])
  assert.deepEqual(ids(analysis.dueTasks), [1])
  assert.equal(dayOf(analysis, '2026-10-16').dueCount, 1)
  assert.deepEqual(analysis.completedThisWeek.map((entry) => entry.dateKey), ['2026-10-13'])
  assert.deepEqual(ids(analysis.doneOutsideWeek), [3], '上海 10-19 已经不在 10-12 这一周')
})

test('未关联课程 / 缺课程 / 同名课程按 courseId 分开，课程合计数对得上', () => {
  const courses = [course(1, '高数'), course(2, '高数'), course(3, '英语')]
  const analysis = run(
    [
      task({ id: 1, courseId: 1, deadline: '2026-10-13T09:00:00+08:00' }),
      task({ id: 2, courseId: 1, status: 'DONE', deadline: '2026-10-14', completedAt: '2026-10-14T10:00:00+08:00' }),
      task({ id: 3, courseId: 2, status: 'DONE', deadline: '2026-10-13' }),
      task({ id: 4, courseId: 2, deadline: '2026-10-15T19:00:00+08:00' }),
      task({ id: 5, courseId: 99, deadline: '2026-10-16' }),
      task({ id: 6, courseId: null, deadline: '2026-10-17' }),
      task({ id: 7, courseId: 3, deadline: '2026-10-18' }),
    ],
    courses,
  )

  assert.deepEqual(
    analysis.courseGroups.map((group) => [group.courseId, group.courseName, group.missingCourse]),
    [
      [3, '英语', false],
      [1, '高数', false],
      [2, '高数', false],
      [99, null, true],
      [null, null, false],
    ],
    '同名课程不合并，缺课程与未关联课程分别成组',
  )
  const byId = new Map(analysis.courseGroups.map((group) => [group.courseId, group]))
  assert.equal(byId.get(1).dueTotal, 2)
  assert.equal(byId.get(1).dueDone, 1)
  assert.equal(byId.get(1).dueOpen, 1)
  assert.equal(byId.get(1).overdue, 1)
  assert.equal(byId.get(2).dueTotal, 2)
  assert.equal(byId.get(2).dueDone, 1)
  assert.equal(byId.get(2).overdue, 1)
  assert.equal(byId.get(99).missingCourse, true)
  assert.equal(byId.get(null).overdue, 0, '10-17 还没到期')
  assert.deepEqual(ids(byId.get(null).tasks), [6])

  assert.deepEqual(analysis.courseTotals, { dueTotal: 7, dueDone: 2, dueOpen: 5, overdue: 2 })
  assert.equal(
    analysis.courseGroups.reduce((sum, group) => sum + group.dueTotal, 0),
    analysis.dueTasks.length,
  )
  assert.equal(
    analysis.courseGroups.reduce((sum, group) => sum + group.overdue, 0),
    analysis.overdueNow.length,
  )
  assert.equal(
    analysis.courseGroups.reduce((sum, group) => sum + group.dueDone, 0),
    analysis.dueDone.length,
  )
})

/* --------------------------- 跨年 / 闰日 / 非法输入 --------------------------- */

test('跨年周里的截止与完成按上海日期正确归周', () => {
  const analysis = analyzeLearningReport({
    tasks: [
      task({ id: 1, deadline: '2026-01-01', status: 'DONE', completedAt: '2025-12-31T23:30:00+08:00' }),
      task({ id: 2, deadline: '2026-01-04T23:59:00+08:00' }),
    ],
    courses: [],
    weekStartDateKey: '2025-12-29',
    now: new Date('2026-01-02T12:00:00+08:00'),
  })
  assert.equal(analysis.week.startDateKey, '2025-12-29')
  assert.deepEqual(ids(analysis.dueTasks), [1, 2])
  assert.deepEqual(ids(analysis.dueDone), [1])
  assert.deepEqual(analysis.completedThisWeek.map((entry) => entry.dateKey), ['2025-12-31'])
  assert.equal(dayOf(analysis, '2025-12-31').completedCount, 1)
  assert.equal(dayOf(analysis, '2026-01-01').dueCount, 1)
  assert.equal(dayOf(analysis, '2026-01-04').dueCount, 1)
})

test('闰日周可统计，非法周 / 非法 now 安全返回 null', () => {
  const analysis = analyzeLearningReport({
    tasks: [task({ id: 1, deadline: '2028-02-29' }), task({ id: 2, status: 'DONE', completedAt: '2028-02-29T09:00:00+08:00' })],
    courses: [],
    weekStartDateKey: '2028-02-28',
    now: new Date('2028-02-29T12:00:00+08:00'),
  })
  assert.equal(analysis.week.endDateKey, '2028-03-05')
  assert.equal(dayOf(analysis, '2028-02-29').dueCount, 1)
  assert.equal(dayOf(analysis, '2028-02-29').overdueCount, 0, '只到日期的当天截止还没过')
  assert.equal(analysis.completedThisWeek.length, 1)

  assert.equal(run([], [], NOW, '2028-02-30'), null)
  assert.equal(analyzeLearningReport({ tasks: [], courses: [], weekStartDateKey: WEEK_START, now: new Date('invalid') }), null)
})

test('parseTaskCompletion：带偏移按上海取日期，裸墙上时间 / 不存在日期不可用', () => {
  assert.deepEqual(parseTaskCompletion('2026-10-15T00:30:00Z'), {
    dateKey: '2026-10-15',
    epochMs: Date.parse('2026-10-15T00:30:00Z'),
  })
  assert.deepEqual(parseTaskCompletion('2026-10-15'), {
    dateKey: '2026-10-15',
    epochMs: Date.parse('2026-10-15T00:00:00+08:00'),
  })
  assert.equal(parseTaskCompletion('2026-10-15T10:00'), null)
  assert.equal(parseTaskCompletion('2026-02-30T10:00:00+08:00'), null)
  assert.equal(parseTaskCompletion('2026-10-15T10:00:00+99:99'), null)
  assert.equal(parseTaskCompletion('   '), null)
  assert.equal(parseTaskCompletion(null), null)
})

/* ------------------------------ 明细选择器 ------------------------------ */

test('每一个可点数字 / 课程 / 日期都通过同一选择器返回完整对应列表', () => {
  const courses = [course(1, '高数'), course(2, '高数')]
  const analysis = run(
    [
      task({ id: 1, courseId: 1, status: 'DONE', deadline: '2026-10-13T09:00:00+08:00', completedAt: '2026-10-14T08:00:00+08:00' }),
      task({ id: 2, courseId: 1, deadline: '2026-10-13T09:00:00+08:00' }),
      task({ id: 3, courseId: 2, status: 'DONE', deadline: '2026-10-14', completedAt: null }),
      task({ id: 4, courseId: 2, deadline: '2026-10-15T19:00:00+08:00' }),
      task({ id: 5, courseId: null, status: 'DONE', completedAt: '2026-10-15T10:00:00+08:00' }),
      task({ id: 6, courseId: null, status: 'DONE', completedAt: null }),
    ],
    courses,
  )

  const expected = {
    completedThisWeek: [1, 5],
    doneMissingCompletion: [3, 6],
    due: [1, 2, 3, 4],
    dueDone: [1, 3],
    dueOpen: [2, 4],
    overdue: [2, 4],
    dayWednesday: [1],
  }
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'completedThisWeek' })), expected.completedThisWeek)
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'doneMissingCompletion' })), expected.doneMissingCompletion)
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'due' })), expected.due)
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'dueDone' })), expected.dueDone)
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'dueOpen' })), expected.dueOpen)
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'overdue' })), expected.overdue)
  // 2026-10-14 是周三。
  assert.deepEqual(
    ids(selectLearningReportTasks(analysis, { kind: 'completedDay', weekday: 3 })),
    expected.dayWednesday,
  )
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'completedDay', weekday: 1 })), [])

  // 每个选择器的长度与汇总数字完全一致。
  assert.equal(selectLearningReportTasks(analysis, { kind: 'completedThisWeek' }).length, analysis.totals.completedThisWeek)
  assert.equal(selectLearningReportTasks(analysis, { kind: 'doneMissingCompletion' }).length, analysis.totals.doneMissingCompletion)
  assert.equal(selectLearningReportTasks(analysis, { kind: 'due' }).length, analysis.totals.dueTotal)
  assert.equal(selectLearningReportTasks(analysis, { kind: 'dueDone' }).length, analysis.totals.dueDone)
  assert.equal(selectLearningReportTasks(analysis, { kind: 'dueOpen' }).length, analysis.totals.dueOpen)
  assert.equal(selectLearningReportTasks(analysis, { kind: 'overdue' }).length, analysis.totals.overdue)

  // 课程选择器按 id 分开，不会把两门同名课合并。
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'course', courseId: 1 })), [1, 2])
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'course', courseId: 2 })), [3, 4])
  assert.deepEqual(ids(selectLearningReportTasks(analysis, { kind: 'course', courseId: null })), [])
  for (const group of analysis.courseGroups) {
    assert.equal(
      selectLearningReportTasks(analysis, { kind: 'course', courseId: group.courseId }).length,
      group.dueTotal,
    )
  }
  for (const day of analysis.days) {
    assert.equal(
      selectLearningReportTasks(analysis, { kind: 'completedDay', weekday: day.weekday }).length,
      day.completedCount,
    )
  }

  // 选中列表确实满足对应 cohort 的定义，而不是只比长度。
  assert.equal(
    selectLearningReportTasks(analysis, { kind: 'dueOpen' }).every((entry) => entry.status !== 'DONE'),
    true,
  )
  assert.equal(
    selectLearningReportTasks(analysis, { kind: 'overdue' }).every((entry) => isDeadlineOverdue(entry.deadline, NOW)),
    true,
  )
  assert.equal(
    selectLearningReportTasks(analysis, { kind: 'dueDone' }).every((entry) => entry.status === 'DONE'),
    true,
  )
})
