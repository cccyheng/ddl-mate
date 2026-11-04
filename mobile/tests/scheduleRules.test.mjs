// 教学周判定测试：星期匹配、学期边界、起止周范围、ALL/ODD/EVEN 相对学期首周的奇偶。
//
// 学期基准统一用 2026-09-07（周一，已核对是周一），因此第 N 周的周一是 09-07 + 7*(N-1)。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  describeWeekRangeSelection,
  describeWeekRule,
  hasApplicableWeekInRange,
  matchesWeekPattern,
  normalizeWeekPattern,
  occurringDatesInRange,
  occursOn,
  teachingWeek,
  termLastDate,
  validateTermRange,
} from '../src/domain/scheduleRules.ts'
import { addDaysToDateKey, weekdayOfDateKey } from '../src/domain/datetime.ts'

const SEMESTER_START = '2026-09-07'
/** 第 N 周周一的日期（便于把「第几周」翻译成具体日期）。 */
const mondayOfWeek = (week) => addDaysToDateKey(SEMESTER_START, (week - 1) * 7)
/** 第 N 周星期 weekday 的日期。 */
const dayOfWeek = (week, weekday) => addDaysToDateKey(mondayOfWeek(week), weekday - 1)

test('学期首周一本身必须是周一（夹具自检）', () => {
  assert.equal(weekdayOfDateKey(SEMESTER_START), 1)
})

test('teachingWeek 以学期首周一所在周为第 1 周', () => {
  assert.equal(teachingWeek(SEMESTER_START, SEMESTER_START), 1)
  assert.equal(teachingWeek(SEMESTER_START, dayOfWeek(1, 7)), 1, '第 1 周周日仍属第 1 周')
  assert.equal(teachingWeek(SEMESTER_START, dayOfWeek(2, 1)), 2, '下一周周一进入第 2 周')
  assert.equal(teachingWeek(SEMESTER_START, dayOfWeek(16, 7)), 16)
  assert.equal(teachingWeek(SEMESTER_START, dayOfWeek(17, 1)), 17, '超出学期范围时仍如实返回周序')
  assert.equal(teachingWeek(SEMESTER_START, '2026-08-31'), 0, '早于学期起点返回 0')
})

test('teachingWeek 拒绝非周一的学期起点与非法日期', () => {
  assert.equal(teachingWeek('2026-09-08', '2026-09-08'), null, '学期起点不是周一 → 无法定义教学周')
  assert.equal(teachingWeek(SEMESTER_START, '2026-02-30'), null)
  assert.equal(teachingWeek('', SEMESTER_START), null)
})

test('星期不匹配则不上课', () => {
  const schedule = { weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 16, weekPattern: 'ALL' }
  assert.equal(occursOn(schedule, dayOfWeek(1, 4)), true)
  assert.equal(occursOn(schedule, dayOfWeek(1, 3)), false, '周三不是周四的课')
  assert.equal(occursOn(schedule, dayOfWeek(1, 5)), false)
})

test('缺少教学周信息（旧数据）时按每周处理，不做周次过滤', () => {
  const legacy = { weekday: 4, semesterStartDate: null, startWeek: null, endWeek: null, weekPattern: null }
  assert.equal(occursOn(legacy, dayOfWeek(1, 4)), true)
  assert.equal(occursOn(legacy, dayOfWeek(30, 4)), true, '没有学期信息就不设边界')
  assert.equal(occursOn(legacy, dayOfWeek(30, 3)), false, '但星期仍必须匹配')
})

test('起止教学周范围生效，范围外不上课', () => {
  const schedule = { weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 3, endWeek: 5, weekPattern: 'ALL' }
  assert.equal(occursOn(schedule, dayOfWeek(2, 4)), false, '第 2 周早于起始周')
  assert.equal(occursOn(schedule, dayOfWeek(3, 4)), true, '起始周包含在内')
  assert.equal(occursOn(schedule, dayOfWeek(5, 4)), true, '结束周包含在内')
  assert.equal(occursOn(schedule, dayOfWeek(6, 4)), false, '第 6 周晚于结束周')
})

