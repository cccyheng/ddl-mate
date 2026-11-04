// 原生时间助手：交互状态纯函数（过期建议守卫 + 只有显式采用才写草稿）。
//
// 这些断言对应授权书里 UI 一节最容易退化、也最难在真机上复现的规则：
// 上下文（短语 / 参考时间 / 课程 / 课表快照）或手工改过的截止时间一变，
// 已展示的建议必须立刻作废；采用时必须用最新输入再校验一次。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assistantContextKey,
  assistantView,
  canAdopt,
  candidateOf,
  initialAssistantState,
  isContextChanged,
  isDeadlineChanged,
  isSelectedCourseAvailable,
  isStale,
  prepareAdoption,
  resolveForState,
  stepAssistantState,
} from '../src/domain/timeAssistantState.ts'

const REFERENCE = '2026-10-13T12:00'
const COURSES = [
  { id: 1, name: '数据结构', code: 'CS201' },
  { id: 2, name: '高等数学', code: 'MA101' },
]
/** 真实「现在」固定成参考时间之前/之后都用得到的时刻（避免依赖机器时钟）。 */
const NOW_BEFORE = new Date('2026-10-15T07:00:00+08:00')
const NOW_AFTER = new Date('2026-10-15T09:00:00+08:00')
const SCHEDULES = [
  {
    id: 7,
    courseId: 1,
    weekday: 4,
    startTime: '08:00',
    endTime: '09:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: '2026-09-07',
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'ALL',
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
  },
]

function context(overrides = {}) {
  return {
    phrase: '下节课前',
    referenceWallClock: REFERENCE,
    courseId: 1,
    courses: COURSES,
    schedules: SCHEDULES,
    ...overrides,
  }
}

/** 走一遍「解析 → 得到建议」的完整流程（用的是真正的解析器，不是假结果）。 */
function resolvedState(overrides = {}, deadline = '') {
  const input = context(overrides)
  const { error, result } = resolveForState({ ...input, courses: input.courses })
  assert.equal(error, null, `解析不应报输入错误：${error}`)
  assert.ok(result, '解析必须给出结果')
  return { state: stepAssistantState(initialAssistantState, { type: 'resolve', result }, input, deadline), input }
}

/* ------------------------------ 初始状态 ------------------------------ */

test('初始状态：没有任何建议，不能采用', () => {
  const input = context()
  const view = assistantView(initialAssistantState, input, '')
  assert.equal(view.status, 'idle')
  assert.equal(view.candidate, null)
  assert.equal(view.canAdopt, false)
  assert.equal(view.stale, false)
  assert.equal(candidateOf(initialAssistantState), null)
})

/* ------------------------------ 解析与采用 ------------------------------ */

test('解析只产生建议，不写草稿；采用后才拿到要写入的时间', () => {
  const { state, input } = resolvedState({}, '')
  const view = assistantView(state, input, '')
  assert.equal(view.status, 'resolved')
  assert.equal(view.canAdopt, true)
  assert.equal(view.candidate.wallClock, '2026-10-15T08:00')
  // 解析本身没有改动截止时间（调用方传入的 deadline 仍然是空串）
  assert.equal(isDeadlineChanged(state, ''), false, '解析后草稿截止时间没有变化')

  const prepared = prepareAdoption(state, input, '')
  assert.equal(prepared.next.adopted, true)
  assert.equal(prepared.next.baselineDeadline, '2026-10-15T08:00')
  assert.equal(
    canAdopt(prepared.next, assistantContextKey(input), '2026-10-15T08:00'),
    false,
    '采用过就不能再点一次',
  )
})

test('采用必须用最新输入再校验：过期后采用不产生任何写入', () => {
  const { state, input } = resolvedState({}, '')
  const changed = { ...input, phrase: '明天 18:00' }
  // 组件用最新上下文算出来不能采用
  assert.equal(canAdopt(state, assistantContextKey(changed), ''), false)
  const afterAdopt = prepareAdoption(state, changed, '')
  assert.equal(afterAdopt.adoptedWallClock, null, '过期建议绝不能被采用')
  assert.equal(afterAdopt.next, state, '无效采用原样返回状态')
})

/* --------------------- 采用的纯结算（事件处理器用） --------------------- */

