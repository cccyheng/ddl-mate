// 原生日期 / 时钟滚轮的纯逻辑测试。
//
// 锁住本轮的硬口径：
// - 1900–2199、闰年、月天数与日期钳制；
// - 打开弹层时的初值只做草稿建议，不写回；
// - 选日期不补时刻（任务仍可只到日期），选时刻保留日期；
// - 清除时刻保留日期；清除日期不留下半截值、不伪造有效截止时间；
// - 24 小时制每一分钟都在。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WHEEL_HOURS,
  WHEEL_MAX_YEAR,
  WHEEL_MIN_YEAR,
  WHEEL_MINUTES,
  WHEEL_MONTHS,
  WHEEL_YEARS,
  clampWheelDate,
  clearWallClockDate,
  clearWallClockTime,
  formatWheelClock,
  formatWheelDate,
  initialWheelClock,
  initialWheelDate,
  parseWheelClock,
  parseWheelDate,
  wheelDaysForMonth,
  withWallClockDate,
  withWallClockTime,
} from '../src/domain/timeWheel.ts'
import { splitWallClock, validateWallClockInput } from '../src/domain/wallClockInput.ts'
import { normalizeTaskDraft } from '../src/domain/taskDraft.ts'

/* ------------------------------ 滚轮候选范围 ------------------------------ */

