/**
 * 照片导入的**行模型与字段映射**（纯函数，可测试）。
 *
 * 这一层只做三件事：
 * 1. 把识别候选转成**可编辑的表单初值**（缺字段就留空并标记「需要补充」，绝不编造时间/星期）；
 * 2. 生成稳定的行 id，让「重新识别」与「用户手改的内容」可以按行对齐、不互相覆盖；
 * 3. 校验每一行是否具备可以写入本机 SQLite 的最小信息，并给出中文缺项说明。
 *
 * 关于教学周的取舍（复核定稿明确要求）：
 * - 截图里如果显示「第 7 周」，那是**这一周**的课表快照，
 *   因此填成 `startWeek = endWeek = 7`，**不是**「整学期每周重复」；
 * - 截图里没有显示周次时不填周次，也不从截图里猜年份/学期；
 * - 学期第一周周一只来自用户在课程页做过的全局校准，这里只负责带上/不带。
 */

import { isValidDateKey } from './datetime'
// 老师姓名的长度上限复用课程表单那一份常量：两边各写一个数字迟早会漂移。
import { COURSE_LIMITS } from './courseDraft'
// 与伴侣服务/前端共用同一份「结构性标签」规则（实现就在 mobile 里，Metro 能直接打包）。
import { isStructuralLabel } from './headerLabels'
import type { CourseDraft, ScheduleDraft } from './types'
import { courseColorChoices } from './types'
import type { OcrCandidate } from './photoOcrClient'
import { canonicalClock } from './scheduleSession'
import { MAX_TEACHING_WEEK, MIN_TEACHING_WEEK } from './teachingWeekRange'

export type WeekPatternValue = 'ALL' | 'ODD' | 'EVEN'

/**
 * 截图里的周次**证据类型**（「范围 vs 快照」标签问题的根）。
 *
 * 旧实现把 `startWeek ?? endWeek` 统一叫 `weekFromImage`，于是 `1-16` 这种**范围**
 * 和「图上只有第 7 周」这种**快照**共用同一个字段，界面文案必然说错一种：
 * 范围行被说成「没有显示教学周 → 默认每周」，快照行被说成「第 N 周」。
 *
 * 现在显式区分：
 * - `snapshot`：图上只给了**一个**周次（`startWeek === endWeek`），
 *   含义是「这就是第 N 周那一周」，导入填 `N–N`，**不是**整学期重复；
 * - `range`：图上给了**起止**（`startWeek < endWeek`，例如 `1-16`），
 *   导入按 `A–B` 填，界面必须说成范围；
 * - `none`：图上没有周次信息（留空 = 每周都上）。
 */
export type WeekScope = 'snapshot' | 'range' | 'none'

