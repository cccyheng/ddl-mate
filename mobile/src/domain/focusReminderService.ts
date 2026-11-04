import { canScheduleReminder, triggerAtMsFromNotificationTrigger, type PendingReminderNotificationInput } from './taskReminder'
import type { ReminderNotificationPort, TaskReminderService } from './taskReminderService'
import type { FocusStore } from './focusTime'
import { focusReminderCandidate, ownsFocusReminder, parseFocusReminderTap } from './focusReminder'
export interface FocusReminderSnapshot { queuedAt: number | null; error: string | null; busy: boolean; permission: string }
export function createFocusReminderService(deps: { port: ReminderNotificationPort; read: () => Promise<FocusStore & { generation: number }>; now?: () => number }) {
  const now = deps.now ?? Date.now
  let suspended = false, epoch = 0, queue: Promise<unknown> = Promise.resolve()
  let snapshot: FocusReminderSnapshot = { queuedAt: null, error: null, busy: false, permission: 'undetermined' }
  const listeners = new Set<() => void>()
  const emit = (patch: Partial<FocusReminderSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()) }
  const message = (e: unknown) => e instanceof Error ? e.message : String(e)
  function serial<T>(action: () => Promise<T>): Promise<T> { const p = queue.then(action, action); queue = p.catch(() => undefined); return p }
  function check(token: number) { if (suspended || token !== epoch) throw new Error('计时状态已改变或正在备份，请重新同步提醒。') }
  const matches = (p: PendingReminderNotificationInput, c: NonNullable<ReturnType<typeof focusReminderCandidate>>) =>
    p.identifier === c.identifier && parseFocusReminderTap(p.identifier, p.data, c.data.generation)?.fingerprint === c.data.fingerprint &&
    triggerAtMsFromNotificationTrigger(p.trigger) === c.triggerAtMs
  const service = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    changed: () => { epoch++ },
    reconcile: (requestPermission = false) => serial(async () => {
      const token = epoch
      let scheduledId: string | null = null
      emit({ busy: true, error: null, queuedAt: null })
      try {
        check(token)
        const source = await deps.read(); check(token)
        let permission = await deps.port.getPermission(); check(token)
        if (requestPermission && source.reminderEnabled && !canScheduleReminder(permission) && permission.canAskAgain) {
          permission = await deps.port.requestPermission(); check(token)
        }
        emit({ permission: permission.status })
        const candidate = focusReminderCandidate(source, source.generation)
        const desired = candidate && candidate.triggerAtMs > now() && canScheduleReminder(permission) ? candidate : null
        const pending = await deps.port.listPending(); check(token)
        for (const p of pending) if (ownsFocusReminder(p.identifier) && (!desired || !matches(p, desired))) {
          check(token); await deps.port.cancel(p.identifier)
        }
        check(token)
        if (source.reminderEnabled && !canScheduleReminder(permission)) throw new Error('计时已保存，但通知权限未开启；到时提醒未安排。')
        if (desired && !pending.some(p => matches(p, desired))) {
          const latest = await deps.port.listPending(); check(token)
          if (latest.length >= 60) throw new Error('计时已保存，但手机通知队列已满；到时提醒未安排。')
          if (desired.triggerAtMs <= now()) return snapshot
          scheduledId = desired.identifier
          await deps.port.schedule(desired); check(token)
        }
        const actual = await deps.port.listPending(); check(token)
        if (desired && desired.triggerAtMs > now()) {
          if (!actual.some(p => matches(p, desired))) throw new Error('计时已保存，系统尚未确认到时提醒，请重新同步。')
          emit({ queuedAt: desired.triggerAtMs })
        }
      } catch (e) {
        let error = message(e)
        // In-flight schedule may have landed after pause/restore. Remove only this producer's exact ID.
        if (scheduledId && (suspended || token !== epoch)) {
          try { await deps.port.cancel(scheduledId) } catch (cancelError) { error += `；取消旧提醒失败：${message(cancelError)}` }
        }
        emit({ queuedAt: null, error })
      } finally { emit({ busy: false }) }
      return snapshot
    }),
    suspend: async () => { suspended = true; epoch++; await queue },
    resume: () => { suspended = false },
    cancelAll: () => serial(async () => {
      try {
        for (const p of await deps.port.listPending()) if (ownsFocusReminder(p.identifier)) await deps.port.cancel(p.identifier)
        if ((await deps.port.listPending()).some(p => ownsFocusReminder(p.identifier))) throw new Error('旧番茄钟提醒尚未取消。')
        emit({ queuedAt: null, error: null }); return null
      } catch (e) { const error = message(e); emit({ error }); return error }
    }),
  }
  return service
}
export type FocusReminderService = ReturnType<typeof createFocusReminderService>
export function withFocusReminderLifecycle(task: TaskReminderService, focus: FocusReminderService): TaskReminderService {
  return { ...task,
    reconcile: async reason => { const report = await task.reconcile(reason); const f = await focus.reconcile(); return f.error ? { ...report, ok: false, reason: [report.reason, f.error].filter(Boolean).join('；') } : report },
    suspendForBackup: async reason => { await Promise.all([task.suspendForBackup(reason), focus.suspend()]) },
    resumeAfterBackup: () => { task.resumeAfterBackup(); focus.resume() },
    cancelAllOwnedNotifications: async reason => { const report = await task.cancelAllOwnedNotifications(reason); const error = await focus.cancelAll(); return error ? { ...report, ok: false, reason: [report.reason, error].filter(Boolean).join('；') } : report },
  }
}