test('学期开始之前的日期一律不上课', () => {
  const schedule = { weekday: 1, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 16, weekPattern: 'ALL' }
  assert.equal(occursOn(schedule, '2026-08-31'), false, '学期前的周一不上课')
  assert.equal(occursOn(schedule, SEMESTER_START), true)
})

/* ------------------- 单双周：相对学期首周，不是 ISO 周 ------------------- */

test('ODD（单周）只保留奇数教学周', () => {
  const schedule = { weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 16, weekPattern: 'ODD' }
  for (const week of [1, 3, 5, 7, 13, 15]) {
    assert.equal(occursOn(schedule, dayOfWeek(week, 4)), true, `第 ${week} 周是奇数周，应上课`)
    assert.equal(teachingWeek(SEMESTER_START, dayOfWeek(week, 4)) % 2, 1, `第 ${week} 周周序应为奇数`)
  }
  for (const week of [2, 4, 6, 8, 14, 16]) {
    assert.equal(occursOn(schedule, dayOfWeek(week, 4)), false, `第 ${week} 周是偶数周，不应上课`)
  }
})

test('EVEN（双周）只保留偶数教学周', () => {
  const schedule = { weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 16, weekPattern: 'EVEN' }
  for (const week of [2, 4, 6, 8, 14, 16]) {
    assert.equal(occursOn(schedule, dayOfWeek(week, 4)), true, `第 ${week} 周是偶数周，应上课`)
  }
  for (const week of [1, 3, 5, 15]) {
    assert.equal(occursOn(schedule, dayOfWeek(week, 4)), false, `第 ${week} 周是奇数周，不应上课`)
  }
})

test('单双周奇偶相对学期首周，而不是 ISO 自然周', () => {
  // 2026-09-07 所在 ISO 周是第 37 周（奇数），若误用 ISO 周奇偶，第 1 教学周会被算成"单周"而
  // 第 2 教学周（ISO 第 38 周）被算成"双周"——恰好在起点处与教学周奇偶一致，因此需要
  // 用一个学期起点落在 ISO 偶数周的学期来区分两者。
  const isoEvenStart = '2026-09-14' // 2026 年的第 38 个 ISO 周（偶数）
  assert.equal(weekdayOfDateKey(isoEvenStart), 1, '基准日必须是周一')

  const odd = { weekday: 1, semesterStartDate: isoEvenStart, startWeek: 1, endWeek: 4, weekPattern: 'ODD' }
  // 教学周第 1 周 = 09-14；它的 ISO 周号是 38（偶数）。
  // 按教学周奇偶应为「单周 → 上课」；若错误地按 ISO 周奇偶就会判成「不上课」。
  assert.equal(teachingWeek(isoEvenStart, '2026-09-14'), 1)
  assert.equal(occursOn(odd, '2026-09-14'), true, '教学周第 1 周必须按奇数周处理，与 ISO 周号无关')
  assert.equal(occursOn(odd, '2026-09-21'), false, '教学周第 2 周是偶数周')
  assert.equal(occursOn(odd, '2026-09-28'), true, '教学周第 3 周是奇数周')
})

test('单双周与起止周范围叠加时同时生效', () => {
  const schedule = { weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 5, endWeek: 9, weekPattern: 'EVEN' }
  assert.equal(occursOn(schedule, dayOfWeek(4, 4)), false, '第 4 周在范围外（且为偶数周）')
  assert.equal(occursOn(schedule, dayOfWeek(5, 4)), false, '第 5 周在范围内但是奇数周，双周规则排除')
  assert.equal(occursOn(schedule, dayOfWeek(6, 4)), true, '第 6 周在范围内且为偶数周')
  assert.equal(occursOn(schedule, dayOfWeek(8, 4)), true)
  assert.equal(occursOn(schedule, dayOfWeek(9, 4)), false, '第 9 周是奇数周')
  assert.equal(occursOn(schedule, dayOfWeek(10, 4)), false, '第 10 周超出结束周')
})

