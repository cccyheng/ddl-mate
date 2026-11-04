// 北京时间（Asia/Shanghai）日期时间工具的测试。
//
// 覆盖：真实日历校验（闰年、大小月、不存在的日期）、墙上时间 ↔ 带偏移 ISO 往返、
// 以及**手机时区为 UTC / 纽约时结果必须一致**（这是本应用最容易出错的地方）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addDaysToDateKey,
  compareByDeadline,
  daysInMonth,
  deadlineToEpochMs,
  deadlineToShanghaiClock,
  deadlineToShanghaiDateKey,
  deadlineToShanghaiWallClock,
  isDateOnlyDeadline,
  isDeadlineOverdue,
  isLeapYear,
  isoToShanghaiClock,
  isoToShanghaiDateKey,
  isoToShanghaiWallClock,
  isValidCalendarDate,
  isValidDateKey,
  isValidShanghaiWallClock,
  isoToEpochMs,
  mondayOfDateKey,
  remainingLabel,
  shanghaiDeadlineLabel,
  shanghaiWallClockToOffset,
  weekdayOfDateKey,
} from '../src/domain/datetime.ts'
import { readShanghaiClock, readShanghaiEpochClock } from '../src/domain/calendarClock.ts'

/* ------------------------- 真实日历日期校验 ------------------------- */

test('闰年判定符合公历规则（含 100/400 年例外）', () => {
  assert.equal(isLeapYear(2024), true)
  assert.equal(isLeapYear(2026), false)
  assert.equal(isLeapYear(2028), true)
  assert.equal(isLeapYear(1900), false, '1900 能被 100 整除但不能被 400 整除，不是闰年')
  assert.equal(isLeapYear(2000), true, '2000 能被 400 整除，是闰年')
})

test('每月天数正确，2 月随闰年变化', () => {
  assert.equal(daysInMonth(2026, 1), 31)
  assert.equal(daysInMonth(2026, 2), 28)
  assert.equal(daysInMonth(2028, 2), 29)
  assert.equal(daysInMonth(2026, 4), 30)
  assert.equal(daysInMonth(2026, 12), 31)
  assert.equal(daysInMonth(2026, 13), 0, '非法月份返回 0')
})

test('不存在的日期被拒绝，不会被静默滚动到下个月', () => {
  assert.equal(isValidCalendarDate(2026, 2, 30), false)
  assert.equal(isValidCalendarDate(2027, 2, 29), false, '2027 不是闰年')
  assert.equal(isValidCalendarDate(2028, 2, 29), true, '2028 是闰年')
  assert.equal(isValidCalendarDate(2026, 4, 31), false, '4 月只有 30 天')
  assert.equal(isValidCalendarDate(2026, 0, 10), false)
  assert.equal(isValidCalendarDate(2026, 1, 0), false)
  assert.equal(isValidCalendarDate(1899, 1, 1), false, '超出支持范围 1900–2199')
})

test('北京时间墙上时间的严格校验（日期与时刻都查）', () => {
  assert.equal(isValidShanghaiWallClock('2026-10-15T22:00'), true)
  assert.equal(isValidShanghaiWallClock('2026-10-15 22:00'), true, '空格分隔也接受')
  assert.equal(isValidShanghaiWallClock('2026-10-15T22:00:30'), true)
  assert.equal(isValidShanghaiWallClock('2026-02-30T10:00'), false, '2 月 30 日不存在')
  assert.equal(isValidShanghaiWallClock('2027-02-29T10:00'), false)
  assert.equal(isValidShanghaiWallClock('2026-10-15T25:00'), false, '没有 25 点')
  assert.equal(isValidShanghaiWallClock('2026-10-15T22:75'), false, '没有 75 分')
  assert.equal(isValidShanghaiWallClock('2026-10-15'), false, '只有日期不算墙上时间')
  assert.equal(isValidShanghaiWallClock(''), false)
  assert.equal(isValidShanghaiWallClock(null), false)
})

test('只到日期的 DDL 是独立精度，通用时间戳解析器保持严格', () => {
  assert.equal(isDateOnlyDeadline('2026-10-15'), true)
  assert.equal(isDateOnlyDeadline('2026-02-30'), false, '不存在的日期不算合法裸日期')
  assert.equal(isDateOnlyDeadline('2026-10-15T22:00'), false)
  assert.equal(isDateOnlyDeadline(''), false)

  // 裸日期仍是「通用」解析器不认的输入，避免误把日期当时间戳。
  assert.equal(isoToEpochMs('2026-10-15'), null)
  assert.equal(isoToShanghaiWallClock('2026-10-15'), '')
  // DDL 专用辅助函数才接受它。
  assert.equal(deadlineToShanghaiDateKey('2026-10-15'), '2026-10-15')
  assert.equal(deadlineToShanghaiWallClock('2026-10-15'), '2026-10-15')
  assert.equal(deadlineToShanghaiClock('2026-10-15'), '')
})

