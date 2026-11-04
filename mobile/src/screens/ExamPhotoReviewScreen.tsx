import React, { useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { examPhotoTaskDraft, parseExamPhotoText, MAX_EXAM_PHOTO_ROWS, type ExamPhotoRow } from '../domain/examPhoto'
import type { ExamPhotoImportResult } from '../domain/examPhotoRepository'
import { deadlineToShanghaiDateKey, shanghaiToday } from '../domain/datetime'
import type { SharedExamRoutes } from '../navigation/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, Badge, OptionGroup, SectionCard } from '../ui/components'
import { DateWheelSheet, ClockWheelSheet } from '../ui/timeWheel'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import { ExamPhotoSteps } from './ExamPhotoCaptureView'

type Nav = NativeStackNavigationProp<SharedExamRoutes>
export function ExamPhotoReviewScreen(): React.ReactElement {
  const store = useAppStore(), navigation = useNavigation<Nav>()
  const { params } = useRoute<RouteProp<SharedExamRoutes, 'ExamPhotoReview'>>()
  const [initial] = useState(() => {
    try { return { rows: parseExamPhotoText(params.sourceText), error: null } }
    catch (cause) { return { rows: [], error: String(cause) } }
  })
  const [rows, setRows] = useState<ExamPhotoRow[]>(initial.rows)
  const [error, setError] = useState<string | null>(initial.error)
  const [errorKey, setErrorKey] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<(ExamPhotoImportResult & { refreshError: string | null }) | null>(null)
  const [picker, setPicker] = useState<{ key: number; field: 'date' | 'start' | 'end' } | null>(null)
  const [expandedKey, setExpandedKey] = useState<number | null>(null)
  const [coursePickerKey, setCoursePickerKey] = useState<number | null>(null)
  const busy = useRef(false), committed = useRef(false), mounted = useRef(true)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const stale = params.generation !== store.notificationRouteGeneration
  const disabled = saving || !!outcome || stale
  const selected = rows.filter(row => row.selected)
  const incomplete = selected.filter(row => !row.title.trim() || !row.date || !row.start).length
  const today = shanghaiToday()
  usePreventRemove(!outcome && rows.length > 0, ({ data }) => {
    if (busy.current) { Alert.alert('正在导入', '请等导入结束后再离开。'); return }
    Alert.alert('离开核对？', '尚未导入的修改不会保存，原图仍在截图库。', [
      { text: '继续核对', style: 'cancel' },
      { text: '离开', style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ])
  })
  function edit(key: number, change: Partial<ExamPhotoRow>) {
    if (busy.current || committed.current || stale) return
    const next = rowsRef.current.map(row => row.key === key ? { ...row, ...change } : row)
    rowsRef.current = next; setRows(next); setError(null); setErrorKey(null)
  }
  function addRow() {
    if (busy.current || committed.current || stale || rowsRef.current.length >= MAX_EXAM_PHOTO_ROWS) return
    const key = Math.max(0, ...rowsRef.current.map(row => row.key)) + 1
    const next = [...rowsRef.current, { key, selected: true, title: '', date: '', start: '', end: '', location: '', seat: '', courseId: null, warning: '请对照原图填写。' }]
    rowsRef.current = next; setRows(next); setExpandedKey(key); setError(null); setErrorKey(null)
  }
  async function save() {
    if (busy.current || committed.current || stale) return
    busy.current = true; setSaving(true); setError(null); setErrorKey(null)
    try {
      const currentRows = rowsRef.current
      const checked = currentRows.filter(row => row.selected)
      if (!checked.length) throw new Error('请至少勾选一场考试。')
      for (const row of checked) {
        try { examPhotoTaskDraft(row, params.sourceText) }
        catch (cause) {
          setExpandedKey(row.key); setErrorKey(row.key)
          throw new Error(`第 ${row.key} 场：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      const result = await store.importExamPhoto({ ...params, rows: currentRows })
      committed.current = true
      if (mounted.current) setOutcome(result)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { busy.current = false; if (mounted.current) setSaving(false) }
  }
  function openOriginal() {
    const parent = navigation.getParent() as unknown as { navigate: (name: string, params: object) => void } | undefined
    parent?.navigate('Courses', { screen: 'PhotoLibrary', params: { focusAttemptId: params.attemptId }, initial: false })
  }
  const currentRow = rows.find(row => row.key === picker?.key)
  return <ScreenScaffold title="核对考试" subtitle="确认考试安排，选中后再导入。">
    <ExamPhotoSteps current={3} />
    <SectionCard style={styles.summaryCard}>
      <View style={styles.summaryHeading}>
        <View style={styles.summaryStat}><Text style={styles.summaryNumber}>{rows.length}</Text><Text style={styles.statLabel}>候选考试</Text></View>
        <View style={styles.summaryStat}><Text style={styles.summaryNumber}>{selected.length}</Text><Text style={styles.statLabel}>已选导入</Text></View>
        <View style={styles.summaryStat}><Text style={[styles.summaryNumber, incomplete > 0 && styles.attentionNumber]}>{incomplete}</Text><Text style={styles.statLabel}>已选待补信息</Text></View>
      </View>
      <Text style={styles.hint}>重点核对日期、时段和考场。点击卡片的“编辑”修改；过期考试默认不选。</Text>
      <AppButton label="查看原图" variant="secondary" compact onPress={openOriginal} disabled={saving} />
      {stale ? <Text style={styles.warning} accessibilityRole="alert">数据已恢复，请返回重新选择照片并核对。</Text> : null}
      {!rows.length ? <Text style={styles.warning}>未提取到考试卡片，可以返回修改识别文字，或在下方手动补充。</Text> : null}
      {error ? <View style={styles.warningBox} accessibilityRole="alert">
        <Text style={styles.warning}>{error}</Text>
        {errorKey !== null ? <Text style={styles.hint}>已展开第 {errorKey} 场，请向下查看并修改。</Text> : null}
      </View> : null}
      {!outcome ? <AppButton label={`导入已选 ${selected.length} 场考试`} disabled={disabled || !selected.length} loading={saving} onPress={() => { void save() }} /> : <>
        <Text style={styles.success}>已新增 {outcome.created.length} 场考试，{outcome.existing.length} 场已存在；原图已关联。</Text>
        {outcome.refreshError ? <Text style={styles.warning} accessibilityRole="alert">保存已成功，列表刷新失败，请刷新查看，无需再次导入。</Text> : null}
        {outcome.refreshError ? <AppButton label="刷新考试列表" onPress={() => { void store.refresh() }} /> : null}
        <AppButton label="返回考试与复习" onPress={() => navigation.navigate('Exams')} />
        {[...new Set([...outcome.created, ...outcome.existing])].map(id => <AppButton key={id}
          label={`查看考试：${store.data.tasks.find(task => task.id === id)?.title ?? `#${id}`}`}
          variant="secondary" onPress={() => navigation.navigate('TaskDetail', { id })} />)}
      </>}
    </SectionCard>
    {rows.map(row => {
      const expanded = expandedKey === row.key
      const past = !!row.date && row.date < today
      const duplicate = store.data.tasks.some(task => task.type === 'EXAM' && task.title === row.title.trim() && deadlineToShanghaiDateKey(task.deadline) === row.date)
      const course = store.data.courses.find(item => item.id === row.courseId)
      const needsFields = !row.title.trim() || !row.date
      const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date)
      return <SectionCard key={row.key} style={[styles.examCard, row.selected && styles.selectedCard]}>
        <View style={styles.cardHeading}>
          <View style={[styles.dateTile, !row.selected && styles.dateTileMuted]} accessible accessibilityLabel={row.date || '日期待补'}>
            <Text style={styles.dateMonth}>{dateParts ? `${Number(dateParts[2])} 月` : '日期'}</Text>
            <Text style={styles.dateDay}>{dateParts ? dateParts[3] : '—'}</Text>
            <Text style={styles.dateYear}>{dateParts ? dateParts[1] : '待补'}</Text>
          </View>
          <View style={styles.cardTitleBox}>
            <Text style={styles.eyebrow}>第 {row.key} 场 · {row.selected ? '已选导入' : '未选择'}</Text>
            <Text style={styles.cardTitle}>{row.title || '待填写考试名称'}</Text>
          </View>
          <Pressable onPress={() => edit(row.key, { selected: !row.selected })} disabled={disabled}
            accessibilityRole="checkbox" accessibilityState={{ checked: row.selected, disabled }}
            accessibilityLabel={`选择第 ${row.key} 场考试：${row.title || '未命名'}`} testID={`exam-select-${row.key}`}
            style={[styles.selection, row.selected && styles.selectionActive]}>
            <Text style={[styles.check, row.selected && styles.checkActive]}>{row.selected ? '✓' : '○'}</Text>
          </Pressable>
        </View>
        <View style={styles.badges}>
          {past ? <Badge text="日期已过" tone="muted" /> : null}
          {needsFields ? <Badge text="待补充" tone="warn" /> : null}
          {!row.start ? <Badge text="时刻未设置" tone="warn" /> : null}
        </View>
        <View style={styles.examDetails}>
          <View style={styles.metaRow}><Text style={styles.metaLabel}>时段</Text><Text style={styles.metaValue}>{row.start ? `${row.start}${row.end ? `–${row.end}` : ' 开始'}` : '仅日期 · 时间待补'}</Text></View>
          <View style={styles.metaRow}><Text style={styles.metaLabel}>考场</Text><Text style={styles.metaValue}>{row.location || '未填写'}</Text></View>
          <View style={styles.metaRow}><Text style={styles.metaLabel}>座位</Text><Text style={styles.metaValue}>{row.seat || '未填写'}</Text></View>
        </View>
        {course ? <Text style={styles.meta}>课程：{course.name}</Text> : null}
        {!row.start ? <Text style={styles.warning}>时间未设置，请对照原图补选；也可保留仅日期。</Text> : null}
        {needsFields ? <Text style={styles.warning}>请补全考试名称和日期后再导入。</Text> : null}
        {duplicate ? <Text style={styles.warning}>已有同名、同日考试，请核对时段；同名同开始时间不会重复创建。</Text> : null}
        {errorKey === row.key && error ? <Text style={styles.warning} accessibilityRole="alert">{error}</Text> : null}
        <AppButton label={expanded ? '收起编辑' : '编辑考试信息'} variant="ghost" compact
          testID={`exam-edit-${row.key}`} disabled={saving || !!outcome}
          onPress={() => setExpandedKey(expanded ? null : row.key)} accessibilityLabel={`${expanded ? '收起' : '编辑'}第 ${row.key} 场考试信息`} />
        {expanded ? <View style={styles.editor}>
          <AppTextField label="考试名称" value={row.title} maxLength={200} editable={!disabled} onChangeText={title => edit(row.key, { title })} />
          <View style={styles.fields}>
            <AppButton label={`考试日期：${row.date || '请选择'}`} variant="secondary" disabled={disabled} onPress={() => setPicker({ key: row.key, field: 'date' })} />
            <AppButton label={`开始时间：${row.start || '未设置'}`} variant="secondary" disabled={disabled} onPress={() => setPicker({ key: row.key, field: 'start' })} />
            <AppButton label={`结束时间：${row.end || '未设置'}`} variant="secondary" disabled={disabled} onPress={() => setPicker({ key: row.key, field: 'end' })} />
          </View>
          <AppTextField label="考试地点" value={row.location} maxLength={500} editable={!disabled} onChangeText={location => edit(row.key, { location })} />
          <AppTextField label="座位号" value={row.seat} maxLength={50} editable={!disabled} onChangeText={seat => edit(row.key, { seat })} />
          <AppButton label={coursePickerKey === row.key ? '收起课程选择' : `关联课程：${course?.name || '不关联'}`} variant="secondary"
            disabled={disabled} onPress={() => setCoursePickerKey(coursePickerKey === row.key ? null : row.key)} />
          {coursePickerKey === row.key ? <OptionGroup label="关联课程" options={[{ value: 0, label: '不关联' }, ...store.data.courses.map(item => ({ value: item.id, label: item.name }))]}
            value={row.courseId ?? 0} disabled={disabled} onChange={id => { edit(row.key, { courseId: id || null }); setCoursePickerKey(null) }} /> : null}
        </View> : null}
      </SectionCard>
    })}
    {!outcome ? <SectionCard>
      <AppButton label="补充一场未识别的考试" variant="secondary" disabled={disabled || rows.length >= MAX_EXAM_PHOTO_ROWS} onPress={addRow} />
      <Text style={styles.hint}>最多 {MAX_EXAM_PHOTO_ROWS} 场。原图会随导入的考试保存，可在任务原图和截图库查看。</Text>
      {rows.length > 1 ? <AppButton label={`导入已选 ${selected.length} 场考试`} disabled={disabled || !selected.length} loading={saving} onPress={() => { void save() }} /> : null}
    </SectionCard> : null}
    {picker && currentRow ? (picker.field === 'date' ? <DateWheelSheet value={currentRow.date} fallbackDateKey={shanghaiToday()} title="考试日期"
      onCancel={() => setPicker(null)} onConfirm={date => { edit(currentRow.key, { date }); setPicker(null) }} /> :
      <ClockWheelSheet value={currentRow[picker.field]} fallbackClock="08:00" title={picker.field === 'start' ? '考试开始时间' : '考试结束时间'}
        onCancel={() => setPicker(null)} onClear={() => { edit(currentRow.key, picker.field === 'start' ? { start: '', end: '' } : { end: '' }); setPicker(null) }}
        onConfirm={value => { edit(currentRow.key, { [picker.field]: value }); setPicker(null) }} />) : null}
  </ScreenScaffold>
}

const styles = StyleSheet.create({
  summaryCard: { backgroundColor: colors.primarySoft, borderColor: colors.primarySoft, borderRadius: 24 },
  summaryHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.sm },
  summaryStat: { flex: 1, minWidth: 0, alignItems: 'center', gap: spacing.xs },
  summaryNumber: { ...typography.display, color: colors.primary, fontVariant: ['tabular-nums'] },
  statLabel: { ...typography.caption, color: colors.primaryDark, textAlign: 'center' },
  attentionNumber: { color: colors.warn },
  examCard: { borderRadius: 24 },
  selectedCard: { borderColor: colors.primary, borderWidth: 1 },
  cardHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  dateTile: { minWidth: 62, flexShrink: 0, backgroundColor: colors.primarySoft, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, alignItems: 'center' },
  dateTileMuted: { backgroundColor: colors.surfaceMute },
  dateMonth: { ...typography.label, color: colors.primary },
  dateDay: { ...typography.display, color: colors.primary, fontVariant: ['tabular-nums'] },
  dateYear: { ...typography.caption },
  selection: { width: 44, minHeight: 44, flexShrink: 0, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  selectionActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  check: { ...typography.title, color: colors.textMuted }, checkActive: { color: colors.white },
  cardTitleBox: { flex: 1, minWidth: 0, gap: spacing.xs, paddingTop: spacing.xs }, eyebrow: { ...typography.caption }, cardTitle: { ...typography.section },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  examDetails: { borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.surfaceSoft },
  metaRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  metaLabel: { ...typography.caption, width: 36, flexShrink: 0, paddingTop: 2 },
  metaValue: { ...typography.body, flex: 1, minWidth: 0 },
  meta: { ...typography.bodySoft },
  fields: { gap: spacing.sm, marginVertical: spacing.sm },
  editor: { borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.md },
  hint: { ...typography.caption, color: colors.textMuted },
  warning: { ...typography.caption, color: colors.warn },
  warningBox: { backgroundColor: colors.warnSoft, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  success: { ...typography.body, color: colors.primary },
})
