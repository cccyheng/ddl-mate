/**
 * 学习周报（原生界面，只读）。
 *
 * 这一页回答的是：**上海时间某一周里，真实完成了什么、真实到期了什么**。
 * 它刻意**不**做的事：
 * - 不写库：没有「打开页面就保存」，也没有新设置 / 新表 / 备份改动；
 * - 不保存历史快照：数据永远来自当前 AppStore 快照，删任务 / 把 DONE 改回 TODO 后会跟着变；
 * - 不用修改时间冒充完成时间，不估算学习时长，不造连续天数 / 评分 / AI 总结；
 * - 不接网络、通知、导入、提醒或新依赖。
 *
 * 周算术、筛选与分页都在 `learningReportScreenState` 的纯函数里；
 * 这里只负责渲染与把点击转成明确的导航 / 状态切换。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { readShanghaiEpochClock } from '../domain/calendarClock'
import { shanghaiDeadlineLabel } from '../domain/datetime'
import {
  LEARNING_REPORT_HISTORY_WEEKS,
  analyzeLearningReport,
  formatLearningReportRate,
  parseTaskCompletion,
  selectLearningReportTasks,
  shortDateKey,
  type LearningReportAnalysis,
  type LearningReportFilter,
} from '../domain/learningReport'
import { taskStatusLabels, type Course, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import {
  AppButton,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  RefreshErrorBanner,
  SectionCard,
} from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { useFocusClock } from '../ui/useFocusClock'
import { FocusWeekSummary } from '../ui/FocusWeekSummary'
import { WeeklyGoalCard } from '../ui/WeeklyGoalCard'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { SharedLearningReportRoutes } from '../navigation/types'
import {
  LEARNING_REPORT_DAY_COLUMN_BASIS_PERCENT,
  LEARNING_REPORT_DAY_COLUMN_GAP,
  LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH,
  clampLearningReportPage,
  clearLearningReportFilter,
  describeLearningReportFilter,
  goToNextLearningWeek,
  goToPreviousLearningWeek,
  initialLearningReportScreenState,
  learningReportPeriodLabel,
  learningReportScreenMode,
  learningReportScrollResetKey,
  learningWeekdayLabel,
  openLearningReportFilter,
  paginateLearningReportTasks,
  resolveLearningReportScreenView,
  returnToCurrentLearningWeek,
  setLearningReportPage,
  type LearningReportScreenView,
} from './learningReportScreenState'

type Nav = NativeStackNavigationProp<SharedLearningReportRoutes>

/* -------------------------------- 小部件 -------------------------------- */