test('normalizeWeekPattern 把未知值按 ALL 处理，与后端 null → ALL 一致', () => {
  assert.equal(normalizeWeekPattern('ODD'), 'ODD')
  assert.equal(normalizeWeekPattern('even'), 'EVEN', '大小写不敏感')
  assert.equal(normalizeWeekPattern(null), 'ALL')
  assert.equal(normalizeWeekPattern(''), 'ALL')
  assert.equal(normalizeWeekPattern('WEEKLY'), 'ALL', '无法识别的值不猜')
  assert.equal(matchesWeekPattern(3, 'ODD'), true)
  assert.equal(matchesWeekPattern(3, 'EVEN'), false)
  assert.equal(matchesWeekPattern(3, null), true)
})

/* ------------------------- 学期范围校验 ------------------------- */

test('教学周校验：全空表示旧数据兼容，不算错误', () => {
  const result = validateTermRange({ semesterStartDate: '', startWeek: '', endWeek: '' })
  assert.equal(result.ok, true)
  assert.equal(result.semesterStartDate, null)
  assert.equal(result.startWeek, null)
})

test('教学周校验：只填一半一律拒绝，绝不猜另一侧', () => {
  const onlyStart = validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '', endWeek: '' })
  assert.equal(onlyStart.ok, false)
  assert.match(onlyStart.message, /起始周与结束周必须同时填写/)

  const noStart = validateTermRange({ semesterStartDate: '', startWeek: '1', endWeek: '16' })
  assert.equal(noStart.ok, false)
  assert.match(noStart.message, /学期第一周周一/)
})

test('教学周校验：学期首周一必须是真实存在的周一', () => {
  const notMonday = validateTermRange({ semesterStartDate: '2026-09-08', startWeek: '1', endWeek: '16' })
  assert.equal(notMonday.ok, false)
  assert.match(notMonday.message, /必须是周一/)

  const notReal = validateTermRange({ semesterStartDate: '2026-02-30', startWeek: '1', endWeek: '16' })
  assert.equal(notReal.ok, false)
  assert.match(notReal.message, /不是真实存在的日期/)

  const good = validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '1', endWeek: '16' })
  assert.equal(good.ok, true)
  assert.equal(good.startWeek, 1)
  assert.equal(good.endWeek, 16)
})

test('教学周校验：范围必须 1 ≤ 起始 ≤ 结束 ≤ 53', () => {
  assert.equal(validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '0', endWeek: '16' }).ok, false)
  assert.equal(validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '10', endWeek: '5' }).ok, false, '起始不能大于结束')
  assert.equal(validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '1', endWeek: '54' }).ok, false)
  assert.equal(validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: 'abc', endWeek: '16' }).ok, false)
  assert.equal(validateTermRange({ semesterStartDate: SEMESTER_START, startWeek: '1', endWeek: '53' }).ok, true)
})

test('单双周在范围内至少要有一周可上，不能保存成空规则', () => {
  assert.equal(hasApplicableWeekInRange(1, 1, 'ODD'), true)
  assert.equal(hasApplicableWeekInRange(1, 1, 'EVEN'), false)
  assert.equal(hasApplicableWeekInRange(2, 2, 'ODD'), false)
  assert.equal(hasApplicableWeekInRange(2, 2, 'EVEN'), true)
  assert.equal(hasApplicableWeekInRange(3, 4, 'ODD'), true)
  assert.equal(hasApplicableWeekInRange(3, 4, 'EVEN'), true)
  assert.equal(hasApplicableWeekInRange(5, 5, 'EVEN'), false)
  assert.equal(hasApplicableWeekInRange(1, 16, 'ALL'), true)
  assert.equal(hasApplicableWeekInRange(1, 16, null), true, '空值按每周处理')
  assert.equal(hasApplicableWeekInRange(0, 1, 'ALL'), false, '范围本身非法时不算有可上课的周')
  assert.equal(hasApplicableWeekInRange(9, 3, 'ALL'), false)
})

