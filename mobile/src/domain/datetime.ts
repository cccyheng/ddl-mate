/**
 * 业务时区（Asia/Shanghai）日期时间工具 —— 纯函数，无 React Native 依赖，可在 node 下直接测试。
 *
 * 契约（与 Web 端 `frontend/src/utils/datetime.js` 一致，由后端 `Asia/Shanghai` 语义定义）：
 * - 用户在表单里填写的是**北京时间墙上时间**（`YYYY-MM-DDTHH:mm`），与手机系统时区无关；
 *   手机在 UTC 还是纽约，都把 `2026-10-15T22:00` 解释为北京时间 22:00。
 * - 入库统一存**带显式偏移的字符串**（`2026-10-15T22:00:00+08:00`），
 *   查询与分组用「+08:00 那一侧」的墙上时间，绝不经过手机本地时区。
 * - `Asia/Shanghai` 自 1991 年起恒为 UTC+8、无夏令时，因此用固定 +480 分钟换算；
 *   展示层仍优先用 `Intl` 的显式 `timeZone`，保证跨运行环境一致。
 */

export const SHANGHAI_ZONE = 'Asia/Shanghai'
export const SHANGHAI_OFFSET_MINUTES = 480

const SHANGHAI_OFFSET_SUFFIX = '+08:00'

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
const OFFSET_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 严格闰年判定（不用 Date 兜底，避免 2026-02-30 被静默滚动到 3 月）。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** 某年某月的真实天数（month 为 1-12）。月份非法返回 0。 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0
  if (month === 2 && isLeapYear(year)) return 29
  return DAYS_IN_MONTH[month - 1] ?? 0
}

export interface WallClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** 真实存在的日历日期（拒绝 2026-02-30 / 2027-02-29 / 月份 13 等）。 */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1900 || year > 2199) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  return true
}

/** 解析北京时间墙上时间 `YYYY-MM-DDTHH:mm[:ss]`；非法（含不存在的日期/时刻）返回 null。 */
export function parseWallClock(value: unknown): WallClockParts | null {
  const match = WALL_CLOCK_RE.exec(String(value ?? '').trim())
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = s ? Number(s) : 0
  if (!isValidCalendarDate(year, month, day)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null
  return { year, month, day, hour, minute, second }
}

/** 是否是合法的北京时间墙上时间。 */
export function isValidShanghaiWallClock(value: unknown): boolean {
  return parseWallClock(value) !== null
}

/** 是否是合法的 `YYYY-MM-DD` 真实日期。 */
export function isValidDateKey(value: unknown): boolean {
  const match = DATE_ONLY_RE.exec(String(value ?? '').trim())
  if (!match) return false
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))
}

/**
 * 北京时间墙上时间 → 带 `+08:00` 偏移的 ISO 字符串（入库格式）。
 * 非法输入返回 null，绝不硬凑一个时间。
 */
