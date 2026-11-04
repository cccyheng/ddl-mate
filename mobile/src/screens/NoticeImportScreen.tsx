/**
 * 通知原文 → 待办（原生界面，一次走完：粘贴 → 提取 → 核对 → 保存）。
 *
 * 交互契约（与授权书逐条对应）：
 * - **粘贴**：上限 10000 字，超了**当场报错**，绝不静默截断；
 * - **提取任务**：只读，不写数据库；显示真实候选数与「没有候选 / 出错」状态；
 * - **核对**：每条候选可勾选（全选 / 全不选 / 单选），只有展开的那一条才渲染完整编辑字段
 *   （30 条候选项也不会一次渲染 30 个时间输入框）；
 * - 每条可改：标题、所属课程（含「不关联课程」）、类型、截止时间、提交要求、提交方式；
 *   原文片段与来源**只读**，始终可读；
 * - **保存**：只写勾选且通过校验的行；课程被删除这类问题**可见地拦下来**，不静默忽略；
 * - 保存期间按钮禁用（防连点）；`committed` 之后不再提供「重试保存」；
 * - 有未保存的核对内容时，改原文 / 重新提取 / 返回上一页都要先明确确认。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import {
  MAX_NOTICE_SOURCE_CHARS,
  MAX_NOTICE_TASKS,
  noticeRowToTaskDraft,
  noticeSourceLengthError,
  parseNoticeSource,
  validateNoticeImportRows,
  noticeRowsFromCandidates,
  type NoticeImportRow,
} from '../domain/noticeImport'
import type { NoticeImportOutcome } from '../domain/noticeImportRepository'
import {
  hasUnsavedNoticeDraft,
  isNoticeSourceStale,
  NOTICE_SOURCE_STALE_MESSAGE,
  noticeSaveGuard,
  noticeSaveGuardFieldErrors,
} from '../domain/noticeImportState'
import { taskTypeLabels, taskTypeOptions, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, Badge, EmptyState, OptionGroup, SectionCard } from '../ui/components'
import { WallClockField } from '../ui/datetimeField'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import type { TaskStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<TaskStackParamList>
type Route = RouteProp<TaskStackParamList, 'NoticeImport'>
type Phase = 'compose' | 'review'

/**
 * 被拦下来的导航动作。
 *
 * 用 `usePreventRemove`（native-stack 官方集成）而不是自己挂 `beforeRemove`：
 * 自己那份实现会丢掉**原始导航动作**，只能退化成 `goBack()`，
 * 用户从原生返回手势 / 头部返回按钮过来时就会走错一步。
 * 这里把 `data.action` 原样记下来，用户明确确认丢弃之后**再原样派发**。
 */
type PendingLeave = { kind: 'discard'; action: Parameters<Nav['dispatch']>[0] | null }

const TYPE_OPTIONS = taskTypeOptions.map((option) => ({ value: option.value, label: taskTypeLabels[option.value] }))

/** 截止时间的可读摘要（只用于折叠行的一行摘要，不参与任何判定）。 */
function deadlineSummary(row: NoticeImportRow): string {
  const value = row.deadline.trim()
  if (value.length === 0) return '截止时间未填（原文没给出完整日期与时刻）'
  return `截止 ${value.replace('T', ' ')}`
}

