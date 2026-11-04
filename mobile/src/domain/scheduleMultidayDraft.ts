/**
 * 多天课表草稿（**纯函数，可测试**）。
 *
 * 用户这次的要求把课表表单从「一天一条」改成了「一次选多天，每天各自填时间与地点」：
 * - 星期可以多选，也可以显式「全选七天」；
 * - **每一天有自己的开始/结束时间与地点**，切换正在编辑的星期不会丢草稿；
 * - 至少要保留一天（取消最后一天会被拒绝，而不是把表单变成非法状态）；
 * - 保存前**逐天校验**，返回具体是哪一天、哪个字段有问题，界面据此切到出错的那一天；
 * - 「开始节次 / 结束节次」的输入框已经从界面移除，但**模型与旧数据保持不变**：
 *   编辑既有课表时把原记录的节次原样带回并写回，绝不因为界面改版就抹掉历史字段。
 *
 * 与数据库无关：真正的一次性写入（单事务）在 `courseRepository.applyScheduleBatch()`，
 * 这里只负责「草稿怎么变」和「保存计划长什么样」，因此可以直接跑单元测试。
 *
 * **复核定稿的修正**：一门课在**同一天可以有多段课**（真实课表里周日 08:00–09:35
 * 与 10:00–11:35 就是两段）。因此本模块不再按「这一天被占用」拒绝，
 * 只按「同一天 + 同一时段」判重；判定规则在 `scheduleSession.ts`，与仓库层共用同一份。
 */

import { normalizeScheduleDraft } from './courseDraft'
import { ValidationError } from './errors'
import type { WeekPattern } from './scheduleRules'
import { isSameSessionSlot } from './scheduleSession'
import { emptyScheduleDraft, type Schedule, type ScheduleDraft } from './types'

export const ALL_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7]

/** 教学周三件套与周次规律是所有天共享的，出错时挂在表单级字段上。 */
const SHARED_DRAFT_FIELDS: readonly string[] = ['semesterStartDate', 'startWeek', 'endWeek', 'weekPattern']

/** 某一天某个字段的错误键，例如 `day:3:endTime`。 */
export function weekdayFieldErrorKey(weekday: number, field: string): string {
  return `day:${weekday}:${field}`
}

/** 某一天本身的错误键（冲突、缺少等），例如 `weekday:3`。 */
export function weekdayErrorKey(weekday: number): string {
  return `weekday:${weekday}`
}

export interface WeekdayDraftEntry {
  weekday: number
  startTime: string
  endTime: string
  location: string
  /** 旧字段：界面上已移除输入；编辑既有课表时原样带回，避免破坏历史数据。 */
  periodStart: string
  periodEnd: string
}

export interface MultidayScheduleDraft {
  /** 已勾选的星期，升序，**永不为空**。 */
  selectedWeekdays: number[]
  /**
   * 每个星期各自的草稿。取消勾选**不删除**这里的草稿，
   * 所以「取消后再选回来」不会丢之前填的时间与地点。
   */
  entries: Record<number, WeekdayDraftEntry>
  /** 当前正在编辑的星期；一定在 `selectedWeekdays` 里。 */
  activeWeekday: number
  semesterStartDate: string
  startWeek: string
  endWeek: string
  weekPattern: WeekPattern
}

export interface WeekdayToggleResult {
  draft: MultidayScheduleDraft
  changed: boolean
  /** `LAST_WEEKDAY` = 拒绝取消，因为至少要保留一天；正常改动为 `null`。 */
  blockedReason: 'LAST_WEEKDAY' | null
}

export interface MultidayValidationIssue {
  weekday: number
  field: string
  message: string
}

export interface MultidayValidationResult {
  ok: boolean
  /** 表单级字段（教学周等）→ 说明。 */
  sharedErrors: Record<string, string>
  /** `day:<weekday>:<field>` → 说明。 */
  dayErrors: Record<string, string>
  /** 逐天的错误摘要，`firstInvalidWeekday` 是界面要自动切过去的那一天。 */
  issues: MultidayValidationIssue[]
  firstInvalidWeekday: number | null
}

