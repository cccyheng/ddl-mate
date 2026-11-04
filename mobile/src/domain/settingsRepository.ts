/**
 * 应用级设置仓库（键值表 `app_settings`）。
 *
 * 目前只承载一项：**全局教学周校准**。设计取舍：
 * - 设置与课表**分开存**，删课程/删课表不会碰到它（课表行会被级联删除）；
 * - 只读写指定的几个键，不提供「列出全部」的宽接口，避免把内部键名泄漏到界面；
 * - 写入走参数化绑定；`value` 存字符串，解析失败按「没有设置」处理而不是抛异常，
 *   否则一条脏值会让课程页直接打不开。
 *
 * **语义约束（来自复核定稿）**：更新校准只影响**以后新建/编辑的表单**，
 * 绝不回写、重算或「修正」任何既有课表的 `semester_start_date`。
 * 因此这个仓库里没有任何 `UPDATE schedules` 语句。
 */

import { APP_SETTINGS_KEYS, APP_SETTINGS_SQL } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import { isMonday, isValidDateKey } from '../domain/datetime'
import { createCalibration, type TeachingWeekCalibration } from '../domain/teachingWeek'
import { isValidTeachingWeek } from '../domain/teachingWeekRange'
import { parseStudyReferenceMinutes, readStoredStudyReferenceMinutes } from '../domain/studyReference'

interface SettingRow {
  key: string
  value: string
  updated_at: string
}

