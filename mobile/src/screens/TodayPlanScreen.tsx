/**
 * 今日学习计划（原生界面）。
 *
 * 这一页回答的是：**今天我给自己划出的这段时间里，按我选的任务和每任务的计划分钟数，
 * 排不排得下、具体几点做什么；排不下的还差多少、为什么。**
 *
 * 它刻意**不**做的事：
 * - 不接 AI、不发通知、不自动重排、不改任何任务的 DDL / 状态 / 预计用时；
 * - 不猜用户的空闲时间：学习时段必须由用户自己填（空白 = 没有时段）；
 * - 不替用户填计划分钟数：`预计用时` 只是一个**可编辑的便利初值**，
 *   而且只对「明确填过 1–1440 分钟」的任务预填；进行中任务的进度没有被测量，
 *   预填的仍然是它原来的预计值，需要用户确认；
 * - 不把预览当成已保存：预览是只读的、零写库；只有「采用并保存」才会写；
 * - 不把昨天的计划当成今天的。
 *
 * 三份状态（草稿 / 预览 / 已保存计划）由 `domain/todayPlanState.ts` 管，
 * 排布规则由 `domain/todayPlan.ts` 管，落库由 `domain/todayPlanRepository.ts` 管：
 * 界面里没有第二份计算公式，也没有任何 SQL。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { readShanghaiEpochClock } from '../domain/calendarClock'
import { shanghaiDeadlineLabel, shanghaiToday, weekdayName, weekdayOfDateKey } from '../domain/datetime'
import { formatMinutes } from '../domain/ddlPressure'
import {
  MAX_SELECTED_TASKS,
  MAX_STUDY_WINDOWS,
  buildTodayPlan,
  normalizePlanMinutes,
  sameTodayPlanFingerprint,
  todayPlanFingerprint,
  validateStudyWindows,
  verifyTodayPlan,
  type PlanSelection,
  type StudyWindowInput,
  type TodayPlan,
  type TodayPlanFingerprint,
} from '../domain/todayPlan'
import {
  addStudyWindow,
  applyCommitResult,
  applySavedPlanRead,
  baselineFromPlan,
  commitFailureResult,
  hasKnownTodaySavedRecord,
  initialTodayPlanState,
  isDraftDirty,
  mergePostCommitRead,
  previewStatus,
  removeStudyWindow,
  resetForNewDate,
  setSelectionMinutes,
  setStudyWindow,
  toggleTaskSelection,
  withDraft,
  withPreview,
  withSaving,
  type TodayPlanPreview,
  type TodayPlanState,
} from '../domain/todayPlanState'
import type { Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import {
  AppButton,
  AppTextField,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  RefreshErrorBanner,
  SectionCard,
} from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { TimeWheelField } from '../ui/timeWheel'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutes } from '../navigation/types'

type Nav = NativeStackNavigationProp<SharedTaskRoutes>

/** 合法的 `HH:mm` 文本（与 `clockToMinutes` 同一口径）。 */
const CLOCK_TEXT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * 只检查「输入框里的文本本身」的问题：写错了格式（`8:00` / `25:00` / `08:60`）。
 *
 * 时段重叠、开始 ≥ 结束这类需要**两段互相比对**的问题由 `validateStudyWindows` 给整块提示，
 * 不挂在单个输入框上（挂上去反而会指向错误的那一段）。
 */
function windowFieldError(value: string, label: string): string | null {
  const text = value.trim()
  if (text.length === 0) return null
  if (!CLOCK_TEXT_RE.test(text)) return `${label}要写成 08:00 这样的 HH:mm。`
  return null
}

/**
 * 这个动作**执行的那一刻**。
 *
 * 刻意不是从焦点时钟的渲染值里取：页面可以一直停在屏幕上（甚至跨过午夜），
 * 而「生成预览 / 采用并保存」必须按用户**按下按钮**的那一瞬间来判定。
 * 这里只读一次、只用一次，不放进 state，也不参与渲染。
 */
function readActionNow(): Date {
  return new Date()
}


/* --------------------------- 选中任务的分钟数初值 --------------------------- */

/** 合法且为正的预计用时才算「可以预填」；缺失 / 0 / 超范围一律留空（不猜、不截断）。 */
export function prefillMinutesFromTask(task: Pick<Task, 'estimatedMinutes'>): string {
  const value = task.estimatedMinutes
  if (typeof value !== 'number' || !Number.isInteger(value)) return ''
  if (value <= 0 || value > 1440) return ''
  return String(value)
}

/** 预填值的来源说明（界面必须写清楚这是「可改的便利初值」，不是安排）。 */
export function prefillNote(task: Pick<Task, 'estimatedMinutes' | 'status'>): string | null {
  const prefill = prefillMinutesFromTask(task)
  if (prefill.length === 0) return null
  return task.status === 'DOING'
    ? `已按原预计用时 ${prefill} 分钟预填；进行中的进度没有被测量，请确认后再用。`
    : `已按原预计用时 ${prefill} 分钟预填，可以改成今天实际打算投入的分钟数。`
}

/* ------------------------------ 保存计划的活链接 ------------------------------ */

/** 已保存计划里的一处「情况变了」（只提示，**绝不**自动改计划）。 */
export interface SavedPlanIssue {
  taskId: number
  taskTitle: string
  text: string
}

/**
 * 读回的计划与**当前真实数据**的差异（纯函数，界面与测试共用）。
 *
 * 差异只报告、不修复：计划里的块不会被自动重排、不会被删除，
 * 任务也不会因为「被排进计划」而变成完成。
 */
