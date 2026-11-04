// 课表冲突检查（纯函数）测试：重叠语义、教学周、14 天窗口、坏数据与稳定输出。
//
// 固定学期首周一 2026-09-07（已核对是周一）；第 N 周周一是 09-07 + 7*(N-1)。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCourseConflicts,
  COURSE_CONFLICTS_WINDOW_DAYS,
} from '../src/domain/courseConflicts.ts'
import { addDaysToDateKey, weekdayOfDateKey } from '../src/domain/datetime.ts'

const SEMESTER_START = '2026-09-07'

const dateOfWeek = (week, weekday) => addDaysToDateKey(SEMESTER_START, (week - 1) * 7 + (weekday - 1))

function course(id, name, instructor = null) {
  return {
    id,
    code: `AUTO-${id}`,
    name,
    instructor,
    semester: null,
    color: null,
    note: null,
    selectionSerial: null,
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
  }
}

function schedule(id, courseId, overrides = {}) {
  return {
    id,
    courseId,
    weekday: 1,
    startTime: '08:00',
    endTime: '09:00',
    location: null,
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
    createdAt: '2026-01-01T00:00:00+08:00',
    updatedAt: '2026-01-01T00:00:00+08:00',
    ...overrides,
  }
}

function build(schedules, courses = [course(1, '高等数学', '张老师')], fromDateKey = SEMESTER_START) {
  return buildCourseConflicts({ schedules, courses, fromDateKey })
}

test('夹具自检：基准日是周一，14 天窗口含首尾', () => {
  assert.equal(weekdayOfDateKey(SEMESTER_START), 1)
  assert.equal(COURSE_CONFLICTS_WINDOW_DAYS, 14)
  const result = build([schedule(1, 1), schedule(2, 1)])
  assert.equal(result.status, 'ok')
  assert.equal(result.fromDateKey, '2026-09-07')
  assert.equal(result.toDateKey, '2026-09-20')
  assert.equal(result.windowDays, 14)
  assert.equal(result.pairCount, 2, '两个周一都在窗口内')
  assert.deepEqual(result.conflictDates, ['2026-09-07', '2026-09-14'])
})

test('严格重叠：相邻不算冲突', () => {
  const result = build([
    schedule(1, 1, { startTime: '08:00', endTime: '09:00' }),
    schedule(2, 1, { startTime: '09:00', endTime: '10:00' }),
  ])
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 0)
  assert.equal(result.dateCount, 0)
})

test('部分重叠：给出重叠区间与分钟数', () => {
  const result = build([
    schedule(2, 1, { startTime: '09:00', endTime: '11:00' }),
    schedule(1, 1, { startTime: '08:00', endTime: '10:00' }),
  ])
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 2)
  for (const pair of result.pairs) {
    assert.equal(pair.overlapStart, '09:00')
    assert.equal(pair.overlapEnd, '10:00')
    assert.equal(pair.overlapMinutes, 60)
    assert.equal(pair.left.scheduleId, 1, '两条记录按课表 id 升序排列')
    assert.equal(pair.right.scheduleId, 2)
  }
})

test('包含：大段包住小段，只重叠小段', () => {
  const result = build([
    schedule(1, 1, { startTime: '08:00', endTime: '12:00' }),
    schedule(2, 1, { startTime: '09:00', endTime: '10:00' }),
  ])
  assert.equal(result.pairCount, 2)
  for (const pair of result.pairs) {
    assert.equal(pair.overlapStart, '09:00')
    assert.equal(pair.overlapEnd, '10:00')
    assert.equal(pair.overlapMinutes, 60)
  }
})

test('完全相同：两条同一时段的记录只报一对/天', () => {
  const result = build([
    schedule(1, 1, { startTime: '08:00', endTime: '09:30' }),
    schedule(2, 1, { startTime: '08:00', endTime: '09:30' }),
  ])
  assert.equal(result.pairCount, 2, '窗口内有两个周一')
  assert.equal(result.dateCount, 2)
  for (const pair of result.pairs) {
    assert.equal(pair.overlapMinutes, 90)
    assert.deepEqual(pair.left.startTime, pair.right.startTime)
  }
})

