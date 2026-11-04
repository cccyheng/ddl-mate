import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { readShanghaiEpochClock } from '../domain/calendarClock'
import { buildRevisionPreview, listExams, type RevisionPreview } from '../domain/examRevision'
import type { ExamRevisionStore } from '../domain/examRevisionRepository'
import { taskStatusLabels } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import type { SharedExamRoutes } from '../navigation/types'
import { AppButton, AppTextField, LoadingState, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { DateWheelSheet } from '../ui/timeWheel'
import { useFocusClock } from '../ui/useFocusClock'
import { colors, spacing, typography } from '../ui/theme'

type Nav = NativeStackNavigationProp<SharedExamRoutes>
type Snapshot = ExamRevisionStore & { generation: number }
type Proposal = { preview: RevisionPreview; planId: number; generation: number }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function ExamsScreen(): React.ReactElement {
  const store = useAppStore(), navigation = useNavigation<Nav>()
  const clock = useFocusClock(readShanghaiEpochClock)
  useFocusEffect(useCallback(() => { void store.refresh() }, [store.refresh]))
  const exams = listExams(store.data.tasks, new Date(clock.epochMs))
  return <ScreenScaffold title="考试与复习" subtitle="记录考试日期，把考前准备安排到每一天。">
    <AppButton label="新增考试" onPress={() => navigation.navigate('TaskForm', { defaultType: 'EXAM' })} />
    <AppButton label="拍照／相册识别考试" variant="secondary" onPress={() => navigation.navigate('ExamPhoto')} />
    {store.status === 'loading' ? <LoadingState message="正在读取考试，请稍候…" /> : null}
    {store.status === 'error' ? <SectionCard title="暂时无法读取"><Text>{store.error}</Text><AppButton label="重试" onPress={() => { void store.retryBootstrap() }} /></SectionCard> : null}
    {store.refreshError ? <Text accessibilityRole="alert">{store.refreshError}</Text> : null}
    {store.status === 'ready' && !exams.length ? <SectionCard title="还没有考试"><Text>新增一场考试并填写日期，就能查看倒计时和安排复习。</Text></SectionCard> : null}
    {exams.map(({ task, date, label, phase }) => <SectionCard key={task.id} title={task.title}>
      <Text style={styles.countdown}>{label}</Text>
      <Text style={styles.hint}>{store.courseById(task.courseId)?.name ?? '未关联课程'} · {date ?? '日期未设置'}</Text>
      <View style={styles.actions}>
        <AppButton label="查看考试" variant="secondary" onPress={() => navigation.navigate('TaskDetail', { id: task.id })} />
        <AppButton label="编辑考试" variant="ghost" onPress={() => navigation.navigate('TaskForm', { id: task.id })} />
        <AppButton label={phase === 'upcoming' ? '安排复习' : '查看复习安排'} onPress={() => navigation.navigate('ExamRevision', { id: task.id })} />
      </View>
    </SectionCard>)}
  </ScreenScaffold>
}

export function ExamRevisionScreen(): React.ReactElement {
  const store = useAppStore(), navigation = useNavigation<Nav>()
  const { params: { id } } = useRoute<RouteProp<SharedExamRoutes, 'ExamRevision'>>()
  const clock = useFocusClock(readShanghaiEpochClock)
  const latestStore = useRef(store); latestStore.current = store
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [start, setStart] = useState(clock.dateKey), [end, setEnd] = useState('')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7])
  const [topics, setTopics] = useState(''), [minutes, setMinutes] = useState('30')
  const [picker, setPicker] = useState<'start' | 'end' | null>(null)
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false)
  const busy = useRef(false), committed = useRef(false), mounted = useRef(true), request = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++ } }, [])
  const reload = useCallback(async () => {
    const ticket = ++request.current
    try {
      const result = await latestStore.current.examRevision.load()
      if (mounted.current && ticket === request.current) { setSnapshot(result); setLoadError(null) }
    } catch (cause) {
      if (mounted.current && ticket === request.current) { setSnapshot(null); setLoadError(message(cause)) }
    }
  }, [])
  useFocusEffect(useCallback(() => { void latestStore.current.refresh(); void reload() }, [reload]))
  useEffect(() => { void reload() }, [reload, store.notificationRouteGeneration, store.data.tasks])
  usePreventRemove(dirty || saving, ({ data }) => {
    if (busy.current) { Alert.alert('正在保存', '请等保存结束后再离开。'); return }
    Alert.alert('离开复习安排？', '尚未创建的修改不会保存。', [
      { text: '继续编辑', style: 'cancel' },
      { text: '离开', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ])
  })
  const exam = store.data.tasks.find(task => task.id === id) ?? null
  const input = { startDate: start, endDate: end, weekdays: days, topics: topics.split(/\r?\n/).map(t => t.trim()).filter(Boolean), minutes: Number(minutes) }
  const current = buildRevisionPreview(exam, input, new Date(clock.epochMs))
  const validProposal = proposal !== null && current.ok && current.preview.fingerprint === proposal.preview.fingerprint &&
    proposal.generation === store.notificationRouteGeneration && snapshot?.generation === proposal.generation
  function edit(action: () => void) {
    if (busy.current) return
    action(); setDirty(true); setProposal(null); setNotice(null); committed.current = false
  }
  function preview() {
    if (busy.current || !snapshot) return
    const result = buildRevisionPreview(latestStore.current.data.tasks.find(t => t.id === id) ?? null, input, new Date())
    if (!result.ok) { setNotice(result.reason); setProposal(null); return }
    setProposal({ preview: result.preview, planId: snapshot.nextId, generation: snapshot.generation })
    committed.current = false; setNotice(null); setDirty(true)
  }
  async function confirm() {
    if (busy.current || committed.current || !proposal || !validProposal) return
    busy.current = true; setSaving(true); setNotice(null)
    try {
      const result = await latestStore.current.examRevision.create({ examId: id, planId: proposal.planId,
        draft: proposal.preview.input, fingerprint: proposal.preview.fingerprint, generation: proposal.generation })
      committed.current = true
      if (mounted.current) {
        setDirty(false); setProposal(null)
        setNotice(`已创建 ${result.plan.taskIds.length} 条复习任务。${result.refreshError ? '保存已成功，但列表刷新失败，请点“刷新已保存安排”，不要重复创建。' : '可在下方、任务列表或日历中查看。'}`)
        await reload()
      }
    } catch (cause) { if (mounted.current) setNotice(message(cause)) }
    finally { busy.current = false; if (mounted.current) setSaving(false) }
  }
  return <ScreenScaffold title="复习安排" subtitle={exam?.title ?? '考试已不存在'}>
    <SectionCard title="安排考前复习">
      <Text style={styles.hint}>选择今天到考试前一天的日期，每个选中的日期安排一次；主题按填写顺序循环。最多 30 次、跨度不超过 90 天。创建后可在任务中单独编辑。</Text>
      <AppButton label={`开始日期：${start || '请选择'}`} disabled={saving} variant="secondary" onPress={() => setPicker('start')} />
      <AppButton label={`结束日期：${end || '请选择'}`} disabled={saving} variant="secondary" onPress={() => setPicker('end')} />
      <Text style={styles.label}>复习星期（可多选）</Text>
      <View style={styles.actions}>{['一', '二', '三', '四', '五', '六', '日'].map((label, index) => <AppButton key={label}
        label={`周${label}`} accessibilityLabel={`周${label}，${days.includes(index + 1) ? '已选' : '未选'}`}
        disabled={saving} variant={days.includes(index + 1) ? 'primary' : 'secondary'} compact
        onPress={() => edit(() => setDays(previous => previous.includes(index + 1) ? previous.filter(d => d !== index + 1) : [...previous, index + 1]))} />)}</View>
      <AppTextField label="复习主题（每行一个）" value={topics} multiline maxLength={3100} editable={!saving}
        placeholder={'例如：第一章重点\n历年试题\n错题回顾'} onChangeText={value => edit(() => setTopics(value))} />
      <AppTextField label="每次预计分钟数" value={minutes} keyboardType="number-pad" maxLength={4} editable={!saving} onChangeText={value => edit(() => setMinutes(value))} />
      {loadError ? <Text accessibilityRole="alert">{loadError}</Text> : null}
      <AppButton label="预览复习安排" disabled={saving || !snapshot || committed.current} onPress={preview} />
      {proposal ? <View style={styles.preview}>
        <Text style={styles.label}>待确认 · {proposal.preview.sessions.length} 次复习</Text>
        {proposal.preview.sessions.map(session => <Text key={session.date} style={styles.hint}>{session.date} · {session.topic} · {session.minutes} 分钟</Text>)}
        {!validProposal ? <Text accessibilityRole="alert">考试、日期或数据已变化，请重新预览。</Text> : null}
        <AppButton label="确认创建复习任务" disabled={!validProposal || saving} loading={saving} onPress={() => { void confirm() }} />
      </View> : null}
      {notice ? <Text style={styles.notice} accessibilityRole="alert">{notice}</Text> : null}
      <Text style={styles.hint}>修改考试日期不会自动移动已创建的任务。本页安排日期与预计用时，不指定一天中的上课或学习时段。</Text>
    </SectionCard>
    <SectionCard title="已保存的复习安排">
      <AppButton label="刷新已保存安排" disabled={saving} variant="ghost" onPress={() => { void store.refresh(); void reload() }} />
      {!snapshot && !loadError ? <LoadingState /> : null}
      {snapshot && !snapshot.plans.some(plan => plan.examId === id) ? <Text style={styles.hint}>还没有保存的安排。先预览，再确认创建。</Text> : null}
      {snapshot?.plans.filter(plan => plan.examId === id).map(plan => {
        const tasks = plan.taskIds.map(taskId => store.data.tasks.find(task => task.id === taskId))
        return <View key={plan.id} style={styles.preview}>
          <Text style={styles.label}>安排 {plan.id} · 已完成 {tasks.filter(t => t?.status === 'DONE').length}/{tasks.length}</Text>
          {plan.taskIds.map((taskId, index) => {
            const task = tasks[index]
            return task ? <AppButton key={taskId} variant="ghost" label={`${task.title} · ${task.deadline ?? '未设日期'} · ${taskStatusLabels[task.status]}`}
              onPress={() => navigation.navigate('TaskDetail', { id: taskId })} /> : <Text key={taskId} style={styles.hint}>任务 #{taskId} 已删除</Text>
          })}
        </View>
      })}
    </SectionCard>
    {picker ? <DateWheelSheet value={picker === 'start' ? start : end} fallbackDateKey={clock.dateKey}
      title={picker === 'start' ? '复习开始日期' : '复习结束日期'} disabled={saving} onCancel={() => setPicker(null)}
      onConfirm={value => { edit(() => picker === 'start' ? setStart(value) : setEnd(value)); setPicker(null) }} /> : null}
  </ScreenScaffold>
}

const styles = StyleSheet.create({
  countdown: { ...typography.title, color: colors.primary },
  label: { ...typography.body, fontWeight: '700', color: colors.text, marginTop: spacing.sm },
  hint: { ...typography.caption, color: colors.textMuted, marginVertical: spacing.xs },
  notice: { ...typography.body, color: colors.primaryDark, marginVertical: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.sm },
  preview: { borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.md, marginTop: spacing.md },
})

