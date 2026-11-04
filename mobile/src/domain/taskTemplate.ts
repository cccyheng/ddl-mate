/**
 * 任务模板（纯逻辑，可跑在 Hermes 与 Node）。
 *
 * 模板只保存**可复用的任务内容**，并且每一项都必须由用户在保存时**显式勾选**：
 * - 标题 / 说明 / 类型 / 优先级 / 预计用时 / 提交要求 / 提交方式 / 所属课程；
 * - **绝不**保存完成状态、截止时间、创建/完成时间、原始通知文本、通知规则或截图关联。
 *
 * 应用模板只会生成一份**可编辑的 TaskDraft**（状态固定为 TODO、截止时间留空），
 * 由用户确认后再走现有任务创建流程；模板本身永远不会直接写任务表。
 *
 * 存储复用 `app_settings` 的版本化 JSON 键（见 `db/schema.ts`），
 * 因此不需要改变数据库版本，也不会让旧备份无法解析。
 */

import type { TaskDraft, TaskPriority, TaskType } from './types'
import { emptyTaskDraft } from './types'
import { normalizeTaskDraft } from './taskDraft'
import { ValidationError } from './errors'
import { parseOffsetIso } from './datetime'

/* ------------------------------- 上限 ------------------------------- */

export const TEMPLATE_LIMITS = {
  /** 单机最多保存多少个模板（防止键值无限膨胀）。 */
  maxTemplates: 100,
  /** 模板名称长度。 */
  maxNameLength: 80,
  /** `task_templates.v1` 序列化后的字节上限（远小于备份单值上限）。 */
  maxStoreBytes: 1_500_000,
} as const

export const TEMPLATE_FIELDS = [
  'title',
  'description',
  'type',
  'priority',
  'estimatedMinutes',
  'submitRequirement',
  'submitMethod',
  'courseId',
] as const

export type TemplateField = (typeof TEMPLATE_FIELDS)[number]

export const TEMPLATE_FIELD_LABELS: Record<TemplateField, string> = {
  title: '标题',
  description: '说明',
  type: '任务类型',
  priority: '优先级',
  estimatedMinutes: '预计用时（分钟）',
  submitRequirement: '提交要求',
  submitMethod: '提交方式',
  courseId: '所属课程',
}

/* ------------------------------- 类型 ------------------------------- */

/** 模板内容：`null` 表示“没有保存这一项”，应用时保持任务表单的原值。 */
export interface TaskTemplateContent {
  title: string | null
  description: string | null
  type: TaskType | null
  priority: TaskPriority | null
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
  courseId: number | null
}

export interface TaskTemplate extends TaskTemplateContent {
  id: number
  /**
   * 单调修订号：每次编辑 +1。
   *
   * 不能只用 `updatedAt` 判断模板是否改过：测试固定在同一个毫秒时，
   * 同一毫秒内的编辑会让时间戳完全相同，旧预览就会错误地继续可用。
   * 旧数据 / 旧模板备份没有这个字段时按修订号 1 读取，保持向后兼容。
   */
  revision: number
  name: string
  createdAt: string
  updatedAt: string
}

/** 新建 / 编辑模板时由表单提交的原始值。 */
export interface TaskTemplateInput {
  name: string
  /** 用户显式勾选的字段；未勾选的字段即使有值也不会被保存。 */
  fields: readonly TemplateField[]
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  /** 空串 = 未估算（保持空白，不补默认值）。 */
  estimatedMinutes: string
  submitRequirement: string
  submitMethod: string
  courseId: number | null
}

export interface TaskTemplateStore {
  version: 1
  nextId: number
  templates: TaskTemplate[]
}

