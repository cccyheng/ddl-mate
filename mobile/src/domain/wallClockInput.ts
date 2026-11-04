/**
 * 截止时间输入的纯逻辑：日期/时间拆分、拼接、补零与实时校验。
 *
 * 刻意放在 `domain/` 而不是直接写进 `ui/datetimeField.tsx`：
 * 这些是纯函数，可以脱离 React Native 直接测试，而它们又正好是
 * 「用户填了什么 / 什么时候算填完」这类最容易出错的地方。
 *
 * 口径与 `normalizeTaskDraft` 保持一致：
 * - `H:mm` 与 `HH:mm` 都接受，输入时用 `padClockText` 补零；
 * - 任务表单可以**只填日期**（表示当天结束前），组件不替用户猜 18:00 或 23:59；
 * - 通知导入 / 时间助手等仍要求具体时刻的调用方，传 `allowDateOnly: false`。
 */

import { isValidDateKey, isValidShanghaiWallClock } from './datetime'

export interface SplitWallClock {
  date: string
  time: string
}

/** `YYYY-MM-DDTHH:mm` → 日期与时间两部分；只有日期时 `time` 为空串。 */
export function splitWallClock(value: string): SplitWallClock {
  const raw = String(value ?? '').trim()
  if (raw.length === 0) return { date: '', time: '' }
  const [date = '', time = ''] = raw.replace(' ', 'T').split('T')
  return { date, time: time.slice(0, 5) }
}

/**
 * 拼接日期与时间。
 *
 * 只有日期时返回**裸日期**（`2026-10-15`），不返回带尾巴的 `2026-10-15T`：
 * 后者虽然能被 `splitWallClock` 读回，但作为状态值不干净，
 * 也容易被别处的严格校验判成非法输入。
 */
export function joinWallClock(date: string, time: string): string {
  const d = date.trim()
  const t = time.trim()
  if (d.length === 0 && t.length === 0) return ''
  if (d.length === 0) return t
  if (t.length === 0) return d
  return `${d}T${t}`
}

/** 把 `9:00` / `09:00` 统一成补零的 `HH:mm`；无法识别时原样返回，交给校验去报错。 */
export function padClockText(value: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim())
  if (!match) return value
  return `${match[1]!.padStart(2, '0')}:${match[2]!.padStart(2, '0')}`
}

/** 是否已经填了日期但还没填时刻（任务表单允许；其他调用方可能仍要求补时刻）。 */
export function isDateWithoutTime(date: string, time: string): boolean {
  return date.trim().length > 0 && time.trim().length === 0
}

export interface WallClockInputOptions {
  /**
   * 是否允许「只有日期、没有时刻」。
   *
   * 默认 `false`：通知导入、时间助手参考时间等仍要求精确到分钟；
   * 任务表单显式传 `true`，把日期当作当天结束前的 DDL 保存。
   */
  allowDateOnly?: boolean
}

/**
 * 实时校验：返回可展示的提示/错误文案；`null` 表示当前输入合法。
 *
 * 与 `normalizeTaskDraft` 的口径刻意一致，不再出现
 * 「这里说没问题、保存时报错」的分歧。日期本身永远严格校验；
 * 只有「日期合法、时间留空」在 `allowDateOnly` 时才是合法状态。
 */
export function validateWallClockInput(
  date: string,
  time: string,
  options: WallClockInputOptions = {},
): string | null {
  const d = date.trim()
  const t = padClockText(time.trim())
  if (d.length === 0 && t.length === 0) return null
  if (d.length === 0) return '请填写日期（YYYY-MM-DD）；只想留空就清掉时间。'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '日期格式应为 YYYY-MM-DD。'
  if (!isValidDateKey(d)) return `${d} 不是真实存在的日期（例如 2026-02-30、2027-02-29 都不存在）。`
  if (t.length === 0) {
    return options.allowDateOnly ? null : '还差一个具体时刻：请填 HH:mm（应用不会替你猜时间）。'
  }
  if (!/^\d{2}:\d{2}$/.test(t)) return '时间格式应为 HH:mm，例如 22:00。'
  if (!isValidShanghaiWallClock(`${d}T${t}`)) {
    return `${time.trim()} 不是有效时刻（小时 00–23，分钟 00–59）。`
  }
  return null
}
