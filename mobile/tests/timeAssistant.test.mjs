// 原生时间助手：解析层（短语 + 参考时间 + 明确选择的课程 + 真实课表）。
//
// 重点覆盖三件最容易出错的事：
// 1. **时区无关**：参考时间一律按北京时间换算，手机在 UTC / 纽约时结果必须一致；
// 2. **严格的「下一次课」**：正在上的那节不算，开始时间等于参考时间也不算，最多向后 366 天；
// 3. **绝不越窗**：`下周…` 只在下个自然周里找课，找不到就如实说没有。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectMatches,
  explainNoMatch,
  findMentionedOtherCourse,
  isAlreadyElapsed,
  labelOf,
  normalizeReference,
  referenceDateKeyOf,
  resolveTimeAssistant,
} from '../src/domain/timeAssistant.ts'

/** 参考时间固定为北京时间 2026-10-13（周二）12:00 —— 与运行机器的时区无关。 */
const REFERENCE_AT = '2026-10-13T12:00:00+08:00'
/** 北京时间 2026-09-07 是周一（学期第一周周一）。 */
const SEMESTER_START = '2026-09-07'

const COURSES = [
  { id: 1, name: '数据结构', code: 'CS201' },
  { id: 2, name: '高等数学', code: 'MA101' },
]

/** 数据结构：周四 08:00，第 1–16 周，每周。 */
const DS_SCHEDULE = {
  id: 7,
  courseId: 1,
  weekday: 4,
  startTime: '08:00',
  endTime: '09:40',
  location: '教三 305',
  semesterStartDate: SEMESTER_START,
  startWeek: 1,
  endWeek: 16,
  weekPattern: 'ALL',
}

function resolve(text, extra = {}) {
  return resolveTimeAssistant({
    text,
    referenceAt: REFERENCE_AT,
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
    ...extra,
  })
}

const firstCandidate = (result) => {
  assert.equal(result.status, 'RESOLVED', `${result.status}：${result.message}`)
  const candidate = result.candidates[0]
  assert.ok(candidate, 'RESOLVED 必须给出候选时间')
  return candidate
}

/* ------------------------------ 参考时间与时区 ------------------------------ */

test('参考时间：带偏移按偏移换算，不带偏移按北京时间解释', () => {
  const shanghai = normalizeReference('2026-10-13T12:00:00+08:00')
  assert.equal(shanghai.wallClock, '2026-10-13T12:00')
  assert.equal(referenceDateKeyOf('2026-10-13T12:00:00+08:00'), '2026-10-13')

  // 同一瞬间的 UTC 写法：换算到北京时间仍然是 10-13 12:00
  assert.equal(referenceDateKeyOf('2026-10-13T04:00:00Z'), '2026-10-13')
  // UTC 的 10-12 23:00 已经是北京时间的 10-13 07:00
  assert.equal(referenceDateKeyOf('2026-10-12T23:00:00Z'), '2026-10-13')
  assert.equal(normalizeReference('2026-10-12T23:00:00Z').wallClock, '2026-10-13T07:00')
  // 不带偏移：按北京时间墙上时间，绝不按手机本地时区
  assert.equal(normalizeReference('2026-10-13 22:00').wallClock, '2026-10-13T22:00')
  assert.equal(normalizeReference('2026-02-30 22:00'), null)
  assert.equal(normalizeReference(''), null)
})