test('只到日期的 DDL 按「次日零点」比较；当天内不逾期', () => {
  assert.equal(
    deadlineToEpochMs('2026-10-15'),
    Date.parse('2026-10-16T00:00:00+08:00'),
    '边界是北京时间次日 00:00，不是 00:00 或 23:59',
  )
  assert.equal(isDateOnlyDeadline('2026-10-15'), true)
  assert.equal(isDeadlineOverdue('2026-10-15', new Date('2026-10-15T23:59:59.999+08:00')), false)
  assert.equal(isDeadlineOverdue('2026-10-15', new Date('2026-10-16T00:00:00+08:00')), true)
  // 精确时刻语义不变：到点那一刻不算逾期。
  assert.equal(isDeadlineOverdue('2026-10-15T22:00:00+08:00', new Date('2026-10-15T22:00:00+08:00')), false)
  assert.equal(isDeadlineOverdue('2026-10-15T22:00:00+08:00', new Date('2026-10-15T22:00:00.001+08:00')), true)
})

test('只到日期的 DDL 标签不显示编造的时刻', () => {
  assert.equal(shanghaiDeadlineLabel('2026-10-15'), '2026-10-15 周四')
  assert.equal(shanghaiDeadlineLabel('2026-10-15T22:00:00+08:00'), '2026-10-15 22:00 周四')
})

test('dateKey 校验同样严格', () => {
  assert.equal(isValidDateKey('2026-09-07'), true)
  assert.equal(isValidDateKey('2026-02-30'), false)
  assert.equal(isValidDateKey('2026-9-7'), false, '必须是补零的两位')
  assert.equal(isValidDateKey(''), false)
})

/* --------------------------- 偏移量换算 --------------------------- */

test('墙上时间 → 带 +08:00 偏移的 ISO，非法输入返回 null', () => {
  assert.equal(shanghaiWallClockToOffset('2026-10-15T22:00'), '2026-10-15T22:00:00+08:00')
  assert.equal(shanghaiWallClockToOffset('2026-10-15 22:00:30'), '2026-10-15T22:00:30+08:00')
  assert.equal(shanghaiWallClockToOffset('2026-02-30T10:00'), null, '绝不硬凑一个时间')
  assert.equal(shanghaiWallClockToOffset(''), null)
  assert.equal(shanghaiWallClockToOffset('明天 22:00'), null)
})

test('同一时刻换回北京时间：UTC 的 14:00 就是北京 22:00', () => {
  assert.equal(isoToShanghaiWallClock('2026-10-15T14:00:00Z'), '2026-10-15T22:00')
  assert.equal(isoToShanghaiWallClock('2026-10-15T22:00:00+08:00'), '2026-10-15T22:00')
  assert.equal(isoToShanghaiWallClock('2026-10-15T10:00:00-04:00'), '2026-10-15T22:00')
  assert.equal(isoToShanghaiClock('2026-10-15T14:00:00Z'), '22:00')
  assert.equal(isoToEpochMs('2026-10-15T14:00:00Z'), isoToEpochMs('2026-10-15T22:00:00+08:00'))
})

test('跨自然日的时区换算：UTC 深夜等于北京第二天上午', () => {
  assert.equal(isoToShanghaiDateKey('2026-10-14T16:00:00Z'), '2026-10-15', 'UTC 16:00 = 北京次日 00:00')
  assert.equal(isoToShanghaiDateKey('2026-10-15T15:59:00Z'), '2026-10-15')
  assert.equal(isoToShanghaiDateKey('2026-10-15T16:00:00Z'), '2026-10-16')
})

/* ---------------- 手机时区切换后结果必须完全一致 ---------------- */

test('手机时区为 UTC / 纽约 / 上海时，北京时间换算结果一致', () => {
  const original = process.env.TZ
  const samples = [
    '2026-10-15T22:00:00+08:00',
    '2026-10-15T23:30:00+08:00',
    '2026-01-01T00:30:00+08:00',
    '2026-07-01T12:00:00+08:00',
  ]
  const byZone = {}

  try {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
      process.env.TZ = zone
      byZone[zone] = samples.map((value) => ({
        wallClock: isoToShanghaiWallClock(value),
        dateKey: isoToShanghaiDateKey(value),
        clock: isoToShanghaiClock(value),
        epoch: isoToEpochMs(value),
      }))
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }

  assert.deepEqual(byZone['UTC'], byZone['America/New_York'])
  assert.deepEqual(byZone['UTC'], byZone['Asia/Shanghai'])
  assert.equal(byZone['UTC'][0].wallClock, '2026-10-15T22:00')
  assert.equal(byZone['UTC'][1].dateKey, '2026-10-15', '北京 23:30 的任务不能被挪到 10-16')
})

