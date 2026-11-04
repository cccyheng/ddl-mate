/**
 * 通知原文在原样交给**复制来的解析器**之前，做的两层**保守原生适配**。
 *
 * 为什么需要这一层（独立复核给的两个真实缺陷）：
 *   1. 解析器的 `fallbackSegments` 在**没有序号条目、也没有空行**时，会把整个块当成一段，
 *      于是最常见的一种群通知
 *        `数据结构作业：请于2026年10月18日22:00前提交实验报告。`
 *        `英语作业：请于2026年10月19日18:00前提交作文。`
 *      被合成**一条**候选（两门课、两个时间），用户没法核对。
 *      前端是逐张截图分别识别的，所以这个组合在 Web 端从没出现过；
 *      原生端用户会一次粘一整段，因此必须在这里补上边界。
 *   2. 解析器的 `guessTaskType` 会给出 `LAB` / `REPORT` 这类**原生任务类型里没有的**值，
 *      直接当成类型写库是「cast-only」的假映射。
 *
 * 三条自律（授权书与复核都点名要求）：
 *   - **不改复制来的解析器**：所有适配都在本文件里做，`noticeParser.js` 保持逐字节一致；
 *   - **宁可少分，不可错分**：只有「一行是**明显的任务标题行**（短标签 + 冒号，且标签里带
 *     任务名词、不带日期时间、不是附加信息标签）」时才会分；分完还要**每一组都真的有任务线索**
 *     才采纳，否则整块原样交给解析器；
 *   - **原文不动**：分组只决定「哪些行一起解析」，返回的 `text` 是原文切出来的片段
 *     （只裁掉组首尾空白），绝不改写、绝不丢行。
 *
 * 本文件是纯函数：无 React、无数据库、无网络。
 */

import { ACTION_RE, findDateTimes } from './noticeParser'
import type { TaskType } from './types'

/* ------------------------- 1. 独立任务标题行的边界 ------------------------- */

/**
 * 任务标题行允许的**短标签**：以任务名词结尾的短语（`数据结构作业` / `英语实验` / `高数报告`）。
 *
 * 刻意要求「以任务名词**结尾**」：`关于期末考试的通知`、`各位同学请注意` 这类
 * 叙述性开头不会被当成标签。
 */
const HEADING_NOUN_TAIL_RE =
  /(?:作业|习题|练习|实验|报告|论文|作文|课程设计|课设|作品|考试|测验|测验卷|答辩|汇报|展示|演讲|阅读|读书笔记|预习|复习|任务|清单)$/

/** 附加信息标签（`提交要求：…` / `截止时间：…` / `邮箱：…`）：**不是**新任务的标题。 */
const AUXILIARY_LABEL_RE =
  /^(?:提交要求|提交方式|提交时间|提交说明|截止时间|截止|提交|要求|说明|备注|附件|链接|网址|邮箱|邮件|命名|文件命名|主题|格式|时间|地点|对象|范围)$/

/** 短标签 + 分隔符：`数据结构作业：` / `英语实验:`。 */
const HEADING_LINE_RE = /^([^：:]{1,24})[：:]\s*(\S.*)$/

/**
 * 标签必须是**汉字（允许括号/斜杠等排版符号）**。
 *
 * 这条限制让适配层**不碰序号行**：`1. 数据结构作业：…` 的标签会变成
 * `1. 数据结构作业`（含数字与点），因此返回 `false` —— 序号条目交给解析器既有的
 * `SEGMENT_START_PATTERNS` 处理（那是它本来就做得很好的部分）。
 */
const HEADING_LABEL_RE = /^[\u3400-\u9fff][\u3400-\u9fff\s·（）()【】、/・]*$/

/** 纯抬头/署名（`2026年10月8日 08:30 张老师`）不是标题行：里面有日期时间。 */
function hasDateTime(text: string): boolean {
  return findDateTimes(text).length > 0
}

/**
 * 这一行是不是**明显的任务标题行**：`短标签 + 冒号 + 后面还有内容`。
 *
 * 判定条件（全部满足才算，任意一条不满足都返回 `false`）：
 *   - 有冒号，且冒号后面还有文字；
 *   - 标签长度 1–24、**以任务名词结尾**（`数据结构作业`、`英语作文`）；
 *   - 标签里**没有**日期时间（`2026年10月18日 22:00：…` 不是标题）；
 *   - 标签不是「提交要求 / 截止时间」这类**附加信息**标签。
 *
 * 注意：**冒号后面可以带日期时间**，而且这正是最常见的一种写法：
 * `数据结构作业：请于2026年10月18日22:00前提交实验报告。`
 * 标题本身只是「作业 / 实验名」，时间属于这条任务的内容。
 * 所以这里刻意**不**检查整行有没有日期时间（早先那版会因此把这种行判成正文，
 * 两条独立通知又会被合并成一条 —— 独立复核复现过这个缺陷）。
 */