export interface ApplyTemplateResult {
  draft: TaskDraft
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

function isTemplateField(value: unknown): value is TemplateField {
  return typeof value === 'string' && (TEMPLATE_FIELDS as readonly string[]).includes(value)
}

function isTaskType(value: unknown): value is TaskType {
  return (
    value === 'HOMEWORK' ||
    value === 'EXAM' ||
    value === 'PROJECT' ||
    value === 'READING' ||
    value === 'PRESENTATION' ||
    value === 'ADMIN' ||
    value === 'OTHER'
  )
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

function isIso(value: unknown): boolean {
  return parseOffsetIso(value) !== null
}

export function emptyTemplateInput(): TaskTemplateInput {
  return {
    name: '',
    fields: [...TEMPLATE_FIELDS],
    title: '',
    description: '',
    type: 'HOMEWORK',
    priority: 3,
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    courseId: null,
  }
}

/* --------------------------- 模板内容归一化 --------------------------- */

/**
 * 校验并归一化模板。
 *
 * - 名称必填；
 * - 至少勾选一项、并且至少有一项真的留下了内容（只勾“预计用时”却留空不算）；
 * - 勾选“标题”就必须填标题，避免应用后得到一个无法保存的空标题；
 * - 空白预计用时保持 `null`（不补 0 / 不补默认分钟）。
 */
export function normalizeTemplateInput(
  input: TaskTemplateInput,
): TaskTemplateContent & { name: string } {
  const fields: Record<string, string> = {}

  const name = String(input.name ?? '').trim()
  if (name.length === 0) fields.name = '请填写模板名称。'
  else if (name.length > TEMPLATE_LIMITS.maxNameLength) {
    fields.name = `模板名称最长 ${TEMPLATE_LIMITS.maxNameLength} 字（当前 ${name.length}）。`
  }

  const selected = new Set<TemplateField>()
  for (const field of input.fields ?? []) {
    if (!isTemplateField(field)) {
      fields.fields = '模板字段列表里有不认识的项。'
      continue
    }
    selected.add(field)
  }
  if (selected.size === 0) fields.fields = '请至少勾选一项要保存的内容。'

  let title: string | null = null
  let description: string | null = null
  let type: TaskType | null = null
  let priority: TaskPriority | null = null
  let estimatedMinutes: number | null = null
  let submitRequirement: string | null = null
  let submitMethod: string | null = null
  let courseId: number | null = null

  if (selected.has('title')) {
    const normalized = normalizeTaskDraft({
      ...emptyTaskDraft(),
      title: String(input.title ?? ''),
      status: 'TODO',
      deadline: '',
    })
    title = normalized.title
  }
  if (selected.has('description')) {
    description = trimOrNull(input.description)
    if (description && description.length > 1000) fields.description = '说明最长 1000 字。'
  }
  if (selected.has('type')) {
    if (!isTaskType(input.type)) fields.type = '任务类型不合法。'
    else type = input.type
  }
  if (selected.has('priority')) {
    if (!isTaskPriority(input.priority)) fields.priority = '优先级必须是 1–5。'
    else priority = input.priority
  }
  if (selected.has('estimatedMinutes')) {
    const raw = String(input.estimatedMinutes ?? '').trim()
    if (raw.length > 0) {
      const parsed = Number(raw)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
        fields.estimatedMinutes = '预计用时请填 0–100000 之间的整数分钟，或留空。'
      } else {
        estimatedMinutes = parsed
      }
    }
    // 留空保持 null —— 模板不会替用户编一个默认分钟数。
  }
  if (selected.has('submitRequirement')) {
    submitRequirement = trimOrNull(input.submitRequirement)
    if (submitRequirement && submitRequirement.length > 500) fields.submitRequirement = '提交要求最长 500 字。'
  }
  if (selected.has('submitMethod')) {
    submitMethod = trimOrNull(input.submitMethod)
    if (submitMethod && submitMethod.length > 128) fields.submitMethod = '提交方式最长 128 字。'
  }
  if (selected.has('courseId')) {
    if (input.courseId !== null && input.courseId !== undefined) {
      if (!isSafePositiveInt(input.courseId)) fields.courseId = '所属课程不合法。'
      else courseId = input.courseId
    }
  }

  const hasContent =
    title !== null ||
    description !== null ||
    type !== null ||
    priority !== null ||
    estimatedMinutes !== null ||
    submitRequirement !== null ||
    submitMethod !== null ||
    courseId !== null
  if (!hasContent && !fields.fields) fields.fields = '模板里还没有可复用的内容，请至少填写并勾选一项。'

  if (Object.keys(fields).length > 0) {
    throw new ValidationError('模板内容还有问题需要修改。', fields)
  }

  return {
    name,
    title,
    description,
    type,
    priority,
    estimatedMinutes,
    submitRequirement,
    submitMethod,
    courseId,
  }
}

/** 模板里实际保存了内容的字段（用于列表展示 / 表单勾选）。 */
export function templateFieldsOf(template: TaskTemplateContent): TemplateField[] {
  const fields: TemplateField[] = []
  if (template.title !== null) fields.push('title')
  if (template.description !== null) fields.push('description')
  if (template.type !== null) fields.push('type')
  if (template.priority !== null) fields.push('priority')
  if (template.estimatedMinutes !== null) fields.push('estimatedMinutes')
  if (template.submitRequirement !== null) fields.push('submitRequirement')
  if (template.submitMethod !== null) fields.push('submitMethod')
  if (template.courseId !== null) fields.push('courseId')
  return fields
}

/** 编辑模板时把已保存内容还原成表单初值。 */
export function templateToInput(template: TaskTemplate): TaskTemplateInput {
  return {
    name: template.name,
    fields: templateFieldsOf(template),
    title: template.title ?? '',
    description: template.description ?? '',
    type: template.type ?? 'HOMEWORK',
    priority: template.priority ?? 3,
    estimatedMinutes: template.estimatedMinutes === null ? '' : String(template.estimatedMinutes),
    submitRequirement: template.submitRequirement ?? '',
    submitMethod: template.submitMethod ?? '',
    courseId: template.courseId,
  }
}

/**
 * 应用模板 → **可编辑草稿**（不写库）。
 *
 * - 状态固定为 TODO；截止时间留空；不复制完成时间 / 原文 / 通知 / 截图；
 * - 模板里的课程若已经不在本机，**不会**把它静默挂到别的课程上：
 *   草稿课程留空，并返回一条明确的复核提示；
 * - 早被删除的模板字段值不会被重新解释成任何默认值。
 */
export function applyTemplate(template: TaskTemplate, validCourseIds: ReadonlySet<number>): ApplyTemplateResult {
  const draft = emptyTaskDraft()
  const warnings: string[] = []

  if (template.title !== null) draft.title = template.title
  if (template.description !== null) draft.description = template.description
  if (template.type !== null) draft.type = template.type
  if (template.priority !== null) draft.priority = template.priority
  if (template.estimatedMinutes !== null) draft.estimatedMinutes = String(template.estimatedMinutes)
  if (template.submitRequirement !== null) draft.submitRequirement = template.submitRequirement
  if (template.submitMethod !== null) draft.submitMethod = template.submitMethod
  if (template.courseId !== null) {
    if (validCourseIds.has(template.courseId)) {
      draft.courseId = template.courseId
    } else {
      warnings.push('模板里保存的课程已不在本机；已把「所属课程」留空，请在保存前重新选择。')
    }
  }
  // 明确不复制：deadline / status / originalText / completedAt / createdAt / updatedAt。
  draft.status = 'TODO'
  draft.deadline = ''
  draft.originalText = ''
  return { draft, warnings }
}

/* ------------------------------ 存储编解码 ------------------------------ */

export function emptyTemplateStore(): TaskTemplateStore {
  return { version: 1, nextId: 1, templates: [] }
}

export function encodeTemplateStore(store: TaskTemplateStore): string {
  return JSON.stringify({
    version: 1,
    nextId: store.nextId,
    templates: store.templates,
  })
}

export interface TemplateStoreDecodeResult {
  ok: boolean
  store: TaskTemplateStore
  reason: string | null
}

function failDecode(reason: string): TemplateStoreDecodeResult {
  return { ok: false, store: emptyTemplateStore(), reason }
}

function decodeTemplateRow(raw: unknown): { ok: true; template: TaskTemplate } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: '模板记录不是对象。' }
  const row = raw as Record<string, unknown>
  const allowed = new Set([
    'courseId',
    'createdAt',
    'description',
    'estimatedMinutes',
    'id',
    'name',
    'priority',
    'revision',
    'submitMethod',
    'submitRequirement',
    'title',
    'type',
    'updatedAt',
  ])
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) return { ok: false, reason: '模板记录的字段集合不对。' }
  }
  for (const required of allowed) {
    if (required !== 'revision' && !(required in row)) {
      return { ok: false, reason: '模板记录缺少字段。' }
    }
  }
  const id = row.id
  if (!isSafePositiveInt(id)) return { ok: false, reason: '模板 ID 不是正整数。' }
  // 旧模板备份没有 revision：按 1 读取；新数据必须继续单调递增。
  const revision = row.revision === undefined ? 1 : row.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    return { ok: false, reason: '模板修订号不合法。' }
  }
  const name = String(row.name ?? '').trim()
  if (name.length === 0 || name.length > TEMPLATE_LIMITS.maxNameLength) {
    return { ok: false, reason: '模板名称不是 1–80 字。' }
  }
  const createdAt = row.createdAt
  const updatedAt = row.updatedAt
  if (!isIso(createdAt) || !isIso(updatedAt)) return { ok: false, reason: '模板时间不是 ISO。' }

  const nullableString = (
    value: unknown,
    max: number,
    label: string,
  ): { ok: true; value: string | null } | { ok: false; reason: string } => {
    if (value === null) return { ok: true, value: null }
    if (typeof value !== 'string' || value.length > max) return { ok: false, reason: `${label}不是合法文本。` }
    const trimmed = value.trim()
    return { ok: true, value: trimmed.length > 0 ? trimmed : null }
  }
  const titleResult = nullableString(row.title, 200, '标题')
  if (!titleResult.ok) return { ok: false, reason: titleResult.reason }
  const descriptionResult = nullableString(row.description, 1000, '说明')
  if (!descriptionResult.ok) return { ok: false, reason: descriptionResult.reason }
  const requirementResult = nullableString(row.submitRequirement, 500, '提交要求')
  if (!requirementResult.ok) return { ok: false, reason: requirementResult.reason }
  const methodResult = nullableString(row.submitMethod, 128, '提交方式')
  if (!methodResult.ok) return { ok: false, reason: methodResult.reason }
  const title = titleResult.value
  const description = descriptionResult.value
  const submitRequirement = requirementResult.value
  const submitMethod = methodResult.value

  const type = row.type
  if (type !== null && !isTaskType(type)) return { ok: false, reason: '任务类型不合法。' }
  const priority = row.priority
  if (priority !== null && !isTaskPriority(priority)) return { ok: false, reason: '优先级不合法。' }
  const estimated = row.estimatedMinutes
  if (
    estimated !== null &&
    (typeof estimated !== 'number' || !Number.isInteger(estimated) || estimated < 0 || estimated > 100_000)
  ) {
    return { ok: false, reason: '预计用时不合法。' }
  }
  if (type === null && priority === null && estimated === null && title === null && description === null && submitRequirement === null && submitMethod === null && row.courseId === null) {
    return { ok: false, reason: '模板没有任何可复用内容。' }
  }
  const courseId = row.courseId
  if (courseId !== null && !isSafePositiveInt(courseId)) return { ok: false, reason: '模板课程 ID 不合法。' }

  return {
    ok: true,
    template: {
      id,
      revision,
      name,
      title,
      description: description as string | null,
      type: type as TaskType | null,
      priority: priority as TaskPriority | null,
      estimatedMinutes: estimated as number | null,
      submitRequirement: submitRequirement as string | null,
      submitMethod: submitMethod as string | null,
      courseId: courseId as number | null,
      createdAt: String(createdAt),
      updatedAt: String(updatedAt),
    },
  }
}

