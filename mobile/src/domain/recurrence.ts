/**
 * 重复任务（纯逻辑，可跑在 Hermes 与 Node）。
 *
 * 本版本**刻意不做后台定时任务**：用户在规则页先看到“实际日期 / 实际任务”的预览，
 * 再显式点「按规则批量创建」。应用关闭时不会自动生成任何任务，界面上也不会暗示
 * iOS 能在应用关闭后自动建任务。
 *
 * 语义：
 * - 频率：每天，或每周（可多选周几）；
 * - 开始 / 结束日期都是**北京时间自然日**，首尾都包含；
 * - 时间可选：留空 = 当天截止的裸日期（`YYYY-MM-DD`），绝不强补 23:59 / 00:00；
 * - 每条生成的任务都是独立可编辑任务，初始状态 TODO，提醒默认关闭；
 * - 去重身份是 `(规则ID, 日期)` 账本，不是“标题哈希”——
 *   不同规则 / 不同日期可以有同一条标题，这是合法的。
 */

import { addDaysToDateKey, dateKeyToDayNumber, isValidDateKey, weekdayName, weekdayOfDateKey } from './datetime'
import { ValidationError } from './errors'
import { normalizeTaskDraft } from './taskDraft'
import { emptyTaskDraft } from './types'
import type { TaskDraft, TaskPriority, TaskType } from './types'

/* ------------------------------- 上限 ------------------------------- */

export const RECURRENCE_LIMITS = {
  /** 单机最多保存多少条规则。 */
  maxRules: 40,
  /** 单条规则最多包含多少天（首尾都算）。 */
  maxRangeDays: 90,
  /** 单次预览 / 生成最多多少个候选任务（与 90 天上限互为兜底）。 */
  maxOccurrences: 100,
  /** 单机账本最多多少条（每条 = 一次“某规则某天已生成/已跳过”）。 */
  maxLedgerEntries: 4000,
  /** 规则名称长度。 */
  maxNameLength: 80,
  /** `task_recurrence.v1` 序列化后的字节上限。 */
  maxStoreBytes: 1_500_000,
} as const

export type RecurrenceCadence = 'DAILY' | 'WEEKLY'

export const RECURRENCE_CADENCE_LABELS: Record<RecurrenceCadence, string> = {
  DAILY: '每天',
  WEEKLY: '每周',
}

/* ------------------------------- 类型 ------------------------------- */

export interface RecurrenceRuleInput {
  name: string
  /** 来源模板（仅作来源说明；规则内容已快照，编辑模板不会改写既有任务）。 */
  templateId: number | null
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  /** 空串 = 未估算（生成的任务同样保持空白）。 */
  estimatedMinutes: string
  submitRequirement: string
  submitMethod: string
  courseId: number | null
  cadence: RecurrenceCadence
  /** 仅 WEEKLY 使用：1=周一 … 7=周日，可多选。 */
  weekdays: number[]
  startDate: string
  endDate: string
  /** `HH:mm`；空串 = 当天截止（日期精度）。 */
  time: string
}

export interface NormalizedRecurrenceRule {
  name: string
  templateId: number | null
  title: string
  description: string | null
  type: TaskType
  priority: TaskPriority
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
  courseId: number | null
  cadence: RecurrenceCadence
  weekdays: number[]
  startDate: string
  endDate: string
  time: string | null
}

export interface RecurrenceRule extends NormalizedRecurrenceRule {
  id: number
  revision: number
  createdAt: string
  updatedAt: string
}

export type RecurrenceLedgerStatus = 'CREATED' | 'SKIPPED'

export interface RecurrenceLedgerEntry {
  ruleId: number
  date: string
  taskId: number | null
  status: RecurrenceLedgerStatus
  createdAt: string
}

export interface RecurrenceStore {
  version: 1
  nextRuleId: number
  rules: RecurrenceRule[]
  ledger: RecurrenceLedgerEntry[]
}

export interface RecurrenceOccurrence {
  date: string
  weekday: number
  /** 裸日期（未填时间）或 `YYYY-MM-DDTHH:mm`（已填时间）。 */
  deadline: string
}

export type RecurrenceOccurrenceStatus = 'AVAILABLE' | 'CREATED' | 'DELETED' | 'SKIPPED'

