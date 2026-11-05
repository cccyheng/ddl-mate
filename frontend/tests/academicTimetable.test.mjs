/** 教务课表导入：全部用合成数据（不含任何真实抓包、登录凭证或个人信息）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAcademicTimetable, periodPairsFromHtml, weekSegments } from '../src/import/academicTimetable.js'

const bits = (weeks, length = 30, offset = 1) => {
  const arr = Array(length).fill('0')
  for (const w of weeks) arr[w - offset] = '1'
  return arr.join('')
}

const courseTake = (courses, extra = []) => ({
  msg: '成功',
  code: 200,
  data: { courses, extra, semesterBeginAt: String(Date.UTC(2026, 7, 30, 16)) }, // 2026-08-31 00:00 北京时间
})

const har = (...responses) => ({
  log: {
    entries: [
      { request: { url: 'https://servicewechat.com/ob/wxob' }, response: { content: { text: '{"base_resp":{"ret":0}}' } } },
      ...responses.map(([url, text]) => ({ request: { url }, response: { content: { text } } })),
    ],
  },
})

test('week sets split into whole runs, odd/even runs and single weeks', () => {
  assert.deepEqual(weekSegments([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), [{ startWeek: 1, endWeek: 16, weekPattern: 'ALL' }])
  assert.deepEqual(weekSegments([3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]), [
    { startWeek: 3, endWeek: 3, weekPattern: 'ALL' },
    { startWeek: 5, endWeek: 18, weekPattern: 'ALL' },
  ])
  assert.deepEqual(weekSegments([1, 5, 7, 9, 11, 13, 15]), [
    { startWeek: 1, endWeek: 1, weekPattern: 'ALL' },
    { startWeek: 5, endWeek: 15, weekPattern: 'ODD' },
  ])
  assert.deepEqual(weekSegments([2, 4, 6, 8, 10, 12, 14, 16]), [{ startWeek: 2, endWeek: 16, weekPattern: 'EVEN' }])
  assert.deepEqual(weekSegments([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 16]), [
    { startWeek: 1, endWeek: 13, weekPattern: 'ALL' },
    { startWeek: 16, endWeek: 16, weekPattern: 'ALL' },
  ])
  assert.deepEqual(weekSegments([]), [])
})

test('mini program courseTake JSON inside a HAR: times, weeks, semester start', () => {
  const json = courseTake(
    [
      { name: '高等数学', teacher: '张老师', classroom: '教一-101', weeks: '1', startSection: '1', endSection: '2', range: bits([1, 2, 3, 4, 5, 6, 7, 8]) },
      { name: '线性代数', teacher: '李老师', classroom: '教二-201', weeks: '3', startSection: '9', endSection: '10', range: bits([1, 3, 5, 7]) },
    ],
    [{ title: '课名：物理实验 上课周：未定义 节次：未定义' }],
  )
  const result = parseAcademicTimetable(har(['https://school.example/weapp/api/v1/academic/courseTake', JSON.stringify(json)]))
  assert.equal(result.error, '')
  assert.equal(result.source, 'courseTake')
  assert.equal(result.semesterStartDate, '2026-08-31')
  assert.equal(result.candidates.length, 2)
  const [math, algebra] = result.candidates
  assert.deepEqual(
    [math.name, math.weekday, math.startTime, math.endTime, math.startWeek, math.endWeek, math.weekPattern, math.location, math.teacher],
    ['高等数学', 1, '08:00', '09:35', 1, 8, 'ALL', '教一-101', '张老师'],
  )
  assert.deepEqual([algebra.weekday, algebra.startTime, algebra.endTime, algebra.weekPattern, algebra.startWeek, algebra.endWeek], [3, '18:00', '19:35', 'ODD', 1, 7])
  assert.match(result.warnings.join('\n'), /尚未排定.*物理实验/)
})

test('records for the same class slot merge teachers and rooms per week', () => {
  const lab = (teacher, room, week) => ({ name: '电路实验', teacher, classroom: room, weeks: '2', startSection: '5', endSection: '6', range: bits([week]) })
  const json = courseTake([
    lab('甲', '实验室A', 13), lab('乙', '实验室A', 13), lab('甲', '实验室B', 13), lab('乙', '实验室B', 13),
    lab('甲', '实验室A', 14), lab('乙', '实验室B', 14),
    { name: '导论', teacher: '甲', classroom: '教一', weeks: '2', startSection: '3', endSection: '4', range: bits([1, 2]) },
    { name: '导论', teacher: '乙', classroom: '教一', weeks: '2', startSection: '3', endSection: '4', range: bits([1, 2]) },
  ])
  const result = parseAcademicTimetable(json)
  const labs = result.candidates.filter((c) => c.name === '电路实验')
  assert.equal(labs.length, 1)
  assert.deepEqual([labs[0].startWeek, labs[0].endWeek, labs[0].teacher, labs[0].location], [13, 14, '甲、乙', '实验室A / 实验室B'])
  const intro = result.candidates.filter((c) => c.name === '导论')
  assert.equal(intro.length, 1)
  assert.equal(intro[0].teacher, '甲、乙')
})

test('rooms that differ by week stay separate rows', () => {
  const json = courseTake([
    { name: 'C++', teacher: '郭', classroom: '102', weeks: '4', startSection: '3', endSection: '4', range: bits([1]) },
    { name: 'C++', teacher: '郭', classroom: '101', weeks: '4', startSection: '3', endSection: '4', range: bits([2, 3, 4]) },
  ])
  const rows = parseAcademicTimetable(json).candidates
  assert.deepEqual(rows.map((r) => [r.location, r.startWeek, r.endWeek]), [['102', 1, 1], ['101', 2, 4]])
})

test('sections that start mid-block are estimated and flagged', () => {
  const json = courseTake([{ name: '选修', teacher: '', classroom: '', weeks: '5', startSection: '2', endSection: '3', range: bits([1]) }])
  const [row] = parseAcademicTimetable(json).candidates
  assert.equal(row.startTime, '08:50')
  assert.equal(row.endTime, '10:45')
  assert.match(row.warnings[0], /估算/)
})

const eamsHtml = `
<table><tr><td rowspan="2">1-2<br>8:10-9:45</td></tr><tr><td>3-4 10:05-11:40</td></tr></table>
<script>
var table0 = new CourseTable(2026,70);
var unitCount = 10;
  var teachers = [{id:1,name:"张老师",lab:false}];
  var actTeachers = [{id:1,name:"张老师",lab:false}];
  var lessonNo = "";
  lessonNo = "9900000001.01";
    activity = new TaskActivity(actTeacherId.join(','),actTeacherName.join(','),"11(9900000001.01)","程序设计(C++)("+lessonNo+")","5","实验楼-101(西校区)","${bits([1, 2, 3, 4], 53, 0)}",taskId,"",assistantName,"","");
    index =3*unitCount+2;
    table0.activities[index][table0.activities[index].length]=activity;
    index =3*unitCount+3;
    table0.activities[index][table0.activities[index].length]=activity;
  var actTeachers = [{id:2,name:"王老师",lab:false},{id:3,name:"赵老师",lab:false}];
  lessonNo = "9900000002.01";
    activity = new TaskActivity(actTeacherId.join(','),actTeacherName.join(','),"12(9900000002.01)","数据结构("+lessonNo+")","6","教二-201","${bits([2, 4, 6], 53, 0)}",taskId,"",assistantName,"","");
    index =0*unitCount+0;
    table0.activities[index][table0.activities[index].length]=activity;
    index =0*unitCount+1;
    table0.activities[index][table0.activities[index].length]=activity;
</script>`

test('EAMS course table page: lesson numbers, weekday/period index, period times from the page', () => {
  assert.deepEqual(periodPairsFromHtml(eamsHtml).map((p) => `${p.start}-${p.end} ${p.from}-${p.to}`), ['1-2 08:10-09:45', '3-4 10:05-11:40'])
  const result = parseAcademicTimetable(har(['http://jw.example/eams/courseTableForStd!courseTable.action', eamsHtml]))
  assert.equal(result.source, 'eams')
  assert.equal(result.semesterStartDate, '')
  const byName = Object.fromEntries(result.candidates.map((c) => [c.name, c]))
  assert.deepEqual(
    [byName['程序设计(C++)'].code, byName['程序设计(C++)'].weekday, byName['程序设计(C++)'].periodStart, byName['程序设计(C++)'].startTime, byName['程序设计(C++)'].endWeek],
    ['9900000001.01', 4, 3, '10:05', 4],
  )
  assert.deepEqual(
    [byName['数据结构'].weekday, byName['数据结构'].startTime, byName['数据结构'].weekPattern, byName['数据结构'].teacher],
    [1, '08:10', 'EVEN', '王老师、赵老师'],
  )
})

test('files without timetable data give a clear error', () => {
  const result = parseAcademicTimetable(har())
  assert.equal(result.candidates.length, 0)
  assert.match(result.error, /没有在文件里找到课表数据/)
  assert.match(parseAcademicTimetable('not json at all').error, /没有/)
})
