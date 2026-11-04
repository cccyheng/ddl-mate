/**
 * DDL 压力分析（原生界面）。
 *
 * 这一页回答的是：**未来 7 个上海自然日里，哪几天到期任务扎堆**。
 * 它刻意**不**做的事（复核要逐条对着看）：
 * - 不做日程排布、不自动重排、不发通知、不接 AI；
 * - 不把「已填预计用时之和」说成「剩余工作量」：DOING 的进度没有被测量；
 * - 不把「没超过参考用时」说成「时间够用 / 一定做得完」；
 * - 不因为「读了这一页」就写库：只有用户在设置区明确点保存才会写入参考用时。
 *
 * 所有数字都来自 `analyzeDdlPressure` 这一份纯函数结果（今天页的摘要入口也用同一份），
 * 界面里没有任何重复的计算公式。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import {
  CONCENTRATION_THRESHOLD,
  analyzeDdlPressure,
  formatMinutes,
  knownEstimateMinutesOf,
  type PressureAnalysis,
  type PressureDay,
} from '../domain/ddlPressure'
import { readShanghaiEpochClock } from '../domain/calendarClock'
import { shanghaiDeadlineLabel, weekdayName } from '../domain/datetime'
import { studyReferenceSaveGuard, studyReferenceToDraft } from '../domain/studyReference'
import {
  resolveStudyReferenceSave,
  syncStudyReferenceDraft,
  type StudyReferenceDraftState,
} from '../domain/studyReferenceState'
import { type Course, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import {
  AppButton,
  AppTextField,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  RefreshErrorBanner,
  SectionCard,
} from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutes } from '../navigation/types'

type Nav = NativeStackNavigationProp<SharedTaskRoutes>

/* ------------------------------ 单日结论文案 ------------------------------ */

export interface DayStatusText {
  /** 主结论（用户先看到的那一行）。 */
  text: string
  /** 补充说明（缺预计用时 / 未设置参考用时等）。 */
  note: string | null
  tone: 'neutral' | 'warn' | 'clay' | 'primary' | 'muted'
}

/**
 * 一天的结论文案（纯函数，导出以便测试锁定措辞）。
 *
 * 措辞上的硬约束：
 * - 「超过参考用时」必须给出**差值**；
 * - 缺预计用时一律说「不完整」，**不出现**任何「时间一定够 / 一定做得完」这类承诺；
 * - 未设置参考用时绝不假装有参考值，只是请用户按需设置，同时照常显示条数与合计。
 */
export function describeDayStatus(day: PressureDay): DayStatusText {
  const reference = day.referenceMinutes
  switch (day.status) {
    case 'empty':
      return { text: '这一天没有到期的未完成任务。', note: null, tone: 'muted' }
    case 'exceeds': {
      const note =
        day.unknownEstimateCount > 0
          ? `另有 ${day.unknownEstimateCount} 条缺预计用时，实际可能更多。`
          : null
      return {
        text: `预计用时合计超过参考 ${formatMinutes(day.excessMinutes)}（参考 ${formatMinutes(reference ?? 0)} 分钟）。`,
        note,
        tone: 'clay',
      }
    }
    case 'incomplete':
      return {
        text: `缺预计用时 ${day.unknownEstimateCount} 条，这一天的合计不完整。`,
        note: `已填合计 ${formatMinutes(day.knownMinutes)} 未超过参考，但缺的部分无法估算，不能据此判断时间够不够。`,
        tone: 'warn',
      }
    case 'unset':
      return {
        text: '未设置参考用时，只显示条数与预计用时合计。',
        note:
          day.unknownEstimateCount > 0
            ? `另有 ${day.unknownEstimateCount} 条缺预计用时，合计只是已填部分。需要比较的话，可在上面的「每日参考用时」按需填写。`
            : '需要比较的话，可在上面的「每日参考用时」按需填写（不填也完全可以）。',
        tone: 'neutral',
      }
    default:
      return {
        text: `预计用时合计未超过参考（${formatMinutes(day.knownMinutes)} / ${formatMinutes(reference ?? 0)} 分钟）。`,
        note: null,
        tone: 'primary',
      }
  }
}

/* --------------------------------- 任务行 -------------------------------- */

