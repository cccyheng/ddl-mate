// 课表 OCR 解析器测试（node --test，无需浏览器、无需网络）。
//
// 覆盖：真实样例图（.supervision/timetable-grid.png、timetable-list.png）的版面 fixture、
// 单双周/教学周、缺字段不臆测、异常输入、框选区域模式。
// 注意：这里测的是"解析 OCR 结果"这一层；真实 OCR 本身由浏览器里的照片导入页验证。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  flattenOcrLines,
  parseTimetable,
  extractSemesterStart,
  extractTime,
  extractWeeks,
  extractWeekday,
  extractLocation,
  extractTeacher,
  isMonday,
  normalize,
  parseRegion,
} from '../src/ocr/timetableParser.js'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'))

const gridFixture = load('timetable-grid-lines.json')
const listFixture = load('timetable-list-lines.json')
// 真实 OCR 输出快照（PSM 11）：验证"真实图片的真实识别结果"也能被正确解析
const gridRealFixture = load('timetable-grid-real-ocr-lines.json')
const listRealFixture = load('timetable-list-real-ocr-lines.json')

test('真实 OCR（表格样图）：相邻两门课不会被合并，还原成 3 条独立候选', () => {
  const result = parseTimetable(flattenOcrLines({ lines: gridRealFixture.lines }))

  assert.equal(result.layout, 'grid')
  assert.equal(result.semesterStartDate, '2026-09-07')
  assert.equal(result.candidates.length, 3, '表格里的三门课必须各自成为一条候选')

  const byName = Object.fromEntries(result.candidates.map((item) => [item.name, item]))
  assert.ok(byName['高等数学'], '应有 高等数学')
  assert.ok(byName['数据结构'], '应有 数据结构')
  assert.ok(byName['大学英语'], '应有 大学英语')

  // 相邻两门课不能被并成一门
  assert.equal(byName['高等数学'].weekday, 1)
  assert.equal(byName['数据结构'].weekday, 2)
  assert.equal(byName['高等数学'].startWeek, 1)
  assert.equal(byName['高等数学'].endWeek, 16)
  assert.equal(byName['高等数学'].weekPattern, 'ODD')
  assert.equal(byName['数据结构'].weekPattern, 'EVEN')
  assert.equal(byName['高等数学'].location, '教一101')
  assert.equal(byName['数据结构'].location, '教二203')
  assert.equal(byName['高等数学'].startTime, '08:00')
  assert.equal(byName['高等数学'].endTime, '09:40')

  // 该图周三表头没被识别出来：推断出的列必须标记出来并要求人工确认
  assert.equal(byName['大学英语'].weekday, 3)
  assert.equal(byName['大学英语'].weekdayInferred, true)
  assert.ok(byName['大学英语'].warnings.some((text) => text.includes('推断')))
  assert.equal(byName['高等数学'].weekdayInferred, undefined)
})

test('真实 OCR（列表样图）：三条课程信息完整且不串列', () => {
  const result = parseTimetable(flattenOcrLines({ lines: listRealFixture.lines }))
  assert.equal(result.candidates.length, 3)
  const byWeekday = Object.fromEntries(result.candidates.map((item) => [item.weekday, item]))
  assert.equal(byWeekday[1].name, '高等数学')
  assert.equal(byWeekday[1].location, '教一101')
  assert.equal(byWeekday[1].weekPattern, 'ODD')
  assert.equal(byWeekday[2].name, '数据结构')
  assert.equal(byWeekday[2].weekPattern, 'EVEN')
  assert.equal(byWeekday[3].name, '大学英语')
  assert.equal(byWeekday[3].weekPattern, 'ALL')
  assert.equal(byWeekday[3].startTime, '14:00')
})

