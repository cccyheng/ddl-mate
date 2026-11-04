/**
 * 「今天」页：真实日期、真实统计、真实排序，没有静态占位数据。
 *
 * 数据全部来自本机 SQLite 快照：
 * - 问候语与日期来自 `Asia/Shanghai` 当前时间；
 * - 统计（逾期 / 今天 / 7 天内 / 已完成）由 `computeTaskStats` 真实计算；
 * - 分组排序由 `bucketToday` 给出，页面不改顺序；
 * - 今日课程由真实课表 + 教学周规则算出，而不是写死的示例。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { bucketToday, computeTaskStats, getDaySummary } from '../domain/calendar'
import { readShanghaiEpochClock } from '../domain/calendarClock'
import { analyzeDdlPressure, CONCENTRATION_THRESHOLD, formatMinutes } from '../domain/ddlPressure'
import { shanghaiToday, weekdayName, weekdayOfDateKey } from '../domain/datetime'
import { computeLiveTimetable, countdownLabel } from '../domain/timetableLive'
import type { Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { TaskCard } from '../ui/TaskCard'
import { AppButton, Badge, EmptyState, RefreshErrorBanner, SectionCard } from '../ui/components'
import { ReminderSyncNotice } from '../ui/ReminderSyncNotice'
import { ConfirmDialog, Toast, taskDeleteDetails } from '../ui/dialog'
import { QuickActions, ToolDisclosure } from '../ui/QuickActions'
import { WeeklyGoalCard } from '../ui/WeeklyGoalCard'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { TodayStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<TodayStackParamList>

function greeting(now: Date = new Date()): string {
  // 用北京时间的小时决定问候语，避免手机时区不同导致「早上好」出现在深夜。
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now),
  )
  if (hour < 6) return '夜深了'
  if (hour < 11) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export function TodayScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [recoverySaveBusy, setRecoverySaveBusy] = useState(false)

  /**
   * 上海墙上时钟：**页面可见时**每 30 秒推进一次，离开页面就停。
   *
   * 取代原来那个 `useEffect([])` 的 60 秒定时器：标签切走之后 React Navigation
   * 并不会卸载这一页，旧定时器会一直在后台空转；而「今日课表 / 正在上课」这类
   * 时间敏感的展示需要的是「回到前台立刻正确」，不是「后台继续跑」。
   * 顺带把跨零点问题也解决了：`clock.dateKey` 会跟着定时器前进。
   *
   * 这里读的是**带真实毫秒**的时钟（`readShanghaiEpochClock`）：
   * 逾期判定要按完整时刻比较，把「现在」截断到分钟会让同一分钟内的先后判错，
   * 也会让首页的压力小结与压力分析页得出不一样的逾期数。`clock.minutes`
   * 继续留给「正在上课 / 下一节」这类分钟级高亮使用。
   */
  const clock = useFocusClock(readShanghaiEpochClock)

  /** 今天的北京时间自然日（跟着 clock 跨零点）。 */
  const today = clock.dateKey
  /** 「现在」= 时钟读到的真实时刻（含秒与毫秒），供任务统计 / 分组 / 压力小结使用。 */
  const now = useMemo(() => new Date(clock.epochMs), [clock.epochMs])
  const weekday = weekdayOfDateKey(today)

  const buckets = useMemo(() => bucketToday(store.data.tasks, now), [store.data.tasks, now])
  const stats = useMemo(() => computeTaskStats(store.data.tasks, now), [store.data.tasks, now])
  const daySummary = useMemo(
    () => getDaySummary(today, store.data.schedules, store.data.courses, store.data.tasks, today),
    [today, store.data.schedules, store.data.courses, store.data.tasks],
  )
  /**
   * DDL 压力分析（**与压力分析页共用同一份纯函数结果**，页面上不重复任何公式）。
   * 今天这一格只做一个小入口，不把整张 7 天表塞进首页。
   */
  const pressure = useMemo(
    () =>
      analyzeDdlPressure({
        tasks: store.data.tasks,
        referenceMinutes: store.studyReferenceMinutes,
        now,
      }),
    [now, store.data.tasks, store.studyReferenceMinutes],
  )
  /** 今日课表的实时状态：正在上课 / 下一节。 */
  const live = useMemo(
    () => computeLiveTimetable(daySummary.meetings.map((meeting) => meeting.schedule), store.data.courses, clock.minutes),
    [clock.minutes, daySummary.meetings, store.data.courses],
  )
  const activeIds = new Set(live.active.map((entry) => entry.session.id))
  const nextId = live.next?.session.id ?? null
  const nextCountdown = countdownLabel(live.minutesUntilNext)

  // 回到本页时重新读一次快照；`refreshError` 由 store 单独记录，
  // 读取失败不会被说成「保存失败」。
  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const openDetail = useCallback(
    (task: Task) => {
      navigation.navigate('TaskDetail', { id: task.id })
    },
    [navigation],
  )

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setBusyId(target.id)
    try {
      await store.deleteTask(target.id)
      setToast({ text: `已删除任务「${target.title}」。`, tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除失败。', tone: 'error' })
    } finally {
      setBusyId(null)
      setPendingDelete(null)
    }
  }, [pendingDelete, store])

  const toggle = useCallback(
    async (task: Task) => {
      setBusyId(task.id)
      try {
        const updated = await store.toggleTaskComplete(task.id)
        setToast({
          text: updated.status === 'DONE' ? `已完成「${updated.title}」。` : `已把「${updated.title}」标回未完成。`,
          tone: 'success',
        })
      } catch (cause) {
        setToast({ text: cause instanceof Error ? cause.message : '更新失败。', tone: 'error' })
      } finally {
        setBusyId(null)
      }
    },
    [store],
  )

  const handleSaveRecovery = useCallback(async (fileName: string) => {
    setRecoverySaveBusy(true)
    try {
      const outcome = await store.backup.saveRecoveryToFiles(fileName)
      if (outcome.kind === 'ok') {
        setToast({ text: `恢复备份已保存：${outcome.fileName ?? fileName}`, tone: 'success' })
      } else if (outcome.kind === 'canceled') {
        setToast({ text: '已取消，没有写出恢复备份。', tone: 'success' })
      } else if (outcome.kind === 'error') {
        setToast({ text: outcome.reason ?? '保存恢复备份失败。', tone: 'error' })
      }
    } finally {
      setRecoverySaveBusy(false)
    }
  }, [store])

  const renderTask = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      course={store.courseById(task.courseId)}
      onPress={openDetail}
      onToggleComplete={toggle}
      onRequestDelete={setPendingDelete}
      busy={busyId === task.id}
    />
  )

  return (
    <>
      <ScreenScaffold
        title={`${greeting()}，今天也从容一点`}
        subtitle={`${today} · ${weekday ? weekdayName(weekday) : ''} · 北京时间`}
        headerAccessory={
          <AppButton
            label="新建任务"
            onPress={() => navigation.navigate('TaskForm', {})}
            compact
            accessibilityLabel="新建任务"
          />
        }
      >
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}
        <ReminderSyncNotice />
        <AppButton label="搜索任务、课程、考试与笔记" variant="secondary" onPress={() => navigation.navigate('GlobalSearch')} style={{ marginBottom: spacing.lg }} accessibilityLabel="打开全局搜索" />
        {store.backupLastRestore ? (
          <SectionCard title="恢复完成" subtitle="数据已整库替换；旧提醒已按安全流程处理">
            <Text style={styles.muted}>
              {store.backupLastRestore.result.counts.tasks} 个任务、{store.backupLastRestore.result.counts.courses} 门课程、{store.backupLastRestore.result.counts.schedules} 条课表、{store.backupLastRestore.result.counts.images} 张截图。
            </Text>
            {store.backupLastRestore.refreshError ? (
              <Text style={styles.warnText}>
                数据已经恢复成功，只是列表没有重新读取出来：{store.backupLastRestore.refreshError}
              </Text>
            ) : null}
            {store.backupLastRestore.navigationResetFailed ? (
              <Text style={styles.warnText}>
                根导航没有确认完成重建；为避免旧表单写回，写入仍被锁住。请点「重试界面重置」。
              </Text>
            ) : null}
            {store.backupLastRestore.notificationWarning ? (
              <Text style={styles.warnText}>
                {store.backupLastRestore.notificationWarning}
              </Text>
            ) : null}
            {store.backupLastRestore.result.recoveryBackup ? (
              <Text style={styles.muted}>
                恢复前的完整备份：{store.backupLastRestore.result.recoveryBackup.fileName}
              </Text>
            ) : null}
            <View style={styles.backupActions}>
              {store.backupLastRestore.refreshError ? (
                <AppButton label="重新读取" compact variant="secondary" onPress={() => void store.refresh()} />
              ) : null}
              {store.backupLastRestore.navigationResetFailed ? (
                <AppButton
                  label="重试界面重置"
                  compact
                  variant="secondary"
                  onPress={() => {
                    void store.backup.retryNavigationReset().then((result) => {
                      setToast({
                        text: result.ok ? '界面已重建，恢复后的写入闸门已释放。' : result.reason ?? '界面仍未完成重建。',
                        tone: result.ok ? 'success' : 'error',
                      })
                    })
                  }}
                />
              ) : null}
              {store.backupLastRestore.notificationWarning ? (
                <AppButton
                  label="重试取消旧提醒"
                  compact
                  variant="secondary"
                  onPress={() => {
                    void store.backup.retryNotificationCleanup().then((result) => {
                      setToast({
                        text: result.ok ? '旧提醒已经确认取消，提醒服务已恢复。' : result.reason ?? '仍未能取消旧提醒。',
                        tone: result.ok ? 'success' : 'error',
                      })
                    })
                  }}
                />
              ) : null}
              {store.backupLastRestore.result.recoveryBackup ? (
                <AppButton
                  label="保存恢复备份"
                  compact
                  variant="secondary"
                  loading={recoverySaveBusy}
                  disabled={recoverySaveBusy}
                  onPress={() => void handleSaveRecovery(store.backupLastRestore!.result.recoveryBackup!.fileName)}
                />
              ) : null}
              <AppButton label="知道了" compact variant="ghost" onPress={store.dismissBackupLastRestore} />
            </View>
          </SectionCard>
        ) : null}
        <WeeklyGoalCard now={clock.epochMs} />
        <View style={styles.statsRow}>
          <StatCell label="已逾期" value={stats.overdue} tone={stats.overdue > 0 ? 'clay' : 'muted'} />
          <StatCell label="今天截止" value={stats.today} tone={stats.today > 0 ? 'warn' : 'muted'} />
          <StatCell label="7 天内" value={stats.next7Days} tone="neutral" />
          <StatCell label="已完成" value={stats.done} tone="success" />
        </View>

        <SectionCard
          title="今日课程"
          subtitle={
            daySummary.meetings.length === 0
              ? '今天没有课程，留一点时间给自己'
              : `共 ${daySummary.meetings.length} 节`
          }
        >
          {/* 实时状态：正在上课 / 下一节（与日历页共用同一套纯函数判定）。 */}
          {live.phase === 'in-class' ? (
            <View style={styles.liveBoxActive} accessibilityRole="summary">
              <Text style={styles.liveTitleActive}>正在上课</Text>
              {live.active.map((entry) => (
                <Text key={entry.session.id} style={styles.liveBody}>
                  {entry.course?.name ?? '未关联课程'} · {entry.session.startTime}–{entry.session.endTime}
                  {entry.session.location ? ` · ${entry.session.location}` : ''}
                </Text>
              ))}
              {live.next ? (
                <Text style={styles.liveSub}>
                  下一节：{live.next.course?.name ?? '未关联课程'} {live.next.session.startTime}
                  {nextCountdown ? ` · ${nextCountdown}后` : ''}
                </Text>
              ) : (
                <Text style={styles.liveSub}>这是今天最后一节课。</Text>
              )}
            </View>
          ) : (live.phase === 'before-first' || live.phase === 'between') && live.next ? (
            <View style={styles.liveBoxNext} accessibilityRole="summary">
              <Text style={styles.liveTitleNext}>{live.phase === 'between' ? '课间 · 下一节课' : '下一节课'}</Text>
              <Text style={styles.liveBody}>
                {live.next.course?.name ?? '未关联课程'} · {live.next.session.startTime}–{live.next.session.endTime}
                {nextCountdown ? ` · ${nextCountdown}后` : ''}
              </Text>
              {live.next.session.location ? <Text style={styles.liveSub}>{live.next.session.location}</Text> : null}
            </View>
          ) : null}
          {daySummary.meetings.length === 0 ? (
            <Text style={styles.muted}>
              还没有安排课程，可以到「课程」添加或拍照导入课表。
            </Text>
          ) : (
            daySummary.meetings.map((meeting) => (
              <View
                key={`${meeting.schedule.id}-${meeting.dateKey}`}
                style={[
                  styles.meetingRow,
                  activeIds.has(meeting.schedule.id) && styles.meetingRowActive,
                  meeting.schedule.id === nextId && styles.meetingRowNext,
                ]}
              >
                <Text style={styles.meetingTime}>
                  {meeting.schedule.startTime}–{meeting.schedule.endTime}
                </Text>
                <View style={styles.meetingBody}>
                  <Text style={styles.meetingName}>{meeting.course?.name ?? '未关联课程'}</Text>
                  <Text style={styles.muted}>
                    {meeting.schedule.location ? `${meeting.schedule.location} · ` : ''}
                    {meeting.schedule.weekPattern === 'ALL'
                      ? '每周'
                      : meeting.schedule.weekPattern === 'ODD'
                        ? '单周'
                        : '双周'}
                  </Text>
                  {activeIds.has(meeting.schedule.id) ? (
                    <Text style={styles.liveBadgeActive}>正在上课</Text>
                  ) : meeting.schedule.id === nextId ? (
                    <Text style={styles.liveBadgeNext}>
                      下一节课{nextCountdown ? ` · ${nextCountdown}后` : ''}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))
          )}
        </SectionCard>

        <SectionCard
          title="今日学习计划"
          subtitle="选择空闲时段，安排今天要做的事"
        >

          <AppButton
            label="安排今天的学习计划"
            variant="secondary"
            compact
            onPress={() => navigation.navigate('TodayPlan')}
            accessibilityLabel="打开今日学习计划"
            accessibilityHint="填写今天的学习时段、选择任务并给出各自计划分钟数，先看只读预览再保存"
          />
        </SectionCard>

        {buckets.overdue.length > 0 ? <SectionCard
          title="已逾期"
          subtitle={`${buckets.overdue.length} 个未完成且已过截止时间`}
        >
          {buckets.overdue.map(renderTask)}
        </SectionCard> : null}

        {buckets.dueToday.length > 0 ? <SectionCard
          title="今天截止"
          subtitle={`${buckets.dueToday.length} 个`}
        >
          {buckets.dueToday.map(renderTask)}
        </SectionCard> : null}

        {buckets.doneToday.length > 0 ? (
          <ToolDisclosure title={`今天已完成（${buckets.doneToday.length} 个）`}>
            {buckets.doneToday.slice(0, 6).map(renderTask)}
            {buckets.doneToday.length > 6 ? <Text style={styles.muted}>这里只展示 6 条，全部记录可在「任务 → 已完成」查看。</Text> : null}
          </ToolDisclosure>
        ) : null}

        <SectionCard
          title="接下来"
          subtitle={
            buckets.upcoming.length === 0
              ? undefined
              : `最近 ${Math.min(buckets.upcoming.length, 6)} 条（含未设置 DDL 的任务）`
          }
        >
          {buckets.upcoming.length === 0 ? (
            <EmptyState
              compact
              title={store.data.tasks.length === 0 ? '还没有待办任务' : buckets.overdue.length + buckets.dueToday.length > 0 ? '暂无后续安排' : '待办已清空'}
              description={store.data.tasks.length === 0 ? '记下一件要做的事，从这里开始。' : buckets.overdue.length + buckets.dueToday.length > 0 ? '先完成上面的任务，再安排下一步。' : '这一刻可以放松一下，也可以安排新的目标。'}
              actionLabel="新建任务"
              onAction={() => navigation.navigate('TaskForm', {})}
            />
          ) : (
            buckets.upcoming.slice(0, 6).map(renderTask)
          )}
        </SectionCard>

        <View style={styles.footnote}>
          <Badge text={`共 ${stats.total} 个任务`} tone="muted" />
          {stats.noDeadline > 0 ? <Badge text={`${stats.noDeadline} 个未设置 DDL`} tone="warn" /> : null}
        </View>
        <SectionCard
          title="DDL 压力分析"
          subtitle={`未来 7 天（含今天）：未完成任务 ${pressure.includedCount} 个 · 预计用时合计 ${formatMinutes(pressure.includedKnownMinutes)}`}
        >
          <Text style={styles.muted}>
            按 DDL 的上海日期分组，只看「待办 / 进行中」的任务；预计用时合计取任务自己填的原始值，
            不是剩余工作量（进行中的进度没有被测量）。
          </Text>
          <View style={styles.pressureBadges}>
            {pressure.includedUnknownEstimateCount > 0 ? (
              <Badge text={`缺预计用时 ${pressure.includedUnknownEstimateCount} 条（统计不完整）`} tone="warn" />
            ) : null}
            {pressure.overdue.length > 0 ? <Badge text={`已逾期 ${pressure.overdue.length} 个`} tone="clay" /> : null}
            {pressure.beyondWindow.length > 0 ? (
              <Badge text={`7 天之外 ${pressure.beyondWindow.length} 个（未计入）`} tone="muted" />
            ) : null}
            <Badge text={`任务集中（每天 ≥${CONCENTRATION_THRESHOLD} 项）`} tone="muted" />
          </View>
          <AppButton
            label="打开 7 天压力分析"
            variant="secondary"
            compact
            onPress={() => navigation.navigate('Pressure')}
            accessibilityLabel="打开未来 7 天的 DDL 压力分析"
            accessibilityHint="查看每一天的到期集中情况、逾期任务与每日参考用时设置"
          />
        </SectionCard>

        <QuickActions title="学习工具" actions={[
          { label: '专注计时', onPress: () => navigation.navigate('FocusTime') },
          { label: '考试与复习', onPress: () => navigation.navigate('Exams') },
          { label: '学习周报', onPress: () => navigation.navigate('LearningReport') },
          { label: '任务模板', onPress: () => navigation.navigate('TaskTemplateList') },
          { label: '备份与恢复', onPress: () => navigation.navigate('Backup') },
        ]} />
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="删除这个任务？"
        details={pendingDelete ? taskDeleteDetails(pendingDelete.title, store.data.originalTexts.has(pendingDelete.id)) : []}
        confirmLabel="删除任务"
        danger
        busy={busyId !== null}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

type StatTone = 'clay' | 'warn' | 'success' | 'neutral' | 'muted'

const STAT_TONES: Record<StatTone, { bg: string; border: string; fg: string }> = {
  clay: { bg: colors.claySoft, border: colors.clay, fg: colors.clayDark },
  warn: { bg: colors.warnSoft, border: colors.warn, fg: colors.warn },
  success: { bg: colors.primarySoft, border: colors.primary, fg: colors.primaryDark },
  neutral: { bg: colors.surfaceSoft, border: colors.border, fg: colors.text },
  muted: { bg: colors.surfaceSoft, border: colors.border, fg: colors.textMuted },
}

function StatCell({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: StatTone
}): React.ReactElement {
  const style = STAT_TONES[tone]
  return (
    <View
      style={[styles.statCell, { backgroundColor: style.bg, borderColor: style.border }]}
      accessibilityRole="text"
      accessibilityLabel={`${label} ${value} 个`}
    >
      <Text style={[styles.statValue, { color: style.fg }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  statCell: {
    flexGrow: 1, flexBasis: '43%', minWidth: 0,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { ...typography.caption, fontSize: 12 },
  muted: { ...typography.bodySoft, color: colors.textMuted },
  warnText: { ...typography.caption, color: colors.warn, marginTop: spacing.xs },
  backupActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  pressureBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.md },
  meetingRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm },
  meetingRowActive: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    paddingLeft: spacing.sm,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.sm,
  },
  meetingRowNext: {
    borderLeftWidth: 3,
    borderLeftColor: colors.borderStrong,
    paddingLeft: spacing.sm,
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.sm,
  },
  liveBadgeActive: { ...typography.caption, color: colors.primaryDark, fontWeight: '700', marginTop: 2 },
  liveBadgeNext: { ...typography.caption, color: colors.textSoft, marginTop: 2 },
  liveBoxActive: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 2,
  },
  liveTitleActive: { ...typography.section, color: colors.primaryDark },
  liveBoxNext: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSoft,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: 2,
  },
  liveTitleNext: { ...typography.section },
  liveBody: { ...typography.bodySoft },
  liveSub: { ...typography.caption },
  meetingTime: { ...typography.mono, minWidth: 92 },
  meetingBody: { flex: 1 },
  meetingName: { ...typography.section, fontSize: 16 },
  footnote: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
})
