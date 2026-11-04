/** Persist intervals rather than timer ticks. Task labels are historical snapshots, never reusable IDs. */
export const FOCUS_KEY = 'focus.sessions.v1'
export const MAX_FOCUS_INTERVAL = 12 * 60 * 60 * 1000
export type FocusInterval = { start: number; end: number }
export type FocusTimer = { kind: 'focus' | 'rest'; focusMinutes: number; restMinutes: number }
export type FocusSession = {
  id: number; title: string; courseName: string; startedAt: number
  intervals: FocusInterval[]; runningSince: number | null; endedAt: number | null
  timer?: FocusTimer
  history?: { kind: 'manual' | 'corrected'; updatedAt: number }
}
export type FocusStore = { version: 1; revision: number; nextId: number; active: FocusSession | null; records: FocusSession[]; reminderEnabled?: boolean }
export type FocusAction =
  | { type: 'historySave'; id?: number; title: string; courseName: string; intervals: FocusInterval[] }
  | { type: 'historyDelete'; id: number }
  | { type: 'start'; title: string; courseName: string; timer?: FocusTimer }
  | { type: 'reminder'; enabled: boolean }
  | { type: 'pause' | 'resume' | 'finish' | 'finishAndRest' | 'nextFocus' | 'discard' | 'recover' }
export const emptyFocus = (): FocusStore => ({ version: 1, revision: 0, nextId: 1, active: null, records: [] })
function assert(value: unknown, message = '专注记录格式无效，已停止写入以保护原数据。'): asserts value {
  if (!value) throw new Error(message)
}
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0
const stamp = (n: unknown): n is number => integer(n) && n <= 7258118400000

export function decodeFocus(raw: string | null): FocusStore {
  if (raw === null) return emptyFocus()
  assert(raw.length <= 600000, '专注记录超过安全容量，请保留备份后再处理。')
  const s = JSON.parse(raw) as FocusStore
  assert(s && s.version === 1 && integer(s.revision) && integer(s.nextId) && s.nextId > 0)
  assert(Array.isArray(s.records) && s.records.length <= 10000)
  assert(s.reminderEnabled === undefined || typeof s.reminderEnabled === 'boolean')
  const ids = new Set<number>()
  let previousEnd = 0
  for (const [entry, active] of [...s.records.map(r => [r, false] as const), ...(s.active === null ? [] : [[s.active, true] as const])]) {
    assert(entry && integer(entry.id) && entry.id > 0 && entry.id < s.nextId && !ids.has(entry.id))
    ids.add(entry.id)
    assert(typeof entry.title === 'string' && entry.title.trim().length > 0 && entry.title.length <= 200)
    assert(typeof entry.courseName === 'string' && entry.courseName.length <= 200)
    assert(stamp(entry.startedAt) && entry.startedAt >= previousEnd)
    if (entry.history !== undefined) {
      assert(!active && entry.history && (entry.history.kind === 'manual' || entry.history.kind === 'corrected') && stamp(entry.history.updatedAt))
    }
    assert(Array.isArray(entry.intervals) && entry.intervals.length <= 2000)
    if (entry.timer !== undefined) {
      const timer = entry.timer
      assert(timer && (timer.kind === 'focus' || timer.kind === 'rest'))
      assert(integer(timer.focusMinutes) && timer.focusMinutes >= 1 && timer.focusMinutes <= 180)
      assert(integer(timer.restMinutes) && timer.restMinutes >= 1 && timer.restMinutes <= 60)
      assert(active || timer.kind === 'focus')
    }
    let last = entry.startedAt
    for (const interval of entry.intervals) {
      assert(interval && stamp(interval.start) && stamp(interval.end) && interval.start >= last && interval.end >= interval.start)
      assert(interval.end - interval.start <= MAX_FOCUS_INTERVAL)
      last = interval.end
    }
    assert(entry.timer === undefined || sealedDuration(entry) <= focusTarget(entry))
    if (active) {
      assert(entry.endedAt === null && (entry.runningSince === null || (stamp(entry.runningSince) && entry.runningSince >= last)))
    } else {
      assert(entry.runningSince === null && stamp(entry.endedAt) && entry.endedAt >= last)
      previousEnd = entry.endedAt
    }
  }
  return s
}

