// 照片识别结果 → 可编辑导入行的映射测试（纯函数，不需要 OCR）。
//
// 覆盖复核对第 7–9 条点名的问题：
// - 端点规范化不能吐出两个端口（`http://ip:8082:8082`）；
// - 截图里没有课程代码时自动给内部编号，**不逼用户编 21 个教务代码**；
// - `startWeek: 1, endWeek: 16` 必须保持 1–16，不能塌成 1–1；
// - 清空截图带来的周次会扩大范围，必须先显式确认，不能静默变成「每周都上」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { endpointFromHostUri, normalizeEndpoint } from '../src/domain/photoOcrClient.ts'
import {
  countRowsNeedingFix,
  describeRow,
  internalCourseCode,
  mergeRowsAfterRerun,
  rowFromCandidate,
  rowToDrafts,
  validateRow,
} from '../src/domain/photoImport.ts'

test('normalizeEndpoint 只保留一个端口，并丢掉路径与凭据', () => {
  assert.equal(normalizeEndpoint('192.168.31.73:8082'), 'http://192.168.31.73:8082')
  assert.equal(normalizeEndpoint('http://192.168.31.73:8082'), 'http://192.168.31.73:8082')
  assert.equal(normalizeEndpoint('http://192.168.31.73:8082/'), 'http://192.168.31.73:8082')
  assert.equal(normalizeEndpoint('https://example.local:9443/v1/ocr'), 'https://example.local:9443')
  assert.equal(normalizeEndpoint('http://example.local'), 'http://example.local', '省略端口时不能补一个假端口')
  assert.equal(normalizeEndpoint('http://user:pass@192.168.1.5:8082'), null, '带凭据的地址一律拒绝')
  assert.equal(normalizeEndpoint('ftp://192.168.1.5:8082'), null)
  assert.equal(normalizeEndpoint(''), null)
  assert.equal(normalizeEndpoint(null), null)
})

test('由 Metro 主机名推断的地址经过规范化后仍然只有一个端口', () => {
  const inferred = endpointFromHostUri('192.168.31.73:8081')
  assert.equal(inferred, 'http://192.168.31.73:8082')
  assert.equal(normalizeEndpoint(inferred), 'http://192.168.31.73:8082')
  assert.equal(endpointFromHostUri('localhost:8081'), null, '本机地址对手机没有意义')
  assert.equal(endpointFromHostUri(null), null)
})

test('截图里没有课程代码：自动给内部编号，不需要用户编 21 个代码', () => {
  const rows = Array.from({ length: 21 }, (_, index) =>
    rowFromCandidate({ name: `课程${index + 1}`, weekday: 1, startTime: '08:00', endTime: '09:35' }, index),
  )
  assert.equal(rows.length, 21)
  assert.ok(
    rows.every((row) => row.code.length > 0 && row.codeIsInternal),
    '每行都要有可用的内部编号，并标记为内部编号',
  )
  assert.equal(rows[0].code, internalCourseCode(1))
  assert.equal(
    rows.flatMap((row) => validateRow(row)).filter((issue) => issue.field === 'code').length,
    0,
    '课程代码不再阻塞导入',
  )
  assert.equal(countRowsNeedingFix(rows), 0, '这 21 行应当可以直接一键导入（不缺必填项）')
})

test('显式给出的教学周范围必须原样保留（1–16 不能塌成 1–1）', () => {
  const row = rowFromCandidate(
    { name: '数据结构', weekday: 1, startTime: '08:00', endTime: '09:35', startWeek: 1, endWeek: 16, weekPattern: 'ODD' },
    0,
  )
  assert.equal(row.startWeek, '1')
  assert.equal(row.endWeek, '16')
  assert.equal(row.weekPattern, 'ODD')

  const { schedule } = rowToDrafts(row, { semesterStartMonday: '2026-08-31', applySemesterStart: true })
  assert.equal(schedule.startWeek, '1')
  assert.equal(schedule.endWeek, '16')
  assert.equal(schedule.weekPattern, 'ODD', '单双周不能被降级成 ALL')
  assert.equal(schedule.semesterStartDate, '2026-08-31')
})

