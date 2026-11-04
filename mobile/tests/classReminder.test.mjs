import test from 'node:test'
import assert from 'node:assert/strict'
import { buildClassReminderCandidates, CLASS_REMINDER_KEY, CLASS_REMINDER_TEST_ID, decodeClassReminderSettings, parseClassReminderTap } from '../src/domain/classReminder.ts'
import { createClassReminderService, withClassReminderLifecycle } from '../src/domain/classReminderService.ts'
import { assertSettingsRestorable } from '../src/domain/backupFormat.ts'

const now = Date.parse('2026-10-25T23:00:00Z') // Monday 07:00 Shanghai, teaching week 8
const settings = { version: 1, enabled: true, leadMinutes: 10 }
const course = { id: 1, name: '数据结构', instructor: '张老师' }
const schedule = { id: 1, courseId: 1, weekday: 1, startTime: '08:00', endTime: '09:35', location: '教学楼103', semesterStartDate: '2026-09-07', startWeek: 1, endWeek: 16, weekPattern: 'ALL' }
const source = extra => ({ settings: { ...settings }, courses: [{ ...course }], schedules: [{ ...schedule }], generation: 2, ...extra })
function fixture(extra = {}) {
  let current = source(extra), pending = new Map(), permission = { status: 'granted', canAskAgain: false, detail: null }
  const calls = { schedules: 0, cancels: [], requests: 0, writes: 0 }
  let readFailure = false, cancelFailure = false, listFailure = false, scheduleFailure = false
  const port = { getPermission: async () => permission, requestPermission: async () => { calls.requests++; return permission },
    listPending: async () => { if (listFailure) throw Error('list unavailable'); return [...pending.values()] },
    schedule: async c => { calls.schedules++; if (scheduleFailure) throw Error('OS schedule failure'); pending.set(c.identifier, { identifier: c.identifier, data: c.data, trigger: { type: 'date', timestamp: c.triggerAtMs } }) },
    cancel: async id => { calls.cancels.push(id); if (cancelFailure) throw Error('OS cancel failure'); pending.delete(id) } }
  const deps = { port, now: () => now, read: async () => { if (readFailure) throw Error('DB unavailable'); return current }, write: async s => { calls.writes++; current = { ...current, settings: s } } }
  const service = createClassReminderService(deps)
  return { service, port, deps, calls, pending, setSource: v => current = v, getSource: () => current,
    permission: v => permission = v, fail: key => { if (key === 'read') readFailure = true; if (key === 'cancel') cancelFailure = true; if (key === 'list') listFailure = true; if (key === 'schedule') scheduleFailure = true } }
}
test('Shanghai dates, odd/even teaching weeks, inclusive range and current lead cutoff', () => {
  const c = buildClassReminderCandidates(source(), now)
  assert.deepEqual(c.map(x => x.data.dateKey), ['2026-10-26', '2026-11-02'])
  assert.equal(c[0].triggerAtMs, Date.parse('2026-10-26T07:50:00+08:00'))
  assert.match(c[0].body, /教学楼103.*张老师/)
  assert.deepEqual(buildClassReminderCandidates(source({ schedules: [{ ...schedule, weekPattern: 'ODD' }] }), now).map(x => x.data.dateKey), ['2026-11-02'])
  assert.deepEqual(buildClassReminderCandidates(source({ schedules: [{ ...schedule, weekPattern: 'EVEN', endWeek: 8 }] }), now).map(x => x.data.dateKey), ['2026-10-26'])
  assert.equal(buildClassReminderCandidates(source(), c[0].triggerAtMs)[0].data.dateKey, '2026-11-02')
  assert.equal(buildClassReminderCandidates(source({ courses: [] }), now).length, 0)
})
test('reconcile idempotent; changing place/time replaces; deletion cancels only class namespace', async () => {
  const f = fixture(); f.pending.set('task-other', { identifier: 'task-other', data: {} })
  assert.equal((await f.service.reconcile()).queued.length, 2)
  await Promise.all([f.service.reconcile(), f.service.reconcile()]); assert.equal(f.calls.schedules, 2)
  f.setSource(source({ schedules: [{ ...schedule, location: '新教室', startTime: '09:00' }] }))
  await f.service.reconcile(); assert.equal(f.calls.schedules, 4); assert.equal(f.calls.cancels.length, 2)
  f.setSource(source({ schedules: [] })); await f.service.reconcile()
  assert.deepEqual([...f.pending.keys()], ['task-other'])
})
test('DB/list read failures never masquerade as empty or cancel other notifications', async () => {
  for (const failure of ['read', 'list']) {
    const f = fixture(); await f.service.reconcile(); f.fail(failure)
    const result = await f.service.reconcile(); assert.ok(result.error); assert.equal(result.checkedAt, null)
    assert.equal(f.calls.cancels.length, 0); assert.equal(f.calls.schedules, 2)
  }
})
test('failed cancellation stops replacement; failed schedule is not reported as queued', async () => {
  const f = fixture(); await f.service.reconcile(); f.setSource(source({ schedules: [{ ...schedule, location: 'changed' }] })); f.fail('cancel')
  assert.ok((await f.service.reconcile()).error); assert.equal(f.calls.schedules, 2)
  const g = fixture(); g.fail('schedule'); assert.ok((await g.service.reconcile()).error); assert.equal(g.service.getSnapshot().queued.length, 0)
})
test('permission requested only by explicit enable/test; denied save remains visible and no queued notification', async () => {
  const f = fixture({ settings: { ...settings, enabled: false } }); f.permission({ status: 'denied', canAskAgain: true, detail: null })
  await f.service.reconcile(); assert.equal(f.calls.requests, 0)
  const saved = await f.service.save(settings); assert.equal(saved.settings.enabled, true); assert.ok(saved.error); assert.equal(f.calls.requests, 1); assert.equal(f.calls.schedules, 0)
})
test('test reminder while disabled survives ordinary foreground sync; off explicitly cancels it', async () => {
  const f = fixture({ settings: { ...settings, enabled: false } }); assert.equal((await f.service.test()).testQueued, true)
  assert.equal(f.calls.writes, 0); await f.service.reconcile(); assert.ok(f.pending.has(CLASS_REMINDER_TEST_ID))
  await f.service.save({ ...settings, enabled: false }); assert.equal(f.pending.size, 0)
})
test('limits nearest 24; task reminders preserved and foreign capacity respected', async () => {
  const schedules = Array.from({ length: 30 }, (_, i) => ({ ...schedule, id: i + 1 }))
  const f = fixture({ schedules }); assert.equal((await f.service.reconcile()).queued.length, 24)
  assert.equal(f.service.getSnapshot().eligibleCount, 60)
  const g = fixture({ schedules }); for (let i = 0; i < 58; i++) g.pending.set('foreign'+i, { identifier: 'foreign'+i })
  assert.equal((await g.service.reconcile()).queued.length, 2); assert.equal(g.pending.size, 60)
})
test('backup suspension blocks queued work and restore cleanup clears only owned class IDs', async () => {
  const f = fixture(); await f.service.reconcile(); f.pending.set('other', { identifier: 'other' })
  await f.service.suspend(); await assert.rejects(f.service.reconcile(), /备份/)
  assert.equal(await f.service.cancelAll(), null); assert.deepEqual([...f.pending.keys()], ['other'])
  f.setSource(source({ settings: { ...settings, enabled: false } })); f.service.resume(); assert.equal((await f.service.reconcile()).queued.length, 0)
})
test('suspension barrier awaits in-flight schedule before cancellation', async () => {
  const f = fixture(); let release, entered
  const began = new Promise(r => entered = r), blocked = new Promise(r => release = r), original = f.port.schedule
  f.port.schedule = async c => { entered(); await blocked; await original(c) }
  const active = f.service.reconcile(); await began; const stop = f.service.suspend(); release(); await stop; await active
  await f.service.cancelAll(); assert.equal(f.pending.size, 0); assert.equal(f.calls.schedules, 1)
})
test('backup lifecycle forwards class cleanup failure and resumes both services', async () => {
  const f = fixture(); let suspended = false
  const task = { reconcile: async () => ({ ok: true, reason: null }), suspendForBackup: async () => { suspended = true }, resumeAfterBackup: () => { suspended = false }, cancelAllOwnedNotifications: async () => ({ ok: true, reason: null }) }
  const combined = withClassReminderLifecycle(task, f.service)
  await combined.suspendForBackup('test'); assert.equal(suspended, true); f.fail('list')
  assert.equal((await combined.cancelAllOwnedNotifications('restore')).ok, false); combined.resumeAfterBackup(); assert.equal(suspended, false)
})
test('settings schema is strict and new key accepted by backup without allowing arbitrary keys', () => {
  const setting = { key: CLASS_REMINDER_KEY, value: JSON.stringify(settings), updatedAt: '2026-10-26T00:00:00Z' }
  assertSettingsRestorable([setting], new Set())
  assert.throws(() => assertSettingsRestorable([{ ...setting, key: 'arbitrary' }], new Set()))
  assert.throws(() => decodeClassReminderSettings(JSON.stringify({ ...settings, leadMinutes: 0 })))
  assert.throws(() => decodeClassReminderSettings(JSON.stringify({ ...settings, extra: true })))
})
test('tap payload validates exact identity and restore generation', () => {
  const c = buildClassReminderCandidates(source(), now)[0]
  assert.ok(parseClassReminderTap(c.identifier, c.data, 2))
  assert.equal(parseClassReminderTap(c.identifier, c.data, 3), null)
  assert.equal(parseClassReminderTap('other', c.data, 2), null)
  assert.equal(parseClassReminderTap(c.identifier, { ...c.data, scheduleId: 2 }, 2), null)
})
