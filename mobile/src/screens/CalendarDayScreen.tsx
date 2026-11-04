/**
 * 日期详情：某一天真实的课程（含时间与地点）与截止任务，任务可点进详情。
 *
 * 这是日历闭环的终点：
 * 月视图 → 点某天 → 本页 → 点某个任务 → 任务详情。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { getDaySummary } from '../domain/calendar'
import { readShanghaiClock } from '../domain/calendarClock'
import { deadlineToShanghaiClock, weekdayName, weekdayOfDateKey } from '../domain/datetime'
import { computeLiveTimetable, countdownLabel } from '../domain/timetableLive'
import { isOverdue, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { TaskCard } from '../ui/TaskCard'
import { AppButton, Badge, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast, taskDeleteDetails } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CalendarStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CalendarStackParamList>
type Route = RouteProp<CalendarStackParamList, 'CalendarDay'>

export function CalendarDayScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const dateKey = route.params.dateKey

  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  /**
   * 上海墙上时间，**只在页面可见时**推进（见 `useFocusClock`）。
   *
   * 注意这里刻意**不**接管导航：把「重新进入日历要看今天」交给父级标签的
   * `tabPress`（在月视图那一层做 `popToTop`），因为这一层无法可靠区分
   * 「用户刚点了这一天」与「用户从别的标签切回来」——两者都是 focus。
   * 猜错就会把用户刚点的那一天强行改成今天。
   */
  const clock = useFocusClock(readShanghaiClock)

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const today = clock.dateKey
  const summary = useMemo(
    () => getDaySummary(dateKey, store.data.schedules, store.data.courses, store.data.tasks, today),
    [dateKey, store.data.courses, store.data.schedules, store.data.tasks, today],
  )

  /** 日历栈里没有任务详情路由，因此走标签栏跳到「任务」栈的详情页。 */
  const openTaskDetail = useCallback(
    (task: Task) => {
      const tabNavigation = navigation.getParent() as
        | { navigate: (name: string, params: { screen: string; params: { id: number } }) => void }
        | undefined
      if (tabNavigation) {
        tabNavigation.navigate('Tasks', { screen: 'TaskDetail', params: { id: task.id } })
      }
    },
    [navigation],
  )

  const toggle = useCallback(
    async (task: Task) => {
      setBusyId(task.id)
      try {
        const updated = await store.toggleTaskComplete(task.id)
        setToast({ text: updated.status === 'DONE' ? '已标记为完成。' : '已恢复为未完成。', tone: 'success' })
      } catch (cause) {
        setToast({ text: cause instanceof Error ? cause.message : '更新失败。', tone: 'error' })
      } finally {
        setBusyId(null)
      }
    },
    [store],
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

  const weekday = weekdayOfDateKey(dateKey)
  const overdueCount = summary.deadlines.filter((entry) => isOverdue(entry.task)).length

  /**
   * 只有**今天**才计算「正在上课 / 下一节」：看历史或未来的某一天时，
   * 那些状态没有意义，也不能显示成「正在上课」。
   */
  const live = useMemo(() => {
    if (dateKey !== clock.dateKey) return null
    return computeLiveTimetable(
      summary.meetings.map((meeting) => meeting.schedule),
      store.data.courses,
      clock.minutes,
    )
  }, [clock.dateKey, clock.minutes, dateKey, store.data.courses, summary.meetings])

  const activeIds = new Set((live?.active ?? []).map((entry) => entry.session.id))
  const nextId = live?.next?.session.id ?? null
  const nextCountdown = countdownLabel(live?.minutesUntilNext ?? null)

  return (
    <>
      <ScreenScaffold
        title={`${dateKey.slice(5)} ${weekday ? weekdayName(weekday) : ''}`}
        subtitle={`${dateKey}${summary.isToday ? '（今天）' : ''} · ${summary.meetings.length} 节课 · ${summary.deadlines.length} 个截止任务`}
      >
        {summary.isToday ? <Badge text="今天" tone="primary" /> : null}
        {overdueCount > 0 ? <Badge text={`${overdueCount} 个已逾期`} tone="clay" /> : null}

        {live && live.phase === 'in-class' ? (
          <View style={styles.liveBoxActive} accessibilityRole="summary">
            <Text style={styles.liveTitleActive}>正在上课</Text>
            {live.active.map((entry) => (
              <Text key={entry.session.id} style={styles.liveBody}>
                {entry.course?.name ?? '未关联课程'} · {entry.session.startTime}–{entry.session.endTime}
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
        ) : live && (live.phase === 'before-first' || live.phase === 'between') && live.next ? (
          <View style={styles.liveBoxNext} accessibilityRole="summary">
            <Text style={styles.liveTitleNext}>{live.phase === 'between' ? '课间 · 下一节课' : '下一节课'}</Text>
            <Text style={styles.liveBody}>
              {live.next.course?.name ?? '未关联课程'} · {live.next.session.startTime}–{live.next.session.endTime}
              {nextCountdown ? ` · ${nextCountdown}后` : ''}
            </Text>
            {live.next.session.location ? <Text style={styles.liveSub}>{live.next.session.location}</Text> : null}
          </View>
        ) : null}

        <SectionCard
          title="当天课程"
          subtitle={summary.meetings.length === 0 ? '这一天没有课' : `${summary.meetings.length} 节`}
        >
          {summary.meetings.length === 0 ? (
            <Text style={styles.muted}>
              按真实课表与教学周规则计算，这一天没有安排课程。
              {store.data.schedules.length === 0 ? '（当前还没有任何课表）' : ''}
            </Text>
          ) : (
            summary.meetings.map((meeting) => (
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
                    {meeting.schedule.periodStart !== null && meeting.schedule.periodEnd !== null
                      ? `第 ${meeting.schedule.periodStart}–${meeting.schedule.periodEnd} 节 · `
                      : ''}
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
          title="当天截止的任务"
          subtitle={
            summary.deadlines.length === 0
              ? '这一天没有任务截止'
              : `${summary.deadlines.length} 个 · 按北京时间排序`
          }
        >
          {summary.deadlines.length === 0 ? (
            <Text style={styles.muted}>
              这一天没有任务到期。没有设置截止时间的任务不会出现在任何一天，它们只在任务列表的「未设置截止时间」分组里。
            </Text>
          ) : (
            summary.deadlines.map((entry) => (
              <View key={entry.task.id}>
                <Text style={styles.deadlineClock}>
                  {deadlineToShanghaiClock(entry.task.deadline) || '只记到日期'}（北京时间）
                </Text>
                <TaskCard
                  task={entry.task}
                  course={store.courseById(entry.task.courseId)}
                  onPress={openTaskDetail}
                  onToggleComplete={toggle}
                  onRequestDelete={setPendingDelete}
                  busy={busyId === entry.task.id}
                />
              </View>
            ))
          )}
        </SectionCard>

        <Text style={styles.note}>
          任务按**截止时间的北京时间自然日**归组，因此手机时区改成 UTC 或纽约也不会把 23:30 的任务挪到第二天。
        </Text>

        <AppButton
          label="返回月视图"
          onPress={() => navigation.goBack()}
          variant="secondary"
          style={styles.back}
          accessibilityLabel="返回日历月视图"
        />
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

const styles = StyleSheet.create({
  muted: { ...typography.bodySoft, color: colors.textMuted },
  note: { ...typography.caption, marginTop: spacing.md, color: colors.textSoft },
  meetingRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
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
    marginBottom: spacing.lg,
    gap: 2,
  },
  liveTitleActive: { ...typography.section, color: colors.primaryDark },
  liveBoxNext: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSoft,
    padding: spacing.md,
    marginBottom: spacing.lg,
    gap: 2,
  },
  liveTitleNext: { ...typography.section },
  liveBody: { ...typography.bodySoft },
  liveSub: { ...typography.caption },
  meetingTime: { ...typography.mono, minWidth: 92 },
  meetingBody: { flex: 1 },
  meetingName: { ...typography.section, fontSize: 16 },
  deadlineClock: { ...typography.label, marginTop: spacing.sm },
  back: { marginTop: spacing.md },
})
