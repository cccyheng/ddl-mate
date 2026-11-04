/**
 * 任务提醒设置仓库 —— **真实 SQLite** 测试。
 *
 * 验证：默认关闭、保存 / 重开数据库、坏记录与未来版本只读、修订号冲突、
 * 任务不存在时零写入、没有 DDL / DONE / CANCELLED / 提醒时刻已过拒绝启用、
 * 关闭在任务失效时仍可用、32 条上限、删任务精确清理、写入失败整体回滚。
 *
 * 边界：Node 侧 `node:sqlite`，不是 iPhone 上的 expo-sqlite；所有库都在系统临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyAdditiveColumns,
  failingRunDatabase,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { SCHEMA_VERSION } from '../src/db/schema.ts'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import { TaskReminderRepository } from '../src/domain/taskReminderRepository.ts'
import { decodeTaskReminder } from '../src/domain/taskReminder.ts'

const NOW = new Date('2026-10-20T04:00:00.000Z') // 北京时间 2026-10-20 12:00
const FUTURE_DEADLINE = '2026-10-20T22:00'

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-reminders-'))
  return { dir, file: join(dir, 'reminders.db') }
}

function openFileDatabase(file, now = () => NOW) {
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const tasks = new TaskRepository(db, now)
  const reminders = new TaskReminderRepository(db, tasks, now)
  return { raw, db, tasks, reminders }
}

async function createTask(tasks, overrides = {}) {
  const outcome = await tasks.create(taskDraft({ deadline: FUTURE_DEADLINE, ...overrides }))
  return outcome.id
}

const enable = (taskId, leadMinutes = 30, expectedRevision = 0) => ({
  taskId,
  enabled: true,
  leadMinutes,
  expectedRevision,
})

const disable = (taskId, leadMinutes = 30, expectedRevision = 0) => ({
  taskId,
  enabled: false,
  leadMinutes,
  expectedRevision,
})

test('默认关闭；保存 → 重开数据库后仍是同一条规则，只写一个键', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)

    const initial = await opened.reminders.loadReminder(taskId)
    assert.deepEqual(initial, { ok: true, state: 'missing', intent: null, revision: 0 })

    const saved = await opened.reminders.saveReminder(enable(taskId, 180))
    assert.equal(saved.ok, true)
    assert.equal(saved.committed, true)
    assert.equal(saved.revision, 1)
    assert.equal(saved.intent.enabled, true)
    assert.equal(saved.intent.leadMinutes, 180)

    const rows = opened.raw.prepare('SELECT key, value FROM app_settings;').all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].key, `task_reminder.${taskId}`)
    const stored = JSON.parse(String(rows[0].value))
    assert.equal(stored.version, 1)
    assert.equal(stored.taskId, taskId)
    assert.equal(stored.revision, 1)
    opened.raw.close()

    const reopened = openFileDatabase(file)
    const loaded = await reopened.reminders.loadReminder(taskId)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.revision, 1)
    assert.equal(loaded.intent.enabled, true)
    assert.equal(loaded.intent.leadMinutes, 180)
    reopened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('关闭也持久化；再次开启修订号继续递增', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, { deadline: '2026-10-25T22:00' })
    assert.equal((await opened.reminders.saveReminder(enable(taskId))).revision, 1)
    const off = await opened.reminders.saveReminder(disable(taskId, 30, 1))
    assert.equal(off.committed, true)
    assert.equal(off.revision, 2)
    assert.equal(off.intent.enabled, false)
    const on = await opened.reminders.saveReminder(enable(taskId, 1440, 2))
    assert.equal(on.revision, 3)
    assert.equal(on.intent.leadMinutes, 1440)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('损坏 / 未来版本：读取如实失败，保存零写入，原始值一个字节不变', async () => {
  for (const rawValue of [
    '{broken json',
    JSON.stringify({ version: 99, taskId: 1, enabled: true, leadMinutes: 30, revision: 9, updatedAt: 'x' }),
  ]) {
    const { dir, file } = tempDbPath()
    try {
      const opened = openFileDatabase(file)
      const taskId = await createTask(opened.tasks)
      opened.raw
        .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);')
        .run(`task_reminder.${taskId}`, rawValue, NOW.toISOString())

      const loaded = await opened.reminders.loadReminder(taskId)
      assert.equal(loaded.ok, false)
      assert.ok(['CORRUPT', 'FUTURE'].includes(loaded.code), loaded.code)

      const saved = await opened.reminders.saveReminder(enable(taskId, 30, 9))
      assert.equal(saved.committed, false)
      assert.notEqual(saved.reason, null)
      const row = opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(`task_reminder.${taskId}`)
      assert.equal(String(row.value), rawValue, '绝不覆盖读不出来的记录')
      opened.raw.close()
    } finally {
      removeTempDir(dir, 'ddl-reminders-')
    }
  }
})

test('修订号冲突：后到的旧版本被拒绝，不覆盖；拿最新版本后仍可替换', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    assert.equal((await opened.reminders.saveReminder(enable(taskId, 30, 0))).revision, 1)
    const stale = await opened.reminders.saveReminder(enable(taskId, 180, 0))
    assert.equal(stale.committed, false)
    assert.equal(stale.revision, 1)
    assert.match(stale.reason, /别处已经保存过/)
    assert.equal((await opened.reminders.loadReminder(taskId)).intent.leadMinutes, 30)
    const fresh = await opened.reminders.saveReminder(enable(taskId, 180, 1))
    assert.equal(fresh.committed, true)
    assert.equal(fresh.revision, 2)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('没有 DDL / 已完成 / 已取消 / 提醒时刻已过：启用零写入；关闭仍允许', async () => {
  const cases = [
    { overrides: { deadline: '' }, code: 'NO_DEADLINE' },
    { overrides: { status: 'DONE' }, code: 'TASK_DONE' },
    { overrides: { status: 'CANCELLED' }, code: 'TASK_CANCELLED' },
    { overrides: { deadline: '2026-10-20T12:10' }, code: 'REMINDER_PAST' },
  ]
  for (const item of cases) {
    const { dir, file } = tempDbPath()
    try {
      const opened = openFileDatabase(file)
      const taskId = await createTask(opened.tasks, item.overrides)
      const saved = await opened.reminders.saveReminder(enable(taskId))
      assert.equal(saved.committed, false, item.code)
      assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, item.code)

      // 关闭不要求任务仍然可提醒：先手工放一条已启用记录，再关闭。
      opened.raw
        .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);')
        .run(
          `task_reminder.${taskId}`,
          JSON.stringify({
            version: 1,
            taskId,
            enabled: true,
            leadMinutes: 30,
            revision: 1,
            updatedAt: NOW.toISOString(),
          }),
          NOW.toISOString(),
        )
      const off = await opened.reminders.saveReminder(disable(taskId, 30, 1))
      assert.equal(off.committed, true, item.code)
      assert.equal(off.intent.enabled, false)
      opened.raw.close()
    } finally {
      removeTempDir(dir, 'ddl-reminders-')
    }
  }
})

test('32 条上限：第 33 条拒绝启用；关掉一条后可启用；已有规则改提前量不占新名额', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const ids = []
    for (let index = 0; index < 33; index += 1) ids.push(await createTask(opened.tasks, { title: `任务 ${index + 1}` }))
    for (let index = 0; index < 32; index += 1) {
      assert.equal((await opened.reminders.saveReminder(enable(ids[index]))).committed, true)
    }
    const rejected = await opened.reminders.saveReminder(enable(ids[32]))
    assert.equal(rejected.committed, false)
    assert.match(rejected.reason, /最多 32 条/)
    assert.equal(opened.raw.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE value LIKE '%\"enabled\":true%';").get().n, 32)

    // 已经启用的规则改提前量：不占新名额，仍然可以保存。
    assert.equal((await opened.reminders.saveReminder(enable(ids[0], 180, 1))).committed, true)

    assert.equal((await opened.reminders.saveReminder(disable(ids[1], 30, 1))).committed, true)
    assert.equal((await opened.reminders.saveReminder(enable(ids[32]))).committed, true)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('删除任务：在同一个事务里精确清掉它自己的规则键，保留别的任务', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const first = await createTask(opened.tasks, { title: 'A' })
    const second = await createTask(opened.tasks, { title: 'B' })
    assert.equal((await opened.reminders.saveReminder(enable(first))).committed, true)
    assert.equal((await opened.reminders.saveReminder(enable(second))).committed, true)
    opened.tasks.setRemoveCleanup((taskId) => opened.reminders.removeReminderForTask(taskId))
    await opened.tasks.remove(first)
    const rows = opened.raw.prepare('SELECT key FROM app_settings;').all()
    assert.deepEqual(rows.map((row) => row.key), [`task_reminder.${second}`])
    const missing = await opened.reminders.loadReminder(first)
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'PARENT_MISSING')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('任务不存在：读取 / 保存都明确失败且零写入', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const loaded = await opened.reminders.loadReminder(999)
    assert.equal(loaded.ok, false)
    assert.equal(loaded.code, 'PARENT_MISSING')
    const saved = await opened.reminders.saveReminder(enable(999))
    assert.equal(saved.committed, false)
    assert.match(saved.reason, /不在本机/)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('写入中途失败：整个事务回滚，不会留下半条规则', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const failingDb = failingRunDatabase(opened.db, (_count, sql) => sql.includes('INSERT INTO app_settings'))
    const failing = new TaskReminderRepository(failingDb, opened.tasks, () => NOW)
    const outcome = await failing.saveReminder(enable(taskId))
    assert.equal(outcome.committed, false)
    assert.match(outcome.reason, /保存提醒设置失败/)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('listReminders：只读列出规则与不可读状态；不会写入任何键', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const good = await createTask(opened.tasks, { title: '好记录' })
    const bad = await createTask(opened.tasks, { title: '坏记录' })
    assert.equal((await opened.reminders.saveReminder(enable(good))).committed, true)
    opened.raw
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);')
      .run(`task_reminder.${bad}`, '{oops', NOW.toISOString())
    const before = opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    const listed = await opened.reminders.listReminders()
    assert.equal(listed.ok, true)
    assert.equal(listed.entries.length, 2)
    assert.equal(listed.entries.find((entry) => entry.taskId === good).state, 'valid')
    assert.equal(listed.entries.find((entry) => entry.taskId === bad).state, 'corrupt')
    const after = opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    assert.equal(after, before)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})

test('保存的 JSON 能被同一个解码器读回（版本与任务编号一致）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, { deadline: '2026-10-25T22:00' })
    await opened.reminders.saveReminder(enable(taskId, 4320))
    const row = opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(`task_reminder.${taskId}`)
    const decoded = decodeTaskReminder(String(row.value), taskId)
    assert.equal(decoded.ok, true)
    assert.equal(decoded.intent.leadMinutes, 4320)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-reminders-')
  }
})
