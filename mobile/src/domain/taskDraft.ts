/**
 * 任务表单校验与「草稿 ↔ 存储」转换（纯函数，可测试）。
 *
 * 关键约束：
 * - 截止时间按**北京时间墙上时间**填写，非法日期（2026-02-30 / 2027-02-29 / 25:00）
 *   一律拒绝，**绝不猜一个时间**；
 * - 日期可以单独保存（`YYYY-MM-DD`，表示当天结束前），此时时间部分保持空白；
 * - 留空就是「未设置 DDL」，不会自动补 23:59 或 00:00；
 * - 标题必填、长度上限与后端一致（200 字）。
 */

import {
  deadlineToShanghaiWallClock,
  isValidDateKey,
  isValidShanghaiWallClock,
  shanghaiWallClockToOffset,
} from './datetime'
import { ValidationError } from './errors'
import type { Task, TaskDraft, TaskPriority, TaskStatus, TaskType } from './types'

const TITLE_MAX = 200
const DESCRIPTION_MAX = 1000
const SUBMIT_REQUIREMENT_MAX = 500
const SUBMIT_METHOD_MAX = 128

const TASK_TYPES: readonly TaskType[] = [
  'HOMEWORK',
  'EXAM',
  'PROJECT',
  'READING',
  'PRESENTATION',
  'ADMIN',
  'OTHER',
]
const TASK_STATUSES: readonly TaskStatus[] = ['TODO', 'DOING', 'DONE', 'CANCELLED']

export interface NormalizedTask {
  title: string
  description: string | null
  courseId: number | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  /** 带 `+08:00` 的 ISO；null = 未设置。 */
  deadline: string | null
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
  originalText: string | null
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * 把 `YYYY-MM-DDTH:mm` 补零成 `YYYY-MM-DDTHH:mm`（也接受空格分隔与带秒的写法）。
 *
 * 这样「输入框接受的写法」与「保存接受的写法」是同一套：
 * 用户填 `2026-10-15T9:00` 时，输入框说没问题，保存也必须能收下并规范成 `09:00`。
 */
function padWallClockText(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{1,2})(?::\d{2})?$/.exec(value)
  if (!match) return value
  const [, date, hour, minute] = match
  return `${date}T${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`
}

export interface NormalizeTaskDraftOptions {
  /**
   * 是否允许只填日期（默认 `true`，任务表单与任务仓库使用）。
   *
   * 通知导入仍要求精确到分钟，会显式传 `false`，避免把「原文只写了日期」
   * 悄悄放宽成另一种时间精度。
   */
  allowDateOnly?: boolean
}

/**
 * 校验并归一化任务草稿。任何非法输入都抛 `ValidationError`（带字段级信息）。
 */
export function normalizeTaskDraft(
  draft: TaskDraft,
  options: NormalizeTaskDraftOptions = {},
): NormalizedTask {
  const fields: Record<string, string> = {}

  const title = String(draft.title ?? '').trim()
  if (title.length === 0) fields.title = '请填写任务标题。'
  else if (title.length > TITLE_MAX) fields.title = `标题最长 ${TITLE_MAX} 字（当前 ${title.length}）。`

  const description = trimOrNull(draft.description)
  if (description && description.length > DESCRIPTION_MAX) {
    fields.description = `说明最长 ${DESCRIPTION_MAX} 字（当前 ${description.length}）。`
  }

  const submitRequirement = trimOrNull(draft.submitRequirement)
  if (submitRequirement && submitRequirement.length > SUBMIT_REQUIREMENT_MAX) {
    fields.submitRequirement = `提交要求最长 ${SUBMIT_REQUIREMENT_MAX} 字。`
  }

  const submitMethod = trimOrNull(draft.submitMethod)
  if (submitMethod && submitMethod.length > SUBMIT_METHOD_MAX) {
    fields.submitMethod = `提交方式最长 ${SUBMIT_METHOD_MAX} 字。`
  }

  const rawDeadline = String(draft.deadline ?? '').trim()
  let deadline: string | null = null
  if (rawDeadline.length > 0) {
    // 先补零成规范写法（`9:00` → `09:00`），让保存口径与输入框的实时校验完全一致：
    // 输入框说没问题的写法，保存也一定接受（反之亦然）。
    const canonical = padWallClockText(rawDeadline)
    if (/^\d{4}-\d{2}-\d{2}$/.test(canonical)) {
      if (!isValidDateKey(canonical)) {
        fields.deadline = '截止时间不是真实存在的北京时间日期/时刻（例如 2026-02-30、25:00 都不允许）。'
      } else if (options.allowDateOnly === false) {
        fields.deadline = '这里仍需要具体时刻：请填 HH:mm（应用不会替你猜时间）。'
      } else {
        // 只填日期：原样保存裸日期，表示「当天结束前」；不补 00:00 / 23:59。
        deadline = canonical
      }
    } else if (!isValidShanghaiWallClock(canonical)) {
      fields.deadline = '截止时间不是真实存在的北京时间日期/时刻（例如 2026-02-30、25:00 都不允许）。'
    } else {
      deadline = shanghaiWallClockToOffset(canonical)
      if (!deadline) fields.deadline = '截止时间格式无法识别。'
    }
  }

  const rawEstimated = String(draft.estimatedMinutes ?? '').trim()
  let estimatedMinutes: number | null = null
  if (rawEstimated.length > 0) {
    const parsed = Number(rawEstimated)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
      fields.estimatedMinutes = '预计用时请填 0–100000 之间的整数分钟。'
    } else {
      estimatedMinutes = parsed
    }
  }

  const type = String(draft.type ?? '') as TaskType
  if (!TASK_TYPES.includes(type)) fields.type = '任务类型不合法。'

  const status = String(draft.status ?? '') as TaskStatus
  if (!TASK_STATUSES.includes(status)) fields.status = '任务状态不合法。'

  const priority = Number(draft.priority) as TaskPriority
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) fields.priority = '优先级必须是 1–5。'

  const courseId = draft.courseId === null || draft.courseId === undefined ? null : Number(draft.courseId)
  if (courseId !== null && (!Number.isInteger(courseId) || courseId <= 0)) {
    fields.courseId = '所属课程不合法。'
  }

  if (Object.keys(fields).length > 0) {
    throw new ValidationError('任务内容还有问题需要修改。', fields)
  }

  return {
    title,
    description,
    courseId,
    type,
    status,
    priority,
    deadline,
    estimatedMinutes,
    submitRequirement,
    submitMethod,
    originalText: trimOrNull(draft.originalText),
  }
}

/** 已存在的任务 → 可编辑草稿（截止时间转回北京时间墙上时间）。 */
export function taskToDraft(task: Task, originalText = ''): TaskDraft {
  return {
    title: task.title,
    description: task.description ?? '',
    courseId: task.courseId,
    type: task.type,
    status: task.status,
    priority: task.priority,
    // 只到日期的 DDL 原样回到日期框，时间框保持空白（不显示编造的 00:00）。
    deadline: task.deadline ? deadlineToShanghaiWallClock(task.deadline) : '',
    estimatedMinutes: task.estimatedMinutes === null ? '' : String(task.estimatedMinutes),
    submitRequirement: task.submitRequirement ?? '',
    submitMethod: task.submitMethod ?? '',
    originalText,
  }
}

export const TASK_LIMITS = {
  TITLE_MAX,
  DESCRIPTION_MAX,
  SUBMIT_REQUIREMENT_MAX,
  SUBMIT_METHOD_MAX,
} as const
