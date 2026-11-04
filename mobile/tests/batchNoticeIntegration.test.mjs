/**
 * 批量识别通知 —— **真实 OCR 端到端验收**（Node，不跑手机）。
 *
 * 复用仓库里既有的两张合成通知截图，不修改夹具：
 * - `frontend/public/samples/notices/notice-01-homework.png`
 * - `frontend/public/samples/notices/notice-02-chat-time.png`
 *
 * 链路：
 *   实际 `createBatchNoticeOperation` 控制器
 *     → 相册端口注入这两张图的**真实字节**
 *     → 真实本机 HTTP（`companion/src/server.mjs` 的 `startServer`，随机端口）
 *     → 真实 Tesseract（`POST /v1/ocr/notice`，没有 mock 引擎）
 *     → 控制器逐张保存文字
 *     → 逐张 `parseNoticeSource`（既有通知解析器）
 *     → 隔离 SQLite 里逐张 `importNoticeCandidates`
 *     → 关库前读回每条任务的完整原文 / 截止时间。
 *
 * 明确标注哪些是测试替身：
 * - **归档端口是替身**：不触碰 Expo/真实手机文件系统，只在隔离 SQLite 里登记一条
 *   `fixture-archive://…` 的尝试；原图字节仍来自真实夹具；
 * - **相册端口是替身**：直接把夹具的 URI 映射到真实 PNG 字节；
 * - OCR 引擎、HTTP 服务、通知解析器、SQLite 仓库、任务读回都是真实的。
 *
 * 不写真实用户数据库 / 照片；临时目录先验证解析后的父目录正是系统临时目录再删除。
 * 运行方式（需要 mobile 的 TS 解析钩子）：
 *   node --import ./tests/setup.mjs --test --experimental-test-isolation=none tests/batchNoticeIntegration.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { startServer } from '../../companion/src/server.mjs'
import { createBatchNoticeOperation } from '../src/screens/batchNoticeController.ts'
import { recognizeNoticeImage } from '../src/domain/noticeOcrClient.ts'
import { noticeRowsFromCandidates, parseNoticeSource } from '../src/domain/noticeImport.ts'
import { NoticeImportRepository } from '../src/domain/noticeImportRepository.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import {
  applyAdditiveColumns,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const fixtures = join(workspaceRoot, 'frontend', 'public', 'samples', 'notices')
const HOMEWORK = join(fixtures, 'notice-01-homework.png')
const CHAT_TIME = join(fixtures, 'notice-02-chat-time.png')

const TEXT = {
  homework: 'fixture://notice-01-homework.png',
  chat: 'fixture://notice-02-chat-time.png',
}
const BYTES = new Map([
  [TEXT.homework, readFileSync(HOMEWORK).toString('base64')],
  [TEXT.chat, readFileSync(CHAT_TIME).toString('base64')],
])
const silentLogger = { info() {}, warn() {}, error() {} }
const NOW = () => new Date('2026-10-18T04:00:00.000Z')

async function waitFor(predicate, message, timeoutMs = 600_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(message)
}

function setupDatabase(dir) {
  const file = join(dir, 'batch-notice-e2e.db')
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec('PRAGMA user_version = 3;')
  applyAdditiveColumns(raw)
  return { raw, db: wrapDatabase(raw), file }
}

test(
  '真实夹具 01/02：批量控制器 → 本机 HTTP/Tesseract → 逐张解析 → 隔离 SQLite → 原文读回',
  { timeout: 900_000 },
  async () => {
    const handle = await startServer(['--localhost', '--port', '0'], silentLogger)
    const started = handle.server.address()
    const base = `http://127.0.0.1:${started.port}`
    const dir = mkdtempSync(join(tmpdir(), 'ddl-batch-notice-'))
    let raw = null
    try {
      const health = await (await fetch(`${base}/v1/health`)).json()
      assert.equal(health.noticeOcr, true, '本机伴侣服务必须声明支持通知 OCR')

      const opened = setupDatabase(dir)
      raw = opened.raw
      const screenshots = new ScreenshotLibraryRepository(opened.db, { now: NOW })
      const tasks = new TaskRepository(opened.db, NOW)
      const noticeImports = new NoticeImportRepository(opened.db, NOW)

      const archiveCalls = []
      let archiveActive = 0
      let archiveMax = 0
      const controller = createBatchNoticeOperation({
        pickFromLibrary: async () => ({
          status: 'picked',
          assets: [
            { uri: TEXT.homework, source: { width: 1170, height: 2532, mimeType: 'image/png' } },
            { uri: TEXT.chat, source: { width: 1170, height: 2532, mimeType: 'image/png' } },
          ],
        }),
        preparePhoto: async (uri) => {
          const base64 = BYTES.get(uri)
          if (!base64) throw new Error(`测试没有为 ${uri} 准备夹具字节`)
          return { base64, mimeType: 'image/png' }
        },
        // 归档端口是替身：只登记隔离 SQLite；**不触碰真实 Expo 文件系统 / 用户照片**。
        archiveOriginal: async (uri, source) => {
          archiveCalls.push(uri)
          archiveActive += 1
          archiveMax = Math.max(archiveMax, archiveActive)
          try {
            const archivedPath = `fixture-archive://${basename(uri)}`
            const outcome = await screenshots.recordAttempt({
              source: 'LIBRARY',
              status: 'ARCHIVED',
              originalUri: uri,
              archivedPath,
              width: source?.width ?? null,
              height: source?.height ?? null,
              format: 'png',
              mimeType: 'image/png',
              sha256: null,
              note: '测试注入的归档尝试：字节来自真实夹具，但不写手机文件系统',
            })
            return {
              ok: true,
              attemptId: outcome.attempt.id,
              message: null,
              archivedUri: archivedPath,
            }
          } finally {
            archiveActive -= 1
          }
        },
        recognize: (endpoint, options) => recognizeNoticeImage(endpoint, options),
        recordResult: async (input) => {
          await screenshots.recordOcrResult({
            attemptId: input.attemptId ?? 0,
            status: input.status,
            requestId: input.requestId ?? null,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
            warnings: input.warnings ?? null,
            rawText: input.rawText ?? null,
            durationMs: input.durationMs ?? null,
            image: input.image ?? null,
            // 通知文字不是课表候选：候选 / layout / week 一律不写。
            candidates: [],
          })
        },
        getEndpoint: () => base,
        getInferredEndpoint: () => null,
      })

      assert.equal(controller.requestPick(), 'started')
      await waitFor(
        () => !controller.getState().busy && controller.getState().items.length === 2,
        '等待两张夹具归档完成',
        30_000,
      )
      assert.equal(archiveCalls.length, 2)
      assert.equal(archiveMax, 1, '归档必须顺序进行')
      assert.ok(controller.getState().items.every((item) => item.archiveStatus === 'archived'))
      assert.equal(controller.getState().items[0].uri, TEXT.homework, '选择顺序必须保留')
      assert.equal(controller.getState().items[1].uri, TEXT.chat)
      assert.deepEqual(await tasks.listAll(), [], '选图 / 归档之后仍然必须零任务')

      assert.equal(controller.startRun(), 'started')
      await waitFor(
        () => !controller.getState().busy && controller.getState().items.every((item) => item.status !== 'running'),
        '等待真实本机 OCR 完成（Tesseract）',
      )

      const items = controller.getState().items
      assert.deepEqual(items.map((item) => item.status), ['success', 'success'], JSON.stringify(items))
      assert.ok(items[0].text.trim().length > 10, `夹具 01 OCR 文字太少：${JSON.stringify(items[0].text)}`)
      assert.ok(items[1].text.trim().length > 10, `夹具 02 OCR 文字太少：${JSON.stringify(items[1].text)}`)
      assert.notEqual(items[0].text, items[1].text, '两张图的文字必须各自独立')

      // 每次识别都真的登记到隔离 SQLite；只记录真实字段，没有课表 layout / week / candidates。
      for (const item of items) {
        assert.ok(item.archivedAttemptId, '已归档的尝试 id 必须存在')
        const result = await screenshots.getOcrResultByAttempt(item.archivedAttemptId)
        assert.ok(result, `截图库应能读回第 ${item.index} 张的识别结果`)
        assert.equal(result.status, 'SUCCESS')
        assert.equal(result.rawText, item.rawText)
        assert.equal(result.requestId, item.requestId)
        assert.ok(result.requestId, '真实 HTTP 通知识别应带请求号')
        assert.equal(result.layout, null, '通知文字不能伪造课表 layout')
        assert.equal(result.week, null, '通知文字不能伪造 week')
        assert.equal(result.candidateCount, 0, '通知文字不能伪造课表候选')
        assert.equal(result.payloadJson, null, '通知文字不写课表 payload')
        assert.equal(result.imageWidth, item.image?.width ?? null)
        assert.equal(result.durationMs, item.ocrMs)
      }
      const attempts = await screenshots.listAttempts(10)
      assert.equal(attempts.length, 2, '两张原图都留在截图库；没有物理删除')
      assert.ok(attempts.every((attempt) => attempt.archivedPath), '归档尝试必须保留原图路径')

      // OCR 完成之后、显式导入之前：仍然零任务。
      assert.deepEqual(await tasks.listAll(), [], '批量 OCR 绝不能自动写任务')

      const parsed = items.map((item) => parseNoticeSource(item.text, []))
      const rows = parsed.map((summary) => noticeRowsFromCandidates(summary.candidates, []))
      assert.ok(parsed[0].candidates.length > 0, `夹具 01 没有解析出候选：${items[0].text}`)
      assert.ok(parsed[1].candidates.length > 0, `夹具 02 没有解析出候选：${items[1].text}`)
      assert.ok(
        parsed[0].candidates.some((candidate) => candidate.deadline === '2026-10-20T22:00'),
        `夹具 01 应解析出 10 月 20 日 22:00：${JSON.stringify(parsed[0].candidates.map((c) => c.deadline))}`,
      )
      assert.deepEqual(
        parsed[1].candidates.map((candidate) => candidate.deadline),
        parsed[1].candidates.map(() => ''),
        '夹具 02 的消息发送时间不能变成截止时间',
      )

      // 显式、逐张导入：每张图各自一份 sourceText，不合并成一大段原文。
      const outcomes = []
      for (const item of items) {
        const index = item.index - 1
        const outcome = await noticeImports.importNoticeCandidates({
          sourceText: items[index].text,
          rows: rows[index],
        })
        assert.equal(outcome.committed, true, JSON.stringify(outcome))
        assert.ok(outcome.createdIds.length > 0, `第 ${item.index} 张应至少创建一条任务`)
        outcomes.push(outcome)
      }

      const storedTasks = await tasks.listAll()
      const storedSources = await tasks.listAllOriginalSources()
      assert.equal(storedSources.size, storedTasks.length, '每条任务都要留一份完整原文')
      assert.equal(storedTasks.length, outcomes[0].createdIds.length + outcomes[1].createdIds.length)

      const distinctSources = new Set(storedSources.values())
      assert.equal(distinctSources.size, 2, '两张截图的原文必须各自保留，不能合并成一份')
      for (const text of storedSources.values()) {
        assert.ok(
          text === items[0].text || text === items[1].text,
          `任务原文必须是某一整张图的逐字 OCR 文字，实际：${JSON.stringify(text)}`,
        )
      }
      const combined = items[0].text + items[1].text
      assert.ok(
        [...storedSources.values()].every((text) => text !== combined),
        '不能把两张图拼成一份超大原文',
      )

      assert.ok(
        outcomes[0].created.some((created) => created.task.deadline === '2026-10-20T22:00:00+08:00'),
        `夹具 01 的任务截止时间应为 10 月 20 日 22:00：${JSON.stringify(
          outcomes[0].created.map((created) => created.task.deadline),
        )}`,
      )
      assert.ok(
        outcomes[1].created.every((created) => created.task.deadline === null),
        '夹具 02 的消息时间不能写进任务截止时间',
      )
      // 原文读回必须逐字一致（包含 OCR 产生的空行 / 标点）。
      for (const outcome of outcomes) {
        for (const created of outcome.created) {
          assert.equal(storedSources.get(created.task.id), items[outcome === outcomes[0] ? 0 : 1].text)
        }
      }
    } finally {
      try {
        await handle.close()
      } catch {
        // 已经关过就算了
      }
      try {
        raw?.close()
      } catch {
        // 已经关过就算了
      }
      removeTempDir(dir, 'ddl-batch-notice-')
    }
  },
)
