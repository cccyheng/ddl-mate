/**
 * 今日学习计划 —— **纯算法**测试（无数据库 / 无 React / 无网络）。
 *
 * 覆盖的是授权书点名要证明的东西：重叠 / 相邻校验、忙区间合并、clipping、
 * 「现在」向上取整、DDL 向下取整与「恰好到点排不下」、没有 DDL 排最后、
 * 优先级稳定排序、跨多个时段 / 多节课拆分、单双周与学期范围、
 * 早 DDL 任务排不满时后面的任务仍然拿得到剩余容量、分钟守恒、
 * 不产生 0 时长块、缺预计用时 / 选中上限、时区与零点、以及「输入不被改写」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SELECTED_TASKS,
  buildTodayPlan,
  ceilToNextMinute,
  floorToMinuteOfShanghaiDay,
  isPlanForToday,
  mergeBusyIntervals,
  normalizePlanMinutes,
  sameTodayPlanFingerprint,
  subtractIntervals,
  todayPlanContextDigest,
  todayPlanFingerprint,
  validateStudyWindows,
  verifyTodayPlan,
} from '../src/domain/todayPlan.ts'

/* --------------------------------- 夹具 --------------------------------- */

const TZ = '2026-10-15' // 周四
/** 上海 2026-10-15 10:00:30 → 02:00:30Z。「现在」之后的第一分钟是 10:01。 */
const NOW = new Date('2026-10-15T02:00:30.000Z')

let nextId = 1

