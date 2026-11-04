// 多天课表草稿的纯领域测试（**不测视觉样式**，只测行为契约）：
// - 每天独立的开始/结束时间与地点，切换/取消/重新勾选都不丢草稿；
// - 至少要保留一天；
// - 保存前逐天校验**所有已勾选的天**，并指出是哪一天、哪个字段；
// - 保存计划：原记录只在保留时更新、新天只新增、已有其它天的记录不被覆盖；
// - 界面上已移除的节次（period）在编辑既有数据时被原样带回，不抹掉历史字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMultidaySavePlan,
  createMultidayDraft,
  entryOf,
  multidayDraftFromSchedule,
  scheduleDraftForWeekday,
  scheduleDraftsForSelected,
  selectAllWeekdays,
  setActiveWeekday,
  toggleWeekday,
  updateActiveEntry,
  updateTerm,
  validateMultidayDraft,
  weekdayErrorKey,
  weekdayFieldErrorKey,
} from '../src/domain/scheduleMultidayDraft.ts'

/** 新建草稿并依次勾选若干天；返回勾选完的草稿。 */
function draftWithWeekdays(weekdays, term = {}) {
  let draft = createMultidayDraft({ weekday: weekdays[0] })
  for (const weekday of weekdays.slice(1)) {
    draft = toggleWeekday(draft, weekday).draft
  }
  if (Object.keys(term).length > 0) draft = updateTerm(draft, term)
  return draft
}

test('新建草稿默认只勾选一天，并且正在编辑那一天', () => {
  const draft = createMultidayDraft({ weekday: 3 })
  assert.deepEqual(draft.selectedWeekdays, [3])
  assert.equal(draft.activeWeekday, 3)
  assert.equal(entryOf(draft, 3).startTime, '08:00')
})

test('每一天各自保存时间与地点，切换正在编辑的星期不会丢草稿', () => {
  let draft = draftWithWeekdays([1, 3])
  assert.equal(draft.activeWeekday, 3, '最后勾选的一天成为正在编辑的一天')

  // 编辑周三
  draft = updateActiveEntry(draft, { startTime: '10:00', endTime: '11:40', location: '教三 305' })
  // 切到周一，填另一套值
  draft = setActiveWeekday(draft, 1)
  assert.equal(draft.activeWeekday, 1)
  draft = updateActiveEntry(draft, { startTime: '08:00', endTime: '09:40', location: '教二 101' })

  assert.equal(entryOf(draft, 1).location, '教二 101')
  assert.equal(entryOf(draft, 3).startTime, '10:00', '切走再切回来必须还是原来的草稿')
  assert.equal(entryOf(draft, 3).location, '教三 305')
})

test('取消勾选不删除草稿，重新勾选后原来的编辑还在', () => {
  let draft = draftWithWeekdays([1, 5])
  draft = updateActiveEntry(draft, { startTime: '14:00', endTime: '15:40', location: '实验楼 2-3' })

  const removed = toggleWeekday(draft, 5)
  assert.equal(removed.changed, true)
  assert.deepEqual(removed.draft.selectedWeekdays, [1])
  assert.equal(removed.draft.activeWeekday, 1, '取消正在编辑的那天后焦点落到剩余的一天')

  const restored = toggleWeekday(removed.draft, 5)
  assert.equal(entryOf(restored.draft, 5).startTime, '14:00')
  assert.equal(entryOf(restored.draft, 5).location, '实验楼 2-3')
})

test('取消最后一天被拒绝，而不是留下没有上课时间的草稿', () => {
  const draft = createMultidayDraft({ weekday: 2 })
  const result = toggleWeekday(draft, 2)
  assert.equal(result.changed, false)
  assert.equal(result.blockedReason, 'LAST_WEEKDAY')
  assert.deepEqual(result.draft.selectedWeekdays, [2], '被拒绝后草稿完全不变')
})

test('取消正在编辑的那一天时，焦点交给最近的剩余一天', () => {
  const draft = draftWithWeekdays([1, 3, 5, 7])
  const removed = toggleWeekday(setActiveWeekday(draft, 3), 3)
  assert.equal(removed.draft.activeWeekday, 5, '优先往后找最近的一天')
  const removedLast = toggleWeekday(setActiveWeekday(draft, 7), 7)
  assert.equal(removedLast.draft.activeWeekday, 5, '没有更后的天就往前找')
})

