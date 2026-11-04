/**
 * 原生端「简短时间短语」解析器 —— 纯函数，无 React / 无网络 / 无系统时区依赖。
 *
 * 与 Web / 后端的 `backend/.../service/TimePhraseParser.java` **语义对齐**，但只保留原生端需要的核心：
 * 规则解析（不是大模型）、整句覆盖（不靠否定词黑名单）、信息不足就要求补全、绝不默认 23:59。
 *
 * 关键约定：
 * 1. 只接受**简短时间短语**（≤ 500 字），不解析整段通知；
 * 2. 日历语义固定：一周从**周一**开始，日期由调用方传入的**参考自然日**（北京时间）推导；
 * 3. **整句覆盖**：日期 / 时刻 token 之外的字符必须只是不改语义的包装词，
 *    因此 `明天18:000`、`下下周五18:00`、`明天18:00之后` 都会被保守拒绝，而不是截断后静默采用；
 * 4. 多个日期 / 多个时刻 / 只有日期 / 只有时刻 → 一律要求补全，**不取第一个**；
 * 5. 不带「本周 / 下周」的「周X」按本周理解；这一天本周已经过去时**不自动跳周**，而是要求写清楚；
 * 6. 支持的日历范围与 `datetime.ts` 一致：**1900–2199**；相对推演越界时如实要求改写，不编时间。
 */

import {
  addDaysToDateKey,
  isValidDateKey,
  mondayOfDateKey,
  weekdayName,
  weekdayOfDateKey,
  type Weekday,
} from './datetime'

/** 短语长度上限（与后端 / Web 端一致：空或超过就给可见校验，不进解析）。 */
export const TIME_PHRASE_MAX_LENGTH = 500

/** 支持解析的日历年份范围（与 `datetime.ts` 的 1900–2199 一致）。 */
export const TIME_PHRASE_MIN_YEAR = 1900
export const TIME_PHRASE_MAX_YEAR = 2199

export type PhraseOutcome = 'RESOLVED' | 'NEEDS_INFO' | 'UNSUPPORTED' | 'COURSE_WINDOW'

export type CourseWindowScope = 'DAY' | 'WEEK' | 'NEXT'

/** 一条解析出的时间（一律是**北京时间墙上时间**）。 */
export interface ResolvedTime {
  dateKey: string
  /** `HH:mm`。 */
  clock: string
  reason: string
  hints: string[]
}

/** 课表匹配窗口：`[startDateKey, endDateKeyExclusive)`（闭开区间，与后端一致）。 */
export interface CourseWindow {
  scope: CourseWindowScope
  startDateKey: string
  endDateKeyExclusive: string
  phrase: string
}

export interface ParsedPhrase {
  outcome: PhraseOutcome
  message: string
  hints: string[]
  times: ResolvedTime[]
  window: CourseWindow | null
  phrase: string | null
}

/* ------------------------------------------------------------------ 入口 */

/** 短语是否在长度上可用（空 / 超 500 字 → 可见校验，不进解析）。 */
export function phraseLengthError(rawText: unknown): string | null {
  const text = typeof rawText === 'string' ? rawText.trim() : ''
  if (text.length === 0) return '请先写一个简短的时间短语，例如「明天晚上8点」或「本周五 18:00」。'
  if (text.length > TIME_PHRASE_MAX_LENGTH) {
    return `时间短语最多 ${TIME_PHRASE_MAX_LENGTH} 字，现在有 ${text.length} 字：请只写一个时间点。`
  }
  return null
}

/**
 * 解析短语。
 *
 * @param rawText       用户输入的短语
 * @param referenceDate 参考时间对应的**北京时间自然日**（`YYYY-MM-DD`）；「今天 / 本周」以它为准
 */
