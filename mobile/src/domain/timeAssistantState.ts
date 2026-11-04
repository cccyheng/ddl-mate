/**
 * 时间助手「交互状态」纯函数 —— 不做任何数据库写入，可脱离 React 直接测试。
 *
 * 为什么要有这一层：界面里最容易出错、也最难在真机上复现的，是**过期建议**。
 * 用户点了「解析」之后又改了短语 / 参考时间 / 课程 / 课表，或者手工改了截止时间，
 * 旧建议必须立刻作废；采用时还要用**最新**的输入再校验一次。
 * 这些规则全部写在这里（纯函数），组件只负责渲染与派发动作。
 *
 * 四个不变的保证：
 * 1. **只有显式采用**才会返回要写入草稿的时间（`adopt` 动作），解析本身不改任何草稿；
 * 2. 短语 / 参考时间 / 课程 / 课表快照 / 手工改截止时间，任一变化都让已展示的建议作废；
 * 3. 采用时必须用最新输入重新校验（`adopt` 会重新算一遍上下文与建议是否仍然有效）；
 * 4. 手工填写的时间永远保留：助手只在「采用」那一次写入，写完之后仍可继续手改。
 */

import { isAlreadyElapsed, resolveTimeAssistant, type TimeAssistantResult } from './timeAssistant'
import type { Course, Schedule } from './types'

export type AssistantRequestStatus = 'idle' | 'resolved' | 'invalid'

/** 课程快照里参与「过期判定」的字段：选中的课是否存在、叫什么、内部编号是什么。 */
export type AssistantCourseInput = Pick<Course, 'id' | 'name'> & { code?: string | null }

export interface AssistantContextInput {
  phrase: string
  /** 通知参考时间（北京墙上时间 `YYYY-MM-DDTHH:mm`）。 */
  referenceWallClock: string
  courseId: number | null
  schedules: ReadonlyArray<Schedule>
  /**
   * 课程快照（**必填**）：选中的课被删除 / 改名 / 换编号时，已展示的建议必须作废，
   * 采用时也必须重新校验这门课还在不在。
   */
  courses: ReadonlyArray<AssistantCourseInput>
}

export interface AssistantState {
  /** 上一次解析时冻结的上下文；为 `null` 表示还没解析过。 */
  contextKey: string | null
  requestStatus: AssistantRequestStatus
  /** 只对「输入不合法」给出的可见校验，与解析结论分开。 */
  requestError: string | null
  /** 最近一次解析的结论（`invalid` 时为 `null`，用 `requestError` 说明）。 */
  resolution: TimeAssistantResult | null
  /** 用户是否已经点过「采用此时间」。 */
  adopted: boolean
  /** 当前建议对应的截止时间（采用后就是它）；`null` 表示还没有建议。 */
  baselineDeadline: string | null
  /** 已展示建议是否已经过期（上下文变了或手工改了截止时间）。 */
  stale: boolean
}

export const initialAssistantState: AssistantState = {
  contextKey: null,
  requestStatus: 'idle',
  requestError: null,
  resolution: null,
  adopted: false,
  baselineDeadline: null,
  stale: false,
}

/** 状态机接受的动作。**没有 `adopt`**：采用由 {@link prepareAdoption} 在事件处理器里结算。 */
export type AssistantAction =
  | { type: 'resolve'; result: TimeAssistantResult }
  | { type: 'invalid'; error: string }
  | { type: 'clear' }

/**
 * 上下文指纹：短语 / 参考时间 / 课程 / **课表快照 + 课程快照本身**。
 *
 * 用快照内容而不是数组引用：后台刷新会产生新的数组对象，但内容相同时不应该让建议失效；
 * 反过来，课表或课程被改动（哪怕只是上课时间从 08:00 变 08:30、或选中的课被改名 / 删除）时
 * 内容一定不同，建议必须作废。
 */
