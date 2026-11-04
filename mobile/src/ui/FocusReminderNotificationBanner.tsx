import React, { useEffect, useRef, useState } from 'react'
import { Text, View, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native'
import type { RootTabParamList } from '../navigation/types'
import { isNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import { currentRouteBlocksNotificationOpen } from '../navigation/taskReminderNotificationRouter'
import { useAppStore } from '../store/AppStore'
import { FOCUS_REMINDER_KIND, focusReminderCandidate, parseFocusReminderTap } from '../domain/focusReminder'
import { AppButton } from './components'
import { colors, radius, spacing, typography } from './theme'

/** Explicit navigation, revalidated after asynchronous DB read; never replace an editing screen. */
export function FocusReminderNotificationBanner({ navigationRef, ready }: { navigationRef: NavigationContainerRefWithCurrent<RootTabParamList>; ready: boolean }): React.ReactElement | null {
  const store = useAppStore(), insets = useSafeAreaInsets()
  const current = useRef({ store, ready }); current.current = { store, ready }
  const [tap, setTap] = useState<{ id: string; data: unknown } | null>(null)
  const tapRef = useRef(tap); tapRef.current = tap
  const [warning, setWarning] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false), live = useRef(true), seen = useRef(new Set<string>())
  useEffect(() => {
    live.current = true
    let active = true, subscription: { remove: () => void } | undefined
    void import('expo-notifications').then(api => {
      if (!active) return
      const receive = (response: ReturnType<typeof api.getLastNotificationResponse>) => {
        if (!active || !response || response.actionIdentifier !== api.DEFAULT_ACTION_IDENTIFIER) return
        const r = response.notification.request
        if (r.content.data?.kind !== FOCUS_REMINDER_KIND) return
        const key = `${r.identifier}:${response.notification.date}:${r.content.data.fingerprint}`
        if (seen.current.has(key)) return
        if (seen.current.size >= 64) seen.current.clear()
        seen.current.add(key)
        setTap({ id: r.identifier, data: r.content.data }); setWarning('')
      }
      subscription = api.addNotificationResponseReceivedListener(receive)
      receive(api.getLastNotificationResponse())
    }).catch(() => undefined)
    return () => { active = false; live.current = false; subscription?.remove() }
  }, [])
  if (!tap || !ready || store.status !== 'ready' || store.backup.gate !== 'idle') return null
  const payload = parseFocusReminderTap(tap.id, tap.data, store.getNotificationRouteGeneration())
  if (!payload) return null
  const close = () => {
    setTap(null)
    void import('expo-notifications').then(async api => {
      const last = api.getLastNotificationResponse()
      if (last?.notification.request.identifier === tap.id && last.notification.request.content.data?.fingerprint === payload.fingerprint) await api.clearLastNotificationResponseAsync()
    }).catch(() => undefined)
  }
  const blocked = (state: unknown): boolean => {
    const routes = (state as { routes?: Array<{ name: string; key: string; state?: unknown }> })?.routes ?? []
    return routes.some(r => currentRouteBlocksNotificationOpen(r, isNavigationDraftDirty) || isNavigationDraftDirty(r.key) || blocked(r.state))
  }
  const open = async () => {
    if (locked.current) return
    locked.current = true; setBusy(true); setWarning('')
    try {
      if (blocked(navigationRef.getRootState())) throw new Error('请先保存或退出正在编辑的页面，再打开番茄钟。')
      const snapshot = await current.current.store.focusTime.load()
      if (!live.current || tapRef.current !== tap) return
      const latest = current.current
      if (!latest.ready || latest.store.backup.gate !== 'idle' || !navigationRef.isReady() || snapshot.generation !== payload.generation || latest.store.getNotificationRouteGeneration() !== payload.generation) throw new Error('数据状态已改变，请关闭这条旧提醒。')
      if (blocked(navigationRef.getRootState())) throw new Error('请先保存或退出正在编辑的页面，再打开番茄钟。')
      const candidate = focusReminderCandidate(snapshot, snapshot.generation)
      if (candidate?.data.fingerprint !== payload.fingerprint) throw new Error('这一轮已结束、暂停或重新计时。请从专注计时页面查看最新状态。')
      if (navigationRef.getCurrentRoute()?.name !== 'FocusTime') navigationRef.navigate('Today', { screen: 'FocusTime', initial: false })
      close()
    } catch (e) { if (live.current && tapRef.current === tap) setWarning(e instanceof Error ? e.message : String(e)) }
    finally { locked.current = false; if (live.current) setBusy(false) }
  }
  return <View style={[styles.box, { bottom: insets.bottom + 64 }]} accessibilityRole="alert">
    <Text style={styles.title}>{payload.phase === 'rest' ? '休息到时提醒' : '番茄专注到时提醒'}</Text>
    <Text style={styles.body}>{warning || '打开番茄钟查看当前状态，自主决定下一步。'}</Text>
    <View style={styles.actions}><AppButton label="查看番茄钟" compact disabled={busy} onPress={() => void open()} /><AppButton label="关闭" compact variant="ghost" disabled={busy} onPress={close} /></View>
  </View>
}
const styles = StyleSheet.create({ box: { position: 'absolute', left: spacing.md, right: spacing.md, padding: spacing.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg }, title: { ...typography.section }, body: { ...typography.bodySoft, marginVertical: spacing.sm }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm } })
