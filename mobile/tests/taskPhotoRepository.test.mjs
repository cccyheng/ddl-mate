/**
 * 任务原图关联 —— **真实 SQLite 持久化**测试。
 *
 * 守的是本轮授权书里最硬的几条：
 * - 只读写既有 `screenshot_refs` / `screenshot_attempts`，没有迁移；
 * - 添加 / 重复添加幂等 / 同一张原图可以独立关联到两条任务；
 * - 解除关联**只**删除这条任务的 `MANUAL_TASK_PHOTO` 引用，
 *   原图、OCR 结果、课程 / 其它任务 / 历史引用全部保留；
 * - 没有归档文件 / `ARCHIVE_FAILED` 的尝试拒绝关联；
 *   识别失败 / 取消但原图仍在的尝试可以关联；
 * - 任务被删除后读取「任务不在」、添加 / 解除都零写入；
 * - 写入失败整体回滚；关库重开之后关联还在。
 *
 * 边界：Node 侧 `node:sqlite`，验证 SQL 与事务逻辑，验证不了 iPhone 上的 expo-sqlite。
 * 所有数据库都是内存库或系统临时目录里的临时文件，**绝不碰真实用户数据**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyAdditiveColumns,
  createTestDatabase,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { SCHEMA_VERSION } from '../src/db/schema.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'
import {
  MANUAL_TASK_PHOTO,
  TASK_PHOTO_CANDIDATE_LIMIT,
  TaskPhotoRepository,
} from '../src/domain/taskPhotoRepository.ts'
import { TaskRepository } from '../src/domain/taskRepository.ts'

const NOW = new Date('2026-10-20T03:00:00.000Z')
const FIXED_CAPTURED = '2026-10-12T04:00:00.000Z'

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-taskphotos-'))
  return { dir, file: join(dir, 'task-photos.db') }
}

function openFileDatabase(file) {
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  return {
    raw,
    db,
    tasks: new TaskRepository(db, () => NOW),
    screenshots: new ScreenshotLibraryRepository(db, { now: () => NOW }),
    photos: new TaskPhotoRepository(db, { now: () => NOW }),
  }
}

async function withMemoryDatabase(run) {
  const ctx = await createTestDatabase()
  const photos = new TaskPhotoRepository(ctx.db, { now: () => NOW })
  try {
    await run({ ...ctx, photos })
  } finally {
    ctx.close()
  }
}

async function createTask(tasks, overrides = {}) {
  const outcome = await tasks.create(taskDraft(overrides))
  return outcome.id
}

async function recordAttempt(screenshots, overrides = {}) {
  const outcome = await screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    capturedAt: FIXED_CAPTURED,
    archivedPath: 'file:///docs/screenshots/shot-a.png',
    sha256: 'a'.repeat(64),
    byteLength: 2048,
    width: 1170,
    height: 2532,
    format: 'png',
    mimeType: 'image/png',
    ...overrides,
  })
  return outcome.attempt.id
}

function insertAttemptRaw(raw, index, overrides = {}) {
  const capturedAt = new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString()
  const archivedPath = `file:///docs/screenshots/shot-${index}.png`
  raw
    .prepare(
      `INSERT INTO screenshot_attempts
         (captured_at, source, status, archived_path, sha256, byte_length, width, height, format, mime_type, created_at, updated_at)
       VALUES (?, 'LIBRARY', 'ARCHIVED', ?, ?, 1024, 100, 100, 'png', 'image/png', ?, ?);`,
    )
    .run(capturedAt, archivedPath, `s${index}`.padEnd(64, '0'), NOW.toISOString(), NOW.toISOString())
  return Number(raw.prepare('SELECT last_insert_rowid() AS id;').get().id)
}

function refCount(raw, relation = null) {
  return relation
    ? Number(raw.prepare('SELECT COUNT(*) AS n FROM screenshot_refs WHERE relation = ?;').get(relation).n)
    : Number(raw.prepare('SELECT COUNT(*) AS n FROM screenshot_refs;').get().n)
}

/* --------------------------------- 用例 --------------------------------- */

