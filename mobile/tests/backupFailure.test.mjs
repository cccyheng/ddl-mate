/**
 * 备份 / 恢复的故障与拒绝路径（真实 SQLite + 真实临时磁盘）。
 *
 * 每个失败都必须证明：数据库、原照片、恢复备份与暂存目录的状态与文案一致，
 * 绝不把「没有恢复」说成部分成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createTestDatabase, taskDraft, courseDraft } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import {
  BACKUP_STAGING_DIR_NAME,
  discardBackupStaging,
  exportBackupToDirectory,
  listRecoveryBackups,
  preflightRestore,
  restoreStagedBackup,
  stageBackupForPreview,
} from '../src/domain/backupService.ts'
import { parseBackupText, sealBackupData, BACKUP_LIMITS } from '../src/domain/backupFormat.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z')
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ddl-backup-fail-'))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  return { root, docs, systemDir }
}

function snapshot(raw) {
  const tables = [
    'courses',
    'schedules',
    'tasks',
    'task_sources',
    'screenshot_attempts',
    'source_screenshots',
    'screenshot_refs',
    'ocr_results',
    'ocr_candidate_rows',
  ]
  const result = {}
  for (const table of tables) result[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY id ASC;`).all()
  result.app_settings = raw.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key ASC;').all()
  return result
}

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function seedAndExport(ctx, docs, systemDir) {
  const fs = createBackupFs(docs)
  const course = await ctx.courses.create(courseDraft({ name: '数据结构', selectionSerial: '9913000172.08' }))
  const task = await ctx.tasks.create(
    taskDraft({
      title: '备份里的任务',
      courseId: course.id,
      deadline: '2026-12-31',
      originalText: '原始通知：12 月 31 日前提交。',
    }),
  )
  const bytes = Buffer.from(TINY_PNG, 'base64')
  const file = join(docs, 'screenshots', 'one.png')
  writeFileSync(file, bytes)
  const uri = pathToFileURL(file).href
  const digest = sha(bytes)
  await ctx.screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    archivedPath: uri,
    sha256: digest,
    byteLength: bytes.length,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
  })
  await ctx.screenshots.upsertSourceEntry({
    catalogKey: 'failure-source',
    title: '测试来源',
    archiveRelPath: '.tools/photo/source.png',
    sha256: 'a'.repeat(64),
    byteLength: 10,
  })
  const exported = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
  const preview = await stageBackupForPreview(ctx.db, fs, exported.uri, { sourceName: 'failure.ddlbackup.json' })
  const original = snapshot(ctx.raw)
  const originalFileNames = readdirSync(join(docs, 'screenshots')).sort()
  const originalFileBytes = readFileSync(file)
  return { fs, course, task, exported, preview, original, originalFileNames, originalFileBytes }
}

test('数据库在删除后插入失败：整库回滚，原图片不变，恢复备份仍可读', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    const failingDb = {
      ...ctx.db,
      async runAsync(sql, params = []) {
        if (sql.includes('INSERT INTO tasks')) throw new Error('测试注入：任务插入失败')
        return ctx.db.runAsync(sql, params)
      },
    }
    const outcome = await restoreStagedBackup(failingDb, seeded.fs, seeded.preview, { now: () => NOW })
    assert.equal(outcome.committed, false)
    assert.equal(outcome.code, 'DB_WRITE_FAILED')
    assert.deepEqual(snapshot(ctx.raw), seeded.original, '失败后整库必须回到原样')
    assert.deepEqual(readdirSync(join(docs, 'screenshots')).sort(), seeded.originalFileNames)
    assert.deepEqual(readFileSync(join(docs, 'screenshots', 'one.png')), seeded.originalFileBytes)
    assert.ok(outcome.recoveryBackup, '事务前生成的恢复备份必须保留')
    const recovery = await listRecoveryBackups(seeded.fs)
    assert.equal(recovery.length, 1)
    const parsed = await parseBackupText(await seeded.fs.readText(recovery[0].uri))
    assert.equal(parsed.counts.tasks, 1)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('图片暂存写入失败：不进入恢复备份 / 事务，旧库与旧照片不变', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    const failingFs = {
      ...seeded.fs,
      async writeBase64(uri, base64) {
        if (uri.includes('/backup-staging/restore-')) throw new Error('测试注入：图片暂存写入失败')
        return seeded.fs.writeBase64(uri, base64)
      },
    }
    const outcome = await restoreStagedBackup(ctx.db, failingFs, seeded.preview, { now: () => NOW })
    assert.equal(outcome.committed, false)
    assert.equal(outcome.code, 'IMAGE_STAGE_FAILED')
    assert.deepEqual(snapshot(ctx.raw), seeded.original)
    assert.deepEqual(readdirSync(join(docs, 'screenshots')).sort(), seeded.originalFileNames)
    assert.equal((await listRecoveryBackups(seeded.fs)).length, 0, '图片未验证完不能生成恢复备份')
    const stagingRoot = join(docs, BACKUP_STAGING_DIR_NAME)
    const left = readdirSync(stagingRoot).filter((name) => name.startsWith('restore-'))
    assert.deepEqual(left, [], '失败的唯一 restore 暂存目录必须清理')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('提交后刷新失败：仍返回 committed，只报告 refreshError，不重复破坏性恢复', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    // 导出后改标题，预览新状态，再恢复；postCommit 抛错模拟刷新失败。
    await ctx.tasks.update(
      seeded.task.id,
      taskDraft({
        title: '导出之后改过的标题',
        courseId: seeded.course.id,
        deadline: '2026-12-31',
        originalText: '',
      }),
    )
    const preview = await stageBackupForPreview(ctx.db, seeded.fs, seeded.exported.uri)
    const outcome = await restoreStagedBackup(ctx.db, seeded.fs, preview, {
      now: () => NOW,
      postCommit: async () => {
        throw new Error('测试注入：刷新失败')
      },
    })
    assert.equal(outcome.committed, true)
    assert.match(outcome.refreshError ?? '', /刷新失败/)
    const restored = snapshot(ctx.raw)
    assert.equal(restored.tasks[0].title, '备份里的任务', '数据已经恢复，不能因为刷新失败而回滚或再恢复一次')
    assert.ok(outcome.recoveryBackup)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('恢复备份写入失败：替换不开始，旧库 / 旧照片不变，也不谎报恢复保护', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    const failingFs = {
      ...seeded.fs,
      async writeText(uri, text) {
        if (uri.includes('/backups/') && uri.includes('ddlmate-recovery-')) {
          throw new Error('测试注入：恢复备份写入失败')
        }
        return seeded.fs.writeText(uri, text)
      },
    }
    const outcome = await restoreStagedBackup(ctx.db, failingFs, seeded.preview, { now: () => NOW })
    assert.equal(outcome.committed, false)
    assert.equal(outcome.code, 'RECOVERY_FAILED')
    assert.equal(outcome.recoveryBackup, null, '没有成功生成就不能声称有恢复备份')
    assert.deepEqual(snapshot(ctx.raw), seeded.original)
    assert.deepEqual(readdirSync(join(docs, 'screenshots')).sort(), seeded.originalFileNames)
    assert.deepEqual(readFileSync(join(docs, 'screenshots', 'one.png')), seeded.originalFileBytes)
    assert.equal((await listRecoveryBackups(seeded.fs)).length, 0)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('过期预览：preflight / restore 都在暂停通知与写库之前拒绝，不生成恢复备份', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    const beforeMutation = snapshot(ctx.raw)
    await ctx.tasks.create(taskDraft({ title: '预览之后新增' }))
    const afterMutation = snapshot(ctx.raw)

    const preflight = await preflightRestore(ctx.db, seeded.fs, seeded.preview)
    assert.equal(preflight.ok, false)
    assert.equal(preflight.code, 'STALE_PREVIEW')
    assert.deepEqual(snapshot(ctx.raw), afterMutation)

    const outcome = await restoreStagedBackup(ctx.db, seeded.fs, seeded.preview, { now: () => NOW })
    assert.equal(outcome.committed, false)
    assert.equal(outcome.code, 'STALE_PREVIEW')
    assert.equal(outcome.recoveryBackup, null)
    assert.deepEqual(snapshot(ctx.raw), afterMutation)
    assert.notDeepEqual(afterMutation, beforeMutation, '测试确实改变了当前数据')
    assert.equal((await listRecoveryBackups(seeded.fs)).length, 0)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('坏备份在预览阶段拒绝：未来版本 / 重复 ID / 坏外键 / 路径穿越 / 坏图片 / 超限', async () => {
  const { root, docs, systemDir } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seedAndExport(ctx, docs, systemDir)
    const base = await parseBackupText(await seeded.fs.readText(seeded.exported.uri))
    const before = snapshot(ctx.raw)
    const clone = () => JSON.parse(JSON.stringify(base.data))
    const sealText = async (data) => JSON.stringify(await sealBackupData(data, { now: () => NOW }))

    const newer = JSON.parse(await seeded.fs.readText(seeded.exported.uri))
    newer.version = 99
    await assert.rejects(() => parseBackupText(JSON.stringify(newer)), /版本.*高于/)

    const duplicate = clone()
    duplicate.tasks.push({ ...duplicate.tasks[0] })
    await assert.rejects(async () => parseBackupText(await sealText(duplicate)), /重复/)

    const badFk = clone()
    badFk.tasks[0].courseId = 9999
    await assert.rejects(async () => parseBackupText(await sealText(badFk)), /不存在的课程/)

    const traversal = clone()
    traversal.sources[0].archiveRelPath = '../outside/photo.png'
    await assert.rejects(async () => parseBackupText(await sealText(traversal)), /相对路径/)

    const badImage = clone()
    badImage.images[0].base64 = '!!!!'
    await assert.rejects(async () => parseBackupText(await sealText(badImage)), /base64/)

    const oversize = clone()
    oversize.images[0].byteLength = BACKUP_LIMITS.maxImageBytes + 1
    await assert.rejects(async () => parseBackupText(await sealText(oversize)), /上限|byteLength/)

    const missingImage = clone()
    missingImage.images = []
    await assert.rejects(async () => parseBackupText(await sealText(missingImage)), /不存在的图片/)

    // 一份坏文件走真实预览接口也不能碰数据库。
    const badPath = join(systemDir, 'bad.ddlbackup.json')
    writeFileSync(badPath, await sealText((() => {
      const data = clone()
      data.sources[0].archiveRelPath = '/absolute/photo.png'
      return data
    })()))
    await assert.rejects(
      () => stageBackupForPreview(ctx.db, seeded.fs, pathToFileURL(badPath).href),
      /相对路径/,
    )
    assert.deepEqual(snapshot(ctx.raw), before)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-fail-')
  }
})

test('取消暂存只允许唯一 import-* 子目录：根 / restore-* / 其它会话都不删', async () => {
  const { root, docs } = setup()
  const fs = createBackupFs(docs)
  try {
    const stagingRoot = join(docs, BACKUP_STAGING_DIR_NAME)
    mkdirSync(join(stagingRoot, 'import-session-a'), { recursive: true })
    mkdirSync(join(stagingRoot, 'import-session-b'), { recursive: true })
    mkdirSync(join(stagingRoot, 'restore-other'), { recursive: true })
    const rootUri = pathToFileURL(stagingRoot).href
    const uri = (name) => pathToFileURL(join(stagingRoot, name)).href

    await assert.rejects(() => discardBackupStaging(fs, rootUri), /唯一 import|不属于/)
    await assert.rejects(() => discardBackupStaging(fs, uri('restore-other')), /唯一 import|不属于/)
    await discardBackupStaging(fs, uri('import-session-a'))
    assert.equal(await fs.exists(uri('import-session-a')), false)
    assert.equal(await fs.exists(uri('import-session-b')), true)
    assert.equal(await fs.exists(uri('restore-other')), true)
  } finally {
    removeTempDir(root, 'ddl-backup-fail-')
  }
})
