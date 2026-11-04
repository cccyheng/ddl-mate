// DDL 压力分析：纯函数测试。
//
// 覆盖授权书点名的边界：
// - 上海自然日 / 设备时区无关；
// - 今天已过去的时刻算「已逾期」，且**不**再计入今天（计数互不重叠）；
// - DDL 恰好等于 now 算「今天到期」，不算已逾期；同一分钟内的先后也要分得清；
// - 第 7 天（含）在窗口内，第 8 天（含）在窗口外；
// - DONE / CANCELLED 完全排除，DOING 计入但**不被说成「剩余」**；
// - 没有 DDL / 脏 DDL 不会被硬塞进任何一天；
// - 扎堆阈值 3；缺预计用时与「预计用时 0」是两件事；
// - 参考用时未设置 / 相等 / 超过；
// - 负数等脏预计用时不产生 NaN；
// - 每天的列表顺序稳定。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONCENTRATION_THRESHOLD,
  PRESSURE_WINDOW_DAYS,
  analyzeDdlPressure,
  classifyPressureTask,
  countUnknownEstimates,
  formatMinutes,
  knownEstimateMinutesOf,
  normalizeReferenceMinutes,
  pressureStatusOf,
  sumKnownMinutes,
} from '../src/domain/ddlPressure.ts'

/** 固定的「现在」：北京时间 2026-10-15（周四）20:00。 */
const NOW = new Date('2026-10-15T20:00:00+08:00')

/** 造一条任务，只需给出本文件关心的字段。 */
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

/** 北京时间某一天的某个时刻（`2026-10-15 22:00` → 带 `+08:00` 的 ISO）。 */
function at(dateKey, clock) {
  return `${dateKey}T${clock}:00+08:00`
}

function run(tasks, referenceMinutes = null) {
  return analyzeDdlPressure({ tasks, referenceMinutes, now: NOW })
}

function dayOf(analysis, dateKey) {
  const day = analysis.days.find((entry) => entry.dateKey === dateKey)
  assert.ok(day, `分析结果里应该有 ${dateKey} 这一天`)
  return day
}

/* ------------------------------- 窗口与日期 ------------------------------- */

test('窗口是含今天在内的 7 个上海自然日，且排他上界是第 8 天', () => {
  const analysis = run([])
  assert.equal(analysis.windowDays, PRESSURE_WINDOW_DAYS)
  assert.equal(analysis.days.length, 7)
  assert.equal(analysis.windowStartDateKey, '2026-10-15')
  assert.equal(analysis.windowEndDateKey, '2026-10-21')
  assert.equal(analysis.windowEndExclusiveDateKey, '2026-10-22')
  assert.deepEqual(
    analysis.days.map((day) => day.dateKey),
    ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21'],
  )
  assert.equal(analysis.days[0].isToday, true)
  assert.equal(analysis.days[0].weekday, 4, '2026-10-15 是周四')
  assert.equal(analysis.days[6].weekday, 3, '2026-10-21 是周三')
})

test('设备时区不参与计算：UTC 里的深夜在上海已经是第二天', () => {
  // 2026-10-15T16:30Z === 2026-10-16 00:30（上海）→ 今天必须是 10-16，窗口 10-16..10-22。
  const analysis = analyzeDdlPressure({ tasks: [], referenceMinutes: null, now: new Date('2026-10-15T16:30:00Z') })
  assert.equal(analysis.windowStartDateKey, '2026-10-16')
  assert.equal(analysis.windowEndDateKey, '2026-10-22')
  assert.equal(analysis.windowEndExclusiveDateKey, '2026-10-23')
})

test('分组只看 deadline 自带 +08:00 偏移的那一侧', () => {
  // 同一时刻写成两种偏移：都是上海 2026-10-16 00:30。
  const analysis = run([
    task({ id: 1, deadline: '2026-10-16T00:30:00+08:00' }),
    task({ id: 2, deadline: '2026-10-15T16:30:00Z' }),
  ])
  assert.equal(dayOf(analysis, '2026-10-16').taskCount, 2)
  assert.equal(dayOf(analysis, '2026-10-15').taskCount, 0, '写 UTC 的那条不能被算到 10-15')
})