function PressureTaskRow({
  task,
  course,
  onPress,
  onEditDeadline,
}: {
  task: Task
  course: Course | null
  onPress: () => void
  onEditDeadline: () => void
}): React.ReactElement {
  const known = knownEstimateMinutesOf(task)
  return (
    <View style={styles.taskRow}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`查看任务 ${task.title}，DDL ${shanghaiDeadlineLabel(task.deadline)}`}
        style={({ pressed }) => [styles.taskMain, pressed && styles.pressed]}
      >
        <Text style={styles.taskTitle}>{task.title}</Text>
        <Text style={styles.taskMeta}>
          {course ? `${course.name} · ` : '未关联课程 · '}
          {known === null ? '缺预计用时（按未知统计）' : `预计用时 ${formatMinutes(known)}`}
        </Text>
        <Text style={styles.taskMeta}>DDL {task.deadline ? shanghaiDeadlineLabel(task.deadline) : '未设置'}</Text>
      </Pressable>
      <AppButton
        label="补预计用时"
        variant="secondary"
        compact
        onPress={onEditDeadline}
        accessibilityLabel={`编辑任务 ${task.title} 的预计用时`}
        accessibilityHint="打开任务编辑页补上预计用时；应用不会替你填"
      />
    </View>
  )
}

/* ------------------------------- 某一天卡片 ------------------------------- */