test('三条课表同时重叠：报告全部 3 对，日期只算 1 天', () => {
  const result = build([
    schedule(1, 1, { startTime: '08:00', endTime: '11:00' }),
    schedule(2, 1, { startTime: '09:00', endTime: '12:00' }),
    schedule(3, 1, { startTime: '10:00', endTime: '13:00' }),
  ])
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 3 * 2, '窗口内两个周一，每个周一 3 对')
  assert.equal(result.dateCount, 2)
  const firstDay = result.pairs.filter((pair) => pair.dateKey === '2026-09-07')
  assert.equal(firstDay.length, 3)
  assert.deepEqual(
    firstDay.map((pair) => pair.key),
    ['2026-09-07|1|2', '2026-09-07|1|3', '2026-09-07|2|3'],
  )
  assert.equal(firstDay[0].overlapMinutes, 120, '08–11 与 09–12 重叠 2 小时')
  assert.equal(firstDay[1].overlapMinutes, 60, '08–11 与 10–13 重叠 1 小时')
  assert.equal(firstDay[2].overlapMinutes, 120, '09–12 与 10–13 重叠 2 小时')
})

test('同一门课的两条不同课表记录也算冲突', () => {
  const result = build([
    schedule(11, 7, { startTime: '08:00', endTime: '10:00' }),
    schedule(12, 7, { startTime: '09:00', endTime: '11:00' }),
  ], [course(7, '大学英语', '李老师')])
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 2)
  assert.equal(result.pairs[0].left.courseId, 7)
  assert.equal(result.pairs[0].right.courseId, 7)
  assert.equal(result.pairs[0].left.courseName, '大学英语')
})

test('不报自己和自己：单条课表 / 重复同 id 的输入都不产生自冲突', () => {
  const single = build([schedule(1, 1)])
  assert.equal(single.pairCount, 0)
  assert.equal(single.validScheduleCount, 1)

  const sameIdTwice = build([
    schedule(1, 1, { startTime: '08:00', endTime: '10:00' }),
    schedule(1, 1, { startTime: '08:00', endTime: '10:00' }),
  ])
  assert.equal(sameIdTwice.pairCount, 0, '同 id 不和自己配对')
})

test('单双周：ODD / EVEN 在真实日期上互不重叠', () => {
  const odd = schedule(1, 1, {
    semesterStartDate: SEMESTER_START,
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'ODD',
  })
  const even = schedule(2, 1, {
    semesterStartDate: SEMESTER_START,
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'EVEN',
  })
  // 窗口 09-07..09-20 覆盖教学周 1（单）与第 2 周（双），两条课永远不同天。
  const disjoint = build([odd, even])
  assert.equal(disjoint.status, 'ok')
  assert.equal(disjoint.pairCount, 0)
  assert.equal(disjoint.warnings.length, 0)

  // 同一种周次规律、真实同一周：必须报冲突。
  const bothOdd = build([odd, { ...odd, id: 3 }])
  assert.equal(bothOdd.pairCount, 1, '窗口内只有第 1 教学周是单周')
  assert.deepEqual(bothOdd.conflictDates, ['2026-09-07'])
})

test('显式起止周 / 不连续的分段范围按实际日期生效', () => {
  const early = schedule(1, 1, {
    semesterStartDate: SEMESTER_START,
    startWeek: 1,
    endWeek: 2,
    weekPattern: 'ALL',
  })
  const late = schedule(2, 1, {
    semesterStartDate: SEMESTER_START,
    startWeek: 5,
    endWeek: 6,
    weekPattern: 'ALL',
  })
  // 09-07 起只覆盖第 1、2 周：late 完全不在窗口内，因此没有冲突。
  assert.equal(build([early, late]).pairCount, 0)

  // 从第 4 周周一起覆盖第 4、5 周：late 在第 5 周上课，与同样第 5 周有课的第三条重叠。
  const weekFive = schedule(3, 1, {
    semesterStartDate: SEMESTER_START,
    startWeek: 5,
    endWeek: 7,
    weekPattern: 'ALL',
  })
  const later = build([late, weekFive], [course(1, '高等数学')], dateOfWeek(4, 1))
  assert.equal(later.status, 'ok')
  assert.deepEqual(later.conflictDates, [dateOfWeek(5, 1)])
  assert.equal(later.pairCount, 1)
})

