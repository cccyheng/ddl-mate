/**
 * DDL 压力分析（**纯函数**，无 React / 无数据库 / 无网络 / 无 AI）。
 *
 * 这份代码要回答的问题只有一个：
 *
 * > 从今天（北京时间）起的 **7 个自然日**里，每一天有多少个「还在进行中」的任务到期、
 * > 它们的**原始预计用时**加起来是多少、有没有人漏填预计用时、哪天属于「扎堆」。
 *
 * 它**不是**日程表，也**不是**可行性判断：
 * - 汇总的是**任务自己填的原始预计用时**，不是「还剩多少要干」；
 *   正在进行（DOING）的任务进度**没有被测量**，它的预计用时按全额计入；
 * - 「参考用时」是用户**可选**填的一个每日学习参考值，分析只做算术比较，
 *   不会替用户排计划、不会自动扣掉上课时间、也不会去数「一晚上能挤出几小时」；
 * - 预计用时缺失时不猜、不补 0：那一天标记为**不完整**，绝不显示成「足够 / 安全」。
 *
 * 时间口径与全 App 一致：一切按 **Asia/Shanghai** 墙上时间分组与比较，
 * 手机的设备时区（UTC / 纽约 / …）不参与任何计算。
 *
 * 「现在」**必须由调用方注入**（`now: Date`），因此测试可以用固定时刻复现任意边界；
 * 本文件里没有任何隐式的 `new Date()`。
 */

import {
  addDaysToDateKey,
  dateKeyToDayNumber,
  deadlineToEpochMs,
  deadlineToShanghaiDateKey,
  isDeadlineOverdue,
  shanghaiToday,
  weekdayOfDateKey,
  type Weekday,
} from './datetime'
import { REFERENCE_MINUTES_MAX, REFERENCE_MINUTES_MIN, readStoredStudyReferenceMinutes } from './studyReference'
import type { Task } from './types'

/** 分析窗口长度：含今天在内共 7 个上海自然日。 */
export const PRESSURE_WINDOW_DAYS = 7

/**
 * 「扎堆（集中）」阈值：**某一天**有 >= 3 个进行中的截止任务。
 *
 * 这是一个**刻意显式写出**的常量，界面必须把「3 个及以上」这句话显示出来，
 * 否则用户无法判断高亮是什么意思。
 */
export const CONCENTRATION_THRESHOLD = 3

/** 未填预计用时的任务在每天里的「未知」标记（界面文案用，不参与算术）。 */
export const UNKNOWN_ESTIMATE_LABEL = '缺预计用时'

/**
 * 某一天的参考比较结论。
 *
 * - `empty`：这一天没有进行中的截止任务（**不安慰、也不报警**）；
 * - `exceeds`：已填预计用时之和 > 参考用时（差值是真实数字）；
 * - `within`：已填预计用时之和 <= 参考用时；**相等不算超标**；
 * - `incomplete`：**还有没填预计用时的任务**，因此「没超过」不能当作「时间一定够」；
 * - `unset`：用户还没有设置参考用时（默认状态，绝不替用户编一个）。
 *
 * 优先级：`empty` > `exceeds` > `unset` > `incomplete` > `within`。
 * 也就是说：**先看有没有超标**（超标与缺用时可以同时成立，界面会同时披露），
 * 再看有没有参考值可比较，最后才判断「没超标」到底可不可信。
 * 参考用时未设置时，缺预计用时的事实仍然通过 `unknownEstimateCount`
 * 与汇总里的 `hasUnknownEstimates` 如实披露，不会被藏起来。
 */
export type PressureStatus = 'empty' | 'unset' | 'within' | 'incomplete' | 'exceeds'