export function describeSavedPlanIssues(
  plan: TodayPlan,
  tasks: readonly Task[],
  dateKey: string,
): SavedPlanIssue[] {
  const byId = new Map<number, Task>()
  for (const task of tasks) byId.set(Number(task.id), task)
  const issues: SavedPlanIssue[] = []
  for (const outcome of plan.outcomes) {
    const task = byId.get(outcome.taskId) ?? null
    if (!task) {
      issues.push({ taskId: outcome.taskId, taskTitle: outcome.taskTitle, text: '这个任务已经不在了（可能被删除）。' })
      continue
    }
    const lines: string[] = []
    if (task.status !== 'TODO' && task.status !== 'DOING') {
      lines.push('任务现在是已完成 / 已取消。')
    }
    if (task.title !== outcome.taskTitle) {
      lines.push(`任务标题已改成「${task.title}」。`)
    }
    if ((task.deadline ?? null) !== (outcome.deadline ?? null)) {
      lines.push('截止时间已经改过。')
    }
    const target = normalizePlanMinutes(outcome.targetMinutes)
    if (target === null) lines.push('计划分钟数不合法。')
    if (lines.length > 0) {
      issues.push({ taskId: outcome.taskId, taskTitle: task.title, text: lines.join(' ') })
    }
  }
  const windowLabels = plan.windowLabels
  const windowsStillValid = validateStudyWindows(
    plan.fingerprint.windows.map((label) => {
      const parts = label.split('-')
      return { start: parts[0] ?? '', end: parts[1] ?? '' }
    }),
  ).ok
  if (!windowsStillValid && windowLabels.length > 0) {
    issues.push({ taskId: 0, taskTitle: '学习时段', text: '计划里记录的学习时段格式已经无法识别。' })
  }
  const order = [...plan.blocks].sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)
  if (order.some((block) => block.endMinute > 1440 || block.endMinute <= block.startMinute)) {
    issues.push({ taskId: 0, taskTitle: '计划块', text: `${dateKey} 的计划里有时间不合理的块。` })
  }
  return issues
}

/* --------------------------------- 主界面 -------------------------------- */