test('美国夏令时切换当天不会影响北京时间的日期归组', () => {
  const original = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    // 2026-11-01 是美国夏令时结束日；北京 11-02 08:00 仍是 11-02
    assert.equal(isoToShanghaiDateKey('2026-11-02T00:00:00+08:00'), '2026-11-02')
    process.env.TZ = 'UTC'
    assert.equal(isoToShanghaiDateKey('2026-11-02T00:00:00+08:00'), '2026-11-02')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

/* --------------------------- 日历运算 --------------------------- */

test('周一为每周第一天，weekday = 1..7', () => {
  assert.equal(weekdayOfDateKey('2026-09-07'), 1, '2026-09-07 是周一')
  assert.equal(weekdayOfDateKey('2026-09-10'), 4, '2026-09-10 是周四')
  assert.equal(weekdayOfDateKey('2026-09-13'), 7, '2026-09-13 是周日')
  assert.equal(mondayOfDateKey('2026-09-13'), '2026-09-07', '周日归属本周周一')
  assert.equal(mondayOfDateKey('2026-09-14'), '2026-09-14', '周一就是它自己')
})

test('加减天数跨月跨年都正确', () => {
  assert.equal(addDaysToDateKey('2026-10-31', 1), '2026-11-01')
  assert.equal(addDaysToDateKey('2026-01-01', -1), '2025-12-31')
  assert.equal(addDaysToDateKey('2028-02-28', 1), '2028-02-29', '闰年 2 月有 29 天')
  assert.equal(addDaysToDateKey('2027-02-28', 1), '2027-03-01', '平年直接到 3 月')
})

test('可读标签带星期，且按北京时间呈现', () => {
  assert.equal(shanghaiDeadlineLabel('2026-10-15T22:00:00+08:00'), '2026-10-15 22:00 周四')
  assert.equal(shanghaiDeadlineLabel('2026-10-15T14:00:00Z'), '2026-10-15 22:00 周四')
})

/* ------------------- 带偏移 ISO 的严格解析（复核修复的回归测试） ------------------- */

test('不存在的时区偏移必须被拒绝，不能算出一个看似正常的时刻', () => {
  for (const bad of [
    '2026-10-15T12:00:00+99:99',
    '2026-10-15T12:00:00+14:01',
    '2026-10-15T12:00:00-15:00',
    '2026-10-15T12:00:00+08:60',
  ]) {
    assert.equal(isoToEpochMs(bad), null, `${bad} 必须解析失败`)
    assert.equal(isoToShanghaiWallClock(bad), '', `${bad} 不得被当成真实时间`)
  }
  // 真实存在的偏移照常工作（+14:00 是地球上真实存在的最大正偏移）
  assert.equal(isoToEpochMs('2026-10-15T12:00:00+14:00') !== null, true)
  assert.equal(isoToEpochMs('2026-10-15T12:00:00+05:30') !== null, true)
})

test('小数秒被保留：同一秒内更晚的时刻 epoch 更大', () => {
  const earlier = isoToEpochMs('2026-10-16T10:00:00.250Z')
  const later = isoToEpochMs('2026-10-16T10:00:00.500Z')
  assert.equal(earlier !== null && later !== null, true)
  assert.equal(later - earlier, 250, '差值应该正好是 250 毫秒')
})

test('多于 3 位的小数秒按毫秒**截断**（不四舍五入、不进位、不判非法）', () => {
  const base = isoToEpochMs('2026-10-16T10:00:00Z')
  assert.equal(base !== null, true)
  // 复核点名的三个真实用例
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.1235Z') - base, 123, '.1235 → 123ms（不是 124）')
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.9999Z') - base, 999, '.9999 → 999ms（不是 1000 / 非法）')
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.0009Z') - base, 0, '.0009 → 0ms')
  // 位数不足要补零，不能当成整数倍
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.5Z') - base, 500, '.5 → 500ms')
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.05Z') - base, 50, '.05 → 50ms')
  assert.equal(isoToEpochMs('2026-10-16T10:00:00.005Z') - base, 5, '.005 → 5ms')
  // 截断只影响小数部分，秒不会因此进位
  assert.equal(isoToEpochMs('2026-10-16T10:00:59.9999Z') - base, 59_999, '不能进位到下一秒')
  // 带 +08:00 偏移时同样成立
  assert.equal(
    isoToEpochMs('2026-10-16T18:00:00.1235+08:00'),
    isoToEpochMs('2026-10-16T10:00:00.123Z'),
    '带偏移的截断结果与 UTC 写法一致',
  )
})

test('带偏移 ISO 的往返与日历分组不受严格化影响', () => {
  assert.equal(isoToShanghaiDateKey('2026-10-15T23:30:00+08:00'), '2026-10-15')
  assert.equal(isoToShanghaiWallClock('2026-10-15T14:00:00Z'), '2026-10-15T22:00')
  assert.equal(isoToShanghaiClock('2026-10-15T14:00:00Z'), '22:00')
})

/* --------------------------- 聚焦时钟读数 --------------------------- */

test('带毫秒的时钟读数保留真实时刻，且与分钟精度读数一致（逾期判定不能被截断到分钟）', () => {
  const instant = new Date('2026-10-15T20:00:00.750+08:00')
  const epochClock = readShanghaiEpochClock(instant)
  const minuteClock = readShanghaiClock(instant)
  assert.equal(epochClock.epochMs, instant.getTime(), 'epochMs 必须是完整毫秒，不能被截断')
  assert.equal(epochClock.dateKey, minuteClock.dateKey)
  assert.equal(epochClock.minutes, minuteClock.minutes)
  assert.equal(epochClock.dateKey, '2026-10-15')
  assert.equal(epochClock.minutes, 20 * 60)

  // 截断到分钟会把这半秒也算成「已经过了 20:00:00.500」——真实毫秒不会。
  const nowAccurate = new Date(readShanghaiEpochClock(new Date('2026-10-15T20:00:00.250+08:00')).epochMs)
  const nowTruncated = new Date('2026-10-15T20:00:00+08:00')
  const deadline = new Date('2026-10-15T20:00:00.500+08:00')
  assert.equal(deadline.getTime() > nowAccurate.getTime(), true, '真实毫秒下：还没到 20:00:00.500')
  assert.equal(deadline.getTime() > nowTruncated.getTime(), true, '截断到分钟会得到相反的结论')
  assert.equal(nowAccurate.getTime(), new Date('2026-10-15T20:00:00.250+08:00').getTime())
})

test('带毫秒的时钟读数沿用上海自然日（跨零点跟随北京时间）', () => {
  // 2026-10-15T16:30:00.123Z === 上海 2026-10-16 00:30:00.123
  const epochClock = readShanghaiEpochClock(new Date('2026-10-15T16:30:00.123Z'))
  assert.equal(epochClock.dateKey, '2026-10-16')
  assert.equal(epochClock.minutes, 30)
  assert.equal(epochClock.epochMs, Date.parse('2026-10-15T16:30:00.123Z'))
})

/* --------------------------- 剩余时间 --------------------------- */

test('剩余时间基于传入的 now，便于固定断言；未设置 DDL 不显示倒计时', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  assert.equal(remainingLabel(null, now).text, '未设置 DDL')
  assert.equal(remainingLabel('2026-10-15T14:00:00+08:00', now).text, '剩余 2 小时')
  assert.equal(remainingLabel('2026-10-14T12:00:00+08:00', now).overdue, true)
  assert.equal(remainingLabel('2026-10-20T12:00:00+08:00', now).text, '剩余 5 天')
  assert.equal(remainingLabel('not-a-date', now).text, '未设置 DDL')
})

test('只到日期的剩余文案用「今天截止 / 剩余 N 天」，不假装精确倒计时', () => {
  const now = new Date('2026-10-15T12:00:00+08:00')
  assert.equal(remainingLabel('2026-10-15', now).text, '今天截止')
  assert.equal(remainingLabel('2026-10-15', now).overdue, false)
  assert.equal(remainingLabel('2026-10-18', now).text, '剩余 3 天')
  assert.equal(remainingLabel('2026-10-14', now).text, '已过截止日期')
  assert.equal(remainingLabel('2026-10-14', now).overdue, true)
})

test('按 DDL 排序时未设置时间的任务排在最后；只到日期按当天结束排序', () => {
  const sorted = [
    { deadline: null },
    { deadline: '2026-10-20T10:00:00+08:00' },
    { deadline: '2026-10-20' },
    { deadline: '2026-10-15T10:00:00+08:00' },
    { deadline: '2026-10-15' },
  ].sort(compareByDeadline)
  assert.deepEqual(
    sorted.map((item) => item.deadline),
    ['2026-10-15T10:00:00+08:00', '2026-10-15', '2026-10-20T10:00:00+08:00', '2026-10-20', null],
  )
})
