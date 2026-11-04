/**
 * 任务提醒 —— **纯规则**测试（无 SQLite / 无原生模块 / 无 React）。
 *
 * 覆盖授权书点名的：北京时间精确偏移、now/future/闰日/非法输入边界、
 * 没有 DDL / 已完成 / 已取消、默认关闭的编码、损坏 / 未来版本只读、
 * 权限 granted/denied/provisional/unavailable、稳定 ID/载荷/指纹、
 * 对账不重复、改动替换、过去不补发、关闭取消、32 条上限、外应用通知不碰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ENABLED_TASK_REMINDERS,
  REMINDER_LEAD_OPTIONS,
  TASK_REMINDER_NOTIFICATION_KIND,
  buildReminderNotificationPayload,
  canScheduleReminder,
  decodeTaskReminder,
  encodeTaskReminder,
  canonicalReminderTriggerMs,
  evaluateTaskReminderEligibility,
  formatReminderMoment,
  parseOwnedReminderNotification,
  parseReminderNotificationPayload,
  planTaskReminderReconciliation,
  reminderNotificationId,
  reminderPermissionLabel,
  taskReminderFingerprint,
  taskReminderKey,
  testReminderNotificationId,
  triggerAtMsFromNotificationTrigger,
} from '../src/domain/taskReminder.ts'

const NOW = Date.parse('2026-10-20T12:00:00+08:00')

const task = (overrides = {}) => ({
  id: 7,
  title: '数据结构作业',
  deadline: '2026-10-20T22:00:00+08:00',
  status: 'TODO',
  ...overrides,
})

const intent = (overrides = {}) => ({
  version: 1,
  taskId: 7,
  enabled: true,
  leadMinutes: 30,
  revision: 1,
  updatedAt: '2026-10-20T04:00:00.000Z',
  ...overrides,
})

const granted = { status: 'granted', canAskAgain: true, detail: null }
const denied = { status: 'denied', canAskAgain: false, detail: null }
const provisional = { status: 'provisional', canAskAgain: true, detail: null }

function owned(overrides = {}) {
  const base = {
    identifier: 'ddlmate.task-reminder.v1.7',
    taskId: 7,
    test: false,
    fingerprint: null,
    triggerAtMs: Date.parse('2026-10-20T21:30:00+08:00'),
    title: '数据结构作业',
    ...overrides,
  }
  return base
}

/* ------------------------------- 时间边界 ------------------------------- */

test('北京时间精确偏移：22:00 +08:00 提前 30 分钟 = UTC 13:30，显示为 21:30', () => {
  const eligibility = evaluateTaskReminderEligibility(task(), 30, NOW)
  assert.equal(eligibility.eligible, true)
  assert.equal(eligibility.deadlineMs, Date.parse('2026-10-20T22:00:00+08:00'))
  assert.equal(eligibility.triggerAtMs, Date.UTC(2026, 9, 20, 13, 30))
  assert.equal(formatReminderMoment(eligibility.triggerAtMs), '2026-10-20 21:30 周二')
})

test('秒精度规范：fractional ms 向上取整到下一秒，绝不提前、最多 +999ms', () => {
  assert.equal(canonicalReminderTriggerMs(1_000), 1_000)
  assert.equal(canonicalReminderTriggerMs(1_001), 2_000)
  assert.equal(canonicalReminderTriggerMs(1_999), 2_000)
  assert.equal(canonicalReminderTriggerMs(1_000.321), 2_000)
  assert.equal(canonicalReminderTriggerMs(Date.parse('2026-10-20T21:30:00.321+08:00')), Date.parse('2026-10-20T21:30:01+08:00'))
  // 不早于请求；延迟 < 1 秒。
  const raw = Date.parse('2026-10-20T21:30:58.900+08:00')
  const canonical = canonicalReminderTriggerMs(raw)
  assert.ok(canonical >= raw)
  assert.ok(canonical - raw < 1_000)
})

