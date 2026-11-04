/**
 * 学习周报的**页面状态机**（纯函数，可单测，不依赖 React / navigation / 设备时钟）。
 *
 * 这一层刻意从屏幕里抽出来，因为它承担三件容易写错、又必须可验证的事：
 * 1. **周的绝对锚点**：`weekAnchor === null` 表示「跟着当前周走」，所以跨过周日午夜后
 *    当前周会自动前进；用户手动翻到的过去周则记录绝对周一日期，不会漂移。
 * 2. **可回看范围**：当前周 + 之前 51 周，共 52 周；再往前 / 往未来都不行。
 * 3. **翻周 / 换筛选时重置分页**：后台数据刷新不能改写所选周、筛选和当前页。
 *
 * 屏幕只把这些函数的结果渲染出来，不在组件里另写一套周算术或筛选规则。
 */

import {
  LEARNING_REPORT_PAGE_SIZE,
  LEARNING_REPORT_WEEKDAY_LABELS,
  formatLearningReportRate,
  learningWeekHistoryBounds,
  learningWeekOf,
  shiftLearningWeek,
  shortDateKey,
  type LearningReportAnalysis,
  type LearningReportFilter,
  type LearningWeek,
} from '../domain/learningReport'
import type { Weekday as WeekdayNumber } from '../domain/datetime'
import type { Task } from '../domain/types'

/** 页面状态：所选周锚点、当前明细筛选、当前页（从 1 开始）。 */
export interface LearningReportScreenState {
  /** `null` = 跟随当前上海周；否则是所选周的周一（`YYYY-MM-DD`）。 */
  weekAnchor: string | null
  filter: LearningReportFilter | null
  page: number
}

export const initialLearningReportScreenState: LearningReportScreenState = {
  weekAnchor: null,
  filter: null,
  page: 1,
}

export interface LearningReportScreenView {
  currentWeek: LearningWeek
  selectedWeek: LearningWeek
  earliestWeekStart: string
  isCurrentWeek: boolean
  canGoPrevious: boolean
  canGoNext: boolean
}

/**
 * 把「状态 + 现在」解析成实际显示的周。
 *
 * - 锚点为空 → 当前周（跨周自动前进）；
 * - 锚点合法 → 用绝对周一；超出 52 周范围 / 指向未来时夹到边界（不抛错）；
 * - `now` 非法 → `null`，界面显示读取错误，不猜日期。
 */
export function resolveLearningReportScreenView(
  state: LearningReportScreenState,
  now: Date,
): LearningReportScreenView | null {
  const bounds = learningWeekHistoryBounds(now)
  if (!bounds) return null

  let selectedWeek = bounds.current
  if (state.weekAnchor !== null) {
    const anchored = learningWeekOf(state.weekAnchor)
    if (anchored) {
      if (anchored.startDateKey < bounds.earliest.startDateKey) selectedWeek = bounds.earliest
      else if (anchored.startDateKey > bounds.current.startDateKey) selectedWeek = bounds.current
      else selectedWeek = anchored
    }
  }

  return {
    currentWeek: bounds.current,
    selectedWeek,
    earliestWeekStart: bounds.earliest.startDateKey,
    isCurrentWeek: selectedWeek.startDateKey === bounds.current.startDateKey,
    canGoPrevious: selectedWeek.startDateKey > bounds.earliest.startDateKey,
    canGoNext: selectedWeek.startDateKey < bounds.current.startDateKey,
  }
}

/** 上一周。已在最早可回看周时原样返回（按钮同时是 disabled）。 */
export function goToPreviousLearningWeek(
  state: LearningReportScreenState,
  now: Date,
): LearningReportScreenState {
  const view = resolveLearningReportScreenView(state, now)
  if (!view || !view.canGoPrevious) return state
  const target = shiftLearningWeek(view.selectedWeek.startDateKey, -1)
  if (!target) return state
  return { ...state, weekAnchor: target.startDateKey, page: 1 }
}

/**
 * 下一周。当前周已经是上限（按钮 disabled）。
 * 从过去周回到「现在这一周」时把锚点清空，让它继续跟随之后跨周。
 */
export function goToNextLearningWeek(
  state: LearningReportScreenState,
  now: Date,
): LearningReportScreenState {
  const view = resolveLearningReportScreenView(state, now)
  if (!view || !view.canGoNext) return state
  const target = shiftLearningWeek(view.selectedWeek.startDateKey, 1)
  if (!target) return state
  const nextAnchor = target.startDateKey >= view.currentWeek.startDateKey ? null : target.startDateKey
  return { ...state, weekAnchor: nextAnchor, page: 1 }
}

/** 显式「回到本周」：清空绝对锚点，恢复跟随当前周。 */
export function returnToCurrentLearningWeek(
  state: LearningReportScreenState,
): LearningReportScreenState {
  if (state.weekAnchor === null && state.page === 1) return state
  return { ...state, weekAnchor: null, page: 1 }
}