export function looksLikeNoticeTaskHeading(line: unknown): boolean {
  const text = String(line ?? '').trim()
  if (text.length === 0) return false
  const match = HEADING_LINE_RE.exec(text)
  if (!match) return false
  const label = match[1]!.trim()
  if (label.length === 0 || label.length > 24) return false
  if (!HEADING_LABEL_RE.test(label)) return false
  if (AUXILIARY_LABEL_RE.test(label)) return false
  if (hasDateTime(label)) return false
  return HEADING_NOUN_TAIL_RE.test(label)
}

/** 一行里有没有任务线索（动作词或任务名词）；与解析器的判据同源。 */
function hasTaskCue(line: string): boolean {
  return ACTION_RE.test(line) || HEADING_NOUN_TAIL_RE.test(line)
}

/**
 * 折行/连接信号：上一行没写完（`…提交到学习` / `邮箱是`）时，下一行是它的续行，不能分。
 *
 * 与解析器的 `CONTINUE_TAIL_RE` 同思路，但只保留**最保守**的一小组虚词结尾，
 * 避免把「以『请』结尾的标题」也误当成没写完。
 */
const TRAILING_CONTINUE_RE = /(?:发送到|发送至|发到|提交到|上交到|交到|上传到|写到|截至|截止|交给|请|要|需|需要|按照|根据|和|与|及|的|于|给|到)\s*$/

export interface NoticeTaskChunk {
  /** 这一组的原文（原文切出来的片段，只裁掉组首尾空白）。 */
  text: string
  /** 原文里的起始行号（从 0 开始，仅用于测试与排查，不参与业务判定）。 */
  startLine: number
}

/**
 * 把一个「块」（原文里没有空行的一段）按**明显的任务标题行**切成若干组。
 *
 * 切分规则：
 *   - 遇到任务标题行，且**当前组已经够分**（≥12 个字符、或已经两行以上、或当前组本身就是
 *     另一个任务标题行）→ 新起一组；
 *   - 上一行以连接词结尾（`…提交到`）→ 这是折行，继续留在当前组；
 *   - 当前组只有一行短标题（`期末三项任务`）→ 不切，避免把标题行切成独立候选。
 *
 * 返回长度 ≥ 2 时调用方才使用它；否则整块原样交给解析器。
 */
export function splitIndependentNoticeTasks(block: string): NoticeTaskChunk[] {
  const text = String(block ?? '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const groups: Array<{ lines: string[]; startLine: number }> = []
  let current: { lines: string[]; startLine: number } | null = null

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    const isHeading = looksLikeNoticeTaskHeading(trimmed)
    if (current === null) {
      current = { lines: [line], startLine: index }
      return
    }
    const currentText = current.lines.join('\n').trim()
    const currentSubstantial = currentText.length >= 12 || current.lines.length >= 2
    // 连续两行都是任务标题（`数据结构作业一：…` ／ `英语作业二：…`）也算「够分」：
    // 它们各自都是完整的标题行，不存在「标题 + 正文」的从属关系。
    const previousIsHeading = looksLikeNoticeTaskHeading(current.lines[0] ?? '')
    const separable = currentSubstantial || previousIsHeading
    const previousLine = (current.lines[current.lines.length - 1] ?? '').trim()
    const previousContinues = TRAILING_CONTINUE_RE.test(previousLine)
    if (isHeading && separable && !previousContinues) {
      groups.push(current)
      current = { lines: [line], startLine: index }
      return
    }
    current.lines.push(line)
  })
  if (current) groups.push(current)

  return groups
    .map((group) => ({ text: group.lines.join('\n').trim(), startLine: group.startLine }))
    .filter((group) => group.text.length > 0)
}

/**
 * 把原文切成若干**独立任务块**。
 *
 * 外层先按空行分块（与解析器的兜底分段同口径），每块再尝试按任务标题行细分。
 * **只有每一块都真的有任务线索时才采纳细分结果**，否则这一块保持原样 ——
 * 这是「宁可少分，不可错分」的兜底：拆错会让用户看到半句话，不如让他看到一整块再自己改。
 */
