/** 上海自然日 `YYYY-MM-DD` 小工具（固定 +08:00，与手机端 datetime 规则一致）。 */
const DAY_MS = 86400000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function dateKeyOf(epochMs) {
  return new Date(epochMs + 8 * 3600000).toISOString().slice(0, 10)
}

export function shiftDateKey(dateKey, days) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

export function weekdayShort(dateKey) {
  return WEEKDAYS[new Date(`${dateKey}T00:00:00Z`).getUTCDay()]
}

/** `10-07 周二` 这样的短标签。 */
export function shortDayLabel(dateKey) {
  return `${dateKey.slice(5)} ${weekdayShort(dateKey)}`
}