/** A clock jump/forgotten timer needs explicit recovery, never a silently inflated record. */
export function focusClockIssue(active: FocusSession | null, now: number): string | null {
  if (!active) return null
  const last = active.runningSince ?? active.intervals.at(-1)?.end ?? active.startedAt
  if (!stamp(now) || now < last) return '系统时间发生变化，请先校准手机时间，再继续。'
  if (!active.timer && active.runningSince !== null && now - active.runningSince > MAX_FOCUS_INTERVAL) return '已连续计时超过 12 小时。请舍弃未确认的连续计时段，保留之前已暂停保存的时段。'
  return null
}

export function applyFocusAction(current: FocusStore, action: FocusAction, now: number): FocusStore {
  assert(stamp(now), '手机时间无效。')
  const s = decodeFocus(JSON.stringify(current))
  assert(s.revision < Number.MAX_SAFE_INTEGER - 1)
  if (action.type === 'historySave' || action.type === 'historyDelete') {
    assert(!s.active, '请先结束当前专注或休息，再补记或修改历史记录。')
    const old = action.id === undefined ? undefined : s.records.find(r => r.id === action.id)
    if (action.id !== undefined) assert(integer(action.id) && old, '这条记录已不存在，请重新读取。')
    if (action.type === 'historyDelete') {
      assert(old, '这条记录已不存在，请重新读取。')
      s.records = s.records.filter(r => r.id !== action.id)
    } else {
      assert(typeof action.title === 'string' && action.title.trim().length > 0 && action.title.trim().length <= 200, '请填写 1–200 字的学习内容。')
      assert(typeof action.courseName === 'string' && action.courseName.trim().length <= 200, '课程名称不能超过 200 字。')
      assert(Array.isArray(action.intervals) && action.intervals.length > 0 && action.intervals.length <= 2000, '至少保留一个有效学习时段。')
      let end = 0
      for (const interval of action.intervals) {
        assert(interval && stamp(interval.start) && stamp(interval.end) && interval.end > interval.start, '每段结束必须晚于开始。')
        assert(interval.start >= end, '学习时段不能倒序或重叠。')
        assert(interval.end <= now, '不能补记或更正为未来的学习时间。')
        assert(interval.end - interval.start <= MAX_FOCUS_INTERVAL, '单个连续学习时段不能超过 12 小时。')
        end = interval.end
      }
      const sameTimes = old && old.intervals.length === action.intervals.length && old.intervals.every((interval, index) =>
        interval.start === action.intervals[index]!.start && interval.end === action.intervals[index]!.end)
      const startedAt = sameTimes ? old.startedAt : action.intervals[0]!.start
      const endedAt = sameTimes ? old.endedAt! : end
      assert(!s.records.some(r => r.id !== old?.id && startedAt < r.endedAt! && endedAt > r.startedAt), '与另一条记录的起止范围重叠，请核对时间；暂停间隙也属于原记录。')
      if (!old) {
        assert(s.records.length < 10000, '专注记录已达上限，请先整理或备份。')
        assert(s.nextId < Number.MAX_SAFE_INTEGER - 1)
      }
      const record: FocusSession = {
        id: old?.id ?? s.nextId++, title: action.title.trim(), courseName: action.courseName.trim(), startedAt,
        endedAt, runningSince: null, intervals: action.intervals.map(i => ({ ...i })),
        history: { kind: old ? 'corrected' : 'manual', updatedAt: now },
      }
      // Only retain the original countdown metadata when its measured intervals are unchanged.
      if (sameTimes && old.timer) record.timer = { ...old.timer }
      s.records = [...s.records.filter(r => r.id !== old?.id), record].sort((a, b) => a.startedAt - b.startedAt || a.id - b.id)
    }
  } else if (action.type === 'reminder') {
    assert(typeof action.enabled === 'boolean')
    s.reminderEnabled = action.enabled
  } else if (action.type === 'start') {
    assert(!s.active, '已有专注正在进行，请先结束或放弃它。')
    assert(s.records.length < 10000, '专注记录已达上限，请先备份。')
    assert(now >= (s.records.at(-1)?.endedAt ?? 0), '手机时间早于上一条记录，请校准时间。')
    assert(s.nextId < Number.MAX_SAFE_INTEGER - 1)
    s.active = { id: s.nextId++, title: action.title.trim(), courseName: action.courseName.trim(), startedAt: now, intervals: [], runningSince: now, endedAt: null }
    if (action.timer) { assert(action.timer.kind === 'focus'); s.active.timer = { ...action.timer } }
  } else {
    const active = s.active
    assert(active, '没有正在进行的专注。')
    if (action.type === 'discard') s.active = null
    else if (action.type === 'recover') {
      // The user explicitly discards the open interval, retaining only sealed intervals.
      active.runningSince = null
    } else {
      const issue = focusClockIssue(active, now)
      assert(!issue, issue ?? '')
      if (action.type === 'resume') {
        assert(active.runningSince === null, '专注已在计时。')
        assert(!active.timer || focusRemaining(active, now) > 0, '倒计时已结束，请保存或进入下一阶段。')
        active.runningSince = now
      } else {
        const until = focusDeadline(active)
        if (active.runningSince !== null) {
          assert(active.intervals.length < 2000, '本次暂停次数已达上限，请先结束。')
          active.intervals.push({ start: active.runningSince, end: until === null ? now : Math.min(now, until) })
          active.runningSince = null
        }
        if (action.type === 'finish' || action.type === 'finishAndRest' || action.type === 'nextFocus') {
          const timer = active.timer
          if (action.type === 'finishAndRest') assert(timer?.kind === 'focus', '只有番茄专注可以保存并开始休息。')
          if (action.type === 'nextFocus') assert(timer?.kind === 'rest', '请先结束当前专注。')
          active.endedAt = until === null ? now : Math.min(now, until)
          if (timer?.kind !== 'rest') s.records.push(active)
          s.active = null
          if ((action.type === 'finishAndRest' || action.type === 'nextFocus') && timer) {
            assert(s.nextId < Number.MAX_SAFE_INTEGER - 1)
            assert(s.records.length < 10000, '专注记录已达上限，请先备份。')
            s.active = { id: s.nextId++, title: active.title, courseName: active.courseName, startedAt: now,
              intervals: [], runningSince: now, endedAt: null,
              timer: { ...timer, kind: action.type === 'finishAndRest' ? 'rest' : 'focus' } }
          }
        }
      }
    }
  }
  s.revision++
  return decodeFocus(JSON.stringify(s))
}

