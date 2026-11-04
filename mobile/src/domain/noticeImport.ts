/**
 * 通知原文 → 待办候选的**纯映射层**（无 React / 无数据库 / 无网络）。
 *
 * 职责边界（与授权书逐条对应）：
 * - 解析交给**逐字节复制的** `noticeParser.js`（保守规则，绝不猜时间 / 绝不编课程）；
 * - 这里只做「解析结果 → 可编辑草稿行」的搬运与校验，以及**原文长度上限**；
 * - 用户改过的字段**只**活在行草稿里，解析结果本身不被改写（重新提取时由界面显式确认）；
 * - 原文（含消息头）原样保留：能整段放进 `description` 就放，放不下就留空并标记
 *   「说明放不下，原文仍会完整留档」—— **任何情况下都不静默丢掉原文**。
 *
 * 一处刻意的取舍：解析器给出的 `deadline` 是 `YYYY-MM-DDTHH:mm`（墙上时间，不含偏移），
 * 与任务草稿 `TaskDraft.deadline` 的口径**完全一致**，因此这里不做任何时间换算 ——
 * 换算是 `normalizeTaskDraft` / `shanghaiWallClockToOffset` 的事，只有一处口径。
 */

import {
  NOTICE_HINTS,
  extractDeadline,
  extractSubmitMethod,
  extractSubmitRequirement,
  extractTitle,
  guessTaskType,
  matchCourse,
  parseNoticeText,
  type NoticeCourseRef,
  type ParsedNoticeCandidate,
} from './noticeParser'
import { isDateOnlyDeadline } from './datetime'
import { mapNoticeTaskType, preSplitNoticeText, taskTypeMappingNote } from './noticeTextAdapter'
import type { TaskDraft, TaskType } from './types'

/**
 * 单次粘贴原文的字符上限。
 *
 * 上限是**显式校验**：超了直接报错、绝不静默截断。10000 个字符足够装下很长的
 * 群公告（真实群通知通常几百字），同时避免用户误把整份文件粘进来把界面拖死。
 */
export const MAX_NOTICE_SOURCE_CHARS = 10_000

/** 单次最多转几条待办（与解析器的 `maxTasks` 同口径）。 */
export const MAX_NOTICE_TASKS = 30

/** 原文超出上限时的中文说明（界面直接展示，并给出当前字数）。 */
export function noticeSourceLengthError(text: string): string | null {
  const length = String(text ?? '').length
  if (length <= MAX_NOTICE_SOURCE_CHARS) return null
  return `原文 ${length} 字，超过单次上限 ${MAX_NOTICE_SOURCE_CHARS} 字：请分成两次导入，应用不会替你截断原文。`
}

/* --------------------------------- 解析 --------------------------------- */

export interface NoticeParseSummary {
  /** 用户粘贴的原文（**原样**保留，含消息头、空白与换行）。 */
  sourceText: string
  /** 解析出的候选（已按 `MAX_NOTICE_TASKS` 截断到上限内）。 */
  candidates: ParsedNoticeCandidate[]
  /**
   * 真实候选数是否**超过**上限。
   *
   * 判定方式：先用一个远高于上限的 `maxTasks` 探一次真实条数，再和上限比较 ——
   * 不能只探 `maxTasks + 1`：解析器的 `maxTasks` 作用在 `splitSegments` **之后**
   * （先切片再过滤非任务段），原文里有群名/消息头这类非任务段时会**少算**，
   * 于是 31 条真实任务可能被当成「没超」。探针条数远大于任何真实原文的段数，
   * 因此它给出的是「过滤后的真实候选数」。
   */
  overflow: boolean
  /** 命中上限时返回的候选条数（等于 `MAX_NOTICE_TASKS`）。 */
  limit: number
  /** 探针给出的真实候选数（过滤掉非任务段之后；未截断）。 */
  actualCount: number
  /** 真实候选数超过探针上限、无法给出准确条数（极端长原文）。 */
  countCapped: boolean
  /** 为控制探针开销，超过这个长度的原文会先裁到 `PARSE_PROBE_CHARS` 再数字数。 */
  sourceTruncatedForCount: boolean
}

