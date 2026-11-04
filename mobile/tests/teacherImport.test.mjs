// 老师姓名端到端：OCR 候选 → 核对页可编辑行 → 课程草稿 → 持久课程。
//
// 这一组测试守的是本轮授权点名的行为：
// - 识别出来的 `teacher` 必须一路带到 `courses.instructor`，不能在这一层丢；
// - **没有**老师信息时留空，绝不编一个；
// - 用户手改 / 重新识别（`mergeRowsAfterRerun`）要把老师当普通字段一样保留；
// - 导入已有课程时**只补空值**：库里非空的老师绝不被空值或冲突值覆盖；
// - 同一门课的多条记录老师不同 → 保留先写入的，冲突如实上报，记录不被破坏。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  mergeRowsAfterRerun,
  rowFromCandidate,
  rowToDrafts,
  teacherOfRow,
  validateRow,
} from '../src/domain/photoImport.ts'
import {
  findTeacherConflicts,
  normalizeTeacherForCompare,
  ScheduleImportRepository,
} from '../src/domain/scheduleImportRepository.ts'
import { COURSE_LIMITS } from '../src/domain/courseDraft.ts'
import { createTestDatabase } from './helpers/sqliteHarness.mjs'

const FIXED_NOW = () => new Date('2026-10-12T04:00:00.000Z')

/* ------------------------------ 纯函数：行模型 ------------------------------ */

test('识别到的老师姓名原样进入可编辑行与课程草稿', () => {
  const row = rowFromCandidate(
    { name: '数据结构', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: '张三' },
    0,
  )
  assert.equal(row.teacher, '张三')
  const { course } = rowToDrafts(row, { semesterStartMonday: null, applySemesterStart: false })
  assert.equal(course.instructor, '张三')
})

test('图上没有老师姓名时留空，绝不编一个', () => {
  const row = rowFromCandidate({ name: '体育', weekday: 3, startTime: '10:00', endTime: '11:35' }, 0)
  assert.equal(row.teacher, '')
  const { course } = rowToDrafts(row, { semesterStartMonday: null, applySemesterStart: false })
  assert.equal(course.instructor, '')
})

test('老师姓名两边的空白会被去掉（不写进库）', () => {
  const row = rowFromCandidate(
    { name: '电路', weekday: 4, startTime: '14:00', endTime: '15:35', teacher: '  李四  ' },
    0,
  )
  assert.equal(row.teacher, '李四')
  assert.equal(rowToDrafts(row, { semesterStartMonday: null, applySemesterStart: false }).course.instructor, '李四')
})

test('用户手改过的老师姓名不会被重新识别覆盖', () => {
  const first = [rowFromCandidate({ name: '甲课', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: '张三' }, 0)]
  first[0].teacher = '改过的老师'
  first[0].edited = true
  const fresh = [rowFromCandidate({ name: '识别原文甲', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: '李四' }, 0)]
  const merged = mergeRowsAfterRerun(first, fresh)
  assert.equal(merged.rows[0].teacher, '改过的老师', '手改的老师必须像其它字段一样被保留')
})

test('没改过的行重新识别后按新结果刷新老师', () => {
  const first = [rowFromCandidate({ name: '甲课', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: '' }, 0)]
  const fresh = [rowFromCandidate({ name: '甲课', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: '李四' }, 0)]
  const merged = mergeRowsAfterRerun(first, fresh)
  assert.equal(merged.rows[0].teacher, '李四')
})

test('旧行（没有 teacher 字段）不会崩，也不会凭空多出一个老师', () => {
  const row = rowFromCandidate({ name: '体育', weekday: 3, startTime: '10:00', endTime: '11:35' }, 0)
  const legacy = { ...row }
  delete legacy.teacher
  assert.equal(teacherOfRow(legacy), '')
  assert.deepEqual(validateRow(legacy), [])
  const { course } = rowToDrafts(legacy, { semesterStartMonday: null, applySemesterStart: false })
  assert.equal(course.instructor, '', '缺字段 = 没有老师信息，不是编一个')
})