test('表格版课表 fixture：识别出 3 门课，星期/时间/节次/地点/周次都对', () => {
  const lines = flattenOcrLines(gridFixture)
  const result = parseTimetable(lines)

  assert.equal(result.layout, 'grid')
  assert.equal(result.semesterStartDate, '2026-09-07')
  assert.equal(result.candidates.length, 3)

  const byName = Object.fromEntries(result.candidates.map((item) => [item.name, item]))

  const math = byName['高等数学']
  assert.ok(math, '应识别出 高等数学')
  assert.equal(math.weekday, 1)
  assert.equal(math.startTime, '08:00')
  assert.equal(math.endTime, '09:40')
  assert.equal(math.periodStart, 1)
  assert.equal(math.periodEnd, 2)
  assert.equal(math.startWeek, 1)
  assert.equal(math.endWeek, 16)
  assert.equal(math.weekPattern, 'ODD')
  assert.equal(math.location, '教一101')
  assert.equal(math.teacher, '王老师')
  assert.deepEqual(math.warnings, [])

  const data = byName['数据结构']
  assert.ok(data, '应识别出 数据结构')
  assert.equal(data.weekday, 2)
  assert.equal(data.weekPattern, 'EVEN')
  assert.equal(data.location, '教二203')

  const english = byName['大学英语']
  assert.ok(english, '应识别出 大学英语')
  assert.equal(english.weekday, 3)
  assert.equal(english.startTime, '14:00')
  assert.equal(english.endTime, '15:40')
  assert.equal(english.periodStart, 5)
  assert.equal(english.periodEnd, 6)
  // 图片里只写了「1-16周」→ 按每周，不臆测单双
  assert.equal(english.weekPattern, 'ALL')
  assert.equal(english.location, '教三305')
})

test('列表版课表 fixture：一行一门课，三种周次规律都识别', () => {
  const lines = flattenOcrLines(listFixture)
  const result = parseTimetable(lines)

  assert.equal(result.layout, 'list')
  assert.equal(result.candidates.length, 3)

  const byWeekday = Object.fromEntries(result.candidates.map((item) => [item.weekday, item]))
  assert.equal(byWeekday[1].name, '高等数学')
  assert.equal(byWeekday[1].weekPattern, 'ODD')
  assert.equal(byWeekday[1].startTime, '08:00')
  assert.equal(byWeekday[1].location, '教一101')
  assert.equal(byWeekday[1].startWeek, 1)
  assert.equal(byWeekday[1].endWeek, 16)

  assert.equal(byWeekday[2].name, '数据结构')
  assert.equal(byWeekday[2].weekPattern, 'EVEN')
  assert.equal(byWeekday[2].location, '教二203')

  assert.equal(byWeekday[3].name, '大学英语')
  assert.equal(byWeekday[3].weekPattern, 'ALL')
  assert.equal(byWeekday[3].startTime, '14:00')
  assert.equal(byWeekday[3].endTime, '15:40')
})

test('缺少具体时刻时留空并提示，不臆测节次对应的时间', () => {
  const lines = flattenOcrLines({
    lines: [{ text: '线性代数 周四 教二108 第1-16周', boundingBox: null, bbox: { x0: 40, y0: 40, x1: 700, y1: 75 } }],
  })
  const result = parseTimetable(lines)
  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.equal(candidate.name, '线性代数')
  assert.equal(candidate.weekday, 4)
  assert.equal(candidate.startTime, null)
  assert.equal(candidate.endTime, null)
  assert.ok(candidate.warnings.some((text) => text.includes('没有具体上课时刻')))
})

test('缺少星期时给出提示而不是瞎猜', () => {
  const lines = flattenOcrLines({
    lines: [{ text: '大学物理 08:00-09:40 实验楼B204 第3-15周 单周', bbox: { x0: 20, y0: 20, x1: 800, y1: 55 } }],
  })
  const result = parseTimetable(lines)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].weekday, null)
  assert.ok(result.candidates[0].warnings.some((text) => text.includes('没有识别到星期')))
})

