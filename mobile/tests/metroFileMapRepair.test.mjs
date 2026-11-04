/**
 * Metro 文件表修复的聚焦测试。
 *
 * 背景（结论见 .supervision/ios-metro-restored-handoff.md）：
 * 本机卷上 Node 的 `fs.readdir(..., { withFileTypes: true })` 对 OneDrive
 * 重解析点文件的 `Dirent` 分类与 `lstat` 不一致——`Dirent.isSymbolicLink()`
 * 为 true，而 `lstatSync()` 明确是普通文件。`@expo/metro-file-map` 的 node
 * 爬虫在冷启动分支直接信任该 `Dirent`，把这类文件记成「目标未知的符号链接」
 * （`SYMLINK === 1`、mtime/size 为 null），于是 Metro 解析器看到
 * `exists: false`，报出 "main module field that could not be resolved"。
 *
 * `mobile/metro.config.js` 的修复只在**文件表自己解析不出来**时才去问
 * `lstat`，命中普通文件就用文件表自带的 `addOrModify` 写回真实元数据。
 * 本测试用假的 fileSystem 覆盖该逻辑的判定分支，不触碰真实 node_modules。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  onDiskFromStats,
  repairMisclassifiedFiles,
} from '../metro.config.js'

/** 造一个和 Metro 文件表接口一致的假实现（只实现修复逻辑用到的部分）。 */
function createFakeFileSystem(knownDirectories, knownFiles) {
  const directories = new Set(knownDirectories)
  const files = new Map(knownFiles)
  const added = []

  return {
    added,
    entries: files,
    lookup(absolutePath) {
      if (directories.has(absolutePath)) {
        return { exists: true, realPath: absolutePath, type: 'd' }
      }
      if (files.has(absolutePath)) {
        return {
          exists: true,
          realPath: absolutePath,
          type: 'f',
          metadata: files.get(absolutePath),
        }
      }
      return { exists: false, missing: absolutePath }
    },
    addOrModify(normalPath, metadata) {
      added.push({ normalPath, metadata })
      files.set(normalPath, metadata)
    },
  }
}

/** 建一个临时工程目录，返回根路径与两条测试路径。 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ddl-metro-filemap-'))
  mkdirSync(join(root, 'node_modules', 'expo', 'src'), { recursive: true })
  const misclassified = join(root, 'node_modules', 'expo', 'src', 'Expo.ts')
  writeFileSync(misclassified, 'export const marker = 1\n', 'utf8')
  return { root, misclassified }
}

test('文件表解析不出来的真实文件会被写回真实元数据', () => {
  const { root, misclassified } = createFixture()
  try {
    // 文件表把它记成「解析不出来的符号链接」，正是爬虫的误判形态。
    const fileSystem = createFakeFileSystem(
      [root, join(root, 'node_modules'), join(root, 'node_modules', 'expo')],
      [],
    )
    assert.equal(fileSystem.lookup(misclassified).exists, false)

    const result = repairMisclassifiedFiles(fileSystem, [root])

    assert.equal(result.repaired, 1)
    const written = fileSystem.entries.get(misclassified)
    assert.ok(Array.isArray(written), '应写入 Metro 元数据数组')
    assert.equal(
      written.length,
      6,
      `元数据长度应为 6，实际 ${JSON.stringify(written)}`,
    )
    // [mtime, size, visited, sha1, symlink, pluginData]
    assert.equal(written[4], 0, 'symlink 槽位必须是 0（普通文件）')
    assert.equal(written[3], null, 'sha1 留空，交给 Metro 按需计算')
    assert.equal(typeof written[0], 'number')
    assert.equal(written[0], lstatSync(misclassified).mtimeMs)
    assert.equal(written[1], 24)
    assert.equal(fileSystem.lookup(misclassified).exists, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件表已经能解析的文件一个字节都不动', () => {
  const { root, misclassified } = createFixture()
  try {
    const existingMetadata = [111, 22, 0, 'sha', 0, null]
    const fileSystem = createFakeFileSystem(
      [root, join(root, 'node_modules'), join(root, 'node_modules', 'expo')],
      [[misclassified, existingMetadata]],
    )

    const result = repairMisclassifiedFiles(fileSystem, [root])

    assert.equal(result.repaired, 0)
    assert.deepEqual(fileSystem.entries.get(misclassified), existingMetadata)
    assert.deepEqual(fileSystem.added, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('磁盘上不存在的路径不会被凭空写入', () => {
  const root = mkdtempSync(join(tmpdir(), 'ddl-metro-filemap-empty-'))
  try {
    const fileSystem = createFakeFileSystem([root], [])
    const result = repairMisclassifiedFiles(fileSystem, [root])
    assert.equal(result.repaired, 0)
    assert.deepEqual(fileSystem.added, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('同一份文件表只扫一遍，重复调用直接返回', () => {
  const { root } = createFixture()
  try {
    const fileSystem = createFakeFileSystem([root], [])
    const first = repairMisclassifiedFiles(fileSystem, [root])
    assert.equal(first.alreadyRepaired, undefined)
    const second = repairMisclassifiedFiles(fileSystem, [root])
    assert.equal(second.alreadyRepaired, true)
    assert.equal(second.repaired, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件表接口不符时返回 null，不抛错', () => {
  assert.equal(repairMisclassifiedFiles(null, ['/tmp']), null)
  assert.equal(repairMisclassifiedFiles({}, ['/tmp']), null)
  assert.equal(
    repairMisclassifiedFiles({ lookup: () => ({ exists: false }) }, ['/tmp']),
    null,
  )
})

test('目录本身是文件表已知目录时仍会继续向下修复', () => {
  const { root, misclassified } = createFixture()
  try {
    // 只登记根目录，子目录靠 lookup 返回 exists:false + lstat 判定为目录。
    const fileSystem = createFakeFileSystem([root], [])
    const result = repairMisclassifiedFiles(fileSystem, [root])
    assert.equal(result.repaired, 1)
    assert.equal(fileSystem.lookup(misclassified).exists, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