function MetricCell({
  label,
  value,
  hint,
  onPress,
  accessibilityLabel,
}: {
  label: string
  value: string
  hint?: string
  onPress: () => void
  accessibilityLabel: string
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="打开对应的任务明细"
      style={({ pressed }) => [styles.metricCell, pressed && styles.pressed]}
    >
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
      {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
    </Pressable>
  )
}

function courseNameOf(task: Task, course: Course | null): string {
  if (task.courseId === null) return '未关联课程'
  return course?.name ?? '课程已删除'
}

function ReportTaskRow({
  task,
  course,
  onPress,
}: {
  task: Task
  course: Course | null
  onPress: () => void
}): React.ReactElement {
  const completion = parseTaskCompletion(task.completedAt)
  const deadlineText = task.deadline ? `截止 ${shanghaiDeadlineLabel(task.deadline)}` : '未设置截止时间'
  const completionText =
    task.status === 'DONE'
      ? completion
        ? `完成 ${shanghaiDeadlineLabel(task.completedAt)}`
        : '完成时间缺失或无法识别'
      : null
  const meta = [taskStatusLabels[task.status], courseNameOf(task, course)].join(' · ')
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${task.title}，${meta}，${deadlineText}${completionText ? `，${completionText}` : ''}，打开任务详情`}
      style={({ pressed }) => [styles.taskRow, pressed && styles.pressed]}
    >
      <Text style={styles.taskTitle}>{task.title}</Text>
      <Text style={styles.taskMeta}>{meta}</Text>
      <Text style={styles.taskMeta}>
        {deadlineText}
        {completionText ? ` · ${completionText}` : ''}
      </Text>
    </Pressable>
  )
}

/* --------------------------------- 主界面 -------------------------------- */

export function LearningReportScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  /**
   * 聚焦时钟：页面可见时每 30 秒推进，离开页面停、回到前台立刻同步。
   * 用**真实毫秒**读数，逾期边界不会因为截断到分钟而判错。
   */
  const clock = useFocusClock(readShanghaiEpochClock)
  const now = useMemo(() => new Date(clock.epochMs), [clock.epochMs])

  const [screen, setScreen] = useState(initialLearningReportScreenState)
  const [showRules, setShowRules] = useState(false)

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  /** 跨零点刷新一次快照；所选周与筛选都保存在独立的 screen state 里，不会被刷新改写。 */
  const lastDateKey = useRef(clock.dateKey)
  useEffect(() => {
    if (lastDateKey.current === clock.dateKey) return
    lastDateKey.current = clock.dateKey
    void refresh()
  }, [clock.dateKey, refresh])

  const view = useMemo(() => resolveLearningReportScreenView(screen, now), [now, screen])

  const analysis = useMemo<LearningReportAnalysis | null>(() => {
    if (!view) return null
    return analyzeLearningReport({
      tasks: store.data.tasks,
      courses: store.data.courses,
      weekStartDateKey: view.selectedWeek.startDateKey,
      now,
    })
  }, [now, store.data.courses, store.data.tasks, view])

  const filterTasks = useMemo(
    () => (analysis && screen.filter ? selectLearningReportTasks(analysis, screen.filter) : []),
    [analysis, screen.filter],
  )
  const page = useMemo(
    () => paginateLearningReportTasks(filterTasks, screen.page),
    [filterTasks, screen.page],
  )
  const filterDescription = useMemo(
    () => (analysis && view && screen.filter ? describeLearningReportFilter(screen.filter, view, analysis) : null),
    [analysis, screen.filter, view],
  )

  const openFilter = useCallback((filter: LearningReportFilter) => {
    setScreen((previous) => openLearningReportFilter(previous, filter))
  }, [])
  const backToSummary = useCallback(() => {
    setScreen(clearLearningReportFilter)
  }, [])
  const goPrevious = useCallback(() => {
    setScreen((previous) => goToPreviousLearningWeek(previous, now))
  }, [now])
  const goNext = useCallback(() => {
    setScreen((previous) => goToNextLearningWeek(previous, now))
  }, [now])
  const goCurrent = useCallback(() => {
    setScreen(returnToCurrentLearningWeek)
  }, [])
  const previousPage = useCallback(() => {
    setScreen((previous) => setLearningReportPage(previous, page.page - 1, page.total))
  }, [page.page, page.total])
  const nextPage = useCallback(() => {
    setScreen((previous) => setLearningReportPage(previous, page.page + 1, page.total))
  }, [page.page, page.total])

  const openDetail = useCallback(
    (task: Task) => navigation.navigate('TaskDetail', { id: task.id }),
    [navigation],
  )

  /** 明细选中态：只影响视觉提示，不参与任何筛选逻辑。 */
  const isDaySelected = (weekday: number): boolean =>
    screen.filter?.kind === 'completedDay' && screen.filter.weekday === weekday
  const isCourseSelected = (courseId: number | null): boolean =>
    screen.filter?.kind === 'course' && screen.filter.courseId === courseId

  const subtitle = view
    ? `${view.selectedWeek.startDateKey} ～ ${view.selectedWeek.endDateKey} · 上海时间周一至周日`
    : '按上海时间统计'

  const maxCompleted = analysis ? Math.max(1, ...analysis.days.map((day) => day.completedCount)) : 1
  const mode = learningReportScreenMode(screen)
  const hasFilter = mode === 'detail' && filterDescription !== null
  const shownPage = clampLearningReportPage(page.page, page.total, page.pageSize)
  const periodLabel = view ? learningReportPeriodLabel(view) : '本周'
  const scrollResetKey = view ? learningReportScrollResetKey({ ...screen, page: shownPage }, view) : 'learning-report-loading'

  return (
    <ScreenScaffold key={scrollResetKey} title="学习周报" subtitle={subtitle}>
      {store.refreshError ? (
        <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
      ) : null}

      {store.status === 'loading' ? <LoadingState message="正在读取本机数据…" /> : null}
      {store.status === 'error' ? (
        <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
      ) : null}

      {store.status === 'ready' && !view ? (
        <ErrorState message="无法确定本周的日期，请稍后重试。" onRetry={() => void store.refresh()} />
      ) : null}

      {store.status === 'ready' && view && analysis ? (
        <>
          <SectionCard
            title="选择周"
            subtitle={
              view.isCurrentWeek
                ? `默认本周；可回看最近 ${LEARNING_REPORT_HISTORY_WEEKS} 周，不能翻到未来`
                : `正在看所选周；可回看最近 ${LEARNING_REPORT_HISTORY_WEEKS} 周，不能翻到未来`
            }
          >
            <View style={styles.weekNavRow}>
              <AppButton
                label="上一周"
                variant="secondary"
                compact
                disabled={!view.canGoPrevious}
                onPress={goPrevious}
                accessibilityLabel="查看上一周的学习周报"
              />
              <View style={styles.weekCenter}>
                <Text style={styles.weekRange}>
                  {view.selectedWeek.startDateKey} ～ {view.selectedWeek.endDateKey}
                </Text>
                <Text style={styles.weekHint}>{view.isCurrentWeek ? '本周' : '历史周'}</Text>
              </View>
              <AppButton
                label="下一周"
                variant="secondary"
                compact
                disabled={!view.canGoNext}
                onPress={goNext}
                accessibilityLabel="查看下一周的学习周报"
              />
            </View>
            <View style={styles.weekBottomRow}>
              <AppButton
                label="回到本周"
                variant={view.isCurrentWeek ? 'secondary' : 'primary'}
                compact
                disabled={view.isCurrentWeek}
                onPress={goCurrent}
                accessibilityLabel="回到本周的学习周报"
              />
              <Badge text={view.isCurrentWeek ? '当前周' : '历史周'} tone={view.isCurrentWeek ? 'primary' : 'muted'} />
              <Text style={styles.caption}>
                最早可回看：{shortDateKey(view.earliestWeekStart)}
              </Text>
            </View>
          </SectionCard>

          {!hasFilter ? (
            <>
            <FocusWeekSummary startDateKey={view.selectedWeek.startDateKey} now={clock.epochMs} />
            <WeeklyGoalCard week={view.selectedWeek.startDateKey} now={clock.epochMs} />
            </>
          ) : null}

          {!hasFilter ? (
            <SectionCard
              title={`${periodLabel}概览`}
              subtitle={`点任意数字，查看${periodLabel}对应的真实任务`}
            >
            <View style={styles.metricGrid}>
              <MetricCell
                label={`${periodLabel}完成`}
                value={String(analysis.completedThisWeek.length)}
                onPress={() => openFilter({ kind: 'completedThisWeek' })}
                accessibilityLabel={`${periodLabel}完成 ${analysis.completedThisWeek.length} 个，查看对应任务`}
              />
              <MetricCell
                label={`${periodLabel}到期`}
                value={String(analysis.dueTasks.length)}
                onPress={() => openFilter({ kind: 'due' })}
                accessibilityLabel={`${periodLabel}到期 ${analysis.dueTasks.length} 个，查看对应任务`}
              />
              <MetricCell
                label="到期完成率"
                value={formatLearningReportRate(analysis.dueCompletionRate)}
                hint={`点开看${periodLabel}到期`}
                onPress={() => openFilter({ kind: 'due' })}
                accessibilityLabel={`${periodLabel}到期完成率 ${formatLearningReportRate(analysis.dueCompletionRate)}，查看到期任务`}
              />
              <MetricCell
                label="到期已完成"
                value={String(analysis.dueDone.length)}
                onPress={() => openFilter({ kind: 'dueDone' })}
                accessibilityLabel={`${periodLabel}到期且已完成 ${analysis.dueDone.length} 个，查看对应任务`}
              />
              <MetricCell
                label="到期未完成"
                value={String(analysis.dueOpen.length)}
                hint="含已逾期"
                onPress={() => openFilter({ kind: 'dueOpen' })}
                accessibilityLabel={`${periodLabel}到期且未完成 ${analysis.dueOpen.length} 个，查看对应任务`}
              />
              <MetricCell
                label="已逾期"
                value={String(analysis.overdueNow.length)}
                onPress={() => openFilter({ kind: 'overdue' })}
                accessibilityLabel={`${periodLabel}到期且已逾期 ${analysis.overdueNow.length} 个，查看对应任务`}
              />
            </View>

            <Text style={styles.note}>根据当前任务统计；修改或删除任务后，周报也会更新。</Text>
            <AppButton
              label={showRules ? '收起统计说明' : '统计说明'}
              variant="ghost"
              compact
              onPress={() => setShowRules((previous) => !previous)}
            />
            {showRules ? (
              <View>
                <Text style={styles.note}>{periodLabel}完成：目前已完成，完成日期在所选周内，且完成时间不晚于现在。</Text>
                <Text style={styles.note}>{periodLabel}到期：截止日期在所选周内，已取消的任务不计入。完成率为其中已完成的比例；没有到期任务时显示「—」。</Text>
                <Text style={styles.note}>完成时间缺失的已完成任务仍算进「到期已完成」，但不计入按完成日期统计的条数。</Text>
                <Text style={styles.note}>周报按北京时间统计，不保存历史快照；已逾期按现在的时间判断。</Text>
              </View>
            ) : null}

            {analysis.doneMissingCompletion.length > 0 ? (
              <Pressable
                onPress={() => openFilter({ kind: 'doneMissingCompletion' })}
                accessibilityRole="button"
                accessibilityLabel={`查看 ${analysis.doneMissingCompletion.length} 条完成时间缺失或无法识别的已完成任务`}
                style={({ pressed }) => [styles.warnBox, pressed && styles.pressed]}
              >
                <Text style={styles.warnText}>
                  {analysis.doneMissingCompletion.length} 条已完成任务缺少有效完成时间，未计入{periodLabel}完成。
                </Text>
                <Text style={styles.linkText}>查看这些任务</Text>
              </Pressable>
            ) : null}
            {showRules && analysis.doneOutsideWeek.length > 0 ? (
              <Text style={styles.caption}>
                另有 {analysis.doneOutsideWeek.length} 条已完成任务的完成时间不在所选周内。
              </Text>
            ) : null}
            {analysis.doneFutureThisWeek.length > 0 ? (
              <Text style={styles.warnText}>
                {analysis.doneFutureThisWeek.length} 条任务的完成时间晚于现在，未计入{periodLabel}完成。
              </Text>
            ) : null}
            {analysis.malformedDeadline.length > 0 ? (
              <Text style={styles.caption}>
                {analysis.malformedDeadline.length} 条任务的截止日期无法识别，未计入{periodLabel}到期。
              </Text>
            ) : null}
          </SectionCard>
          ) : null}

          {hasFilter && filterDescription ? (
            <SectionCard
              title={`${filterDescription.heading}（${page.total} 条）`}
              subtitle={filterDescription.subtitle}
            >
              <View style={styles.drillActions}>
                <AppButton
                  label="返回汇总"
                  variant="secondary"
                  compact
                  onPress={backToSummary}
                  accessibilityLabel="返回学习周报汇总"
                />
                <AppButton
                  label="清除筛选"
                  variant="ghost"
                  compact
                  onPress={backToSummary}
                  accessibilityLabel="清除当前任务筛选"
                />
                <Badge text={`共 ${page.total} 条`} tone="muted" />
              </View>

              {page.total === 0 ? (
                <EmptyState
                  title="没有对应任务"
                  description={filterDescription.emptyText}
                  actionLabel="清除筛选"
                  onAction={backToSummary}
                />
              ) : (
                <>
                  {page.items.map((task) => (
                    <ReportTaskRow
                      key={task.id}
                      task={task}
                      course={store.courseById(task.courseId)}
                      onPress={() => openDetail(task)}
                    />
                  ))}
                  {page.pageCount > 1 ? (
                    <View style={styles.pagerRow}>
                      <AppButton
                        label="上一页"
                        variant="secondary"
                        compact
                        disabled={shownPage <= 1}
                        onPress={previousPage}
                        accessibilityLabel="任务明细上一页"
                      />
                      <Text style={styles.pagerText}>
                        第 {shownPage} / {page.pageCount} 页 · 共 {page.total} 条
                      </Text>
                      <AppButton
                        label="下一页"
                        variant="secondary"
                        compact
                        disabled={shownPage >= page.pageCount}
                        onPress={nextPage}
                        accessibilityLabel="任务明细下一页"
                      />
                    </View>
                  ) : null}
                </>
              )}
            </SectionCard>
          ) : null}

          {!hasFilter ? <>
          <SectionCard
            title="每日完成"
            subtitle="点某一天，查看当天完成的任务"
          >
            <View style={styles.barRow}>
              {analysis.days.map((day) => {
                const selected = isDaySelected(day.weekday)
                const barHeight =
                  day.completedCount === 0
                    ? 0
                    : Math.max(6, Math.round((day.completedCount / maxCompleted) * 72))
                return (
                  <Pressable
                    key={day.dateKey}
                    onPress={() => openFilter({ kind: 'completedDay', weekday: day.weekday })}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${learningWeekdayLabel(day.weekday)} ${shortDateKey(day.dateKey)}，完成 ${day.completedCount} 个，查看当天完成的任务`}
                    style={({ pressed }) => [
                      styles.barColumn,
                      selected && styles.barColumnSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.barValue}>{day.completedCount}</Text>
                    <View style={styles.barTrack}>
                      <View style={[styles.barFill, { height: barHeight }]} />
                    </View>
                    <Text style={styles.barWeekday}>{learningWeekdayLabel(day.weekday)}</Text>
                    <Text style={styles.barDate}>{shortDateKey(day.dateKey)}</Text>
                  </Pressable>
                )
              })}
            </View>
            {analysis.completedThisWeek.length === 0 ? (
              <Text style={styles.caption}>{periodLabel}还没有完成记录。</Text>
            ) : null}
          </SectionCard>

          <SectionCard
            title={`按课程看${periodLabel}到期`}
            subtitle={`合计 ${analysis.courseTotals.dueTotal} 条到期；点课程查看任务`}
          >
            {analysis.courseGroups.length === 0 ? (
              <Text style={styles.caption}>{periodLabel}没有到期任务。</Text>
            ) : (
              analysis.courseGroups.map((group) => {
                const label =
                  group.courseId === null
                    ? '未关联课程'
                    : group.missingCourse
                      ? '课程已删除'
                      : (group.courseName ?? '未命名课程')
                const selected = isCourseSelected(group.courseId)
                return (
                  <Pressable
                    key={String(group.courseId)}
                    onPress={() => openFilter({ kind: 'course', courseId: group.courseId })}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${label}，${periodLabel}到期 ${group.dueTotal} 条，已完成 ${group.dueDone}，未完成 ${group.dueOpen}，其中已逾期 ${group.overdue}，查看对应任务`}
                    style={({ pressed }) => [
                      styles.courseRow,
                      selected && styles.courseRowSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.courseName}>{label}</Text>
                    <Text style={styles.courseMeta}>
                      到期 {group.dueTotal} · 已完成 {group.dueDone} · 未完成 {group.dueOpen}（其中已逾期{' '}
                      {group.overdue}）
                    </Text>
                  </Pressable>
                )
              })
            )}
            <Text style={styles.caption}>
              合计：到期 {analysis.courseTotals.dueTotal} · 已完成 {analysis.courseTotals.dueDone} · 未完成{' '}
              {analysis.courseTotals.dueOpen}（其中已逾期 {analysis.courseTotals.overdue}）。
            </Text>
          </SectionCard>

          <Text style={styles.footnote}>
            周报只读当前本机数据，不保存历史；把任务改回未完成或删除后，这里会跟着当前数据变化。
          </Text>
          </> : null}
        </>
      ) : null}
    </ScreenScaffold>
  )
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.8 },
  caption: { ...typography.caption, marginTop: spacing.xs },
  note: { ...typography.bodySoft, color: colors.textSoft, marginTop: spacing.sm },
  warnBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.warnSoft,
    minHeight: MIN_TOUCH_SIZE,
  },
  warnText: { ...typography.bodySoft, color: colors.warn, marginTop: spacing.xs },
  linkText: { ...typography.label, color: colors.primary, marginTop: spacing.xs },

  weekNavRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  weekCenter: { flex: 1, minWidth: 140, alignItems: 'center' },
  weekRange: { ...typography.body, fontWeight: '600', textAlign: 'center' },
  weekHint: { ...typography.caption, marginTop: 2 },
  weekBottomRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  metricCell: {
    flexGrow: 1,
    flexBasis: '30%',
    minHeight: MIN_TOUCH_SIZE,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    gap: 2,
  },
  metricValue: { fontSize: 20, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  metricLabel: { ...typography.caption, fontSize: 12, textAlign: 'center' },
  metricHint: { ...typography.caption, fontSize: 11, color: colors.textMuted, textAlign: 'center' },

  drillActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  pagerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pagerText: { ...typography.caption, textAlign: 'center' },

  taskRow: {
    minHeight: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  taskTitle: { ...typography.body, fontWeight: '600' },
  taskMeta: { ...typography.caption, marginTop: 2 },

  barRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: LEARNING_REPORT_DAY_COLUMN_GAP, marginTop: spacing.sm },
  barColumn: {
    flexBasis: `${LEARNING_REPORT_DAY_COLUMN_BASIS_PERCENT}%`,
    flexShrink: 0,
    minWidth: LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH,
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    minHeight: MIN_TOUCH_SIZE,
  },
  barColumnSelected: { backgroundColor: colors.primarySoft },
  barValue: { ...typography.caption, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  barTrack: {
    height: 72,
    width: '70%',
    maxWidth: 28,
    justifyContent: 'flex-end',
    borderTopWidth: 0,
    backgroundColor: colors.surfaceMute,
    borderRadius: radius.sm,
    marginVertical: 2,
    overflow: 'hidden',
  },
  barFill: { width: '100%', backgroundColor: colors.primary, borderRadius: radius.sm },
  barWeekday: { ...typography.caption, fontSize: 12, textAlign: 'center' },
  barDate: { ...typography.caption, fontSize: 10, color: colors.textMuted, textAlign: 'center' },

  courseRow: {
    minHeight: MIN_TOUCH_SIZE,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    borderRadius: radius.sm,
  },
  courseRowSelected: { backgroundColor: colors.primarySoft },
  courseName: { ...typography.body, fontWeight: '600' },
  courseMeta: { ...typography.caption, marginTop: 2 },
  footnote: { ...typography.caption, marginTop: spacing.sm, color: colors.textMuted },
})
