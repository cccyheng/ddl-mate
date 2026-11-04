/**
 * 课程与课表表单校验（纯函数，可测试）。
 *
 * 校验口径与后端 `ScheduleService` 保持一致：
 * - 课程名必填；**课程代码不是用户要填的东西**（见下）；
 * - 星期 1–7；上课时间 `HH:mm` 且开始 < 结束；
 * - 学期第一周周一必须是**真实存在的周一**；起止教学周 1–53 且成对出现、起始 ≤ 结束；
 * - 只填一半的教学周信息一律拒绝，绝不替用户猜另一侧。
 */

import { isValidDateKey, weekdayName, weekdayOfDateKey } from './datetime'
import { ValidationError } from './errors'
import { validateTermRange, type WeekPattern } from './scheduleRules'
import type { Course, CourseDraft, Schedule, ScheduleDraft } from './types'

const CODE_MAX = 32
const NAME_MAX = 128
const INSTRUCTOR_MAX = 64
const SEMESTER_MAX = 32
const NOTE_MAX = 500
const LOCATION_MAX = 128

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

export interface NormalizedCourse {
  /**
   * 内部代码：**不面向用户**。
   *
   * 老库里可能已经有值（学校教务代码 / 导入时自动生成的内部编号），
   * **保留原样用于匹配**；新建时留空由仓库层补一个唯一的内部编号。
   * 空串在仓库层表示「保留库里已有的值 / 新建时自动生成」，不是在报错。
   */
  code: string
  name: string
  instructor: string | null
  semester: string | null
  color: string | null
  note: string | null
  /**
   * 选课序号：**非空**时返回字符串，空返回 `null`。
   *
   * `null` 在仓库层表示「保留库里已有的值」，因此这里刻意不区分「没给」与「给了空串」：
   * 要**明确清空**必须走 `CourseDraft.clearSelectionSerial`。
   */
  selectionSerial: string | null
}

/** 选课序号上限：截图里通常是 `9913000172.08` 这种，给足余量但不允许塞大段文本。 */
const SELECTION_SERIAL_MAX = 40

export function normalizeCourseDraft(draft: CourseDraft): NormalizedCourse {
  const fields: Record<string, string> = {}

  const name = String(draft.name ?? '').trim()
  if (name.length === 0) fields.name = '请填写课程名称。'
  else if (name.length > NAME_MAX) fields.name = `课程名称最长 ${NAME_MAX} 字。`

  /*
   * 课程代码**不做必填校验**：它是内部字段，正常流程里用户根本看不到、也不该被要求输入。
   * 留空 → 新建时由仓库层补一个唯一的内部编号（`AUTO-01` 这种），编辑时保留库里已有的值。
   * 这里只守住「太长了」这一条（老数据 / 照片导入路径仍可能带一个真实教务代码进来）。
   */
  const code = String(draft.code ?? '').trim()
  if (code.length > CODE_MAX) fields.code = `课程代码最长 ${CODE_MAX} 字。`

  const instructor = trimOrNull(draft.instructor)
  if (instructor && instructor.length > INSTRUCTOR_MAX) fields.instructor = `教师最长 ${INSTRUCTOR_MAX} 字。`

  const semester = trimOrNull(draft.semester)
  if (semester && semester.length > SEMESTER_MAX) fields.semester = `学期最长 ${SEMESTER_MAX} 字。`

  const note = trimOrNull(draft.note)
  if (note && note.length > NOTE_MAX) fields.note = `备注最长 ${NOTE_MAX} 字。`

  const color = trimOrNull(draft.color)
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) fields.color = '颜色需要是 #RRGGBB 形式。'

  const selectionSerial = trimOrNull(draft.selectionSerial)
  if (selectionSerial && selectionSerial.length > SELECTION_SERIAL_MAX) {
    fields.selectionSerial = `选课序号最长 ${SELECTION_SERIAL_MAX} 字（截图里通常是 9913000172.08 这种）。`
  }

  if (Object.keys(fields).length > 0) throw new ValidationError('课程信息还有问题需要修改。', fields)
  return { code, name, instructor, semester, color, note, selectionSerial }
}

export interface NormalizedSchedule {
  weekday: number
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
}

