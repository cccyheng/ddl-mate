/**
 * 通知点击的恢复代次边界（纯 router，真实 await 交错）。
 *
 * 覆盖 review 点名：
 * - 点击已进入 lookup，恢复在 await 期间提交：旧代次不得导航；
 * - 重启后仍收到旧通知点击：不得打开恢复后复用 ID 的任务；
 * - 恢复后新排程（新代次）的任务提醒仍能正常打开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReminderNotificationPayload } from '../src/domain/taskReminder.ts'
import { createTaskReminderNotificationRouter } from '../src/navigation/taskReminderNotificationRouter.ts'

const TASK = { id: 1, title: '提醒任务', deadline: '2026-12-01T10:00:00+08:00' }
const TRIGGER = Date.parse('2026-11-30T10:00:00+08:00')
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT'

function responseFor(generation) {
  return {
    actionIdentifier: DEFAULT_ACTION,
    notification: {
      date: 1_760_000_000_000,
      request: {
        identifier: 'ddlmate.task-reminder.v1.1',
        content: { data: buildReminderNotificationPayload(TASK, 1440, TRIGGER, generation) },
      },
    },
  }
}

function makeRouter({ generation, delayedLookup = false } = {}) {
  let currentGeneration = generation
  let listener = null
  let resolveLookup = null
  const navigated = []
  const events = []
  const lookup = () =>
    delayedLookup
      ? new Promise((resolve) => {
          resolveLookup = () => resolve({ ok: true, task: { id: 1, title: '恢复后的另一条任务' }, reason: null })
        })
      : Promise.resolve({ ok: true, task: { id: 1, title: '恢复后的另一条任务' }, reason: null })
  const router = createTaskReminderNotificationRouter({
    loadNotifications: async () => ({
      DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
      getLastNotificationResponse: async () => null,
      addNotificationResponseReceivedListener: (callback) => {
        listener = callback
        return { remove: () => {} }
      },
    }),
    lookupTaskFresh: lookup,
    receipts: {
      hasConsumed: async () => ({ ok: true, consumed: false, reason: null }),
      recordConsumption: async () => ({ ok: true, stored: true, reason: null }),
    },
    navigateToTask: (taskId) => {
      navigated.push(taskId)
    },
    navigateToTaskList: () => {},
    isEditing: () => false,
    isNavigationReady: () => true,
    getNotificationGeneration: () => currentGeneration,
    now: () => 1_760_000_000_000,
    onTapEvent: (event) => events.push(event),
  })
  return {
    router,
    navigated,
    events,
    tap: (generationValue) => listener?.(responseFor(generationValue)),
    setGeneration: (value) => {
      currentGeneration = value
    },
    resolveLookup: () => resolveLookup?.(),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('lookup await 期间恢复提交：旧代次点击在导航前被拒绝', async () => {
  const harness = makeRouter({ generation: 0, delayedLookup: true })
  await harness.router.start()
  harness.router.markNavigationReady()

  harness.tap(0)
  await tick()
  assert.ok(harness.events.some((event) => event.stage === 'recognized'))
  harness.setGeneration(1)
  harness.resolveLookup()
  await tick()
  await tick()

  assert.deepEqual(harness.navigated, [], '恢复提交后不能拿旧任务 ID 导航')
  assert.equal(harness.router.getState().notice?.kind, 'warning')
  assert.ok(harness.events.some((event) => event.stage === 'stale-generation'))
})

test('重启后旧通知点击（代次 0）不打开恢复后复用 ID 的任务', async () => {
  const harness = makeRouter({ generation: 1 })
  await harness.router.start()
  harness.router.markNavigationReady()
  harness.tap(0)
  await tick()
  await tick()
  assert.deepEqual(harness.navigated, [])
  assert.equal(harness.router.getState().notice?.kind, 'warning')
})

test('恢复后新代次通知仍正常打开任务详情', async () => {
  const harness = makeRouter({ generation: 1 })
  await harness.router.start()
  harness.router.markNavigationReady()
  harness.tap(1)
  await tick()
  await tick()
  assert.deepEqual(harness.navigated, [1])
  assert.equal(harness.router.getState().notice, null)
})
