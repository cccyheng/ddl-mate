/**
 * 「结构性标签」识别：星期 / 日期 / 时刻 / 节次 / 课表界面的导航与栏目标题。
 *
 * 为什么需要单独一层：
 *   课表照片里除了真正的课程卡片，还有**表头行**（周一…周日、10/12…）与**左侧时间栏**
 *   （节次 1…10、08:00–09:35）。当几何定位没匹配上、回退到整图识别时，OCR 最容易读准的
 *   恰恰是这些高对比度的表头文字，于是「周一」「08:00」有可能被当成课程名导进用户课表。
 *   这一层用来**在任何边界上识别并拦掉这类纯标签**。
 *
 * 铁律（与任务书一致）：
 *   - 只拦「**整段文字就是**结构性标签」的情况，绝不做「含某个字就拦」的粗暴过滤；
 *   - 所以 `数字信号处理`、`时间序列分析`、`星期一的科学`、`面向对象程序设计(C++)`
 *     `大学英语(3)`、`概率论与数理统计`、`C++程序设计`、`数学分析2` 都必须原样通过；
 *   - 本模块是**纯函数**（不依赖 DOM / canvas / Node / React Native），因此：
 *       * 手机端（Metro 打包）从 `mobile/src/domain/headerLabels.ts` 直接引用；
 *       * 伴侣服务与前端（Vite / Node）引用 `frontend/src/ocr/structuralLabels.js`，
 *         那个文件**只是这个文件的转发**，两边永远是同一份行为。
 */

/** 「周/週/星期/礼拜 + 一二三四五六日天 或 数字」的完整星期标签。 */
const WEEKDAY_LABEL_RE = /^(?:周|週|星期|礼拜)\s*(?:[一二三四五六日天]|[1-7１-７]|ニ|二)$/

/** 教材/教务常见的「第 N 周」「第 1-16 周」「1-16周」这类周次标签。 */
const WEEK_LABEL_RE = /^第?\s*\d{1,2}\s*(?:[-–—~〜至到]\s*\d{1,2}\s*)?周$/

/** 纯日期：「10/12」「10-12」「10.12」「10月12日」「2026-10-12」。 */
const DATE_LABEL_RE = /^(?:20\d{2}\s*[-/.年]\s*)?\d{1,2}\s*[-/.月]\s*\d{1,2}\s*[日号]?$/

/** 只有「日」的日期标签：「12日」「3号」。 */
const DAY_LABEL_RE = /^\d{1,2}\s*[日号]$/

/** 纯时刻：「08:00」「8：00」「08:00-09:35」「08:00~09:35」。 */
const TIME_LABEL_RE = /^\d{1,2}\s*[:：]\s*\d{2}(?:\s*[-–—~〜至到]\s*\d{1,2}\s*[:：]\s*\d{2})?$/

/** 纯节次：「1」「10」（1–12 节）。 */
const PERIOD_LABEL_RE = /^\d{1,2}$/

/** 节次范围：「第1-2节」「1-2节」「1、2节」「1至2节」（节号必须在 1–12 内）。 */
const PERIOD_RANGE_RE = /^第?\s*(\d{1,2})\s*[-–—~〜至到、,，]\s*(\d{1,2})\s*节$/

/** 课表界面上的栏目标题 / 导航 / 星期几栏名（整段相等才算）。 */
const CONTAINER_LABELS = new Set([
  '课表',
  '课程表',
  '上课时间',
  '时间',
  '节次',
  '星期',
  '周次',
  '教学周',
  '日期',
  '上午',
  '下午',
  '晚上',
  '上一周',
  '下一周',
  '上週',
  '下週',
  '本周',
  '本月',
  '今天',
  '返回',
])

/** 只去掉「一定是噪声」的字符（空白、竖线、点号），保留 : - / 这类有语义的分隔符。 */
const NOISE_RE = /[\s|｜¦丨·・•]+/g
/** 连装饰带分隔符一起去掉，用于「整段只有标点/线条」的判断。 */
const DECORATION_RE = /[\s|｜¦丨·、,，.。:：;；~〜\-–—_/\\()（）[\]【】<>《》]+/g

function stripNoise(text: unknown): string {
  return String(text ?? '')
    .replace(NOISE_RE, '')
    .trim()
}

function stripDecoration(text: unknown): string {
  return String(text ?? '')
    .replace(DECORATION_RE, '')
    .trim()
}

export type StructuralLabelKind = 'weekday' | 'week' | 'date' | 'time' | 'period' | 'container' | null

