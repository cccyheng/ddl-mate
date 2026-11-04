// 每日参考用时：纯输入校验测试。
//
// 授权书点名要求：界面与仓库**用同一套判定**，小数 / NaN / 负数 / 越界 / 指数写法一律拒绝；
// 空 = 未设置；库里存了脏值按「未设置」处理，而不是崩掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  REFERENCE_MINUTES_MAX,
  REFERENCE_MINUTES_MIN,
  STUDY_REFERENCE_RANGE_MESSAGE,
  isStudyReferenceDirty,
  parseStudyReferenceMinutes,
  readStoredStudyReferenceMinutes,
  studyReferenceSaveGuard,
  studyReferenceToDraft,
} from '../src/domain/studyReference.ts'
import {
  resolveStudyReferenceSave,
  syncStudyReferenceDraft,
} from '../src/domain/studyReferenceState.ts'

test('范围常量是 1–1440 分钟', () => {
  assert.equal(REFERENCE_MINUTES_MIN, 1)
  assert.equal(REFERENCE_MINUTES_MAX, 1440)
})

test('空输入 = 未设置（默认状态），不报错', () => {
  for (const raw of ['', '   ', null, undefined]) {
    const parsed = parseStudyReferenceMinutes(raw)
    assert.equal(parsed.ok, true, `${JSON.stringify(raw)} 应该是合法的「未设置」`)
    assert.equal(parsed.unset, true)
    assert.equal(parsed.minutes, null)
  }
})

test('接受范围内的十进制整数，并归一化掉前后空白与多余前导零', () => {
  assert.deepEqual(parseStudyReferenceMinutes('120'), { ok: true, minutes: 120, unset: false, text: '120' })
  assert.deepEqual(parseStudyReferenceMinutes(' 90 '), { ok: true, minutes: 90, unset: false, text: '90' })
  assert.deepEqual(parseStudyReferenceMinutes('007'), { ok: true, minutes: 7, unset: false, text: '7' })
  assert.equal(parseStudyReferenceMinutes('1').minutes, 1, '下界')
  assert.equal(parseStudyReferenceMinutes('1440').minutes, 1440, '上界')
})

test('拒绝小数 / 指数 / 正负号 / 单位后缀 / 越界 / 非数字', () => {
  const rejected = ['30.5', '0.5', '1e3', '1E3', '+30', '-5', '30m', '30 分钟', '一百', 'NaN', 'Infinity', '0', '1441', '99999', '1,440', '30;']
  for (const raw of rejected) {
    const parsed = parseStudyReferenceMinutes(raw)
    assert.equal(parsed.ok, false, `「${raw}」必须被拒绝`)
    assert.equal(parsed.minutes, null)
    assert.equal(parsed.reason, STUDY_REFERENCE_RANGE_MESSAGE, `「${raw}」的提示要一致`)
  }
})

test('仓库读回：脏值一律按「未设置」处理，不抛异常', () => {
  assert.equal(readStoredStudyReferenceMinutes('120'), 120)
  assert.equal(readStoredStudyReferenceMinutes(' 480 '), 480)
  for (const raw of ['', '0', '-1', '30.5', '1e3', 'abc', null, undefined, '1441']) {
    assert.equal(readStoredStudyReferenceMinutes(raw), null, `${JSON.stringify(raw)} 应该按未设置处理`)
  }
})

test('脏判定：与已保存值相同就不算脏，非法输入算脏（不能悄悄丢）', () => {
  assert.equal(isStudyReferenceDirty('120', 120), false)
  assert.equal(isStudyReferenceDirty(' 120 ', 120), false, '空白不算改动')
  assert.equal(isStudyReferenceDirty('121', 120), true)
  assert.equal(isStudyReferenceDirty('', 120), true, '清空是改动')
  assert.equal(isStudyReferenceDirty('', null), false, '本来就是未设置')
  assert.equal(isStudyReferenceDirty('abc', 120), true, '非法输入也算有未保存内容')
  assert.equal(isStudyReferenceDirty('  ', 120), true, '只剩空白 = 想清空')
})

test('保存守卫：非法与「没有改动」都不写库', () => {
  assert.equal(studyReferenceSaveGuard('120', 120).canSave, false, '没有改动不该产生写入')
  assert.equal(studyReferenceSaveGuard('120', 120).dirty, false)
  assert.equal(studyReferenceSaveGuard('abc', 120).canSave, false)
  assert.equal(studyReferenceSaveGuard('abc', 120).reason, STUDY_REFERENCE_RANGE_MESSAGE)
  assert.equal(studyReferenceSaveGuard('', 120).canSave, true, '清空是合法改动')
  assert.equal(studyReferenceSaveGuard('', 120).minutes, null)
  assert.equal(studyReferenceSaveGuard('90', null).canSave, true)
  assert.equal(studyReferenceSaveGuard('90', null).minutes, 90)
})

test('已保存值 → 输入框文本', () => {
  assert.equal(studyReferenceToDraft(120), '120')
  assert.equal(studyReferenceToDraft(null), '')
})

/* ------------------------------ 草稿同步 ------------------------------ */

test('后台刷新：已保存值没变时，正在输入的内容一个字都不动', () => {
  const state = { draft: '12', lastSynced: null } // 用户正在输入 120 的途中
  const result = syncStudyReferenceDraft({ state, observed: null, committed: false })
  assert.equal(result.changed, false)
  assert.equal(result.state.draft, '12', '输入中的内容绝不能被刷新冲掉')
})

