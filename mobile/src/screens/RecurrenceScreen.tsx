/**
 * 重复任务规则 + 实际日期预览 + 显式批量创建。
 *
 * 本版本刻意**没有后台定时任务**：应用关闭时不会自动生成任何任务。
 * 用户必须先看到“实际日期 / 实际任务”的预览，再点「按规则批量创建」；
 * 全部规则 + 任务 + 账本在一个 SQLite 事务里写入。
 *
 * 去重身份是 `(规则ID, 日期)`：
 * - 同一份确认预览重放会被事务内的 `nextRuleId` 令牌 / 指纹拒绝；
 * - 已创建过的日期显示“已创建”；用户删掉某次任务后显示“已删除（不会重建）”。
 */

import React, { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import { createImmediateSubmissionGuard } from '../domain/submissionGuard'
import {
  RECURRENCE_CADENCE_LABELS,
  RECURRENCE_LIMITS,
  ruleInputFromTemplate,
  weekdaysLabel,
  type RecurrenceOccurrencePreview,
  type RecurrencePreviewResult,
  type RecurrenceRule,
  type RecurrenceRuleInput,
} from '../domain/recurrence'
import { weekdayName, weekdayOptions } from '../domain/datetime'
import { taskPriorityOptions, taskTypeOptions } from '../domain/types'
import { StalePreviewError } from '../domain/taskTemplateRepository'
import { useAppStore } from '../store/AppStore'
import {
  AppButton,
  AppTextField,
  EmptyState,
  MultiOptionGroup,
  OptionGroup,
  RefreshErrorBanner,
  SectionCard,
} from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import {
  DateWheelSheet,
  suggestedTodayDateKey,
  TimeWheelField,
  WallClockPickerButton,
} from '../ui/timeWheel'
import { colors, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithTemplates } from '../navigation/types'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithTemplates>

function emptyRuleInput(): RecurrenceRuleInput {
  return {
    name: '',
    templateId: null,
    title: '',
    description: '',
    type: 'HOMEWORK',
    priority: 3,
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    courseId: null,
    cadence: 'DAILY',
    weekdays: [],
    startDate: '',
    endDate: '',
    time: '',
  }
}

function ruleToInput(rule: RecurrenceRule): RecurrenceRuleInput {
  return {
    name: rule.name,
    templateId: rule.templateId,
    title: rule.title,
    description: rule.description ?? '',
    type: rule.type,
    priority: rule.priority,
    estimatedMinutes: rule.estimatedMinutes === null ? '' : String(rule.estimatedMinutes),
    submitRequirement: rule.submitRequirement ?? '',
    submitMethod: rule.submitMethod ?? '',
    courseId: rule.courseId,
    cadence: rule.cadence,
    weekdays: [...rule.weekdays],
    startDate: rule.startDate,
    endDate: rule.endDate,
    time: rule.time ?? '',
  }
}

function sameInput(left: RecurrenceRuleInput, right: RecurrenceRuleInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function withFieldDetails(message: string, fields: Record<string, string> | undefined): string {
  const details = Object.values(fields ?? {})
    .filter((value) => value.trim().length > 0)
    .join(' ')
  return details.length > 0 ? `${message} ${details}` : message
}

/** 只到自然日的滚轮字段（重复规则不把开始/结束日期和时间混在一起）。 */
function DateOnlyWheelField({
  label,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | null
  disabled?: boolean
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const hasValue = /^\d{4}-\d{2}-\d{2}$/.test(value)
  return (
    <>
      <WallClockPickerButton
        label={label}
        value={hasValue ? value : ''}
        placeholder="点按选择日期"
        onPress={() => setOpen(true)}
        error={error}
        disabled={disabled}
        accessibilityLabel={label}
        accessibilityHint="打开年 / 月 / 日滚轮，按北京时间选择自然日"
      />
      {open ? (
        <DateWheelSheet
          value={value}
          fallbackDateKey={suggestedTodayDateKey()}
          title={label}
          subtitle="只选自然日（北京时间）；时刻在下面单独选择，可留空"
          disabled={disabled}
          clearLabel={hasValue ? '清除日期' : undefined}
          onCancel={() => setOpen(false)}
          onConfirm={(dateKey) => {
            onChange(dateKey)
            setOpen(false)
          }}
          onClear={
            hasValue
              ? () => {
                  onChange('')
                  setOpen(false)
                }
              : undefined
          }
          testID="recurrence-date-wheel"
        />
      ) : null}
    </>
  )
}

const STATUS_LABELS: Record<RecurrenceOccurrencePreview['status'], string> = {
  AVAILABLE: '可创建',
  CREATED: '已创建',
  DELETED: '已删除（不会重建）',
  SKIPPED: '已跳过',
}

function statusTone(status: RecurrenceOccurrencePreview['status']): string {
  if (status === 'AVAILABLE') return colors.primaryDark
  if (status === 'CREATED') return colors.warn
  if (status === 'DELETED') return colors.clayDark
  return colors.textMuted
}

export function RecurrenceScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null)
  const [input, setInput] = useState<RecurrenceRuleInput>(() => emptyRuleInput())
  const baselineRef = React.useRef<RecurrenceRuleInput>(emptyRuleInput())
  const [preview, setPreview] = useState<RecurrencePreviewResult | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [confirmGenerate, setConfirmGenerate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<RecurrenceRule | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const [pendingDiscardEditor, setPendingDiscardEditor] = useState(false)
  const leaveConfirmedRef = React.useRef(false)
  /** 同步生成闸门：state 渲染前连续两次确认也只允许一次事务。 */
  const generateGuardRef = React.useRef(createImmediateSubmissionGuard())
  /** 成功后到编辑器关闭渲染之间，拒绝迟到的重复提交（避免多一次 stale 错误）。 */
  const generateSucceededRef = React.useRef(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const dirty = editorOpen && !generating && !sameInput(input, baselineRef.current)
  usePreventRemove(dirty || generating, ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (generating) return
    setPendingLeaveAction(data.action)
  })

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  const startEditor = useCallback((rule: RecurrenceRule | null) => {
    const next = rule ? ruleToInput(rule) : emptyRuleInput()
    generateSucceededRef.current = false
    setInput(next)
    baselineRef.current = next
    setEditingRuleId(rule?.id ?? null)
    setPreview(null)
    setFormError(null)
    setEditorOpen(true)
  }, [])

  const closeEditor = useCallback(() => {
    setEditorOpen(false)
    setEditingRuleId(null)
    setPreview(null)
    setFormError(null)
    setInput(emptyRuleInput())
    baselineRef.current = emptyRuleInput()
  }, [])

  const requestCloseEditor = useCallback(() => {
    if (dirty) setPendingDiscardEditor(true)
    else closeEditor()
  }, [closeEditor, dirty])

  const update = useCallback(<K extends keyof RecurrenceRuleInput>(key: K, value: RecurrenceRuleInput[K]) => {
    setInput((previous) => ({ ...previous, [key]: value }))
    // 任何改动都让旧预览失效：必须重新预览，生成令牌也随新预览更新。
    setPreview(null)
    setFormError(null)
  }, [])

  const applyTemplate = useCallback(
    (templateId: number) => {
      const template = store.data.templates.find((row) => row.id === templateId)
      if (!template) return
      const applied = ruleInputFromTemplate(input, template)
      setInput(applied.input)
      setPreview(null)
      setFormError(
        applied.warnings.length > 0 ? applied.warnings.join(' ') : null,
      )
    },
    [input, store.data.templates],
  )

  const onPreview = useCallback(() => {
    setFormError(null)
    const result = store.taskTemplates.preview(input, editingRuleId)
    setPreview(result)
    if (!result.ok) setFormError(withFieldDetails(result.reason, result.fields))
  }, [editingRuleId, input, store])

  const onGenerate = useCallback(async () => {
    if (!preview || !preview.ok) return
    if (generateSucceededRef.current) return
    if (!generateGuardRef.current.tryEnter()) return
    setConfirmGenerate(false)
    setGenerating(true)
    setFormError(null)
    try {
      const outcome = await store.taskTemplates.generate(input, {
        ruleId: editingRuleId,
        expectedFingerprint: preview.fingerprint,
      })
      generateSucceededRef.current = true
      const skipped = outcome.skippedExisting + outcome.skippedDeleted + outcome.skippedExplicit
      const base =
        outcome.created > 0
          ? `已创建 ${outcome.created} 条任务`
          : '规则内容已保存，没有创建新任务'
      const skippedText =
        skipped > 0 ? `；跳过 ${skipped} 条已有记录（已创建 / 已删除 / 已跳过）` : ''
      const message = `${base}${skippedText}。`
      setToast({
        text: outcome.refreshError
          ? `${message} ${
              outcome.created > 0 ? '任务已写入' : '规则已保存'
            }，但列表刷新失败：${outcome.refreshError}`
          : message,
        tone: 'success',
      })
      closeEditor()
    } catch (cause) {
      if (cause instanceof StalePreviewError) {
        setPreview(null)
        setFormError('预览之后规则、模板或课程发生了变化；请重新预览并确认。')
      } else if (cause instanceof ValidationError) {
        setFormError(withFieldDetails(cause.message, cause.fields))
      } else {
        setFormError(cause instanceof Error ? cause.message : '批量创建失败。')
      }
    } finally {
      generateGuardRef.current.release()
      setGenerating(false)
    }
  }, [closeEditor, editingRuleId, input, preview, store])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return
    const target = pendingDelete
    setDeleting(true)
    try {
      await store.taskTemplates.removeRule(target.id)
      setToast({ text: `已删除规则「${target.name}」；它创建过的任务都还在。`, tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除规则失败。', tone: 'error' })
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }, [deleting, pendingDelete, store])

  const courseOptions = React.useMemo(
    () => [
      { value: 0, label: '不关联课程' },
      ...store.data.courses.map((course) => ({ value: course.id, label: course.name })),
    ],
    [store.data.courses],
  )

  const taskIds = React.useMemo(() => new Set(store.data.tasks.map((task) => task.id)), [store.data.tasks])
  const rules = store.data.recurrenceRules
  /** 已全部创建 / 已删除，当前只能保存规则本身，不创建任务。 */
  const confirmingSaveOnly = preview !== null && preview.ok && preview.availableCount === 0

  return (
    <>
      <ScreenScaffold
        title="重复任务"
        subtitle="先预览实际日期，再按规则批量创建；应用关闭后不会自动生成任务"
        headerAccessory={
          !editorOpen ? (
            <AppButton label="新建规则" onPress={() => startEditor(null)} compact accessibilityLabel="新建重复任务规则" />
          ) : undefined
        }
      >
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}
        {store.templateStoreError ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>{store.templateStoreError}</Text>
          </View>
        ) : null}

        {!editorOpen ? (
          <>
            <SectionCard title="怎么工作" subtitle="本版本只做用户确认后的有限批量创建">
              <Text style={styles.muted}>
                规则会按你选的开始 / 结束日期（首尾都算）和每天 / 每周周几，先列出实际日期与任务。
                只有你点「按规则批量创建」后才会写入本机；每条都是独立任务，初始为待办、提醒关闭。
              </Text>
              <Text style={styles.muted}>
                已创建过的日期会被记住：重复点按不会重复创建；你删掉某次任务后，再生成也不会悄悄补回来。
              </Text>
            </SectionCard>

            {rules.length === 0 ? (
              <EmptyState
                title="还没有重复任务规则"
                description="点击右上角「新建规则」，先选日期范围与频率，再预览实际任务。"
                actionLabel="新建规则"
                onAction={() => startEditor(null)}
              />
            ) : (
              rules.map((rule) => {
                const entries = store.data.recurrenceLedger.filter((entry) => entry.ruleId === rule.id)
                const created = entries.filter(
                  (entry) => entry.status === 'CREATED' && entry.taskId !== null && taskIds.has(entry.taskId),
                ).length
                const deleted = entries.filter(
                  (entry) => entry.status === 'CREATED' && (entry.taskId === null || !taskIds.has(entry.taskId)),
                ).length
                return (
                  <SectionCard
                    key={rule.id}
                    title={rule.name}
                    subtitle={`${RECURRENCE_CADENCE_LABELS[rule.cadence]} · ${rule.startDate} 至 ${rule.endDate}${
                      rule.time ? ` · ${rule.time}` : ' · 当天截止（未填时刻）'
                    }`}
                  >
                    <Text style={styles.contentText}>{rule.title}</Text>
                    {rule.cadence === 'WEEKLY' ? (
                      <Text style={styles.muted}>每周：{weekdaysLabel(rule.weekdays)}</Text>
                    ) : null}
                    <Text style={styles.muted}>
                      已创建且仍在：{created} 条
                      {deleted > 0 ? ` · 已删除：${deleted} 条（不会重建）` : ''}
                      {rule.estimatedMinutes === null ? '' : ` · 预计 ${rule.estimatedMinutes} 分钟`}
                    </Text>
                    <View style={styles.actions}>
                      <AppButton
                        label="编辑规则"
                        onPress={() => startEditor(rule)}
                        compact
                        accessibilityLabel={`编辑重复规则「${rule.name}」`}
                      />
                      <AppButton
                        label="删除规则"
                        onPress={() => setPendingDelete(rule)}
                        variant="danger"
                        compact
                        accessibilityLabel={`删除重复规则「${rule.name}」`}
                      />
                    </View>
                  </SectionCard>
                )
              })
            )}
          </>
        ) : (
          <>
            {formError ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{formError}</Text>
              </View>
            ) : null}

            <SectionCard title="规则名称" subtitle="只用于你自己识别这条规则">
              <AppTextField
                label="规则名称"
                required
                value={input.name}
                onChangeText={(value) => update('name', value)}
                placeholder="例如：每周三实验报告"
                editable={!generating}
                maxLength={RECURRENCE_LIMITS.maxNameLength}
              />
            </SectionCard>

            <SectionCard title="从模板填入内容（可选）" subtitle="点一下才会填入；之后仍可逐项修改">
              {store.data.templates.length === 0 ? (
                <>
                  <Text style={styles.muted}>还没有模板。可以先去「任务模板」新建，或直接在下面填写任务内容。</Text>
                  <AppButton
                    label="打开任务模板"
                    onPress={() => navigation.navigate('TaskTemplateList')}
                    variant="secondary"
                    compact
                    disabled={generating}
                    accessibilityLabel="打开任务模板列表"
                  />
                </>
              ) : (
                <View style={styles.templateRow}>
                  {store.data.templates.map((template) => (
                    <AppButton
                      key={template.id}
                      label={`用「${template.name}」填入`}
                      onPress={() => applyTemplate(template.id)}
                      variant="secondary"
                      compact
                      disabled={generating}
                      accessibilityLabel={`用模板「${template.name}」填入规则内容`}
                    />
                  ))}
                </View>
              )}
              {input.templateId !== null ? (
                <Text style={styles.muted}>
                  来源模板：{store.data.templates.find((row) => row.id === input.templateId)?.name ?? '已删除'}。
                  规则内容已是快照，编辑模板不会改写已有规则 / 任务。
                </Text>
              ) : null}
            </SectionCard>

            <SectionCard title="任务内容" subtitle="每条生成的任务都使用这份内容，之后可以单独编辑">
              <AppTextField
                label="任务标题"
                required
                value={input.title}
                onChangeText={(value) => update('title', value)}
                editable={!generating}
                maxLength={200}
              />
              <AppTextField
                label="说明"
                value={input.description}
                onChangeText={(value) => update('description', value)}
                editable={!generating}
                multiline
                maxLength={1000}
              />
              <OptionGroup
                label="类型"
                options={taskTypeOptions}
                value={input.type}
                onChange={(value) => update('type', value)}
                disabled={generating}
              />
              <OptionGroup
                label="优先级"
                options={taskPriorityOptions}
                value={input.priority}
                onChange={(value) => update('priority', value)}
                disabled={generating}
              />
              <OptionGroup
                label="所属课程"
                options={courseOptions}
                value={input.courseId ?? 0}
                onChange={(value) => update('courseId', value === 0 ? null : value)}
                disabled={generating}
              />
              <AppTextField
                label="预计用时（分钟）"
                value={input.estimatedMinutes}
                onChangeText={(value) => update('estimatedMinutes', value)}
                keyboardType="number-pad"
                placeholder="留空表示未估算"
                editable={!generating}
                hint="留空会保持空白，不会补默认分钟。"
              />
              <AppTextField
                label="提交要求"
                value={input.submitRequirement}
                onChangeText={(value) => update('submitRequirement', value)}
                editable={!generating}
                maxLength={500}
              />
              <AppTextField
                label="提交方式"
                value={input.submitMethod}
                onChangeText={(value) => update('submitMethod', value)}
                editable={!generating}
                maxLength={128}
              />
            </SectionCard>

            <SectionCard
              title="频率与日期"
              subtitle={`日期首尾都包含；一次最多 ${RECURRENCE_LIMITS.maxRangeDays} 天，请按实际需要选择，不会猜学期或年份`}
            >
              <OptionGroup
                label="频率"
                options={[
                  { value: 'DAILY' as const, label: '每天' },
                  { value: 'WEEKLY' as const, label: '每周' },
                ]}
                value={input.cadence}
                onChange={(value) => update('cadence', value)}
                disabled={generating}
              />
              {input.cadence === 'WEEKLY' ? (
                <MultiOptionGroup
                  label="每周哪几天（可多选）"
                  options={weekdayOptions}
                  values={input.weekdays}
                  onChange={(values) => update('weekdays', values)}
                  disabled={generating}
                  hint={input.weekdays.length === 0 ? '请至少选择一个周几。' : `已选：${weekdaysLabel(input.weekdays)}`}
                />
              ) : null}
              <DateOnlyWheelField
                label="开始日期"
                value={input.startDate}
                onChange={(value) => update('startDate', value)}
                disabled={generating}
              />
              <DateOnlyWheelField
                label="结束日期"
                value={input.endDate}
                onChange={(value) => update('endDate', value)}
                disabled={generating}
              />
              <TimeWheelField
                label="截止时间（可选）"
                value={input.time}
                onChange={(value) => update('time', value)}
                disabled={generating}
                placeholder="留空 = 当天截止"
                hint="留空时每条任务的截止时间只记到日期（当天结束前），不会强补 23:59 或 00:00。"
              />
            </SectionCard>

            <AppButton
              label="预览实际日期与任务"
              onPress={onPreview}
              disabled={generating}
              accessibilityLabel="预览重复任务的实际日期与任务"
              accessibilityHint="只读预览，不会写入任何任务"
            />

            {preview ? (
              <SectionCard title="预览结果" subtitle="这一步还没有写入任何任务">
                {!preview.ok ? (
                  <Text style={styles.errorText}>{withFieldDetails(preview.reason, preview.fields)}</Text>
                ) : (
                  <>
                    <Text style={styles.previewSummary}>
                      {preview.rule.startDate} 至 {preview.rule.endDate} · 共 {preview.occurrences.length} 个日期 ·{' '}
                      {preview.availableCount} 条可创建
                      {preview.createdCount > 0 ? ` · 仍存在的已创建记录 ${preview.createdCount} 条` : ''}
                      {preview.deletedCount > 0 ? ` · 已删除 ${preview.deletedCount} 条（不会重建）` : ''}
                      {preview.skippedCount > 0 ? ` · 已跳过 ${preview.skippedCount} 条` : ''}
                    </Text>
                    {preview.rule.time ? (
                      <Text style={styles.muted}>每条任务的截止时间：日期 + {preview.rule.time}（北京时间）</Text>
                    ) : (
                      <Text style={styles.muted}>未填时刻：每条任务的截止时间只记到日期，当天结束前都算未逾期。</Text>
                    )}
                    {preview.blockedReason ? (
                      <Text style={styles.errorText}>{preview.blockedReason}</Text>
                    ) : null}
                    {preview.warnings.map((warning) => (
                      <Text key={warning} style={styles.warnText}>
                        {warning}
                      </Text>
                    ))}
                    <View style={styles.occurrenceList}>
                      {preview.occurrences.map((occurrence) => (
                        <View key={occurrence.date} style={styles.occurrenceRow}>
                          <Text style={styles.occurrenceDate}>
                            {occurrence.date} {weekdayName(occurrence.weekday)}
                          </Text>
                          <Text style={[styles.occurrenceStatus, { color: statusTone(occurrence.status) }]}>
                            {STATUS_LABELS[occurrence.status]}
                            {occurrence.taskId === null ? '' : ` #${occurrence.taskId}`}
                          </Text>
                        </View>
                      ))}
                    </View>
                    {preview.availableCount > 0 && !preview.blockedReason ? (
                      <AppButton
                        label={`按规则批量创建 ${preview.availableCount} 条任务`}
                        onPress={() => setConfirmGenerate(true)}
                        disabled={generating}
                        loading={generating}
                        style={styles.gap}
                        accessibilityLabel={`按规则批量创建 ${preview.availableCount} 条任务`}
                        accessibilityHint="会创建一个规则、相应任务和已创建记录；重复点按不会重复创建"
                      />
                    ) : editingRuleId !== null && !preview.blockedReason ? (
                      <AppButton
                        label="只保存规则（创建 0 条任务）"
                        onPress={() => setConfirmGenerate(true)}
                        disabled={generating}
                        loading={generating}
                        variant="secondary"
                        style={styles.gap}
                        accessibilityLabel="只保存规则修改，不创建新任务"
                        accessibilityHint="保存规则名称和任务内容；已有任务不会被修改，已删除的日期不会重建"
                      />
                    ) : (
                      <Text style={styles.muted}>
                        {preview.blockedReason
                          ? '请先按上面的提示修正课程，再重新预览。'
                          : '这些日期都已创建 / 已删除 / 已跳过，没有需要新建的任务。'}
                      </Text>
                    )}
                  </>
                )}
              </SectionCard>
            ) : null}

            <AppButton
              label="取消编辑"
              onPress={requestCloseEditor}
              variant="secondary"
              disabled={generating}
              style={styles.gap}
            />
          </>
        )}
      </ScreenScaffold>

      <ConfirmDialog
        visible={confirmGenerate}
        title={confirmingSaveOnly ? '只保存规则修改？' : '按规则批量创建任务？'}
        message={
          preview && preview.ok
            ? confirmingSaveOnly
              ? '这次不会创建任何任务，只保存规则名称 / 任务内容。已有任务不会被修改，已删除的日期仍不会重建。'
              : `会创建 ${preview.availableCount} 条独立任务（初始为待办，提醒关闭），并保存这条规则与已创建记录。`
            : ''
        }
        details={
          confirmingSaveOnly
            ? [
                '规则内容会保存；创建任务数是 0。',
                '已有任务逐条保持不变；已删除的日期不会因为保存规则而重建。',
              ]
            : [
                '同一份预览重复提交不会重复创建；已创建 / 已删除的日期会按已有记录跳过。',
                '应用关闭后不会自动生成任何任务；以后需要更多，请重新预览并再次确认。',
              ]
        }
        confirmLabel={confirmingSaveOnly ? '保存规则' : '批量创建'}
        busy={generating}
        onConfirm={() => void onGenerate()}
        onCancel={() => setConfirmGenerate(false)}
      />

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="删除这条重复规则？"
        message={`规则「${pendingDelete?.name ?? ''}」和它的已创建记录会从本机删除。`}
        details={[
          '已经创建的任务不会被删除。',
          '删除后如果再想要相同规则，需要新建一条规则并重新确认预览。',
        ]}
        confirmLabel="删除规则"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        visible={pendingDiscardEditor}
        title="放弃这次规则编辑？"
        message="还有改动没有保存 / 没有批量创建。"
        confirmLabel="放弃改动"
        cancelLabel="继续编辑"
        danger
        onConfirm={() => {
          setPendingDiscardEditor(false)
          closeEditor()
        }}
        onCancel={() => setPendingDiscardEditor(false)}
      />

      <ConfirmDialog
        visible={pendingLeaveAction !== null}
        title="离开重复任务？"
        message="还有改动没有保存 / 没有批量创建，离开后这些改动会丢失。"
        confirmLabel="放弃改动"
        cancelLabel="继续编辑"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeaveAction(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  muted: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  contentText: { ...typography.body },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  templateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  errorBox: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: { ...typography.bodySoft, color: colors.clayDark, marginTop: spacing.xs },
  warnText: { ...typography.caption, color: colors.warn, marginTop: spacing.xs },
  previewSummary: { ...typography.bodySoft, marginBottom: spacing.xs },
  occurrenceList: { marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  occurrenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 36,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 4,
  },
  occurrenceDate: { ...typography.bodySoft },
  occurrenceStatus: { ...typography.caption, fontWeight: '600' },
  gap: { marginTop: spacing.md },
})
