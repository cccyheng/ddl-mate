/**
 * 任务提醒点击 → 任务详情：控制器 / 回执 / 解析测试。
 *
 * 不启动 React Native；通知 API、store 重查、回执端口全部用假实现或真实临时 SQLite。
 * 重点覆盖 supervisor 指出的失败场景：持久重启、A→B→A、同 ID 新投递、延迟冷启动、
 * 卸载竞态、重复 start、缺失 vs 读取失败、编辑暂缓、安全返回任务列表。
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
  buildReminderNotificationPayload,
  buildTestReminderNotificationPayload,
  reminderNotificationId,
  testReminderNotificationId,
} from '../src/domain/taskReminder.ts'
import { TaskReminderNotificationReceiptsRepository } from '../src/domain/taskReminderNotificationReceiptsRepository.ts'
import {
  createTaskReminderNotificationRouter,
  currentRouteNameFromState,
  isTaskReminderEditingRoute,
  parseTaskReminderNotificationTap,
  taskStackCurrentRouteName,
  taskStackHasEditingRoute,
} from '../src/navigation/taskReminderNotificationRouter.ts'

const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'
const TRIGGER_AT = Date.parse('2026-10-20T21:30:00+08:00')
const TASK = { id: 7, title: '数据结构作业', deadline: '2026-10-20T22:00:00+08:00', status: 'TODO' }
const MAIN_PAYLOAD = buildReminderNotificationPayload(TASK, 30, TRIGGER_AT)
const TEST_PAYLOAD = buildTestReminderNotificationPayload(7, TRIGGER_AT)

function responseFor(payload, options = {}) {
  const taskId = payload.taskId
  const identifier =
    options.identifier ??
    (payload.kind === 'ddlmate.task-reminder-test.v1'
      ? testReminderNotificationId(taskId)
      : reminderNotificationId(taskId))
  return {
    actionIdentifier: options.action ?? DEFAULT_ACTION,
    notification: {
      date: options.date ?? 1_800_000_000_000,
      request: { identifier, content: { data: payload } },
    },
  }
}

function fakeNotifications(initialLast = null) {
  let listener = null
  let last = initialLast
  let addCount = 0
  let removeCount = 0
  const api = {
    DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
    getLastNotificationResponse: () => last,
    addNotificationResponseReceivedListener: (callback) => {
      addCount += 1
      listener = callback
      return {
        remove: () => {
          removeCount += 1
          if (listener === callback) listener = null
        },
      }
    },
  }
  return {
    api,
    emit: (response) => listener?.(response),
    setLast: (value) => {
      last = value
    },
    get addCount() {
      return addCount
    },
    get removeCount() {
      return removeCount
    },
    get listenerCount() {
      return listener ? 1 : 0
    },
  }
}

function inMemoryReceipts(initiallyConsumed = []) {
  const consumed = new Set(initiallyConsumed)
  const recorded = []
  let readFailure = null
  let writeFailure = null
  return {
    port: {
      hasConsumed: async (token) => {
        if (readFailure) return { ok: false, consumed: false, reason: readFailure }
        return { ok: true, consumed: consumed.has(token), reason: null }
      },
      recordConsumption: async (receipt) => {
        if (writeFailure) return { ok: false, stored: false, reason: writeFailure }
        recorded.push(receipt)
        consumed.add(receipt.token)
        return { ok: true, stored: true, reason: null }
      },
    },
    consumed,
    recorded,
    failRead: (reason) => {
      readFailure = reason
    },
    recoverRead: () => {
      readFailure = null
    },
    failWrite: (reason) => {
      writeFailure = reason
    },
    recoverWrite: () => {
      writeFailure = null
    },
  }
}

function makeHarness(overrides = {}) {
  const fake = overrides.fake ?? fakeNotifications()
  const memory = overrides.receipts ?? inMemoryReceipts()
  const tasks = new Map(
    overrides.tasks === undefined
      ? [[7, { id: 7, title: TASK.title }]]
      : overrides.tasks.map((task) => [task.id, task]),
  )
  const navigations = []
  let taskListNavigations = 0
  const diagnostics = []
  let editing = overrides.editing ?? false
  let ready = overrides.ready ?? false
  let lookupFailure = overrides.lookupFailure ?? null
  const lookupCalls = []

  const router = createTaskReminderNotificationRouter({
    loadNotifications: overrides.loadNotifications ?? (async () => fake.api),
    lookupTaskFresh: async (taskId) => {
      lookupCalls.push(taskId)
      if (overrides.lookupTaskFresh) return overrides.lookupTaskFresh(taskId)
      if (lookupFailure) return { ok: false, task: null, reason: lookupFailure }
      return { ok: true, task: tasks.get(taskId) ?? null, reason: null }
    },
    receipts: memory.port,
    navigateToTask:
      overrides.navigateToTask ??
      ((taskId) => {
        navigations.push(taskId)
      }),
    navigateToTaskList: () => {
      taskListNavigations += 1
    },
    isEditing: () => editing,
    isNavigationReady: () => ready,
    now: overrides.now ?? (() => 1_800_000_000_000),
    ephemeralDedupeMs: overrides.ephemeralDedupeMs,
    onDiagnostic: (message) => diagnostics.push(message),
  })

  return {
    router,
    fake,
    memory,
    tasks,
    navigations,
    diagnostics,
    lookupCalls,
    get taskListNavigations() {
      return taskListNavigations
    },
    get editing() {
      return editing
    },
    setEditing(value) {
      editing = value
      router.setEditing(value)
    },
    get ready() {
      return ready
    },
    markReady() {
      ready = true
      router.markNavigationReady()
    },
    failLookup(reason) {
      lookupFailure = reason
    },
    recoverLookup() {
      lookupFailure = null
    },
  }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/* ------------------------------- 解析 ------------------------------- */

