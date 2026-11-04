import React, { useEffect, useRef, useState } from 'react'
import { Linking, Text, View, StyleSheet } from 'react-native'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { CourseStackParamList } from '../navigation/types'
import { useAppStore } from '../store/AppStore'
import { CLASS_REMINDER_LEADS, defaultClassReminderSettings } from '../domain/classReminder'
import { AppButton, LoadingState, OptionGroup, SectionCard } from '../ui/components'
import { ConfirmDialog } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'

type Nav = NativeStackNavigationProp<CourseStackParamList>
export function ClassReminderScreen(): React.ReactElement {
  const store = useAppStore(), navigation = useNavigation<Nav>(), service = store.getClassReminder()
  const [snapshot, setSnapshot] = useState(() => service?.getSnapshot() ?? null)
  const [draft, setDraft] = useState(defaultClassReminderSettings)
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const baseline = useRef(JSON.stringify(defaultClassReminderSettings()))
  const guard = useRef(false), mounted = useRef(true)
  const [leave, setLeave] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const dirty = loaded && JSON.stringify(draft) !== baseline.current
  usePreventRemove(dirty || busy, ({ data }) => { if (!busy) setLeave(data.action) })
  useEffect(() => {
    mounted.current = true
    if (!service) return () => { mounted.current = false }
    const unsubscribe = service.subscribe(() => { if (mounted.current) setSnapshot(service.getSnapshot()) })
    void service.reconcile().then(result => {
      if (!mounted.current) return
      setSnapshot(result); setDraft(result.settings); baseline.current = JSON.stringify(result.settings); setLoaded(true)
    }).catch(e => { if (mounted.current) { setMessage(String(e)); setLoaded(true) } })
    return () => { mounted.current = false; unsubscribe() }
  }, [service])
  async function run(action: 'save' | 'test' | 'sync') {
    if (!service || guard.current) return
    guard.current = true; setBusy(true); setMessage(null)
    try {
      const result = await (action === 'save' ? service.save(draft) : action === 'test' ? service.test() : service.reconcile())
      if (!mounted.current) return
      setSnapshot(result)
      if (action === 'save') { baseline.current = JSON.stringify(result.settings); setDraft(result.settings) }
      setMessage(result.error ?? (action === 'test' ? '测试已安排。切到手机桌面，约 10 秒后查看通知。' : action === 'save' ? '设置已保存。' : '提醒已同步。'))
    } catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : String(e)) }
    finally { guard.current = false; if (mounted.current) setBusy(false) }
  }
  return <>
    <ScreenScaffold title="上课前提醒" subtitle="根据课表，提前提醒你去上课">
      {!loaded || !snapshot ? <LoadingState message="正在读取提醒设置…" /> : <>
        <SectionCard title="提醒设置" subtitle="保存后应用于所有课程，单双周和指定教学周与课表一致">
          <OptionGroup label="课前提醒" value={draft.enabled ? 'ON' : 'OFF'} options={[{ value: 'OFF', label: '关闭' }, { value: 'ON', label: '开启' }]} disabled={busy} onChange={v => setDraft(d => ({ ...d, enabled: v === 'ON' }))} />
          <OptionGroup label="提前多久" value={draft.leadMinutes} options={CLASS_REMINDER_LEADS.map(value => ({ value, label: `${value} 分钟` }))} disabled={busy} onChange={leadMinutes => setDraft(d => ({ ...d, leadMinutes }))} />
          <AppButton label="保存设置" onPress={() => void run('save')} disabled={busy} loading={busy} />
        </SectionCard>
        {message || snapshot.error ? <Text accessibilityRole="alert" style={styles.notice}>{message ?? snapshot.error}</Text> : null}
        <SectionCard title="手机通知" subtitle={snapshot.permission === 'granted' ? '已获得通知权限' : snapshot.permission === 'provisional' ? '当前为安静通知，声音以系统设置为准' : '未获得通知权限或状态暂不可读'}>
          <View style={styles.actions}>
            <AppButton label="测试提醒（10 秒后）" variant="secondary" onPress={() => void run('test')} disabled={busy || dirty} />
            <AppButton label="重新同步" variant="secondary" onPress={() => void run('sync')} disabled={busy || dirty} />
            <AppButton label="打开系统设置" variant="ghost" onPress={() => void Linking.openSettings().catch(() => setMessage('请在系统设置中允许 Expo Go 发送通知。'))} />
          </View>
          <Text style={styles.note}>测试不会开启正式提醒或修改课表。专注模式与静音设置可能影响声音。</Text>
        </SectionCard>
        <SectionCard title={snapshot.checkedAt === null ? '近期提醒（尚未确认）' : `已安排 ${snapshot.queued.length} 条课前提醒`} subtitle="查看未来 14 天，最多安排最近 24 条；重开应用或回到前台会补充后续提醒">
          <Text style={styles.note}>已安排的通知在关闭应用后仍可触发。长期不打开应用，后续课程不会自动补排；错过提前提醒时间的课程不会补发。修改或删除课表后会重新同步。</Text>
          {snapshot.eligibleCount > snapshot.queued.length && !snapshot.error ? <Text style={styles.note}>另有 {snapshot.eligibleCount - snapshot.queued.length} 条近期课程等待后续补排。</Text> : null}
          {snapshot.checkedAt === null ? <Text style={styles.note}>尚未确认系统排程，请重新同步。</Text> : !snapshot.settings.enabled ? <Text style={styles.note}>课前提醒已关闭。</Text> : snapshot.queued.length === 0 ? <Text style={styles.note}>暂无可安排的课程，请检查未来两周的课表及教学周。</Text> : snapshot.queued.map(row => <View key={row.identifier} style={styles.row}>
            <Text style={styles.title}>{row.title.replace('即将上课 · ', '')}</Text>
            <Text style={styles.note}>{row.body}</Text>
            <AppButton label="查看课程" variant="ghost" compact onPress={() => navigation.navigate('CourseDetail', { id: row.data.courseId })} />
          </View>)}
        </SectionCard>
      </>}
    </ScreenScaffold>
    <ConfirmDialog visible={leave !== null} title="放弃未保存的提醒设置？" message="已保存的设置不会改变。" confirmLabel="放弃改动" cancelLabel="继续编辑" onConfirm={() => { const action = leave; setLeave(null); if (action) navigation.dispatch(action) }} onCancel={() => setLeave(null)} />
  </>
}
const styles = StyleSheet.create({ actions: { gap: spacing.sm }, notice: { ...typography.body, color: colors.primaryDark, marginBottom: spacing.md }, note: { ...typography.bodySoft, marginVertical: spacing.xs }, title: { ...typography.body, fontWeight: '600' }, row: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border } })