/** 用户可编辑的一行（也是导入时的输入）。 */
export interface PhotoImportRow {
  /** 稳定行 id：同一张图重新识别时位置不变。 */
  id: string
  /** 界面上的行号（从 1 开始）。 */
  rowNumber: number
  include: boolean
  /** 原始识别文本，只读留存，便于用户对照原图核对。 */
  rawText: string
  name: string
  /**
   * 课程代码。
   *
   * 截图里通常**没有**课程代码，因此这里自动生成一个**内部编号**（`AUTO-01` 这种），
   * 而不是逼用户凭空编 21 个教务代码（那等于「一键导入」根本没法用）。
   * - 内部编号**只在导出/展示时说明是内部编号**，绝不伪装成学校代码；
   * - 导入时如果已经存在同名课程，会**复用那门课已有的代码**，不会覆盖；
   * - 用户想填真实代码可以直接改，`codeIsInternal` 会变成 false。
   */
  code: string
  /** 当前代码是不是自动生成的内部编号（界面据此说明来源）。 */
  codeIsInternal: boolean
  /**
   * **选课序号**：截图里课程名后面括号中的那串数字（例如 `9913000172.08`）。
   *
   * 与 `code` 完全分开：
   * - `code` 是 App 内部编号，或用户手填的学校代码；
   * - `selectionSerial` 是学校选课系统里的序号，只用于展示与
   *   「这是不是同一门课」的判断，**绝不**写进 `courses.code`。
   * 空字符串 = 图上没有这串数字（不猜）。
   */
  selectionSerial: string
  weekday: string
  startTime: string
  endTime: string
  location: string
  /**
   * **老师姓名**（截图里识别出来的，或用户手填的）。
   *
   * 空字符串 = 图上没有这一项 / 用户留空，**绝不编一个**；
   * 导入时原样写进 `courses.instructor`（见 `rowToDrafts`）。
   * 同名课程合并时由仓库层决定「补空 / 保留已有 / 报冲突」，绝不静默覆盖。
   */
  teacher: string
  /** 起止教学周（字符串，空 = 不限制）。 */
  startWeek: string
  endWeek: string
  weekPattern: WeekPatternValue
  /** 截图里的周次证据类型（快照 / 范围 / 没有）。 */
  weekScope: WeekScope
  /**
   * 截图里**真的显示出来的**周次，只用于「依据」展示与扩大范围时的确认。
   *
   * - `weekScope === 'snapshot'`：图上显示的那一周（等于起止周）；
   * - `weekScope === 'range'`：范围的**结束周**（这样确认文案能说清原本的范围）；
   * - `weekScope === 'none'`：`null`。
   */
  weekFromImage: number | null
  /**
   * 用户是否**主动把「截图显示的范围」扩大成了「每周都上」**。
   *
   * 复核对抓到的坑：清空起止周会让这条课从「只在这一周 / 这一段」悄悄变成
   * 「整学期每周」，属于静默扩大学习计划。因此清空截图带来的周次时必须显式确认一次
   * （界面上的「确实要改成每周都上」开关），否则导入前校验会拦住。
   */
  confirmedBroadenToEveryWeek: boolean
  /** 识别阶段的提示（低置信度、缺地点等），只展示不参与判定。 */
  warnings: string[]
  /** 用户是否手动改过这一行（重新识别时默认不覆盖）。 */
  edited: boolean
  /**
   * 这一行来自哪一次截图归档（`screenshot_attempts.id`）。
   *
   * 导入时用它写 `screenshot_refs`，让「课程 / 课表 → 原始截图」这条链**持久**存在，
   * 而不是只活在这一个界面上。
   */
  linkedAttemptId: number | null
}

/** 自动内部编号：`AUTO-01`。刻意用 ASCII 前缀，避免被误当成学校代码。 */
export function internalCourseCode(rowNumber: number): string {
  return `AUTO-${String(rowNumber).padStart(2, '0')}`
}

/**
 * 行上的老师姓名（去掉首尾空白）。
 *
 * 用 `String(... ?? '')` 而不是直接 `row.teacher.trim()`：**旧导航参数里的行**
 * （这次改动之前生成的 payload）没有 `teacher` 字段，直接点读会抛异常，
 * 而缺字段的正确含义是「没有老师信息」——留空，不是崩溃，也不是编一个。
 */
export function teacherOfRow(row: Pick<PhotoImportRow, 'teacher'>): string {
  return String(row.teacher ?? '').trim()
}

/** 全局教学周校准里、与导入有关的部分。 */
export interface ImportScopeOption {
  /** 学期第一周周一；没有校准时为 `null`。 */
  semesterStartMonday: string | null
  /** 是否把「学期第一周周一」写进每条课表（有校准就写，让记录自洽）。 */
  applySemesterStart: boolean
}

function normalizeWeekPattern(value: string | null | undefined): WeekPatternValue {
  const raw = String(value ?? '').trim().toUpperCase()
  return raw === 'ODD' || raw === 'EVEN' ? raw : 'ALL'
}

function positiveWeek(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return value >= MIN_TEACHING_WEEK && value <= MAX_TEACHING_WEEK ? value : null
}

/**
 * 由起止周判断「截图给的是什么证据」。
 *
 * 刻意**不**把 `startWeek` 当成「图上显示的周次」：那正是旧实现的错。
 * 范围行的依据是「A 到 B」，快照行的依据是「只有第 N 周」。
 */
export function weekScopeOf(startWeek: number | null, endWeek: number | null): WeekScope {
  if (startWeek !== null && endWeek !== null) return startWeek === endWeek ? 'snapshot' : 'range'
  if (startWeek !== null || endWeek !== null) return 'snapshot'
  return 'none'
}

/**
 * 图上真正显示出来的那个「周次依据」。
 *
 * - 快照：那一周本身；
 * - 范围：**结束周**（确认文案要说「原本是第 1–16 周」，而不是「第 1 周」）；
 * - 没有：`null`。
 */
export function weekEvidenceOf(startWeek: number | null, endWeek: number | null, scope: WeekScope): number | null {
  if (scope === 'none') return null
  if (scope === 'range') return endWeek ?? startWeek
  return startWeek ?? endWeek
}

