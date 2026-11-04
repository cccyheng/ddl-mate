/**
 * 「提醒同步需要重试」提示条。
 *
 * 任务删除 / 完成 / 改期后，系统通知的取消或替换是在任务写库之后异步做的：
 * 任务保存成功不代表系统通知也同步成功。服务把失败记在快照里，这里订阅并显示，
 * 让「取消失败」不会只躺在内存里被吞掉。
 *
 * 它**不**把任务保存说成失败，也不自动重试；用户点按钮才再对账一次。
 */

import React, { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useAppStore } from '../store/AppStore'
import { AppButton } from './components'
import { colors, radius, spacing, typography } from './theme'

export function ReminderSyncNotice(): React.ReactElement | null {
  const store = useAppStore()
  const [error, setError] = useState<string | null>(() => store.taskReminder.getSnapshot().lastError)
  const reminder = store.taskReminder

  useEffect(() => {
    const read = () => {
      setError(reminder.getSnapshot().lastError)
    }
    read()
    return reminder.subscribe(read)
  }, [reminder])

  if (!error) return null

  return (
    <View style={styles.box} accessibilityRole="alert">
      <Text style={styles.title}>提醒同步需要重试</Text>
      <Text style={styles.text}>{error}</Text>
      <Text style={styles.text}>
        任务本身已经保存；这里只说明手机里的通知还没有确认同步。可以重试一次，不会修改任务。
      </Text>
      <AppButton
        label="重试提醒同步"
        onPress={() => void reminder.reconcile('manual-retry')}
        variant="secondary"
        compact
        style={styles.action}
        accessibilityLabel="重新同步任务提醒到手机系统"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.warnSoft,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.xs,
  },
  title: { ...typography.section, color: colors.warn },
  text: { ...typography.caption },
  action: { marginTop: spacing.sm, alignSelf: 'flex-start' },
})
