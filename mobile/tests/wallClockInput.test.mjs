// 截止时间输入逻辑与持久化口径的一致性测试。
//
// 复核指出的问题：界面上「只填日期」曾会被静默补成 18:00，
// 而且 `validateWallClockInput` 接受 `9:00` 却在保存时被 normalize 拒绝。
// 这里把两条口径钉在一起：界面允许的，保存也必须允许；界面报错的，保存也必须拒绝。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isDateWithoutTime,
  joinWallClock,
  padClockText,
  splitWallClock,
  validateWallClockInput,
} from '../src/domain/wallClockInput.ts'
import { normalizeTaskDraft } from '../src/domain/taskDraft.ts'
import { ValidationError } from '../src/domain/errors.ts'

/* --------------------------- 拆分与拼接 --------------------------- */

test('splitWallClock 拆分日期与时间，只有日期时时间为空', () => {
  assert.deepEqual(splitWallClock('2026-10-15T22:00'), { date: '2026-10-15', time: '22:00' })
  assert.deepEqual(splitWallClock('2026-10-15 22:00'), { date: '2026-10-15', time: '22:00' })
  assert.deepEqual(splitWallClock('2026-10-15'), { date: '2026-10-15', time: '' })
  assert.deepEqual(splitWallClock(''), { date: '', time: '' })
})

test('joinWallClock 不产生带尾巴的 "2026-10-15T"', () => {
  assert.equal(joinWallClock('2026-10-15', '22:00'), '2026-10-15T22:00')
  assert.equal(joinWallClock('2026-10-15', ''), '2026-10-15', '只有日期就是裸日期')
  assert.equal(joinWallClock('', '22:00'), '22:00')
  assert.equal(joinWallClock('', ''), '')
  assert.equal(joinWallClock(' 2026-10-15 ', ' 22:00 '), '2026-10-15T22:00', '两侧空白会被去掉')
})

test('padClockText 把 H:mm 补零成 HH:mm，无法识别时原样返回', () => {
  assert.equal(padClockText('9:00'), '09:00')
  assert.equal(padClockText('09:00'), '09:00')
  assert.equal(padClockText('9:5'), '09:05')
  assert.equal(padClockText('22:00'), '22:00')
  assert.equal(padClockText('abc'), 'abc')
  assert.equal(padClockText('25:00'), '25:00', '不负责判断合法性，只负责补零')
})

test('isDateWithoutTime 只对「有日期没时间」为真', () => {
  assert.equal(isDateWithoutTime('2026-10-15', ''), true)
  assert.equal(isDateWithoutTime('2026-10-15', '22:00'), false)
  assert.equal(isDateWithoutTime('', '22:00'), false)
  assert.equal(isDateWithoutTime('', ''), false)
})

/* --------------------------- 实时校验 --------------------------- */

test('全空是合法的「未设置 DDL」，不算错误', () => {
  assert.equal(validateWallClockInput('', ''), null)
})

test('任务表单允许只填日期；要求精确时刻的场景仍提示补时刻', () => {
  assert.equal(
    validateWallClockInput('2026-10-15', '', { allowDateOnly: true }),
    null,
    '任务表单：日期可以单独保存（当天结束前）',
  )
  const message = validateWallClockInput('2026-10-15', '')
  assert.match(message, /还差一个具体时刻/)
  assert.match(message, /不会替你猜时间/)
})

test('只填时刻会提示补日期', () => {
  assert.match(validateWallClockInput('', '22:00'), /请填写日期/)
})

test('不存在的日期被拒绝（有没有时刻都一样）', () => {
  assert.match(validateWallClockInput('2026-02-30', '10:00'), /不是真实存在的日期/)
  assert.match(validateWallClockInput('2027-02-29', '10:00'), /不是真实存在的日期/)
  assert.match(
    validateWallClockInput('2026-02-30', '', { allowDateOnly: true }),
    /不是真实存在的日期/,
    '允许只填日期，不代表允许不存在的日期',
  )
  assert.equal(validateWallClockInput('2028-02-29', '10:00'), null, '2028 是闰年')
  assert.equal(validateWallClockInput('2028-02-29', '', { allowDateOnly: true }), null)
})