/** 用户可见的周次范围文字（空 = 每周）。 */
export function describeWeekRange(row: Pick<PhotoImportRow, 'startWeek' | 'endWeek' | 'weekPattern'>): string {
  const start = row.startWeek.trim()
  const end = row.endWeek.trim()
  if (!start || !end) return '每周都上'
  const pattern = row.weekPattern === 'ALL' ? '' : row.weekPattern === 'ODD' ? '（单周）' : '（双周）'
  return start === end ? `第 ${start} 周${pattern}` : `第 ${start}–${end} 周${pattern}`
}

/** 这一行图上给的周次范围是否还是原样（没被清空）。 */
export function hasWeekScope(row: Pick<PhotoImportRow, 'startWeek' | 'endWeek'>): boolean {
  return row.startWeek.trim().length > 0 && row.endWeek.trim().length > 0
}

/**
 * 表单里（字符串）的起止周 → 周次证据类型。
 *
 * 界面在用户手改起止周之后必须重算这个字段：否则一条原本 `1–16` 的范围行被改成
 * `7–7` 之后还挂着 `range`，标签就会继续说「范围」——那正是要修的误导。
 */
export function deriveWeekScope(startWeek: string, endWeek: string): WeekScope {
  const start = startWeek.trim().length > 0 ? Number(startWeek) : null
  const end = endWeek.trim().length > 0 ? Number(endWeek) : null
  return weekScopeOf(Number.isFinite(start) ? start : null, Number.isFinite(end) ? end : null)
}

/** 表单里（字符串）的起止周 → 「图上显示的周次依据」。 */
export function deriveWeekEvidence(startWeek: string, endWeek: string, scope: WeekScope): number | null {
  const start = startWeek.trim().length > 0 ? Number(startWeek) : null
  const end = endWeek.trim().length > 0 ? Number(endWeek) : null
  return weekEvidenceOf(Number.isFinite(start) ? start : null, Number.isFinite(end) ? end : null, scope)
}

/** 由识别候选生成一行可编辑内容（id 稳定：`row-<序号>`）。 */
export function rowFromCandidate(candidate: OcrCandidate, index: number): PhotoImportRow {
  const name = String(candidate.name ?? '').trim()
  const location = String(candidate.location ?? '').trim()
  // 老师姓名：服务端有就带上，没有就留空（**绝不**从课程名里猜一个「老师」出来）。
  const teacher = String(candidate.teacher ?? '').trim()
  const startTime = canonicalClock(candidate.startTime) ?? ''
  const endTime = canonicalClock(candidate.endTime) ?? ''
  const weekday = Number.isInteger(candidate.weekday) && candidate.weekday! >= 1 && candidate.weekday! <= 7
    ? String(candidate.weekday)
    : ''
  // 起止教学周**分别**保留：`startWeek: 1, endWeek: 16` 就是 1–16，绝不塌成 1–1。
  const startWeek = positiveWeek(candidate.startWeek)
  const endWeek = positiveWeek(candidate.endWeek)
  const scope = weekScopeOf(startWeek, endWeek)
  const warnings = [...(candidate.warnings ?? [])]
  if (!name) warnings.push('没有识别到课程名，请手动填写')
  if (!weekday) warnings.push('没有识别到星期，请手动选择')
  if (!startTime || !endTime) warnings.push('没有识别到上课时间，请手动填写（不会替你猜一个时间）')
  if (!location) warnings.push('没有识别到地点，可留空或手动补充')

  return {
    id: `row-${index + 1}`,
    rowNumber: index + 1,
    include: true,
    rawText: String(candidate.rawText ?? '').trim(),
    name,
    // 截图里没有课程代码：先给一个**内部编号**，用户可以改；导入时同名课程会复用已有代码。
    code: internalCourseCode(index + 1),
    codeIsInternal: true,
    // 选课序号与内部编号**分开**：图上那串数字原样留着，不参与 code 的任何判定。
    selectionSerial: String(candidate.courseCode ?? '').trim(),
    weekday,
    startTime,
    endTime,
    location,
    teacher,
    startWeek: startWeek === null ? '' : String(startWeek),
    endWeek: endWeek === null ? '' : String(endWeek),
    weekPattern: normalizeWeekPattern(candidate.weekPattern),
    weekScope: scope,
    weekFromImage: weekEvidenceOf(startWeek, endWeek, scope),
    confirmedBroadenToEveryWeek: false,
    warnings,
    edited: false,
    linkedAttemptId: null,
  }
}

