/**
 * 任务原图「直接从相册 / 相机放一张」的状态机 + 真实文件 / SQLite 测试。
 *
 * 守的是授权范围里点名的运行边界：
 * - 选图 → 先落盘到全局截图库 → 再显式关联当前任务；
 * - 取消选择是正常结果，不写文件、不写记录；
 * - 选图期间切换任务 / 卸载：图片仍可保存，但绝不关联到另一条任务；
 * - 选图期间任务被删除：仓库事务拒绝，图片仍在截图库；
 * - 恢复代次变化 / 备份闸门在选图后关闭：不建立关联，也不谎报「没保存」；
 * - 同一帧双击只发起一次选图 / 归档 / 关联；
 * - 保存后的图片能被后续备份包含，重启后仍能从仓库读回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createBackupFs } from './helpers/backupFs.mjs'
import { createTestDatabase, taskDraft } from './helpers/sqliteHarness.mjs'
import { archivePickedPhoto } from '../src/domain/screenshotArchive.ts'
import { buildBackupData } from '../src/domain/backupService.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'
import { TaskPhotoRepository } from '../src/domain/taskPhotoRepository.ts'
import { createInitialTaskPhotosState, createTaskPhotosOperation } from '../src/screens/taskPhotosController.ts'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='
const PNG = Buffer.from(PNG_BASE64, 'base64')

function nativeFs(root) {
  const toPath = (uri) => fileURLToPath(uri)
  return {
    documentDirectory: `${pathToFileURL(root).href.replace(/\/$/, '')}/`,
    async makeDirectoryAsync(uri, options) {
      await mkdir(toPath(uri), { recursive: options?.intermediates !== false })
    },
    async getInfoAsync(uri) {
      try {
        const info = await stat(toPath(uri))
        return { exists: true, size: info.size, isDirectory: info.isDirectory() }
      } catch {
        return { exists: false }
      }
    },
    async readAsStringAsync(uri) {
      return (await readFile(toPath(uri))).toString('base64')
    },
    async writeAsStringAsync(uri, contents, options) {
      const buffer =
        String(options?.encoding ?? '').toLowerCase() === 'base64'
          ? Buffer.from(String(contents), 'base64')
          : Buffer.from(String(contents), 'utf8')
      await writeFile(toPath(uri), buffer)
    },
    async moveAsync({ from, to }) {
      await rename(toPath(from), toPath(to))
    },
    async deleteAsync(uri) {
      await rm(toPath(uri), { force: true })
    },
    async downloadAsync() {
      throw new Error('测试不走下载')
    },
  }
}

async function context() {
  const root = await mkdtemp(join(tmpdir(), 'ddl-task-direct-'))
  await mkdir(join(root, 'documents'), { recursive: true })
  await writeFile(join(root, 'source.png'), PNG)
  const fs = nativeFs(join(root, 'documents'))
  const db = await createTestDatabase()
  const taskPhotos = new TaskPhotoRepository(db.db)
  const backupFs = createBackupFs(join(root, 'documents'))
  return {
    root,
    db,
    fs,
    backupFs,
    taskPhotos,
    sourceUri: pathToFileURL(join(root, 'source.png')).href,
    cleanup: async () => {
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function readyState(taskId, photos = []) {
  return createInitialTaskPhotosState(taskId, { loaded: true, taskExists: true, photos })
}

function makeOperation(ctx, taskId, overrides = {}) {
  const calls = { pick: 0, archive: 0, attach: 0 }
  const deps = {
    taskId,
    state: readyState(taskId),
    listPhotos: (id) => ctx.taskPhotos.listPhotos(id),
    listAddable: (id, limit) => ctx.taskPhotos.listAddable(id, limit),
    attach: async (id, attemptId) => {
      calls.attach += 1
      return ctx.taskPhotos.attach(id, attemptId)
    },
    detach: (id, attemptId) => ctx.taskPhotos.detach(id, attemptId),
    pickFromLibrary: async () => {
      calls.pick += 1
      return { status: 'picked', uri: ctx.sourceUri, source: { width: 1, height: 1, mimeType: 'image/png' } }
    },
    captureFromCamera: async () => {
      calls.pick += 1
      return { status: 'picked', uri: ctx.sourceUri, source: { width: 1, height: 1, mimeType: 'image/png' } }
    },
    archiveOriginal: async (uri, source, attemptSource) => {
      calls.archive += 1
      const outcome = await archivePickedPhoto(
        { uri, source, attemptSource },
        {
          fs: ctx.fs,
          readSourceBase64: (target) => ctx.fs.readAsStringAsync(target),
          recordAttempt: (input) => ctx.db.screenshots.recordAttempt(input),
        },
      )
      return {
        ok: outcome.ok,
        attemptId: outcome.attemptId,
        message: outcome.ok ? null : outcome.message,
        archivedUri: outcome.ok ? outcome.archivedUri : null,
      }
    },
    getRestoreEpoch: () => 0,
    canWriteNow: () => true,
    ...overrides,
  }
  const operation = createTaskPhotosOperation(deps)
  return { operation, calls }
}

test('从相册添加：先归档到截图库，再显式关联；备份包含原图，重启后仍可读回', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    const { operation, calls } = makeOperation(ctx, task.id)
    const result = await operation.addFromLibrary()
    assert.equal(result, 'started')
    const state = operation.getState()
    assert.equal(state.busy, false)
    assert.equal(state.photos.length, 1)
    assert.equal(state.photos[0].manual, true)
    assert.equal(state.photos[0].attempt.source, 'LIBRARY')
    assert.equal(calls.pick, 1)
    assert.equal(calls.archive, 1)
    assert.equal(calls.attach, 1)
    assert.match(state.notice?.text ?? '', /已把这张截图保存到截图库，并关联到这条任务/)

    const archived = state.photos[0].attempt.archivedPath
    assert.equal((await ctx.fs.getInfoAsync(archived)).exists, true)
    assert.deepEqual(await readFile(fileURLToPath(archived)), PNG)

    const backup = await buildBackupData(ctx.db.db, ctx.backupFs)
    assert.equal(backup.data.images.length, 1)
    assert.equal(backup.data.attempts.length, 1)
    assert.notEqual(backup.data.attempts[0].imageId, null)
    assert.equal(backup.data.attempts[0].imageId, backup.data.images[0].id)

    // 「重启」= 新仓库实例；文件与关联都还在。
    const restartedPhotos = new TaskPhotoRepository(ctx.db.db)
    const persisted = await restartedPhotos.listPhotos(task.id)
    assert.equal(persisted.photos.length, 1)
    const restartedLibrary = new ScreenshotLibraryRepository(ctx.db.db)
    assert.equal((await restartedLibrary.listAttempts()).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('取消选择：正常结束，不保存、不关联、不报错', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    const { operation, calls } = makeOperation(ctx, task.id, {
      pickFromLibrary: async () => ({ status: 'cancelled' }),
    })
    await operation.addFromLibrary()
    assert.equal(calls.archive, 0)
    assert.equal(calls.attach, 0)
    assert.equal((await ctx.db.screenshots.listAttempts()).length, 0)
    assert.equal((await ctx.taskPhotos.listPhotos(task.id)).photos.length, 0)
    assert.match(operation.getState().notice?.text ?? '', /已取消选择/)
  } finally {
    await ctx.cleanup()
  }
})

test('选图期间切到另一条任务：图片可保存，但绝不关联到新任务', async () => {
  const ctx = await context()
  try {
    const first = await ctx.db.tasks.create(taskDraft({ title: '第一条' }))
    const second = await ctx.db.tasks.create(taskDraft({ title: '第二条' }))
    const pending = deferred()
    const { operation, calls } = makeOperation(ctx, first.id, {
      pickFromLibrary: () => pending.promise,
    })
    const running = operation.addFromLibrary()
    operation.setTaskId(second.id)
    pending.resolve({ status: 'picked', uri: ctx.sourceUri, source: { width: 1, height: 1 } })
    await running
    assert.equal(calls.attach, 0, '旧任务的选择不能关联到新任务')
    assert.equal((await ctx.taskPhotos.listPhotos(first.id)).photos.length, 0)
    assert.equal((await ctx.taskPhotos.listPhotos(second.id)).photos.length, 0)
    assert.equal((await ctx.db.screenshots.listAttempts()).length, 1, '图片仍保存到全局截图库')
  } finally {
    await ctx.cleanup()
  }
})

test('选图期间任务被删除：不写关联，页面切成任务不在，图片仍在截图库', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    const pending = deferred()
    const { operation, calls } = makeOperation(ctx, task.id, {
      pickFromLibrary: () => pending.promise,
    })
    const running = operation.addFromLibrary()
    await ctx.db.tasks.remove(task.id)
    pending.resolve({ status: 'picked', uri: ctx.sourceUri, source: { width: 1, height: 1 } })
    await running
    const state = operation.getState()
    assert.equal(calls.attach, 1, '仍然会尝试一次，由仓库事务拒绝')
    assert.equal(state.taskExists, false)
    assert.equal(state.photos.length, 0)
    assert.match(state.notice?.text ?? '', /这条任务已经不在本机/)
    assert.equal((await ctx.db.screenshots.listAttempts()).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('恢复代次在归档后变化：不建立关联，也不谎报图片没保存', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    let epoch = 0
    const { operation, calls } = makeOperation(ctx, task.id, {
      getRestoreEpoch: () => epoch,
      archiveOriginal: async (...args) => {
        const outcome = await archivePickedPhoto(
          { uri: args[0], source: args[1], attemptSource: args[2] },
          {
            fs: ctx.fs,
            readSourceBase64: (target) => ctx.fs.readAsStringAsync(target),
            recordAttempt: (input) => ctx.db.screenshots.recordAttempt(input),
          },
        )
        epoch = 1
        return { ok: outcome.ok, attemptId: outcome.attemptId, message: null, archivedUri: outcome.archivedUri }
      },
    })
    await operation.addFromLibrary()
    assert.equal(calls.attach, 0)
    assert.match(operation.getState().notice?.text ?? '', /备份恢复已经发生/)
    assert.equal((await ctx.db.screenshots.listAttempts()).length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('归档后备份闸门关闭：不关联，消息说明图片已在截图库', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    let writable = true
    const { operation, calls } = makeOperation(ctx, task.id, {
      canWriteNow: () => writable,
      archiveOriginal: async (...args) => {
        const outcome = await archivePickedPhoto(
          { uri: args[0], source: args[1], attemptSource: args[2] },
          {
            fs: ctx.fs,
            readSourceBase64: (target) => ctx.fs.readAsStringAsync(target),
            recordAttempt: (input) => ctx.db.screenshots.recordAttempt(input),
          },
        )
        writable = false
        return { ok: outcome.ok, attemptId: outcome.attemptId, message: null, archivedUri: outcome.archivedUri }
      },
    })
    await operation.addFromLibrary()
    assert.equal(calls.attach, 0)
    assert.match(operation.getState().notice?.text ?? '', /已经保存到截图库/)
    assert.equal((await ctx.db.screenshots.listAttempts()).length, 1)
    assert.equal((await ctx.taskPhotos.listPhotos(task.id)).photos.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('同一帧双击：只发起一次选择 / 归档 / 关联', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    const pending = deferred()
    let pickCalls = 0
    const { operation, calls } = makeOperation(ctx, task.id, {
      pickFromLibrary: () => {
        pickCalls += 1
        return pending.promise
      },
    })
    const first = operation.addFromLibrary()
    const second = await operation.addFromLibrary()
    assert.equal(second, 'busy')
    pending.resolve({ status: 'picked', uri: ctx.sourceUri, source: { width: 1, height: 1 } })
    await first
    assert.equal(pickCalls, 1)
    assert.equal(calls.archive, 1)
    assert.equal(calls.attach, 1)
    assert.equal((await ctx.taskPhotos.listPhotos(task.id)).photos.length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('初始备份闸门关闭：直接拒绝，不打开选择器', async () => {
  const ctx = await context()
  try {
    const task = await ctx.db.tasks.create(taskDraft())
    const { operation, calls } = makeOperation(ctx, task.id, { canWriteNow: () => false })
    const result = await operation.addFromLibrary()
    assert.equal(result, 'blocked')
    assert.equal(calls.pick, 0)
    assert.match(operation.getState().notice?.text ?? '', /备份/)
  } finally {
    await ctx.cleanup()
  }
})