export function normalizeScheduleDraft(draft: ScheduleDraft): NormalizedSchedule {
  const fields: Record<string, string> = {}

  const weekday = Number(draft.weekday)
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) fields.weekday = '星期必须是周一至周日。'

  const startTime = String(draft.startTime ?? '').trim()
  const endTime = String(draft.endTime ?? '').trim()
  if (!CLOCK_RE.test(startTime)) fields.startTime = '开始时间格式应为 HH:mm（00:00–23:59）。'
  if (!CLOCK_RE.test(endTime)) fields.endTime = '结束时间格式应为 HH:mm（00:00–23:59）。'
  if (!fields.startTime && !fields.endTime && startTime >= endTime) {
    fields.endTime = '结束时间必须晚于开始时间。'
  }

  const location = trimOrNull(draft.location)
  if (location && location.length > LOCATION_MAX) fields.location = `地点最长 ${LOCATION_MAX} 字。`

  const periodStart = parseOptionalPeriod(draft.periodStart, 'periodStart', fields)
  const periodEnd = parseOptionalPeriod(draft.periodEnd, 'periodEnd', fields)
  if (periodStart !== null && periodEnd !== null && periodStart > periodEnd) {
    fields.periodEnd = '结束节次不能早于开始节次。'
  }
  if ((periodStart === null) !== (periodEnd === null)) {
    fields.periodEnd = '开始节次与结束节次需要同时填写。'
  }

  const term = validateTermRange({
    semesterStartDate: draft.semesterStartDate,
    startWeek: draft.startWeek,
    endWeek: draft.endWeek,
    weekPattern: draft.weekPattern,
  })
  if (!term.ok) {
    const target = term.message?.includes('学期第一周周一')
      ? 'semesterStartDate'
      : term.message?.includes('没有可上课的周')
        ? 'weekPattern'
        : 'endWeek'
    fields[target] = term.message ?? '教学周设置不合法。'
  }

  const weekPattern = String(draft.weekPattern ?? 'ALL').toUpperCase()
  if (weekPattern !== 'ALL' && weekPattern !== 'ODD' && weekPattern !== 'EVEN') {
    fields.weekPattern = '上课周次规律只能是每周 / 单周 / 双周。'
  }

  const weekRange = term.ok && term.startWeek !== null && term.endWeek !== null ? `${term.startWeek}-${term.endWeek}` : null

  if (Object.keys(fields).length > 0) throw new ValidationError('课表信息还有问题需要修改。', fields)

  return {
    weekday,
    startTime,
    endTime,
    location,
    periodStart,
    periodEnd,
    weekRange,
    semesterStartDate: term.semesterStartDate,
    startWeek: term.startWeek,
    endWeek: term.endWeek,
    weekPattern: weekPattern as WeekPattern,
  }
}

function parseOptionalPeriod(
  raw: string | number | null | undefined,
  field: string,
  fields: Record<string, string>,
): number | null {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return null
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    fields[field] = '节次需要是 1–20 的整数。'
    return null
  }
  return value
}

/* ---------------------------- 课程名归一化（跨 OCR 变体） ---------------------------- */

/**
 * 课程名归一化：把**同一门课**的排版/标点变体归到一起。
 *
 * 为什么需要它（真实截图上的问题）：同一门课在周一的格子里识别成 `大学物理(B-2)`，
 * 在周三的格子里识别成 `大学物理B-2`（括号被拆行丢掉）。如果按「去掉空白后的原文」比较，
 * 这两行会被当成两门课，导入后课程列表就多出一门重复课程（用户看到 16 门而实际只有 15 门）。
 *
 * 归一化规则刻意**保守**：
 * - 去掉：空白、以及**不承载语义**的标点（括号、连字符、顿号、斜杠、点号、冒号、引号等）；
 * - 保留：字母、数字、加号、下划线与**全部汉字**；
 * - 因此 `C++` 与 `C`、`大学物理实验(2)` 与 `大学物理实验(3)` 仍然是不同的课。
 *
 * 它只用于「这是不是同一门课」的判断，**绝不**改写用户看到的课程名。
 */
