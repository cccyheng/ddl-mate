/**
 * 内部课程代码的**唯一性**分配（纯函数，可测试）。
 *
 * 背景：课程代码是**内部字段**，不再让用户输入。新建课程（手工表单 / 照片导入里没有代码的行）
 * 都必须拿到一个**稳定且唯一**的内部编号，否则：
 * - 两条新课程撞同一个代码 → 现有匹配 / 去重逻辑会以为它们是同一门课；
 * - 代码每次都被重算 → 课程「身份」漂移，后续编辑 / 复用会出问题。
 *
 * 为什么唯一性检查必须同时看两处：
 * - 库里已有的代码（老数据的真实教务代码也可能长得像 `AUTO-01`，绝不能覆盖别人）；
 * - **本次调用里已经预留的代码**（照片导入一批里会连续新建多门课，
 *   而这一批的插入在同一个事务里，中途读库是看不到刚插入的行的，所以必须显式预留）。
 */

import { internalCourseCodeText, isInternalCourseCode } from './courseDraft'

/** 内部编号的前缀，与 `internalCourseCodeText` 保持一致。 */
const INTERNAL_PREFIX = 'AUTO-'

/** 代码长度上限（与 `COURSE_LIMITS.CODE_MAX` 对齐）。 */
const CODE_MAX = 32

/** 最多尝试多少个序号；正常只在「最后一个号被占用」时多走一两次。 */
const MAX_ATTEMPTS = 100000

function sequenceOf(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim()
  if (!isInternalCourseCode(text)) return null
  const digits = text.replace(/^auto-?/i, '')
  const value = Number(digits)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 在 `used` 之外挑一个可用的内部编号。
 *
 * 优先接着已有的最大序号往下排（`AUTO-01` → `AUTO-02`），既能复用空出来的号，
 * 也不会因为删过一门课就把号重新发一遍。
 */
export function allocateInternalCourseCode(used: Iterable<string | null | undefined>, fallbackSeed = 1): string {
  const occupied = new Set<string>()
  let highest = 0
  for (const raw of used) {
    const text = String(raw ?? '').trim()
    if (text.length === 0) continue
    occupied.add(text.toUpperCase())
    const sequence = sequenceOf(text)
    if (sequence !== null && sequence > highest) highest = sequence
  }

  const seed = Number.isFinite(fallbackSeed) && fallbackSeed > 0 ? Math.floor(fallbackSeed) : 1
  const start = Math.max(highest + 1, seed)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = internalCourseCodeText(start + attempt)
    if (!occupied.has(candidate.toUpperCase())) return candidate
  }

  // 理论上到不了这里（要十几万个内部编号才会打满上面的循环）。
  // 兜底也给一个**合法形状**的唯一值，而不是返回空串或重复号。
  const stamp = Date.now().toString(36).toUpperCase()
  const candidate = `${INTERNAL_PREFIX}${stamp}`.slice(0, CODE_MAX)
  return occupied.has(candidate) ? `${INTERNAL_PREFIX}${stamp}X`.slice(0, CODE_MAX) : candidate
}
