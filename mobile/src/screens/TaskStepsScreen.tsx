/**
 * 任务步骤清单（原生界面）。
 *
 * 这一页回答的是：**这条任务被我拆成了哪几步、哪几步做完了。**
 *
 * 它刻意**不**做的事（授权书逐条点名）：
 * - 不接 AI、不发通知、不自动生成步骤；
 * - 不给步骤加截止时间 / 预计用时，也不把步骤变成独立的日历任务；
 * - 全部步骤做完也不会把父任务标成完成，不改它的 DDL、状态或预计用时；
 * - 不替用户保存：添加 / 编辑 / 勾选 / 删除全程零写入，只有点「保存步骤」才写库；
 * - 刷新（含页面重新聚焦）**绝不会覆盖**正在编辑的草稿。
 *
 * 界面状态由 `screens/taskStepsState.ts` 管（草稿 / 基线 / 草稿基版本 / 已知最新版本），
 * 落库由 `domain/taskStepsRepository.ts` 管：界面里没有第二份校验规则，也没有任何 SQL。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { MAX_TASK_STEPS } from '../domain/taskSteps'
import { taskStatusLabels } from '../domain/types'
import { useAppStore, type StoreStatus } from '../store/AppStore'
import { AppButton, AppTextField, Badge, EmptyState, ErrorState, LoadingState, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithSteps } from '../navigation/types'
import {
  addStep,
  applyCommitResult,
  applySavedStepsRead,
  clearSteps,
  commitFailureResult,
  createTaskStepsState,
  draftIssues,
  isDraftDirty,
  needsClearConfirm,
  needsRemoveConfirm,
  progressText,
  removeStep,
  setStepTitle,
  toggleStepDone,
  withSaving,
  type TaskStepsState,
} from './taskStepsState'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithSteps>
type Route = RouteProp<SharedTaskRoutesWithSteps, 'TaskSteps'>

type LoadMode = 'initial' | 'refresh' | 'reload'

/**
 * 生成一个**稳定的**步骤编号。
 *
 * 编号是步骤的身份证：编辑内容 / 勾选完成都不会换编号，因此顺序与「哪一步」
 * 在多次保存之间都是稳定的。这里只要求唯一且够短，不承载任何业务含义。
 */
function makeStepId(seed: number): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `s${seed.toString(36)}${random}`.slice(0, 32)
}