/* ------------------------------- 逾期边界 ------------------------------- */

test('今天更早时刻到期的任务算「已逾期」，并且不再计入今天', () => {
  const analysis = run([
    task({ id: 1, deadline: at('2026-10-15', '09:00') }),
    task({ id: 2, deadline: at('2026-10-15', '22:00') }),
  ])
  assert.deepEqual(analysis.overdue.map((entry) => entry.id), [1])
  assert.deepEqual(dayOf(analysis, '2026-10-15').tasks.map((entry) => entry.id), [2], '逾期的不能重复出现在今天')
  assert.equal(analysis.includedCount, 1)
  assert.equal(analysis.activeCount, 2, '活跃任务总数 = 逾期 + 窗口内')
})

test('DDL 恰好等于 now 算「今天到期」，不算已逾期', () => {
  const analysis = run([task({ id: 1, deadline: at('2026-10-15', '20:00') })])
  assert.equal(analysis.overdue.length, 0)
  assert.deepEqual(dayOf(analysis, '2026-10-15').tasks.map((entry) => entry.id), [1])
})

test('同一分钟内的先后也分得清：19:59 已逾期，20:00 未逾期', () => {
  const now = new Date('2026-10-15T20:00:30+08:00')
  assert.equal(classifyPressureTask(task({ deadline: at('2026-10-15', '20:00') }), now), 'overdue')
  const analysis = analyzeDdlPressure({
    tasks: [task({ id: 1, deadline: at('2026-10-15', '20:01') })],
    referenceMinutes: null,
    now,
  })
  assert.deepEqual(analysis.overdue.map((entry) => entry.id), [])
  assert.equal(dayOf(analysis, '2026-10-15').taskCount, 1)
})

test('只到日期的 DDL 当天内算今天，跨天才算逾期，且不会被当成脏数据', () => {
  const analysis = run([task({ id: 1, deadline: '2026-10-15' })])
  assert.equal(classifyPressureTask(task({ deadline: '2026-10-15' }), NOW), 'today')
  assert.deepEqual(analysis.overdue, [])
  assert.deepEqual(analysis.malformedDeadline, [])
  assert.deepEqual(dayOf(analysis, '2026-10-15').tasks.map((entry) => entry.id), [1])
  assert.equal(dayOf(analysis, '2026-10-15').earliestDeadline, '2026-10-15')

  const afterDay = new Date('2026-10-16T00:00:00+08:00')
  assert.equal(classifyPressureTask(task({ deadline: '2026-10-15' }), afterDay), 'overdue')
})

test('第 7 天在窗口内，第 8 天在窗口外（排他边界）', () => {
  const analysis = run([
    task({ id: 1, deadline: at('2026-10-21', '23:59') }),
    task({ id: 2, deadline: at('2026-10-22', '00:00') }),
  ])
  assert.deepEqual(dayOf(analysis, '2026-10-21').tasks.map((entry) => entry.id), [1])
  assert.deepEqual(analysis.beyondWindow.map((entry) => entry.id), [2])
  assert.equal(analysis.includedCount, 1)
  assert.equal(dayOf(analysis, '2026-10-21').taskCount, 1)
})

test('超过 7 天的任务只披露条数、不计入任何一天，也不会消失', () => {
  const analysis = run([
    task({ id: 1, deadline: at('2026-11-01', '12:00') }),
    task({ id: 2, deadline: at('2027-03-01', '12:00') }),
  ])
  assert.equal(analysis.includedCount, 0)
  assert.deepEqual(analysis.beyondWindow.map((entry) => entry.id), [1, 2])
  assert.equal(analysis.activeCount, 2)
})

/* --------------------------- 状态与脏数据 --------------------------- */