export function TodayPlanScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const clock = useFocusClock(readShanghaiEpochClock)
  /**
   * 展示用的「现在」。真正的排布 / 保存**不使用**这个值：
   * 每次点「生成预览」「采用并保存」都会当场重新读一次表（见 `readActionNow`），
   * 焦点时钟只负责让界面上的日期与文案保持新鲜（前台才走字，没有后台定时器）。
   */
  const now = useMemo(() => new Date(clock.epochMs), [clock.epochMs])
  const today = clock.dateKey || store.today

  const { refresh, todayPlan } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const [state, setState] = useState<TodayPlanState>(() => initialTodayPlanState(today))
  const [loadingSaved, setLoadingSaved] = useState(false)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [storedOtherDate, setStoredOtherDate] = useState(false)
  /** 同步的在途闸门：只靠 state 挡不住同一帧里的双击。 */
  const inFlightRef = useRef(false)
  const [pendingReplace, setPendingReplace] = useState(false)
  const [pendingReset, setPendingReset] = useState(false)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const leaveConfirmedRef = useRef(false)
  /** 显示「采用并保存」之后再点一次的风险：读回失败时这份预览不能重复提交。 */
  const committedAwaitingRefresh = state.phase === 'committedNoReadback'
  /**
   * 本机里已知有「今天的计划记录」吗（**内容可能读不到**）。
   *
   * 用于三件事：替换前必须确认、是否显示已保存区块、以及诚实地说「已保存但没读回来」。
   * 判据不能只看 `savedPlan`：读回失败时内容会被清掉，但记录与版本号仍然在。
   */
  const knownSavedRecord = hasKnownTodaySavedRecord({
    committed: state.committed,
    savedRevision: state.savedRevision,
    savedPlan: state.savedPlan,
    storedOtherDate,
  })

  /**
   * **过期的读回不能盖掉更新的结果**。
   *
   * `loadTodayPlan` 是异步的：切天、保存成功、跨零点重置都会触发它，
   * 如果早先发出的那次读回晚一点才回来，它带的是旧日期 / 旧版本的数据。
   * 这里用一个同步递增的序号做闸门：只有**最后一次**发起的读回才允许写状态，
   * 已经在途的旧读回一律丢弃（`discarded: true`）。
   */
  const readGenerationRef = useRef(0)

  const loadSaved = useCallback(
    async (
      dateKey: string,
    ): Promise<{ discarded: boolean; plan: TodayPlan | null; error: string | null; revision: number | null }> => {
      const generation = readGenerationRef.current + 1
      readGenerationRef.current = generation
      setLoadingSaved(true)
      try {
        const result = await todayPlan.loadTodayPlan(dateKey)
        if (readGenerationRef.current !== generation) {
          return { discarded: true, plan: null, error: null, revision: null }
        }
        if (!result.ok) {
          setSavedError(result.reason)
          setStoredOtherDate(false)
          // 读不出来：清掉不可用的内容，但**保留已经知道的版本号**（乐观锁的依据）。
          setState((previous) =>
            applySavedPlanRead(previous, {
              ok: false,
              plan: null,
              revision: previous.savedRevision,
              storedOtherDate: false,
              error: result.reason,
            }),
          )
          return { discarded: false, plan: null, error: result.reason, revision: null }
        }
        setSavedError(null)
        setStoredOtherDate(result.storedOtherDate)
        setState((previous) =>
          applySavedPlanRead(previous, {
            ok: true,
            plan: result.plan,
            revision: result.revision,
            storedOtherDate: result.storedOtherDate,
            error: null,
          }),
        )
        return { discarded: false, plan: result.plan, error: null, revision: result.revision }
      } catch (cause) {
        if (readGenerationRef.current !== generation) {
          return { discarded: true, plan: null, error: null, revision: null }
        }
        const message = cause instanceof Error ? cause.message : '读取已保存的计划失败。'
        setSavedError(message)
        setState((previous) =>
          applySavedPlanRead(previous, {
            ok: false,
            plan: null,
            revision: previous.savedRevision,
            storedOtherDate: false,
            error: message,
          }),
        )
        return { discarded: false, plan: null, error: message, revision: null }
      } finally {
        if (readGenerationRef.current === generation) setLoadingSaved(false)
      }
    },
    [todayPlan],
  )

  useEffect(() => {
    void loadSaved(today)
  }, [loadSaved, today])

  /**
   * 后台刷新到「已保存计划真的变了」时，把干净基线也对齐过去 ——
   * 但**只在草稿没有未保存改动时**这样做，绝不覆盖用户正在编辑的内容。
   *
   * 用 ref 读最新的草稿与基线，避免把 `state` 放进依赖里造成「改一次输入就
   * 重新对齐一次基线」的循环（那会把脏草稿误判成干净的）。
   */
  const stateRef = useRef(state)
  stateRef.current = state
  const savedPlanIdentity = state.savedPlan
    ? `${state.savedPlan.date}#${state.savedRevision}`
    : `none#${state.savedRevision}`
  useEffect(() => {
    const current = stateRef.current
    if (isDraftDirty(current.draft, current.baseline)) return
    const observed = baselineFromPlan(current.savedPlan, current.draft.date)
    if (isDraftDirty(current.draft, observed)) return
    if (current.draft.date !== observed.date) return
    setState((previous) =>
      isDraftDirty(previous.draft, previous.baseline)
        ? previous
        : { ...previous, baseline: baselineFromPlan(previous.savedPlan, previous.draft.date) },
    )
  }, [savedPlanIdentity])

  /* ------------------------- 选中任务的预填（一次） ------------------------- */

  const activeTasks = useMemo(
    () => store.data.tasks.filter((task) => task.status === 'TODO' || task.status === 'DOING'),
    [store.data.tasks],
  )

  /** 全部任务（不限状态）—— 用来判断已保存计划里的任务还在不在。 */
  const allTasksById = useMemo(() => {
    const map = new Map<number, Task>()
    for (const task of store.data.tasks) map.set(Number(task.id), task)
    return map
  }, [store.data.tasks])

  /* ------------------------------- 输入校验 ------------------------------- */

  const windowValidation = useMemo(() => validateStudyWindows(state.draft.windows), [state.draft.windows])

  const minutesErrors = useMemo(() => {
    const errors = new Map<number, string>()
    for (const selection of state.draft.selections) {
      if (selection.minutes.trim().length === 0) {
        errors.set(selection.taskId, '请填写今天打算投入的分钟数（1–1440）。')
        continue
      }
      if (normalizePlanMinutes(selection.minutes) === null) {
        errors.set(selection.taskId, '分钟数要是 1–1440 之间的整数。')
      }
    }
    return errors
  }, [state.draft.selections])

  const overSelectionLimit = state.draft.selections.length > MAX_SELECTED_TASKS
  const selectionLimitMessage = overSelectionLimit
    ? `最多只能选 ${MAX_SELECTED_TASKS} 个任务，现在选了 ${state.draft.selections.length} 个：请先取消一些。`
    : null

  /** 当前输入（草稿 + 真实上下文）的身份指纹；预览是否过期用它比对。 */
  const currentFingerprint: TodayPlanFingerprint | null = useMemo(() => {
    if (!windowValidation.ok) return null
    const selections: PlanSelection[] = []
    for (const selection of state.draft.selections) {
      const minutes = normalizePlanMinutes(selection.minutes)
      if (minutes === null) return null
      selections.push({ taskId: selection.taskId, minutes })
    }
    if (selections.length > MAX_SELECTED_TASKS) return null
    return todayPlanFingerprint({
      date: state.draft.date,
      windows: windowValidation.windows,
      selections,
      context: {
        tasks: store.data.tasks,
        schedules: store.data.schedules,
        courses: store.data.courses,
      },
    })
  }, [
    state.draft.date,
    state.draft.selections,
    store.data.courses,
    store.data.schedules,
    store.data.tasks,
    windowValidation,
  ])

  const previewInfo = useMemo(
    () => previewStatus({ preview: state.preview, draft: state.draft, currentFingerprint, now }),
    [currentFingerprint, now, state.draft, state.preview],
  )

  /** 已保存计划是否因为「上下文变了」需要提示（只读警告，不自动改）。 */
  const savedIssueInput = state.savedPlan
  const savedFingerprintNow = useMemo(() => {
    if (!savedIssueInput) return null
    const windows: StudyWindowInput[] = savedIssueInput.fingerprint.windows.map((label) => {
      const parts = label.split('-')
      return { start: parts[0] ?? '', end: parts[1] ?? '' }
    })
    const validation = validateStudyWindows(windows)
    if (!validation.ok) return null
    return todayPlanFingerprint({
      date: savedIssueInput.date,
      windows: validation.windows,
      selections: savedIssueInput.fingerprint.selections,
      context: {
        tasks: store.data.tasks,
        schedules: store.data.schedules,
        courses: store.data.courses,
      },
    })
  }, [savedIssueInput, store.data.courses, store.data.schedules, store.data.tasks])

  const savedContextChanged = useMemo(() => {
    if (!state.savedPlan || !savedFingerprintNow) return false
    return !sameTodayPlanFingerprint(state.savedPlan.fingerprint, savedFingerprintNow)
  }, [savedFingerprintNow, state.savedPlan])

  const savedIssues = useMemo(
    () => (state.savedPlan ? describeSavedPlanIssues(state.savedPlan, store.data.tasks, today) : []),
    [state.savedPlan, store.data.tasks, today],
  )

  /* -------------------------------- 动作 -------------------------------- */

  /**
   * 生成预览（只读，零写库）。
   *
   * 三条硬边界（复核 11）：
   * 1. **当场读表**：`now` 用这个动作执行的那一刻，而不是上一次焦点时钟的读数
   *    （页面挂着不动十几分钟后点「生成预览」不能还按旧时间排）；
   * 2. **跨零点守卫**：草稿日期不等于现在的上海日期时**直接拒绝并保留草稿**，
   *    绝不把昨天的计划排成今天的样子；
   * 3. **纯函数抛错也不崩界面**：`buildTodayPlan` 出错时把原因显示在页内，
   *    并把 `inputErrors`（输入层面的错误）一并展示出来。
   */
  const onGeneratePreview = useCallback(() => {
    if (inFlightRef.current) return
    const actionNow = readActionNow()
    const actionToday = shanghaiToday(actionNow)
    if (state.draft.date !== actionToday) {
      setState((previous) => ({
        ...previous,
        notice: {
          text: `这份草稿属于 ${previous.draft.date}，现在已经是 ${actionToday}：请先点「以今天重新开始」（草稿会保留到你确认）。`,
          tone: 'error',
        },
      }))
      return
    }
    if (!windowValidation.ok || selectionLimitMessage || minutesErrors.size > 0) return
    if (state.draft.selections.length === 0) return
    if (!currentFingerprint) return
    const selections: PlanSelection[] = state.draft.selections.map((selection) => ({
      taskId: selection.taskId,
      minutes: normalizePlanMinutes(selection.minutes)!,
    }))
    let plan: TodayPlan
    try {
      plan = buildTodayPlan({
        date: state.draft.date,
        now: actionNow,
        windows: state.draft.windows,
        selections,
        tasks: store.data.tasks,
        schedules: store.data.schedules,
        courses: store.data.courses,
      })
    } catch (cause) {
      setState((previous) => ({
        ...previous,
        preview: null,
        notice: {
          text: `生成预览时出错：${cause instanceof Error ? cause.message : String(cause)}`,
          tone: 'error',
        },
      }))
      return
    }
    if (plan.inputErrors.length > 0) {
      setState((previous) => ({
        ...previous,
        preview: null,
        notice: { text: plan.inputErrors.join(' '), tone: 'error' },
      }))
      return
    }
    const preview: TodayPlanPreview = {
      plan,
      fingerprint: currentFingerprint,
      generatedAtEpochMs: actionNow.getTime(),
    }
    setState((previous) => withPreview(previous, preview))
  }, [
    currentFingerprint,
    minutesErrors.size,
    selectionLimitMessage,
    state.draft.date,
    state.draft.selections,
    state.draft.windows,
    store.data.courses,
    store.data.schedules,
    store.data.tasks,
    windowValidation.ok,
  ])

  const commit = useCallback(async () => {
    if (inFlightRef.current) return
    const preview = state.preview
    if (!preview || previewInfo.stale) return
    if (!currentFingerprint) return
    if (!sameTodayPlanFingerprint(preview.fingerprint, currentFingerprint)) return
    inFlightRef.current = true
    /**
     * **保存开始时就把读回闸门往前推一格**：这一刻之前发出的读回全部作废，
     * 它们带的是保存之前的状态，绝不能让它们盖掉保存后的结果（复核 14 / 15）。
     */
    readGenerationRef.current += 1
    setState((previous) => withSaving(previous))
    try {
      /**
       * 保存时把**用户确认过的那份预览**交给仓库当证据：仓库会在事务里用新鲜数据 + 预览的
       * 分钟锚点重算，比对块身份；时间已经溜走导致块开始时间到达时会拒绝并请用户重新生成。
       * 界面**不给**任何块 —— 计划块只能由仓库算。
       */
      const result = await todayPlan.saveTodayPlan({
        date: state.draft.date,
        windows: state.draft.windows,
        selections: preview.fingerprint.selections.map((selection) => ({
          taskId: selection.taskId,
          minutes: selection.minutes,
        })),
        previewPlan: preview.plan,
        expectedRevision: state.savedRevision,
      })
      /**
       * 提交成功后立刻读回一次，再**一次性**决定状态：
       * - 读回成功 → `saved`（内容换成刚保存的那一份，版本号取较大者）；
       * - 读回失败 → `committedNoReadback`：保留「已提交」与版本号，**清掉旧内容**
       *   （上一版计划绝不能顶着新版本号显示成今天的计划），界面提示「已保存，但没读回来」。
       *
       * `load.discarded` 表示这次读回被更新的一次读回抢先了：那一份已经把最新内容写进状态，
       * 这里就不能再用旧结果去覆盖它，因此不传 `readback`（表示「保留现状」）。
       */
      const load = result.committed ? await loadSaved(state.draft.date) : null
      const merged = mergePostCommitRead(
        result,
        load
          ? { discarded: load.discarded, plan: load.plan, error: load.error, revision: load.revision }
          : null,
      )
      setState((previous) =>
        applyCommitResult(previous, merged, {
          readback: !load || load.discarded ? undefined : load.plan,
        }),
      )
    } catch (cause) {
      setState((previous) => applyCommitResult(previous, commitFailureResult(cause)))
    } finally {
      inFlightRef.current = false
    }
  }, [
    currentFingerprint,
    loadSaved,
    previewInfo.stale,
    state.draft.date,
    state.draft.windows,
    state.preview,
    state.savedRevision,
    todayPlan,
  ])

  const onAdopt = useCallback(() => {
    if (inFlightRef.current) return
    if (!state.preview || previewInfo.stale) return
    /**
     * 替换确认的判据是「**本机里已知有今天的计划记录**」，而不只是「当前读到了内容」：
     * 读回失败之后 `savedPlan` 已经被清掉，但记录与版本号还在 —— 那时**仍然必须确认**，
     * 否则一次读回失败就会把替换确认这道关悄悄绕过去（复核 15）。
     */
    if (knownSavedRecord) {
      setPendingReplace(true)
      return
    }
    void commit()
  }, [commit, knownSavedRecord, previewInfo.stale, state.preview])

  /** 跨零点后的显式「以今天重新开始」：清空草稿、换到新的一天、再读一次那天的计划。 */
  const onResetForNewDate = useCallback(() => {
    const actionToday = shanghaiToday(readActionNow())
    setState((previous) => resetForNewDate(previous, actionToday, null, 0))
    void loadSaved(actionToday)
  }, [loadSaved])

  /* --------------------------- 离开与替换的确认 --------------------------- */

  const dirty = isDraftDirty(state.draft, state.baseline)
  const pending = state.phase === 'saving'

  usePreventRemove(dirty || pending, ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (pending) return
    setPendingLeaveAction(data.action)
  })

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  /* -------------------------------- 渲染 -------------------------------- */

  const dateLabel = `${today} ${weekdayName(weekdayOfDateKey(today) ?? 1)}`
  const activePlan = previewInfo.stale ? null : state.preview?.plan ?? null
  const verification = activePlan ? verifyTodayPlan(activePlan) : null

  /** 把已保存计划的时段与选中任务放回输入区（显式的「照着改一版」动作）。 */
  const onLoadSavedIntoDraft = useCallback(() => {
    const saved = state.savedPlan
    if (!saved) return
    setState((previous) =>
      withDraft(previous, {
        date: previous.draft.date,
        windows:
          saved.fingerprint.windows.length > 0
            ? saved.fingerprint.windows.map((label) => {
                const parts = label.split('-')
                return { start: parts[0] ?? '', end: parts[1] ?? '' }
              })
            : previous.draft.windows,
        selections: saved.fingerprint.selections.map((selection) => ({
          taskId: selection.taskId,
          minutes: String(selection.minutes),
        })),
      }),
    )
  }, [state.savedPlan])

  const selectionRows = useMemo(() => {
    const selected = new Map(state.draft.selections.map((selection) => [selection.taskId, selection]))
    const ordered = [...activeTasks].sort((a, b) => {
      const leftSelected = selected.has(a.id) ? 0 : 1
      const rightSelected = selected.has(b.id) ? 0 : 1
      if (leftSelected !== rightSelected) return leftSelected - rightSelected
      return a.id - b.id
    })
    return ordered.map((task) => ({ task, selection: selected.get(task.id) ?? null }))
  }, [activeTasks, state.draft.selections])

  return (
    <>
      <ScreenScaffold title="今日学习计划" subtitle={`${dateLabel}（北京时间）· 按你填的学习时段和选中的任务排`}>
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}

        {store.status === 'loading' ? <LoadingState message="正在读取本机数据…" /> : null}
        {store.status === 'error' ? (
          <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
        ) : null}

        {store.status === 'ready' ? (
          <>
            {state.draft.date !== today ? (
              <SectionCard
                title="已经跨过零点"
                subtitle={`这份草稿属于 ${state.draft.date}，现在已经是 ${today}。昨天的时段与选中任务不会自动带到今天。`}
              >
                <View style={styles.buttonRow}>
                  <AppButton
                    label="以今天重新开始"
                    onPress={() => setPendingReset(true)}
                    compact
                    accessibilityLabel="以今天重新开始今日学习计划"
                    accessibilityHint="会清空草稿里的时段与选中任务，昨天的计划仍然保存在本机"
                  />
                </View>
              </SectionCard>
            ) : null}

            {savedError ? (
              <SectionCard title="已保存的计划读不出来" subtitle="这条记录仍然保留在本机，没有被改动">
                <Text style={styles.warnLine}>{savedError}</Text>
                <Text style={styles.note}>
                  这一条暂时无法使用；可以先生成并保存一份新的计划，或稍后再回来看看。
                </Text>
              </SectionCard>
            ) : null}

            {/* --------------------------- 1. 学习时段 --------------------------- */}
            <SectionCard
              title="今天的学习时段"
              subtitle={`最多 ${MAX_STUDY_WINDOWS} 段，点按选择时间；结束须晚于开始，不支持跨天`}
            >
              {state.draft.windows.map((window, index) => {
                const issue = windowValidation.issues.find((entry) => entry.index === index)
                return (
                  <View key={`window-${index}`} style={styles.windowRow}>
                    <View style={styles.windowFields}>
                      <TimeWheelField
                        label={`第 ${index + 1} 段开始`}
                        value={window.start}
                        onChange={(text) =>
                          setState((previous) => withDraft(previous, setStudyWindow(previous.draft, index, 'start', text)))
                        }
                        placeholder="选择开始时间"
                        disabled={pending}
                        error={
                          windowFieldError(window.start, '开始时间') ??
                          (issue && issue.field === 'start' ? issue.message : null)
                        }
                        hint="点按后用 24 小时制滚轮选择。"
                        identityKey={`today-window:${state.draft.date}:${index}:${window.start}:${window.end}`}
                        accessibilityLabel={`第 ${index + 1} 段学习时段开始时间`}
                        testID={`today-plan-window-${index}-start`}
                        style={styles.windowField}
                      />
                      <TimeWheelField
                        label={`第 ${index + 1} 段结束`}
                        value={window.end}
                        onChange={(text) =>
                          setState((previous) => withDraft(previous, setStudyWindow(previous.draft, index, 'end', text)))
                        }
                        placeholder="选择结束时间"
                        disabled={pending}
                        error={
                          windowFieldError(window.end, '结束时间') ?? (issue && issue.field === 'end' ? issue.message : null)
                        }
                        hint="同一天内结束必须晚于开始，不支持跨天。"
                        identityKey={`today-window:${state.draft.date}:${index}:${window.start}:${window.end}`}
                        accessibilityLabel={`第 ${index + 1} 段学习时段结束时间`}
                        testID={`today-plan-window-${index}-end`}
                        style={styles.windowField}
                      />
                    </View>
                    <AppButton
                      label="删除这一段"
                      variant="ghost"
                      compact
                      onPress={() => setState((previous) => withDraft(previous, removeStudyWindow(previous.draft, index)))}
                      disabled={pending || state.draft.windows.length <= 1}
                      accessibilityLabel={`删除第 ${index + 1} 段学习时段`}
                    />
                  </View>
                )
              })}
              {windowValidation.issues.length > 0 ? (
                <View accessibilityRole="alert">
                  {windowValidation.issues.map((issue) => (
                    <Text key={`${issue.index}-${issue.field}`} style={styles.errorLine}>
                      {issue.message}
                    </Text>
                  ))}
                </View>
              ) : null}
              <View style={styles.buttonRow}>
                <AppButton
                  label={`加一段（最多 ${MAX_STUDY_WINDOWS} 段）`}
                  variant="secondary"
                  compact
                  onPress={() => setState((previous) => withDraft(previous, addStudyWindow(previous.draft)))}
                  disabled={pending || state.draft.windows.length >= MAX_STUDY_WINDOWS}
                  accessibilityLabel="再加一段学习时段"
                />
              </View>
              <Text style={styles.note}>
                空白 = 今天没有时段（应用不会替你猜空闲时间）。已经过去的时段会自动从「现在」之后开始算。
              </Text>
            </SectionCard>

            {/* --------------------------- 2. 选中任务 --------------------------- */}
            <SectionCard
              title="今天要做哪些任务"
              subtitle={`最多选 ${MAX_SELECTED_TASKS} 个；每个都要填今天打算投入的分钟数（1–1440）。已完成 / 已取消的任务不会出现在这里`}
            >
              {selectionLimitMessage ? <Text style={styles.errorLine}>{selectionLimitMessage}</Text> : null}
              {selectionRows.length === 0 ? (
                <EmptyState
                  title="还没有待办任务"
                  description="先建一个任务，再回来把它排进今天的计划。"
                  actionLabel="新建任务"
                  onAction={() => navigation.navigate('TaskForm', {})}
                />
              ) : (
                selectionRows.map(({ task, selection }) => (
                  <SelectionRow
                    key={task.id}
                    task={task}
                    courseName={store.courseById(task.courseId)?.name ?? null}
                    selected={selection !== null}
                    minutes={selection?.minutes ?? ''}
                    error={selection ? minutesErrors.get(task.id) ?? null : null}
                    disabled={pending}
                    onToggle={() =>
                      setState((previous) => withDraft(previous, toggleTaskSelection(previous.draft, task.id)))
                    }
                    onChangeMinutes={(text) =>
                      setState((previous) => withDraft(previous, setSelectionMinutes(previous.draft, task.id, text)))
                    }
                    onOpenTask={() => navigation.navigate('TaskDetail', { id: task.id })}
                    onEditTask={() => navigation.navigate('TaskForm', { id: task.id })}
                  />
                ))
              )}
              <Text style={styles.note}>
                开始或结束时间与这里的 DDL 不一致时，计划只按「截止时间之前」来排，不会动任务的任何字段。
              </Text>
            </SectionCard>

            {/* --------------------------- 3. 生成预览 --------------------------- */}
            <SectionCard title="生成预览" subtitle="先看一份只读的计划；不点「采用并保存」就不会写入本机">
              <View style={styles.buttonRow}>
                <AppButton
                  label="生成预览"
                  onPress={onGeneratePreview}
                  disabled={
                    pending ||
                    state.draft.date !== today ||
                    !windowValidation.ok ||
                    Boolean(selectionLimitMessage) ||
                    minutesErrors.size > 0 ||
                    state.draft.selections.length === 0
                  }
                  accessibilityLabel="生成今日学习计划预览"
                  accessibilityHint="只生成只读预览，不会保存，也不会改动任务"
                />
              </View>
              <Text style={styles.note}>
                按截止时间优先生成，可提前调整；任务计划分钟数不等于剩余工作量。
              </Text>
            </SectionCard>

            {/* ----------------------------- 4. 预览 ----------------------------- */}
            {activePlan ? (
              <SectionCard
                title="预览：排出来的计划"
                subtitle={`${activePlan.date} 生成于 ${formatClock(state.preview?.generatedAtEpochMs ?? now.getTime())} · 只读`}
              >
                <View style={styles.badgeRow}>
                  <Badge text={`计划分钟数合计 ${formatMinutes(activePlan.targetMinutes)}`} tone="neutral" />
                  <Badge text={`已排 ${formatMinutes(activePlan.scheduledMinutes)}`} tone="primary" />
                  {activePlan.unscheduledMinutes > 0 ? (
                    <Badge text={`未排 ${formatMinutes(activePlan.unscheduledMinutes)}`} tone="clay" />
                  ) : null}
                </View>

                {activePlan.windowLabels.length === 0 ? (
                  <Text style={styles.warnLine}>今天没有可用的学习时段。</Text>
                ) : (
                  <Text style={styles.note}>
                    可用时段：{activePlan.windowLabels.join('、')}
                    {activePlan.freeSlots.length > 0
                      ? ` · 其中空闲：${activePlan.freeSlots.map((slot) => `${slot.start}-${slot.end}`).join('、')}`
                      : ''}
                  </Text>
                )}
                {activePlan.busyIntervals.length > 0 ? (
                  <Text style={styles.note}>
                    上课时间（整段算忙，课间也算）：{activePlan.busyIntervals.map((busy) => `${busy.start}-${busy.end}`).join('、')}
                  </Text>
                ) : null}

                {activePlan.emptyPlan ? (
                  <Text style={styles.warnLine}>
                    这段时间一块都排不进去。可以检查：时段是不是已经过去、是不是正好和上课时间重叠、或者把计划分钟数改小一点。
                  </Text>
                ) : (
                  activePlan.blocks.map((block, index) => (
                    <View key={`block-${block.taskId}-${block.startMinute}-${index}`} style={styles.blockRow}>
                      <Text style={styles.blockTime}>
                        {block.startTime}-{block.endTime}
                      </Text>
                      <View style={styles.blockMain}>
                        <Text style={styles.blockTitle}>{block.taskTitle}</Text>
                        <Text style={styles.blockMeta}>
                          {formatMinutes(block.minutes)} · 时段 {block.windowLabel}
                        </Text>
                      </View>
                    </View>
                  ))
                )}

                {activePlan.outcomes.map((outcome) => (
                  <View key={`outcome-${outcome.taskId}`} style={styles.outcomeRow}>
                    <Text style={styles.outcomeTitle}>{outcome.taskTitle}</Text>
                    <Text style={styles.outcomeMeta}>
                      计划 {outcome.targetMinutes} 分钟 · 已排 {outcome.scheduledMinutes} 分钟 · 未排{' '}
                      {outcome.unscheduledMinutes} 分钟
                      {outcome.unscheduled ? `（${outcome.unscheduled.text}）` : ''}
                    </Text>
                  </View>
                ))}

                {verification && !verification.ok ? (
                  <Text style={styles.errorLine}>预览自检未通过：{verification.errors[0]}</Text>
                ) : null}

                {activePlan.warnings.length > 0 ? (
                  <View accessibilityRole="alert">
                    {activePlan.warnings.map((warning) => (
                      <Text key={warning} style={styles.warnLine}>
                        {warning}
                      </Text>
                    ))}
                  </View>
                ) : null}

                <View style={styles.buttonRow}>
                  <AppButton
                    label={knownSavedRecord ? '采用并替换今天的计划' : '采用并保存'}
                    onPress={onAdopt}
                    loading={pending}
                    disabled={pending || previewInfo.stale}
                    accessibilityLabel="采用并保存今天的计划"
                    accessibilityHint="会保存到本机；如果今天已经有计划，会先请你确认替换"
                  />
                  <AppButton
                    label="重新生成"
                    variant="secondary"
                    compact
                    onPress={onGeneratePreview}
                    disabled={pending}
                    accessibilityLabel="重新生成预览"
                  />
                </View>
                <Text style={styles.note}>
                  保存之后才会写进本机；保存不会改动任务的截止时间、状态或预计用时，也不会把任务标记成完成。
                </Text>
              </SectionCard>
            ) : state.preview ? (
              <SectionCard title="预览已经过期" subtitle="输入或相关任务 / 课表变了">
                <Text style={styles.warnLine}>{previewInfo.message ?? '请重新生成预览。'}</Text>
              </SectionCard>
            ) : null}

            {/* --------------------------- 5. 已保存计划 --------------------------- */}
            <SectionCard
              title="今天已保存的计划"
              subtitle={
                loadingSaved
                  ? '正在读取…'
                  : state.savedPlan
                    ? `版本 ${state.savedRevision} · ${state.savedPlan.date}`
                    : committedAwaitingRefresh
                      ? `已保存（版本 ${state.savedRevision}），这次没读回来`
                      : storedOtherDate
                        ? '本机里保存的是别的一天的计划（不会当成今天的）'
                        : knownSavedRecord
                          ? `本机有今天的计划记录（版本 ${state.savedRevision}），但内容读不出来`
                          : '今天还没有保存过计划'
              }
            >
              {state.savedPlan === null && knownSavedRecord ? (
                <>
                  <Text style={styles.warnLine}>
                    {committedAwaitingRefresh
                      ? `刚才那份计划已经保存（版本 ${state.savedRevision}），只是这一次没能读回内容。`
                      : `本机里今天的计划记录（版本 ${state.savedRevision}）现在读不出来。`}
                    为避免把旧内容当成新的，这里暂时不显示任何块。
                  </Text>
                  <View style={styles.buttonRow}>
                    <AppButton
                      label="重新读一次"
                      variant="secondary"
                      compact
                      onPress={() => void loadSaved(state.draft.date)}
                      disabled={loadingSaved}
                      accessibilityLabel="重新读取已保存的今日计划"
                    />
                  </View>
                </>
              ) : null}
              {state.savedPlan ? (
                <>
                  {savedContextChanged ? (
                    <Text style={styles.warnLine}>
                      相关任务 / 课表在保存之后改过：下面的块仍然保留原样（这是你当时排的），需要的话请重新生成一份。
                    </Text>
                  ) : null}
                  {savedIssues.length > 0 ? (
                    <View accessibilityRole="alert">
                      {savedIssues.map((issue) => (
                        <Text key={`${issue.taskId}-${issue.text}`} style={styles.warnLine}>
                          {issue.taskTitle}：{issue.text}
                        </Text>
                      ))}
                    </View>
                  ) : null}
                  <View style={styles.badgeRow}>
                    <Badge text={`已排 ${formatMinutes(state.savedPlan.scheduledMinutes)}`} tone="primary" />
                    {state.savedPlan.unscheduledMinutes > 0 ? (
                      <Badge text={`未排 ${formatMinutes(state.savedPlan.unscheduledMinutes)}`} tone="clay" />
                    ) : null}
                  </View>
                  {state.savedPlan.blocks.length === 0 ? (
                    <Text style={styles.note}>这份计划里没有任何块。</Text>
                  ) : (
                    state.savedPlan.blocks.map((block, index) => {
                      // 计划里存的是**任务标题快照**；任务还在就点得进详情，任务被删了就只读。
                      const liveTask = allTasksById.get(block.taskId) ?? null
                      const label = `${block.startTime}-${block.endTime}`
                      return (
                        <Pressable
                          key={`saved-${block.taskId}-${block.startMinute}-${index}`}
                          onPress={liveTask ? () => navigation.navigate('TaskDetail', { id: liveTask.id }) : undefined}
                          disabled={liveTask === null}
                          accessibilityRole={liveTask ? 'button' : 'text'}
                          accessibilityState={{ disabled: liveTask === null }}
                          accessibilityLabel={
                            liveTask
                              ? `${label} 任务 ${block.taskTitle}，查看任务详情`
                              : `${label} 任务 ${block.taskTitle}（任务已不存在，无法打开）`
                          }
                          style={({ pressed }) => [styles.blockRow, liveTask ? pressed && styles.pressed : null]}
                        >
                          <Text style={styles.blockTime}>{label}</Text>
                          <View style={styles.blockMain}>
                            <Text style={styles.blockTitle}>{block.taskTitle}</Text>
                            <Text style={styles.blockMeta}>
                              {formatMinutes(block.minutes)}
                              {liveTask ? ' · 点这一行看任务详情' : ' · 任务已不存在'}
                            </Text>
                          </View>
                        </Pressable>
                      )
                    })
                  )}
                  <Text style={styles.note}>
                    这份计划只是安排，不会自动改任务状态：任务完成要靠你自己在任务页勾选。
                  </Text>
                </>
              ) : (
                <Text style={styles.note}>
                  还没有保存过今天的计划。上面生成的预览是只读的；点「采用并保存」才会写入本机。
                </Text>
              )}
              {state.savedPlan ? (
                <View style={styles.buttonRow}>
                  <AppButton
                    label="把已保存的计划读回输入区"
                    variant="secondary"
                    compact
                    onPress={onLoadSavedIntoDraft}
                    disabled={pending}
                    accessibilityLabel="把已保存计划读回输入框"
                    accessibilityHint="把已保存的时段与选中任务放回输入区，方便改一版新的"
                  />
                </View>
              ) : null}
            </SectionCard>

            {state.notice ? (
              <SectionCard title="上一次操作的结果">
                <Text style={state.notice.tone === 'success' ? styles.note : styles.errorLine}>{state.notice.text}</Text>
              </SectionCard>
            ) : null}
          </>
        ) : null}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingReplace}
        title="替换今天已经保存的计划？"
        message="今天已经有一份保存好的计划。替换会写入新的版本；旧的那份不会自动保留备份。"
        details={[
          '任务本身不会被改动（DDL、状态、预计用时都不变）。',
          '旧计划里的块会被新计划替换掉。',
        ]}
        confirmLabel="替换并保存"
        busy={pending}
        onConfirm={() => {
          setPendingReplace(false)
          void commit()
        }}
        onCancel={() => setPendingReplace(false)}
      />

      <ConfirmDialog
        visible={pendingReset}
        title="以今天重新开始？"
        message={`草稿里 ${state.draft.date} 的时段与选中任务会被清空。`}
        details={['本机里保存的计划不会被删除。', '清空后需要重新填时段、重新选任务。']}
        confirmLabel="清空并重新开始"
        danger
        onConfirm={() => {
          setPendingReset(false)
          onResetForNewDate()
        }}
        onCancel={() => setPendingReset(false)}
      />

      <ConfirmDialog
        visible={pendingLeaveAction !== null && !pending}
        title="离开并丢弃这份草稿？"
        message="时段与选中任务还没有保存成计划。"
        details={['点「采用并保存」会把它写进本机。', '离开不会影响已经保存过的那份计划。']}
        confirmLabel="丢弃并离开"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeaveAction(null)}
      />

      {state.notice ? <Toast text={state.notice.text} tone={state.notice.tone} /> : null}
    </>
  )
}

