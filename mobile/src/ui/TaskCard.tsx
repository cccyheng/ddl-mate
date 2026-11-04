/**
 * 任务卡片：列表、今日页、日期详情页共用。
 *
 * - 整卡可点进详情（`accessibilityRole="button"`）；
 * - 完成与删除是**独立的大按钮**（≥44pt），不会因为卡片可点而误触；
 * - 删除按钮只负责冒泡 `onRequestDelete`，二次确认由页面统一做。
 */

import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import {
  deadlineToShanghaiClock,
  deadlineToShanghaiDateKey,
  remainingLabel,
  weekdayName,
  weekdayOfDateKey,
} from '../domain/datetime'
import { isOverdue, taskPriorityLabels, taskTypeLabels, type Course, type Task } from '../domain/types'
import { AppButton, Badge } from './components'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from './theme'

export interface TaskCardProps {
  task: Task
  course?: Course | null
  onPress: (task: Task) => void
  onToggleComplete: (task: Task) => void
  onRequestDelete: (task: Task) => void
  /** 删除/完成的进行中状态，禁用按钮避免重复提交。 */
  busy?: boolean
}

export function TaskCard({
  task,
  course,
  onPress,
  onToggleComplete,
  onRequestDelete,
  busy = false,
}: TaskCardProps): React.ReactElement {
  const done = task.status === 'DONE'
  const overdue = isOverdue(task)
  const remaining = remainingLabel(task.deadline)
  const deadlineDate = task.deadline ? deadlineToShanghaiDateKey(task.deadline) : ''
  const deadlineClock = task.deadline ? deadlineToShanghaiClock(task.deadline) : ''
  const weekday = deadlineDate ? weekdayOfDateKey(deadlineDate) : null
  const deadlineText = task.deadline
    ? deadlineClock
      ? `截止 ${deadlineDate} ${weekday ? weekdayName(weekday) : ''} ${deadlineClock}（北京时间）`
      : `截止 ${deadlineDate} ${weekday ? weekdayName(weekday) : ''}（只记到日期，北京时间）`
    : '无截止日期'

  const accessibilityParts = [
    task.title,
    taskTypeLabels[task.type],
    `优先级${taskPriorityLabels[task.priority] ?? task.priority}`,
    done ? '已完成' : overdue ? '已逾期' : '未完成',
    task.deadline
      ? deadlineClock
        ? `截止 ${deadlineDate} ${weekday ? weekdayName(weekday) : ''} ${deadlineClock} 北京时间`
        : `截止 ${deadlineDate} ${weekday ? weekdayName(weekday) : ''}，只记到日期，北京时间`
      : '未设置截止时间',
    course ? `课程 ${course.name}` : '未关联课程',
  ]

  return (
    <View style={[styles.card, done && styles.cardDone, overdue && !done && styles.cardOverdue]}>
      <Pressable
        onPress={() => onPress(task)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityParts.join('，')}
        accessibilityHint="打开任务详情"
        style={({ pressed }) => [styles.main, pressed && styles.mainPressed]}
      >
        <View style={styles.titleRow}>
          <Text style={[styles.title, done && styles.titleDone]}>
            {task.title}
          </Text>
          {done ? <Badge text="已完成" tone="success" /> : null}
          {!done && overdue ? <Badge text={remaining.text} tone="clay" /> : null}
          {!done && !overdue && task.deadline ? <Badge text={remaining.text} tone="muted" /> : null}
        </View>

        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{taskTypeLabels[task.type]}</Text>
          <Text style={styles.metaDot}>·</Text>
          <Text style={styles.metaText}>优先级 {taskPriorityLabels[task.priority] ?? task.priority}</Text>
          {course ? (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Text style={[styles.metaText, course.color ? { color: course.color } : null]} numberOfLines={1}>
                {course.name}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.metaTextMuted}>未关联课程</Text>
            </>
          )}
        </View>

        <Text style={styles.deadlineText}>{deadlineText}</Text>
      </Pressable>

      <View style={styles.actions}>
        <AppButton
          label={done ? '标为未完成' : '标记完成'}
          onPress={() => onToggleComplete(task)}
          variant={done ? 'secondary' : 'primary'}
          compact
          disabled={busy}
          accessibilityLabel={`${done ? '把' : '把'}${task.title}标为${done ? '未完成' : '已完成'}`}
          style={styles.action}
        />
        <AppButton
          label="删除"
          onPress={() => onRequestDelete(task)}
          variant="ghost"
          compact
          disabled={busy}
          accessibilityLabel={`删除任务 ${task.title}`}
          accessibilityHint="删除前会再次确认"
          style={styles.action}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  cardDone: { backgroundColor: colors.surfaceSoft, borderColor: colors.border },
  cardOverdue: { borderLeftColor: colors.clay, borderLeftWidth: 4 },
  main: { padding: spacing.lg, minHeight: MIN_TOUCH_SIZE },
  mainPressed: { backgroundColor: colors.primaryTint },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  title: { ...typography.section, flexShrink: 1 },
  titleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.sm, flexWrap: 'wrap' },
  metaText: { ...typography.caption },
  metaTextMuted: { ...typography.caption, fontStyle: 'italic' },
  metaDot: { color: colors.textMuted },
  deadlineText: { ...typography.caption, marginTop: spacing.md },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  action: { minWidth: 96, flexShrink: 1 },
})