test('fractional 截止时间：可安排性 / 指纹 / 载荷统一使用规范秒值', () => {
  const fractionalTask = task({ deadline: '2026-10-20T22:00:00.321+08:00' })
  const now = Date.parse('2026-10-20T12:00:00.321+08:00')
  const eligibility = evaluateTaskReminderEligibility(fractionalTask, 30, now)
  assert.equal(eligibility.eligible, true)
  assert.equal(eligibility.triggerAtMs, Date.parse('2026-10-20T21:30:01+08:00'))

  const payload = buildReminderNotificationPayload(fractionalTask, 30, eligibility.triggerAtMs)
  assert.equal(payload.triggerAtMs, eligibility.triggerAtMs)
  assert.equal(
    payload.fingerprint,
    taskReminderFingerprint({
      taskId: 7,
      deadline: fractionalTask.deadline,
      leadMinutes: 30,
      title: fractionalTask.title,
      triggerAtMs: eligibility.triggerAtMs,
    }),
  )
})

test('边界：now 恰好等于触发时刻 → 过去；now 早 1ms → 可启用', () => {
  const trigger = Date.parse('2026-10-20T21:30:00+08:00')
  assert.equal(evaluateTaskReminderEligibility(task(), 30, trigger).eligible, false)
  assert.equal(evaluateTaskReminderEligibility(task(), 30, trigger).code, 'REMINDER_PAST')
  assert.equal(evaluateTaskReminderEligibility(task(), 30, trigger - 1).eligible, true)
})

test('闰日：2028-02-29 可提前 1 天；2027-02-29 是非法日期', () => {
  const leap = evaluateTaskReminderEligibility(
    task({ deadline: '2028-02-29T08:00:00+08:00' }),
    1440,
    Date.parse('2028-02-27T00:00:00+08:00'),
  )
  assert.equal(leap.eligible, true)
  assert.equal(leap.triggerAtMs, Date.parse('2028-02-28T08:00:00+08:00'))

  const invalid = evaluateTaskReminderEligibility(
    task({ deadline: '2027-02-29T08:00:00+08:00' }),
    30,
    NOW,
  )
  assert.equal(invalid.eligible, false)
  assert.equal(invalid.code, 'INVALID_DEADLINE')
})

test('没有 DDL / 已完成 / 已取消 / 任务不在本机：都不能启用，原因明确', () => {
  const noDeadline = evaluateTaskReminderEligibility(task({ deadline: null }), 30, NOW)
  assert.equal(noDeadline.code, 'NO_DEADLINE')
  assert.match(noDeadline.reason, /没有截止时间/)

  const done = evaluateTaskReminderEligibility(task({ status: 'DONE' }), 30, NOW)
  assert.equal(done.code, 'TASK_DONE')
  assert.match(done.reason, /完成/)

  const cancelled = evaluateTaskReminderEligibility(task({ status: 'CANCELLED' }), 30, NOW)
  assert.equal(cancelled.code, 'TASK_CANCELLED')
  assert.match(cancelled.reason, /取消/)

  const missing = evaluateTaskReminderEligibility(null, 30, NOW)
  assert.equal(missing.code, 'TASK_MISSING')

  const dateOnly = evaluateTaskReminderEligibility(task({ deadline: '2026-10-20' }), 30, NOW)
  assert.equal(dateOnly.eligible, false)
  assert.equal(dateOnly.code, 'DATE_ONLY_DEADLINE')
  assert.match(dateOnly.reason, /只记到日期/)
  assert.match(dateOnly.reason, /HH:mm/, '要明确告诉用户补上具体时刻就能提醒')
  assert.equal(dateOnly.triggerAtMs, null, '绝不猜一个 23:59 的提醒时刻')
})