/**
 * 重新识别后合并：
 * - **用户改过的行默认保留**（`edited: true`），不会被新结果覆盖；
 * - 未改过的行按位置用新结果刷新；
 * - 行数变化时保留用户改过的行并追加新行，不让用户的修改凭空消失。
 */
export function mergeRowsAfterRerun(
  previous: readonly PhotoImportRow[],
  fresh: readonly PhotoImportRow[],
): { rows: PhotoImportRow[]; preserved: number; replaced: number; added: number } {
  const editedByIndex = new Map<number, PhotoImportRow>()
  previous.forEach((row, index) => {
    if (row.edited) editedByIndex.set(index, row)
  })

  const rows: PhotoImportRow[] = []
  let preserved = 0
  let replaced = 0
  let added = 0
  const total = Math.max(previous.length, fresh.length)
  for (let index = 0; index < total; index += 1) {
    const kept = editedByIndex.get(index)
    const next = fresh[index]
    if (kept && next) {
      rows.push({ ...next, ...pickEditedFields(kept), id: next.id, rowNumber: index + 1, edited: true })
      preserved += 1
      continue
    }
    if (kept) {
      rows.push({ ...kept, rowNumber: index + 1 })
      preserved += 1
      continue
    }
    if (next) {
      rows.push({ ...next, rowNumber: index + 1 })
      if (index >= previous.length) added += 1
      else replaced += 1
    }
  }
  return { rows, preserved, replaced, added }
}

function pickEditedFields(row: PhotoImportRow): Partial<PhotoImportRow> {
  return {
    include: row.include,
    name: row.name,
    code: row.code,
    codeIsInternal: row.codeIsInternal,
    selectionSerial: row.selectionSerial,
    weekday: row.weekday,
    startTime: row.startTime,
    endTime: row.endTime,
    location: row.location,
    // 老师姓名与其它字段一样：用户改过就跟着 `edited` 保留，重新识别不能把它抹掉。
    teacher: teacherOfRow(row),
    startWeek: row.startWeek,
    endWeek: row.endWeek,
    weekPattern: row.weekPattern,
    weekScope: row.weekScope,
    weekFromImage: row.weekFromImage,
    confirmedBroadenToEveryWeek: row.confirmedBroadenToEveryWeek,
    warnings: row.warnings,
    linkedAttemptId: row.linkedAttemptId,
  }
}

/** 行上「必须补」的字段（用于界面提示与导入前校验）。 */
export interface RowFieldIssue {
  /**
   * 出问题的字段。
   *
   * `instructor` 刻意沿用**仓库层 / 课程草稿的字段名**（`normalizeCourseDraft` 报的也是
   * `instructor`），这样界面把仓库返回的 `row:<行号>:instructor` 直接接到「老师姓名」
   * 输入框上，不需要再做一次名字翻译 —— 一处名字不一致就会让错误显示到别的字段上。
   */
  field: 'name' | 'weekday' | 'startTime' | 'endTime' | 'weekRange' | 'calendar' | 'instructor'
  message: string
}

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** 这一行的起止周是否真的成对且落在 1–53。 */
function weekRangeIssue(row: PhotoImportRow): RowFieldIssue | null {
  const hasStart = row.startWeek.trim().length > 0
  const hasEnd = row.endWeek.trim().length > 0
  if (!hasStart && !hasEnd) return null
  if (hasStart !== hasEnd) {
    return { field: 'weekRange', message: '起始周与结束周要同时填写，或都留空（留空 = 每周都上）。' }
  }
  const start = Number(row.startWeek)
  const end = Number(row.endWeek)
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < MIN_TEACHING_WEEK ||
    end > MAX_TEACHING_WEEK ||
    start > end
  ) {
    return {
      field: 'weekRange',
      message: `教学周范围要满足 ${MIN_TEACHING_WEEK} ≤ 起始 ≤ 结束 ≤ ${MAX_TEACHING_WEEK}（当前 ${row.startWeek}-${row.endWeek}）。`,
    }
  }
  return null
}

/**
 * 检查一行是否可导入；返回需要用户修改的字段（空数组 = 可以导入）。
 *
 * 课程代码**不再**是必填项：截图里没有代码，逼用户编 21 个代码等于「一键导入」不可用。
 * 自动生成的内部编号（`AUTO-01`）可以直接导入；同名课程会复用已有代码。
 */
