/**
 * 原生端时间助手「解析层」—— 纯函数，无 React / 无网络 / 无数据库写入。
 *
 * 职责：
 * - 复用 {@link parseTimePhrase}（纯语法）把短语变成确定时间或课程窗口；
 * - 「课前」类说法**只看用户明确选择的那门课**，并按 {@link occursOn}（全应用唯一教学周判定）
 *   在真实课表里找**严格晚于参考时间**的最近一节；
 * - 输出可直接展示的中文说明（北京时间 + 解释 + 课程 / 日期 / 地点 / 过去提醒）。
 *
 * 三条硬边界：
 * 1. **只读**：本模块不写数据库、不改任务草稿；
 * 2. **固定北京时间**：一律用 `datetime.ts` 的 Asia/Shanghai 工具，与手机系统时区无关；
 * 3. **不越窗**：`下周…` / `本周X…` 只在窗口内找课，找不到就如实说没有，绝不越周。
 */

import {
  SHANGHAI_ZONE,
  isoToEpochMs,
  isoToShanghaiDateKey,
  isoToShanghaiWallClock,
  isValidDateKey,
  parseOffsetIso,
  shanghaiWallClockToOffset,
  weekdayName,
  weekdayOfDateKey,
} from './datetime'
import { occursOn, type ScheduleWeekRule } from './scheduleRules'
import {
  MAX_LOOKAHEAD_DAYS,
  parseTimePhrase,
  phraseLengthError,
  type CourseWindow,
  type ParsedPhrase,
} from './timePhraseParser'

export const TIME_ASSISTANT_ZONE = SHANGHAI_ZONE

export type TimeAssistantStatus = 'RESOLVED' | 'NEEDS_INFO' | 'UNSUPPORTED' | 'NO_COURSE_MATCH'

export interface TimeAssistantCandidate {
  /** 带 `+08:00` 的 ISO 字符串（与任务 `deadline` 入库格式一致）。 */
  deadline: string
  /** 北京墙上时间 `YYYY-MM-DDTHH:mm`（表单字段用的格式）。 */
  wallClock: string
  /** 北京时间可读标签 `YYYY-MM-DD HH:mm 周五`。 */
  label: string
  reason: string
  kind: 'TIME_PHRASE' | 'COURSE_BOUNDARY'
  /** 该时间早于参考时间（助手如实提示，绝不偷偷换一个时间）。 */
  past: boolean
  courseBoundary: boolean
  courseId: number | null
  courseName: string | null
  scheduleId: number | null
  scheduleDate: string | null
  scheduleStartTime: string | null
  scheduleLocation: string | null
  note: string | null
}

export interface TimeAssistantResult {
  status: TimeAssistantStatus
  message: string
  hints: string[]
  referenceAt: string
  /** 参考时间的北京墙上时间 `YYYY-MM-DDTHH:mm`。 */
  referenceWallClock: string
  referenceLabel: string
  timeZone: string
  candidates: TimeAssistantCandidate[]
}

export interface TimeAssistantRequest {
  text: string
  /** 参考时间：带偏移的 ISO 或北京墙上时间；非法 / 缺偏移按无偏移处理（= 北京时间）。 */
  referenceAt: string
  /** 用户在表单里**明确选择**的课程；`null` 表示没有选择。 */
  courseId?: number | null
  courses?: ReadonlyArray<{ id: number; name: string; code?: string | null }>
  /** 真实课表快照（全部课程的课表，内部按 courseId 过滤）。 */
  schedules?: ReadonlyArray<ScheduleWeekRule & { id: number; courseId: number; startTime: string; location?: string | null }>
}

/* ------------------------------------------------------------------ 入口 */

