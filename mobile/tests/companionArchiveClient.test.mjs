// 电脑归档目录元数据的客户端：形状校验、失败兜底、不把脏数据展示给用户。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchCompanionArchiveSources, normalizeRemoteSource } from '../src/domain/companionArchiveClient.ts'

const GOOD = {
  catalogKey: 'retained-original-vertical-week7',
  title: '原始竖版课表',
  description: '早前保留的竖版卡片截图',
  archiveRelPath: '.tools/photo/retained-original.png',
  sha256: 'a'.repeat(64),
  byteLength: 1752730,
  width: 1279,
  height: 2781,
  knownFacts: ['周一 7–8 节 15:30–17:05 体育(3)'],
  absentFacts: ['周六的课'],
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

test('normalizeRemoteSource：合法条目全字段保留', () => {
  const entry = normalizeRemoteSource(GOOD)
  assert.equal(entry?.catalogKey, GOOD.catalogKey)
  assert.equal(entry?.sha256, 'a'.repeat(64))
  assert.deepEqual(entry?.knownFacts, GOOD.knownFacts)
})

test('normalizeRemoteSource：缺 key / 标题 / 路径，或哈希形状不对时拒绝', () => {
  assert.equal(normalizeRemoteSource(null), null)
  assert.equal(normalizeRemoteSource({ title: 't', archiveRelPath: 'a' }), null, 'catalogKey 必须有')
  assert.equal(normalizeRemoteSource({ catalogKey: 'k', archiveRelPath: 'a' }), null, 'title 必须有')
  assert.equal(normalizeRemoteSource({ catalogKey: 'k', title: 't' }), null, 'archiveRelPath 必须有')
  // 哈希形状不对 → 降级成 null（仍然能列出来，只是没法本地校验）。
  const bad = normalizeRemoteSource({ ...GOOD, sha256: 'not-a-hash' })
  assert.equal(bad?.sha256, null)
})

test('fetchCompanionArchiveSources：正常返回时只保留合法条目', async () => {
  const result = await fetchCompanionArchiveSources('http://127.0.0.1:8082', {
    fetchImpl: async (url) => {
      assert.equal(url, 'http://127.0.0.1:8082/v1/archive/sources')
      return jsonResponse({ ok: true, sources: [GOOD, { nonsense: true }] })
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.sources.length, 1, '脏条目必须被丢掉')
  assert.equal(result.error, null)
})

test('fetchCompanionArchiveSources：非 2xx / 网络失败 / 没有地址都给可读原因且不抛异常', async () => {
  const notFound = await fetchCompanionArchiveSources('http://127.0.0.1:8082', {
    fetchImpl: async () => jsonResponse({ ok: false }, 500),
  })
  assert.equal(notFound.ok, false)
  assert.match(notFound.error ?? '', /500/)
  assert.deepEqual(notFound.sources, [])

  const offline = await fetchCompanionArchiveSources('http://127.0.0.1:8082', {
    fetchImpl: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  assert.equal(offline.ok, false)
  assert.match(offline.error ?? '', /ECONNREFUSED/)

  const noEndpoint = await fetchCompanionArchiveSources(null)
  assert.equal(noEndpoint.ok, false)
  assert.match(noEndpoint.error ?? '', /电脑地址/)
})

test('fetchCompanionArchiveSources：地址里的路径与端口被规范化（不会拼出双端口）', async () => {
  let seen = ''
  await fetchCompanionArchiveSources('192.168.31.73:8082/v1/ocr', {
    fetchImpl: async (url) => {
      seen = String(url)
      return jsonResponse({ ok: true, sources: [] })
    },
  })
  assert.equal(seen, 'http://192.168.31.73:8082/v1/archive/sources')
})