/* ------------------------------ 纯函数：冲突检测 ------------------------------ */

test('同名多段出现不同老师 → 被检出（两边都要标记，列出全部老师）', () => {
  const rows = [
    { id: 'row-1', name: '数据结构', teacher: '张三', selectionSerial: '' },
    { id: 'row-2', name: '数据结构', teacher: '李四', selectionSerial: '' },
  ]
  const conflicts = findTeacherConflicts(rows)
  assert.ok(conflicts.has('row-1'))
  assert.ok(conflicts.has('row-2'))
  assert.deepEqual([...conflicts.get('row-1')].sort(), ['张三', '李四'].sort())
})

test('同名但选课序号不同：是两门课，老师不同不算冲突', () => {
  const rows = [
    { id: 'row-1', name: '体育', teacher: '张三', selectionSerial: '11111.01' },
    { id: 'row-2', name: '体育', teacher: '李四', selectionSerial: '22222.02' },
  ]
  assert.equal(findTeacherConflicts(rows).size, 0)
})

test('老师相同 / 有一边为空 / 不同课程名都不算冲突', () => {
  assert.equal(
    findTeacherConflicts([
      { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '' },
      { id: 'b', name: '数据结构', teacher: ' 张三 ', selectionSerial: '' },
    ]).size,
    0,
  )
  assert.equal(
    findTeacherConflicts([
      { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '' },
      { id: 'b', name: '数据结构', teacher: '', selectionSerial: '' },
    ]).size,
    0,
    '有一边没识别到老师时不能报冲突（仓库层会补空值）',
  )
  assert.equal(
    findTeacherConflicts([
      { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '' },
      { id: 'b', name: '操作系统', teacher: '李四', selectionSerial: '' },
    ]).size,
    0,
  )
  assert.equal(normalizeTeacherForCompare(' 张 三 '), normalizeTeacherForCompare('张三'))
})

/* ------------------------------ 真实 SQLite：导入 ------------------------------ */

/** 造一条待导入候选（默认新建课程；老师、序号、时段可按需覆盖）。 */
function importCandidate({
  rowNumber = 1,
  name = '数据结构',
  teacher = '',
  serial = '',
  code = `AUTO-${String(rowNumber).padStart(2, '0')}`,
  weekday = 1,
  startTime = '08:00',
  endTime = '09:35',
} = {}) {
  return {
    rowNumber,
    include: true,
    course: { code, name, instructor: teacher, semester: '', color: '', note: '', selectionSerial: serial },
    schedule: {
      weekday,
      startTime,
      endTime,
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '2026-08-31',
      startWeek: '1',
      endWeek: '16',
      weekPattern: 'ALL',
    },
  }
}

async function importHarness() {
  const ctx = await createTestDatabase()
  const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
  return { ctx, repository }
}

test('新建课程时老师姓名落库并能读回（端到端持久化）', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const outcome = await repository.importCandidates({ candidates: [importCandidate({ teacher: '张三' })] })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.courses.length, 1)
    assert.equal(outcome.courses[0].course.instructor, '张三')
    assert.deepEqual(outcome.teacherConflicts, [])
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses').get().instructor, '张三')
  } finally {
    ctx.close()
  }
})

test('已有课程老师为非空时，空白的识别结果不会把它抹掉', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const created = await ctx.courses.create({
      code: 'AUTO-01',
      name: '数据结构',
      instructor: '王老师',
      semester: '',
      color: '',
      note: '',
      selectionSerial: '',
    })
    const outcome = await repository.importCandidates({ candidates: [importCandidate({ teacher: '', code: 'AUTO-01' })] })
    assert.equal(outcome.courses[0].reused, true)
    assert.equal(outcome.courses[0].course.instructor, '王老师')
    assert.deepEqual(outcome.teacherConflicts, [], '空值不是冲突')
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses WHERE id = ?').get(created.id).instructor, '王老师')
  } finally {
    ctx.close()
  }
})

