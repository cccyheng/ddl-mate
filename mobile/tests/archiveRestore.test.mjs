// 历史来源**取回**的端到端流程（真实临时磁盘 + 真实 SQLite）：
// 下载 → 校验 → 内容寻址落盘 → 登记尝试 → 关联来源。
//
// 复核对点名的真实缺陷都在这里守：
// - 中断的第二次下载**绝不**截断本机已经验证过的原图；
// - 校验和不符 / 非 2xx 时只清理这次新下载的临时文件，历史一条不动；
// - 同一份字节重复取回只占一份文件，但仍然各留一条提交历史。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyAdditiveColumns, readSchemaSql, readScreenshotLibrarySql, wrapDatabase } from './helpers/sqliteHarness.mjs'

const here = dirname(fileURLToPath(import.meta.url))

test('历史来源取回：下载 → 校验 → 内容寻址落盘 → 登记 → 关联（重开库仍在）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ddl-restore-'))
  const dir = join(root, 'docs')
  await mkdir(dir, { recursive: true })
  const dbPath = join(root, 'history.sqlite')
  let raw = new DatabaseSync(dbPath)
  const db = wrapDatabase(raw)
  // v3 表结构（与真机一致）。
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readScreenshotLibrarySql())
  applyAdditiveColumns(raw)

  try {
    const { ScreenshotLibraryRepository } = await import('../src/domain/screenshotLibraryRepository.ts')
    let repo = new ScreenshotLibraryRepository(db, { now: () => new Date('2026-10-12T04:00:00.000Z') })
    const payload = await readFile(resolve(here, '..', '..', '.tools', 'photo', 'retained-original.png'))
    const { sha256Hex } = await import('../src/domain/hashing.ts')
    const expectedSha = await sha256Hex(new Uint8Array(payload))

    const fs = {
      documentDirectory: `${pathToFileURL(dir).href}/`,
      async makeDirectoryAsync(uri) {
        await mkdir(fileURLToPath(uri), { recursive: true })
      },
      async getInfoAsync(uri) {
        try {
          const info = await import('node:fs/promises').then((m) => m.stat(fileURLToPath(uri)))
          return { exists: true, size: info.size, isDirectory: info.isDirectory() }
        } catch {
          return { exists: false }
        }
      },
      readAsStringAsync: async (uri) => (await readFile(fileURLToPath(uri))).toString('base64'),
      writeAsStringAsync: async (uri, contents) => writeFile(fileURLToPath(uri), Buffer.from(contents, 'base64')),
      moveAsync: async ({ from, to }) => (await import('node:fs/promises')).rename(fileURLToPath(from), fileURLToPath(to)),
      deleteAsync: async (uri) => (await import('node:fs/promises')).rm(fileURLToPath(uri), { force: true }),
      downloadAsync: async (_remote, uri) => {
        await writeFile(fileURLToPath(uri), payload)
        return { uri, status: 200 }
      },
    }

    const { downloadArchivedSource } = await import('../src/domain/screenshotFiles.ts')
    const first = await downloadArchivedSource({
      remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
      expectedSha256: expectedSha,
      format: 'png',
      deps: { fs },
    })
    assert.equal(first.sha256, expectedSha)
    assert.match(first.fileName, /^shot-[0-9a-f]{32}\.png$/, '落盘文件名是内容寻址的')
    assert.deepEqual(await readFile(fileURLToPath(first.uri)), payload)

    const recorded = await repo.recordAttempt({
      source: 'ARCHIVE',
      status: 'ARCHIVED',
      archivedPath: first.uri,
      sha256: first.sha256,
      byteLength: first.byteLength,
      width: 1279,
      height: 2781,
      format: 'png',
      mimeType: 'image/png',
    })
    await repo.upsertSourceEntry({
      catalogKey: 'known',
      title: '原始竖版课表',
      archiveRelPath: '.tools/photo/retained-original.png',
      sha256: expectedSha,
      byteLength: first.byteLength,
    })
    await repo.attachSourceAttempt('known', recorded.attempt.id)

    // 再取一次同一份内容：复用同一个文件，但新增一条历史。
    const second = await downloadArchivedSource({
      remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
      expectedSha256: expectedSha,
      format: 'png',
      deps: { fs },
    })
    assert.equal(second.uri, first.uri)
    assert.equal(second.reusedExisting, true)
    const recordedAgain = await repo.recordAttempt({
      source: 'ARCHIVE',
      status: 'ARCHIVED',
      archivedPath: second.uri,
      sha256: second.sha256,
      byteLength: second.byteLength,
    })
    assert.equal(recordedAgain.deduplicated, true)
    assert.equal(recordedAgain.dedupOfAttemptId, recorded.attempt.id)
    assert.equal((await readdir(join(dir, 'screenshots'))).length, 1, '同一份字节只占一个文件')

    // 关掉再打开：关联与状态都还在。
    raw.close()
    raw = new DatabaseSync(dbPath)
    const reopened = wrapDatabase(raw)
    repo = new ScreenshotLibraryRepository(reopened, { now: () => new Date('2026-10-12T04:00:00.000Z') })
    const source = await repo.getSourceByKey('known')
    assert.equal(source?.foreignAttemptId, recorded.attempt.id)
    assert.equal((await repo.listAttempts()).length, 2)
    const linked = await repo.listRefsForAttempt(recordedAgain.attempt.id)
    assert.equal(linked.length, 1, '第二次取回挂了去重关联')
    assert.equal(linked[0].targetKind, 'ATTEMPT')
  } finally {
    raw.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('历史来源取回：内容不符 / 非 2xx 时清理新下载，原有文件与历史不动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ddl-restore-bad-'))
  const dir = join(root, 'docs')
  await mkdir(dir, { recursive: true })
  const { downloadArchivedSource } = await import('../src/domain/screenshotFiles.ts')

  const original = Buffer.from('previously verified original bytes')
  const shotsDir = join(dir, 'screenshots')
  await mkdir(shotsDir, { recursive: true })
  const keptPath = join(shotsDir, 'shot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png')
  await writeFile(keptPath, original)

  const makeFs = (download) => ({
    documentDirectory: `${pathToFileURL(dir).href}/`,
    makeDirectoryAsync: async (uri) => mkdir(fileURLToPath(uri), { recursive: true }),
    getInfoAsync: async (uri) => {
      try {
        const info = await import('node:fs/promises').then((m) => m.stat(fileURLToPath(uri)))
        return { exists: true, size: info.size, isDirectory: info.isDirectory() }
      } catch {
        return { exists: false }
      }
    },
    readAsStringAsync: async (uri) => (await readFile(fileURLToPath(uri))).toString('base64'),
    writeAsStringAsync: async (uri, contents) => writeFile(fileURLToPath(uri), Buffer.from(contents, 'base64')),
    moveAsync: async ({ from, to }) => (await import('node:fs/promises')).rename(fileURLToPath(from), fileURLToPath(to)),
    deleteAsync: async (uri) => (await import('node:fs/promises')).rm(fileURLToPath(uri), { force: true }),
    downloadAsync: download,
  })

  try {
    // 1) 下载中途断线（写了一半就抛错）。
    await assert.rejects(
      () =>
        downloadArchivedSource({
          remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
          expectedSha256: 'b'.repeat(64),
          format: 'png',
          deps: {
            fs: makeFs(async (_remote, uri) => {
              await writeFile(fileURLToPath(uri), Buffer.from('partial'))
              throw new Error('connection lost')
            }),
          },
        }),
      /connection lost/,
    )

    // 2) 服务返回非 2xx：错误体绝不能被当成图片留下。
    await assert.rejects(
      () =>
        downloadArchivedSource({
          remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
          expectedSha256: 'b'.repeat(64),
          format: 'png',
          deps: {
            fs: makeFs(async (_remote, uri) => {
              await writeFile(fileURLToPath(uri), Buffer.from('{"ok":false}'))
              return { uri, status: 404 }
            }),
          },
        }),
      /返回 404/,
    )

    // 3) 校验和不符：拒绝登记。
    await assert.rejects(
      () =>
        downloadArchivedSource({
          remoteUri: 'http://127.0.0.1:8082/v1/archive/source/known',
          expectedSha256: 'b'.repeat(64),
          format: 'png',
          deps: {
            fs: makeFs(async (_remote, uri) => {
              await writeFile(fileURLToPath(uri), Buffer.from('not-the-expected-bytes'))
              return { uri, status: 200 }
            }),
          },
        }),
      /校验和不一致/,
    )

    // 三种失败之后：原有文件一字未改，也没有留下任何临时文件。
    assert.deepEqual(await readFile(keptPath), original)
    assert.deepEqual(await readdir(shotsDir), ['shot-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