export interface RecurrenceOccurrencePreview extends RecurrenceOccurrence {
  status: RecurrenceOccurrenceStatus
  taskId: number | null
}

export interface RecurrencePreviewContext {
  courseIds: ReadonlySet<number>
  templates: ReadonlyMap<number, { updatedAt: string; revision: number }>
  ledger: readonly RecurrenceLedgerEntry[]
  existingTaskIds: ReadonlySet<number>
  /** 新建规则传 `null`；编辑既有规则传它的 id 与当前 revision。 */
  ruleId: number | null
  ruleRevision: number
  /**
   * 预览时持久化在规则库里的 `nextRuleId`。
   *
   * 新建规则时它必须进入指纹：第一次生成会消耗这个 id 并把它 +1，
   * 于是**同一份已确认预览**在重试 / 重开 / 刷新失败后再次提交时会得到
   * “指纹过期”，由仓库拒绝或返回已存在结果，绝不会再建第二条规则。
   * 这是持久化在 SQLite 里的权威重放证明，不依赖 UI 的 busy 标记。
   */
  nextRuleId: number
}

export interface RecurrencePreview {
  ok: true
  fingerprint: string
  rule: NormalizedRecurrenceRule
  occurrences: RecurrenceOccurrencePreview[]
  availableCount: number
  createdCount: number
  deletedCount: number
  skippedCount: number
  warnings: string[]
  blockedReason: string | null
  /** 实际日期范围（首尾包含），用于界面说明。 */
  rangeDays: number
}

export interface RecurrencePreviewFailure {
  ok: false
  reason: string
  fields: Record<string, string>
}

export type RecurrencePreviewResult = RecurrencePreview | RecurrencePreviewFailure

export interface ApplyTemplateToRuleResult {
  input: RecurrenceRuleInput
  warnings: string[]
}

/* ------------------------------ 小工具 ------------------------------ */

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function isSafePositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function normalizeClock(raw: string): string | null | 'INVALID' {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (!match) return 'INVALID'
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return 'INVALID'
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeWeekdays(raw: readonly unknown[]): number[] | null {
  const seen = new Set<number>()
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 7) return null
    seen.add(value)
  }
  if (seen.size === 0) return null
  return [...seen].sort((a, b) => a - b)
}

/** 稳定 JSON：同一输入永远得到同一指纹，不受对象键顺序影响。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const object = value as Record<string, unknown>
  const keys = Object.keys(object).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

/* ------------------------------ 归一化 ------------------------------ */

