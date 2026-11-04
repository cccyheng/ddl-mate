// 离线兜底清单的**准确性**：源码里的路径 / 哈希 / 字节数必须与磁盘上的真实文件一致。
//
// 同时守一条产品约束（复核对要求）：**App 源码里不放个人课表事实**。
// 描述性文案（标题里的星期 / 课程、图上有什么没有什么）只存在于电脑上的
// `.tools/photo/archive-catalog.json`，由 App 在显式同步时读回并持久化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KNOWN_SOURCE_CATALOG,
  SHA256_HEX_RE,
  knownSourceByKey,
  knownSourceToCatalogEntry,
  verifyDownloadedSource,
} from '../src/domain/screenshotSources.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const catalogPath = join(repoRoot, '.tools', 'photo', 'archive-catalog.json')

test('电脑上的目录文件存在，且只允许项目自己的 .tools/photo', () => {
  assert.ok(existsSync(catalogPath), `缺少 ${catalogPath}`)
  const parsed = JSON.parse(readFileSync(catalogPath, 'utf8'))
  assert.deepEqual(parsed.allowedRoots, ['.tools/photo'], '只允许读项目自己的归档目录')
  assert.equal(parsed.root, '.')
  assert.ok(Array.isArray(parsed.sources) && parsed.sources.length === KNOWN_SOURCE_CATALOG.length)
})

test('电脑目录与 App 离线清单一一对应：键、路径、哈希、字节数都一致', () => {
  const parsed = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const byKey = new Map(parsed.sources.map((entry) => [entry.catalogKey, entry]))
  for (const entry of KNOWN_SOURCE_CATALOG) {
    const remote = byKey.get(entry.catalogKey)
    assert.ok(remote, `电脑目录里缺少 ${entry.catalogKey}`)
    assert.equal(remote.archiveRelPath, entry.archiveRelPath, '路径必须一致，否则取不到文件')
    assert.equal(String(remote.sha256).toLowerCase(), entry.sha256, '哈希必须一致，否则校验必然失败')
    assert.equal(remote.byteLength, entry.byteLength)
  }
  // 反向：电脑目录里也不该有 App 完全不知道的条目（那会出现在列表里却取不回来）。
  for (const remote of parsed.sources) {
    assert.ok(knownSourceByKey(remote.catalogKey), `App 清单缺少 ${remote.catalogKey}`)
  }
})

test('App 源码里的离线清单**不含**个人课表事实（只有路径 / 哈希 / 中性标题）', () => {
  const source = readFileSync(join(here, '..', 'src', 'domain', 'screenshotSources.ts'), 'utf8')
  // 这些词只应该出现在电脑上的目录文件里，不该被固化进 App 源码。
  for (const personal of ['体育', '马克思', '体育馆', '副馆场地', '17:05', '15:30', '选课序号', '1713000172']) {
    assert.ok(!source.includes(personal), `App 源码不应包含个人课表内容：${personal}`)
  }
  for (const entry of KNOWN_SOURCE_CATALOG) {
    // 中性标题里也不该出现课程 / 星期信息。
    assert.match(entry.neutralTitle, /历史截图/, `${entry.catalogKey} 的标题应当是中性描述`)
    assert.doesNotMatch(entry.neutralTitle, /体育|马克思|周[一二三四五六日]|星期/)
  }
})

test('新增的 2026-10-13 原始 PNG 已登记（路径 / 哈希 / 字节数与磁盘一致）', () => {
  // 第 4 条：用户新提交的横向课表原图。登记它只是为了让「从电脑恢复历史截图」
  // 能在同一套流程里取回这一份字节，**不是**把识别结论写进 App 源码。
  const entry = knownSourceByKey('user-20261013-dense-horizontal')
  assert.ok(entry, '新原图必须登记进离线清单')
  assert.equal(entry.archiveRelPath, '.tools/photo/user-20261013-dense/input.png')
  assert.equal(entry.byteLength, 201603)
  assert.equal(entry.sha256, '9d78ab5dbf5c2e20796ab007142a735d001770d4a4e617b5495897e1a954a809')
  assert.equal(entry.kind, 'horizontal-grid')
  assert.equal(KNOWN_SOURCE_CATALOG.length, 4, '原有 3 条必须保留，加上新的一条共 4 条')

  const bytes = readFileSync(join(repoRoot, entry.archiveRelPath))
  assert.equal(bytes.length, entry.byteLength)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256)
})

