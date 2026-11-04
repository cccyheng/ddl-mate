/**
 * 真实中文 OCR 夹具的端到端验收（Node，不跑手机）。
 *
 * 复用**既有**合成通知截图（`frontend/public/samples/notices/`），不再生成新夹具：
 * 1. `notice-01-homework.png`：真实 Tesseract → 既有通知解析器 → 真实 SQLite 单事务导入
 *    → **关库重开**仍能读回完整原文；完整日期 + 时刻必须成为截止时间。
 * 2. `notice-02-chat-time.png`：真实 HTTP `POST /v1/ocr/notice`（startServer + 真实引擎）
 *    → 解析器；消息发送时间**不能**被当成截止时间。
 *
 * 这里没有 mock 引擎：测试里的文字就是这两张 PNG 真正识别出来的。
 * 运行方式（需要 mobile 的 TS 解析钩子，因为解析器与仓库是 TypeScript）：
 *   node --import ../mobile/tests/setup.mjs --test --experimental-test-isolation=none tests/noticeOcrImport.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { decodeImage } from '../src/imageCodec.mjs'
import { OcrEngine } from '../src/ocrEngine.mjs'
import { startServer } from '../src/server.mjs'
import {
  applyAdditiveColumns,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  wrapDatabase,
} from '../../mobile/tests/helpers/sqliteHarness.mjs'
import { parseNoticeSource, noticeRowsFromCandidates } from '../../mobile/src/domain/noticeImport.ts'
import { NoticeImportRepository } from '../../mobile/src/domain/noticeImportRepository.ts'
import { TaskRepository } from '../../mobile/src/domain/taskRepository.ts'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const fixtures = join(workspaceRoot, 'frontend', 'public', 'samples', 'notices')
const HOMEWORK = join(fixtures, 'notice-01-homework.png')
const CHAT_TIME = join(fixtures, 'notice-02-chat-time.png')
const silentLogger = { info() {}, warn() {}, error() {} }
const NOW = () => new Date('2026-10-18T04:00:00.000Z')

/**
 * 递归删除前先证明目标确实是 `mkdtemp` 在系统临时目录下创建的那个前缀目录。
 *
 * 这不是形式主义：`rmSync(..., { recursive: true })` 是不可逆的，任何路径拼错
 * 都会造成真实数据丢失。要求同时满足：
 * - 解析后的父目录 == 解析后的系统临时目录；
 * - 解析后的目录名以精确的 `ddl-notice-photo-` 开头。
 */
function assertSafeTempDir(dir) {
  const resolved = realpathSync(dir)
  const tempRoot = realpathSync(tmpdir())
  assert.equal(dirname(resolved), tempRoot, `拒绝删除不在系统临时目录下的路径：${resolved}`)
  assert.ok(
    basename(resolved).startsWith('ddl-notice-photo-'),
    `拒绝删除前缀不匹配的临时目录：${resolved}`,
  )
  return resolved
}

function assertNoticeText(text) {
  assert.equal(typeof text, 'string')
  assert.ok(text.trim().length > 10, `OCR 文字太少：${JSON.stringify(text)}`)
  // 行顺序必须保留：消息头应排在正文之前。
  const header = text.indexOf('2026年10月8日')
  const body = Math.max(
    text.indexOf('张老师'),
    text.indexOf('王老师'),
    text.indexOf('第三次作业'),
    text.indexOf('实验预习报告'),
  )
  assert.ok(header >= 0, `OCR 应读到消息头，实际：${JSON.stringify(text)}`)
  assert.ok(body >= 0, `OCR 应读到正文，实际：${JSON.stringify(text)}`)
  assert.ok(header < body, `消息头应排在正文之前，实际：${JSON.stringify(text)}`)
}

function assertHomeworkParsed(parsed) {
  const deadlines = parsed.candidates.map((candidate) => candidate.deadline)
  assert.ok(parsed.candidates.length >= 1, JSON.stringify(parsed.candidates))
  assert.ok(
    deadlines.includes('2026-10-20T22:00'),
    `完整日期 + 时刻应成为截止时间，实际：${JSON.stringify(deadlines)}`,
  )
  // 复核已知：这张图的「提交要求」可能被解析器单独当成候选，不强行要求恰好 1 条。
  assert.ok(parsed.candidates.length <= 3, `候选数异常：${parsed.candidates.length}`)
}