/** 规则里的任务内容复用现有任务校验（标题 / 长度 / 课程 ID / 预计用时等）。 */
export function normalizeRecurrenceRule(input: RecurrenceRuleInput): NormalizedRecurrenceRule {
  const fields: Record<string, string> = {}

  const name = String(input.name ?? '').trim()
  if (name.length === 0) fields.name = '请填写规则名称。'
  else if (name.length > RECURRENCE_LIMITS.maxNameLength) {
    fields.name = `规则名称最长 ${RECURRENCE_LIMITS.maxNameLength} 字（当前 ${name.length}）。`
  }

  let title = ''
  let description: string | null = null
  let type: TaskType = 'HOMEWORK'
  let priority: TaskPriority = 3
  let estimatedMinutes: number | null = null
  let submitRequirement: string | null = null
  let submitMethod: string | null = null
  let courseId: number | null = null
  try {
    const normalizedTask = normalizeTaskDraft({
      ...emptyTaskDraft(),
      title: String(input.title ?? ''),
      description: String(input.description ?? ''),
      type: input.type,
      priority: input.priority,
      estimatedMinutes: String(input.estimatedMinutes ?? ''),
      submitRequirement: String(input.submitRequirement ?? ''),
      submitMethod: String(input.submitMethod ?? ''),
      courseId: input.courseId,
      status: 'TODO',
      deadline: '',
      originalText: '',
    })
    title = normalizedTask.title
    description = normalizedTask.description
    type = normalizedTask.type
    priority = normalizedTask.priority
    estimatedMinutes = normalizedTask.estimatedMinutes
    submitRequirement = normalizedTask.submitRequirement
    submitMethod = normalizedTask.submitMethod
    courseId = normalizedTask.courseId
  } catch (cause) {
    if (cause instanceof ValidationError) {
      for (const [key, message] of Object.entries(cause.fields)) {
        fields[`task_${key}`] = message
      }
    } else {
      throw cause
    }
  }

  let templateId: number | null = null
  if (input.templateId !== null && input.templateId !== undefined) {
    if (!isSafePositiveInt(input.templateId)) fields.templateId = '来源模板不合法。'
    else templateId = input.templateId
  }

  const cadence = input.cadence
  if (cadence !== 'DAILY' && cadence !== 'WEEKLY') fields.cadence = '频率只能是每天或每周。'

  let weekdays: number[] = []
  if (input.cadence === 'WEEKLY') {
    const normalized = normalizeWeekdays(input.weekdays ?? [])
    if (normalized === null) fields.weekdays = '每周规则请至少选择一个周几（可多选）。'
    else weekdays = normalized
  } else if (cadence === 'DAILY') {
    weekdays = []
  }

  const startDate = String(input.startDate ?? '').trim()
  const endDate = String(input.endDate ?? '').trim()
  if (!isValidDateKey(startDate)) fields.startDate = '开始日期不是真实存在的日期（例如 2026-02-30 不允许）。'
  if (!isValidDateKey(endDate)) fields.endDate = '结束日期不是真实存在的日期（例如 2027-02-29 不允许）。'
  let rangeDays = 0
  if (isValidDateKey(startDate) && isValidDateKey(endDate)) {
    const startDay = dateKeyToDayNumber(startDate)!
    const endDay = dateKeyToDayNumber(endDate)!
    if (endDay < startDay) fields.endDate = '结束日期不能早于开始日期。'
    else {
      rangeDays = endDay - startDay + 1
      if (rangeDays > RECURRENCE_LIMITS.maxRangeDays) {
        fields.endDate = `一次最多创建 ${RECURRENCE_LIMITS.maxRangeDays} 天内的任务（当前 ${rangeDays} 天），请缩短范围。`
      }
    }
  }

  const normalizedClock = normalizeClock(input.time ?? '')
  if (normalizedClock === 'INVALID') fields.time = '时间请选择真实存在的 HH:mm（例如 23:59），或留空表示当天截止。'
  const time = normalizedClock === 'INVALID' ? null : normalizedClock

  if (Object.keys(fields).length > 0) {
    throw new ValidationError('重复规则还有问题需要修改。', fields)
  }

  return {
    name,
    templateId,
    title,
    description,
    type,
    priority,
    estimatedMinutes,
    submitRequirement,
    submitMethod,
    courseId,
    cadence,
    weekdays,
    startDate,
    endDate,
    time,
  }
}

/* --------------------------- 候选日期 / 预览 --------------------------- */

/** 规则范围内实际会被创建的自然日（首尾包含），带可选时刻。 */
export function buildOccurrences(rule: NormalizedRecurrenceRule): RecurrenceOccurrence[] {
  const startDay = dateKeyToDayNumber(rule.startDate)
  const endDay = dateKeyToDayNumber(rule.endDate)
  if (startDay === null || endDay === null || endDay < startDay) return []
  const weekdays = new Set(rule.weekdays)
  const occurrences: RecurrenceOccurrence[] = []
  for (let day = startDay; day <= endDay; day += 1) {
    const date = addDaysToDateKey(rule.startDate, day - startDay)
    if (!date) continue
    const weekday = weekdayOfDateKey(date)
    if (weekday === null) continue
    if (rule.cadence === 'WEEKLY' && !weekdays.has(weekday)) continue
    occurrences.push({
      date,
      weekday,
      deadline: rule.time ? `${date}T${rule.time}` : date,
    })
    if (occurrences.length > RECURRENCE_LIMITS.maxOccurrences) break
  }
  return occurrences
}

/** 日期 + 可选时刻 → 生成任务用的草稿（状态 TODO、原文为空、提醒不创建）。 */
export function taskDraftForOccurrence(
  rule: NormalizedRecurrenceRule,
  occurrence: Pick<RecurrenceOccurrence, 'date' | 'deadline'>,
): TaskDraft {
  return {
    title: rule.title,
    description: rule.description ?? '',
    courseId: rule.courseId,
    type: rule.type,
    status: 'TODO',
    priority: rule.priority,
    deadline: occurrence.deadline,
    estimatedMinutes: rule.estimatedMinutes === null ? '' : String(rule.estimatedMinutes),
    submitRequirement: rule.submitRequirement ?? '',
    submitMethod: rule.submitMethod ?? '',
    originalText: '',
  }
}

