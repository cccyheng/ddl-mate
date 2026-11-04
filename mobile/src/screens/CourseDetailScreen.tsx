/**
 * 课程详情：课程信息 + 这门课的课表（增 / 改 / 删）+ 关联任务 + 教学周时间线。
 *
 * 本页是课表增删的唯一入口（`ScheduleForm` 之前写好了但没有入口，属于断掉的闭环）。
 * 删除课表需要二次确认；删除课程同样受引用保护，并明确告知任务会被保留。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { courseColorOf, type Schedule } from '../domain/types'
import { describeTerm } from '../domain/courseDraft'
import { termLastDate } from '../domain/scheduleRules'
import { addDaysToDateKey, weekdayName, weekdayOfDateKey } from '../domain/datetime'
import type { ScreenshotAttempt } from '../domain/screenshotLibraryRepository'
import { useAppStore } from '../store/AppStore'
import { AppButton, Badge, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast, courseDeleteDetails } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>
type Route = RouteProp<CourseStackParamList, 'CourseDetail'>

/** 教学周时间线一格：某一周这门课的上课日安排。 */
interface WeekCell {
  week: number
  dates: string[]
  /** 这一周是否有课（结合单双周与学期边界）。 */
  active: boolean
}

export function CourseDetailScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const courseId = route.params.id

  const [pendingSchedule, setPendingSchedule] = useState<Schedule | null>(null)
  const [confirmingCourse, setConfirmingCourse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 这门课关联的原始截图（导入时写下的持久关联）。 */
  const [linkedScreenshots, setLinkedScreenshots] = useState<ScreenshotAttempt[]>([])
  const screenshotLibrary = store.screenshotLibrary

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const course = store.courseById(courseId)
  const schedules = useMemo(
    () => store.data.schedules.filter((schedule) => schedule.courseId === courseId),
    [courseId, store.data.schedules],
  )
  const linkedTasks = useMemo(
    () => store.data.tasks.filter((task) => task.courseId === courseId),
    [courseId, store.data.tasks],
  )

  /**
   * 这门课是从哪张截图导入的（持久关联，关掉 App 也还在）。
   *
   * 读失败只是少一个入口，不影响这一页的其它内容，因此不弹错误、只留空列表。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await screenshotLibrary.listAttemptsLinkedTo('COURSE', courseId)
        if (!cancelled) setLinkedScreenshots(list)
      } catch {
        if (!cancelled) setLinkedScreenshots([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [courseId, screenshotLibrary])

  /** 用第一条有教学周设置的课表作为时间线基准（同一门课通常一致）。 */
  const termBase = useMemo(
    () =>
      schedules.find(
        (schedule) =>
          schedule.semesterStartDate !== null && schedule.startWeek !== null && schedule.endWeek !== null,
      ) ?? null,
    [schedules],
  )

  const weekTimeline = useMemo<WeekCell[]>(() => {
    if (!termBase || !termBase.semesterStartDate || termBase.startWeek === null || termBase.endWeek === null) {
      return []
    }
    const cells: WeekCell[] = []
    for (let week = termBase.startWeek; week <= termBase.endWeek; week += 1) {
      const dates: string[] = []
      for (const schedule of schedules) {
        const weekOffset = (week - 1) * 7 + (schedule.weekday - 1)
        const dateKey = addDaysToDateKey(termBase.semesterStartDate, weekOffset)
        if (dateKey) dates.push(dateKey)
      }
      const active = schedules.some((schedule) => dates.length > 0)
      cells.push({ week, dates, active })
    }
    return cells
  }, [schedules, termBase])

  const confirmScheduleDelete = useCallback(async () => {
    if (!pendingSchedule) return
    const target = pendingSchedule
    setBusy(true)
    try {
      await store.deleteSchedule(target.id)
      setToast({ text: '课表已删除。', tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除课表失败。', tone: 'error' })
    } finally {
      setBusy(false)
      setPendingSchedule(null)
    }
  }, [pendingSchedule, store])

  const confirmCourseDelete = useCallback(async () => {
    if (!course) return
    setBusy(true)
    try {
      const result = await store.deleteCourse(course.id, { confirmed: true })
      setConfirmingCourse(false)
      setToast({
        text: `已删除课程：${result.detachedTasks} 个任务保留（已解除关联），${result.removedSchedules} 条课表被删除。`,
        tone: 'success',
      })
      navigation.goBack()
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除课程失败。', tone: 'error' })
      setBusy(false)
    }
  }, [course, navigation, store])

  if (!course) {
    return (
      <ScreenScaffold title="课程不存在" subtitle="它可能已经被删除">
        <Text style={styles.muted}>这门课程不在这台手机上了，可能已经被删除。</Text>
        <AppButton label="返回课程列表" onPress={() => navigation.goBack()} variant="secondary" />
      </ScreenScaffold>
    )
  }

  const termLast = termBase && termBase.semesterStartDate && termBase.endWeek !== null
    ? termLastDate(termBase.semesterStartDate, termBase.endWeek)
    : null

  return (
    <>
      <ScreenScaffold
        title={course.name}
        subtitle={[course.instructor, course.semester].filter((part): part is string => Boolean(part)).join(' · ')}
        headerAccessory={
          <AppButton
            label="编辑"
            onPress={() => navigation.navigate('CourseForm', { id: course.id })}
            variant="secondary"
            compact
            accessibilityLabel="编辑这门课程"
          />
        }
      >
        <View style={styles.badgeRow}>
          <View style={[styles.colorDot, { backgroundColor: courseColorOf(course) }]} />
          <Badge text={`${schedules.length} 条课表`} tone="muted" />
          <Badge text={`${linkedTasks.length} 个任务`} tone="muted" />
          {termBase ? <Badge text={`第 ${termBase.startWeek}-${termBase.endWeek} 周`} tone="primary" /> : null}
        </View>

        {/*
          只展示**用户看得懂**的标识：选课序号（学校选课系统里那串数字）。
          内部课程代码由 App 自己维护，不在这里出现（老数据里的代码原样保留用于匹配）。
        */}
        <SectionCard title="选课序号" subtitle="学校选课系统里的序号，用来区分同名但其实是两门不同的课">
          {course.selectionSerial ? (
            <Text style={styles.body}>选课序号：{course.selectionSerial}</Text>
          ) : (
            <Text style={styles.muted}>
              还没有记录选课序号。截图导入时会自动读出来；也可以点右上角「编辑」手动填。
            </Text>
          )}
        </SectionCard>

        <SectionCard
          title="来源截图"
          subtitle={
            linkedScreenshots.length === 0
              ? '没有关联的截图（手工创建的课程通常没有）'
              : `${linkedScreenshots.length} 张 · 点进去可以看原图`
          }
        >
          {linkedScreenshots.length === 0 ? (
            <Text style={styles.muted}>
              这门课不是从截图导入的，或者导入时那张图没能保存。截图库里可以看到全部历史截图。
            </Text>
          ) : (
            linkedScreenshots.map((attempt) => (
              <View key={attempt.id} style={styles.sourceRow}>
                <Text style={styles.body}>
                  #{attempt.id} · {attempt.capturedAt.slice(0, 16).replace('T', ' ')}
                  {attempt.width && attempt.height ? ` · ${attempt.width}×${attempt.height}` : ''}
                </Text>
                <AppButton
                  label="看原图"
                  onPress={() => navigation.navigate('PhotoLibrary', { focusAttemptId: attempt.id })}
                  variant="secondary"
                  compact
                  accessibilityLabel={`查看课程来源截图 #${attempt.id}`}
                />
              </View>
            ))
          )}
          <AppButton
            label="打开截图库"
            onPress={() => navigation.navigate('PhotoLibrary')}
            variant="ghost"
            compact
            style={styles.addSchedule}
            accessibilityLabel="打开截图库"
          />
        </SectionCard>

        {course.note ? (
          <SectionCard title="备注">
            <Text style={styles.body}>{course.note}</Text>
          </SectionCard>
        ) : null}

        <SectionCard
          title="课表"
          subtitle={schedules.length === 0 ? '还没有课表' : `${schedules.length} 条 · 点击可编辑`}
        >
          {schedules.length === 0 ? (
            <Text style={styles.muted}>
              这门课还没有上课时间。添加后它才会出现在日历、日期详情和今日课程里。
            </Text>
          ) : (
            schedules.map((schedule) => (
              <View key={schedule.id} style={styles.scheduleRow}>
                <View style={styles.scheduleMain}>
                  <Text style={styles.scheduleTime}>
                    {weekdayName(schedule.weekday)} {schedule.startTime}–{schedule.endTime}
                  </Text>
                  <Text style={styles.muted}>
                    {schedule.location ? `${schedule.location} · ` : ''}
                    {describeTerm(schedule)}
                  </Text>
                  {schedule.periodStart !== null && schedule.periodEnd !== null ? (
                    <Text style={styles.muted}>
                      第 {schedule.periodStart}–{schedule.periodEnd} 节
                    </Text>
                  ) : null}
                </View>
                <View style={styles.scheduleActions}>
                  <AppButton
                    label="编辑"
                    onPress={() => navigation.navigate('ScheduleForm', { courseId: course.id, scheduleId: schedule.id })}
                    variant="secondary"
                    compact
                    disabled={busy}
                    accessibilityLabel={`编辑 ${weekdayName(schedule.weekday)} ${schedule.startTime} 的课表`}
                  />
                  <AppButton
                    label="删除"
                    onPress={() => setPendingSchedule(schedule)}
                    variant="ghost"
                    compact
                    disabled={busy}
                    accessibilityLabel={`删除 ${weekdayName(schedule.weekday)} ${schedule.startTime} 的课表`}
                    accessibilityHint="删除前会再次确认"
                  />
                </View>
              </View>
            ))
          )}
          <AppButton
            label="添加课表"
            onPress={() => navigation.navigate('ScheduleForm', { courseId: course.id })}
            style={styles.addSchedule}
            disabled={busy}
            accessibilityLabel="给这门课添加课表"
          />
        </SectionCard>

        <SectionCard
          title="教学周时间线"
          subtitle={
            weekTimeline.length === 0
              ? '未设置学期第一周周一与起止教学周，这门课按「每周」处理'
              : `第 ${termBase?.startWeek}–${termBase?.endWeek} 周 · 学期首周一 ${termBase?.semesterStartDate}${termLast ? ` · 最后一天 ${termLast}` : ''}`
          }
        >
          {weekTimeline.length === 0 ? (
            <Text style={styles.muted}>
              在课表里填写「学期第一周周一」与起止教学周后，这里会显示每一周的实际上课日期，
              并按单双周规则标出哪些周有课。
            </Text>
          ) : (
            weekTimeline.map((cell) => {
              const pattern = schedules[0]?.weekPattern ?? 'ALL'
              const parityOk =
                pattern === 'ALL' ? true : pattern === 'ODD' ? cell.week % 2 === 1 : cell.week % 2 === 0
              return (
                <View key={cell.week} style={styles.weekRow}>
                  <Text style={[styles.weekLabel, parityOk ? styles.weekActive : styles.weekInactive]}>
                    第 {cell.week} 周
                  </Text>
                  <View style={styles.weekDates}>
                    {!parityOk ? (
                      <Text style={styles.muted}>按{pattern === 'ODD' ? '单' : '双'}周规则本周不上课</Text>
                    ) : (
                      cell.dates.map((dateKey) => {
                        const weekday = weekdayOfDateKey(dateKey)
                        return (
                          <Text key={dateKey} style={styles.weekDate}>
                            {dateKey} {weekday ? weekdayName(weekday) : ''}
                          </Text>
                        )
                      })
                    )}
                  </View>
                </View>
              )
            })
          )}
        </SectionCard>

        <SectionCard title="关联任务" subtitle={`${linkedTasks.length} 个任务关联这门课`}>
          {linkedTasks.length === 0 ? (
            <Text style={styles.muted}>还没有任务关联这门课。删除课程不会影响任何任务。</Text>
          ) : (
            linkedTasks.map((task) => (
              <Text key={task.id} style={styles.body}>
                • {task.title}
                {task.deadline ? `（截止 ${task.deadline.slice(0, 16).replace('T', ' ')}）` : '（未设置 DDL）'}
              </Text>
            ))
          )}
          <Text style={styles.note}>
            删除这门课时，上面这些任务**不会**被删除，只会变成「未关联课程」。
          </Text>
        </SectionCard>

        <AppButton
          label="编辑课程"
          onPress={() => navigation.navigate('CourseForm', { id: course.id })}
          variant="secondary"
          disabled={busy}
        />
        <AppButton
          label="删除课程"
          onPress={() => setConfirmingCourse(true)}
          variant="danger"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="删除这门课程"
          accessibilityHint="会先说明受影响的课表与任务数量"
        />
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingSchedule !== null}
        title="删除这条课表？"
        details={
          pendingSchedule
            ? [
                `${weekdayName(pendingSchedule.weekday)} ${pendingSchedule.startTime}–${pendingSchedule.endTime} 会被删除。`,
                '这门课程本身和其它课表不受影响。',
                '删除后无法撤销。',
              ]
            : []
        }
        confirmLabel="删除课表"
        danger
        busy={busy}
        onConfirm={() => void confirmScheduleDelete()}
        onCancel={() => setPendingSchedule(null)}
      />

      <ConfirmDialog
        visible={confirmingCourse}
        title="删除课程会怎样？"
        details={courseDeleteDetails(course.name, linkedTasks.length, schedules.length)}
        confirmLabel="确认删除课程"
        danger
        busy={busy}
        onConfirm={() => void confirmCourseDelete()}
        onCancel={() => setConfirmingCourse(false)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg, flexWrap: 'wrap' },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  body: { ...typography.body, marginBottom: spacing.xs },
  muted: { ...typography.caption, marginTop: spacing.xs },
  note: { ...typography.caption, marginTop: spacing.md, color: colors.textSoft },
  scheduleRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.sm,
  },
  scheduleMain: { gap: 2 },
  scheduleTime: { ...typography.section, fontSize: 16 },
  scheduleActions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  addSchedule: { marginTop: spacing.md },
  weekRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  weekLabel: { ...typography.label, minWidth: 68 },
  weekActive: { color: colors.primaryDark },
  weekInactive: { color: colors.textMuted },
  weekDates: { flex: 1, gap: 2 },
  weekDate: { ...typography.bodySoft },
  gap: { marginTop: spacing.md },
  card: { borderRadius: radius.md },
})