test('年份覆盖 1900–2199；月 / 时 / 分候选完整，分钟是每一分钟', () => {
  assert.equal(WHEEL_YEARS.length, 300)
  assert.equal(WHEEL_YEARS[0], WHEEL_MIN_YEAR)
  assert.equal(WHEEL_YEARS[WHEEL_YEARS.length - 1], WHEEL_MAX_YEAR)
  assert.deepEqual(WHEEL_MONTHS, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(WHEEL_HOURS.length, 24)
  assert.equal(WHEEL_HOURS[0], 0)
  assert.equal(WHEEL_HOURS[23], 23)
  assert.equal(WHEEL_MINUTES.length, 60)
  assert.equal(WHEEL_MINUTES[0], 0)
  assert.equal(WHEEL_MINUTES[59], 59)
  assert.deepEqual(WHEEL_MINUTES.slice(0, 4), [0, 1, 2, 3], '不是 5 分钟一跳')
})

test('日滚轮按真实月天数生成：闰年、平年、大小月都正确', () => {
  assert.equal(wheelDaysForMonth(2028, 2).length, 29)
  assert.equal(wheelDaysForMonth(2027, 2).length, 28)
  assert.equal(wheelDaysForMonth(2000, 2).length, 29)
  assert.equal(wheelDaysForMonth(1900, 2).length, 28)
  assert.equal(wheelDaysForMonth(2026, 4).length, 30)
  assert.equal(wheelDaysForMonth(2026, 12).length, 31)
  assert.deepEqual([...wheelDaysForMonth(2026, 2)], Array.from({ length: 28 }, (_, index) => index + 1))
})

/* ------------------------------ 日期钳制 ------------------------------ */

test('换年 / 换月会把日期钳制到真实存在的那一天', () => {
  assert.deepEqual(clampWheelDate({ year: 2028, month: 2, day: 31 }), { year: 2028, month: 2, day: 29 })
  assert.deepEqual(clampWheelDate({ year: 2027, month: 2, day: 29 }), { year: 2027, month: 2, day: 28 })
  assert.deepEqual(clampWheelDate({ year: 2026, month: 4, day: 31 }), { year: 2026, month: 4, day: 30 })
  assert.deepEqual(clampWheelDate({ year: 2026, month: 1, day: 31 }), { year: 2026, month: 1, day: 31 })
})

test('年份与月份本身也会钳制在支持范围内，不生成界外日期', () => {
  assert.deepEqual(clampWheelDate({ year: 1800, month: 13, day: 0 }), { year: 1900, month: 12, day: 1 })
  assert.deepEqual(clampWheelDate({ year: 2300, month: 0, day: 40 }), { year: 2199, month: 1, day: 31 })
})

/* ------------------------------ 解析与格式化 ------------------------------ */

test('日期解析拒绝不存在的日期与界外年份，合法值可往返', () => {
  assert.deepEqual(parseWheelDate('2026-10-15'), { year: 2026, month: 10, day: 15 })
  assert.deepEqual(parseWheelDate('2028-02-29'), { year: 2028, month: 2, day: 29 })
  assert.equal(parseWheelDate('2027-02-29'), null, '平年 2 月 29 日不存在')
  assert.equal(parseWheelDate('2026-02-30'), null, '2 月 30 日不存在')
  assert.equal(parseWheelDate('1899-12-31'), null, '早于 1900 年')
  assert.equal(parseWheelDate('2200-01-01'), null, '晚于 2199 年')
  assert.equal(parseWheelDate(''), null)
  assert.equal(parseWheelDate('2026/10/15'), null)

  const parts = parseWheelDate('2026-10-15')
  assert.ok(parts)
  assert.equal(formatWheelDate(parts), '2026-10-15')
})

test('时刻解析接受 H:mm / HH:mm 并补零；非法小时 / 分钟返回 null', () => {
  assert.deepEqual(parseWheelClock('9:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseWheelClock('09:05'), { hour: 9, minute: 5 })
  assert.deepEqual(parseWheelClock('23:59'), { hour: 23, minute: 59 })
  assert.deepEqual(parseWheelClock('0:00'), { hour: 0, minute: 0 })
  assert.equal(parseWheelClock('24:00'), null)
  assert.equal(parseWheelClock('23:60'), null)
  assert.deepEqual(parseWheelClock('9:5'), { hour: 9, minute: 5 }, '与既有 padClockText 口径一致')
  assert.equal(parseWheelClock(''), null)
  assert.equal(parseWheelClock('abc'), null)

  assert.equal(formatWheelClock({ hour: 9, minute: 5 }), '09:05')
  assert.equal(formatWheelClock({ hour: 23, minute: 59 }), '23:59')
})

/* ------------------------- 打开弹层时的初值建议 ------------------------- */

test('日期初值：当前值优先；空 / 非法时才用回退建议，且不写回任何值', () => {
  assert.deepEqual(initialWheelDate('2026-10-15', '2026-01-01'), { year: 2026, month: 10, day: 15 })
  assert.deepEqual(initialWheelDate('', '2026-01-01'), { year: 2026, month: 1, day: 1 })
  assert.deepEqual(initialWheelDate('2026-02-30', '2026-01-01'), { year: 2026, month: 1, day: 1 })
  assert.deepEqual(initialWheelDate('', '不是日期'), { year: 2000, month: 1, day: 1 })

  // 建议只是返回值，原值不会被函数修改（字符串本身不可变，这里钉住语义）。
  const current = ''
  initialWheelDate(current, '2026-01-01')
  assert.equal(current, '')
})

test('时刻初值：当前值优先；空 / 非法时才用回退建议', () => {
  assert.deepEqual(initialWheelClock('9:05', '22:00'), { hour: 9, minute: 5 })
  assert.deepEqual(initialWheelClock('', '22:00'), { hour: 22, minute: 0 })
  assert.deepEqual(initialWheelClock('25:00', '22:00'), { hour: 22, minute: 0 })
  assert.deepEqual(initialWheelClock('', '不是时刻'), { hour: 0, minute: 0 })
})

/* ------------------------------ 确认写回口径 ------------------------------ */

test('选日期不自动补时刻：日期优先、时刻原样保留，空时刻仍是空', () => {
  assert.equal(withWallClockDate('', '2026-10-15'), '2026-10-15', '空值选日期后仍是裸日期')
  assert.equal(withWallClockDate('2026-10-15', '2026-10-16'), '2026-10-16', '原为日期时仍只到日期')
  assert.equal(
    withWallClockDate('2026-10-15T22:00', '2026-10-16'),
    '2026-10-16T22:00',
    '原有具体时刻要保留，不能被清掉',
  )
  assert.equal(withWallClockDate('22:00', '2026-10-15'), '2026-10-15', '只有时刻的旧半截值不能借选日期伪造时刻')
  assert.equal(withWallClockDate('2026-10-15T22:00', '2026-10-16').includes('18:00'), false)
})

test('选时刻保留日期，并统一补零', () => {
  assert.equal(withWallClockTime('2026-10-15', '9:05'), '2026-10-15T09:05')
  assert.equal(withWallClockTime('2026-10-15T22:00', '23:59'), '2026-10-15T23:59')
  assert.equal(withWallClockTime('2026-10-15', '0:00'), '2026-10-15T00:00')
})

/* ------------------------------ 清除口径 ------------------------------ */

test('清除时刻保留日期；日期只到日时也不会被改成带时刻', () => {
  assert.equal(clearWallClockTime('2026-10-15T22:00'), '2026-10-15')
  assert.equal(clearWallClockTime('2026-10-15'), '2026-10-15')
  assert.equal(clearWallClockTime(''), '')
  assert.equal(clearWallClockTime('22:00'), '', '只有时刻的半截值清掉后不能留下假日期')
})

test('清除日期会把整个值清空，绝不伪造一个看起来有效的截止时间', () => {
  assert.equal(clearWallClockDate('2026-10-15T22:00'), '')
  assert.equal(clearWallClockDate('2026-10-15'), '')
  assert.equal(clearWallClockDate(''), '')
  assert.notEqual(clearWallClockDate('2026-10-15T22:00'), '2026-10-15', '不能只清日期留下时刻')
})

test('清除时刻后：任务可保持日期当天截止，要求精确时刻的场景仍然报错', () => {
  const dateOnly = clearWallClockTime('2026-10-15T22:00')
  const { date, time } = splitWallClock(dateOnly)
  assert.equal(date, '2026-10-15')
  assert.equal(time, '')
  assert.equal(validateWallClockInput(date, time, { allowDateOnly: true }), null)
  assert.match(
    validateWallClockInput(date, time),
    /还差一个具体时刻/,
    '通知导入 / 时间助手等严格场景仍要求具体时刻',
  )

  const clearedAll = clearWallClockDate('2026-10-15T22:00')
  assert.equal(validateWallClockInput('', '', { allowDateOnly: true }), null)
  assert.equal(validateWallClockInput('', ''), null)
  assert.equal(clearedAll, '')
})

/* -------------------- 与任务保存口径的回归：只到日期仍可保存 -------------------- */

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

test('滚轮选日期后仍走原来的保存口径：日期只到日就存裸日期', () => {
  const next = withWallClockDate('2026-10-15', '2026-10-16')
  assert.equal(next, '2026-10-16')
  assert.equal(normalizeTaskDraft(draftWith(next)).deadline, '2026-10-16')
  assert.equal(normalizeTaskDraft(draftWith(next)).deadline.includes('T'), false, '不能变成 00:00 / 23:59')
})

test('整份清空仍然是未设置，不恢复精确时刻要求', () => {
  assert.equal(normalizeTaskDraft(draftWith('')).deadline, null)
})
