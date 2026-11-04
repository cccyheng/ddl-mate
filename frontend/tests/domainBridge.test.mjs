/**
 * 网页数据 → 手机端共享规则模块的桥接测试。
 *
 * 运行（需要手机端的 TS 无扩展名解析钩子；Node ≥ 22.18 自带类型剥离）：
 *   node --import ../mobile/tests/setup.mjs --test tests/domainBridge.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzeDdlPressure } from '../../mobile/src/domain/ddlPressure.ts'
import { applyFocusAction, decodeFocus, emptyFocus, focusTotal } from '../../mobile/src/domain/focusTime.ts'
import { analyzeLearningReport } from '../../mobile/src/domain/learningReport.ts'
import { buildTodayPlan } from '../../mobile/src/domain/todayPlan.ts'
import { toDomainCourse, toDomainSchedule, toDomainTask } from '../src/domain/mappers.js'

/** 与 GET /api/tasks 返回的单条记录同形状（字段取自真实响应）。 */
const webTask = (overrides = {}) => ({
  id: 7,
  title: '操作系统实验报告',
  course: { id: 1, code: 'CS201', name: '数据结构', color: '#4f7cff' },
  type: 'LAB',
  typeLabel: '实验',
  status: 'TODO',
  statusLabel: '未开始',
  priority: 4,
  priorityLabel: '较高',
  deadline: '2026-11-07T23:59:00+08:00',
  estimatedMinutes: 90,
  createdAt: '2026-11-01T10:00:00.123+08:00',
  updatedAt: '2026-11-01T10:00:00.123+08:00',
  sourceCount: 0,
  attachments: [],
  ...overrides,
})

const webCourse = { id: 1, code: 'CS201', name: '数据结构', instructor: '王老师', color: '#4f7cff', createdAt: 'x', updatedAt: 'x' }

test('任务：course 对象换成 courseId，缺省字段统一为 null', () => {
  const task = toDomainTask(webTask({ course: undefined, description: undefined, completedAt: undefined }))
  assert.equal(task.courseId, null)
  assert.equal(task.description, null)
  assert.equal(task.completedAt, null)
  assert.equal(toDomainTask(webTask()).courseId, 1)
})

test('课表：HH:mm:ss 截成 HH:mm，周次规则默认 ALL', () => {
  const schedule = toDomainSchedule({ id: 3, courseId: 1, weekday: 3, startTime: '14:00:00', endTime: '15:40:00' })
  assert.equal(schedule.startTime, '14:00')
  assert.equal(schedule.endTime, '15:40')
  assert.equal(schedule.weekPattern, 'ALL')
  assert.equal(schedule.location, null)
})

test('DDL 压力：网页任务按上海自然日归到正确的一天', () => {
  const now = new Date('2026-11-04T14:00:00+08:00')
  const analysis = analyzeDdlPressure({ tasks: [toDomainTask(webTask())], referenceMinutes: 60, now })
  assert.equal(analysis.includedCount, 1)
  const day = analysis.days.find((d) => d.dateKey === '2026-11-07')
  assert.equal(day.taskCount, 1)
  assert.equal(day.knownMinutes, 90)
  assert.equal(day.status, 'exceeds')
})

test('学习周报：completedAt 带秒与毫秒的网页时间也能计入本周完成', () => {
  const done = webTask({ status: 'DONE', completedAt: '2026-11-04T09:30:12.5+08:00' })
  const analysis = analyzeLearningReport({
    tasks: [toDomainTask(done)],
    courses: [toDomainCourse(webCourse)],
    weekStartDateKey: '2026-11-02',
    now: new Date('2026-11-04T14:00:00+08:00'),
  })
  assert.equal(analysis.totals.completedThisWeek, 1)
})

test('今日计划：避开课表占用时间，时间块不晚于 DDL', () => {
  const plan = buildTodayPlan({
    date: '2026-11-04',
    now: new Date('2026-11-04T13:00:00+08:00'),
    windows: [{ start: '14:00', end: '17:00' }],
    selections: [{ taskId: 7, minutes: 90 }],
    tasks: [toDomainTask(webTask())],
    schedules: [toDomainSchedule({ id: 3, courseId: 1, weekday: 3, startTime: '14:00:00', endTime: '15:40:00', weekPattern: 'ALL' })],
    courses: [toDomainCourse(webCourse)],
  })
  assert.equal(plan.scheduledMinutes, 80, '14:00–15:40 上课，只剩 15:40–17:00')
  assert.equal(plan.blocks[0].startTime, '15:40')
})

