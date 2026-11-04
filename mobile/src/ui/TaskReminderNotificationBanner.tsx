/**
 * 通知点击的**非破坏性**提示条。
 *
 * 出现在根导航上方，不占用路由、不弹原生 Alert、不派发返回动作。两种情况最重要：
 * - 用户正在编辑：只提示「离开当前编辑后自动打开」，不提供会丢弃草稿的直达按钮；
 * - 任务读取失败 / 已删除：明确显示原因，分别提供「重试」与「返回任务列表」。
 */

import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import type { TaskReminderNotificationState } from '../navigation/taskReminderNotificationRouter'
import {
  notificationDiagnosticSummary,
  useNotificationNavigationDiagnostics,
} from '../navigation/notificationNavigationDiagnostics'
import { AppButton } from './components'
import { colors, radius, spacing, typography } from './theme'

export function TaskReminderNotificationBanner({
  state,
  onRetry,
  onDismiss,
  onOpenTaskList,
}: {
  state: TaskReminderNotificationState
  onRetry: () => void
  onDismiss: () => void
  onOpenTaskList: () => void
}): React.ReactElement | null {
  const insets = useSafeAreaInsets()
  const diagnostics = useNotificationNavigationDiagnostics()
  const notice = state.notice
  if (!notice) return null

  const title = noticeTitle(notice.kind)
  const body = noticeBody(notice)
  const canOpenTaskList = notice.kind === 'missing' && !state.editing && state.navigationReady
  const showDiagnostic = notice.kind === 'pending' || notice.kind === 'error'

  return (
    <View style={[styles.overlay, { bottom: insets.bottom + 64 }]} pointerEvents="box-none">
      <View style={styles.card} accessibilityRole="alert" accessibilityLabel={`${title}。${body}`}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.body}>{body}</Text>
        {showDiagnostic ? (
          <Text style={styles.diagnostic}>本机诊断：{notificationDiagnosticSummary(diagnostics)}</Text>
        ) : null}
        <View style={styles.actions}>
          {notice.kind === 'error' && notice.canRetry ? (
            <AppButton label="重试" onPress={onRetry} variant="secondary" compact />
          ) : null}
          {notice.kind === 'missing' ? (
            <AppButton
              label="返回任务列表"
              onPress={onOpenTaskList}
              variant="secondary"
              compact
              disabled={!canOpenTaskList}
              accessibilityHint={
                canOpenTaskList ? '回到任务列表；不会改动其它页面未保存的草稿' : '先离开当前编辑，才能返回任务列表'
              }
            />
          ) : null}
          <AppButton
            label={notice.kind === 'pending' && notice.blockedByEditing ? '先不打开' : '关闭'}
            onPress={onDismiss}
            variant="ghost"
            compact
          />
        </View>
        {notice.kind === 'missing' && !canOpenTaskList ? (
          <Text style={styles.hint}>先完成 / 离开当前编辑，才会安全返回任务列表。</Text>
        ) : null}
      </View>
    </View>
  )
}

function noticeTitle(kind: 'pending' | 'missing' | 'error' | 'warning'): string {
  switch (kind) {
    case 'pending':
      return '任务提醒'
    case 'missing':
      return '提醒对应的任务已不在本机'
    case 'error':
      return '通知打开失败'
    case 'warning':
      return '任务已打开，但记录没保存'
    default:
      return '任务提醒'
  }
}

function noticeBody(notice: NonNullable<TaskReminderNotificationState['notice']>): string {
  switch (notice.kind) {
    case 'pending': {
      const name = notice.title ? `「${notice.title}」` : '这条任务'
      if (notice.blockedByEditing) {
        return `${name}的提醒已收到。先完成当前编辑，离开这一页后会自动打开任务详情；现在不会改动或丢弃任何草稿。`
      }
      if (notice.waitingForReady) {
        return `${name}的提醒已收到，正在准备打开任务详情…`
      }
      return `${name}的提醒已收到，正在打开任务详情…`
    }
    case 'missing':
      return notice.detail ?? '这条任务可能已经被删除。'
    case 'error':
      return notice.message
    case 'warning':
      return notice.message
    default:
      return ''
  }
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 20,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    padding: spacing.lg,
    gap: spacing.sm,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  title: { ...typography.section, color: colors.text },
  body: { ...typography.bodySoft, color: colors.text },
  diagnostic: { ...typography.caption, color: colors.textMuted },
  hint: { ...typography.caption, color: colors.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
})