test('提前量只接受 30 / 180 / 1440 / 4320；四个选项都有中文标签', () => {
  assert.deepEqual(
    REMINDER_LEAD_OPTIONS.map((option) => option.value),
    [30, 180, 1440, 4320],
  )
  assert.equal(evaluateTaskReminderEligibility(task(), 60, NOW).eligible, false)
  assert.equal(evaluateTaskReminderEligibility(task(), Number.NaN, NOW).eligible, false)
})

/* ------------------------------- 规则编码 ------------------------------- */

test('规则键只接受正整数任务 ID', () => {
  assert.equal(taskReminderKey(7), 'task_reminder.7')
  assert.equal(taskReminderKey(0), null)
  assert.equal(taskReminderKey(-1), null)
  assert.equal(taskReminderKey(1.5), null)
  assert.equal(taskReminderKey(Number.NaN), null)
})

test('版本化规则：编码 → 解码；损坏 / 未来版本 / 任务对不上都不覆盖', () => {
  const encoded = encodeTaskReminder(intent())
  const decoded = decodeTaskReminder(encoded, 7)
  assert.equal(decoded.ok, true)
  assert.deepEqual(decoded.intent, intent())

  assert.equal(decodeTaskReminder('{not json', 7).ok, false)
  assert.equal(decodeTaskReminder('{not json', 7).code, 'CORRUPT')
  const future = JSON.stringify({ ...intent(), version: 2 })
  const futureResult = decodeTaskReminder(future, 7)
  assert.equal(futureResult.ok, false)
  assert.equal(futureResult.code, 'FUTURE')
  const mismatch = decodeTaskReminder(encodeTaskReminder(intent({ taskId: 8 })), 7)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'CORRUPT')
  const badLead = decodeTaskReminder(JSON.stringify({ ...intent(), leadMinutes: 60 }), 7)
  assert.equal(badLead.ok, false)
})

/* -------------------------------- 权限 --------------------------------- */

test('权限：granted / provisional 可排；denied / undetermined / unavailable 都不可', () => {
  assert.equal(canScheduleReminder(granted), true)
  assert.equal(canScheduleReminder(provisional), true)
  for (const status of ['denied', 'undetermined', 'unavailable']) {
    assert.equal(canScheduleReminder({ status, canAskAgain: true, detail: null }), false)
  }
  assert.match(reminderPermissionLabel(provisional), /安静通知/)
  assert.match(reminderPermissionLabel(denied), /未允许/)
})

/* --------------------------- ID / 载荷 / 指纹 --------------------------- */

test('通知 ID 只认精确命名空间 + 正整数；测试提醒是独立命名空间', () => {
  assert.equal(reminderNotificationId(7), 'ddlmate.task-reminder.v1.7')
  assert.equal(testReminderNotificationId(7), 'ddlmate.task-reminder.v1.test.7')
  for (const value of [0, -3, 1.5, Number.NaN]) {
    assert.equal(reminderNotificationId(value), null)
    assert.equal(testReminderNotificationId(value), null)
  }
})

test('载荷严格解析；任务编号与 ID 不一致 / 外应用载荷都被拒绝', () => {
  const payload = buildReminderNotificationPayload(task(), 30, Date.parse('2026-10-20T21:30:00+08:00'))
  assert.equal(payload.kind, TASK_REMINDER_NOTIFICATION_KIND)
  assert.equal(parseReminderNotificationPayload(payload).ok, true)
  assert.equal(parseReminderNotificationPayload({ ...payload, version: 2 }).ok, false)
  assert.equal(parseReminderNotificationPayload({ ...payload, taskId: 0 }).ok, false)
  assert.equal(parseReminderNotificationPayload({ kind: 'other', version: 1 }).ok, false)

  const validInput = {
    identifier: 'ddlmate.task-reminder.v1.7',
    data: payload,
    trigger: { type: 'date', value: Date.parse('2026-10-20T21:30:00+08:00') },
  }
  assert.equal(parseOwnedReminderNotification(validInput)?.taskId, 7)
  assert.equal(
    parseOwnedReminderNotification({ ...validInput, identifier: 'ddlmate.task-reminder.v1.8' }),
    null,
  )
  assert.equal(
    parseOwnedReminderNotification({ ...validInput, identifier: 'com.other.app.task-reminder.v1.7' }),
    null,
  )
  assert.equal(
    parseOwnedReminderNotification({ ...validInput, identifier: 'ddlmate.task-reminder.v1.007' }),
    null,
  )
  assert.equal(
    parseOwnedReminderNotification({ ...validInput, identifier: 'ddlmate.task-reminder.v1.-7' }),
    null,
  )
})