/** 每个任务拿到唯一 id（测试里不手写 id，避免用例之间撞号）。 */
function task(overrides = {}) {
  const id = overrides.id ?? nextId++
  return {
    id,
    title: `任务 ${id}`,
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

function course(overrides = {}) {
  const id = overrides.id ?? 1
  return {
    id,
    code: 'AUTO-01',
    name: `课程 ${id}`,
    instructor: null,
    semester: null,
    color: null,
    note: null,
    selectionSerial: null,
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
    ...overrides,
  }
}

function schedule(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    courseId: overrides.courseId ?? 1,
    weekday: overrides.weekday ?? 4,
    startTime: overrides.startTime ?? '08:00',
    endTime: overrides.endTime ?? '09:40',
    location: null,
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: overrides.semesterStartDate ?? '2026-09-07',
    startWeek: overrides.startWeek ?? 1,
    endWeek: overrides.endWeek ?? 16,
    weekPattern: overrides.weekPattern ?? 'ALL',
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
  }
}

function plan(overrides = {}) {
  return buildTodayPlan({
    date: TZ,
    now: NOW,
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [],
    tasks: [],
    schedules: [],
    courses: [],
    ...overrides,
  })
}

/** 计划结果里「理论上还能用的分钟数」（空闲缺口之和）。 */
function freeCapacity(result) {
  return result.freeSlots.reduce((total, slot) => total + (slot.endMinute - slot.startMinute), 0)
}

/* ------------------------------ 时段输入校验 ------------------------------ */

test('时段校验：空白行被忽略，相邻允许，重叠/倒置/非法格式一律拒绝', () => {
  const blank = validateStudyWindows([
    { start: '', end: '' },
    { start: '  ', end: '' },
  ])
  assert.equal(blank.ok, true)
  assert.equal(blank.windows.length, 0)

  const adjacent = validateStudyWindows([
    { start: '08:00', end: '09:00' },
    { start: '09:00', end: '10:00' },
  ])
  assert.equal(adjacent.ok, true, '首尾相接不算重叠')
  assert.deepEqual(
    adjacent.windows.map((window) => `${window.start}-${window.end}`),
    ['08:00-09:00', '09:00-10:00'],
  )

  const unsorted = validateStudyWindows([
    { start: '14:00', end: '15:00' },
    { start: '08:00', end: '09:00' },
  ])
  assert.equal(unsorted.ok, true)
  assert.deepEqual(
    unsorted.windows.map((window) => window.start),
    ['08:00', '14:00'],
    '归一化后按开始时间排序',
  )

  const overlapping = validateStudyWindows([
    { start: '08:00', end: '09:30' },
    { start: '09:00', end: '10:00' },
  ])
  assert.equal(overlapping.ok, false, '重叠必须报错，不能偷偷合并')
  assert.equal(overlapping.issues[0].field, 'overlap')

  assert.equal(validateStudyWindows([{ start: '10:00', end: '10:00' }]).ok, false, '开始 = 结束非法')
  assert.equal(validateStudyWindows([{ start: '11:00', end: '10:00' }]).ok, false, '开始 > 结束非法')
  assert.equal(validateStudyWindows([{ start: '8:00', end: '9:00' }]).ok, false, 'HH:mm 必须两位')
  assert.equal(validateStudyWindows([{ start: '08:00', end: '25:00' }]).ok, false, '小时越界')
  assert.equal(validateStudyWindows([{ start: '08:60', end: '10:00' }]).ok, false, '分钟越界')
  assert.equal(validateStudyWindows([{ start: '08:00', end: '' }]).ok, false, '只填一半非法')
  assert.equal(
    validateStudyWindows([
      { start: '01:00', end: '02:00' },
      { start: '03:00', end: '04:00' },
      { start: '05:00', end: '06:00' },
      { start: '07:00', end: '08:00' },
      { start: '09:00', end: '10:00' },
    ]).ok,
    false,
    '超过 4 段必须报错（第 5 段不静默丢弃）',
  )
})

/* ------------------------------- 忙区间运算 ------------------------------- */

test('忙区间：重叠与相邻都合并，减法不留下假的缝隙', () => {
  const merged = mergeBusyIntervals([
    { start: 60, end: 120 },
    { start: 110, end: 180 },
    { start: 180, end: 200 },
    { start: 400, end: 401 },
  ])
  assert.deepEqual(merged, [
    { start: 60, end: 200 },
    { start: 400, end: 401 },
  ])

  const free = subtractIntervals([{ start: 0, end: 300 }], merged)
  assert.deepEqual(free, [
    { start: 0, end: 60 },
    { start: 200, end: 300 },
  ])

  const fullyBusy = subtractIntervals([{ start: 60, end: 120 }], [{ start: 0, end: 1440 }])
  assert.deepEqual(fullyBusy, [])
})

/* --------------------------- 现在向上取整 / DDL 取整 --------------------------- */

test('现在向上取整到下一分钟（按上海墙上时间，不看设备时区）', () => {
  const ceil = ceilToNextMinute(new Date('2026-10-15T02:00:00.001Z'))
  assert.equal(ceil.dateKey, '2026-10-15')
  assert.equal(ceil.minute, 601, '10:00:00.001 → 10:01')
  const exact = ceilToNextMinute(new Date('2026-10-15T02:00:00.000Z'))
  assert.equal(exact.minute, 600, '正好整分 → 保持 10:00')
  const late = ceilToNextMinute(new Date('2026-10-15T15:59:30.000Z')) // 上海 23:59:30
  assert.equal(late.dateKey, '2026-10-15', '不换天：日期守卫负责判断这一天是不是过完了')
  assert.equal(late.minute, 1440, '23:59:30 向上取整到 24:00 = 当天剩余容量 0')
  const lastSecond = ceilToNextMinute(new Date('2026-10-15T15:59:59.999Z'))
  assert.equal(lastSecond.dateKey, '2026-10-15')
  assert.equal(lastSecond.minute, 1440)
  assert.equal(ceilToNextMinute(new Date('not a date')), null, '非法 now 返回 null，绝不用 Date.now 兜底')
})

test('晚上 23:59 生成计划：当天剩余容量为 0，白天时段不会被重新打开', () => {
  const late = task()
  const result = plan({
    now: new Date('2026-10-15T15:59:30.000Z'), // 上海 23:59:30
    tasks: [late],
    windows: [{ start: '08:00', end: '09:00' }],
    selections: [{ taskId: late.id, minutes: 30 }],
  })
  assert.equal(result.blocks.length, 0)
  assert.equal(result.scheduledMinutes, 0)
  assert.equal(result.windowLabels.length, 0, '已经过完的时段不会被当成可用')
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('目标日期不是 now 的上海今天：一块都不排，并说明要重新开始', () => {
  const one = task()
  const result = plan({
    date: '2026-10-14',
    tasks: [one],
    selections: [{ taskId: one.id, minutes: 30 }],
  })
  assert.equal(result.blocks.length, 0)
  assert.equal(result.outcomes[0].unscheduled.reason, 'DATE_NOT_TODAY')
  assert.ok(result.inputErrors.some((message) => message.includes('2026-10-14')))
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('DDL 向下取整到分钟，且必须落在上海当天之内', () => {
  assert.deepEqual(floorToMinuteOfShanghaiDay('2026-10-15T10:30:59+08:00'), {
    dateKey: '2026-10-15',
    minute: 630,
  })
  assert.equal(floorToMinuteOfShanghaiDay('2026-10-15T10:30:59.999+08:00').minute, 630, '小数秒也向下取整')
  assert.equal(floorToMinuteOfShanghaiDay('not-a-time'), null)
  assert.equal(floorToMinuteOfShanghaiDay(null), null)

  assert.deepEqual(
    floorToMinuteOfShanghaiDay('2026-10-15'),
    { dateKey: '2026-10-15', minute: 1440 },
    '只到日期表示当天结束前，计划可以排满这一天',
  )
})

test('只到日期的 DDL 当天仍可排计划，不因没有时刻被判成脏数据', () => {
  const onlyDate = task({ title: '只到日期', deadline: '2026-10-15', estimatedMinutes: 60 })
  const result = plan({
    tasks: [onlyDate],
    selections: [{ taskId: onlyDate.id, minutes: 60 }],
  })
  assert.equal(result.outcomes[0].unscheduled, null)
  assert.equal(result.blocks.reduce((total, block) => total + block.minutes, 0), 60)
  assert.equal(verifyTodayPlan(result).ok, true)
})

/* -------------------------------- 排序规则 -------------------------------- */

test('没有 DDL 的任务排在最后；同时刻按优先级降序、再按 id 稳定', () => {
  const noDeadlineA = task({ title: '无 DDL A', priority: 5 })
  const noDeadlineB = task({ title: '无 DDL B', priority: 1 })
  const early = task({ title: '早 DDL', priority: 1, deadline: '2026-10-15T11:00:00+08:00' })
  const sameTimeHigh = task({ title: '同刻高优先', priority: 5, deadline: '2026-10-15T12:00:00+08:00' })
  const sameTimeLow = task({ title: '同刻低优先', priority: 2, deadline: '2026-10-15T12:00:00+08:00' })
  const tomorrow = task({ title: '明天 DDL', priority: 5, deadline: '2026-10-16T09:00:00+08:00' })
  const tasks = [noDeadlineA, noDeadlineB, early, sameTimeHigh, sameTimeLow, tomorrow]

  const result = plan({
    tasks,
    windows: [{ start: '10:00', end: '14:00' }],
    selections: tasks.map((entry) => ({ taskId: entry.id, minutes: 30 })),
  })
  assert.deepEqual(
    result.blocks.map((block) => block.taskId),
    [early.id, sameTimeHigh.id, sameTimeLow.id, tomorrow.id, noDeadlineA.id, noDeadlineB.id],
    '最早 DDL → 优先级高 → id 小；无 DDL 最后（内部也按优先级）',
  )
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.taskId),
    tasks.map((entry) => entry.id),
    '结论保持用户选择顺序',
  )
  assert.equal(result.blocks.length, 6, '每个任务都拿到了一块')
})

/* ------------------------------ 课表与容量 ------------------------------ */

test('今天真实有课的整段算忙；学期范围外 / 别的星期几都不占时间', () => {
  const one = task()
  const courses = [course({ id: 1 })]

  const withClass = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ startTime: '10:30', endTime: '11:00' })],
    windows: [{ start: '10:00', end: '11:30' }],
    selections: [{ taskId: one.id, minutes: 120 }],
  })
  // 可用：10:01-10:30（29）+ 11:00-11:30（30）= 59 分钟。
  assert.equal(withClass.scheduledMinutes, 59)
  assert.equal(withClass.unscheduledMinutes, 61)
  assert.deepEqual(
    withClass.blocks.map((block) => `${block.startTime}-${block.endTime}`),
    ['10:01-10:30', '11:00-11:30'],
  )
  assert.deepEqual(withClass.freeSlots.map((slot) => `${slot.start}-${slot.end}`), ['10:01-10:30', '11:00-11:30'])

  const otherWeekday = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ weekday: 3, startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 120 }],
  })
  assert.equal(otherWeekday.scheduledMinutes, 119, '别的星期几不占时间（可用 10:01-12:00）')

  const outOfTerm = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ startWeek: 20, endWeek: 22, startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 120 }],
  })
  assert.equal(outOfTerm.scheduledMinutes, 119, '学期范围外不占时间')

  // 教学周：2026-09-07 是第 1 周周一，2026-10-15 是第 6 周（周四，双周）。
  const evenBusy = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ weekPattern: 'EVEN', startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 120 }],
  })
  assert.equal(evenBusy.scheduledMinutes, 0, '第 6 周是双周，EVEN 课占用整段')

  const oddFree = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ weekPattern: 'ODD', startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 120 }],
  })
  assert.equal(oddFree.scheduledMinutes, 119, '第 6 周不是单周，ODD 课不占时间')
})