test('添加 → 读取 → 关库重开：关联还在；读取本身零写入', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, { title: '课程论文' })
    const attemptId = await recordAttempt(opened.screenshots)

    const beforeRefs = refCount(opened.raw)
    const empty = await opened.photos.listPhotos(taskId)
    assert.deepEqual(empty, { taskExists: true, photos: [] })
    assert.equal(refCount(opened.raw), beforeRefs, '读取不会自己创建关联')

    const attached = await opened.photos.attach(taskId, attemptId)
    assert.equal(attached.committed, true)
    assert.equal(attached.idempotent, false)
    assert.equal(attached.code, null)
    assert.ok(attached.manualRefId !== null && attached.manualRefId > 0)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1)

    const list = await opened.photos.listPhotos(taskId)
    assert.equal(list.taskExists, true)
    assert.equal(list.photos.length, 1)
    assert.equal(list.photos[0].manual, true)
    assert.equal(list.photos[0].attempt.id, attemptId)
    assert.equal(list.photos[0].attempt.archivedPath, 'file:///docs/screenshots/shot-a.png')
    assert.equal(list.photos[0].attempt.source, 'LIBRARY')
    assert.equal(list.photos[0].attempt.capturedAt, FIXED_CAPTURED)

    // 读取（含候选）不写任何东西。
    const beforeAttempts = Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_attempts;').get().n)
    await opened.photos.listPhotos(taskId)
    await opened.photos.listAddable(taskId)
    assert.equal(refCount(opened.raw), beforeRefs + 1, '只有刚才 attach 写过一次')
    assert.equal(
      Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_attempts;').get().n),
      beforeAttempts,
    )
    opened.raw.close()

    const reopened = openFileDatabase(file)
    const persisted = await reopened.photos.listPhotos(taskId)
    assert.equal(persisted.taskExists, true)
    assert.equal(persisted.photos.length, 1)
    assert.equal(persisted.photos[0].manual, true)
    assert.equal(persisted.photos[0].attempt.id, attemptId)
    reopened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('重复添加幂等：同一次尝试、同一份归档文件的另一次尝试都只保留一条手动引用', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const first = await recordAttempt(opened.screenshots)

    const once = await opened.photos.attach(taskId, first)
    assert.equal(once.committed, true)
    assert.equal(once.idempotent, false)

    const twice = await opened.photos.attach(taskId, first)
    assert.equal(twice.committed, true)
    assert.equal(twice.idempotent, true)
    assert.equal(twice.manualRefId, once.manualRefId)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1, '重复添加不会堆第二行')

    // 内容寻址 + 去重：同一份字节再登记一次是新的 attempt，但仍是同一张原图。
    const duplicate = await recordAttempt(opened.screenshots, {
      note: '同一张图再登记一次',
    })
    assert.notEqual(duplicate, first, '尝试历史是新的')
    const viaDuplicate = await opened.photos.attach(taskId, duplicate)
    assert.equal(viaDuplicate.committed, true)
    assert.equal(viaDuplicate.idempotent, true, '按归档路径识别为同一张原图')
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1)

    const list = await opened.photos.listPhotos(taskId)
    assert.equal(list.photos.length, 1, '界面上一张原图只出现一次')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('同一张原图可以独立关联到两条任务；解除一条不影响另一条', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskA = await createTask(opened.tasks, { title: '任务 A' })
    const taskB = await createTask(opened.tasks, { title: '任务 B' })
    const attemptId = await recordAttempt(opened.screenshots)

    assert.equal((await opened.photos.attach(taskA, attemptId)).committed, true)
    assert.equal((await opened.photos.attach(taskB, attemptId)).committed, true)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 2)

    assert.equal((await opened.photos.detach(taskA, attemptId)).removed, true)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1)
    assert.equal((await opened.photos.listPhotos(taskA)).photos.length, 0)
    const stillB = await opened.photos.listPhotos(taskB)
    assert.equal(stillB.photos.length, 1)
    assert.equal(stillB.photos[0].manual, true)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('解除只删本模块的手动引用：原图 / OCR / 课程 / 历史 / 其它任务引用全部保留', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskA = await createTask(opened.tasks, { title: '任务 A' })
    const taskB = await createTask(opened.tasks, { title: '任务 B' })
    const attemptId = await recordAttempt(opened.screenshots)
    await opened.screenshots.recordOcrResult({
      attemptId,
      status: 'SUCCESS',
      requestId: 'req-keep',
      rawText: '识别结果要保留',
      candidates: [],
    })
    await opened.photos.attach(taskA, attemptId)
    await opened.photos.attach(taskB, attemptId)
    // 历史任务引用（不是本模块的手动关系）+ 课程引用。
    await opened.screenshots.linkRef({ attemptId, targetKind: 'TASK', targetId: taskA, relation: 'SOURCE' })
    await opened.screenshots.linkRef({ attemptId, targetKind: 'COURSE', targetId: 7, relation: 'IMPORTED_COURSE' })

    const before = {
      attempt: Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_attempts WHERE id = ?;').get(attemptId).n),
      ocr: Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM ocr_results WHERE attempt_id = ?;').get(attemptId).n),
      course: Number(opened.raw.prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'COURSE';").get().n),
      taskB: Number(
        opened.raw
          .prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'TASK' AND target_id = ? AND relation = ?;")
          .get(taskB, MANUAL_TASK_PHOTO).n,
      ),
      historical: Number(
        opened.raw
          .prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'TASK' AND target_id = ? AND relation = 'SOURCE';")
          .get(taskA).n,
      ),
    }

    const detached = await opened.photos.detach(taskA, attemptId)
    assert.equal(detached.committed, true)
    assert.equal(detached.removed, true)

    assert.equal(
      Number(
        opened.raw
          .prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'TASK' AND target_id = ? AND relation = ?;")
          .get(taskA, MANUAL_TASK_PHOTO).n,
      ),
      0,
      '只删掉任务 A 的手动引用',
    )
    assert.equal(
      Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_attempts WHERE id = ?;').get(attemptId).n),
      before.attempt,
      '原图尝试还在',
    );
    assert.equal(
      Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM ocr_results WHERE attempt_id = ?;').get(attemptId).n),
      before.ocr,
      'OCR 结果还在',
    )
    assert.equal(
      Number(opened.raw.prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'COURSE';").get().n),
      before.course,
      '课程引用还在',
    )
    assert.equal(
      Number(
        opened.raw
          .prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'TASK' AND target_id = ? AND relation = ?;")
          .get(taskB, MANUAL_TASK_PHOTO).n,
      ),
      before.taskB,
      '任务 B 的关联还在',
    )
    assert.equal(
      Number(
        opened.raw
          .prepare("SELECT COUNT(*) AS n FROM screenshot_refs WHERE target_kind = 'TASK' AND target_id = ? AND relation = 'SOURCE';")
          .get(taskA).n,
      ),
      before.historical,
      '历史引用还在',
    )

    // 任务 A 仍能看到这张图，但只能只读：没有手动关联，只有历史关系。
    const after = await opened.photos.listPhotos(taskA)
    assert.equal(after.photos.length, 1)
    assert.equal(after.photos[0].manual, false)
    assert.deepEqual(after.photos[0].otherRelations, ['SOURCE'])

    // 再解除一次：幂等，不报错、不再删任何东西。
    const again = await opened.photos.detach(taskA, attemptId)
    assert.equal(again.committed, true)
    assert.equal(again.removed, false)
    assert.equal(refCount(opened.raw), before.course + before.taskB + before.historical)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('没有归档文件 / ARCHIVE_FAILED / 不存在的尝试：拒绝关联且零写入', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)

    const noPath = await recordAttempt(opened.screenshots, {
      status: 'ARCHIVED',
      archivedPath: null,
      sha256: null,
    })
    const archiveFailedWithPath = await recordAttempt(opened.screenshots, {
      status: 'ARCHIVE_FAILED',
      archivedPath: 'file:///docs/screenshots/failed-but-path.png',
      sha256: 'f'.repeat(64),
    })

    for (const attemptId of [noPath, archiveFailedWithPath, taskId + 999]) {
      const outcome = await opened.photos.attach(taskId, attemptId)
      assert.equal(outcome.committed, false)
      assert.ok(outcome.code === 'PHOTO_NOT_ARCHIVED' || outcome.code === 'PHOTO_MISSING')
      assert.match(outcome.reason, /不能关联|不在本机截图库/)
    }

    const missingTask = await opened.photos.attach(taskId + 50, noPath)
    assert.equal(missingTask.committed, false)
    assert.equal(missingTask.code, 'TASK_MISSING')
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 0, '所有失败路径都是零写入')

    // 非法 ID 在仓库层就拒绝，连查询都不需要。
    for (const bad of [0, -1, 1.5, Number.NaN, '12']) {
      const invalidTask = await opened.photos.attach(bad, noPath)
      assert.equal(invalidTask.committed, false)
      assert.equal(invalidTask.code, 'INVALID_TASK_ID')
      const invalidPhoto = await opened.photos.attach(taskId, bad)
      assert.equal(invalidPhoto.committed, false)
      assert.equal(invalidPhoto.code, 'INVALID_PHOTO_ID')
    }
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 0)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('识别失败 / 取消但原图仍在：允许关联，状态如实保留', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const attemptId = await recordAttempt(opened.screenshots)
    await opened.screenshots.recordOcrResult({
      attemptId,
      status: 'FAILED',
      errorCode: 'OCR_TIMEOUT',
      errorMessage: '识别超时',
      candidates: [],
    })
    const attempt = await opened.screenshots.getAttempt(attemptId)
    assert.equal(attempt.status, 'FAILED', 'OCR 失败会更新尝试状态，但不会删原图')

    const attached = await opened.photos.attach(taskId, attemptId)
    assert.equal(attached.committed, true, '有归档原图就可以关联')
    const list = await opened.photos.listPhotos(taskId)
    assert.equal(list.photos.length, 1)
    assert.equal(list.photos[0].attempt.status, 'FAILED')
    assert.equal(list.photos[0].attempt.archivedPath, 'file:///docs/screenshots/shot-a.png')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('任务在打开页面之后被删除：读取返回任务不在，添加 / 解除都拒绝且保留原图与历史引用', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const attemptId = await recordAttempt(opened.screenshots)
    const attached = await opened.photos.attach(taskId, attemptId)
    assert.equal(attached.committed, true)

    await opened.tasks.remove(taskId)

    const list = await opened.photos.listPhotos(taskId)
    assert.deepEqual(list, { taskExists: false, photos: [] })
    const addable = await opened.photos.listAddable(taskId)
    assert.deepEqual(addable, { taskExists: false, photos: [] })

    const add = await opened.photos.attach(taskId, attemptId)
    assert.equal(add.committed, false)
    assert.equal(add.code, 'TASK_MISSING')
    const remove = await opened.photos.detach(taskId, attemptId)
    assert.equal(remove.committed, false)
    assert.equal(remove.code, 'TASK_MISSING')

    assert.equal(
      Number(opened.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_attempts WHERE id = ?;').get(attemptId).n),
      1,
      '删除任务绝不删除原图尝试',
    )
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1, '历史引用也不被任务删除顺手清掉')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('写入失败：事务回滚，关联一条都不留；之后仍可正常添加', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const attemptId = await recordAttempt(opened.screenshots)

    const failing = {
      ...opened.db,
      async runAsync(sql, params = []) {
        if (String(sql).includes('INSERT INTO screenshot_refs')) {
          throw new Error('测试注入的写入失败')
        }
        return opened.db.runAsync(sql, params)
      },
    }
    const failingRepo = new TaskPhotoRepository(failing, { now: () => NOW })
    const failed = await failingRepo.attach(taskId, attemptId)
    assert.equal(failed.committed, false)
    assert.equal(failed.code, 'WRITE_FAILED')
    assert.match(failed.reason, /没有写入/)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 0, '失败后零改动')
    assert.equal((await opened.photos.listPhotos(taskId)).photos.length, 0)

    // 真实连接再确认一次：没有半条记录，仍然可以正常添加。
    const after = await opened.photos.attach(taskId, attemptId)
    assert.equal(after.committed, true)
    assert.equal(refCount(opened.raw, MANUAL_TASK_PHOTO), 1)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('候选列表：默认最多 300 张、最近在前、已手动关联的排除；不自动选择 / 不自动写', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const ids = []
    for (let index = 0; index < 305; index += 1) {
      ids.push(insertAttemptRaw(opened.raw, index))
    }

    const before = refCount(opened.raw)
    const defaultList = await opened.photos.listAddable(taskId)
    assert.equal(TASK_PHOTO_CANDIDATE_LIMIT, 300)
    assert.equal(defaultList.taskExists, true)
    assert.equal(defaultList.photos.length, 300, '默认上限就是界面写出的 300')
    assert.equal(defaultList.photos[0].id, ids[304], '最近保存的在前')
    assert.equal(defaultList.photos[299].id, ids[5])
    assert.equal(refCount(opened.raw), before, '列候选不会自动选择或写入')

    const capped = await opened.photos.listAddable(taskId, 1000)
    assert.equal(capped.photos.length, 300, '请求更多也只到 300')
    const small = await opened.photos.listAddable(taskId, 5)
    assert.deepEqual(small.photos.map((photo) => photo.id), ids.slice(-5).reverse())

    // 关联最新一张之后，候选里不再出现它。
    const linked = await opened.photos.attach(taskId, ids[304])
    assert.equal(linked.committed, true)
    const afterLink = await opened.photos.listAddable(taskId)
    assert.equal(afterLink.photos.length, 300)
    assert.equal(afterLink.photos.some((photo) => photo.id === ids[304]), false, '已关联的不再列出')

    // 同一份归档文件的另一次尝试也应该被排除（按原图而不是按尝试去重）。
    const duplicate = await recordAttempt(opened.screenshots, {
      archivedPath: 'file:///docs/screenshots/shot-304.png',
      sha256: 's304'.padEnd(64, '0'),
      capturedAt: '2026-10-31T00:00:00.000Z',
    })
    const afterDuplicate = await opened.photos.listAddable(taskId)
    assert.equal(
      afterDuplicate.photos.some((photo) => photo.id === duplicate),
      false,
      '同一份归档文件已经手动关联过，不再作为候选',
    )
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-taskphotos-')
  }
})

test('候选列表只含可查看原图：无路径 / ARCHIVE_FAILED 不出现，识别失败但原图仍在会出现', async () => {
  await withMemoryDatabase(async (ctx) => {
    const taskId = await createTask(ctx.tasks)
    const good = await recordAttempt(ctx.screenshots, {
      archivedPath: 'file:///docs/screenshots/good.png',
      sha256: '1'.repeat(64),
    })
    const failedOcr = await recordAttempt(ctx.screenshots, {
      archivedPath: 'file:///docs/screenshots/failed-ocr.png',
      sha256: '2'.repeat(64),
    })
    await ctx.screenshots.recordOcrResult({ attemptId: failedOcr, status: 'CANCELLED', candidates: [] })
    await recordAttempt(ctx.screenshots, {
      status: 'ARCHIVE_FAILED',
      archivedPath: null,
      sha256: null,
      capturedAt: '2026-10-13T04:00:00.000Z',
    })
    await recordAttempt(ctx.screenshots, {
      status: 'ARCHIVED',
      archivedPath: null,
      sha256: null,
      capturedAt: '2026-10-14T04:00:00.000Z',
    })

    const list = await ctx.photos.listAddable(taskId)
    assert.deepEqual(list.photos.map((photo) => photo.id).sort((a, b) => a - b), [good, failedOcr].sort((a, b) => a - b))
  })
})

test('非法任务 ID 读取不崩、不写：返回任务不在；解除非法 ID 也拒绝', async () => {
  await withMemoryDatabase(async (ctx) => {
    for (const bad of [0, -2, 2.5, Number.NaN, '9']) {
      assert.deepEqual(await ctx.photos.listPhotos(bad), { taskExists: false, photos: [] })
      assert.deepEqual(await ctx.photos.listAddable(bad), { taskExists: false, photos: [] })
      const detached = await ctx.photos.detach(bad, 1)
      assert.equal(detached.committed, false)
      assert.equal(detached.code, 'INVALID_TASK_ID')
    }
    assert.equal(refCount(ctx.raw), 0)
  })
})
