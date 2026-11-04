/**
 * 「只导入截图」的真实文件 + 真实 SQLite 测试。
 *
 * 守的是：
 * - 只写截图库 / screenshots，任务、课程、课表、设置与旧关联一条不动；
 * - 同一份备份重复导入按校验过的字节幂等，不越导越多；
 * - 同一 SHA 的多条历史尝试（各自带任务关联）全部修复，不只修第一条；
 * - 内容寻址文件被占据时保留原字节，新文件用可被路径恢复识别的 restore 名；
 * - 哈希 / 大小 / 来源文件过期时整体拒绝，不留下半条记录；
 * - 数据库失败回滚并清理本次新建文件；空备份明确说明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createBackupFs } from './helpers/backupFs.mjs'
import { createTestDatabase, courseDraft, failingRunDatabase, scheduleDraft, taskDraft } from './helpers/sqliteHarness.mjs'
import { exportBackupToDirectory, stageBackupForPreview } from '../src/domain/backupService.ts'
import {
  importScreenshotImagesFromBackup,
  imagesFromBackupContentView,
  readImagesFromStagedBackup,
  imagesFromParsedBackup,
} from '../src/domain/screenshotBackupImport.ts'
import { parseBackupText } from '../src/domain/backupFormat.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'
import { appOwnedScreenshotRelativePath } from '../src/domain/screenshotPathRecovery.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII=',
  'base64',
)
const AT = '2026-10-22T02:00:00.000Z'

async function context() {
  const root = await mkdtemp(join(tmpdir(), 'ddl-image-import-'))
  await mkdir(join(root, 'documents'), { recursive: true })
  await mkdir(join(root, 'cache'), { recursive: true })
  await mkdir(join(root, 'exports'), { recursive: true })
  const db = await createTestDatabase()
  const fs = createBackupFs(join(root, 'documents'))
  return {
    root,
    db,
    fs,
    exports: pathToFileURL(join(root, 'exports')).href,
    cleanup: async () => {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function seed(ctx, title = '原始任务') {
  const course = await ctx.db.courses.create(courseDraft())
  await ctx.db.courses.createSchedule(course.id, scheduleDraft())
  await ctx.db.tasks.create(taskDraft({ title, courseId: course.id, originalText: '通知原文' }))
  await ctx.db.tasks.create(taskDraft({ title: '第二条任务' }))
  const original = join(ctx.root, 'documents', 'original.png')
  await writeFile(original, PNG)
  await ctx.db.db.runAsync(
    `INSERT INTO screenshot_attempts
       (captured_at, source, status, archived_path, format, byte_length, width, height, sha256, created_at, updated_at)
     VALUES (?, 'LIBRARY', 'ARCHIVED', ?, 'png', ?, 1, 1, ?, ?, ?);`,
    [AT, pathToFileURL(original).href, PNG.length, '0'.repeat(64), AT, AT],
  )
  // 真实导出会重算哈希；把登记值改对，才能证明「导出物逐字节有效」。
  const { sha256HexOfBase64 } = await import('../src/domain/hashing.ts')
  await ctx.db.db.runAsync('UPDATE screenshot_attempts SET sha256 = ? WHERE id = 1;', [
    await sha256HexOfBase64(PNG.toString('base64')),
  ])
  await ctx.db.db.runAsync(
    "INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at) VALUES (1, 'TASK', 1, 'MANUAL_TASK_PHOTO', ?);",
    [AT],
  )
  return original
}

async function imagesFor(ctx) {
  const exported = await exportBackupToDirectory(ctx.db.db, ctx.fs, ctx.exports)
  const preview = await stageBackupForPreview(ctx.db.db, ctx.fs, exported.uri)
  const images = await readImagesFromStagedBackup(ctx.fs, preview)
  return { exported, preview, images }
}

test('只导入截图：保留当前任务 / 课程 / 课表 / 关联，重复导入字节幂等', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { images } = await imagesFor(ctx)
    await ctx.db.db.runAsync('DELETE FROM screenshot_refs;')
    await ctx.db.db.runAsync('DELETE FROM screenshot_attempts;')
    await ctx.db.db.runAsync("UPDATE tasks SET title = 'current task must survive' WHERE id = 1;")
    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    const tables = ['tasks', 'courses', 'schedules', 'screenshot_refs']
    const before = await Promise.all(tables.map((name) => ctx.db.db.getAllAsync(`SELECT * FROM ${name};`)))

    const first = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images })
    assert.equal(first.committed, true)
    assert.equal(first.imported, 1)
    const attempts = await repo.listAttempts()
    assert.equal(attempts.length, 1)
    assert.deepEqual(await readFile(fileURLToPath(attempts[0].archivedPath)), PNG)
    assert.deepEqual(await Promise.all(tables.map((name) => ctx.db.db.getAllAsync(`SELECT * FROM ${name};`))), before)
    assert.equal((await repo.listRefsForAttempt(attempts[0].id)).length, 0, '不导入旧关联')

    const second = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images })
    assert.equal(second.committed, true)
    assert.equal(second.imported, 0)
    assert.equal(second.skipped, 1)
    assert.equal((await repo.listAttempts()).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('同一 SHA 的多条历史尝试全部修复，任务关联一条不丢、也不新增重复记录', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { images } = await imagesFor(ctx)
    const image = images[0]
    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    await ctx.db.db.runAsync('UPDATE screenshot_attempts SET archived_path = ?, sha256 = ?, byte_length = ? WHERE id = 1;', [
      pathToFileURL(join(ctx.root, 'missing-first.png')).href,
      image.sha256,
      image.byteLength,
    ])
    const second = await repo.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: pathToFileURL(join(ctx.root, 'missing-second.png')).href,
      sha256: image.sha256,
      byteLength: image.byteLength,
      format: 'png',
    })
    await ctx.db.db.runAsync(
      "INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at) VALUES (?, 'TASK', 2, 'MANUAL_TASK_PHOTO', ?);",
      [second.attempt.id, AT],
    )
    const refs = await ctx.db.db.getAllAsync('SELECT * FROM screenshot_refs;')

    const result = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images })
    assert.equal(result.committed, true)
    const attempts = await repo.listAttempts()
    assert.equal(attempts.length, 2, '不新增第三条记录')
    for (const row of attempts) assert.equal(await ctx.fs.exists(row.archivedPath), true, `#${row.id} 仍然打不开`)
    assert.deepEqual(await ctx.db.db.getAllAsync('SELECT * FROM screenshot_refs;'), refs)
    assert.deepEqual(await readFile(fileURLToPath(attempts[0].archivedPath)), PNG)
  } finally {
    await ctx.cleanup()
  }
})

test('内容寻址文件已被占用：保留原字节，导入文件使用可恢复的 restore 名', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { images } = await imagesFor(ctx)
    const image = images[0]
    await ctx.db.db.runAsync('DELETE FROM screenshot_refs;')
    await ctx.db.db.runAsync('DELETE FROM screenshot_attempts;')
    const dir = join(ctx.root, 'documents', 'screenshots')
    await mkdir(dir, { recursive: true })
    const collision = join(dir, `shot-${image.sha256.slice(0, 32)}.png`)
    await writeFile(collision, 'unrelated existing bytes')

    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    const result = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images })
    assert.equal(result.committed, true)
    assert.equal(await readFile(collision, 'utf8'), 'unrelated existing bytes')
    const photo = (await repo.listAttempts())[0]
    assert.deepEqual(await readFile(fileURLToPath(photo.archivedPath)), PNG)
    const relative = appOwnedScreenshotRelativePath(
      `file:///old/Documents/screenshots/${photo.archivedPath.split('/').pop()}`,
      'file:///new/Documents/',
    )
    assert.equal(typeof relative, 'string')
  } finally {
    await ctx.cleanup()
  }
})

test('哈希不符 / 来源摘要过期：整体拒绝，不写记录也不留半成品', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { preview, images } = await imagesFor(ctx)
    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    const tampered = [{ ...images[0], sha256: 'f'.repeat(64) }]
    const before = await repo.listAttempts()
    const failed = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images: tampered })
    assert.equal(failed.committed, false)
    assert.equal(failed.code, 'INVALID_IMAGE')
    assert.deepEqual(await repo.listAttempts(), before)
    const files = await readdir(join(ctx.root, 'documents', 'screenshots')).catch(() => [])
    assert.deepEqual(files, [], '失败不能留下新文件')

    await assert.rejects(
      () => readImagesFromStagedBackup(ctx.fs, { ...preview, backupDigest: 'a'.repeat(64) }),
      /预览之后被改动|文件在预览之后/,
    )
    assert.deepEqual(await repo.listAttempts(), before)
  } finally {
    await ctx.cleanup()
  }
})

test('数据库写入失败：事务回滚、本次新建文件清理、已有数据不动', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { images } = await imagesFor(ctx)
    await ctx.db.db.runAsync('DELETE FROM screenshot_refs;')
    await ctx.db.db.runAsync('DELETE FROM screenshot_attempts;')
    const failing = failingRunDatabase(ctx.db.db, (_count, sql) => sql.includes('INSERT INTO screenshot_attempts'))
    const repo = new ScreenshotLibraryRepository(failing)
    const result = await importScreenshotImagesFromBackup({ db: failing, fs: ctx.fs, repository: repo, images })
    assert.equal(result.committed, false)
    assert.equal(result.code, 'DB_FAILED')
    assert.equal((await ctx.db.db.getAllAsync('SELECT * FROM screenshot_attempts;')).length, 0)
    const files = await readdir(join(ctx.root, 'documents', 'screenshots')).catch(() => [])
    assert.deepEqual(files, [], '回滚后本次新建的图片要清理')
  } finally {
    await ctx.cleanup()
  }
})

test('空备份：明确说明没有截图，任务和课程不动', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    const before = await ctx.db.db.getAllAsync('SELECT * FROM tasks;')
    const result = await importScreenshotImagesFromBackup({ db: ctx.db.db, fs: ctx.fs, repository: repo, images: [] })
    assert.equal(result.committed, true)
    assert.equal(result.total, 0)
    assert.match(result.message, /没有可导入的截图/)
    assert.deepEqual(await ctx.db.db.getAllAsync('SELECT * FROM tasks;'), before)
  } finally {
    await ctx.cleanup()
  }
})

test('从严格解析结果取图片：只带图片与第一次采集时间，不复制 refs / 外部 id 关联', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { exported } = await imagesFor(ctx)
    const text = await ctx.fs.readText(exported.uri)
    const parsed = await parseBackupText(text)
    const images = imagesFromParsedBackup(parsed)
    assert.equal(images.length, 1)
    assert.equal(images[0].sha256, parsed.data.images[0].sha256)
    assert.equal(images[0].capturedAt, parsed.data.attempts[0].capturedAt)
    assert.equal('refs' in images[0], false)
    assert.equal('id' in images[0], true)
  } finally {
    await ctx.cleanup()
  }
})

test('内容视图的暂存图片也能只导入：回读字节并重新校验后才写记录', async () => {
  const ctx = await context()
  try {
    await seed(ctx)
    const { images } = await imagesFor(ctx)
    await ctx.db.db.runAsync('DELETE FROM screenshot_refs;')
    await ctx.db.db.runAsync('DELETE FROM screenshot_attempts;')
    const staged = join(ctx.root, 'documents', 'view-image.png')
    await writeFile(staged, Buffer.from(images[0].base64, 'base64'))
    const view = {
      images: [
        {
          imageId: images[0].id,
          sha256: images[0].sha256,
          byteLength: images[0].byteLength,
          width: images[0].width,
          height: images[0].height,
          format: images[0].format,
          capturedAt: images[0].capturedAt,
          stagedUri: pathToFileURL(staged).href,
        },
      ],
    }
    const candidates = imagesFromBackupContentView(view)
    const repo = new ScreenshotLibraryRepository(ctx.db.db)
    const result = await importScreenshotImagesFromBackup({
      db: ctx.db.db,
      fs: ctx.fs,
      repository: repo,
      images: candidates,
    })
    assert.equal(result.committed, true)
    assert.equal(result.imported, 1)
    const attempts = await repo.listAttempts()
    assert.deepEqual(await readFile(fileURLToPath(attempts[0].archivedPath)), PNG)
  } finally {
    await ctx.cleanup()
  }
})
