import { canScheduleReminder, triggerAtMsFromNotificationTrigger, type PendingReminderNotificationInput } from './taskReminder'
import type { ReminderNotificationPort, TaskReminderService } from './taskReminderService'
import { CLASS_REMINDER_KIND, CLASS_REMINDER_LIMIT, CLASS_REMINDER_TEST_ID, buildClassReminderCandidates,
  defaultClassReminderSettings, decodeClassReminderSettings, ownsClassReminderId,
  type ClassReminderCandidate, type ClassReminderSettings, type ClassReminderSource } from './classReminder'

export interface ClassReminderSnapshot {
  settings: ClassReminderSettings; busy: boolean; error: string | null; queued: ClassReminderCandidate[]
  eligibleCount: number; checkedAt: number | null; permission: string; testQueued: boolean
}
export interface ClassReminderDeps {
  port: ReminderNotificationPort
  read: () => Promise<ClassReminderSource>
  write: (settings: ClassReminderSettings) => Promise<void>
  now?: () => number
}
function matches(p: PendingReminderNotificationInput, c: ClassReminderCandidate): boolean {
  const d = p.data as Record<string, unknown> | undefined
  return p.identifier === c.identifier && d?.fingerprint === c.data.fingerprint &&
    d?.kind === CLASS_REMINDER_KIND && d?.generation === c.data.generation &&
    triggerAtMsFromNotificationTrigger(p.trigger) === c.triggerAtMs
}
export function createClassReminderService(deps: ClassReminderDeps) {
  const now = deps.now ?? Date.now
  let suspended = false, queue: Promise<unknown> = Promise.resolve()
  let snapshot: ClassReminderSnapshot = { settings: defaultClassReminderSettings(), busy: false, error: null,
    queued: [], eligibleCount: 0, checkedAt: null, permission: 'undetermined', testQueued: false }
  const listeners = new Set<() => void>()
  const emit = (patch: Partial<ClassReminderSnapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()) }
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const p = queue.then(action, action); queue = p.catch(() => undefined); return p
  }
  const message = (e: unknown) => e instanceof Error ? e.message : String(e)
  function checkActive() { if (suspended) throw new Error('备份操作进行中，课前提醒将在结束后同步。') }
  async function sync(): Promise<ClassReminderSnapshot> {
    checkActive()
    emit({ busy: true, error: null })
    try {
      const source = await deps.read(); checkActive()
      emit({ settings: source.settings })
      const permission = await deps.port.getPermission(); checkActive()
      emit({ permission: permission.status })
      const all = buildClassReminderCandidates(source, now())
      const pending = await deps.port.listPending(); checkActive()
      const own = pending.filter(p => ownsClassReminderId(p.identifier) && p.identifier !== CLASS_REMINDER_TEST_ID)
      const foreignCount = pending.length - own.length
      // Reserve normal task reminder slots; never fill the OS queue with the whole semester.
      const capacity = Math.max(0, Math.min(CLASS_REMINDER_LIMIT, 60 - foreignCount))
      const desired = canScheduleReminder(permission) ? all.slice(0, capacity) : []
      const keep = new Map(desired.map(c => [c.identifier, c]))
      for (const p of own) {
        const target = keep.get(p.identifier)
        if (target && matches(p, target)) continue
        checkActive(); await deps.port.cancel(p.identifier)
      }
      for (const candidate of desired) {
        if (pending.some(p => matches(p, candidate))) continue
        checkActive()
        if (candidate.triggerAtMs <= now()) continue
        await deps.port.schedule(candidate)
      }
      checkActive()
      const actual = await deps.port.listPending(); checkActive()
      const queued = desired.filter(c => actual.some(p => matches(p, c)))
      const reason = source.settings.enabled && !canScheduleReminder(permission)
        ? '设置已保存，但通知权限未开启。请在系统设置中允许通知后重试。'
        : queued.length !== desired.length ? '系统尚未确认全部提醒，请重新同步。'
        : all.length && !capacity ? '手机通知队列已满，请稍后重试。' : null
      emit({ queued, eligibleCount: all.length, checkedAt: now(), error: reason })
    } catch (e) { emit({ queued: [], checkedAt: null, error: message(e) }) }
    finally { emit({ busy: false }) }
    return snapshot
  }
  const service = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    reconcile: () => serial(sync),
    save: (input: ClassReminderSettings) => serial(async () => {
      checkActive()
      const settings = decodeClassReminderSettings(JSON.stringify(input))
      await deps.write(settings); emit({ settings }); checkActive()
      try {
        if (settings.enabled) {
          const p = await deps.port.getPermission(); checkActive()
          if (!canScheduleReminder(p) && p.canAskAgain) await deps.port.requestPermission()
        } else {
          await deps.port.cancel(CLASS_REMINDER_TEST_ID)
          emit({ testQueued: false })
        }
      } catch (e) { emit({ error: `设置已保存；${message(e)}` }); return snapshot }
      return sync()
    }),
    test: () => serial(async () => {
      checkActive(); emit({ busy: true, testQueued: false, error: null })
      try {
        const source = await deps.read(); checkActive()
        let p = await deps.port.getPermission(); checkActive()
        if (!canScheduleReminder(p) && p.canAskAgain) p = await deps.port.requestPermission()
        checkActive(); emit({ permission: p.status })
        if (!canScheduleReminder(p)) throw new Error('通知权限未开启，测试提醒没有安排。')
        await deps.port.cancel(CLASS_REMINDER_TEST_ID); checkActive()
        const at = Math.ceil((now() + 10_000) / 1000) * 1000
        const candidate: ClassReminderCandidate = { identifier: CLASS_REMINDER_TEST_ID, title: '课前提醒测试',
          body: '测试成功。正式提醒会显示课程、上课时间和地点。', triggerAtMs: at,
          data: { kind: CLASS_REMINDER_KIND, generation: source.generation, courseId: 0, scheduleId: 0,
            dateKey: '', startTime: '', fingerprint: String(at), test: true } }
        await deps.port.schedule(candidate); checkActive()
        const pending = await deps.port.listPending(); checkActive()
        if (!pending.some(p => matches(p, candidate))) throw new Error('系统未确认测试提醒，请重试。')
        emit({ testQueued: true })
      } catch (e) { emit({ error: message(e) }) }
      finally { emit({ busy: false }) }
      return snapshot
    }),
    suspend: async () => { suspended = true; await queue },
    resume: () => { suspended = false },
    cancelAll: () => serial(async () => {
      try {
        const pending = await deps.port.listPending()
        for (const p of pending) if (ownsClassReminderId(p.identifier)) await deps.port.cancel(p.identifier)
        const remaining = (await deps.port.listPending()).filter(p => ownsClassReminderId(p.identifier))
        if (remaining.length) throw new Error('旧课前提醒尚未取消。')
        emit({ queued: [], testQueued: false, checkedAt: null }); return null
      } catch (e) { const error = message(e); emit({ error }); return error }
    }),
  }
  return service
}
export type ClassReminderService = ReturnType<typeof createClassReminderService>

/** Reuse every existing backup suspension/cancellation boundary, including restore retry paths. */
export function withClassReminderLifecycle(task: TaskReminderService, classes: ClassReminderService): TaskReminderService {
  return { ...task,
    reconcile: async reason => {
      const report = await task.reconcile(reason)
      const c = await classes.reconcile()
      return c.error ? { ...report, ok: false, reason: [report.reason, c.error].filter(Boolean).join('；') } : report
    },
    suspendForBackup: async reason => { await Promise.all([task.suspendForBackup(reason), classes.suspend()]) },
    resumeAfterBackup: () => { task.resumeAfterBackup(); classes.resume() },
    cancelAllOwnedNotifications: async reason => {
      const report = await task.cancelAllOwnedNotifications(reason)
      const error = await classes.cancelAll()
      return error ? { ...report, ok: false, reason: [report.reason, error].filter(Boolean).join('；') } : report
    },
  }
}
