// 历史归档的**真实 HTTP** 边界：真实起服务、真实 fetch。
//
// 这组测试证明的是「手机上点恢复时到底会发生什么」：
// - 列表接口只给元数据；
// - 取文件接口给的是真字节，且校验和与目录一致；
// - 路径穿越 / 未登记的 key 一律被拒（这是「不做文件服务」这条约束的回归闸门）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer } from '../src/server.mjs'

const silentLogger = { info() {}, warn() {}, error() {} }

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'ddl-archive-http-'))
  const photoDir = join(root, '.tools', 'photo')
  await mkdir(photoDir, { recursive: true })
  const payload = Buffer.from('archive-http-payload-0123456789')
  await writeFile(join(photoDir, 'known.png'), payload)
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const catalogPath = join(photoDir, 'archive-catalog.json')
  await writeFile(
    catalogPath,
    JSON.stringify({
      root: '.',
      allowedRoots: ['.tools/photo'],
      sources: [
        {
          catalogKey: 'known-source',
          title: '已知来源',
          archiveRelPath: '.tools/photo/known.png',
          sha256,
          byteLength: payload.length,
          width: 10,
          height: 20,
        },
      ],
    }),
    'utf8',
  )
  return { root, catalogPath, payload, sha256, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function withServer(catalogPath, run) {
  const started = await startServer(['--localhost', '--port', '0', '--archive-catalog', catalogPath], silentLogger)
  const { port } = started.server.address()
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await started.close()
  }
}

test('真实 HTTP：列出归档来源只给元数据（没有字节、没有绝对路径）', async () => {
  const ws = await makeWorkspace()
  try {
    await withServer(ws.catalogPath, async (base) => {
      const response = await fetch(`${base}/v1/archive/sources`)
      assert.equal(response.status, 200)
      const payload = await response.json()
      assert.equal(payload.ok, true)
      assert.equal(payload.available, true)
      assert.equal(payload.sources.length, 1)
      assert.equal(payload.sources[0].catalogKey, 'known-source')
      assert.equal(payload.sources[0].sha256, ws.sha256)
      assert.ok(!JSON.stringify(payload).includes(ws.root), '不能泄露工作区绝对路径')
    })
  } finally {
    await ws.cleanup()
  }
})

test('真实 HTTP：取一份登记过的归档 → 真字节 + 校验和响应头', async () => {
  const ws = await makeWorkspace()
  try {
    await withServer(ws.catalogPath, async (base) => {
      const response = await fetch(`${base}/v1/archive/source/known-source`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-archive-sha256'), ws.sha256)
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.length, ws.payload.length)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), ws.sha256)
    })
  } finally {
    await ws.cleanup()
  }
})

test('真实 HTTP：路径穿越与未登记 key 都被拒（不做文件服务）', async () => {
  const ws = await makeWorkspace()
  try {
    await withServer(ws.catalogPath, async (base) => {
      for (const target of [
        '/v1/archive/source/..%2F..%2Fetc%2Fpasswd',
        '/v1/archive/source/%2Fetc%2Fpasswd',
        '/v1/archive/source/nope',
      ]) {
        const response = await fetch(`${base}${target}`)
        assert.ok(response.status >= 400, `${target} 必须被拒绝，实际 ${response.status}`)
        const payload = await response.json()
        assert.equal(payload.ok, false)
        assert.ok(['NOT_FOUND', 'FORBIDDEN'].includes(payload.code), `${target} 的 code 应为 NOT_FOUND/FORBIDDEN`)
      }
    })
  } finally {
    await ws.cleanup()
  }
})

test('真实 HTTP：归档接口只接受 GET', async () => {
  const ws = await makeWorkspace()
  try {
    await withServer(ws.catalogPath, async (base) => {
      const response = await fetch(`${base}/v1/archive/sources`, { method: 'POST' })
      assert.equal(response.status, 405)
    })
  } finally {
    await ws.cleanup()
  }
})