test('学期开始前 / 结束后 / 范围外都不上课，不产生冲突', () => {
  const pair = [
    schedule(1, 1, {
      semesterStartDate: SEMESTER_START,
      startWeek: 1,
      endWeek: 1,
      weekPattern: 'ALL',
    }),
    schedule(2, 1, {
      semesterStartDate: SEMESTER_START,
      startWeek: 1,
      endWeek: 1,
      weekPattern: 'ALL',
    }),
  ]
  // 08-24..09-06 完全在学期开始前。
  assert.equal(build(pair, undefined, '2026-08-24').pairCount, 0)
  // 09-14..09-27 完全在第 1 周之后（结束周 = 1）。
  assert.equal(build(pair, undefined, '2026-09-14').pairCount, 0)
  // 09-07 所在周正好在范围内。
  assert.equal(build(pair, undefined, '2026-09-07').pairCount, 1)

  const outside = [
    schedule(3, 1, { semesterStartDate: SEMESTER_START, startWeek: 3, endWeek: 4 }),
    schedule(4, 1, { semesterStartDate: SEMESTER_START, startWeek: 3, endWeek: 4 }),
  ]
  assert.equal(build(outside, undefined, '2026-09-07').pairCount, 0, '第 1、2 周不在第 3–4 周范围内')
})

test('跨月 / 跨年 / 闰日：日期按上海自然日连续推进', () => {
  const monthPair = [
    schedule(1, 1, { weekday: 4 }),
    schedule(2, 1, { weekday: 4 }),
  ]
  assert.equal(weekdayOfDateKey('2026-10-01'), 4)
  const month = build(monthPair, undefined, '2026-09-28')
  assert.equal(month.toDateKey, '2026-10-11')
  assert.deepEqual(month.conflictDates, ['2026-10-01', '2026-10-08'])

  const yearPair = [
    schedule(3, 1, { weekday: 5 }),
    schedule(4, 1, { weekday: 5 }),
  ]
  assert.equal(weekdayOfDateKey('2027-01-01'), 5)
  const year = build(yearPair, undefined, '2026-12-28')
  assert.equal(year.toDateKey, '2027-01-10')
  assert.deepEqual(year.conflictDates, ['2027-01-01', '2027-01-08'])

  const leapPair = [
    schedule(5, 1, { weekday: 2 }),
    schedule(6, 1, { weekday: 2 }),
  ]
  assert.equal(weekdayOfDateKey('2028-02-29'), 2)
  const leap = build(leapPair, undefined, '2028-02-21')
  assert.equal(leap.toDateKey, '2028-03-05')
  assert.ok(leap.conflictDates.includes('2028-02-29'))
  assert.equal(leap.pairCount, leap.conflictDates.length, '每个冲突日期一对')
})

test('14 天窗口首尾都包含，第 15 天不在结果里', () => {
  const mondayPair = [
    schedule(1, 1, { weekday: 1 }),
    schedule(2, 1, { weekday: 1 }),
  ]
  const sundayPair = [
    schedule(3, 1, { weekday: 7 }),
    schedule(4, 1, { weekday: 7 }),
  ]
  const result = build([...mondayPair, ...sundayPair])
  assert.equal(result.toDateKey, '2026-09-20')
  assert.ok(result.conflictDates.includes('2026-09-07'), '第 1 天（含）')
  assert.ok(result.conflictDates.includes('2026-09-20'), '第 14 天（含）')
  assert.equal(result.conflictDates.includes('2026-09-21'), false, '第 15 天不在窗口内')
  for (const pair of result.pairs) {
    assert.ok(pair.dateKey >= result.fromDateKey && pair.dateKey <= result.toDateKey)
  }
})