test('专注：存储格式往返后仍能解码（与手机端同一份 JSON）', () => {
  const t0 = Date.parse('2026-11-04T10:00:00+08:00')
  let store = applyFocusAction(emptyFocus(), { type: 'start', title: '复习', courseName: '数据结构' }, t0)
  store = applyFocusAction(store, { type: 'finish' }, t0 + 25 * 60000)
  const again = decodeFocus(JSON.stringify(store))
  assert.equal(focusTotal(again, t0, t0 + 3600000, t0 + 3600000), 25 * 60000)
})

test('状态：网页的 ARCHIVED 在规则模块里按「已取消」处理，不计入压力', async () => {
  const { analyzeDdlPressure: analyze } = await import('../../mobile/src/domain/ddlPressure.ts')
  const archived = toDomainTask(webTask({ status: 'ARCHIVED' }))
  assert.equal(archived.status, 'CANCELLED')
  const analysis = analyze({ tasks: [archived], now: new Date('2026-11-04T14:00:00+08:00') })
  assert.equal(analysis.includedCount, 0)
  assert.equal(analysis.excludedInactiveCount, 1)
})

test('重复任务草稿 → 网页创建请求：墙上时间补 +08:00，只到日期按 23:59，0 分钟视为未填', async () => {
  const { deadlineForWeb, draftToTaskRequest } = await import('../src/domain/taskTypes.js')
  assert.equal(deadlineForWeb('2026-11-09T23:59'), '2026-11-09T23:59:00+08:00')
  assert.equal(deadlineForWeb('2026-11-09'), '2026-11-09T23:59:00+08:00')
  assert.equal(deadlineForWeb('2026-11-09T10:00:00+08:00'), '2026-11-09T10:00:00+08:00')
  assert.equal(deadlineForWeb(''), null)
  const body = draftToTaskRequest({
    title: '周作业', description: '', courseId: 3, type: 'HOMEWORK', status: 'TODO', priority: 3,
    deadline: '2026-11-09T23:59', estimatedMinutes: '0', submitRequirement: '', submitMethod: '', originalText: '',
  })
  assert.equal(body.estimatedMinutes, null)
  assert.equal(body.description, null)
  assert.equal(body.deadline, '2026-11-09T23:59:00+08:00')
})

test('联动：专注按任务名 + 课程匹配；复习进度与所属考试互查', async () => {
  const { focusForTask, focusRouteFor, revisionPlanOf, revisionProgress } = await import('../src/domain/links.js')
  const t0 = Date.parse('2026-11-04T10:00:00+08:00')
  let store = applyFocusAction(emptyFocus(), { type: 'start', title: '操作系统实验报告', courseName: '数据结构' }, t0)
  store = applyFocusAction(store, { type: 'finish' }, t0 + 20 * 60000)
  store = applyFocusAction(store, { type: 'start', title: '操作系统实验报告', courseName: '大学英语' }, t0 + 30 * 60000)
  store = applyFocusAction(store, { type: 'finish' }, t0 + 40 * 60000)
  const summary = focusForTask(store, webTask())
  assert.equal(summary.count, 1, '课程不同的同名记录不算')
  assert.equal(summary.ms, 20 * 60000)
  assert.deepEqual(focusRouteFor(7, 45), { name: 'focus', query: { taskId: '7', minutes: '45' } })
  assert.deepEqual(focusRouteFor(7), { name: 'focus', query: { taskId: '7' } })

  const plans = [{ id: 1, examId: 70, examTitle: '期中考试', createdAt: 'x', fingerprint: 'f', taskIds: [71, 72, 73] }]
  const tasks = new Map([[71, { status: 'DONE' }], [72, { status: 'TODO' }]])
  assert.deepEqual(revisionProgress(plans, 70, tasks), { total: 2, done: 1, missing: 1 })
  assert.deepEqual(revisionPlanOf(plans, 72), { examId: 70, examTitle: '期中考试' })
  assert.equal(revisionPlanOf(plans, 99), null)
})
