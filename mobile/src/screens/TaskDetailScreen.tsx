/**
 * 任务详情：完整字段 + **原始通知文本**（可追加、不可覆盖）+ 编辑 / 完成 / 删除入口。
 *
 * 详情页是只读视图；所有修改都走表单页或明确的按钮，不存在「点一下就偷偷改数据」的交互。
 * 文案面向用户：不出现存储字段名、原始 ISO 串或数据库术语。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { isDateOnlyDeadline, shanghaiDeadlineLabel, remainingLabel } from '../domain/datetime'
import { taskPriorityLabels, taskStatusLabels, taskTypeLabels, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, Badge, EmptyState, ErrorState, LoadingState, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast, taskDeleteDetails } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithTemplates } from '../navigation/types'
import { clearNavigationDraft, setNavigationDraftDirty } from '../navigation/navigationDraftGuard'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithTemplates>
type Route = RouteProp<SharedTaskRoutesWithTemplates, 'TaskDetail'>

export function TaskDetailScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const taskId = route.params.id

  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [appendText, setAppendText] = useState('')

  /**
   * 只把**真实未保存内容**登记给通知导航：追加原文有字 / 删除确认框打开 /
   * 正在写库（busy）。没改任何东西的详情页可以被通知直接打开，不会被当成
   * 「编辑中」静默挡下。
   *
   * 用 ref 同步登记，输入 / 确认 / busy 的 setter 都会先更新 ref 再通知，
   * 避免通知恰好在 React 渲染 / effect 之间到达时看到旧的干净状态。
   */
  const appendTextRef = useRef('')
  const confirmingRef = useRef(false)
  const busyRef = useRef(false)

  const syncDraft = useCallback(() => {
    setNavigationDraftDirty(
      route.key,
      'TaskDetail',
      appendTextRef.current.trim().length > 0 || confirmingRef.current || busyRef.current,
    )
  }, [route.key])

  const changeAppendText = useCallback(
    (value: string) => {
      appendTextRef.current = value
      setAppendText(value)
      // 同步登记，通知回调与输入事件之间不留下「看起来是干净页」的窗口。
      setNavigationDraftDirty(
        route.key,
        'TaskDetail',
        value.trim().length > 0 || confirmingRef.current || busyRef.current,
      )
    },
    [route.key],
  )

  const changeConfirming = useCallback(
    (next: boolean) => {
      confirmingRef.current = next
      setConfirming(next)
      setNavigationDraftDirty(
        route.key,
        'TaskDetail',
        appendTextRef.current.trim().length > 0 || next || busyRef.current,
      )
    },
    [route.key],
  )

  const changeBusy = useCallback(
    (next: boolean) => {
      busyRef.current = next
      setBusy(next)
      setNavigationDraftDirty(
        route.key,
        'TaskDetail',
        appendTextRef.current.trim().length > 0 || confirmingRef.current || next,
      )
    },
    [route.key],
  )

  /** 状态变化后的兜底同步；没有 cleanup，dirty→dirty 不会瞬时报「干净」。 */
  useEffect(() => {
    syncDraft()
  }, [appendText, busy, confirming, syncDraft])

  /** 只有真正卸载 / 换 route key 才清理，且清理延迟到微任务，StrictMode 不闪断。 */
  useEffect(() => {
    return () => clearNavigationDraft(route.key)
  }, [route.key])

  const snapshotTask = useMemo(
    () => store.data.tasks.find((item) => item.id === taskId) ?? null,
    [store.data.tasks, taskId],
  )
  /**
   * 通知点击可能先于任务快照刷新到达详情页；快照里没有**不能**直接说任务已删除。
   * 这里再做一次只读数据库重查：成功则用最新任务，读失败显示可重试错误，
   * 只有明确查不到才显示「已删除」。
   */
  const [fresh, setFresh] = useState<{ status: 'idle' | 'loading' | 'found' | 'missing' | 'error'; task: Task | null; reason: string | null }>({
    status: 'idle',
    task: null,
    reason: null,
  })
  const [freshAttempt, setFreshAttempt] = useState(0)

  /**
   * 同一个详情实例被复用于另一条任务时，旧任务的 toast / 输入 / 操作中状态
   * 不能显示在新任务上；但**真实草稿**（追加原文有字 / 确认框）绝不清掉。
   */
  useEffect(() => {
    if (appendTextRef.current.trim().length > 0 || confirmingRef.current) return
    appendTextRef.current = ''
    confirmingRef.current = false
    busyRef.current = false
    setAppendText('')
    setConfirming(false)
    setBusy(false)
    setToast(null)
    setFresh({ status: 'idle', task: null, reason: null })
    setFreshAttempt(0)
    setNavigationDraftDirty(route.key, 'TaskDetail', false)
  }, [route.key, taskId])

  useEffect(() => {
    if (snapshotTask) {
      setFresh({ status: 'idle', task: null, reason: null })
      return
    }
    let cancelled = false
    setFresh({ status: 'loading', task: null, reason: null })
    void store.getTaskFresh(taskId).then((result) => {
      if (cancelled) return
      if (!result.ok) {
        setFresh({ status: 'error', task: null, reason: result.reason })
        return
      }
      setFresh(
        result.task
          ? { status: 'found', task: result.task, reason: null }
          : { status: 'missing', task: null, reason: null },
      )
    })
    return () => {
      cancelled = true
    }
  }, [freshAttempt, snapshotTask, store, taskId])

  const freshTask = fresh.status === 'found' && fresh.task?.id === taskId ? fresh.task : null
  const task = snapshotTask ?? freshTask
  const course = task ? store.courseById(task.courseId) : null
  const originalText = task ? (store.data.originalTexts.get(task.id) ?? '') : ''

  const toggle = useCallback(async () => {
    if (!task) return
    changeBusy(true)
    try {
      const updated = await store.toggleTaskComplete(task.id)
      setToast({ text: updated.status === 'DONE' ? '已标记为完成。' : '已恢复为未完成。', tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '更新失败。', tone: 'error' })
    } finally {
      changeBusy(false)
    }
  }, [changeBusy, store, task])

  const confirmDelete = useCallback(async () => {
    if (!task) return
    changeBusy(true)
    try {
      await store.deleteTask(task.id)
      changeConfirming(false)
      navigation.goBack()
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除失败。', tone: 'error' })
      changeBusy(false)
    }
  }, [changeBusy, changeConfirming, navigation, store, task])

  const submitAppend = useCallback(async () => {
    if (!task) return
    const text = appendText.trim()
    if (text.length === 0) return
    changeBusy(true)
    try {
      await store.appendTaskOriginalText(task.id, text)
      changeAppendText('')
      setToast({ text: '已追加到原始文本，原来的内容没有被改动。', tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '追加失败。', tone: 'error' })
    } finally {
      changeBusy(false)
    }
  }, [appendText, changeAppendText, changeBusy, store, task])

  if (!task) {
    if (fresh.status === 'idle' || fresh.status === 'loading') {
      return (
        <ScreenScaffold title="正在读取任务" subtitle="从本机数据库确认这条任务">
          <LoadingState message="正在确认这条任务是否还在本机…" />
        </ScreenScaffold>
      )
    }
    if (fresh.status === 'error') {
      return (
        <ScreenScaffold title="暂时读不到这条任务" subtitle="不是已删除，只是这次读取失败">
          <ErrorState
            message={fresh.reason ?? '读取任务失败，请重试。'}
            onRetry={() => setFreshAttempt((value) => value + 1)}
          />
        </ScreenScaffold>
      )
    }
    return (
      <ScreenScaffold title="找不到这条任务" subtitle="它可能已经被删除">
        <EmptyState
          title="这条任务不在本机了"
          description="它可能已经被删除。返回任务列表可以继续。"
          actionLabel="返回任务列表"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  const remaining = remainingLabel(task.deadline)
  const done = task.status === 'DONE'
  const dateOnlyDeadline = isDateOnlyDeadline(task.deadline)

  return (
    <>
      <ScreenScaffold title={task.title} subtitle="这条任务保存在这台手机上">
        <View style={styles.badgeRow}>
          <Badge text={taskStatusLabels[task.status]} tone={done ? 'success' : 'primary'} />
          <Badge text={taskTypeLabels[task.type]} tone="neutral" />
          <Badge text={`优先级 ${taskPriorityLabels[task.priority] ?? task.priority}`} tone="muted" />
          {task.deadline ? <Badge text={remaining.text} tone={remaining.overdue ? 'clay' : 'muted'} /> : null}
        </View>

        <SectionCard title="截止时间">
          {task.deadline ? (
            <>
              <Text style={styles.deadline}>{shanghaiDeadlineLabel(task.deadline)}</Text>
              {dateOnlyDeadline ? (
                <Text style={styles.muted}>
                  只记到日期（按北京时间）：这一天内完成都不算逾期；需要定时提醒时，编辑任务补上具体时刻（HH:mm）即可。
                </Text>
              ) : (
                <Text style={styles.muted}>
                  按北京时间记录。即使手机换了时区或出国，这里显示的时刻都不会变。
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.muted}>未设置截止时间。这条任务不会出现在日历的任何一天上。</Text>
          )}
        </SectionCard>

        <SectionCard title="课程">
          <Text style={styles.value}>{course ? course.name : '未关联课程'}</Text>
          {course?.instructor ? <Text style={styles.muted}>教师：{course.instructor}</Text> : null}
        </SectionCard>

        <SectionCard title="说明">
          <Text style={styles.value}>{task.description ?? '没有填写说明。'}</Text>
        </SectionCard>

        <SectionCard title="提交信息">
          <Text style={styles.muted}>提交要求：{task.submitRequirement ?? '未填写'}</Text>
          <Text style={styles.muted}>提交方式：{task.submitMethod ?? '未填写'}</Text>
          <Text style={styles.muted}>
            预计用时：{task.estimatedMinutes === null ? '未估算' : `${task.estimatedMinutes} 分钟`}
          </Text>
        </SectionCard>

        <SectionCard
          title="原始通知文本"
          subtitle={originalText ? '只读留档：编辑任务不会覆盖它，需要补充请用下面的「追加原文」' : '这条任务还没有保存原文'}
        >
          <Text style={[styles.original, originalText ? null : styles.muted]}>
            {originalText || '（空）可以在编辑页把通知原文粘贴进去留档。'}
          </Text>

          {originalText ? (
            <>
              <AppTextField
                label="追加一段新原文"
                value={appendText}
                onChangeText={changeAppendText}
                placeholder="例如后来又收到一条补充通知，粘贴在这里"
                editable={!busy}
                multiline
                hint="追加会作为新的一条记录保存，已有原文不会被改写或删除。"
                accessibilityLabel="追加原始通知文本"
              />
              <AppButton
                label="追加原文"
                onPress={() => void submitAppend()}
                variant="secondary"
                compact
                disabled={busy || appendText.trim().length === 0}
                accessibilityLabel="把这段文本追加为新的原文记录"
              />
            </>
          ) : null}
        </SectionCard>

        <SectionCard title="时间信息">
          <Text style={styles.muted}>创建：{shanghaiDeadlineLabel(task.createdAt)}</Text>
          <Text style={styles.muted}>最近修改：{shanghaiDeadlineLabel(task.updatedAt)}</Text>
          <Text style={styles.muted}>
            完成：{task.completedAt ? shanghaiDeadlineLabel(task.completedAt) : '尚未完成'}
          </Text>
        </SectionCard>

        <AppButton
          label={done ? '标为未完成' : '标记完成'}
          onPress={() => void toggle()}
          loading={busy}
          disabled={busy}
          accessibilityLabel={done ? '把任务标为未完成' : '把任务标为已完成'}
        />
        <AppButton
          label="编辑任务"
          onPress={() => navigation.navigate('TaskForm', { id: task.id })}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="编辑这个任务"
        />
        <AppButton
          label="存为模板"
          onPress={() => navigation.navigate('TaskTemplateForm', { sourceTaskId: task.id })}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="把这条任务存为模板"
          accessibilityHint="只保存你勾选的可复用内容；不会复制截止时间、完成状态、原始通知或截图"
        />
        <AppButton
          label="任务模板"
          onPress={() => navigation.navigate('TaskTemplateList')}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="打开任务模板列表"
        />
        <AppButton
          label="步骤清单"
          onPress={() => navigation.navigate('TaskSteps', { id: task.id })}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="打开这条任务的步骤清单"
          accessibilityHint="把这条任务手动拆成几步；步骤只是清单，不会改动任务的截止时间或状态"
        />
        <AppButton
          label="提醒设置"
          onPress={() => navigation.navigate('TaskReminder', { id: task.id })}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="设置这条任务的截止提醒"
          accessibilityHint="默认关闭；只有你显式开启后，才会在截止前用手机本地通知提醒"
        />
        <AppButton
          label="任务原图"
          onPress={() => navigation.navigate('TaskPhotos', { id: task.id })}
          variant="secondary"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="查看这条任务的原图"
          accessibilityHint="查看关联到这条任务的截图；可以直接从相册或相机放一张新截图，也可以从截图库手动添加，或解除手动关联"
        />
        <AppButton
          label="删除任务"
          onPress={() => changeConfirming(true)}
          variant="danger"
          disabled={busy}
          style={styles.gap}
          accessibilityLabel="删除这个任务"
          accessibilityHint="删除前会再次确认"
        />
      </ScreenScaffold>

      <ConfirmDialog
        visible={confirming}
        title="删除这个任务？"
        details={taskDeleteDetails(task.title, originalText.length > 0)}
        confirmLabel="删除任务"
        danger
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => changeConfirming(false)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  deadline: { ...typography.section, marginBottom: spacing.xs },
  value: { ...typography.body },
  muted: { ...typography.caption, marginTop: spacing.xs },
  original: { ...typography.bodySoft, color: colors.text },
  gap: { marginTop: spacing.md },
})