test('真实 OCR（notice-01）→ 解析器 → SQLite 导入 → 关库重开读回', { timeout: 600_000 }, async () => {
  const engine = new OcrEngine()
  let sourceText
  try {
    const result = await engine.recognizeNotice(decodeImage(readFileSync(HOMEWORK)), {
      isCancelled: () => false,
    })
    assert.equal(result.cancelled, false)
    assert.equal(result.empty, false)
    sourceText = result.rawText
    assertNoticeText(sourceText)
    // 注意：真实 OCR 会把「学习通」拆成「学习\n通」两行；这里不修改夹具去迁就识别错误，
    // 只断言正文与完整截止时间确实被读到了（解析结果见下面的 deadline 断言）。
    assert.ok(sourceText.includes('第三次作业'), `OCR 应读到作业正文，实际：${sourceText}`)
  } finally {
    await engine.terminate()
  }

  const parsed = parseNoticeSource(sourceText, [])
  assertHomeworkParsed(parsed)
  const rows = noticeRowsFromCandidates(parsed.candidates, [])

  const dir = mkdtempSync(join(tmpdir(), 'ddl-notice-photo-'))
  const file = join(dir, 'notice-e2e.db')
  let raw = new DatabaseSync(file)
  try {
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec(readSchemaSql())
    raw.exec(readAppSettingsSql())
    raw.exec(readScreenshotLibrarySql())
    raw.exec('PRAGMA user_version = 3;')
    applyAdditiveColumns(raw)
    const db = wrapDatabase(raw)
    const repo = new NoticeImportRepository(db, NOW)
    const outcome = await repo.importNoticeCandidates({ sourceText, rows })
    assert.equal(outcome.committed, true, JSON.stringify(outcome))
    assert.ok(outcome.createdIds.length > 0)
    assert.ok(
      outcome.created.some((created) => created.task.deadline === '2026-10-20T22:00:00+08:00'),
      JSON.stringify(outcome.created.map((created) => created.task.deadline)),
    )

    raw.close()
    raw = new DatabaseSync(file)
    const reopened = wrapDatabase(raw)
    const reopenedTasks = new TaskRepository(reopened, NOW)
    const tasks = await reopenedTasks.listAll()
    assert.equal(tasks.length, outcome.createdIds.length, '重开之后任务都还在')
    const stored = await reopenedTasks.listAllOriginalSources()
    assert.equal(stored.size, outcome.createdIds.length, '每条任务都留了完整原文')
    for (const text of stored.values()) {
      assert.equal(text, sourceText, '原文逐字保留（包括 OCR 产生的空行与标点）')
    }
  } finally {
    try {
      raw.close()
    } catch {
      // 已经关过就算了
    }
    rmSync(assertSafeTempDir(dir), { recursive: true, force: true })
  }
})

test('真实 HTTP（notice-02）：startServer + 真实引擎识别；消息时间不能成为截止时间', { timeout: 600_000 }, async () => {
  const handle = await startServer(['--localhost', '--port', '0'], silentLogger)
  try {
    const { port } = handle.server.address()
    const base = `http://127.0.0.1:${port}`
    const health = await (await fetch(`${base}/v1/health`)).json()
    assert.equal(health.noticeOcr, true)

    const response = await fetch(`${base}/v1/ocr/notice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: readFileSync(CHAT_TIME).toString('base64') }),
      signal: AbortSignal.timeout(120_000),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.rawText, 'string')
    assert.equal(payload.empty, false)
    assert.ok(payload.requestId, '通知请求应带一个可用于界面显示的请求号')
    assert.ok(payload.image && payload.image.width > 0)
    assertNoticeText(payload.rawText)

    const parsed = parseNoticeSource(payload.rawText, [])
    assert.ok(parsed.candidates.length > 0, JSON.stringify(parsed.candidates))
    assert.deepEqual(
      parsed.candidates.map((candidate) => candidate.deadline),
      parsed.candidates.map(() => ''),
      '消息发送时间不能变成截止时间',
    )
  } finally {
    await handle.close()
  }
})
