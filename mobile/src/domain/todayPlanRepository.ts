/**
 * 今日学习计划的**持久化层**（无 React / 无网络 / 无 AI）。
 *
 * 设计约束（逐条来自授权书与复核，改这里之前先读一遍）：
 * - **不新增表、不改 schema 版本**：整份计划写进既有的 `app_settings` 键值表，
 *   键是 {@link APP_SETTINGS_KEYS.TODAY_PLAN}，值是**带版本号的紧凑 JSON**；
 * - **提交前用新鲜状态重算，绝不信任调用方给的块**：`saveTodayPlan` 只接受
 *   「日期 + 显式时段 + 选中任务与计划分钟数 + 期望版本 + **这次预览的计划（证据）**」，
 *   计划块由仓库自己在事务里用刚读到的任务 / 课表 / 课程 + **预览的分钟锚点**重算；
 * - **时间推进不会让计划偷偷挪位**：重算使用预览时的 `anchorEpochMs`；
 *   但如果提交那一刻已经有块**开始时间到达**，直接拒绝并要求重新生成 ——
 *   绝不悄悄改排一版用户没确认过的计划，也绝不把过去的时间写进去；
 * - **一次事务**：读既有计划（版本 + 破损检查）→ 重算 → 与预览比对 → 校验 → 写回，
 *   全程在同一个事务里，因此「预览时还在、提交时被删掉」的任务不可能被保存进去；
 * - **乐观锁**：两个标签页同时打开时，后到的那个会因为 `expectedRevision` 对不上被拒绝；
 * - **脏数据不崩也不改写**：库里 JSON 解析不了 / 版本不认识 / 结构不合法 → 返回可读的
 *   不可用原因，**绝不修改或删除**那条记录，也**不承诺**「重新生成就能替换它」；
 * - 不写任何凭据，也不存「整个 App 的数据」。
 */

import { APP_SETTINGS_KEYS } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import { deadlineToEpochMs, shanghaiToday } from './datetime'
import {
  MAX_SAVED_BLOCKS,
  MAX_SELECTED_TASKS,
  MAX_STUDY_WINDOWS,
  MINUTES_PER_DAY,
  PLAN_MINUTES_MAX,
  PLAN_MINUTES_MIN,
  TODAY_PLAN_STORAGE_VERSION,
  buildTodayPlan,
  isPlanForToday,
  minuteToClock,
  samePlanResult,
  sameTodayPlanFingerprint,
  shanghaiMinuteOfDay,
  todayPlanFingerprint,
  validatePlanSelections,
  validateStudyWindows,
  verifyTodayPlan,
} from './todayPlan'
import type {
  PlanBlock,
  PlanTaskOutcome,
  StudyWindowInput,
  TodayPlan,
  TodayPlanContext,
  UnscheduledReason,
} from './todayPlan'

/** 重算计划需要的「新鲜上下文」——由 store 在事务里回调读取。 */
export type TodayPlanContextSource = () => Promise<TodayPlanContext>

export interface TodayPlanReadResult {
  ok: true
  plan: TodayPlan | null
  revision: number
  /** 存的是别的一天的计划时为 `true`（界面要说清楚，绝不冒充今天）。 */
  storedOtherDate: boolean
}

export interface TodayPlanUnavailable {
  ok: false
  reason: string
  /** 库里那条原始值的片段（只用于诊断）。 */
  rawExcerpt: string | null
}

export type TodayPlanLoadResult = TodayPlanReadResult | TodayPlanUnavailable

export interface SaveTodayPlanInput {
  date: string
  windows: readonly StudyWindowInput[]
  selections: readonly { taskId: number; minutes: number }[]
  /** 用户**确认过的那份预览**（证据）；仓库只用它做身份核对与锚点，绝不直接保存它的块。 */
  previewPlan: TodayPlan
  /** 已保存计划的版本号；`0` = 认为还没有保存过。 */
  expectedRevision: number
}

