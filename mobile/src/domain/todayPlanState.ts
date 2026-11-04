/**
 * 「今日学习计划」草稿与预览的**状态机**（纯函数，无 React / 无数据库）。
 *
 * 界面里有三份东西必须**同时存在**、而且互相不能覆盖（授权书点名的要求）：
 * 1. **草稿**：用户正在编辑的日期 / 时段 / 选中任务与分钟数（还没生成、或改了之后还没重新生成）；
 * 2. **预览**：上一次明确点「生成预览」得到的那份只读计划（零写库）；
 * 3. **已保存计划**：库里真正存在的那一份（只有点「采用并保存」才会变）。
 *
 * 因此这里的函数一律**返回新对象**，绝不改写入参；并且用「指纹」而不是
 * 「用户有没有再点一次」来判断预览是不是过期了。**脏判定**同时看
 * 日期 + 时段原文 + 选中任务 + 分钟数：只改时段（还没选任务）同样是「有未保存的输入」。
 */

import {
  isPlanForToday,
  sameTodayPlanFingerprint,
  type PlanSelection,
  type StudyWindowInput,
  type TodayPlan,
  type TodayPlanFingerprint,
} from './todayPlan'

export interface DraftSelection {
  taskId: number
  /** 用户输入的**原文**（可以被改坏，由校验负责拦住）。 */
  minutes: string
}

/** 正在编辑的草稿（界面的唯一事实来源）。 */
export interface TodayPlanDraft {
  /** 草稿属于哪一天（上海自然日）。 */
  date: string
  /** 1–4 段原始输入（原样保留用户写的内容，包括未填完的行）。 */
  windows: StudyWindowInput[]
  /** 选中任务 → 计划分钟数**原文**。 */
  selections: DraftSelection[]
}

/** 「干净」基线：与它一致就表示没有未保存的改动。 */
export interface TodayPlanBaseline {
  date: string
  windows: StudyWindowInput[]
  selections: PlanSelection[]
}

export interface TodayPlanPreview {
  plan: TodayPlan
  /** 生成这份预览时的输入指纹（采用时要拿它跟最新输入比对）。 */
  fingerprint: TodayPlanFingerprint
  /** 生成预览的时刻（展示用）。 */
  generatedAtEpochMs: number
}

export type PreviewInvalidReason = 'NONE' | 'DIRTY' | 'DATE_CHANGED'

export interface PreviewStatus {
  stale: boolean
  reason: PreviewInvalidReason
  message: string | null
}

/** 空草稿：一天、一段空白时段、没有选中任务（不会替用户预填任何时间）。 */
export function emptyTodayPlanDraft(date: string, windowSlots = 1): TodayPlanDraft {
  const count = Math.max(1, Math.min(4, Math.trunc(windowSlots) || 1))
  return {
    date,
    windows: Array.from({ length: count }, () => ({ start: '', end: '' })),
    selections: [],
  }
}

/** 全新的一天：干净基线为空（昨天的时段与选中任务绝不带到今天）。 */
export function emptyBaseline(date: string): TodayPlanBaseline {
  return { date, windows: [{ start: '', end: '' }], selections: [] }
}

/** 已保存计划 → 干净基线（用于「离开时要不要问一句」）。 */
export function baselineFromPlan(plan: TodayPlan | null, fallbackDate: string): TodayPlanBaseline {
  if (!plan) return emptyBaseline(fallbackDate)
  const windows: StudyWindowInput[] = plan.fingerprint.windows.map((label) => {
    const parts = label.split('-')
    return { start: parts[0] ?? '', end: parts[1] ?? '' }
  })
  return {
    date: plan.date,
    windows: windows.length > 0 ? windows : [{ start: '', end: '' }],
    selections: plan.fingerprint.selections.map((selection) => ({
      taskId: selection.taskId,
      minutes: selection.minutes,
    })),
  }
}

/** 草稿 → 干净基线（保存成功后把输入区标记为「已保存」）。 */
export function baselineFromDraft(draft: TodayPlanDraft): TodayPlanBaseline {
  const selections: PlanSelection[] = []
  for (const selection of draft.selections) {
    const minutes = Number(selection.minutes.trim())
    if (Number.isInteger(minutes)) selections.push({ taskId: selection.taskId, minutes })
  }
  return {
    date: draft.date,
    windows: draft.windows.map((window) => ({ ...window })),
    selections,
  }
}