test('单双周缺起止周时提示补充', () => {
  const weeks = extractWeeks('高等数学 周一 08:00-09:40 单周')
  assert.equal(weeks.weekPattern, 'ODD')
  assert.equal(weeks.startWeek, undefined)
})

test('学期起点必须是周一，否则忽略并提示', () => {
  const good = extractSemesterStart([{ text: '第一周周一：2026-09-07', bbox: { x0: 0, y0: 0, x1: 400, y1: 30 } }])
  assert.equal(good.semesterStartDate, '2026-09-07')
  assert.deepEqual(good.warnings, [])

  const bad = extractSemesterStart([{ text: '第一周周一：2026-09-08', bbox: { x0: 0, y0: 0, x1: 400, y1: 30 } }])
  assert.equal(bad.semesterStartDate, null)
  assert.equal(bad.warnings.length, 1)
  assert.ok(bad.warnings[0].includes('不是周一'))
})

test('无关文本不会产生候选，但原文保留', () => {
  const lines = flattenOcrLines({
    lines: [
      { text: '关于期中考试安排的通知', bbox: { x0: 0, y0: 0, x1: 400, y1: 30 } },
      { text: '请同学们按时复习', bbox: { x0: 0, y0: 40, x1: 400, y1: 70 } },
    ],
  })
  const result = parseTimetable(lines)
  assert.equal(result.candidates.length, 0)
  assert.ok(result.rawText.includes('关于期中考试安排的通知'))
})

test('框选区域模式：整块文字也能解析出一门课', () => {
  const lines = flattenOcrLines({
    lines: [
      { text: '高等数学', bbox: { x0: 10, y0: 0, x1: 120, y1: 30 } },
      { text: '王老师', bbox: { x0: 10, y0: 32, x1: 100, y1: 60 } },
      { text: '教一101', bbox: { x0: 10, y0: 62, x1: 110, y1: 90 } },
      { text: '1-16周(单)', bbox: { x0: 10, y0: 92, x1: 130, y1: 120 } },
      { text: '周一 08:00-09:40', bbox: { x0: 10, y0: 122, x1: 220, y1: 150 } },
    ],
  })
  const result = parseRegion(lines)
  assert.equal(result.candidates.length, 1)
  const candidate = result.candidates[0]
  assert.equal(candidate.name, '高等数学')
  assert.equal(candidate.weekday, 1)
  assert.equal(candidate.startTime, '08:00')
  assert.equal(candidate.endTime, '09:40')
  assert.equal(candidate.weekPattern, 'ODD')
  assert.equal(candidate.location, '教一101')
  assert.equal(candidate.teacher, '王老师')
})

test('全角字符与多种分隔符都能识别', () => {
  assert.equal(normalize('０８：００－０９：４０'), '08:00-09:40')
  const time = extractTime('０８：００～０９：４０')
  assert.equal(time.startTime, '08:00')
  assert.equal(time.endTime, '09:40')
  assert.equal(extractWeekday('星期一'), 1)
  assert.equal(extractWeekday('周日'), 7)
  assert.equal(extractWeekday('礼拜3'), 3)
  assert.equal(extractWeekday('第五节'), null)
  assert.equal(extractLocation('上课地点：实验楼B204'), '实验楼B204')
  assert.equal(extractTeacher('任课教师 李老师'), '李老师')
  assert.equal(isMonday('2026-09-07'), true)
  assert.equal(isMonday('2026-09-09'), false)
})

test('时间格式非法时不产出时间', () => {
  assert.deepEqual(extractTime('25:99-26:00'), {})
  assert.deepEqual(extractTime('第1-2节'), {})
})

test('空输入安全', () => {
  assert.deepEqual(flattenOcrLines(null), [])
  const result = parseTimetable([])
  assert.equal(result.candidates.length, 0)
  assert.equal(typeof result.layout, 'string')
  assert.equal(result.semesterStartDate, null)
})