export interface SaveTodayPlanResult {
  ok: boolean
  committed: boolean
  revision: number | null
  reason: string | null
  readbackError: string | null
}

const STALE_TIME_MESSAGE =
  '这段时间里已经过去了：预览里的计划块已经开始，请重新生成预览再保存（应用不会替你悄悄改排一版）。'
const CHANGED_MESSAGE = '相关任务 / 课表在预览之后变了，请重新生成预览再保存。'
const WRONG_DATE_MESSAGE = '这份预览不是这一天的计划，请重新生成后再保存。'
const CONFLICT_MESSAGE = '别处已经保存过今天的计划，请先刷新看看最新版本，再决定要不要覆盖。'
const CORRUPT_MESSAGE = '本机保存的今日计划读不出来（格式或版本不认识），已停止保存以免覆盖它。'
const MALFORMED_MESSAGE = '这段输入不合法（时段或选择项），请改好之后再保存。'

function excerptOf(raw: string): string {
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw
}

interface StoredPayload {
  version?: unknown
  date?: unknown
  revision?: unknown
  savedAt?: unknown
  anchorEpochMs?: unknown
  windows?: unknown
  selections?: unknown
  blocks?: unknown
  outcomes?: unknown
  scheduledMinutes?: unknown
  unscheduledMinutes?: unknown
  targetMinutes?: unknown
  windowLabels?: unknown
  contextDigest?: unknown
  algorithmVersion?: unknown
}

