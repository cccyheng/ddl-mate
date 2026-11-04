// 历史归档的**只读**边界：能且只能读目录里登记过、且在允许根之内的那几份文件。
//
// 这组测试守的是授权范围里的硬约束：
// - 不做文件服务：任意路径、绝对路径、`..` 逃逸、目录之外的路径全部拒绝；
// - 只发登记过的那一份：key 不在目录里 → 404；
// - 内容变了就拒发（SHA256 不一致），而不是发一份「不知道是什么」的图；
// - 目录缺失只会让恢复入口为空，不影响识别服务本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ArchiveError,
  assertRealPathInside,
  loadArchiveCatalog,
  publicCatalogEntry,
  readArchiveSource,
  resolveArchivePath,
} from '../src/archive.mjs'

/** 造一个带归档目录的临时工作区。 */
async function makeWorkspace({ tamper = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ddl-archive-'))
  const photoDir = join(root, '.tools', 'photo')
  await mkdir(photoDir, { recursive: true })
  const payload = Buffer.from('fake-png-bytes-for-test')
  const filePath = join(photoDir, 'known.png')
  await writeFile(filePath, tamper ? Buffer.from('changed-bytes') : payload)
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const catalogPath = join(photoDir, 'archive-catalog.json')
  await writeFile(
    catalogPath,
    JSON.stringify({
      // 相对路径的基准就是这份临时工作区；`allowedRoots` 照旧生效。
      root: '.',
      allowedRoots: ['.tools/photo'],
      sources: [
        {
          catalogKey: 'known-source',
          title: '已知来源',
          description: '测试用',
          archiveRelPath: '.tools/photo/known.png',
          sha256,
          byteLength: payload.length,
          width: 10,
          height: 20,
          layout: 'stacked-cards',
          knownFacts: ['周一体育'],
          absentFacts: ['周六马克思'],
        },
        {
          catalogKey: 'outside-root',
          title: '根之外',
          archiveRelPath: '.tools/secret.txt',
          sha256: null,
        },
      ],
    }),
    'utf8',
  )
  return { root, catalogPath, payload, sha256, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('路径解析：只接受允许根之内的相对路径', () => {
  // 用一个「绝对路径」的根，跨平台都能验证相对解析（Windows 上用盘符根）。
  const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace'
  assert.equal(resolveArchivePath(root, '.tools/photo/known.png'), join(root, '.tools', 'photo', 'known.png'))
  assert.throws(() => resolveArchivePath(root, process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'), ArchiveError)
  assert.throws(() => resolveArchivePath(root, '../../etc/passwd'), ArchiveError)
  assert.throws(() => resolveArchivePath(root, '.tools/photo/../../secret.txt'), ArchiveError)
  assert.throws(() => resolveArchivePath(root, '.tools/secret.txt'), ArchiveError)
  assert.throws(() => resolveArchivePath(root, ''), ArchiveError)
})

test('读一份登记过的归档：字节与 SHA256 都对', async () => {
  const ws = await makeWorkspace()
  try {
    const result = await readArchiveSource({
      workspaceRoot: ws.root,
      catalogPath: ws.catalogPath,
      catalogKey: 'known-source',
      logger: { warn() {}, error() {} },
    })
    assert.equal(result.bytes.length, ws.payload.length)
    assert.equal(result.sha256, ws.sha256)
    assert.equal(result.contentType, 'image/png')
    assert.equal(result.entry.catalogKey, 'known-source')
    assert.ok(!JSON.stringify(result.entry).includes(ws.root), '对外元数据不能泄露本机绝对路径')
  } finally {
    await ws.cleanup()
  }
})

test('文件被改过 → 拒发（校验和不一致），不给一份不知道是什么的图', async () => {
  const ws = await makeWorkspace({ tamper: true })
  try {
    await assert.rejects(
      () =>
        readArchiveSource({
          workspaceRoot: ws.root,
          catalogPath: ws.catalogPath,
          catalogKey: 'known-source',
          logger: { warn() {}, error() {} },
        }),
      (error) => error instanceof ArchiveError && error.code === 'CHECKSUM_MISMATCH',
    )
  } finally {
    await ws.cleanup()
  }
})

test('未登记的 key → NOT_FOUND；允许根之外的条目 → FORBIDDEN', async () => {
  const ws = await makeWorkspace()
  try {
    const logger = { warn() {}, error() {} }
    await assert.rejects(
      () => readArchiveSource({ workspaceRoot: ws.root, catalogPath: ws.catalogPath, catalogKey: 'nope', logger }),
      (error) => error.code === 'NOT_FOUND',
    )
    await assert.rejects(
      () => readArchiveSource({ workspaceRoot: ws.root, catalogPath: ws.catalogPath, catalogKey: 'outside-root', logger }),
      (error) => error.code === 'FORBIDDEN',
    )
  } finally {
    await ws.cleanup()
  }
})

test('目录缺失时：不抛异常，只是没有条目（识别服务照常）', async () => {
  const catalog = await loadArchiveCatalog({
    workspaceRoot: join(tmpdir(), 'definitely-not-here'),
    logger: { warn() {}, error() {} },
  })
  assert.equal(catalog.ok, false)
  assert.deepEqual(catalog.sources, [])
  assert.ok(catalog.allowedRoots.length > 0, '仍然保留默认允许根，保证后续路径校验不失效')
})

test('符号链接指到允许根之外：拒绝发送（字符串包含判断挡不住链接）', async (t) => {
  const ws = await makeWorkspace()
  const outside = await mkdtemp(join(tmpdir(), 'ddl-archive-outside-'))
  try {
    const payload = Buffer.from('this-is-outside-the-allowed-root')
    const secret = join(outside, 'secret.png')
    await writeFile(secret, payload)
    const linkPath = join(ws.root, '.tools', 'photo', 'linked.png')
    try {
      await symlink(secret, linkPath, 'file')
    } catch (cause) {
      // Windows 上未开开发者模式时创建符号链接会失败：跳过而不是假装通过。
      t.skip(`本机无法创建符号链接：${cause instanceof Error ? cause.message : String(cause)}`)
      return
    }
    // 把链接登记进目录（模拟目录被改坏 / 被人塞了链接）。
    const catalog = JSON.parse(await readFile(ws.catalogPath, 'utf8'))
    catalog.sources.push({
      catalogKey: 'linked-escape',
      title: '链接逃逸',
      archiveRelPath: '.tools/photo/linked.png',
      sha256: null,
    })
    await writeFile(ws.catalogPath, JSON.stringify(catalog), 'utf8')

    await assert.rejects(
      () =>
        readArchiveSource({
          workspaceRoot: ws.root,
          catalogPath: ws.catalogPath,
          catalogKey: 'linked-escape',
          logger: { warn() {}, error() {} },
        }),
      (error) => error instanceof ArchiveError && error.code === 'FORBIDDEN',
    )
  } finally {
    await ws.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

test('真实路径包含判断：根之外的真实文件即便命名合法也拒绝', async () => {
  const ws = await makeWorkspace()
  const outside = await mkdtemp(join(tmpdir(), 'ddl-archive-outside-'))
  try {
    const secret = join(outside, 'secret.png')
    await writeFile(secret, Buffer.from('outside'))
    // 路径字符串看起来没问题（就在允许根里的相对路径），但传进来的实际是根外的文件。
    // 这正是符号链接会造成的局面：`realpath` 之后必须落在允许根之内。
    await assert.rejects(
      () =>
        assertRealPathInside({
          workspaceRoot: ws.root,
          absolutePath: secret,
          allowedRoots: ['.tools/photo'],
        }),
      (error) => error instanceof ArchiveError && error.code === 'FORBIDDEN',
    )
    // 根内的真实文件照常放行。
    const inside = join(ws.root, '.tools', 'photo', 'known.png')
    assert.equal(
      await assertRealPathInside({ workspaceRoot: ws.root, absolutePath: inside, allowedRoots: ['.tools/photo'] }),
      await realpath(inside),
    )
  } finally {
    await ws.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

test('对外条目形状固定：不含字节，也不含绝对路径', () => {
  const entry = publicCatalogEntry({
    catalogKey: 'k',
    title: 't',
    archiveRelPath: '.tools/photo/a.png',
    sha256: 'a'.repeat(64),
    knownFacts: ['x'],
    absentFacts: ['y'],
  })
  assert.deepEqual(Object.keys(entry).sort(), [
    'absentFacts',
    'archiveRelPath',
    'byteLength',
    'capturedAt',
    'catalogKey',
    'description',
    'height',
    'knownFacts',
    'layout',
    'provenance',
    'sha256',
    'title',
    'width',
  ])
})
