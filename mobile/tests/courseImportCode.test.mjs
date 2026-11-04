// 内部课程代码的**唯一性分配**（纯函数）。
//
// 这一组守的是「课程代码是内部字段」这条口径下最容易出错的点：
// 新建课程时界面根本不收集代码，所以**代码全由分配器产生**，一旦撞号，
// 库里就会有两门看起来是同一门课的记录（后续按代码匹配 / 合并全被污染）。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INTERNAL_COURSE_CODE_PREFIX,
  internalCourseCodeText,
  isInternalCourseCode,
  normalizeCourseDraft,
} from '../src/domain/courseDraft.ts'
import { allocateInternalCourseCode } from '../src/domain/courseImportCode.ts'

test('分配器优先用 AUTO-01 起步，并接着已有最大号往下排', () => {
  assert.equal(allocateInternalCourseCode([]), 'AUTO-01')
  assert.equal(allocateInternalCourseCode(['AUTO-01']), 'AUTO-02')
  assert.equal(allocateInternalCourseCode(['AUTO-01', 'AUTO-09']), 'AUTO-10')
  assert.equal(allocateInternalCourseCode([null, undefined, '', '  ']), 'AUTO-01', '空值不算占用')
})

test('分配器同时避开库里已有代码与本次已经预留的号（大小写不敏感）', () => {
  // 口径：从**已有的最大号**往下排，不去复用空出来的号（删过课也不会把旧号再发一次）。
  const used = new Set(['auto-03', 'AUTO-01'])
  const first = allocateInternalCourseCode(used)
  assert.equal(first, 'AUTO-04', '接着最大的 AUTO-03 往下排，且不区分大小写')
  used.add(first.toUpperCase())
  assert.equal(allocateInternalCourseCode(used), 'AUTO-05', '同一批里连续分配不能撞号')
})

test('用户手写的真实代码不会被当成可跳过的内部号', () => {
  assert.equal(isInternalCourseCode('AUTO-01'), true)
  assert.equal(isInternalCourseCode('auto-7'), true)
  assert.equal(isInternalCourseCode('CS201'), false)
  assert.equal(isInternalCourseCode('AUTOMATION-1'), false)
  assert.equal(isInternalCourseCode(''), false)
  assert.equal(internalCourseCodeText(1), `${INTERNAL_COURSE_CODE_PREFIX}01`)
  assert.equal(internalCourseCodeText(12), 'AUTO-12')
  assert.equal(internalCourseCodeText(100), 'AUTO-100')
})

test('草稿里的代码不再必填：留空是「交给仓库分配」，超长仍然拒绝', () => {
  const normalized = normalizeCourseDraft({
    code: '   ',
    name: '数据结构',
    instructor: '',
    semester: '',
    color: '',
    note: '',
    selectionSerial: '',
  })
  assert.equal(normalized.code, '', '空代码应当原样传下去（不是报错，也不是编一个假的）')
  assert.equal(normalized.name, '数据结构')

  assert.throws(
    () =>
      normalizeCourseDraft({
        code: 'X'.repeat(33),
        name: '数据结构',
        instructor: '',
        semester: '',
        color: '',
        note: '',
        selectionSerial: '',
      }),
    (error) => error.name === 'ValidationError' && Boolean(error.fields.code),
  )

  // 名称依旧是硬要求。
  assert.throws(
    () =>
      normalizeCourseDraft({
        code: '',
        name: '  ',
        instructor: '',
        semester: '',
        color: '',
        note: '',
        selectionSerial: '',
      }),
    (error) => error.name === 'ValidationError' && Boolean(error.fields.name),
  )
})