test('其他时区偏移的参考时间仍然换算到北京自然日再算「明天」', () => {
  // 纽约时间 2026-10-13 09:00（-04:00）= 北京时间 2026-10-13 21:00 → 明天是 10-14
  const result = resolveTimeAssistant({
    text: '明天 08:00',
    referenceAt: '2026-10-13T09:00:00-04:00',
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(firstCandidate(result).wallClock, '2026-10-14T08:00')

  // 纽约时间 2026-10-13 20:00（-04:00）= 北京时间 2026-10-14 08:00 → 明天是 10-15
  const resultLate = resolveTimeAssistant({
    text: '明天 08:00',
    referenceAt: '2026-10-13T20:00:00-04:00',
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(firstCandidate(resultLate).wallClock, '2026-10-15T08:00')
})

test('候选时间一律带 +08:00，标签是可读的北京时间', () => {
  const candidate = firstCandidate(resolve('明天晚上8点'))
  assert.equal(candidate.deadline, '2026-10-14T20:00:00+08:00')
  assert.equal(candidate.wallClock, '2026-10-14T20:00')
  assert.equal(candidate.label, '2026-10-14 20:00 周三')
  assert.equal(candidate.kind, 'TIME_PHRASE')
  assert.equal(candidate.courseBoundary, false)
  assert.equal(labelOf('2026-10-16T08:00'), '2026-10-16 08:00 周五')
  assert.equal(labelOf(''), '')
})

test('过去的时间照实给出，并明确提示「在参考时间之前」', () => {
  const result = resolve('今天 08:00')
  const candidate = firstCandidate(result)
  assert.equal(candidate.past, true, '08:00 早于参考时间 12:00')
  assert.ok(result.hints.some((hint) => hint.includes('参考时间之前')))
  // 将来时间不带过去提示
  assert.equal(firstCandidate(resolve('今天 22:00')).past, false)
})

test('输入不可用时给出可读提示，不产出候选', () => {
  const noReference = resolveTimeAssistant({ text: '明天 18:00', referenceAt: '不是时间' })
  assert.equal(noReference.status, 'NEEDS_INFO')
  assert.equal(noReference.candidates.length, 0)

  const empty = resolve('')
  assert.equal(empty.status, 'NEEDS_INFO')
  assert.match(empty.message, /请先写/)
})

/* ------------------------------ 课程边界 ------------------------------ */

test('「下节课前」= 参考时间之后最近的、严格晚于参考时间的课', () => {
  const candidate = firstCandidate(resolve('下节课前'))
  assert.equal(candidate.wallClock, '2026-10-15T08:00', '参考日周二 12:00 → 下一次课是周四 08:00')
  assert.equal(candidate.kind, 'COURSE_BOUNDARY')
  assert.equal(candidate.courseBoundary, true)
  assert.equal(candidate.courseId, 1)
  assert.equal(candidate.courseName, '数据结构')
  assert.equal(candidate.scheduleId, 7)
  assert.equal(candidate.scheduleDate, '2026-10-15')
  assert.equal(candidate.scheduleStartTime, '08:00')
  assert.equal(candidate.scheduleLocation, '教三 305')
  assert.match(candidate.note, /不会提前扣分钟/)
  assert.equal(candidate.deadline, '2026-10-15T08:00:00+08:00')
})

test('正在上的课不算「下一次」，开始时间等于参考时间也不算', () => {
  // 参考时间正好是周四 08:00（正在上课的那一节）→ 下一次必须是下周四
  const inProgress = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-10-15T08:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(firstCandidate(inProgress).scheduleDate, '2026-10-22', '开始时间等于参考时间不算下一次')

  // 课上到一半（08:30）→ 同样不算，取下周四
  const midClass = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-10-15T08:30:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(firstCandidate(midClass).scheduleDate, '2026-10-22')

  // 上课前一分钟 → 这一节仍然算「下一次」
  const beforeClass = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-10-15T07:59:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(firstCandidate(beforeClass).scheduleDate, '2026-10-15')
})

test('窗口内有多节时取最早的一节，并在说明里写出还有几节', () => {
  // 下周窗口里只有两条课（周四 08:00 / 周五 10:00）→ 取最早的一条
  const extra = { ...DS_SCHEDULE, id: 8, weekday: 5, startTime: '10:00', location: '教三 306' }
  const result = resolve('下周这门课前', { schedules: [extra, DS_SCHEDULE] })
  const candidate = firstCandidate(result)
  assert.equal(candidate.scheduleId, 7, '周四 08:00 早于周五 10:00')
  assert.match(candidate.note, /还有 1 节更晚的课/)
  assert.match(candidate.note, /2026-10-23 10:00/)

  // 「下节课前」是 366 天窗口，说明里会如实写出这条窗口里所有更晚的课
  const broad = firstCandidate(resolve('下节课前', { schedules: [extra, DS_SCHEDULE] }))
  assert.match(broad.note, /还有 21 节更晚的课/)
})

test('同一时刻的重复课表会去重', () => {
  const duplicate = { ...DS_SCHEDULE, id: 9 }
  const result = resolve('下周这门课前', { schedules: [DS_SCHEDULE, duplicate] })
  const candidate = firstCandidate(result)
  assert.equal(candidate.scheduleId, 7, '同一天同一时刻只保留一条')
  assert.doesNotMatch(candidate.note, /还有/, '去重之后下周窗口里只有这一节')
})

test('单双周 / 起止教学周 / 超出学期范围都按 occursOn 过滤', () => {
  // 双周课：第 1 周（09-07 起）是单周，周四 09-10 是第 1 周 → 不上；下一次是第 2 周 09-17
  const evenWeeks = { ...DS_SCHEDULE, id: 11, weekPattern: 'EVEN' }
  const evenResult = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-09-08T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [evenWeeks],
  })
  assert.equal(firstCandidate(evenResult).scheduleDate, '2026-09-17', '双周课跳过第 1 周')

  // 只在第 2 周有课：第 1 周的周四不匹配
  const onlyWeek2 = { ...DS_SCHEDULE, id: 12, startWeek: 2, endWeek: 2 }
  const rangeResult = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-09-08T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [onlyWeek2],
  })
  assert.equal(firstCandidate(rangeResult).scheduleDate, '2026-09-17')

  // 学期结束（第 16 周周日 2026-12-27 之后）→ 没有匹配
  const outOfTerm = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-12-28T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(outOfTerm.status, 'NO_COURSE_MATCH')
  assert.equal(outOfTerm.candidates.length, 0)

  // 旧课表（没有教学周信息）按每周处理
  const legacy = {
    id: 13,
    courseId: 1,
    weekday: 4,
    startTime: '08:00',
    semesterStartDate: null,
    startWeek: null,
    endWeek: null,
    weekPattern: 'ALL',
  }
  const legacyResult = resolve('下节课前', { schedules: [legacy] })
  assert.equal(firstCandidate(legacyResult).scheduleDate, '2026-10-15')
})

