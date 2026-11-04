/**
 * 「任务步骤清单」界面的**状态机**（纯函数，无 React / 无数据库）。
 *
 * 界面里有四份东西必须**同时存在**、而且互相不能覆盖：
 * 1. **草稿**：用户正在编辑的步骤（可能还没保存）；
 * 2. **干净基线**：草稿当初基于的那一份已保存内容（与草稿一致 = 没有未保存改动）；
 * 3. **草稿基版本** (`draftBaseRevision`)：草稿基于哪一版（保存时**只**用它当乐观锁依据）；
 * 4. **已知最新版本** (`latestRevision`)：后台读到的最大版本（只增）。
 *
 * 三条硬规则（授权书 + 复核点名）：
 * - **刷新绝不覆盖脏草稿**：后台读到更新版本时只更新 `latestRevision` 并立起
 *   `conflict` 标记，绝不动草稿、也绝不动 `draftBaseRevision`；
 *   否则用户基于版本 1 改的草稿会拿版本 2 去保存，把从没看过的内容覆盖掉；
 * - **草稿只在两处被整份替换**：初次加载 / 草稿干净时的刷新，以及用户**显式确认**
 *   「载入最新版本（丢弃草稿）」。没有第二次「顺手补一下草稿」的写入口；
 * - **读回失败不能把「已经提交」改写掉**：版本号只增不减，读失败时如实记录原因，
 *   界面提示「已保存但暂时无法读取」并只提供重试读取，绝不把旧内容当成刚保存的那一份。
 */

import {
  MAX_TASK_STEPS,
  TASK_STEP_TITLE_MAX,
  clampStepTitleInput,
  normalizeStepTitle,
  progressOf,
  validateTaskSteps,
  type TaskStep,
} from '../domain/taskSteps'

/** 草稿里的一步：`title` 是**用户输入原文**（可以被改坏，由校验负责拦住）。 */
export interface TaskStepsDraftStep {
  id: string
  title: string
  done: boolean
}

/** 「干净」基线：与草稿一致就表示没有未保存的改动。 */
export interface TaskStepsBaseline {
  steps: TaskStep[]
  revision: number
}

export type TaskStepsPhase = 'idle' | 'saving' | 'saved' | 'committedNoReadback' | 'rejected'

/** 读取失败的类别：父任务不在 / 记录坏了 / 任务编号不合法 / 其它读错误 / 数据库还没准备好。 */
export type TaskStepsReadErrorCode =
  | 'PARENT_MISSING'
  | 'CORRUPT'
  | 'INVALID_TASK'
  | 'READ_FAILED'
  | 'NOT_READY'

export interface TaskStepsState {
  draft: TaskStepsDraftStep[]
  baseline: TaskStepsBaseline
  /** 草稿基于的版本号；保存时**唯一**的 `expectedRevision` 来源。 */
  draftBaseRevision: number
  /** 后台读到过的最新版本号（只增；只用于判断「别处有更新」）。 */
  latestRevision: number
  /** 是否已经成功完成过一次初始读取（在此之前不允许编辑 / 保存）。 */
  loaded: boolean
  /** 写入是否**已经提交**（读回失败时同样为 `true`）。 */
  committed: boolean
  phase: TaskStepsPhase
  notice: { text: string; tone: 'success' | 'error' } | null
  /** 这一次读取失败的真实原因（与「没有步骤」严格区分）。 */
  readError: string | null
  readErrorCode: TaskStepsReadErrorCode | null
  /** 脏草稿遇到了更新的版本：必须由用户显式选择「载入最新（丢弃草稿）」。 */
  conflict: boolean
}

/* -------------------------------- 初始状态 -------------------------------- */

export function emptyBaseline(): TaskStepsBaseline {
  return { steps: [], revision: 0 }
}

/** 全新状态：草稿空、基线空、版本 0、还没有完成初始读取。 */
export function createTaskStepsState(): TaskStepsState {
  return {
    draft: [],
    baseline: emptyBaseline(),
    draftBaseRevision: 0,
    latestRevision: 0,
    loaded: false,
    committed: false,
    phase: 'idle',
    notice: null,
    readError: null,
    readErrorCode: null,
    conflict: false,
  }
}

