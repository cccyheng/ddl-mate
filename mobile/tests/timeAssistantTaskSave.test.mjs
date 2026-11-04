// 原生时间助手：与真实 SQLite 的集成测试。
//
// 授权书要求证明两件事：
// 1. 解析 / 采用**不会**写任何数据库（只读）；
// 2. 「采用此时间」得到的时间，经**现有的任务保存路径**写进去之后能被原样读回。
// 这里用的是应用真正的 schema 与仓库（见 tests/helpers/sqliteHarness.mjs 的说明：
// Node 侧 SQLite 验证 SQL / 事务 / 校验，验证不了原生绑定与真机 UI）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTestDatabase, courseDraft, taskDraft } from './helpers/sqliteHarness.mjs'
import { resolveTimeAssistant } from '../src/domain/timeAssistant.ts'

/** 参考时间固定为北京时间 2026-10-13（周二）12:00。 */
const REFERENCE_AT = '2026-10-13T12:00:00+08:00'
const SEMESTER_START = '2026-09-07'
const scheduleInput = (courseId, overrides = {}) => ({
  weekday: 4,
  startTime: '08:00',
  endTime: '09:40',
  location: '教三 305',
  periodStart: '',
  periodEnd: '',
  semesterStartDate: SEMESTER_START,
  startWeek: '1',
  endWeek: '16',
  weekPattern: 'ALL',
  ...overrides,
})

async function seed() {
  const ctx = await createTestDatabase()
  const course = await ctx.courses.create(courseDraft({ name: '数据结构', code: 'CS201' }))
  const schedule = await ctx.courses.createSchedule(course.id, scheduleInput(course.id))
  return { ctx, course, schedule }
}

test('真实课表 → 解析「下节课前」→ 采用 → 现有保存路径写回一致的时间', async () => {
  const { ctx, course, schedule } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const schedules = await ctx.courses.listSchedules()
    assert.equal(schedules.length, 1)

    const before = {
      tasks: await ctx.tasks.countAll(),
      schedules: await ctx.courses.countSchedules(),
      courses: courses.length,
    }

    const result = resolveTimeAssistant({
      text: '下节课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses,
      schedules,
    })
    assert.equal(result.status, 'RESOLVED', result.message)
    const candidate = result.candidates[0]
    assert.equal(candidate.wallClock, '2026-10-15T08:00', '周四 08:00 的课')
    assert.equal(candidate.scheduleId, schedule.id)
    assert.equal(candidate.scheduleLocation, '教三 305')

    // 解析是只读的：库里的条数一条不变
    assert.equal(await ctx.tasks.countAll(), before.tasks, '解析不得创建任务')
    assert.equal(await ctx.courses.countSchedules(), before.schedules, '解析不得改课表')
    assert.equal((await ctx.courses.listAll()).length, before.courses)

    // 「采用」= 把候选时间填进任务草稿的 deadline
    const outcome = await ctx.tasks.create(
      taskDraft({ title: '数据结构第 3 次作业', courseId: course.id, deadline: candidate.wallClock }),
    )
    assert.equal(outcome.committed, true)
    assert.equal(outcome.readbackError, null)

    const stored = await ctx.tasks.getById(outcome.task.id)
    assert.equal(stored.deadline, '2026-10-15T08:00:00+08:00', '入库统一带 +08:00')
    assert.equal(stored.courseId, course.id)

    // 采用之后仍然可以手工改（助手不会锁死这个字段）
    const edited = await ctx.tasks.update(
      stored.id,
      taskDraft({ title: stored.title, courseId: course.id, deadline: '2026-10-18T23:30' }),
    )
    assert.equal(edited.committed, true)
    const afterEdit = await ctx.tasks.getById(stored.id)
    assert.equal(afterEdit.deadline, '2026-10-18T23:30:00+08:00')
  } finally {
    ctx.close()
  }
})

test('候选时间与上课边界严格一致：不会提前扣分钟', async () => {
  const { ctx, course } = await seed()
  try {
    const schedules = await ctx.courses.listSchedules()
    // 参考日 2026-10-13（周二）：本周四是 10-15，下周四才是 10-22
    const thisWeek = resolveTimeAssistant({
      text: '本周四上课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses: [course],
      schedules,
    })
    assert.equal(thisWeek.candidates[0].wallClock, '2026-10-15T08:00')

    const nextWeek = resolveTimeAssistant({
      text: '下周四上课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses: [course],
      schedules,
    })
    const candidate = nextWeek.candidates[0]
    assert.equal(candidate.wallClock, '2026-10-22T08:00')
    assert.equal(candidate.scheduleStartTime, '08:00')
    assert.equal(candidate.deadline, '2026-10-22T08:00:00+08:00')
  } finally {
    ctx.close()
  }
})

test('课表改动之后同一个短语给出不同结果（助手读的是最新课表）', async () => {
  const { ctx, course, schedule } = await seed()
  try {
    const first = resolveTimeAssistant({
      text: '下节课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses: [course],
      schedules: await ctx.courses.listSchedules(),
    })
    assert.equal(first.candidates[0].wallClock, '2026-10-15T08:00')

    // 把这门课的课表从周四改到周五 10:00
    await ctx.courses.updateSchedule(schedule.id, scheduleInput(course.id, { weekday: 5, startTime: '10:00', endTime: '11:40' }))
    const second = resolveTimeAssistant({
      text: '下节课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses: [course],
      schedules: await ctx.courses.listSchedules(),
    })
    assert.equal(second.candidates[0].wallClock, '2026-10-16T10:00', '读的是当前课表，不是旧快照')
  } finally {
    ctx.close()
  }
})

test('课程没有课表时如实说没有课表，且不写任何数据', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft({ name: '没有课表的课', code: 'X1' }))
    const result = resolveTimeAssistant({
      text: '下节课前',
      referenceAt: REFERENCE_AT,
      courseId: course.id,
      courses: [course],
      schedules: [],
    })
    assert.equal(result.status, 'NO_COURSE_MATCH')
    assert.match(result.message, /还没有课表/)
    assert.equal(await ctx.tasks.countAll(), 0)
    assert.equal(await ctx.courses.countSchedules(), 0)
  } finally {
    ctx.close()
  }
})