test('trigger 形状兼容 number / date / value；读不出返回 null', () => {
  assert.equal(triggerAtMsFromNotificationTrigger(123), 123)
  assert.equal(triggerAtMsFromNotificationTrigger(new Date(456)), 456)
  assert.equal(triggerAtMsFromNotificationTrigger({ type: 'date', value: 789 }), 789)
  assert.equal(triggerAtMsFromNotificationTrigger({ date: '2026-10-20T13:30:00Z' }), Date.parse('2026-10-20T13:30:00Z'))
  assert.equal(triggerAtMsFromNotificationTrigger({ type: 'timeInterval', seconds: 10 }), null)
  assert.equal(triggerAtMsFromNotificationTrigger(null), null)
})

test('安装 SDK57 的 iOS 回读形状：calendar 精确；timeInterval / repeating / unknown 不可验证', () => {
  // iOS calendar 回读：必须是显式上海时区 + 完整组件才换算。
  assert.equal(
    triggerAtMsFromNotificationTrigger({
      type: 'calendar',
      repeats: false,
      dateComponents: { timeZone: 'Asia/Shanghai', year: 2026, month: 10, day: 20, hour: 21, minute: 30, second: 0 },
    }),
    Date.parse('2026-10-20T21:30:00+08:00'),
  )
  assert.equal(
    triggerAtMsFromNotificationTrigger({
      type: 'calendar',
      dateComponents: { year: 2026, month: 10, day: 20, hour: 21, minute: 30 },
    }),
    null,
    '缺时区不猜',
  )
  // date 在 iOS 内部会变成 timeInterval(seconds)，JS 侧无法证明真实绝对时间。
  assert.equal(
    triggerAtMsFromNotificationTrigger({ type: 'timeInterval', seconds: 1800, repeats: false }),
    null,
    'timeInterval + JS 排程时刻不能证明原生绝对时间',
  )
  assert.equal(triggerAtMsFromNotificationTrigger({ type: 'timeInterval', seconds: 1800, repeats: true }), null)
  assert.equal(triggerAtMsFromNotificationTrigger({ type: 'unknown', timestamp: 123 }), null)
  assert.equal(
    triggerAtMsFromNotificationTrigger({
      type: 'calendar',
      repeats: true,
      dateComponents: { timeZone: 'Asia/Shanghai', year: 2026, month: 10, day: 20, hour: 21, minute: 30 },
    }),
    null,
    '重复 calendar 不能当成一次性提醒',
  )
  assert.equal(
    triggerAtMsFromNotificationTrigger({ type: 'date', timestamp: Date.parse('2026-10-20T21:30:00+08:00'), repeats: true }),
    null,
    '重复 date 不能当成一次性提醒',
  )
})