export class AppSettingsRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date

  constructor(db: SqliteDatabase, now: () => Date = () => new Date()) {
    this.db = db
    this.now = now
  }

  /** 读取原始字符串值；不存在返回 `null`。 */
  async get(key: string): Promise<string | null> {
    const row = await this.db.getFirstAsync<SettingRow>('SELECT key, value, updated_at FROM app_settings WHERE key = ?;', [
      key,
    ])
    return row ? String(row.value) : null
  }

  /** 写入（覆盖）一个设置项。 */
  async set(key: string, value: string): Promise<void> {
    const nowIso = this.now().toISOString()
    await this.db.runAsync(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      [key, value, nowIso],
    )
  }

  /** 删除一个设置项（例如「清除校准」）。 */
  async remove(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM app_settings WHERE key = ?;', [key])
  }

  /**
   * 读取教学周校准。
   *
   * 任一项缺失或不可用都返回 `null`，由界面引导用户重新校准，
   * 而不是给出一个「第 1 周」的假默认。这里的检查包括：
   * - 两个日期都是真实日期；
   * - 学期第一周周一**真的是周一**（`2026-09-01` 这种周二必须被拒绝，
   *   否则 `teachingWeek()` 会算出错误的周次）；
   * - 周次是 1–53 的整数；
   * - **自洽性**：由「校准当天 + 当时填的周次」重算出来的周一必须与库里那条一致
   *   （防止有人手工改了其中一个键，留下互相矛盾的半套数据）。
   */
  async loadTeachingWeekCalibration(): Promise<TeachingWeekCalibration | null> {
    const [monday, week, today, setAt] = await Promise.all([
      this.get(APP_SETTINGS_KEYS.SEMESTER_START_MONDAY),
      this.get(APP_SETTINGS_KEYS.CALIBRATED_WEEK),
      this.get(APP_SETTINGS_KEYS.CALIBRATED_TODAY),
      this.get(APP_SETTINGS_KEYS.CALIBRATED_AT),
    ])
    if (!monday || !week || !today) return null
    if (!isValidDateKey(monday) || !isValidDateKey(today)) return null
    if (!isMonday(monday)) return null
    const parsedWeek = Number(week)
    if (!isValidTeachingWeek(parsedWeek)) return null
    const recomputed = createCalibration(today, parsedWeek, setAt ?? '')
    if (!recomputed.ok || recomputed.calibration.semesterStartMonday !== monday) return null
    return {
      today,
      currentWeek: parsedWeek,
      semesterStartMonday: monday,
      setAt: setAt ?? '',
    }
  }

  /**
   * 写入教学周校准。**只写这四个键**，不触碰 `schedules`。
   *
   * 输入不合法时返回 `{ ok: false }`，由界面显示原因；绝不写入半套数据。
   */
  async saveTeachingWeekCalibration(input: {
    today: string
    currentWeek: number | string
  }): Promise<{ ok: true; calibration: TeachingWeekCalibration } | { ok: false; reason: string }> {
    const created = createCalibration(input.today, input.currentWeek, this.now().toISOString())
    if (!created.ok) return { ok: false, reason: created.reason }
    const { semesterStartMonday, currentWeek, today, setAt } = created.calibration

    await this.db.withTransactionAsync(async () => {
      await this.set(APP_SETTINGS_KEYS.SEMESTER_START_MONDAY, semesterStartMonday)
      await this.set(APP_SETTINGS_KEYS.CALIBRATED_WEEK, String(currentWeek))
      await this.set(APP_SETTINGS_KEYS.CALIBRATED_TODAY, today)
      await this.set(APP_SETTINGS_KEYS.CALIBRATED_AT, setAt)
    })

    return { ok: true, calibration: created.calibration }
  }

  /** 清除校准（界面需要显式确认；清除后要求周次的表单会引导重新设置）。 */
  async clearTeachingWeekCalibration(): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.remove(APP_SETTINGS_KEYS.SEMESTER_START_MONDAY)
      await this.remove(APP_SETTINGS_KEYS.CALIBRATED_WEEK)
      await this.remove(APP_SETTINGS_KEYS.CALIBRATED_TODAY)
      await this.remove(APP_SETTINGS_KEYS.CALIBRATED_AT)
    })
  }

  /* --------------------------- 照片识别服务地址 --------------------------- */

  /** 读取用户配置（或自动推断后保存）的伴侣服务地址。 */
  async loadOcrEndpoint(): Promise<string | null> {
    const value = await this.get(APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT)
    return value && value.trim().length > 0 ? value.trim() : null
  }

  /** 保存伴侣服务地址（空字符串 = 清除）。调用方负责先做格式校验。 */
  async saveOcrEndpoint(endpoint: string): Promise<void> {
    const trimmed = String(endpoint ?? '').trim()
    if (trimmed.length === 0) {
      await this.remove(APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT)
      return
    }
    await this.set(APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT, trimmed)
  }

  /* ---------------------- 本机通知路由代次（恢复边界） ---------------------- */

  /**
   * 读取本机通知路由代次。
   *
   * 这个值**只在本机递增，绝不从备份导入**。恢复成功后 +1，使恢复前已送达 /
   * 仍在系统里的旧通知（载荷代次较旧）点击时被拒绝，不会按可能被复用的任务 ID
   * 打开恢复后的另一条任务。缺失或脏值按 0 处理。
   */
  async loadNotificationRouteGeneration(): Promise<number> {
    const raw = await this.get(APP_SETTINGS_KEYS.NOTIFICATION_ROUTE_GENERATION)
    const value = Number(raw)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  /** 写入本机通知路由代次（只接受非负安全整数）。 */
  async saveNotificationRouteGeneration(value: number): Promise<void> {
    const safe = Number.isSafeInteger(value) && value >= 0 ? value : 0
    await this.set(APP_SETTINGS_KEYS.NOTIFICATION_ROUTE_GENERATION, String(safe))
  }

  /* --------------------- 每日学习参考用时（DDL 压力分析） --------------------- */

  /**
   * 读取用户设置的每日学习参考用时（分钟）。
   *
   * - 没有设置过 → `null`（**默认就是没有**，绝不编一个默认参考值）；
   * - 库里存的是脏值（早前手改过、旧版本写坏、超出 1–1440）→ 同样按「未设置」处理，
   *   而不是抛异常：一条脏设置不该让整个设置页或压力分析打不开。
   */
  async loadDailyStudyReferenceMinutes(): Promise<number | null> {
    const stored = await this.get(APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES)
    return readStoredStudyReferenceMinutes(stored)
  }

  /**
   * 保存每日学习参考用时（单条 UPSERT，**只写这一个键**）。
   *
   * 非法输入返回 `{ ok: false }` 并且**一个字节都不写**（界面显示原因）；
   * 传空串 / `null` = 清除这一项（回到「未设置」），而不是写入 0。
   *
   * 这个写入不碰 `tasks` / `courses` / `schedules`：参考值只是展示用的比较基准。
   */
  async saveDailyStudyReferenceMinutes(
    raw: unknown,
  ): Promise<{ ok: true; minutes: number | null } | { ok: false; reason: string }> {
    const parsed = parseStudyReferenceMinutes(raw)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    if (parsed.unset) {
      await this.remove(APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES)
      return { ok: true, minutes: null }
    }
    await this.set(APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES, String(parsed.minutes))
    return { ok: true, minutes: parsed.minutes }
  }

  /** 清除参考用时（回到「未设置」）。 */
  async clearDailyStudyReferenceMinutes(): Promise<void> {
    await this.remove(APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES)
  }

  /**
   * 确保 `app_settings` 键值表存在。
   *
   * 今日计划（`daily_plan.today`）**复用这张既有表**，而它在很旧的库或测试用的内存库里
   * 可能还没建。这里只做 `CREATE TABLE IF NOT EXISTS`（与 `db/schema.ts` 里同一句 SQL），
   * 不删列、不改列、不动任何一行数据；表已经存在时它是一次空操作。
   */
  async ensureDailyPlanStorage(): Promise<void> {
    await this.db.execAsync(APP_SETTINGS_SQL)
  }
}