/** 探针允许的最大候选数：远高于上限，用来得到「过滤后的真实条数」。 */
const PARSE_PROBE_TASKS = 500

/** 探针输入的字符上限：20 万字符的原文只用于**数字数**，不会写库里。 */
const PARSE_PROBE_CHARS = 200_000

/**
 * 解析原文。**只读**：不写数据库、不改任何状态。
 *
 * 先把原文按「明显的独立任务标题行」切成块（见 `noticeTextAdapter.ts`），
 * 逐块交给**逐字节复制来的**解析器；块内的原文一律原样传入，不改字、不删行。
 */
export function parseNoticeSource(
  rawText: string,
  courses: readonly NoticeCourseRef[],
): NoticeParseSummary {
  const sourceText = String(rawText ?? '')
  const chunks = preSplitNoticeText(sourceText)

  const parsed: ParsedNoticeCandidate[] = []
  for (const chunk of chunks) {
    // 保留每一条自己那一段原文（含消息头），供只读展示与留档说明。
    for (const candidate of parseNoticeText(chunk.text, { courses, maxTasks: PARSE_PROBE_TASKS })) {
      parsed.push({ ...candidate, rawText: chunk.text })
    }
  }

  const sourceTruncatedForCount = sourceText.length > PARSE_PROBE_CHARS
  const probeInput = sourceTruncatedForCount ? sourceText.slice(0, PARSE_PROBE_CHARS) : sourceText
  const actualCount = sourceTruncatedForCount
    ? (() => {
        let total = 0
        for (const chunk of preSplitNoticeText(probeInput)) {
          total += parseNoticeText(chunk.text, { courses, maxTasks: PARSE_PROBE_TASKS }).length
        }
        return total
      })()
    : parsed.length
  const countCapped = actualCount >= PARSE_PROBE_TASKS

  return {
    sourceText,
    candidates: parsed.slice(0, MAX_NOTICE_TASKS),
    overflow: actualCount > MAX_NOTICE_TASKS,
    limit: MAX_NOTICE_TASKS,
    actualCount,
    countCapped,
    sourceTruncatedForCount,
  }
}

/* ------------------------------ 行草稿映射 ------------------------------ */

/** 一行可编辑的候选（界面状态；解析结果 + 用户改动）。 */
export interface NoticeImportRow {
  /** 稳定行号（从 1 开始），用于错误定位与「第 N 行」文案。 */
  rowIndex: number
  /** 是否勾选保存。解析阶段只做**建议**：用户没勾的绝不写库。 */
  selected: boolean
  title: string
  courseId: number | null
  /** 解析时的课程关联是否已经在本机找不到了（界面必须可见地拦下来）。 */
  courseMissing: boolean
  type: TaskType
  /**
   * 解析器给出的**原始类型**（`LAB` / `REPORT` 这类原生没有的值）。
   *
   * 有值时说明类型被显式映射过，映射说明会写进任务说明，便于保存后核对。
   */
  mappedFromType: string | null
  /** 北京墙上时间 `YYYY-MM-DDTHH:mm`；空串 = 未确定（**不会**被填默认值）。 */
  deadline: string
  submitRequirement: string
  submitMethod: string
  /** 这一段的原文（只读展示用，不参与去重）。 */
  segmentText: string
  /** 解析器的保守提示（缺年份 / 相对说法 / 多组时间…），原话展示。 */
  hints: string[]
  /** 原文能否整段放进任务说明；放不下时界面如实说明。 */
  descriptionFits: boolean
}

