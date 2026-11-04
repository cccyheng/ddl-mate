/**
 * 课表「同一节课」的语义判定 —— 全应用唯一的**重复判定**入口（纯函数，可测试）。
 *
 * 复核定稿（两轮修正的结论，别再退回旧口径）：
 *
 * 第一轮：**不能**用「同一天只允许一条」当唯一约束。一门课同一天可以有多段课
 * （真实照片里「形势与政策」周日 08:00–09:35 与 10:00–11:35 就是两段）。
 *
 * 第二轮：**只比星期 + 时刻也不够**。同一个星期、同一个时刻完全可以是两门不同的课表行：
 * - 单周（ODD）与双周（EVEN）各一条；
 * - 第 1–8 周与第 9–16 周各一条；
 * - 学期起点不同（不同学期）的两条。
 * 上面三种都**必须允许并存**，否则用户在真实课表里就存不下第二条。
 *
 * 因此「完全相同的一条」= 下面这些字段全部一致（各自规范化后比较）：
 *   weekday / startTime / endTime / weekPattern / semesterStartDate / startWeek / endWeek
 *
 * 地点**不参与**判重：同一个时段换个教室仍然是「同一节课」被改了，不是新的一节课；
 * 用它参与判重会出现「只改教室就变成两条」的怪现象。
 *
 * 这里刻意只做纯比较、不查数据库，方便仓库层、表单层与导入层共用同一份规则。
 */

export interface SessionLike {
  weekday: number
  startTime: string
  endTime: string
  /** `ALL` / `ODD` / `EVEN`；缺省按 `ALL`（旧数据语义）。 */
  weekPattern?: string | null
  /** 学期第一周周一（`YYYY-MM-DD`）；缺省表示「无教学周限制」。 */
  semesterStartDate?: string | null
  /**
   * 起止周允许是 `number`（已保存的记录）或 `string`（表单草稿还没解析）。
   * 两种都接受，比较前统一转成整数；解析不出来一律视为「没有周次范围」。
   */
  startWeek?: number | string | null
  endWeek?: number | string | null
}

/**
 * 时刻规范化：接受 `HH:mm`、`H:mm`、`HH:mm:ss`。
 * 无法识别时返回 `null`（调用方决定怎么处理，绝不硬凑一个时刻）。
 */
export function canonicalClock(value: string | null | undefined): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 周次规律规范化：只认 ODD / EVEN，其余（含 null）一律 ALL —— 与 `normalizeWeekPattern` 同口径。 */
export function canonicalWeekPattern(value: string | null | undefined): 'ALL' | 'ODD' | 'EVEN' {
  const raw = String(value ?? '').trim().toUpperCase()
  return raw === 'ODD' || raw === 'EVEN' ? raw : 'ALL'
}

/** 周次解析：`number | string | null` → 1–53 的整数，其余一律 `null`（绝不把 `''` 当成 0）。 */
function parseWeekValue(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (!/^\d{1,2}$/.test(text)) return null
  const parsed = Number(text)
  return parsed >= 1 && parsed <= 53 ? parsed : null
}

/**
 * 教学周范围的规范化键。
 *
 * 三条信息必须**成套**才有意义：学期起点 + 起始周 + 结束周。
 * 任何一项缺失都视为「没有教学周范围」（旧数据 / 每周都上），绝不能拿半套去比。
 */
export function weekScopeKey(session: SessionLike): string {
  const pattern = canonicalWeekPattern(session.weekPattern)
  const start = parseWeekValue(session.startWeek)
  const end = parseWeekValue(session.endWeek)
  const anchor = String(session.semesterStartDate ?? '').trim()
  const hasScope = anchor.length > 0 && start !== null && end !== null
  if (!hasScope) return `none|${pattern}`
  return `${anchor}|${start}|${end}|${pattern}`
}

/** 时段键（星期 + 时刻），只用于「同一天同一时段」这一层判定。 */
export function sesslotKey(session: SessionLike): string {
  const start = canonicalClock(session.startTime) ?? String(session.startTime)
  const end = canonicalClock(session.endTime) ?? String(session.endTime)
  return `${Number(session.weekday)}|${start}|${end}`
}

/** 完整语义键：时段 + 教学周范围（含单双周与学期起点）。 */
export function sessionIdentityKey(session: SessionLike): string {
  return `${sesslotKey(session)}|${weekScopeKey(session)}`
}

function normalizedClock(value: string | null | undefined): string {
  return canonicalClock(value) ?? String(value ?? '').trim()
}

/**
 * 两条课表是否是**同一天、同一时段、同一教学周范围**的那一条。
 *
 * 只有这种情况才算「重复」：重复点保存、失败重试、批量导入同一行。
 * 同一天不同时段、或同一时段不同单双周/周次范围/学期起点，都返回 `false`（允许并存）。
 */
export function isSameSessionSlot(left: SessionLike, right: SessionLike): boolean {
  if (Number(left.weekday) !== Number(right.weekday)) return false
  if (normalizedClock(left.startTime) !== normalizedClock(right.startTime)) return false
  if (normalizedClock(left.endTime) !== normalizedClock(right.endTime)) return false
  return weekScopeKey(left) === weekScopeKey(right)
}