function entryFromSchedule(schedule: Schedule): WeekdayDraftEntry {
  return {
    weekday: schedule.weekday,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    location: schedule.location ?? '',
    periodStart: schedule.periodStart === null ? '' : String(schedule.periodStart),
    periodEnd: schedule.periodEnd === null ? '' : String(schedule.periodEnd),
  }
}

function entryFromDefaults(weekday: number, defaults?: Partial<WeekdayDraftEntry>): WeekdayDraftEntry {
  const base = emptyScheduleDraft(weekday)
  return {
    weekday,
    startTime: defaults?.startTime ?? base.startTime,
    endTime: defaults?.endTime ?? base.endTime,
    location: defaults?.location ?? base.location,
    periodStart: defaults?.periodStart ?? base.periodStart,
    periodEnd: defaults?.periodEnd ?? base.periodEnd,
  }
}

function sortedWeekdays(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right)
}

/** 读取某一天的草稿；没有就按默认值现建一个（不写进 draft）。 */
export function entryOf(draft: MultidayScheduleDraft, weekday: number): WeekdayDraftEntry {
  return draft.entries[weekday] ?? entryFromDefaults(weekday)
}

/** 新建的空白多天草稿：默认只选一天（周一）并处于编辑状态。 */
export function createMultidayDraft(
  options: {
    weekday?: number
    semesterStartDate?: string
    startWeek?: string
    endWeek?: string
    weekPattern?: WeekPattern
  } = {},
): MultidayScheduleDraft {
  const weekday = options.weekday ?? 1
  return {
    selectedWeekdays: [weekday],
    entries: { [weekday]: entryFromDefaults(weekday) },
    activeWeekday: weekday,
    semesterStartDate: options.semesterStartDate ?? '',
    startWeek: options.startWeek ?? '',
    endWeek: options.endWeek ?? '',
    weekPattern: options.weekPattern ?? 'ALL',
  }
}

/** 从既有课表行生成多天草稿：只勾选原来那一天，其它天留空待用户添加。 */
export function multidayDraftFromSchedule(schedule: Schedule): MultidayScheduleDraft {
  return {
    selectedWeekdays: [schedule.weekday],
    entries: { [schedule.weekday]: entryFromSchedule(schedule) },
    activeWeekday: schedule.weekday,
    semesterStartDate: schedule.semesterStartDate ?? '',
    startWeek: schedule.startWeek === null ? '' : String(schedule.startWeek),
    endWeek: schedule.endWeek === null ? '' : String(schedule.endWeek),
    weekPattern: schedule.weekPattern,
  }
}

/** 取消 active 那天之后，把编辑焦点交给「最近的」剩余一天：先往后找，再往前找。 */
function nextActiveWeekday(remaining: readonly number[], removed: number): number {
  const after = remaining.find((weekday) => weekday > removed)
  if (after !== undefined) return after
  const before = [...remaining].reverse().find((weekday) => weekday < removed)
  return before ?? remaining[0] ?? ALL_WEEKDAYS[0]!
}

/**
 * 勾选 / 取消某一天。
 *
 * 取消最后一天会被**拒绝**（`blockedReason === 'LAST_WEEKDAY'`）而不是静默变成非法草稿：
 * 界面据此提示「至少要保留一天」。
 */
export function toggleWeekday(draft: MultidayScheduleDraft, weekday: number): WeekdayToggleResult {
  const selected = draft.selectedWeekdays.includes(weekday)
  if (selected) {
    if (draft.selectedWeekdays.length <= 1) {
      return { draft, changed: false, blockedReason: 'LAST_WEEKDAY' }
    }
    const remaining = draft.selectedWeekdays.filter((value) => value !== weekday)
    const activeWeekday = draft.activeWeekday === weekday ? nextActiveWeekday(remaining, weekday) : draft.activeWeekday
    return {
      draft: { ...draft, selectedWeekdays: remaining, activeWeekday },
      changed: true,
      blockedReason: null,
    }
  }
  // 新勾选的一天立刻成为正在编辑的一天，用户可以直接填它的时间与地点。
  const entries = draft.entries[weekday] ? draft.entries : { ...draft.entries, [weekday]: entryFromDefaults(weekday) }
  return {
    draft: {
      ...draft,
      selectedWeekdays: sortedWeekdays([...draft.selectedWeekdays, weekday]),
      entries,
      activeWeekday: weekday,
    },
    changed: true,
    blockedReason: null,
  }
}