test('已有课程老师为非空时，冲突的识别结果不会被静默覆盖，而是如实报告', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const created = await ctx.courses.create({
      code: 'AUTO-01',
      name: '数据结构',
      instructor: '王老师',
      semester: '',
      color: '',
      note: '',
      selectionSerial: '',
    })
    const outcome = await repository.importCandidates({ candidates: [importCandidate({ teacher: '李老师', code: 'AUTO-01' })] })
    assert.equal(
      ctx.raw.prepare('SELECT instructor FROM courses WHERE id = ?').get(created.id).instructor,
      '王老师',
      '库里的老师必须原样保留',
    )
    assert.equal(outcome.teacherConflicts.length, 1)
    assert.equal(outcome.teacherConflicts[0].keptTeacher, '王老师')
    assert.equal(outcome.teacherConflicts[0].ignoredTeacher, '李老师')
    assert.equal(outcome.teacherConflicts[0].courseId, created.id)
    assert.equal(outcome.courses[0].course.instructor, '王老师')
  } finally {
    ctx.close()
  }
})

test('已有课程老师为空时，识别/编辑到的老师会被补上（只补空值）', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const created = await ctx.courses.create({
      code: 'AUTO-01',
      name: '数据结构',
      instructor: '',
      semester: '',
      color: '',
      note: '',
      selectionSerial: '',
    })
    const outcome = await repository.importCandidates({ candidates: [importCandidate({ teacher: '李老师', code: 'AUTO-01' })] })
    assert.deepEqual(outcome.teacherConflicts, [])
    assert.equal(outcome.courses[0].course.instructor, '李老师')
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses WHERE id = ?').get(created.id).instructor, '李老师')
  } finally {
    ctx.close()
  }
})

test('同一批同一门课多条记录老师不同：保留先写入的，冲突上报，课表一条不少', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const outcome = await repository.importCandidates({
      candidates: [
        importCandidate({ rowNumber: 1, teacher: '张三', weekday: 1 }),
        importCandidate({ rowNumber: 2, teacher: '李四', weekday: 3, startTime: '10:00', endTime: '11:35' }),
      ],
    })
    assert.equal(outcome.schedules.length, 2, '同一门课的两段课表都要写进去')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 1, '同名课程合并成一门')
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses').get().instructor, '张三')
    assert.equal(outcome.teacherConflicts.length, 1)
    assert.equal(outcome.teacherConflicts[0].keptTeacher, '张三')
    assert.equal(outcome.teacherConflicts[0].ignoredTeacher, '李四')
  } finally {
    ctx.close()
  }
})

test('同一批同一门课：先出现的行没老师、后面的行有老师 → 补上，不算冲突', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const outcome = await repository.importCandidates({
      candidates: [
        importCandidate({ rowNumber: 1, teacher: '', weekday: 1 }),
        importCandidate({ rowNumber: 2, teacher: '李四', weekday: 3, startTime: '10:00', endTime: '11:35' }),
      ],
    })
    assert.equal(outcome.schedules.length, 2)
    assert.deepEqual(outcome.teacherConflicts, [])
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses').get().instructor, '李四')
  } finally {
    ctx.close()
  }
})

test('同一批同一门课多行给同一位老师：不报冲突、不重复上报', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const outcome = await repository.importCandidates({
      candidates: [
        importCandidate({ rowNumber: 1, teacher: '张三', weekday: 1 }),
        importCandidate({ rowNumber: 2, teacher: ' 张三 ', weekday: 3, startTime: '10:00', endTime: '11:35' }),
      ],
    })
    assert.deepEqual(outcome.teacherConflicts, [])
    assert.equal(ctx.raw.prepare('SELECT instructor FROM courses').get().instructor, '张三')
  } finally {
    ctx.close()
  }
})