export function addStudyWindow(draft: TodayPlanDraft): TodayPlanDraft {
  if (draft.windows.length >= 4) return draft
  return { ...draft, windows: [...draft.windows, { start: '', end: '' }] }
}

export function setStudyWindow(
  draft: TodayPlanDraft,
  index: number,
  field: 'start' | 'end',
  value: string,
): TodayPlanDraft {
  return {
    ...draft,
    windows: draft.windows.map((window, cursor) => (cursor === index ? { ...window, [field]: value } : window)),
  }
}

export function removeStudyWindow(draft: TodayPlanDraft, index: number): TodayPlanDraft {
  const next = draft.windows.filter((_, cursor) => cursor !== index)
  return { ...draft, windows: next.length > 0 ? next : [{ start: '', end: '' }] }
}

/** 选中 / 取消一个任务（选中时分钟数留空：应用绝不替用户填）。 */
export function toggleTaskSelection(draft: TodayPlanDraft, taskId: number): TodayPlanDraft {
  const exists = draft.selections.some((selection) => selection.taskId === taskId)
  if (exists) {
    return { ...draft, selections: draft.selections.filter((selection) => selection.taskId !== taskId) }
  }
  return { ...draft, selections: [...draft.selections, { taskId, minutes: '' }] }
}

export function setSelectionMinutes(draft: TodayPlanDraft, taskId: number, minutes: string): TodayPlanDraft {
  return {
    ...draft,
    selections: draft.selections.map((selection) =>
      selection.taskId === taskId ? { ...selection, minutes } : selection,
    ),
  }
}

/**
 * 有未保存的输入吗？
 *
 * 判据是**日期 + 时段原文 + 选中任务与分钟数**三件事（与干净基线逐项比对）。
 * 只改了时段、还没选任务也必须算「脏」—— 否则离开页面时不会问一句，
 * 用户刚输入的时间会被静默丢掉（复核点名的缺陷）。
 */
export function isDraftDirty(draft: TodayPlanDraft, baseline: TodayPlanBaseline | null): boolean {
  if (!baseline) return hasMeaningfulInput(draft)
  if (draft.date !== baseline.date) return true
  if (draft.windows.length !== baseline.windows.length) return true
  for (let index = 0; index < draft.windows.length; index += 1) {
    const left = draft.windows[index]!
    const right = baseline.windows[index]!
    if (left.start.trim() !== right.start.trim() || left.end.trim() !== right.end.trim()) return true
  }
  if (draft.selections.length !== baseline.selections.length) return true
  const leftSelections = [...draft.selections].sort((a, b) => a.taskId - b.taskId)
  const rightSelections = [...baseline.selections].sort((a, b) => a.taskId - b.taskId)
  for (let index = 0; index < leftSelections.length; index += 1) {
    const left = leftSelections[index]!
    const right = rightSelections[index]!
    if (left.taskId !== right.taskId) return true
    if (left.minutes.trim() !== String(right.minutes)) return true
  }
  return false
}

/** 草稿里有没有「用户真的写过东西」（没有基线时的兜底判据）。 */
export function hasMeaningfulInput(draft: TodayPlanDraft): boolean {
  if (draft.selections.length > 0) return true
  return draft.windows.some((window) => window.start.trim().length > 0 || window.end.trim().length > 0)
}

/**
 * 预览是否过期（三个判据，任意一条命中就作废）：
 * 1. 跨过了上海零点（预览属于昨天）；
 * 2. 草稿的时段 / 选中任务 / 分钟数原文变了；
 * 3. 相关任务 / 课表 / 课程的内容变了（指纹里的上下文摘要比对，不含无关字段）。
 */