test('解析只接受本应用严格命名空间 + 默认点击动作；正式 / 测试提醒都可解析', () => {
  const main = parseTaskReminderNotificationTap(responseFor(MAIN_PAYLOAD), DEFAULT_ACTION)
  assert.equal(main?.taskId, 7)
  assert.equal(main?.test, false)
  assert.equal(main?.title, TASK.title)
  assert.match(main?.token ?? '', /ddlmate\.task-reminder\.v1\.7/)

  const testTap = parseTaskReminderNotificationTap(responseFor(TEST_PAYLOAD), DEFAULT_ACTION)
  assert.equal(testTap?.taskId, 7)
  assert.equal(testTap?.test, true)
  assert.equal(testTap?.identifier, 'ddlmate.task-reminder.v1.test.7')

  for (const bad of [
    null,
    [],
    'notification',
    {},
    { ...responseFor(MAIN_PAYLOAD), actionIdentifier: 'custom.action' },
    { ...responseFor(MAIN_PAYLOAD), notification: null },
    responseFor(MAIN_PAYLOAD, { identifier: 'com.other.app.task-reminder.v1.7' }),
    responseFor(MAIN_PAYLOAD, { identifier: 'ddlmate.task-reminder.v1.007' }),
    responseFor(MAIN_PAYLOAD, { identifier: 'ddlmate.task-reminder.v1.-7' }),
    responseFor(MAIN_PAYLOAD, { identifier: 'ddlmate.task-reminder.v1.8' }),
    responseFor({ ...MAIN_PAYLOAD, version: 2 }),
    responseFor({ ...MAIN_PAYLOAD, title: '' }),
    responseFor({ ...MAIN_PAYLOAD, fingerprint: '' }),
    responseFor({ ...MAIN_PAYLOAD, taskId: 0 }),
  ]) {
    assert.equal(parseTaskReminderNotificationTap(bad, DEFAULT_ACTION), null)
  }
})

test('同稳定 ID + 同展示时间，不同测试 trigger / 正式指纹得到不同 token；缺时间 token 仍稳定', () => {
  const a = parseTaskReminderNotificationTap(responseFor(TEST_PAYLOAD, { date: 111 }), DEFAULT_ACTION)
  const b = parseTaskReminderNotificationTap(
    responseFor({ ...TEST_PAYLOAD, triggerAtMs: TRIGGER_AT + 10_000 }, { date: 111 }),
    DEFAULT_ACTION,
  )
  assert.notEqual(a?.token, b?.token)
  assert.notEqual(a?.durableToken, b?.durableToken)

  const fingerprintChanged = parseTaskReminderNotificationTap(
    responseFor({ ...MAIN_PAYLOAD, fingerprint: 'v1-other' }, { date: 111 }),
    DEFAULT_ACTION,
  )
  const original = parseTaskReminderNotificationTap(responseFor(MAIN_PAYLOAD, { date: 111 }), DEFAULT_ACTION)
  assert.notEqual(original?.token, fingerprintChanged?.token)

  const noDate = responseFor(MAIN_PAYLOAD)
  delete noDate.notification.date
  const missing = parseTaskReminderNotificationTap(noDate, DEFAULT_ACTION)
  assert.equal(missing?.durableToken, null)
  assert.equal(missing?.token, missing?.memoryToken)
})

