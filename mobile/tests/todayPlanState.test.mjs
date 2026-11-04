/**
 * 今日学习计划 —— **状态机**测试（草稿 / 预览 / 已保存计划三份状态互不覆盖）。
 *
 * 覆盖授权书点名的状态行为：草稿在刷新与出错时保留、输入变化让预览作废、
 * 相关任务 / 课表变化让预览作废、跨零点拒绝旧预览、替换取消（不写）、
 * 提交失败时草稿保留且已保存计划不动、提交成功后的读回失败如实报告。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  addStudyWindow,
  applyCommitResult,
  applySavedPlanRead,
  commitFailureResult,
  emptyTodayPlanDraft,
  hasKnownTodaySavedRecord,
  initialTodayPlanState,
  isDraftDirty,
  mergePostCommitRead,
  previewStatus,
  removeStudyWindow,
  resetForNewDate,
  setSelectionMinutes,
  setStudyWindow,
  toggleTaskSelection,
  withDraft,
  withPreview,
  withSaving,
} from '../src/domain/todayPlanState.ts'
import { todayPlanFingerprint, validateStudyWindows, buildTodayPlan } from '../src/domain/todayPlan.ts'

const TZ = '2026-10-15'
const NOW = new Date('2026-10-15T02:00:30.000Z')

function task(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? '任务 1',
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

function fingerprintOf(draft, tasks = [task()], schedules = [], courses = []) {
  const validation = validateStudyWindows(draft.windows)
  if (!validation.ok) return null
  const selections = []
  for (const selection of draft.selections) {
    const minutes = Number(selection.minutes)
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return null
    selections.push({ taskId: selection.taskId, minutes })
  }
  return todayPlanFingerprint({ date: draft.date, windows: validation.windows, selections, context: { tasks, schedules, courses } })
}

/* --------------------------------- 草稿 --------------------------------- */

test('草稿编辑：加/删时段、选中/取消任务、改分钟数都不改原对象', () => {
  const base = emptyTodayPlanDraft(TZ)
  assert.equal(base.windows.length, 1)
  assert.equal(base.selections.length, 0, '不预选任何任务')

  const withWindow = addStudyWindow(base)
  assert.equal(withWindow.windows.length, 2)
  assert.equal(base.windows.length, 1, '原对象没变')

  const capped = addStudyWindow(addStudyWindow(addStudyWindow(addStudyWindow(withWindow))))
  assert.equal(capped.windows.length, 4, '最多 4 段')
  assert.equal(addStudyWindow(capped).windows.length, 4, '第 5 段被拒（不是静默加第 5 段）')

  const removed = removeStudyWindow(base, 0)
  assert.equal(removed.windows.length, 1, '至少留一行，界面不会变成空面板')

  const typed = setStudyWindow(base, 0, 'start', '08:00')
  assert.equal(typed.windows[0].start, '08:00')
  assert.equal(base.windows[0].start, '', '原对象没变')

  const selected = toggleTaskSelection(base, 7)
  assert.deepEqual(selected.selections, [{ taskId: 7, minutes: '' }], '选中时不替用户填分钟数')
  const unselected = toggleTaskSelection(selected, 7)
  assert.deepEqual(unselected.selections, [])

  const filled = setSelectionMinutes(selected, 7, '60')
  assert.equal(filled.selections[0].minutes, '60')
  assert.equal(selected.selections[0].minutes, '', '原对象没变')
})

/* ------------------------------- 预览作废 ------------------------------- */

test('预览：输入没变时可用；改分钟数 / 勾任务 / 任务内容变化都立刻作废', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const tasks = [task({ id: 1 })]
  const fingerprint = fingerprintOf(draft, tasks)
  const plan = buildTodayPlan({
    date: TZ,
    now: NOW,
    windows: draft.windows,
    selections: [{ taskId: 1, minutes: 60 }],
    tasks,
    schedules: [],
    courses: [],
  })
  const preview = { plan, fingerprint, generatedAtEpochMs: NOW.getTime() }

  assert.equal(previewStatus({ preview, draft, currentFingerprint: fingerprint, now: NOW }).stale, false)

  const edited = setSelectionMinutes(draft, 1, '61')
  const stale = previewStatus({ preview, draft: edited, currentFingerprint: fingerprintOf(edited, tasks), now: NOW })
  assert.equal(stale.stale, true)
  assert.equal(stale.reason, 'DIRTY')
  assert.match(stale.message, /重新生成/)

  const otherTask = toggleTaskSelection(draft, 2)
  assert.equal(
    previewStatus({ preview, draft: otherTask, currentFingerprint: fingerprintOf(otherTask, tasks), now: NOW }).stale,
    true,
  )

  const changedTask = [task({ id: 1, deadline: '2026-10-15T18:00:00+08:00' })]
  const contextStale = previewStatus({
    preview,
    draft,
    currentFingerprint: fingerprintOf(draft, changedTask),
    now: NOW,
  })
  assert.equal(contextStale.stale, true, '相关任务改了（例如加了 DDL）预览就作废')

  const addedCourse = fingerprintOf(draft, tasks, [], [{ id: 3, name: '新课程' }])
  assert.equal(previewStatus({ preview, draft, currentFingerprint: addedCourse, now: NOW }).stale, true)
})

