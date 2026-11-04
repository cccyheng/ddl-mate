/**
 * 日历 / 课表「实时状态」的**纯逻辑**（可单测，不依赖 React 或设备时钟）。
 *
 * 这里放两件事：
 * 1. **按下日历标签或回到今天时显示哪一天 / 哪个月** —— 在执行那一刻读时钟；
 *    从日期详情返回则保留浏览月份，不调用月份重置；
 * 2. **今天这一天的实时状态** —— 正在上课 / 下一节 / 课间 / 今天没课。
 *
 * 时间口径与全 App 一致：**Asia/Shanghai 墙上时间**（`shanghaiNowWallClock`）。
 * 所以「设备时区是 UTC 或纽约」不会导致日历默认到昨天或显示假的「正在上课」。
 */

import { shanghaiNowWallClock, shanghaiToday } from './datetime'

export interface ShanghaiClock {
  /** `YYYY-MM-DD`（上海自然日）。 */
  dateKey: string
  /** 当天第几分钟（上海墙上时间）。 */
  minutes: number
}

/** `HH:mm` → 当天第几分钟；不合法返回 `null`。 */
export function clockToMinutes(value: string | null | undefined): number | null {
  const text = String(value ?? '').trim()
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** 读一次「现在」的上海墙上时间（**每次调用都重新读**，避免用到过期值）。 */
export function readShanghaiClock(now: Date = new Date()): ShanghaiClock {
  const wall = shanghaiNowWallClock(now)
  return { dateKey: wall.slice(0, 10), minutes: clockToMinutes(wall.slice(11, 16)) ?? 0 }
}

/**
 * 带**完整时刻**的时钟读数。
 *
 * 为什么不能只拿 `ShanghaiClock`（日期 + 分钟）还原「现在」来做逾期判定：
 * 那会**丢掉秒与毫秒**。把「现在」截断到分钟之后，
 * 「10:00:00.500 到期」在一个 `10:00:00.250` 的现在会被算成已逾期 —— 差半秒也是差。
 * 因此逾期边界用这里的 `epochMs`（真实毫秒），而日期分组仍然用 `dateKey`。
 */
export interface ShanghaiEpochClock {
  /** `YYYY-MM-DD`（上海自然日）。 */
  dateKey: string
  /** 真实 epoch 毫秒（**不截断到分钟**）。 */
  epochMs: number
  /** 当天第几分钟（上海墙上时间，仅用于展示型判定）。 */
  minutes: number
}

/** 读一次「现在」的上海日期 + 真实毫秒（每次调用都重新读）。 */
export function readShanghaiEpochClock(now: Date = new Date()): ShanghaiEpochClock {
  return { ...readShanghaiClock(now), epochMs: now.getTime() }
}

/** `YYYY-MM-DD` → `{year, month}`（month 1–12）；无法解析返回 `null`。 */
export function monthOfDateKey(dateKey: string): { year: number; month: number } | null {
  const year = Number(String(dateKey ?? '').slice(0, 4))
  const month = Number(String(dateKey ?? '').slice(5, 7))
  if (!Number.isInteger(year) || year < 1970 || !Number.isInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

/**
 * 进入日历时「默认落在哪一天」。
 *
 * 刻意做成函数而不是常量：调用方在标签按下或回到今天按钮执行时调用它，
 * 因此跨过午夜后得到的是新的一天，而不是上次渲染时缓存的日期。
 */
export function calendarFocusTarget(now: Date = new Date()): {
  dateKey: string
  minutes: number
  cursor: { year: number; month: number }
} {
  const clock = readShanghaiClock(now)
  const cursor = monthOfDateKey(clock.dateKey) ?? monthOfDateKey(shanghaiToday(now))!
  return { dateKey: clock.dateKey, minutes: clock.minutes, cursor }
}

/**
 * 从**标签**重新进入日历时，是否需要把日历栈归位到月视图（`popToTop`）。
 *
 * 背景（复核对点名的真实缺陷）：用户在「某一天」详情里 → 切到别的标签 →
 * 再点「日历」标签回来。这时日历栈仍然是 `[月视图, 某一天]`，
 * 不归位的话用户会看到上次那个过去的日期。
 *
 * 为什么判据是「路由数量 > 1」而不是在详情页监听自己的 focus：
 * 详情页的 focus 无法区分「用户刚点了这一天」与「用户从别的标签切回来」
 * （两者 `isFocused()` 都可能为真），猜错就会把用户刚选的那一天强行改成今天
 * —— 这正是上一版被复核抓到的 bug。标签按下是唯一没有歧义的入口信号。
 */
export function shouldReturnToMonthOnTabEntry(routeCount: number): boolean {
  return Number.isFinite(routeCount) && routeCount > 1
}

/** 按下「日历」标签时该做的两件事（`popToTop` 只有需要时才做）。 */
export interface CalendarTabEntryAction {
  /**
   * **总是**把显示月份设回「执行这一刻」的上海今天所在月。
   *
   * 这一条与栈深度无关：用户翻到别的月份后，在已经选中的「日历」标签上再按一次，
   * 预期就是回到今天（标签的常规语义）；而栈里压着「某一天」时，
   * 标签监听器同时执行 `resetToToday` 与 `popToTop`；月视图的焦点回调仅刷新数据。
   */
  resetToToday: boolean
  /** 只有栈里压着「某一天」时才归位到月视图。 */
  popToTop: boolean
}

/**
 * 按下「日历」标签（无论是不是当前已选中的标签）时的统一动作。
 *
 * 刻意做成纯函数：`tabPress` 是唯一没有歧义的「进入日历」信号，
 * 而这里要同时表达两件事——**总是回到今天**，但**只在必要时**才动导航栈。
 * 栈内浏览（点某一天、从某一天返回月视图）不受影响，因为这条路径只在标签按下时触发。
 */
export function calendarTabEntryAction(routeCount: number): CalendarTabEntryAction {
  return { resetToToday: true, popToTop: shouldReturnToMonthOnTabEntry(routeCount) }
}

