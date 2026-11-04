/**
 * 任务步骤清单 —— **界面状态机**测试（纯函数，无 React / 无数据库）。
 *
 * 覆盖复核点名的行为（不是「照抄实现」）：
 * 1. 初次加载 / 干净刷新会铺草稿；**脏草稿（哪怕被清空成 0 步）刷新后一个字都不变**；
 * 2. 脏草稿遇到更新版本时，`draftBaseRevision` 保持草稿原来那一版 ——
 *    保存绝不会拿后台读到的新版本号去覆盖用户从没看过的内容；
 * 3. 读回失败 / 冲突被拒都保留草稿；提交后的读回失败保留「已提交 + 版本号」；
 * 4. 显式「载入最新（丢弃草稿）」才会整份替换草稿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_TASK_STEPS } from '../src/domain/taskSteps.ts'
import {
  addStep,
  applyCommitResult,
  applySavedStepsRead,
  clearSteps,
  commitFailureResult,
  createTaskStepsState,
  draftFromSteps,
  draftIssues,
  isDraftDirty,
  needsClearConfirm,
  needsRemoveConfirm,
  progressText,
  removeStep,
  setStepTitle,
  toggleStepDone,
  withSaving,
} from '../src/screens/taskStepsState.ts'

const step = (id, title, done = false) => ({ id, title, done })

/** 用一次成功的读取把状态铺成「已加载 rev `revision` 的 `steps`」。 */
function loaded(steps, revision = 1) {
  return applySavedStepsRead(createTaskStepsState(), { ok: true, steps, revision, error: null })
}

const readOk = (steps, revision) => ({ ok: true, steps, revision, error: null })
const readFail = (error, code = 'READ_FAILED') => ({ ok: false, steps: [], revision: 0, error, code })

/* -------------------------------- 初始加载 -------------------------------- */

test('初始加载：草稿 / 基线 / 草稿基版本一起铺好，之后才允许编辑', () => {
  const before = createTaskStepsState()
  assert.equal(before.loaded, false, '还没读到之前不能编辑')

  const after = loaded([step('a', 'A'), step('b', 'B', true)], 3)
  assert.equal(after.loaded, true)
  assert.deepEqual(after.draft, [step('a', 'A'), step('b', 'B', true)])
  assert.equal(after.baseline.revision, 3)
  assert.equal(after.draftBaseRevision, 3)
  assert.equal(after.latestRevision, 3)
  assert.equal(after.readError, null)
  assert.equal(isDraftDirty(after.draft, after.baseline), false, '刚加载完是干净的')
})

test('干净刷新（没有未保存改动）：草稿跟着库里的新内容走', () => {
  const base = loaded([step('a', 'A')], 1)
  const next = applySavedStepsRead(base, readOk([step('a', 'A2'), step('b', 'B')], 2))
  assert.deepEqual(next.draft, [step('a', 'A2'), step('b', 'B')])
  assert.equal(next.draftBaseRevision, 2)
  assert.equal(next.latestRevision, 2)
})

/* ------------------------------ 脏草稿不被覆盖 ------------------------------ */

test('脏草稿 + 同版本刷新（包括被清空成 0 步）：草稿一个字都不变', () => {
  const base = loaded([step('a', 'A')], 1)
  // 用户把唯一一步删掉 → 草稿是「有意为之的空」，仍然是脏的。
  const cleared = clearSteps(base)
  assert.deepEqual(cleared.draft, [])
  assert.equal(isDraftDirty(cleared.draft, cleared.baseline), true)
  assert.equal(cleared.draftBaseRevision, 1)

  const refreshed = applySavedStepsRead(cleared, readOk([step('a', 'A')], 1))
  assert.deepEqual(refreshed.draft, [], '刷新绝不能把已保存的步骤又塞回空草稿')
  assert.equal(isDraftDirty(refreshed.draft, refreshed.baseline), true)
})

test('脏草稿 + 更新版本：保留草稿与草稿基版本，只立冲突标记（回归：不能拿新版号覆盖）', () => {
  const base = loaded([step('a', '原内容')], 1)
  const edited = setStepTitle(base, 'a', '我改过的内容')
  assert.equal(edited.draftBaseRevision, 1)

  // 另一个实例保存了版本 2，本页聚焦时读到了。
  const refreshed = applySavedStepsRead(edited, readOk([step('a', '别处的内容')], 2))
  assert.deepEqual(refreshed.draft, [step('a', '我改过的内容')], '草稿必须原样保留')
  assert.equal(refreshed.baseline.revision, 1, '基线仍然是草稿当初基于的那一版')
  assert.equal(refreshed.draftBaseRevision, 1, '保存只能用这个版本号（回归点）')
  assert.equal(refreshed.latestRevision, 2, '最新版本单独记录')
  assert.equal(refreshed.conflict, true, '必须立起冲突标记')
  assert.notEqual(refreshed.draftBaseRevision, refreshed.latestRevision)
})

