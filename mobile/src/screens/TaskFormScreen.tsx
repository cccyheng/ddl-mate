/**
 * 任务新建 / 编辑表单（新建与编辑共用一套字段）。
 *
 * - 键盘感知：外层 `KeyboardAvoidingView` + 滚动容器 `keyboardShouldPersistTaps`
 *   （见 `ScreenScaffold`），正在输入的字段不会被键盘挡住；
 * - 截止时间：严格校验的北京时间输入，日期可单独保存（当天截止）、时间选填；
 *   **全部留空即未设置**，不自动补时间；
 * - 原始通知文本：可粘贴留档；**已有原文时该字段只读**（如需补充走详情页「追加原文」），
 *   仓库层也会明确拒绝覆盖，绝不静默丢弃用户输入；
 * - 表单只在打开时按任务 id 初始化**一次**：后台刷新不会覆盖用户未保存的输入；
 * - 保存期间禁用按钮，防止重复提交。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import { createImmediateSubmissionGuard } from '../domain/submissionGuard'
import { taskToDraft } from '../domain/taskDraft'
import type { SaveOutcome } from '../domain/taskRepository'
import {
  emptyTaskDraft,
  taskPriorityOptions,
  taskStatusOptions,
  taskTypeOptions,
  type TaskDraft,
} from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { WallClockField } from '../ui/datetimeField'
import { AppButton, AppTextField, EmptyState, LoadingState, OptionGroup, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { TimeAssistant } from '../ui/timeAssistant'
import { colors, spacing, typography } from '../ui/theme'
import type { TaskStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<TaskStackParamList>
type Route = RouteProp<TaskStackParamList, 'TaskForm'>

export function TaskFormScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const editingId = route.params?.id
  const isEditing = typeof editingId === 'number'
  const templateId = route.params?.templateId
  const isApplyingTemplate = !isEditing && typeof templateId === 'number'

  const [draft, setDraft] = useState<TaskDraft>(() => ({
    ...emptyTaskDraft(),
    ...(!isEditing && !isApplyingTemplate && route.params?.defaultType === 'EXAM' ? { type: 'EXAM' as const } : {}),
  }))
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 同步提交闸门：state 渲染前连续两次点击也只允许一次创建 / 更新。 */
  const submitGuardRef = useRef(createImmediateSubmissionGuard())
  /** 提交成功后到导航卸载之间，仍用 ref 拒绝任何迟到的重复提交。 */
  const submittedRef = useRef(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 已经为哪个任务做过表单初始化；`null` 表示还没填过。 */
  const hydratedFor = useRef<number | null>(null)
  const [hydrated, setHydrated] = useState(!isEditing && !isApplyingTemplate)
  /** 编辑对象是否已经在本机留存过原文（决定该字段是否只读）。 */
  const [hasStoredSource, setHasStoredSource] = useState(false)
  /** 模板应用只做**一次**；后续快照刷新不能覆盖用户正在编辑的草稿。 */
  const templateHydratedFor = useRef<number | null>(null)
  const templateRequestRef = useRef(0)
  const mountedRef = useRef(true)
  const appliedDraftRef = useRef<TaskDraft | null>(null)
  const [templateWarning, setTemplateWarning] = useState<string | null>(null)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const leaveConfirmedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const existing = useMemo(
    () => (isEditing ? (store.data.tasks.find((task) => task.id === editingId) ?? null) : null),
    [editingId, isEditing, store.data.tasks],
  )

  /**
   * 编辑模式：**只按任务 id 初始化一次**，不再依赖 `existing` / `originalTexts` 的引用。
   *
   * 之前的写法把这两个引用放进依赖数组，而后台每次刷新都会产生新引用，
   * 于是刷新一到就把用户**还没保存的输入**整份覆盖掉。
   * 现在用一个 ref 记住「已经为哪个 id 填过」，同一 id 不会二次覆盖。
   */
  useEffect(() => {
    if (!isEditing || typeof editingId !== 'number') return
    if (store.status !== 'ready') return
    if (hydratedFor.current === editingId) return
    const target = store.data.tasks.find((task) => task.id === editingId)
    if (!target) return
    const originalText = store.data.originalTexts.get(target.id) ?? ''
    setDraft(taskToDraft(target, originalText))
    setHasStoredSource(originalText.length > 0)
    hydratedFor.current = editingId
    setHydrated(true)
  }, [editingId, isEditing, store.data.originalTexts, store.data.tasks, store.status])

  /**
   * 应用模板：只按 templateId 初始化**一次**。
   *
   * 请求号 + 挂载标记保证：读取期间用户离开 / 换成另一个模板时，晚到的结果
   * 不会覆盖别的草稿；读取完成后后台刷新也不会再次覆盖用户正在改的内容。
   */
  useEffect(() => {
    if (!isApplyingTemplate || typeof templateId !== 'number') return
    if (store.status !== 'ready') return
    if (templateHydratedFor.current === templateId) return
    templateHydratedFor.current = templateId
    const requestId = templateRequestRef.current + 1
    templateRequestRef.current = requestId
    void store.taskTemplates.apply(templateId).then((result) => {
      if (!mountedRef.current || requestId !== templateRequestRef.current) return
      if (!result.ok || !result.draft) {
        setTemplateError(result.reason ?? '模板读不出来。')
        setHydrated(true)
        return
      }
      setDraft(result.draft)
      appliedDraftRef.current = result.draft
      setTemplateWarning(result.warnings.length > 0 ? result.warnings.join(' ') : null)
      setHydrated(true)
    })
  }, [isApplyingTemplate, store.status, templateId])

  const dirtyTemplateDraft =
    isApplyingTemplate &&
    hydrated &&
    !saving &&
    appliedDraftRef.current !== null &&
    JSON.stringify(draft) !== JSON.stringify(appliedDraftRef.current)

  usePreventRemove(dirtyTemplateDraft || (isApplyingTemplate && saving), ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (saving) return
    setPendingLeaveAction(data.action)
  })

  const confirmLeaveTemplateDraft = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  /**
   * 目标记录不存在。只有 store 已经 ready 时才敢断言「不存在」，
   * 否则会先闪一个「任务不存在」再被真正的数据打脸。
   */
  const missing = isEditing && store.status === 'ready' && hydratedFor.current !== editingId && !existing

  const courseOptions = useMemo(
    () => [
      { value: 0, label: '不关联课程' },
      ...store.data.courses.map((course) => ({ value: course.id, label: course.name })),
    ],
    [store.data.courses],
  )

  const update = useCallback(<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!prev[key as string]) return prev
      const next = { ...prev }
      delete next[key as string]
      return next
    })
  }, [])

  /**
   * 把仓库的写入结果翻译成用户能懂的一句话。
   *
   * 关键区分：**「没写进去」和「写了但列表读不回来」是两件事**。
   * 后者若说成「保存失败」，用户会再点一次保存 → 产生重复任务，
   * 所以这里明确说「已经保存好了，只需刷新」。
   */
  const reportSaveOutcome = useCallback(
    (outcome: SaveOutcome, label: string) => {
      if (outcome.committed && outcome.readbackError) {
        setToast({
          text: `已${label}到这台手机。列表需要重新读取一次才能看到最新内容，不用再保存一遍。`,
          tone: 'success',
        })
        return
      }
      setToast({ text: `已${label}到这台手机。`, tone: 'success' })
    },
    [],
  )

  const onSubmit = useCallback(async () => {
    if (submittedRef.current) return
    if (!submitGuardRef.current.tryEnter()) return
    setFormError(null)
    setSaving(true)
    try {
      if (isEditing && typeof editingId === 'number') {
        const outcome = await store.updateTask(editingId, draft)
        reportSaveOutcome(outcome, '保存')
        submittedRef.current = true
        leaveConfirmedRef.current = true
        navigation.goBack()
      } else {
        const outcome = await store.createTask(draft)
        reportSaveOutcome(outcome, '新建')
        // 用 outcome.id 跳转：即使提交后的读回失败，这个 id 也是**已经落库**的那条，
        // 不会因为读不回来就引导用户再点一次保存（那会产生重复任务）。
        submittedRef.current = true
        leaveConfirmedRef.current = true
        navigation.replace('TaskDetail', { id: outcome.id })
      }
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setFieldErrors(cause.fields)
        setFormError(cause.message)
      } else {
        setFormError(cause instanceof Error ? cause.message : '保存失败。')
      }
    } finally {
      submitGuardRef.current.release()
      setSaving(false)
    }
  }, [draft, editingId, isEditing, navigation, reportSaveOutcome, store])

  if ((isEditing || isApplyingTemplate) && !hydrated && !missing && !templateError) {
    return (
      <ScreenScaffold title={isApplyingTemplate ? '使用模板新建任务' : '编辑任务'} subtitle="正在读取本机数据…">
        <LoadingState message={isApplyingTemplate ? '正在读取模板内容…' : '正在读取这条任务…'} />
      </ScreenScaffold>
    )
  }

  if (templateError) {
    return (
      <ScreenScaffold title="模板读不出来" subtitle="没有创建任何任务">
        <EmptyState
          title="这个模板暂时不能用"
          description={templateError}
          actionLabel="返回"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  if (missing) {
    return (
      <ScreenScaffold title="找不到这条任务" subtitle="它可能已经被删除">
        <EmptyState
          title="这条任务不在本机了"
          description="它可能已经被删除。你可以返回列表，或新建一条任务。"
          actionLabel="返回任务列表"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  return (
    <>
      <ScreenScaffold
        title={isEditing ? '编辑任务' : isApplyingTemplate ? '使用模板新建任务' : '新建任务'}
        subtitle={
          isEditing
            ? '修改后立即保存在这台手机上'
            : isApplyingTemplate
              ? '模板只填入可复用内容；请确认后点「创建任务」，现在还没有写入任何任务'
              : '保存后立即存在这台手机上，不需要网络'
        }
      >
        {formError ? (
          <View style={styles.formError} accessibilityRole="alert">
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}

        {isApplyingTemplate ? (
          <SectionCard title="模板已填入草稿" subtitle="状态固定为待办；截止时间留空，需要你自己确认">
            <Text style={styles.templateNote}>
              模板不会复制完成状态、截止时间、原始通知、通知规则或截图。下面所有内容都可以修改，
              只有点「创建任务」才会真的写入本机。
            </Text>
            {templateWarning ? (
              <Text style={styles.templateWarning} accessibilityRole="alert">
                {templateWarning}
              </Text>
            ) : null}
          </SectionCard>
        ) : null}

        <SectionCard title="基本信息">
          <AppTextField
            label="标题"
            required
            value={draft.title}
            onChangeText={(text) => update('title', text)}
            placeholder="例如：数据结构第 3 次作业"
            error={fieldErrors.title ?? null}
            editable={!saving}
            maxLength={200}
            autoFocus={!isEditing && !isApplyingTemplate}
          />
          <AppTextField
            label="说明"
            value={draft.description}
            onChangeText={(text) => update('description', text)}
            placeholder="补充要求、范围、页码等"
            error={fieldErrors.description ?? null}
            editable={!saving}
            multiline
            maxLength={1000}
          />
        </SectionCard>

        <SectionCard
          title="截止时间"
          subtitle="按北京时间（Asia/Shanghai）用滚轮选择。日期可单独保存（当天截止），时间选填；全部留空表示未设置，不会替你补时刻。"
        >
          <WallClockField
            label="日期"
            value={draft.deadline}
            onChange={(value) => update('deadline', value)}
            error={fieldErrors.deadline ?? null}
            allowDateOnly
            showQuickFill
            disabled={saving}
            identityKey={`task:${editingId ?? 'new'}`}
          />
          {/* 数据没就绪时先不显示助手：避免在课表快照还没读到之前给出「没有匹配的课」。 */}
          {store.status === 'ready' ? (
            <TimeAssistant
              deadline={draft.deadline}
              courseId={draft.courseId}
              courses={store.data.courses}
              schedules={store.data.schedules}
              onAdoptDeadline={(value) => update('deadline', value)}
              disabled={saving}
            />
          ) : null}
        </SectionCard>

        <SectionCard title="分类与状态">
          <OptionGroup
            label="类型"
            options={taskTypeOptions}
            value={draft.type}
            onChange={(value) => update('type', value)}
            error={fieldErrors.type ?? null}
            disabled={saving}
          />
          <OptionGroup
            label="状态"
            options={taskStatusOptions}
            value={draft.status}
            onChange={(value) => update('status', value)}
            error={fieldErrors.status ?? null}
            disabled={saving}
          />
          <OptionGroup
            label="优先级"
            options={taskPriorityOptions}
            value={draft.priority}
            onChange={(value) => update('priority', value)}
            error={fieldErrors.priority ?? null}
            disabled={saving}
          />
          <OptionGroup label="所属课程" options={courseOptions} value={draft.courseId ?? 0} onChange={(value) => update('courseId', value === 0 ? null : value)} error={fieldErrors.courseId ?? null} disabled={saving} />
        </SectionCard>

        <SectionCard title="提交信息（可选）">
          <AppTextField
            label="提交要求"
            value={draft.submitRequirement}
            onChangeText={(text) => update('submitRequirement', text)}
            placeholder="例如：PDF 上传到教学网"
            error={fieldErrors.submitRequirement ?? null}
            editable={!saving}
            maxLength={500}
          />
          <AppTextField
            label="提交方式"
            value={draft.submitMethod}
            onChangeText={(text) => update('submitMethod', text)}
            placeholder="例如：教学网 / 邮箱 / 纸质交给助教"
            error={fieldErrors.submitMethod ?? null}
            editable={!saving}
            maxLength={128}
          />
          <AppTextField
            label="预计用时（分钟）"
            value={draft.estimatedMinutes}
            onChangeText={(text) => update('estimatedMinutes', text)}
            placeholder="留空表示未估算"
            keyboardType="number-pad"
            error={fieldErrors.estimatedMinutes ?? null}
            editable={!saving}
          />
        </SectionCard>

        <SectionCard
          title="原始通知 / 原始文本"
          subtitle={
            hasStoredSource
              ? '这条任务已经留存了原文，为避免误删只能查看；需要补充请到任务详情页追加'
              : '粘贴通知原文即可留档；保存后任务详情页随时能读回原文'
          }
        >
          <AppTextField
            label="原始文本"
            value={draft.originalText}
            onChangeText={(text) => update('originalText', text)}
            placeholder="例如：各位同学，第 3 次作业请在 10 月 15 日 22:00 前提交。"
            error={fieldErrors.originalText ?? null}
            // 已有留存原文时只读：否则用户在这里的修改会被仓库明确拒绝（不是静默丢弃）。
            editable={!saving && !hasStoredSource}
            multiline
            hint={
              hasStoredSource
                ? '已留存的原文不会被编辑覆盖。如需补充新的通知内容，请在任务详情页使用「追加原文」。'
                : '原文只是留档，不会自动解析出截止时间；时间仍由你确认后填写。'
            }
          />
        </SectionCard>

        <AppButton
          label={isEditing ? '保存修改' : '创建任务'}
          onPress={() => void onSubmit()}
          loading={saving}
          disabled={saving}
          accessibilityLabel={isEditing ? '保存任务修改' : '创建任务'}
        />
        <AppButton
          label="取消"
          onPress={() => navigation.goBack()}
          variant="secondary"
          disabled={saving}
          style={styles.cancel}
          accessibilityLabel="取消并返回"
        />
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingLeaveAction !== null}
        title="离开这个任务草稿？"
        message="模板填进来的内容有改动还没保存，离开后这些改动会丢失。"
        confirmLabel="放弃改动"
        cancelLabel="继续编辑"
        danger
        onConfirm={confirmLeaveTemplateDraft}
        onCancel={() => setPendingLeaveAction(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  muted: { ...typography.bodySoft, color: colors.textMuted, marginBottom: spacing.md },
  formError: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  templateNote: { ...typography.bodySoft, color: colors.text },
  templateWarning: { ...typography.bodySoft, color: colors.warn, marginTop: spacing.sm },
  submit: { marginTop: spacing.lg },
  cancel: { marginTop: spacing.md },
})
