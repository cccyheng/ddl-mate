/**
 * 「每日参考用时」设置区的**纯状态**（无 React / 无数据库）。
 *
 * 这一层存在的理由很具体：
 * 1. **草稿不能被后台刷新冲掉** —— 用户正在输入 `12`（还没打完 `120`）时，
 *    任何一次 store 刷新、任何一次重新渲染都必须保留她的输入，
 *    而且**合法与非法**草稿一视同仁（`abc` 也是她打的字，不能替她改掉）；
 * 2. **但刷新要推进「已保存值」这条基线** —— 否则输入框会永远拿旧基线判断脏不脏，
 *    用户明明保存过了，返回时还会被问「要不要丢弃未保存的修改」；
 * 3. 保存结果必须**区分「没写进去」和「写了但列表没刷新出来」**，
 *    后者如果说成失败，用户会再点一次保存；
 * 4. **已提交的保存一定要让草稿与已保存值对齐**（包括「清除」这个动作），
 *    否则一次成功的清除会留下 `120` 这个旧草稿，看起来还是「脏」的，
 *    下一次刷新甚至可能把它当成用户的新输入写回去。
 *
 * 所有判定都是纯函数，可以在 node 下直接测（见 `tests/studyReference.test.mjs`
 * 与 .supervision 下监督者提供的独立复核脚本）。
 */

import { isStudyReferenceDirty, parseStudyReferenceMinutes, studyReferenceToDraft } from './studyReference'

export interface StudyReferenceDraftState {
  /** 输入框里当前的文本。 */
  draft: string
  /** 上一次**已知的**已保存值（分钟）；`null` = 未设置。 */
  lastSynced: number | null
}

export interface SyncStudyReferenceInput {
  state: StudyReferenceDraftState
  /** 最近一次从存储读到的值（可能来自后台刷新，也可能来自保存成功后的回读）。 */
  observed: number | null
  /** 最近一次保存是否已经提交（提交成功后必须与已保存值对齐）。 */
  committed: boolean
}

export interface SyncStudyReferenceResult {
  state: StudyReferenceDraftState
  /**
   * 状态是否发生了**任何**变化（草稿**或**已保存基线）。
   *
   * 必须是「任一字段变化」而不是只看草稿：界面用它决定要不要 `setState`
   * （`next.changed ? next.state : previous`），只看草稿的话，
   * 「草稿没变、基线变了」这一次更新会被丢掉。
   */
  changed: boolean
  /** 当前草稿是否与已保存值不同。 */
  dirty: boolean
}

/** 草稿文本是否原样保留（不做任何规范化）。 */
function keepDraft(state: StudyReferenceDraftState, observed: number | null): SyncStudyReferenceResult {
  const changed = state.lastSynced !== observed
  const next = changed ? { draft: state.draft, lastSynced: observed } : state
  return {
    state: next,
    changed,
    dirty: isStudyReferenceDirty(next.draft, next.lastSynced),
  }
}

/**
 * 把「存储里观察到的值」同步进草稿。
 *
 * 规则（复核逐条点过）：
 * 1. **已提交的保存**：草稿与已保存值对齐（`draft = observed`，`dirty = false`），
 *    无论有没有草稿内容 —— 保存成功后输入框不该再是脏的；
 * 2. **有未保存的草稿**（与基线不同，合法或非法都算）：**原样保留草稿**，
 *    只把基线推进到 `observed`，并按新基线重算 `dirty`；
 * 3. **干净的草稿**：直接采用 `observed`（例如在别处改了设置，这里要跟着变）。
 */
export function syncStudyReferenceDraft(input: SyncStudyReferenceInput): SyncStudyReferenceResult {
  const { state, observed, committed } = input
  if (committed) {
    const next: StudyReferenceDraftState = { draft: studyReferenceToDraft(observed), lastSynced: observed }
    return {
      state: next,
      changed: next.draft !== state.draft || next.lastSynced !== state.lastSynced,
      dirty: false,
    }
  }
  if (isStudyReferenceDirty(state.draft, state.lastSynced)) {
    return keepDraft(state, observed)
  }
  const nextDraft = studyReferenceToDraft(observed)
  const next: StudyReferenceDraftState = { draft: nextDraft, lastSynced: observed }
  return {
    state: next,
    changed: next.draft !== state.draft || next.lastSynced !== state.lastSynced,
    dirty: false,
  }
}

/** 仓库保存结果里这一层真正需要的字段。 */
export interface StudyReferenceSaveLike {
  ok: boolean
  committed: boolean
  minutes: number | null
  reason: string | null
  refreshError: string | null
}

export interface StudyReferenceResolveResult {
  /** 是否真的写进去了。 */
  committed: boolean
  /** 同步之后的草稿状态。 */
  state: StudyReferenceDraftState
  /** 可直接展示的中文说明；没有需要说明的时候为 `null`。 */
  message: string | null
  /** 说明的语气（成功 / 提醒）。 */
  tone: 'success' | 'warn'
}

/**
 * 把保存结果翻译成「草稿状态 + 一句实话」。
 *
 * - 输入被拒绝（`ok: false`）：**已保存值不变**（`lastSynced` 不动），草稿原样保留，
 *   这样用户改一改就能再存，不需要重打一遍；
 * - 提交成功（**无论随后刷新成功还是失败**）：草稿一律与已保存值对齐
 *   （`minutes === null` → 空草稿）。清除成功之后输入框必须真的变空，
 *   不能还留着旧的 `120` 让用户以为没清掉。
 */
export function resolveStudyReferenceSave(
  state: StudyReferenceDraftState,
  result: StudyReferenceSaveLike,
): StudyReferenceResolveResult {
  if (!result.committed) {
    return {
      committed: false,
      state,
      message: result.reason ?? '这次没有保存：输入不合法。',
      tone: 'warn',
    }
  }
  const next: StudyReferenceDraftState = {
    draft: studyReferenceToDraft(result.minutes),
    lastSynced: result.minutes,
  }
  if (result.refreshError) {
    return {
      committed: true,
      state: next,
      message: '参考用时已经保存到这台手机，但界面上的统计没能重新读取，点「重新读取」即可。',
      tone: 'warn',
    }
  }
  return {
    committed: true,
    state: next,
    message:
      result.minutes === null
        ? '已清除每日参考用时（回到未设置）。'
        : `已保存每日参考用时：${result.minutes} 分钟。`,
    tone: 'success',
  }
}

/**
 * 输入框里的文本是否**允许保存**（其实只是把守卫重新导出，让界面不必再 import 两个模块）。
 *
 * 注意：真正的「脏 / 合法」判定在 `studyReference.ts`，这里是它的一个薄包装，
 * 保证界面只依赖这一层也能拿到一致结论。
 */
export function canSaveStudyReference(draft: string, saved: number | null): boolean {
  const parsed = parseStudyReferenceMinutes(draft)
  return parsed.ok && isStudyReferenceDirty(draft, saved)
}