export function shanghaiWallClockToOffset(value: unknown): string | null {
  const parts = parseWallClock(value)
  if (!parts) return null
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}${SHANGHAI_OFFSET_SUFFIX}`
  )
}

export interface OffsetIsoParts extends WallClockParts {
  /** 原始字符串里的偏移，单位分钟（`Z` 记 0）。 */
  offsetMinutes: number
  /** 小数秒折算的毫秒（`.500` → `500`）；没有小数部分时为 0。 */
  milliseconds: number
}

/**
 * 解析带偏移的 ISO（`2026-10-15T22:00:00+08:00` / `...Z` / `...00.500Z`）。
 *
 * **偏移必须真实存在**：小时 `00–14`、分钟 `00–59`。
 * 像 `+99:99` 这种「格式对得上正则、现实里不存在」的偏移一律返回 `null`
 * —— 否则它会算出一个看似正常的时刻，把脏数据伪装成真实的 DDL。
 * 小数秒会被保留（毫秒），因为「同一秒内谁先谁后」在逾期边界上是真实存在的。
 *
 * 多于 3 位的小数**按毫秒截断**（ISO 8601 / JS `Date` 的 epoch 毫秒口径）：
 * `.1235` → `123`、`.9999` → `999`、`.0009` → `0`。
 * 这里刻意**不做四舍五入，也不拒绝**：`.9999` 如果被舍入成 `1000` 就等于「进位到下一秒」，
 * 会让一个合法时间被当成非法（或悄悄改掉一秒），而它本来只是比 `.999` 多写了几个数字。
 */
export function parseOffsetIso(value: unknown): OffsetIsoParts | null {
  const raw = String(value ?? '').trim()
  const match = OFFSET_ISO_RE.exec(raw)
  if (!match) return null
  const [, y, mo, d, h, mi, s, fraction, zone] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h)
  const minute = Number(mi)
  const second = s ? Number(s) : 0
  if (!isValidCalendarDate(year, month, day)) return null
  if (hour > 23 || minute > 59 || second > 59) return null
  if (zone === undefined) return null
  // 取前三位（不足三位补零），多余的小数位直接丢掉 —— 不四舍五入、不进位。
  const milliseconds = fraction ? Number(`${fraction}000`.slice(0, 3)) : 0
  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 999) return null
  let offsetMinutes: number
  if (zone === 'Z') {
    offsetMinutes = 0
  } else {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offsetHours = Number(digits.slice(0, 2))
    const offsetRemainder = Number(digits.slice(2, 4))
    // 真实存在的偏移范围：-14:00 .. +14:00，分钟部分 0–59
    // （`+14:01` 不是任何一个真实时区，必须拒绝）。
    if (!Number.isInteger(offsetHours) || !Number.isInteger(offsetRemainder)) return null
    if (offsetHours > 14 || offsetRemainder > 59) return null
    if (offsetHours === 14 && offsetRemainder !== 0) return null
    offsetMinutes = sign * (offsetHours * 60 + offsetRemainder)
  }
  return { year, month, day, hour, minute, second, offsetMinutes, milliseconds }
}

const OFFSET_MINUTES_CACHE = new Map<number, Intl.DateTimeFormat>()

function shanghaiFormatter(): Intl.DateTimeFormat {
  const cached = OFFSET_MINUTES_CACHE.get(1)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  })
  OFFSET_MINUTES_CACHE.set(1, formatter)
  return formatter
}

/**
 * 带偏移的 ISO → 北京时间墙上时间各部分。
 *
 * 优先用 `Intl` 的显式 `timeZone`；运行环境缺少该时区数据时回退到固定 +8 换算，
 * 两条路径对 Asia/Shanghai 结果相同。
 */
export function offsetIsoToShanghaiParts(value: unknown): WallClockParts | null {
  const parsed = parseOffsetIso(value)
  if (!parsed) return null
  const utcMs = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hour,
    parsed.minute,
    parsed.second,
  ) - parsed.offsetMinutes * 60_000
  try {
    const parts: Record<string, string> = {}
    for (const part of shanghaiFormatter().formatToParts(new Date(utcMs))) {
      parts[part.type] = part.value
    }
    const year = Number(parts.year)
    const month = Number(parts.month)
    const day = Number(parts.day)
    const hour = Number(parts.hour) % 24
    const minute = Number(parts.minute)
    if (isValidCalendarDate(year, month, day)) {
      return { year, month, day, hour, minute, second: parsed.second }
    }
  } catch {
    // 回退到固定偏移
  }
  const shifted = new Date(utcMs + SHANGHAI_OFFSET_MINUTES * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/**
 * 只记到日期的 DDL（`YYYY-MM-DD`，且必须是真实存在的日期）。
 *
 * 这是**任务截止时间**独有的第二种合法精度，不是时间戳：它表示「这一天结束前」，
 * 不表示 00:00，也不表示 23:59。通用的 `parseOffsetIso` / `isoToEpochMs` 仍然只认
 * 带偏移的时间戳，不会被这里放宽 —— 需要处理 DDL 的调用方请使用本文件里的
 * `deadline*` 辅助函数。
 */
export function isDateOnlyDeadline(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  return DATE_ONLY_RE.test(raw) && isValidDateKey(raw)
}

/**
 * DDL → 北京时间自然日。
 *
 * - 裸日期原样返回；
 * - 带偏移 ISO 按 +08:00 一侧取日期（与 `isoToShanghaiDateKey` 一致）。
 */
export function deadlineToShanghaiDateKey(value: unknown): string {
  if (isDateOnlyDeadline(value)) return String(value).trim()
  return isoToShanghaiDateKey(value)
}

/** DDL → 北京时间 `HH:mm`；只记到日期时返回空串（不编造 00:00）。 */
export function deadlineToShanghaiClock(value: unknown): string {
  if (isDateOnlyDeadline(value)) return ''
  return isoToShanghaiClock(value)
}

/**
 * DDL → 表单初值文本。
 *
 * - 裸日期原样返回（重新打开时时间框保持空白）；
 * - 带偏移 ISO 转成北京时间墙上时间 `YYYY-MM-DDTHH:mm`。
 *
 * 刻意与通用的 `isoToShanghaiWallClock` 分开：后者仍只接受时间戳，
 * 不会因为 DDL 新增了「只到日期」的精度而被悄悄放宽。
 */
export function deadlineToShanghaiWallClock(value: unknown): string {
  if (isDateOnlyDeadline(value)) return String(value).trim()
  return isoToShanghaiWallClock(value)
}

/**
 * DDL → 用于比较 / 逾期判断的 epoch 毫秒。
 *
 * 只到日期的 DDL 取**次日 00:00（北京时间）**作为边界：这一天还没结束都不算逾期，
 * 跨过零点才算。精确到分钟的 DDL 保持原来的真实时刻，不改变既有语义。
 */
export function deadlineToEpochMs(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (!isDateOnlyDeadline(raw)) return isoToEpochMs(raw)
  const nextDay = addDaysToDateKey(raw, 1)
  if (!nextDay) return null
  const epoch = Date.parse(`${nextDay}T00:00:00+08:00`)
  return Number.isFinite(epoch) ? epoch : null
}

/**
 * 这条 DDL 在 `now` 时是否已经逾期。
 *
 * - 精确时间：到点那一刻不算逾期（保持既有 `<` 语义）；
 * - 只到日期：当天结束（次日 00:00）即算逾期，不再多等一毫秒。
 */
export function isDeadlineOverdue(value: unknown, now: Date | number = new Date()): boolean {
  const target = deadlineToEpochMs(value)
  if (target === null) return false
  const nowMs = typeof now === 'number' ? now : now.getTime()
  if (!Number.isFinite(nowMs)) return false
  return isDateOnlyDeadline(value) ? target <= nowMs : target < nowMs
}

/** 带偏移的 ISO → 北京时间墙上时间 `YYYY-MM-DDTHH:mm`（表单初值格式）。 */
export function isoToShanghaiWallClock(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (!OFFSET_ISO_RE.test(raw)) {
    const bare = parseWallClock(raw)
    return bare
      ? `${bare.year}-${pad2(bare.month)}-${pad2(bare.day)}T${pad2(bare.hour)}:${pad2(bare.minute)}`
      : ''
  }
  const parts = offsetIsoToShanghaiParts(raw)
  if (!parts) return ''
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`
}

