// 截图归档与「重新识别」的端到端流程（真实临时磁盘 + 真实 SQLite）。
//
// 守的是复核对点名的几条：
// - 归档用的是**原始字节**（PNG/JPEG 不重编码），落盘后可读回、可重开；
// - 取回来源时下载到临时文件、校验后才内容寻址落盘，失败不截断原有文件；
// - 「重新识别」在测试装的路径上会走**新的一次尝试**（不覆盖旧结果）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyAdditiveColumns, readSchemaSql, readScreenshotLibrarySql, wrapDatabase } from './helpers/sqliteHarness.mjs'
import { archivePickedPhoto } from '../src/domain/screenshotArchive.ts'
import { downloadArchivedSource } from '../src/domain/screenshotFiles.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 真实磁盘上的一整套文件系统替身（`expo-file-system/legacy` 的最小形状）。 */
function nativeFs(root) {
  const toPath = (uri) => fileURLToPath(uri)
  return {
    documentDirectory: `${pathToFileURL(root).href}/`,
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
      const { rename } = await import('node:fs/promises')
      await rename(toPath(from), toPath(to))
    },
    async deleteAsync(uri) {
      await rm(toPath(uri), { force: true })
    },
    async downloadAsync(remoteUri, fileUri) {
      throw new Error(`测试没有配置 downloadAsync（${remoteUri} → ${fileUri}）`)
    },
  }
}

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), 'ddl-screenshot-'))
  const raw = new DatabaseSync(join(root, 'library.sqlite'))
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readScreenshotLibrarySql())
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const repository = new ScreenshotLibraryRepository(db, { now: () => new Date('2026-10-12T12:25:24.000Z') })
  return {
    root,
    raw,
    repository,
    fs: nativeFs(root),
    close: () => raw.close(),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('归档真实 PNG：原始字节一字不差地落盘，并登记成一次成功尝试', async () => {
  const lib = await makeLibrary()
  try {
    const originalPath = resolve(here, '..', '..', '.tools', 'photo', 'retained-original.png')
    const original = await readFile(originalPath)
    const outcome = await archivePickedPhoto(
      { uri: pathToFileURL(originalPath).href, attemptSource: 'LIBRARY', capturedAtMs: 1_760_000_000_000 },
      {
        fs: lib.fs,
        readSourceBase64: (uri) => lib.fs.readAsStringAsync(uri),
        recordAttempt: (input) => lib.repository.recordAttempt(input),
      },
    )
    assert.equal(outcome.ok, true, 'PNG 原图必须能归档')
    assert.equal(outcome.preservedOriginal, true)
    assert.equal(outcome.byteLength, original.length)
    assert.deepEqual(await readFile(fileURLToPath(outcome.archivedUri)), original, '落盘字节与原始字节完全一致')
    const stored = await lib.repository.getAttempt(outcome.attemptId)
    assert.equal(stored?.status, 'ARCHIVED')
    assert.equal(stored?.byteLength, original.length)
    assert.equal(stored?.width, 1279)
    assert.equal(stored?.height, 2781)
  } finally {
    lib.close()
    await lib.cleanup()
  }
})

test('归档真实横向截图：同一份字节两次提交只占一份文件，但留两条历史', async () => {
  const lib = await makeLibrary()
  try {
    const a = resolve(here, '..', '..', '.tools', 'photo', 'phone-20261012-122524', 'input.png')
    const b = resolve(here, '..', '..', '.tools', 'photo', 'phone-20261012-202526', 'input.png')
    const save = (uri) =>
      archivePickedPhoto(
        { uri: pathToFileURL(uri).href, attemptSource: 'LIBRARY' },
        {
          fs: lib.fs,
          readSourceBase64: (target) => lib.fs.readAsStringAsync(target),
          recordAttempt: (input) => lib.repository.recordAttempt(input),
        },
      )
    const first = await save(a)
    const second = await save(b)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(first.archivedUri, second.archivedUri, '字节相同 → 同一个内容寻址文件')
    assert.notEqual(first.attemptId, second.attemptId, '两次提交各留一条历史')
    const files = await readdir(join(lib.root, 'screenshots'))
    assert.equal(files.length, 1, '同一份字节只占一个文件')
    const attempts = await lib.repository.listAttempts()
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].dedupOfAttemptId, attempts[1].id)
  } finally {
    lib.close()
    await lib.cleanup()
  }
})

test('重新识别路径：同一份归档原图再登记一次 → 新尝试 + 去重关联，旧结果不动', async () => {
  const lib = await makeLibrary()
  try {
    const originalPath = resolve(here, '..', '..', '.tools', 'photo', 'retained-original.png')
    const first = await archivePickedPhoto(
      { uri: pathToFileURL(originalPath).href, attemptSource: 'LIBRARY' },
      {
        fs: lib.fs,
        readSourceBase64: (uri) => lib.fs.readAsStringAsync(uri),
        recordAttempt: (input) => lib.repository.recordAttempt(input),
      },
    )
    await lib.repository.recordOcrResult({ attemptId: first.attemptId, status: 'FAILED', errorCode: 'NETWORK' })
    assert.equal((await lib.repository.getAttempt(first.attemptId))?.status, 'FAILED')

    // 「重新识别」= 拿同一份文件再登记一次（内容寻址 → 复用同一份字节）。
    const rerun = await archivePickedPhoto(
      { uri: first.archivedUri, attemptSource: 'LIBRARY' },
      {
        fs: lib.fs,
        readSourceBase64: (uri) => lib.fs.readAsStringAsync(uri),
        recordAttempt: (input) => lib.repository.recordAttempt(input),
      },
    )
    assert.equal(rerun.ok, true)
    assert.equal(rerun.archivedUri, first.archivedUri)
    assert.notEqual(rerun.attemptId, first.attemptId)
    await lib.repository.recordOcrResult({ attemptId: rerun.attemptId, status: 'SUCCESS', candidates: [] })

    const attempts = await lib.repository.listAttempts()
    assert.equal(attempts.length, 2)
    assert.equal(attempts.find((entry) => entry.id === first.attemptId)?.status, 'FAILED', '旧结果不被覆盖')
    assert.equal(attempts.find((entry) => entry.id === rerun.attemptId)?.status, 'SUCCEEDED')
    assert.equal(await lib.repository.countAttemptsWithFile(), 2)
  } finally {
    lib.close()
    await lib.cleanup()
  }
})

test('取回来源的下载阶段：非 2xx 不落盘，且不留下任何临时文件', async () => {
  const lib = await makeLibrary()
  try {
    lib.fs.downloadAsync = async (_remote, fileUri) => {
      await writeFile(fileURLToPath(fileUri), Buffer.from('{"ok":false,"code":"NOT_FOUND"}'))
      return { uri: fileUri, status: 404 }
    }
    await assert.rejects(
      () =>
        downloadArchivedSource({
          remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
          expectedSha256: 'c'.repeat(64),
          format: 'png',
          deps: { fs: lib.fs },
        }),
      /返回 404/,
    )
    const files = await readdir(join(lib.root, 'screenshots'))
    assert.deepEqual(files, [], '非 2xx 之后不能留下任何文件（包括临时文件）')
  } finally {
    lib.close()
    await lib.cleanup()
  }
})