export function previewStatus(input: {
  preview: TodayPlanPreview | null
  draft: TodayPlanDraft
  currentFingerprint: TodayPlanFingerprint | null
  now: Date
}): PreviewStatus {
  const { preview } = input
  if (!preview) return { stale: true, reason: 'DIRTY', message: '还没有生成预览。' }
  if (!isPlanForToday(preview.plan.date, input.now)) {
    return {
      stale: true,
      reason: 'DATE_CHANGED',
      message: `这份预览是 ${preview.plan.date} 生成的，已经不是今天了，请重新生成。`,
    }
  }
  if (!input.currentFingerprint) {
    return { stale: true, reason: 'DIRTY', message: '输入已经变化，请重新生成预览。' }
  }
  if (!sameTodayPlanFingerprint(preview.fingerprint, input.currentFingerprint)) {
    return { stale: true, reason: 'DIRTY', message: '时段或选中任务已经变化，请重新生成预览。' }
  }
  return { stale: false, reason: 'NONE', message: null }
}

/* --------------------------- 保存动作的状态迁移 --------------------------- */

export interface TodayPlanCommitResult {
  ok: boolean
  /** 写入是否已经提交（`false` = 一个字节都没写）。 */
  committed: boolean
  /** 提交后的新版本号；没提交时为 `null`。 */
  revision: number | null
  /** 被拒绝时的原因（中文，可直接展示）。 */
  reason: string | null
  /** **写入已提交**但随后的读回失败时的真实错误。 */
  readbackError: string | null
}

/**
 * 保存阶段。
 *
 * 关键点：**「写进去了」与「读回来了」是两件事**。
 * `committedNoReadback` 表示确实已经提交（版本号也拿到了），只是读回失败；
 * 界面必须把它当「已保存」对待（`committed === true`，不能再点一次同一份预览），
 * 同时如实说明读回失败。
 */
export type SavePhase = 'idle' | 'saving' | 'saved' | 'committedNoReadback' | 'rejected'

export interface TodayPlanState {
  /** 干净基线（与草稿比对判定「有没有未保存的输入」）。 */
  baseline: TodayPlanBaseline
  draft: TodayPlanDraft
  preview: TodayPlanPreview | null
  savedPlan: TodayPlan | null
  savedRevision: number
  /** **写入已经提交**的事实（读回失败时同样为 `true`）。 */
  committed: boolean
  phase: SavePhase
  notice: { text: string; tone: 'success' | 'error' } | null
}

export function initialTodayPlanState(
  date: string,
  savedPlan: TodayPlan | null = null,
  savedRevision = 0,
): TodayPlanState {
  return {
    baseline: emptyBaseline(date),
    draft: emptyTodayPlanDraft(date),
    preview: null,
    savedPlan,
    savedRevision,
    committed: savedPlan !== null,
    phase: 'idle',
    notice: null,
  }
}

/** 生成预览：草稿一个字都不动。 */
export function withPreview(state: TodayPlanState, preview: TodayPlanPreview | null): TodayPlanState {
  return { ...state, preview, phase: 'idle', notice: null }
}

/** 输入变更：预览作废（置空），草稿保留。 */
export function withDraft(state: TodayPlanState, draft: TodayPlanDraft): TodayPlanState {
  return { ...state, draft, preview: null, phase: 'idle' }
}

export function withSaving(state: TodayPlanState): TodayPlanState {
  return { ...state, phase: 'saving', notice: null }
}

/**
 * 保存返回后的状态迁移。
 *
 * - **提交成功**：保留「已提交」这件事与版本号；草稿与基线都对齐到刚保存的输入
 *   （于是**保存完就是干净的**，离开时不会再问一次）；预览作废；
 * - **提交成功但读回失败**：`savedPlan` **置空**（旧的计划绝不能顶着新版本号显示成「今天的计划」），
 *   但 `committed: true` + `savedRevision` 更新，界面据此提示「已保存，但没读回来」；
 * - **被拒绝**：一个字节都没写，已保存计划与草稿都不动，只给原因。
 */