test('无效时间 / 星期 / 教学周逐条跳过并给出原因，绝不猜', () => {
  const schedules = [
    schedule(1, 1, { startTime: '25:00' }),
    schedule(2, 1, { startTime: '09:00', endTime: '09:00' }),
    schedule(3, 1, { startTime: '10:00', endTime: '09:00' }),
    schedule(4, 1, { weekday: 8 }),
    schedule(5, 1, { semesterStartDate: SEMESTER_START }),
    schedule(6, 1, {
      semesterStartDate: SEMESTER_START,
      startWeek: 5,
      endWeek: 3,
    }),
    schedule(7, 1, {
      semesterStartDate: '2026-09-08',
      startWeek: 1,
      endWeek: 4,
    }),
    schedule(8, 1, { weekPattern: 'WEEKLY' }),
    schedule(9, 1, { startWeek: 1, endWeek: 4 }),
    null,
  ]
  const result = build(schedules)
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 0)
  assert.equal(result.validScheduleCount, 0)
  assert.equal(result.skippedCount, schedules.length)
  assert.equal(result.warnings.length, schedules.length)
  assert.equal(result.hasIncompleteData, true)

  const kinds = new Set(result.warnings.map((warning) => warning.kind))
  assert.ok(kinds.has('INVALID_TIME'))
  assert.ok(kinds.has('INVALID_WEEKDAY'))
  assert.ok(kinds.has('INVALID_WEEK_RULE'))
  assert.ok(kinds.has('INVALID_RECORD'))
  for (const warning of result.warnings) {
    assert.ok(warning.message.length > 0, '每条跳过都要有可展示的原因')
  }
})

test('非零秒不能被静默截断；HH:mm:ss 只接受 00 秒', () => {
  const rejected = build([
    schedule(1, 1, { startTime: '08:00:99' }),
    schedule(2, 1, { startTime: '08:00:30' }),
    schedule(3, 1, { startTime: '08:00:00' }),
  ])
  assert.equal(rejected.status, 'ok')
  assert.equal(rejected.validScheduleCount, 1, ':00 是合法旧数据')
  assert.equal(rejected.skippedCount, 2)
  assert.ok(rejected.warnings.every((warning) => warning.kind === 'INVALID_TIME'))

  const accepted = build([
    schedule(1, 1, { startTime: '8:00', endTime: '09:00:00' }),
    schedule(2, 1, { startTime: '08:30', endTime: '09:30' }),
  ])
  assert.equal(accepted.warnings.length, 0, 'H:mm 与 00 秒都应接受')
  assert.equal(accepted.pairCount, 2)
  assert.equal(accepted.pairs[0].overlapMinutes, 30)
})

test('非文本单双周值必须报无效，不能当成每周', () => {
  for (const raw of [7, false, true, {}, []]) {
    const result = build([schedule(1, 1, { weekPattern: raw }), schedule(2, 1)])
    assert.equal(result.skippedCount, 1, `weekPattern=${JSON.stringify(raw)} 必须被跳过`)
    assert.equal(result.validScheduleCount, 1)
    assert.equal(result.pairCount, 0)
    assert.equal(result.warnings[0].kind, 'INVALID_WEEK_RULE')
  }
})

test('课表 id 必须是正整数；无效课程 id 按缺失处理且不匹配坏课程', () => {
  for (const id of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = build([schedule(id, 1), schedule(2, 1)])
    assert.equal(result.skippedCount, 1, `课表 id=${id} 必须被跳过`)
    assert.equal(result.pairCount, 0)
    assert.equal(result.warnings[0].kind, 'INVALID_RECORD')
  }

  const badCourse = build(
    [
      schedule(1, 0, { startTime: '08:00', endTime: '10:00' }),
      schedule(2, 1.5, { startTime: '09:00', endTime: '11:00' }),
    ],
    [course(0, '编号为零的课'), course(1.5, '小数编号的课')],
  )
  assert.equal(badCourse.status, 'ok')
  assert.equal(badCourse.pairCount, 2, '课表本身有效，只是课程缺失，仍参与比较')
  assert.equal(badCourse.missingCourseCount, 2)
  for (const pair of badCourse.pairs) {
    assert.equal(pair.left.course, null)
    assert.equal(pair.right.course, null)
    assert.equal(pair.left.courseMissing, true)
    assert.equal(pair.right.courseMissing, true)
    assert.equal(pair.left.courseId, null)
    assert.equal(pair.right.courseId, null)
  }
})

test('旧数据教学周全空仍按每周上课；部分填写才报无效', () => {
  const legacy = build([
    schedule(1, 1, { weekPattern: null }),
    schedule(2, 1, { weekPattern: null }),
  ])
  assert.equal(legacy.status, 'ok')
  assert.equal(legacy.warnings.length, 0, '全空是既有旧数据语义，不是坏数据')
  assert.equal(legacy.pairCount, 2)

  const partial = build([
    schedule(1, 1, { semesterStartDate: SEMESTER_START }),
    schedule(2, 1, { semesterStartDate: SEMESTER_START }),
  ])
  assert.equal(partial.pairCount, 0)
  assert.equal(partial.warnings.length, 2)
  assert.ok(partial.warnings.every((warning) => warning.kind === 'INVALID_WEEK_RULE'))
})

