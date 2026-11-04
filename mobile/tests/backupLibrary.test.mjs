/**
 * 本机备份库 / 只读内容预览的真实文件测试。
 *
 * 覆盖：重启后仍可发现、同秒冲突文件名、恢复备份可直接查看、内容来自备份而非
 * Live DB、只读零写库、缺失/损坏可见、创建失败、保留后外部另存前重新校验、
 * 唯一 view-* 清理、图片逐字节校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createTestDatabase, taskDraft, courseDraft } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import {
  BACKUP_DIR_NAME,
  BACKUP_LIBRARY_DIR_NAME,
  closeBackupContentView,
  createLocalBackup,
  exportBackupToDirectory,
  listBackupLibrary,
  openBackupContentView,
  saveBackupLibraryEntryToDirectory,
} from '../src/domain/backupService.ts'
import { sha256HexOfBase64 } from '../src/domain/hashing.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z')
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ddl-backup-library-'))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  return { root, docs }
}

function snapshot(raw) {
  const tables = ['tasks', 'courses', 'schedules', 'task_sources', 'screenshot_attempts', 'source_screenshots', 'screenshot_refs']
  const result = {}
  for (const table of tables) result[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY id ASC;`).all()
  result.app_settings = raw.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key ASC;').all()
  return result
}

async function seed(ctx, docs) {
  const course = await ctx.courses.create(courseDraft({ name: '数据结构', instructor: '王老师', selectionSerial: '9913000172.08' }))
  const task = await ctx.tasks.create(
    taskDraft({
      title: '备份里的旧标题',
      courseId: course.id,
      deadline: '2026-12-31',
      originalText: '原始通知',
    }),
  )
  const bytes = Buffer.from(TINY_PNG, 'base64')
  const file = join(docs, 'screenshots', 'one.png')
  writeFileSync(file, bytes)
  const uri = pathToFileURL(file).href
  await ctx.screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    archivedPath: uri,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
  })
  return { course, task }
}

test('本机备份重启后仍从真实文件发现；内容来自备份而非当前 DB，只读且可清理', async () => {
  const { root, docs } = setup()
  const ctx = await createTestDatabase()
  try {
    const seeded = await seed(ctx, docs)
    const fs1 = createBackupFs(docs)
    const created = await createLocalBackup(ctx.db, fs1, { now: () => NOW })
    assert.match(created.fileName, /^ddlmate-library-20261008-120000\.ddlbackup\.json$/)
    const before = snapshot(ctx.raw)

    // 模拟重启：全新的文件系统适配器实例，只共享同一 Documents。
    const fs2 = createBackupFs(docs)
    const entries = await listBackupLibrary(fs2)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, 'library')
    assert.equal(entries[0].valid, true)
    assert.equal(entries[0].counts?.tasks, 1)
    assert.equal(entries[0].counts?.images, 1)

    // 备份创建后改当前 DB；打开内容仍必须显示备份里的旧标题。
    await ctx.tasks.update(
      seeded.task.id,
      taskDraft({
        title: '当前 DB 的新标题',
        courseId: seeded.course.id,
        deadline: '2026-12-31',
        originalText: '',
      }),
    )
    const afterMutation = snapshot(ctx.raw)
    const view = await openBackupContentView(fs2, entries[0])
    assert.equal(view.tasks.length, 1)
    assert.equal(view.tasks[0].title, '备份里的旧标题')
    assert.equal(view.courses[0].name, '数据结构')
    assert.equal(view.courses[0].instructor, '王老师')
    assert.equal(view.schedules.length, 0)
    assert.equal(view.images.length, 1)
    assert.equal(view.images[0].format, 'png')
    assert.equal(view.images[0].byteLength, Buffer.from(TINY_PNG, 'base64').length)
    const staged = readFileSync(fileURLToPath(view.images[0].stagedUri))
    assert.equal(createHash('sha256').update(staged).digest('hex'), view.images[0].sha256)
    assert.deepEqual(snapshot(ctx.raw), afterMutation, '只读内容预览不能写当前数据库')

    assert.equal(await fs2.exists(view.viewDir), true)
    await closeBackupContentView(fs2, view.viewDir)
    assert.equal(await fs2.exists(view.viewDir), false)
    assert.deepEqual(snapshot(ctx.raw), afterMutation, '关闭内容视图不能改变数据库')
    assert.deepEqual(before.tasks[0].title, '备份里的旧标题')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-library-')
  }
})

test('同一秒创建多份本机 / 恢复备份：-2 冲突文件名仍可发现、打开、另存', async () => {
  const { root, docs } = setup()
  const ctx = await createTestDatabase()
  try {
    await ctx.tasks.create(taskDraft({ title: '同秒备份' }))
    const fs = createBackupFs(docs)
    const first = await createLocalBackup(ctx.db, fs, { now: () => NOW })
    const second = await createLocalBackup(ctx.db, fs, { now: () => NOW })
    assert.notEqual(first.fileName, second.fileName)
    assert.match(second.fileName, /\.ddlbackup-2\.json$/)

    const recoveryDir = join(docs, BACKUP_DIR_NAME)
    mkdirSync(recoveryDir, { recursive: true })
    const rec1 = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(recoveryDir).href, {
      now: () => NOW,
      fileNamePrefix: 'ddlmate-recovery',
    })
    const rec2 = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(recoveryDir).href, {
      now: () => NOW,
      fileNamePrefix: 'ddlmate-recovery',
    })
    assert.match(rec2.fileName, /\.ddlbackup-2\.json$/)

    const entries = await listBackupLibrary(fs)
    assert.equal(entries.filter((entry) => entry.kind === 'library').length, 2)
    assert.equal(entries.filter((entry) => entry.kind === 'recovery').length, 2)
    for (const entry of entries) {
      assert.equal(entry.valid, true)
      const view = await openBackupContentView(fs, entry)
      assert.ok(view.tasks.length >= 1)
      await closeBackupContentView(fs, view.viewDir)
    }

    const outDir = join(root, 'saved')
    mkdirSync(outDir, { recursive: true })
    const saved = await saveBackupLibraryEntryToDirectory(
      fs,
      entries.find((entry) => entry.fileName === second.fileName),
      pathToFileURL(outDir).href,
    )
    assert.match(saved.fileName, /\.ddlbackup-2\.json$/)
    assert.ok(readFileSync(fileURLToPath(saved.uri)).length > 0)
    assert.ok(rec1.fileName)
    assert.ok(rec2.fileName)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-library-')
  }
})

test('缺失 / 损坏文件可见且打开失败；创建失败不写新文件', async () => {
  const { root, docs } = setup()
  const ctx = await createTestDatabase()
  try {
    await ctx.tasks.create(taskDraft({ title: '用于备份' }))
    const fs = createBackupFs(docs)
    const created = await createLocalBackup(ctx.db, fs, { now: () => NOW })
    const libraryDir = join(docs, BACKUP_DIR_NAME, BACKUP_LIBRARY_DIR_NAME)
    const corruptName = 'ddlmate-library-20261008-040001.ddlbackup.json'
    writeFileSync(join(libraryDir, corruptName), '{not-json')
    const beforeList = await listBackupLibrary(fs)
    assert.equal(beforeList.some((entry) => entry.fileName === corruptName && !entry.valid), true)
    await assert.rejects(
      () => openBackupContentView(fs, { kind: 'library', fileName: corruptName }),
      /JSON|格式|损坏|解析/,
    )

    rmSync(fileURLToPath(created.uri))
    const afterDelete = await listBackupLibrary(fs)
    assert.equal(afterDelete.some((entry) => entry.fileName === created.fileName), false)
    await assert.rejects(
      () => openBackupContentView(fs, { kind: 'library', fileName: created.fileName }),
      /不在本机|读不到/,
    )

    // 写入失败：模拟 library 目录 writeText 抛错；不能留下 .part / 半文件。
    const failingFs = {
      ...fs,
      async writeText(uri, text) {
        if (uri.includes(`/${BACKUP_LIBRARY_DIR_NAME}/`)) throw new Error('测试注入：写入失败')
        return fs.writeText(uri, text)
      },
    }
    await assert.rejects(() => createLocalBackup(ctx.db, failingFs, { now: () => NOW }), /写入失败/)
    const names = await fs.listNames(libraryDir)
    assert.equal(names.some((name) => name.includes('.part-')), false)
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-library-')
  }
})

test('列表之后文件变坏：外部另存必须重新 parser 失败，且不留下目标文件', async () => {
  const { root, docs } = setup()
  const ctx = await createTestDatabase()
  try {
    await ctx.tasks.create(taskDraft({ title: '另存测试' }))
    const fs = createBackupFs(docs)
    const created = await createLocalBackup(ctx.db, fs, { now: () => NOW })
    const entries = await listBackupLibrary(fs)
    const entry = entries.find((item) => item.fileName === created.fileName)
    assert.ok(entry)

    writeFileSync(fileURLToPath(created.uri), '{broken-after-list')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    await assert.rejects(
      () => saveBackupLibraryEntryToDirectory(fs, entry, pathToFileURL(outDir).href),
      /JSON|格式|损坏|解析/,
    )
    assert.deepEqual(await fs.listNames(pathToFileURL(outDir).href), [])
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-library-')
  }
})