/** 单个任务在分析里的归类，用来证明每一天的计数互不重叠。 */
export type PressureBucket =
  /** 进行中 + 有 DDL + **已过 now**（包括今天更早的时刻）。 */
  | 'overdue'
  /** 进行中 + DDL 在今天、且不早于 now。 */
  | 'today'
  /** 进行中 + DDL 在第 2..7 天。 */
  | 'window'
  /** 进行中 + DDL 在第 8 天及以后（在窗口之外，单独披露条数）。 */
  | 'beyond'
  /** 进行中但没有 DDL。 */
  | 'missing'
  /** 进行中但 DDL 存的是不可解析的脏值 —— 需要用户去修，**不猜**是哪一天。 */
  | 'malformed'
  /** DONE / CANCELLED：完全不计入压力分析。 */
  | 'inactive'

/** 按上海自然日聚合出来的一天。 */
export interface PressureDay {
  /** `YYYY-MM-DD`（上海）。 */
  dateKey: string
  weekday: Weekday | null
  isToday: boolean
  /** 这一天到期的进行中任务数（DDL 归到这一天）。 */
  taskCount: number
  /**
   * **已填**预计用时之和（分钟）。
   * 缺少预计用时或脏值的任务按「未知」处理，**不按 0 计入**。
   */
  knownMinutes: number
  /** 缺失（或脏值）预计用时的任务数。 */
  unknownEstimateCount: number
  /** 这一天**最早**的进行中截止时刻（带偏移的 ISO）；没有则为 `null`。 */
  earliestDeadline: string | null
  /** 是否扎堆（`taskCount >= CONCENTRATION_THRESHOLD`）。 */
  concentrated: boolean
  /** 实际的扎堆阈值（界面要显式写出来）。 */
  concentrationThreshold: number
  /** 比较结论（见 {@link PressureStatus}）。 */
  status: PressureStatus
  /** 超过参考用时的分钟数（`status === 'exceeds'` 时 > 0，否则为 0）。 */
  excessMinutes: number
  /** 比对用的参考用时；未设置时为 `null`。 */
  referenceMinutes: number | null
  /** 这一天到期的全部进行中任务（按截止时刻升序，未填预计用时的也在这里）。 */
  tasks: Task[]
}

/** 分析用的扁平输入：任务 + 可选的每日参考用时 + 注入的「现在」。 */
export interface PressureAnalysisInput {
  tasks: readonly Task[]
  /** 用户设置的每日参考用时（分钟）；`null` / 未设置 = 不比较。 */
  referenceMinutes?: number | null
  /** 注入的「现在」；决定「已逾期」的分界与窗口起点。 */
  now: Date
}

export interface PressureAnalysis {
  /** 窗口第一天 = 上海今天。 */
  windowStartDateKey: string
  /** 窗口最后一天（含）。 */
  windowEndDateKey: string
  /** 窗口的**排他**上界：第 8 天（DDL >= 这一天即「7 天之外」）。 */
  windowEndExclusiveDateKey: string
  windowDays: number
  /** 窗口内 7 天，顺序固定（今天在前）。 */
  days: PressureDay[]
  /** 已过 now 的进行中任务（窗口内与今天更早的都在这里，**不再算进任何一天**）。 */
  overdue: Task[]
  /** 进行中但没有 DDL（永远不出现在任何一天里）。 */
  missingDeadline: Task[]
  /** 进行中但 DDL 是无法解析的脏值 —— 需要修复，不猜日期。 */
  malformedDeadline: Task[]
  /** DDL 在第 8 天及以后的进行中任务（窗口外，只披露条数）。 */
  beyondWindow: Task[]
  /** 窗口 7 天内到期的进行中任务总数（= 各天 taskCount 之和）。 */
  includedCount: number
  /** 窗口内已填预计用时之和（分钟）。 */
  includedKnownMinutes: number
  /** 窗口内缺预计用时的任务数。 */
  includedUnknownEstimateCount: number
  /** 进行中任务总数（= included + overdue + missing + malformed + beyond）。 */
  activeCount: number
  /** DONE / CANCELLED 的任务数（只用于说明「已排除」）。 */
  excludedInactiveCount: number
  /** 参考用时（分钟）；未设置 = `null`。 */
  referenceMinutes: number | null
  /** 是否**任何一天**都有任务（没有任务时界面该引导去新建任务）。 */
  hasAnyTask: boolean
  /** 窗口内是否存在缺预计用时的情况（含脏值）。 */
  hasUnknownEstimates: boolean
  /** 是否存在需要用户处理的 DDL 数据问题（缺 DDL / 脏 DDL）。 */
  hasDeadlineIssues: boolean
}