test('exact week：第 6 周命中的课占时间，起止周错开的课不占', () => {
  const one = task()
  const courses = [course({ id: 1 })]
  const hit = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ startWeek: 6, endWeek: 6, startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 60 }],
  })
  assert.equal(hit.scheduledMinutes, 0)
  const miss = plan({
    tasks: [one],
    courses,
    schedules: [schedule({ startWeek: 3, endWeek: 5, startTime: '10:00', endTime: '12:00' })],
    selections: [{ taskId: one.id, minutes: 60 }],
  })
  assert.equal(miss.scheduledMinutes, 60, '第 3-5 周的课今天不上，整段可用')
})

/* --------------------------- DDL 边界与拆分 --------------------------- */

test('DDL 恰好等于现在：一分钟都排不下，且明确给出原因', () => {
  const exact = task({ deadline: '2026-10-15T10:00:30+08:00' })
  const nowResult = plan({ tasks: [exact], selections: [{ taskId: exact.id, minutes: 30 }] })
  assert.equal(nowResult.scheduledMinutes, 0)
  assert.equal(nowResult.outcomes[0].unscheduled.reason, 'DEADLINE_NOW', 'DDL 正好是 now 这一刻')

  const past = task({ deadline: '2026-10-15T09:00:00+08:00' })
  const pastResult = plan({ tasks: [past], selections: [{ taskId: past.id, minutes: 30 }] })
  assert.equal(pastResult.outcomes[0].unscheduled.reason, 'DEADLINE_PASSED', 'DDL 早于 now')

  const yesterday = task({ deadline: '2026-10-14T20:00:00+08:00' })
  const yesterdayResult = plan({ tasks: [yesterday], selections: [{ taskId: yesterday.id, minutes: 30 }] })
  assert.equal(yesterdayResult.outcomes[0].unscheduled.reason, 'DEADLINE_PASSED')
})

