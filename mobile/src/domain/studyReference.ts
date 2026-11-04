/**
 * 「每日学习参考用时」的**纯输入校验**（无 React / 无数据库）。
 *
 * 为什么单独一层：同一个值有三个入口（界面输入框、仓库写入、从库里读回），
 * 三处必须用**同一套**判定，否则会出现「界面说没问题、保存却写不进去」
 * 或者更糟的「脏值被写进设置、下次打开 App 直接崩」。
 *
 * 口径（刻意严格）：
 * - 空串 / 纯空白 = **未设置**（默认状态；不会替用户编一个参考值）；
 * - 只接受**十进制整数**写法：`1`–`1440`；
 * - 明确拒绝小数（`30.5`）、科学计数（`1e3`）、正负号（`+30` / `-5`）、
 *   前导零之外的杂字符（`30 分` / `30m`）、超出范围（`0` / `1441`）、
 *   `NaN` / `Infinity` —— 一处拒绝，处处一致。
 *
 * 这个值只影响**展示用的比较**：它不会改动任何任务或课表。
 */

/**
 * 每日学习参考用时的合法范围（分钟）。
 *
 * **单一事实来源就在这里**（`ddlPressure.ts` 从这里 import），
 * 因为这一层是最底层、没有任何反向依赖；反过来 import 会形成模块环，
 * 环在 ESM 里会让模板字符串读到未初始化的绑定（本机已真实复现过一次）。
 * 范围本身是个有意收紧的产品口径：1 分钟到 24 小时。
 */
export const REFERENCE_MINUTES_MIN = 1
export const REFERENCE_MINUTES_MAX = 1440

/** 只接受纯十进制整数字面量（显式禁止小数 / 指数 / 符号 / 前后缀）。 */
const INTEGER_TEXT_RE = /^\d+$/

export type StudyReferenceParse =
  | { ok: true; minutes: number | null; unset: true; text: '' }
  | { ok: true; minutes: number; unset: false; text: string }
  | { ok: false; reason: string; minutes: null; unset: false; text: string }

export const STUDY_REFERENCE_RANGE_MESSAGE = `请填 ${REFERENCE_MINUTES_MIN}–${REFERENCE_MINUTES_MAX} 之间的整数分钟，例如 120。`

/**
 * 解析用户输入 / 仓库输入。
 *
 * **只接受字符串与数字两种原始类型**（外加 `null` / `undefined` = 未设置）。
 * 布尔、数组、对象一律拒绝，而不是 `String()` 一下碰运气：
 * `true` 变成 `"true"`、`[60]` 变成 `"60"` 都会**悄悄写入一个用户没填过的值**，
 * 这正是复核点名的缺陷。
 *
 * 返回结构里同时给出「是否未设置」与「归一化后的文本」，界面与仓库都不必再自己判断。
 */
export function parseStudyReferenceMinutes(raw: unknown): StudyReferenceParse {
  if (raw === null || raw === undefined) return { ok: true, minutes: null, unset: true, text: '' }
  if (typeof raw === 'boolean' || typeof raw === 'object' || typeof raw === 'function' || typeof raw === 'symbol') {
    return { ok: false, reason: STUDY_REFERENCE_RANGE_MESSAGE, minutes: null, unset: false, text: '' }
  }
  const text = typeof raw === 'number' ? String(raw) : String(raw).trim()
  if (text.length === 0) return { ok: true, minutes: null, unset: true, text: '' }
  if (!INTEGER_TEXT_RE.test(text)) {
    return { ok: false, reason: STUDY_REFERENCE_RANGE_MESSAGE, minutes: null, unset: false, text }
  }
  const minutes = Number(text)
  if (!Number.isInteger(minutes) || minutes < REFERENCE_MINUTES_MIN || minutes > REFERENCE_MINUTES_MAX) {
    return { ok: false, reason: STUDY_REFERENCE_RANGE_MESSAGE, minutes: null, unset: false, text }
  }
  return { ok: true, minutes, unset: false, text: String(minutes) }
}

/**
 * 从**库里存的字符串**读回参考用时。
 *
 * 与 {@link parseStudyReferenceMinutes} 的差别：脏值**不报错**，直接当成「未设置」，
 * 因为一条历史脏数据不该让设置页或压力分析打不开。
 */
export function readStoredStudyReferenceMinutes(raw: unknown): number | null {
  const parsed = parseStudyReferenceMinutes(raw)
  return parsed.ok ? parsed.minutes : null
}

/** 草稿的「脏」判定：与已保存的值不同才算脏（未设置 = `null`）。 */
export function isStudyReferenceDirty(draft: string, saved: number | null): boolean {
  const parsed = parseStudyReferenceMinutes(draft)
  if (!parsed.ok) {
    // 非法输入也算「有未保存的改动」，但保存会被守卫拦下（不能悄悄丢弃用户输入）。
    return draft.trim().length > 0
  }
  return parsed.minutes !== saved
}

/** 已经保存的值 → 输入框里的文本。 */
export function studyReferenceToDraft(saved: number | null): string {
  return saved === null ? '' : String(saved)
}

/**
 * 保存前的守卫（界面按钮与事件处理器共用同一套判定）。
 *
 * 返回 `canSave`：非法输入、或与已保存值相同（无改动）时不允许写入，
 * 因此「只渲染、没动过」的状态**永远不会**产生写库动作。
 */
export function studyReferenceSaveGuard(draft: string, saved: number | null): {
  canSave: boolean
  reason: string | null
  minutes: number | null
  dirty: boolean
} {
  const parsed = parseStudyReferenceMinutes(draft)
  const dirty = isStudyReferenceDirty(draft, saved)
  if (!parsed.ok) {
    return { canSave: false, reason: parsed.reason, minutes: null, dirty }
  }
  if (!dirty) {
    return { canSave: false, reason: null, minutes: parsed.minutes, dirty: false }
  }
  return { canSave: true, reason: null, minutes: parsed.minutes, dirty: true }
}
