/**
 * 任务模板新建 / 编辑（也负责“把这条任务存为模板”）。
 *
 * - 只保存用户勾选的可复用内容；截止时间 / 状态 / 完成时间 / 原文 / 通知 / 截图
 *   都不在模板里，界面也不提供这些字段；
 * - 空白预计用时保持空白，不补 0；
 * - 保存成功后明确显示“已写入本机”，若随后列表刷新失败会单独说明，不会让用户
 *   以为没保存而重复点一次；
 * - 有未保存改动时离开会先确认（与任务步骤 / 今日计划同一套 `usePreventRemove`）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import { createImmediateSubmissionGuard } from '../domain/submissionGuard'
import { taskPriorityOptions, taskTypeOptions, type Task } from '../domain/types'
import {
  emptyTemplateInput,
  TEMPLATE_FIELDS,
  TEMPLATE_FIELD_LABELS,
  type TaskTemplateInput,
  type TemplateField,
} from '../domain/taskTemplate'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, EmptyState, LoadingState, MultiOptionGroup, OptionGroup, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithTemplates } from '../navigation/types'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithTemplates>
type Route = RouteProp<SharedTaskRoutesWithTemplates, 'TaskTemplateForm'>

const FIELD_OPTIONS = TEMPLATE_FIELDS.map((value) => ({ value, label: TEMPLATE_FIELD_LABELS[value] }))

function templateInputFromTask(task: Task): TaskTemplateInput {
  const fields: TemplateField[] = []
  if (task.title.trim().length > 0) fields.push('title')
  if (task.description && task.description.trim().length > 0) fields.push('description')
  fields.push('type', 'priority')
  if (task.estimatedMinutes !== null) fields.push('estimatedMinutes')
  if (task.submitRequirement && task.submitRequirement.trim().length > 0) fields.push('submitRequirement')
  if (task.submitMethod && task.submitMethod.trim().length > 0) fields.push('submitMethod')
  if (task.courseId !== null) fields.push('courseId')

  const input = emptyTemplateInput()
  return {
    ...input,
    name: `${task.title.trim()}模板`.slice(0, 80),
    fields,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes === null ? '' : String(task.estimatedMinutes),
    submitRequirement: task.submitRequirement ?? '',
    submitMethod: task.submitMethod ?? '',
    courseId: task.courseId,
  }
}

function sameInput(left: TaskTemplateInput, right: TaskTemplateInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function TaskTemplateFormScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const editingId = route.params?.id
  const sourceTaskId = route.params?.sourceTaskId
  const isEditing = typeof editingId === 'number'
  const fromTask = typeof sourceTaskId === 'number'

  const [input, setInput] = useState<TaskTemplateInput>(() => emptyTemplateInput())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [hydrated, setHydrated] = useState(!isEditing && !fromTask)
  const [missing, setMissing] = useState(false)
  const [saved, setSaved] = useState<{ message: string; refreshError: string | null } | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const leaveConfirmedRef = useRef(false)
  /** 同步提交闸门：state 渲染前连续两次点击也只允许一次写入。 */
  const submitGuardRef = useRef(createImmediateSubmissionGuard())
  /** 成功后的终态也要用 ref 同步记住，避免 setState 尚未渲染时的第三次提交。 */
  const savedRef = useRef(false)
  const hydratedFor = useRef<string | null>(null)
  const baselineRef = useRef<TaskTemplateInput>(input)

  useEffect(() => {
    if (hydratedFor.current !== null) return
    if (store.status !== 'ready') return
    if (isEditing && typeof editingId === 'number') {
      const template = store.data.templates.find((row) => row.id === editingId)
      if (!template) {
        setMissing(true)
        setHydrated(true)
        hydratedFor.current = `missing:${editingId}`
        return
      }
      const next = {
        ...emptyTemplateInput(),
        name: template.name,
        fields: (['title', 'description', 'type', 'priority', 'estimatedMinutes', 'submitRequirement', 'submitMethod', 'courseId'] as TemplateField[]).filter(
          (field) => template[field] !== null,
        ),
        title: template.title ?? '',
        description: template.description ?? '',
        type: template.type ?? 'HOMEWORK',
        priority: template.priority ?? 3,
        estimatedMinutes: template.estimatedMinutes === null ? '' : String(template.estimatedMinutes),
        submitRequirement: template.submitRequirement ?? '',
        submitMethod: template.submitMethod ?? '',
        courseId: template.courseId,
      }
      setInput(next)
      baselineRef.current = next
      hydratedFor.current = `template:${editingId}`
      setHydrated(true)
      return
    }
    if (fromTask && typeof sourceTaskId === 'number') {
      const task = store.data.tasks.find((row) => row.id === sourceTaskId)
      if (!task) {
        setMissing(true)
        setHydrated(true)
        hydratedFor.current = `missing-task:${sourceTaskId}`
        return
      }
      const next = templateInputFromTask(task)
      setInput(next)
      baselineRef.current = next
      hydratedFor.current = `task:${sourceTaskId}`
      setHydrated(true)
    }
  }, [editingId, fromTask, isEditing, sourceTaskId, store.data.tasks, store.data.templates, store.status])

  const update = useCallback(<K extends keyof TaskTemplateInput>(key: K, value: TaskTemplateInput[K]) => {
    setInput((previous) => ({ ...previous, [key]: value }))
    setFormError(null)
    setFieldErrors((previous) => {
      if (!previous[key as string]) return previous
      const next = { ...previous }
      delete next[key as string]
      return next
    })
    setSaved(null)
  }, [])

  const dirty = hydrated && !missing && !saved && !sameInput(input, baselineRef.current)

  usePreventRemove(dirty || saving, ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (saving) return
    setPendingLeaveAction(data.action)
  })

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  const courseOptions = useMemo(
    () => [
      { value: 0, label: '不关联课程' },
      ...store.data.courses.map((course) => ({ value: course.id, label: course.name })),
    ],
    [store.data.courses],
  )

  const onSubmit = useCallback(async () => {
    if (saved || savedRef.current) return
    if (!submitGuardRef.current.tryEnter()) return
    setFormError(null)
    setSaving(true)
    try {
      const outcome = isEditing && typeof editingId === 'number'
        ? await store.taskTemplates.update(editingId, input)
        : fromTask && typeof sourceTaskId === 'number'
          ? await store.taskTemplates.saveFromTask(sourceTaskId, input)
          : await store.taskTemplates.create(input)
      baselineRef.current = input
      savedRef.current = true
      setSaved({
        message: `模板「${outcome.template.name}」已保存在这台手机上。`,
        refreshError: outcome.refreshError,
      })
      setToast({ text: '模板已保存。', tone: 'success' })
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setFieldErrors(cause.fields)
        setFormError(cause.message)
      } else {
        setFormError(cause instanceof Error ? cause.message : '保存模板失败。')
      }
    } finally {
      submitGuardRef.current.release()
      setSaving(false)
    }
  }, [editingId, fromTask, input, isEditing, saved, sourceTaskId, store])

  if (!hydrated) {
    return (
      <ScreenScaffold title="任务模板" subtitle="正在读取本机模板…">
        <LoadingState message="正在读取模板内容…" />
      </ScreenScaffold>
    )
  }

  if (missing) {
    return (
      <ScreenScaffold title="找不到要用的内容" subtitle="它可能已经被删除">
        <EmptyState
          title={fromTask ? '这条任务不在本机了' : '这个模板不在本机了'}
          description="删除后无法再保存为模板；请返回任务列表重新选择。"
          actionLabel="返回"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  const selected = new Set(input.fields)
  const title = isEditing ? '编辑模板' : fromTask ? '存为模板' : '新建模板'

  return (
    <>
      <ScreenScaffold
        title={title}
        subtitle="模板只保存你勾选的可复用内容；不会保存截止时间、完成状态、原始通知或截图"
      >
        {formError ? (
          <View style={styles.formError} accessibilityRole="alert">
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}

        {saved ? (
          <SectionCard title="已保存" subtitle="写入已经提交，不需要再点一次保存">
            <Text style={styles.savedText}>{saved.message}</Text>
            {saved.refreshError ? (
              <Text style={styles.warnText}>
                内容已经保存；只是模板列表这次没刷新出来：{saved.refreshError}
              </Text>
            ) : null}
            <AppButton label="返回" onPress={() => navigation.goBack()} variant="secondary" style={styles.gap} />
          </SectionCard>
        ) : (
          <>
            <SectionCard title="模板名称" subtitle="用于在列表里找到它">
              <AppTextField
                label="模板名称"
                required
                value={input.name}
                onChangeText={(value) => update('name', value)}
                placeholder="例如：实验报告模板"
                error={fieldErrors.name ?? null}
                editable={!saving}
                maxLength={80}
              />
            </SectionCard>

            <SectionCard title="保存哪些内容" subtitle="没勾选的项不会写入模板；应用后仍可在任务表单里修改">
              <MultiOptionGroup
                label="可复用内容"
                options={FIELD_OPTIONS}
                values={input.fields}
                onChange={(values) => update('fields', values)}
                error={fieldErrors.fields ?? null}
                disabled={saving}
              />
            </SectionCard>

            <SectionCard title="内容" subtitle="空白项保持空白，不会自动补默认值">
              {selected.has('title') ? (
                <AppTextField
                  label="标题"
                  required
                  value={input.title}
                  onChangeText={(value) => update('title', value)}
                  error={fieldErrors.title ?? null}
                  editable={!saving}
                  maxLength={200}
                />
              ) : null}
              {selected.has('description') ? (
                <AppTextField
                  label="说明"
                  value={input.description}
                  onChangeText={(value) => update('description', value)}
                  error={fieldErrors.description ?? null}
                  editable={!saving}
                  multiline
                  maxLength={1000}
                />
              ) : null}
              {selected.has('type') ? (
                <OptionGroup
                  label="类型"
                  options={taskTypeOptions}
                  value={input.type}
                  onChange={(value) => update('type', value)}
                  error={fieldErrors.type ?? null}
                  disabled={saving}
                />
              ) : null}
              {selected.has('priority') ? (
                <OptionGroup
                  label="优先级"
                  options={taskPriorityOptions}
                  value={input.priority}
                  onChange={(value) => update('priority', value)}
                  error={fieldErrors.priority ?? null}
                  disabled={saving}
                />
              ) : null}
              {selected.has('estimatedMinutes') ? (
                <AppTextField
                  label="预计用时（分钟）"
                  value={input.estimatedMinutes}
                  onChangeText={(value) => update('estimatedMinutes', value)}
                  placeholder="留空表示未估算"
                  keyboardType="number-pad"
                  error={fieldErrors.estimatedMinutes ?? null}
                  editable={!saving}
                  hint="留空会保持空白，不会补 0 或默认分钟。"
                />
              ) : null}
              {selected.has('submitRequirement') ? (
                <AppTextField
                  label="提交要求"
                  value={input.submitRequirement}
                  onChangeText={(value) => update('submitRequirement', value)}
                  error={fieldErrors.submitRequirement ?? null}
                  editable={!saving}
                  maxLength={500}
                />
              ) : null}
              {selected.has('submitMethod') ? (
                <AppTextField
                  label="提交方式"
                  value={input.submitMethod}
                  onChangeText={(value) => update('submitMethod', value)}
                  error={fieldErrors.submitMethod ?? null}
                  editable={!saving}
                  maxLength={128}
                />
              ) : null}
              {selected.has('courseId') ? (
                <OptionGroup
                  label="所属课程"
                  options={courseOptions}
                  value={input.courseId ?? 0}
                  onChange={(value) => update('courseId', value === 0 ? null : value)}
                  error={fieldErrors.courseId ?? null}
                  disabled={saving}
                />
              ) : null}
              {selected.size === 0 ? (
                <Text style={styles.muted}>请至少勾选一项要保存的内容。</Text>
              ) : null}
            </SectionCard>

            <AppButton
              label="保存模板"
              onPress={() => void onSubmit()}
              loading={saving}
              disabled={saving}
              accessibilityLabel="保存任务模板"
            />
            <AppButton
              label="取消"
              onPress={() => navigation.goBack()}
              variant="secondary"
              disabled={saving}
              style={styles.gap}
            />
          </>
        )}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingLeaveAction !== null}
        title="离开模板编辑？"
        message="还有改动没有保存，离开后这些改动会丢失。"
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
  formError: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  muted: { ...typography.caption, color: colors.textMuted },
  savedText: { ...typography.body },
  warnText: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  gap: { marginTop: spacing.md },
})
