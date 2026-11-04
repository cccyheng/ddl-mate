/**
 * 任务提醒点击回执仓库：真实临时 SQLite。
 *
 * 覆盖：缺省为空、跨重开持久、A/B/A 保留多条、幂等、32 条上限、
 * 坏记录 / 未来版本零写入（绝不覆盖原值）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAppSettingsSql, wrapDatabase } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import {
  MAX_TASK_REMINDER_RECEIPTS,
  TASK_REMINDER_RECEIPT_KEY,
  decodeTaskReminderNotificationReceipts,
  encodeTaskReminderNotificationReceipts,
} from '../src/domain/taskReminderNotificationReceipts.ts'
import { TaskReminderNotificationReceiptsRepository } from '../src/domain/taskReminderNotificationReceiptsRepository.ts'

function openReceipts() {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-receipts-'))
  const raw = new DatabaseSync(join(dir, 'receipts.db'))
  raw.exec(readAppSettingsSql())
  const db = wrapDatabase(raw)
  return {
    dir,
    raw,
    db,
    repository: new TaskReminderNotificationReceiptsRepository(db, () => new Date('2026-10-20T12:00:00.000Z')),
    close() {
      raw.close()
      removeTempDir(dir, 'ddl-receipts-')
    },
  }
}

function receipt(token, overrides = {}) {
  return {
    version: 1,
    token,
    taskId: 7,
    identifier: 'ddlmate.task-reminder.v1.7',
    deliveryDate: 1000,
    evidence: 'fingerprint:v1-test',
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    consumedAt: '2026-10-20T12:00:00.000Z',
    ...overrides,
  }
}

test('缺省为空；记录 / 重开后仍在；A/B/A 不会被单 token 覆盖', async () => {
  const opened = openReceipts()
  try {
    assert.deepEqual(await opened.repository.loadReceipts(), { ok: true, receipts: [] })

    const a = receipt('token-a')
    const b = receipt('token-b', { taskId: 8, identifier: 'ddlmate.task-reminder.v1.8' })
    assert.equal((await opened.repository.recordConsumption(a)).ok, true)
    assert.equal((await opened.repository.recordConsumption(b)).ok, true)
    assert.equal((await opened.repository.recordConsumption(a)).stored, false, '重复 A 幂等，不新增')

    const reopened = new TaskReminderNotificationReceiptsRepository(opened.db)
    assert.equal((await reopened.hasConsumed('token-a')).consumed, true)
    assert.equal((await reopened.hasConsumed('token-b')).consumed, true)
    assert.equal((await reopened.hasConsumed('token-c')).consumed, false)
    const loaded = await reopened.loadReceipts()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.receipts.length, 2)
  } finally {
    opened.close()
  }
})

test('上限 32 条：保留最新，最旧的被淘汰', async () => {
  const opened = openReceipts()
  try {
    for (let index = 0; index < MAX_TASK_REMINDER_RECEIPTS + 5; index += 1) {
      const result = await opened.repository.recordConsumption(receipt(`token-${index}`))
      assert.equal(result.ok, true)
    }
    const loaded = await opened.repository.loadReceipts()
    assert.equal(loaded.ok, true)
    assert.equal(loaded.receipts.length, MAX_TASK_REMINDER_RECEIPTS)
    assert.equal(loaded.receipts[0].token, `token-${MAX_TASK_REMINDER_RECEIPTS + 4}`)
    assert.equal((await opened.repository.hasConsumed('token-0')).consumed, false)
  } finally {
    opened.close()
  }
})

test('坏 JSON / 未来版本：读取如实失败，写入零覆盖', async () => {
  const opened = openReceipts()
  try {
    opened.raw
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);')
      .run(TASK_REMINDER_RECEIPT_KEY, '{not json', '2026-10-20T12:00:00.000Z')

    const loaded = await opened.repository.loadReceipts()
    assert.equal(loaded.ok, false)
    const before = opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(TASK_REMINDER_RECEIPT_KEY)
    const result = await opened.repository.recordConsumption(receipt('token-a'))
    assert.equal(result.ok, false)
    const after = opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(TASK_REMINDER_RECEIPT_KEY)
    assert.equal(after.value, before.value, '坏值一个字节都不能改')

    opened.raw
      .prepare('UPDATE app_settings SET value = ? WHERE key = ?;')
      .run(encodeTaskReminderNotificationReceipts([receipt('token-a')]).replace('"version":1', '"version":2'), TASK_REMINDER_RECEIPT_KEY)
    assert.equal((await opened.repository.loadReceipts()).ok, false)
    assert.equal((await opened.repository.recordConsumption(receipt('token-b'))).ok, false)
  } finally {
    opened.close()
  }
})

test('回执编解码严格：坏字段 / 超长 token / 重复 token 都按规则处理', () => {
  const encoded = encodeTaskReminderNotificationReceipts([receipt('a'), receipt('a'), receipt('b')])
  const decoded = decodeTaskReminderNotificationReceipts(encoded)
  assert.equal(decoded.ok, true)
  assert.deepEqual(
    decoded.receipts.map((entry) => entry.token),
    ['a', 'b'],
  )
  assert.equal(decodeTaskReminderNotificationReceipts('[]').ok, false)
  assert.equal(decodeTaskReminderNotificationReceipts(JSON.stringify({ version: 1, receipts: [{ token: 'x' }] })).ok, false)
  assert.equal(
    decodeTaskReminderNotificationReceipts(
      JSON.stringify({ version: 1, receipts: [receipt('x'.repeat(513))] }),
    ).ok,
    false,
  )
})