test('根状态 / Tasks 隐藏栈的路由识别（编辑页保守暂缓）', () => {
  const root = {
    index: 2,
    routes: [
      { name: 'Today', state: { index: 0, routes: [{ name: 'Today' }] } },
      {
        name: 'Tasks',
        state: { index: 1, routes: [{ name: 'TaskList' }, { name: 'TaskForm' }] },
      },
      { name: 'Calendar', state: { index: 0, routes: [{ name: 'CalendarMonth' }] } },
    ],
  }
  assert.equal(taskStackCurrentRouteName(root), 'TaskForm')
  assert.equal(currentRouteNameFromState(root), 'CalendarMonth')
  assert.equal(taskStackHasEditingRoute(root), true)
  assert.equal(isTaskReminderEditingRoute('TaskDetail'), true)
  assert.equal(isTaskReminderEditingRoute('TaskForm'), true)
  assert.equal(isTaskReminderEditingRoute('ExamRevision'), true)
  assert.equal(isTaskReminderEditingRoute('TaskList'), false)

  const formBuried = {
    routes: [
      {
        name: 'Tasks',
        state: {
          index: 2,
          routes: [{ name: 'TaskList' }, { name: 'TaskForm' }, { name: 'TaskPhotos' }],
        },
      },
    ],
  }
  assert.equal(taskStackCurrentRouteName(formBuried), 'TaskPhotos')
  assert.equal(taskStackHasEditingRoute(formBuried), true, '藏在栈中间的草稿页也不能被 pop')
  formBuried.routes[0].state.routes[1].name = 'ExamRevision'
  assert.equal(taskStackHasEditingRoute(formBuried), true, '复习草稿也不能被通知跳转覆盖')
})

/* --------------------------- 冷启动 / 就绪 --------------------------- */

test('冷启动：未就绪时排队、不查库 / 不写回执；onReady 后只跳一次', async () => {
  const harness = makeHarness({ fake: fakeNotifications(responseFor(MAIN_PAYLOAD)) })
  await harness.router.start()
  await settle()
  assert.deepEqual(harness.navigations, [])
  assert.deepEqual(harness.lookupCalls, [])
  assert.equal(harness.memory.recorded.length, 0)
  assert.equal(harness.router.getState().notice?.kind, 'pending')

  harness.markReady()
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.memory.recorded.length, 1)
  assert.equal(harness.router.getState().notice, null)

  harness.markReady()
  await settle()
  assert.deepEqual(harness.navigations, [7], '重复 onReady 不重复跳')
})

test('监听器 + 冷启动 last 同一个 response 只导航一次', async () => {
  const harness = makeHarness({ fake: fakeNotifications(responseFor(MAIN_PAYLOAD)), ready: true })
  harness.router.markNavigationReady()
  await harness.router.start()
  await settle()
  assert.deepEqual(harness.navigations, [7])

  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.deepEqual(harness.navigations, [7])
})

/* ------------------------------ 持久回执 ------------------------------ */

function openReceiptDatabase() {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-notification-receipts-'))
  const raw = new DatabaseSync(join(dir, 'receipts.db'))
  raw.exec(readAppSettingsSql())
  return { dir, raw, repository: new TaskReminderNotificationReceiptsRepository(wrapDatabase(raw)) }
}

test('持久回执：重开数据库后同一条展示不会再次导航', async () => {
  const opened = openReceiptDatabase()
  try {
    const firstMemory = {
      port: {
        hasConsumed: (token) => opened.repository.hasConsumed(token),
        recordConsumption: (receipt) => opened.repository.recordConsumption(receipt),
      },
    }
    const first = makeHarness({ fake: fakeNotifications(responseFor(MAIN_PAYLOAD)), receipts: firstMemory, ready: true })
    first.router.markNavigationReady()
    await first.router.start()
    await settle()
    assert.deepEqual(first.navigations, [7])

    const secondMemory = {
      port: {
        hasConsumed: (token) => opened.repository.hasConsumed(token),
        recordConsumption: (receipt) => opened.repository.recordConsumption(receipt),
      },
    }
    const second = makeHarness({ fake: fakeNotifications(responseFor(MAIN_PAYLOAD)), receipts: secondMemory, ready: true })
    second.router.markNavigationReady()
    await second.router.start()
    await settle()
    assert.deepEqual(second.navigations, [], '重启后相同 delivery 已消费')
  } finally {
    opened.raw.close()
    removeTempDir(opened.dir, 'ddl-notification-receipts-')
  }
})

