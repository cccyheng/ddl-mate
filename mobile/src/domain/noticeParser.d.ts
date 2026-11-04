/**
 * `noticeParser.js` 的类型声明。
 *
 * 为什么是 `.js` + `.d.ts` 而不是 `.ts`：
 * 这份解析器是从 `frontend/src/ocr/noticeParser.js` **逐字节复制**过来的（见
 * `docs/native-notice-import.md` 的「来源与同步」），它带着一批历史回归用例，
 * 任何一次「顺手重写」都可能改掉保守语义。保持原文件不动、只补一层类型，
 * 才能让 `mobile/tests/noticeParserParity.test.mjs` 用 SHA256 证明两边**完全一致**。
 *
 * 这里的类型只描述真实用到的字段，`readonly` / 可选标注与实现保持一致。
 */

export interface NoticeDateTimeSegment {
  kind: 'date' | 'time'
  /** 原始写法（例如 `2026年10月15日`、`22:00`）。 */
  raw: string
  index: number
  length: number
  /** 日期片段的校验结果（不存在或越界的日期为 `false`）。 */
  valid: boolean
  year?: number | null
  month?: number | null
  day?: number | null
  hasYear?: boolean
  prefix?: string
  hour?: number | null
  minute?: number | null
}

export interface NoticeDeadlineCandidate {
  /** `YYYY-MM-DDTHH:mm`（墙上时间，不含偏移）。 */
  year: number
  month: number
  day: number
  hour: number
  minute: number
  raw: string
  index: number
  end: number
}

export interface NoticeIncompleteItem {
  kind: 'date' | 'time' | 'monthDay' | 'day'
  raw: string
  index: number
  /** `no-year` / `no-time` / `no-date` / `invalid-time`。 */
  reason: string
}

export interface NoticeDeadlineOption {
  /** `YYYY-MM-DDTHH:mm`。 */
  value: string
  display: string
  index: number
  /** 是否临近「截止 / 提交」措辞（解析器据此保守地自动填入）。 */
  cued: boolean
}

export interface NoticeDeadlineResult {
  /** `YYYY-MM-DDTHH:mm` 或空串（不确定时**绝不猜**）。 */
  deadline: string
  display: string
  hints: string[]
  options: NoticeDeadlineOption[]
  chatTimesIgnored: boolean
  incomplete: NoticeIncompleteItem[]
  invalid: NoticeDateTimeSegment[]
}

export interface NoticeSegment {
  id: string
  index: number
  text: string
}

export interface ParsedNoticeCandidate {
  segmentId: string
  segmentIndex: number
  /** 这一段的原文（用于展示与留档，**不截断**）。 */
  rawText: string
  title: string
  type: string
  courseId: number | null
  courseName: string
  deadline: string
  deadlineDisplay: string
  deadlineOptions: NoticeDeadlineOption[]
  submitRequirement: string
  submitMethod: string
  hints: string[]
  sourceRef: string | null
  sourceName: string
}

export interface NoticeCourseRef {
  id: number
  name: string
  code?: string | null
}

export interface ParseNoticeOptions {
  courses?: readonly NoticeCourseRef[]
  sourceRef?: string | null
  sourceName?: string
  /** 最多返回多少条候选（解析器内部会先过滤无效段再切片）。 */
  maxTasks?: number
}

export const NOTICE_HINTS: {
  deadlineMissing: string
  deadlineNoYear: string
  deadlineNoTime: string
  deadlineRelative: string
  deadlineInvalid: string
  deadlineAmbiguous: string
  deadlineNotClearlyDeadline: string
  deadlineChatTime: string
  courseUnmatched: string
}

export const WEEKDAY_CN: Record<string, number>

export function validYmd(year: number, month: number, day: number): boolean
export function applyMeridiem(prefix: string, hour: number): number | null
export function findDateTimes(text: unknown): NoticeDateTimeSegment[]
export function combineDateTimes(
  items: readonly NoticeDateTimeSegment[],
  text?: string,
): {
  complete: NoticeDeadlineCandidate[]
  incomplete: NoticeIncompleteItem[]
  invalid: NoticeDateTimeSegment[]
}
export function isChatTimestamp(text: string, item: NoticeDateTimeSegment | NoticeDeadlineCandidate): boolean
export function formatWallClock(value: { year: number; month: number; day: number; hour: number; minute: number }): string
export function extractDeadline(rawText: unknown): NoticeDeadlineResult
export function toOffsetDateTime(localValue: string | null | undefined): string | null
export function normalizeOcrText(text: unknown): string
export function looksLikeChatHeaderLine(line: unknown): boolean
export function chatHeaderEnd(text: unknown): number
export function maskSensitive(text: unknown): { masked: string; restore: (value: string) => string }
export function splitSegments(rawText: unknown): NoticeSegment[]
export function extractTitle(segmentText: unknown): string
export function guessTaskType(text: unknown): string
export function extractSubmitRequirement(text: unknown): { value: string; label: string | null }
export function extractSubmitMethod(text: unknown): string
export function matchCourse(text: unknown, courses?: readonly NoticeCourseRef[]): NoticeCourseRef | null
export function parseNoticeText(rawText: unknown, options?: ParseNoticeOptions): ParsedNoticeCandidate[]
export function isMeaningfulCandidate(candidate: ParsedNoticeCandidate, wholeText?: string): boolean
export function hasRelativeTimeCue(text: unknown): boolean
export function hasActionCue(text: unknown): boolean
export function firstCompleteDeadline(text: unknown): string
export const ACTION_RE: RegExp
export const RELATIVE_DEADLINE_RE: RegExp
export const DEADLINE_CUE_RE: RegExp
export const SEGMENT_START_PATTERNS: RegExp[]
