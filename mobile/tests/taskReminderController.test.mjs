/**
 * 任务提醒设置页控制器 —— 纯状态机测试。
 *
 * 覆盖：初始读取、脏草稿不被后台刷新覆盖、外部修订号变化要求刷新、
 * 同步 busy 闸门（双击只发一次）、保存成功 / 冲突 / 原生失败的不同文案、
 * 关闭取消失败的可见警告、测试提醒、dispose 后晚到的结果不再改状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateTaskReminderEligibility } from '../src/domain/taskReminder.ts'
import { createTaskReminderController } from '../src/screens/taskReminderController.ts'

const NOW_MS = Date.parse('2026-10-20T04:00:00.000Z')
const TASK = { id: 7, title: '数据结构作业', deadline: '2026-10-20T22:00:00+08:00', status: 'TODO' }
const PERMISSION = { status: 'granted', canAskAgain: true, detail: null }
const ELIGIBLE = evaluateTaskReminderEligibility(TASK, 30, NOW_MS)

function inspection(overrides = {}) {
  const intent =
    overrides.intent === undefined
      ? {
          version: 1,
          taskId: 7,
          enabled: false,
          leadMinutes: 30,
          revision: 0,
          updatedAt: '2026-10-20T04:00:00.000Z',
        }
      : overrides.intent
  const revision = overrides.revision ?? intent?.revision ?? 0
  return {
    taskId: 7,
    task: TASK,
    intentState: intent ? 'valid' : 'missing',
    intent,
    revision,
    readReason: null,
    permission: PERMISSION,
    eligibility: ELIGIBLE,
    osState: 'off',
    pending: null,
    pendingReason: null,
    lastError: null,
    atMs: NOW_MS,
    ...overrides,
  }
}

const saved = (intent, overrides = {}) => ({
  ok: true,
  committed: true,
  revision: intent.revision,
  intent,
  reason: null,
  readbackError: null,
  ...overrides,
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createHarness(initial = inspection()) {
  const calls = { inspect: 0, save: 0, test: 0, retry: 0 }
  let view = initial
  let saveImpl = async (input) => ({
    save: saved({
      version: 1,
      taskId: 7,
      enabled: input.enabled,
      leadMinutes: input.leadMinutes,
      revision: 1,
      updatedAt: '2026-10-20T04:00:00.000Z',
    }),
    permission: PERMISSION,
    report: null,
    inspection: inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: input.enabled,
        leadMinutes: input.leadMinutes,
        revision: 1,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 1,
      osState: input.enabled ? 'queued' : 'off',
    }),
    savedButNotScheduled: false,
    reason: null,
  })
  const deps = {
    inspect: async () => {
      calls.inspect += 1
      return view
    },
    save: async (input) => {
      calls.save += 1
      return saveImpl(input)
    },
    test: async () => {
      calls.test += 1
      return {
        ok: true,
        queued: true,
        verified: true,
        identifier: 'ddlmate.task-reminder.v1.test.7',
        triggerAtMs: NOW_MS + 10_000,
        permission: PERMISSION,
        reason: '测试提醒已经交给系统，约 10 秒后检查手机；这不代表已经确认送达。',
      }
    },
    retry: async () => {
      calls.retry += 1
      return { inspection: { ...view, osState: 'queued' }, reason: null }
    },
  }
  return {
    calls,
    deps,
    controller: createTaskReminderController(7, deps),
    setView(next) {
      view = next
    },
    setSave(fn) {
      saveImpl = fn
    },
  }
}

test('初始读取：默认关闭，草稿与基线一致', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  const state = controller.getState()
  assert.equal(state.phase, 'ready')
  assert.equal(state.baselineEnabled, false)
  assert.equal(state.draftEnabled, false)
  assert.equal(state.dirty, false)
  assert.equal(state.canEnable, true, '关闭状态下当前提前量本身是可安排的，只是用户没开启')
  controller.dispose()
})

test('开启后草稿变脏；保存一次后基线更新，系统状态为已排队', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  assert.equal(controller.getState().dirty, true)
  assert.equal(controller.getState().canEnable, true)
  await controller.save()
  const state = controller.getState()
  assert.equal(state.baselineEnabled, true)
  assert.equal(state.baselineLead, 30)
  assert.equal(state.dirty, false)
  assert.equal(state.inspection.osState, 'queued')
  assert.equal(state.notice.tone, 'success')
  controller.dispose()
})

test('双击保存：同步 busy 闸门只发一次请求', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  const gate = deferred()
  harness.setSave(async (input) => {
    await gate.promise
    return {
      save: saved({
        version: 1,
        taskId: 7,
        enabled: input.enabled,
        leadMinutes: input.leadMinutes,
        revision: 1,
        updatedAt: '2026-10-20T04:00:00.000Z',
      }),
      permission: PERMISSION,
      report: null,
      inspection: inspection({ osState: 'queued' }),
      savedButNotScheduled: false,
      reason: null,
    }
  })
  const first = controller.save()
  const second = controller.save()
  await Promise.resolve()
  assert.equal(harness.calls.save, 1)
  assert.equal(controller.getState().busy, true)
  gate.resolve()
  await Promise.all([first, second])
  assert.equal(harness.calls.save, 1)
  controller.dispose()
})

test('后台刷新不覆盖脏草稿；外部修订号变化时提示先刷新', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  controller.setLead(180)
  assert.equal(controller.getState().dirty, true)

  harness.setView(
    inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: true,
        leadMinutes: 1440,
        revision: 4,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 4,
      osState: 'queued',
    }),
  )
  await controller.load('refresh')
  const state = controller.getState()
  assert.equal(state.draftLead, 180, '草稿没有被覆盖')
  assert.equal(state.draftEnabled, true)
  assert.equal(state.baselineLead, 1440)
  assert.equal(state.needsReload, true)
  assert.equal(state.notice.tone, 'warning')

  await controller.save()
  assert.equal(harness.calls.save, 0, '要求先刷新，不能拿旧修订号覆盖')
  controller.dispose()
})

test('保存冲突：保留草稿，提示错误，不改写为成功', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  harness.setSave(async () => ({
    save: {
      ok: false,
      committed: false,
      revision: 3,
      intent: null,
      reason: '别处已经保存过这条任务的提醒设置，请先刷新看看最新版本。',
      readbackError: null,
    },
    permission: PERMISSION,
    report: null,
    inspection: inspection(),
    savedButNotScheduled: false,
    reason: '别处已经保存过这条任务的提醒设置，请先刷新看看最新版本。',
  }))
  await controller.save()
  const state = controller.getState()
  assert.equal(state.draftEnabled, true)
  assert.equal(state.notice.tone, 'error')
  assert.match(state.notice.text, /别处已经保存过/)
  assert.equal(state.needsReload, true)
  controller.dispose()
})

test('规则已保存但原生未排好：显示“设置已保存，提醒尚未安排”，可重试', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  harness.setSave(async (input) => ({
    save: saved({
      version: 1,
      taskId: 7,
      enabled: true,
      leadMinutes: input.leadMinutes,
      revision: 1,
      updatedAt: '2026-10-20T04:00:00.000Z',
    }),
    permission: { status: 'denied', canAskAgain: false, detail: null },
    report: null,
    inspection: inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: true,
        leadMinutes: 30,
        revision: 1,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 1,
      osState: 'not-queued',
      permission: { status: 'denied', canAskAgain: false, detail: null },
    }),
    savedButNotScheduled: true,
    reason: '设置已保存，但通知权限未允许，提醒还没有安排。',
  }))
  await controller.save()
  const state = controller.getState()
  assert.equal(state.notice.tone, 'warning')
  assert.match(state.notice.text, /设置已保存，提醒尚未安排/)
  assert.equal(state.baselineEnabled, true)
  assert.equal(state.inspection.osState, 'not-queued')

  await controller.retry()
  assert.equal(harness.calls.retry, 1)
  assert.equal(controller.getState().inspection.osState, 'queued')
  controller.dispose()
})

test('关闭时取消失败：仍然显示为已关闭草稿，但警告系统里的通知未确认取消', async () => {
  const harness = createHarness(
    inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: true,
        leadMinutes: 30,
        revision: 1,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 1,
      osState: 'queued',
    }),
  )
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(false)
  harness.setSave(async () => ({
    save: saved({
      version: 1,
      taskId: 7,
      enabled: false,
      leadMinutes: 30,
      revision: 2,
      updatedAt: '2026-10-20T04:00:00.000Z',
    }),
    permission: PERMISSION,
    report: null,
    inspection: inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: false,
        leadMinutes: 30,
        revision: 2,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 2,
      osState: 'stale',
      pendingReason: '系统里还排着一条已经关闭的提醒，重试对账可以取消它。',
    }),
    savedButNotScheduled: false,
    reason: '系统里还排着一条已经关闭的提醒，重试对账可以取消它。',
  }))
  await controller.save()
  const state = controller.getState()
  assert.equal(state.baselineEnabled, false)
  assert.equal(state.notice.tone, 'warning')
  assert.match(state.notice.text, /没有确认取消|重试/)
  controller.dispose()
})

test('测试提醒：只在用户动作时调用，并显示“已安排但不等同送达”', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  await controller.test()
  assert.equal(harness.calls.test, 1)
  const state = controller.getState()
  assert.equal(state.testStatus.tone, 'success')
  assert.match(state.testStatus.text, /10 秒/)
  assert.match(state.testStatus.text, /不代表已经确认送达/)
  controller.dispose()
})

test('dispose 之后晚到的保存结果不再改状态；订阅清理后不再通知', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  let notifications = 0
  const unsubscribe = controller.subscribe(() => {
    notifications += 1
  })
  controller.setEnabled(true)
  const gate = deferred()
  harness.setSave(async () => {
    await gate.promise
    return {
      save: saved({
        version: 1,
        taskId: 7,
        enabled: true,
        leadMinutes: 30,
        revision: 1,
        updatedAt: '2026-10-20T04:00:00.000Z',
      }),
      permission: PERMISSION,
      report: null,
      inspection: inspection({ osState: 'queued' }),
      savedButNotScheduled: false,
      reason: null,
    }
  })
  const pendingSave = controller.save()
  controller.dispose()
  gate.resolve()
  await pendingSave
  assert.equal(controller.getState().disposed, true)
  assert.equal(controller.getState().baselineEnabled, false, '晚到结果没有写进已释放的控制器')
  unsubscribe()
  const before = notifications
  controller.setEnabled(true)
  assert.equal(notifications, before)
})

test('setup → cleanup → setup：activate 恢复控制器，不重放保存 / 权限 / 测试', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.dispose()
  assert.equal(controller.getState().disposed, true)
  controller.activate()
  assert.equal(controller.getState().disposed, false)
  await controller.load('refresh')
  const state = controller.getState()
  assert.equal(state.phase, 'ready')
  assert.equal(harness.calls.save, 0, 'activate 不重放保存')
  assert.equal(harness.calls.test, 0, 'activate 不重放测试提醒 / 权限')
  controller.setEnabled(true)
  await controller.save()
  assert.equal(harness.calls.save, 1, '恢复后仍可正常保存')
  controller.dispose()
})

test('显式载入最新：冲突后普通刷新不丢草稿，reloadLatest 才丢弃并采用最新修订', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  harness.setView(
    inspection({
      intent: {
        version: 1,
        taskId: 7,
        enabled: true,
        leadMinutes: 180,
        revision: 2,
        updatedAt: '2026-10-20T04:00:00.000Z',
      },
      revision: 2,
      osState: 'queued',
    }),
  )
  await controller.load('refresh')
  assert.equal(controller.getState().needsReload, true)
  assert.equal(controller.getState().draftEnabled, true)
  assert.equal(controller.getState().baselineLead, 180)
  // 普通编辑不得把冲突标记偷偷清掉。
  controller.setLead(30)
  assert.equal(controller.getState().needsReload, true)
  await controller.save()
  assert.equal(harness.calls.save, 0, '冲突标记不清就不能保存')
  assert.match(controller.getState().notice.text, /先刷新/)

  await controller.reloadLatest()
  const reloaded = controller.getState()
  assert.equal(reloaded.needsReload, false)
  assert.equal(reloaded.dirty, false)
  assert.equal(reloaded.draftLead, 180)
  assert.equal(reloaded.baselineRevision, 2)

  let savedInput = null
  harness.setSave(async (input) => {
    savedInput = input
    return {
      save: saved({
        version: 1,
        taskId: 7,
        enabled: input.enabled,
        leadMinutes: input.leadMinutes,
        revision: 3,
        updatedAt: '2026-10-20T04:00:00.000Z',
      }),
      permission: PERMISSION,
      report: null,
      inspection: inspection({
        intent: {
          version: 1,
          taskId: 7,
          enabled: input.enabled,
          leadMinutes: input.leadMinutes,
          revision: 3,
          updatedAt: '2026-10-20T04:00:00.000Z',
        },
        revision: 3,
        osState: 'queued',
      }),
      savedButNotScheduled: false,
      reason: null,
    }
  })
  controller.setLead(30)
  await controller.save()
  assert.equal(savedInput.expectedRevision, 2, '显式载入后使用最新修订号')
  controller.dispose()
})

test('提交后读回失败：baseline 仍前进到 committed 修订，不留下旧版本 + 脏草稿', async () => {
  const harness = createHarness()
  const { controller } = harness
  await controller.load('initial')
  controller.setEnabled(true)
  harness.setSave(async (input) => ({
    save: saved({
      version: 1,
      taskId: 7,
      enabled: input.enabled,
      leadMinutes: input.leadMinutes,
      revision: 5,
      updatedAt: '2026-10-20T04:00:00.000Z',
    }),
    permission: PERMISSION,
    report: null,
    inspection: inspection({
      intent: null,
      intentState: 'corrupt',
      revision: 0,
      osState: 'unknown',
      readReason: '读取提醒设置失败',
    }),
    savedButNotScheduled: true,
    reason: '设置已保存，但读取提醒状态失败，可以重试。',
  }))
  await controller.save()
  const state = controller.getState()
  assert.equal(state.baselineEnabled, true)
  assert.equal(state.baselineRevision, 5)
  assert.equal(state.draftEnabled, true)
  assert.equal(state.dirty, false)
  assert.equal(state.needsReload, false)
  assert.equal(state.notice.tone, 'warning')
  assert.match(state.notice.text, /尚未安排/)
  controller.dispose()
})

test('OFF 取消重试：确认系统里没有提醒时显示成功；仍失败时保留警告', async () => {
  const offInspection = inspection({
    intent: {
      version: 1,
      taskId: 7,
      enabled: false,
      leadMinutes: 30,
      revision: 2,
      updatedAt: '2026-10-20T04:00:00.000Z',
    },
    revision: 2,
    osState: 'stale',
    pendingReason: '系统里还排着一条已经关闭的提醒。',
  })
  const harness = createHarness(offInspection)
  const { controller } = harness
  await controller.load('initial')

  harness.deps.retry = async () => ({ inspection: { ...offInspection, osState: 'off' }, reason: null })
  await controller.retry()
  assert.equal(controller.getState().notice.tone, 'success')
  assert.match(controller.getState().notice.text, /已关闭/)
  assert.equal(controller.getState().inspection.osState, 'off')

  harness.deps.retry = async () => ({
    inspection: { ...offInspection, osState: 'stale' },
    reason: '取消系统提醒失败：模拟失败',
  })
  await controller.retry()
  assert.equal(controller.getState().notice.tone, 'warning')
  assert.match(controller.getState().notice.text, /取消系统提醒失败/)
  controller.dispose()
})