test('教学周校验：范围与单双周叠加后没有可上课的周 → 明确拒绝，不扩展范围', () => {
  const singleOdd = validateTermRange({
    semesterStartDate: SEMESTER_START,
    startWeek: '7',
    endWeek: '7',
    weekPattern: 'ODD',
  })
  assert.equal(singleOdd.ok, true, '第 7 周 + 单周有课')

  const singleEven = validateTermRange({
    semesterStartDate: SEMESTER_START,
    startWeek: '7',
    endWeek: '7',
    weekPattern: 'EVEN',
  })
  assert.equal(singleEven.ok, false)
  assert.match(singleEven.message, /没有双周的周次/)
  assert.match(singleEven.message, /改成“每周”/)
  assert.equal(singleEven.startWeek, null, '校验结果不替用户猜一个可用范围')

  const oddOnly = validateTermRange({
    semesterStartDate: SEMESTER_START,
    startWeek: '2',
    endWeek: '2',
    weekPattern: 'ODD',
  })
  assert.equal(oddOnly.ok, false)
  assert.match(oddOnly.message, /没有单周的周次/)

  assert.equal(
    validateTermRange({
      semesterStartDate: SEMESTER_START,
      startWeek: '2',
      endWeek: '12',
      weekPattern: 'EVEN',
    }).ok,
    true,
    '范围内有偶数周时双周规则合法',
  )
})

test('周次摘要显示起止与单双周；未选全/无效/无可用周次都说清楚', () => {
  assert.equal(describeWeekRangeSelection('1', '16', 'ALL'), '第 1–16 周 · 每周')
  assert.equal(describeWeekRangeSelection('7', '7', 'ODD'), '第 7 周 · 单周')
  assert.equal(describeWeekRangeSelection('3', '18', 'EVEN'), '第 3–18 周 · 双周')
  assert.equal(describeWeekRangeSelection('', '16', 'ALL'), '还没有选择完整的起止周')
  assert.equal(describeWeekRangeSelection('1', '', 'ALL'), '还没有选择完整的起止周')
  assert.equal(describeWeekRangeSelection('9', '3', 'ALL'), '第 9–3 周 · 范围无效')
  assert.equal(
    describeWeekRangeSelection('7', '7', 'EVEN'),
    '第 7 周 · 双周（没有可上课的周次）',
    '空规则必须在摘要里直接暴露',
  )
})

test('termLastDate 给出学期最后一天（结束周的第 7 天）', () => {
  assert.equal(termLastDate(SEMESTER_START, 16), '2026-12-27', '第 16 周周日')
  assert.equal(termLastDate('2026-09-08', 16), null, '非周一返回 null')
  assert.equal(termLastDate(SEMESTER_START, 0), null)
})

/* ------------------------- 辅助函数 ------------------------- */

test('occurringDatesInRange 只返回真实上课日期', () => {
  const schedule = { weekday: 1, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 3, weekPattern: 'ODD' }
  const dates = occurringDatesInRange(schedule, SEMESTER_START, '2026-09-28')
  assert.deepEqual(dates, ['2026-09-07', '2026-09-21'], '第 1、3 周周一，第 2 周被单周规则排除')
})

test('describeWeekRule 输出人话，旧数据明确标注', () => {
  assert.equal(
    describeWeekRule({ weekday: 4, semesterStartDate: SEMESTER_START, startWeek: 1, endWeek: 16, weekPattern: 'ODD' }),
    '周四 · 第 1-16 周 · 单周',
  )
  assert.equal(
    describeWeekRule({ weekday: 4, semesterStartDate: null, startWeek: null, endWeek: null, weekPattern: null }),
    '周四 · 每周（未设置教学周）',
  )
})