test('prepareAdoption 成功时返回下一个状态与要写入的时间（且是纯结算，不改原状态）', () => {
  const { state, input } = resolvedState({}, '')
  const before = JSON.stringify(state)

  const { next, adoptedWallClock } = prepareAdoption(state, input, '')
  assert.equal(adoptedWallClock, '2026-10-15T08:00', '只有真采纳成功才给出要写入的时间')
  assert.equal(next.adopted, true)
  assert.equal(next.baselineDeadline, '2026-10-15T08:00')
  assert.equal(JSON.stringify(state), before, '结算不得改动传入的状态对象')

  // 再点一次：已经是 adopted，结算返回原状态、不给写入时间（回调不会被调用第二次）
  const second = prepareAdoption(next, input, '2026-10-15T08:00')
  assert.equal(second.next, next, '无效采用必须原样返回同一个状态对象')
  assert.equal(second.adoptedWallClock, null)
})

test('prepareAdoption 在各种无效情况下都不给出写入时间', () => {
  const { state, input } = resolvedState({}, '')

  // 1) 上下文变了（短语 / 参考时间 / 课程）
  for (const changed of [
    { ...input, phrase: '明天 18:00' },
    { ...input, referenceWallClock: '2026-10-13T13:00' },
    { ...input, courseId: 2 },
  ]) {
    const prepared = prepareAdoption(state, changed, '')
    assert.equal(prepared.next, state)
    assert.equal(prepared.adoptedWallClock, null)
  }

  // 2) 选中的课被删除
  const deleted = { ...input, courses: COURSES.filter((course) => course.id !== 1) }
  assert.equal(prepareAdoption(state, deleted, '').adoptedWallClock, null)

  // 3) 手工改了截止时间
  assert.equal(prepareAdoption(state, input, '2026-10-20T09:00').adoptedWallClock, null)

  // 4) 还没有解析过
  assert.equal(prepareAdoption(initialAssistantState, input, '').adoptedWallClock, null)

  // 5) 课表在解析之后被改动：展示的候选与最新解析不一致 → 不采用（要求重新解析）
  const scheduleChanged = { ...input, schedules: [{ ...SCHEDULES[0], startTime: '09:00' }] }
  assert.equal(prepareAdoption(state, scheduleChanged, '').adoptedWallClock, null)

  // 6) 选中的课被改名（展示的候选里课程信息已过期）→ 同样不采用
  const renamed = { ...input, courses: [{ id: 1, name: '数据结构（新）', code: 'CS201' }, COURSES[1]] }
  assert.equal(prepareAdoption(state, renamed, '').adoptedWallClock, null)
})

test('采用路径只有一个入口：状态机不再接受 adopt 动作', () => {
  const { state, input } = resolvedState({}, '')
  // 传一个已经不在动作联合里的动作（运行时是未知分支）→ 状态原样返回，什么都不会写
  const unknown = stepAssistantState(state, { type: 'adopt' }, input, '')
  assert.equal(unknown, state, '未知动作必须原样返回，避免出现第二条写入路径')
  assert.equal(unknown.adopted, false)
})

/* ------------------------------ 过期守卫 ------------------------------ */

test('短语 / 参考时间 / 课程变化都让建议失效', () => {
  const { state, input } = resolvedState({}, '')
  const baselineKey = assistantContextKey(input)

  for (const changed of [
    { ...input, phrase: '明天 18:00' },
    { ...input, referenceWallClock: '2026-10-13T13:00' },
    { ...input, courseId: 2 },
  ]) {
    const key = assistantContextKey(changed)
    assert.notEqual(key, baselineKey, '上下文指纹必须变化')
    assert.equal(isContextChanged(state, key), true)
    assert.equal(isStale(state, key, ''), true)
    assert.equal(canAdopt(state, key, ''), false)
  }
})