test('截图只显示某一周（第 7 周）时按那两周次范围填入，而不是整学期', () => {
  const row = rowFromCandidate(
    { name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35', startWeek: 7, endWeek: 7 },
    0,
  )
  assert.equal(row.startWeek, '7')
  assert.equal(row.endWeek, '7')
  assert.equal(row.weekFromImage, 7)

  const { schedule } = rowToDrafts(row, { semesterStartMonday: '2026-08-31', applySemesterStart: true })
  assert.equal(schedule.startWeek, '7')
  assert.equal(schedule.endWeek, '7')
  assert.equal(schedule.weekPattern, 'ALL', '第 7 周这一周里的课仍然是「每周」（就那一周）')
})

test('清空截图带来的周次范围 = 静默扩大，必须先显式确认', () => {
  const row = rowFromCandidate(
    { name: '数据结构', weekday: 1, startTime: '08:00', endTime: '09:35', startWeek: 7, endWeek: 7 },
    0,
  )
  row.startWeek = ''
  row.endWeek = ''
  const issues = validateRow(row)
  assert.ok(
    issues.some((issue) => issue.field === 'weekRange'),
    '清空第 7 周的周次必须报「范围」错误，而不是静默变成整学期每周',
  )

  row.confirmedBroadenToEveryWeek = true
  assert.deepEqual(
    validateRow(row).filter((issue) => issue.field === 'weekRange'),
    [],
    '显式确认之后才允许改成每周都上',
  )
})

test('没有显示周次的截图：留空就是「每周都上」，不需要额外确认', () => {
  const row = rowFromCandidate({ name: '体育', weekday: 3, startTime: '10:00', endTime: '11:35' }, 0)
  assert.equal(row.weekFromImage, null)
  assert.deepEqual(validateRow(row), [])
  const { schedule } = rowToDrafts(row, { semesterStartMonday: '2026-08-31', applySemesterStart: true })
  assert.equal(schedule.startWeek, '')
  assert.equal(schedule.weekPattern, 'ALL')
  assert.equal(schedule.semesterStartDate, '', '没有周次范围时不写学期起点')
})

test('缺少课程名/星期/时间的行仍然被拦住（不猜时间、不编课程）', () => {
  const row = rowFromCandidate({ name: '', weekday: null, startTime: null, endTime: null }, 3)
  const fields = validateRow(row).map((issue) => issue.field)
  assert.ok(fields.includes('name'))
  assert.ok(fields.includes('weekday'))
  assert.ok(fields.includes('startTime'))
  assert.ok(fields.includes('endTime'))
  assert.equal(row.startTime, '', '识别不到时间就留空，绝不编一个 08:00')
})

test('单双周与起止周不完整时报错；描述文案包含周次与单双周', () => {
  const row = rowFromCandidate(
    { name: '电路', weekday: 4, startTime: '14:00', endTime: '15:35', startWeek: 3, endWeek: null, weekPattern: 'EVEN' },
    0,
  )
  assert.ok(validateRow(row).some((issue) => issue.field === 'weekRange'))
  const complete = rowFromCandidate(
    { name: '电路', weekday: 4, startTime: '14:00', endTime: '15:35', startWeek: 3, endWeek: 16, weekPattern: 'EVEN' },
    1,
  )
  assert.match(describeRow(complete), /周四 14:00–15:35/)
  assert.match(describeRow(complete), /第 3–16 周/)
  assert.match(describeRow(complete), /双周/)
})

test('重新识别：用户改过的行保留，其它行按新结果刷新', () => {
  const first = [rowFromCandidate({ name: '甲课', weekday: 1, startTime: '08:00', endTime: '09:35' }, 0)]
  first[0].name = '改过的名字'
  first[0].edited = true
  const fresh = [
    rowFromCandidate({ name: '识别原文甲', weekday: 1, startTime: '08:00', endTime: '09:35' }, 0),
    rowFromCandidate({ name: '乙课', weekday: 2, startTime: '10:00', endTime: '11:35' }, 1),
  ]
  const merged = mergeRowsAfterRerun(first, fresh)
  assert.equal(merged.preserved, 1)
  assert.equal(merged.added, 1)
  assert.equal(merged.rows[0].name, '改过的名字', '用户改过的内容不能被新识别覆盖')
  assert.equal(merged.rows[1].name, '乙课')
})