/** 已保存的步骤 → 草稿行（复制一份，绝不共享引用）。 */
export function draftFromSteps(steps: readonly TaskStep[]): TaskStepsDraftStep[] {
  return steps.map((step) => ({ id: step.id, title: step.title, done: step.done }))
}

/* -------------------------- 草稿的纯函数操作（不写入参） -------------------------- */

export function addStep(state: TaskStepsState, id: string, title = ''): TaskStepsState {
  if (state.draft.length >= MAX_TASK_STEPS) return state
  return { ...state, draft: [...state.draft, { id, title: clampStepTitleInput(title), done: false }], phase: 'idle' }
}

export function setStepTitle(state: TaskStepsState, id: string, title: string): TaskStepsState {
  const next = clampStepTitleInput(title)
  return {
    ...state,
    draft: state.draft.map((step) => (step.id === id ? { ...step, title: next } : step)),
    phase: 'idle',
  }
}

export function toggleStepDone(state: TaskStepsState, id: string): TaskStepsState {
  return {
    ...state,
    draft: state.draft.map((step) => (step.id === id ? { ...step, done: !step.done } : step)),
    phase: 'idle',
  }
}

export function removeStep(state: TaskStepsState, id: string): TaskStepsState {
  return { ...state, draft: state.draft.filter((step) => step.id !== id), phase: 'idle' }
}

/** 清空全部步骤（界面需要先确认，见 `needsClearConfirm`）。 */
export function clearSteps(state: TaskStepsState): TaskStepsState {
  return { ...state, draft: [], phase: 'idle' }
}

/**
 * 草稿规范化：去掉标题首尾空白。
 *
 * 校验用与写库用**必须是同一份规范**，否则会出现「界面说没问题、保存时被拒」。
 */
export function normalizedDraftSteps(draft: readonly TaskStepsDraftStep[]): TaskStep[] {
  return draft.map((step) => ({ id: step.id.trim(), title: normalizeStepTitle(step.title) ?? '', done: step.done }))
}

/* --------------------------------- 校验 --------------------------------- */

export interface TaskStepsIssues {
  /** 标题问题（按步骤 ID 索引），可直接挂到对应输入框上。 */
  fieldErrors: Map<string, string>
  /** 整体性问题（条数上限、编号重复等），显示在清单上方。 */
  formErrors: string[]
  ok: boolean
}

const EMPTY_TITLE_MESSAGE = '这一步还没有写内容。'
const LONG_TITLE_MESSAGE = `每一步最多 ${TASK_STEP_TITLE_MAX} 个字。`

/** 草稿当前的问题（空标题 / 超长 / 超过条数上限 / 编号重复）。 */
export function draftIssues(draft: readonly TaskStepsDraftStep[]): TaskStepsIssues {
  const fieldErrors = new Map<string, string>()
  const formErrors: string[] = []
  const normalized = normalizedDraftSteps(draft)

  if (draft.length > MAX_TASK_STEPS) {
    formErrors.push(`最多只能有 ${MAX_TASK_STEPS} 步，现在有 ${draft.length} 步：请先删掉一些。`)
  }
  const seen = new Set<string>()
  for (const step of normalized) {
    // 空 ID / 重复 ID 是内部编号问题，不该出现，但绝不静默放过。
    if (step.id.length === 0) formErrors.push('有一步缺少编号，请删掉它重新添加。')
    else if (seen.has(step.id)) formErrors.push('清单里有重复的编号，请删掉重复的那一步。')
    seen.add(step.id)
  }
  for (const raw of draft) {
    const id = raw.id.trim()
    const title = normalizeStepTitle(raw.title)
    if (title === null) fieldErrors.set(id, EMPTY_TITLE_MESSAGE)
    else if (title.length > TASK_STEP_TITLE_MAX) fieldErrors.set(id, LONG_TITLE_MESSAGE)
  }
  const validation = validateTaskSteps(normalized)
  if (!validation.ok && fieldErrors.size === 0 && formErrors.length === 0) {
    formErrors.push(validation.reason ?? '这份清单暂时不能保存。')
  }
  return { fieldErrors, formErrors, ok: fieldErrors.size === 0 && formErrors.length === 0 }
}