/** 严格解码 `app_settings.task_templates.v1`；任何坏数据都返回可读原因。 */
export function decodeTemplateStore(raw: string | null): TemplateStoreDecodeResult {
  if (raw === null || raw.trim().length === 0) return { ok: true, store: emptyTemplateStore(), reason: null }
  if (raw.length > TEMPLATE_LIMITS.maxStoreBytes) return failDecode('模板库超过大小上限。')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return failDecode('模板库不是有效 JSON。')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return failDecode('模板库不是对象。')
  const object = parsed as Record<string, unknown>
  const keys = Object.keys(object).sort()
  if (keys.length !== 3 || keys[0] !== 'nextId' || keys[1] !== 'templates' || keys[2] !== 'version') {
    return failDecode('模板库的字段集合不对。')
  }
  if (object.version !== 1) return failDecode('模板库版本不认识。')
  const templatesRaw = object.templates
  if (!Array.isArray(templatesRaw)) return failDecode('模板列表不是数组。')
  if (templatesRaw.length > TEMPLATE_LIMITS.maxTemplates) {
    return failDecode(`模板数量超过 ${TEMPLATE_LIMITS.maxTemplates} 个上限。`)
  }
  const templates: TaskTemplate[] = []
  const seen = new Set<number>()
  for (const row of templatesRaw) {
    const decoded = decodeTemplateRow(row)
    if (!decoded.ok) return failDecode(decoded.reason)
    if (seen.has(decoded.template.id)) return failDecode(`模板 ID ${decoded.template.id} 重复。`)
    seen.add(decoded.template.id)
    templates.push(decoded.template)
  }
  const maxId = templates.reduce((max, template) => Math.max(max, template.id), 0)
  const nextId = object.nextId
  if (!isSafePositiveInt(nextId) || nextId <= maxId) return failDecode('模板库的下一个 ID 不合法。')
  return { ok: true, store: { version: 1, nextId, templates }, reason: null }
}