test('DONE / CANCELLED 被排除，DOING 计入（但不会被说成剩余工作量）', () => {
  const analysis = run([
    task({ id: 1, status: 'TODO', deadline: at('2026-10-16', '12:00'), estimatedMinutes: 60 }),
    task({ id: 2, status: 'DOING', deadline: at('2026-10-16', '12:00'), estimatedMinutes: 90 }),
    task({ id: 3, status: 'DONE', deadline: at('2026-10-16', '12:00'), estimatedMinutes: 120 }),
    task({ id: 4, status: 'CANCELLED', deadline: at('2026-10-16', '12:00'), estimatedMinutes: 30 }),
  ])
  const day = dayOf(analysis, '2026-10-16')
  assert.deepEqual(day.tasks.map((entry) => entry.id), [1, 2], '已完成 / 已取消不进入任何一天')
  assert.equal(day.taskCount, 2)
  assert.equal(day.knownMinutes, 150, 'DOING 的预计用时按全额计入（进度没有被测量）')
  assert.equal(analysis.excludedInactiveCount, 2)
  assert.equal(analysis.activeCount, 2)
})

test('没有 DDL 的进行中任务不进任何一天，单独列出', () => {
  const analysis = run([task({ id: 1, deadline: null }), task({ id: 2, deadline: '   ' })])
  assert.deepEqual(analysis.missingDeadline.map((entry) => entry.id), [1, 2])
  assert.equal(analysis.includedCount, 0)
  assert.equal(analysis.days.every((day) => day.taskCount === 0), true)
  assert.equal(analysis.hasDeadlineIssues, true)
})

test('无法解析的 DDL 归入「需要修复」，不会被猜成某一天', () => {
  const analysis = run([
    task({ id: 1, deadline: '2026-02-30T10:00:00+08:00' }),
    task({ id: 2, deadline: 'not-a-date' }),
    task({ id: 3, deadline: '2026-10-16' }),
  ])
  assert.deepEqual(analysis.malformedDeadline.map((entry) => entry.id), [1, 2])
  assert.equal(analysis.includedCount, 1, '只到日期的 10-16 是合法 DDL，不能被当成脏数据')
  assert.deepEqual(dayOf(analysis, '2026-10-16').tasks.map((entry) => entry.id), [3])
  assert.equal(analysis.overdue.length, 0)
  assert.equal(analysis.activeCount, 3, '脏数据任务不会凭空消失')
})

test('每一个进行中任务都恰好落进一个分类：合计等于活跃任务数', () => {
  const analysis = run([
    task({ id: 1, deadline: at('2026-10-14', '12:00') }),
    task({ id: 2, deadline: at('2026-10-15', '10:00') }),
    task({ id: 3, deadline: at('2026-10-15', '22:00') }),
    task({ id: 4, deadline: at('2026-10-18', '08:00') }),
    task({ id: 5, deadline: at('2026-10-30', '08:00') }),
    task({ id: 6, deadline: null }),
    task({ id: 7, deadline: 'oops' }),
  ])
  const sum =
    analysis.includedCount +
    analysis.overdue.length +
    analysis.missingDeadline.length +
    analysis.malformedDeadline.length +
    analysis.beyondWindow.length
  assert.equal(sum, analysis.activeCount)
  assert.equal(analysis.activeCount, 7)
  assert.equal(analysis.includedCount, 2, '只有 10-15 22:00 与 10-18 08:00 落在窗口内')
})

/* --------------------------- 预计用时与参考值 --------------------------- */