export function assistantContextKey(input: AssistantContextInput): string {
  const schedules = [...input.schedules]
    .map((schedule) => ({
      id: schedule.id,
      courseId: schedule.courseId,
      weekday: schedule.weekday,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      location: schedule.location ?? '',
      semesterStartDate: schedule.semesterStartDate ?? '',
      startWeek: schedule.startWeek === null || schedule.startWeek === undefined ? '' : String(schedule.startWeek),
      endWeek: schedule.endWeek === null || schedule.endWeek === undefined ? '' : String(schedule.endWeek),
      weekPattern: schedule.weekPattern ?? 'ALL',
    }))
    .sort((left, right) => left.id - right.id)
    .map(
      (schedule) =>
        `${schedule.id}/${schedule.courseId}/${schedule.weekday}/${schedule.startTime}/${schedule.endTime}/` +
        `${schedule.location}/${schedule.semesterStartDate}/${schedule.startWeek}/${schedule.endWeek}/${schedule.weekPattern}`,
    )
  const courses = [...input.courses]
    .map((course) => `${course.id}/${course.name ?? ''}/${course.code ?? ''}`)
    .sort()
  return [
    input.phrase.trim(),
    input.referenceWallClock.trim(),
    input.courseId === null ? 'none' : String(input.courseId),
    schedules.join('|'),
    courses.join('|'),
  ].join('\u0001')
}

/** 选择的那门课现在还在不在课程快照里（被删除 / 列表刷新掉之后就是 `false`）。 */
export function isSelectedCourseAvailable(input: AssistantContextInput): boolean {
  if (input.courseId === null) return false
  return input.courses.some((course) => course.id === input.courseId)
}

/** 当前输入与已展示建议的上下文是否已经不一致。 */
export function isContextChanged(state: AssistantState, contextKey: string): boolean {
  return state.contextKey !== null && state.contextKey !== contextKey
}

/** 截止时间是否在建议展示之后被手工改过（或换成了别的时间）。 */
export function isDeadlineChanged(state: AssistantState, deadline: string): boolean {
  return state.baselineDeadline !== null && state.baselineDeadline !== deadline
}

/**
 * 上下文 / 截止时间变化后，判断已展示建议是否作废。
 *
 * 说明：解析**不会**改动截止时间，所以 `deadline` 在这里只可能是用户手工改的（或来自后台刷新）。
 */
export function isStale(state: AssistantState, contextKey: string, deadline: string): boolean {
  if (state.requestStatus !== 'resolved' || state.resolution === null) return false
  return isContextChanged(state, contextKey) || isDeadlineChanged(state, deadline)
}

/**
 * 状态迁移入口：只处理**没有副作用**的三种动作（解析结论 / 输入不合法 / 清空）。
 *
 * 「采用」刻意不在这里：它要写父组件的草稿，属于副作用，必须由
 * {@link prepareAdoption} 在事件处理器里结算后单独处理。
 *
 * @param deadline 当前任务草稿里的截止时间（`YYYY-MM-DDTHH:mm`，空串表示未设置）
 */
export function stepAssistantState(
  state: AssistantState,
  action: AssistantAction,
  input: AssistantContextInput,
  deadline: string,
): AssistantState {
  const contextKey = assistantContextKey(input)

  switch (action.type) {
    case 'resolve':
      return {
        contextKey,
        requestStatus: 'resolved',
        requestError: null,
        resolution: action.result,
        adopted: false,
        baselineDeadline: deadline,
        stale: false,
      }
    case 'invalid':
      return {
        contextKey,
        requestStatus: 'invalid',
        requestError: action.error,
        resolution: null,
        adopted: false,
        baselineDeadline: null,
        stale: false,
      }
    case 'clear':
      return { ...initialAssistantState }
    default:
      return state
  }
}

/** 已展示建议里的第一条候选（没有建议时为 `null`）。 */
export function candidateOf(state: AssistantState) {
  if (state.requestStatus !== 'resolved' || state.resolution === null) return null
  return state.resolution.candidates[0] ?? null
}

/** 现在能不能点「采用此时间」。 */
export function canAdopt(
  state: AssistantState,
  contextKey: string,
  deadline: string,
  input?: AssistantContextInput,
): boolean {
  if (state.requestStatus !== 'resolved' || state.resolution === null) return false
  if (state.adopted) return false
  if (isStale(state, contextKey, deadline)) return false
  // 选中的课被删除 / 已经不在课程快照里 → 不能采用（还要重新解析）
  if (input && !isSelectedCourseAvailable(input)) return false
  return (state.resolution.candidates[0] ?? null) !== null
}

