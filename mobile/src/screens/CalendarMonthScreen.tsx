/**
 * 日历月视图：6×7 可点日期网格，每格显示真实的课程与 DDL 数量。
 *
 * - 网格从该月 1 号所在周的**周一**开始（业务周以周一为首日）；
 * - 每格的数字来自 `buildCalendarMonth`：真实课表（尊重教学周与单双周）+ 真实任务 DDL；
 * - 点击任意一天进入该天的详情（课程时间 + 截止任务），形成闭环，不是静态占位；
 * - 逾期未完成的任务所在日期会显示陶土橙圆点。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { buildCalendarMonth, listMeetingsInRange, type MonthCell } from '../domain/calendar'
import { calendarFocusTarget, readShanghaiClock, calendarTabEntryAction } from '../domain/calendarClock'
import { shanghaiToday, weekdayOptions } from '../domain/datetime'
import { computeLiveTimetable, countdownLabel } from '../domain/timetableLive'
import { useAppStore } from '../store/AppStore'
import { AppButton, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { ToolDisclosure } from '../ui/QuickActions'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { CalendarStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CalendarStackParamList>

/**
 * 父级标签导航器的最小形状（只要 `addListener('tabPress')`）。
 *
 * 刻意**不** import 具体导航库类型：这一层只需要「标签被按了」这一个能力。
 * 去推测导航内部生命周期（例如初次 focus 时 `isFocused()` 是什么）反而容易写错。
 */
interface TabEntryNavigation {
  addListener: (event: 'tabPress', callback: () => void) => () => void
}

/** 日历栈的导航状态：只需要路由数量，判断栈里是否压着「某一天」。 */
interface StackNavigationStateLike {
  routes?: Array<{ name?: string }>
}

const WEEKDAY_HEADERS = weekdayOptions.map((option) => option.label)

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = month - 1 + delta
  const nextYear = year + Math.floor(zeroBased / 12)
  const nextMonth = ((zeroBased + 12) % 12) % 12
  return { year: nextYear, month: nextMonth + 1 }
}

/** `YYYY-MM-DD` → 该月的 `{year, month}`；不可解析时返回 `null`。 */
function monthOfDateKey(dateKey: string): { year: number; month: number } | null {
  const year = Number(dateKey.slice(0, 4))
  const month = Number(dateKey.slice(5, 7))
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null
  return { year, month }
}