test('排队通知的绝对时刻只信原生 trigger，不回退到载荷；unknown/repeating 不变成 queued', () => {
  const payload = buildReminderNotificationPayload(task(), 30, Date.parse('2026-10-20T21:30:00+08:00'))
  const base = { identifier: 'ddlmate.task-reminder.v1.7', data: payload, title: '数据结构作业' }
  const known = parseOwnedReminderNotification({
    ...base,
    trigger: { type: 'timeInterval', seconds: 1800, repeats: false },
  })
  assert.equal(known.triggerAtMs, null, 'timeInterval 不能靠载荷冒充绝对时间')

  const repeating = parseOwnedReminderNotification({
    ...base,
    trigger: { type: 'timeInterval', seconds: 60, repeats: true },
  })
  assert.equal(repeating.triggerAtMs, null)

  const unknown = parseOwnedReminderNotification({
    ...base,
    trigger: { type: 'unknown', timestamp: payload.triggerAtMs },
  })
  assert.equal(unknown.triggerAtMs, null)

  const calendar = parseOwnedReminderNotification({
    ...base,
    trigger: {
      type: 'calendar',
      repeats: false,
      dateComponents: {
        timeZone: 'Asia/Shanghai',
        year: 2026,
        month: 10,
        day: 20,
        hour: 21,
        minute: 30,
        second: 0,
      },
    },
  })
  assert.equal(calendar.triggerAtMs, Date.parse('2026-10-20T21:30:00+08:00'))
})

test('指纹：相同输入稳定；标题 / 截止 / 提前量 / 触发时刻任一改变都会变', () => {
  const base = { taskId: 7, deadline: '2026-10-20T22:00:00+08:00', leadMinutes: 30, title: '作业', triggerAtMs: 1000 }
  assert.equal(taskReminderFingerprint(base), taskReminderFingerprint({ ...base }))
  assert.notEqual(taskReminderFingerprint(base), taskReminderFingerprint({ ...base, title: '作业（改）' }))
  assert.notEqual(taskReminderFingerprint(base), taskReminderFingerprint({ ...base, deadline: '2026-10-21T22:00:00+08:00' }))
  assert.notEqual(taskReminderFingerprint(base), taskReminderFingerprint({ ...base, leadMinutes: 180 }))
  assert.notEqual(taskReminderFingerprint(base), taskReminderFingerprint({ ...base, triggerAtMs: 2000 }))
})

/* -------------------------------- 对账 --------------------------------- */

test('首次对账安排一条；系统里已有同指纹同触发时刻 → 刷新不再排', () => {
  const first = planTaskReminderReconciliation({
    tasks: [task()],
    entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
    pending: [],
    permission: granted,
    nowMs: NOW,
  })
  assert.equal(first.operations.length, 1)
  assert.equal(first.operations[0].kind, 'schedule')
  assert.equal(first.operations[0].request.identifier, 'ddlmate.task-reminder.v1.7')

  const payload = first.operations[0].request.data
  const second = planTaskReminderReconciliation({
    tasks: [task()],
    entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
    pending: [
      owned({
        fingerprint: payload.fingerprint,
        triggerAtMs: payload.triggerAtMs,
      }),
    ],
    permission: granted,
    nowMs: NOW,
  })
  assert.equal(second.operations.length, 0, '不重复安排')
  assert.equal(second.unchanged.length, 1)
})

test('任务标题或 DDL 变了 → 只替换同一个 ID（先取消再排）', () => {
  const pending = owned({ fingerprint: 'old-fingerprint', triggerAtMs: Date.parse('2026-10-20T21:30:00+08:00') })
  const plan = planTaskReminderReconciliation({
    tasks: [task({ title: '数据结构作业（改）' })],
    entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
    pending: [pending],
    permission: granted,
    nowMs: NOW,
  })
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].kind, 'replace')
  assert.equal(plan.operations[0].identifier, pending.identifier)
})

test('提醒时刻已过 / 已完成 / 已取消 / 没有 DDL / 改成仅日期 → 取消本应用自己那条，不补发', () => {
  const pending = owned({ fingerprint: 'whatever' })
  for (const [changedTask, code] of [
    [task({ deadline: '2026-10-19T22:00:00+08:00' }), 'REMINDER_PAST'],
    [task({ status: 'DONE' }), 'TASK_DONE'],
    [task({ status: 'CANCELLED' }), 'TASK_CANCELLED'],
    [task({ deadline: null }), 'NO_DEADLINE'],
    [task({ deadline: '2026-10-20' }), 'DATE_ONLY_DEADLINE'],
  ]) {
    const plan = planTaskReminderReconciliation({
      tasks: [changedTask],
      entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
      pending: [pending],
      permission: granted,
      nowMs: NOW,
    })
    assert.equal(plan.operations.length, 1, code)
    assert.equal(plan.operations[0].kind, 'cancel', code)
    assert.ok(plan.blocked.some((item) => item.code === code), code)
  }
})

