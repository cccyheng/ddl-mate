/**
 * 旧截图绝对路径的安全修复（真实临时磁盘 + 真实 SQLite）。
 *
 * 守的是：
 * - 只提取应用自己的 `screenshots/<内容寻址名>`，再拼到**当前** documentDirectory；
 * - 文件不存在 → missing，记录仍保留；
 * - 字节数 / SHA-256 / 格式任一不符 → rejected，绝不按文件名猜；
 * - 哈希缺失时至少要求文件名里的内容指纹与真实字节一致；
 * - 只接受本机 file URI / 绝对路径，拒绝 http(s)、带 host 的 file URI、`..` 与外部目录；
 * - 数据库更新是带旧值条件的单列 CAS，失败不改任何东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { sha256HexOfBase64 } from '../src/domain/hashing.ts'
import { MAX_ARCHIVE_BYTES } from '../src/domain/screenshotFiles.ts'
import {
  appOwnedScreenshotRelativePath,
  isAppOwnedScreenshotFileName,
  repairScreenshotPaths,
  resolveScreenshotPath,
} from '../src/domain/screenshotPathRecovery.ts'
import { createTestDatabase } from './helpers/sqliteHarness.mjs'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='
const PNG = Buffer.from(PNG_BASE64, 'base64')

function nativeScreenshotFs(documentDirectory) {
  const toPath = (uri) => fileURLToPath(uri)
  return {
    documentDirectory: `${pathToFileURL(documentDirectory).href.replace(/\/$/, '')}/`,
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
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ddl-path-recovery-'))
  const screenshots = join(root, 'screenshots')
  await mkdir(screenshots, { recursive: true })
  const sha = await sha256HexOfBase64(PNG_BASE64)
  const fileName = `shot-${sha.slice(0, 32)}.png`
  await writeFile(join(screenshots, fileName), PNG)
  const fs = nativeScreenshotFs(root)
  const newPath = `${fs.documentDirectory}screenshots/${fileName}`
  const oldPath = `file:///var/mobile/Containers/Data/Application/OLD-UUID/Documents/screenshots/${fileName}`
  return {
    root,
    fs,
    sha,
    fileName,
    newPath,
    oldPath,
    record: {
      id: 1,
      archivedPath: oldPath,
      sha256: sha,
      byteLength: PNG.length,
      format: 'png',
      status: 'ARCHIVED',
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('旧容器路径 → 当前应用目录：相同相对位置、字节与哈希都一致才修复', async () => {
  const ctx = await setup()
  try {
    const resolution = await resolveScreenshotPath(ctx.record, ctx.fs)
    assert.equal(resolution.status, 'repaired')
    assert.equal(resolution.update.newPath, ctx.newPath)
    assert.equal(resolution.update.sha256, ctx.sha)
    assert.equal(resolution.update.byteLength, PNG.length)

    const applied = []
    const report = await repairScreenshotPaths([ctx.record], ctx.fs, async (update) => {
      applied.push(update)
      return true
    })
    assert.equal(report.repaired, 1)
    assert.equal(report.missing, 0)
    assert.equal(report.rejected, 0)
    assert.equal(applied.length, 1)
    assert.equal(applied[0].oldPath, ctx.oldPath)
  } finally {
    await ctx.cleanup()
  }
})

test('文件不在当前目录：missing，原记录保持可列出，不伪造路径', async () => {
  const ctx = await setup()
  try {
    await rm(fileURLToPath(ctx.newPath))
    const resolution = await resolveScreenshotPath(ctx.record, ctx.fs)
    assert.equal(resolution.status, 'missing')
    const report = await repairScreenshotPaths([ctx.record], ctx.fs, async () => {
      throw new Error('missing 不应触发更新')
    })
    assert.equal(report.missing, 1)
    assert.deepEqual(report.missingAttemptIds, [1])
    assert.equal(report.repaired, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('哈希 / 字节数 / 格式对不上：rejected，不按文件名猜', async () => {
  const ctx = await setup()
  try {
    const wrongSha = await resolveScreenshotPath({ ...ctx.record, sha256: 'a'.repeat(64) }, ctx.fs)
    assert.equal(wrongSha.status, 'rejected')
    const wrongSize = await resolveScreenshotPath({ ...ctx.record, byteLength: PNG.length + 1 }, ctx.fs)
    assert.equal(wrongSize.status, 'rejected')
    const wrongFormat = await resolveScreenshotPath({ ...ctx.record, format: 'jpeg' }, ctx.fs)
    assert.equal(wrongFormat.status, 'rejected')

    // 没有登记哈希时，文件名里的内容指纹必须与真实字节一致；这里故意换名。
    const otherSha = 'b'.repeat(64)
    const otherName = `shot-${otherSha.slice(0, 32)}.png`
    await writeFile(join(ctx.root, 'screenshots', otherName), PNG)
    const noRegisteredSha = await resolveScreenshotPath(
      { ...ctx.record, archivedPath: ctx.oldPath.replace(ctx.fileName, otherName), sha256: null },
      ctx.fs,
    )
    assert.equal(noRegisteredSha.status, 'rejected')
  } finally {
    await ctx.cleanup()
  }
})

test('绝对 URL / 遍历 / 外部目录 / 不带内容指纹的名字一律拒绝', async () => {
  const ctx = await setup()
  try {
    const cases = [
      `https://example.com/Documents/screenshots/${ctx.fileName}`,
      `file://evil-host/Documents/screenshots/${ctx.fileName}`,
      `/var/mobile/Containers/Data/Application/OLD/Documents/screenshots/${ctx.fileName}`,
      `file:///tmp/other/Documents/screenshots/../screenshots/${ctx.fileName}`,
      `file:///tmp/other/Documents/other/${ctx.fileName}`,
      `file:///tmp/other/Documents/screenshots/not-content-addressed.png`,
      `file:///tmp/other/Documents/screenshots/${ctx.fileName}?x=1`,
    ]
    for (const archivedPath of cases) {
      assert.equal(appOwnedScreenshotRelativePath(archivedPath, ctx.fs.documentDirectory), null, archivedPath)
    }
    assert.equal(
      appOwnedScreenshotRelativePath(`file:///old/Documents/screenshots/${ctx.fileName}`, 'file:///new/Documents/'),
      `screenshots/${ctx.fileName}`,
    )
  } finally {
    await ctx.cleanup()
  }
})

test('恢复冲突名：真实时间戳格式与 uniqueName 数字后缀都认得，下划线等任意后缀不认', () => {
  const sha16 = '6b1048f8a6d40bac'
  assert.equal(isAppOwnedScreenshotFileName(`restore-20261025-131201-${sha16}.png`), true)
  assert.equal(isAppOwnedScreenshotFileName(`restore-20261025-131201-${sha16}-2.png`), true)
  assert.equal(isAppOwnedScreenshotFileName(`restore-20261025-131201-${sha16}-shadow.png`), false)
  assert.equal(isAppOwnedScreenshotFileName(`restore-20261025-1312018-${sha16}.png`), false)
  assert.equal(
    appOwnedScreenshotRelativePath(
      `file:///old/Documents/screenshots/restore-20261025-131201-${sha16}-2.png`,
      'file:///new/Documents/',
    ),
    `screenshots/restore-20261025-131201-${sha16}-2.png`,
  )
})

test('当前路径已经可用：直接 already-ok，不读字节、不重写记录', async () => {
  const ctx = await setup()
  try {
    let reads = 0
    const fs = {
      documentDirectory: ctx.fs.documentDirectory,
      getInfoAsync: async () => ({ exists: true, size: PNG.length, isDirectory: false }),
      readAsStringAsync: async () => {
        reads += 1
        return PNG_BASE64
      },
    }
    const resolution = await resolveScreenshotPath({ ...ctx.record, archivedPath: ctx.newPath }, fs)
    assert.equal(resolution.status, 'already-ok')
    assert.equal(reads, 0, '文件已在时不做多余读取')
    const report = await repairScreenshotPaths([{ ...ctx.record, archivedPath: ctx.newPath }], fs, async () => {
      throw new Error('already-ok 不应触发更新')
    })
    assert.equal(report.alreadyOk, 1)
    assert.equal(report.repaired, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('候选文件超过单张上限：先看大小再拒绝，不把大文件读进内存', async () => {
  const ctx = await setup()
  try {
    let reads = 0
    const fs = {
      documentDirectory: ctx.fs.documentDirectory,
      getInfoAsync: async (uri) =>
        uri.includes('OLD-UUID')
          ? { exists: false }
          : { exists: true, size: MAX_ARCHIVE_BYTES + 1, isDirectory: false },
      readAsStringAsync: async () => {
        reads += 1
        return PNG_BASE64
      },
    }
    const resolution = await resolveScreenshotPath({ ...ctx.record, byteLength: null }, fs)
    assert.equal(resolution.status, 'rejected')
    assert.match(resolution.reason, /大小|上限/)
    assert.equal(reads, 0, '大小超限时绝不读取字节')
  } finally {
    await ctx.cleanup()
  }
})

test('仓库 CAS：旧路径 / 哈希对不上就不更新；正确时只改路径一列', async () => {
  const db = await createTestDatabase()
  try {
    const recorded = await db.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: 'file:///old/Documents/screenshots/shot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
      sha256: 'a'.repeat(64),
      byteLength: 123,
      format: 'png',
      mimeType: 'image/png',
    })
    const id = recorded.attempt.id
    assert.equal(
      await db.screenshots.rebaseArchivedPath({
        attemptId: id,
        expectedArchivedPath: 'file:///wrong',
        nextArchivedPath: 'file:///new/Documents/screenshots/next.png',
      }),
      false,
    )
    assert.equal(
      await db.screenshots.rebaseArchivedPath({
        attemptId: id,
        expectedArchivedPath: 'file:///old/Documents/screenshots/shot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
        nextArchivedPath: 'file:///new/Documents/screenshots/next.png',
        expectedSha256: 'b'.repeat(64),
      }),
      false,
    )
    assert.equal(
      await db.screenshots.rebaseArchivedPath({
        attemptId: id,
        expectedArchivedPath: 'file:///old/Documents/screenshots/shot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
        nextArchivedPath: 'file:///new/Documents/screenshots/next.png',
        expectedSha256: 'a'.repeat(64),
      }),
      true,
    )
    const stored = await db.screenshots.getAttempt(id)
    assert.equal(stored.archivedPath, 'file:///new/Documents/screenshots/next.png')
    assert.equal(stored.sha256, 'a'.repeat(64))
    assert.equal(stored.byteLength, 123)
    assert.equal(stored.status, 'ARCHIVED')
  } finally {
    db.close()
  }
})
