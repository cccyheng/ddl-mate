// 学习周报：页面状态机 / 翻周 / 筛选 / 分页的**真实回调**测试。
//
// 这些不是对着源码文本做的接线断言，而是直接调用屏幕会调用的那些函数：
// 上一周 / 下一周 / 回到本周 / 点数字 / 点日期 / 点课程 / 翻页。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeLearningReport } from '../src/domain/learningReport.ts'
import {
  clampLearningReportPage,
  clearLearningReportFilter,
  describeLearningReportFilter,
  formatLearningWeekRange,
  goToNextLearningWeek,
  goToPreviousLearningWeek,
  initialLearningReportScreenState,
  learningReportPageCount,
  learningWeekdayLabel,
  openLearningReportFilter,
  paginateLearningReportTasks,
  resolveLearningReportScreenView,
  returnToCurrentLearningWeek,
  setLearningReportPage,
} from '../src/screens/learningReportScreenState.ts'

const NOW = new Date('2026-10-15T20:00:00+08:00')
const NEXT_WEEK = new Date('2026-10-22T09:00:00+08:00')

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

function manyTasks(count) {
  return Array.from({ length: count }, (_, index) => task({ id: index + 1, title: `任务 ${index + 1}` }))
}

/* -------------------------------- 周导航 -------------------------------- */

test('初始状态显示当前上海周：上一周可用、下一周禁用', () => {
  const view = resolveLearningReportScreenView(initialLearningReportScreenState, NOW)
  assert.equal(view.selectedWeek.startDateKey, '2026-10-12')
  assert.equal(view.selectedWeek.endDateKey, '2026-10-18')
  assert.equal(view.isCurrentWeek, true)
  assert.equal(view.canGoPrevious, true)
  assert.equal(view.canGoNext, false, '不能翻到未来')
})

test('上一周记录绝对周一；再下一周回到当前周时清空锚点', () => {
  const previous = goToPreviousLearningWeek(initialLearningReportScreenState, NOW)
  assert.equal(previous.weekAnchor, '2026-10-05')
  assert.equal(previous.page, 1)
  const previousView = resolveLearningReportScreenView(previous, NOW)
  assert.equal(previousView.selectedWeek.startDateKey, '2026-10-05')
  assert.equal(previousView.isCurrentWeek, false)
  assert.equal(previousView.canGoNext, true)

  const backToNow = goToNextLearningWeek(previous, NOW)
  assert.equal(backToNow.weekAnchor, null, '回到当前周后恢复「跟随当前周」')
  assert.equal(resolveLearningReportScreenView(backToNow, NOW).isCurrentWeek, true)
})

test('当前周继续点下一周是 no-op（按钮 disabled，状态不漂移）', () => {
  const state = initialLearningReportScreenState
  assert.equal(goToNextLearningWeek(state, NOW), state)
  assert.equal(resolveLearningReportScreenView(state, NOW).canGoNext, false)
})

test('最多回看 52 周：更早的周被夹到最早周，上一周禁用', () => {
  let state = initialLearningReportScreenState
  for (let index = 0; index < 60; index += 1) {
    state = goToPreviousLearningWeek(state, NOW)
  }
  assert.equal(state.weekAnchor, '2025-10-20')
  const view = resolveLearningReportScreenView(state, NOW)
  assert.equal(view.earliestWeekStart, '2025-10-20')
  assert.equal(view.canGoPrevious, false)
  // 已经到边界后再点，不再改变状态。
  assert.equal(goToPreviousLearningWeek(state, NOW), state)
})

test('当前周跟随跨周前进；手动选中的过去周保持绝对锚点', () => {
  const sundayNight = new Date('2026-10-18T23:30:00+08:00')
  const mondayMorning = new Date('2026-10-19T00:10:00+08:00')
  const followingWeek = new Date('2026-10-26T09:00:00+08:00')

  // 未选过去周：跨周后自动显示新的一周。
  assert.equal(resolveLearningReportScreenView(initialLearningReportScreenState, sundayNight).selectedWeek.startDateKey, '2026-10-12')
  assert.equal(resolveLearningReportScreenView(initialLearningReportScreenState, mondayMorning).selectedWeek.startDateKey, '2026-10-19')
  assert.equal(resolveLearningReportScreenView(initialLearningReportScreenState, followingWeek).selectedWeek.startDateKey, '2026-10-26')

  // 手动选了 10-12 这一周：即使现在已经是下一周，显示的仍是 10-12。
  const manual = openLearningReportFilter(
    goToPreviousLearningWeek(initialLearningReportScreenState, sundayNight),
    { kind: 'due' },
  )
  assert.equal(manual.weekAnchor, '2026-10-05')
  assert.equal(manual.filter.kind, 'due')
  const laterView = resolveLearningReportScreenView(manual, followingWeek)
  assert.equal(laterView.selectedWeek.startDateKey, '2026-10-05', '过去周按绝对日期保留，不随 now 漂移')
  assert.equal(laterView.canGoNext, true)
  assert.equal(laterView.currentWeek.startDateKey, '2026-10-26')
})