/** 显式「全选七天」；已经填过的草稿保持不变。 */
export function selectAllWeekdays(draft: MultidayScheduleDraft): MultidayScheduleDraft {
  const entries: Record<number, WeekdayDraftEntry> = { ...draft.entries }
  for (const weekday of ALL_WEEKDAYS) {
    if (!entries[weekday]) entries[weekday] = entryFromDefaults(weekday)
  }
  return { ...draft, selectedWeekdays: [...ALL_WEEKDAYS], entries }
}

/** 仅切换到某一天编辑；未勾选的天不能被激活。 */
export function setActiveWeekday(draft: MultidayScheduleDraft, weekday: number): MultidayScheduleDraft {
  if (!draft.selectedWeekdays.includes(weekday)) return draft
  if (draft.activeWeekday === weekday) return draft
  return { ...draft, activeWeekday: weekday }
}

/** 修改「正在编辑的那一天」的时间 / 地点（节次不在界面上，只能由旧数据带回）。 */
export function updateActiveEntry(
  draft: MultidayScheduleDraft,
  patch: Partial<Pick<WeekdayDraftEntry, 'startTime' | 'endTime' | 'location'>>,
): MultidayScheduleDraft {
  const current = entryOf(draft, draft.activeWeekday)
  const next: WeekdayDraftEntry = { ...current, ...patch, weekday: draft.activeWeekday }
  return { ...draft, entries: { ...draft.entries, [draft.activeWeekday]: next } }
}

/** 更新教学周设置（所有天共享）。 */
export function updateTerm(
  draft: MultidayScheduleDraft,
  patch: Partial<Pick<MultidayScheduleDraft, 'semesterStartDate' | 'startWeek' | 'endWeek' | 'weekPattern'>>,
): MultidayScheduleDraft {
  return { ...draft, ...patch }
}

/** 把某一天的草稿摊平成仓库层认识的 `ScheduleDraft`（教学周信息来自共享部分）。 */
export function scheduleDraftForWeekday(draft: MultidayScheduleDraft, weekday: number): ScheduleDraft {
  const entry = entryOf(draft, weekday)
  return {
    weekday,
    startTime: entry.startTime,
    endTime: entry.endTime,
    location: entry.location,
    periodStart: entry.periodStart,
    periodEnd: entry.periodEnd,
    semesterStartDate: draft.semesterStartDate,
    startWeek: draft.startWeek,
    endWeek: draft.endWeek,
    weekPattern: draft.weekPattern,
  }
}

/** 按星期升序，把已勾选的天摊平成待保存的草稿列表。 */
export function scheduleDraftsForSelected(draft: MultidayScheduleDraft): ScheduleDraft[] {
  return sortedWeekdays(draft.selectedWeekdays).map((weekday) => scheduleDraftForWeekday(draft, weekday))
}

/**
 * 逐天校验**所有已勾选的天**（不只是正在编辑的那一天）。
 *
 * 返回的 `firstInvalidWeekday` 供界面自动切换到第一个出错的天，
 * `dayErrors` 的键是 `day:<weekday>:<field>`，与表单里的字段一一对应。
 */
export function validateMultidayDraft(draft: MultidayScheduleDraft): MultidayValidationResult {
  const sharedErrors: Record<string, string> = {}
  const dayErrors: Record<string, string> = {}
  const issues: MultidayValidationIssue[] = []

  if (draft.selectedWeekdays.length === 0) {
    sharedErrors.weekdays = '请至少选择一天上课。'
    return { ok: false, sharedErrors, dayErrors, issues, firstInvalidWeekday: null }
  }

  let firstInvalidWeekday: number | null = null

  for (const weekday of sortedWeekdays(draft.selectedWeekdays)) {
    let hasDayIssue = false
    try {
      normalizeScheduleDraft(scheduleDraftForWeekday(draft, weekday))
    } catch (cause) {
      if (!(cause instanceof ValidationError)) throw cause
      for (const [field, message] of Object.entries(cause.fields)) {
        if (SHARED_DRAFT_FIELDS.includes(field)) {
          if (!sharedErrors[field]) sharedErrors[field] = message
          continue
        }
        dayErrors[weekdayFieldErrorKey(weekday, field)] = message
        issues.push({ weekday, field, message })
        hasDayIssue = true
      }
    }
    // 只有「这一天自己的字段」出错才需要把界面切过去；共享字段（教学周）出错不算某一天的问题。
    if (hasDayIssue && firstInvalidWeekday === null) firstInvalidWeekday = weekday
  }

  return {
    ok: Object.keys(sharedErrors).length === 0 && Object.keys(dayErrors).length === 0,
    sharedErrors,
    dayErrors,
    issues,
    firstInvalidWeekday,
  }
}

