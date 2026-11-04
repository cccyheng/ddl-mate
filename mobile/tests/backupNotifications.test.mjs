/**
 * 恢复边界的通知行为：暂停期间不排程、只取消本应用通知、部分取消失败后
 * 从**未改变的数据库**重新对账，以及代次不同的旧 OS 通知必须替换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTaskReminderService } from '../src/domain/taskReminderService.ts'
import {
  buildReminderNotificationPayload,
  buildTestReminderNotificationPayload,
  reminderNotificationId,
  taskReminderFingerprint,
  testReminderNotificationId,
} from '../src/domain/taskReminder.ts'

const NOW = () => new Date('2026-10-08T04:00:00.000Z')
const TASK = {
  id: 1,
  title: '提醒任务',
  deadline: '2026-12-01T10:00:00+08:00',
  status: 'TODO',
}
const TRIGGER = Date.parse('2026-11-30T10:00:00+08:00')
const INTENT = {
  version: 1,
  taskId: 1,
  enabled: true,
  leadMinutes: 1440,
  revision: 1,
  updatedAt: NOW().toISOString(),
}

function payload(generation = 0) {
  return buildReminderNotificationPayload(TASK, 1440, TRIGGER, generation)
}

function pendingOwned(identifier = reminderNotificationId(1), generation = 0) {
  return {
    identifier,
    data: payload(generation),
    trigger: { type: 'date', value: TRIGGER },
    title: TASK.title,
  }
}

function pendingTest(generation = 0) {
  return {
    identifier: testReminderNotificationId(1),
    data: buildTestReminderNotificationPayload(1, TRIGGER, generation),
    trigger: { type: 'date', value: TRIGGER },
    title: '测试提醒',
  }
}

function makeHarness({ initialPending = [], failCancel = () => false } = {}) {
  let pending = initialPending.map((entry) => ({ ...entry }))
  const scheduled = []
  const cancelled = []
  let generation = 0
  const port = {
    async getPermission() {
      return { status: 'granted', canAskAgain: true, detail: null }
    },
    async requestPermission() {
      return { status: 'granted', canAskAgain: true, detail: null }
    },
    async listPending() {
      return pending.map((entry) => ({ ...entry }))
    },
    async schedule(content) {
      scheduled.push({ identifier: content.identifier, generation: content.data.deliveryGeneration })
      const next = {
        identifier: content.identifier,
        data: content.data,
        trigger: { type: 'date', value: content.triggerAtMs },
        title: content.title,
      }
      pending = pending.filter((entry) => entry.identifier !== content.identifier)
      pending.push(next)
    },
    async cancel(identifier) {
      if (failCancel(identifier)) throw new Error(`测试注入：取消失败 ${identifier}`)
      cancelled.push(identifier)
      pending = pending.filter((entry) => entry.identifier !== identifier)
    },
  }
  const service = createTaskReminderService({
    port,
    readTasks: async () => [TASK],
    readEntries: async () => ({ ok: true, entries: [{ taskId: 1, state: 'valid', intent: INTENT, reason: null }] }),
    loadReminder: async () => ({ ok: true, state: 'valid', intent: INTENT, revision: INTENT.revision }),
    getTask: async () => TASK,
    saveReminder: async () => ({
      ok: true,
      committed: true,
      revision: 2,
      intent: INTENT,
      reason: null,
      readbackError: null,
    }),
    removeReminder: async () => null,
    now: NOW,
    getNotificationGeneration: () => generation,
  })
  return {
    service,
    port,
    scheduled,
    cancelled,
    setGeneration(value) {
      generation = value
    },
    getPending() {
      return pending
    },
  }
}

test('暂停对账期间不 schedule；取消只碰本应用命名空间；恢复后从原 DB 重新安排', async () => {
  const harness = makeHarness({
    initialPending: [pendingOwned(reminderNotificationId(1)), pendingTest(), { identifier: 'other.app.1', data: {}, trigger: null }],
    failCancel: (identifier) => identifier === testReminderNotificationId(1),
  })
  await harness.service.suspendForBackup('恢复测试')
  const suspended = await harness.service.reconcile('while-suspended')
  assert.equal(suspended.ok, false)
  assert.equal(harness.scheduled.length, 0, '暂停期间绝不能安排新通知')

  const cancel = await harness.service.cancelAllOwnedNotifications('测试部分取消')
  assert.equal(cancel.ok, false, '部分取消失败必须如实报告')
  assert.deepEqual(cancel.failures.map((entry) => entry.identifier), [testReminderNotificationId(1)])
  assert.equal(harness.cancelled.includes('other.app.1'), false, '别的 App 通知绝不能被取消')

  // 模拟恢复没有提交：释放暂停后必须从原 DB 重新对账（已取消的那条要补排）。
  await harness.service.resumeAfterBackup()
  const report = await harness.service.reconcile('恢复失败，重新安排原提醒')
  assert.equal(report.ok, true, report.reason ?? '')
  assert.ok(harness.scheduled.some((entry) => entry.identifier === reminderNotificationId(1)))
})

test('暂停期间被丢弃的对账请求：resume 后自动补一次最新 DB 对账', async () => {
  const harness = makeHarness()
  await harness.service.suspendForBackup('导出/预览测试')
  const dropped = await harness.service.notifyTaskChange('暂停期间的任务改动')
  assert.equal(dropped?.ok, false)
  assert.equal(harness.scheduled.length, 0)
  harness.service.resumeAfterBackup()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(
    harness.scheduled.some((entry) => entry.identifier === reminderNotificationId(1)),
    'resume 必须补一次最新 DB 对账，不能只 emit',
  )
})

test('代次不同的旧 OS 通知会被替换；新代次通知正常排程', async () => {
  const harness = makeHarness({ initialPending: [pendingOwned(reminderNotificationId(1), 0)] })
  harness.setGeneration(3)
  const report = await harness.service.reconcile('恢复后')
  assert.equal(report.ok, true, report.reason ?? '')
  assert.equal(harness.cancelled.includes(reminderNotificationId(1)), true, '旧代次通知必须先取消')
  assert.ok(
    harness.scheduled.some(
      (entry) => entry.identifier === reminderNotificationId(1) && entry.generation === 3,
    ),
    '新排程必须带当前代次',
  )
})

test('通知载荷代次缺省为 0，负数/坏代次被拒绝（旧通知兼容与失效边界）', async () => {
  const { parseReminderNotificationPayload } = await import('../src/domain/taskReminder.ts')
  const old = { ...payload(0) }
  delete old.deliveryGeneration
  const parsedOld = parseReminderNotificationPayload(old)
  assert.equal(parsedOld.ok, true)
  assert.equal(parsedOld.payload.deliveryGeneration, 0)
  assert.equal(parseReminderNotificationPayload({ ...payload(0), deliveryGeneration: -1 }).ok, false)
  assert.equal(parseReminderNotificationPayload({ ...payload(0), deliveryGeneration: 1.5 }).ok, false)

  // 指纹仍只由原有字段决定，代次单独比较，不会让同一个提醒无故重复排。
  assert.equal(
    taskReminderFingerprint({ taskId: 1, deadline: TASK.deadline, leadMinutes: 1440, title: TASK.title, triggerAtMs: TRIGGER }),
    payload(9).fingerprint,
  )
})