/**
 * 预计用时的合法范围 —— **与任务表单（`normalizeTaskDraft`）完全一致**。
 *
 * 保持一致的动机很直接：如果分析层用一套更严的口径，用户在表单里填的合法值
 * 会在统计里被当成「未填」，界面就会显示一个假的「不完整」。
 * `0` 是**合法**输入，代表用户明确写了「预计 0 分钟」。
 */
export const ESTIMATED_MINUTES_MIN = 0
export const ESTIMATED_MINUTES_MAX = 100_000

/** 仅当它是范围内的整数分钟时才认为「已填预计用时」；`null` / 负数 / 小数 / NaN / 越界 / 脏字符串一律按未知。 */
function estimateMinutesOf(task: Pick<Task, 'estimatedMinutes'>): number | null {
  const value = task?.estimatedMinutes
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < ESTIMATED_MINUTES_MIN || value > ESTIMATED_MINUTES_MAX) return null
  return value
}

/**
 * 界面用的同一个口径：返回「已填的分钟数」或 `null`（未知）。
 *
 * 导出它是为了让界面文案**不再自己判断**（历史缺陷：用真值判断会把合法的 `0` 说成「未填」）。
 */
export function knownEstimateMinutesOf(task: Pick<Task, 'estimatedMinutes'>): number | null {
  return estimateMinutesOf(task)
}

/** 任务的截止时刻（epoch 毫秒）；没有 DDL 或脏值返回 `null`。 */
function deadlineEpochMsOf(task: Pick<Task, 'deadline'>): number | null {
  const raw = task?.deadline
  if (raw === null || raw === undefined || String(raw).trim().length === 0) return null
  return deadlineToEpochMs(raw)
}

/** DONE / CANCELLED 不算「进行中」，不进入压力分析。 */
function isActiveTask(task: Pick<Task, 'status'>): boolean {
  return task.status === 'TODO' || task.status === 'DOING'
}

/**
 * 归类一个进行中任务。
 *
 * 关键的**不重叠**规则（这样每一天的数字与「已逾期」的数字加起来才对得上）：
 * - DDL 早于 `now`（**含今天更早的时刻**）→ `overdue`，**不再算进今天**；
 * - DDL 恰好等于 `now` → 属于 `today`（**到点不算已经逾期**）；
 * - DDL 在 `[windowStart, windowEndExclusive)` 内 → 归到它自己的那一天；
 * - DDL >= 第 8 天 → `beyond`；
 * - 没有 DDL → `missing`；DDL 存在但解析不出来 → `malformed`（**不猜日期**）。
 */
export function classifyPressureTask(
  task: Pick<Task, 'status' | 'deadline'>,
  now: Date,
): PressureBucket {
  if (!isActiveTask(task)) return 'inactive'
  const raw = task.deadline
  if (raw === null || raw === undefined || String(raw).trim().length === 0) return 'missing'

  const epochMs = deadlineToEpochMs(raw)
  if (epochMs === null) return 'malformed'

  const nowMs = now.getTime()
  // 只到日期的 DDL 在当天内不算逾期，跨过北京时间零点才归入 overdue。
  if (isDeadlineOverdue(raw, nowMs)) return 'overdue'

  const dateKey = deadlineToShanghaiDateKey(raw)
  const startKey = shanghaiToday(now)
  if (!dateKey || !startKey) return 'malformed'

  if (dateKey === startKey) return 'today'

  const startDay = dayNumberOrNull(startKey)
  const targetDay = dayNumberOrNull(dateKey)
  if (startDay === null || targetDay === null) return 'malformed'
  const offset = targetDay - startDay
  if (offset <= 0) {
    // 理论上到不了这里（dateKey 与 now 同一天或更早），保守归到逾期/今天，绝不丢任务。
    return offset < 0 ? 'overdue' : 'today'
  }
  if (offset < PRESSURE_WINDOW_DAYS) return 'window'
  return 'beyond'
}

