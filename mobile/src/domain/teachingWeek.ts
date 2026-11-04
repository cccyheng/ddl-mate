/**
 * 教学周校准 —— 全应用唯一的「学期第一周周一」推理入口（纯函数，可测试）。
 *
 * 用户这一版的要求：**每个学期只问一次**「本周是第几教学周」，
 * 由「今天（北京时间）+ 当前教学周」反推出学期第一周周一，之后所有表单都用它，
 * 表单里不再让用户手填「学期第一周周一」。
 *
 * 约定（写死不猜）：
 * - 反推公式：`学期首周一 = 本周一 − (当前教学周 − 1) × 7 天`；
 * - 当前教学周必须是 1–53 的整数，否则返回 `null`（**绝不默认成第 1 周**）；
 * - 日期一律按**北京时间**算，与手机系统时区无关（复用 `datetime.ts`）。
 *
 * 这个模块只做数学与文案，不碰数据库、不碰网络。
 */

import {
  addDaysToDateKey,
  dateKeyToDayNumber,
  isMonday,
  isValidDateKey,
  mondayOfDateKey,
  shanghaiToday,
  teachingWeekdayName,
} from './datetime'
import { isValidTeachingWeek, MAX_TEACHING_WEEK, MIN_TEACHING_WEEK } from './teachingWeekRange'

/** 一次教学周校准的内容：哪一天、当时认为是第几周、据此算出的学期首周一。 */
export interface TeachingWeekCalibration {
  /** 校准当天（北京时间自然日）。 */
  today: string
  /** 用户填写的「今天是第几教学周」。 */
  currentWeek: number
  /** 由上面两项推出的学期第一周周一（`YYYY-MM-DD`，一定是周一）。 */
  semesterStartMonday: string
  /** 校准写入时间（ISO，带偏移），仅用于展示「上次校准」。 */
  setAt: string
}

export type CalibrationResult =
  | { ok: true; calibration: TeachingWeekCalibration }
  | { ok: false; reason: string }

/**
 * 由「今天 + 当前教学周」算出学期第一周周一。
 *
 * 返回 `null` 表示输入无法使用（今天非法 / 教学周不在 1–53），**不返回默认值**。
 */
export function semesterStartMondayFrom(today: string, currentWeek: number | string): string | null {
  if (!isValidDateKey(today)) return null
  const week = typeof currentWeek === 'number' ? currentWeek : Number(String(currentWeek).trim())
  if (!isValidTeachingWeek(week)) return null
  const thisMonday = mondayOfDateKey(today)
  if (!thisMonday) return null
  return addDaysToDateKey(thisMonday, -(week - 1) * 7)
}

/** 构造一次校准；输入不合法时给出可直接展示的理由，而不是硬凑一个学期起点。 */
export function createCalibration(
  today: string,
  currentWeek: number | string,
  setAt: string,
): CalibrationResult {
  if (!isValidDateKey(today)) return { ok: false, reason: '今天的日期无法识别，请稍后重试。' }
  const raw = String(currentWeek ?? '').trim()
  if (raw.length === 0) {
    return { ok: false, reason: `请填写本周是第几教学周（${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK} 的整数）。` }
  }
  const week = Number(raw)
  if (!isValidTeachingWeek(week)) {
    return {
      ok: false,
      reason: `教学周需要是 ${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK} 之间的整数，当前填写的是「${raw}」。`,
    }
  }
  const monday = semesterStartMondayFrom(today, week)
  if (!monday) return { ok: false, reason: '无法由今天推算出学期第一周周一，请检查填写的教学周。' }
  return {
    ok: true,
    calibration: { today, currentWeek: week, semesterStartMonday: monday, setAt },
  }
}

/**
 * 重新打开页面时按**今天**重算当前教学周。
 *
 * 这是「校准一次、长期可用」的关键：学期首周一固定不变，
 * 当前教学周随着日子自动往前走，用户不需要每次重新填。
 * 返回 `null` 表示已有校准不可用（学期首周一非法）。
 */
export function currentTeachingWeekOn(calibration: TeachingWeekCalibration | null, today: string): number | null {
  if (!calibration) return null
  if (!isValidDateKey(calibration.semesterStartMonday) || !isValidDateKey(today)) return null
  const start = dateKeyToDayNumber(calibration.semesterStartMonday)
  const target = dateKeyToDayNumber(today)
  if (start === null || target === null) return null
  return Math.floor((target - start) / 7) + 1
}

/** 今天的北京时间自然日。 */
export function todayInBeijing(now: Date = new Date()): string {
  return shanghaiToday(now)
}

export interface CalibrationSummary {
  /** 「2026-10-15（周三）是第 7 教学周」这样的一句人话。 */
  todayLine: string
  /** 「学期第一周周一：2026-09-07」；没有校准时为 null。 */
  semesterStartLine: string | null
  /** 当前教学周；无法计算时为 null。 */
  currentWeek: number | null
  /** 界面提示：校准是否已经过期/尚不可用。 */
  warning: string | null
}

/** 校准摘要（课程页与表单共用同一份文案，避免两处不一致）。 */
export function describeCalibration(
  calibration: TeachingWeekCalibration | null,
  today: string,
): CalibrationSummary {
  if (!calibration) {
    return {
      todayLine: today,
      semesterStartLine: null,
      currentWeek: null,
      warning: '还没有校准教学周。需要填写周次范围或单双周的课表，请先设置一次「本周是第几教学周」。',
    }
  }
  const week = currentTeachingWeekOn(calibration, today)
  const weekday = teachingWeekdayName(today)
  const todayLine = weekday ? `${today}（${weekday}）` : today
  if (week === null) {
    return {
      todayLine,
      semesterStartLine: calibration.semesterStartMonday,
      currentWeek: null,
      warning: '教学周校准数据不完整，请重新设置一次。',
    }
  }
  let warning: string | null = null
  if (week < MIN_TEACHING_WEEK) {
    warning = `按校准推算，今天还没到第 1 教学周（学期首周一 ${calibration.semesterStartMonday}）。`
  } else if (week > MAX_TEACHING_WEEK) {
    warning = `按校准推算，今天已经超过第 ${MAX_TEACHING_WEEK} 教学周，可能已经进入下一个学期，请重新校准。`
  }
  return {
    todayLine,
    semesterStartLine: `学期第一周周一：${calibration.semesterStartMonday}`,
    currentWeek: week,
    warning,
  }
}

/** 校准是否仍然可用（学期起点是**真实存在的周一**，且能算出 1–53 之间的教学周）。 */
export function calibrationUsable(calibration: TeachingWeekCalibration | null, today: string): boolean {
  if (!calibration) return false
  if (!isValidDateKey(calibration.semesterStartMonday) || !isMonday(calibration.semesterStartMonday)) return false
  if (!isValidTeachingWeek(calibration.currentWeek)) return false
  const week = currentTeachingWeekOn(calibration, today)
  return week !== null && isValidTeachingWeek(week)
}

/** 供界面展示的「这一周是第几教学周」说明。 */
export function teachingWeekLabel(week: number): string {
  return `第 ${week} 教学周`
}