test('DDL 在 now 之后但只有一分钟可用时，只排一分钟', () => {
  const soon = task({ deadline: '2026-10-15T10:02:00+08:00' })
  const result = plan({
    tasks: [soon],
    windows: [{ start: '10:00', end: '11:00' }],
    selections: [{ taskId: soon.id, minutes: 60 }],
  })
  assert.equal(result.scheduledMinutes, 1, '允许的最后一分钟是 10:01（10:02 不含）')
  assert.equal(result.blocks[0].startTime, '10:01')
  assert.equal(result.blocks[0].endTime, '10:02')
  assert.equal(result.unscheduledMinutes, 59)
})

test('DDL 的秒被向下取整：10:30:59 的块最多排到 10:30', () => {
  const floored = task({ deadline: '2026-10-15T10:30:59+08:00' })
  const result = plan({
    tasks: [floored],
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [{ taskId: floored.id, minutes: 600 }],
  })
  assert.equal(result.blocks[0].endTime, '10:30')
  assert.equal(result.scheduledMinutes, 29, '可用区间是 10:01–10:30（10:30 那一分钟不含）')
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('任务会跨多个时段与多节课拆分，块都是正整数分钟且互不重叠', () => {
  const split = task({ deadline: '2026-10-15T18:00:00+08:00' })
  const courses = [course({ id: 1 })]
  const result = plan({
    tasks: [split],
    courses,
    schedules: [schedule({ startTime: '13:00', endTime: '14:00' })],
    windows: [
      { start: '10:00', end: '11:00' },
      { start: '12:30', end: '15:00' },
    ],
    selections: [{ taskId: split.id, minutes: 200 }],
  })
  // 可用：10:01-11:00（59）+ 12:30-13:00（30）+ 14:00-15:00（60）= 149 分钟。
  assert.equal(freeCapacity(result), 149)
  assert.equal(result.scheduledMinutes, 149)
  assert.equal(result.unscheduledMinutes, 51)
  assert.deepEqual(
    result.blocks.map((block) => `${block.startTime}-${block.endTime}`),
    ['10:01-11:00', '12:30-13:00', '14:00-15:00'],
  )
  for (const block of result.blocks) {
    assert.ok(block.minutes >= 1)
    assert.equal(block.endMinute - block.startMinute, block.minutes)
  }
  assert.equal(result.blocks.length, result.outcomes[0].blockCount)
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('早 DDL 的任务排不满时，后面的任务仍然拿得到剩余容量（不丢容量）', () => {
  const earlyDeadline = task({ priority: 5, deadline: '2026-10-15T11:00:00+08:00' })
  const later = task({ priority: 1, deadline: '2026-10-15T18:00:00+08:00' })
  const result = plan({
    tasks: [earlyDeadline, later],
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [
      { taskId: earlyDeadline.id, minutes: 100 },
      { taskId: later.id, minutes: 60 },
    ],
  })
  const capacity = freeCapacity(result)
  assert.equal(capacity, 119)
  // 早 DDL 的任务在自己的允许区间里尽量排满（10:01–11:00 = 59），剩下的给后面的任务。
  assert.equal(result.outcomes[0].scheduledMinutes, 59)
  assert.equal(result.outcomes[0].unscheduledMinutes, 41)
  assert.equal(result.outcomes[1].scheduledMinutes, 60)
  assert.equal(result.outcomes[1].unscheduledMinutes, 0, '后面的任务拿到了剩下的容量')
  assert.equal(result.scheduledMinutes, capacity, '总容量一分钟都不浪费')
  assert.equal(result.unscheduledMinutes, 41)
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('分钟守恒：每个选中任务的「已排 + 未排 = 计划分钟数」，整份也是', () => {
  const tight = task({ deadline: '2026-10-15T10:30:00+08:00' })
  const open = task()
  const done = task({ status: 'DONE' })
  const overdue = task({ deadline: '2026-10-15T09:00:00+08:00' })
  const result = plan({
    tasks: [tight, open, done, overdue],
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [
      { taskId: tight.id, minutes: 90 },
      { taskId: open.id, minutes: 45 },
      { taskId: done.id, minutes: 30 },
      { taskId: overdue.id, minutes: 30 },
      { taskId: 987_654, minutes: 20 },
    ],
  })
  for (const outcome of result.outcomes) {
    assert.equal(outcome.scheduledMinutes + outcome.unscheduledMinutes, outcome.targetMinutes)
  }
  assert.equal(result.scheduledMinutes + result.unscheduledMinutes, result.targetMinutes)
  const verification = verifyTodayPlan(result)
  assert.equal(verification.ok, true, verification.errors.join(' / '))
  assert.equal(result.outcomes[2].unscheduled.reason, 'INACTIVE_TASK')
  assert.equal(result.outcomes[3].unscheduled.reason, 'DEADLINE_PASSED')
  assert.equal(result.outcomes[4].unscheduled.reason, 'MISSING_TASK')
  assert.equal(result.outcomes[2].scheduledMinutes, 0, '已完成的任务一分钟都不排')
})

test('没有学习时段 / 时段全在过去：一分钟都排不进去，并说明原因', () => {
  const one = task()
  const none = plan({ tasks: [one], windows: [], selections: [{ taskId: one.id, minutes: 60 }] })
  assert.equal(none.emptyPlan, true)
  assert.equal(none.outcomes[0].unscheduled.reason, 'NO_WINDOW')

  const past = plan({ tasks: [one], windows: [{ start: '08:00', end: '09:00' }], selections: [{ taskId: one.id, minutes: 60 }] })
  assert.equal(past.scheduledMinutes, 0)
  assert.equal(past.windowLabels.length, 0, '已经过去的时段不参与')
  assert.equal(past.outcomes[0].unscheduled.reason, 'NO_WINDOW')

  const head = plan({ tasks: [one], windows: [{ start: '09:30', end: '10:30' }], selections: [{ taskId: one.id, minutes: 60 }] })
  assert.equal(head.scheduledMinutes, 29, '只保留从「现在」之后的部分（10:00:30 → 10:01 起）')
  assert.equal(head.blocks[0].startTime, '10:01')
})

test('缺失预计用时不会被当成 0 或自动填；非法计划分钟数被拒', () => {
  const missing = task({ estimatedMinutes: null })
  const zero = task({ estimatedMinutes: 0 })
  const result = plan({
    tasks: [missing, zero],
    selections: [
      { taskId: missing.id, minutes: 60 },
      { taskId: zero.id, minutes: 0 },
    ],
  })
  assert.equal(result.outcomes[0].scheduledMinutes, 60, '目标分钟数只来自用户输入')
  assert.equal(result.outcomes[0].targetMinutes, 60)
  assert.equal(result.outcomes[1].targetMinutes, 0)
  assert.equal(result.outcomes[1].scheduledMinutes, 0)
  assert.equal(result.outcomes[1].unscheduled.reason, 'INVALID_TARGET')
  assert.ok(result.warnings.some((warning) => warning.includes('预计用时')), '要提示有选中任务没填过预计用时')

  assert.equal(normalizePlanMinutes(0), null)
  assert.equal(normalizePlanMinutes(1441), null)
  assert.equal(normalizePlanMinutes('60'), 60)
  assert.equal(normalizePlanMinutes(60.5), null)
  assert.equal(normalizePlanMinutes('1e2'), null)
  assert.equal(normalizePlanMinutes(true), null)
})

test('进行中的任务会被提示「进度没有被测量」，计划分钟数仍然只用用户输入', () => {
  const doing = task({ status: 'DOING', estimatedMinutes: 120 })
  const result = plan({
    tasks: [doing],
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [{ taskId: doing.id, minutes: 45 }],
  })
  assert.equal(result.outcomes[0].targetMinutes, 45, '不会自动用 estimatedMinutes')
  assert.equal(result.outcomes[0].scheduledMinutes, 45)
  assert.ok(result.warnings.some((warning) => warning.includes('进度')))
})

test('超过 30 个选中任务：明确报错并且一块都不排（不静默截断）', () => {
  const tasks = Array.from({ length: MAX_SELECTED_TASKS + 1 }, () => task())
  const result = plan({
    tasks,
    windows: [{ start: '10:00', end: '23:00' }],
    selections: tasks.map((entry) => ({ taskId: entry.id, minutes: 10 })),
  })
  assert.ok(
    result.inputErrors.some((message) => message.includes(String(MAX_SELECTED_TASKS))),
    '要把「最多 30 个」这条错误摆出来',
  )
  assert.equal(result.blocks.length, 0, '超限时绝不能给出「看起来能用」的计划')
  assert.equal(result.scheduledMinutes, 0)
  assert.equal(result.outcomes.length, MAX_SELECTED_TASKS + 1, '每个选择项的结论都在，一个都没丢')
  assert.ok(result.outcomes.every((outcome) => outcome.unscheduled?.reason === 'INVALID_INPUT'))
  assert.equal(verifyTodayPlan(result).ok, true)
})

test('重复选中同一个任务：整份输入判为不合法，一块都不排', () => {
  const one = task()
  const result = plan({
    tasks: [one],
    windows: [{ start: '10:00', end: '12:00' }],
    selections: [
      { taskId: one.id, minutes: 30 },
      { taskId: one.id, minutes: 30 },
    ],
  })
  assert.equal(result.blocks.length, 0, '同一任务被算两次是不可接受的')
  assert.ok(result.inputErrors.some((message) => message.includes('重复')))
})

test('任务编号不是正整数（字符串 / 布尔值）：判为不合法，不做 Number 兜底', () => {
  const one = task()
  for (const badId of ['1', true, 0, -1, 1.5, null]) {
    const result = plan({
      tasks: [one],
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: badId, minutes: 30 }],
    })
    assert.equal(result.blocks.length, 0, `任务编号 ${String(badId)} 必须被拒绝`)
    assert.ok(result.inputErrors.length > 0)
  }
})

/* ------------------------------- 时区与零点 ------------------------------- */

test('设备时区无关：同一时刻在不同 TZ 环境给出同样的墙钟结果', () => {
  const original = process.env.TZ
  try {
    const one = task()
    process.env.TZ = 'America/New_York'
    const ny = plan({ tasks: [one], selections: [{ taskId: one.id, minutes: 30 }] })
    process.env.TZ = 'UTC'
    const utc = plan({ tasks: [one], selections: [{ taskId: one.id, minutes: 30 }] })
    assert.deepEqual(ny.blocks, utc.blocks)
    assert.equal(ny.blocks[0].startTime, '10:01')
    assert.equal(ny.scheduledMinutes, 30)
  } finally {
    process.env.TZ = original
  }
})

test('零点：昨天的日期不再算今天，计划也不会被当成今天的', () => {
  assert.equal(isPlanForToday(TZ, NOW), true)
  assert.equal(isPlanForToday(TZ, new Date('2026-10-15T16:30:00.000Z')), false, '上海 00:30 已经是 10-16')
  const next = task()
  const nextDay = plan({
    date: '2026-10-16',
    now: new Date('2026-10-15T16:30:00.000Z'),
    windows: [{ start: '00:30', end: '01:30' }],
    tasks: [next],
    selections: [{ taskId: next.id, minutes: 30 }],
  })
  assert.equal(nextDay.scheduledMinutes, 30)
  assert.equal(nextDay.blocks[0].startTime, '00:30', '整分边界上从 00:30 起算')
})

/* --------------------------------- 指纹 --------------------------------- */

test('指纹：顺序无关、只看相关内容；与排布无关的 updatedAt 不影响', () => {
  const one = task({ deadline: '2026-10-15T18:00:00+08:00' })
  const other = task()
  const tasks = [one]
  const windows = validateStudyWindows([{ start: '10:00', end: '12:00' }]).windows
  const selections = [
    { taskId: one.id, minutes: 60 },
    { taskId: other.id, minutes: 30 },
  ]
  const first = todayPlanFingerprint({ date: TZ, windows, selections, context: { tasks, schedules: [], courses: [] } })
  const reordered = todayPlanFingerprint({
    date: TZ,
    windows,
    selections: [...selections].reverse(),
    context: { tasks, schedules: [], courses: [] },
  })
  assert.equal(sameTodayPlanFingerprint(first, reordered), true)

  const touchedUpdatedAt = todayPlanFingerprint({
    date: TZ,
    windows,
    selections,
    context: { tasks: [{ ...one, updatedAt: '2026-10-15T09:00:00+08:00' }], schedules: [], courses: [] },
  })
  assert.equal(sameTodayPlanFingerprint(first, touchedUpdatedAt), true, '无关字段不该让预览失效')

  const changedDeadline = todayPlanFingerprint({
    date: TZ,
    windows,
    selections,
    context: { tasks: [{ ...one, deadline: '2026-10-15T19:00:00+08:00' }], schedules: [], courses: [] },
  })
  assert.equal(sameTodayPlanFingerprint(first, changedDeadline), false, 'DDL 变了预览就得作废')

  const changedStatus = todayPlanFingerprint({
    date: TZ,
    windows,
    selections,
    context: { tasks: [{ ...one, status: 'DONE' }], schedules: [], courses: [] },
  })
  assert.equal(sameTodayPlanFingerprint(first, changedStatus), false, '任务完成也要让预览作废')

  const changedMinutes = todayPlanFingerprint({
    date: TZ,
    windows,
    selections: [
      { taskId: one.id, minutes: 61 },
      { taskId: other.id, minutes: 30 },
    ],
    context: { tasks, schedules: [], courses: [] },
  })
  assert.equal(sameTodayPlanFingerprint(first, changedMinutes), false)

  const addedCourse = todayPlanFingerprint({
    date: TZ,
    windows,
    selections,
    context: { tasks, schedules: [], courses: [course({ id: 9, name: '新加的课' })] },
  })
  assert.equal(sameTodayPlanFingerprint(first, addedCourse), false, '新增课程也要能看出来')
  assert.notEqual(todayPlanContextDigest({ tasks: [], schedules: [], courses: [] }), '')
})

/* ------------------------------ 输入不被改写 ------------------------------ */

test('纯函数：输入对象在生成计划后一个字段都没变', () => {
  const one = task({ deadline: '2026-10-15T11:00:00+08:00', estimatedMinutes: 90 })
  const tasks = [one]
  const schedules = [schedule({ id: 5, startTime: '10:30', endTime: '11:00' })]
  const windows = [{ start: '10:00', end: '12:00' }]
  const selections = [{ taskId: one.id, minutes: 120 }]
  const tasksSnapshot = JSON.parse(JSON.stringify(tasks))
  const schedulesSnapshot = JSON.parse(JSON.stringify(schedules))
  const windowsSnapshot = JSON.parse(JSON.stringify(windows))
  const selectionsSnapshot = JSON.parse(JSON.stringify(selections))

  plan({ tasks, schedules, courses: [course({ id: 1 })], windows, selections })

  assert.deepEqual(tasks, tasksSnapshot)
  assert.deepEqual(schedules, schedulesSnapshot)
  assert.deepEqual(windows, windowsSnapshot)
  assert.deepEqual(selections, selectionsSnapshot)
  assert.equal(one.estimatedMinutes, 90, '任务的预计用时永远不被计划改写')
})

test('自检能抓到人为破坏的计划（证明 verify 真的在检查）', () => {
  const one = task()
  const result = plan({ tasks: [one], selections: [{ taskId: one.id, minutes: 30 }] })
  assert.equal(verifyTodayPlan(result).ok, true)

  const zeroLength = { ...result, blocks: [{ ...result.blocks[0], endMinute: result.blocks[0].startMinute, minutes: 0 }] }
  assert.equal(verifyTodayPlan(zeroLength).ok, false, '零时长块要被抓到')

  const outsideWindow = { ...result, blocks: [{ ...result.blocks[0], startMinute: 0, endMinute: 30 }] }
  assert.equal(verifyTodayPlan(outsideWindow).ok, false, '块跑到时段外要被抓到')

  const brokenConservation = {
    ...result,
    outcomes: [{ ...result.outcomes[0], unscheduledMinutes: 1 }],
  }
  assert.equal(verifyTodayPlan(brokenConservation).ok, false, '分钟守恒被破坏要被抓到')

  const duplicateIdentity = { ...result, blocks: [result.blocks[0], { ...result.blocks[0] }] }
  assert.equal(verifyTodayPlan(duplicateIdentity).ok, false, '块身份重复要被抓到')

  const wrongClockString = {
    ...result,
    blocks: [{ ...result.blocks[0], startTime: '23:59' }],
  }
  assert.equal(verifyTodayPlan(wrongClockString).ok, false, 'HH:mm 文案与分钟数对不上要被抓到')

  const unknownTaskBlock = { ...result, blocks: [{ ...result.blocks[0], taskId: 4242 }] }
  assert.equal(verifyTodayPlan(unknownTaskBlock).ok, false, '块的任务没有对应结果要被抓到')
})

test('自检会抓到压到上课时间的块（空闲缺口，而不只是「在窗口内」）', () => {
  const one = task()
  const result = plan({
    tasks: [one],
    courses: [course({ id: 1 })],
    schedules: [schedule({ startTime: '10:30', endTime: '11:00' })],
    windows: [{ start: '10:00', end: '11:30' }],
    selections: [{ taskId: one.id, minutes: 59 }],
  })
  assert.equal(verifyTodayPlan(result).ok, true)
  assert.equal(result.busyIntervals.length, 1)

  // 人为把第二块挪进上课时间里：容器（窗口）没变，但空闲缺口对不上。
  const intoClass = {
    ...result,
    blocks: [result.blocks[0], { ...result.blocks[0], startMinute: 630, endMinute: 630 + 29, startTime: '10:30', endTime: '10:59' }],
  }
  const verification = verifyTodayPlan(intoClass)
  assert.equal(verification.ok, false)
  assert.ok(verification.errors.some((error) => error.includes('空闲缺口') || error.includes('忙区间')))
})