export function applyCommitResult(
  state: TodayPlanState,
  result: TodayPlanCommitResult,
  options: { readback?: TodayPlan | null } = {},
): TodayPlanState {
  if (result.committed) {
    const committedRevision = result.revision ?? state.savedRevision
    /**
     * 状态里已经有**更新的**版本（保存期间别处又存了一版，或那次更新的读回已经落地）：
     * 本地这次提交的版本号比它旧，绝不能把版本号或内容往回退 —— 只更新「已提交」这个事实。
     */
    if (state.savedRevision > committedRevision) {
      return {
        ...state,
        preview: null,
        committed: true,
        baseline: baselineFromDraft(state.draft),
        phase: state.savedPlan !== null ? 'saved' : 'committedNoReadback',
      }
    }
    if (result.readbackError) {
      return {
        ...state,
        preview: null,
        // 提交的版本比状态里已知的更新（或状态里没有内容）：旧内容不能代表刚保存的那一份。
        savedPlan: null,
        savedRevision: committedRevision,
        committed: true,
        baseline: baselineFromDraft(state.draft),
        phase: 'committedNoReadback',
        notice: { text: `今天的计划已保存，但读回本机数据时出错：${result.readbackError}`, tone: 'error' },
      }
    }
    const hasFreshReadback = options.readback !== undefined && options.readback !== null
    if (!hasFreshReadback && committedRevision > state.savedRevision) {
      return {
        ...state,
        preview: null,
        savedPlan: null,
        savedRevision: committedRevision,
        committed: true,
        baseline: baselineFromDraft(state.draft),
        phase: 'committedNoReadback',
        notice: {
          text: `今天的计划已保存（版本 ${committedRevision}），但这次没能读回内容，暂时不显示之前的计划。`,
          tone: 'error',
        },
      }
    }
    return {
      ...state,
      preview: null,
      // `readback` 没给（`undefined`）时保留上一份已保存计划（它与提交的版本一致）；
      // 明确给 `null` 表示「这次确实没读到新内容」。
      savedPlan: options.readback === undefined ? state.savedPlan : options.readback,
      savedRevision: Math.max(state.savedRevision, committedRevision),
      committed: true,
      baseline: baselineFromDraft(state.draft),
      phase: 'saved',
      notice: { text: '今天的计划已保存。', tone: 'success' },
    }
  }
  return {
    ...state,
    phase: 'rejected',
    notice: { text: result.reason ?? '保存失败，请稍后再试。', tone: 'error' },
  }
}

/**
 * 读一次已保存计划的结果（界面把「读到什么」交给状态机处理）。
 *
 * - `ok: true`：读到了今天的计划（`plan` 可能是 `null`，表示今天还没有）；
 * - `ok: false`：读不到 / 读不出来。**已经知道的版本号要保留**，
 *   但内容必须当作「没有」——界面不能拿旧快照顶着它显示。
 */
export interface SavedPlanReadOutcome {
  ok: boolean
  plan: TodayPlan | null
  revision: number
  storedOtherDate: boolean
  error: string | null
}

/**
 * 读回结果 → 状态（版本号单调；内容与版本号必须来自同一次读回）。
 *
 * 为什么单独做一个纯函数：
 * - **读失败**时「版本号」和「内容」必须分开处理：版本号是已经发生的事实（乐观锁要用），
 *   内容则是「这次没读到」，必须清掉（否则上一版计划会顶着新版本号显示成今天的计划）；
 * - **读成功但版本号更旧**时（例如保存之前发出、保存之后才回来的那次读回），
 *   整条结果都要丢弃：绝不能把旧内容配上已知的新版本号 —— 那正是复核点名的真实缺陷。
 */
export function applySavedPlanRead(state: TodayPlanState, read: SavedPlanReadOutcome): TodayPlanState {
  if (!read.ok) {
    return {
      ...state,
      // 保留已知的版本号与「确实保存过」的事实（`committed`），只清掉不可用的内容。
      savedRevision: Math.max(state.savedRevision, read.revision),
      savedPlan: null,
      committed: state.committed || read.revision > 0,
      phase: state.phase === 'committedNoReadback' ? state.phase : 'idle',
    }
  }
  // 更旧的读回：整条丢弃（不换内容、也不动版本号）。
  if (read.revision < state.savedRevision) return state
  return {
    ...state,
    savedPlan: read.plan,
    savedRevision: Math.max(state.savedRevision, read.revision),
    committed: read.plan !== null || read.revision > 0 || state.committed,
  }
}

/**
 * 已知「本机里有今天的计划记录」吗？
 *
 * 用于两件事：替换前必须确认；以及读不到内容时不要把旧快照当成当前计划。
 * 注意 `storedOtherDate`（存的是别的一天）**不算**今天的记录。
 */
