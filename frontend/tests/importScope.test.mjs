import test from 'node:test'
import assert from 'node:assert/strict'
import { weekViewImportGate } from '../src/ocr/importScope.js'
import { contrastForText } from '../src/ocr/imageOps.js'
import { parseCardText } from '../src/ocr/weekGridLayout.js'
const row = () => ({ selected: true, sourceWeekView: { week: 7 }, startWeek: 7, endWeek: 7, weekPattern: 'ALL' })
const confirmed = { confirmed: true, semesterStartDate: '2026-08-31' }
test('周视图缺学期起点时不能退回无期限每周', () => {
  assert.equal(weekViewImportGate([row()], { confirmed: true }).blocked, true)
})
test('清空、部分填写、倒置、越界周次均保留来源约束', () => {
  for (const [startWeek, endWeek] of [[null, null], [7, null], [8, 7], [0, 7], [1, 54]]) {
    assert.equal(weekViewImportGate([{ ...row(), startWeek, endWeek }], confirmed).blocked, true)
  }
})
test('框选之后只按候选来源判断，和当前整图布局状态无关', () => {
  const mixed = [row(), { name: '框选新增', selected: true }]
  assert.equal(weekViewImportGate(mixed, { ...confirmed, confirmed: false }).blocked, true)
  assert.equal(weekViewImportGate(mixed, confirmed).blocked, false)
})
test('允许用户确认修改后的起止周和单双周', () => {
  assert.equal(weekViewImportGate([{ ...row(), startWeek: 1, endWeek: 16, weekPattern: 'ODD' }], confirmed).blocked, false)
})
test('普通课表与取消勾选的周视图不会误触门禁', () => {
  assert.equal(weekViewImportGate([{ startWeek: 1, endWeek: 16 }, { ...row(), selected: false }], {}).blocked, false)
})
test('学期起点校验星期与实际日期', () => {
  for (const semesterStartDate of ['2026-09-01', '2026-02-31', 'broken']) {
    assert.equal(weekViewImportGate([row()], { ...confirmed, semesterStartDate }).blocked, true)
  }
})
test('灰度拉伸保留深浅背景上的细笔画而不是二值化', () => {
  const dark = contrastForText(Uint8ClampedArray.from([...Array(90).fill(90), 120, 150, ...Array(8).fill(180)]))
  assert.equal(dark[0], 255)
  assert.ok(dark[90] > 0 && dark[90] < 255)
  const light = contrastForText(Uint8ClampedArray.from([...Array(90).fill(220), 180, 120, ...Array(8).fill(80)]))
  assert.equal(light[0], 255)
  assert.ok(light[90] > 0 && light[90] < 255)
})
test('地点括号残缺不能破坏课程名称的括号，且明确标记不确定', () => {
  const result = parseCardText('大学物理(B-2)@教学楼-204多媒体)')
  assert.equal(result.name, '大学物理(B-2)')
  assert.equal(result.suspect, true)
})