export interface MultidaySaveContext {
  /** 正在编辑的既有课表行；新建时为 `null`。 */
  original: { scheduleId: number; weekday: number } | null
  /**
   * 同一课程里**其它**课表行的实际时段与教学周范围（不含 `original`）。
   *
   * 复核定稿：这里**不再**是「已被占用的星期」，而是完整的时段 + 周次范围。
   * 同一天可以有多段课（周日 08:00–09:35 与 10:00–11:35），
   * 同一时段也可以有单周与双周两条 —— 只有「同一天 + 同一时段 + 同一教学周范围」
   * 才算重复。缺省视为空数组。
   */
  existingSessions?: ReadonlyArray<{
    weekday: number
    startTime: string
    endTime: string
    weekPattern?: string | null
    semesterStartDate?: string | null
    startWeek?: number | null
    endWeek?: number | null
  }>
  /**
   * @deprecated 旧口径「其它行占用的星期」会把同一天的第二段课、单双周各一条
   * 误判为冲突。仅为兼容旧调用方保留，不再据此拒绝任何一天。
   */
  occupiedWeekdays?: readonly number[]
}

export interface MultidaySavePlan {
  /** 精确按 id 更新（只会碰到这些行）。 */
  updates: Array<{ scheduleId: number; draft: ScheduleDraft }>
  /** 新增的天。 */
  creates: ScheduleDraft[]
  /**
   * 同一课程里**同一天同一时段、且教学周范围也相同**的那一条已经存在：
   * 不覆盖、不重复插入，交给用户去编辑原来的那一条。
   * 注意这是「重复的那一段」，不是「这一天」，也不是「这个时段」。
   */
  duplicates: number[]
  /** 用户取消了原记录所在的那一天 → 原记录保持不动（不更新、不删除）。 */
  untouchedOriginalScheduleId: number | null
}

/**
 * 由多天草稿生成保存计划。
 *
 * 关键取舍（都为了「不破坏既有数据」）：
 * - **原记录只在它那一天仍被勾选时才更新**；取消了就保持不动，绝不误删、误改；
 * - 同一天**允许**存在多段不同的课、同一时段也允许单双周各一条：
 *   只有「同一天 + 同一时段 + 同一教学周范围」才算重复，记为 `duplicates`
 *   由界面提示用户直接编辑那一条；
 * - 原记录的节次（period）由其草稿原样带回，界面移除输入不会抹掉历史字段。
 */
export function buildMultidaySavePlan(
  draft: MultidayScheduleDraft,
  context: MultidaySaveContext,
): MultidaySavePlan {
  const selected = new Set(sortedWeekdays(draft.selectedWeekdays))
  const existing = context.existingSessions ?? []
  const updates: Array<{ scheduleId: number; draft: ScheduleDraft }> = []
  const creates: ScheduleDraft[] = []
  const duplicates: number[] = []

  for (const weekday of sortedWeekdays(draft.selectedWeekdays)) {
    const rowDraft = scheduleDraftForWeekday(draft, weekday)
    if (context.original && context.original.weekday === weekday) {
      updates.push({ scheduleId: context.original.scheduleId, draft: rowDraft })
      continue
    }
    // 只有「同一天同一时段」才算重复：同一天的另一段时间是合法的第二段课。
    const duplicated = existing.some((session) => isSameSessionSlot(session, rowDraft))
    if (duplicated) {
      duplicates.push(weekday)
      continue
    }
    creates.push(rowDraft)
  }

  const untouchedOriginalScheduleId =
    context.original && !selected.has(context.original.weekday) ? context.original.scheduleId : null

  return { updates, creates, duplicates, untouchedOriginalScheduleId }
}