test('冲突被拒：草稿与基版本都不动，冲突标记保留（重试一次也不会悄悄覆盖）', () => {
  const base = loaded([step('a', 'A')], 1)
  const edited = setStepTitle(base, 'a', '我的改动')
  const rejected = applyCommitResult(edited, {
    ok: false,
    committed: false,
    revision: 2,
    reason: '别处已经保存过这条任务的步骤，请先刷新看看最新版本，再决定要不要覆盖。',
    readbackError: null,
  })
  assert.equal(rejected.phase, 'rejected')
  assert.equal(rejected.conflict, true)
  assert.deepEqual(rejected.draft, edited.draft)
  assert.equal(rejected.draftBaseRevision, 1)
  assert.equal(rejected.latestRevision, 2)
  assert.match(rejected.notice.text, /别处已经保存过/)
})

test('冲突的显式出路：force 载入最新版本才会替换草稿并清除标记', () => {
  const base = loaded([step('a', 'A')], 1)
  const edited = setStepTitle(base, 'a', '我的改动')
  const conflicted = applySavedStepsRead(edited, readOk([step('a', '别处的')], 2))
  assert.equal(conflicted.conflict, true)

  const reloaded = applySavedStepsRead(conflicted, readOk([step('a', '别处的')], 2), { force: true })
  assert.deepEqual(reloaded.draft, [step('a', '别处的')], '用户确认后草稿被整份替换')
  assert.equal(reloaded.draftBaseRevision, 2)
  assert.equal(reloaded.conflict, false)
  assert.equal(isDraftDirty(reloaded.draft, reloaded.baseline), false)
})

/* --------------------------------- 草稿编辑 --------------------------------- */

test('草稿操作：添加 / 改标题 / 勾选 / 删除都不改原对象，也不改基线', () => {
  const base = loaded([step('a', '看例题')], 1)
  const added = addStep(base, 'b', '做题')
  assert.equal(base.draft.length, 1, '原状态一个字都没被改')
  assert.deepEqual(added.draft, [step('a', '看例题'), step('b', '做题')])

  const renamed = setStepTitle(added, 'a', '看完第 3 章例题')
  assert.deepEqual(added.draft, [step('a', '看例题'), step('b', '做题')], '改标题不改原对象')
  assert.deepEqual(renamed.draft, [step('a', '看完第 3 章例题'), step('b', '做题')])

  const toggled = toggleStepDone(renamed, 'a')
  assert.equal(toggled.draft[0].done, true)
  assert.equal(renamed.draft[0].done, false)

  const removed = removeStep(toggled, 'a')
  assert.deepEqual(removed.draft, [step('b', '做题')])
  assert.equal(toggled.draft.length, 2, '删除不改原对象')

  // 输入封顶 120 字，但不 trim（用户还在打字，光标不能跳）。
  const long = setStepTitle(base, 'a', 'x'.repeat(200))
  assert.equal(long.draft[0].title.length, 120)
})

test('条数上限：到 30 步之后不再添加（不静默丢弃已有步骤）', () => {
  let state = createTaskStepsState()
  for (let index = 0; index < MAX_TASK_STEPS + 5; index += 1) {
    state = addStep(state, `s${index}`, `第 ${index} 步`)
  }
  assert.equal(state.draft.length, MAX_TASK_STEPS)
})

/* ---------------------------------- 校验 ---------------------------------- */

test('校验：空标题与超长标题挂在对应行上，条数超限 / 重复编号给整体提示', () => {
  const blank = draftIssues([step('a', ''), step('b', '正常')])
  assert.equal(blank.ok, false)
  assert.match(blank.fieldErrors.get('a'), /没有写内容/)
  assert.equal(blank.fieldErrors.has('b'), false)

  const long = draftIssues([step('a', 'x'.repeat(121))])
  assert.match(long.fieldErrors.get('a'), /120/)

  const tooMany = draftIssues(
    Array.from({ length: MAX_TASK_STEPS + 1 }, (_, index) => step(`s${index}`, `第 ${index} 步`)),
  )
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.formErrors.some((message) => /最多只能有/.test(message)))

  const duplicate = draftIssues([step('same', 'A'), step('same', 'B')])
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.formErrors.some((message) => /重复/.test(message)))

  assert.equal(draftIssues([step('a', '  看书  ')]).ok, true, '首尾空白不算问题（保存时会去掉）')
})