test('最多只向后找 366 天，超出就不给候选', () => {
  // 课表只出现在第 60 周（约 413 天之后）→ 366 天窗口内找不到
  const farAway = { ...DS_SCHEDULE, id: 14, startWeek: 60, endWeek: 60 }
  const result = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-10-13T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [farAway],
  })
  assert.equal(result.status, 'NO_COURSE_MATCH')
  assert.match(result.message, /最多 366 天/)

  // 366 天之内（第 50 周，约 343 天）仍然能找到
  const withinWindow = { ...DS_SCHEDULE, id: 15, startWeek: 50, endWeek: 50 }
  const found = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: '2026-10-13T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [withinWindow],
  })
  assert.equal(firstCandidate(found).scheduleDate, '2027-08-19')
})

test('本周 / 下周窗口严格限定，找不到就解释，绝不越周', () => {
  // 参考日 2026-10-13（周二）：下周是 10-19 ~ 10-25，数据结构周四 10-22
  const nextWeek = resolve('下周这门课前')
  assert.equal(firstCandidate(nextWeek).scheduleDate, '2026-10-22')

  // 「下周五上课前」只有 10-23 这一天，而这门课是周四 → 没有匹配，且不越周
  const dayWindow = resolve('下周五上课前')
  assert.equal(dayWindow.status, 'NO_COURSE_MATCH')
  assert.match(dayWindow.message, /下周五上课前/)
  assert.match(dayWindow.message, /当天没有课/)
  assert.ok(dayWindow.hints.some((hint) => hint.includes('不会越周')))

  // 「本周这门课前」只算参考当天及之后：本周四 10-15 在窗口内
  const thisWeek = resolve('本周这门课前')
  assert.equal(firstCandidate(thisWeek).scheduleDate, '2026-10-15')

  // 参考日 2026-10-16（周五）：本周剩下的日子（五、六、日）都没有这门课 → 没有匹配
  const thisWeekNoMatch = resolveTimeAssistant({
    text: '本周这门课前',
    referenceAt: '2026-10-16T12:00:00+08:00',
    courseId: 1,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(thisWeekNoMatch.status, 'NO_COURSE_MATCH')
  assert.match(thisWeekNoMatch.message, /不会越周/)
})

test('本周X上课前 / 下周X上课前只考虑那一天', () => {
  // 数据结构是周四：本周四 10-15 有课
  assert.equal(firstCandidate(resolve('本周四上课前')).scheduleDate, '2026-10-15')
  // 下周四 10-22 有课
  assert.equal(firstCandidate(resolve('下周四上课前')).scheduleDate, '2026-10-22')
  // 本周二（参考当天）已经 12:00，08:00 的课已经开始/结束 → 不是「下一次」
  const todayPast = resolve('本周二上课前')
  assert.equal(todayPast.status, 'NO_COURSE_MATCH')
})

test('窗口内没有课的说明按窗口类型区分（DAY / WEEK / NEXT）', () => {
  const day = explainNoMatch('数据结构', {
    scope: 'DAY',
    startDateKey: '2026-10-23',
    endDateKeyExclusive: '2026-10-24',
    phrase: '下周五上课前',
  })
  assert.match(day, /当天没有课/)

  const week = explainNoMatch('数据结构', {
    scope: 'WEEK',
    startDateKey: '2026-10-19',
    endDateKeyExclusive: '2026-10-26',
    phrase: '下周这门课前',
  })
  assert.match(week, /2026-10-19 ~ 2026-10-25/)
  assert.match(week, /不会越周/)

  const next = explainNoMatch('数据结构', {
    scope: 'NEXT',
    startDateKey: '2026-10-13',
    endDateKeyExclusive: '2027-10-14',
    phrase: '下节课前',
  })
  assert.match(next, /最多 366 天/)
})

test('没有选择课程 / 课程不存在 → 要求先明确选择，绝不替用户挑课', () => {
  const noCourse = resolve('下节课前', { courseId: null })
  assert.equal(noCourse.status, 'NEEDS_INFO')
  assert.match(noCourse.message, /需要先明确选择课程/)
  assert.equal(noCourse.candidates.length, 0)

  // 选中的课程在本机已经不存在（被删除 / 列表还没读到）→ 绝不拿空壳课程名继续算
  const deleted = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: REFERENCE_AT,
    courseId: 999,
    courses: COURSES,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(deleted.status, 'NEEDS_INFO')
  assert.equal(deleted.candidates.length, 0)
  assert.match(deleted.message, /找不到了/)

  // 连课程快照都没有（例如数据还没就绪）→ 同样拒绝
  const noList = resolveTimeAssistant({
    text: '下节课前',
    referenceAt: REFERENCE_AT,
    courseId: 1,
    schedules: [DS_SCHEDULE],
  })
  assert.equal(noList.status, 'NEEDS_INFO')
  assert.equal(noList.candidates.length, 0)

  // 文字里提到另一门课 → 要求澄清
  const mentioned = resolve('下次高等数学课前', { text: '下次高等数学课前' })
  assert.equal(mentioned.status, 'NEEDS_INFO')

  const other = findMentionedOtherCourse('下次高等数学课前', 1, COURSES)
  assert.equal(other, '高等数学')
  assert.equal(findMentionedOtherCourse('下节课前', 1, COURSES), null)
  assert.equal(findMentionedOtherCourse('CS201 的下节课前', 1, COURSES), null, '提到的是自己这门课，不算冲突')
})

test('isAlreadyElapsed 看的是真实当前时刻（与参考时间无关）', () => {
  const candidateAt = '2026-10-15T08:00'
  assert.equal(isAlreadyElapsed(candidateAt, new Date('2026-10-15T07:00:00+08:00')), false)
  assert.equal(isAlreadyElapsed(candidateAt, new Date('2026-10-15T08:00:00+08:00')), true, '正好到点就算已经过去')
  assert.equal(isAlreadyElapsed(candidateAt, new Date('2026-10-15T09:00:00+08:00')), true)
  // 同一瞬间的 UTC 写法结果一致（不受手机时区影响）
  assert.equal(isAlreadyElapsed(candidateAt, new Date('2026-10-14T23:00:00Z')), false)
  assert.equal(isAlreadyElapsed(candidateAt, new Date('2026-10-15T01:00:00Z')), true)
  assert.equal(isAlreadyElapsed('不是时间', new Date()), false)
})

test('这门课没有课表 → 明确说没有课表，不假装能算', () => {
  const noSchedules = resolve('下节课前', { schedules: [] })
  assert.equal(noSchedules.status, 'NO_COURSE_MATCH')
  assert.match(noSchedules.message, /还没有课表/)
  assert.equal(noSchedules.candidates.length, 0)
})

test('collecMatches 的窗口上限：超过 366 天的窗口会被截到 366 天', () => {
  const reference = normalizeReference(REFERENCE_AT)
  const matches = collectMatches([DS_SCHEDULE], {
    scope: 'NEXT',
    startDateKey: '2026-10-13',
    endDateKeyExclusive: '2099-01-01',
    phrase: '下节课前',
  }, reference)
  assert.equal(matches.length > 0, true)
  assert.equal(matches[0].dateKey, '2026-10-15')
  const last = matches[matches.length - 1]
  const dayDiff =
    (Date.parse(`${last.dateKey}T00:00:00Z`) - Date.parse('2026-10-13T00:00:00Z')) / 86_400_000
  assert.equal(dayDiff < 366, true, `最后一节应该在 366 天窗口内，实际 ${dayDiff} 天`)
})

/* ------------------------------ 只读性 ------------------------------ */

test('解析不改动任何输入（纯函数：schedule 对象与候选都不可变）', () => {
  const schedules = [{ ...DS_SCHEDULE }]
  const snapshot = JSON.stringify(schedules)
  const result = resolve('下节课前', { schedules })
  assert.equal(JSON.stringify(schedules), snapshot, '解析不得改动课表快照')
  result.candidates[0].note = '被测试改动'
  assert.notEqual(result.candidates[0].note, schedules[0].note)
})