test('外部刷新保留**合法的**未保存草稿，并把基线推进到新值', () => {
  const result = syncStudyReferenceDraft({ state: { draft: '150', lastSynced: 120 }, observed: 90, committed: false })
  assert.deepEqual(result.state, { draft: '150', lastSynced: 90 }, '用户打的 150 必须保留，基线更新为 90')
  assert.equal(result.dirty, true, '150 ≠ 90，仍然是未保存状态')
  assert.equal(result.changed, true, '基线变了也算变化（否则界面会丢掉这次更新）')
})

test('外部刷新保留**非法的**未保存草稿，并把基线推进到新值', () => {
  const result = syncStudyReferenceDraft({ state: { draft: 'abc', lastSynced: 120 }, observed: 90, committed: false })
  assert.deepEqual(result.state, { draft: 'abc', lastSynced: 90 })
  assert.equal(result.changed, true)
  assert.equal(result.dirty, true)
})

test('干净的草稿跟随外部变化（在别处改了设置，这里要跟着变）', () => {
  const result = syncStudyReferenceDraft({ state: { draft: '120', lastSynced: 120 }, observed: 90, committed: false })
  assert.deepEqual(result.state, { draft: '90', lastSynced: 90 })
  assert.equal(result.dirty, false)
})

test('初始未设置 + 用户已经打好字：刷新只推进基线，不吞掉输入', () => {
  const result = syncStudyReferenceDraft({ state: { draft: '75', lastSynced: null }, observed: 75, committed: false })
  assert.deepEqual(result.state, { draft: '75', lastSynced: 75 })
  assert.equal(result.changed, true)
  assert.equal(result.dirty, false, '刚好等于已保存值，就不算脏')
})

test('保存成功：无论刷新是否成功，草稿都与已保存值对齐', () => {
  const clean = syncStudyReferenceDraft({ state: { draft: '120', lastSynced: 120 }, observed: 120, committed: true })
  assert.equal(clean.dirty, false)
  const align = syncStudyReferenceDraft({ state: { draft: '150', lastSynced: 120 }, observed: 90, committed: true })
  assert.deepEqual(align.state, { draft: '90', lastSynced: 90 })
  assert.equal(align.dirty, false)
})

/* --------------------------- 保存结果翻译 --------------------------- */

test('保存失败（输入被拒绝）：已保存值不变，草稿保留，提示原因', () => {
  const state = { draft: '1e3', lastSynced: 120 }
  const resolved = resolveStudyReferenceSave(state, {
    ok: false,
    committed: false,
    minutes: null,
    reason: STUDY_REFERENCE_RANGE_MESSAGE,
    refreshError: null,
  })
  assert.equal(resolved.committed, false)
  assert.equal(resolved.state, state, '状态原样返回：用户不用重打一遍')
  assert.equal(resolved.tone, 'warn')
  assert.match(resolved.message, /1440|整数/)
})

test('写入已提交但刷新失败：仍然算「已保存」，草稿与已保存值对齐', () => {
  const resolved = resolveStudyReferenceSave(
    { draft: '180', lastSynced: null },
    { ok: true, committed: true, minutes: 180, reason: null, refreshError: '读取快照失败' },
  )
  assert.equal(resolved.committed, true)
  assert.deepEqual(resolved.state, { draft: '180', lastSynced: 180 }, '已保存值必须生效（否则会被反复问「未保存」）')
  assert.equal(resolved.tone, 'warn')
  assert.match(resolved.message, /已经保存/)
  assert.doesNotMatch(resolved.message, /失败/)
})

test('**清除**提交成功但刷新失败：草稿必须真的变空，不能留下旧值', () => {
  const resolved = resolveStudyReferenceSave(
    { draft: '120', lastSynced: 120 },
    { ok: true, committed: true, minutes: null, reason: null, refreshError: 'read failed' },
  )
  assert.equal(resolved.committed, true)
  assert.deepEqual(resolved.state, { draft: '', lastSynced: null }, '旧草稿必须被清掉')
})

test('保存成功：草稿对齐并给出明确回执；清除时回到未设置', () => {
  const saved = resolveStudyReferenceSave(
    { draft: '180', lastSynced: null },
    { ok: true, committed: true, minutes: 180, reason: null, refreshError: null },
  )
  assert.equal(saved.state.draft, '180')
  assert.equal(saved.state.lastSynced, 180)
  assert.equal(saved.tone, 'success')
  assert.match(saved.message, /180 分钟/)

  const cleared = resolveStudyReferenceSave(
    { draft: '', lastSynced: 180 },
    { ok: true, committed: true, minutes: null, reason: null, refreshError: null },
  )
  assert.equal(cleared.state.draft, '')
  assert.equal(cleared.state.lastSynced, null)
  assert.match(cleared.message, /未设置/)
})

test('原始类型守卫：布尔 / 数组 / 对象一律拒绝，不做字符串强转', () => {
  for (const raw of [true, false, [60], [], {}, Symbol('x'), () => 60]) {
    const parsed = parseStudyReferenceMinutes(raw)
    assert.equal(parsed.ok, false, `${String(raw)} 必须被拒绝`)
    assert.equal(parsed.minutes, null)
  }
  assert.deepEqual(parseStudyReferenceMinutes(90), { ok: true, minutes: 90, unset: false, text: '90' })
  assert.deepEqual(parseStudyReferenceMinutes('90'), { ok: true, minutes: 90, unset: false, text: '90' })
})

