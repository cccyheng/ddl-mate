/**
 * 「通知转待办」界面的**纯状态判定**（无 React / 无数据库 / 无网络）。
 *
 * 抽出这一层的原因（复核第 9 条点名的最终安全问题）：
 * 界面上原文输入框在提取之后仍然可以改。如果只用一句「原文已更改」的提示、
 * 却把**当前文本**（B）连同**按旧原文（A）提取出来的候选行**一起保存，
 * 写进库的原文与候选就对不上了。所以这里把两条硬规则做成可单测的纯函数：
 *
 *   1. **原文与提取快照不等 → 不允许保存**（界面按钮禁用 + 事件处理器再拦一次，
 *      两层都要拦；只有确认重新提取之后，快照才会更新成新原文）；
 *   2. **未落库草稿的判定与阶段无关**：`outcome === null` 时只要粘了原文
 *      （哪怕提取结果是 0 条候选）就算草稿，离开前必须提示，不能静默丢掉。
 *
 * 保存时入库的原文一律取**提取快照**（不是当前输入框的文本），
 * 这样「已保存的原文」永远等于「候选行是按哪份原文提取的」。
 */

/** 原文在提取之后被改过时的提示（界面按钮 disabled 与事件处理器共用同一句话）。 */
export const NOTICE_SOURCE_STALE_MESSAGE = '原文已更改，请重新提取后保存。'

export interface NoticeSourceStateInput {
  /** 输入框里当前的原文。 */
  sourceText: string
  /**
   * 当前候选行数。
   *
   * **必须传**（复核第 10 条）：用户提取出候选、改了几行之后把原文清空时，
   * `sourceText` 已经为空，但核对行还在 —— 不能因为「原文空了」就当成没有草稿。
   */
  rowCount: number
  /** 上一次提取时的原文快照；`null` 表示从来没有提取过。 */
  snapshot: string | null
  /** 是否已经成功保存（保存之后不再算草稿，也不该再被盘问）。 */
  committed: boolean
}

/**
 * 原文是否与提取快照不一致（= 候选行已经过期）。
 *
 * 比较是**逐字符**的：前后空白也算改动 —— 原文要逐字留档，`A` 与 `A ` 不是同一份输入。
 */
export function isNoticeSourceStale(snapshot: string | null, sourceText: string): boolean {
  return snapshot !== null && snapshot !== sourceText
}

/**
 * 是否还有**未落库的草稿**（`usePreventRemove` 与「返回」提示都用它）。
 *
 * 判定与阶段无关，并且**逐项**覆盖「用户已经投入过、静默丢掉就再也找不回来」的东西：
 *
 *  1. 原文里还有非空内容（只粘贴了还没提取、或提取出 0 条候选）；
 *  2. 还有**候选行**（哪怕原文被清空了 —— 复核第 10 条点名的回归：
 *     提取 → 改候选 → 清空原文，不能因为 `sourceText` 空了就放行离开）；
 *  3. 曾经提取过（快照非 null）：提取出 0 条候选也是一次真实操作，
 *     留下的是一个「已经看过结果」的状态，离开同样要先确认。
 *
 * 真正空白的初始状态（没原文、没提取、没候选）返回 `false`，不打扰用户。
 */
export function hasUnsavedNoticeDraft(input: NoticeSourceStateInput): boolean {
  if (input.committed) return false
  if (input.sourceText.trim().length > 0) return true
  if (input.rowCount > 0) return true
  return input.snapshot !== null
}

export interface NoticeSaveGuardInput {
  /** 输入框里当前的原文。 */
  sourceText: string
  /** 上一次提取时的原文快照（保存时入库的就是它）。 */
  snapshot: string | null
  /** 当前候选行数。 */
  rowCount: number
  /** 是否已经提交过（提交之后不允许再次保存）。 */
  committed: boolean
}

export interface NoticeSaveGuardResult {
  /** 事件处理器是否允许继续保存流程。 */
  allowed: boolean
  /** 保存按钮是否可点（与 `allowed` 同口径，界面不必再自己拼条件）。 */
  canSave: boolean
  /** 可展示的中文原因（允许保存时为空串）。 */
  reason: string
  /** 入库时必须使用的原文（= 提取快照）。 */
  sourceToPersist: string
  /** 原文与提取快照不一致。 */
  sourceStale: boolean
}

/**
 * 保存前的守卫。**事件处理器必须真的按它拦截**，不能只把按钮变灰。
 *
 * 判定顺序：
 *  1. 已经提交过 → 拒绝（防止重复导入）；
 *  2. 原文与提取快照不一致 → 拒绝，提示重新提取（快照是 `null` 不算不一致）；
 *  3. 一条候选都没有：
 *     - 已经提取过（快照非 null）→ 允许保存 0 条（与仓库「没有勾选」的报错一致，界面会提示）；
 *     - 还没提取过、但粘了原文 → 拒绝并提示先提取（否则用户以为已经导入了）；
 *     - 还没提取过、原文也是空的 → 拒绝（没有任何输入）。
 */
export function noticeSaveGuard(input: NoticeSaveGuardInput): NoticeSaveGuardResult {
  const snapshot = input.snapshot
  const sourceStale = isNoticeSourceStale(snapshot, input.sourceText)
  const result = (allowed: boolean, reason: string): NoticeSaveGuardResult => ({
    allowed,
    canSave: allowed,
    reason,
    sourceToPersist: snapshot ?? input.sourceText,
    sourceStale,
  })

  if (input.committed) return result(false, '这批候选已经保存过了，不需要再保存一次。')
  if (sourceStale) return result(false, NOTICE_SOURCE_STALE_MESSAGE)
  if (input.rowCount === 0) {
    if (snapshot !== null) return result(true, '')
    if (input.sourceText.trim().length > 0) return result(false, '还没有提取候选：请先点「提取任务」。')
    return result(false, '请先粘贴通知原文，再点「提取任务」。')
  }
  return result(true, '')
}

/** 把守卫的拒绝原因接进界面已有的「第 N 行 / 字段」错误表。 */
export function noticeSaveGuardFieldErrors(guard: NoticeSaveGuardResult): Record<string, string> {
  if (guard.allowed) return {}
  return guard.sourceStale ? { sourceText: guard.reason } : { save: guard.reason }
}
