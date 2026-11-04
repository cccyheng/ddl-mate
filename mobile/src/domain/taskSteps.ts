/**
 * 任务的**手动步骤清单**（纯逻辑：无 React / 无数据库 / 无网络 / 无 AI）。
 *
 * 这一份只回答一个问题：**这条任务被我拆成了哪几步、哪几步做完了。**
 *
 * 刻意的边界（来自授权书，改这里之前先读一遍）：
 * - **不是子任务、不是日程**：步骤只挂在父任务下面，不会被写进 `tasks` 表，
 *   也没有自己的截止时间 / 预计用时 / 状态机；
 * - **全部步骤做完 ≠ 父任务完成**：`progressOf` 只算 0..N 的计数，
 *   绝不回写父任务的状态、DDL 或预计用时（那是用户自己的动作）；
 * - **有界且严格**：最多 {@link MAX_TASK_STEPS} 条、标题去掉首尾空白后 1–120 字、
 *   步骤 ID 稳定且不重复。任何一条不满足都判定「这份记录不可用」，
 *   **绝不静默截断、补默认值或丢弃某一行** —— 那等于替用户改了他写的东西。
 */

/** 单个任务的步骤上限。 */
export const MAX_TASK_STEPS = 30

/** 步骤标题长度上限（按去除首尾空白后的字符数计）。 */
export const TASK_STEP_TITLE_MAX = 120

/** 存储载荷的版本号（不认识的版本一律按「读不出来」处理）。 */
export const TASK_STEPS_STORAGE_VERSION = 1

/** 步骤 ID 的长度上限（ID 由界面生成，这里只做有界检查与唯一性检查）。 */
export const TASK_STEP_ID_MAX = 64

/** 原始记录的读取上限；超过就当作不可用（防止一条畸形值把内存撑爆）。 */
const RAW_LIMIT = 60_000

/** 一条步骤。`done` 只是清单上的勾，不会影响父任务。 */
export interface TaskStep {
  id: string
  title: string
  done: boolean
}

/** 落库载荷（版本 + 属于哪条任务 + 版本号 + 步骤）。 */
export interface TaskStepsPayload {
  version: number
  taskId: number
  revision: number
  steps: TaskStep[]
}

/* --------------------------------- 校验 --------------------------------- */

/** 正整数任务 ID（`1`、`2`…；`0` / 负数 / 小数 / 非数字全部不合法）。 */
export function isValidTaskId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * 去掉首尾空白后的标题；空标题返回 `null`（界面会把它标成「要写点什么」）。
 *
 * 超长**不在这里截断**：截断等于替用户改内容。输入侧的上限由
 * {@link clampStepTitleInput}（`maxLength`）保证，写库侧由 {@link validateTaskSteps} 拦住。
 */
export function normalizeStepTitle(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.length === 0 ? null : text
}

/** 输入框用：只做长度封顶，不改变用户已经写下的内容（不 trim，光标不跳）。 */
export function clampStepTitleInput(raw: string): string {
  return typeof raw === 'string' ? raw.slice(0, TASK_STEP_TITLE_MAX) : ''
}

/** 一条步骤的标题合法吗（1–120 字，且首尾没有多余空白才算规范）。 */
export function isValidStepTitle(raw: unknown): boolean {
  const text = normalizeStepTitle(raw)
  return text !== null && text.length <= TASK_STEP_TITLE_MAX
}

export interface TaskStepsValidation {
  ok: boolean
  /** 规范化后的步骤（标题已 trim）；不合法时为 `[]`。 */
  steps: TaskStep[]
  /** 人话原因（第一处问题），可直接展示。 */
  reason: string | null
}

const TITLE_REASON = `每一步都要写 1–${TASK_STEP_TITLE_MAX} 个字（首尾空白会被去掉）。`

/**
 * 校验整份步骤清单。
 *
 * 全部通过才返回 `ok: true`；任何一处不合法都返回**整份**失败，
 * 不返回「能用的那部分」—— 半份清单会让界面显示的内容与用户写的对不上。
 */