/* -------------------------------- 子组件 -------------------------------- */

function SelectionRow({
  task,
  courseName,
  selected,
  minutes,
  error,
  disabled,
  onToggle,
  onChangeMinutes,
  onOpenTask,
  onEditTask,
}: {
  task: Task
  courseName: string | null
  selected: boolean
  minutes: string
  error: string | null
  disabled: boolean
  onToggle: () => void
  onChangeMinutes: (text: string) => void
  onOpenTask: () => void
  onEditTask: () => void
}): React.ReactElement {
  const note = prefillNote(task)
  return (
    <View style={[styles.taskRow, selected && styles.taskRowSelected]}>
      <Pressable
        onPress={onToggle}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected, disabled }}
        accessibilityLabel={`选中任务 ${task.title}`}
        style={({ pressed }) => [styles.taskMain, pressed && styles.pressed]}
      >
        <Text style={styles.taskTitle}>
          {selected ? '☑ ' : '☐ '}
          {task.title}
        </Text>
        <Text style={styles.taskMeta}>
          {courseName ? `${courseName} · ` : '未关联课程 · '}
          {task.status === 'DOING' ? '进行中 · ' : '待办 · '}
          优先级 {task.priority}
        </Text>
        <Text style={styles.taskMeta}>DDL {task.deadline ? shanghaiDeadlineLabel(task.deadline) : '未设置'}</Text>
        {task.estimatedMinutes === null ? (
          <Text style={styles.taskMeta}>没有填过预计用时</Text>
        ) : (
          <Text style={styles.taskMeta}>预计用时 {task.estimatedMinutes} 分钟（任务自己的值，不会被这里改动）</Text>
        )}
      </Pressable>
      <View style={styles.taskActions}>
        {selected ? (
          <AppTextField
            label="本次安排分钟数"
            value={minutes}
            onChangeText={onChangeMinutes}
            placeholder="例如 60"
            keyboardType="number-pad"
            editable={!disabled}
            error={error}
            hint={error ? undefined : note ?? '必须自己填：应用不会替你估一个数。'}
            style={styles.minutesField}
            accessibilityLabel={`任务 ${task.title} 的本次安排分钟数`}
          />
        ) : null}
        <View style={styles.buttonRow}>
          <AppButton label="任务详情" variant="ghost" compact onPress={onOpenTask} accessibilityLabel={`查看任务 ${task.title}`} />
          <AppButton label="编辑任务" variant="ghost" compact onPress={onEditTask} accessibilityLabel={`编辑任务 ${task.title}`} />
        </View>
      </View>
    </View>
  )
}