test('A → B → A：回执保留多条，A 不会在 B 之后再次打开', async () => {
  const harness = makeHarness({ ready: true })
  harness.router.markNavigationReady()
  await harness.router.start()
  const a = responseFor(MAIN_PAYLOAD, { date: 1000 })
  const b = responseFor({ ...MAIN_PAYLOAD, taskId: 8 }, { date: 2000, identifier: 'ddlmate.task-reminder.v1.8' })
  harness.tasks.set(8, { id: 8, title: '另一条任务' })

  harness.fake.emit(a)
  await settle()
  harness.fake.emit(b)
  await settle()
  harness.fake.emit(a)
  await settle()
  assert.deepEqual(harness.navigations, [7, 8])
})

test('同一稳定 ID 的新日期 / 新载荷：视为新投递；同 ID 同日期才抑制', async () => {
  const harness = makeHarness({ ready: true })
  harness.router.markNavigationReady()
  await harness.router.start()

  harness.fake.emit(responseFor(MAIN_PAYLOAD, { date: 1000 }))
  await settle()
  harness.fake.emit(responseFor(MAIN_PAYLOAD, { date: 2000 }))
  await settle()
  harness.fake.emit(responseFor({ ...MAIN_PAYLOAD, fingerprint: 'v1-changed' }, { date: 2000 }))
  await settle()
  harness.fake.emit(responseFor({ ...MAIN_PAYLOAD, fingerprint: 'v1-changed' }, { date: 2000 }))
  await settle()
  assert.deepEqual(harness.navigations, [7, 7, 7])
})

test('缺展示时间不写持久回执；短时重复被去重，窗口过后新投递仍可打开', async () => {
  let now = 1_000
  const harness = makeHarness({ ready: true, now: () => now, ephemeralDedupeMs: 5_000 })
  harness.router.markNavigationReady()
  await harness.router.start()
  const raw = responseFor(MAIN_PAYLOAD)
  delete raw.notification.date

  harness.fake.emit(raw)
  await settle()
  harness.fake.emit(raw)
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.memory.recorded.length, 0, '缺时间不得写永久回执')

  now += 6_000
  harness.fake.emit(raw)
  await settle()
  assert.deepEqual(harness.navigations, [7, 7], '未来投递不会被永久吞掉')
})

/* --------------------------- 任务读取 / 重试 --------------------------- */

test('缺失任务：显式提示 + 安全返回任务列表；编辑中不允许直接返回', async () => {
  const harness = makeHarness({ ready: true, tasks: [] })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  assert.deepEqual(harness.navigations, [])
  assert.equal(harness.router.getState().notice?.kind, 'missing')
  assert.equal(harness.router.openTaskList(), true)
  assert.equal(harness.taskListNavigations, 1)

  harness.fake.emit(responseFor({ ...MAIN_PAYLOAD, taskId: 8 }, { date: 2000 }))
  await settle()
  harness.setEditing(true)
  assert.equal(harness.router.openTaskList(), false)
  assert.equal(harness.taskListNavigations, 1)
})

test('读取任务失败：不当作删除，不导航 / 不写回执；重试成功后才打开', async () => {
  const harness = makeHarness({ ready: true, lookupFailure: '数据库暂时读不出来' })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  assert.deepEqual(harness.navigations, [])
  assert.equal(harness.router.getState().notice?.kind, 'error')
  assert.equal(harness.memory.recorded.length, 0)

  harness.recoverLookup()
  await harness.router.retry()
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.memory.recorded.length, 1)
})

