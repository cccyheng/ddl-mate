/**
 * 任务步骤清单 —— **纯逻辑**测试（无数据库、无 React）。
 *
 * 覆盖授权书点名的纯函数用例：标题长度与空标题、条数上限、重复编号、
 * 进度 0..N、编解码（不认识的版本 / 坏结构 → 读不出来而不是猜），
 * 以及「空清单绝不显示 100%」这条文案规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TASK_STEPS,
  TASK_STEPS_STORAGE_VERSION,
  TASK_STEP_TITLE_MAX,
  TASK_STEPS_UNREADABLE_REASON,
  clampStepTitleInput,
  decodeTaskSteps,
  encodeTaskSteps,
  isValidStepTitle,
  isValidTaskId,
  normalizeStepTitle,
  progressLabel,
  progressOf,
  validateTaskSteps,
} from '../src/domain/taskSteps.ts'

const step = (id, title, done = false) => ({ id, title, done })

test('标题：首尾空白会被去掉；空标题与超长标题都不合法', () => {
  assert.equal(normalizeStepTitle('  看书  '), '看书')
  assert.equal(normalizeStepTitle('   '), null)
  assert.equal(normalizeStepTitle(undefined), null)

  assert.equal(isValidStepTitle('写第 3 题'), true)
  assert.equal(isValidStepTitle('   '), false, '只有空白 = 没有内容')
  assert.equal(isValidStepTitle('x'.repeat(TASK_STEP_TITLE_MAX)), true, `${TASK_STEP_TITLE_MAX} 字正好合法`)
  assert.equal(isValidStepTitle('x'.repeat(TASK_STEP_TITLE_MAX + 1)), false, '多一个字就不合法')
  assert.equal(isValidStepTitle(`  ${'x'.repeat(TASK_STEP_TITLE_MAX)}  `), true, '首尾空白不算长度')

  // 输入框的封顶不改变已写内容（只截长度），与校验口径一致。
  assert.equal(clampStepTitleInput('x'.repeat(200)).length, TASK_STEP_TITLE_MAX)
  assert.equal(clampStepTitleInput('  保留空白  '), '  保留空白  ')
})

test('任务 ID：只接受正整数', () => {
  assert.equal(isValidTaskId(1), true)
  assert.equal(isValidTaskId(0), false)
  assert.equal(isValidTaskId(-3), false)
  assert.equal(isValidTaskId(1.5), false)
  assert.equal(isValidTaskId('7'), false)
  assert.equal(isValidTaskId(Number.NaN), false)
})

test('整份清单校验：条数上限、重复编号、缺字段全部整份失败', () => {
  const ok = validateTaskSteps([step('a', '第一步'), step('b', '第二步', true)])
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.steps, [step('a', '第一步'), step('b', '第二步', true)])

  const many = Array.from({ length: MAX_TASK_STEPS }, (_, index) => step(`s${index}`, `第 ${index} 步`))
  assert.equal(validateTaskSteps(many).ok, true, `${MAX_TASK_STEPS} 步正好合法`)
  assert.equal(validateTaskSteps([...many, step('extra', '多一步')]).ok, false, '超过上限整份失败')
  assert.match(validateTaskSteps([...many, step('extra', '多一步')]).reason, /最多只能有/)

  assert.equal(validateTaskSteps([step('same', 'A'), step('same', 'B')]).ok, false, '编号重复')
  assert.match(validateTaskSteps([step('same', 'A'), step('same', 'B')]).reason, /重复/)

  assert.equal(validateTaskSteps([{ id: 'a', title: '没有 done 字段' }]).ok, false)
  assert.equal(validateTaskSteps([{ title: '没有 id' }]).ok, false)
  assert.equal(validateTaskSteps([step('a', '   ')]).ok, false, '空标题不合法')
  assert.equal(validateTaskSteps([step('a', 'x'.repeat(500))]).ok, false, '超长标题不合法')
  assert.equal(validateTaskSteps('不是数组').ok, false)

  // 不合法时**不返回「能用的那部分」**：半份清单会让界面与用户写的对不上。
  const partial = validateTaskSteps([step('a', '好的'), step('b', '   ')])
  assert.equal(partial.ok, false)
  assert.deepEqual(partial.steps, [])
})

test('编码 → 解码：往返一致，载荷只含版本 / 父任务 / 版本号 / 步骤', () => {
  const steps = [step('a', '第一步', true), step('b', '第二步')]
  const raw = encodeTaskSteps(7, 3, steps)
  const payload = JSON.parse(raw)
  assert.deepEqual(Object.keys(payload).sort(), ['revision', 'steps', 'taskId', 'version'])
  assert.equal(payload.version, TASK_STEPS_STORAGE_VERSION)
  assert.equal(payload.taskId, 7)
  assert.equal(payload.revision, 3)

  const decoded = decodeTaskSteps(raw)
  assert.equal(decoded.ok, true)
  assert.equal(decoded.taskId, 7)
  assert.equal(decoded.revision, 3)
  assert.deepEqual(decoded.steps, steps)

  // 标题在编码时就已规范化（界面传原文，仓库只存规范值）。
  const normalized = decodeTaskSteps(encodeTaskSteps(1, 1, [step('a', ' 看书 ')]))
  assert.deepEqual(normalized.steps, [step('a', '看书')])
})

test('解码：坏 JSON / 不认识的版本 / 结构不合法 / 重复编号 → 读不出来（绝不猜）', () => {
  const cases = [
    '{ 这不是 json',
    '',
    '   ',
    JSON.stringify({ version: 99, taskId: 1, revision: 1, steps: [] }),
    JSON.stringify({ version: 1, taskId: 0, revision: 1, steps: [] }),
    JSON.stringify({ version: 1, taskId: 1, revision: 0, steps: [] }),
    JSON.stringify({ version: 1, taskId: 1, revision: 1, steps: '不是数组' }),
    JSON.stringify({ version: 1, taskId: 1, revision: 1, steps: [{ id: 'a', title: '  ', done: false }] }),
    JSON.stringify({ version: 1, taskId: 1, revision: 1, steps: [step('a', 'A'), step('a', 'B')] }),
    JSON.stringify({ version: 1, taskId: 1, revision: 1.5, steps: [] }),
    JSON.stringify([1, 2, 3]),
    null,
  ]
  for (const raw of cases) {
    const decoded = decodeTaskSteps(raw)
    assert.equal(decoded.ok, false, `这条必须读不出来：${String(raw).slice(0, 40)}`)
    assert.equal(decoded.reason, TASK_STEPS_UNREADABLE_REASON)
  }
})

test('进度：0..N 的计数，空清单为 0/0 且文案绝不说「已完成」', () => {
  assert.deepEqual(progressOf([]), { total: 0, done: 0 })
  assert.deepEqual(progressOf([step('a', 'A'), step('b', 'B')]), { total: 2, done: 0 })
  assert.deepEqual(progressOf([step('a', 'A', true), step('b', 'B')]), { total: 2, done: 1 })
  assert.deepEqual(progressOf([step('a', 'A', true), step('b', 'B', true)]), { total: 2, done: 2 })

  assert.equal(progressLabel([]), '尚未添加步骤', '空清单不显示 0/0 或 100%')
  assert.doesNotMatch(progressLabel([]), /%|100|完成/)
  assert.equal(progressLabel([step('a', 'A', true), step('b', 'B')]), '1/2 已完成')
  assert.equal(progressLabel([step('a', 'A', true)]), '1/1 已完成')
})