/** 点某个数字 / 某一天 / 某门课：只换筛选，页数回到第 1 页。 */
export function openLearningReportFilter(
  state: LearningReportScreenState,
  filter: LearningReportFilter,
): LearningReportScreenState {
  return { ...state, filter, page: 1 }
}

/** 返回汇总 / 清除筛选：列表消失，回到第 1 页。 */
export function clearLearningReportFilter(
  state: LearningReportScreenState,
): LearningReportScreenState {
  if (state.filter === null && state.page === 1) return state
  return { ...state, filter: null, page: 1 }
}

/** 当前视图是「汇总」还是「选中任务的明细」；明细模式只保留周导航 + 任务 + 返回汇总。 */
export type LearningReportScreenMode = 'summary' | 'detail'

export function learningReportScreenMode(state: LearningReportScreenState): LearningReportScreenMode {
  return state.filter === null ? 'summary' : 'detail'
}

/** 筛选的稳定 key：只用于「换筛选就回到顶部」，不参与业务计算。 */
export function learningReportFilterKey(filter: LearningReportFilter): string {
  switch (filter.kind) {
    case 'completedDay':
      return `completedDay:${filter.weekday}`
    case 'course':
      return `course:${filter.courseId === null ? 'none' : filter.courseId}`
    default:
      return filter.kind
  }
}

/**
 * 屏幕滚动重置 key：模式 / 筛选 / 所选周 / 页码任一变化都换 key，
 * 从而用**局部** keyed ScreenScaffold 回到顶部；后台数据刷新不改变它。
 */
export function learningReportScrollResetKey(
  state: LearningReportScreenState,
  view: LearningReportScreenView,
): string {
  return [
    learningReportScreenMode(state),
    view.selectedWeek.startDateKey,
    String(state.page),
    state.filter ? learningReportFilterKey(state.filter) : 'none',
  ].join('|')
}

/** 「本周」只用于当前周；看历史周时统一说「所选周」，避免把历史数据说成本周。 */
export function learningReportPeriodLabel(view: LearningReportScreenView): string {
  return view.isCurrentWeek ? '本周' : '所选周'
}

/* ----------------------------- 小屏日柱布局 ----------------------------- */

/**
 * 7 个日柱在 320pt 宽的手机上放不进一行（每列还要 >=44pt 触控目标），
 * 因此按 22% 基准宽度换行成 4 + 3 两行。这个纯函数让「是否真的放得下」
 * 可以被测试算出来，而不是只写在注释里。
 */
export const LEARNING_REPORT_DAY_COLUMN_BASIS_PERCENT = 22
export const LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH = 44
export const LEARNING_REPORT_DAY_COLUMN_GAP = 8

export interface LearningReportDayColumnLayout {
  columnWidth: number
  columnsPerRow: number
  rows: number
}

export function learningReportDayColumnLayout(
  contentWidth: number,
  dayCount: number = 7,
): LearningReportDayColumnLayout {
  const safeDayCount = Number.isInteger(dayCount) && dayCount > 0 ? dayCount : 7
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) {
    return { columnWidth: LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH, columnsPerRow: 1, rows: safeDayCount }
  }
  const nominal = (contentWidth * LEARNING_REPORT_DAY_COLUMN_BASIS_PERCENT) / 100
  const columnWidth = Math.max(LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH, nominal)
  const columnsPerRow = Math.max(
    1,
    Math.floor((contentWidth + LEARNING_REPORT_DAY_COLUMN_GAP) / (columnWidth + LEARNING_REPORT_DAY_COLUMN_GAP)),
  )
  return { columnWidth, columnsPerRow, rows: Math.ceil(safeDayCount / columnsPerRow) }
}

/** 任务明细每页条数（有界渲染）。 */
export function learningReportPageCount(
  totalItems: number,
  pageSize: number = LEARNING_REPORT_PAGE_SIZE,
): number {
  if (!Number.isFinite(totalItems) || totalItems <= 0) return 1
  const safePageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : LEARNING_REPORT_PAGE_SIZE
  return Math.max(1, Math.ceil(totalItems / safePageSize))
}

/** 把任意页码夹到 `1..pageCount`；非法数字回到第 1 页。 */
export function clampLearningReportPage(
  page: number,
  totalItems: number,
  pageSize: number = LEARNING_REPORT_PAGE_SIZE,
): number {
  const pageCount = learningReportPageCount(totalItems, pageSize)
  if (!Number.isFinite(page)) return 1
  const integer = Math.trunc(page)
  return Math.min(Math.max(1, integer), pageCount)
}

/** 当前页的数据（只渲染这一页，避免一次铺开 52 周或整周任务）。 */
export interface LearningReportPageSlice {
  items: Task[]
  page: number
  pageCount: number
  total: number
  pageSize: number
}

export function paginateLearningReportTasks(
  tasks: readonly Task[],
  requestedPage: number,
  pageSize: number = LEARNING_REPORT_PAGE_SIZE,
): LearningReportPageSlice {
  const safePageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.floor(pageSize) : LEARNING_REPORT_PAGE_SIZE
  const total = tasks.length
  const pageCount = learningReportPageCount(total, safePageSize)
  const page = clampLearningReportPage(requestedPage, total, safePageSize)
  const start = (page - 1) * safePageSize
  return { items: tasks.slice(start, start + safePageSize), page, pageCount, total, pageSize: safePageSize }
}