test('fresh 查询未完成时 onReady：只交付一次，不重复导航', async () => {
  const read = deferred()
  const harness = makeHarness({
    ready: true,
    lookupTaskFresh: () => read.promise,
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.deepEqual(harness.navigations, [])

  harness.router.markNavigationReady()
  read.resolve({ ok: true, task: { id: 7, title: TASK.title }, reason: null })
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.memory.recorded.length, 1)
})

test('dismiss 让等待数据库的旧点击失效：不导航、不写回执', async () => {
  const read = deferred()
  const harness = makeHarness({
    ready: true,
    lookupTaskFresh: () => read.promise,
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  harness.router.dismiss()
  read.resolve({ ok: true, task: { id: 7, title: TASK.title }, reason: null })
  await settle()
  assert.deepEqual(harness.navigations, [])
  assert.equal(harness.memory.recorded.length, 0)
})

test('foreign / 非默认动作不能取消正在处理的本应用点击', async () => {
  const read = deferred()
  const harness = makeHarness({
    ready: true,
    lookupTaskFresh: () => read.promise,
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  harness.fake.emit({ actionIdentifier: 'foreign' })
  harness.fake.emit(responseFor(MAIN_PAYLOAD, { action: 'custom.action' }))
  read.resolve({ ok: true, task: { id: 7, title: TASK.title }, reason: null })
  await settle()
  assert.deepEqual(harness.navigations, [7])
})

test('较新的 live 成功后，旧冷启动读取失败 / 旧 start 不能覆盖状态或导航', async () => {
  const cold = deferred()
  const fake = fakeNotifications(null)
  fake.api.getLastNotificationResponse = () => cold.promise
  const harness = makeHarness({ fake, ready: true })
  harness.tasks.set(8, { id: 8, title: '另一条任务' })
  harness.router.markNavigationReady()
  const starting = harness.router.start()
  await settle()

  fake.emit(responseFor({ ...MAIN_PAYLOAD, taskId: 8 }, { date: 2000, identifier: 'ddlmate.task-reminder.v1.8' }))
  await settle()
  assert.deepEqual(harness.navigations, [8])

  cold.reject(new Error('older cold read failed'))
  await starting
  await settle()
  assert.deepEqual(harness.navigations, [8])
  assert.equal(harness.router.getState().notice, null, '旧冷启动失败不能覆盖 live 成功')
})

test('新的 start 让旧 start 的待完成查库失效', async () => {
  const firstLookup = deferred()
  let calls = 0
  const harness = makeHarness({
    ready: true,
    lookupTaskFresh: () => {
      calls += 1
      return calls === 1 ? firstLookup.promise : Promise.resolve({ ok: true, task: { id: 7, title: TASK.title }, reason: null })
    },
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.equal(calls, 1)

  await harness.router.start()
  firstLookup.resolve({ ok: true, task: { id: 7, title: TASK.title }, reason: null })
  await settle()
  assert.deepEqual(harness.navigations, [], '旧代查库完成后不能导航')
})

test('回执读取失败：显示可重试错误且不导航；恢复后重试成功', async () => {
  const harness = makeHarness({ ready: true })
  harness.memory.failRead('回执库读不出来')
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  assert.deepEqual(harness.navigations, [])
  assert.equal(harness.router.getState().notice?.kind, 'error')
  harness.memory.recoverRead()
  await harness.router.retry()
  await settle()
  assert.deepEqual(harness.navigations, [7])
})

test('导航失败不写回执；错误提示重试成功后才写', async () => {
  let attempts = 0
  const harness = makeHarness({
    ready: true,
    navigateToTask: (taskId) => {
      attempts += 1
      if (attempts === 1) throw new Error('navigation not ready')
      harness.navigations.push(taskId)
    },
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.equal(harness.router.getState().notice?.kind, 'error')
  assert.equal(harness.memory.recorded.length, 0, '没有成功导航就不能写已消费')

  await harness.router.retry()
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.memory.recorded.length, 1)
})

test('回执写入失败：导航已接受，但显式警告“重启后可能再次提示”', async () => {
  const harness = makeHarness({ ready: true })
  harness.memory.failWrite('磁盘满了')
  harness.router.markNavigationReady()
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.deepEqual(harness.navigations, [7])
  assert.equal(harness.router.getState().notice?.kind, 'warning')
})

/* --------------------------- 编辑 / 隐藏栈 --------------------------- */

test('编辑中收到点击：只显示非破坏性待打开提示；安全离开后才导航', async () => {
  const harness = makeHarness({ ready: true, editing: true })
  harness.router.markNavigationReady()
  await harness.router.start()
  await harness.router.setEditing(true)
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()

  const notice = harness.router.getState().notice
  assert.equal(notice?.kind, 'pending')
  assert.equal(notice?.blockedByEditing, true)
  assert.deepEqual(harness.navigations, [])
  assert.deepEqual(harness.lookupCalls, [])

  harness.setEditing(false)
  await settle()
  assert.deepEqual(harness.navigations, [7])
})

test('导航未就绪 + 编辑中：先等编辑离开，再等 onReady，不抢跑', async () => {
  const harness = makeHarness({ editing: true })
  await harness.router.start()
  harness.fake.emit(responseFor(MAIN_PAYLOAD))
  await settle()
  assert.deepEqual(harness.navigations, [])

  harness.setEditing(false)
  await settle()
  assert.deepEqual(harness.navigations, [], '导航仍未 ready')

  harness.markReady()
  await settle()
  assert.deepEqual(harness.navigations, [7])
})

/* ------------------------------ 生命周期 ------------------------------ */

test('卸载时丢弃尚未完成的冷启动读取 / 动态 import，不再导航', async () => {
  const pendingLoad = deferred()
  const harness = makeHarness({ loadNotifications: () => pendingLoad.promise })
  const ready = harness.markReady.bind(harness)
  ready()
  const start = harness.router.start()
  harness.router.dispose()
  pendingLoad.resolve(harness.fake.api)
  await start
  await settle()
  assert.deepEqual(harness.navigations, [])
  assert.equal(harness.fake.listenerCount, 0)
})

test('重复 start 只保留一个监听；旧异步结果不能提交', async () => {
  const harness = makeHarness({ ready: true, fake: fakeNotifications(responseFor(MAIN_PAYLOAD)) })
  harness.router.markNavigationReady()
  await harness.router.start()
  await harness.router.start()
  await settle()
  assert.equal(harness.fake.listenerCount, 1)
  assert.deepEqual(harness.navigations, [7], '同一冷启动 response 不重复')
})

test('并发 start（StrictMode 双 setup）：只保留最后一代监听，旧代不提交', async () => {
  const firstLoad = deferred()
  const secondLoad = deferred()
  const loads = [firstLoad, secondLoad]
  let call = 0
  const fake = fakeNotifications(responseFor(MAIN_PAYLOAD))
  const harness = makeHarness({
    fake,
    ready: true,
    loadNotifications: () => loads[call++].promise,
  })
  harness.router.markNavigationReady()
  const first = harness.router.start()
  const second = harness.router.start()

  secondLoad.resolve(fake.api)
  await second
  await settle()
  assert.equal(fake.listenerCount, 1)
  assert.deepEqual(harness.navigations, [7])

  firstLoad.resolve(fake.api)
  await first
  await settle()
  assert.equal(fake.listenerCount, 1, '旧代不得再注册监听')
  assert.deepEqual(harness.navigations, [7])
})

test('较新的 live 点击先到，延迟的旧冷启动结果被忽略', async () => {
  const cold = deferred()
  const fake = fakeNotifications(null)
  fake.api.getLastNotificationResponse = () => cold.promise
  const harness = makeHarness({ fake, ready: true })
  harness.router.markNavigationReady()
  const start = harness.router.start()
  await settle()
  assert.equal(fake.listenerCount, 1)
  harness.tasks.set(8, { id: 8, title: '另一条任务' })

  fake.emit(responseFor({ ...MAIN_PAYLOAD, taskId: 8 }, { date: 2000, identifier: 'ddlmate.task-reminder.v1.8' }))
  await settle()
  assert.deepEqual(harness.navigations, [8])

  cold.resolve(responseFor(MAIN_PAYLOAD, { date: 1000 }))
  await start
  await settle()
  assert.deepEqual(harness.navigations, [8], '旧冷启动不能覆盖更新的 live 点击')
})

test('原生模块加载失败：显示可重试错误；retry 重新加载后可处理冷启动', async () => {
  const fake = fakeNotifications(responseFor(MAIN_PAYLOAD))
  let fail = true
  const harness = makeHarness({
    fake,
    ready: true,
    loadNotifications: async () => {
      if (fail) throw new Error('native missing')
      return fake.api
    },
  })
  harness.router.markNavigationReady()
  await harness.router.start()
  await settle()
  assert.equal(harness.router.getState().notice?.kind, 'error')

  fail = false
  await harness.router.retry()
  await settle()
  assert.deepEqual(harness.navigations, [7])
})