test('缺失课程：仍按课表参与检测，显示安全兜底名并标记不完整', () => {
  const result = build([
    schedule(1, 1, { startTime: '08:00', endTime: '10:00' }),
    schedule(2, 999, { startTime: '09:00', endTime: '11:00' }),
  ])
  assert.equal(result.status, 'ok')
  assert.equal(result.pairCount, 2)
  assert.equal(result.missingCourseCount, 1)
  assert.equal(result.hasIncompleteData, true)
  assert.equal(result.warnings.length, 0, '课程缺失不是跳过课表的理由')
  const missing = result.pairs[0].right
  assert.equal(missing.courseMissing, true)
  assert.equal(missing.course, null)
  assert.match(missing.courseName, /未知课程/)
  assert.equal(result.pairs[0].left.courseMissing, false)
})

test('起点日期非法：明确 unavailable，不是「0 个冲突」', () => {
  for (const fromDateKey of ['', '2026-02-30', '2026-9-7', 'not-a-date']) {
    const result = build([schedule(1, 1), schedule(2, 1)], undefined, fromDateKey)
    assert.equal(result.status, 'unavailable', `起点 ${JSON.stringify(fromDateKey)} 必须不可用`)
    assert.equal(result.pairCount, 0)
    assert.equal(result.fromDateKey, null)
    assert.equal(result.toDateKey, null)
    assert.equal(result.hasIncompleteData, true)
    assert.match(result.reason, /不是「没有冲突」/)
  }
})

test('排序稳定：输入顺序不影响输出；日期 → 重叠开始 → 课表 id', () => {
  const base = [
    schedule(30, 1, { startTime: '10:00', endTime: '11:00' }),
    schedule(10, 1, { startTime: '08:00', endTime: '10:00' }),
    schedule(20, 1, { startTime: '09:00', endTime: '12:00' }),
    schedule(40, 1, { weekday: 7, startTime: '08:00', endTime: '09:00' }),
    schedule(50, 1, { weekday: 7, startTime: '08:30', endTime: '09:30' }),
  ]
  const first = build(base)
  const second = build([...base].reverse())
  assert.deepEqual(
    second.pairs.map((pair) => pair.key),
    first.pairs.map((pair) => pair.key),
  )
  assert.deepEqual(
    first.pairs.map((pair) => [pair.dateKey, pair.overlapStart, pair.left.scheduleId, pair.right.scheduleId]),
    [...first.pairs]
      .sort((left, right) => {
        if (left.dateKey !== right.dateKey) return left.dateKey.localeCompare(right.dateKey)
        if (left.overlapStartMinutes !== right.overlapStartMinutes) {
          return left.overlapStartMinutes - right.overlapStartMinutes
        }
        if (left.left.scheduleId !== right.left.scheduleId) {
          return left.left.scheduleId - right.left.scheduleId
        }
        return left.right.scheduleId - right.right.scheduleId
      })
      .map((pair) => [pair.dateKey, pair.overlapStart, pair.left.scheduleId, pair.right.scheduleId]),
  )
})

test('不修改输入：课表 / 课程对象与数组顺序原样保留', () => {
  const schedules = [
    schedule(2, 1, { startTime: '09:00', endTime: '11:00' }),
    schedule(1, 1, { startTime: '08:00', endTime: '10:00' }),
  ]
  const courses = [course(2, '线性代数'), course(1, '高等数学')]
  const schedulesBefore = JSON.stringify(schedules)
  const coursesBefore = JSON.stringify(courses)
  const scheduleOrderBefore = schedules.map((item) => item.id)
  const courseOrderBefore = courses.map((item) => item.id)

  const result = build(schedules, courses)
  assert.equal(result.pairCount, 2)
  assert.equal(JSON.stringify(schedules), schedulesBefore)
  assert.equal(JSON.stringify(courses), coursesBefore)
  assert.deepEqual(schedules.map((item) => item.id), scheduleOrderBefore)
  assert.deepEqual(courses.map((item) => item.id), courseOrderBefore)
})