/* --------------------- 复核补充：超长老师姓名的可见可改 --------------------- */

test('超长的老师姓名在行上就被指出（报在 instructor 字段），且绝不静默截断', () => {
  const long = '张'.repeat(COURSE_LIMITS.INSTRUCTOR_MAX + 1)
  const row = rowFromCandidate(
    { name: '数据结构', weekday: 1, startTime: '08:00', endTime: '09:35', teacher: long },
    0,
  )
  assert.equal(row.teacher, long, '不能把识别到的长名字悄悄剪短')
  assert.equal(
    rowToDrafts(row, { semesterStartMonday: null, applySemesterStart: false }).course.instructor,
    long,
    '草稿里也要原样保留，交给校验去报错',
  )

  const issues = validateRow(row).filter((issue) => issue.field === 'instructor')
  assert.equal(issues.length, 1, '超长必须报在「老师姓名」对应的 instructor 字段上')
  assert.match(issues[0].message, new RegExp(String(COURSE_LIMITS.INSTRUCTOR_MAX)))

  // 用户改短（或清空）之后，这一条错误立刻消失。
  row.teacher = '张'.repeat(COURSE_LIMITS.INSTRUCTOR_MAX)
  assert.deepEqual(validateRow(row).filter((issue) => issue.field === 'instructor'), [])
  row.teacher = ''
  assert.deepEqual(validateRow(row).filter((issue) => issue.field === 'instructor'), [])
})

test('超长老师姓名由仓库层报在 row:N:instructor 上（界面据此接到老师姓名输入框）', async () => {
  const { ctx, repository } = await importHarness()
  try {
    const long = '张'.repeat(COURSE_LIMITS.INSTRUCTOR_MAX + 1)
    let error = null
    try {
      await repository.importCandidates({ candidates: [importCandidate({ teacher: long })] })
    } catch (cause) {
      error = cause
    }
    assert.ok(error, '必须抛错，而不是静默截断后照常写库')
    assert.equal(error.name, 'ValidationError')
    assert.ok(
      Object.keys(error.fields).includes('row:1:instructor'),
      `错误键必须与「老师姓名」字段对齐，实际是：${Object.keys(error.fields).join(', ')}`,
    )
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 0, '被拒时一行都不写')
  } finally {
    ctx.close()
  }
})

/* --------------------- 复核补充：代码合并规则与仓库一致 --------------------- */

test('同名但两条真实课程代码不同：是两门课，老师不同不报冲突', () => {
  const rows = [
    { id: 'row-1', name: '数据结构', teacher: '张三', selectionSerial: '', code: 'CS201' },
    { id: 'row-2', name: '数据结构', teacher: '李四', selectionSerial: '', code: 'CS202' },
  ]
  assert.equal(findTeacherConflicts(rows).size, 0, '用户手写的两条不同真实代码不能被当成同一门课')
})

test('同名且可合并（代码相同 / 一边是内部编号 / 旧行缺 code）：老师不同仍然报冲突', () => {
  const sameCode = [
    { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '', code: 'CS201' },
    { id: 'b', name: '数据结构', teacher: '李四', selectionSerial: '', code: 'CS201' },
  ]
  assert.equal(findTeacherConflicts(sameCode).size, 2)

  const internal = [
    { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '', code: 'AUTO-01' },
    { id: 'b', name: '数据结构', teacher: '李四', selectionSerial: '', code: 'CS201' },
  ]
  assert.equal(findTeacherConflicts(internal).size, 2, '内部编号不承载用户意图，与真实代码可以合并')

  const legacy = [
    { id: 'a', name: '数据结构', teacher: '张三', selectionSerial: '' },
    { id: 'b', name: '数据结构', teacher: '李四', selectionSerial: '', code: 'CS201' },
  ]
  assert.equal(findTeacherConflicts(legacy).size, 2, '旧行缺 code 按内部 / 未知处理，不当成另一门课')
})