test('全选七天保留已填草稿，未勾选的天不能被激活', () => {
  let draft = draftWithWeekdays([2])
  draft = updateActiveEntry(draft, { startTime: '19:00', endTime: '20:40' })
  const all = selectAllWeekdays(draft)
  assert.deepEqual(all.selectedWeekdays, [1, 2, 3, 4, 5, 6, 7])
  assert.equal(entryOf(all, 2).startTime, '19:00', '全选不能覆盖已填过的天')

  const untouched = setActiveWeekday(all, 2)
  assert.equal(untouched, all, '已经是激活状态时不做无意义的改动')
  const guarded = setActiveWeekday(createMultidayDraft({ weekday: 4 }), 6)
  assert.equal(guarded.activeWeekday, 4, '未勾选的天不能被激活')
})

test('逐天校验：非当前编辑的星期出错也会被发现，并指出是哪一天哪个字段', () => {
  let draft = draftWithWeekdays([1, 3])
  // 正在编辑周三，把周三的结束时间填得比开始时间早
  draft = updateActiveEntry(draft, { startTime: '10:00', endTime: '09:00' })
  // 之后用户切到周一继续编辑，周三仍是勾选状态但不活跃
  draft = setActiveWeekday(draft, 1)

  const result = validateMultidayDraft(draft)
  assert.equal(result.ok, false)
  assert.equal(result.firstInvalidWeekday, 3, '界面要自动切到出错的那一天')
  assert.match(result.dayErrors[weekdayFieldErrorKey(3, 'endTime')], /结束时间必须晚于开始时间/)
  assert.equal(result.dayErrors[weekdayFieldErrorKey(1, 'endTime')], undefined, '合法的一天不能被牵连')
  assert.deepEqual(
    result.issues.map((issue) => [issue.weekday, issue.field]),
    [[3, 'endTime']],
  )
})

test('逐天校验：教学周这类共享字段只报一次，且不会误报成某一天的问题', () => {
  const draft = draftWithWeekdays([1, 4], { endWeek: '16' })
  const result = validateMultidayDraft(draft)
  assert.equal(result.ok, false)
  assert.match(result.sharedErrors.semesterStartDate, /学期第一周周一/)
  assert.equal(result.firstInvalidWeekday, null)
  assert.deepEqual(result.dayErrors, {})
})

test('逐天校验：全部合法时通过', () => {
  const draft = draftWithWeekdays([1, 4], {
    semesterStartDate: '2026-09-07',
    startWeek: '1',
    endWeek: '16',
  })
  const result = validateMultidayDraft(draft)
  assert.equal(result.ok, true)
  assert.equal(result.firstInvalidWeekday, null)
})

test('逐天校验：单周/双周在所选范围里没有可上课周次时拒绝，且不修改草稿', () => {
  const draft = draftWithWeekdays([1], {
    semesterStartDate: '2026-09-07',
    startWeek: '7',
    endWeek: '7',
    weekPattern: 'EVEN',
  })
  const before = JSON.parse(JSON.stringify(draft))

  const result = validateMultidayDraft(draft)
  assert.equal(result.ok, false)
  assert.match(result.sharedErrors.weekPattern, /没有双周的周次/)
  assert.equal(result.firstInvalidWeekday, null, '共享的教学周问题不切到某一天')
  assert.deepEqual(JSON.parse(JSON.stringify(draft)), before, '校验不能把用户选的第 7 周改成别的范围')
})

test('逐天校验：只选了一半的起止周 / 起始晚于结束都拒绝，不静默补全或交换', () => {
  const half = draftWithWeekdays([1], {
    semesterStartDate: '2026-09-07',
    startWeek: '3',
    endWeek: '',
    weekPattern: 'ALL',
  })
  const halfResult = validateMultidayDraft(half)
  assert.equal(halfResult.ok, false)
  assert.match(halfResult.sharedErrors.endWeek, /同时填写/)
  assert.equal(half.startWeek, '3')
  assert.equal(half.endWeek, '')

  const reversed = draftWithWeekdays([1], {
    semesterStartDate: '2026-09-07',
    startWeek: '8',
    endWeek: '3',
    weekPattern: 'ALL',
  })
  const reversedResult = validateMultidayDraft(reversed)
  assert.equal(reversedResult.ok, false)
  assert.match(reversedResult.sharedErrors.endWeek, /要求 1 ≤ 起始周 ≤ 结束周 ≤ 53/)
  assert.equal(reversed.startWeek, '8', '不能替用户交换或缩小范围')
  assert.equal(reversed.endWeek, '3')
})