/* --------------------------- 保存载荷的结构校验 --------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 64) return null
    result.push(entry)
  }
  return result
}

function asWindows(value: unknown): StudyWindowInput[] | null {
  if (!Array.isArray(value) || value.length > MAX_STUDY_WINDOWS) return null
  const result: StudyWindowInput[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return null
    const start = entry.start
    const end = entry.end
    if (typeof start !== 'string' || typeof end !== 'string') return null
    result.push({ start, end })
  }
  return result
}

function asSelections(value: unknown): Array<{ taskId: number; minutes: number }> | null {
  const validation = validatePlanSelections(value)
  if (!validation.ok) return null
  if (validation.selections.some((selection) => selection.minutes < PLAN_MINUTES_MIN)) return null
  return validation.selections.map((selection) => ({ taskId: selection.taskId, minutes: selection.minutes }))
}

function asBlocks(value: unknown): PlanBlock[] | null {
  if (!Array.isArray(value) || value.length > MAX_SAVED_BLOCKS) return null
  const result: PlanBlock[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return null
    const taskId = entry.taskId
    const minutes = entry.minutes
    const startMinute = entry.startMinute
    const endMinute = entry.endMinute
    if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return null
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1) return null
    if (typeof startMinute !== 'number' || !Number.isInteger(startMinute) || startMinute < 0 || startMinute >= MINUTES_PER_DAY) {
      return null
    }
    if (
      typeof endMinute !== 'number' ||
      !Number.isInteger(endMinute) ||
      endMinute <= startMinute ||
      endMinute > MINUTES_PER_DAY
    ) {
      return null
    }
    if (endMinute - startMinute !== minutes) return null
    if (typeof entry.taskTitle !== 'string' || entry.taskTitle.length > 400) return null
    if (typeof entry.windowLabel !== 'string' || entry.windowLabel.length > 32) return null
    if (entry.startTime !== minuteToClock(startMinute) || entry.endTime !== minuteToClock(endMinute)) return null
    result.push({
      taskId,
      taskTitle: entry.taskTitle,
      windowLabel: entry.windowLabel,
      startTime: entry.startTime,
      endTime: entry.endTime,
      startMinute,
      endMinute,
      minutes,
    })
  }
  return result
}

const UNSCHEDULED_REASONS: readonly UnscheduledReason[] = [
  'NO_WINDOW',
  'INSUFFICIENT_TIME',
  'DEADLINE_PASSED',
  'DEADLINE_NOW',
  'INVALID_DEADLINE',
  'MISSING_TASK',
  'INACTIVE_TASK',
  'INVALID_TARGET',
  'DATE_NOT_TODAY',
  'INVALID_INPUT',
]

function asOutcomes(value: unknown, selections: readonly { taskId: number; minutes: number }[]): PlanTaskOutcome[] | null {
  if (!Array.isArray(value) || value.length > MAX_SELECTED_TASKS) return null
  if (value.length !== selections.length) return null
  const result: PlanTaskOutcome[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) return null
    const taskId = entry.taskId
    const targetMinutes = entry.targetMinutes
    const scheduledMinutes = entry.scheduledMinutes
    const unscheduledMinutes = entry.unscheduledMinutes
    if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return null
    const selection = selections.find((candidate) => candidate.taskId === taskId)
    if (!selection || selection.minutes !== targetMinutes) return null
    if (typeof targetMinutes !== 'number' || !Number.isInteger(targetMinutes) || targetMinutes <= 0) return null
    if (targetMinutes < PLAN_MINUTES_MIN || targetMinutes > PLAN_MINUTES_MAX) return null
    if (typeof scheduledMinutes !== 'number' || !Number.isInteger(scheduledMinutes) || scheduledMinutes < 0) return null
    if (typeof unscheduledMinutes !== 'number' || !Number.isInteger(unscheduledMinutes) || unscheduledMinutes < 0) return null
    if (scheduledMinutes + unscheduledMinutes !== targetMinutes) return null
    if (typeof entry.taskTitle !== 'string' || entry.taskTitle.length > 400) return null

    /**
     * 下面这几项**不再悄悄补默认值**（复核 13b）。
     *
     * 以前的做法是：`status` 不认识就写成 `TODO`、`deadline` 是对象就写成 `null`、
     * `courseId` 类型不对就写成 `null`、`blockCount` 缺失就写 0 ——
     * 那等于**替用户编了一份数据**，界面会把编出来的内容当成他当初排的计划。
     * 现在只要字段缺失或类型 / 取值不对，整条记录判定为「读不出来」，
     * 由上层如实告诉用户「这条记录不可用」，并原样保留那条原始记录。
     */
    const status = entry.status
    if (status !== 'TODO' && status !== 'DOING' && status !== 'DONE' && status !== 'CANCELLED') return null

    // deadline：允许 `null`（任务本来就没有 DDL），否则必须是可解析的 DDL：
    // 真实的带偏移 ISO 串，或只到日期的 `YYYY-MM-DD`（当天结束前）。
    let deadline: string | null = null
    if (entry.deadline !== null) {
      if (typeof entry.deadline !== 'string' || entry.deadline.length > 64) return null
      if (deadlineToEpochMs(entry.deadline) === null) return null
      deadline = entry.deadline
    }

    // courseId：允许 `null`（未关联课程），否则必须是正整数。
    let courseId: number | null = null
    if (entry.courseId !== null) {
      if (typeof entry.courseId !== 'number' || !Number.isSafeInteger(entry.courseId) || entry.courseId <= 0) return null
      courseId = entry.courseId
    }

    // courseName：与 courseId 一致 —— 关联了课程就必须有名字，没关联就必须是 `null`。
    let courseName: string | null = null
    if (entry.courseName !== null) {
      if (typeof entry.courseName !== 'string' || entry.courseName.length > 200) return null
      courseName = entry.courseName
    }
    if ((courseId === null) !== (courseName === null)) return null

    if (typeof entry.blockCount !== 'number' || !Number.isInteger(entry.blockCount) || entry.blockCount < 0) return null

    let unscheduled: PlanTaskOutcome['unscheduled'] = null
    if (entry.unscheduled !== null && entry.unscheduled !== undefined) {
      if (!isPlainObject(entry.unscheduled)) return null
      const reason = entry.unscheduled.reason
      const text = entry.unscheduled.text
      if (typeof reason !== 'string' || !UNSCHEDULED_REASONS.includes(reason as UnscheduledReason)) return null
      if (typeof text !== 'string' || text.length > 200) return null
      unscheduled = { reason: reason as UnscheduledReason, text }
    }
    // 「有没有没排完的分钟」与「有没有原因」必须一致，不允许只有一半。
    if ((unscheduledMinutes > 0) !== (unscheduled !== null)) return null

    result.push({
      taskId,
      taskTitle: entry.taskTitle,
      courseId,
      courseName,
      status,
      deadline,
      targetMinutes,
      scheduledMinutes,
      unscheduledMinutes,
      unscheduled,
      blockCount: entry.blockCount,
    })
  }
  return result
}