export function parseTimePhrase(rawText: string, referenceDate: string): ParsedPhrase {
  const lengthError = phraseLengthError(rawText)
  if (lengthError) return needsInfo(lengthError)
  if (!isValidDateKey(referenceDate)) {
    return needsInfo('参考时间不是一个真实存在的日期（格式 YYYY-MM-DD），无法计算相对时间。')
  }

  const text = normalizePhrase(rawText)

  if (UNSAFE_COMPLEX.test(text)) {
    return unsupported(
      '这句话里有否定 / 延期 / 更改一类说法，时间助手只做时间换算：请直接写清楚目标时间（例如「下周五 18:00」）。',
      ['助手不处理「取消 / 延期 / 改到」这类复杂句。'],
    )
  }
  if (PAST_RELATIVE.test(text)) {
    return unsupported('「…以前」是相对过去的说法，助手只解析将来的明确时间：请写「今天 22:00」这样的明确写法。')
  }
  if (CALENDAR_DEPENDENT.test(text)) {
    return unsupported('这句话要靠校历（假期 / 开学 / 考试周）才能算，本机没有校历数据，助手不做推测。', [
      '可以改写成本周 / 下周 + 星期几，例如「下周五 18:00」。',
    ])
  }

  // -------------------- 课程边界说法 --------------------
  const broadCourseMatches = [...text.matchAll(COURSE_PHRASE_ANY_G)]
  const weekCourseMatch = COURSE_WINDOW_RE.exec(text)
  const nextClassMatch = weekCourseMatch ? null : NEXT_CLASS_RE.exec(text)

  if (broadCourseMatches.length >= 2) {
    return needsInfo('这句话里有多个「课前」条件（例如「…或…」「…和…」），助手不能只取第一个：请只保留一个条件。', [
      '例如只写「下周五上课前」。',
    ])
  }

  const exactMatch = weekCourseMatch ?? nextClassMatch
  if (exactMatch && exactMatch.index !== undefined) {
    const matched = exactMatch[0]
    const leftover = stripSpan(text, exactMatch.index, exactMatch.index + matched.length)
    if (hasConcreteDateOrTime(leftover)) {
      return needsInfo('同一句话里既有「课前」又有具体日期 / 时刻，无法确定以哪个为准：请只保留一种说法。', [
        '例如只写「下周五上课前」，或只写「下周五 18:00」。',
      ])
    }
    if (!isAllowedFiller(leftover)) {
      return needsInfo(
        `「${matched}」外面还有助手无法识别的内容「${leftover.trim()}」：请只保留一个「课前」短语（例如「下周五上课前」）。`,
        ['「课前两小时」「课前或…」这类修饰暂不支持，避免替你猜时间。'],
      )
    }
    if (weekCourseMatch) {
      const window = weekWindow(weekCourseMatch, referenceDate)
      if (!window) return needsInfo('「本周」剩下的时间里没有可算的日子：请改写成本周内的具体一天，或写明确时间。')
      return courseWindow(window, matched)
    }
    const end = addDaysToDateKey(referenceDate, MAX_LOOKAHEAD_DAYS)
    if (!end) return needsInfo('参考时间太靠近可支持范围的上限，无法向后推演 366 天：请换一个参考时间。')
    return courseWindow({ scope: 'NEXT', startDateKey: referenceDate, endDateKeyExclusive: end, phrase: matched }, matched)
  }

  if (broadCourseMatches.length >= 1 || BARE_COURSE_PHRASE.test(text)) {
    return needsInfo('带课程名或类型限定的「课前」说法暂不支持：请先明确选择那门课，或直接写明确时间（例如「下周五 18:00」）。', [
      '可以用的课前说法只有：「下节课前 / 下次课前 / 下次上课前 / 本周五上课前 / 下周这门课前」。',
      '「下次数学课前」「下周实验课前」这类限定不会替你猜是哪一节。',
    ])
  }

  // -------------------- 普通时间短语 --------------------
  for (const hint of GRANULARITY_HINTS) {
    if (hint.pattern.test(text)) return needsInfo(hint.message)
  }

  const dates = dedupeOverlappingDates(collectDates(text))
  const times = collectTimes(text)

  if (dates.length > 1) {
    return needsInfo(
      `这句话里有多个日期（${dates.map((token) => token.raw).join('、')}），助手不能只取第一个：请分开写，或只保留一个日期。`,
      ['一次只解析一个时间点。'],
    )
  }
  if (times.length > 1) {
    return needsInfo(
      `这句话里有多个时刻（${times.map((token) => token.raw).join('、')}），助手不能只取第一个：请分开写，或只保留一个时刻。`,
      ['一次只解析一个时间点。'],
    )
  }
  if (dates.length === 0 && times.length === 0) {
    if (WEEK_ONLY.test(text)) {
      return needsInfo('「下周 / 本周」还需要具体到某一天与时刻：请写「下周五 18:00」。', [
        '也可以写「下周五上课前」，助手会去课表里找那门课的下一节。',
      ])
    }
    return needsInfo(
      '没有认出可用的时间说法。助手支持：今天 / 明天 / 后天 / 本周X / 这周X / 下周X + 明确时刻，精确日期 YYYY-MM-DD HH:mm，以及「下节课前」这类课程说法。',
      ['示例：「明天 22:00」「本周五 18:00」「2026-10-20 23:00」「下周五上课前」。'],
    )
  }

  const firstDate = dates[0]
  const firstTime = times[0]
  if (!firstDate) {
    return needsInfo(`只有时刻「${firstTime?.raw ?? ''}」，没有日期：请补上哪一天（例如「明天 ${firstTime?.raw ?? ''}」）。`, [
      '助手不会默认按今天算，也不会补 23:59。',
    ])
  }
  if (!firstTime) {
    return needsInfo(`只有日期「${firstDate.raw}」，没有具体时刻：请补上几点几分（例如「${firstDate.raw} 22:00」）。`, [
      '助手不会默认按当天 23:59 处理。',
    ])
  }

  const leftover = stripSpans(text, [firstDate], [firstTime])
  if (!isAllowedFiller(leftover)) {
    return needsInfo(
      `这句话里还有助手无法识别的内容「${leftover.trim()}」：请只保留一个确定的时间点（例如「明天 18:00」）。`,
      ['不支持的写法（例如「之后」「开始」「18:000」）不会被截断后静默采用。'],
    )
  }

  const resolved = resolveDateTime(firstDate, firstTime, referenceDate, text)
  if (typeof resolved === 'string') return needsInfo(resolved)
  return {
    outcome: 'RESOLVED',
    message: '已解析出候选时间。',
    hints: resolved.hints,
    times: [resolved],
    window: null,
    phrase: null,
  }
}