/** 带偏移的 ISO → 北京时间自然日 `YYYY-MM-DD`（日历分组用，不受手机时区影响）。 */
export function isoToShanghaiDateKey(value: unknown): string {
  const parts = offsetIsoToShanghaiParts(value)
  if (!parts) return ''
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/** 带偏移的 ISO → 北京时间 `HH:mm`。 */
export function isoToShanghaiClock(value: unknown): string {
  const parts = offsetIsoToShanghaiParts(value)
  if (!parts) return ''
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`
}

/**
 * 带偏移的 ISO → epoch 毫秒（排序与**逾期边界比较**用）。
 *
 * 两处刻意的严格性（都是复核点名的真实缺陷）：
 * - **偏移必须真实存在**（`+99:99` 这种直接返回 `null`，由调用方归入「需要修复」，
 *   绝不伪装成一个过去的时刻）；
 * - **保留小数秒**：`...10:00:00.500Z` 与 `...10:00:00.250Z` 谁在前是分得清的。
 */
export function isoToEpochMs(value: unknown): number | null {
  const parsed = parseOffsetIso(value)
  if (!parsed) return null
  return (
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsed.hour,
      parsed.minute,
      parsed.second,
      parsed.milliseconds,
    ) -
    parsed.offsetMinutes * 60_000
  )
}

/** 现在的北京时间墙上时间（`YYYY-MM-DDTHH:mm`）。 */
export function shanghaiNowWallClock(now: Date = new Date()): string {
  const parts = offsetIsoToShanghaiParts(now.toISOString())
  if (!parts) return ''
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`
}

/** 现在的北京时间自然日 `YYYY-MM-DD`。 */
export function shanghaiToday(now: Date = new Date()): string {
  return isoToShanghaiDateKey(now.toISOString())
}

/** `YYYY-MM-DD` → 距 1970-01-01 的天数（纯日历运算，不经时区）。 */
export function dateKeyToDayNumber(dateKey: string): number | null {
  if (!isValidDateKey(dateKey)) return null
  const match = DATE_ONLY_RE.exec(dateKey.trim())
  if (!match) return null
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000)
}

/** 天数（1970-01-01 起） → `YYYY-MM-DD`。 */
export function dayNumberToDateKey(dayNumber: number): string {
  const date = new Date(dayNumber * 86_400_000)
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** `dateKey` 加减天数。 */
export function addDaysToDateKey(dateKey: string, days: number): string | null {
  const dayNumber = dateKeyToDayNumber(dateKey)
  if (dayNumber === null) return null
  return dayNumberToDateKey(dayNumber + days)
}

/** 周一 = 1 … 周日 = 7。 */
export function weekdayOfDateKey(dateKey: string): Weekday | null {
  const dayNumber = dateKeyToDayNumber(dateKey)
  if (dayNumber === null) return null
  // 1970-01-01 是周四（4）
  const iso = (((dayNumber + 3) % 7) + 7) % 7
  return (iso + 1) as Weekday
}

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday - 1] ?? '未知'
}

