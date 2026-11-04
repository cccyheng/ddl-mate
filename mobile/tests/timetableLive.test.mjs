// 「正在上课 / 下一节课」的判定，以及「进入日历默认当天」的时间计算。
//
// 这两块都是用户明确要求的可见行为，而且边界很容易写错（恰好上课、恰好下课、
// 跨午夜、设备时区不是北京时间、同时段多门课），所以用纯函数穷举掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clockToMinutes, computeLiveTimetable, countdownLabel } from '../src/domain/timetableLive.ts'
import {
  calendarFocusTarget,
  calendarTabEntryAction,
  monthOfDateKey,
  readShanghaiClock,
  shouldReturnToMonthOnTabEntry,
} from '../src/domain/calendarClock.ts'
import { shanghaiNowWallClock } from '../src/domain/datetime.ts'

const COURSES = [
  { id: 1, name: '高等数学', code: 'MATH1' },
  { id: 2, name: '大学物理', code: 'PHYS1' },
  { id: 3, name: '体育(3)', code: 'PE3' },
]

function session(id, courseId, startTime, endTime) {
  return { id, courseId, weekday: 1, startTime, endTime }
}

test('clockToMinutes：合法 HH:mm 换算成分钟，非法一律 null（不猜时间）', () => {
  assert.equal(clockToMinutes('00:00'), 0)
  assert.equal(clockToMinutes('08:00'), 480)
  assert.equal(clockToMinutes('15:30'), 930)
  assert.equal(clockToMinutes('23:59'), 1439)
  assert.equal(clockToMinutes('24:00'), null)
  assert.equal(clockToMinutes('8:00'), null)
  assert.equal(clockToMinutes('08:60'), null)
  assert.equal(clockToMinutes(''), null)
  assert.equal(clockToMinutes(null), null)
})

test('恰好开始时间算正在上课，恰好结束时间算已经下课（区间 [start, end)）', () => {
  const sessions = [session(1, 1, '08:00', '09:40')]
  const atStart = computeLiveTimetable(sessions, COURSES, clockToMinutes('08:00'))
  assert.equal(atStart.phase, 'in-class')
  assert.equal(atStart.active.length, 1)

  const inMiddle = computeLiveTimetable(sessions, COURSES, clockToMinutes('09:00'))
  assert.equal(inMiddle.phase, 'in-class')

  const atEnd = computeLiveTimetable(sessions, COURSES, clockToMinutes('09:40'))
  assert.notEqual(atEnd.phase, 'in-class', '到点就算下课，不能把结束当开始')
  assert.equal(atEnd.phase, 'after-last')
})

test('课前 / 课间 / 课后三种阶段各自正确，并给出下一节与倒计时', () => {
  const sessions = [session(1, 1, '08:00', '09:40'), session(2, 2, '10:00', '11:40')]

  const before = computeLiveTimetable(sessions, COURSES, clockToMinutes('07:30'))
  assert.equal(before.phase, 'before-first')
  assert.equal(before.active.length, 0)
  assert.equal(before.next?.session.id, 1)
  assert.equal(before.minutesUntilNext, 30)
  assert.equal(countdownLabel(before.minutesUntilNext), '30 分钟')

  const between = computeLiveTimetable(sessions, COURSES, clockToMinutes('09:50'))
  assert.equal(between.phase, 'between')
  assert.equal(between.next?.session.id, 2)
  assert.equal(between.next?.course?.name, '大学物理')
  assert.equal(between.minutesUntilNext, 10)

  const after = computeLiveTimetable(sessions, COURSES, clockToMinutes('12:00'))
  assert.equal(after.phase, 'after-last')
  assert.equal(after.next, null)
  assert.equal(after.minutesUntilNext, null)
  assert.equal(after.active.length, 0)
})

test('没有课的日期：phase 是 none，不显示任何「正在上课」', () => {
  const empty = computeLiveTimetable([], COURSES, clockToMinutes('10:00'))
  assert.equal(empty.phase, 'none')
  assert.deepEqual(empty.active, [])
  assert.equal(empty.next, null)
})

test('时间非法 / 结束不晚于开始的记录被跳过，不会造成假的「正在上课」', () => {
  const broken = [
    session(1, 1, '08:00', '08:00'),
    session(2, 1, '09:00', '08:00'),
    { id: 3, courseId: 1, weekday: 1, startTime: 'bad', endTime: '10:00' },
  ]
  const result = computeLiveTimetable(broken, COURSES, clockToMinutes('09:30'))
  assert.equal(result.phase, 'none')
  assert.deepEqual(result.sessions, [])
})

test('同时段多门课：正在上课的全部列出，下一节取最早开始的那一节', () => {
  const overlap = [
    session(2, 2, '10:00', '11:40'),
    session(1, 1, '08:00', '09:40'),
    session(3, 3, '08:00', '09:40'),
  ]
  const during = computeLiveTimetable(overlap, COURSES, clockToMinutes('08:30'))
  assert.equal(during.phase, 'in-class')
  assert.deepEqual(during.active.map((entry) => entry.session.id), [1, 3], '两门同时上课都要显示')
  assert.equal(during.next?.session.id, 2)

  const beforeAll = computeLiveTimetable(overlap, COURSES, clockToMinutes('07:00'))
  assert.equal(beforeAll.next?.session.id, 1, '下一节取最早开始；开始时间相同则按 id 稳定排序')
})