/** 说明字段能放下的最大长度（与 `taskDraft.ts` 的 `DESCRIPTION_MAX` 一致）。 */
const DESCRIPTION_MAX = 1000
/** 标题字段最大长度（解析器内部已截到 60，这里只做兜底）。 */
const TITLE_MAX = 200

function draftDescription(segmentText: string): { description: string; fits: boolean } {
  const trimmed = segmentText.trim()
  if (trimmed.length === 0) return { description: '', fits: true }
  if (trimmed.length > DESCRIPTION_MAX) return { description: '', fits: false }
  return { description: trimmed, fits: true }
}

/** 映射过类型时追加的说明（不会撑爆说明上限；撑爆就不加，绝不截断正文）。 */
function withTypeNote(description: string, mappedFromType: string | null, type: TaskType, note: string): string {
  if (mappedFromType === null || mappedFromType.length === 0 || note.length === 0) return description
  if (description.length === 0) return note
  if (description.length + note.length + 1 > DESCRIPTION_MAX) return description
  return `${description}\n${note}`
}

/** 解析候选 → 行草稿。传入的 `courses` 只用于判断「解析时关联的课程是否还在」。 */
export function noticeRowFromCandidate(
  candidate: ParsedNoticeCandidate,
  courses: readonly NoticeCourseRef[],
): NoticeImportRow {
  const courseId = candidate.courseId === null || candidate.courseId === undefined ? null : Number(candidate.courseId)
  const courseMissing = courseId !== null && !courses.some((course) => course.id === courseId)
  const { description, fits } = draftDescription(String(candidate.rawText ?? ''))
  const deadline = String(candidate.deadline ?? '').trim()
  // 类型**显式映射**（LAB → PROJECT 之类），不做 cast-only 的假映射。
  const mapping = mapNoticeTaskType(candidate.type)
  return {
    rowIndex: candidate.segmentIndex,
    selected: true,
    title: String(candidate.title ?? '').slice(0, TITLE_MAX),
    courseId: courseMissing ? null : courseId,
    courseMissing,
    type: mapping.type,
    mappedFromType: mapping.mapped ? mapping.sourceType : null,
    deadline,
    submitRequirement: String(candidate.submitRequirement ?? ''),
    submitMethod: String(candidate.submitMethod ?? ''),
    segmentText: String(candidate.rawText ?? ''),
    hints: [...(candidate.hints ?? []), ...(mapping.mapped ? [mapping.note] : [])],
    // 说明字段只是「顺手放一份」，放不下时留空并由原文留档兜底。
    descriptionFits: description.length > 0 || fits,
  }
}

/** 解析候选列表 → 行草稿列表（行号沿用解析器的段号，稳定且可读）。 */
export function noticeRowsFromCandidates(
  candidates: readonly ParsedNoticeCandidate[],
  courses: readonly NoticeCourseRef[],
): NoticeImportRow[] {
  return candidates.map((candidate) => noticeRowFromCandidate(candidate, courses))
}

/* -------------------------------- 校验 --------------------------------- */

/**
 * 行草稿 → `TaskDraft`。
 *
 * 说明（`description`）在这里生成：能整段放下就放（映射过类型时追加一行映射说明），
 * 放不下就留空 —— 原文随后会整份写进 `task_sources`，所以「说明放不下」不等于「原文丢了」。
 *
 * 仓库层（`NoticeImportRepository`）复用的就是这一个函数，两处不会漂移。
 */
export function noticeRowToTaskDraft(row: NoticeImportRow): TaskDraft {
  const { description } = draftDescription(row.segmentText)
  const note = taskTypeMappingNote(row.mappedFromType) ?? ''
  return {
    title: row.title,
    description: withTypeNote(description, row.mappedFromType ?? null, row.type, note),
    courseId: row.courseId,
    type: row.type,
    status: 'TODO',
    priority: 3,
    deadline: row.deadline,
    estimatedMinutes: '',
    submitRequirement: row.submitRequirement,
    submitMethod: row.submitMethod,
    originalText: '',
  }
}

