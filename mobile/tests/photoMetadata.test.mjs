// 「范围 vs 快照」标签 + 选课序号往返：这两块是本轮授权里点名的**元数据修正**。
//
// 复核对抓到的真实缺陷：
// - `weekFromImage = startWeek ?? endWeek` 让 1–16 这种**范围**被说成「没有显示教学周」，
//   而「只显示第 7 周」的快照被说成单独一周 —— 两种证据被同一个字段糊在一起；
// - 选课序号（截图里课程名后括号里的数字）被丢掉，同名不同序号的课会被静默合并。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  broadenWarningMessage,
  deriveWeekEvidence,
  deriveWeekScope,
  describeWeekRange,
  rowFromCandidate,
  rowToDrafts,
  validateRow,
  weekEvidenceOf,
  weekScopeOf,
} from '../src/domain/photoImport.ts'
import { createTestDatabase } from './helpers/sqliteHarness.mjs'
import { CourseRepository } from '../src/domain/courseRepository.ts'
import { normalizeCourseDraft, courseToDraft } from '../src/domain/courseDraft.ts'

/* ------------------------------ 周次证据分类 ------------------------------ */

test('weekScopeOf：范围 / 快照 / 没有，三种证据分得开', () => {
  assert.equal(weekScopeOf(1, 16), 'range')
  assert.equal(weekScopeOf(7, 7), 'snapshot')
  assert.equal(weekScopeOf(3, 18), 'range')
  assert.equal(weekScopeOf(7, null), 'snapshot', '只给一侧时按快照处理，不假装是范围')
  assert.equal(weekScopeOf(null, null), 'none')
})

test('weekEvidenceOf：范围取结束周（用于确认文案），快照取那一周', () => {
  assert.equal(weekEvidenceOf(1, 16, 'range'), 16)
  assert.equal(weekEvidenceOf(7, 7, 'snapshot'), 7)
  assert.equal(weekEvidenceOf(null, null, 'none'), null)
})

test('describeWeekRange：范围写成 1–16，快照写成第 7 周，并带上单双周', () => {
  assert.equal(describeWeekRange({ startWeek: '1', endWeek: '16', weekPattern: 'ALL' }), '第 1–16 周')
  assert.equal(describeWeekRange({ startWeek: '7', endWeek: '7', weekPattern: 'ALL' }), '第 7 周')
  assert.equal(describeWeekRange({ startWeek: '3', endWeek: '18', weekPattern: 'ODD' }), '第 3–18 周（单周）')
  assert.equal(describeWeekRange({ startWeek: '', endWeek: '', weekPattern: 'ALL' }), '每周都上')
})

test('识别到的 1–16 被标成范围，界面文案不会再说是「某一周」', () => {
  const row = rowFromCandidate(
    { name: '大学物理(B-2)', weekday: 1, startTime: '08:00', endTime: '09:35', startWeek: 1, endWeek: 16 },
    0,
  )
  assert.equal(row.weekScope, 'range')
  assert.equal(row.weekFromImage, 16, '依据是范围的结束周，不再是起始周')
  assert.equal(row.startWeek, '1')
  assert.equal(row.endWeek, '16')
})