export function hasKnownTodaySavedRecord(input: {
  committed: boolean
  savedRevision: number
  savedPlan: TodayPlan | null
  storedOtherDate: boolean
}): boolean {
  if (input.storedOtherDate) return false
  if (input.savedPlan !== null) return true
  if (input.committed) return true
  return input.savedRevision > 0
}

/** 仓库抛异常时的结果（异常可能发生在提交之后，因此绝不谎称「没写进去」）。 */
export function commitFailureResult(cause: unknown): TodayPlanCommitResult {
  const message = cause instanceof Error ? cause.message : String(cause ?? '保存失败。')
  return { ok: false, committed: false, revision: null, reason: message, readbackError: null }
}

/** 保存之后界面自己那次读回的结果（纯数据，便于单独测试）。 */
export interface PostCommitReadOutcome {
  /** `true` = 这次读回已经被更新的读回抢先，结果作废。 */
  discarded: boolean
  /** 读到的计划；没读到为 `null`。 */
  plan: TodayPlan | null
  /** 读不到 / 读不出来时的原因。 */
  error: string | null
  /** 这次读回看到的**库里的版本号**；没读到为 `null`。 */
  revision: number | null
}

/**
 * 把「提交结果」和「界面随后那次读回」合并成一个准备交给
 * {@link applyCommitResult} 的结果（复核 14）。
 *
 * 为什么需要它：仓库返回 `readbackError: null` 只说明**仓库自己**那一步读回了，
 * 界面紧接着又读了一次（为了拿到最新快照）。如果界面这次读回失败，
 * 旧实现会把「没读到内容」当成「读到了空的计划」，于是状态被标成 `saved`，
 * 界面还把**上一版**的计划当成刚保存的那份显示出来。
 *
 * 合并规则：
 * - 提交没成功 → 原样返回（界面的读回与它无关）；
 * - 提交成功且界面读回了内容 → 保持仓库的 `readbackError`（通常为 `null`）；
 *   读到的版本号**更新**（可能比本地提交更高：别处又存过一版）→ 结果里的版本号取较大者，
 *   避免「版本号 2 配着版本 3 的内容」这种自相矛盾的状态；
 * - 提交成功但界面这次读回**没有拿到内容**（读不到 / 读不出来）→ 补上 `readbackError`，
 *   状态机会把它标成 `committedNoReadback`（清掉旧内容、不允许重复提交同一份预览）；
 * - 提交成功但界面这次读回被**更新的读回抢先作废**（`discarded`）→ 不在这里编造结论：
 *   交给 `applyCommitResult` 比较版本号 —— 状态里的版本更新就整条保留，
 *   否则按「这次没读到」处理。**作废的读回绝不会把版本号或内容往回退**。
 */
export function mergePostCommitRead(
  result: TodayPlanCommitResult,
  read: PostCommitReadOutcome | null,
): TodayPlanCommitResult {
  if (!result.committed || !read) return result
  if (read.discarded) return result
  // 版本号单调：读到的（可能更高的）版本号不能被本地提交结果盖回去。
  const revision =
    result.revision === null ? read.revision : read.revision === null ? result.revision : Math.max(result.revision, read.revision)
  if (read.plan) return { ...result, revision }
  if (result.readbackError) return { ...result, revision }
  return { ...result, revision, readbackError: read.error ?? '保存后没有读回这份计划。' }
}

/**
 * 零点切换：草稿与基线都换成新的一天（**必须由用户显式确认后调用**）。
 *
 * 旧计划仍留在库里；`savedPlan` 只换成「新的一天的计划」（通常为 `null`），
 * 绝不把昨天的计划当成今天的。
 */
export function resetForNewDate(
  state: TodayPlanState,
  date: string,
  savedPlan: TodayPlan | null,
  savedRevision: number,
): TodayPlanState {
  return {
    baseline: emptyBaseline(date),
    draft: emptyTodayPlanDraft(date),
    preview: null,
    savedPlan,
    savedRevision,
    committed: savedPlan !== null,
    phase: 'idle',
    notice: { text: `已切换到 ${date}（昨天填过的时段与选中任务不会带到今天）。`, tone: 'success' },
  }
}

/** 计划块的时间范围文案（`08:00-08:30`）。 */
export function blockLabel(block: { startTime: string; endTime: string }): string {
  return `${block.startTime}-${block.endTime}`
}