export function normalizeCourseNameForCompare(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s()（）\[\]【】{}<>《》\-–—_/\\、,，.。;；:：!！?？'‘’"“”`~·•|]/g, '')
    .trim()
}

/**
 * 课程代码归一化：判断两个代码是不是「同一个」。
 *
 * 与课程名同理：`CS-101` 与 `CS101` 视为同一个代码。
 */
export function normalizeCourseCodeForCompare(raw: string | null | undefined): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-–—_/\\]/g, '')
    .trim()
}

/**
 * 自动生成的**内部代码**：`AUTO-01`、`AUTO-07` …
 *
 * 为什么还留着这个格式（而不是换一种）：
 * - 老库里已经有照片导入写下的 `AUTO-nn` 代码，**不能迁移、不能改写**，
 *   它们要继续被认成「内部生成、不承载用户意图」；
 * - 新建课程留空时也复用同一个格式，于是「哪些代码是 App 自己编的」永远只有一条判据。
 *
 * 它不承载用户意图，因此同名课程合并时可以放心复用 / 覆盖。
 */
export const INTERNAL_COURSE_CODE_PREFIX = 'AUTO-'

/** 内部代码序号补零到 2 位：`AUTO-01` … `AUTO-99`，再往上自然变 3 位。 */
export function internalCourseCodeText(sequence: number): string {
  const safe = Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 1
  return `${INTERNAL_COURSE_CODE_PREFIX}${String(safe).padStart(2, '0')}`
}

/** 照片导入与新建课程自动生成的内部编号（`AUTO-01`）。它不承载用户意图，可以放心复用。 */
export function isInternalCourseCode(raw: string | null | undefined): boolean {
  return /^auto-?\d+$/i.test(String(raw ?? '').trim())
}

export function courseToDraft(course: Course): CourseDraft {
  return {
    code: course.code,
    name: course.name,
    instructor: course.instructor ?? '',
    semester: course.semester ?? '',
    color: course.color ?? '',
    note: course.note ?? '',
    // 选课序号原样带进表单；它是独立字段，绝不与 code 混用。
    selectionSerial: course.selectionSerial ?? '',
  }
}

export function scheduleToDraft(schedule: Schedule): ScheduleDraft {
  return {
    weekday: schedule.weekday,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    location: schedule.location ?? '',
    periodStart: schedule.periodStart === null ? '' : String(schedule.periodStart),
    periodEnd: schedule.periodEnd === null ? '' : String(schedule.periodEnd),
    semesterStartDate: schedule.semesterStartDate ?? '',
    startWeek: schedule.startWeek === null ? '' : String(schedule.startWeek),
    endWeek: schedule.endWeek === null ? '' : String(schedule.endWeek),
    weekPattern: schedule.weekPattern,
  }
}

/** 教学周设置的中文摘要（课程详情页展示）。 */
export function describeTerm(schedule: Schedule): string {
  if (!schedule.semesterStartDate || schedule.startWeek === null || schedule.endWeek === null) {
    return '每周（未设置教学周）'
  }
  const weekday = weekdayOfDateKey(schedule.semesterStartDate)
  const mondayNote = weekday === 1 ? '' : '（非周一，数据异常）'
  const pattern = schedule.weekPattern === 'ALL' ? '每周' : schedule.weekPattern === 'ODD' ? '单周' : '双周'
  return `学期首周一 ${schedule.semesterStartDate}${mondayNote} · 第 ${schedule.startWeek}-${schedule.endWeek} 周 · ${pattern}`
}

/** 学期起点的星期几提示，用于表单校验提示文案。 */
export function mondayHint(dateKey: string): string {
  if (!isValidDateKey(dateKey)) return '请输入 YYYY-MM-DD 格式的真实日期。'
  const weekday = weekdayOfDateKey(dateKey)
  if (weekday === null) return '日期无法识别。'
  return weekday === 1 ? '是周一 ✓' : `是${weekdayName(weekday)}，学期第一周必须是周一。`
}

export const COURSE_LIMITS = {
  CODE_MAX,
  NAME_MAX,
  INSTRUCTOR_MAX,
  SEMESTER_MAX,
  NOTE_MAX,
  LOCATION_MAX,
} as const
