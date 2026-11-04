import React, { useEffect, useRef, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native'
import type { RootTabParamList } from '../navigation/types'
import { isNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import { useAppStore } from '../store/AppStore'
import { parseClassReminderTap } from '../domain/classReminder'
import { AppButton } from './components'
import { colors, spacing, radius, typography } from './theme'

// Explicit open keeps notification taps from replacing a form with unsaved work.
export function ClassReminderNotificationBanner({ navigationRef, ready }: { navigationRef: NavigationContainerRefWithCurrent<RootTabParamList>; ready: boolean }): React.ReactElement | null {
  const store = useAppStore(), insets = useSafeAreaInsets()
  const [tap, setTap] = useState<{ id: string; data: unknown } | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const seen = useRef(new Set<string>())
  useEffect(() => {
    let active = true, subscription: { remove: () => void } | undefined
    void import('expo-notifications').then(api => {
      if (!active) return
      const receive = (response: ReturnType<typeof api.getLastNotificationResponse>) => {
        if (!active || !response || response.actionIdentifier !== api.DEFAULT_ACTION_IDENTIFIER) return
        const r = response.notification.request, data = r.content.data
        if (data?.kind !== 'ddlmate.class-reminder.v1') return
        const token = `${r.identifier}:${response.notification.date}`
        if (seen.current.has(token)) return
        if (seen.current.size > 64) seen.current.clear()
        seen.current.add(token); setTap({ id: r.identifier, data }); setWarning(null)
      }
      subscription = api.addNotificationResponseReceivedListener(receive)
      receive(api.getLastNotificationResponse())
    }).catch(() => undefined)
    return () => { active = false; subscription?.remove() }
  }, [])
  if (!tap || !ready || store.status !== 'ready' || store.backup.gate !== 'idle') return null
  const payload = parseClassReminderTap(tap.id, tap.data, store.getNotificationRouteGeneration())
  if (!payload) return null
  const course = store.courseById(payload.courseId)
  const close = () => {
    setTap(null)
    void import('expo-notifications').then(async api => {
      const last = api.getLastNotificationResponse()
      if (last?.notification.request.identifier === tap.id && last.notification.request.content.data?.fingerprint === payload.fingerprint) await api.clearLastNotificationResponseAsync()
    }).catch(() => undefined)
  }
  const open = () => {
    const blocks = (state: unknown): boolean => {
      const routes = (state as { routes?: Array<{ name: string; key: string; state?: unknown }> })?.routes ?? []
      return routes.some(r => /Form$|PhotoReview|NoticeImport|BatchNotice|ClassReminder/.test(r.name) || isNavigationDraftDirty(r.key) || blocks(r.state))
    }
    if (blocks(navigationRef.getRootState())) { setWarning('请先保存或退出正在编辑的页面，再打开课程。'); return }
    if (!store.courseById(payload.courseId)) { setWarning('这门课程已不在当前课表中。'); return }
    navigationRef.navigate('Courses', { screen: 'CourseDetail', params: { id: payload.courseId }, initial: false })
    close()
  }
  return <View style={[styles.overlay, { bottom: insets.bottom + 64 }]} accessibilityRole="alert">
    <Text style={styles.title}>{payload.test ? '课前提醒测试成功' : course?.name ?? '这门课程已删除'}</Text>
    <Text style={styles.body}>{payload.test ? '手机已收到测试通知。' : `${payload.dateKey} ${payload.startTime} 上课，当前时间和地点请以课表为准。`}</Text>
    {warning ? <Text style={styles.body}>{warning}</Text> : null}
    <View style={styles.actions}>{!payload.test && course ? <AppButton label="查看课程" compact onPress={open} /> : null}<AppButton label="关闭" compact variant="ghost" onPress={close} /></View>
  </View>
}
const styles = StyleSheet.create({ overlay: { position: 'absolute', left: spacing.md, right: spacing.md, padding: spacing.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg }, title: { ...typography.body, fontWeight: '700' }, body: { ...typography.bodySoft, marginVertical: spacing.xs }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm } })
