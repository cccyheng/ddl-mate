import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRoute } from '@react-navigation/native'
import { clearNavigationDraft, setNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import { useAppStore } from '../store/AppStore'
import { focusClockIssue, focusDayStart, focusDuration, focusRemaining, focusTotal, formatFocusDuration, type FocusAction, type FocusStore } from '../domain/focusTime'
import type { FocusReminderSnapshot } from '../domain/focusReminderService'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { AppButton, AppTextField, OptionGroup, SectionCard } from '../ui/components'
import { DurationWheelSheet } from '../ui/timeWheel'
import { FocusDial } from '../ui/FocusDial'
import { FocusFullscreen, type FocusConfirmAction } from '../ui/FocusFullscreen'
import { FocusRecordManager } from '../ui/FocusRecordManager'
import { ConfirmDialog } from '../ui/dialog'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, spacing, typography } from '../ui/theme'

type Snapshot = FocusStore & { generation: number }
const readNow = () => Date.now()
const dateKey = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
const stampLabel = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')

export function FocusTimeScreen(): React.ReactElement {
  const store = useAppStore()
  const api = useRef(store.focusTime); api.current = store.focusTime
  useFocusClock(readNow, { intervalMs: 1000 })
  // A save can happen between ticks: read again so a fresh start is not mistaken for clock rollback.
  const now = readNow()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('自由专注')
  const [taskId, setTaskId] = useState<number | null>(null)
  const [showTasks, setShowTasks] = useState(false)
  const [search, setSearch] = useState('')
  const [historyDirty, setHistoryDirty] = useState(false)
  const [confirm, setConfirm] = useState<FocusConfirmAction | null>(null)
  const [immersive, setImmersive] = useState(false)
  const [mode, setMode] = useState<'elapsed' | 'countdown'>('elapsed')
  const [focusMinutes, setFocusMinutes] = useState(25)
  const [restMinutes, setRestMinutes] = useState(5)
  const [durationWheel, setDurationWheel] = useState<'focus' | 'rest' | null>(null)
  const reminderService = store.focusTime.getReminder()
  const [reminder, setReminder] = useState<FocusReminderSnapshot | null>(() => reminderService?.getSnapshot() ?? null)
  useEffect(() => {
    setReminder(reminderService?.getSnapshot() ?? null)
    return reminderService?.subscribe(() => setReminder(reminderService.getSnapshot()))
  }, [reminderService])
  const locked = useRef(false)
  const lifetime = useRef(0)
  const reload = useCallback(async () => {
    const token = lifetime.current
    try {
      const next = await api.current.load()
      if (token === lifetime.current) { setSnapshot(next); setError('') }
    } catch (e) { if (token === lifetime.current) setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useFocusEffect(useCallback(() => {
    lifetime.current++; setSnapshot(null); setConfirm(null); setDurationWheel(null); setTaskId(null); setMessage('')
    // 全屏只是展示层：离开页面/恢复备份时收起，但绝不写计时状态。
    setImmersive(false)
    void reload()
    void api.current.getReminder()?.reconcile()
    return () => { lifetime.current++; setImmersive(false) }
  }, [reload, store.restoreEpoch]))

  async function act(action: FocusAction, expected: Snapshot | null = snapshot): Promise<boolean> {
    if (locked.current || !snapshot || !expected) return false
    locked.current = true; setBusy(true); setError(''); setMessage('')
    const token = lifetime.current
    try {
      const next = await api.current.act(expected.revision, expected.generation, action)
      if (token === lifetime.current) {
        setSnapshot(next); setConfirm(null)
        // 新专注直接进入沉浸钟；暂停/继续/结束等动作不改展示层。
        if (action.type === 'start') { Keyboard.dismiss(); setImmersive(true) }
        if (action.type === 'finish') setMessage(snapshot.active?.timer?.kind === 'rest' ? '休息已结束，不计入学习时长。' : '本次专注已保存，可以在学习周报查看时长。')
        if (action.type === 'finishAndRest') setMessage('专注记录已保存。现在休息一下，休息时间不计入学习时长。')
        if (action.type === 'nextFocus') setMessage('新一轮专注开始了。')
        if (action.type === 'discard') setMessage('本次计时已放弃，没有保存。')
        if (action.type === 'recover') setMessage('已舍弃未确认时段，之前暂停保存的时段仍然保留。')
        if (action.type === 'historySave' || action.type === 'historyDelete') setMessage('专注记录已更新，返回今天页或周报即可查看最新进度。')
        return true
      }
    } catch (e) {
      if (token === lifetime.current) {
        setError(e instanceof Error ? e.message : String(e)); setConfirm(null)
        // Re-read after an uncertain result; never replay a write automatically.
        try { const next = await api.current.load(); if (token === lifetime.current) setSnapshot(next) } catch { /* Keep error and retry control. */ }
      }
    } finally { locked.current = false; setBusy(false) }
    return false
  }
  const active = snapshot?.active ?? null
  const route = useRoute()
  const dirty = historyDirty || busy || confirm !== null || durationWheel !== null || (!active && (title !== '自由专注' || taskId !== null || mode !== 'elapsed' || focusMinutes !== 25 || restMinutes !== 5))
  useEffect(() => {
    setNavigationDraftDirty(route.key, 'FocusTime', dirty)
    return () => clearNavigationDraft(route.key)
  }, [route.key, dirty])
  const isRest = active?.timer?.kind === 'rest'
  const expired = Boolean(active?.timer && focusRemaining(active, now) === 0)
  const displayed = active ? active.timer ? Math.ceil(focusRemaining(active, now) / 1000) * 1000 : focusDuration(active, now) : mode === 'countdown' ? focusMinutes * 60000 : 0
  const target = active?.timer ? (isRest ? active.timer.restMinutes : active.timer.focusMinutes) * 60000 : 0
  const dialProgress = active?.timer ? 1 - focusRemaining(active, now) / target : mode === 'countdown' && !active ? 0 : null
  const dialValue = formatFocusDuration(displayed)
  const dialText = dialValue.startsWith('00:') ? dialValue.slice(3) : dialValue
  const dialLabel = active ? expired ? isRest ? '休息结束' : '本轮完成 · 等待保存' : active.runningSince === null ? '已暂停' : isRest ? '正在休息' : active.timer ? '番茄专注中' : '专注中' : mode === 'countdown' ? '准备开始这一轮' : '准备好了，就开始吧'
  const dialCaption = active?.timer ? `${Math.round((dialProgress ?? 0) * 100)}% 已完成` : mode === 'countdown' ? `${focusMinutes} 分钟专注 · ${restMinutes} 分钟休息` : '正计时 · 按自己的节奏'
  const issue = focusClockIssue(active, now)
  const today = focusDayStart(dateKey(now))
  const weekday = new Date(today + 8 * 3600000).getUTCDay() || 7
  const week = today - (weekday - 1) * 86400000
  const chosen = store.data.tasks.find(t => t.id === taskId)
  const tasks = store.data.tasks.filter(t => t.status !== 'DONE' && t.status !== 'CANCELLED' && t.title.includes(search.trim()))
  const sessionTitle = (chosen?.title ?? title).trim()
  const sessionCourse = store.data.courses.find(c => c.id === chosen?.courseId)?.name ?? ''
  const canStart = Boolean(snapshot) && !busy && !historyDirty && Boolean(sessionTitle) && !active
  const startHint = historyDirty ? '请先保存或取消下方的记录编辑，再开始新专注。' : !sessionTitle ? '先写下这次专注要做什么。' : !snapshot ? '正在读取手机中的记录…' : ''
  const confirmTitle = confirm === 'finishAndRest' ? '保存专注并开始休息？' : confirm === 'nextFocus' ? '开始新一轮专注？' : confirm === 'finish' ? isRest ? '结束休息？' : '保存这次专注？' : confirm === 'recover' ? '舍弃未确认时段？' : '放弃这次专注？'
  const confirmMessage = confirm === 'finishAndRest' ? '保存实际专注时长，随后开始休息倒计时。休息不计入学习时长。' : confirm === 'nextFocus' ? '结束当前休息，沿用本轮设置开始新的专注倒计时。' : confirm === 'finish' ? isRest ? '结束当前休息，回到准备页面。' : '确认后计时结束，累计时长会加入记录和学习周报。' : confirm === 'recover' ? '仅保留之前按下暂停时已保存的时段；当前连续计时段不会计入。' : '本次计时将不保存，已有历史记录会保留。'
  const confirmLabel = confirm === 'discard' || confirm === 'recover' ? '确认舍弃' : '确认'
  const confirmDanger = confirm === 'discard' || confirm === 'recover'
  function startSession() {
    if (!canStart) return
    void act({ type: 'start', title: chosen?.title ?? title, courseName: sessionCourse, ...(mode === 'countdown' ? { timer: { kind: 'focus', focusMinutes, restMinutes } } : {}) })
  }
  function exitImmersive() {
    // 写入/确认期间保持全屏可见，避免在全屏 Modal 关闭过程中再挂一个 ConfirmDialog。
    if (locked.current || busy) return
    setConfirm(null)
    setImmersive(false)
  }
  function cancelConfirm() {
    if (locked.current || busy) return
    setConfirm(null)
  }
  return <ScreenScaffold title="专注计时" subtitle="留一段时间，做好眼前这一件事。">
    {error ? <SectionCard title="暂时无法操作"><Text style={styles.note}>{error}</Text><AppButton label="重新读取状态" onPress={() => void reload()} disabled={busy} /></SectionCard> : null}
    {message ? <Text accessibilityRole="alert" style={styles.note}>{message}</Text> : null}
    <View style={[styles.hero, isRest && styles.restHero]}>
      <View style={styles.heroHeading}>
        <Text style={styles.eyebrow}>{isRest ? '放松 · 充电' : '专注 · 当下'}</Text>
        <Text style={styles.heroTitle}>{active ? isRest ? '让思绪歇一会儿' : active.title : '把这一刻留给自己'}</Text>
        <Text style={styles.note}>{active ? active.courseName || '自由专注' : '从一小段专注开始'}</Text>
      </View>
      {!active && snapshot ? <OptionGroup label="计时方式" value={mode} options={[{ value: 'elapsed', label: '正计时' }, { value: 'countdown', label: '番茄钟' }]} disabled={busy} onChange={setMode} /> : null}
      <FocusDial value={dialText} rest={isRest} progress={dialProgress} label={dialLabel} caption={dialCaption} />
      {snapshot && confirm === null && durationWheel === null ? <AppButton
        label={isRest ? '全屏休息' : active ? '全屏专注' : '全屏准备'}
        variant="secondary"
        disabled={busy}
        accessibilityHint="全屏显示计时；退出后计时继续，不会停止或保存"
        onPress={() => { Keyboard.dismiss(); setImmersive(true) }}
      /> : null}
      <View style={styles.timerHint}>
        <Text style={styles.note}>{isRest ? '放松片刻，休息不会计入学习时长。下一轮由你开始。' : active?.timer ? '切后台继续倒计时。到时停止累计，确认保存后计入学习时长。' : '切后台继续计时，暂停不计入。计时仅记录经过的时间。'}</Text>
      </View>
      {!snapshot ? <Text style={styles.note}>{error ? '读取失败，请重试后再开始计时。' : '正在读取手机中的记录…'}</Text> : active ? <>
        {issue ? <><Text accessibilityRole="alert" style={styles.warning}>{issue}</Text><AppButton label="舍弃未确认时段" variant="secondary" disabled={busy} onPress={() => setConfirm('recover')} /></> : <>
          {!expired ? <AppButton label={active.runningSince === null ? isRest ? '继续休息' : '继续专注' : '暂停一下'} disabled={busy} onPress={() => void act({ type: active.runningSince === null ? 'resume' : 'pause' })} /> : null}
          {active.timer?.kind === 'focus' ? <AppButton label="保存并开始休息" variant={expired ? 'primary' : 'secondary'} disabled={busy} onPress={() => setConfirm('finishAndRest')} /> : null}
          {isRest ? <AppButton label="开始下一轮专注" disabled={busy} onPress={() => setConfirm('nextFocus')} /> : null}
          <AppButton label={isRest ? '结束休息' : '结束并保存'} variant="secondary" disabled={busy} onPress={() => setConfirm('finish')} />
        </>}
        <AppButton label="放弃本次" variant="ghost" disabled={busy} onPress={() => setConfirm('discard')} />
      </> : <>
        <AppButton label="开始专注" disabled={busy || historyDirty || !sessionTitle} onPress={startSession} />
        {historyDirty ? <Text style={styles.note}>请先保存或取消下方的记录编辑，再开始新专注。</Text> : null}
        <View style={styles.setupHeading}><Text style={styles.eyebrow}>本轮设置</Text><Text style={styles.note}>时长与任务按你的节奏调整</Text></View>
        {mode === 'countdown' ? <View style={styles.tasks}>
          <AppButton label={`专注 ${focusMinutes} 分钟 · 滚轮选择`} variant="secondary" disabled={busy} onPress={() => setDurationWheel('focus')} />
          <AppButton label={`休息 ${restMinutes} 分钟 · 滚轮选择`} variant="secondary" disabled={busy} onPress={() => setDurationWheel('rest')} />
        </View> : null}
        <AppTextField label="本次专注" value={chosen?.title ?? title} editable={!chosen && !busy} onChangeText={setTitle} maxLength={200} />
        <AppButton label={chosen ? `已选：${chosen.title}` : '选择一个任务（可选）'} variant="secondary" onPress={() => setShowTasks(!showTasks)} disabled={busy} />
        {chosen ? <AppButton label="改为自由专注" variant="secondary" onPress={() => setTaskId(null)} disabled={busy} /> : null}
        {showTasks ? <View style={styles.tasks}>
          <AppTextField label="搜索任务" value={search} onChangeText={setSearch} />
          {tasks.slice(0, 30).map(task => <AppButton key={task.id} label={task.title} variant="secondary" disabled={busy} onPress={() => { setTaskId(task.id); setShowTasks(false) }} />)}
          <Text style={styles.note}>{tasks.length > 30 ? '输入关键词可以找到更多任务。' : tasks.length ? '只显示尚未结束的任务。' : '没有匹配的任务。'}</Text>
        </View> : null}
      </>}
    </View>
    {snapshot ? <SectionCard title="到时提醒" subtitle="仅用于番茄专注和休息；正计时没有预定结束时间。">
      <OptionGroup label="手机通知" value={snapshot.reminderEnabled ? 'on' : 'off'} options={[{ value: 'off', label: '关闭' }, { value: 'on', label: '开启' }]} disabled={busy} onChange={v => void act({ type: 'reminder', enabled: v === 'on' })} />
      <Text style={styles.note}>{reminder?.error ?? (reminder?.queuedAt && reminder.queuedAt > now ? `到时提醒已安排：${stampLabel(reminder.queuedAt)}（北京时间）` : expired ? '本轮已到时。实际送达和声音受系统通知权限与专注模式影响。' : snapshot.reminderEnabled ? '开启后会在番茄钟运行时安排到时提醒；暂停期间不安排。' : '开启时才请求通知权限，不影响计时保存。')}</Text>
      <AppButton label="重新同步提醒" variant="secondary" disabled={busy || reminder?.busy} onPress={() => { void reminderService?.reconcile() }} />
    </SectionCard> : null}
    <SectionCard title="已保存的学习时长" subtitle="按北京时间分日统计；进行中的专注在结束保存后计入。">
      {snapshot ? <View style={styles.stats}>
        <View style={styles.stat}><Text style={styles.eyebrow}>今天的积累</Text><Text style={styles.statValue}>{formatFocusDuration(focusTotal(snapshot, today, today + 86400000, now))}</Text></View>
        <View style={styles.stat}><Text style={styles.eyebrow}>本周的积累</Text><Text style={styles.statValue}>{formatFocusDuration(focusTotal(snapshot, week, week + 7 * 86400000, now))}</Text></View>
      </View> : <Text style={styles.note}>{error ? '时长暂时无法读取。' : '正在读取已保存的时长…'}</Text>}
    </SectionCard>
    {snapshot ? <FocusRecordManager key={snapshot.generation} snapshot={snapshot} busy={busy} onAction={act} onDirtyChange={setHistoryDirty} /> : <SectionCard title="专注记录"><Text style={styles.note}>{error ? '记录暂时无法读取，原数据会保留。' : '正在读取专注记录…'}</Text></SectionCard>}
    {durationWheel && !immersive ? <DurationWheelSheet key={durationWheel} title={durationWheel === 'focus' ? '专注时长' : '休息时长'} value={durationWheel === 'focus' ? focusMinutes : restMinutes} max={durationWheel === 'focus' ? 180 : 60} onCancel={() => setDurationWheel(null)} onConfirm={minutes => { if (durationWheel === 'focus') setFocusMinutes(minutes); else setRestMinutes(minutes); setDurationWheel(null) }} /> : null}
    {confirm !== null && !immersive ? <ConfirmDialog visible title={confirmTitle} message={confirmMessage} confirmLabel={confirmLabel} danger={confirmDanger} busy={busy} onConfirm={() => { if (confirm && !locked.current) void act({ type: confirm }) }} onCancel={cancelConfirm} /> : null}
    <FocusFullscreen
      visible={immersive}
      loading={!snapshot}
      active={Boolean(active)}
      countdown={Boolean(active?.timer)}
      rest={isRest}
      expired={expired}
      paused={active?.runningSince === null}
      issue={issue}
      time={dialText}
      stateLabel={dialLabel}
      caption={dialCaption}
      taskTitle={active ? active.title : sessionTitle || '自由专注'}
      courseName={active ? active.courseName : sessionCourse}
      progress={dialProgress}
      error={error}
      message={message}
      busy={busy}
      canStart={canStart}
      startHint={startHint}
      confirm={confirm}
      confirmTitle={confirmTitle}
      confirmMessage={confirmMessage}
      confirmLabel={confirmLabel}
      confirmDanger={confirmDanger}
      onExit={exitImmersive}
      onPauseResume={() => { if (active) void act({ type: active.runningSince === null ? 'resume' : 'pause' }) }}
      onFinishAndRest={() => setConfirm('finishAndRest')}
      onNextFocus={() => setConfirm('nextFocus')}
      onFinish={() => setConfirm('finish')}
      onDiscard={() => setConfirm('discard')}
      onRecover={() => setConfirm('recover')}
      onRetry={() => void reload()}
      onStart={startSession}
      onCancelConfirm={cancelConfirm}
      onConfirm={() => { if (confirm && !locked.current) void act({ type: confirm }) }}
    />
  </ScreenScaffold>
}
const styles = StyleSheet.create({
  hero: { padding: 20, borderRadius: 28, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DDE8DF', gap: 12, marginBottom: 20 },
  restHero: { backgroundColor: '#FFFCF6', borderColor: '#EAE0CC' },
  heroHeading: { alignItems: 'center', gap: 6, paddingTop: 4 },
  eyebrow: { ...typography.label, color: colors.textMuted, fontSize: 12, letterSpacing: 1 },
  heroTitle: { ...typography.title, textAlign: 'center', fontSize: 23 },
  timerHint: { paddingHorizontal: 8, paddingBottom: 8 },
  setupHeading: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 18, marginTop: 10, gap: 5 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { flexGrow: 1, flexBasis: 120, minWidth: 0, padding: 14, backgroundColor: '#F0F5F1', borderRadius: 18, gap: 8 },
  statValue: { ...typography.section, fontVariant: ['tabular-nums'], fontSize: 22 },
  timer: { alignItems: 'center', paddingVertical: spacing.xl, gap: spacing.md },
  clock: { fontSize: 48, fontWeight: '700', fontVariant: ['tabular-nums'], color: colors.primary, maxWidth: '100%' },
  state: { ...typography.label, color: colors.primary }, note: { ...typography.caption },
  restClock: { color: colors.warn },
  warning: { ...typography.body, color: colors.clay }, total: { ...typography.section },
  tasks: { gap: spacing.sm }, record: { paddingVertical: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, gap: spacing.xs },
})