/** 只解析短语本身（不涉及课表），UI 可用来做实时校验。 */
export function parseAssistantPhrase(
  text: string,
  referenceWallClock: string,
): { error: string | null; parsed: ParsedPhrase | null } {
  const error = phraseLengthError(text)
  if (error) return { error, parsed: null }
  const referenceDate = referenceWallClock.slice(0, 10)
  if (!isValidDateKey(referenceDate)) {
    return { error: '通知参考时间不是有效的北京时间，无法计算相对时间。', parsed: null }
  }
  return { error: null, parsed: parseTimePhrase(text, referenceDate) }
}

/** 完整的本地解析：短语 + 参考时间 + 明确选择的课程 + 真实课表。 */
export function resolveTimeAssistant(request: TimeAssistantRequest): TimeAssistantResult {
  const reference = normalizeReference(request.referenceAt)
  if (!reference) {
    return build('', '', 'NEEDS_INFO', '通知参考时间不是有效的北京时间：请重新填写（例如 2026-10-13 12:00）。', [])
  }

  const { parsed, error } = parseAssistantPhrase(request.text, reference.wallClock)
  if (error || !parsed) {
    return build(reference.offsetIso, reference.wallClock, 'NEEDS_INFO', error ?? '短语不可用。', [])
  }

  switch (parsed.outcome) {
    case 'NEEDS_INFO':
      return build(reference.offsetIso, reference.wallClock, 'NEEDS_INFO', parsed.message, parsed.hints)
    case 'UNSUPPORTED':
      return build(reference.offsetIso, reference.wallClock, 'UNSUPPORTED', parsed.message, parsed.hints)
    case 'RESOLVED': {
      const candidate = candidateFromParsedTime(parsed, reference)
      if (!candidate) {
        return build(reference.offsetIso, reference.wallClock, 'NEEDS_INFO', parsed.message, parsed.hints)
      }
      const hints = [...parsed.hints]
      if (candidate.past && !hints.includes('这个时间在参考时间之前：如果需要将来的时间，请改写短语。')) {
        hints.push('这个时间在参考时间之前：如果需要将来的时间，请改写短语。')
      }
      return build(reference.offsetIso, reference.wallClock, 'RESOLVED', '已按短语解析出明确时间。', hints, [candidate])
    }
    case 'COURSE_WINDOW':
      return resolveCourseBoundary(request, parsed, reference)
    default:
      return build(reference.offsetIso, reference.wallClock, 'NEEDS_INFO', parsed.message, parsed.hints)
  }
}

/* ------------------------------------------------------------------ 普通时间短语 */

interface Reference {
  wallClock: string
  offsetIso: string
  epochMs: number
}

function candidateFromParsedTime(parsed: ParsedPhrase, reference: Reference): TimeAssistantCandidate | null {
  const time = parsed.times[0]
  if (!time) return null
  const deadline = shanghaiWallClockToOffset(`${time.dateKey}T${time.clock}`)
  if (!deadline) return null
  const epochMs = isoToEpochMs(deadline)
  return {
    deadline,
    wallClock: `${time.dateKey}T${time.clock}`,
    label: labelOf(`${time.dateKey}T${time.clock}`),
    reason: time.reason,
    kind: 'TIME_PHRASE',
    past: epochMs !== null && epochMs < reference.epochMs,
    courseBoundary: false,
    courseId: null,
    courseName: null,
    scheduleId: null,
    scheduleDate: null,
    scheduleStartTime: null,
    scheduleLocation: null,
    note: null,
  }
}

/* ------------------------------------------------------------------ 课程边界 */

type ScheduleInput = ScheduleWeekRule & {
  id: number
  courseId: number
  startTime: string
  location?: string | null
}

export type { ScheduleInput }

interface ClassMatch {
  schedule: ScheduleInput
  dateKey: string
  startWallClock: string
  startEpochMs: number
}