/** 有未保存的改动吗（与干净基线逐条比对：编号、内容、勾选状态都要一致）。 */
export function isDraftDirty(draft: readonly TaskStepsDraftStep[], baseline: TaskStepsBaseline | null): boolean {
  if (!baseline) return draft.length > 0
  const normalized = normalizedDraftSteps(draft)
  if (normalized.length !== baseline.steps.length) return true
  for (let index = 0; index < normalized.length; index += 1) {
    const left = normalized[index]!
    const right = baseline.steps[index]!
    if (left.id !== right.id) return true
    if (left.title !== right.title) return true
    if (left.done !== right.done) return true
  }
  return false
}

/** 草稿有真正的输入吗（标题非空），或者有勾选 —— 用于「离开时要不要问一句」的兜底。 */
export function hasMeaningfulDraft(draft: readonly TaskStepsDraftStep[]): boolean {
  return draft.some((step) => step.title.trim().length > 0) || draft.some((step) => step.done) || draft.length > 0
}

/**
 * 把**整份清单清空**需要确认吗。
 *
 * 判据：草稿是空的，而它基于的已保存内容本来有步骤 —— 「从有到无」是显式清空，
 * 必须问一句；本来就是空的（新任务）不需要。
 */
export function needsClearConfirm(state: Pick<TaskStepsState, 'draft' | 'draftBaseRevision' | 'baseline'>): boolean {
  if (state.draft.length > 0) return false
  // 判据是「基线里本来有步骤」：已保存的就是空清单时，再保存一次空清单不需要再问。
  return state.baseline.steps.length > 0
}

/** 删除某一步需要确认吗：内容非空或已经勾选，就不是「误点一下」能丢的。 */
export function needsRemoveConfirm(step: Pick<TaskStepsDraftStep, 'title' | 'done'>): boolean {
  return step.title.trim().length > 0 || step.done
}

/* ------------------------------ 读取 / 保存的迁移 ------------------------------ */

/** 一次读取的结果（界面把「读到什么」交给状态机处理）。 */
export interface TaskStepsReadOutcome {
  ok: boolean
  steps: TaskStep[]
  revision: number
  error: string | null
  /** 读取失败的类别；`ok: true` 时忽略。 */
  code?: TaskStepsReadErrorCode | null
}

/**
 * 读取结果 → 状态（**唯一**会「铺草稿」的地方，因此不会出现第二次覆盖）。
 *
 * - **读失败**：只记原因与类别，草稿、基线、版本号一个字都不动；
 * - **更旧的读回**：整条丢弃 —— 绝不能把旧内容配上已知的新版本号；
 * - **初始读取**（`!loaded`）或**草稿干净**：整个状态对齐到库里那份
 *   （草稿、基线、`draftBaseRevision` 一起）—— 这就是「初次加载 / 干净刷新」；
 * - **草稿脏**：草稿、基线、`draftBaseRevision` **全部保留**，只把
 *   `latestRevision` 往前推；若读到的版本比草稿基版本新，立起 `conflict`
 *   等用户显式处理（绝不悄悄用新版本去保存这份草稿）；
 * - `force: true`（用户确认「载入最新并丢弃草稿」）：即使草稿脏也整份替换。
 */
export function applySavedStepsRead(
  state: TaskStepsState,
  read: TaskStepsReadOutcome,
  options: { force?: boolean } = {},
): TaskStepsState {
  if (!read.ok) {
    return {
      ...state,
      readError: read.error ?? '读取步骤清单失败。',
      readErrorCode: read.code ?? 'READ_FAILED',
    }
  }
  if (read.revision < state.latestRevision) return state
  const nextLatest = Math.max(state.latestRevision, read.revision)
  const dirty = state.loaded && isDraftDirty(state.draft, state.baseline)
  const adopt = options.force === true || !state.loaded || !dirty
  if (adopt) {
    const baseline: TaskStepsBaseline = {
      steps: read.steps.map((step) => ({ ...step })),
      revision: read.revision,
    }
    return {
      ...state,
      draft: draftFromSteps(read.steps),
      baseline,
      draftBaseRevision: read.revision,
      latestRevision: nextLatest,
      loaded: true,
      committed: state.committed || read.revision > 0,
      readError: null,
      readErrorCode: null,
      conflict: false,
      phase: state.phase === 'saving' ? 'saving' : 'idle',
    }
  }
  // 脏草稿：一个字都不动，只更新「别处有更新」的判断。
  return {
    ...state,
    latestRevision: nextLatest,
    conflict: state.conflict || read.revision > state.draftBaseRevision,
    readError: null,
    readErrorCode: null,
    phase: state.phase === 'saving' ? 'saving' : state.phase,
  }
}

