/**
 * 课表冲突检查（原生只读界面）。
 *
 * 这一页只回答一件事：**从今天起 14 天（含今天）里，哪些课表在同一天有真实时间重叠**。
 *
 * 刻意不做的事：
 * - 不写库、不改课表、不合并、不删除、不自动调整任何课程；
 * - 不把「查看课程 / 编辑课表」做成自动修改，用户点进去后仍由现有表单决定要不要保存；
 * - 不把检查结果说成「整个学期都没问题」：页面始终显示检查范围，且只覆盖这 14 天；
 * - 不因为课程记录缺失就丢掉课表：仍用这条课表参与时段比较，只是不给无效的课程链接。
 *
 * 刷新与跨零点沿用 `useFocusClock`：进入页面 / 回到前台立刻读一次，离开页面自动清理
 * 定时器与 AppState 监听；日期一变，`fromDateKey` 跟着变，结果重算。
 */

import React, { useCallback, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import {
  buildCourseConflicts,
  COURSE_CONFLICTS_WINDOW_DAYS,
  type CourseConflictEntry,
  type CourseConflictPair,
  type CourseConflictWarning,
} from '../domain/courseConflicts'
import { readShanghaiClock } from '../domain/calendarClock'
import { weekdayName, weekdayOfDateKey } from '../domain/datetime'
import { useAppStore } from '../store/AppStore'
import {
  AppButton,
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  SectionCard,
} from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import { useFocusClock } from '../ui/useFocusClock'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>

/** 刷新失败时仍展示上一次成功快照，并明确说明「可能不是最新」。 */
function StaleSnapshotNotice({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.ReactElement {
  return (
    <View style={[styles.notice, styles.noticeWarn]} accessibilityRole="alert">
      <Text style={styles.noticeTitle}>这次刷新没有成功</Text>
      <Text style={styles.noticeText}>
        下面显示的是上一次成功读取的课表快照，可能不是最新；已保存的课表不会被这次刷新失败改动。
      </Text>
      <Text style={styles.noticeText}>{message}</Text>
      <AppButton
        label="重新读取"
        onPress={onRetry}
        variant="secondary"
        compact
        style={styles.noticeAction}
        accessibilityLabel="重新读取课表快照"
      />
    </View>
  )
}

function warningKey(warning: CourseConflictWarning, index: number): string {
  return `${warning.scheduleId ?? 'unknown'}-${warning.kind}-${index}`
}

function warningLabel(warning: CourseConflictWarning): string {
  const target = warning.scheduleId === null ? '一条课表' : `课表 #${warning.scheduleId}`
  return `${target}：${warning.message}`
}

function EntryBlock({
  entry,
  dateKey,
  onOpenCourse,
  onEditSchedule,
}: {
  entry: CourseConflictEntry
  dateKey: string
  onOpenCourse: (entry: CourseConflictEntry) => void
  onEditSchedule: (entry: CourseConflictEntry) => void
}): React.ReactElement {
  const weekday = weekdayName(entry.weekday)
  const actionsAvailable = !entry.courseMissing && entry.courseId !== null
  return (
    <View style={styles.entry}>
      <Text style={styles.entryName}>{entry.courseName}</Text>
      <Text style={styles.entryMeta}>
        教师：{entry.teacher ?? '未填写'} · 地点：{entry.location ?? '未填写'}
      </Text>
      <Text style={styles.entryTime}>
        {weekday} {entry.startTime}–{entry.endTime}
      </Text>
      <Text style={styles.entryMeta}>{entry.weekLabel}</Text>
      {entry.courseMissing ? (
        <Text style={styles.entryWarning}>
          课程记录已不在本机；这条课表仍参与时段比较，但无法打开课程详情或课表编辑。
        </Text>
      ) : null}
      {actionsAvailable ? (
        <View style={styles.entryActions}>
          <AppButton
            label="查看课程"
            onPress={() => onOpenCourse(entry)}
            variant="secondary"
            compact
            accessibilityLabel={`查看课程 ${entry.courseName}`}
            accessibilityHint="打开课程详情；不会修改任何课表"
          />
          <AppButton
            label="编辑课表"
            onPress={() => onEditSchedule(entry)}
            variant="ghost"
            compact
            accessibilityLabel={`编辑 ${entry.courseName} 在 ${dateKey} ${weekday} ${entry.startTime} 的课表`}
            accessibilityHint="打开这条课表的编辑表单；保存与否由你决定"
          />
        </View>
      ) : null}
    </View>
  )
}

function PairCard({
  pair,
  onOpenCourse,
  onEditSchedule,
}: {
  pair: CourseConflictPair
  onOpenCourse: (entry: CourseConflictEntry) => void
  onEditSchedule: (entry: CourseConflictEntry) => void
}): React.ReactElement {
  return (
    <View
      style={styles.pairCard}
      accessibilityRole="summary"
      accessibilityLabel={`${pair.dateKey} 冲突：${pair.left.courseName} 与 ${pair.right.courseName}，重叠 ${pair.overlapStart} 到 ${pair.overlapEnd}，共 ${pair.overlapMinutes} 分钟`}
    >
      <View style={styles.pairHead}>
        <Badge text={`${pair.overlapStart}–${pair.overlapEnd}`} tone="clay" />
        <Text style={styles.pairOverlap}>重叠 {pair.overlapMinutes} 分钟</Text>
      </View>
      <View style={styles.pairEntries}>
        <EntryBlock
          entry={pair.left}
          dateKey={pair.dateKey}
          onOpenCourse={onOpenCourse}
          onEditSchedule={onEditSchedule}
        />
        <View style={styles.pairDivider} />
        <EntryBlock
          entry={pair.right}
          dateKey={pair.dateKey}
          onOpenCourse={onOpenCourse}
          onEditSchedule={onEditSchedule}
        />
      </View>
    </View>
  )
}

export function CourseConflictsScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  /** 只读时钟：焦点 / 回前台 / 每 30 秒推进；离开页面由 hook 清理定时器与监听。 */
  const clock = useFocusClock(readShanghaiClock)

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  /**
   * `clock` 参与依赖：每次 focus / AppState active / 定时 tick 都会产生新读数，
   * 因此结果会重新计算；日期变化时窗口起点也随之变化（跨零点不需要额外定时器）。
   */
  const conflicts = useMemo(
    () =>
      buildCourseConflicts({
        schedules: store.data.schedules,
        courses: store.data.courses,
        fromDateKey: clock.dateKey,
      }),
    [clock, store.data.courses, store.data.schedules],
  )

  const groups = useMemo(() => {
    if (conflicts.status !== 'ok') return []
    const byDate = new Map<string, CourseConflictPair[]>()
    for (const pair of conflicts.pairs) {
      const list = byDate.get(pair.dateKey) ?? []
      list.push(pair)
      byDate.set(pair.dateKey, list)
    }
    return [...byDate.entries()].map(([dateKey, pairs]) => ({ dateKey, pairs }))
  }, [conflicts])

  const openCourse = useCallback(
    (entry: CourseConflictEntry) => {
      if (entry.courseId === null || entry.courseMissing) return
      navigation.navigate('CourseDetail', { id: entry.courseId })
    },
    [navigation],
  )

  const editSchedule = useCallback(
    (entry: CourseConflictEntry) => {
      if (entry.courseId === null || entry.courseMissing) return
      navigation.navigate('ScheduleForm', { courseId: entry.courseId, scheduleId: entry.scheduleId })
    },
    [navigation],
  )

  const rangeLine =
    conflicts.status === 'ok'
      ? `今天起 ${COURSE_CONFLICTS_WINDOW_DAYS} 天（含今天） · ${conflicts.fromDateKey} 至 ${conflicts.toDateKey}`
      : `今天起 ${COURSE_CONFLICTS_WINDOW_DAYS} 天（含今天） · 起止日期无法确定`

  const stalePrefix = store.refreshError ? '刷新失败 · 可能是旧快照 · ' : ''
  const headerSubtitle =
    store.status === 'loading'
      ? '只读检查 · 正在读取本机课表…'
      : store.status === 'error'
        ? '只读检查 · 本机数据读取失败'
        : conflicts.status === 'unavailable'
          ? '只读检查 · 当前无法给出结论'
          : conflicts.scheduleCount === 0
            ? '还没有课表 · 只读检查'
            : conflicts.validScheduleCount === 0
              ? '没有可参与比较的课表 · 当前无法给出结论'
              : `${stalePrefix}${conflicts.pairCount} 对冲突 · 涉及 ${conflicts.dateCount} 天 · 只读检查`

  const emptyTitle =
    conflicts.status === 'ok' && conflicts.hasIncompleteData
      ? '在可比较的课表中，这 14 天没有发现时间冲突'
      : '这 14 天没有发现时间冲突'

  return (
    <ScreenScaffold title="课表冲突检查" subtitle={headerSubtitle}>
      {store.refreshError ? (
        <StaleSnapshotNotice message={store.refreshError} onRetry={() => void store.refresh()} />
      ) : null}

      <SectionCard
        title="检查范围"
        subtitle="这是固定窗口，不是整个学期，也不代表更早或更晚的课表没有问题"
      >
        <Text style={styles.range}>{rangeLine}</Text>
        <Text style={styles.muted}>
          今天的课也会检查，包括今天已经过去的时段。每次进入本页会重新读取本机课表；回到前台和跨过零点会用当前已加载的数据重算。
        </Text>
      </SectionCard>

      {store.status === 'loading' ? <LoadingState message="正在读取本机课表…" /> : null}
      {store.status === 'error' ? (
        <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
      ) : null}

      {store.status === 'ready' ? (
        <>
          {conflicts.status === 'unavailable' ? (
            <SectionCard title="无法给出结论" subtitle="这不是「没有冲突」">
              <Text style={styles.unavailable}>{conflicts.reason}</Text>
              <Text style={styles.muted}>请重新读取本机数据；如果问题持续，检查系统日期后再试。</Text>
              <AppButton
                label="重新读取"
                onPress={() => void store.refresh()}
                variant="secondary"
                compact
                style={styles.retryButton}
                accessibilityLabel="重新读取课表数据"
              />
            </SectionCard>
          ) : (
            <>
              {conflicts.warnings.length > 0 || conflicts.missingCourseCount > 0 ? (
                <SectionCard
                  title="有数据未能完整参与检查"
                  subtitle="结果只覆盖通过校验的课表；下面逐条说明原因"
                >
                  {conflicts.warnings.length > 0 ? (
                    <>
                      <Text style={styles.warnTitle}>
                        {conflicts.warnings.length} 条课表因数据问题被跳过
                      </Text>
                      {conflicts.warnings.map((warning, index) => (
                        <Text key={warningKey(warning, index)} style={styles.warnLine}>
                          • {warningLabel(warning)}
                        </Text>
                      ))}
                    </>
                  ) : null}
                  {conflicts.missingCourseCount > 0 ? (
                    <Text style={styles.warnLine}>
                      另外有 {conflicts.missingCourseCount} 条课表的课程记录已不在本机：它们仍按原时段参与比较，
                      但不会提供打不开的课程或课表编辑入口。
                    </Text>
                  ) : null}
                </SectionCard>
              ) : null}

              {conflicts.scheduleCount === 0 ? (
                <EmptyState
                  title="还没有课表"
                  description="先在课程详情里添加课表（星期、开始/结束时间、教学周），然后回到这里检查。"
                  actionLabel="返回课程列表"
                  onAction={() => navigation.navigate('CourseList')}
                />
              ) : conflicts.validScheduleCount === 0 ? (
                <EmptyState
                  title="没有可参与比较的课表"
                  description="现有课表都因为数据问题被跳过，无法判断有没有冲突。请先按上面的原因修正课表。"
                />
              ) : (
                <>
                  <SectionCard
                    title="检查结果"
                    subtitle="一对 = 两条课表在同一天有重叠时段；同一对只显示一次"
                  >
                    <View style={styles.badgeRow}>
                      <Badge
                        text={`${conflicts.pairCount} 对冲突`}
                        tone={conflicts.pairCount > 0 ? 'clay' : 'muted'}
                        accessibilityLabel={`${conflicts.pairCount} 对冲突`}
                      />
                      <Badge
                        text={`涉及 ${conflicts.dateCount} 天`}
                        tone={conflicts.pairCount > 0 ? 'warn' : 'muted'}
                        accessibilityLabel={`冲突涉及 ${conflicts.dateCount} 个不同日期`}
                      />
                      <Badge
                        text={`${conflicts.validScheduleCount}/${conflicts.scheduleCount} 条通过校验`}
                        tone="muted"
                        accessibilityLabel={`共 ${conflicts.scheduleCount} 条课表，其中 ${conflicts.validScheduleCount} 条通过校验`}
                      />
                      {store.refreshError ? (
                        <Badge text="刷新失败 · 可能不是最新" tone="warn" />
                      ) : null}
                    </View>
                    <Text style={styles.muted}>
                      上面的数字是「冲突的课表对」和「涉及的不同日期」，不是冲突课程数；三条课表同时重叠会显示三对。
                    </Text>
                  </SectionCard>

                  {conflicts.pairCount === 0 ? (
                    <EmptyState
                      title={emptyTitle}
                      description="只检查了上面显示的 14 天；这不表示整个学期都没有冲突，也不检查任务或 DDL。"
                    />
                  ) : (
                    groups.map((group) => {
                      const weekday = weekdayOfDateKey(group.dateKey)
                      return (
                        <SectionCard
                          key={group.dateKey}
                          title={`${group.dateKey}${weekday ? ` ${weekdayName(weekday)}` : ''}`}
                          subtitle={`${group.pairs.length} 对冲突`}
                        >
                          {group.pairs.map((pair) => (
                            <PairCard
                              key={pair.key}
                              pair={pair}
                              onOpenCourse={openCourse}
                              onEditSchedule={editSchedule}
                            />
                          ))}
                        </SectionCard>
                      )
                    })
                  )}
                </>
              )}
            </>
          )}

          <Text style={styles.footerNote}>
            本页只读。需要调整时，请进入对应的课程详情或课表表单手动修改；这里不会自动修改任何课表。
          </Text>
        </>
      ) : null}
    </ScreenScaffold>
  )
}

const styles = StyleSheet.create({
  range: { ...typography.body, marginBottom: spacing.xs },
  muted: { ...typography.caption, marginTop: spacing.xs },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  notice: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  noticeWarn: { borderColor: colors.warn, backgroundColor: colors.warnSoft },
  noticeTitle: { ...typography.section, color: colors.warn },
  noticeText: { ...typography.caption },
  noticeAction: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  unavailable: { ...typography.body, color: colors.clayDark },
  retryButton: { marginTop: spacing.md, alignSelf: 'flex-start' },
  warnTitle: { ...typography.label, color: colors.warn, marginBottom: spacing.xs },
  warnLine: { ...typography.caption, marginTop: spacing.xs },
  pairCard: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  pairHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  pairOverlap: { ...typography.label, color: colors.clayDark },
  pairEntries: { gap: spacing.sm },
  pairDivider: { height: 1, backgroundColor: colors.border },
  entry: {
    gap: 2,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
    minHeight: MIN_TOUCH_SIZE,
  },
  entryName: { ...typography.section, fontSize: 16 },
  entryMeta: { ...typography.caption },
  entryTime: { ...typography.body, fontWeight: '600' },
  entryWarning: { ...typography.caption, color: colors.clayDark, marginTop: spacing.xs },
  entryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  footerNote: { ...typography.caption, marginTop: spacing.sm, marginBottom: spacing.xl },
})