function resolveCourseBoundary(
  request: TimeAssistantRequest,
  parsed: ParsedPhrase,
  reference: Reference,
): TimeAssistantResult {
  const window = parsed.window
  const phrase = parsed.phrase ?? '课前'
  if (!window) {
    return build(reference.offsetIso, reference.wallClock, 'NEEDS_INFO', parsed.message, parsed.hints)
  }

  const courseId = request.courseId
  if (courseId === null || courseId === undefined) {
    return build(
      reference.offsetIso,
      reference.wallClock,
      'NEEDS_INFO',
      `「${phrase}」需要先明确选择课程：请先选好这门课，再点解析。`,
      ['课程必须由你明确选择，助手不会从文字里替你挑一门课。'],
    )
  }

  const courseList = request.courses
  if (courseList === undefined) {
    return build(
      reference.offsetIso,
      reference.wallClock,
      'NEEDS_INFO',
      `「${phrase}」需要课程信息才能按课表推算：请先选好这门课，再点解析。`,
      ['课程必须由你明确选择，助手不会从文字里替你挑一门课。'],
    )
  }

  const course = courseList.find((item) => item.id === courseId) ?? null
  if (!course) {
    // 选择的那门课在本机已经不存在（被删除 / 数据还没读到）：绝不拿一个「所选课程」的空壳继续算。
    return build(
      reference.offsetIso,
      reference.wallClock,
      'NEEDS_INFO',
      `「${phrase}」原来选择的课程在本机已经找不到了：请在「所属课程」里重新选择一门课，再点解析。`,
      ['助手不会用一门不存在的课去推算时间。'],
    )
  }
  const courseName = course.name

  const mentioned = findMentionedOtherCourse(request.text, courseId, courseList)
  if (mentioned) {
    return build(
      reference.offsetIso,
      reference.wallClock,
      'NEEDS_INFO',
      `文字里提到的是「${mentioned}」，与你选择的「${courseName}」不是同一门课：请选择对应的课程，或改写短语。`,
      ['助手不会忽略文字里的另一门课，直接按当前选择的课程算。'],
    )
  }

  const schedules = (request.schedules ?? []).filter((schedule) => schedule.courseId === courseId)
  if (schedules.length === 0) {
    return build(
      reference.offsetIso,
      reference.wallClock,
      'NO_COURSE_MATCH',
      `「${courseName}」在本机还没有课表，无法按「课前」推算：请先补上课表，或改用明确时间。`,
      ['可以写「下周五 18:00」这样的明确时间。'],
    )
  }

  const matches = collectMatches(schedules, window, reference)
  if (matches.length === 0) {
    return build(reference.offsetIso, reference.wallClock, 'NO_COURSE_MATCH', explainNoMatch(courseName, window), [
      '助手只按约定窗口查找，不会越周去更远的地方找课。',
      '可以改用明确时间，例如「下周五 18:00」。',
      '也可以检查课表里这门课的星期 / 起止教学周 / 单双周设置。',
    ])
  }

  const first = matches[0] as ClassMatch
  const clock = first.schedule.startTime.slice(0, 5)
  let note = '课前完成：按开课时间作为截止边界，助手不会提前扣分钟。'
  if (matches.length > 1) {
    const second = matches[1] as ClassMatch
    note += `该窗口内还有 ${matches.length - 1} 节更晚的课（下一节 ${second.dateKey} ${second.schedule.startTime.slice(
      0,
      5,
    )}），按「课前」取最早的一节。`
  }

  const candidate: TimeAssistantCandidate = {
    deadline: `${first.startWallClock}:00+08:00`,
    wallClock: first.startWallClock,
    label: labelOf(first.startWallClock),
    reason:
      `“${phrase}” → ${courseName} ${first.dateKey}（${weekdayName(weekdayOfDateKey(first.dateKey) ?? 1)}）` +
      `${clock} 上课前（北京时间 +08:00）`,
    kind: 'COURSE_BOUNDARY',
    past: false,
    courseBoundary: true,
    courseId,
    courseName,
    scheduleId: first.schedule.id,
    scheduleDate: first.dateKey,
    scheduleStartTime: clock,
    scheduleLocation: first.schedule.location ?? null,
    note,
  }

  return build(
    reference.offsetIso,
    reference.wallClock,
    'RESOLVED',
    `已按课表匹配到「${courseName}」的下一节：${first.dateKey} ${weekdayName(
      weekdayOfDateKey(first.dateKey) ?? 1,
    )} ${clock}。`,
    [],
    [candidate],
  )
}