export function validateTaskSteps(raw: unknown): TaskStepsValidation {
  if (!Array.isArray(raw)) return { ok: false, steps: [], reason: '步骤清单的格式不对。' }
  if (raw.length > MAX_TASK_STEPS) {
    return { ok: false, steps: [], reason: `最多只能有 ${MAX_TASK_STEPS} 步，现在有 ${raw.length} 步。` }
  }
  const steps: TaskStep[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, steps: [], reason: '步骤清单里有一条不是有效的内容。' }
    }
    const candidate = entry as { id?: unknown; title?: unknown; done?: unknown }
    if (typeof candidate.id !== 'string') return { ok: false, steps: [], reason: '步骤清单里有一条缺少编号。' }
    const id = candidate.id.trim()
    if (id.length === 0 || id.length > TASK_STEP_ID_MAX) {
      return { ok: false, steps: [], reason: '步骤清单里有编号不可用。' }
    }
    if (seen.has(id)) return { ok: false, steps: [], reason: '步骤清单里有重复的编号。' }
    seen.add(id)
    const title = normalizeStepTitle(candidate.title)
    if (title === null || title.length > TASK_STEP_TITLE_MAX) {
      return { ok: false, steps: [], reason: TITLE_REASON }
    }
    if (typeof candidate.done !== 'boolean') {
      return { ok: false, steps: [], reason: '步骤清单里有一条的完成状态不可用。' }
    }
    steps.push({ id, title, done: candidate.done })
  }
  return { ok: true, steps, reason: null }
}

/* ------------------------------ 存储用的编解码 ------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 存进 `app_settings` 的紧凑 JSON（只有版本、父任务、版本号、步骤）。 */
export function encodeTaskSteps(taskId: number, revision: number, steps: readonly TaskStep[]): string {
  const payload: TaskStepsPayload = {
    version: TASK_STEPS_STORAGE_VERSION,
    taskId,
    revision,
    steps: steps.map((step) => ({ id: step.id, title: step.title, done: step.done })),
  }
  return JSON.stringify(payload)
}

export type DecodeTaskStepsResult =
  | { ok: true; taskId: number; revision: number; steps: TaskStep[] }
  | { ok: false; reason: string }

/** 读不出来时的统一说法（界面直接展示，且明确说「原样保留、没有改动」）。 */
export const TASK_STEPS_UNREADABLE_REASON =
  '本机保存的步骤清单读不出来（格式或版本不认识），这条记录会原样保留，暂时无法使用。'

/**
 * 把库里读到的一段 JSON 解析成步骤清单。
 *
 * 严格：版本不认识、父任务 ID 不是正整数、版本号不是正整数、结构不合法、
 * 标题不合法、ID 重复或超限、条数超限 —— 全部判定「读不出来」，
 * 由调用方如实说明并**原样保留**那条原始记录。
 */
export function decodeTaskSteps(raw: unknown): DecodeTaskStepsResult {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  }
  if (raw.length > RAW_LIMIT) return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  if (parsed.version !== TASK_STEPS_STORAGE_VERSION) {
    return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  }
  if (!isValidTaskId(parsed.taskId)) return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  if (typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 1) {
    return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  }
  const validation = validateTaskSteps(parsed.steps)
  if (!validation.ok) return { ok: false, reason: TASK_STEPS_UNREADABLE_REASON }
  return { ok: true, taskId: parsed.taskId, revision: parsed.revision, steps: validation.steps }
}

/* -------------------------------- 进度展示 -------------------------------- */

export interface TaskStepsProgress {
  total: number
  done: number
}

/** 进度计数（`done` 落在 `0..total`，空清单为 `0/0`）。 */
export function progressOf(steps: readonly TaskStep[]): TaskStepsProgress {
  const total = steps.length
  let done = 0
  for (const step of steps) if (step.done) done += 1
  return { total, done: Math.max(0, Math.min(total, done)) }
}

/**
 * 「已完成 / 总数」文案。
 *
 * 空清单**绝不显示 0/0 或 100%**：那种数字会让人以为「已经全部做完了」，
 * 这里明确说「尚未添加步骤」。
 */
export function progressLabel(steps: readonly TaskStep[]): string {
  const { total, done } = progressOf(steps)
  if (total === 0) return '尚未添加步骤'
  return `${done}/${total} 已完成`
}
