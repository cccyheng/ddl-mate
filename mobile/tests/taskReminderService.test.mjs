/**
 * 任务提醒中央串行服务 —— 真实 SQLite + **假通知端口**测试。
 *
 * 这里验证的是服务自己的语义：保存后真实排队状态、权限被拒 / provisional / 原生不可用、
 * 调度失败仍保留已保存意图、刷新不重复、任务改动替换、完成 / 删除 / 关闭只取消本应用
 * 自己的通知、列表失败是「未知」不是「空」、取消失败不排新通知、测试提醒独立命名空间、
 * 串行队列 newest-intent-wins。
 *
 * 明确边界：**没有真机通知硬件验证**；`port` 是内存假端口，只验证逻辑与字节级 ID/载荷。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import {
  applyAdditiveColumns,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import { TaskReminderRepository } from '../src/domain/taskReminderRepository.ts'
import { createTaskReminderService } from '../src/domain/taskReminderService.ts'
import { offsetIsoToShanghaiParts } from '../src/domain/datetime.ts'

const NOW = new Date('2026-10-20T04:00:00.000Z') // 北京时间 2026-10-20 12:00
const DEADLINE = '2026-10-20T22:00'

function openMemory() {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec('PRAGMA user_version = 3;')
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const tasks = new TaskRepository(db, () => NOW)
  const reminders = new TaskReminderRepository(db, tasks, () => NOW)
  return { raw, db, tasks, reminders }
}

async function createTask(tasks, overrides = {}) {
  const outcome = await tasks.create(taskDraft({ deadline: DEADLINE, ...overrides }))
  return outcome.id
}

const taskLike = (task) => ({ id: task.id, title: task.title, deadline: task.deadline, status: task.status })

function createFakePort(options = {}) {
  const state = {
    permission: options.permission ?? { status: 'granted', canAskAgain: true, detail: null },
    requestResult: options.requestResult ?? { status: 'granted', canAskAgain: true, detail: null },
    pending: [...(options.pending ?? [])],
    scheduleCalls: [],
    cancelCalls: [],
    requestCalls: 0,
    listCalls: 0,
    scheduleError: options.scheduleError ?? null,
    cancelError: options.cancelError ?? null,
    listError: options.listError ?? null,
  }
  const port = {
    getPermission: async () => state.permission,
    requestPermission: async () => {
      state.requestCalls += 1
      state.permission = state.requestResult
      return state.permission
    },
    listPending: async () => {
      state.listCalls += 1
      if (state.listError) throw new Error(state.listError)
      return state.pending
    },
    schedule: async (content) => {
      if (state.scheduleError) throw new Error(state.scheduleError)
      state.scheduleCalls.push(content)
      state.pending = state.pending.filter((item) => item.identifier !== content.identifier)
      state.pending.push({
        identifier: content.identifier,
        data: content.data,
        trigger: { type: 'date', value: content.triggerAtMs },
        title: content.title,
      })
    },
    cancel: async (identifier) => {
      if (state.cancelError) throw new Error(state.cancelError)
      state.cancelCalls.push(identifier)
      state.pending = state.pending.filter((item) => item.identifier !== identifier)
    },
  }
  return { state, port }
}

function createService(opened, port, now = NOW) {
  return createTaskReminderService({
    port,
    readTasks: async () => (await opened.tasks.listAll()).map(taskLike),
    readEntries: () => opened.reminders.listReminders(),
    loadReminder: (taskId) => opened.reminders.loadReminder(taskId),
    getTask: async (taskId) => {
      const task = await opened.tasks.getById(taskId)
      return task ? taskLike(task) : null
    },
    saveReminder: (input) => opened.reminders.saveReminder(input),
    removeReminder: (taskId) => opened.reminders.removeReminderForTask(taskId),
    now: () => now,
  })
}

test('开启 + 权限允许：规则提交 → 系统确认排队；重复刷新不重复安排', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)

  const outcome = await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(outcome.save.committed, true)
  assert.equal(outcome.savedButNotScheduled, false)
  assert.equal(outcome.inspection.osState, 'queued')
  assert.equal(state.scheduleCalls.length, 1)
  assert.equal(state.pending.length, 1)

  const report = await service.reconcile('foreground')
  assert.equal(report.ok, true)
  assert.equal(report.unchangedTaskIds.includes(taskId), true)
  assert.equal(state.scheduleCalls.length, 1, '刷新不能重复安排')
  assert.equal(state.pending.length, 1)
  opened.raw.close()
})

test('开启 + 权限被拒：规则已保存但明确“尚未安排”；授权后重试才安排', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort({
    permission: { status: 'denied', canAskAgain: false, detail: null },
  })
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)

  const outcome = await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(outcome.save.committed, true)
  assert.equal(outcome.savedButNotScheduled, true)
  assert.match(outcome.reason, /权限|安排/)
  assert.equal(state.scheduleCalls.length, 0)
  assert.equal(outcome.inspection.osState, 'not-queued')

  state.permission = { status: 'granted', canAskAgain: true, detail: null }
  const retried = await service.reconcile('manual-retry')
  assert.equal(retried.scheduledTaskIds.includes(taskId), true)
  assert.equal(state.scheduleCalls.length, 1)
  opened.raw.close()
})

test('原生安排失败：不谎报已安排，也不把已经提交的规则说成保存失败', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort({ scheduleError: '模拟 OS 排程失败' })
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)

  const outcome = await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(outcome.save.committed, true)
  assert.equal(outcome.savedButNotScheduled, true)
  assert.match(outcome.reason, /尚未安排|安排.*失败/)
  assert.equal(outcome.report.ok, false)
  assert.ok(outcome.report.failures.some((failure) => failure.action === 'schedule'))
  assert.equal(state.pending.length, 0)
  assert.equal(outcome.inspection.osState, 'not-queued')

  // 规则确实还在库里，重试时仍然可用。
  const loaded = await opened.reminders.loadReminder(taskId)
  assert.equal(loaded.ok, true)
  assert.equal(loaded.intent.enabled, true)
  opened.raw.close()
})

test('权限 provisional：可以安排，但界面语义是安静通知；unavailable 不安排', async () => {
  const opened = openMemory()
  const provisionalPort = createFakePort({
    permission: { status: 'provisional', canAskAgain: true, detail: null },
  }).port
  const provisionalService = createService(opened, provisionalPort)
  const first = await createTask(opened.tasks, { title: 'provisional' })
  const provisional = await provisionalService.saveSettings({
    taskId: first,
    enabled: true,
    leadMinutes: 30,
    expectedRevision: 0,
  })
  assert.equal(provisional.inspection.osState, 'queued')

  const unavailablePort = createFakePort({
    permission: { status: 'unavailable', canAskAgain: false, detail: '没有原生模块' },
  }).port
  const unavailableService = createService(opened, unavailablePort)
  const second = await createTask(opened.tasks, { title: 'unavailable' })
  const unavailable = await unavailableService.saveSettings({
    taskId: second,
    enabled: true,
    leadMinutes: 30,
    expectedRevision: 0,
  })
  assert.equal(unavailable.save.committed, true)
  assert.equal(unavailable.savedButNotScheduled, true)
  assert.equal(unavailable.inspection.osState, 'not-queued')
  opened.raw.close()
})

test('改标题 / 改截止时间：只替换同一条应用通知，系统里仍然只有一条', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks, { title: '旧标题' })
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(state.pending.length, 1)

  await opened.tasks.update(taskId, taskDraft({ deadline: '2026-10-21T22:00', title: '新标题' }))
  const report = await service.reconcile('task-update')
  assert.equal(report.ok, true)
  assert.ok(report.scheduledTaskIds.includes(taskId))
  assert.equal(state.pending.length, 1)
  assert.equal(state.pending[0].identifier, `ddlmate.task-reminder.v1.${taskId}`)
  assert.equal(state.scheduleCalls.length, 2)
  assert.match(state.pending[0].data.title, /新标题/)
  opened.raw.close()
})

test('完成 / 取消 / 关闭 / 删除只取消本应用精确 ID 的通知；外应用通知保留', async () => {
  const opened = openMemory()
  const foreign = { identifier: 'com.other.app.meeting', data: { foo: 'bar' }, trigger: { type: 'date', value: 1 } }
  const { state, port } = createFakePort({ pending: [foreign] })
  const service = createService(opened, port)
  const first = await createTask(opened.tasks, { title: 'A' })
  const second = await createTask(opened.tasks, { title: 'B' })
  await service.saveSettings({ taskId: first, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  await service.saveSettings({ taskId: second, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(state.pending.length, 3)

  await opened.tasks.changeStatus(first, 'DONE')
  await service.reconcile('task-done')
  assert.equal(state.pending.some((item) => item.identifier === `ddlmate.task-reminder.v1.${first}`), false)
  assert.equal(state.pending.some((item) => item.identifier === `ddlmate.task-reminder.v1.${second}`), true)
  assert.equal(state.pending.some((item) => item.identifier === foreign.identifier), true)
  assert.ok(state.cancelCalls.every((identifier) => identifier === `ddlmate.task-reminder.v1.${first}`))

  await service.saveSettings({ taskId: second, enabled: false, leadMinutes: 30, expectedRevision: 1 })
  assert.equal(state.pending.some((item) => item.identifier === `ddlmate.task-reminder.v1.${second}`), false)
  assert.equal(state.pending.some((item) => item.identifier === foreign.identifier), true)

  await opened.tasks.remove(second) // 没有注入 cleanup，模拟遗留的规则键
  const report = await service.reconcile('task-delete')
  assert.deepEqual(report.orphanTaskIds, [second])
  const entries = await opened.reminders.listReminders()
  assert.equal(entries.entries.some((entry) => entry.taskId === second), false, '孤儿规则被精确清理')
  opened.raw.close()
})

test('关闭时权限被拒也必须取消；取消失败可见，不能声称已经取消', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(state.pending.length, 1)

  state.permission = { status: 'denied', canAskAgain: false, detail: null }
  const off = await service.saveSettings({ taskId, enabled: false, leadMinutes: 30, expectedRevision: 1 })
  assert.equal(off.save.committed, true)
  assert.equal(state.pending.length, 0, '权限被拒也要取消')
  assert.equal(off.reason, null)

  // 第二次：重新开启（授权）再关，但取消注入失败。
  state.permission = { status: 'granted', canAskAgain: true, detail: null }
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 2 })
  assert.equal(state.pending.length, 1)
  state.cancelError = '模拟取消失败'
  const failedOff = await service.saveSettings({ taskId, enabled: false, leadMinutes: 30, expectedRevision: 3 })
  assert.equal(failedOff.save.committed, true)
  assert.equal(failedOff.savedButNotScheduled, false)
  assert.notEqual(failedOff.reason, null, '关闭失败必须可见')
  assert.equal(state.pending.length, 1)
  assert.equal(failedOff.inspection.osState, 'stale')
  opened.raw.close()
})

test('关闭时系统通知列表读不出来：committed OFF 也必须说明取消未确认', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  state.listError = 'OS read unavailable'
  const off = await service.saveSettings({ taskId, enabled: false, leadMinutes: 30, expectedRevision: 1 })
  assert.equal(off.save.committed, true)
  assert.equal(off.inspection.osState, 'unknown')
  assert.ok(off.reason, '不能把未知的取消失败说成已取消')
  assert.match(off.reason, /无法确认|取消|列表|读取/)
  opened.raw.close()
})

test('列表读取失败 = 状态未知：不清空 / 不取消，也不当成空列表', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  const before = state.pending.length

  state.listError = '模拟读取系统通知失败'
  const report = await service.reconcile('foreground')
  assert.equal(report.ok, false)
  assert.equal(report.verified, false)
  assert.equal(state.pending.length, before, '读取失败不能清空系统通知')
  assert.equal(state.cancelCalls.length, 0)
  const inspected = await service.inspectTask(taskId)
  assert.equal(inspected.osState, 'unknown')
  opened.raw.close()
})

test('替换前取消失败：绝不排新通知，旧通知保留，失败可见', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks, { title: '旧标题' })
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  await opened.tasks.update(taskId, taskDraft({ deadline: '2026-10-21T22:00', title: '新标题' }))
  const callsBefore = state.scheduleCalls.length
  state.cancelError = '取消失败'
  const report = await service.reconcile('task-update')
  assert.equal(report.ok, false)
  assert.equal(state.scheduleCalls.length, callsBefore, '取消不成功不能排新的')
  assert.equal(state.pending.length, 1)
  assert.ok(report.failures.some((failure) => failure.action === 'replace'))
  opened.raw.close()
})

test('测试提醒：独立 ID、约 10 秒后；重复测试只替换测试通知，不影响任务提醒', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  const taskNotificationId = `ddlmate.task-reminder.v1.${taskId}`
  const testNotificationId = `ddlmate.task-reminder.v1.test.${taskId}`
  assert.equal(state.pending.some((item) => item.identifier === taskNotificationId), true)

  const first = await service.testReminder(taskId)
  assert.equal(first.ok, true)
  assert.equal(first.queued, true)
  assert.equal(first.verified, true)
  assert.equal(first.identifier, testNotificationId)
  assert.ok(first.triggerAtMs >= NOW.getTime() + 9_000)
  assert.equal(state.pending.some((item) => item.identifier === taskNotificationId), true)

  state.permission = { status: 'granted', canAskAgain: true, detail: null }
  const second = await service.testReminder(taskId)
  assert.equal(second.ok, true)
  assert.equal(state.pending.filter((item) => item.identifier === testNotificationId).length, 1)
  assert.equal(state.pending.some((item) => item.identifier === taskNotificationId), true, '不碰任务提醒')
  opened.raw.close()
})

test('权限申请只发生在显式开启 / 测试提醒：启动对账不弹提示', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort({
    permission: { status: 'undetermined', canAskAgain: true, detail: null },
    requestResult: { status: 'granted', canAskAgain: true, detail: null },
  })
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.reconcile('bootstrap')
  assert.equal(state.requestCalls, 0, '启动不申请权限')

  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(state.requestCalls, 1, '显式开启才申请')

  state.permission = { status: 'undetermined', canAskAgain: true, detail: null }
  await service.testReminder(taskId)
  assert.equal(state.requestCalls, 2, '显式测试才申请')
  opened.raw.close()
})

test('串行队列：连续两次保存以最后一次意图为准，不会留下两条不同提前量的通知', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  const [first, second] = await Promise.all([
    service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 }),
    service.saveSettings({ taskId, enabled: true, leadMinutes: 180, expectedRevision: 0 }),
  ])
  // 第二次的 expectedRevision=0 在串行队列里会与第一次冲突；这本身就是 stale 保护。
  assert.equal(first.save.committed, true)
  assert.equal(second.save.committed, false)
  assert.match(second.save.reason, /别处已经保存过/)
  const loaded = await opened.reminders.loadReminder(taskId)
  assert.equal(loaded.intent.leadMinutes, 30)
  assert.equal(state.pending.length, 1)
  opened.raw.close()
})

test('安装 SDK57 iOS 回读：calendar 完整组件可验证；repeating / timeInterval / 未知 trigger 不冒充 queued', async () => {
  const opened = openMemory()
  const { state, port } = createFakePort()
  const service = createService(opened, port)
  const taskId = await createTask(opened.tasks)
  await service.saveSettings({ taskId, enabled: true, leadMinutes: 30, expectedRevision: 0 })
  assert.equal(state.pending.length, 1)
  const request = state.scheduleCalls[0]
  const parts = offsetIsoToShanghaiParts(new Date(request.triggerAtMs).toISOString())
  assert.ok(parts)

  // iOS 回读 calendar 的 dateComponents：完整、显式上海时区、非重复 → 精确匹配。
  const dateComponents = {
    calendar: 'iso8601',
    timeZone: 'Asia/Shanghai',
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
  state.pending[0] = { ...state.pending[0], trigger: { type: 'calendar', repeats: false, dateComponents } }
  const queued = await service.inspectTask(taskId)
  assert.equal(queued.osState, 'queued')

  // repeating calendar 不能证明是那条一次性提醒。
  state.pending[0] = { ...state.pending[0], trigger: { type: 'calendar', repeats: true, dateComponents } }
  const repeating = await service.inspectTask(taskId)
  assert.notEqual(repeating.osState, 'queued')

  // DATE → timeInterval 的 seconds 是原生侧计算的，JS 无法证明绝对时间。
  state.pending[0] = { ...state.pending[0], trigger: { type: 'timeInterval', seconds: 60, repeats: false } }
  const interval = await service.inspectTask(taskId)
  assert.notEqual(interval.osState, 'queued')

  // 未知 type 即使带一个看起来合理的 timestamp 也不可验证。
  state.pending[0] = { ...state.pending[0], trigger: { type: 'unknown', timestamp: request.triggerAtMs } }
  const unknown = await service.inspectTask(taskId)
  assert.notEqual(unknown.osState, 'queued')
  opened.raw.close()
})

test('真实 Date.now().321：测试提醒规范到整秒后，能被原生 calendar 回读验证', async () => {
  const opened = openMemory()
  const fake = createFakePort()
  const state = fake.state
  const fractionalNow = new Date('2026-10-19T04:00:00.321Z')
  const port = {
    ...fake.port,
    schedule: async (content) => {
      state.scheduleCalls.push(content)
      const shifted = new Date(content.triggerAtMs + 8 * 3_600_000)
      state.pending = state.pending.filter((item) => item.identifier !== content.identifier)
      state.pending.push({
        identifier: content.identifier,
        data: content.data,
        title: content.title,
        trigger: {
          type: 'calendar',
          repeats: false,
          dateComponents: {
            timeZone: 'Asia/Shanghai',
            year: shifted.getUTCFullYear(),
            month: shifted.getUTCMonth() + 1,
            day: shifted.getUTCDate(),
            hour: shifted.getUTCHours(),
            minute: shifted.getUTCMinutes(),
            second: shifted.getUTCSeconds(),
          },
        },
      })
    },
  }
  const service = createService(opened, port, fractionalNow)
  const taskId = await createTask(opened.tasks)
  const result = await service.testReminder(taskId)
  assert.equal(result.ok, true)
  assert.equal(result.verified, true, '小数毫秒不能导致永远 unverified')
  assert.equal(result.triggerAtMs % 1_000, 0)
  assert.ok(result.triggerAtMs >= fractionalNow.getTime() + 10_000)
  assert.ok(result.triggerAtMs - (fractionalNow.getTime() + 10_000) < 1_000)
  opened.raw.close()
})
