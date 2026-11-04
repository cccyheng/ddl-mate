// 仓库层守卫：表头/时间栏文字**绝不能写进数据库**。
//
// 复核对明确要求：「header label rejection must apply photo import repository as well as UI」。
// 界面校验（`validateRow`）只是第一道；仓库是唯一真正写库的入口，所以这里再拦一道，
// 而且要在**事务开始之前**拦下来 —— 任何一行不合法，整批都不写。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTestDatabase } from './helpers/sqliteHarness.mjs'
import { rowFromCandidate, rowToDrafts } from '../src/domain/photoImport.ts'
import { ScheduleImportRepository } from '../src/domain/scheduleImportRepository.ts'

/** 把「识别候选」按界面真实的路径变成仓库输入（与 PhotoReviewScreen 一致）。 */
function candidateInput(entry, index) {
  const row = rowFromCandidate(entry, index)
  const drafts = rowToDrafts(row, { semesterStartMonday: '2026-08-31', applySemesterStart: true })
  return { rowNumber: index + 1, include: true, ...drafts }
}

async function countRows(db) {
  const courses = await db.getFirstAsync('SELECT count(*) AS n FROM courses;')
  const schedules = await db.getFirstAsync('SELECT count(*) AS n FROM schedules;')
  return { courses: Number(courses.n), schedules: Number(schedules.n) }
}

const HEADER_NAMES = ['周一', '星期二', '08:00', '08:00-08:45', '10/12', '第7周', '第1-2节', '上一周', '时间', '节次']

test('仓库层拒绝表头/时间栏名称，并且一行都不写', async () => {
  for (const name of HEADER_NAMES) {
    const harness = await createTestDatabase()
    try {
      const repository = new ScheduleImportRepository(harness.db)
      const input = candidateInput(
        // 即使星期与时间都被"识破得很完整"，也不能把表头文字当成课程。
        { name, weekday: 1, startTime: '08:00', endTime: '09:35', location: '教三 305' },
        0,
      )
      let error = null
      try {
        await repository.importCandidates({ candidates: [input] })
      } catch (cause) {
        error = cause
      }
      assert.ok(error, `「${name}」必须被拒绝`)
      assert.equal(error.name, 'ValidationError')
      assert.match(error.fields['row:1:name'] ?? '', /表头|时间栏/, `「${name}」的错误要说明原因`)
      assert.deepEqual(await countRows(harness.db), { courses: 0, schedules: 0 }, '被拒绝时不能写任何数据')
    } finally {
      harness.close()
    }
  }
})

test('仓库层：整批里只要有一行是表头文字，整批都不写', async () => {
  const harness = await createTestDatabase()
  try {
    const repository = new ScheduleImportRepository(harness.db)
    const inputs = [
      candidateInput({ name: '数字信号处理', weekday: 1, startTime: '08:00', endTime: '09:35', location: '教三305' }, 0),
      candidateInput({ name: '周一', weekday: 2, startTime: '10:00', endTime: '11:35', location: null }, 1),
    ]
    let error = null
    try {
      await repository.importCandidates({ candidates: inputs })
    } catch (cause) {
      error = cause
    }
    assert.ok(error, '含表头行的批次必须被拒绝')
    assert.equal(error.name, 'ValidationError')
    assert.match(error.fields['row:2:name'] ?? '', /表头|时间栏/)
    assert.deepEqual(await countRows(harness.db), { courses: 0, schedules: 0 }, '事务前校验失败时整批不写')
  } finally {
    harness.close()
  }
})

test('仓库层：真实课程名照常导入（守卫不能误伤）', async () => {
  const harness = await createTestDatabase()
  try {
    const repository = new ScheduleImportRepository(harness.db)
    const names = ['时间序列分析', '数字信号处理', '星期一的科学', 'C++', '大学英语(3)', '数学分析2']
    const inputs = names.map((name, index) =>
      candidateInput({ name, weekday: (index % 5) + 1, startTime: '08:00', endTime: '09:35', location: '教三305' }, index),
    )
    const result = await repository.importCandidates({ candidates: inputs })
    assert.equal(result.committed, true)
    const stored = (await harness.db.getAllAsync('SELECT name FROM courses ORDER BY id ASC;')).map((row) => String(row.name))
    assert.deepEqual(stored, names)
  } finally {
    harness.close()
  }
})