test('课表快照变化（同一门课改了时间 / 加了课）同样让建议失效', () => {
  const { state, input } = resolvedState({}, '')

  const timeChanged = [{ ...SCHEDULES[0], startTime: '08:30' }]
  assert.equal(canAdopt(state, assistantContextKey({ ...input, schedules: timeChanged }), ''), false)

  const added = [...SCHEDULES, { ...SCHEDULES[0], id: 8, weekday: 5 }]
  assert.equal(canAdopt(state, assistantContextKey({ ...input, schedules: added }), ''), false)

  const removed = []
  assert.equal(canAdopt(state, assistantContextKey({ ...input, schedules: removed }), ''), false)

  // 内容完全相同的**新数组**（后台刷新常见）不应该让建议失效
  const refreshed = SCHEDULES.map((schedule) => ({ ...schedule }))
  assert.equal(assistantContextKey({ ...input, schedules: refreshed }), assistantContextKey(input))
  assert.equal(canAdopt(state, assistantContextKey({ ...input, schedules: refreshed }), '', input), true)
})

test('课程快照变化（选中的课被删除 / 改名 / 换编号）让建议失效且不能采用', () => {
  const { state, input } = resolvedState({}, '')
  const baseline = assistantContextKey(input)

  // 选中的课被删除
  const deleted = { ...input, courses: COURSES.filter((course) => course.id !== 1) }
  assert.notEqual(assistantContextKey(deleted), baseline, '课程快照必须进入上下文指纹')
  assert.equal(isSelectedCourseAvailable(deleted), false)
  assert.equal(canAdopt(state, assistantContextKey(deleted), '', deleted), false)
  const afterAdopt = prepareAdoption(state, deleted, '')
  assert.equal(afterAdopt.adoptedWallClock, null, '选中的课不存在时绝不写入')
  assert.equal(afterAdopt.next, state)

  // 选中的课改名
  const renamed = { ...input, courses: [{ id: 1, name: '数据结构（改）', code: 'CS201' }, COURSES[1]] }
  assert.notEqual(assistantContextKey(renamed), baseline)

  // 课程列表内容相同的新数组不会误判
  const refreshed = COURSES.map((course) => ({ ...course }))
  assert.equal(assistantContextKey({ ...input, courses: refreshed }), baseline)
  assert.equal(isSelectedCourseAvailable({ ...input, courses: refreshed }), true)
})

test('「这个时间已经过去了」按真实当前时刻判断，与参考时间无关', () => {
  const { state, input } = resolvedState({}, '')
  // 建议是 2026-10-15 08:00：现在 07:00 还没到，现在 09:00 已经过去了
  assert.equal(assistantView(state, input, '', NOW_BEFORE).alreadyElapsed, false)
  assert.equal(assistantView(state, input, '', NOW_AFTER).alreadyElapsed, true)
  // 提示并不改变候选时间本身
  assert.equal(assistantView(state, input, '', NOW_AFTER).candidate.wallClock, '2026-10-15T08:00')
})

test('手工改截止时间让建议失效，且手工值必须保留', () => {
  const { state, input } = resolvedState({}, '2026-10-14T21:00')
  const key = assistantContextKey(input)
  assert.equal(canAdopt(state, key, '2026-10-14T21:00'), true)

  // 用户把截止时间手改成别的时间
  assert.equal(isDeadlineChanged(state, '2026-10-20T09:00'), true)
  assert.equal(isStale(state, key, '2026-10-20T09:00'), true)
  assert.equal(canAdopt(state, key, '2026-10-20T09:00'), false)
  const afterAdopt = prepareAdoption(state, input, '2026-10-20T09:00')
  assert.equal(afterAdopt.adoptedWallClock, null, '手工值不会被过期建议覆盖')
  assert.equal(afterAdopt.next, state)
  assert.equal(state.baselineDeadline, '2026-10-14T21:00', '基线仍然是展示建议时的值')

  // 改回原值时建议重新可用（上下文没变，允许采用）
  assert.equal(canAdopt(state, key, '2026-10-14T21:00'), true)
})

test('采用之后再手工改时间：不得被建议覆盖，且建议自动作废', () => {
  const { state, input } = resolvedState({}, '')
  const key = assistantContextKey(input)
  const adopted = prepareAdoption(state, input, '').next
  assert.equal(adopted.adopted, true)

  const manual = '2026-10-18T23:30'
  const view = assistantView(adopted, input, manual)
  assert.equal(view.stale, true)
  assert.equal(view.canAdopt, false, '已经采用过 / 已手改，都不能再写一次')
  assert.equal(canAdopt(adopted, key, manual), false)
})

