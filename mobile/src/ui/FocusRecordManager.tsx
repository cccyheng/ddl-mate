import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { applyFocusAction, focusDuration, formatFocusDuration, type FocusAction, type FocusStore } from '../domain/focusTime'
import { historyDrafts, historyIntervals, historyWall, historyLabel, type HistoryIntervalDraft } from '../domain/focusHistory'
import { AppButton, AppTextField, SectionCard } from './components'
import { WallClockField } from './datetimeField'
import { ConfirmDialog } from './dialog'
import { colors, typography } from './theme'

type Snapshot = FocusStore & { generation: number }
type Editor = { id?: number; title: string; courseName: string; rows: HistoryIntervalDraft[]; expected: Snapshot }
export function FocusRecordManager({ snapshot, busy, onAction, onDirtyChange }: {
  snapshot: Snapshot; busy: boolean
  onAction: (action: FocusAction, expected: Snapshot) => Promise<boolean>
  onDirtyChange: (dirty: boolean) => void
}): React.ReactElement {
  const [selected, setSelected] = useState<number | null>(null), [limit, setLimit] = useState(20)
  const [editor, setEditor] = useState<Editor | null>(null), [shownRows, setShownRows] = useState(10)
  const [pending, setPending] = useState<{ action: FocusAction; expected: Snapshot } | null>(null)
  const [error, setError] = useState('')
  const locked = useRef(false), live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false; onDirtyChange(false) } }, [onDirtyChange])
  useEffect(() => { onDirtyChange(Boolean(editor || pending || busy)) }, [editor, pending, busy, onDirtyChange])
  const record = snapshot.records.find(r => r.id === selected)
  const readonly = busy || Boolean(snapshot.active)
  const begin = (id?: number) => {
    if (readonly) return
    const old = id === undefined ? undefined : snapshot.records.find(r => r.id === id)
    setError(''); setShownRows(10); onDirtyChange(true)
    setEditor({ id, title: old?.title ?? '', courseName: old?.courseName ?? '', rows: old ? historyDrafts(old.intervals) : [{ start: '', end: '' }], expected: snapshot })
  }
  const preview = () => {
    if (!editor || readonly) return
    try {
      const intervals = historyIntervals(editor.rows)
      const action: FocusAction = { type: 'historySave', id: editor.id, title: editor.title, courseName: editor.courseName, intervals }
      // Validate the same domain rules before asking for confirmation; this does not persist anything.
      applyFocusAction(editor.expected, action, Date.now())
      setPending({ action, expected: editor.expected }); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const commit = async () => {
    if (!pending || locked.current || readonly) return
    locked.current = true
    try {
      const ok = await onAction(pending.action, pending.expected)
      if (!live.current) return
      setPending(null)
      if (ok) { setEditor(null); setSelected(null); setError(''); onDirtyChange(false) }
      else setError('未保存成功，请查看页面上方提示。草稿仍保留；若记录已更新，请取消后重新打开。')
    } catch (cause) {
      if (live.current) { setPending(null); setError(cause instanceof Error ? cause.message : String(cause)) }
    } finally { locked.current = false }
  }
  const updateRow = (index: number, key: 'start' | 'end', value: string) => {
    if (editor) setEditor({ ...editor, rows: editor.rows.map((row, i) => i === index ? { ...row, [key]: value } : row) })
  }
  const title = editor ? editor.id === undefined ? '补记学习' : '更正专注记录' : record ? '专注明细' : '专注记录'
  const source = record?.history?.kind === 'manual' ? '手动补记' : record?.history?.kind === 'corrected' ? '已手动更正' : record?.timer ? '番茄专注' : '计时记录'
  const pendingMinutes = pending?.action.type === 'historySave' ? pending.action.intervals.reduce((n, i) => n + Math.max(0, i.end - i.start), 0) : 0
  return <SectionCard title={title} subtitle="按真实学习时段统计，暂停间隙不计入；补记和更正会更新周目标与周报。">
    {snapshot.active ? <Text style={typography.caption}>当前有专注或休息尚未结束。可查看明细，结束后再补记和纠错。</Text> : null}
    {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
    {editor ? <>
      <AppTextField label="学习内容" value={editor.title} editable={!busy} onChangeText={title => setEditor({ ...editor, title })} />
      <AppTextField label="课程名称（选填）" value={editor.courseName} editable={!busy} onChangeText={courseName => setEditor({ ...editor, courseName })} />
      <Text style={typography.caption}>每段填写实际学习时间，休息留在段与段之间。未修改的时间保留原始秒数；修改后的时间精确到分钟。</Text>
      {editor.rows.slice(0, shownRows).map((row, i) => <View key={i} style={styles.row}>
        <WallClockField label={`第 ${i + 1} 段开始`} value={row.start} onChange={v => updateRow(i, 'start', v)} required disabled={readonly} identityKey={`${editor.id ?? 'new'}-${i}-start-${row.original?.start ?? ''}`} />
        <WallClockField label={`第 ${i + 1} 段结束`} value={row.end} onChange={v => updateRow(i, 'end', v)} required disabled={readonly} identityKey={`${editor.id ?? 'new'}-${i}-end-${row.original?.end ?? ''}`} />
        <AppButton label={`移除第 ${i + 1} 段`} variant="ghost" disabled={readonly} onPress={() => setEditor({ ...editor, rows: editor.rows.filter((_, index) => index !== i) })} />
      </View>)}
      {editor.rows.length > shownRows ? <AppButton label="展开更多时段" variant="secondary" onPress={() => setShownRows(shownRows + 10)} /> : null}
      <View style={styles.actions}>
        <AppButton label="增加学习时段" variant="secondary" disabled={readonly || editor.rows.length >= 2000} onPress={() => { setEditor({ ...editor, rows: [...editor.rows, { start: '', end: '' }] }); setShownRows(editor.rows.length + 1) }} />
        <AppButton label="核对并保存记录" disabled={readonly} onPress={preview} />
        <AppButton label="取消编辑" variant="ghost" disabled={busy} onPress={() => { setEditor(null); setPending(null); setError(''); onDirtyChange(false) }} />
      </View>
    </> : record ? <>
      <Text style={typography.section}>{record.title}</Text>
      <Text style={typography.bodySoft}>{record.courseName || '自由专注'} · {source}</Text>
      <Text style={typography.title}>{formatFocusDuration(focusDuration(record, Date.now()))}</Text>
      <Text style={typography.caption}>起止：{historyLabel(record.startedAt)} 至 {historyLabel(record.endedAt!)}（北京时间）</Text>
      {record.intervals.slice(0, shownRows).map((i, index) => <Text key={index} style={typography.bodySoft}>{index + 1}. {historyLabel(i.start)} → {historyLabel(i.end)} · {formatFocusDuration(i.end - i.start)}</Text>)}
      {record.intervals.length > shownRows ? <AppButton label="展开更多时段" variant="secondary" onPress={() => setShownRows(shownRows + 10)} /> : null}
      <View style={styles.actions}>
        <AppButton label="更正这条记录" variant="secondary" disabled={readonly} onPress={() => begin(record.id)} />
        <AppButton label="删除这条记录" variant="danger" disabled={readonly} onPress={() => { onDirtyChange(true); setPending({ action: { type: 'historyDelete', id: record.id }, expected: snapshot }) }} />
        <AppButton label="返回记录列表" variant="ghost" disabled={busy} onPress={() => { setSelected(null); setError('') }} />
      </View>
    </> : <>
      <AppButton label="补记学习时段" variant="secondary" disabled={readonly} onPress={() => begin()} />
      {snapshot.records.length ? snapshot.records.slice().reverse().slice(0, limit).map(r => <View style={styles.row} key={r.id}>
        <Text style={typography.section}>{r.title}</Text>
        <Text style={typography.caption}>{r.courseName || '自由专注'} · {historyWall(r.startedAt).replace('T', ' ')}（北京时间）{r.history ? r.history.kind === 'manual' ? ' · 手动补记' : ' · 已更正' : ''}</Text>
        <Text style={typography.section}>{formatFocusDuration(focusDuration(r, Date.now()))}</Text>
        <AppButton label="查看明细" accessibilityLabel={`查看${r.title}的专注明细`} variant="secondary" onPress={() => { setSelected(r.id); setShownRows(10); setError('') }} />
      </View>) : <Text style={typography.caption}>还没有专注记录。可以结束计时后保存，也可以补记漏计的学习。</Text>}
      {snapshot.records.length > limit ? <AppButton label="查看更多记录" variant="secondary" onPress={() => setLimit(limit + 20)} /> : null}
    </>}
    <ConfirmDialog visible={pending !== null} title={pending?.action.type === 'historyDelete' ? '删除这条专注记录？' : '确认保存学习记录？'} message={pending?.action.type === 'historyDelete' ? `将移除这条记录的 ${formatFocusDuration(record ? focusDuration(record, Date.now()) : 0)} 学习时长，周报和目标进度会随之减少。此操作不能直接撤销。` : `将按填写的有效时段保存，共 ${formatFocusDuration(pendingMinutes)}。补记或纠错会明确标注，周报和目标进度会重新计算。修改时段后以更正值为准，不再沿用原番茄钟的计划时长。`} confirmLabel={pending?.action.type === 'historyDelete' ? '确认删除记录' : '确认保存记录'} danger={pending?.action.type === 'historyDelete'} busy={busy} onConfirm={() => void commit()} onCancel={() => { if (!busy) { setPending(null); onDirtyChange(Boolean(editor)) } }} />
  </SectionCard>
}
const styles = StyleSheet.create({ row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 8 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }, error: { ...typography.caption, color: colors.clay } })