/* --------------------------------- 脏判定 --------------------------------- */

test('脏判定：与基线逐条比对（内容 / 勾选 / 条数 / 顺序）', () => {
  const baseline = { steps: [step('a', 'A'), step('b', 'B')], revision: 2 }
  assert.equal(isDraftDirty(draftFromSteps(baseline.steps), baseline), false)
  assert.equal(isDraftDirty(draftFromSteps([step('a', 'A'), step('b', 'B改了')]), baseline), true)
  assert.equal(isDraftDirty(draftFromSteps([step('a', 'A'), step('b', 'B', true)]), baseline), true, '勾选也算改动')
  assert.equal(isDraftDirty(draftFromSteps([step('a', 'A')]), baseline), true)
  assert.equal(isDraftDirty(draftFromSteps([step('b', 'B'), step('a', 'A')]), baseline), true, '顺序变了')
  assert.equal(isDraftDirty(draftFromSteps([step('a', ' A '), step('b', 'B')]), baseline), false, '只多空白不算改动')
  assert.equal(isDraftDirty(draftFromSteps([]), null), false)
  assert.equal(isDraftDirty(draftFromSteps([step('a', 'A')]), null), true)
})

test('确认规则：删除有内容 / 已勾选的步骤要问；把已保存清单清空要问', () => {
  assert.equal(needsRemoveConfirm(step('a', '有内容')), true)
  assert.equal(needsRemoveConfirm(step('a', '   ')), false, '完全空白的一行可以直接删')
  assert.equal(needsRemoveConfirm(step('a', '', true)), true, '勾过的即使没写内容也要问')

  const saved = loaded([step('a', 'A')], 1)
  const cleared = clearSteps(saved)
  assert.equal(needsClearConfirm(cleared), true, '保存过内容再清空 = 显式清除，必须确认')
  assert.equal(needsClearConfirm(saved), false, '草稿里还有内容就不算清空')
  assert.equal(needsClearConfirm(createTaskStepsState()), false, '本来就没保存过，不需要确认')
  assert.equal(needsClearConfirm(loaded([], 1)), false, '已保存的就是空清单时，也不需要确认')
})

/* ------------------------------- 读取失败 ------------------------------- */

test('读失败：只记原因与类别，草稿 / 基线 / 两个版本号一个字都不动', () => {
  const base = loaded([step('a', '已保存')], 4)
  const edited = setStepTitle(base, 'a', '正在写的')
  const failed = applySavedStepsRead(edited, readFail('本机保存的步骤清单读不出来（格式或版本不认识）。', 'CORRUPT'))
  assert.match(failed.readError, /读不出来/)
  assert.equal(failed.readErrorCode, 'CORRUPT')
  assert.deepEqual(failed.draft, edited.draft, '草稿必须原样保留')
  assert.equal(failed.draftBaseRevision, 4)
  assert.equal(failed.latestRevision, 4)
  assert.equal(failed.committed, base.committed)
})

test('父任务不存在也是读取失败的一种：草稿保留，界面据此显示「任务不在」', () => {
  const base = loaded([step('a', '正在写的')], 2)
  const failed = applySavedStepsRead(base, readFail('这条任务已经不在本机了。', 'PARENT_MISSING'))
  assert.equal(failed.readErrorCode, 'PARENT_MISSING')
  assert.deepEqual(failed.draft, base.draft)
  assert.equal(failed.draftBaseRevision, 2)
})

test('更旧的读回：整条丢弃（绝不把旧内容配上新版本号）', () => {
  const base = loaded([step('a', '新内容')], 5)
  const stale = applySavedStepsRead(base, readOk([step('a', '老内容')], 4))
  assert.equal(stale, base, '更旧的读回被整条丢弃')
})

test('保存进行中：读取即使回来也不把 phase 从 saving 改掉', () => {
  const base = loaded([step('a', 'A')], 1)
  const saving = withSaving(base)
  const arrived = applySavedStepsRead(saving, readOk([step('a', 'A')], 1))
  assert.equal(arrived.phase, 'saving')
})

/* ------------------------------- 保存结果 ------------------------------- */