test('无效输入给出可见校验，且不覆盖已展示的建议', () => {
  const { state, input } = resolvedState({}, '')
  assert.equal(state.resolution !== null, true)

  const empty = { ...input, phrase: '   ' }
  const { error, result } = resolveForState({ ...empty, courses: COURSES })
  assert.match(error, /请先写/)
  assert.equal(result, null)

  const invalid = stepAssistantState(state, { type: 'invalid', error }, empty, '')
  assert.equal(invalid.requestStatus, 'invalid')
  assert.equal(invalid.resolution, null, '输入不合法时不保留旧建议')
  assert.equal(invalid.requestError, error)
  assert.equal(candidateOf(invalid), null)
  assert.equal(canAdopt(invalid, assistantContextKey(empty), ''), false)
})

test('clear 回到初始状态（换任务 / 关闭面板时使用）', () => {
  const { state, input } = resolvedState({}, '')
  const cleared = stepAssistantState(state, { type: 'clear' }, input, '')
  assert.deepEqual(cleared, initialAssistantState)
})

/* ------------------------------ 解析入口 ------------------------------ */

test('resolveForState 对空短语 / 空参考时间 / 非法参考时间给出错误而不是假结果', () => {
  const emptyPhrase = resolveForState({ ...context({ phrase: '' }), courses: COURSES })
  assert.match(emptyPhrase.error, /请先写/)
  assert.equal(emptyPhrase.result, null)

  // 用户清空参考时间：必须如实报错，绝不偷偷换回「现在」
  const emptyReference = resolveForState({ ...context({ referenceWallClock: '' }), courses: COURSES })
  assert.match(emptyReference.error, /不能为空/)
  assert.equal(emptyReference.result, null)

  const blankReference = resolveForState({ ...context({ referenceWallClock: '   ' }), courses: COURSES })
  assert.match(blankReference.error, /不能为空/)

  const badReference = resolveForState({
    ...context({ referenceWallClock: '不是时间' }),
    courses: COURSES,
  })
  assert.match(badReference.error, /参考时间/)
  assert.equal(badReference.result, null)
})

test('选中的课不存在 / 课程列表缺失时，课程类短语不产出候选', () => {
  const deleted = resolveForState({
    ...context(),
    courseId: 999,
    courses: COURSES,
  })
  assert.equal(deleted.error, null)
  assert.equal(deleted.result.status, 'NEEDS_INFO')
  assert.equal(deleted.result.candidates.length, 0)
  assert.match(deleted.result.message, /找不到了/)

  // 解析层在完全没有课程快照时也必须拒绝，而不是用一个空壳课程名继续算
  const withoutCourses = { ...context() }
  delete withoutCourses.courses
  const missingList = resolveForState(withoutCourses)
  assert.equal(missingList.error, null)
  assert.equal(missingList.result.status, 'NEEDS_INFO')
  assert.equal(missingList.result.candidates.length, 0)
})

test('resolveForState 保留解析器给出的「需要补全 / 不支持」结论（不是错误）', () => {
  const needsInfo = resolveForState({ ...context({ phrase: '明天' }), courses: COURSES })
  assert.equal(needsInfo.error, null)
  assert.equal(needsInfo.result.status, 'NEEDS_INFO')
  assert.match(needsInfo.result.message, /没有具体时刻/)

  const unsupported = resolveForState({ ...context({ phrase: '取消明天的作业' }), courses: COURSES })
  assert.equal(unsupported.error, null)
  assert.equal(unsupported.result.status, 'UNSUPPORTED')
})

test('候选里的信息足以展示地点 / 日期 / 课程 / 过去提醒', () => {
  const { state, input } = resolvedState({}, '')
  const candidate = assistantView(state, input, '').candidate
  assert.equal(candidate.courseName, '数据结构')
  assert.equal(candidate.scheduleDate, '2026-10-15')
  assert.equal(candidate.scheduleLocation, '教三 305')
  assert.equal(candidate.past, false)
  assert.match(candidate.label, /2026-10-15 08:00 周四/)

  const past = resolvedState({ phrase: '今天 08:00' }, '')
  const pastCandidate = assistantView(past.state, past.input, '').candidate
  assert.equal(pastCandidate.past, true)
})