export function validateRow(row: PhotoImportRow): RowFieldIssue[] {
  const issues: RowFieldIssue[] = []
  if (!row.name.trim()) issues.push({ field: 'name', message: '请填写课程名称。' })
  // 表头/时间栏守卫：识别流水线已经拦过一道，这里是最后一道，
  // 保证「周一」「10/12」「08:00」「第 7 周」这类文字永远不会被导成课程。
  if (row.name.trim() && isStructuralLabel(row.name.trim())) {
    issues.push({
      field: 'name',
      message:
        '这一行的名称是课表的表头或时间栏文字（星期 / 日期 / 节次 / 时刻），不是课程名。' +
        '请填写真正的课程名称，或把这一行取消勾选。',
    })
  }
  const weekday = Number(row.weekday)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    issues.push({ field: 'weekday', message: '请选择星期（周一至周日）。' })
  }
  if (!CLOCK_RE.test(row.startTime.trim())) issues.push({ field: 'startTime', message: '开始时间要填成 HH:mm。' })
  if (!CLOCK_RE.test(row.endTime.trim())) issues.push({ field: 'endTime', message: '结束时间要填成 HH:mm。' })
  if (CLOCK_RE.test(row.startTime.trim()) && CLOCK_RE.test(row.endTime.trim()) && row.startTime.trim() >= row.endTime.trim()) {
    issues.push({ field: 'endTime', message: '结束时间必须晚于开始时间。' })
  }

  const rangeIssue = weekRangeIssue(row)
  if (rangeIssue) issues.push(rangeIssue)

  // 静默扩大：截图显示的是「第 7 周」或「第 1–16 周」，用户把周次清空了 →
  // 会从「这一段」变成「整学期每周」。这正是复核对第 9/10 条要求拦住的
  // 「clearing week7 silently broadens」，因此这里报在 `weekRange` 字段上
  // （文案里说清**原本到底是什么范围**与两个可选做法），
  // 只有用户显式打开「确认改成每周都上」才放行。
  const cleared = rangeIssue === null && row.startWeek.trim().length === 0 && row.endWeek.trim().length === 0
  if (cleared && row.weekFromImage !== null && !row.confirmedBroadenToEveryWeek) {
    issues.push({ field: 'weekRange', message: broadenWarningMessage(row) })
  }

  // 老师姓名：不上限就会在仓库层被拒绝，而那时用户只看到一句笼统的「第 N 行有问题」。
  // 这里用**同一份**上限常量提前报在「老师姓名」字段上，超长的识别结果是可以当场改短的，
  // 绝不静默截断成另一个名字。
  const teacher = teacherOfRow(row)
  if (teacher.length > COURSE_LIMITS.INSTRUCTOR_MAX) {
    issues.push({
      field: 'instructor',
      message: `老师姓名最长 ${COURSE_LIMITS.INSTRUCTOR_MAX} 字（当前 ${teacher.length} 字），请改短或清空。`,
    })
  }
  return issues
}

/**
 * 「清空周次会扩大范围」的确认文案。
 *
 * 范围行与快照行**必须说不同的话**（这正是原先「范围 vs 快照」标签混淆的后果）：
 * `1–16` 被清空时要说「原本是第 1–16 周」，而不是说成「第 1 周」或「没有显示教学周」。
 *
 * 同时兼容「用户已经改过起止周、然后才清空」的情况：这时用行上**当前**的起止周
 * 拼出原始范围；当前也空时退回 `weekFromImage` 这一条证据。
 */
export function broadenWarningMessage(
  row: Pick<PhotoImportRow, 'weekScope' | 'weekFromImage' | 'startWeek' | 'endWeek'>,
): string {
  const start = row.startWeek.trim()
  const end = row.endWeek.trim()
  const fromRow = start.length > 0 && end.length > 0 ? (start === end ? `第 ${start} 周` : `第 ${start}–${end} 周`) : null
  const fallback =
    row.weekFromImage === null
      ? null
      : row.weekScope === 'range'
        ? `第 ${start || '?'}–${row.weekFromImage} 周`
        : `第 ${row.weekFromImage} 周`
  const original = fromRow ?? fallback ?? '图上显示的那一段周次'
  return (
    `这张图的周次依据是${original}。清空起止周会让这条课从「只在这一段」变成「整学期每周都上」。` +
    `要继续的话请二选一：把起止周填回需要的范围，或显式打开这一行的「确认改成每周都上」。`
  )
}