test('关闭提醒：即使权限被拒也取消已排队的本应用通知；失败由服务层暴露', () => {
  const plan = planTaskReminderReconciliation({
    tasks: [task()],
    entries: [{ taskId: 7, state: 'valid', intent: intent({ enabled: false }), reason: null }],
    pending: [owned({ fingerprint: 'old' })],
    permission: denied,
    nowMs: NOW,
  })
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].kind, 'cancel')
})

test('权限 denied / undetermined / unavailable：不排新通知，也不谎报已安排', () => {
  for (const permission of [
    denied,
    { status: 'undetermined', canAskAgain: true, detail: null },
    { status: 'unavailable', canAskAgain: false, detail: 'x' },
  ]) {
    const plan = planTaskReminderReconciliation({
      tasks: [task()],
      entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
      pending: [],
      permission,
      nowMs: NOW,
    })
    assert.equal(plan.operations.length, 0)
    assert.ok(plan.blocked.length > 0)
  }
})

test('32 条上限：第 33 条被明确拒绝生效，而不是静默丢掉别的提醒', () => {
  const tasks = []
  const entries = []
  for (let taskId = 1; taskId <= MAX_ENABLED_TASK_REMINDERS + 1; taskId += 1) {
    tasks.push(task({ id: taskId, title: `任务 ${taskId}` }))
    entries.push({ taskId, state: 'valid', intent: intent({ taskId }), reason: null })
  }
  const plan = planTaskReminderReconciliation({ tasks, entries, pending: [], permission: granted, nowMs: NOW })
  assert.equal(plan.operations.filter((operation) => operation.kind === 'schedule').length, MAX_ENABLED_TASK_REMINDERS)
  assert.ok(plan.blocked.some((item) => item.taskId === MAX_ENABLED_TASK_REMINDERS + 1 && item.code === 'LIMIT_REACHED'))
})

test('损坏 / 未来版本规则：不动它的通知，也不覆盖记录', () => {
  for (const state of ['corrupt', 'future']) {
    const plan = planTaskReminderReconciliation({
      tasks: [task()],
      entries: [{ taskId: 7, state, intent: null, reason: '读不出来' }],
      pending: [owned({ fingerprint: 'old' })],
      permission: granted,
      nowMs: NOW,
    })
    assert.equal(plan.operations.length, 0)
    assert.ok(plan.blocked.some((item) => item.taskId === 7 && item.code === 'READ_FAILED'))
  }
})

test('任务已删除：取消遗留通知并给出可清理的孤儿任务编号', () => {
  const plan = planTaskReminderReconciliation({
    tasks: [],
    entries: [{ taskId: 7, state: 'valid', intent: intent(), reason: null }],
    pending: [owned({ fingerprint: 'old' })],
    permission: granted,
    nowMs: NOW,
  })
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].kind, 'cancel')
  assert.deepEqual(plan.orphanTaskIds, [7])
  assert.ok(plan.blocked.some((item) => item.code === 'TASK_MISSING'))
})

test('任务还在、但没有规则键的遗留通知会被清理；测试提醒不被对账碰', () => {
  const plan = planTaskReminderReconciliation({
    tasks: [task()],
    entries: [],
    pending: [
      owned({ identifier: 'ddlmate.task-reminder.v1.7' }),
      owned({ identifier: 'ddlmate.task-reminder.v1.test.7', test: true, fingerprint: null }),
    ],
    permission: granted,
    nowMs: NOW,
  })
  assert.equal(plan.operations.length, 1)
  assert.equal(plan.operations[0].identifier, 'ddlmate.task-reminder.v1.7')
})