export function withSaving(state: TaskStepsState): TaskStepsState {
  return { ...state, phase: 'saving', notice: null }
}

export interface TaskStepsCommitResult {
  ok: boolean
  /** 写入是否已经提交（`false` = 一个字节都没写）。 */
  committed: boolean
  /** 提交后的新版本号；**被冲突拒绝**时是库里当前的版本号（只用于提示，不写库）。 */
  revision: number | null
  reason: string | null
  readbackError: string | null
}

/** 仓库抛异常时的结果（异常可能发生在提交之后，因此绝不谎称「没写进去」）。 */
export function commitFailureResult(cause: unknown): TaskStepsCommitResult {
  const message = cause instanceof Error ? cause.message : String(cause ?? '保存失败。')
  return { ok: false, committed: false, revision: null, reason: message, readbackError: null }
}

/**
 * 保存返回后的状态迁移。
 *
 * - **提交成功**：基线换成刚提交的草稿（于是保存完就是干净的，离开时不会再问一次）、
 *   `draftBaseRevision` 与 `latestRevision` 一起前进、冲突标记清除；
 *   读回失败时**保留「已提交」与版本号**，只把 `readError` 记下来（提示「已保存但暂时无法读取」）；
 * - **被拒绝**：一个字节都没写，草稿与基线都不动，只给原因；
 *   如果仓库告诉了当前库里的版本、且比草稿基版本新，就立起冲突标记 —— 保存**不会**
 *   因为「再点一次」就悄悄覆盖，必须先显式载入最新版本。
 */
export function applyCommitResult(state: TaskStepsState, result: TaskStepsCommitResult): TaskStepsState {
  if (!result.committed) {
    const newer = result.revision !== null && result.revision > state.draftBaseRevision
    return {
      ...state,
      phase: 'rejected',
      notice: { text: result.reason ?? '保存失败，请稍后再试。', tone: 'error' },
      latestRevision: result.revision === null ? state.latestRevision : Math.max(state.latestRevision, result.revision),
      conflict: state.conflict || newer,
    }
  }
  // 版本号单调：即使仓库回传的版本比状态里已知的旧（例如那次更新的读回已经落地），
  // 也绝不把草稿基版本往回退。
  const committedRevision = Math.max(state.draftBaseRevision, result.revision ?? state.draftBaseRevision)
  const committedSteps = normalizedDraftSteps(state.draft).map((step) => ({ ...step }))
  const baseline: TaskStepsBaseline = { steps: committedSteps, revision: committedRevision }
  if (result.readbackError) {
    return {
      ...state,
      baseline,
      draftBaseRevision: committedRevision,
      latestRevision: Math.max(state.latestRevision, committedRevision),
      committed: true,
      loaded: true,
      conflict: false,
      readError: result.readbackError,
      readErrorCode: 'READ_FAILED',
      phase: 'committedNoReadback',
      notice: {
        text: `步骤已经保存，但读回本机数据时出错：${result.readbackError}`,
        tone: 'error',
      },
    }
  }
  return {
    ...state,
    baseline,
    draftBaseRevision: committedRevision,
    latestRevision: Math.max(state.latestRevision, committedRevision),
    committed: true,
    loaded: true,
    conflict: false,
    readError: null,
    readErrorCode: null,
    phase: 'saved',
    notice: { text: '步骤已保存。全部步骤做完也不会改这条任务的状态或 DDL。', tone: 'success' },
  }
}

/** 用户在冲突提示里确认「载入最新版本并丢弃草稿」之后、读取真正落地之前的状态。 */
export function withConflictResolved(state: TaskStepsState): TaskStepsState {
  return { ...state, conflict: false, notice: null }
}

/* -------------------------------- 展示辅助 -------------------------------- */

/** 「已完成 / 总数」文案（空清单 = 尚未添加步骤，绝不显示 100%）。 */
export function progressText(draft: readonly TaskStepsDraftStep[]): string {
  const { total, done } = progressOf(draft.map((step) => ({ id: step.id, title: step.title, done: step.done })))
  if (total === 0) return '尚未添加步骤'
  return `${done}/${total} 已完成`
}