/**
 * 在窗口内按真实课表找「参考时间之后**才开始**」的课，按开始时间升序，同一时刻去重。
 *
 * 正在上的那节（开始时间 ≤ 参考时间）不算「下一次」，开始时间**等于**参考时间也不算。
 */
export function collectMatches(
  schedules: readonly ScheduleInput[],
  window: CourseWindow,
  reference: Reference,
): ClassMatch[] {
  const start = window.startDateKey
  let endExclusive = window.endDateKeyExclusive
  const startDay = dayNumberOf(start)
  const endDay = dayNumberOf(endExclusive)
  if (startDay === null || endDay === null || endDay <= startDay) return []
  if (endDay - startDay > MAX_LOOKAHEAD_DAYS) endExclusive = dateKeyAfter(startDay + MAX_LOOKAHEAD_DAYS)
  const lastDay = dayNumberOf(endExclusive)
  if (lastDay === null) return []

  const matches: ClassMatch[] = []
  const seen = new Set<string>()
  for (let day = startDay; day < lastDay; day += 1) {
    const dateKey = dateKeyAfter(day)
    if (!isValidDateKey(dateKey)) continue
    for (const schedule of schedules) {
      if (!occursOn(schedule, dateKey)) continue
      const startWallClock = `${dateKey}T${normalizeClock(schedule.startTime)}`
      const offsetIso = shanghaiWallClockToOffset(startWallClock)
      if (!offsetIso) continue
      const startEpochMs = isoToEpochMs(offsetIso)
      if (startEpochMs === null) continue
      // 参考时间之后才开始的课才算「下一次」：正在上的那节不算
      if (startEpochMs <= reference.epochMs) continue
      const key = startWallClock.slice(0, 16)
      if (seen.has(key)) continue
      seen.add(key)
      matches.push({ schedule, dateKey, startWallClock: startWallClock.slice(0, 16), startEpochMs })
    }
  }
  matches.sort((left, right) => left.startEpochMs - right.startEpochMs)
  return matches
}

/** 窗口内一节都没匹配上时的解释文案（说清窗口范围，绝不暗示越周去找）。 */
export function explainNoMatch(courseName: string, window: CourseWindow): string {
  const range = `${window.startDateKey} ~ ${dateKeyAfter((dayNumberOf(window.endDateKeyExclusive) ?? 1) - 1)}`
  if (window.scope === 'DAY') {
    return (
      `「${window.phrase}」对应 ${window.startDateKey}（${weekdayName(
        weekdayOfDateKey(window.startDateKey) ?? 1,
      )}），但课表里「${courseName}」当天没有课（已按学期起点 / 起止教学周 / 单双周过滤，正在上的课不算下一次）。`
    )
  }
  if (window.scope === 'WEEK') {
    return `「${window.phrase}」限定的时间窗口（${range}）里没有「${courseName}」的课：助手不会越周到更远的周去找。`
  }
  return `从参考时间起最多 ${MAX_LOOKAHEAD_DAYS} 天（${range}）内都没有「${courseName}」的课（已按学期起点 / 起止教学周 / 单双周过滤）。`
}

/** 文字里是否提到了**另一门**已有课程（名称或代码完全一致）；提到就要求用户先澄清。 */
export function findMentionedOtherCourse(
  text: string,
  selectedCourseId: number,
  courses: ReadonlyArray<{ id: number; name: string; code?: string | null }>,
): string | null {
  const normalized = String(text ?? '').replace(/\s+/g, '')
  const others: string[] = []
  for (const course of courses) {
    if (course.id === selectedCourseId) continue
    const keys = [course.name ?? '', course.code ?? '']
    for (const key of keys) {
      const candidate = key.replace(/\s+/g, '')
      if (candidate.length >= 2 && normalized.includes(candidate)) {
        others.push(course.name || candidate)
        break
      }
    }
  }
  return others.length === 0 ? null : others.join('、')
}