/* --------------------------------- 工具 --------------------------------- */

function formatClock(epochMs: number): string {
  const date = new Date(epochMs)
  if (!Number.isFinite(date.getTime())) return '—'
  const wall = new Date(date.getTime() + 480 * 60_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
}

/* --------------------------------- 样式 --------------------------------- */

const styles = StyleSheet.create({
  note: { ...typography.caption, marginTop: spacing.sm },
  warnLine: { ...typography.caption, color: colors.clay, marginTop: spacing.sm },
  errorLine: { ...typography.caption, color: colors.clayDark, marginTop: spacing.xs, fontWeight: '600' },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  pressed: { opacity: 0.8 },

  windowRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
    marginBottom: spacing.sm,
  },
  // Each picker needs its own full row: placeholder, action and hint must fit on small phones.
  windowFields: { flexDirection: 'column', alignItems: 'stretch', gap: spacing.xs, minWidth: 0 },
  windowField: { width: '100%', minWidth: 0 },
  minutesField: { minWidth: 160, flexGrow: 1 },

  taskRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  taskRowSelected: { backgroundColor: colors.primaryTint, borderRadius: radius.sm, paddingHorizontal: spacing.sm },
  taskMain: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  taskTitle: { ...typography.body, fontWeight: '600' },
  taskMeta: { ...typography.caption, marginTop: 2 },
  taskActions: { gap: spacing.sm },

  blockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  blockTime: { ...typography.mono, minWidth: 108 },
  blockMain: { flex: 1 },
  blockTitle: { ...typography.body, fontWeight: '600' },
  blockMeta: { ...typography.caption, marginTop: 2 },

  outcomeRow: { paddingVertical: spacing.xs },
  outcomeTitle: { ...typography.label },
  outcomeMeta: { ...typography.caption },
})