function DaySection({
  day,
  expanded,
  onToggle,
  renderTask,
}: {
  day: PressureDay
  expanded: boolean
  onToggle: () => void
  renderTask: (task: Task) => React.ReactElement
}): React.ReactElement {
  const status = useMemo(() => describeDayStatus(day), [day])
  const statusStyle = STATUS_TONES[status.tone]
  const dateLabel = `${day.dateKey.slice(5)} ${day.weekday ? weekdayName(day.weekday) : ''}`.trim()
  return (
    <View style={styles.dayCard}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${dateLabel}，${day.taskCount} 个未完成任务，${expanded ? '收起' : '展开'}任务列表`}
        style={({ pressed }) => [styles.dayHead, pressed && styles.pressed]}
      >
        <View style={styles.dayHeadTop}>
          <Text style={styles.dayTitle}>
            {dateLabel}
            {day.isToday ? <Text style={styles.todayMark}>（今天）</Text> : null}
          </Text>
          <View style={styles.badgeRow}>
            {day.concentrated ? (
              <Badge text={`任务集中（每天 ≥${day.concentrationThreshold} 项）`} tone="clay" />
            ) : null}
            <Badge text={expanded ? '收起' : `展开 ${day.taskCount} 条`} tone="muted" />
          </View>
        </View>
        <Text style={styles.dayMeta}>
          未完成任务 {day.taskCount} 个 · 预计用时合计 {formatMinutes(day.knownMinutes)}
          {day.unknownEstimateCount > 0 ? ` · 缺预计用时 ${day.unknownEstimateCount} 条` : ''}
        </Text>
        <Text style={styles.dayMeta}>
          最早 DDL：{day.earliestDeadline ? shanghaiDeadlineLabel(day.earliestDeadline) : '—'}
          {day.referenceMinutes === null ? '' : ` · 参考 ${formatMinutes(day.referenceMinutes)}`}
        </Text>
        <Text style={[styles.dayStatus, { color: statusStyle.fg }]}>{status.text}</Text>
        {status.note ? <Text style={styles.dayNote}>{status.note}</Text> : null}
      </Pressable>
      {expanded ? (
        <View style={styles.dayBody}>
          {day.tasks.length === 0 ? (
            <Text style={styles.emptyLine}>这一天没有到期的未完成任务。</Text>
          ) : (
            day.tasks.map(renderTask)
          )}
        </View>
      ) : null}
    </View>
  )
}

/* --------------------------------- 主界面 -------------------------------- */

export function PressureScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  /**
   * 聚焦时钟：页面可见时每 30 秒推进，离开页面停、回到前台立刻同步。
   *
   * 这里用的是**带真实毫秒**的读数（`readShanghaiEpochClock`），不是「日期 + 分钟」：
   * 逾期判定要按完整时刻比较，把「现在」截断到分钟会让同一秒内的先后判错。
   */
  const clock = useFocusClock(readShanghaiEpochClock)

  /** 「现在」= 时钟读到的真实时刻（含秒与毫秒），只依赖时钟读数 memo 一次。 */
  const now = useMemo(() => new Date(clock.epochMs), [clock.epochMs])

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  /** 跨零点：上海自然日一变就重读一次快照（`today` 与统计都跟着更新）。 */
  const lastDateKey = useRef(clock.dateKey)
  React.useEffect(() => {
    if (lastDateKey.current === clock.dateKey) return
    lastDateKey.current = clock.dateKey
    void refresh()
  }, [clock.dateKey, refresh])

  const analysis: PressureAnalysis = useMemo(
    () =>
      analyzeDdlPressure({
        tasks: store.data.tasks,
        referenceMinutes: store.studyReferenceMinutes,
        now,
      }),
    [now, store.data.tasks, store.studyReferenceMinutes],
  )

  /* --------------------------- 参考用时设置区 --------------------------- */

  const [draftState, setDraftState] = useState<StudyReferenceDraftState>(() => ({
    draft: studyReferenceToDraft(store.studyReferenceMinutes),
    lastSynced: store.studyReferenceMinutes,
  }))
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  /**
   * **同步**的在途闸门。
   *
   * 只靠 `saving`/`clearing` 这两个 state 不够：它们在同一个事件循环里还没提交，
   * 用户（或双击）在**同一帧**里连点两次保存/清除，两次都会读到旧值于是都发出去。
   * ref 的赋值是同步的，因此这里能真正把第二次挡住。
   */
  const inFlightRef = useRef(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [pendingClear, setPendingClear] = useState(false)
  const pending = saving || clearing

  /**
   * 与已保存值同步。
   *
   * - 后台刷新：只要「已保存值」没变，草稿一个字都不动（用户正在输入的内容不会被冲掉）；
   * - 保存成功后：草稿与已保存值对齐（输入框不再被当成「脏」，返回时也不会被多问一次）。
   */
  const observedReference = store.studyReferenceMinutes
  React.useEffect(() => {
    setDraftState((previous) => {
      const next = syncStudyReferenceDraft({ state: previous, observed: observedReference, committed: false })
      return next.changed ? next.state : previous
    })
  }, [observedReference])

  const guard = useMemo(
    () => studyReferenceSaveGuard(draftState.draft, draftState.lastSynced),
    [draftState.draft, draftState.lastSynced],
  )
  const draftError = useMemo(() => {
    if (draftState.draft.trim().length === 0) return null
    return guard.reason
  }, [draftState.draft, guard.reason])

  const onSaveReference = useCallback(async () => {
    if (inFlightRef.current || !guard.canSave) return
    inFlightRef.current = true
    setSaving(true)
    try {
      const result = await store.saveStudyReferenceMinutes(draftState.draft)
      const resolved = resolveStudyReferenceSave(draftState, result)
      setDraftState(resolved.state)
      setToast({ text: resolved.message ?? '', tone: resolved.tone === 'success' ? 'success' : 'error' })
    } catch (cause) {
      // 抛异常时**保留草稿**（resolved 没走到，draftState 原样），只如实报错。
      setToast({ text: cause instanceof Error ? cause.message : '保存失败。', tone: 'error' })
    } finally {
      inFlightRef.current = false
      setSaving(false)
    }
  }, [draftState, guard.canSave, store])

  const confirmClearReference = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setClearing(true)
    try {
      const result = await store.saveStudyReferenceMinutes(null)
      const resolved = resolveStudyReferenceSave(draftState, result)
      setDraftState(resolved.state)
      setToast({ text: resolved.message ?? '', tone: resolved.tone === 'success' ? 'success' : 'error' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '清除失败。', tone: 'error' })
    } finally {
      inFlightRef.current = false
      setClearing(false)
      setPendingClear(false)
    }
  }, [draftState, store])

  /* ------------------------------ 导航与动作 ------------------------------ */

  const openDetail = useCallback((task: Task) => navigation.navigate('TaskDetail', { id: task.id }), [navigation])
  const openEdit = useCallback((task: Task) => navigation.navigate('TaskForm', { id: task.id }), [navigation])

  const renderTask = useCallback(
    (task: Task) => (
      <PressureTaskRow
        key={task.id}
        task={task}
        course={store.courseById(task.courseId)}
        onPress={() => openDetail(task)}
        onEditDeadline={() => openEdit(task)}
      />
    ),
    [openDetail, openEdit, store],
  )

  /** 展开状态**只由用户点击改变**：刷新、保存、跨零点都不会把它重置。 */
  const [expandedDates, setExpandedDates] = useState<ReadonlySet<string>>(() => new Set<string>())
  const toggleDay = useCallback((dateKey: string) => {
    setExpandedDates((previous) => {
      const next = new Set(previous)
      if (next.has(dateKey)) next.delete(dateKey)
      else next.add(dateKey)
      return next
    })
  }, [])

  const [showAllOverdue, setShowAllOverdue] = useState(false)

  /** 未保存的设置草稿：离开前要用原生确认框问一次（**只在真的有改动时**）。 */
  const dirty = guard.dirty
  const leaveConfirmedRef = useRef(false)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  usePreventRemove(dirty || saving || clearing, ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (saving || clearing) {
      setToast({ text: '正在保存参考用时，请稍等一下再离开。', tone: 'error' })
      return
    }
    setPendingLeaveAction(data.action)
  })

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    // 丢弃草稿 → 回到已保存值，再去派发被拦下来的那个原始动作。
    setDraftState((previous) => ({ draft: studyReferenceToDraft(previous.lastSynced), lastSynced: previous.lastSynced }))
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  /* -------------------------------- 渲染 -------------------------------- */

  const headerSubtitle = analysis.windowDays
    ? [
        `${analysis.windowStartDateKey} 起 7 天（至 ${analysis.windowEndDateKey}，含今天）`,
        `未完成任务 ${analysis.includedCount} 个`,
        `预计用时合计 ${formatMinutes(analysis.includedKnownMinutes)}`,
      ].join(' · ')
    : '正在读取本机数据…'

  const overdueVisible = showAllOverdue ? analysis.overdue : analysis.overdue.slice(0, 5)

  /**
   * 输入框下面的提示。
   *
   * 三件事必须写清楚（授权书点名）：参考值对 7 天一视同仁、不扣上课时间、
   * 也没有把夜里还剩多少时间算进去。这三条只在设置区讲一遍，
   * 每天的卡片上不再重复长篇说明。
   */
  const referenceHint =
    `已保存：${draftState.lastSynced === null ? '未设置' : `${draftState.lastSynced} 分钟`}。` +
    '这个参考值对 7 天一视同仁，不会自动扣掉上课时间，也没有考虑夜里还剩多少时间可用。'

  return (
    <>
      <ScreenScaffold title="DDL 压力分析" subtitle={headerSubtitle}>
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}

        {store.status === 'loading' ? <LoadingState message="正在读取本机数据…" /> : null}
        {store.status === 'error' ? (
          <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
        ) : null}

        {store.status === 'ready' ? (
          <>
            <SectionCard
              title="每日参考用时（可选）"
              subtitle="只跟「预计用时合计」比较；不填就只显示条数与合计，应用不会替你编一个参考值"
            >
              <AppTextField
                label="每日参考用时（分钟）"
                value={draftState.draft}
                onChangeText={(text) => setDraftState((previous) => ({ ...previous, draft: text }))}
                placeholder="留空 = 未设置，例如 120"
                keyboardType="number-pad"
                editable={!pending}
                error={draftError}
                hint={draftError ? undefined : referenceHint}
                accessibilityLabel="每日参考用时分钟数"
              />
              <View style={styles.buttonRow}>
                <AppButton
                  label="保存参考用时"
                  onPress={() => void onSaveReference()}
                  disabled={!guard.canSave || pending}
                  loading={saving}
                  compact
                  accessibilityLabel="保存每日参考用时"
                  accessibilityHint="只保存这个参考数字，不会改动任何任务或课表"
                />
                <AppButton
                  label="清除（回到未设置）"
                  variant="secondary"
                  onPress={() => setPendingClear(true)}
                  disabled={draftState.lastSynced === null || pending}
                  compact
                  accessibilityLabel="清除每日参考用时"
                />
              </View>
              <Text style={styles.note}>
                设置这个参考值不会修改任何任务或课程，也不会生成日程或调整任务时间。
              </Text>
            </SectionCard>

            <SectionCard
              title="这份分析包含什么"
              subtitle={`范围：${analysis.windowStartDateKey} ～ ${analysis.windowEndDateKey}（7 个上海自然日，含今天）`}
            >
              <View style={styles.bulletList} accessibilityLabel="这份分析的口径与边界">
                <Text style={styles.bulletItem}>• 只统计「待办 / 进行中」且设置了 DDL 的任务，按 DDL 的上海日期分组。</Text>
                <Text style={styles.bulletItem}>• 已完成与已取消的任务不参与任何一天。</Text>
                <Text style={styles.bulletItem}>• 预计用时合计是任务自己填的原始值，不是剩余工作量（进行中的进度没有被测量，仍按全额计入）。</Text>
                <Text style={styles.bulletItem}>• 这是按截止日期的集中度统计，不是排好的日程，也不代表任务不能提前完成。</Text>
                <Text style={styles.bulletItem}>• 没超过参考用时，不等于「时间一定够」。</Text>
                <Text style={styles.bulletItem}>• 小提示：如果某几天集中，可以早点动手把任务分到更空的日子。</Text>
              </View>
              <View style={styles.badgeRow}>
                <Badge text={`窗口内 ${analysis.includedCount} 个`} tone="neutral" />
                <Badge text={`预计用时合计 ${formatMinutes(analysis.includedKnownMinutes)}`} tone="neutral" />
                {analysis.includedUnknownEstimateCount > 0 ? (
                  <Badge text={`缺预计用时 ${analysis.includedUnknownEstimateCount} 条`} tone="warn" />
                ) : null}
                {analysis.overdue.length > 0 ? <Badge text={`已逾期 ${analysis.overdue.length} 个`} tone="clay" /> : null}
                {analysis.beyondWindow.length > 0 ? (
                  <Badge text={`7 天之外 ${analysis.beyondWindow.length} 个（未计入）`} tone="muted" />
                ) : null}
                <Badge text={`任务集中（每天 ≥${CONCENTRATION_THRESHOLD} 项）`} tone="muted" />
              </View>
              {analysis.includedUnknownEstimateCount > 0 ? (
                <Text style={styles.warnLine}>
                  有 {analysis.includedUnknownEstimateCount} 条任务缺预计用时，下面每一天的合计只是「已填部分」，
                  不能当作完整的工作量。
                </Text>
              ) : null}
              {analysis.malformedDeadline.length > 0 ? (
                <Text style={styles.warnLine}>
                  另有 {analysis.malformedDeadline.length} 条任务的截止时间格式无法识别，已单独列在下面等你修复（应用不会猜它是哪一天）。
                </Text>
              ) : null}
            </SectionCard>

            {/* ---------------------------- 已逾期 ---------------------------- */}
            <SectionCard
              title="已逾期（未完成）"
              subtitle={
                analysis.overdue.length === 0
                  ? '没有已过截止时间的未完成任务'
                  : `${analysis.overdue.length} 个 · 这里不再计入下面的任何一天，避免重复统计`
              }
            >
              {analysis.overdue.length === 0 ? (
                <Text style={styles.emptyLine}>很好，没有逾期的未完成任务。</Text>
              ) : (
                <>
                  {overdueVisible.map(renderTask)}
                  {!showAllOverdue && analysis.overdue.length > overdueVisible.length ? (
                    <AppButton
                      label={`显示全部 ${analysis.overdue.length} 条`}
                      variant="secondary"
                      compact
                      onPress={() => setShowAllOverdue(true)}
                      accessibilityLabel={`显示全部 ${analysis.overdue.length} 条逾期任务`}
                      accessibilityHint="逾期列表默认只显示前 5 条，展开后可以看到全部"
                    />
                  ) : null}
                  {showAllOverdue && analysis.overdue.length > 5 ? (
                    <AppButton
                      label="只看前 5 条"
                      variant="ghost"
                      compact
                      onPress={() => setShowAllOverdue(false)}
                      accessibilityLabel="折叠逾期任务列表"
                    />
                  ) : null}
                </>
              )}
            </SectionCard>

            {/* ---------------------------- 7 天 ---------------------------- */}
            <SectionCard title="未来 7 天（含今天）" subtitle="点某一天可以看到那一天的完整任务列表">
              {analysis.includedCount === 0 ? (
                <EmptyState
                  title="这 7 天没有到期的未完成任务"
                  description="到期任务会按 DDL 出现在这里。给任务补上截止时间之后，这一页就会显示每天的集中情况。"
                  actionLabel="新建任务"
                  onAction={() => navigation.navigate('TaskForm', {})}
                />
              ) : (
                analysis.days.map((day) => (
                  <DaySection
                    key={day.dateKey}
                    day={day}
                    expanded={expandedDates.has(day.dateKey)}
                    onToggle={() => toggleDay(day.dateKey)}
                    renderTask={renderTask}
                  />
                ))
              )}
            </SectionCard>

            {/* ------------------- 没有 DDL / 需要修复 ------------------- */}
            {analysis.missingDeadline.length > 0 ? (
              <SectionCard
                title="没有截止时间（未计入上面的日期）"
                subtitle={`${analysis.missingDeadline.length} 个 · 应用不会替你猜一个 DDL`}
              >
                {analysis.missingDeadline.map(renderTask)}
              </SectionCard>
            ) : null}

            {analysis.malformedDeadline.length > 0 ? (
              <SectionCard
                title="截止时间无法识别（需要修复）"
                subtitle={`${analysis.malformedDeadline.length} 个 · 这些不会被算到任何一天，请打开任务重新填一个真实时间`}
              >
                {analysis.malformedDeadline.map(renderTask)}
              </SectionCard>
            ) : null}

            {analysis.beyondWindow.length > 0 ? (
              <SectionCard
                title="7 天之外"
                subtitle={`${analysis.beyondWindow.length} 个未完成任务在 ${analysis.windowEndExclusiveDateKey} 之后到期，本次不统计`}
              >
                {analysis.beyondWindow.map(renderTask)}
              </SectionCard>
            ) : null}

            {analysis.includedCount === 0 && analysis.overdue.length === 0 && analysis.missingDeadline.length === 0 ? (
              <SectionCard title="还没有未完成任务" subtitle="这一页只统计「待办 / 进行中」的任务">
                <EmptyState
                  title="先建一个任务"
                  description="添加任务并填上截止时间与预计用时之后，这里会按天显示集中情况。"
                  actionLabel="新建任务"
                  onAction={() => navigation.navigate('TaskForm', {})}
                />
              </SectionCard>
            ) : null}

            <View style={styles.footnote}>
              <Badge
                text={`未完成任务共 ${analysis.activeCount} 个`}
                tone="muted"
                accessibilityLabel={`未完成任务共 ${analysis.activeCount} 个`}
              />
              <Badge text={`已排除已完成/已取消 ${analysis.excludedInactiveCount} 个`} tone="muted" />
            </View>
          </>
        ) : null}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingClear}
        title="清除每日参考用时？"
        message="清除之后不再跟参考用时做比较，只显示每天的条数与合计；任务和课程不会被改动。"
        details={['可以随时再填一个新的参考用时。']}
        confirmLabel="清除参考用时"
        danger
        busy={clearing}
        onConfirm={() => void confirmClearReference()}
        onCancel={() => setPendingClear(false)}
      />

      <ConfirmDialog
        visible={pendingLeaveAction !== null}
        title="离开并丢弃这处修改？"
        message="输入框里的参考用时还没有保存，离开后需要重新填写。"
        details={['点「保存参考用时」就会写下刚才输入的数字。']}
        confirmLabel="丢弃并离开"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeaveAction(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const STATUS_TONES: Record<DayStatusText['tone'], { fg: string }> = {
  neutral: { fg: colors.text },
  warn: { fg: colors.warn },
  clay: { fg: colors.clayDark },
  primary: { fg: colors.primaryDark },
  muted: { fg: colors.textMuted },
}

const styles = StyleSheet.create({
  note: { ...typography.caption, marginTop: spacing.sm },
  bulletList: { gap: spacing.xs },
  bulletItem: { ...typography.bodySoft },
  warnLine: { ...typography.caption, color: colors.clay, marginTop: spacing.sm },
  emptyLine: { ...typography.bodySoft, color: colors.textMuted },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  pressed: { opacity: 0.8 },

  dayCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  dayHead: { padding: spacing.md, minHeight: MIN_TOUCH_SIZE },
  dayHeadTop: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  dayTitle: { ...typography.section },
  todayMark: { ...typography.caption, color: colors.primaryDark },
  dayMeta: { ...typography.caption, marginTop: 2 },
  dayStatus: { ...typography.bodySoft, marginTop: spacing.xs, fontWeight: '600' },
  dayNote: { ...typography.caption, marginTop: 2 },
  dayBody: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surfaceSoft,
  },

  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  taskMain: { flex: 1, minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  taskTitle: { ...typography.body, fontWeight: '600' },
  taskMeta: { ...typography.caption, marginTop: 2 },
  footnote: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
})
