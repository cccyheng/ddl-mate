import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRoute } from '@react-navigation/native'
import { batchDeadline, batchTarget, isBatchEligible, TASK_BATCH_LIMIT, type TaskBatchAction, type TaskBatchRequest } from '../domain/taskBatch'
import type { Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { clearNavigationDraft, setNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import { AppButton, SectionCard } from './components'
import { ConfirmDialog } from './dialog'
import { WallClockField } from './datetimeField'
import { colors, spacing, typography } from './theme'

export function TaskBatchManager({ tasks, filterKey, onExit }: { tasks: Task[]; filterKey: string; onExit: () => void }): React.ReactElement {
  const store = useAppStore()
  const route = useRoute()
  const [selected, setSelected] = useState<number[]>([])
  const [deadline, setDeadline] = useState('')
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<TaskBatchRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('只处理未完成任务，每次最多 100 条。')
  const lock = useRef(false)
  const previousFilter = useRef(filterKey)
  const generation = store.getNotificationRouteGeneration()
  const previousGeneration = useRef(generation)
  const eligible = tasks.filter(isBatchEligible)
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function showMessage(text: string, transient = false): void {
    if (successTimer.current !== null) clearTimeout(successTimer.current)
    successTimer.current = null
    setMessage(text)
    if (transient) successTimer.current = setTimeout(() => {
      successTimer.current = null
      setMessage('')
    }, 3000)
  }
  useEffect(() => () => {
    if (successTimer.current !== null) clearTimeout(successTimer.current)
  }, [])
  useLayoutEffect(() => {
    setNavigationDraftDirty(route.key, 'TaskList', true)
    return () => clearNavigationDraft(route.key)
  }, [route.key])
  useEffect(() => {
    if (previousFilter.current === filterKey && previousGeneration.current === generation) return
    const restored = previousGeneration.current !== generation
    previousFilter.current = filterKey
    previousGeneration.current = generation
    setSelected([]); setPreview(null); setEditing(false); setDeadline('')
    showMessage(restored ? '数据已恢复，已清空选择。请重新核对当前任务。' : '筛选已改变，已清空选择。请在当前列表重新选择。')
  }, [filterKey, generation])
  function prepare(action: TaskBatchAction): void {
    if (lock.current || previousFilter.current !== filterKey || previousGeneration.current !== generation) return
    try {
      batchDeadline(action)
      const targets = eligible.filter(task => selected.includes(task.id)).map(batchTarget)
      if (!targets.length || targets.length !== selected.length) throw new Error('所选任务已变化，请重新选择。')
      setPreview({ targets, action, generation: store.getNotificationRouteGeneration() })
      showMessage('')
    } catch (cause) { showMessage(cause instanceof Error ? cause.message : '请重新核对。') }
  }
  async function submit(): Promise<void> {
    if (lock.current || !preview || previousFilter.current !== filterKey || previousGeneration.current !== generation) return
    lock.current = true; setBusy(true)
    try {
      const result = await store.applyTaskBatch(preview)
      setPreview(null); setSelected([]); setEditing(false); setDeadline('')
      showMessage(result.warning ?? `已保存：更新 ${result.updatedIds.length} 条，${result.unchangedIds.length} 条无需修改。`, !result.warning)
    } catch (cause) {
      setPreview(null); setSelected([])
      showMessage(cause instanceof Error ? cause.message : '整批未保存，请刷新后重新核对。')
      void store.refresh()
    } finally { lock.current = false; setBusy(false) }
  }
  const actionLabel = preview?.action.kind === 'complete' ? '标记为已完成'
    : preview?.action.kind === 'clearDeadline' ? '清除截止日期'
      : `截止日期统一为 ${preview?.action.kind === 'deadline' ? preview.action.value.replace('T', ' ') : ''}${preview?.action.kind === 'deadline' && preview.action.value.length === 10 ? '（只设日期，当天结束前）' : '（北京时间）'}`
  return <>
    <SectionCard title={`批量管理 · 已选 ${selected.length} 条`} subtitle="先勾选任务，再选择操作">
      {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
      <View style={styles.actions}>
        <AppButton label="全选当前列表" variant="secondary" disabled={busy || eligible.length === 0 || eligible.length > TASK_BATCH_LIMIT}
          onPress={() => { setSelected(eligible.map(t => t.id)); setPreview(null) }} />
        <AppButton label="清空选择" variant="secondary" disabled={busy || !selected.length} onPress={() => { setSelected([]); setPreview(null) }} />
        <AppButton label="退出批量管理" variant="ghost" disabled={busy} onPress={onExit} />
      </View>
      {eligible.length > TASK_BATCH_LIMIT ? <Text style={styles.message}>当前超过 100 条，请缩小筛选范围或逐条勾选。</Text> : null}
      <View style={styles.actions}>
        <AppButton label="批量完成" disabled={busy || !selected.length} onPress={() => prepare({ kind: 'complete' })} />
        <AppButton label="统一截止日期" variant="secondary" disabled={busy || !selected.length} onPress={() => setEditing(v => !v)} />
        <AppButton label="清除截止日期" variant="secondary" disabled={busy || !selected.length} onPress={() => prepare({ kind: 'clearDeadline' })} />
      </View>
      {editing ? <>
        <WallClockField label="新的截止日期" value={deadline} onChange={setDeadline} allowDateOnly disabled={busy || !!preview}
          identityKey={`${generation}:${filterKey}`} hint="时间可以不填。留空不会清除原日期。" />
        <AppButton label="预览日期修改" disabled={busy || !selected.length} onPress={() => prepare({ kind: 'deadline', value: deadline })} />
      </> : null}
    </SectionCard>
    {eligible.length === 0 ? <Text style={styles.message}>当前筛选下没有可批量处理的未完成任务。</Text> : null}
    {eligible.map(task => {
      const checked = selected.includes(task.id)
      return <Pressable key={task.id} accessibilityRole="checkbox" accessibilityState={{ checked, disabled: busy }}
        accessibilityLabel={`${checked ? '取消选择' : '选择'} ${task.title}`} disabled={busy}
        onPress={() => {
          if (lock.current) return
          if (!checked && selected.length >= TASK_BATCH_LIMIT) showMessage('已选满 100 条，请先取消部分选择。')
          setSelected(ids => ids.includes(task.id) ? ids.filter(id => id !== task.id) : ids.length < TASK_BATCH_LIMIT ? [...ids, task.id] : ids)
          setPreview(null)
        }} style={[styles.task, checked && styles.selected]}>
        <Text style={styles.title}>{checked ? '☑' : '☐'} {task.title}</Text>
        <Text style={styles.message}>{store.courseById(task.courseId)?.name ?? '未关联课程'} · {task.deadline?.replace('T', ' ').replace('+08:00', '') ?? '未设置截止日期'}</Text>
      </Pressable>
    })}
    <ConfirmDialog visible={!!preview} title={`确认处理 ${preview?.targets.length ?? 0} 条任务？`}
      message={actionLabel} details={preview?.targets.map(t => `#${t.id} ${t.title}`)} confirmLabel="确认整批保存" busy={busy}
      onConfirm={() => void submit()} onCancel={() => { if (!lock.current) setPreview(null) }} />
  </>
}
const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginVertical: spacing.sm },
  message: { ...typography.caption, marginVertical: spacing.sm, flexShrink: 1 },
  title: { ...typography.body, fontWeight: '700', flexShrink: 1 },
  task: { padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm, minHeight: 64 },
  selected: { borderColor: colors.primary, backgroundColor: colors.primarySoft, borderWidth: 2 },
})