/**
 * 「整段只有标签」判定（**通用**，不写死任何一种组合）。
 *
 * 表头行与左侧时间栏经常被 OCR 拼成一行（有时连分隔符都丢了）：
 *   - `周一 | 10/12`、`周一 周二 周三`、`08:00 08:45`、`10/12 10/13 10/14`、
 *     `课表 | 第7周 | 上一周 | 下一周`；
 *   - 分隔符被 OCR 吃掉之后的粘连形态：`课表第7周上一周下一周`、`周一10/12`、`08000845`。
 *
 * 判定方式：用一个"标签片段"正则把整段**完整覆盖**地切出来（所有片段头尾相接正好等于原文），
 * 才算纯标签。只要出现一个切不出来的字（`数字信号处理`、`数学分析2`、`教三305`、
 * `10月12日作业讲评`），覆盖就不完整 → 不是标签，真实课程名因此不会被误伤。
 */
const LABEL_PART_PATTERN = [
  // 先长后短：完整时刻区间要优先于单独时刻被吃掉。
  '\\d{1,2}\\s*[:：]\\s*\\d{2}(?:\\s*[-–—~〜至到]\\s*\\d{1,2}\\s*[:：]\\s*\\d{2})?',
  '(?:周|週|星期|礼拜)\\s*(?:[一二三四五六日天]|[1-7１-７]|ニ)',
  '第?\\s*\\d{1,2}\\s*[-–—~〜至到]\\s*\\d{1,2}\\s*周',
  '第?\\s*\\d{1,2}\\s*周',
  '第?\\s*\\d{1,2}\\s*[-–—~〜至到、,，]\\s*\\d{1,2}\\s*节',
  '(?:20\\d{2}\\s*[-/.年]\\s*)?\\d{1,2}\\s*[-/.月]\\s*\\d{1,2}\\s*[日号]?',
  '[|｜¦丨·・•]',
].join('|')

/** 需要整段相等才算的栏目标题（课表 / 上一周 / 节次 …）。 */
const CONTAINER_PATTERN = [...CONTAINER_LABELS].sort((a, b) => b.length - a.length).join('|')

/** 只有纯标签才能拼出的整段（含栏目标题）。 */
const FULL_LABEL_RE = new RegExp(`^(?:(?:${LABEL_PART_PATTERN})|(?:${CONTAINER_PATTERN}))+$`)

/** 单个 token（已被分隔符切开）是不是标签：星期 / 周次 / 日期 / 时刻 / 节次。 */
function classifySingleLabel(token: unknown): StructuralLabelKind {
  const value = String(token ?? '').trim()
  if (!value) return null
  if (WEEKDAY_LABEL_RE.test(value)) return 'weekday'
  if (WEEK_LABEL_RE.test(value)) return 'week'
  if (DATE_LABEL_RE.test(value)) return 'date'
  if (DAY_LABEL_RE.test(value)) {
    const day = Number(value.replace(/[日号]$/, ''))
    if (day >= 1 && day <= 31) return 'date'
  }
  if (TIME_LABEL_RE.test(value)) return 'time'
  const range = value.match(PERIOD_RANGE_RE)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (start >= 1 && start <= 12 && end >= 1 && end <= 12) return 'period'
  }
  if (CONTAINER_LABELS.has(value)) return 'container'
  if (PERIOD_LABEL_RE.test(value)) {
    const period = Number(value)
    if (period >= 1 && period <= 12) return 'period'
  }
  return null
}

/**
 * 判断一段文字是不是**纯结构性标签**。
 *
 * @param raw 已去掉 `@地点` 的课程名文本
 * @returns 标签类型；不是标签时返回 `null`（= 可以当课程名）
 */
export function classifyStructuralLabel(raw: unknown): StructuralLabelKind {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const compacted = text.replace(/\s+/g, '')
  const label = stripNoise(text)
  if (!compacted || !label) return null

  // 1) 单个精确标签（最稳，先判）。
  const single = classifySingleLabel(compacted)
  if (single) return single

  // 2) 整段由标签拼成（含竖线/空格分隔，以及分隔符被 OCR 吃掉的粘连形态）。
  if (FULL_LABEL_RE.test(compacted)) return 'weekday'

  // 3) 逐段判定：允许「空格 / 竖线」分隔的多段标签，每一段都必须完整是标签。
  const segments = text
    .split(/[|｜¦丨·・•]+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length > 1) {
    const everySegmentIsLabels = segments.every((segment) => {
      const tokens = segment.split(/\s+/).filter(Boolean)
      if (!tokens.length) return false
      return tokens.every((token) => FULL_LABEL_RE.test(token.replace(/\s+/g, '')))
    })
    if (everySegmentIsLabels) return 'weekday'
  }

  // 4) 单个段里全是标签 token（「周一 周二」这种没有竖线的表头行）。
  const singleSegment = segments.length === 1 ? segments[0] : undefined
  if (singleSegment !== undefined) {
    const tokens = singleSegment.split(/\s+/).filter(Boolean)
    if (tokens.length > 1 && tokens.every((token) => classifySingleLabel(token))) return 'weekday'
  }

  if (WEEKDAY_LABEL_RE.test(label)) return 'weekday'
  if (WEEK_LABEL_RE.test(label)) return 'week'
  if (DATE_LABEL_RE.test(stripDecoration(compacted))) return 'date'
  if (TIME_LABEL_RE.test(label)) return 'time'
  if (CONTAINER_LABELS.has(stripDecoration(compacted))) return 'container'
  return null
}