test('缺预计用时与「0 分钟」是两件事：0 合法、缺失只算未知', () => {
  const tasks = [
    task({ id: 1, estimatedMinutes: 30 }),
    task({ id: 2, estimatedMinutes: 0 }),
    task({ id: 3, estimatedMinutes: null }),
    task({ id: 4, estimatedMinutes: -45 }),
    task({ id: 5, estimatedMinutes: 12.5 }),
    task({ id: 6, estimatedMinutes: 100_000 }),
    task({ id: 7, estimatedMinutes: 100_001 }),
    task({ id: 8, estimatedMinutes: Number.NaN }),
    task({ id: 9, estimatedMinutes: '60' }),
  ]
  assert.equal(sumKnownMinutes(tasks), 100_030, '只有范围内的整数进合计（0 加 0）')
  assert.equal(countUnknownEstimates(tasks), 6, 'null / 负数 / 小数 / 越界 / NaN / 脏字符串算未知')
  assert.equal(Number.isFinite(sumKnownMinutes(tasks)), true, '绝不能出现 NaN')
  assert.equal(knownEstimateMinutesOf(tasks[1]), 0, '合法的 0 是「已填」，不是未知')
  assert.equal(knownEstimateMinutesOf(tasks[6]), null, '100001 超出任务表单范围，算未知')
})

test('预计用时为 0 的一天：算作已填、不算不完整', () => {
  const analysis = run([task({ id: 1, deadline: at('2026-10-16', '12:00'), estimatedMinutes: 0 })], 60)
  const day = dayOf(analysis, '2026-10-16')
  assert.equal(day.unknownEstimateCount, 0)
  assert.equal(day.knownMinutes, 0)
  assert.equal(day.status, 'within', '0 <= 60，且没有未知用时，所以是明确「未超过」')
})

test('一天的结论与文案口径：缺预计用时永远算「不完整」，绝不说足够', () => {
  const analysis = run(
    [
      task({ id: 1, deadline: at('2026-10-16', '12:00'), estimatedMinutes: 60 }),
      task({ id: 2, deadline: at('2026-10-16', '14:00'), estimatedMinutes: null }),
    ],
    300,
  )
  const day = dayOf(analysis, '2026-10-16')
  assert.equal(day.knownMinutes, 60)
  assert.equal(day.unknownEstimateCount, 1)
  assert.equal(day.status, 'incomplete')
  assert.equal(day.excessMinutes, 0)
})

test('参考用时未设置：状态是 unset，但仍然显示条数与合计', () => {
  const analysis = run([task({ id: 1, deadline: at('2026-10-16', '12:00'), estimatedMinutes: 60 })])
  const day = dayOf(analysis, '2026-10-16')
  assert.equal(day.status, 'unset')
  assert.equal(day.referenceMinutes, null)
  assert.equal(day.taskCount, 1)
  assert.equal(day.knownMinutes, 60)
  assert.equal(day.unknownEstimateCount, 0)
})

test('参考用时的三种比较：相等不算超标、超过给出差值、低于参考是 within', () => {
  assert.equal(
    pressureStatusOf({ taskCount: 2, knownMinutes: 120, unknownEstimateCount: 0, referenceMinutes: 120 }),
    'within',
    '相等不算超标',
  )
  assert.equal(
    pressureStatusOf({ taskCount: 2, knownMinutes: 121, unknownEstimateCount: 0, referenceMinutes: 120 }),
    'exceeds',
  )
  assert.equal(
    pressureStatusOf({ taskCount: 2, knownMinutes: 60, unknownEstimateCount: 0, referenceMinutes: 120 }),
    'within',
  )
  assert.equal(
    pressureStatusOf({ taskCount: 0, knownMinutes: 0, unknownEstimateCount: 0, referenceMinutes: 120 }),
    'empty',
    '没有任务时不说「未超过」，就是空',
  )
  assert.equal(
    pressureStatusOf({ taskCount: 1, knownMinutes: 999, unknownEstimateCount: 1, referenceMinutes: null }),
    'unset',
    '没有参考值时不比较（缺失事实另行披露）',
  )
})

test('超过参考用时：差值是真实数字，同时如实披露还有没填预计用时的任务', () => {
  const analysis = run(
    [
      task({ id: 1, deadline: at('2026-10-17', '12:00'), estimatedMinutes: 200 }),
      task({ id: 2, deadline: at('2026-10-17', '13:00'), estimatedMinutes: null }),
    ],
    120,
  )
  const day = dayOf(analysis, '2026-10-17')
  assert.equal(day.status, 'exceeds')
  assert.equal(day.excessMinutes, 80)
  assert.equal(day.unknownEstimateCount, 1, '超标也要披露不完整，不能只说「超了 80 分钟」')
})