test('编辑既有课表：起止周与单双周原样进入草稿，缺一项也保留原样', () => {
  const base = {
    id: 77,
    courseId: 7,
    weekday: 2,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: '9-16',
    semesterStartDate: '2026-09-07',
    startWeek: 9,
    endWeek: 16,
    weekPattern: 'ODD',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  }
  const draft = multidayDraftFromSchedule(base)
  assert.equal(draft.startWeek, '9')
  assert.equal(draft.endWeek, '16')
  assert.equal(draft.weekPattern, 'ODD')
  assert.equal(draft.semesterStartDate, '2026-09-07')

  const partial = multidayDraftFromSchedule({ ...base, startWeek: 9, endWeek: null, weekRange: null })
  assert.equal(partial.startWeek, '9')
  assert.equal(partial.endWeek, '', '缺失的一半保持为空，不补默认值')
  assert.equal(partial.weekPattern, 'ODD', '单双周不能被降级成 ALL')
})

test('保存计划（新建）：选中几天就生成几条独立草稿，按星期升序', () => {
  let draft = draftWithWeekdays([1, 3])
  draft = updateActiveEntry(draft, { startTime: '10:00', endTime: '11:40', location: '教三 305' })
  draft = setActiveWeekday(draft, 1)
  draft = updateActiveEntry(draft, { startTime: '08:00', endTime: '09:40', location: '教二 101' })

  const plan = buildMultidaySavePlan(draft, { original: null, occupiedWeekdays: [] })
  assert.deepEqual(plan.updates, [])
  assert.deepEqual(
    plan.creates.map((item) => [item.weekday, item.startTime, item.location]),
    [
      [1, '08:00', '教二 101'],
      [3, '10:00', '教三 305'],
    ],
  )
  assert.deepEqual(plan.duplicates, [])
  assert.equal(plan.untouchedOriginalScheduleId, null)
})

test('保存计划（编辑）：原记录只在保留时更新，新勾选的天只新增', () => {
  const original = { scheduleId: 42, weekday: 3 }
  let draft = multidayDraftFromSchedule({
    id: 42,
    courseId: 7,
    weekday: 3,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: 3,
    periodEnd: 4,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  })
  draft = toggleWeekday(draft, 1).draft
  draft = setActiveWeekday(draft, 1)
  draft = updateActiveEntry(draft, { startTime: '08:00', endTime: '09:40', location: '教二 101' })

  const plan = buildMultidaySavePlan(draft, { original, occupiedWeekdays: [5] })
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].scheduleId, 42, '只按原 id 更新，不会新建重复的周三')
  assert.equal(plan.updates[0].draft.weekday, 3)
  assert.equal(plan.updates[0].draft.periodStart, '3', '界面上移除的节次必须原样写回')
  assert.equal(plan.updates[0].draft.periodEnd, '4')
  assert.deepEqual(
    plan.duplicates,
    [],
    '旧口径的 occupiedWeekdays 不再用于拒绝任何一天（只保留兼容）',
  )
  assert.deepEqual(
    plan.creates.map((item) => item.weekday),
    [1],
  )
  assert.equal(plan.untouchedOriginalScheduleId, null)
})

test('保存计划（编辑）：同一天另一段时间不算重复，正常新增第二段课', () => {
  const original = { scheduleId: 42, weekday: 3 }
  let draft = multidayDraftFromSchedule({
    id: 42,
    courseId: 7,
    weekday: 3,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  })
  draft = toggleWeekday(draft, 5).draft
  draft = updateActiveEntry(draft, { startTime: '14:00', endTime: '15:40', location: '另一间教室' })

  const plan = buildMultidaySavePlan(draft, {
    original,
    existingSessions: [{ weekday: 5, startTime: '08:00', endTime: '09:40' }],
  })
  assert.deepEqual(plan.duplicates, [], '同一天的另一个时段不是重复')
  assert.deepEqual(
    plan.creates.map((item) => [item.weekday, item.startTime]),
    [[5, '14:00']],
    '第二段课必须被新增，而不是被当成冲突拒掉',
  )
  assert.equal(plan.updates.length, 1, '原周三仍然正常更新')
})