test('识别到的第 7 周被标成快照，仍然只在那一周', () => {
  const row = rowFromCandidate(
    { name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35', startWeek: 7, endWeek: 7 },
    0,
  )
  assert.equal(row.weekScope, 'snapshot')
  assert.equal(row.weekFromImage, 7)
})

test('界面上手改起止周后，证据类型跟着变（不会继续说「范围」）', () => {
  assert.equal(deriveWeekScope('7', '7'), 'snapshot')
  assert.equal(deriveWeekScope('1', '16'), 'range')
  assert.equal(deriveWeekScope('', ''), 'none')
  assert.equal(deriveWeekEvidence('7', '7', 'snapshot'), 7)
  assert.equal(deriveWeekEvidence('1', '16', 'range'), 16)
  assert.equal(deriveWeekEvidence('', '', 'none'), null)
})

test('范围行被清空时，确认文案说的是原本那个范围，不是「第 1 周」', () => {
  const row = rowFromCandidate(
    { name: '电路', weekday: 4, startTime: '14:00', endTime: '15:35', startWeek: 3, endWeek: 18 },
    0,
  )
  const message = broadenWarningMessage(row)
  assert.match(message, /第 3–18 周/, '要说清原本的范围')
  assert.doesNotMatch(message, /第 3 周。/, '不能只说起始周')

  // 清空后必须被拦住，除非显式确认。
  row.startWeek = ''
  row.endWeek = ''
  assert.ok(validateRow(row).some((issue) => issue.field === 'weekRange'))
  row.confirmedBroadenToEveryWeek = true
  assert.deepEqual(validateRow(row).filter((issue) => issue.field === 'weekRange'), [])
  // 用户改过的周次证据要跟着走：清空后不再是「范围」。
  assert.equal(deriveWeekScope(row.startWeek, row.endWeek), 'none')
})

test('快照行的确认文案仍然说的是「那一周」', () => {
  const row = rowFromCandidate(
    { name: '形势与政策', weekday: 7, startTime: '08:00', endTime: '09:35', startWeek: 7, endWeek: 7 },
    0,
  )
  assert.match(broadenWarningMessage(row), /第 7 周/)
})

/* ------------------------------ 选课序号往返 ------------------------------ */

test('选课序号与内部编号分开：AUTO-01 不被选课序号覆盖', () => {
  const row = rowFromCandidate(
    {
      name: '大学物理(B-2)',
      weekday: 1,
      startTime: '08:00',
      endTime: '09:35',
      startWeek: 1,
      endWeek: 16,
      courseCode: '9913000172.08',
    },
    0,
  )
  assert.equal(row.code, 'AUTO-01', '课程代码仍然是内部编号')
  assert.equal(row.codeIsInternal, true)
  assert.equal(row.selectionSerial, '9913000172.08', '选课序号单独保留')

  const { course } = rowToDrafts(row, { semesterStartMonday: '2026-08-31', applySemesterStart: true })
  assert.equal(course.code, 'AUTO-01')
  assert.equal(course.selectionSerial, '9913000172.08')
})

test('图上没有选课序号时留空，绝不编一个', () => {
  const row = rowFromCandidate({ name: '电路', weekday: 4, startTime: '14:00', endTime: '15:35' }, 0)
  assert.equal(row.selectionSerial, '')
  const { course } = rowToDrafts(row, { semesterStartMonday: null, applySemesterStart: false })
  assert.equal(course.selectionSerial, '')
})

test('选课序号超长被拒绝（不静默截断成另一个号）', () => {
  assert.throws(
    () => normalizeCourseDraft({ code: 'AUTO-01', name: '课', instructor: '', semester: '', color: '', note: '', selectionSerial: 'x'.repeat(41) }),
    (error) => error.name === 'ValidationError' && Boolean(error.fields.selectionSerial),
  )
})

test('课程仓库：选课序号能存能读，普通保存不会把它抹掉', async () => {
  const ctx = await createTestDatabase()
  try {
    const courses = new CourseRepository(ctx.db, () => new Date('2026-10-12T04:00:00.000Z'))
    const created = await courses.create({
      code: 'AUTO-01',
      name: '大学物理(B-2)',
      instructor: '',
      semester: '',
      color: '',
      note: '',
      selectionSerial: '9913000172.08',
    })
    assert.equal(created.selectionSerial, '9913000172.08')
    assert.equal(created.code, 'AUTO-01')

    // 表单带回来的草稿（courseToDraft 会带上序号）→ 保存后仍在。
    const roundTrip = courseToDraft(created)
    assert.equal(roundTrip.selectionSerial, '9913000172.08')
    const updated = await courses.update(created.id, { ...roundTrip, note: '改了备注' })
    assert.equal(updated.selectionSerial, '9913000172.08')
    assert.equal(updated.note, '改了备注')

    // 旧调用方（草稿里**没有**序号字段）保存时也不能把已记录的序号抹掉。
    const legacySave = await courses.update(created.id, {
      code: updated.code,
      name: updated.name,
      instructor: updated.instructor ?? '',
      semester: updated.semester ?? '',
      color: updated.color ?? '',
      note: '旧表单保存',
    })
    assert.equal(legacySave.selectionSerial, '9913000172.08', '空序号 + 未标记清空 = 保留')

    // 明确清空才真的清空。
    const cleared = await courses.update(created.id, { ...courseToDraft(legacySave), selectionSerial: '', clearSelectionSerial: true })
    assert.equal(cleared.selectionSerial, null)

    // 只改序号的专用方法不会碰其它字段。
    const serialOnly = await courses.updateSelectionSerial(created.id, '9913000999.01')
    assert.equal(serialOnly.selectionSerial, '9913000999.01')
    assert.equal(serialOnly.code, 'AUTO-01')
    assert.equal(serialOnly.name, '大学物理(B-2)')
  } finally {
    ctx.close()
  }
})