function dayNumberOrNull(dateKey: string): number | null {
  return dateKeyToDayNumber(dateKey)
}

/** 已填预计用时之和（缺预计用时的任务按未知处理，不计 0）。 */
export function sumKnownMinutes(tasks: readonly Pick<Task, 'estimatedMinutes'>[]): number {
  return tasks.reduce((total, task) => total + (estimateMinutesOf(task) ?? 0), 0)
}

/** 缺预计用时的任务数（含脏值 / 负数 / 小数）。 */
export function countUnknownEstimates(tasks: readonly Pick<Task, 'estimatedMinutes'>[]): number {
  return tasks.reduce((total, task) => total + (estimateMinutesOf(task) === null ? 1 : 0), 0)
}

/**
 * 单日的比较结论（纯函数，界面与测试共用，**不重复实现**）。
 *
 * 判定顺序（与 {@link PressureStatus} 的注释一致）：
 * 1. 没有任务 → `empty`；
 * 2. 有参考用时且已填用时之和 > 参考 → `exceeds`（**同时**通过 `unknownEstimateCount`
 *    披露「还有 N 条没填」，不是「说够了」）；
 * 3. 没有参考用时 → `unset`（如实请用户按需设置，仍然显示条数与合计）；
 * 4. 还有没填预计用时的任务 → `incomplete`（**绝不说「时间一定够」**）；
 * 5. 其余（已填用时之和 <= 参考）→ `within`；**相等不算超标**。
 */
export function pressureStatusOf(input: {
  taskCount: number
  knownMinutes: number
  unknownEstimateCount: number
  referenceMinutes: number | null
}): PressureStatus {
  if (input.taskCount <= 0) return 'empty'
  const reference = input.referenceMinutes
  if (reference !== null && input.knownMinutes > reference) return 'exceeds'
  // 没有参考值就**没有比较**：状态是「未设置」，不是「不完整」；
  // 缺预计用时的事实仍然通过 unknownEstimateCount 与汇总里的 hasUnknownEstimates 披露。
  if (reference === null) return 'unset'
  if (input.unknownEstimateCount > 0) return 'incomplete'
  return 'within'
}

/**
 * 把（可能来自脏数据的）参考用时收敛成合法值或 `null`。
 *
 * **刻意复用参考用时的同一套严格判定**（`readStoredStudyReferenceMinutes`）：
 * 界面输入、仓库写入、库里读回、分析比较四处必须是一个口径。
 * 早期版本这里用 `Number(value)` 兜底，会把 `true`→`1`、`[60]`→`60`、`'1e2'`→`100`
 * 都当成合法参考值 —— 那是复核点名的真实缺陷。
 */
export function normalizeReferenceMinutes(value: unknown): number | null {
  return readStoredStudyReferenceMinutes(value)
}

/**
 * 生成整份分析。
 *
 * 窗口只推导一次（`windowStartDateKey` / `windowEndExclusiveDateKey`），
 * 之后所有判定都用这两个边界，避免「每一天各算一遍今天」导致跨零点不一致。
 */