export interface NoticeImportValidation {
  /** 「第 N 行：…」→ 中文说明；字段名与行号都在里面，界面能就地展示。 */
  fieldErrors: Record<string, string>
  /** 勾选且通过校验的行数。 */
  selectedCount: number
}

/** 每行至少要有这些字段才允许保存（标题必填）。 */
export function validateNoticeRowDraft(row: NoticeImportRow): Record<string, string> {
  const errors: Record<string, string> = {}
  const title = row.title.trim()
  if (title.length === 0) errors.title = '请填写任务标题。'
  else if (title.length > TITLE_MAX) errors.title = `标题最长 ${TITLE_MAX} 字。`
  // 通知导入保持「精确到分钟」的旧口径：只到日期的 DDL 请到任务表单里单独保存。
  if (isDateOnlyDeadline(row.deadline)) {
    errors.deadline = '通知导入仍需要具体时刻（HH:mm）；只有日期的截止时间请在任务表单里填写。'
  }
  return errors
}

/**
 * 校验整批勾选的行。
 *
 * - **已删除的课程**：单独一条可见错误（不是「静默忽略」，也不是把课程悄悄改成空）；
 * - 每行的标题 / 时间 / 提交信息等由 `normalizeTaskDraft` 的同一套口径兜底
 *   （仓库层会再跑一遍，界面这里只是为了**就地**提示）。
 */
export function validateNoticeImportRows(
  rows: readonly NoticeImportRow[],
  courses: readonly NoticeCourseRef[],
): NoticeImportValidation {
  const fieldErrors: Record<string, string> = {}
  let selectedCount = 0
  const availableIds = new Set(courses.map((course) => course.id))
  for (const row of rows) {
    if (!row.selected) continue
    selectedCount += 1
    const rowKey = (field: string): string => `row:${row.rowIndex}:${field}`
    if (row.courseMissing) {
      fieldErrors[rowKey('courseId')] =
        `第 ${row.rowIndex} 行：解析时关联的课程在本机已经找不到了，请重新选择课程或改成「不关联课程」。`
    } else if (row.courseId !== null && !availableIds.has(row.courseId)) {
      fieldErrors[rowKey('courseId')] =
        `第 ${row.rowIndex} 行：选择的课程在本机已经找不到了，请重新选择课程或改成「不关联课程」。`
    }
    for (const [field, message] of Object.entries(validateNoticeRowDraft(row))) {
      fieldErrors[rowKey(field)] = `第 ${row.rowIndex} 行：${message}`
    }
  }
  if (selectedCount === 0) {
    fieldErrors.selection = '还没有勾选任何一条：请勾选要保存的候选项。'
  }
  return { fieldErrors, selectedCount }
}

/* ------------------------- 需要用户核对的提示整理 ------------------------- */

/** 把解析提示整理成界面可用的短句（原样保留解析器的措辞，不另造语义）。 */
export function noticeRowHintText(row: NoticeImportRow): string[] {
  return row.hints.filter((hint) => hint.trim().length > 0)
}

/** 这条候选是否需要用户先补时间（原文没给出完整的「日期 + 时刻」）。 */
export function needsManualDeadline(row: NoticeImportRow): boolean {
  return row.deadline.trim().length === 0
}

export { NOTICE_HINTS, extractDeadline, extractSubmitMethod, extractSubmitRequirement, extractTitle, guessTaskType, matchCourse }
export {
  NATIVE_TASK_TYPE_LABELS,
  looksLikeNoticeTaskHeading,
  mapNoticeTaskType,
  preSplitNoticeText,
  splitIndependentNoticeTasks,
  taskTypeMappingNote,
  taskTypeNote,
} from './noticeTextAdapter'
export type { NoticeTaskChunk, TaskTypeMapping } from './noticeTextAdapter'
export type { NoticeCourseRef, ParsedNoticeCandidate }