test('脏参考值（负数 / 小数 / 超范围 / 字符串垃圾）一律当成未设置，不参与比较', () => {
  assert.equal(normalizeReferenceMinutes(-30), null)
  assert.equal(normalizeReferenceMinutes(30.5), null)
  assert.equal(normalizeReferenceMinutes(0), null)
  assert.equal(normalizeReferenceMinutes(1441), null)
  assert.equal(normalizeReferenceMinutes('abc'), null)
  assert.equal(normalizeReferenceMinutes(''), null)
  assert.equal(normalizeReferenceMinutes(480), 480)
  const analysis = run([task({ id: 1, deadline: at('2026-10-18', '12:00'), estimatedMinutes: 600 })], -5)
  assert.equal(dayOf(analysis, '2026-10-18').status, 'unset')
})

test('参考值不做类型强转：布尔 / 数组 / 对象 / 十六进制 / 指数写法都不是合法参考值', () => {
  for (const value of [true, false, [], [60], {}, '1e2', '0x20', '+60', '60.0']) {
    assert.equal(normalizeReferenceMinutes(value), null, `${JSON.stringify(value)} 不能被当成参考值`)
  }
  assert.equal(normalizeReferenceMinutes(60), 60, '数字 60 合法')
  assert.equal(normalizeReferenceMinutes('60'), 60, '十进制整数字符串 60 合法')
  assert.equal(normalizeReferenceMinutes(' 60 '), 60, '前后空白按用户输入的常态处理')
})

test('无法解析的 DDL（含不存在的时区偏移）一律归入「需要修复」，绝不算成已逾期', () => {
  const analysis = run([
    task({ id: 1, deadline: '2026-10-15T12:00:00+99:99' }),
    task({ id: 2, deadline: '2026-10-15T12:00:00+14:01' }),
    task({ id: 3, deadline: at('2026-10-15', '23:00') }),
    task({ id: 4, deadline: at('2026-10-14', '12:00') }),
  ])
  assert.deepEqual(analysis.malformedDeadline.map((entry) => entry.id), [1, 2])
  assert.deepEqual(analysis.overdue.map((entry) => entry.id), [4], '只有真正过去的合法 DDL 才算逾期')
  assert.equal(analysis.includedCount, 1)
})

test('毫秒也参与比较：同一秒内更晚的 DDL 不算逾期', () => {
  const nowMs = new Date('2026-10-15T20:00:00.250+08:00')
  assert.equal(
    classifyPressureTask(task({ deadline: '2026-10-15T20:00:00.500+08:00' }), nowMs),
    'today',
    '晚 250 毫秒仍是「今天到期」',
  )
  assert.equal(
    classifyPressureTask(task({ deadline: '2026-10-15T20:00:00.100+08:00' }), nowMs),
    'overdue',
    '早 150 毫秒就是已逾期',
  )
})

/* ------------------------------- 扎堆阈值 ------------------------------- */

test('扎堆阈值是 3：2 条标普通、3 条标扎堆，并且阈值本身可以被界面读到', () => {
  assert.equal(CONCENTRATION_THRESHOLD, 3)
  const two = run([
    task({ id: 1, deadline: at('2026-10-19', '09:00') }),
    task({ id: 2, deadline: at('2026-10-19', '10:00') }),
  ])
  assert.equal(dayOf(two, '2026-10-19').concentrated, false)
  const three = run([
    task({ id: 1, deadline: at('2026-10-19', '09:00') }),
    task({ id: 2, deadline: at('2026-10-19', '10:00') }),
    task({ id: 3, deadline: at('2026-10-19', '11:00') }),
  ])
  const day = dayOf(three, '2026-10-19')
  assert.equal(day.concentrated, true)
  assert.equal(day.concentrationThreshold, 3)
})

/* ------------------------------- 列表与合计 ------------------------------- */