export function analyzeDdlPressure(input: PressureAnalysisInput): PressureAnalysis {
  const { tasks } = input
  const now = input.now
  const referenceMinutes = normalizeReferenceMinutes(input.referenceMinutes)

  const windowStartDateKey = shanghaiToday(now)
  const endKey = addDaysToDateKey(windowStartDateKey, PRESSURE_WINDOW_DAYS - 1)
  const endExclusiveKey = addDaysToDateKey(windowStartDateKey, PRESSURE_WINDOW_DAYS)

  const buckets: Record<PressureBucket, Task[]> = {
    overdue: [],
    today: [],
    window: [],
    beyond: [],
    missing: [],
    malformed: [],
    inactive: [],
  }

  for (const task of tasks) {
    buckets[classifyPressureTask(task, now)].push(task)
  }

  const sortByDeadline = (list: Task[]): Task[] =>
    [...list].sort((a, b) => {
      const left = deadlineEpochMsOf(a)
      const right = deadlineEpochMsOf(b)
      if (left === null && right === null) return a.id - b.id
      if (left === null) return 1
      if (right === null) return -1
      if (left !== right) return left - right
      // 同一时刻：按 id 稳定排序，保证列表顺序可复现。
      return a.id - b.id
    })

  const perDay = new Map<string, Task[]>()
  for (const task of [...buckets.today, ...buckets.window]) {
    const dateKey = deadlineToShanghaiDateKey(task.deadline)
    if (!dateKey) {
      // 已在上面的分类里判定过可解析；这里只做防御，绝不静默丢任务。
      buckets.malformed.push(task)
      continue
    }
    const list = perDay.get(dateKey) ?? []
    list.push(task)
    perDay.set(dateKey, list)
  }

  const days: PressureDay[] = []
  if (endKey) {
    for (let offset = 0; offset < PRESSURE_WINDOW_DAYS; offset += 1) {
      const dateKey = addDaysToDateKey(windowStartDateKey, offset)
      if (!dateKey) continue
      const dayTasks = sortByDeadline(perDay.get(dateKey) ?? [])
      const knownMinutes = sumKnownMinutes(dayTasks)
      const unknownEstimateCount = countUnknownEstimates(dayTasks)
      const status = pressureStatusOf({
        taskCount: dayTasks.length,
        knownMinutes,
        unknownEstimateCount,
        referenceMinutes,
      })
      const earliest = dayTasks.find((task) => deadlineEpochMsOf(task) !== null)?.deadline ?? null
      days.push({
        dateKey,
        weekday: weekdayOfDateKey(dateKey),
        isToday: dateKey === windowStartDateKey,
        taskCount: dayTasks.length,
        knownMinutes,
        unknownEstimateCount,
        earliestDeadline: earliest,
        concentrated: dayTasks.length >= CONCENTRATION_THRESHOLD,
        concentrationThreshold: CONCENTRATION_THRESHOLD,
        status,
        excessMinutes:
          status === 'exceeds' && referenceMinutes !== null ? knownMinutes - referenceMinutes : 0,
        referenceMinutes,
        tasks: dayTasks,
      })
    }
  }

  const includedTasks = days.flatMap((day) => day.tasks)
  const overdue = sortByDeadline(buckets.overdue)
  const missingDeadline = [...buckets.missing].sort((a, b) => a.id - b.id)
  const malformedDeadline = [...buckets.malformed].sort((a, b) => a.id - b.id)
  const beyondWindow = sortByDeadline(buckets.beyond)

  const includedCount = includedTasks.length
  const includedKnownMinutes = sumKnownMinutes(includedTasks)
  const includedUnknownEstimateCount = countUnknownEstimates(includedTasks)

  return {
    windowStartDateKey,
    windowEndDateKey: endKey ?? windowStartDateKey,
    windowEndExclusiveDateKey: endExclusiveKey ?? windowStartDateKey,
    windowDays: days.length,
    days,
    overdue,
    missingDeadline,
    malformedDeadline,
    beyondWindow,
    includedCount,
    includedKnownMinutes,
    includedUnknownEstimateCount,
    activeCount:
      includedCount +
      overdue.length +
      missingDeadline.length +
      malformedDeadline.length +
      beyondWindow.length,
    excludedInactiveCount: buckets.inactive.length,
    referenceMinutes,
    hasAnyTask: includedCount > 0,
    hasUnknownEstimates: includedUnknownEstimateCount > 0,
    hasDeadlineIssues: missingDeadline.length > 0 || malformedDeadline.length > 0,
  }
}

/** 分钟 → 人类可读时长（例如 `3 小时 20 分钟`）；`0` 显示 `0 分钟`。 */
export function formatMinutes(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0
  const hours = Math.floor(safe / 60)
  const rest = safe % 60
  if (hours <= 0) return `${rest} 分钟`
  if (rest === 0) return `${hours} 小时`
  return `${hours} 小时 ${rest} 分钟`
}