/* ------------------------------------------------------------------ 参考时间与展示 */

/** 参考时间：带偏移的 ISO 或北京墙上时间；两者都非法时返回 `null`。 */
export function normalizeReference(value: unknown): Reference | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null

  const parsedOffset = parseOffsetIso(raw)
  if (parsedOffset) {
    const wallClock = isoToShanghaiWallClock(raw)
    const epochMs = isoToEpochMs(raw)
    const offsetIso = shanghaiWallClockToOffset(wallClock)
    if (!wallClock || epochMs === null || !offsetIso) return null
    return { wallClock: wallClock.slice(0, 16), offsetIso: offsetIso.slice(0, 19) + '+08:00', epochMs }
  }

  // 不带偏移：按**北京墙上时间**解释（与表单口径一致），绝不按手机本地时区解释。
  const offsetIso = shanghaiWallClockToOffset(raw)
  const epochMs = offsetIso ? isoToEpochMs(offsetIso) : null
  if (!offsetIso || epochMs === null) return null
  return { wallClock: raw.slice(0, 10) + 'T' + offsetIso.slice(11, 16), offsetIso: offsetIso.slice(0, 19) + '+08:00', epochMs }
}

/** 参考时间的北京时间自然日（`YYYY-MM-DD`）。 */
export function referenceDateKeyOf(value: unknown): string | null {
  const reference = normalizeReference(value)
  return reference ? isoToShanghaiDateKey(reference.offsetIso) : null
}

/** 北京时间可读标签 `YYYY-MM-DD HH:mm 周五`；非法返回空串。 */
export function labelOf(wallClock: string): string {
  const value = String(wallClock ?? '').trim()
  if (!value) return ''
  const deadline = shanghaiWallClockToOffset(value)
  if (!deadline) return ''
  const dateKey = deadline.slice(0, 10)
  const clock = deadline.slice(11, 16)
  const weekday = weekdayOfDateKey(dateKey)
  return `${dateKey} ${clock}${weekday ? ` ${weekdayName(weekday)}` : ''}`
}

/**
 * 建议的时间**是不是已经过去了**（基准 = 真实的当前时刻，不是通知参考时间）。
 *
 * 为什么两者都要有：通知参考时间可能是几天前发布通知的时间，用它算出来的「明天 18:00」
 * 在**参考时间**看来是将来的，但**现在**可能早就过了。助手只如实提示，
 * **绝不**悄悄换一个时间；参考时间本身也不会被冒充成「现在」。
 */
export function isAlreadyElapsed(wallClock: string, now: Date = new Date()): boolean {
  const deadline = shanghaiWallClockToOffset(wallClock)
  const epochMs = deadline ? isoToEpochMs(deadline) : null
  if (epochMs === null) return false
  return epochMs <= now.getTime()
}

function build(
  referenceAt: string,
  referenceWallClock: string,
  status: TimeAssistantStatus,
  message: string,
  hints: string[],
  candidates: TimeAssistantCandidate[] = [],
): TimeAssistantResult {
  return {
    status,
    message,
    hints,
    referenceAt,
    referenceWallClock,
    referenceLabel: labelOf(referenceWallClock),
    timeZone: TIME_ASSISTANT_ZONE,
    candidates,
  }
}

function dayNumberOf(dateKey: string): number | null {
  if (!isValidDateKey(dateKey)) return null
  return Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / 86_400_000)
}

function dateKeyAfter(dayNumber: number): string {
  return new Date(dayNumber * 86_400_000).toISOString().slice(0, 10)
}

/** `8:00` / `08:00` 统一补零成 `08:00`；非法返回空串（调用方会跳过）。 */
function normalizeClock(value: unknown): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim())
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${match[2]}`
}
