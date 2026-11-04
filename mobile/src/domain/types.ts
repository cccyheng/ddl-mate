/** 领域类型定义：与后端 `com.ddlmate.domain` 的字段语义保持一致，字段名对齐 Web 端 API。 */

import { isDeadlineOverdue } from './datetime'
import type { WeekPattern } from './scheduleRules'

export type TaskStatus = 'TODO' | 'DOING' | 'DONE' | 'CANCELLED'

export type TaskPriority = 1 | 2 | 3 | 4 | 5

export type TaskType =
  | 'HOMEWORK'
  | 'EXAM'
  | 'PROJECT'
  | 'READING'
  | 'PRESENTATION'
  | 'ADMIN'
  | 'OTHER'

export const taskStatusLabels: Record<TaskStatus, string> = {
  TODO: '待办',
  DOING: '进行中',
  DONE: '已完成',
  CANCELLED: '已取消',
}

export const taskTypeLabels: Record<TaskType, string> = {
  HOMEWORK: '作业',
  EXAM: '考试',
  PROJECT: '项目',
  READING: '阅读',
  PRESENTATION: '展示',
  ADMIN: '事务',
  OTHER: '其它',
}

/** 优先级 5 最高（对齐后端 TaskPriority：1..5）。 */
export const taskPriorityLabels: Record<number, string> = {
  5: '紧急',
  4: '高',
  3: '中',
  2: '低',
  1: '最低',
}

export const taskStatusOptions: ReadonlyArray<{ value: TaskStatus; label: string }> = (
  Object.keys(taskStatusLabels) as TaskStatus[]
).map((value) => ({ value, label: taskStatusLabels[value] }))

export const taskTypeOptions: ReadonlyArray<{ value: TaskType; label: string }> = (
  Object.keys(taskTypeLabels) as TaskType[]
).map((value) => ({ value, label: taskTypeLabels[value] }))

export const taskPriorityOptions: ReadonlyArray<{ value: TaskPriority; label: string }> = [5, 4, 3, 2, 1].map(
  (value) => ({ value: value as TaskPriority, label: `${taskPriorityLabels[value]}（${value}）` }),
)

export interface Course {
  id: number
  /**
   * **内部代码**（老数据里的学校教务代码，或 App 自动生成的 `AUTO-01` 内部编号）。
   *
   * 它**不面向用户**：界面不展示、也不要求用户输入；
   * 保留它的唯一用途是匹配 / 去重（照片导入复用同名课程、老数据不被改写）。
   * 新建课程时留空，由仓库层分配一个唯一的内部编号。
   */
  code: string
  name: string
  instructor: string | null
  semester: string | null
  color: string | null
  note: string | null
  /**
   * **选课序号**（截图里课程名后括号中的那串数字，例如 `9913000172.08`）。
   *
   * 与 `code` 严格分开：
   * - `code` 是 App 内部编号（`AUTO-01`）或用户手填的学校代码；
   * - `selectionSerial` 是学校选课系统里的序号，只用于展示与「同名课是不是同一门」的判断。
   * `null` 表示没有这个信息（旧数据 / 图上没有这串数字），**绝不**编一个出来。
   */
  selectionSerial: string | null
  createdAt: string
  updatedAt: string
}

export interface CourseDraft {
  /**
   * 内部代码（可选）。
   *
   * - 空串 / 没给 → 新建时由仓库层分配唯一内部编号，编辑时**保留库里已有的代码**；
   * - 非空 → 照写（照片导入行 / 老调用方仍可能带一个真实教务代码）。
   * 界面上已经没有这个字段，正常用户流程永远不会填它。
   */
  code: string
  name: string
  instructor: string
  semester: string
  color: string
  note: string
  /**
   * 选课序号（空字符串 = 没有 / 保留库里已有的值）。
   *
   * 仓库层的口径（避免一次普通保存就把用户已记录的选课序号抹掉）：
   * - 非空 → 写入这个值；
   * - 空 + `clearSelectionSerial` 为真 → 明确清空；
   * - 空 + 未标记清空 → **保留**库里已有的值（旧表单 / 旧代码路径也安全）。
   */
  selectionSerial?: string
  /** 用户**明确**清空了选课序号（课程表单里的「清空选课序号」动作）。 */
  clearSelectionSerial?: boolean
  /**
   * 用户**明确**清空了内部课程代码。
   *
   * 内部代码在界面上不可见，正常流程永远不会设这个标记（因此编辑课程时草稿里的空代码
   * 一律解释为「保留库里已有的代码」）；保留它只是为了给未来的显式维护动作留一条路。
   */
  clearCode?: boolean
}