export function CalendarMonthScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  /** 焦点时钟：进入日历立刻读一次，离开就停（见 `useFocusClock`）。 */
  const clock = useFocusClock(readShanghaiClock)
  const [cursor, setCursor] = useState(() => monthOfDateKey(shanghaiToday()) ?? { year: 2026, month: 1 })

  const today = clock.dateKey

  /**
   * 把显示月份设回**当前**上海日期所在月。
   *
   * 刻意在执行时重新读时钟（而不是用渲染时的 `today`）：跨过午夜后回到 App，
   * 拿到的是新的一天。`useCallback([])` 保证焦点回调的依赖是稳定引用，
   * 普通渲染 / store 刷新都不会重新触发重置。
   */
  const resetToToday = useCallback(() => {
    setCursor(calendarFocusTarget().cursor)
  }, [])

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      // 从日期详情返回只刷新内容，保留用户浏览的月份。
      // 回到今天由底部标签 tabPress 或显式按钮触发，不与栈内返回混用。
      void refresh()
      return undefined
    }, [refresh]),
  )

  /**
   * 按下「日历」标签（包含**已经选中**时再按一次）时的统一动作。
   *
   * 场景一：用户在「某一天」详情里 → 切到别的标签 → 再点「日历」标签回来。
   * 这时日历栈仍然是 `[月视图, 某一天]`，不归位的话用户会看到上次那个过去的日期。
   * 场景二：用户翻到了别的月份 → 在已经选中的「日历」标签上再按一次。
   * 这时栈只有月视图一层，导航不需要动，但显示月份要回到今天。
   *
   * 两件事合起来做：**总是** `resetToToday()`（执行时重新读时钟），
   * 只有栈里压着「某一天」时才 `popToTop()`（由 `calendarTabEntryAction` 决定）。
   *
   * 为什么用父级 `tabPress` 而不是在详情页监听自己的 `focus`：
   * 后者无法区分「点击某一天时自己的首次 focus」与「切标签回来时的 focus」
   * （两者 `isFocused()` 都可能为真），会把用户刚点的那一天强行改成今天。
   * 标签按下是**唯一没有歧义**的入口信号；进去之后用户仍可在栈内自由浏览
   * （点某一天 / 从某一天返回月视图都不会触发这里）。
   */
  useEffect(() => {
    const tabNavigation = navigation.getParent() as unknown as TabEntryNavigation | undefined
    if (!tabNavigation?.addListener) return undefined
    const unsubscribe = tabNavigation.addListener('tabPress', () => {
      const state = navigation.getState() as StackNavigationStateLike | undefined
      const action = calendarTabEntryAction(state?.routes?.length ?? 0)
      if (action.resetToToday) resetToToday()
      if (action.popToTop) navigation.popToTop()
    })
    return unsubscribe
  }, [navigation, resetToToday])

  /** 今天的真实课时（已按学期 / 单双周 / 星期过滤）。 */
  const liveTimetable = useMemo(
    () =>
      computeLiveTimetable(
        listMeetingsInRange(store.data.schedules, store.data.courses, today, today).map((meeting) => meeting.schedule),
        store.data.courses,
        clock.minutes,
      ),
    [clock.minutes, store.data.courses, store.data.schedules, today],
  )

  const month = useMemo(
    () =>
      buildCalendarMonth({
        year: cursor.year,
        month: cursor.month,
        schedules: store.data.schedules,
        courses: store.data.courses,
        tasks: store.data.tasks,
        today,
      }),
    [cursor.month, cursor.year, store.data.courses, store.data.schedules, store.data.tasks, today],
  )

  const monthTotals = useMemo(() => {
    let meetings = 0
    let deadlines = 0
    for (const cell of month.cells) {
      if (!cell.inMonth) continue
      meetings += cell.meetingCount
      deadlines += cell.deadlineCount
    }
    return { meetings, deadlines }
  }, [month.cells])

  /** 「回到今天」按钮与进入页面用的是同一套逻辑（执行时重新读时钟）。 */
  const goToday = resetToToday

  const openDay = useCallback(
    (cell: MonthCell) => {
      navigation.navigate('CalendarDay', { dateKey: cell.dateKey })
    },
    [navigation],
  )

  const nextCountdown = countdownLabel(liveTimetable.minutesUntilNext)
  const nextLabel = liveTimetable.next
    ? `${liveTimetable.next.course?.name ?? '未关联课程'} ${liveTimetable.next.session.startTime}` +
      `${nextCountdown ? ` · ${nextCountdown}后` : ''}`
    : null

  return (
    <ScreenScaffold
      title={`${cursor.year} 年 ${cursor.month} 月`}
      subtitle={`本月 ${monthTotals.meetings} 节课 · ${monthTotals.deadlines} 个截止任务 · 点某一天看当天安排`}
      headerAccessory={
        <AppButton label="回到今天" onPress={goToday} variant="secondary" compact accessibilityLabel="回到今天" />
      }
    >
      {/* 今天这一天的实时状态：正在上课 / 下一节 / 今天没课。 */}
      <SectionCard
        title="今天的课"
        subtitle={`${today} · ${liveTimetable.sessions.length} 节`}
      >
        {liveTimetable.phase === 'in-class' ? (
          <View style={styles.liveBoxActive} accessibilityRole="summary">
            <Text style={styles.liveTitleActive}>正在上课</Text>
            {liveTimetable.active.map((entry) => (
              <Text key={entry.session.id} style={styles.liveBody}>
                {entry.course?.name ?? '未关联课程'} · {entry.session.startTime}–{entry.session.endTime}
                {nextLabel ? `　下一节：${nextLabel}` : ''}
              </Text>
            ))}
          </View>
        ) : liveTimetable.phase === 'before-first' || liveTimetable.phase === 'between' ? (
          <View style={styles.liveBoxNext} accessibilityRole="summary">
            <Text style={styles.liveTitleNext}>
              {liveTimetable.phase === 'between' ? '课间 · 下一节课' : '下一节课'}
            </Text>
            <Text style={styles.liveBody}>{nextLabel ?? '（时间待补充）'}</Text>
            {liveTimetable.next?.session.location ? (
              <Text style={styles.liveSub}>{liveTimetable.next.session.location}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.liveIdle}>
            {liveTimetable.sessions.length === 0
              ? '今天没有安排课程。'
              : '今天的课都上完了。'}
          </Text>
        )}
      </SectionCard>

      <View style={styles.monthNav}>
        <AppButton
          label="上一月"
          onPress={() => setCursor((prev) => shiftMonth(prev.year, prev.month, -1))}
          variant="secondary"
          compact
          accessibilityLabel="查看上一月"
        />
        <AppButton
          label="下一月"
          onPress={() => setCursor((prev) => shiftMonth(prev.year, prev.month, 1))}
          variant="secondary"
          compact
          accessibilityLabel="查看下一月"
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.gridContainer}>
      <View style={styles.grid}>
        <View style={styles.headerRow}>
          {WEEKDAY_HEADERS.map((label) => (
            <View key={label} style={styles.headerCell}>
              <Text style={styles.headerText}>{label.replace('周', '')}</Text>
            </View>
          ))}
        </View>

        {Array.from({ length: 6 }, (_, weekIndex) => (
          <View key={`week-${weekIndex}`} style={styles.weekRow}>
            {month.cells.slice(weekIndex * 7, weekIndex * 7 + 7).map((cell) => (
              <DayCell key={cell.dateKey} cell={cell} onPress={openDay} />
            ))}
          </View>
        ))}
      </View>
      </ScrollView>

      <ToolDisclosure title="日历说明">
      <SectionCard title="图例" subtitle="数字是当天的真实条数">
        <Text style={styles.legend}>• 节课 = 当天按教学周规则实际上课的门数</Text>
        <Text style={styles.legend}>• DDL = 当天截止的任务数（按北京时间自然日归组）</Text>
        <Text style={styles.legend}>• 陶土橙圆点 = 那天有逾期未完成的任务</Text>
        <Text style={styles.legend}>• 灰色日期 = 不属于本月（仍可点击查看）</Text>
        <Text style={styles.note}>
          未设置截止时间的任务不会出现在任何一天上——应用不会替它猜一个日期。
          {store.data.schedules.length === 0 ? ' 当前还没有课表，所以每节课数都是 0。' : ''}
        </Text>
      </SectionCard>
      </ToolDisclosure>
    </ScreenScaffold>
  )
}