test('倒计时文案：不足一小时按分钟，超过一小时给小时与分钟', () => {
  assert.equal(countdownLabel(0), '0 分钟')
  assert.equal(countdownLabel(59), '59 分钟')
  assert.equal(countdownLabel(60), '1 小时')
  assert.equal(countdownLabel(65), '1 小时 05 分')
  assert.equal(countdownLabel(125), '2 小时 05 分')
  assert.equal(countdownLabel(null), null)
  assert.equal(countdownLabel(-1), null)
})

test('上海墙上时间读的是 Asia/Shanghai，不受设备时区影响', () => {
  // 2026-10-12T00:30Z = 北京时间 08:30 同一天。
  const clock = readShanghaiClock(new Date('2026-10-12T00:30:00.000Z'))
  assert.equal(clock.dateKey, '2026-10-12')
  assert.equal(clock.minutes, 8 * 60 + 30)
  assert.equal(shanghaiNowWallClock(new Date('2026-10-12T00:30:00.000Z')), '2026-10-12T08:30')

  // 2026-10-11T17:00Z = 北京时间 10-12 01:00 → 跨日必须按上海算。
  const acrossMidnight = readShanghaiClock(new Date('2026-10-11T17:00:00.000Z'))
  assert.equal(acrossMidnight.dateKey, '2026-10-12')
  assert.equal(acrossMidnight.minutes, 60)
})

test('进入日历的默认目标：日期是上海「今天」，cursor 是该自然日所在月（跨午夜也正确）', () => {
  const beforeMidnight = calendarFocusTarget(new Date('2026-10-31T15:30:00.000Z')) // 北京 23:30
  assert.equal(beforeMidnight.dateKey, '2026-10-31')
  assert.deepEqual(beforeMidnight.cursor, { year: 2026, month: 10 })

  // 同一个瞬间之后 40 分钟：北京已经跨到 11-01，默认月份也要跟着跨月。
  const afterMidnight = calendarFocusTarget(new Date('2026-10-31T16:10:00.000Z'))
  assert.equal(afterMidnight.dateKey, '2026-11-01')
  assert.deepEqual(afterMidnight.cursor, { year: 2026, month: 11 })
})

test('monthOfDateKey：合法日期给出年月，垃圾输入返回 null（不猜月份）', () => {
  assert.deepEqual(monthOfDateKey('2026-10-12'), { year: 2026, month: 10 })
  assert.deepEqual(monthOfDateKey('2026-01-01'), { year: 2026, month: 1 })
  assert.equal(monthOfDateKey(''), null)
  assert.equal(monthOfDateKey('2026-13-01'), null)
  assert.equal(monthOfDateKey('not-a-date'), null)
})

test('从标签重新进入日历：栈里有「某一天」才归位到月视图（单层不动）', () => {
  // 只有月视图一层：不归位，用户翻月份的状态不会被清掉。
  assert.equal(shouldReturnToMonthOnTabEntry(1), false)
  assert.equal(shouldReturnToMonthOnTabEntry(0), false)
  // 栈里压着「某一天」：归位，避免回到日历还停在上次那个过去的日期。
  assert.equal(shouldReturnToMonthOnTabEntry(2), true)
  assert.equal(shouldReturnToMonthOnTabEntry(3), true)
  // 非数字（导航状态还没准备好）不动作，绝不猜。
  assert.equal(shouldReturnToMonthOnTabEntry(Number.NaN), false)
  assert.equal(shouldReturnToMonthOnTabEntry(Number.POSITIVE_INFINITY), false)
})

test('按下「日历」标签的统一动作：总是回到今天，只在栈深时归位', () => {
  // 单层月视图（例如用户翻到了别的月份后，在已选中的标签上再按一次）：
  // 导航不动，但**必须**回到今天 —— 这正是复核留下的那个缺口。
  assert.deepEqual(calendarTabEntryAction(1), { resetToToday: true, popToTop: false })
  // 栈里压着「某一天」：回到今天 + 归位到月视图。
  assert.deepEqual(calendarTabEntryAction(2), { resetToToday: true, popToTop: true })
  assert.deepEqual(calendarTabEntryAction(3), { resetToToday: true, popToTop: true })
  // 导航状态还没准备好（非数字）：仍然回到今天，但不猜栈深度、不动导航。
  assert.deepEqual(calendarTabEntryAction(Number.NaN), { resetToToday: true, popToTop: false })
  assert.deepEqual(calendarTabEntryAction(0), { resetToToday: true, popToTop: false })
})

test('标签动作与栈内浏览分开：栈内点某一天 / 返回不经过标签动作', () => {
  // 这条测试锁住语义边界：`calendarTabEntryAction` 只在**标签按下**时调用，
  // 它的返回永远是「回到今天」，因此绝不能把它接到「某一天」的焦点回调上，
  // 否则点击历史日期就会被打回今天（上一版被复核抓到的 bug）。
  for (const depth of [1, 2, 3]) {
    assert.equal(calendarTabEntryAction(depth).resetToToday, true)
  }
})

test('挂钟读数与「默认当天」在跨日瞬间保持一致（23:59 → 00:01）', () => {
  // 北京 2026-10-31 23:59（UTC 15:59）
  const before = calendarFocusTarget(new Date('2026-10-31T15:59:00.000Z'))
  assert.equal(before.dateKey, '2026-10-31')
  assert.deepEqual(before.cursor, { year: 2026, month: 10 })
  // 两分钟后进入 11 月 1 日
  const after = calendarFocusTarget(new Date('2026-10-31T16:01:00.000Z'))
  assert.equal(after.dateKey, '2026-11-01')
  assert.deepEqual(after.cursor, { year: 2026, month: 11 })
  assert.equal(after.minutes, 1)
})