/**
 * 预览指纹。
 *
 * 只要规则内容、来源模板 revision、课程是否存在、规则 revision 有变化，指纹就会变；
 * 新建规则还会把持久化的 `nextRuleId` 纳入指纹，因此**同一份确认预览**在第一次
 * 生成消耗掉该 id 之后就无法再次通过事务内的权威校验。
 * 生成时仓库会在**事务内部**重新计算并比较，旧预览绝不允许写库。
 */
export function recurrenceFingerprint(
  rule: NormalizedRecurrenceRule,
  context: Pick<RecurrencePreviewContext, 'templates' | 'courseIds' | 'ruleId' | 'ruleRevision' | 'nextRuleId'>,
): string {
  const template = rule.templateId === null ? null : (context.templates.get(rule.templateId) ?? null)
  const templateRevision = template
    ? { revision: template.revision, updatedAt: template.updatedAt }
    : null
  const coursePresent = rule.courseId === null ? true : context.courseIds.has(rule.courseId)
  return stableStringify({
    version: 1,
    ruleId: context.ruleId,
    ruleRevision: context.ruleRevision,
    // 只有新建规则需要“一次性确认令牌”；编辑既有规则由 id + revision 证明身份。
    newRuleToken: context.ruleId === null ? context.nextRuleId : null,
    rule,
    templateRevision,
    coursePresent,
  })
}

/** 预览：实际日期、每条候选的账本状态、已创建 / 已删除 / 可创建的计数。 */
export function buildRecurrencePreview(
  input: RecurrenceRuleInput,
  context: RecurrencePreviewContext,
): RecurrencePreviewResult {
  let rule: NormalizedRecurrenceRule
  try {
    rule = normalizeRecurrenceRule(input)
  } catch (cause) {
    if (cause instanceof ValidationError) {
      return { ok: false, reason: cause.message, fields: cause.fields }
    }
    throw cause
  }

  const warnings: string[] = []
  let blockedReason: string | null = null
  if (rule.courseId !== null && !context.courseIds.has(rule.courseId)) {
    blockedReason = '规则里保存的课程已不在本机；请重新选择课程（或明确改为不关联课程）后再创建，应用不会把它挂到别的课程上。'
    warnings.push(blockedReason)
  }
  if (rule.templateId !== null && !context.templates.has(rule.templateId)) {
    warnings.push('来源模板已删除；规则仍按保存时的内容快照生效，已创建的任务不受影响。')
  }

  const ledgerByDate = new Map<string, RecurrenceLedgerEntry>()
  for (const entry of context.ledger) {
    if (entry.ruleId !== (context.ruleId ?? -1)) continue
    ledgerByDate.set(entry.date, entry)
  }

  const occurrences: RecurrenceOccurrencePreview[] = []
  let availableCount = 0
  let createdCount = 0
  let deletedCount = 0
  let skippedCount = 0
  for (const occurrence of buildOccurrences(rule)) {
    const entry = ledgerByDate.get(occurrence.date)
    let status: RecurrenceOccurrenceStatus = 'AVAILABLE'
    let taskId: number | null = null
    if (entry) {
      if (entry.status === 'SKIPPED') {
        status = 'SKIPPED'
        skippedCount += 1
      } else {
        taskId = entry.taskId
        if (entry.taskId !== null && context.existingTaskIds.has(entry.taskId)) {
          status = 'CREATED'
          createdCount += 1
        } else {
          // 用户删掉了这次生成的任务（或账本里没有可用任务 ID）。
          // 这是**已完成过的历史**：再次生成必须明确跳过，不能悄悄补回来。
          status = 'DELETED'
          deletedCount += 1
        }
      }
    } else {
      availableCount += 1
    }
    occurrences.push({ ...occurrence, status, taskId })
  }

  if (occurrences.length === 0) {
    return {
      ok: false,
      reason: '这个日期范围里没有符合频率的日期，请调整开始 / 结束日期或每周的周几。',
      fields: { weekdays: '这个范围内没有可创建的日期。' },
    }
  }

  const startDay = dateKeyToDayNumber(rule.startDate)!
  const endDay = dateKeyToDayNumber(rule.endDate)!
  return {
    ok: true,
    fingerprint: recurrenceFingerprint(rule, context),
    rule,
    occurrences,
    availableCount,
    createdCount,
    deletedCount,
    skippedCount,
    warnings,
    blockedReason,
    rangeDays: endDay - startDay + 1,
  }
}

