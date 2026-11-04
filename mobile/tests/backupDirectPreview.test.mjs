/**
 * 「预览刚导出的备份」的隔离真实文件测试：
 * - 不经过系统文件选择器，直接读取本进程刚写出的文件；
 * - 预览不改变数据库；
 * - 文件被移动/删除时明确失败，保留手动选择入口的前提；
 * - 取消只清理本次暂存目录；
 * - 全局闸门阻止双击；
 * - 导出失败不替换上一条成功元数据（纯内存语义）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createTestDatabase, taskDraft } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import {
  discardBackupStaging,
  exportBackupToDirectory,
  stageBackupForPreview,
} from '../src/domain/backupService.ts'
import { BackupOperationGate, retainLastSuccessfulExport } from '../src/domain/backupOperationGate.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ddl-backup-direct-'))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  return { root, docs, systemDir }
}

function snapshot(raw) {
  const tables = ['tasks', 'courses', 'schedules', 'task_sources', 'screenshot_attempts', 'source_screenshots', 'screenshot_refs']
  const result = {}
  for (const table of tables) result[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY id ASC;`).all()
  result.app_settings = raw.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key ASC;').all()
  return result
}

async function exportWithTask(ctx, fs, systemDir) {
  await ctx.tasks.create(taskDraft({ title: '刚导出的任务', deadline: '2026-12-31', originalText: '原始通知' }))
  return exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
}

test('直接预览刚导出的文件：不打开选择器、计数/来源正确、数据库零改动', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  try {
    const exported = await exportWithTask(ctx, fs, systemDir)
    assert.equal(exported.directoryUri, pathToFileURL(systemDir).href)
    const before = snapshot(ctx.raw)
    const preview = await stageBackupForPreview(ctx.db, fs, exported.uri, { sourceName: exported.fileName })
    assert.equal(preview.counts.tasks, 1)
    assert.equal(preview.sourceName, exported.fileName)
    assert.equal(preview.isEmpty, false)
    assert.deepEqual(snapshot(ctx.raw), before, '预览不能写数据库')
    await discardBackupStaging(fs, preview.stageDir)
    assert.equal(await fs.exists(preview.stageDir), false)
    assert.deepEqual(snapshot(ctx.raw), before, '取消预览只清理暂存目录')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-direct-')
  }
})

test('刚导出的文件被删除/移动：直接读取明确失败，数据库不动', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  try {
    const exported = await exportWithTask(ctx, fs, systemDir)
    const before = snapshot(ctx.raw)
    rmSync(fileURLToPath(exported.uri))
    await assert.rejects(
      () => stageBackupForPreview(ctx.db, fs, exported.uri, { sourceName: exported.fileName }),
      /不存在|读不到|ENOENT/,
    )
    assert.deepEqual(snapshot(ctx.raw), before)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-direct-')
  }
})

test('并发闸门 + 成功元数据保留语义', () => {
  const gate = new BackupOperationGate()
  assert.equal(gate.begin('previewing'), true)
  assert.equal(gate.begin('previewing'), false, '直接预览双击必须被拒绝')
  gate.end()

  const previous = { fileName: 'old.ddlbackup.json', uri: 'file:///old' }
  assert.equal(retainLastSuccessfulExport(previous, null), previous, '失败/取消不能清除上次成功')
  const next = { fileName: 'new.ddlbackup.json', uri: 'file:///new' }
  assert.equal(retainLastSuccessfulExport(previous, next), next, '成功才替换')
  assert.equal(retainLastSuccessfulExport(null, null), null)
})