export function TaskStepsScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const taskId = route.params.id

  const { refresh, taskSteps } = store
  const [state, setState] = useState<TaskStepsState>(() => createTaskStepsState())
  const [loadingSteps, setLoadingSteps] = useState(true)
  /**
   * 「明确载入最新版本（丢弃草稿）」正在进行。
   *
   * 这个动作会把草稿整份换成库里的内容，所以从用户确认的那一刻起就必须
   * **同步冻结**编辑 / 增删 / 勾选 / 保存：否则用户在等待读回的几百毫秒里
   * 新打的字会被随后到达的强制覆盖悄悄吞掉。普通的后台刷新不设这个闸门
   * （它本来就不会覆盖脏草稿）。
   */
  const [reloading, setReloading] = useState(false)
  /** 同步的在途闸门：只靠 state 挡不住同一帧里的双击。 */
  const inFlightRef = useRef(false)
  /** 同步的「正在读取」闸门：让聚焦 / 就绪后的自动读取不会叠在一起。 */
  const loadingRef = useRef(false)
  /** 同步的「正在载入最新版本」闸门（`reloading` 的 ref 版本，供事件处理函数即读）。 */
  const reloadingRef = useRef(false)
  const [pendingLeaveAction, setPendingLeaveAction] = useState<Parameters<Nav['dispatch']>[0] | null>(null)
  const leaveConfirmedRef = useRef(false)
  /** 待确认的删除 / 保存前清空 / 清空草稿 / 冲突载入动作。 */
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [pendingClearExisting, setPendingClearExisting] = useState(false)
  const [pendingClear, setPendingClear] = useState(false)
  const [pendingConflictReload, setPendingConflictReload] = useState(false)

  const task = useMemo(() => store.data.tasks.find((item) => item.id === taskId) ?? null, [store.data.tasks, taskId])

  /**
   * **过期的读回不能盖掉更新的结果**。
   *
   * `loadSteps` 是异步的：重新聚焦、保存成功都会触发它，如果早先发出的那次读回
   * 晚一点才回来，它带的是旧版本的数据。这里用一个同步递增的序号做闸门：
   * 只有**最后一次**发起的读回才允许写状态，已经在途的旧读回一律丢弃；
   * 保存一开始就推进序号，因此保存期间发起的旧读回也不会把状态改回旧内容。
   */
  const readGenerationRef = useRef(0)

  const loadSteps = useCallback(
    async (mode: LoadMode): Promise<void> => {
      // 保存进行中不读：避免把旧内容铺到正在提交的状态上。
      if (inFlightRef.current) return
      /**
       * 普通刷新 / 初次读取不重入；**显式载入最新**例外：它必须能抢在
       * 一次还没回来的普通读之前执行（否则用户确认了却什么都不发生）。
       * 抢跑时推进 generation，让旧读回的 finally 与 setState 一起作废。
       */
      if (mode !== 'reload' && loadingRef.current) return
      if (mode === 'reload') {
        // 在**任何 await 之前**立起冻结闸门：确认之后新输入不会再进入草稿。
        reloadingRef.current = true
        setReloading(true)
      }
      loadingRef.current = true
      const generation = readGenerationRef.current + 1
      readGenerationRef.current = generation
      setLoadingSteps(true)
      try {
        const result = await taskSteps.loadSteps(taskId)
        if (readGenerationRef.current !== generation || inFlightRef.current) return
        setState((previous) =>
          applySavedStepsRead(
            previous,
            result.ok
              ? { ok: true, steps: result.steps, revision: result.revision, error: null, code: null }
              : { ok: false, steps: [], revision: 0, error: result.reason, code: result.code },
            { force: mode === 'reload' },
          ),
        )
      } catch (cause) {
        if (readGenerationRef.current !== generation || inFlightRef.current) return
        const message = cause instanceof Error ? cause.message : '读取步骤清单失败。'
        setState((previous) =>
          applySavedStepsRead(previous, { ok: false, steps: [], revision: 0, error: message, code: 'READ_FAILED' }),
        )
      } finally {
        // 只有「最后一次」读取收尾时才清闸门；被作废的读回不许把旗标卡在 true，
        // 也不许替更新的那次读取提前解除冻结。
        if (readGenerationRef.current === generation) {
          loadingRef.current = false
          reloadingRef.current = false
          setLoadingSteps(false)
          setReloading(false)
        }
      }
    },
    [taskId, taskSteps],
  )

  const loadRef = useRef(loadSteps)
  loadRef.current = loadSteps
  const loadedRef = useRef(false)
  loadedRef.current = state.loaded

  /**
   * 每次聚焦都刷新：既刷新任务快照（父任务可能已被删掉），也重读步骤清单。
   *
   * 用 ref 拿最新的加载函数，因此这个 effect **不会**因为函数引用变化而反复重跑
   * （那会让每次输入都触发一次无关的读库）。
   */
  useFocusEffect(
    useCallback(() => {
      void refresh()
      void loadRef.current('initial')
      return undefined
    }, [refresh]),
  )

  /**
   * 数据库刚就绪时（例如从通知直接打开这一页）补一次读取。
   * 只在状态**变成** ready 时尝试一次，失败不自动重试（用户可点页面里的重试按钮）。
   */
  const previousStatusRef = useRef<StoreStatus>(store.status)
  useEffect(() => {
    const previous = previousStatusRef.current
    previousStatusRef.current = store.status
    if (store.status !== 'ready' || previous === 'ready') return
    if (loadedRef.current || inFlightRef.current) return
    void loadRef.current('refresh')
  }, [store.status])

  /* -------------------------------- 派生状态 -------------------------------- */

  const issues = useMemo(() => draftIssues(state.draft), [state.draft])
  const dirty = isDraftDirty(state.draft, state.baseline)
  const pending = state.phase === 'saving'
  const progress = progressText(state.draft)
  const atLimit = state.draft.length >= MAX_TASK_STEPS
  /** 父任务在库里 / 界面快照里已经不存在。 */
  const parentMissing = state.readErrorCode === 'PARENT_MISSING'
  /** 库里的记录读不出来（坏 JSON / 版本不认识）：绝不拿草稿去覆盖它。 */
  const recordCorrupt = state.readErrorCode === 'CORRUPT'
  /** 所有「这一页现在不能正常用」的情形。 */
  const unavailable = parentMissing || recordCorrupt
  /** 刚才那次保存已经提交、只是随后的读回失败：内容已经写进去了，编辑区照常可用。 */
  const readbackFailed = state.phase === 'committedNoReadback' && state.readError !== null
  /** 其它读取失败（数据库 / 读取异常）：如实提示并给重试，不冒充「没有步骤」。 */
  const genericReadFailure = state.readError !== null && !recordCorrupt && !parentMissing && !readbackFailed
  const parentGone = store.status === 'ready' && task === null
  /** 能不能编辑 / 保存（初始读取完成之前 / 显式载入最新期间一律不许动）。 */
  const canEdit = state.loaded && !unavailable && !parentGone && !pending && !reloading
  const canSave = canEdit && !state.conflict && dirty && issues.ok

  /* -------------------------------- 动作 -------------------------------- */

  /** 草稿修改：保存或「载入最新」进行中一律不响应（同步闸门，不依赖禁用态）。 */
  const mutateDraft = useCallback((next: (previous: TaskStepsState) => TaskStepsState) => {
    if (inFlightRef.current || reloadingRef.current) return
    setState(next)
  }, [])

  const commit = useCallback(async () => {
    if (inFlightRef.current || reloadingRef.current) return
    if (!state.loaded || unavailable || parentGone || state.conflict) return
    if (!issues.ok) return
    inFlightRef.current = true
    /**
     * 保存开始时就把读回闸门往前推一格：这一刻之前发出的读回全部作废；
     * 同时清掉转圈 / 载入闸门（那些读回不会再有机会收尾）。
     */
    readGenerationRef.current += 1
    loadingRef.current = false
    reloadingRef.current = false
    setLoadingSteps(false)
    setReloading(false)
    setState((previous) => withSaving(previous))
    try {
      const result = await taskSteps.saveSteps({
        taskId,
        steps: state.draft.map((step) => ({ id: step.id, title: step.title, done: step.done })),
        // 乐观锁只用**草稿基版本**：后台读到的更新版本绝不会被拿来覆盖这份草稿。
        expectedRevision: state.draftBaseRevision,
      })
      setState((previous) => applyCommitResult(previous, result))
    } catch (cause) {
      setState((previous) => applyCommitResult(previous, commitFailureResult(cause)))
    } finally {
      inFlightRef.current = false
    }
  }, [
    issues.ok,
    parentGone,
    state.conflict,
    state.draft,
    state.draftBaseRevision,
    state.loaded,
    taskId,
    taskSteps,
    unavailable,
  ])

  const onSave = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current || pending) return
    if (!canSave) return
    // 把已有清单清空是显式动作：必须先确认一次（草稿原样保留）。
    if (needsClearConfirm(state) && dirty) {
      setPendingClearExisting(true)
      return
    }
    void commit()
  }, [canSave, commit, dirty, pending, state])

  const onAddStep = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current || !canEdit) return
    setState((previous) => addStep(previous, makeStepId(previous.draft.length + 1 + Math.floor(Math.random() * 36))))
  }, [canEdit])

  const onRemoveStep = useCallback(
    (id: string) => {
      if (inFlightRef.current || reloadingRef.current || !canEdit) return
      const step = state.draft.find((candidate) => candidate.id === id)
      if (!step) return
      // 有内容 / 已勾选的一步不能「一点就没了」：先问一句，取消时草稿原样保留。
      if (needsRemoveConfirm(step)) {
        setPendingRemoveId(id)
        return
      }
      setState((previous) => removeStep(previous, id))
    },
    [canEdit, state.draft],
  )

  const onRequestClear = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current || !canEdit) return
    if (state.draft.length === 0) return
    setPendingClear(true)
  }, [canEdit, state.draft.length])

  /** 冲突的唯一出路：确认后整份载入库里的最新版本（草稿会被丢弃）。 */
  const onReloadLatest = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current) return
    setPendingConflictReload(true)
  }, [])

  const confirmReloadLatest = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current) return
    setPendingConflictReload(false)
    void loadRef.current('reload')
  }, [])

  const confirmRemove = useCallback(() => {
    if (inFlightRef.current || reloadingRef.current) return
    const id = pendingRemoveId
    setPendingRemoveId(null)
    if (!id) return
    setState((previous) => removeStep(previous, id))
  }, [pendingRemoveId])

  const confirmLeave = useCallback(() => {
    const action = pendingLeaveAction
    setPendingLeaveAction(null)
    leaveConfirmedRef.current = true
    if (action) navigation.dispatch(action)
    else navigation.goBack()
  }, [navigation, pendingLeaveAction])

  /**
   * 离开守卫：有未保存改动时，任何「离开这一页」的导航动作都要先问一句，
   * 确认后**重放原来那个动作**（不是简单地 goBack，那样会丢掉返回目标）。
   * 保存进行中则直接拦住，避免写了一半被离开。
   */
  usePreventRemove(dirty || pending || reloading, ({ data }) => {
    if (leaveConfirmedRef.current) return
    if (pending || reloading) return
    setPendingLeaveAction(data.action)
  })

  /* -------------------------------- 渲染 -------------------------------- */

  const routeAvailable = Number.isSafeInteger(taskId) && taskId > 0

  if (!routeAvailable) {
    return (
      <ScreenScaffold title="步骤清单">
        <ErrorState
          message="这个页面没有拿到有效的任务编号，无法显示步骤清单。"
          onRetry={() => navigation.goBack()}
          retryLabel="返回"
        />
      </ScreenScaffold>
    )
  }

  const parentStatus = task ? taskStatusLabels[task.status] : null
  /** 保存按钮下面的说明：只在**真的**保存过之后才说「一致」。 */
  const saveNote = unavailable || parentGone
    ? '现在不能保存（见上面的说明）；你正在编辑的内容仍然保留在内存里。'
    : state.conflict
      ? '保存已暂停：这条任务的步骤在别处更新过，请先载入最新版本，或把草稿复制走。'
      : readbackFailed
        ? '刚才的内容已经保存进去了，只是这次没读回来；可以点「重新读一次」。'
        : !state.loaded
          ? state.readError
            ? '暂时读不出已保存的步骤；可以点上面的「重新读一次」。'
            : '正在读取已保存的步骤…'
          : dirty
            ? '有改动还没保存：离开这一页之前会先问你一句。'
            : state.draftBaseRevision > 0
              ? '当前内容与已保存的一致。'
              : '还没有保存过步骤。'

  const showEditor = state.loaded || state.draft.length > 0

  return (
    <>
      <ScreenScaffold
        title="任务步骤"
        subtitle={task ? `属于「${task.title}」· 步骤只是清单，不是日程` : '正在读取这条任务…'}
      >
        {store.refreshError ? (
          <SectionCard title="列表没能刷新">
            <Text style={styles.errorLine}>{store.refreshError}</Text>
            <Text style={styles.note}>
              这只影响任务列表的刷新，不代表步骤没有保存；当前页面的保存结果以下面的提示为准。重新读取即可。
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读取"
                variant="secondary"
                compact
                onPress={() => {
                  void refresh()
                  void loadRef.current('refresh')
                }}
              />
            </View>
          </SectionCard>
        ) : null}

        {store.status === 'loading' ? <LoadingState message="正在读取本机数据…" /> : null}
        {store.status === 'error' ? (
          <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
        ) : null}

        {/* 父任务已经不在了：草稿仍然留在内存里，保存会被拒绝（零写入）。 */}
        {parentGone || parentMissing ? (
          <SectionCard title="这条任务已经不在本机了" subtitle="步骤清单不会保存，也不会写入任何东西">
            <Text style={styles.errorLine}>
              它可能已经被删除。下面你正在编辑的内容仍然保留在内存里，可以先复制出去；但保存不会成功。
            </Text>
            <View style={styles.buttonRow}>
              <AppButton label="返回任务列表" variant="secondary" compact onPress={() => navigation.goBack()} />
            </View>
          </SectionCard>
        ) : null}

        {/* 库里那条记录读不出来：如实说明，且明确「没有被改动、不会被覆盖」。 */}
        {recordCorrupt ? (
          <SectionCard title="已保存的步骤读不出来" subtitle="这条记录仍然保留在本机，没有被改动">
            <Text style={styles.errorLine}>{state.readError}</Text>
            <Text style={styles.note}>
              为了不把旧内容当成新的，这里不使用它，也不会用你现在的草稿去覆盖它。
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读一次"
                variant="secondary"
                compact
                onPress={() => void loadRef.current('refresh')}
                disabled={loadingSteps || pending}
              />
            </View>
          </SectionCard>
        ) : null}

        {/* 刚才保存已经提交，只是读回失败：明确说「已保存」，只提供重试读取。 */}
        {readbackFailed ? (
          <SectionCard title="已保存但暂时无法读取" subtitle="写入已经完成，不需要再保存一次">
            <Text style={styles.errorLine}>{state.readError}</Text>
            <Text style={styles.note}>重新读一次就能看到最新的内容；如果一直读不出来，那也只是本机读取的问题。</Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读一次"
                variant="secondary"
                compact
                onPress={() => void loadRef.current('refresh')}
                disabled={loadingSteps || pending}
              />
            </View>
          </SectionCard>
        ) : null}

        {/* 其它读取失败：如实说明，并给重试；绝不冒充「还没有添加步骤」。 */}
        {genericReadFailure ? (
          <SectionCard title="步骤清单暂时读不出来" subtitle="这不代表没有步骤；这一条记录没有被改动">
            <Text style={styles.errorLine}>{state.readError}</Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读一次"
                variant="secondary"
                compact
                onPress={() => void loadRef.current('refresh')}
                disabled={loadingSteps || pending}
              />
            </View>
          </SectionCard>
        ) : null}

        {/* 脏草稿遇到更新的版本：绝不用新版本号去保存旧草稿，必须显式选择。 */}
        {state.conflict && !unavailable ? (
          <SectionCard title="这条任务的步骤在别处更新过" subtitle="应用不会用你现在的草稿去覆盖它">
            <Text style={styles.warnLine}>
              你正在编辑的内容是基于更早的一版改的。直接保存会被拒绝，所以这里先暂停保存。
            </Text>
            {reloading ? (
              <Text style={styles.note}>正在载入最新版本…载入完成前不能编辑或保存，避免刚输入的内容被覆盖。</Text>
            ) : (
              <Text style={styles.note}>
                可以点下面的按钮载入最新版本（你现在的草稿会被丢弃），或者先把草稿里的内容复制出去。
              </Text>
            )}
            <View style={styles.buttonRow}>
              <AppButton
                label={reloading ? '正在载入最新版本…' : '载入最新版本（丢弃草稿）'}
                variant="secondary"
                compact
                onPress={onReloadLatest}
                disabled={loadingSteps || pending || reloading}
                accessibilityHint="会用本机里最新的那一份替换当前草稿，当前草稿不会保存"
              />
            </View>
          </SectionCard>
        ) : null}

        {showEditor ? (
          <>
            <SectionCard title="进度" subtitle={task ? `父任务当前状态：${parentStatus}` : undefined}>
              <View style={styles.badgeRow}>
                <Badge
                  text={progress}
                  tone={state.draft.length > 0 && !state.draft.some((step) => !step.done) ? 'success' : 'primary'}
                />
                {!state.loaded ? null : dirty ? (
                  <Badge text="有未保存的改动" tone="clay" />
                ) : state.phase === 'committedNoReadback' ? (
                  <Badge text="已保存（未读回）" tone="muted" />
                ) : state.draftBaseRevision > 0 ? (
                  <Badge text="已保存" tone="muted" />
                ) : null}
                {state.conflict ? <Badge text="别处有更新" tone="clay" /> : null}
              </View>
              <Text style={styles.note}>
                步骤全部做完也不会自动把父任务标成完成，也不改它的截止时间或预计用时；父任务的状态只由你在任务页自己改。
              </Text>
            </SectionCard>

            <SectionCard
              title="步骤清单"
              subtitle={`最多 ${MAX_TASK_STEPS} 步；每一步 1–120 个字。可以随时改，只有点「保存步骤」才会写进本机`}
            >
              {!state.loaded && loadingSteps ? <LoadingState message="正在读取步骤…" /> : null}
              {state.loaded && state.draft.length === 0 ? (
                <EmptyState title="尚未添加步骤" description="把这条任务拆成几小步，做的时候逐条勾掉。" />
              ) : null}

              {state.draft.map((step, index) => (
                <View key={step.id} style={styles.stepRow}>
                  <Pressable
                    onPress={() => mutateDraft((previous) => toggleStepDone(previous, step.id))}
                    disabled={!canEdit}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: step.done, disabled: !canEdit }}
                    accessibilityLabel={`第 ${index + 1} 步：${step.title.trim().length > 0 ? step.title : '（还没写内容）'}`}
                    style={({ pressed }) => [styles.checkbox, pressed && canEdit && styles.pressed]}
                  >
                    <Text style={styles.checkboxGlyph}>{step.done ? '☑' : '☐'}</Text>
                  </Pressable>
                  <View style={styles.stepField}>
                    <AppTextField
                      label={`第 ${index + 1} 步`}
                      value={step.title}
                      onChangeText={(text) => mutateDraft((previous) => setStepTitle(previous, step.id, text))}
                      placeholder="例如：先看完第 3 章的例题"
                      maxLength={120}
                      editable={canEdit}
                      error={issues.fieldErrors.get(step.id) ?? null}
                      accessibilityLabel={`第 ${index + 1} 步的内容`}
                    />
                  </View>
                  <AppButton
                    label="删除"
                    variant="ghost"
                    compact
                    onPress={() => onRemoveStep(step.id)}
                    disabled={!canEdit}
                    accessibilityLabel={`删除第 ${index + 1} 步`}
                  />
                </View>
              ))}

              {issues.formErrors.length > 0 ? (
                <View accessibilityRole="alert">
                  {issues.formErrors.map((message) => (
                    <Text key={message} style={styles.errorLine}>
                      {message}
                    </Text>
                  ))}
                </View>
              ) : null}

              <View style={styles.buttonRow}>
                <AppButton
                  label={atLimit ? `已达到 ${MAX_TASK_STEPS} 步上限` : '添加一步'}
                  variant="secondary"
                  compact
                  onPress={onAddStep}
                  disabled={!canEdit || atLimit}
                  accessibilityLabel="添加一步"
                />
                <AppButton
                  label="清空全部步骤"
                  variant="ghost"
                  compact
                  onPress={onRequestClear}
                  disabled={!canEdit || state.draft.length === 0}
                  accessibilityLabel="清空全部步骤"
                  accessibilityHint="清空后需要点保存步骤才会写进本机"
                />
              </View>
            </SectionCard>

            <SectionCard title="保存" subtitle="保存会写入整份清单（=你现在看到的内容）">
              <View style={styles.buttonRow}>
                <AppButton
                  label="保存步骤"
                  onPress={onSave}
                  loading={pending}
                  disabled={!canSave}
                  accessibilityLabel="保存步骤清单"
                  accessibilityHint="把整份清单写入本机；不会改动任务的截止时间、状态或预计用时"
                />
              </View>
              <Text style={styles.note}>{saveNote}</Text>
            </SectionCard>

            {state.notice ? (
              <SectionCard title="上一次操作的结果">
                <Text style={state.notice.tone === 'success' ? styles.note : styles.errorLine}>{state.notice.text}</Text>
                {state.phase === 'rejected' && !state.conflict ? (
                  <View style={styles.buttonRow}>
                    <AppButton
                      label="重新读取已保存的步骤"
                      variant="secondary"
                      compact
                      onPress={() => void loadRef.current('refresh')}
                      disabled={loadingSteps || pending}
                      accessibilityHint="读取本机里这条任务最新的步骤；你还没保存的改动会保留"
                    />
                  </View>
                ) : null}
              </SectionCard>
            ) : null}
          </>
        ) : store.status === 'ready' && loadingSteps ? (
          <LoadingState message="正在读取步骤…" />
        ) : null}
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingRemoveId !== null && !pending}
        title="删除这一步？"
        message="这一步已经有内容或已经勾选过，删掉之后草稿里就没有它了。"
        details={['还没有保存：点「取消」会原样保留这一步。', '保存后本机里那一份才会跟着变。']}
        confirmLabel="删除这一步"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemoveId(null)}
      />

      <ConfirmDialog
        visible={pendingClearExisting && !pending}
        title="把步骤全部清空？"
        message="这条任务本来已经有保存好的步骤，现在草稿里一条都不剩。"
        details={['点「保存步骤」之后本机里的清单才会变成空的。', '父任务本身不会被删除，也不会被改动。']}
        confirmLabel="清空并保存"
        danger
        onConfirm={() => {
          setPendingClearExisting(false)
          void commit()
        }}
        onCancel={() => setPendingClearExisting(false)}
      />

      <ConfirmDialog
        visible={pendingClear && !pending}
        title="清空正在编辑的步骤？"
        message="草稿里的所有步骤都会被移除（本机里已保存的那一份暂时不变）。"
        details={['要真正写进本机，还要再点一次「保存步骤」。', '点「取消」会原样保留现在的草稿。']}
        confirmLabel="清空草稿"
        danger
        onConfirm={() => {
          if (inFlightRef.current || reloadingRef.current) return
          setPendingClear(false)
          setState((previous) => clearSteps(previous))
        }}
        onCancel={() => setPendingClear(false)}
      />

      <ConfirmDialog
        visible={pendingConflictReload && !pending}
        title="载入最新版本并丢弃草稿？"
        message="最近一次保存到本机的步骤会替换你现在编辑的内容。"
        details={['你现在的草稿不会保存，也不会覆盖别处的那一份。', '如果只想保留自己的内容，请先点「取消」把草稿复制出去。']}
        confirmLabel="载入最新版本"
        danger
        onConfirm={confirmReloadLatest}
        onCancel={() => setPendingConflictReload(false)}
      />

      <ConfirmDialog
        visible={pendingLeaveAction !== null && !pending}
        title="离开并丢弃这些改动？"
        message="步骤清单还没有保存。"
        details={['点「保存步骤」会把它写进本机。', '离开不会影响已经保存过的那一份。']}
        confirmLabel="丢弃并离开"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeaveAction(null)}
      />

      {state.notice ? <Toast text={state.notice.text} tone={state.notice.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  stepField: { flex: 1 },
  checkbox: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center' },
  checkboxGlyph: { fontSize: 22, color: colors.primaryDark },
  pressed: { opacity: 0.6 },
  note: { ...typography.caption, marginTop: spacing.xs },
  warnLine: { ...typography.caption, color: colors.clay, marginTop: spacing.xs, fontWeight: '600' },
  errorLine: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },
})
