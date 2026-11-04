// 「学期第一周周一」解析规则的纯函数测试。
//
// 复核对第 11 条点名的 CRITICAL：旧实现编辑既有课表时**总是**拿全局校准覆盖记录自己的
// 学期起点，等于把用户已经排好的老课表静默挪到新日期。这组测试锁死三条规则：
// 1. 记录自己有合法起点 → 原样保留（全局怎么变都不动）；没有合法起点时才算「没有」。
// 2. 自己没有起点但做了全局校准 → 用全局。
// 3. 两者都没有 → null，由界面要求先校准，绝不猜。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  anchorAllowsSavingWithoutCalibration,
  resolveSemesterAnchor,
  usableSemesterAnchor,
} from '../src/domain/semesterAnchor.ts'

test('usableSemesterAnchor 只认「真实日期 + 周一」', () => {
  assert.equal(usableSemesterAnchor('2026-08-31'), '2026-08-31')
  assert.equal(usableSemesterAnchor(' 2026-08-31 '), '2026-08-31')
  assert.equal(usableSemesterAnchor('2026-09-01'), null, '周二不是学期起点')
  assert.equal(usableSemesterAnchor('2026-02-30'), null, '不存在的日期')
  assert.equal(usableSemesterAnchor(''), null)
  assert.equal(usableSemesterAnchor(null), null)
  assert.equal(usableSemesterAnchor(undefined), null)
})

test('编辑既有课表：记录自己的起点优先，全局重新校准不会改写它', () => {
  const resolution = resolveSemesterAnchor({
    existingAnchor: '2026-08-31',
    calibrationMonday: '2026-09-21',
  })
  assert.equal(resolution.anchor, '2026-08-31', '老记录必须保持自己的学期起点')
  assert.equal(resolution.source, 'existing')
  assert.match(resolution.note, /不受全局教学周重新校准影响/)
})

test('编辑既有课表：全局校准被清掉后，仍然能沿用记录自己的起点保存', () => {
  const resolution = resolveSemesterAnchor({ existingAnchor: '2026-08-31', calibrationMonday: null })
  assert.equal(resolution.anchor, '2026-08-31')
  assert.equal(resolution.source, 'existing')
  assert.equal(
    anchorAllowsSavingWithoutCalibration({ existingAnchor: '2026-08-31', calibrationMonday: null }),
    true,
    '有自己起点的老记录不该被「没有全局校准」拦住',
  )
})

test('新建课表：没有自己的起点时使用全局校准', () => {
  const resolution = resolveSemesterAnchor({ existingAnchor: '', calibrationMonday: '2026-09-21' })
  assert.equal(resolution.anchor, '2026-09-21')
  assert.equal(resolution.source, 'calibration')
})

test('两边都没有（或有非法值）→ null，并且不允许在缺校准时保存', () => {
  const empty = resolveSemesterAnchor({ existingAnchor: null, calibrationMonday: null })
  assert.equal(empty.anchor, null)
  assert.equal(empty.source, 'none')
  assert.equal(anchorAllowsSavingWithoutCalibration({ existingAnchor: null, calibrationMonth: null }), false)

  const broken = resolveSemesterAnchor({ existingAnchor: '2026-09-01', calibrationMonday: '2026-09-02' })
  assert.equal(broken.anchor, null, '两天都不是周一 → 都不能当学期起点')
  assert.equal(broken.source, 'none')
})

test('「编辑老记录 + 用户这次并不想做教学周」不应该报错：靠 source 判断即可', () => {
  const resolution = resolveSemesterAnchor({ existingAnchor: '2026-08-31', calibrationMonday: null })
  assert.equal(resolution.source, 'existing')
  // 表单里的分支：termMode === 'weeks' 时要求 anchor 不为 null；
  // 老记录在没有任何全局校准的情况下也能满足这个条件。
  assert.notEqual(resolution.anchor, null)
})
