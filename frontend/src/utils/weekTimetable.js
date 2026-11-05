/**
 * 周视图课表的纯计算：一周的日期、时间轴范围、每节课的位置与并排分栏。
 * 课表数据直接用月历接口按日期展开后的结果（已按教学周 / 单双周过滤）。
 */
import { toDateKey } from './datetime.js'

export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 'YYYY-MM-DD' → 本地 Date（不经过 UTC，避免跨时区差一天）。 */
export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return toDateKey(date) === key ? date : null
}

/** 某天所在周的周一。 */
export function mondayOf(date) {
  const day = (date.getDay() + 6) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - day)
}

export function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** 周一起的 7 天：{ key, date, label, dayOfMonth, month } */
export function weekDays(monday) {
  return WEEKDAY_LABELS.map((label, index) => {
    const date = addDays(monday, index)
    return { key: toDateKey(date), date, label, dayOfMonth: date.getDate(), month: date.getMonth() + 1 }
  })
}

/** 这一周覆盖的 1～2 个月份，供逐月请求月历接口。 */
export function monthsOfWeek(monday) {
  const result = []
  for (const offset of [0, 6]) {
    const date = addDays(monday, offset)
    const item = { year: date.getFullYear(), month: date.getMonth() + 1 }
    if (!result.some((m) => m.year === item.year && m.month === item.month)) result.push(item)
  }
  return result
}

/** 'HH:mm[:ss]' → 当天分钟数；无效返回 null。 */
export function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''))
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return minutes >= 0 && minutes <= 24 * 60 ? minutes : null
}

/** 时间轴：默认 08:00–18:00，按本周实际课程向外扩到整点。 */
export function timeAxis(items, { defaultStart = 8 * 60, defaultEnd = 18 * 60 } = {}) {
  let start = defaultStart
  let end = defaultEnd
  for (const item of items) {
    const s = toMinutes(item.startTime)
    const e = toMinutes(item.endTime)
    if (s !== null) start = Math.min(start, Math.floor(s / 60) * 60)
    if (e !== null) end = Math.max(end, Math.ceil(e / 60) * 60)
  }
  const hours = []
  for (let minute = start; minute < end; minute += 60) hours.push(minute)
  return { start, end, hours }
}

/**
 * 同一天的课按时间排好，并给时间重叠的课分到不同的栏（lane），并排显示不互相遮挡。
 * 返回 [{ ...item, top, height, lane, lanes }]，top/height 是占时间轴的比例（0～1）。
 */
export function layoutDay(items, axis) {
  const span = axis.end - axis.start
  const sorted = items
    .map((item) => ({ item, s: toMinutes(item.startTime), e: toMinutes(item.endTime) }))
    .filter((x) => x.s !== null && x.e !== null && x.e > x.s)
    .sort((a, b) => a.s - b.s || a.e - b.e)

  const placed = []
  let group = []
  let groupEnd = -1
  const flush = () => {
    const lanes = Math.max(1, ...group.map((x) => x.lane + 1))
    for (const x of group) placed.push({ ...x.item, top: (x.s - axis.start) / span, height: (x.e - x.s) / span, lane: x.lane, lanes })
    group = []
  }
  for (const x of sorted) {
    if (group.length && x.s >= groupEnd) {
      flush()
      groupEnd = -1
    }
    const used = new Set(group.filter((g) => g.e > x.s).map((g) => g.lane))
    let lane = 0
    while (used.has(lane)) lane += 1
    group.push({ ...x, lane })
    groupEnd = Math.max(groupEnd, x.e)
  }
  if (group.length) flush()
  return placed
}