export function NoticeImportScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()

  const [phase, setPhase] = useState<Phase>('compose')
  /**
   * 原文初值只从路由参数取**一次**。
   *
   * 「截图转待办」用 `navigation.push('NoticeImport', { initialSourceText })` 打开一个
   * **全新实例**，因此不会覆盖用户已经打开并改过的核对草稿；这里也只把参数当初始值，
   * 之后路由参数变化绝不再回写输入框。参数是完整 reviewed text（长度在上一步已校验）。
   */
  const [sourceText, setSourceText] = useState(() => route.params?.initialSourceText ?? '')
  /**
   * 上一次「提取任务」时用的原文快照。
   *
   * 这是**唯一**允许入库的原文：候选行是按它算出来的。输入框之后可以改，
   * 但只要与它不一致，保存就会被拦下来（见 `noticeSaveGuard`）。
   */
  const [sourceSnapshot, setSourceSnapshot] = useState<string | null>(null)
  const [rows, setRows] = useState<NoticeImportRow[]>([])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [outcome, setOutcome] = useState<NoticeImportOutcome | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [overflowNotice, setOverflowNotice] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<null | { kind: 'reextract' | 'discard' }>(null)
  const [pendingLeave, setPendingLeave] = useState<PendingLeave | null>(null)
  /** 保存期间尝试离开时的明确提示（不提供「丢弃」按钮，只让用户等）。 */
  const [waitNotice, setWaitNotice] = useState<string | null>(null)

  /** 防连点的同步闸门：`saving` 是异步 state，两次极快的点击可能都读到 false。 */
  const submitGuard = useRef(false)
  /** 「已经提交过」的标记：提交之后**不再允许**重试保存，避免产生重复任务。 */
  const committedRef = useRef(false)
  /**
   * 用户已经在确认框里明确选择「丢弃并离开」。
   *
   * 为什么需要这个 ref：确认时派发的**就是被拦下来的那个动作**，React 的
   * `preventRemove` 标志要到下一次渲染才变 false —— 如果这里不再拦一次，
   * 同一个动作会被再拦一遍、确认框会原地弹回来。
   */
  const confirmedLeaveRef = useRef(false)

  const sourceError = noticeSourceLengthError(sourceText)
  /** 已经提取、还没保存的核对内容。 */
  const hasUncommittedReview = phase === 'review' && outcome === null && rows.length > 0
  /** 原文在提取之后被改过：候选行已经过期，不允许保存（按钮与事件处理器都拦）。 */
  const sourceStale = isNoticeSourceStale(sourceSnapshot, sourceText)
  /**
   * 未落库的草稿：**与阶段无关**。
   *
   * 覆盖三种「静默丢掉就再也找不回来」的东西：粘了原文、还有核对行（哪怕原文被清空）、
   * 或者已经提取过（快照非 null，含提取出 0 条候选）。已经成功保存之后就不再算草稿。
   */
  const hasUnsavedDraft = hasUnsavedNoticeDraft({
    sourceText,
    rowCount: rows.length,
    snapshot: sourceSnapshot,
    committed: outcome !== null,
  })
  /** 保存守卫：按钮可用性与事件处理器共用同一个判定。 */
  const saveGuard = useMemo(
    () =>
      noticeSaveGuard({
        sourceText,
        snapshot: sourceSnapshot,
        rowCount: rows.length,
        committed: outcome !== null,
      }),
    [outcome, rows.length, sourceSnapshot, sourceText],
  )

  const availableCourses = useMemo(
    () => store.data.courses.map((course) => ({ id: course.id, name: course.name })),
    [store.data.courses],
  )

  const courseOptions = useMemo(
    () => [
      { value: 0, label: '不关联课程' },
      ...store.data.courses.map((course) => ({ value: course.id, label: course.name })),
    ],
    [store.data.courses],
  )

  const selectedCount = useMemo(() => rows.filter((row) => row.selected).length, [rows])

  const updateRow = useCallback((rowIndex: number, patch: Partial<NoticeImportRow>) => {
    setRows((previous) => previous.map((row) => (row.rowIndex === rowIndex ? { ...row, ...patch } : row)))
    setFieldErrors((previous) => {
      const keys = Object.keys(previous).filter((key) => key.startsWith(`row:${rowIndex}:`))
      if (keys.length === 0) return previous
      const next = { ...previous }
      for (const key of keys) delete next[key]
      return next
    })
  }, [])

  const runExtract = useCallback(() => {
    setExtractError(null)
    setOverflowNotice(null)
    setFormError(null)
    setOutcome(null)
    const summary = parseNoticeSource(sourceText, availableCourses)
    // 映射规则统一放在 `noticeImport.ts`（可单测），这里只负责把结果塞进界面状态。
    const nextRows = noticeRowsFromCandidates(summary.candidates, availableCourses)
    setRows(nextRows)
    setExpanded(nextRows.length > 0 ? (nextRows[0]?.rowIndex ?? null) : null)
    setFieldErrors({})
    setPhase('review')
    // 记录**这一次提取用的原文**：之后所有计算与入库都以它为准。
    setSourceSnapshot(sourceText)
    if (summary.overflow) {
      const total = summary.countCapped ? `超过 ${summary.actualCount}` : String(summary.actualCount)
      setOverflowNotice(
        `原文里一共有 ${total} 条候选任务，超过单次上限 ${MAX_NOTICE_TASKS} 条：` +
          `这里只列出前 ${MAX_NOTICE_TASKS} 条，后面的没有列出来（也不会被保存）。` +
          `请把这部分存好，剩下的原文再导入一次。`,
      )
    }
  }, [availableCourses, sourceText])

  const onExtract = useCallback(() => {
    if (sourceError) {
      setExtractError(sourceError)
      return
    }
    // 已经改过核对内容时，重新提取会丢掉那些改动 → 必须先明确确认。
    if (hasUncommittedReview) {
      setPendingConfirm({ kind: 'reextract' })
      return
    }
    runExtract()
  }, [hasUncommittedReview, runExtract, sourceError])

  const setAllSelected = useCallback((selected: boolean) => {
    setRows((previous) => previous.map((row) => ({ ...row, selected })))
    setFieldErrors({})
  }, [])

  const onSave = useCallback(async () => {
    if (submitGuard.current || committedRef.current) return
    // 第一层守卫（**事件处理器里真的拦截**，不只是把按钮变灰）：
    // 原文与提取快照不一致时绝不把「旧候选 + 新原文」写进库。
    const guard = noticeSaveGuard({
      sourceText,
      snapshot: sourceSnapshot,
      rowCount: rows.length,
      committed: committedRef.current,
    })
    if (!guard.allowed) {
      setFieldErrors(noticeSaveGuardFieldErrors(guard))
      setFormError(guard.reason)
      return
    }
    const validation = validateNoticeImportRows(rows, availableCourses)
    if (Object.keys(validation.fieldErrors).length > 0) {
      setFieldErrors(validation.fieldErrors)
      setFormError('还有需要修改的地方：请看下面标出的行。')
      return
    }
    if (validation.selectedCount === 0) {
      setFieldErrors({ selection: '还没有勾选任何一条：请勾选要保存的候选项。' })
      setFormError('还没有勾选任何一条：请勾选要保存的候选项。')
      return
    }
    setFieldErrors({})
    setFormError(null)
    submitGuard.current = true
    setSaving(true)
    try {
      // 入库原文一律取**提取快照**（守卫已经验证它与当前输入一致），
      // 保证「保存下来的原文」就是「候选行按哪份原文算出来的」。
      const result = await store.importNoticeCandidates({ sourceText: guard.sourceToPersist, rows })
      committedRef.current = true
      setOutcome(result)
      setToast({
        text: result.readbackError
          ? `已保存 ${result.createdIds.length} 条待办；列表需要重新读取一次才能看到最新内容，不用再保存一遍。`
          : `已保存 ${result.createdIds.length} 条待办。`,
        tone: 'success',
      })
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setFieldErrors(cause.fields)
        setFormError(cause.message)
      } else {
        setFormError(cause instanceof Error ? cause.message : '保存失败。')
      }
    } finally {
      submitGuard.current = false
      setSaving(false)
      // 保存结束后「正在保存」的等待提示必须消失，否则会误导下一步操作。
      setWaitNotice(null)
    }
  }, [availableCourses, rows, sourceSnapshot, sourceText, store])

  /** 改了原文但还没重新提取：提示用户「现在看到的是上次提取的结果」。 */
  const onChangeSource = useCallback(
    (value: string) => {
      setSourceText(value)
      setExtractError(null)
    },
    [],
  )

  /* --------------------------- 返回前的未保存确认 --------------------------- */

  /**
   * 用 `usePreventRemove`（native-stack 官方集成）拦截返回：头部返回按钮、原生返回手势、
   * 以及任何 `navigate/goBack` 派发都会走到同一个回调，并且**带着原始导航动作**。
   *
   * - 保存进行中：拦下来并给出「正在保存，请稍等」的明确提示，**不提供丢弃按钮**
   *   （绝不把「保存中」误判成「没保存」而让用户丢掉这次导入）；
   * - 有未保存草稿（核对内容或只粘贴了原文）：拦下来，把原始动作存起来，
   *   用户明确确认丢弃之后再原样派发。
   */
  usePreventRemove(hasUnsavedDraft || saving, ({ data }) => {
    if (confirmedLeaveRef.current) return
    if (saving) {
      setWaitNotice('正在保存，请稍等这一批写完再离开，避免误以为没保存而重复导入。')
      return
    }
    setWaitNotice(null)
    setPendingLeave({ kind: 'discard', action: data.action })
  })

  const confirmPending = useCallback(() => {
    const pending = pendingConfirm
    if (!pending) return
    if (pending.kind === 'reextract') {
      setPendingConfirm(null)
      runExtract()
      return
    }
    if (saving) return
    // 丢弃草稿：先清干净，再原样派发被拦下来的那个导航动作。
    setPendingConfirm(null)
    setRows([])
    setSourceSnapshot(null)
    setPhase('compose')
    setOutcome(null)
    committedRef.current = false
    navigation.goBack()
  }, [navigation, pendingConfirm, runExtract, saving])

  const confirmLeave = useCallback(() => {
    const pending = pendingLeave
    if (!pending || saving) return
    setPendingLeave(null)
    setRows([])
    setSourceText('')
    setSourceSnapshot(null)
    setPhase('compose')
    setOutcome(null)
    committedRef.current = false
    // 置位后再派发：同一个动作不会被 `usePreventRemove` 再拦一次。
    confirmedLeaveRef.current = true
    if (pending.action) navigation.dispatch(pending.action)
    else navigation.goBack()
  }, [navigation, pendingLeave, saving])

  const openTask = useCallback(
    (task: Task) => navigation.navigate('TaskDetail', { id: task.id }),
    [navigation],
  )

  return (
    <>
      <ScreenScaffold
        title="通知转待办"
        subtitle={`粘贴群通知原文 → 提取候选 → 逐条核对后保存（单次最多 ${MAX_NOTICE_TASKS} 条，原文 ${MAX_NOTICE_SOURCE_CHARS} 字以内）`}
      >
        {/* ------------------------------ 粘贴原文 ------------------------------ */}
        <SectionCard
          title="1. 粘贴通知原文"
          subtitle="原文（包括群名、发送时间这些消息头）会完整留档到每条任务，之后在任务详情里随时读回"
        >
          <AppTextField
            label="通知原文"
            value={sourceText}
            onChangeText={onChangeSource}
            placeholder={'例如：\n2026年10月8日 09:12 张老师\n第三次作业请在 2026年10月20日 22:00 前提交到学习通。'}
            multiline
            editable={!saving && outcome === null}
            error={extractError ?? sourceError}
            hint={
              sourceError
                ? undefined
                : `已输入 ${sourceText.length} / ${MAX_NOTICE_SOURCE_CHARS} 字。这里只做本地规则提取，不是 AI 语义理解，也不会联网。`
            }
            accessibilityLabel="通知原文"
          />
          {sourceStale ? (
            <Text style={styles.staleNote} accessibilityRole="alert">
              {NOTICE_SOURCE_STALE_MESSAGE}
              {'\n'}
              下面是按上一次提取的原文算出来的候选：原文改动之后要先重新提取，保存按钮才会再次可用
              （取消重新提取不会丢掉你已经改好的候选）。
            </Text>
          ) : null}
          <AppButton
            label="提取任务"
            onPress={onExtract}
            disabled={saving || sourceText.trim().length === 0 || outcome !== null}
            accessibilityLabel="从原文提取任务候选"
            accessibilityHint="只在本机按规则提取，不写任何数据"
          />
        </SectionCard>

        {/* ------------------------------- 结果态 ------------------------------- */}
        {phase === 'review' && rows.length === 0 ? (
          <EmptyState
            title="没有提取到可用的任务"
            description={
              '这段文字里没有找到「像任务」的内容（动作、任务名词或明确的截止时间）。\n' +
              '可以检查是否粘贴完整，或回到任务页手动新建一条。'
            }
            actionLabel="回到任务列表"
            onAction={() => navigation.goBack()}
          />
        ) : null}

        {overflowNotice ? (
          <View style={styles.warnBox} accessibilityRole="alert">
            <Text style={styles.warnText}>{overflowNotice}</Text>
          </View>
        ) : null}

        {/* ------------------------------- 核对列表 ------------------------------ */}
        {phase === 'review' && rows.length > 0 ? (
          <>
            <SectionCard
              title="2. 核对并勾选"
              subtitle={`共 ${rows.length} 条候选，已勾选 ${selectedCount} 条。不勾选的行不会被保存。`}
            >
              <View style={styles.bulkRow}>
                <AppButton
                  label="全选"
                  variant="secondary"
                  compact
                  disabled={saving || outcome !== null}
                  onPress={() => setAllSelected(true)}
                  accessibilityLabel="全选所有候选"
                />
                <AppButton
                  label="全不选"
                  variant="secondary"
                  compact
                  disabled={saving || outcome !== null}
                  onPress={() => setAllSelected(false)}
                  accessibilityLabel="取消勾选所有候选"
                />
                {outcome === null ? (
                  <AppButton
                    label="重新提取"
                    variant="secondary"
                    compact
                    disabled={saving}
                    onPress={onExtract}
                    accessibilityLabel="按当前原文重新提取任务"
                    accessibilityHint="会覆盖下面已经改好的核对内容，需要先确认"
                  />
                ) : null}
              </View>
              {fieldErrors.selection ? (
                <Text style={styles.errorText} accessibilityRole="alert">
                  {fieldErrors.selection}
                </Text>
              ) : null}
              {rows.map((row) => (
                <CandidateRow
                  key={row.rowIndex}
                  row={row}
                  expanded={expanded === row.rowIndex}
                  courseOptions={courseOptions}
                  errors={fieldErrors}
                  disabled={saving || outcome !== null}
                  onToggleExpand={() => setExpanded((previous) => (previous === row.rowIndex ? null : row.rowIndex))}
                  onChange={(patch) => updateRow(row.rowIndex, patch)}
                />
              ))}
            </SectionCard>

            {formError ? (
              <View style={styles.errorBox} accessibilityRole="alert">
                <Text style={styles.errorText}>{formError}</Text>
              </View>
            ) : null}

            {outcome ? null : (
              <>
                <AppButton
                  label={`保存勾选的 ${selectedCount} 条为待办`}
                  onPress={() => void onSave()}
                  loading={saving}
                  // 按钮与事件处理器**同一个守卫**：原文与提取快照不一致时不可点。
                  disabled={saving || selectedCount === 0 || !saveGuard.canSave}
                  accessibilityLabel="保存勾选的候选为待办任务"
                  accessibilityHint={
                    saveGuard.canSave ? '只保存勾选且通过校验的行' : saveGuard.reason
                  }
                />
                {!saveGuard.canSave && saveGuard.reason ? (
                  <Text style={styles.errorText} accessibilityRole="alert">
                    {saveGuard.reason}
                  </Text>
                ) : null}
              </>
            )}
          </>
        ) : null}

        {/* ------------------------------- 完成态 ------------------------------- */}
        {outcome ? (
          <SectionCard
            title="3. 保存结果"
            subtitle={
              outcome.readbackError
                ? '已经写入这台手机，只是列表暂时读不回来；不用再保存一次。'
                : '下面是这次真正写进本机的任务。'
            }
          >
            <Text style={styles.resultLine}>新建 {outcome.createdIds.length} 条。</Text>
            {outcome.duplicateCount > 0 ? (
              <Text style={styles.resultLine}>
                跳过完全重复的 {outcome.duplicateCount} 条（原文与全部字段都和已有任务一致）。
              </Text>
            ) : null}
            {outcome.readbackError ? (
              <Text style={styles.errorText} accessibilityRole="alert">
                读回失败：{outcome.readbackError.message}
              </Text>
            ) : null}
            {outcome.duplicates.map((duplicate) => (
              <Text key={`dup-${duplicate.taskNumber}`} style={styles.resultLine}>
                第 {duplicate.taskNumber} 行「{duplicate.title}」已存在，没有重复新建。
              </Text>
            ))}
            {outcome.created.map((created) => (
              <View key={created.taskId} style={styles.createdRow}>
                <Text style={styles.createdTitle}>{created.task.title}</Text>
                <Text style={styles.resultLine}>
                  {created.task.deadline ? `截止 ${created.task.deadline.slice(0, 16).replace('T', ' ')}` : '未设置截止时间'}
                  {created.task.courseId === null
                    ? '　未关联课程'
                    : `　课程：${store.courseById(created.task.courseId)?.name ?? '（已删除）'}`}
                </Text>
                <AppButton
                  label="查看这条任务"
                  variant="secondary"
                  compact
                  onPress={() => openTask(created.task)}
                  accessibilityLabel={`查看任务 ${created.task.title}`}
                />
              </View>
            ))}
            <AppButton
              label="返回任务列表"
              onPress={() => navigation.goBack()}
              accessibilityLabel="返回任务列表"
            />
          </SectionCard>
        ) : null}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingConfirm !== null}
        title={pendingConfirm?.kind === 'reextract' ? '重新提取会覆盖已改好的内容' : '离开并丢弃核对内容？'}
        message={
          pendingConfirm?.kind === 'reextract'
            ? '现在列表里对标题、课程、时间、提交信息的修改都会丢失，改为按当前原文重新提取。'
            : '这次核对的内容还没有保存，返回后需要重新粘贴与提取。'
        }
        details={
          pendingConfirm?.kind === 'reextract'
            ? ['原文本身不会被改动。', '已经保存过的任务不受影响。']
            : ['没有保存的候选项不会写进本机。', '已经保存过的任务不受影响。']
        }
        confirmLabel={pendingConfirm?.kind === 'reextract' ? '重新提取' : '丢弃并返回'}
        danger={pendingConfirm?.kind === 'discard'}
        busy={saving}
        onConfirm={confirmPending}
        onCancel={() => setPendingConfirm(null)}
      />

      {/* 用户按了返回：明确确认之后才派发**原来那个**导航动作（不是一律 goBack）。 */}
      <ConfirmDialog
        visible={pendingLeave !== null && !saving}
        title="离开并丢弃这次的内容？"
        message={
          rows.length > 0
            ? '这次核对的内容和原文都还没有保存，离开后需要重新粘贴与提取。'
            : '粘贴的原文还没有提取，离开后就没了。'
        }
        details={['没有保存的内容不会写进本机。', '已经保存过的任务不受影响。']}
        confirmLabel="丢弃并离开"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeave(null)}
      />

      {waitNotice ? (
        <ConfirmDialog
          visible
          title="正在保存，请稍等"
          message={waitNotice}
          details={['保存期间离开会让这批内容看起来「没保存」，容易重复导入。']}
          confirmLabel="继续等待"
          cancelLabel="知道了"
          onConfirm={() => setWaitNotice(null)}
          onCancel={() => setWaitNotice(null)}
        />
      ) : null}

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

