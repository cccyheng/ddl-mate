import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importBlockReason } from '../src/ocr/importValidation.js'

const row = (overrides = {}) => ({
  courseMode: 'new',
  existingCourseId: null,
  courseName: '高等数学',
  code: 'OCR01',
  weekday: 1,
  startTime: '08:00',
  endTime: '09:40',
  startWeek: null,
  endWeek: null,
  weekPattern: 'ALL',
  ...overrides,
})

test('complete rows can be imported', () => {
  assert.equal(importBlockReason([row(), row({ courseName: '数据结构', code: 'OCR02', weekday: 2 })]), '')
})

test('no selected rows', () => {
  assert.match(importBlockReason([]), /至少勾选一条/)
})

test('names the course and every missing field', () => {
  const reason = importBlockReason([row(), row({ courseName: '大学英语', code: 'OCR02', weekday: null, startTime: '' })])
  assert.match(reason, /「大学英语」还缺少星期、开始时间/)
})

test('missing course name or existing course', () => {
  assert.match(importBlockReason([row({ courseName: '  ' })]), /有一条候选还缺少课程名/)
  assert.match(importBlockReason([row({ courseMode: 'existing' })]), /「高等数学」还缺少要归入的已有课程/)
})

test('start must be before end', () => {
  assert.match(importBlockReason([row({ startTime: '10:00', endTime: '09:40' })]), /「高等数学」周一的开始时间（10:00）不早于结束时间（09:40）/)
})

test('course codes: missing, taken by own course, clashing in batch', () => {
  assert.match(importBlockReason([row({ code: '' })]), /缺少课程代码/)
  assert.match(importBlockReason([row()], { courses: [{ code: 'ocr01' }] }), /已被你的其他课程占用/)
  assert.match(importBlockReason([row(), row({ courseName: '线性代数' })]), /用了同一个课程代码/)
  // 同一门新课的两次上课共用代码是允许的（导入时按课程名合并）
  assert.equal(importBlockReason([row(), row({ weekday: 3 })]), '')
})

test('existing-course rows skip the code checks', () => {
  assert.equal(importBlockReason([row({ courseMode: 'existing', existingCourseId: 7, code: '' })], { courses: [{ code: 'OCR01' }] }), '')
})

test('week view gate reason is passed through', () => {
  assert.equal(importBlockReason([row()], { gate: { blocked: true, reason: '请填写学期第一周周一' } }), '请填写学期第一周周一')
})

test('teaching weeks and odd/even weeks need the semester start', () => {
  assert.match(importBlockReason([row({ startWeek: 1, endWeek: 16 })]), /学期第一周周一/)
  assert.match(importBlockReason([row({ weekPattern: 'ODD' })]), /单周\/双周/)
  assert.equal(importBlockReason([row({ startWeek: 1, endWeek: 16, weekPattern: 'ODD' })], { semesterStartDate: '2026-09-07' }), '')
})