function DayCell({ cell, onPress }: { cell: MonthCell; onPress: (cell: MonthCell) => void }): React.ReactElement {
  const parts: string[] = [`${cell.dateKey}`]
  if (cell.isToday) parts.push('今天')
  parts.push(cell.meetingCount > 0 ? `${cell.meetingCount} 节课` : '没有课')
  parts.push(cell.deadlineCount > 0 ? `${cell.deadlineCount} 个 DDL` : '没有 DDL')
  if (cell.hasOverdue) parts.push('有逾期任务')

  return (
    <Pressable
      onPress={() => onPress(cell)}
      accessibilityRole="button"
      accessibilityLabel={parts.join('，')}
      accessibilityHint="查看这一天的课程与截止任务"
      style={({ pressed }) => [
        styles.cell,
        !cell.inMonth && styles.cellOutside,
        cell.isToday && styles.cellToday,
        pressed && styles.cellPressed,
      ]}
    >
      <Text style={[styles.cellDay, !cell.inMonth && styles.cellDayOutside, cell.isToday && styles.cellDayToday]}>
        {cell.day}
      </Text>
      <View style={styles.cellBody}>
        {cell.meetingCount > 0 ? <Text style={styles.cellMeeting}>{cell.meetingCount} 课</Text> : null}
        {cell.deadlineCount > 0 ? <Text style={styles.cellDeadline}>{cell.deadlineCount} DDL</Text> : null}
        {cell.hasOverdue ? <View style={styles.overdueDot} /> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  monthNav: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.md },
  gridContainer: { flexGrow: 1, paddingBottom: spacing.lg },
  grid: { flex: 1, minWidth: 322, backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing.md },
  headerRow: { flexDirection: 'row' },
  headerCell: { flex: 1, alignItems: 'center', paddingVertical: spacing.xs },
  headerText: { ...typography.label, fontSize: 12 },
  weekRow: { flexDirection: 'row' },
  cell: {
    flex: 1,
    minWidth: MIN_TOUCH_SIZE,
    minHeight: 76,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    padding: 4,
    borderRadius: radius.sm,
    margin: 1,
  },
  cellOutside: { backgroundColor: colors.surfaceSoft },
  cellToday: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.primaryTint },
  cellPressed: { backgroundColor: colors.primarySoft },
  cellDay: { ...typography.mono, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  cellDayOutside: { color: colors.textMuted },
  cellDayToday: { color: colors.primaryDark, fontWeight: '700' },
  cellBody: { marginTop: 2, gap: 1 },
  cellMeeting: { fontSize: 10, color: colors.primaryDark },
  cellDeadline: { fontSize: 10, color: colors.clayDark },
  overdueDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.clay, marginTop: 2 },
  legend: { ...typography.caption, marginBottom: 2 },
  note: { ...typography.caption, marginTop: spacing.sm, color: colors.textSoft },
  liveBoxActive: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    padding: spacing.md,
    gap: 2,
  },
  liveTitleActive: { ...typography.section, color: colors.primaryDark },
  liveBoxNext: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceSoft,
    padding: spacing.md,
    gap: 2,
  },
  liveTitleNext: { ...typography.section },
  liveBody: { ...typography.bodySoft },
  liveSub: { ...typography.caption },
  liveIdle: { ...typography.caption, color: colors.textSoft },
})