test('保存计划（编辑）：同一天同一时段才是重复，交给界面提示去编辑原来那条', () => {
  const original = { scheduleId: 42, weekday: 3 }
  let draft = multidayDraftFromSchedule({
    id: 42,
    courseId: 7,
    weekday: 3,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  })
  draft = toggleWeekday(draft, 5).draft
  draft = updateActiveEntry(draft, { startTime: '08:00', endTime: '09:40' })

  const plan = buildMultidaySavePlan(draft, {
    original,
    existingSessions: [{ weekday: 5, startTime: '08:00', endTime: '09:40' }],
  })
  assert.deepEqual(plan.duplicates, [5], '同一天同一时段才是重复')
  assert.deepEqual(plan.creates, [], '不能覆盖或重复插入完全一样的那一条')
  assert.equal(plan.updates.length, 1, '原周三仍然正常更新')
})

test('保存计划（编辑）：同一时段但单双周 / 周次范围不同的既有行不算重复', () => {
  const original = { scheduleId: 42, weekday: 3 }
  const base = {
    id: 42,
    courseId: 7,
    weekday: 3,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  }
  let draft = multidayDraftFromSchedule(base)
  draft = toggleWeekday(draft, 7).draft
  draft = updateActiveEntry(draft, { startTime: '08:00', endTime: '09:35' })
  draft = updateTerm(draft, { semesterStartDate: '2026-08-31', startWeek: '1', endWeek: '16', weekPattern: 'ODD' })

  const plan = buildMultidaySavePlan(draft, {
    original,
    existingSessions: [
      { weekday: 7, startTime: '08:00', endTime: '09:35', weekPattern: 'EVEN', semesterStartDate: '2026-08-31', startWeek: 1, endWeek: 16 },
    ],
  })
  assert.deepEqual(plan.duplicates, [], '单周与双周各一条是合法的两条')

  const planRange = buildMultidaySavePlan(draft, {
    original,
    existingSessions: [
      { weekday: 7, startTime: '08:00', endTime: '09:35', weekPattern: 'ODD', semesterStartDate: '2026-08-31', startWeek: 9, endWeek: 16 },
    ],
  })
  assert.deepEqual(planRange.duplicates, [], '第 1–8 周与第 9–16 周是合法的两条')
})

test('保存计划（编辑）：取消原记录所在的那一天时，原记录保持不动', () => {
  const original = { scheduleId: 42, weekday: 3 }
  let draft = multidayDraftFromSchedule({
    id: 42,
    courseId: 7,
    weekday: 3,
    startTime: '10:00',
    endTime: '11:40',
    location: '教三 305',
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-10-08T04:00:00.000Z',
    updatedAt: '2026-10-08T04:00:00.000Z',
  })
  // 只有周三被选中时不能取消；先加一天再把周三取消
  draft = toggleWeekday(draft, 1).draft
  draft = toggleWeekday(draft, 3).draft

  const plan = buildMultidaySavePlan(draft, { original, occupiedWeekdays: [] })
  assert.equal(plan.untouchedOriginalScheduleId, 42)
  assert.deepEqual(plan.updates, [], '不更新被取消的原记录')
  assert.deepEqual(
    plan.creates.map((item) => item.weekday),
    [1],
  )
})

test('摊平后的草稿与逐天草稿保持一致（星期、时间、地点、教学周）', () => {
  let draft = draftWithWeekdays([2, 6], {
    semesterStartDate: '2026-09-07',
    startWeek: '2',
    endWeek: '12',
    weekPattern: 'EVEN',
  })
  draft = setActiveWeekday(draft, 6)
  draft = updateActiveEntry(draft, { startTime: '15:00', endTime: '16:40', location: '体育馆' })

  const flattened = scheduleDraftsForSelected(draft)
  assert.deepEqual(
    flattened.map((item) => item.weekday),
    [2, 6],
  )
  assert.equal(flattened[1].location, '体育馆')
  assert.equal(flattened[1].weekPattern, 'EVEN')
  assert.equal(flattened[1].semesterStartDate, '2026-09-07')
  assert.deepEqual(scheduleDraftForWeekday(draft, 2), flattened[0])
})

test('冲突错误键与字段错误键使用同一套约定（供仓库层复用）', () => {
  assert.equal(weekdayErrorKey(3), 'weekday:3')
  assert.equal(weekdayFieldErrorKey(3, 'endTime'), 'day:3:endTime')
})