/* ------------------------------------------------------------------ 课程窗口 */

/** 把「本周五上课前 / 下周三上课前 / 下周这门课前」翻译成检索窗口。 */
function weekWindow(match: RegExpExecArray, referenceDate: string): CourseWindow | null {
  const whole = match[0]
  const weekPrefix = match[1] ?? ''
  const afterWeek = whole.slice(weekPrefix.length)
  const dayChar = afterWeek.length > 0 && isWeekdayChar(afterWeek[0] as string) ? (afterWeek[0] as string) : null
  const nextWeek = weekPrefix.startsWith('下')
  const thisMonday = mondayOfDateKey(referenceDate)
  if (!thisMonday) return null
  const targetMonday = nextWeek ? addDaysToDateKey(thisMonday, 7) : thisMonday
  if (!targetMonday) return null

  if (dayChar) {
    const date = addDaysToDateKey(targetMonday, weekdayNumber(dayChar) - 1)
    if (!date) return null
    const end = addDaysToDateKey(date, 1)
    if (!end) return null
    return { scope: 'DAY', startDateKey: date, endDateKeyExclusive: end, phrase: whole }
  }
  if (nextWeek) {
    const end = addDaysToDateKey(targetMonday, 7)
    if (!end) return null
    return { scope: 'WEEK', startDateKey: targetMonday, endDateKeyExclusive: end, phrase: whole }
  }
  const end = addDaysToDateKey(thisMonday, 7)
  if (!end) return null
  return { scope: 'WEEK', startDateKey: referenceDate, endDateKeyExclusive: end, phrase: whole }
}

/* ------------------------------------------------------------------ 日期 / 时刻求解 */

function resolveDateTime(
  dateToken: DateToken,
  timeToken: TimeToken,
  referenceDate: string,
  text: string,
): ResolvedTime | string {
  const dateResult = resolveDate(dateToken, referenceDate)
  if (typeof dateResult === 'string') return dateResult
  const timeResult = resolveTime(timeToken)
  if (typeof timeResult === 'string') return timeResult

  const reason =
    `“${text}” → ${dateResult.dateKey}（${weekdayName(weekdayOfDateKey(dateResult.dateKey) ?? 1)}）` +
    `${timeResult.clock}（北京时间 +08:00）`
  return {
    dateKey: dateResult.dateKey,
    clock: timeResult.clock,
    reason,
    hints: [...dateResult.hints, ...timeResult.hints],
  }
}

