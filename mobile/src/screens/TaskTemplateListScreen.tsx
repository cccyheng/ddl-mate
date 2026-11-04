/**
 * 任务模板列表。
 *
 * 入口：任务列表 / 今天 / 任务详情。
 * - 每个模板只展示它真正保存了的可复用字段；
 * - “使用模板”会打开 TaskForm 的可编辑草稿，必须由用户显式保存，绝不直接建任务；
 * - 删除模板前二次确认，并明确说明已有任务不会被删除。
 */

import React, { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import {
  TEMPLATE_FIELD_LABELS,
  templateFieldsOf,
  type TaskTemplate,
} from '../domain/taskTemplate'
import { useAppStore } from '../store/AppStore'
import { AppButton, Badge, EmptyState, RefreshErrorBanner, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithTemplates } from '../navigation/types'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithTemplates>

function templateSummary(template: TaskTemplate): string {
  const fields = templateFieldsOf(template)
  if (fields.length === 0) return '没有可复用内容'
  return fields.map((field) => TEMPLATE_FIELD_LABELS[field]).join('、')
}

export function TaskTemplateListScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const [pendingDelete, setPendingDelete] = useState<TaskTemplate | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || deleting) return
    const target = pendingDelete
    setDeleting(true)
    try {
      await store.taskTemplates.remove(target.id)
      setToast({ text: `已删除模板「${target.name}」；用它创建过的任务都还在。`, tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除模板失败。', tone: 'error' })
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }, [deleting, pendingDelete, store])

  const templates = store.data.templates

  return (
    <>
      <ScreenScaffold
        title="任务模板"
        subtitle="保存可复用的任务内容；应用后先生成可编辑草稿，确认后才创建任务"
        headerAccessory={
          <AppButton
            label="新建"
            onPress={() => navigation.navigate('TaskTemplateForm', {})}
            compact
            accessibilityLabel="新建任务模板"
          />
        }
      >
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}
        {store.templateStoreError ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorText}>{store.templateStoreError}</Text>
            <Text style={styles.muted}>为避免覆盖坏数据，模板写入已暂停；请先处理这条错误。</Text>
          </View>
        ) : null}

        <SectionCard
          title="重复任务规则"
          subtitle="先预览实际日期与任务，再按规则批量创建；本版本不会在应用关闭后自动生成"
        >
          <AppButton
            label="打开重复任务规则"
            onPress={() => navigation.navigate('Recurrence')}
            variant="secondary"
            accessibilityLabel="打开重复任务规则"
            accessibilityHint="每天或每周多选周几，先预览实际日期，再显式批量创建"
          />
        </SectionCard>

        <Text style={styles.hint}>
          模板只保存你勾选的内容；截止时间、完成状态、原始通知、截图和通知规则都不会被复制。
        </Text>

        {templates.length === 0 ? (
          <EmptyState
            title="还没有任务模板"
            description="在任务详情页可以把现有任务存为模板，也可以在这里新建一个模板。"
            actionLabel="新建模板"
            onAction={() => navigation.navigate('TaskTemplateForm', {})}
          />
        ) : (
          templates.map((template) => (
            <SectionCard
              key={template.id}
              title={template.name}
              subtitle={templateSummary(template)}
            >
              <View style={styles.badgeRow}>
                {template.title ? <Badge text={template.title} tone="neutral" /> : null}
                {template.courseId === null ? null : (
                  <Badge
                    text={store.courseById(template.courseId)?.name ?? '原课程已不存在'}
                    tone={store.courseById(template.courseId) ? 'muted' : 'clay'}
                  />
                )}
                {template.estimatedMinutes === null ? null : (
                  <Badge text={`${template.estimatedMinutes} 分钟`} tone="muted" />
                )}
              </View>
              {template.courseId !== null && !store.courseById(template.courseId) ? (
                <Text style={styles.warnText}>
                  这个模板原关联的课程已不在本机；应用时会留空并提示你重新选择，不会挂到别的课程上。
                </Text>
              ) : null}
              <View style={styles.actions}>
                <AppButton
                  label="使用模板"
                  onPress={() => navigation.navigate('TaskForm', { templateId: template.id })}
                  compact
                  accessibilityLabel={`使用模板「${template.name}」新建任务`}
                  accessibilityHint="会打开可编辑的任务表单，只有你确认保存后才会创建任务"
                />
                <AppButton
                  label="编辑"
                  onPress={() => navigation.navigate('TaskTemplateForm', { id: template.id })}
                  variant="secondary"
                  compact
                  accessibilityLabel={`编辑模板「${template.name}」`}
                />
                <AppButton
                  label="删除"
                  onPress={() => setPendingDelete(template)}
                  variant="danger"
                  compact
                  accessibilityLabel={`删除模板「${template.name}」`}
                />
              </View>
            </SectionCard>
          ))
        )}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="删除这个模板？"
        message={`模板「${pendingDelete?.name ?? ''}」会从本机删除。`}
        details={[
          '已经用这个模板创建过的任务不会被删除。',
          '重复任务规则里保存的是内容快照，也不会因此被删除。',
        ]}
        confirmLabel="删除模板"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  hint: { ...typography.caption, color: colors.textMuted, marginBottom: spacing.md },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  errorBox: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: { ...typography.bodySoft, color: colors.clayDark, marginBottom: spacing.xs },
  warnText: { ...typography.caption, color: colors.warn, marginTop: spacing.xs },
  muted: { ...typography.caption, color: colors.textMuted },
})