test('非法时刻被拒绝', () => {
  assert.match(validateWallClockInput('2026-10-15', '25:00'), /不是有效时刻/)
  assert.match(validateWallClockInput('2026-10-15', '22:75'), /不是有效时刻/)
})

test('H:mm 与 HH:mm 都通过（与保存口径一致）', () => {
  assert.equal(validateWallClockInput('2026-10-15', '9:00'), null)
  assert.equal(validateWallClockInput('2026-10-15', '09:00'), null)
  assert.equal(validateWallClockInput('2026-10-15', '22:00'), null)
})

/* ------------------ 界面口径 vs 保存口径必须一致 ------------------ */

const draftWith = (deadline) => ({
  title: '任务',
  description: '',
  courseId: null,
  type: 'HOMEWORK',
  status: 'TODO',
  priority: 3,
  deadline,
  estimatedMinutes: '',
  submitRequirement: '',
  submitMethod: '',
  originalText: '',
})

test('界面说合法的输入，保存也一定接受；界面说非法的，保存也一定拒绝', () => {
  const cases = [
    { deadline: '2026-10-15T22:00', label: '标准写法' },
    { deadline: '2026-10-15T09:00', label: '补零写法' },
    { deadline: '2026-10-15', label: '只有日期' },
    { deadline: '', label: '未设置' },
    { deadline: '2026-02-30T10:00', label: '不存在的日期' },
    { deadline: '2027-02-29T10:00', label: '平年 2 月 29 日' },
    { deadline: '2026-10-15T25:00', label: '非法小时' },
    { deadline: '2026-10-15T22:75', label: '非法分钟' },
    { deadline: '明天 22:00', label: '非时间字符串' },
  ]

  for (const item of cases) {
    const { date, time } = splitWallClock(item.deadline)
    const uiSaysOk = validateWallClockInput(date, time, { allowDateOnly: true }) === null
    let saveSaysOk = true
    try {
      normalizeTaskDraft(draftWith(item.deadline))
    } catch {
      saveSaysOk = false
    }
    assert.equal(
      saveSaysOk,
      uiSaysOk,
      `${item.label}（${item.deadline}）：界面判定=${uiSaysOk}，保存判定=${saveSaysOk}，两者必须一致`,
    )
  }
})

test('界面补零后的 `9:00` 落库为 09:00，两边不会打架', () => {
  // 组件在 onChange 里就调用 padClockText，因此真正进入草稿的是补齐后的值。
  assert.equal(validateWallClockInput('2026-10-15', '9:00'), null)
  const padded = joinWallClock('2026-10-15', padClockText('9:00'))
  assert.equal(padded, '2026-10-15T09:00')

  const normalized = normalizeTaskDraft(draftWith(padded))
  assert.equal(normalized.deadline, '2026-10-15T09:00:00+08:00')
})

test('只有日期时保存为裸日期，时间保持空白（不写猜测时刻）', () => {
  const normalized = normalizeTaskDraft(draftWith('2026-10-15'))
  assert.equal(normalized.deadline, '2026-10-15', '保存后仍是只到日期，不能变成 00:00 或 23:59')

  // 要求精确时刻的调用方（通知导入）仍会被明确拒绝，并且错误挂在 fields.deadline 上。
  assert.throws(
    () => normalizeTaskDraft(draftWith('2026-10-15'), { allowDateOnly: false }),
    (error) => {
      assert.ok(error instanceof ValidationError, `应为 ValidationError，实际 ${error?.name}`)
      assert.match(error.fields.deadline, /仍需要具体时刻/)
      assert.deepEqual(Object.keys(error.fields), ['deadline'])
      return true
    },
  )
})

test('时间但缺日期 / 非法日期仍然被拒绝', () => {
  for (const bad of ['22:00', '2026-02-30', '2027-02-29']) {
    assert.throws(
      () => normalizeTaskDraft(draftWith(bad)),
      (error) => {
        assert.ok(error instanceof ValidationError)
        assert.ok(error.fields.deadline, `${bad} 应挂在 deadline 字段`)
        return true
      },
    )
  }
})