export interface Schedule {
  id: number
  courseId: number
  weekday: number
  /** `HH:mm`。 */
  startTime: string
  endTime: string
  location: string | null
  periodStart: number | null
  periodEnd: number | null
  weekRange: string | null
  semesterStartDate: string | null
  startWeek: number | null
  endWeek: number | null
  weekPattern: WeekPattern
  createdAt: string
  updatedAt: string
}

export interface ScheduleDraft {
  weekday: number
  startTime: string
  endTime: string
  location: string
  periodStart: string
  periodEnd: string
  semesterStartDate: string
  startWeek: string
  endWeek: string
  weekPattern: WeekPattern
}

export interface Task {
  id: number
  title: string
  description: string | null
  courseId: number | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  /**
   * 带显式 `+08:00` 偏移的 ISO 字符串（精确到分钟），或只到日期的 `YYYY-MM-DD`
   * （表示当天结束前）；null 表示未设置。需要日期 / 逾期语义时请使用
   * `deadlineToShanghaiDateKey` / `isDeadlineOverdue`，不要假定它一定是时间戳。
   */
  deadline: string | null
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskDraft {
  title: string
  description: string
  courseId: number | null
  type: TaskType
  status: TaskStatus
  priority: TaskPriority
  /**
   * 北京时间墙上时间 `YYYY-MM-DDTHH:mm`，或只到日期的 `YYYY-MM-DD`（时间留空）；
   * 空字符串表示未设置（不会自动补默认值）。
   */
  deadline: string
  estimatedMinutes: string
  submitRequirement: string
  submitMethod: string
  /** 原通知/原始文本，仅在用户填写或从通知导入时保存。 */
  originalText: string
}

export type TaskSourceKind = 'ORIGINAL_TEXT' | 'MANUAL'

export interface TaskSource {
  id: number
  taskId: number
  kind: TaskSourceKind
  /** 原始通知/原始文本，只读留存，编辑任务不会覆盖它。 */
  rawText: string
  createdAt: string
}

export function emptyTaskDraft(): TaskDraft {
  return {
    title: '',
    description: '',
    courseId: null,
    type: 'HOMEWORK',
    status: 'TODO',
    priority: 3,
    deadline: '',
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    originalText: '',
  }
}

export function emptyCourseDraft(): CourseDraft {
  return { code: '', name: '', instructor: '', semester: '', color: '', note: '', selectionSerial: '' }
}

export function emptyScheduleDraft(weekday = 1): ScheduleDraft {
  return {
    weekday,
    startTime: '08:00',
    endTime: '09:40',
    location: '',
    periodStart: '',
    periodEnd: '',
    semesterStartDate: '',
    startWeek: '',
    endWeek: '',
    weekPattern: 'ALL',
  }
}

/** 课程默认色：与 Web 端一致（陶土橙），无颜色时用弱文字色。 */
export const COURSE_DEFAULT_COLOR = '#b4573a'
export const COURSE_FALLBACK_COLOR = '#65746b'

export const courseColorChoices: readonly string[] = [
  '#b4573a',
  '#285b47',
  '#8a6a2f',
  '#7a4a63',
  '#3f5f7a',
  '#65746b',
]

export function courseColorOf(course: Pick<Course, 'color'> | null | undefined): string {
  const color = course?.color?.trim()
  return color && color.length > 0 ? color : COURSE_FALLBACK_COLOR
}

export function isTaskDone(task: Pick<Task, 'status'>): boolean {
  return task.status === 'DONE'
}

/**
 * 未完成且已过截止时间。
 *
 * 只到日期的 DDL 在当天内都不算逾期，跨过北京时间零点才开始算。
 */
export function isOverdue(task: Pick<Task, 'deadline' | 'status'>, now: Date = new Date()): boolean {
  if (task.status === 'DONE' || task.status === 'CANCELLED') return false
  if (!task.deadline) return false
  return isDeadlineOverdue(task.deadline, now)
}