test('显式回到本周：清空锚点、回到第 1 页，但保留当前筛选', () => {
  const past = { weekAnchor: '2026-09-28', filter: { kind: 'dueOpen' }, page: 3 }
  const current = returnToCurrentLearningWeek(past)
  assert.deepEqual(current, { weekAnchor: null, filter: { kind: 'dueOpen' }, page: 1 })
  assert.equal(returnToCurrentLearningWeek(current), current, '已经是本周且第 1 页时保持引用不变')
})

test('翻周保留筛选、重置分页；非法锚点安全夹到当前周', () => {
  const state = { weekAnchor: null, filter: { kind: 'overdue' }, page: 2 }
  const previous = goToPreviousLearningWeek(state, NOW)
  assert.deepEqual(previous.filter, { kind: 'overdue' }, '翻周不丢失用户选中的 cohort')
  assert.equal(previous.page, 1, '所选周变化必须重置分页')

  const invalid = resolveLearningReportScreenView({ weekAnchor: '2026-02-30', filter: null, page: 1 }, NOW)
  assert.equal(invalid.selectedWeek.startDateKey, '2026-10-12')

  const future = resolveLearningReportScreenView({ weekAnchor: '2026-11-02', filter: null, page: 1 }, NOW)
  assert.equal(future.selectedWeek.startDateKey, '2026-10-12', '未来锚点夹回当前周')
})

/* -------------------------------- 筛选与分页 -------------------------------- */

test('点数字 / 日期 / 课程都只替换筛选并把页码重置为 1', () => {
  const base = { weekAnchor: '2026-10-05', filter: null, page: 4 }
  assert.deepEqual(openLearningReportFilter(base, { kind: 'completedThisWeek' }), {
    weekAnchor: '2026-10-05',
    filter: { kind: 'completedThisWeek' },
    page: 1,
  })
  assert.deepEqual(openLearningReportFilter(base, { kind: 'completedDay', weekday: 3 }), {
    weekAnchor: '2026-10-05',
    filter: { kind: 'completedDay', weekday: 3 },
    page: 1,
  })
  assert.deepEqual(openLearningReportFilter(base, { kind: 'course', courseId: 7 }), {
    weekAnchor: '2026-10-05',
    filter: { kind: 'course', courseId: 7 },
    page: 1,
  })

  const filtered = openLearningReportFilter(base, { kind: 'due' })
  assert.deepEqual(clearLearningReportFilter(filtered), { weekAnchor: '2026-10-05', filter: null, page: 1 })
  assert.equal(clearLearningReportFilter({ weekAnchor: null, filter: null, page: 1 }).filter, null)
})

test('分页是有界渲染：20 条一页、夹住越界页码、空列表也有第 1 页', () => {
  const tasks = manyTasks(45)
  const first = paginateLearningReportTasks(tasks, 1)
  assert.equal(first.items.length, 20)
  assert.equal(first.page, 1)
  assert.equal(first.pageCount, 3)
  assert.equal(first.total, 45)
  assert.deepEqual(first.items[0], tasks[0])
  assert.deepEqual(first.items[19], tasks[19])

  const second = paginateLearningReportTasks(tasks, 2)
  assert.equal(second.items.length, 20)
  assert.deepEqual(second.items[0], tasks[20])

  const last = paginateLearningReportTasks(tasks, 3)
  assert.equal(last.items.length, 5)
  assert.deepEqual(last.items[4], tasks[44])

  assert.equal(paginateLearningReportTasks(tasks, 99).page, 3, '超过末页夹到末页')
  assert.equal(paginateLearningReportTasks(tasks, 0).page, 1)
  assert.equal(paginateLearningReportTasks(tasks, Number.NaN).page, 1)
  assert.equal(paginateLearningReportTasks([], 5).pageCount, 1, '空列表也显示第 1 / 1 页')
  assert.deepEqual(paginateLearningReportTasks([], 5).items, [])
  assert.equal(learningReportPageCount(0), 1)
  assert.equal(learningReportPageCount(20), 1)
  assert.equal(learningReportPageCount(21), 2)
  assert.equal(clampLearningReportPage(99, 45), 3)
  assert.equal(clampLearningReportPage(0, 45), 1)
})