/**
 * 把库里读到的一段 JSON 解析成计划；任何不合法的结构都返回 `null`（由调用方给出可读原因）。
 *
 * 刻意**不**补默认值：宁可让用户看到「这份保存的计划读不出来」，
 * 也不要给他一份看起来正常、其实字段是猜出来的计划。
 */
export function parseTodayPlanPayload(raw: unknown): { plan: TodayPlan; revision: number } | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  if (raw.length > 200_000) return null
  let parsed: StoredPayload
  try {
    parsed = JSON.parse(raw) as StoredPayload
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.version !== TODAY_PLAN_STORAGE_VERSION) return null
  if (typeof parsed.date !== 'string' || parsed.date.length !== 10) return null
  if (typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1) return null
  if (typeof parsed.anchorEpochMs !== 'number' || !Number.isFinite(parsed.anchorEpochMs)) return null
  const windows = asWindows(parsed.windows)
  const selections = asSelections(parsed.selections)
  const windowLabels = asStringArray(parsed.windowLabels, MAX_STUDY_WINDOWS)
  if (!windows || !selections || !windowLabels) return null
  const blocks = asBlocks(parsed.blocks)
  const outcomes = asOutcomes(parsed.outcomes, selections)
  if (!blocks || !outcomes) return null
  const windowValidation = validateStudyWindows(windows)
  if (!windowValidation.ok) return null
  if (typeof parsed.contextDigest !== 'string' || parsed.contextDigest.length > 100_000) return null
  if (typeof parsed.algorithmVersion !== 'string' || parsed.algorithmVersion.length > 16) return null
  if (
    typeof parsed.scheduledMinutes !== 'number' ||
    !Number.isInteger(parsed.scheduledMinutes) ||
    parsed.scheduledMinutes < 0
  ) {
    return null
  }
  if (
    typeof parsed.unscheduledMinutes !== 'number' ||
    !Number.isInteger(parsed.unscheduledMinutes) ||
    parsed.unscheduledMinutes < 0
  ) {
    return null
  }
  if (typeof parsed.targetMinutes !== 'number' || !Number.isInteger(parsed.targetMinutes) || parsed.targetMinutes < 0) {
    return null
  }
  if (parsed.scheduledMinutes + parsed.unscheduledMinutes !== parsed.targetMinutes) return null

  /**
   * 日期与锚点必须自洽：锚点（排布用的「现在」）换算回上海自然日之后，
   * 必须正好是这份计划自己的那一天 —— 否则这份记录是拼出来的 / 被改过的，
   * 不能当成「今天的计划」展示。
   */
  const anchor = shanghaiMinuteOfDay(parsed.anchorEpochMs)
  if (!anchor || anchor.dateKey !== parsed.date) return null
  // 每个 outcome 的「计划分钟数」合计必须等于整份的合计（逐条对得上，不只是总数对得上）。
  const outcomeTargetTotal = outcomes.reduce((total, outcome) => total + outcome.targetMinutes, 0)
  if (outcomeTargetTotal !== parsed.targetMinutes) return null
  const outcomeScheduledTotal = outcomes.reduce((total, outcome) => total + outcome.scheduledMinutes, 0)
  if (outcomeScheduledTotal !== parsed.scheduledMinutes) return null
  const blockMinutesTotal = blocks.reduce((total, block) => total + block.minutes, 0)
  if (blockMinutesTotal !== parsed.scheduledMinutes) return null

  const plan: TodayPlan = {
    date: parsed.date,
    anchorEpochMs: parsed.anchorEpochMs,
    windowLabels,
    blocks,
    outcomes,
    scheduledMinutes: parsed.scheduledMinutes,
    unscheduledMinutes: parsed.unscheduledMinutes,
    targetMinutes: parsed.targetMinutes,
    hasUnscheduled: parsed.unscheduledMinutes > 0,
    emptyPlan: blocks.length === 0,
    // 空闲缺口与忙区间是**排布时的派生数据**，保存时不存（载荷要有界）：
    // 读回时用当时的窗口做容器检查，忙区间检查只在生成那一刻做（见 verifyTodayPlan 文档）。
    freeSlots: windowValidation.windows,
    busyIntervals: [],
    inputErrors: [],
    fingerprint: {
      date: parsed.date,
      windows: windowValidation.windows.map((window) => `${window.start}-${window.end}`),
      selections: [...selections].sort((a, b) => a.taskId - b.taskId).map((selection) => ({ ...selection })),
      contextDigest: parsed.contextDigest,
      algorithmVersion: parsed.algorithmVersion,
    },
    warnings: [],
  }
  const verification = verifyTodayPlan(plan)
  if (!verification.ok) return null
  return { plan, revision: parsed.revision }
}

