/**
 * 任务提醒设置页的**纯状态控制器**（无 React / 无原生模块）。
 *
 * 它把「从数据库 / 系统读到的真实状态」与「用户正在编辑的草稿」分开：
 * - 后台刷新、回到前台只更新真实状态，**绝不覆盖脏草稿**；
 * - 保存使用同步的 busy 闸门，双击不会发两次请求；
 * - 每次异步请求都有序号，晚到的旧任务 / 旧结果不能写进当前页面；
 * - 保存结果区分「规则已保存」与「系统是否真的排好」，不会把前者说成后者。
 */

import {
  canScheduleReminder,
  evaluateTaskReminderEligibility,
  isReminderLeadMinutes,
  reminderLeadLabel,
  type ReminderEligibility,
  type ReminderLeadMinutes,
  type ReminderTaskLike,
  type TaskReminderIntent,
} from '../domain/taskReminder'
import type {
  SaveTaskReminderServiceOutcome,
  TaskReminderInspection,
  TestReminderOutcome,
} from '../domain/taskReminderService'
import type { SaveTaskReminderInput } from '../domain/taskReminderRepository'

export interface TaskReminderControllerDeps {
  inspect: (taskId: number) => Promise<TaskReminderInspection>
  save: (input: SaveTaskReminderInput) => Promise<SaveTaskReminderServiceOutcome>
  test: (taskId: number) => Promise<TestReminderOutcome>
  retry: (taskId: number) => Promise<{ inspection: TaskReminderInspection; reason: string | null }>
}

export type ReminderNoticeTone = 'success' | 'warning' | 'error' | 'info'

export interface ReminderNotice {
  tone: ReminderNoticeTone
  text: string
}

export type ReminderBusyAction = 'load' | 'save' | 'test' | 'retry'

export interface TaskReminderControllerState {
  taskId: number
  phase: 'loading' | 'ready' | 'error'
  busy: boolean
  busyAction: ReminderBusyAction | null
  task: ReminderTaskLike | null
  inspection: TaskReminderInspection | null
  permission: TaskReminderInspection['permission'] | null
  baselineEnabled: boolean
  baselineLead: ReminderLeadMinutes
  baselineRevision: number
  draftEnabled: boolean
  draftLead: ReminderLeadMinutes
  dirty: boolean
  canEnable: boolean
  draftEligibility: ReminderEligibility | null
  needsReload: boolean
  notice: ReminderNotice | null
  lastError: string | null
  testStatus: { text: string; tone: ReminderNoticeTone } | null
  loadError: string | null
  disposed: boolean
}

export interface TaskReminderController {
  getState: () => TaskReminderControllerState
  subscribe: (listener: () => void) => () => void
  /** 重新挂载 / StrictMode setup 时恢复控制器；不重放写库或权限请求。 */
  activate: () => void
  load: (mode?: 'initial' | 'refresh') => Promise<void>
  /** 用户显式选择「载入最新」：丢弃当前草稿，采用库里的最新修订。 */
  reloadLatest: () => Promise<void>
  refreshAfterForeground: () => Promise<void>
  setEnabled: (enabled: boolean) => void
  setLead: (leadMinutes: ReminderLeadMinutes) => void
  save: () => Promise<void>
  retry: () => Promise<void>
  test: () => Promise<void>
  dispose: () => void
}

function initialLead(intent: TaskReminderIntent | null): ReminderLeadMinutes {
  return intent && isReminderLeadMinutes(intent.leadMinutes) ? intent.leadMinutes : 30
}

function createInitialState(taskId: number): TaskReminderControllerState {
  return {
    taskId,
    phase: 'loading',
    busy: false,
    busyAction: null,
    task: null,
    inspection: null,
    permission: null,
    baselineEnabled: false,
    baselineLead: 30,
    baselineRevision: 0,
    draftEnabled: false,
    draftLead: 30,
    dirty: false,
    canEnable: false,
    draftEligibility: null,
    needsReload: false,
    notice: null,
    lastError: null,
    testStatus: null,
    loadError: null,
    disposed: false,
  }
}

/** 由真实任务 / 草稿提前量算出「当前草稿能不能启用」；界面用它禁用保存并解释原因。 */
export function evaluateDraft(
  task: ReminderTaskLike | null,
  enabled: boolean,
  leadMinutes: ReminderLeadMinutes,
  nowMs: number,
): ReminderEligibility {
  return evaluateTaskReminderEligibility(task, leadMinutes, nowMs)
}