test('翻页不改筛选 / 所选周；越界点击是 no-op', () => {
  const base = { weekAnchor: '2026-10-05', filter: { kind: 'due' }, page: 1 }
  const page2 = setLearningReportPage(base, 2, 45)
  assert.deepEqual(page2, { weekAnchor: '2026-10-05', filter: { kind: 'due' }, page: 2 })
  const page3 = setLearningReportPage(page2, 99, 45)
  assert.equal(page3.page, 3)
  assert.deepEqual(page3.filter, { kind: 'due' })
  assert.equal(setLearningReportPage(page3, 99, 45), page3)
})

test('后台刷新模拟：同一份状态在数据刷新 / now 前进后不被改写', () => {
  const state = { weekAnchor: '2026-10-05', filter: { kind: 'course', courseId: 1 }, page: 2 }
  const frozen = JSON.parse(JSON.stringify(state))
  // 刷新只会换数据源；屏幕状态对象与 now 的重新求值不能反过来改状态。
  resolveLearningReportScreenView(state, NEXT_WEEK)
  paginateLearningReportTasks(manyTasks(3), state.page)
  assert.deepEqual(state, frozen, '刷新 / 重新求值后所选周、筛选、页保持不变')
  const view = resolveLearningReportScreenView(state, NEXT_WEEK)
  assert.equal(view.selectedWeek.startDateKey, '2026-10-05')
})

/* ------------------------------- 明细文案 / 日期 ------------------------------- */

test('明细标题与说明随筛选变化，课程缺课程 / 同名不合并的文案清楚', () => {
  const now = NOW
  const view = resolveLearningReportScreenView(initialLearningReportScreenState, now)
  const analysis = analyzeLearningReport({
    tasks: [
      task({ id: 1, courseId: 1, status: 'DONE', deadline: '2026-10-13', completedAt: '2026-10-13T08:00:00+08:00' }),
      task({ id: 2, courseId: 2, deadline: '2026-10-13T09:00:00+08:00' }),
      task({ id: 3, courseId: 99, deadline: '2026-10-14' }),
    ],
    courses: [
      { id: 1, code: 'AUTO-1', name: '高数', instructor: null, semester: null, color: null, note: null, selectionSerial: null, createdAt: '2026-01-01T00:00:00+08:00', updatedAt: '2026-01-01T00:00:00+08:00' },
      { id: 2, code: 'AUTO-2', name: '高数', instructor: null, semester: null, color: null, note: null, selectionSerial: null, createdAt: '2026-01-01T00:00:00+08:00', updatedAt: '2026-01-01T00:00:00+08:00' },
    ],
    weekStartDateKey: '2026-10-12',
    now,
  })

  assert.match(describeLearningReportFilter({ kind: 'completedThisWeek' }, view, analysis).heading, /本周完成/)
  assert.match(describeLearningReportFilter({ kind: 'doneMissingCompletion' }, view, analysis).heading, /完成时间缺失/)
  assert.match(describeLearningReportFilter({ kind: 'due' }, view, analysis).heading, /本周到期/)
  assert.match(describeLearningReportFilter({ kind: 'overdue' }, view, analysis).heading, /已逾期/)
  assert.match(describeLearningReportFilter({ kind: 'completedDay', weekday: 2 }, view, analysis).heading, /周二/)
  assert.match(describeLearningReportFilter({ kind: 'course', courseId: 1 }, view, analysis).heading, /高数/)
  assert.match(describeLearningReportFilter({ kind: 'course', courseId: 99 }, view, analysis).heading, /课程已删除/)
  assert.match(describeLearningReportFilter({ kind: 'course', courseId: 777 }, view, analysis).heading, /这门课/)
  assert.match(describeLearningReportFilter({ kind: 'course', courseId: null }, view, analysis).heading, /未关联课程/)
  assert.match(describeLearningReportFilter({ kind: 'dueOpen' }, view, analysis).subtitle, /含已逾期 2 条/)
})

test('周范围与周几标签是稳定的短文案，非法周几不崩', () => {
  assert.equal(formatLearningWeekRange({ startDateKey: '2026-10-12', endDateKey: '2026-10-18' }), '10-12 ～ 10-18')
  assert.equal(formatLearningWeekRange({ startDateKey: '2025-12-29', endDateKey: '2026-01-04' }), '12-29 ～ 01-04')
  assert.equal(learningWeekdayLabel(1), '周一')
  assert.equal(learningWeekdayLabel(7), '周日')
  assert.equal(learningWeekdayLabel(0), '未知')
  assert.equal(learningWeekdayLabel(9), '未知')
})
