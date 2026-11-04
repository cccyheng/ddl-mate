import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRoute } from '@react-navigation/native'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { goalDuration, goalWeek, weeklyGoalProgress } from '../domain/weeklyGoal'
import { clearNavigationDraft, setNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import { AppButton, SectionCard } from './components'
import { WeeklyGoalWheelSheet } from './timeWheel'
import { colors, typography } from './theme'

type Snapshot = Awaited<ReturnType<AppStoreValue['weeklyGoal']['load']>>
export function WeeklyGoalCard({ now, week: selectedWeek }: { now: number; week?: string }): React.ReactElement {
  const store = useAppStore(), route = useRoute(), week = selectedWeek ?? goalWeek(now)
  const api = useRef(store.weeklyGoal); api.current = store.weeklyGoal
  const [loaded, setLoaded] = useState<{ week: string; value: Snapshot } | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState(false), [wheel, setWheel] = useState(false)
  const [draft, setDraft] = useState(300), [busy, setBusy] = useState(false)
  const lifetime = useRef(0), locked = useRef(false)
  const snapshot = loaded?.week === week ? loaded.value : null
  const canEdit = week === goalWeek(now) && store.backup.gate === 'idle'
  useFocusEffect(useCallback(() => {
    const token = ++lifetime.current
    setLoaded(null); setError(''); setEditing(false); setWheel(false); setBusy(false); locked.current = false
    void api.current.load().then(value => {
      if (token === lifetime.current) setLoaded({ week, value })
    }, cause => { if (token === lifetime.current) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { lifetime.current++; clearNavigationDraft(route.key) }
  }, [week, store.restoreEpoch, retry, route.key]))
  const markDirty = (dirty: boolean) => {
    if (route.name === 'Today' || route.name === 'LearningReport') setNavigationDraftDirty(route.key, route.name, dirty)
  }
  useEffect(() => {
    markDirty(editing || wheel || busy)
    return () => clearNavigationDraft(route.key)
  }, [route.key, route.name, editing, wheel, busy])
  const save = async (minutes: number | null) => {
    if (locked.current || !snapshot || !canEdit) return
    locked.current = true; setBusy(true); setError(''); markDirty(true)
    const token = lifetime.current
    try {
      const goals = await api.current.save(snapshot.goals.revision, snapshot.generation, week, minutes)
      if (token !== lifetime.current) return
      setLoaded({ week, value: { ...snapshot, goals } }); setEditing(false); setWheel(false)
    } catch (cause) {
      if (token === lifetime.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (token === lifetime.current) { locked.current = false; setBusy(false) }
    }
  }
  const progress = snapshot ? weeklyGoalProgress(snapshot.goals, snapshot.focus, week, now) : null
  return <SectionCard title={canEdit ? '本周学习目标' : '这一周的学习目标'} subtitle={`${week} 起的一周 · 仅统计已保存的专注时长`}>
    {!progress ? <Text style={typography.bodySoft}>{error ? '目标暂时无法读取' : '读取学习目标…'}</Text> : progress.targetMinutes === null ?
      <Text style={typography.bodySoft}>{canEdit ? '给这一周定一个小目标，慢慢积累。' : '这一周没有设置学习目标。'}</Text> : <>
        <View style={styles.heading}><Text style={styles.percent}>{progress.percent}%</Text><Text style={typography.bodySoft}>目标 {goalDuration(progress.targetMinutes)}</Text></View>
        <View style={styles.track} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: progress.percent ?? 0 }} accessibilityLabel="学习目标完成进度">
          <View style={[styles.fill, { width: `${progress.percent}%` }]} />
        </View>
        <Text style={typography.bodySoft}>已完成 {goalDuration(Math.floor(progress.elapsedMs / 60000))}{progress.remainingMs === 0 ? ' · 目标已达成' : ` · 还差 ${goalDuration(Math.ceil((progress.remainingMs ?? 0) / 60000))}`}</Text>
      </>}
    {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    {!editing && error ? <AppButton label="重新读取学习目标" variant="secondary" onPress={() => setRetry(retry + 1)} /> : null}
    {canEdit && snapshot && !editing ? <AppButton label={progress?.targetMinutes ? '调整本周目标' : '设置本周目标'} variant="secondary" onPress={() => { setDraft(progress?.targetMinutes ?? 300); setEditing(true); markDirty(true); setError('') }} /> : null}
    {canEdit && editing ? <View style={styles.editor}>
      <AppButton label={`目标时长：${goalDuration(draft)} · 滚轮选择`} variant="secondary" disabled={busy} onPress={() => setWheel(true)} />
      <View style={styles.actions}>
        <AppButton label="保存目标" disabled={busy} loading={busy} onPress={() => void save(draft)} />
        <AppButton label="取消" variant="ghost" disabled={busy} onPress={() => { setEditing(false); setWheel(false); setError(''); markDirty(false) }} />
        {progress?.targetMinutes ? <AppButton label="关闭本周目标" variant="ghost" disabled={busy} onPress={() => void save(null)} /> : null}
      </View>
      <Text style={typography.caption}>只调整这一周，历史目标保持原样。关闭目标不删除专注记录。</Text>
    </View> : null}
    {canEdit && wheel ? <WeeklyGoalWheelSheet value={draft} onCancel={() => setWheel(false)} onConfirm={value => { setDraft(value); setWheel(false) }} /> : null}
  </SectionCard>
}
const styles = StyleSheet.create({
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
  percent: { ...typography.title, color: colors.primaryDark, fontVariant: ['tabular-nums'] },
  track: { height: 10, borderRadius: 5, backgroundColor: colors.primaryTint, overflow: 'hidden', marginVertical: 12 },
  fill: { height: '100%', borderRadius: 5, backgroundColor: colors.primary },
  editor: { gap: 12, marginTop: 12 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, error: { ...typography.caption, color: colors.clay },
})