function resolveDate(token: DateToken, referenceDate: string): { dateKey: string; hints: string[] } | string {
  switch (token.kind) {
    case 'ABS': {
      const dateKey = `${pad(token.year, 4)}-${pad(token.month)}-${pad(token.day)}`
      if (!isValidDateKey(dateKey)) return `日期不存在：「${token.raw}」，请核对后重写。`
      if (!isWithinSupportedYears(dateKey)) {
        return `「${token.raw}」超出支持的年份范围（${TIME_PHRASE_MIN_YEAR}–${TIME_PHRASE_MAX_YEAR} 年）：请换一个日期。`
      }
      return { dateKey, hints: [] }
    }
    case 'MONTH_DAY':
      return `「${token.raw}」只有月日没有年份，无法确定是哪一年：请写完整日期（例如 ${referenceDate.slice(0, 4)}-${pad(
        token.month,
      )}-${pad(token.day)}）。`
    case 'DAY_ONLY':
      return `「${token.raw}」只有几号：请写完整日期，或「明天 / 本周五」这样的写法。`
    case 'REL': {
      const offset = REL_DAY_OFFSETS[token.raw] ?? 0
      const dateKey = addDaysToDateKey(referenceDate, offset)
      if (!dateKey || !isWithinSupportedYears(dateKey)) {
        return `「${token.raw}」超出支持的年份范围（${TIME_PHRASE_MIN_YEAR}–${TIME_PHRASE_MAX_YEAR} 年）：请换一个参考时间或改写。`
      }
      return { dateKey, hints: [] }
    }
    case 'WEEKDAY': {
      const prefix = token.weekPrefix ?? ''
      const next = prefix.startsWith('下')
      const thisMonday = mondayOfDateKey(referenceDate)
      if (!thisMonday) return '参考日期无法定位到自然周：请检查参考时间。'
      const monday = next ? addDaysToDateKey(thisMonday, 7) : thisMonday
      if (!monday) return '「下周」超出了支持的时间范围：请改写或换一个参考时间。'
      const dateKey = addDaysToDateKey(monday, token.weekday - 1)
      if (!dateKey || !isWithinSupportedYears(dateKey)) {
        return `「${token.raw}」超出了支持的时间范围（${TIME_PHRASE_MIN_YEAR}–${TIME_PHRASE_MAX_YEAR} 年）：请改写。`
      }
      if (prefix.length === 0 && dateKey < referenceDate) {
        const label = weekdayName(token.weekday)
        return `「${label}」在本周已经过去，助手不会自动跳到下周：请写「下周${label.slice(1)}」或具体日期。`
      }
      const hints =
        prefix.length === 0
          ? [
              `没有写「本周 / 下周」，按本周的「${weekdayName(token.weekday)}」理解；已经过去的日子不会被自动跳到下周。`,
            ]
          : []
      return { dateKey, hints }
    }
    default:
      return `没有认出日期「${token.raw}」。`
  }
}

function resolveTime(token: TimeToken): { clock: string; hints: string[] } | string {
  let hour = token.hour
  const { minute } = token
  if (hour > 23 || minute > 59) {
    return `时刻不存在：「${token.raw}」（小时 0-23、分钟 0-59）。`
  }
  const prefix = token.prefix ?? ''
  const hints: string[] = []
  switch (prefix) {
    case '凌晨':
    case '早上':
    case '早晨':
    case '上午': {
      if (hour === 12) return `「${prefix}12点」是正午还是零点不明确：请写 12:00 或 00:00。`
      if (hour > 12) return `「${prefix}${hour}点」不是有效写法（${prefix}是上午）：请改写。`
      hints.push(`按「${prefix}」理解，解析为 ${pad(hour)}:${pad(minute)}。`)
      break
    }
    case '中午': {
      if (hour > 12) return `「中午${hour}点」不是有效写法：请写 12:00 或明确的 24 小时时刻。`
      if (hour >= 1 && hour <= 5) {
        hour += 12
        hints.push(`按口语习惯，把「中午${token.hour}点」理解为 ${pad(hour)}:${pad(minute)}。`)
      }
      break
    }
    case '下午':
    case '傍晚':
    case '晚上':
    case '今晚':
    case '明晚': {
      // 下午15点 / 凌晨12点 / 晚上12点 / 下午0点 一律因为「半日与时刻矛盾」拒绝，不猜。
      if (hour === 0) return `「${prefix}0点」含义不明确：请写 00:00。`
      if (hour === 12) return `「${prefix}12点」是正午还是午夜不明确：请写 12:00 或 00:00。`
      if (hour > 12) return `「${prefix}${hour}点」不是有效写法（${prefix}已经是下午）：请改写。`
      hour += 12
      break
    }
    default: {
      if (hour >= 1 && hour <= 11) {
        hints.push(
          `「${token.raw}」按 24 小时制理解为 ${pad(hour)}:${pad(minute)}；如果指下午，请写「下午${token.raw}」或「${hour + 12}:${pad(minute)}」。`,
        )
      }
      break
    }
  }
  return { clock: `${pad(hour)}:${pad(minute)}`, hints }
}