/** 组件用的便捷入口：先按最新输入判定过期，再决定能否采用。 */
export function assistantView(
  state: AssistantState,
  input: AssistantContextInput,
  deadline: string,
  now: Date = new Date(),
) {
  const contextKey = assistantContextKey(input)
  const candidate = candidateOf(state)
  const stale = isStale(state, contextKey, deadline)
  return {
    contextKey,
    status: state.requestStatus,
    error: state.requestError,
    resolution: state.resolution,
    candidate,
    adopted: state.adopted,
    stale,
    /** 选择的那门课现在还在不在（被删除时用来解释为什么不能采用）。 */
    selectedCourseAvailable: isSelectedCourseAvailable(input),
    /** 建议的时间按**真实当前时刻**算是不是已经过去了（与「早于参考时间」是两件事）。 */
    alreadyElapsed: candidate ? isAlreadyElapsed(candidate.wallClock, now) : false,
    canAdopt: canAdopt(state, contextKey, deadline, input),
  }
}

/** 重新解析（解析器是纯函数，所以这里不需要任何副作用）。 */
export function resolveForState(input: {
  phrase: string
  referenceWallClock: string
  courseId: number | null
  courses: ReadonlyArray<AssistantCourseInput>
  schedules: ReadonlyArray<Schedule>
}): { error: string | null; result: TimeAssistantResult | null } {
  if (input.phrase.trim().length === 0) {
    return { error: '请先写一个简短的时间短语，例如「明天晚上8点」或「本周五 18:00」。', result: null }
  }
  if (input.referenceWallClock.trim().length === 0) {
    // 参考时间被清空时必须**如实报错**，绝不偷偷换回「现在」：那会把相对时间算到另一天。
    return { error: '通知参考时间不能为空：请填写时间，或点「重新设为现在」。', result: null }
  }
  const result = resolveTimeAssistant({
    text: input.phrase,
    referenceAt: input.referenceWallClock,
    courseId: input.courseId,
    courses: input.courses,
    schedules: input.schedules,
  })
  if (result.status === 'NEEDS_INFO' && result.referenceAt === '') {
    return { error: result.message, result: null }
  }
  return { error: null, result }
}

/** 一次「采用」的纯结算结果：`adoptedWallClock` 为 `null` 表示这次采用无效、什么都不该写。 */
export interface AdoptionPreparation {
  next: AssistantState
  adoptedWallClock: string | null
}

/**
 * 「采用此时间」的**纯结算**：把全部校验与状态迁移算完，返回「下一个状态 + 要写入的时间」。
 *
 * 存在的理由（复核点名）：React 的 `setState(updater)` 里的 updater **必须是纯函数**，
 * 可能在渲染期被重放 / 延迟执行。如果在 updater 里调用父组件的 `onAdoptDeadline`，
 * 就会出现「回调被调用多次」或「在渲染期更新别的组件」。
 * 所以这里把结算完全放在**事件处理器**里：算完 → `setState(next)` → 只有在
 * `adoptedWallClock !== null` 时**调用一次**父回调，updater 里没有任何副作用。
 *
 * 结算内容（全部基于**最新**输入，而不是缓存展示结果）：
 * 1. 展示的建议必须还在、采用条件仍成立（`canAdopt`：未过期、未采用、候选仍在、选中的课仍存在）；
 * 2. 用最新输入**重新解析**一次，并与展示的候选逐字段比对；不一致（例如课表已被改动）就不采用，
 *    由用户重新解析后再点。
 */
export function prepareAdoption(
  state: AssistantState,
  input: AssistantContextInput,
  deadline: string,
): AdoptionPreparation {
  const contextKey = assistantContextKey(input)
  if (!canAdopt(state, contextKey, deadline, input)) return { next: state, adoptedWallClock: null }

  const displayed = candidateOf(state)
  if (!displayed) return { next: state, adoptedWallClock: null }

  const { error, result } = resolveForState(input)
  const fresh = error || !result ? null : (result.candidates[0] ?? null)
  if (!fresh || !sameCandidate(fresh, displayed)) return { next: state, adoptedWallClock: null }

  return {
    next: { ...state, adopted: true, baselineDeadline: displayed.wallClock, stale: false },
    adoptedWallClock: displayed.wallClock,
  }
}

/** 两条候选是不是同一个时间点（只比会写进草稿的东西与展示依赖的课表信息）。 */
function sameCandidate(
  left: TimeAssistantResult['candidates'][number],
  right: TimeAssistantResult['candidates'][number],
): boolean {
  return (
    left.wallClock === right.wallClock &&
    left.courseId === right.courseId &&
    left.scheduleId === right.scheduleId &&
    left.scheduleDate === right.scheduleDate &&
    left.scheduleStartTime === right.scheduleStartTime
  )
}
