/**
 * 课程与课表列表：课程卡片 + 本周课表视图（真实数据，非占位）。
 *
 * 删除课程是**受保护的**操作：先查引用计数，再让用户看到
 * 「几个任务会保留、几条课表会删除」的具体数字后才执行。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { occursOn } from '../domain/scheduleRules'
import { shanghaiToday, weekdayName, weekdayOptions, weekdayOfDateKey } from '../domain/datetime'
import { describeCalibration } from '../domain/teachingWeek'
import { CourseInUseError } from '../domain/errors'
import { courseColorOf, type Course } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, Badge, EmptyState, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast, courseDeleteDetails } from '../ui/dialog'
import { QuickActions, ToolDisclosure } from '../ui/QuickActions'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>

interface DeletePlan {
  course: Course
  taskCount: number
  scheduleCount: number
}

export function CourseListScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [deletePlan, setDeletePlan] = useState<DeletePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const taskCountByCourse = useMemo(() => {
    const map = new Map<number, number>()
    for (const task of store.data.tasks) {
      if (task.courseId === null) continue
      map.set(task.courseId, (map.get(task.courseId) ?? 0) + 1)
    }
    return map
  }, [store.data.tasks])

  /** 当前教学周状态（与课表表单里显示的是同一份说明）。 */
  const summary = useMemo(() => describeCalibration(store.calibration, store.today), [store.calibration, store.today])

  const scheduleCountByCourse = useMemo(() => {
    const map = new Map<number, number>()
    for (const schedule of store.data.schedules) {
      map.set(schedule.courseId, (map.get(schedule.courseId) ?? 0) + 1)
    }
    return map
  }, [store.data.schedules])

  /** 本周课表：按「今天所在自然周」逐日展开，尊重教学周与单双周。 */
  const thisWeek = useMemo(() => {
    const today = shanghaiToday()
    const weekday = weekdayOfDateKey(today) ?? 1
    const monday = new Date(`${today}T00:00:00Z`)
    monday.setUTCDate(monday.getUTCDate() - (weekday - 1))
    const days: { dateKey: string; weekday: number; label: string; items: string[] }[] = []
    for (let offset = 0; offset < 7; offset += 1) {
      const cursor = new Date(monday.getTime())
      cursor.setUTCDate(cursor.getUTCDate() + offset)
      const dateKey = cursor.toISOString().slice(0, 10)
      const items = store.data.schedules
        .filter((schedule) => occursOn(schedule, dateKey))
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
        .map((schedule) => {
          const course = store.courseById(schedule.courseId)
          const suffix = schedule.location ? ` @ ${schedule.location}` : ''
          return `${schedule.startTime}–${schedule.endTime} ${course?.name ?? '未知课程'}${suffix}`
        })
      days.push({
        dateKey,
        weekday: offset + 1,
        label: `${weekdayName(offset + 1)} ${dateKey.slice(5)}`,
        items,
      })
    }
    return days
  }, [store])

  const requestDelete = useCallback(
    async (course: Course) => {
      const { taskCount, scheduleCount } = await store.countCourseReferences(course.id)
      setDeletePlan({ course, taskCount, scheduleCount })
    },
    [store],
  )

  const confirmDelete = useCallback(async () => {
    if (!deletePlan) return
    setBusy(true)
    try {
      const result = await store.deleteCourse(deletePlan.course.id, { confirmed: true })
      setToast({
        text: `已删除课程「${deletePlan.course.name}」：${result.detachedTasks} 个任务保留了（已解除关联），${result.removedSchedules} 条课表被删除。`,
        tone: 'success',
      })
      setDeletePlan(null)
    } catch (cause) {
      const message =
        cause instanceof CourseInUseError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : '删除课程失败。'
      setToast({ text: message, tone: 'error' })
      setDeletePlan(null)
    } finally {
      setBusy(false)
    }
  }, [deletePlan, store])

  return (
    <>
      <ScreenScaffold
        title="课程与课表"
        subtitle={`${store.data.courses.length} 门课程 · ${store.data.schedules.length} 条课表`}
        headerAccessory={
          <AppButton label="新建课程" onPress={() => navigation.navigate('CourseForm', {})} compact accessibilityLabel="新建课程" />
        }
      >
        <QuickActions title="课表与照片" actions={[
          { label: '拍照导入课表', onPress: () => navigation.navigate('PhotoImport') },
          { label: '截图库', onPress: () => navigation.navigate('PhotoLibrary') },
        ]} />
        {store.data.courses.length === 0 ? (
          <EmptyState
            title="还没有课程"
            description="添加课程后设置上课时间，或直接拍照导入课表。"
            actionLabel="新建课程"
            onAction={() => navigation.navigate('CourseForm', {})}
          />
        ) : (
          store.data.courses.map((course) => (
            <View key={course.id} style={styles.courseCard}>
              <Pressable
                onPress={() => navigation.navigate('CourseDetail', { id: course.id })}
                accessibilityRole="button"
                accessibilityLabel={`课程 ${course.name}，${taskCountByCourse.get(course.id) ?? 0} 个任务，${scheduleCountByCourse.get(course.id) ?? 0} 条课表`}
                accessibilityHint="打开课程详情"
                style={({ pressed }) => [styles.courseMain, pressed && styles.pressed]}
              >
                <View style={styles.courseTitleRow}>
                  <View style={[styles.colorDot, { backgroundColor: courseColorOf(course) }]} />
                  <Text style={styles.courseName}>{course.name}</Text>
                </View>
                {/* 内部课程代码不展示；只显示用户看得懂的信息（教师 / 学期 / 选课序号）。 */}
                <Text style={styles.muted}>
                  {[course.instructor, course.semester, course.selectionSerial ? `选课序号 ${course.selectionSerial}` : null]
                    .filter((part): part is string => Boolean(part))
                    .join(' · ')}
                </Text>
                <View style={styles.badgeRow}>
                  <Badge text={`${taskCountByCourse.get(course.id) ?? 0} 个任务`} tone="muted" />
                  <Badge text={`${scheduleCountByCourse.get(course.id) ?? 0} 条课表`} tone="muted" />
                </View>
              </Pressable>
              <View style={styles.courseActions}>
                <AppButton
                  label="删除"
                  onPress={() => void requestDelete(course)}
                  variant="ghost"
                  compact
                  accessibilityLabel={`删除课程 ${course.name}`}
                  accessibilityHint="会先显示受影响的课表与任务数量"
                />
              </View>
            </View>
          ))
        )}

        <ToolDisclosure title="课程工具与设置">
          <QuickActions title="管理课程" actions={[
            { label: '上课前提醒', onPress: () => navigation.navigate('ClassReminder') },
            { label: '课表冲突检查', onPress: () => navigation.navigate('CourseConflicts') },
            { label: '备份与恢复', onPress: () => navigation.navigate('Backup') },
            { label: '识别服务设置', onPress: () => navigation.navigate('CompanionSettings') },
            { label: '恢复历史截图', onPress: () => navigation.navigate('SourceArchive') },
          ]} />
        </ToolDisclosure>
        <SectionCard
          title="教学周"
          subtitle="校准本周，自动匹配单双周课表"
        >
          <Text style={styles.muted}>今天（北京时间）：{store.today}</Text>
          <Text style={styles.muted}>
            {summary.currentWeek === null
              ? '当前教学周：未知（还没有校准）'
              : `当前教学周：第 ${summary.currentWeek} 教学周`}
          </Text>
          {summary.warning ? <Text style={styles.warn}>{summary.warning}</Text> : null}
          <AppButton
            label={store.calibration ? '查看 / 重新校准教学周' : '设置教学周'}
            onPress={() => navigation.navigate('TeachingWeek')}
            variant="secondary"
            compact
            style={styles.addSchedule}
            accessibilityLabel="打开教学周设置"
          />
        </SectionCard>

        <SectionCard title="本周课表" subtitle="已按教学周与单双周匹配">
          {store.data.schedules.length === 0 ? (
            <Text style={styles.muted}>还没有课表。进入课程详情可以添加，或用上面的「拍照导入课表」。</Text>
          ) : (
            thisWeek.map((day) => (
              <View key={day.dateKey} style={styles.weekRow}>
                <Text style={styles.weekDay}>{day.label}</Text>
                <View style={styles.weekBody}>
                  {day.items.length === 0 ? (
                    <Text style={styles.muted}>—</Text>
                  ) : (
                    day.items.map((item) => (
                      <Text key={item} style={styles.weekItem}>
                        {item}
                      </Text>
                    ))
                  )}
                </View>
              </View>
            ))
          )}
          <Text style={styles.weekNote}>
            星期编号固定为 1=周一 … 7=周日：{weekdayOptions.map((option) => `${option.value}=${option.label}`).join('、')}
          </Text>
        </SectionCard>
      </ScreenScaffold>

      <ConfirmDialog
        visible={deletePlan !== null}
        title="删除课程会怎样？"
        details={
          deletePlan ? courseDeleteDetails(deletePlan.course.name, deletePlan.taskCount, deletePlan.scheduleCount) : []
        }
        confirmLabel="确认删除课程"
        danger
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeletePlan(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  courseCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  courseMain: { padding: spacing.lg, minHeight: MIN_TOUCH_SIZE },
  pressed: { backgroundColor: colors.primaryTint },
  courseTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  colorDot: { width: 6, height: 30, borderRadius: 3 },
  courseName: { ...typography.section, flexShrink: 1 },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  courseActions: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  addSchedule: { marginTop: spacing.md },
  muted: { ...typography.caption, marginTop: spacing.xs },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.xs },
  weekRow: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  weekDay: { ...typography.label, minWidth: 92 },
  weekBody: { flex: 1, gap: 2 },
  weekItem: { ...typography.bodySoft },
  weekNote: { ...typography.caption, marginTop: spacing.md },
})