/** 把模板内容填入规则编辑器（用户显式点“使用此模板”才调用）。 */
export function ruleInputFromTemplate(
  base: RecurrenceRuleInput,
  template: {
    title: string | null
    description: string | null
    type: TaskType | null
    priority: TaskPriority | null
    estimatedMinutes: number | null
    submitRequirement: string | null
    submitMethod: string | null
    courseId: number | null
    id: number
  },
): ApplyTemplateToRuleResult {
  const warnings: string[] = []
  return {
    input: {
      ...base,
      templateId: template.id,
      title: template.title ?? base.title,
      description: template.description ?? base.description,
      type: template.type ?? base.type,
      priority: template.priority ?? base.priority,
      estimatedMinutes:
        template.estimatedMinutes === null ? base.estimatedMinutes : String(template.estimatedMinutes),
      submitRequirement: template.submitRequirement ?? base.submitRequirement,
      submitMethod: template.submitMethod ?? base.submitMethod,
      courseId: template.courseId === null ? base.courseId : template.courseId,
    },
    warnings,
  }
}

/* ------------------------------ 存储编解码 ------------------------------ */

export function emptyRecurrenceStore(): RecurrenceStore {
  return { version: 1, nextRuleId: 1, rules: [], ledger: [] }
}

export function encodeRecurrenceStore(store: RecurrenceStore): string {
  return JSON.stringify({
    version: 1,
    nextRuleId: store.nextRuleId,
    rules: store.rules,
    ledger: store.ledger,
  })
}

export interface RecurrenceStoreDecodeResult {
  ok: boolean
  store: RecurrenceStore
  reason: string | null
}

function failDecode(reason: string): RecurrenceStoreDecodeResult {
  return { ok: false, store: emptyRecurrenceStore(), reason }
}

function decodeRuleRow(raw: unknown): { ok: true; rule: RecurrenceRule } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '重复规则不是对象。' }
  const row = raw as Record<string, unknown>
  const id = row.id
  if (!isSafePositiveInt(id)) return { ok: false, reason: '重复规则 ID 不是正整数。' }
  const revision = row.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return { ok: false, reason: '重复规则 revision 不合法。' }
  }
  const createdAt = String(row.createdAt ?? '')
  const updatedAt = String(row.updatedAt ?? '')
  if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: '重复规则创建时间不是 ISO。' }
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/.test(updatedAt) || Number.isNaN(Date.parse(updatedAt))) {
    return { ok: false, reason: '重复规则更新时间不是 ISO。' }
  }
  const templateId = row.templateId
  if (templateId !== null && !isSafePositiveInt(templateId)) {
    return { ok: false, reason: '重复规则的来源模板 ID 不合法。' }
  }
  const weekdaysRaw = row.weekdays
  if (!Array.isArray(weekdaysRaw)) return { ok: false, reason: '重复规则的周几不是数组。' }
  const estimated = row.estimatedMinutes
  const input: RecurrenceRuleInput = {
    name: String(row.name ?? ''),
    templateId: templateId as number | null,
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    type: row.type as TaskType,
    priority: row.priority as TaskPriority,
    estimatedMinutes: estimated === null ? '' : String(estimated),
    submitRequirement: String(row.submitRequirement ?? ''),
    submitMethod: String(row.submitMethod ?? ''),
    courseId: row.courseId === null ? null : (row.courseId as number),
    cadence: row.cadence as RecurrenceCadence,
    weekdays: weekdaysRaw as number[],
    startDate: String(row.startDate ?? ''),
    endDate: String(row.endDate ?? ''),
    time: row.time === null ? '' : String(row.time ?? ''),
  }
  let normalized: NormalizedRecurrenceRule
  try {
    normalized = normalizeRecurrenceRule(input)
  } catch (cause) {
    if (cause instanceof ValidationError) return { ok: false, reason: `重复规则不合法：${cause.message}` }
    throw cause
  }
  return {
    ok: true,
    rule: {
      ...normalized,
      id,
      revision,
      createdAt,
      updatedAt,
    },
  }
}