/** 某个 `YYYY-MM-DD` 是星期几的中文名（`周一`…`周日`）；日期非法返回 `null`。 */
export function teachingWeekdayName(dateKey: string): string | null {
  const weekday = weekdayOfDateKey(dateKey)
  return weekday === null ? null : weekdayName(weekday)
}

export const weekdayOptions: ReadonlyArray<{ value: Weekday; label: string }> = WEEKDAY_NAMES.map(
  (label, index) => ({ value: (index + 1) as Weekday, label }),
)

/** 该日期所在自然周的周一（业务周从周一开始）。 */
export function mondayOfDateKey(dateKey: string): string | null {
  const weekday = weekdayOfDateKey(dateKey)
  if (weekday === null) return null
  return addDaysToDateKey(dateKey, -(weekday - 1))
}

/** 该日期是否是周一。 */
export function isMonday(dateKey: string): boolean {
  return weekdayOfDateKey(dateKey) === 1
}

/**
 * 北京时间可读标签，例如 `2026-10-15 22:00 周四`。
 *
 * 只记到日期的 DDL 显示为 `2026-10-15 周四`：**不带** `00:00` / `23:59`
 * 这类用户没填过的时刻。通用时间戳标签（创建 / 修改 / 完成时间）不受影响。
 */
export function shanghaiDeadlineLabel(value: unknown): string {
  const raw = String(value ?? '').trim()
  if (isDateOnlyDeadline(raw)) {
    const weekday = weekdayOfDateKey(raw)
    return `${raw} ${weekday ? weekdayName(weekday) : ''}`.trim()
  }
  const wallClock = isoToShanghaiWallClock(value)
  if (!wallClock) return String(value ?? '')
  const dateKey = wallClock.slice(0, 10)
  const weekday = weekdayOfDateKey(dateKey)
  return `${dateKey} ${wallClock.slice(11, 16)} ${weekday ? weekdayName(weekday) : ''}`.trim()
}

export interface RemainingInfo {
  text: string
  tone: 'muted' | 'warn' | 'danger' | 'success'
  overdue: boolean
  hours: number | null
}

/**
 * 距离截止的剩余时间描述（基准为传入的 now，便于测试固定时间）。
 *
 * 只记到日期的 DDL 用「今天截止 / 剩余 N 天 / 已过截止日期」表达，
 * 不会编出一个 `剩余 1 小时` 之类的精确倒计时。
 */
export function remainingLabel(deadline: unknown, now: Date = new Date()): RemainingInfo {
  const raw = String(deadline ?? '').trim()
  if (isDateOnlyDeadline(raw)) {
    const today = shanghaiToday(now)
    if (raw < today) return { text: '已过截止日期', tone: 'danger', overdue: true, hours: null }
    if (raw === today) return { text: '今天截止', tone: 'warn', overdue: false, hours: null }
    const targetDay = dateKeyToDayNumber(raw)
    const todayDay = dateKeyToDayNumber(today)
    if (targetDay === null || todayDay === null) {
      return { text: '未设置 DDL', tone: 'muted', overdue: false, hours: null }
    }
    const days = targetDay - todayDay
    return { text: `剩余 ${days} 天`, tone: days <= 3 ? 'warn' : 'muted', overdue: false, hours: null }
  }
  const target = isoToEpochMs(deadline)
  if (target === null) return { text: '未设置 DDL', tone: 'muted', overdue: false, hours: null }
  const diffMs = target - now.getTime()
  const hours = diffMs / 3_600_000
  if (diffMs < 0) {
    const overdueHours = Math.abs(hours)
    const text =
      overdueHours < 24
        ? `已逾期 ${Math.max(1, Math.round(overdueHours))} 小时`
        : `已逾期 ${Math.floor(overdueHours / 24)} 天`
    return { text, tone: 'danger', overdue: true, hours }
  }
  if (hours < 1) return { text: `剩余 ${Math.max(1, Math.round(hours * 60))} 分钟`, tone: 'danger', overdue: false, hours }
  if (hours < 24) return { text: `剩余 ${Math.round(hours)} 小时`, tone: 'warn', overdue: false, hours }
  const days = Math.floor(hours / 24)
  return { text: `剩余 ${days} 天`, tone: days <= 3 ? 'warn' : 'muted', overdue: false, hours }
}

/**
 * 排序用的稳定比较：有 DDL 的按时间升序，无 DDL 的排最后。
 *
 * 只记到日期的 DDL 按「当天结束」排序，因此同一天的精确时刻会排在它前面，
 * 次日的任务仍然排在它后面。
 */
export function compareByDeadline<T extends { deadline: string | null }>(a: T, b: T): number {
  const left = deadlineToEpochMs(a.deadline)
  const right = deadlineToEpochMs(b.deadline)
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left - right
}
