/** 读取教学周校准（与手机端同样的 4 个键）。任一不一致都当作没有校准，绝不拼出半套数据。 */
import { createCalibration, currentTeachingWeekOn, todayInBeijing } from '@domain/teachingWeek'
import { settingsApi } from '@/api'
import { SETTING_KEYS } from '@/domain/settingKeys'

export const CALIBRATION_KEYS = [
  SETTING_KEYS.SEMESTER_START_MONDAY,
  SETTING_KEYS.CALIBRATED_WEEK,
  SETTING_KEYS.CALIBRATED_TODAY,
  SETTING_KEYS.CALIBRATED_AT,
]

/** rows：键 → GET /api/settings/{key} 的结果。 */
export function calibrationFromRows(rows) {
  const [monday, week, calibratedToday, setAt] = CALIBRATION_KEYS.map((key) => rows[key]?.value ?? null)
  if (!monday || !week || !calibratedToday) return null
  const recomputed = createCalibration(calibratedToday, Number(week), setAt ?? '')
  if (!recomputed.ok || recomputed.calibration.semesterStartMonday !== monday) return null
  return recomputed.calibration
}

export async function loadCalibrationRows() {
  const results = await Promise.all(CALIBRATION_KEYS.map((key) => settingsApi.get(key)))
  return Object.fromEntries(results.map((r) => [r.key, r]))
}

/** 今天是第几教学周（未校准或超出 1–53 时为 null）。 */
export async function currentTeachingWeek() {
  const calibration = calibrationFromRows(await loadCalibrationRows())
  const week = currentTeachingWeekOn(calibration, todayInBeijing())
  return week !== null && week >= 1 && week <= 53 ? week : null
}