/* ------------------------------------------------------------------ 词法收集 */

type DateKind = 'ABS' | 'MONTH_DAY' | 'DAY_ONLY' | 'REL' | 'WEEKDAY'

interface DateToken {
  start: number
  end: number
  raw: string
  kind: DateKind
  year: number
  month: number
  day: number
  weekPrefix: string | null
  weekday: Weekday
}

interface TimeToken {
  start: number
  end: number
  raw: string
  prefix: string | null
  hour: number
  minute: number
}

const REL_DAY_OFFSETS: Record<string, number> = {
  今天: 0,
  今日: 0,
  今晚: 0,
  明天: 1,
  明日: 1,
  明晚: 1,
  后天: 2,
  后日: 2,
  大后天: 3,
}

function collectDates(text: string): DateToken[] {
  const tokens: DateToken[] = []
  for (const match of text.matchAll(ABS_DATE_G)) {
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      kind: 'ABS',
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      weekPrefix: null,
      weekday: 1,
    })
  }
  for (const match of text.matchAll(MONTH_DAY_G)) {
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      kind: 'MONTH_DAY',
      year: 0,
      month: Number(match[1]),
      day: Number(match[2]),
      weekPrefix: null,
      weekday: 1,
    })
  }
  for (const match of text.matchAll(DAY_ONLY_G)) {
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      kind: 'DAY_ONLY',
      year: 0,
      month: 0,
      day: Number(match[1]),
      weekPrefix: null,
      weekday: 1,
    })
  }
  for (const match of text.matchAll(REL_DAY_G)) {
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      kind: 'REL',
      year: 0,
      month: 0,
      day: 0,
      weekPrefix: null,
      weekday: 1,
    })
  }
  for (const match of text.matchAll(WEEKDAY_G)) {
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      kind: 'WEEKDAY',
      year: 0,
      month: 0,
      day: 0,
      weekPrefix: match[1] ?? null,
      weekday: weekdayNumber(match[2] ?? '一'),
    })
  }
  return tokens
}

function collectTimes(text: string): TimeToken[] {
  const tokens: TimeToken[] = []
  for (const match of text.matchAll(TIME_G)) {
    const groups = match.groups ?? {}
    let minute = 0
    if (groups.cm !== undefined) minute = Number(groups.cm)
    else if (groups.half !== undefined) {
      minute = groups.half === '半' ? 30 : groups.half === '一刻' ? 15 : groups.half === '三刻' ? 45 : 0
    } else if (groups.nm !== undefined) minute = Number(groups.nm)
    tokens.push({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      raw: match[0],
      prefix: groups.prefix ?? null,
      hour: Number(groups.h ?? 0),
      minute,
    })
  }
  return tokens
}

/** 丢掉被更长匹配完全包住的短匹配（`2026年10月8日` 里不再单独算一次 `10月8日` / `8日`）。 */
function dedupeOverlappingDates(tokens: DateToken[]): DateToken[] {
  const sorted = [...tokens].sort((left, right) => left.start - right.start || right.end - left.end)
  const kept: DateToken[] = []
  for (const token of sorted) {
    const covered = kept.some((other) => token.start >= other.start && token.end <= other.end)
    if (!covered) kept.push(token)
  }
  return kept.sort((left, right) => left.start - right.start)
}

/* ------------------------------------------------------------------ 全句覆盖 */

function stripSpan(text: string, start: number, end: number): string {
  return text.slice(0, start) + text.slice(end)
}

/**
 * 依次移除全部日期 / 时刻片段，返回剩余文本。
 *
 * **必须先合并重叠片段**：`今晚8点` 的日期 token 是 `今晚`、时刻 token 是 `今晚8点`
 * （时刻 token 带半日前缀，从同一个下标开始），逐个删会把 `8点` 留在句子里被误判成无法识别的内容。
 */