function decodeLedgerRow(raw: unknown): { ok: true; entry: RecurrenceLedgerEntry } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '生成账本不是对象。' }
  const row = raw as Record<string, unknown>
  const ruleId = row.ruleId
  if (!isSafePositiveInt(ruleId)) return { ok: false, reason: '生成账本的规则 ID 不合法。' }
  const date = String(row.date ?? '')
  if (!isValidDateKey(date)) return { ok: false, reason: '生成账本的日期不是真实日期。' }
  const status = row.status
  if (status !== 'CREATED' && status !== 'SKIPPED') return { ok: false, reason: '生成账本状态不认识。' }
  const taskId = row.taskId
  if (status === 'CREATED') {
    if (!isSafePositiveInt(taskId)) return { ok: false, reason: '已创建账本缺少任务 ID。' }
  } else if (taskId !== null) {
    return { ok: false, reason: '已跳过账本不能带任务 ID。' }
  }
  const createdAt = String(row.createdAt ?? '')
  if (Number.isNaN(Date.parse(createdAt)) || !/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) {
    return { ok: false, reason: '生成账本时间不是 ISO。' }
  }
  return { ok: true, entry: { ruleId, date, taskId: taskId as number | null, status, createdAt } }
}

/** 严格解码 `app_settings.task_recurrence.v1`。 */
export function decodeRecurrenceStore(raw: string | null): RecurrenceStoreDecodeResult {
  if (raw === null || raw.trim().length === 0) return { ok: true, store: emptyRecurrenceStore(), reason: null }
  if (raw.length > RECURRENCE_LIMITS.maxStoreBytes) return failDecode('重复规则库超过大小上限。')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failDecode('重复规则库不是有效 JSON。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failDecode('重复规则库不是对象。')
  const object = parsed as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 4 || keys[0] !== 'ledger' || keys[1] !== 'nextRuleId' || keys[2] !== 'rules' || keys[3] !== 'version') {
    return failDecode('重复规则库的字段集合不对。')
  }
  if (object.version !== 1) return failDecode('重复规则库版本不认识。')
  if (!Array.isArray(object.rules)) return failDecode('重复规则列表不是数组。')
  if (!Array.isArray(object.ledger)) return failDecode('生成账本不是数组。')
  if (object.rules.length > RECURRENCE_LIMITS.maxRules) return failDecode('重复规则数量超过上限。')
  if (object.ledger.length > RECURRENCE_LIMITS.maxLedgerEntries) return failDecode('生成账本超过上限。')
  const rules: RecurrenceRule[] = []
  const ruleIds = new Set<number>()
  for (const rawRule of object.rules) {
    const decoded = decodeRuleRow(rawRule)
    if (!decoded.ok) return failDecode(decoded.reason)
    if (ruleIds.has(decoded.rule.id)) return failDecode(`重复规则 ID ${decoded.rule.id} 重复。`)
    ruleIds.add(decoded.rule.id)
    rules.push(decoded.rule)
  }
  const ledger: RecurrenceLedgerEntry[] = []
  const seen = new Set<string>()
  for (const rawEntry of object.ledger) {
    const decoded = decodeLedgerRow(rawEntry)
    if (!decoded.ok) return failDecode(decoded.reason)
    if (!ruleIds.has(decoded.entry.ruleId)) {
      return failDecode(`生成账本指向不存在的规则 #${decoded.entry.ruleId}。`)
    }
    const key = `${decoded.entry.ruleId}|${decoded.entry.date}`
    if (seen.has(key)) return failDecode(`规则 #${decoded.entry.ruleId} 的 ${decoded.entry.date} 在账本里重复。`)
    seen.add(key)
    ledger.push(decoded.entry)
  }
  const maxId = rules.reduce((max, rule) => Math.max(max, rule.id), 0)
  const nextRuleId = object.nextRuleId
  if (!isSafePositiveInt(nextRuleId) || nextRuleId <= maxId) return failDecode('重复规则库的下一个 ID 不合法。')
  return { ok: true, store: { version: 1, nextRuleId, rules, ledger }, reason: null }
}

/** 给用户看的周几说明，例如 `周一、周三`。 */
export function weekdaysLabel(weekdays: readonly number[]): string {
  return weekdays.map((weekday) => weekdayName(weekday)).join('、')
}