test('每天的任务按截止时刻升序排列（同一时刻按 id 稳定）', () => {
  const analysis = run([
    task({ id: 9, deadline: at('2026-10-20', '18:00') }),
    task({ id: 3, deadline: at('2026-10-20', '08:00') }),
    task({ id: 7, deadline: at('2026-10-20', '08:00') }),
    task({ id: 1, deadline: at('2026-10-20', '12:00') }),
  ])
  const day = dayOf(analysis, '2026-10-20')
  assert.deepEqual(day.tasks.map((entry) => entry.id), [3, 7, 1, 9])
  assert.equal(day.earliestDeadline, at('2026-10-20', '08:00'))
  assert.equal(day.taskCount, 4)
  assert.equal(day.concentrated, true)
})

test('同一天混合已填与未填时，合计只是「已填部分」且最早 DDL 仍然正确', () => {
  const analysis = run(
    [
      task({ id: 1, deadline: at('2026-10-21', '09:00'), estimatedMinutes: 45 }),
      task({ id: 2, deadline: at('2026-10-21', '08:00'), estimatedMinutes: null }),
      task({ id: 3, deadline: at('2026-10-21', '10:00'), estimatedMinutes: 15 }),
    ],
    300,
  )
  const day = dayOf(analysis, '2026-10-21')
  assert.equal(day.knownMinutes, 60)
  assert.equal(day.unknownEstimateCount, 1)
  assert.equal(day.earliestDeadline, at('2026-10-21', '08:00'), '最早 DDL 与有没有填用时无关')
  assert.equal(day.status, 'incomplete')
})

test('空输入：7 天都是 empty，没有 NaN、没有负零', () => {
  const analysis = run([])
  assert.equal(analysis.includedCount, 0)
  assert.equal(analysis.overdue.length, 0)
  assert.equal(analysis.activeCount, 0)
  assert.equal(analysis.hasAnyTask, false)
  assert.equal(analysis.hasUnknownEstimates, false)
  assert.equal(analysis.hasDeadlineIssues, false)
  for (const day of analysis.days) {
    assert.equal(day.status, 'empty')
    assert.equal(day.knownMinutes, 0)
    assert.equal(Object.is(day.knownMinutes, -0), false)
    assert.equal(day.earliestDeadline, null)
    assert.deepEqual(day.tasks, [])
  }
})

test('窗口内合计与窗口内缺用时：跨天的数字要对得上', () => {
  const analysis = run(
    [
      task({ id: 1, deadline: at('2026-10-15', '21:00'), estimatedMinutes: 100 }),
      task({ id: 2, deadline: at('2026-10-17', '21:00'), estimatedMinutes: 50 }),
      task({ id: 3, deadline: at('2026-10-17', '22:00'), estimatedMinutes: null }),
      task({ id: 4, deadline: at('2026-10-25', '22:00'), estimatedMinutes: 999 }),
      task({ id: 5, status: 'DONE', deadline: at('2026-10-16', '22:00'), estimatedMinutes: 999 }),
    ],
    0,
  )
  assert.equal(analysis.includedCount, 3)
  assert.equal(analysis.includedKnownMinutes, 150)
  assert.equal(analysis.includedUnknownEstimateCount, 1)
  const totalPerDay = analysis.days.reduce((sum, day) => sum + day.knownMinutes, 0)
  assert.equal(totalPerDay, analysis.includedKnownMinutes)
  assert.equal(analysis.hasUnknownEstimates, true)
})

/* ------------------------------- 展示辅助 ------------------------------- */

test('分钟格式化：整点、带零头、非法值都不崩', () => {
  assert.equal(formatMinutes(0), '0 分钟')
  assert.equal(formatMinutes(45), '45 分钟')
  assert.equal(formatMinutes(60), '1 小时')
  assert.equal(formatMinutes(200), '3 小时 20 分钟')
  assert.equal(formatMinutes(Number.NaN), '0 分钟')
  assert.equal(formatMinutes(-10), '0 分钟')
})