test('预览：跨过上海零点后作废，并说明这是哪一天生成的', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const tasks = [task({ id: 1 })]
  const fingerprint = fingerprintOf(draft, tasks)
  const preview = {
    plan: buildTodayPlan({
      date: TZ,
      now: NOW,
      windows: draft.windows,
      selections: [{ taskId: 1, minutes: 60 }],
      tasks,
      schedules: [],
      courses: [],
    }),
    fingerprint,
    generatedAtEpochMs: NOW.getTime(),
  }
  const nextMorning = new Date('2026-10-15T16:30:00.000Z') // 上海 10-16 00:30
  const status = previewStatus({ preview, draft, currentFingerprint: fingerprint, now: nextMorning })
  assert.equal(status.stale, true)
  assert.equal(status.reason, 'DATE_CHANGED')
  assert.match(status.message, /2026-10-15/)
})

test('没有预览 / 输入非法（分钟数没填）：不能采用', () => {
  const draft = toggleTaskSelection(emptyTodayPlanDraft(TZ), 1)
  assert.equal(previewStatus({ preview: null, draft, currentFingerprint: null, now: NOW }).stale, true)
  assert.equal(
    previewStatus({ preview: null, draft, currentFingerprint: fingerprintOf(draft, [task({ id: 1 })]), now: NOW }).stale,
    true,
  )
})

/* ------------------------------ 脏与保存迁移 ------------------------------ */

test('脏判定：日期 + 时段原文 + 选中任务与分钟数，逐项比对基线', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 5), 5, '30')
  const matching = { date: TZ, windows: [{ start: '', end: '' }], selections: [{ taskId: 5, minutes: 30 }] }

  assert.equal(isDraftDirty(emptyTodayPlanDraft(TZ), null), false, '什么都没写 = 干净（没有基线也不算脏）')
  assert.equal(isDraftDirty(draft, null), true, '选了任务 = 脏')
  assert.equal(isDraftDirty(draft, matching), false, '与基线一致 = 干净')
  assert.equal(isDraftDirty(draft, { ...matching, selections: [{ taskId: 5, minutes: 31 }] }), true, '分钟数改了 = 脏')
  assert.equal(
    isDraftDirty(draft, { ...matching, selections: [{ taskId: 5, minutes: 30 }, { taskId: 6, minutes: 10 }] }),
    true,
    '多了一个选中任务 = 脏',
  )
  assert.equal(isDraftDirty(draft, { ...matching, date: '2026-10-16' }), true, '日期不同 = 脏')
  assert.equal(
    isDraftDirty(draft, { ...matching, windows: [{ start: '08:00', end: '09:00' }] }),
    true,
    '时段不同 = 脏',
  )
})

test('脏判定：只改了时段、还没选任务，也算「有未保存的输入」', () => {
  const blank = emptyTodayPlanDraft(TZ)
  const baseline = { date: TZ, windows: [{ start: '', end: '' }], selections: [] }
  assert.equal(isDraftDirty(blank, baseline), false, '空白草稿 = 干净')

  const windowOnly = setStudyWindow(blank, 0, 'start', '08:00')
  assert.equal(isDraftDirty(windowOnly, baseline), true, '只填了时段也必须算脏（离开时要问一句）')
  assert.equal(isDraftDirty(windowOnly, null), true, '没有基线时同样算脏')

  const both = setStudyWindow(setStudyWindow(blank, 0, 'start', '08:00'), 0, 'end', '09:00')
  assert.equal(isDraftDirty(both, baseline), true)
  assert.equal(
    isDraftDirty(both, { date: TZ, windows: [{ start: '08:00', end: '09:00' }], selections: [] }),
    false,
    '与基线一致 = 干净',
  )

  const twoWindows = addStudyWindow(blank)
  assert.equal(isDraftDirty(twoWindows, baseline), true, '多了一段（仍是空白）= 脏')
})