/**
 * 今日计划的仓库。
 *
 * `db` 只用来读写 `app_settings` 里那一个键；任务 / 课表 / 课程由 `readContext` 提供，
 * 这样「重算」用的永远是**事务里刚读到的真实状态**，而不是界面手里的旧快照。
 */
export class TodayPlanRepository {
  private readonly db: SqliteDatabase
  private readonly readContext: TodayPlanContextSource
  private readonly now: () => Date

  constructor(db: SqliteDatabase, readContext: TodayPlanContextSource, now: () => Date = () => new Date()) {
    this.db = db
    this.readContext = readContext
    this.now = now
  }

  private async rawValue(): Promise<string | null> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [
      APP_SETTINGS_KEYS.TODAY_PLAN,
    ])
    return row ? String(row.value) : null
  }

  /**
   * 读今天的计划。
   *
   * - 没有保存过 → `{ ok: true, plan: null, revision: 0 }`（正常状态，不是错误）；
   * - 存的是**别的一天** → `plan: null` + `storedOtherDate: true`；
   * - 不可用（坏 JSON / 版本不认识 / 结构不合法）→ `{ ok: false, reason }`，
   *   **绝不**修改或删除那条记录。
   */
  async loadTodayPlan(date: string): Promise<TodayPlanLoadResult> {
    const raw = await this.rawValue()
    if (raw === null) return { ok: true, plan: null, revision: 0, storedOtherDate: false }
    const parsed = parseTodayPlanPayload(raw)
    if (!parsed) {
      return {
        ok: false,
        reason: '本机保存的今日计划读不出来（格式或版本不认识），这条记录会原样保留，暂时无法使用。',
        rawExcerpt: excerptOf(raw),
      }
    }
    if (parsed.plan.date !== date) {
      return { ok: true, plan: null, revision: parsed.revision, storedOtherDate: true }
    }
    return { ok: true, plan: parsed.plan, revision: parsed.revision, storedOtherDate: false }
  }

  /**
   * 保存（或替换）今天的计划 —— **唯一会写库的入口**。
   *
   * 步骤（**全部在同一个事务里**，任何一步失败都一个字节都不写）：
   * 1. 事务里**当场**读 `now()`（不在排队前读，避免排队期间时间溜走）；
   * 2. 读既有计划：JSON 坏 / 结构不合法 → 拒绝（不覆盖用户的数据）；
   * 3. 版本比对：`expectedRevision` 与库里不一致 → 拒绝；
   * 4. 日期守卫：`date` 必须等于**提交这一刻**的上海今天；
   * 5. 用预览的**分钟锚点** + 新鲜上下文重算，要求结果与预览**块身份一致**；
   * 6. 提交这一刻再校验：任何块**已经开始**（`startMinute <= 提交分钟`）→ 拒绝；
   * 7. 写入（版本 +1），再读回校验；读回失败时如实返回 `readbackError`（写入已提交）。
   */
  async saveTodayPlan(input: SaveTodayPlanInput): Promise<SaveTodayPlanResult> {
    const date = String(input.date ?? '')
    const windows: StudyWindowInput[] = (input.windows ?? []).map((window) => ({
      start: String(window?.start ?? ''),
      end: String(window?.end ?? ''),
    }))
    const selectionValidation = validatePlanSelections(input.selections ?? [])
    if (!selectionValidation.ok) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: selectionValidation.errors[0] ?? MALFORMED_MESSAGE,
        readbackError: null,
      }
    }
    const selections = selectionValidation.selections
    if (selections.length === 0) {
      return { ok: false, committed: false, revision: null, reason: '至少要选一个任务才能保存今天的计划。', readbackError: null }
    }
    if (selections.some((selection) => selection.minutes < PLAN_MINUTES_MIN)) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: `每个选中任务都要填 ${PLAN_MINUTES_MIN}–${PLAN_MINUTES_MAX} 之间的整数分钟。`,
        readbackError: null,
      }
    }
    const windowValidation = validateStudyWindows(windows)
    if (!windowValidation.ok) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: windowValidation.issues[0]?.message ?? '学习时段不合法。',
        readbackError: null,
      }
    }
    const preview = input.previewPlan
    if (!preview || typeof preview !== 'object' || !Number.isFinite(preview.anchorEpochMs)) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: '缺少这次预览的内容，请重新生成预览再保存。',
        readbackError: null,
      }
    }
    const previewAnchor = shanghaiMinuteOfDay(preview.anchorEpochMs)
    if (!previewAnchor || previewAnchor.dateKey !== date) {
      return { ok: false, committed: false, revision: null, reason: WRONG_DATE_MESSAGE, readbackError: null }
    }

    let committedRevision: number | null = null
    let rejection: SaveTodayPlanResult | null = null

    try {
      await this.db.withTransactionAsync(async () => {
        // 1) 事务里当场取「现在」。
        const commitNow = this.now()
        const commitMs = commitNow.getTime()
        const commitAnchor = Number.isFinite(commitMs) ? shanghaiMinuteOfDay(commitMs) : null
        if (!commitAnchor) {
          rejection = {
            ok: false,
            committed: false,
            revision: null,
            reason: '本机时间读数不可用，暂时无法保存。',
            readbackError: null,
          }
          return
        }

        // 2) 读既有计划（破损即拒绝，绝不覆盖）。
        const raw = await this.rawValue()
        let existingRevision = 0
        if (raw !== null) {
          const parsed = parseTodayPlanPayload(raw)
          if (!parsed) {
            rejection = { ok: false, committed: false, revision: null, reason: CORRUPT_MESSAGE, readbackError: null }
            return
          }
          existingRevision = parsed.revision
        }
        // 3) 乐观版本。
        if (existingRevision !== input.expectedRevision) {
          rejection = { ok: false, committed: false, revision: null, reason: CONFLICT_MESSAGE, readbackError: null }
          return
        }
        // 4) 日期守卫（提交这一刻）。
        if (!isPlanForToday(date, commitNow)) {
          rejection = {
            ok: false,
            committed: false,
            revision: null,
            reason: `现在已经是 ${shanghaiToday(commitNow)}，${date} 的计划不能再保存为今天的计划。`,
            readbackError: null,
          }
          return
        }

        // 5) 用**预览的锚点** + 新鲜上下文重算，要求与预览是同一份计划。
        const context = await this.readContext()
        const rederived = buildTodayPlan({
          date,
          now: new Date(previewAnchor.epochMs),
          windows,
          selections,
          tasks: context.tasks,
          schedules: context.schedules,
          courses: context.courses,
        })
        const verification = verifyTodayPlan(rederived)
        if (!verification.ok) {
          rejection = {
            ok: false,
            committed: false,
            revision: null,
            reason: `重算出来的计划没有通过自检（${verification.errors[0] ?? '未知原因'}）。`,
            readbackError: null,
          }
          return
        }
        /**
         * 5a) **上下文指纹**必须与预览一致。
         *
         * 块身份比对不够：任务标题这类**不影响排布、但用户看得见**的字段改了，
         * 块会一模一样，于是「看着旧标题存下去」——这正是复核 12 抓到的真实缺陷。
         * 用户确认的是「当时那份内容」，所以任何参与指纹的字段变了就必须重新生成预览。
         */
        const freshFingerprint = todayPlanFingerprint({
          date,
          windows: windowValidation.windows,
          selections,
          context: { tasks: context.tasks, schedules: context.schedules, courses: context.courses },
        })
        if (!sameTodayPlanFingerprint(freshFingerprint, preview.fingerprint)) {
          rejection = { ok: false, committed: false, revision: null, reason: CHANGED_MESSAGE, readbackError: null }
          return
        }
        if (!samePlanResult(rederived, preview)) {
          rejection = { ok: false, committed: false, revision: null, reason: CHANGED_MESSAGE, readbackError: null }
          return
        }

        // 6) 提交这一刻：任何块**已经开始**（开始分钟早于当前分钟）→ 拒绝，要求重新生成。
        //    是「早于」而不是「不晚于」：`startMinute === commitMinute` 表示这一分钟刚刚开始
        //    （例如预览与提交都落在 10:05），块正是从这一刻起算，仍然有效。
        if (rederived.blocks.some((block) => block.startMinute < commitAnchor.minute)) {
          rejection = { ok: false, committed: false, revision: null, reason: STALE_TIME_MESSAGE, readbackError: null }
          return
        }

        // 7) 写入（只存可校验的规范结构；空闲缺口这类派生数据不存）。
        const nextRevision = existingRevision + 1
        const payload = {
          version: TODAY_PLAN_STORAGE_VERSION,
          date,
          revision: nextRevision,
          savedAt: new Date(commitMs).toISOString(),
          anchorEpochMs: rederived.anchorEpochMs,
          windows,
          selections,
          blocks: rederived.blocks,
          outcomes: rederived.outcomes,
          scheduledMinutes: rederived.scheduledMinutes,
          unscheduledMinutes: rederived.unscheduledMinutes,
          targetMinutes: rederived.targetMinutes,
          windowLabels: rederived.windowLabels,
          contextDigest: rederived.fingerprint.contextDigest,
          algorithmVersion: rederived.fingerprint.algorithmVersion,
        }
        await this.db.runAsync(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [APP_SETTINGS_KEYS.TODAY_PLAN, JSON.stringify(payload), new Date(commitMs).toISOString()],
        )
        committedRevision = nextRevision
      })
    } catch (cause) {
      return {
        ok: false,
        committed: false,
        revision: null,
        reason: `保存今日计划失败：${cause instanceof Error ? cause.message : String(cause)}`,
        readbackError: null,
      }
    }

    if (rejection) return rejection
    if (committedRevision === null) {
      return { ok: false, committed: false, revision: null, reason: '保存没有完成，请再试一次。', readbackError: null }
    }

    // 写入已经提交 → 明确读回一次；读回失败也**不**改写「已提交」这个事实。
    try {
      const readBack = await this.loadTodayPlan(date)
      if (!readBack.ok) {
        return { ok: true, committed: true, revision: committedRevision, reason: null, readbackError: readBack.reason }
      }
      if (!readBack.plan) {
        return {
          ok: true,
          committed: true,
          revision: committedRevision,
          reason: null,
          readbackError: '保存后没有读回这份计划。',
        }
      }
      return { ok: true, committed: true, revision: committedRevision, reason: null, readbackError: null }
    } catch (cause) {
      return {
        ok: true,
        committed: true,
        revision: committedRevision,
        reason: null,
        readbackError: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }
}