export function preSplitNoticeText(rawText: string): NoticeTaskChunk[] {
  const source = String(rawText ?? '').replace(/\r\n?/g, '\n')
  const blocks = source.split(/\n{2,}/)
  const chunks: NoticeTaskChunk[] = []
  let lineCursor = 0

  for (const block of blocks) {
    const trimmedBlock = block.trim()
    if (trimmedBlock.length === 0) {
      lineCursor += block.split('\n').length
      continue
    }
    const groups = splitIndependentNoticeTasks(trimmedBlock)
    if (groups.length >= 2 && groups.every((group) => hasTaskCue(group.text))) {
      for (const group of groups) {
        chunks.push({ text: group.text, startLine: lineCursor + group.startLine })
      }
    } else {
      chunks.push({ text: trimmedBlock, startLine: lineCursor })
    }
    lineCursor += block.split('\n').length
  }

  return chunks
}

/* ---------------------------- 2. 任务类型映射 ---------------------------- */

/**
 * 解析器认识、但**原生任务类型里没有**的取值 → 有意义的原生类型。
 *
 * 映射不是「随便塞一个」：
 *   - `LAB`（实验）→ `PROJECT`（项目/课设类工作），在原生界面上显示为「项目」；
 *   - `REPORT`（报告/论文）→ `PROJECT`（同样是产出物的创作类工作）；
 *   - 其它未知取值 → `OTHER`，绝不猜测它的语义。
 */
const TASK_TYPE_ALIASES: Record<string, TaskType> = {
  LAB: 'PROJECT',
  REPORT: 'PROJECT',
  NOTICE: 'ADMIN',
  ADMIN: 'ADMIN',
}

/** 原生任务类型全集（与 `normalizeTaskDraft` 的校验口径一致）。 */
const NATIVE_TASK_TYPES: readonly TaskType[] = [
  'HOMEWORK',
  'EXAM',
  'PROJECT',
  'READING',
  'PRESENTATION',
  'ADMIN',
  'OTHER',
]

/** 原生任务类型的**中文名**（写进 `Task.type` 备注，让保存结果可核对）。 */
export const NATIVE_TASK_TYPE_LABELS: Record<TaskType, string> = {
  HOMEWORK: '作业',
  EXAM: '考试',
  PROJECT: '项目',
  READING: '阅读',
  PRESENTATION: '展示',
  ADMIN: '事务',
  OTHER: '其它',
}

export interface TaskTypeMapping {
  /** 最终会写进数据库的原生类型（一定在 `NATIVE_TASK_TYPES` 里）。 */
  type: TaskType
  /** 解析器给出的原始类型（保留下来，写进任务备注以便复核）。 */
  sourceType: string
  /** 原始类型是否被映射过（`LAB` → `PROJECT` 之类）。 */
  mapped: boolean
  /** 映射说明（中文，可展示；没映射时为空串）。 */
  note: string
}

/**
 * 把解析器给出的类型**显式映射**成原生任务类型。
 *
 * 绝不 `as TaskType` 硬转：未知取值一律落到 `OTHER` 并如实说明，
 * 这样「解析器新增了类型」不会静默变成一条类型非法的任务。
 */
export function mapNoticeTaskType(raw: unknown): TaskTypeMapping {
  const sourceType = String(raw ?? '').trim()
  if (NATIVE_TASK_TYPES.includes(sourceType as TaskType)) {
    return { type: sourceType as TaskType, sourceType, mapped: false, note: '' }
  }
  const aliased = TASK_TYPE_ALIASES[sourceType]
  if (aliased) {
    return {
      type: aliased,
      sourceType,
      mapped: true,
      note: `解析结果原类型：${sourceType} → 保存为「${NATIVE_TASK_TYPE_LABELS[aliased]}」`,
    }
  }
  return {
    type: 'OTHER',
    sourceType: sourceType.length > 0 ? sourceType : '（空）',
    mapped: true,
    note: `解析结果原类型：${sourceType.length > 0 ? sourceType : '（空）'} → 保存为「其它」`,
  }
}

/** 一段类型备注（写进 `Task.description` 末尾），没有映射时为 `null`。 */
export function taskTypeNote(mapping: TaskTypeMapping): string | null {
  return mapping.mapped ? mapping.note : null
}

/**
 * 只要一段中文映射说明（给没有完整 `TaskTypeMapping` 的调用方用）。
 *
 * `noticeImport.ts` 的行草稿上存的是「解析器原类型」字符串，用它反查同一份映射表，
 * 保证「界面提示里的说明」与「真正写进说明的说明」是同一句话。
 */
export function taskTypeMappingNote(sourceType: string | null | undefined): string | null {
  if (sourceType === null || sourceType === undefined || String(sourceType).length === 0) return null
  return taskTypeNote(mapNoticeTaskType(sourceType))
}