function stripSpans(text: string, dates: DateToken[], times: TimeToken[]): string {
  const spans = [
    ...dates.map((token) => ({ start: token.start, end: token.end })),
    ...times.map((token) => ({ start: token.start, end: token.end })),
  ]
    .filter((span) => span.start >= 0 && span.end <= text.length && span.start < span.end)
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const merged: Array<{ start: number; end: number }> = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
    } else {
      merged.push({ ...span })
    }
  }

  let out = ''
  let cursor = 0
  for (const span of merged) {
    out += text.slice(cursor, span.start)
    cursor = span.end
  }
  return out + text.slice(cursor)
}

/** 剩余文本里是否还有「具体日期 / 时刻」（课程短语外面不允许再写一个明确时间）。 */
function hasConcreteDateOrTime(text: string): boolean {
  if (TEXT_CONTAINS_TIME.test(text)) return true
  if (ABS_DATE_G.test(text) || MONTH_DAY_G.test(text) || DAY_ONLY_G.test(text) || REL_DAY_G.test(text)) return true
  return false
}

/**
 * 剩余文本是否只是允许的包装词（空白 / 标点 / 前 / 之前 / 截止 / 提交…）。
 * 任何未定义字符都会让整句被保守拒绝。
 */
function isAllowedFiller(leftover: string): boolean {
  if (leftover.length === 0) return true
  let stripped = leftover.replace(FILLER_PUNCT_G, '')
  let previous: string
  do {
    previous = stripped
    stripped = stripped.replace(FILLER_TOKENS_G, '')
  } while (stripped !== previous)
  return stripped.length === 0
}

/* ------------------------------------------------------------------ 小工具 */

/** 全角数字 / 全角冒号 / 全角空格 / 全角斜杠归一化；不改动任何文字内容。 */
export function normalizePhrase(rawText: string): string {
  let out = ''
  for (const ch of String(rawText ?? '').trim()) {
    if (ch >= '０' && ch <= '９') out += String.fromCharCode('0'.charCodeAt(0) + (ch.charCodeAt(0) - '０'.charCodeAt(0)))
    else if (ch === '：') out += ':'
    else if (ch === '　') out += ' '
    else if (ch === '／') out += '/'
    else out += ch
  }
  return out.trim()
}

function isWithinSupportedYears(dateKey: string): boolean {
  if (!isValidDateKey(dateKey)) return false
  const year = Number(dateKey.slice(0, 4))
  return year >= TIME_PHRASE_MIN_YEAR && year <= TIME_PHRASE_MAX_YEAR
}

function isWeekdayChar(ch: string): boolean {
  return (ch >= '一' && ch <= '六') || ch === '日' || ch === '天' || (ch >= '1' && ch <= '7')
}

function weekdayNumber(value: string): Weekday {
  switch (value) {
    case '一':
    case '1':
      return 1
    case '二':
    case '2':
      return 2
    case '三':
    case '3':
      return 3
    case '四':
    case '4':
      return 4
    case '五':
    case '5':
      return 5
    case '六':
    case '6':
      return 6
    default:
      return 7
  }
}

export function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

function needsInfo(message: string, hints: string[] = []): ParsedPhrase {
  return { outcome: 'NEEDS_INFO', message, hints, times: [], window: null, phrase: null }
}

function unsupported(message: string, hints: string[] = []): ParsedPhrase {
  return { outcome: 'UNSUPPORTED', message, hints, times: [], window: null, phrase: null }
}

function courseWindow(window: CourseWindow, phrase: string): ParsedPhrase {
  return { outcome: 'COURSE_WINDOW', message: '按课程边界解析。', hints: [], times: [], window, phrase }
}

/* ------------------------------------------------------------------ 词法模式 */

const MERIDIEM = '凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚'

/** 「下节课前」最多向后找 366 天（超出范围不越界去更远找）。 */
export const MAX_LOOKAHEAD_DAYS = 366

/** 否定 / 延期 / 更改：保守拒绝，不猜。 */
const UNSAFE_COMPLEX = /取消|不用|不需要|不必|无需|勿|别交|延期|推迟|延后|改期|更改|改成|改为|改到|不是|并非|过期|算了|不交|不做|不参加|没有确定|未定|待定|待确认|不确定/