test('提交成功：草稿保留、预览作废、已保存计划与版本更新', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const before = { ...initialTodayPlanState(TZ), draft, preview: { plan: null, fingerprint: null, generatedAtEpochMs: 0 } }
  const saved = { date: TZ }
  const after = applyCommitResult(before, { ok: true, committed: true, revision: 3, reason: null, readbackError: null }, {
    readback: saved,
  })
  assert.equal(after.phase, 'saved')
  assert.equal(after.savedRevision, 3)
  assert.equal(after.savedPlan, saved)
  assert.deepEqual(after.draft, draft, '草稿一个字都没动')
  assert.equal(after.preview, null, '保存后预览作废（它已经不是最新输入）')
  assert.equal(after.notice.tone, 'success')
})

test('提交被拒（陈旧 / 冲突）：已保存计划与草稿都不动，只给原因', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const previousSaved = { date: TZ, marker: 'old' }
  const before = {
    ...initialTodayPlanState(TZ, previousSaved, 2),
    draft,
  }
  const after = applyCommitResult(before, {
    ok: false,
    committed: false,
    revision: null,
    reason: '别处已经保存过今天的计划。',
    readbackError: null,
  })
  assert.equal(after.savedPlan, previousSaved, '被拒时已保存计划一个字都不动')
  assert.equal(after.savedRevision, 2)
  assert.deepEqual(after.draft, draft)
  assert.equal(after.phase, 'rejected')
  assert.match(after.notice.text, /别处/)
})

test('提交成功但读回失败：保留「已提交」与版本号，并**清掉**旧内容，绝不冒充当前计划', () => {
  const previousSaved = { date: TZ, marker: 'old' }
  const before = { ...initialTodayPlanState(TZ, previousSaved, 2), draft: emptyTodayPlanDraft(TZ) }
  const after = applyCommitResult(
    before,
    { ok: true, committed: true, revision: 3, reason: null, readbackError: '数据库忙' },
    { readback: null },
  )
  assert.equal(after.committed, true, '「写进去了」这个事实不能被读回失败抹掉')
  assert.equal(after.savedRevision, 3, '版本号要更新，否则下一次保存会被自己挡住')
  assert.equal(after.phase, 'committedNoReadback')
  assert.equal(after.savedPlan, null, '上一版计划绝不能顶着新版本号显示成今天的计划')
  assert.match(after.notice.text, /已保存/)
  assert.match(after.notice.text, /数据库忙/)
  assert.equal(after.notice.tone, 'error')
  assert.equal(
    hasKnownTodaySavedRecord({ committed: after.committed, savedRevision: after.savedRevision, savedPlan: after.savedPlan, storedOtherDate: false }),
    true,
    '内容虽然没了，但「本机有今天的记录」这个事实还在 —— 替换仍然要确认',
  )
})

test('读回失败不清零已知版本号（乐观锁的依据），只清掉不可用的内容', () => {
  const previousSaved = { date: TZ, marker: 'old' }
  const before = initialTodayPlanState(TZ, previousSaved, 4)

  const unavailable = applySavedPlanRead(before, {
    ok: false,
    plan: null,
    revision: before.savedRevision,
    storedOtherDate: false,
    error: '记录读不出来',
  })
  assert.equal(unavailable.savedPlan, null, '不可用的内容要清掉')
  assert.equal(unavailable.savedRevision, 4, '已知版本号要保留')
  assert.equal(unavailable.committed, true, '确实保存过的事实要保留')

  const networkError = applySavedPlanRead(unavailable, {
    ok: false,
    plan: null,
    revision: unavailable.savedRevision,
    storedOtherDate: false,
    error: '读取失败',
  })
  assert.equal(networkError.savedRevision, 4, '连续失败也不会把版本号打回 0')

  // 以后又读到了（版本 5）：内容与版本号一起更新。
  const recovered = applySavedPlanRead(networkError, {
    ok: true,
    plan: { date: TZ, marker: 'new' },
    revision: 5,
    storedOtherDate: false,
    error: null,
  })
  assert.equal(recovered.savedRevision, 5)
  assert.equal(recovered.savedPlan.marker, 'new')
  assert.equal(recovered.committed, true)

  // 读回成功但读到的是别的一天的记录：不算今天的记录。
  const otherDay = applySavedPlanRead(before, {
    ok: true,
    plan: null,
    revision: 6,
    storedOtherDate: true,
    error: null,
  })
  assert.equal(
    hasKnownTodaySavedRecord({
      committed: otherDay.committed,
      savedRevision: otherDay.savedRevision,
      savedPlan: otherDay.savedPlan,
      storedOtherDate: true,
    }),
    false,
    '别的一天的记录不触发今天的替换确认',
  )
})