/* ------------------------------- 单条候选 ------------------------------- */

function CandidateRow({
  row,
  expanded,
  courseOptions,
  errors,
  disabled,
  onToggleExpand,
  onChange,
}: {
  row: NoticeImportRow
  expanded: boolean
  courseOptions: ReadonlyArray<{ value: number; label: string }>
  errors: Record<string, string>
  disabled: boolean
  onToggleExpand: () => void
  onChange: (patch: Partial<NoticeImportRow>) => void
}): React.ReactElement {
  const errorOf = (field: string): string | null => errors[`row:${row.rowIndex}:${field}`] ?? null
  const rowError =
    errorOf('title') ?? errorOf('courseId') ?? errorOf('deadline') ?? errorOf('submitRequirement') ?? errorOf('submitMethod')
  const draft = useMemo(() => noticeRowToTaskDraft(row), [row])

  return (
    <View style={[styles.row, !row.selected && styles.rowUnselected]}>
      <View style={styles.rowHead}>
        <Pressable
          onPress={() => onChange({ selected: !row.selected })}
          disabled={disabled}
          accessibilityRole="checkbox"
          accessibilityLabel={`第 ${row.rowIndex} 行 ${row.title || '（没有标题）'}：${row.selected ? '已勾选' : '未勾选'}`}
          accessibilityState={{ checked: row.selected, disabled }}
          style={styles.checkbox}
        >
          <Text style={styles.checkboxGlyph}>{row.selected ? '☑' : '☐'}</Text>
        </Pressable>
        <Pressable
          onPress={onToggleExpand}
          accessibilityRole="button"
          accessibilityLabel={`第 ${row.rowIndex} 行 ${expanded ? '收起编辑字段' : '展开编辑字段'}`}
          accessibilityState={{ expanded }}
          style={styles.rowSummary}
        >
          <Text style={styles.rowTitle} numberOfLines={2}>
            第 {row.rowIndex} 条 · {row.title || '（没有标题）'}
          </Text>
          <Text style={styles.rowMeta}>
            {row.courseId !== null
              ? `课程：${courseOptions.find((option) => option.value === row.courseId)?.label ?? '（已删除）'}`
              : '课程：未关联'}
            　{taskTypeLabels[row.type]}　{deadlineSummary(row)}
          </Text>
          <Text style={styles.rowToggle}>{expanded ? '收起' : '展开修改'}</Text>
        </Pressable>
      </View>

      {rowError ? (
        <Text style={styles.errorText} accessibilityRole="alert">
          {rowError}
        </Text>
      ) : null}

      {row.courseMissing ? (
        <Text style={styles.warnInline} accessibilityRole="alert">
          第 {row.rowIndex} 行解析时关联的课程已经不在本机了：请重新选择，或改成「不关联课程」。
        </Text>
      ) : null}

      {expanded ? (
        <View style={styles.rowBody}>
          <AppTextField
            label="标题"
            required
            value={row.title}
            onChangeText={(value) => onChange({ title: value })}
            error={errorOf('title')}
            editable={!disabled}
            maxLength={200}
            accessibilityLabel={`第 ${row.rowIndex} 行标题`}
          />
          <OptionGroup
            label="所属课程"
            options={courseOptions}
            value={row.courseId ?? 0}
            onChange={(value) => onChange({ courseId: value === 0 ? null : value, courseMissing: false })}
            error={errorOf('courseId')}
            disabled={disabled}
          />
          <OptionGroup
            label="类型"
            options={TYPE_OPTIONS}
            value={row.type}
            onChange={(value) => onChange({ type: value })}
            disabled={disabled}
          />
          <WallClockField
            label="截止时间"
            value={row.deadline}
            onChange={(value) => onChange({ deadline: value })}
            error={errorOf('deadline')}
            hint="原文里没有完整的「日期 + 时刻」时这里就是空的：请自己确认，应用不会猜。"
            disabled={disabled}
            identityKey={`notice:${row.rowIndex}`}
          />
          {row.hints.length > 0 ? (
            <View style={styles.hintBox}>
              {row.hints.map((hint) => (
                <Text key={hint} style={styles.hintText}>
                  · {hint}
                </Text>
              ))}
            </View>
          ) : null}
          <AppTextField
            label="提交要求"
            value={row.submitRequirement}
            onChangeText={(value) => onChange({ submitRequirement: value })}
            error={errorOf('submitRequirement')}
            editable={!disabled}
            maxLength={500}
            accessibilityLabel={`第 ${row.rowIndex} 行提交要求`}
          />
          <AppTextField
            label="提交方式"
            value={row.submitMethod}
            onChangeText={(value) => onChange({ submitMethod: value })}
            error={errorOf('submitMethod')}
            editable={!disabled}
            maxLength={128}
            accessibilityLabel={`第 ${row.rowIndex} 行提交方式`}
          />
          <View style={styles.readonlyBox}>
            <View style={styles.readonlyHead}>
              <Badge text="原文片段（只读）" tone="muted" />
            </View>
            <Text style={styles.readonlyText} selectable>
              {row.segmentText}
            </Text>
            <Text style={styles.hintText}>
              {row.descriptionFits
                ? '这一段会放进任务的「说明」；完整原文（含消息头）会一并留档到任务详情。'
                : '这一段太长，放不进任务「说明」：说明留空，但完整原文仍会留档到任务详情。'}
            </Text>
            {draft.deadline ? null : (
              <Text style={styles.hintText}>当前没有截止时间：保存后它不会出现在日历上，直到你补上时间。</Text>
            )}
          </View>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  note: { ...typography.caption, marginBottom: spacing.sm },
  /** 原文改过之后的醒目提示：候选已经过期，保存被拦下。 */
  staleNote: {
    ...typography.caption,
    color: colors.clay,
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  warnBox: {
    backgroundColor: colors.warnSoft,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  warnText: { ...typography.bodySoft, color: colors.warn },
  warnInline: { ...typography.caption, color: colors.warn, marginTop: spacing.xs },
  errorBox: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },
  bulkRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  row: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  rowUnselected: { backgroundColor: colors.surfaceMute, opacity: 0.72 },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  checkbox: { minHeight: MIN_TOUCH_SIZE, minWidth: MIN_TOUCH_SIZE, alignItems: 'center', justifyContent: 'center' },
  checkboxGlyph: { fontSize: 22, color: colors.primaryDark },
  rowSummary: { flex: 1 },
  rowTitle: { ...typography.body, fontWeight: '600' },
  rowMeta: { ...typography.caption, marginTop: 2 },
  rowToggle: { ...typography.caption, color: colors.primary, marginTop: spacing.xs },
  rowBody: { marginTop: spacing.md },
  hintBox: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  hintText: { ...typography.caption },
  readonlyBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: colors.surfaceSoft,
    marginBottom: spacing.md,
  },
  readonlyHead: { flexDirection: 'row', marginBottom: spacing.xs },
  readonlyText: { ...typography.bodySoft, marginBottom: spacing.xs },
  createdRow: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  createdTitle: { ...typography.body, fontWeight: '600' },
  resultLine: { ...typography.caption, marginTop: spacing.xs },
})