/** 「三天以前 / 两周之前」这类相对过去的说法。 */
const PAST_RELATIVE = /[0-9一二三四五六七八九十两]\s*(?:天|日|周|星期|个?月|年)\s*(?:以前|之前)/

/** 需要校历才能算的说法。 */
const CALENDAR_DEPENDENT = /国庆|寒假|暑假|开学|期末周|考试周|校历|放假|节假日|假期|调休/

interface GranularityHint {
  pattern: RegExp
  message: string
}

const GRANULARITY_HINTS: GranularityHint[] = [
  {
    pattern: /尽快|随时|有空|抽空|稍后|以后|接下来/,
    message: '「尽快 / 随时 / 以后」不是确定时刻：请写明确的一天与时刻（例如「明天 18:00」）。',
  },
  {
    pattern: /每(?:天|日|周|星期|月|年)/,
    message: '这是重复发生的时间，不是一次性的截止时间：请写具体哪一天（例如「本周五 18:00」）。',
  },
  { pattern: /周末/, message: '「周末」是一整段范围：请具体到周六或周日（例如「本周六 12:00」）。' },
  {
    pattern: /月底|月初|中旬|上旬|下旬|下个月|下月|本月|这个月/,
    message: '这是「月」级别的范围：请具体到某一天与时刻（例如「10 月 20 日 22:00」）。',
  },
]

/** 精确支持的**周限定**课程短语：本周 / 这周 / 下周 + 可选星期 + 可选这门 + 上课前。 */
const COURSE_WINDOW_RE =
  /(本周|这周|下周|下个星期|本星期|这个星期|这星期)(?:[一二三四五六日天1-7])?(?:这|那)?门?(?:的)?(?:上)?课(?:之)?前/

/** 精确支持的**次 / 节限定**课程短语：下节课前 / 下次课前 / 下次上课前 / 下一节课之前。 */
const NEXT_CLASS_RE = /下(?:一)?(?:次|节)(?:的)?(?:上)?课(?:之)?前/

/** 宽口径「课前」探测：只用于计数与提示，绝不用于产出候选。 */
const COURSE_PHRASE_ANY_G =
  /(?:下(?:一)?(?:次|节)|(?:本|这|下)(?:个)?(?:周|星期))[^，,。；;！？、\s]{0,8}?(?:上课|上机|实验|课)(?:之)?前/g

/** 连「下 / 本 / 这」都没有的「课前」。 */
const BARE_COURSE_PHRASE = /(?:上)?课(?:之)?前/

const ABS_DATE_G = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g
const MONTH_DAY_G = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g
const DAY_ONLY_G = /(\d{1,2})\s*[日号]/g
const REL_DAY_G = /大后天|今天|今日|今晚|明天|明日|明晚|后天|后日/g
const WEEKDAY_G = /(下个|这个|本|这|下)?(?:周|星期)([一二三四五六日天1-7])/g
const WEEK_ONLY = /下周|下个星期|本周|这周|本星期|这个星期|这星期/

/** 时刻：`22:00`、`22点`、`22点30`、`晚上8点`、`下午3点半`。 */
const TIME_G = new RegExp(
  `(?:(?<prefix>${MERIDIEM})\\s*)?(?<h>\\d{1,2})\\s*(?:(?<colon>:)\\s*(?<cm>\\d{1,2})|(?<cn>[点时])(?:(?<half>半|一刻|三刻)|(?<nm>\\d{1,2})\\s*分?)?)`,
  'g',
)

/** 与 `TIME_G` 同源的无状态探测版（只判断「有没有时刻」）。 */
const TEXT_CONTAINS_TIME = new RegExp(
  `(?:${MERIDIEM})?\\s*\\d{1,2}\\s*(?::\\s*\\d{1,2}|[点时](?:半|一刻|三刻|\\d{1,2}\\s*分?)?)`,
)

const FILLER_TOKENS_G = /之前|截止|截至|提交到|提交|上交|上传|发送|完成|需要|务必|请在|请于|请|于|在|的|要|需|前|交|到|至|和|及|与|给/g
/** 包装词之间允许的空白与标点（`T` 也放进来，这样 `2026-10-20T23:00` 与空格写法等价）。 */
const FILLER_PUNCT_G = /[\sT，,。；;、:：~～\-—()（）[\]【】"'\u2018\u2019\u201C\u201D]+/g