test('更旧的读回整条丢弃：绝不让旧内容配上已知的新版本号', () => {
  const newest = { date: TZ, marker: 'REVISION THREE' }
  const stale = { date: TZ, marker: 'REVISION TWO' }
  const state = initialTodayPlanState(TZ, newest, 3)

  const after = applySavedPlanRead(state, {
    ok: true,
    plan: stale,
    revision: 2,
    storedOtherDate: false,
    error: null,
  })
  assert.equal(after.savedRevision, 3, '版本号不回退')
  assert.deepEqual(after.savedPlan, newest, '旧内容不能覆盖新内容')
  assert.equal(after, state, '整条丢弃：状态对象都没变')

  // 同版本号的读回则按内容更新（内容与版本号来自同一次读回）。
  const sameRevision = applySavedPlanRead(state, {
    ok: true,
    plan: { date: TZ, marker: 'THREE-AGAIN' },
    revision: 3,
    storedOtherDate: false,
    error: null,
  })
  assert.equal(sameRevision.savedRevision, 3)
  assert.equal(sameRevision.savedPlan.marker, 'THREE-AGAIN')

  // 更新版本号：内容与版本号一起前进。
  const newer = applySavedPlanRead(state, {
    ok: true,
    plan: { date: TZ, marker: 'REVISION FOUR' },
    revision: 4,
    storedOtherDate: false,
    error: null,
  })
  assert.equal(newer.savedRevision, 4)
  assert.equal(newer.savedPlan.marker, 'REVISION FOUR')
})

test('提交成功后基线对齐：立刻变成「干净」，离开时不会再问一次', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const before = { ...initialTodayPlanState(TZ), draft }
  assert.equal(isDraftDirty(before.draft, before.baseline), true)
  const savedPlan = { date: TZ, marker: 'just-saved' }
  const after = applyCommitResult(
    before,
    { ok: true, committed: true, revision: 1, reason: null, readbackError: null },
    { readback: savedPlan },
  )
  assert.equal(after.phase, 'saved')
  assert.equal(after.savedPlan, savedPlan, '读回成功才显示刚保存的那一份')
  assert.equal(isDraftDirty(after.draft, after.baseline), false, '保存完就是干净的')
})

test('提交成功但这次没读回内容：不把「提交前的那份」当成刚保存的计划', () => {
  const oldPlan = { date: TZ, marker: 'OLD REVISION ONE' }
  const before = initialTodayPlanState(TZ, oldPlan, 1)
  const after = applyCommitResult(before, { ok: true, committed: true, revision: 2, reason: null, readbackError: null })
  assert.equal(after.committed, true)
  assert.equal(after.savedRevision, 2, '版本号要前进到刚提交的那一版')
  assert.equal(after.savedPlan, null, '旧内容不能顶着新版本号显示成刚保存的计划')
  assert.equal(after.phase, 'committedNoReadback')
})