test('离线清单的路径都在 .tools/photo 内、哈希形状合法、键不重复', () => {
  const seen = new Set()
  for (const entry of KNOWN_SOURCE_CATALOG) {
    assert.ok(entry.archiveRelPath.startsWith('.tools/photo/'), `${entry.catalogKey} 的路径必须落在归档目录里`)
    assert.doesNotMatch(entry.archiveRelPath, /\.\./, '不允许路径逃逸')
    assert.match(entry.sha256, SHA256_HEX_RE, `${entry.catalogKey} 的 SHA256 形状不对`)
    assert.ok(entry.byteLength > 0)
    assert.ok(!seen.has(entry.catalogKey), `catalogKey 重复：${entry.catalogKey}`)
    seen.add(entry.catalogKey)
  }
})

test('磁盘上的真实文件与离线清单的 SHA256 / 字节数完全一致', () => {
  for (const entry of KNOWN_SOURCE_CATALOG) {
    const absolute = join(repoRoot, entry.archiveRelPath)
    assert.ok(existsSync(absolute), `缺少归档文件 ${entry.archiveRelPath}`)
    const bytes = readFileSync(absolute)
    assert.equal(bytes.length, entry.byteLength, `${entry.catalogKey} 的字节数不一致`)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.catalogKey} 的 SHA256 不一致`)
  }
})

test('两张横向截图登记为同一份字节（同图两次提交，不假装是两张不同的图）', () => {
  const first = knownSourceByKey('phone-20261012-122524-horizontal')
  const second = knownSourceByKey('phone-20261012-202526-horizontal')
  assert.ok(first && second)
  assert.equal(first.sha256, second.sha256, '同一份字节 → 同一 SHA256')
  assert.equal(first.byteLength, second.byteLength)
  assert.notEqual(first.catalogKey, second.catalogKey, '但仍然保留两条提交历史')
})

test('离线 upsert 输入只带中性文案：描述为空、不编造尺寸', () => {
  for (const entry of KNOWN_SOURCE_CATALOG) {
    const input = knownSourceToCatalogEntry(entry)
    assert.equal(input.description, null, '描述性文案必须等电脑目录同步回来')
    assert.equal(input.width, null)
    assert.equal(input.height, null)
    assert.equal(input.sha256, entry.sha256)
    assert.equal(input.archiveRelPath, entry.archiveRelPath)
  }
})

test('verifyDownloadedSource：长度或哈希不对都拒绝，一致才接受', () => {
  const entry = KNOWN_SOURCE_CATALOG[0]
  assert.deepEqual(verifyDownloadedSource(entry, { byteLength: entry.byteLength, sha256: entry.sha256.toUpperCase() }), {
    ok: true,
  })
  const short = verifyDownloadedSource(entry, { byteLength: entry.byteLength - 1, sha256: entry.sha256 })
  assert.equal(short.ok, false)
  assert.match(short.message, /字节数不对/)
  const wrongHash = verifyDownloadedSource(entry, { byteLength: entry.byteLength, sha256: 'f'.repeat(64) })
  assert.equal(wrongHash.ok, false)
  assert.match(wrongHash.message, /校验和不同/)
})

test('knownSourceByKey 只认登记过的 key', () => {
  assert.equal(knownSourceByKey('retained-original-vertical-week7')?.byteLength, 1752730)
  assert.equal(knownSourceByKey('nope'), null)
})