export function createTaskReminderController(
  taskId: number,
  deps: TaskReminderControllerDeps,
): TaskReminderController {
  let state = createInitialState(taskId)
  let listenerSet = new Set<() => void>()
  let disposed = false
  let requestGeneration = 0
  let busyRef = false

  function emit(): void {
    for (const listener of [...listenerSet]) {
      try {
        listener()
      } catch {
        // 界面自己的异常不能打断控制器状态机。
      }
    }
  }

  function setState(patch: Partial<TaskReminderControllerState>): void {
    state = { ...state, ...patch }
    emit()
  }

  function begin(action: ReminderBusyAction): number {
    requestGeneration += 1
    busyRef = true
    setState({ busy: true, busyAction: action })
    return requestGeneration
  }

  function isCurrent(generation: number): boolean {
    return !disposed && generation === requestGeneration
  }

  function finish(generation: number): void {
    if (generation !== requestGeneration) return
    busyRef = false
    setState({ busy: false, busyAction: null })
  }

  function adoptInspection(inspection: TaskReminderInspection, forceDraft: boolean): void {
    const intent = inspection.intent
    const baselineEnabled = Boolean(intent?.enabled)
    const baselineLead = initialLead(intent)
    const baselineRevision = inspection.revision
    const nextDraftEnabled = forceDraft || !state.dirty ? baselineEnabled : state.draftEnabled
    const nextDraftLead = forceDraft || !state.dirty ? baselineLead : state.draftLead
    const draftEligibility = evaluateDraft(inspection.task, nextDraftEnabled, nextDraftLead, inspection.atMs)
    const dirty = nextDraftEnabled !== baselineEnabled || nextDraftLead !== baselineLead
    setState({
      phase: 'ready',
      task: inspection.task,
      inspection,
      permission: inspection.permission,
      baselineEnabled,
      baselineLead,
      baselineRevision,
      draftEnabled: nextDraftEnabled,
      draftLead: nextDraftLead,
      dirty,
      canEnable: draftEligibility.eligible,
      draftEligibility,
      lastError: inspection.lastError,
      loadError: null,
    })
  }

  async function load(mode: 'initial' | 'refresh' = 'refresh'): Promise<void> {
    if (disposed) return
    if (busyRef) return
    const generation = begin('load')
    if (mode === 'initial') setState({ phase: 'loading', notice: null, loadError: null })
    try {
      const inspection = await deps.inspect(taskId)
      if (!isCurrent(generation)) return
      const previousRevision = state.baselineRevision
      const forceDraft = !state.dirty
      adoptInspection(inspection, forceDraft)
      if (inspection.intentState === 'corrupt' || inspection.intentState === 'future') {
        setState({
          notice: {
            tone: 'error',
            text:
              inspection.readReason ??
              '本机保存的提醒设置读不出来，已停止修改，以免覆盖它。',
          },
          needsReload: false,
        })
      } else if (!forceDraft && inspection.revision !== previousRevision) {
        setState({
          needsReload: true,
          notice: {
            tone: 'warning',
            text: '这条任务的提醒设置在别处已经更新。当前草稿保留着，先刷新再保存，避免覆盖别处的修改。',
          },
        })
      }
    } catch (cause) {
      if (!isCurrent(generation)) return
      setState({
        phase: state.phase === 'loading' ? 'error' : state.phase,
        loadError: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      finish(generation)
    }
  }

  /**
   * **显式**载入最新（用户主动丢弃草稿）。
   *
   * 与普通刷新不同：它会用库里的最新修订替换 draft / baseline，并清掉 `needsReload`。
   * 只有用户按「载入最新设置」才会调用；后台刷新继续保护脏草稿。
   */
  async function reloadLatest(): Promise<void> {
    if (disposed || busyRef) return
    const generation = begin('load')
    try {
      const inspection = await deps.inspect(taskId)
      if (!isCurrent(generation)) return
      adoptInspection(inspection, true)
      if (inspection.intentState === 'corrupt' || inspection.intentState === 'future') {
        setState({
          needsReload: true,
          notice: { tone: 'error', text: inspection.readReason ?? '最新设置读不出来，已停止修改以免覆盖它。' },
        })
      } else {
        setState({
          needsReload: false,
          notice: { tone: 'info', text: '已载入最新提醒设置。' },
          loadError: null,
        })
      }
    } catch (cause) {
      if (!isCurrent(generation)) return
      setState({
        loadError: cause instanceof Error ? cause.message : String(cause),
        notice: { tone: 'error', text: `载入最新设置失败：${cause instanceof Error ? cause.message : String(cause)}` },
      })
    } finally {
      finish(generation)
    }
  }

  function setEnabled(enabled: boolean): void {
    if (disposed || busyRef) return
    const draftEligibility = evaluateDraft(state.task, enabled, state.draftLead, state.inspection?.atMs ?? Date.now())
    const dirty = enabled !== state.baselineEnabled || state.draftLead !== state.baselineLead
    setState({
      draftEnabled: enabled,
      dirty,
      canEnable: draftEligibility.eligible,
      draftEligibility,
      notice:
        enabled && !draftEligibility.eligible && draftEligibility.reason
          ? { tone: 'warning', text: draftEligibility.reason }
          : state.notice,
    })
  }

  function setLead(leadMinutes: ReminderLeadMinutes): void {
    if (disposed || busyRef || !isReminderLeadMinutes(leadMinutes)) return
    const draftEligibility = evaluateDraft(state.task, state.draftEnabled, leadMinutes, state.inspection?.atMs ?? Date.now())
    const dirty = state.draftEnabled !== state.baselineEnabled || leadMinutes !== state.baselineLead
    setState({
      draftLead: leadMinutes,
      dirty,
      canEnable: draftEligibility.eligible,
      draftEligibility,
      notice:
        state.draftEnabled && !draftEligibility.eligible && draftEligibility.reason
          ? { tone: 'warning', text: draftEligibility.reason }
          : state.notice,
    })
  }

  async function save(): Promise<void> {
    if (disposed || busyRef) return
    if (state.needsReload) {
      setState({ notice: { tone: 'warning', text: '请先刷新到最新设置，再决定是否保存。' } })
      return
    }
    if (state.draftEnabled && !state.canEnable) {
      setState({
        notice: {
          tone: 'warning',
          text: state.draftEligibility?.reason ?? '当前任务还不能启用提醒。',
        },
      })
      return
    }
    if (!state.dirty) {
      setState({ notice: { tone: 'info', text: '提醒设置没有改动。' } })
      return
    }
    const generation = begin('save')
    try {
      const outcome = await deps.save({
        taskId,
        enabled: state.draftEnabled,
        leadMinutes: state.draftLead,
        expectedRevision: state.baselineRevision,
      })
      if (!isCurrent(generation)) return
      if (outcome.inspection) {
        // 保存失败时用**非强制**采用：只更新真实状态，保留用户正在编辑的草稿。
        adoptInspection(outcome.inspection, outcome.save.committed)
      } else if (outcome.save.committed && outcome.save.intent) {
        // 规则已经提交，但状态读回失败：baseline 必须前进到已提交的修订号，
        // 否则界面会停在旧修订 / 脏草稿，下一次保存还可能拿旧版本覆盖。
        const intent = outcome.save.intent
        const draftEligibility = evaluateDraft(state.task, intent.enabled, intent.leadMinutes, Date.now())
        setState({
          baselineEnabled: intent.enabled,
          baselineLead: intent.leadMinutes,
          baselineRevision: intent.revision,
          draftEnabled: intent.enabled,
          draftLead: intent.leadMinutes,
          dirty: false,
          needsReload: false,
          canEnable: draftEligibility.eligible,
          draftEligibility,
        })
      }
      if (!outcome.save.ok || !outcome.save.committed) {
        setState({
          needsReload: !outcome.save.committed && Boolean(outcome.save.revision !== null && outcome.save.revision !== state.baselineRevision),
          notice: {
            tone: 'error',
            text: outcome.save.reason ?? '提醒设置没有保存成功，请再试一次。',
          },
          lastError: outcome.save.reason,
        })
        return
      }
      const actualEnabled = outcome.save.intent?.enabled ?? state.draftEnabled
      const savedNotScheduled = outcome.savedButNotScheduled && actualEnabled
      const closedWithIssue = !actualEnabled && Boolean(outcome.reason)
      /**
       * committed 是唯一事实：即使随后的 inspection 读回失败 / 仍是旧修订，
       * baseline 也必须前进到刚提交的 intent，不能退回旧版本或把已保存草稿留在“脏”状态。
       */
      if (outcome.save.committed && outcome.save.intent) {
        const intent = outcome.save.intent
        const currentTask = outcome.inspection?.task ?? state.task
        const committedEligibility = evaluateDraft(currentTask, intent.enabled, intent.leadMinutes, Date.now())
        setState({
          baselineEnabled: intent.enabled,
          baselineLead: intent.leadMinutes,
          baselineRevision: intent.revision,
          draftEnabled: intent.enabled,
          draftLead: intent.leadMinutes,
          dirty: false,
          needsReload: false,
          canEnable: committedEligibility.eligible,
          draftEligibility: committedEligibility,
        })
      }
      setState({
        needsReload: false,
        notice: savedNotScheduled
          ? {
              tone: 'warning',
              text: `设置已保存，提醒尚未安排。${outcome.reason ?? ''}`.trim(),
            }
          : closedWithIssue
            ? {
                tone: 'warning',
                text: outcome.reason ?? '提醒已关闭，但系统里的通知还没有确认取消。',
              }
            : {
                tone: 'success',
                text: actualEnabled
                  ? outcome.inspection?.osState === 'queued'
                    ? '提醒设置已保存，系统里已经排好；到点前会由手机本地通知提醒。'
                    : '提醒设置已保存。'
                  : '提醒已关闭。系统里本应用为这条任务排着的提醒会尝试取消。',
              },
        lastError: savedNotScheduled || closedWithIssue ? (outcome.reason ?? null) : null,
      })
    } catch (cause) {
      if (!isCurrent(generation)) return
      setState({
        notice: { tone: 'error', text: `保存提醒设置失败：${cause instanceof Error ? cause.message : String(cause)}` },
        lastError: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      finish(generation)
    }
  }

  async function retry(): Promise<void> {
    if (disposed || busyRef) return
    const generation = begin('retry')
    try {
      const result = await deps.retry(taskId)
      if (!isCurrent(generation)) return
      adoptInspection(result.inspection, true)
      const enabled = result.inspection.intent?.enabled === true
      const clean =
        (enabled && result.inspection.osState === 'queued') ||
        (!enabled && result.inspection.osState === 'off')
      setState({
        notice: clean
          ? enabled
            ? { tone: 'success', text: '提醒已经重新交给系统，并确认在系统列表里。' }
            : { tone: 'success', text: '提醒已关闭，系统里已经没有本应用为这条任务排着的提醒。' }
          : {
              tone: 'warning',
              text:
                result.reason ??
                result.inspection.pendingReason ??
                (enabled ? '还没有确认提醒已经安排，可以稍后再试。' : '还没有确认系统里的提醒已经取消，可以稍后再试。'),
            },
        lastError: clean ? null : result.reason,
      })
    } catch (cause) {
      if (!isCurrent(generation)) return
      setState({
        notice: { tone: 'error', text: `重试失败：${cause instanceof Error ? cause.message : String(cause)}` },
        lastError: cause instanceof Error ? cause.message : String(cause),
      })
    } finally {
      finish(generation)
    }
  }

  async function test(): Promise<void> {
    if (disposed || busyRef) return
    const generation = begin('test')
    setState({ testStatus: { text: '正在安排测试提醒…', tone: 'info' } })
    try {
      const outcome = await deps.test(taskId)
      if (!isCurrent(generation)) return
      setState({
        permission: outcome.permission,
        testStatus: {
          text: outcome.reason ?? (outcome.ok ? '测试提醒已经交给系统。' : '测试提醒没有安排成功。'),
          tone: outcome.ok ? (outcome.verified ? 'success' : 'warning') : 'error',
        },
        notice: null,
      })
      // 测试只排一条 10 秒后的通知，不改变任务规则；重新读一次权限 / 系统状态。
      if (outcome.ok) void load('refresh')
    } catch (cause) {
      if (!isCurrent(generation)) return
      setState({
        testStatus: { text: `测试提醒失败：${cause instanceof Error ? cause.message : String(cause)}`, tone: 'error' },
      })
    } finally {
      finish(generation)
    }
  }

  function activate(): void {
    if (!disposed) return
    disposed = false
    // 只恢复生命周期，不重放读 / 写 / 权限请求；调用方随后按需要 load。
    requestGeneration += 1
    setState({ disposed: false })
  }

  function dispose(): void {
    disposed = true
    requestGeneration += 1
    busyRef = false
    listenerSet.clear()
    state = { ...state, disposed: true, busy: false, busyAction: null }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listenerSet.add(listener)
      return () => {
        listenerSet.delete(listener)
      }
    },
    activate,
    load,
    reloadLatest,
    refreshAfterForeground: () => load('refresh'),
    setEnabled,
    setLead,
    save,
    retry,
    test,
    dispose,
  }
}

/** 给界面用的已保存规则摘要（不展示原始 ID / JSON）。 */
export function savedReminderSummary(intent: TaskReminderIntent | null): string {
  if (!intent) return '还没有保存过提醒设置（默认关闭）。'
  if (!intent.enabled) return '提醒已关闭。'
  return `已启用：${reminderLeadLabel(intent.leadMinutes)}。`
}

/** 权限能不能真正送达的简短说明；不是「已安排」的替代品。 */
export function permissionScheduleNote(permission: TaskReminderInspection['permission']): string {
  if (canScheduleReminder(permission)) {
    return permission.status === 'provisional'
      ? '当前是安静通知授权：不会响铃，只在通知中心显示。'
      : '通知权限已允许。'
  }
  return permission.detail ?? '通知权限未允许，提醒暂时不会由系统送达。'
}