test('保存被拒（非冲突）：草稿与基线都不动，只给原因', () => {
  const base = loaded([step('a', '旧')], 2)
  const edited = setStepTitle(base, 'a', '新')
  const rejected = applyCommitResult(edited, {
    ok: false,
    committed: false,
    revision: null,
    reason: '这条任务已经不在本机了。',
    readbackError: null,
  })
  assert.equal(rejected.phase, 'rejected')
  assert.match(rejected.notice.text, /不在本机/)
  assert.deepEqual(rejected.draft, edited.draft)
  assert.deepEqual(rejected.baseline, edited.baseline)
  assert.equal(rejected.conflict, false)
})

test('保存成功：基线对齐到刚提交的草稿（只落一次），版本号前进，冲突清除', () => {
  const base = loaded([step('a', '旧')], 2)
  const edited = setStepTitle(base, 'a', '  写完了  ')
  const conflicted = applySavedStepsRead(edited, readOk([step('a', '别处的')], 3))
  assert.equal(conflicted.conflict, true)

  const saved = applyCommitResult(conflicted, {
    ok: true,
    committed: true,
    revision: 4,
    reason: null,
    readbackError: null,
  })
  assert.equal(saved.phase, 'saved')
  assert.equal(saved.committed, true)
  assert.equal(saved.draftBaseRevision, 4)
  assert.equal(saved.latestRevision, 4)
  assert.equal(saved.conflict, false)
  assert.deepEqual(saved.baseline.steps, [step('a', '写完了')], '基线存的是规范化后的内容')
  assert.equal(saved.baseline.revision, 4)
  assert.equal(isDraftDirty(saved.draft, saved.baseline), false, '保存完就是干净的')
})

test('提交成功但读回失败：保留「已提交」与版本号，基线只落一次且不再可重复保存', () => {
  const base = loaded([step('a', 'A')], 1)
  const edited = setStepTitle(base, 'a', 'B')
  const next = applyCommitResult(edited, {
    ok: true,
    committed: true,
    revision: 2,
    reason: null,
    readbackError: '读回时连接断了',
  })
  assert.equal(next.phase, 'committedNoReadback')
  assert.equal(next.committed, true, '写入已经提交，这个事实不能被读回失败改写')
  assert.equal(next.draftBaseRevision, 2)
  assert.equal(next.baseline.revision, 2)
  assert.deepEqual(next.baseline.steps, [step('a', 'B')])
  assert.equal(isDraftDirty(next.draft, next.baseline), false, '同一份草稿不应再提示保存')
  assert.match(next.readError, /读回时连接断了/)
  assert.match(next.notice.text, /已经保存/)
})

test('读回失败之后的一次成功读取：清掉错误与失败阶段，内容与版本对得上', () => {
  const base = loaded([step('a', 'A')], 1)
  const edited = setStepTitle(base, 'a', 'B')
  const failed = applyCommitResult(edited, {
    ok: true,
    committed: true,
    revision: 2,
    reason: null,
    readbackError: '读回时连接断了',
  })
  assert.equal(failed.phase, 'committedNoReadback')

  const recovered = applySavedStepsRead(failed, readOk([step('a', 'B')], 2))
  assert.equal(recovered.readError, null)
  assert.equal(recovered.readErrorCode, null)
  assert.notEqual(recovered.phase, 'committedNoReadback', '读回成功后不再停留在「未读回」')
  assert.equal(recovered.draftBaseRevision, 2)
  assert.deepEqual(recovered.draft, [step('a', 'B')])
})

test('提交结论单调：状态里已有更新的版本时不会被旧结果回退', () => {
  const base = loaded([step('a', 'A')], 7)
  const next = applyCommitResult(base, { ok: true, committed: true, revision: 5, reason: null, readbackError: null })
  assert.equal(next.draftBaseRevision, 7, '版本号只增不减')
})

test('异常：写入前抛错 = 没写进去；in-flight 标记由保存阶段表示', () => {
  const failed = commitFailureResult(new Error('数据库忙'))
  assert.equal(failed.committed, false)
  assert.match(failed.reason, /数据库忙/)
  assert.equal(withSaving(createTaskStepsState()).phase, 'saving')
})

test('进度文案：空清单说「尚未添加步骤」，绝不显示 100%', () => {
  assert.equal(progressText([]), '尚未添加步骤')
  assert.doesNotMatch(progressText([]), /%|100/)
  assert.equal(progressText([step('a', 'A', true), step('b', 'B')]), '1/2 已完成')
})