test('提交成功 + 界面随后读回失败：也必须标成 committedNoReadback，绝不冒充 saved', () => {
  const previousSaved = { date: TZ, marker: 'old' }
  const commit = { ok: true, committed: true, revision: 5, reason: null, readbackError: null }

  // 仓库那一步读回了（readbackError 为 null），但界面这次读不到任何内容。
  const mergedMissing = mergePostCommitRead(commit, { discarded: false, plan: null, error: '本机读取失败', revision: null })
  assert.equal(mergedMissing.readbackError, '本机读取失败')
  const afterMissing = applyCommitResult({ ...initialTodayPlanState(TZ, previousSaved, 4) }, mergedMissing)
  assert.equal(afterMissing.committed, true)
  assert.equal(afterMissing.savedRevision, 5, '版本号要跟着提交走')
  assert.equal(afterMissing.phase, 'committedNoReadback')
  assert.equal(afterMissing.savedPlan, null, '旧的计划不能当成刚保存的那份')
  assert.match(afterMissing.notice.text, /本机读取失败/)

  // 版本号单调：界面读到的版本比本地提交更高时，取更高那个（不能出现「版本 5 配版本 6 的内容」）。
  const mergedNewer = mergePostCommitRead(commit, {
    discarded: false,
    plan: { date: TZ, marker: 'newer' },
    error: null,
    revision: 6,
  })
  assert.equal(mergedNewer.revision, 6)
  assert.equal(mergedNewer.readbackError, null)
  const afterNewer = applyCommitResult({ ...initialTodayPlanState(TZ) }, mergedNewer, {
    readback: { date: TZ, marker: 'newer' },
  })
  assert.equal(afterNewer.savedRevision, 6)
  assert.equal(afterNewer.savedPlan.marker, 'newer', '版本号与内容必须来自同一次读回')

  // 读回来的版本号更低（理论上不该发生）也不能把已知版本号改小。
  const mergedOlder = mergePostCommitRead({ ...commit, revision: 7 }, {
    discarded: false,
    plan: null,
    error: 'x',
    revision: 3,
  })
  assert.equal(mergedOlder.revision, 7)

  // 读回被更新的读回抢先（作废）：不在这里判失败，交给调用方保留更新的状态。
  const readDiscarded = { discarded: true, plan: null, error: null, revision: null }
  const mergedDiscarded = mergePostCommitRead(commit, readDiscarded)
  assert.equal(mergedDiscarded.readbackError, null, '抢先是「更新的一次读回在管」，不是失败')
  assert.equal(mergedDiscarded.committed, true)
  assert.equal(mergedDiscarded.revision, commit.revision, '作废的读回不带版本号，也不会改坏提交结论')

  // 读回了内容 → 正常 saved，不额外报错。
  const readbackPlan = { date: TZ, marker: 'new' }
  const mergedOk = mergePostCommitRead(commit, { discarded: false, plan: readbackPlan, error: null, revision: 5 })
  assert.equal(mergedOk.readbackError, null)
  const afterOk = applyCommitResult({ ...initialTodayPlanState(TZ) }, mergedOk, { readback: readbackPlan })
  assert.equal(afterOk.phase, 'saved')
  assert.equal(afterOk.savedPlan, readbackPlan)

  // 提交本身失败时，界面的读回与它无关，原样返回。
  const failed = { ok: false, committed: false, revision: null, reason: '被拒', readbackError: null }
  assert.equal(mergePostCommitRead(failed, { discarded: false, plan: null, error: 'x', revision: null }), failed)
  // 仓库自己已经报了读回错误时，不覆盖它。
  const alreadyReported = { ...commit, readbackError: '仓库读回失败' }
  assert.equal(
    mergePostCommitRead(alreadyReported, { discarded: false, plan: null, error: '界面读回失败', revision: null }).readbackError,
    '仓库读回失败',
  )
})

test('仓库抛异常：如实转述，不谎称「写进去了」', () => {
  const result = commitFailureResult(new Error('磁盘满了'))
  assert.equal(result.committed, false)
  assert.equal(result.ok, false)
  assert.match(result.reason, /磁盘满了/)
})

test('withDraft 保留草稿但清掉预览；withSaving 清掉上一次提示', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const preview = { plan: { date: TZ }, fingerprint: null, generatedAtEpochMs: 0 }
  const state = { ...initialTodayPlanState(TZ), preview, notice: { text: '旧提示', tone: 'success' } }
  const edited = withDraft(state, draft)
  assert.equal(edited.preview, null)
  assert.deepEqual(edited.draft, draft)
  const saving = withSaving(edited)
  assert.equal(saving.phase, 'saving')
  assert.equal(saving.notice, null)
})

test('跨零点：显式重置后草稿清空、已保存计划换成新的一天（昨天的不会被当成今天）', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const state = { ...initialTodayPlanState(TZ), draft, notice: { text: 'x', tone: 'success' } }
  const reset = resetForNewDate(state, '2026-10-16', null, 0)
  assert.equal(reset.draft.date, '2026-10-16')
  assert.equal(reset.draft.selections.length, 0, '昨天的选中任务不会带到今天')
  assert.equal(reset.draft.windows.every((window) => window.start === '' && window.end === ''), true)
  assert.equal(reset.savedPlan, null)
  assert.match(reset.notice.text, /2026-10-16/)
})

test('预览生成不改草稿（withPreview 只挂预览）', () => {
  const draft = setSelectionMinutes(toggleTaskSelection(emptyTodayPlanDraft(TZ), 1), 1, '60')
  const state = { ...initialTodayPlanState(TZ), draft }
  const next = withPreview(state, { plan: { date: TZ }, fingerprint: null, generatedAtEpochMs: 1 })
  assert.deepEqual(next.draft, draft)
  assert.equal(next.phase, 'idle')
})
