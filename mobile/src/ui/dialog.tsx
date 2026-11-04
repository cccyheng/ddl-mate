/**
 * 确认对话框：用原生 `Modal` 实现，替代 Web 的 `window.confirm`。
 *
 * 为什么不用 `Alert.alert`：删除课程时需要展示**带引用计数的差异说明**
 * （「2 个任务会保留但解除关联，3 条课表会一起删除」），`Alert` 的标题/正文
 * 排版无法稳定承载这种多行信息，也不方便做无障碍标签与测试断言。
 */

import React from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { AppButton } from './components'
import { MotionReveal, useReducedMotion } from './motion'
import { colors, radius, spacing, typography } from './theme'

export interface ConfirmDialogProps {
  visible: boolean
  title: string
  /** 多行说明，逐条渲染成语义清晰的项目符号。 */
  details?: readonly string[]
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  visible,
  title,
  details = [],
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): React.ReactElement {
  const reducedMotion = useReducedMotion()
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onCancel}
      accessibilityViewIsModal
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityRole="alert">
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <Text style={styles.title}>{title}</Text>
            {message ? <Text style={styles.message}>{message}</Text> : null}
            {details.map((line) => (
              <View key={line} style={styles.detailRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.detailText}>{line}</Text>
              </View>
            ))}
          </ScrollView>
          <View style={styles.actions}>
            <AppButton label={cancelLabel} onPress={onCancel} variant="secondary" disabled={busy} style={styles.action} />
            <AppButton
              label={confirmLabel}
              onPress={onConfirm}
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              style={styles.action}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** 轻量底部提示条（保存成功 / 失败），自动不拦截触摸。 */
export function Toast({ text, tone }: { text: string; tone: 'success' | 'error' }): React.ReactElement {
  return (
    <View
      pointerEvents="none"
      style={[styles.toast, tone === 'error' ? styles.toastError : styles.toastSuccess]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <MotionReveal key={text}><Text style={[styles.toastText, tone === 'error' ? styles.toastTextError : null]}>{tone === 'success' ? '✓  ' : ''}{text}</Text></MotionReveal>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    maxHeight: '80%',
  },
  scroll: { flexGrow: 0 },
  scrollContent: { paddingBottom: spacing.sm },
  title: { ...typography.title, marginBottom: spacing.md },
  message: { ...typography.bodySoft, marginBottom: spacing.md },
  detailRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  bullet: { ...typography.body, color: colors.textMuted },
  detailText: { ...typography.bodySoft, flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  action: { flexGrow: 1, flexBasis: 104 },

  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
  },
  toastSuccess: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  toastError: { backgroundColor: colors.claySoft, borderColor: colors.clay },
  toastText: { ...typography.bodySoft, color: colors.primaryDark },
  toastTextError: { color: colors.clayDark },
})

/**
 * 删除确认文案。
 *
 * 面向用户写，不出现表名 / SQL / 字段名这类实现细节：
 * 用户关心的是「哪些东西会消失、能不能撤销」，不是数据存在哪张表。
 */
export function taskDeleteDetails(taskTitle: string, hasOriginalText: boolean): string[] {
  const lines = [`任务「${taskTitle}」会从这台手机上永久删除。`]
  if (hasOriginalText) lines.push('这条任务保存的原始通知文本也会一起删除。')
  lines.push('删除后无法恢复。')
  return lines
}

export function courseDeleteDetails(
  courseName: string,
  taskCount: number,
  scheduleCount: number,
): string[] {
  const lines: string[] = []
  if (taskCount > 0) {
    lines.push(`有 ${taskCount} 个任务关联这门课：任务不会被删除，只会变成「未关联课程」。`)
  }
  if (scheduleCount > 0) {
    lines.push(`这门课的 ${scheduleCount} 条课表会随课程一起删除。`)
  }
  if (taskCount === 0 && scheduleCount === 0) {
    lines.push('这门课没有被任何任务或课表引用。')
  }
  lines.push(`课程「${courseName}」本身会从这台手机上永久删除，删除后无法恢复。`)
  return lines
}