/** 翻页：越界时原样返回（按钮同时是 disabled）。 */
export function setLearningReportPage(
  state: LearningReportScreenState,
  requestedPage: number,
  totalItems: number,
): LearningReportScreenState {
  const nextPage = clampLearningReportPage(requestedPage, totalItems)
  if (nextPage === state.page) return state
  return { ...state, page: nextPage }
}

/** 明细区的标题 / 说明 / 空状态文案；全部由筛选 + 同一份分析结果派生。 */
export interface LearningReportFilterDescription {
  heading: string
  subtitle: string
  emptyText: string
}

function courseFilterLabel(
  analysis: LearningReportAnalysis,
  courseId: number | null,
): string {
  if (courseId === null) return '未关联课程'
  const group = analysis.courseGroups.find((entry) => entry.courseId === courseId)
  if (!group) return '这门课'
  if (group.missingCourse) return '课程已删除'
  return group.courseName ?? '未命名课程'
}

export function describeLearningReportFilter(
  filter: LearningReportFilter,
  view: LearningReportScreenView,
  analysis: LearningReportAnalysis,
): LearningReportFilterDescription {
  const periodLabel = learningReportPeriodLabel(view)
  switch (filter.kind) {
    case 'completedThisWeek':
      return {
        heading: `${periodLabel}完成的任务`,
        subtitle: `只算现在状态为已完成、完成时间落在${periodLabel}内且不晚于现在的任务。`,
        emptyText: `${periodLabel}还没有完成记录。`,
      }
    case 'doneMissingCompletion':
      return {
        heading: '完成时间缺失或无法识别的已完成任务',
        subtitle: '这些任务现在是已完成，但没有可用的完成时间；周报不会补一个时间。',
        emptyText: '没有完成时间缺失或无法识别的任务。',
      }
    case 'due':
      return {
        heading: `${periodLabel}到期的任务`,
        subtitle: `按截止日期的上海自然日归入${periodLabel}；已取消的任务不计入。`,
        emptyText: `${periodLabel}没有到期任务。`,
      }
    case 'dueDone':
      return {
        heading: `${periodLabel}到期且已完成的任务`,
        subtitle: `完成率按${periodLabel}全部到期任务计算；当前 ${formatLearningReportRate(analysis.dueCompletionRate)}。`,
        emptyText: `${periodLabel}到期的任务里还没有已完成的。`,
      }
    case 'dueOpen':
      return {
        heading: `${periodLabel}到期且未完成的任务`,
        subtitle: `含已逾期 ${analysis.overdueNow.length} 条；未完成包含待办与进行中。`,
        emptyText: `${periodLabel}到期的任务都已经完成。`,
      }
    case 'overdue':
      return {
        heading: `${periodLabel}到期且已逾期的任务`,
        subtitle: '现在仍是待办或进行中，且已经过截止时间；只到日期的截止按当天结束计算。',
        emptyText: `${periodLabel}到期的未完成任务里没有已逾期的。`,
      }
    case 'completedDay': {
      const day = analysis.days.find((entry) => entry.weekday === filter.weekday)
      const label = LEARNING_REPORT_WEEKDAY_LABELS[filter.weekday - 1] ?? '这一天'
      return {
        heading: day ? `${label}（${shortDateKey(day.dateKey)}）完成的任务` : `${label}完成的任务`,
        subtitle: `范围 ${view.selectedWeek.startDateKey} ～ ${view.selectedWeek.endDateKey}，只算完成时间落在这一天的任务。`,
        emptyText: day && day.completedCount === 0 ? '这一天没有完成记录。' : '没有对应任务。',
      }
    }
    case 'course': {
      const label = courseFilterLabel(analysis, filter.courseId)
      const group = analysis.courseGroups.find((entry) => entry.courseId === filter.courseId)
      return {
        heading: `${label} · ${periodLabel}到期`,
        subtitle: group
          ? `到期 ${group.dueTotal} 条 · 已完成 ${group.dueDone} · 未完成 ${group.dueOpen}（其中已逾期 ${group.overdue}）。`
          : `这门课${periodLabel}没有到期任务。`,
        emptyText: `这门课${periodLabel}没有到期任务。`,
      }
    }
    default:
      return { heading: '任务明细', subtitle: '', emptyText: '没有对应任务。' }
  }
}

/** 周范围短标签，例如 `10-12 ～ 10-18`。 */
export function formatLearningWeekRange(week: LearningWeek): string {
  return `${shortDateKey(week.startDateKey)} ～ ${shortDateKey(week.endDateKey)}`
}

/** 周几的数字（1..7）→ 中文短名；防御非法值。 */
export function learningWeekdayLabel(weekday: WeekdayNumber): string {
  return LEARNING_REPORT_WEEKDAY_LABELS[weekday - 1] ?? '未知'
}
