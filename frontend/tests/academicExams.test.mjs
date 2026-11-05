/** 考试安排导入：合成数据（不含真实抓包或个人信息）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { examDeadline, examDescription, examMinutes, examTitle, parseAcademicExams } from '../src/import/academicExams.js'

const examHtml = `
<div class="grid"><table class="gridtable"><thead class="gridhead"><tr>
<th>考试批次</th><th>课程序号</th><th>课程名称</th><th>考试类别</th><th>考试日期</th><th>考试安排</th><th>考试地点</th><th>考场座位号</th><th>考试情况</th><th>其它说明</th>
</tr></thead><tbody>
<tr><td>期末考试</td><td>9000000001.01</td><td>测试课程A</td><td>期末考试</td>   <td>2026-12-20</td>
  <td>8:00~09:35</td>
  <td><a href="/eams/stdExamTable!downloadExamroomSeat.action?examRoom.id=1">测试楼-101（多媒体）</a></td>
  <td>59</td><td>正常</td><td> </td></tr>
<tr><td>考试周</td><td>9000000002.01</td><td>测试课程B</td><td>期末考试</td><td><font color="BBC4C3">时间未安排</font></td>
  <td><font color="BBC4C3">时间未安排</font></td><td><font color="BBC4C3">地点未安排</font></td><td><font color="BBC4C3">地点未安排</font></td><td>正常</td><td></td></tr>
<tr><td>期中考试</td><td>9000000001.01</td><td>测试课程A</td><td>期中考试</td><td>2026-10-20</td><td>10:00~11:35</td><td>测试楼-403</td><td>26</td><td>缓考</td><td>带计算器</td></tr>
</tbody></table></div>`

const har = (...texts) => ({ log: { entries: texts.map((text, i) => ({ request: { url: `http://jw.example/eams/stdExamTable!examTable.action?${i}` }, response: { content: { text } } })) } })

test('parses exam rows by header name, sorted by date, undated last', () => {
  const { exams, error } = parseAcademicExams(har('{"base_resp":{}}', examHtml))
  assert.equal(error, '')
  assert.deepEqual(exams.map((e) => [e.name, e.category, e.date, e.startTime, e.endTime]), [
    ['测试课程A', '期中考试', '2026-10-20', '10:00', '11:35'],
    ['测试课程A', '期末考试', '2026-12-20', '08:00', '09:35'],
    ['测试课程B', '期末考试', null, null, null],
  ])
  const [mid, final, unset] = exams
  assert.equal(final.location, '测试楼-101（多媒体）')
  assert.equal(final.seat, '59')
  assert.equal(unset.location, '')
  assert.equal(unset.scheduled, false)
  assert.equal(mid.status, '缓考')
})

test('the same exam captured twice is kept once', () => {
  const { exams } = parseAcademicExams(har(examHtml, examHtml))
  assert.equal(exams.length, 3)
})

test('several tables in one page are parsed separately (no header rows as exams)', () => {
  const { exams } = parseAcademicExams(`${examHtml}\n${examHtml.replace('2026-12-20', '2026-12-21')}`)
  assert.ok(exams.every((e) => e.name !== '课程名称'))
  assert.equal(exams.length, 4)
})

test('exam → DDL fields', () => {
  const { exams } = parseAcademicExams(examHtml)
  const final = exams.find((e) => e.category === '期末考试' && e.date)
  assert.equal(examTitle(final), '测试课程A 期末考试')
  assert.equal(examDeadline(final), '2026-12-20T08:00:00+08:00')
  assert.equal(examMinutes(final), 95)
  assert.match(examDescription(final), /考试时间：2026-12-20 08:00~09:35\n考试地点：测试楼-101（多媒体）\n座位号：59/)
  const unset = exams.find((e) => !e.date)
  assert.equal(examDeadline(unset), null)
  assert.match(examDescription(unset), /学校尚未安排/)
  const mid = exams.find((e) => e.category === '期中考试')
  assert.match(examDescription(mid), /考试情况：缓考[\s\S]*说明：带计算器/)
})

test('no exam table gives a clear error', () => {
  assert.match(parseAcademicExams(har('<html>课表</html>')).error, /没有在文件里找到考试安排/)
})