export function focusDuration(session: FocusSession, now: number): number {
  const saved = sealedDuration(session)
  const elapsed = saved + (session.runningSince !== null && !focusClockIssue(session, now) ? now - session.runningSince : 0)
  return session.timer ? Math.min(focusTarget(session), elapsed) : elapsed
}
function sealedDuration(session: FocusSession): number { return session.intervals.reduce((total, i) => total + i.end - i.start, 0) }
export function focusTarget(session: FocusSession): number {
  return session.timer ? (session.timer.kind === 'rest' ? session.timer.restMinutes : session.timer.focusMinutes) * 60000 : Infinity
}
export function focusRemaining(session: FocusSession, now: number): number { return Math.max(0, focusTarget(session) - focusDuration(session, now)) }
export function focusDeadline(session: FocusSession): number | null {
  return session.timer && session.runningSince !== null ? session.runningSince + Math.max(0, focusTarget(session) - sealedDuration(session)) : null
}
/** Completed intervals only; clips at Shanghai boundaries supplied by the caller. */
export function focusTotal(store: FocusStore, from: number, to: number, now = Date.now()): number {
  return store.records.reduce((sum, record) => sum + record.intervals.reduce((subtotal, i) =>
    subtotal + Math.max(0, Math.min(i.end, to, now) - Math.max(i.start, from)), 0), 0)
}
export function formatFocusDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
export function focusDayStart(dateKey: string): number { return Date.parse(`${dateKey}T00:00:00+08:00`) }
/** Restoring a backup pauses the timer. The open interval has no confirmed end and is dropped. */
export function focusForRestore(raw: string): string {
  const s = decodeFocus(raw)
  if (s.active) s.active.runningSince = null
  if (s.reminderEnabled !== undefined) s.reminderEnabled = false
  assert(s.revision < Number.MAX_SAFE_INTEGER - 1)
  s.revision++
  return JSON.stringify(s)
}