/** 整批里有多少行需要先修改（只统计勾选的行）。 */
export function countRowsNeedingFix(rows: readonly PhotoImportRow[]): number {
  return rows.filter((row) => row.include && validateRow(row).length > 0).length
}

/**
 * 一行 → `CourseDraft` + `ScheduleDraft`。
 *
 * 两个**不能丢**的约束（复核对明确要求）：
 * - 起止周与单双周**原样写出**，绝不因为「某一项为空」就静默改成 `ALL`
 *   （截图显示第 7 周的那一条，清空前必须先确认，见 `validateRow`）；
 * - 有周次范围且已校准时，把校准出来的学期首周一写进去，让这条记录自洽；
 *   没有校准时**不编造**学期起点（`semesterStartDate` 留空），导入前校验会拦住。
 *
 * 课程代码：用行上的值（通常是自动内部编号）；同名课程在导入时由仓库层复用已有代码。
 * **选课序号**（图上课程名后括号里的那串数字）作为独立字段带下去，绝不写进课程代码；
 * 仓库层用它判断「同名但序号不同的两门课不能合并」，并给同名课程补写这个证据。
 * 颜色按行号从既有调色板里循环取，保证新建的课程在列表里有区分度。
 */
export function rowToDrafts(
  row: PhotoImportRow,
  scope: ImportScopeOption,
): { course: CourseDraft; schedule: ScheduleDraft } {
  const name = row.name.trim()
  const hasWeekScope = row.startWeek.trim().length > 0 && row.endWeek.trim().length > 0
  const semesterStartDate =
    hasWeekScope && scope.applySemesterStart && scope.semesterStartMonday && isValidDateKey(scope.semesterStartMonday)
      ? scope.semesterStartMonday
      : ''

  const course: CourseDraft = {
    code: (row.code.trim() || internalCourseCode(row.rowNumber)).slice(0, 32),
    name,
    // 老师姓名：识别到的 / 用户手填的原样带下去；空就是空，不编一个。
    // 刻意**不**在这里截断：超长会在导入校验里作为该行的错误显示出来，而不是被悄悄剪掉。
    instructor: teacherOfRow(row),
    semester: '',
    color: courseColorChoices[(row.rowNumber - 1) % courseColorChoices.length] ?? '',
    note: '',
    // 选课序号：空串在仓库层表示「保留库里已有的值」，不会把已记录的序号抹掉。
    selectionSerial: row.selectionSerial.trim().slice(0, 40),
  }
  const schedule: ScheduleDraft = {
    weekday: Number(row.weekday) || 1,
    startTime: row.startTime.trim(),
    endTime: row.endTime.trim(),
    location: row.location.trim(),
    periodStart: '',
    periodEnd: '',
    semesterStartDate,
    startWeek: hasWeekScope ? row.startWeek.trim() : '',
    endWeek: hasWeekScope ? row.endWeek.trim() : '',
    // 只有真的「没有周次范围」时才落到 ALL；单双周本身一定要保留下来。
    weekPattern: hasWeekScope ? row.weekPattern : 'ALL',
  }
  return { course, schedule }
}

/** 一行的人话摘要（列表里显示，避免用户看一堆空字段）。 */
export function describeRow(row: PhotoImportRow): string {
  const weekdayText = row.weekday ? `周${'一二三四五六日'[Number(row.weekday) - 1] ?? '?'}` : '星期未填'
  const timeText = row.startTime && row.endTime ? `${row.startTime}–${row.endTime}` : '时间未填'
  const weekText =
    row.startWeek && row.endWeek
      ? `第 ${row.startWeek}${row.startWeek === row.endWeek ? '' : `–${row.endWeek}`} 周${
          row.weekPattern === 'ALL' ? '' : row.weekPattern === 'ODD' ? ' · 单周' : ' · 双周'
        }`
      : '每周'
  return `${weekdayText} ${timeText} · ${weekText}${row.location ? ` · ${row.location}` : ''}`
}

/** 统计：一门课在识别结果里出现了几次（用于提示「同一门课有多段」）。 */
export function courseFrequency(rows: readonly PhotoImportRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.name.trim()
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export const WEEK_PATTERN_OPTIONS: ReadonlyArray<{ value: WeekPatternValue; label: string }> = [
  { value: 'ALL', label: '每周' },
  { value: 'ODD', label: '单周' },
  { value: 'EVEN', label: '双周' },
]
