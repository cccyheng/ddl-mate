/**
 * 真实历史截图关联：任务 / 课程 / 课表被合法删除后，screenshot_refs 仍然保留。
 *
 * 备份必须接受这种「多态历史 target 缺失」，但同时要把恢复后新库的 AUTOINCREMENT
 * 高水位推到历史 target 之上，避免未来新建实体复用缺失 ID 后误挂旧截图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTestDatabase, taskDraft, courseDraft, scheduleDraft } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import {
  exportBackupToDirectory,
  restoreStagedBackup,
  stageBackupForPreview,
} from '../src/domain/backupService.ts'
import { parseBackupText, sealBackupData } from '../src/domain/backupFormat.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z')
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ddl-backup-history-'))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  return { root, docs, systemDir }
}

function refs(raw) {
  return raw
    .prepare('SELECT target_kind, target_id FROM screenshot_refs ORDER BY id ASC;')
    .all()
    .map((row) => ({ kind: row.target_kind, id: row.target_id }))
}

async function seedAndDeleteTargets(ctx, docs) {
  const course1 = await ctx.courses.create(courseDraft({ name: '保留课程' }))
  const course3 = await ctx.courses.create(courseDraft({ name: '历史课程' }))
  const schedule1 = await ctx.courses.createSchedule(course1.id, scheduleDraft({ startTime: '08:00', endTime: '09:00' }))
  await ctx.courses.createSchedule(course1.id, scheduleDraft({ startTime: '10:00', endTime: '11:00' }))
  const schedule3 = await ctx.courses.createSchedule(course1.id, scheduleDraft({ startTime: '14:00', endTime: '15:00' }))
  const task1 = await ctx.tasks.create(taskDraft({ title: '保留任务' }))
  await ctx.tasks.create(taskDraft({ title: '第二个任务' }))
  const task3 = await ctx.tasks.create(taskDraft({ title: '将被删除的任务', originalText: '删除前原文' }))

  const bytes = Buffer.from(TINY_PNG, 'base64')
  const file = join(docs, 'screenshots', 'history.png')
  writeFileSync(file, bytes)
  const uri = pathToFileURL(file).href
  const sha = createHash('sha256').update(bytes).digest('hex')
  const attempt = await ctx.screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    archivedPath: uri,
    sha256: sha,
    byteLength: bytes.length,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
  })
  for (const target of [
    { targetKind: 'COURSE', targetId: course3.id },
    { targetKind: 'SCHEDULE', targetId: schedule3.id },
    { targetKind: 'TASK', targetId: task3.id },
  ]) {
    await ctx.screenshots.linkRef({
      attemptId: attempt.attempt.id,
      ...target,
      relation: 'HISTORICAL_TEST',
    })
  }

  // 真实删除路径：引用不会被仓库删掉（schema 明确保留历史关联）。
  await ctx.courses.removeCourse(course3.id, { confirmed: true })
  await ctx.courses.removeSchedule(schedule3.id)
  await ctx.tasks.remove(task3.id)
  assert.deepEqual(refs(ctx.raw), [
    { kind: 'COURSE', id: course3.id },
    { kind: 'SCHEDULE', id: schedule3.id },
    { kind: 'TASK', id: task3.id },
  ])
  return { course1, schedule1, task1, course3Id: course3.id, schedule3Id: schedule3.id, task3Id: task3.id, attemptId: attempt.attempt.id }
}

test('已删除任务/课程/课表的合法历史 refs 可导出、预览并在新库恢复；新 ID 不复用历史 target', async () => {
  const { root, docs, systemDir } = setup()
  const source = await createTestDatabase()
  const fresh = await createTestDatabase()
  const fs = createBackupFs(docs)
  try {
    const seeded = await seedAndDeleteTargets(source, docs)
    const exported = await exportBackupToDirectory(source.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })

    // 导出物必须被 own parser 接受（历史 target 缺失不是坏 schema）。
    const parsed = await parseBackupText(await fs.readText(exported.uri))
    assert.deepEqual(
      parsed.data.refs.map((ref) => [ref.targetKind, ref.targetId]),
      [
        ['COURSE', seeded.course3Id],
        ['SCHEDULE', seeded.schedule3Id],
        ['TASK', seeded.task3Id],
      ],
    )

    // 在全新空库上预览 + 恢复；fingerprint 以新库当前状态为准。
    const preview = await stageBackupForPreview(fresh.db, fs, exported.uri)
    const restored = await restoreStagedBackup(fresh.db, fs, preview, { now: () => NOW })
    assert.equal(restored.committed, true, restored.committed ? '' : restored.reason)
    assert.deepEqual(refs(fresh.raw), [
      { kind: 'COURSE', id: seeded.course3Id },
      { kind: 'SCHEDULE', id: seeded.schedule3Id },
      { kind: 'TASK', id: seeded.task3Id },
    ])

    // 新实体必须从历史 target 之上分配 ID，不能复用 3 把旧图挂到新任务/课程/课表。
    const newCourse = await fresh.courses.create(courseDraft({ name: '恢复后新课程' }))
    const newSchedule = await fresh.courses.createSchedule(
      seeded.course1.id,
      scheduleDraft({ startTime: '16:00', endTime: '17:00' }),
    )
    const newTask = await fresh.tasks.create(taskDraft({ title: '恢复后新任务' }))
    assert.ok(newCourse.id > seeded.course3Id, `course id ${newCourse.id} 必须大于历史 ${seeded.course3Id}`)
    assert.ok(newSchedule.id > seeded.schedule3Id, `schedule id ${newSchedule.id} 必须大于历史 ${seeded.schedule3Id}`)
    assert.ok(newTask.id > seeded.task3Id, `task id ${newTask.id} 必须大于历史 ${seeded.task3Id}`)
    assert.deepEqual(refs(fresh.raw), [
      { kind: 'COURSE', id: seeded.course3Id },
      { kind: 'SCHEDULE', id: seeded.schedule3Id },
      { kind: 'TASK', id: seeded.task3Id },
    ])
  } finally {
    source.close()
    fresh.close()
    removeTempDir(root, 'ddl-backup-history-')
  }
})

test('ATTEMPT ref 目标不存在仍是真坏外键；历史 COURSE/SCHEDULE/TASK 才允许缺失', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    await seedAndDeleteTargets(ctx, docs)
    const exported = await exportBackupToDirectory(ctx.db, createBackupFs(docs), pathToFileURL(systemDir).href, { now: () => NOW })
    const base = await parseBackupText(await createBackupFs(docs).readText(exported.uri))
    const data = JSON.parse(JSON.stringify(base.data))
    data.refs.push({
      id: Math.max(...data.refs.map((ref) => ref.id)) + 1,
      attemptId: data.attempts[0].id,
      targetKind: 'ATTEMPT',
      targetId: 9999,
      relation: 'BROKEN',
      createdAt: NOW.toISOString(),
    })
    const sealed = await sealBackupData(data, { now: () => NOW })
    await assert.rejects(() => parseBackupText(JSON.stringify(sealed)), /不存在的 ATTEMPT/)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-history-')
  }
})