/** 便捷布尔版：是不是纯结构性标签。 */
export function isStructuralLabel(raw: unknown): boolean {
  return classifyStructuralLabel(raw) !== null
}

/** 候选行（只用到这两个字段，保持结构兼容：解析器、周视图、导入校验都能传自己那一种）。 */
export interface StructuralCandidateLike {
  name?: string | null
  location?: string | null
}

/**
 * 一条候选是不是「只有结构性标签、没有真课程内容」。
 *
 * 只依据**候选自己的字段**判断（名称 + 地点），不看外部上下文，
 * 因此对「列表 / 表格 / 周视图」三种来源都适用。
 */
export function isStructuralCandidate(candidate: StructuralCandidateLike | null | undefined): boolean {
  if (!candidate) return false
  const name = String(candidate.name ?? '').trim()
  if (!name) return false
  // 有地点说明读到的是一块课程卡片，不是表头文字。
  if (String(candidate.location ?? '').trim()) return false
  return isStructuralLabel(name)
}

/** 把卡片 OCR 的多行文本压成一行（行与行之间保留一个空格，避免把两行粘成一个词）。 */
function joinCardLines(text: unknown): string {
  return String(text ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
}

/** 剥掉名称里的地点部分（`名称@地点` → `名称`）。 */
export function namePartOf(text: unknown): string {
  return String(text ?? '').split(/[@＠©®]/)[0] ?? ''
}

/**
 * 表头单元格文字专用（比候选宽松：这里还没有"名称 / 地点"的切分）。
 *
 * 卡片区域里读出来的多行文字先按 `parseCardText` 的规则拼成一段，
 * 再看它是不是纯标签 —— 多行拼接正是"周一\n10/12"变成表头组合的路径。
 */
export function isHeaderCardText(rawText: unknown): boolean {
  if (rawText === null || rawText === undefined) return false
  const text = joinCardLines(rawText)
  if (!text) return false
  if (isStructuralLabel(text)) return true
  const name = namePartOf(text)
  if (isStructuralLabel(name)) return true
  return isStructuralLabel(joinCardLines(name))
}

export interface HeaderOnlyResult {
  headerOnly: boolean
  total: number
  structural: number
}

/**
 * 「整批候选全是结构性标签」判定。
 *
 * 用于最外层兜底：当解析器/识别流水线无论如何还是产出了一批候选时，
 * 只要它们**全部**是表头/时间栏标签，就不能当成「识别成功」，
 * 必须给出明确失败（见 `OcrLayoutError`）。
 *
 * 刻意不猜具体是哪一种标签，也不因为「数量少」就拒绝 —— 一门课也是合法结果。
 */
export function isHeaderOnlyResult(candidates: readonly StructuralCandidateLike[] | null | undefined): HeaderOnlyResult {
  const list = Array.isArray(candidates) ? candidates : []
  const named = list.filter((candidate) => String(candidate?.name ?? '').trim())
  if (named.length === 0) return { headerOnly: false, total: 0, structural: 0 }
  const structural = named.filter((candidate) => isStructuralCandidate(candidate)).length
  return { headerOnly: structural === named.length, total: named.length, structural }
}

export interface OcrLayoutErrorOptions {
  code?: string
  layout?: string
  headerOnly?: number
  candidateCount?: number
}

/** 供调用方统一抛出：识别结果里只有表头/时间栏，没有真正的课程。 */
export class OcrLayoutError extends Error {
  readonly code: string
  readonly layout: string
  readonly headerOnly: number
  readonly candidateCount: number

  constructor(message: string, options: OcrLayoutErrorOptions = {}) {
    super(message)
    this.name = 'OcrLayoutError'
    this.code = options.code ?? 'STRUCTURE_NOT_FOUND'
    this.layout = options.layout ?? 'unknown'
    this.headerOnly = options.headerOnly ?? 0
    this.candidateCount = options.candidateCount ?? 0
  }
}

/** 只有表头/时间栏时的统一失败文案（手机端会原样展示给用户）。 */
export const HEADER_ONLY_MESSAGE =
  '只读到课表的表头与时间栏文字（星期、日期、节次、时刻），没有读到真正的课程卡片。' +
  '请重新截取或拍摄课表内容区域（让课程方块尽量占满画面）后再试一次；也可以直接手动添加课程。'
