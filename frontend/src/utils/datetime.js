/**
 * 时间展示工具。
 *
 * 后端返回的时间是带偏移量的 ISO 字符串（例如 2026-10-15T10:10:00+08:00），
 * 浏览器会自动转成用户本机时区展示；业务时区固定为 Asia/Shanghai 时数值一致。
 */

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_ONLY = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const TIME_ONLY = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDateTime(value) {
  if (!value) return '未设置'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return DATE_TIME.format(date).replace(/\//g, '-')
}

export function formatDate(value) {
  if (!value) return '未设置'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return DATE_ONLY.format(date).replace(/\//g, '-')
}

/** 课表的 "HH:mm:ss" 本地时间，直接截断展示。 */
export function formatClock(value) {
  if (!value) return ''
  const parts = String(value).split(':')
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : String(value)
}

export function formatTimeOfDay(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return TIME_ONLY.format(date)
}

/** 把 Date/ISO 转成 input[type=datetime-local] 需要的本地字符串。 */
export function toDatetimeLocal(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`
}

/**
 * 把 datetime-local 的值（本地时间）转成带 +08:00 偏移的 ISO 字符串。
 * 不传偏移量时后端按业务时区解释，但显式带偏移量最清晰。
 *
 * 注意：这是给**通用表单**用的（按运行电脑时区补偏移）。通知导入的截止时间固定按
 * 上海墙上时间处理，请用下面的 toShanghaiWallClock / fromShanghaiWallClock。
 */
export function fromDatetimeLocal(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/**
 * 业务时区（Asia/Shanghai）的墙上时间 ↔ input[type=datetime-local] 的值。
 *
 * 候选里的 deadline 一律是**不带偏移**的上海墙上时间（`2026-10-15T22:00`），
 * 所以这里绝不能经过 `new Date(...)`：在 UTC 浏览器里那会把 22:00 变成 14:00。
 * 这两种转换对格式只做字符串级处理，因此在任何运行电脑时区下结果都一致。
 */
export function toShanghaiWallClock(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/)
  return match ? `${match[1]}T${match[2]}` : ''
}

/** datetime-local 的值（用户按上海墙上时间填的）→ 候选用的无偏移字符串。 */
export function fromShanghaiWallClock(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/)
  return match ? `${match[1]}T${match[2]}` : ''
}

/** 距离 DDL 的剩余时间描述。 */
export function remainingLabel(deadline) {
  if (!deadline) return { text: '未设置 DDL', tone: 'muted', overdue: false, hours: null }
  const target = new Date(deadline).getTime()
  if (Number.isNaN(target)) return { text: '时间未知', tone: 'muted', overdue: false, hours: null }
  const diffMs = target - Date.now()
  const hours = diffMs / 36e5
  if (diffMs < 0) {
    const overdueHours = Math.abs(hours)
    const text = overdueHours < 24 ? `已逾期 ${Math.round(overdueHours)} 小时` : `已逾期 ${Math.floor(overdueHours / 24)} 天`
    return { text, tone: 'danger', overdue: true, hours }
  }
  if (hours < 1) return { text: `剩余 ${Math.max(1, Math.round(hours * 60))} 分钟`, tone: 'danger', overdue: false, hours }
  if (hours < 24) return { text: `剩余 ${Math.round(hours)} 小时`, tone: 'warn', overdue: false, hours }
  const days = Math.floor(hours / 24)
  if (days <= 3) return { text: `剩余 ${days} 天`, tone: 'warn', overdue: false, hours }
  return { text: `剩余 ${days} 天`, tone: 'muted', overdue: false, hours }
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export function weekdayName(weekday) {
  const index = Number(weekday) - 1
  return WEEKDAY_NAMES[index] || '未知'
}

export const weekdayOptions = WEEKDAY_NAMES.map((label, index) => ({ value: index + 1, label }))

export function toDateKey(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function greeting() {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function todayLabel() {
  const now = new Date()
  const weekday = WEEKDAY_NAMES[(now.getDay() + 6) % 7]
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${weekday}`
}

/* =====================================================================
   V1.2 时间助手：业务时区（Asia/Shanghai）的墙上时间工具。
   全部用 Intl 的显式 timeZone 计算，因此**运行电脑在 UTC 还是上海结果都一样**，
   不会出现「UTC 浏览器少 8 小时」的偏移。原有函数一律不改，避免其它入口回归。
   ===================================================================== */

const SHANGHAI_ZONE = 'Asia/Shanghai'

const SHANGHAI_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  hourCycle: 'h23',
})

/** Date → 上海墙上时间的各部分（不经过本机时区）。 */
function shanghaiPartsOf(date) {
  const parts = {}
  for (const part of SHANGHAI_PARTS.formatToParts(date)) parts[part.type] = part.value
  return parts
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/
const OFFSET_SUFFIX_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/

/** 上海墙上时间是否真实存在（严格校验日期与时分，不靠 Date 兜底）。 */
export function isValidShanghaiWallClock(value) {
  const match = WALL_CLOCK_RE.exec(String(value ?? '').trim())
  if (!match) return false
  const [, year, month, day, hour, minute] = match.map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  if (hour > 23 || minute > 59) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  )
}

/**
 * datetime-local 的值（用户按上海墙上时间填的）→ 带 +08:00 的 ISO 字符串。
 * 非法日期 / 时刻返回 null，绝不硬凑。
 */
export function shanghaiWallClockToOffset(value) {
  if (!isValidShanghaiWallClock(value)) return null
  const match = WALL_CLOCK_RE.exec(String(value).trim())
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+08:00`
}

/**
 * 后端返回的带偏移量 ISO（如 2026-10-15T10:10:00+08:00）→ 上海墙上时间 `YYYY-MM-DDTHH:mm`。
 * 已经是不带偏移的墙上时间时按原样截断，不经过 `new Date(...)`（避免本机时区搬运）。
 */
export function isoToShanghaiWallClock(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (!OFFSET_SUFFIX_RE.test(raw)) {
    const bare = WALL_CLOCK_RE.exec(raw)
    return bare ? `${bare[1]}-${bare[2]}-${bare[3]}T${bare[4]}:${bare[5]}` : ''
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''
  const parts = shanghaiPartsOf(date)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** 现在的上海墙上时间，供「参考时间」默认值与「设为现在」使用。 */
export function shanghaiNowWallClock(now = new Date()) {
  const parts = shanghaiPartsOf(now)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** 带偏移量的 ISO → 可读的北京时间标签（例如 `2026-10-12 18:00 周一`）。 */
export function shanghaiDeadlineLabel(value) {
  const wallClock = isoToShanghaiWallClock(value)
  const match = WALL_CLOCK_RE.exec(wallClock)
  if (!match) return String(value ?? '')
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  const weekday = WEEKDAY_NAMES[(date.getUTCDay() + 6) % 7]
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} ${weekday}`
}

export { SHANGHAI_ZONE }
