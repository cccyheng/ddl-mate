/**
 * 任务原图（原生界面）。
 *
 * 这一页回答的是：**这条任务关联了哪些原图？** 以及从**既有截图库**里显式挑一张，
 * 或直接从手机相册 / 相机放一张新的截图进来。
 *
 * 边界（逐条对应授权书）：
 * - 只展示真实归档路径（`archived_path`），绝不用临时的 `original_uri` 冒充原图；
 * - 添加是**一张一张**的显式动作，没有自动选择、没有批量待定草稿；
 * - 直接从相册 / 相机添加时复用 `AppStore.archiveOriginal` 的既有归档路径：
 *   先保存到全局截图库，再显式关联到当前任务；选择取消 / 卸载 / 恢复代次变化
 *   都不会把旧图挂到另一条任务上；
 * - 解除关联必须二次确认，并且只删除本模块的 `MANUAL_TASK_PHOTO` 引用；
 *   原图、OCR 结果、课程 / 课表 / 其它任务 / 历史引用全部保留；
 * - 历史非手动关联可以只读展示，但绝不会被标成可解除；
 * - 本页不识别、不上传、不调用 OCR；
 * - 读取在聚焦时刷新；迟到的旧读回不会盖掉当前任务；
 * - 写入期间有同步闸门，双击不会写两次；提交后刷新失败只说「已保存」，
 *   只给「重新读取列表」，绝不引导用户重复添加 / 解除。
 *
 * 生命周期与错误语义在 `taskPhotosController.ts` 里，不依赖 React，可单测。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import type { TaskPhoto, TaskPhotoAttempt } from '../domain/taskPhotoRepository'
import { capturePhotoFromCamera, pickPhotoFromLibrary } from '../domain/photoPicker'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { AppButton, Badge, EmptyState, ErrorState, LoadingState, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { ScreenshotViewer } from '../ui/ScreenshotViewer'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { SharedTaskRoutesWithPhotos } from '../navigation/types'
import {
  createInitialTaskPhotosState,
  createTaskPhotosOperation,
  TASK_PHOTO_CANDIDATE_LIMIT,
  type TaskPhotosOperation,
  type TaskPhotosState,
} from './taskPhotosController'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithPhotos>
type Route = RouteProp<SharedTaskRoutesWithPhotos, 'TaskPhotos'>

const SOURCE_LABEL: Record<string, string> = {
  LIBRARY: '相册选择',
  CAMERA: '相机拍摄',
  ARCHIVE: '从电脑恢复',
  OTHER: '其它',
}

const STATUS_LABEL: Record<string, { text: string; tone: 'primary' | 'warn' | 'muted' }> = {
  ARCHIVED: { text: '已保存原图', tone: 'primary' },
  UPLOADING: { text: '识别中', tone: 'muted' },
  SUCCEEDED: { text: '识别完成', tone: 'primary' },
  FAILED: { text: '识别失败（原图已保留）', tone: 'warn' },
  CANCELLED: { text: '已取消（原图已保留）', tone: 'warn' },
  ARCHIVE_FAILED: { text: '没能保存到本机', tone: 'warn' },
}

function formatTime(iso: string): string {
  const text = String(iso ?? '')
  if (text.length < 16) return text || '时间未知'
  return `${text.slice(0, 10)} ${text.slice(11, 16)}`.replace('T', ' ')
}

function describeBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '大小未知'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function photoLabel(attempt: TaskPhotoAttempt): string {
  return `#${attempt.id} · ${SOURCE_LABEL[attempt.source] ?? attempt.source}`
}

/**
 * 缩略图：打不开时如实显示「图片打不开」并给重试；没有归档路径时显示「无原图」。
 * 绝不把临时 URI 或空加载圈当成一张存在的图片。
 */
function PhotoThumb({
  attempt,
  onOpen,
  accessibilityLabel,
}: {
  attempt: Pick<TaskPhotoAttempt, 'id' | 'archivedPath'>
  onOpen: () => void
  accessibilityLabel: string
}): React.ReactElement {
  const [failed, setFailed] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const path = attempt.archivedPath

  useEffect(() => {
    setFailed(false)
    setReloadToken(0)
  }, [attempt.id, path])

  if (!path) {
    return (
      <View style={styles.thumbBox}>
        <Text style={styles.thumbMissing}>无原图</Text>
      </View>
    )
  }
  if (failed) {
    return (
      <View style={styles.thumbBox} accessibilityRole="alert">
        <Text style={styles.thumbMissing}>图片打不开</Text>
        <Pressable
          onPress={() => {
            setFailed(false)
            setReloadToken((value) => value + 1)
          }}
          style={styles.thumbRetry}
          accessibilityRole="button"
          accessibilityLabel={`重新加载第 ${attempt.id} 条原图`}
        >
          <Text style={styles.thumbRetryText}>重试</Text>
        </Pressable>
      </View>
    )
  }
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="imagebutton"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="打开全屏，可双指缩放"
      style={({ pressed }) => [styles.thumbBox, pressed && styles.pressed]}
    >
      <Image
        key={`${attempt.id}:${reloadToken}`}
        source={{ uri: path }}
        style={styles.thumb}
        resizeMode="contain"
        onError={() => setFailed(true)}
      />
    </Pressable>
  )
}

function useTaskPhotosController(taskId: number): {
  controller: TaskPhotosOperation
  state: TaskPhotosState
} {
  const store = useAppStore()
  const storeRef = useRef<AppStoreValue>(store)
  storeRef.current = store

  const controllerRef = useRef<TaskPhotosOperation | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createTaskPhotosOperation({
      taskId,
      state: createInitialTaskPhotosState(taskId),
      listPhotos: (id) => storeRef.current.taskPhotos.listPhotos(id),
      listAddable: (id, limit) => storeRef.current.taskPhotos.listAddable(id, limit),
      attach: (id, attemptId) => storeRef.current.taskPhotos.attachPhoto(id, attemptId),
      detach: (id, attemptId) => storeRef.current.taskPhotos.detachPhoto(id, attemptId),
      pickFromLibrary: pickPhotoFromLibrary,
      captureFromCamera: capturePhotoFromCamera,
      archiveOriginal: (uri, source, attemptSource) =>
        storeRef.current.archiveOriginal(uri, source, attemptSource),
      getRestoreEpoch: () => storeRef.current.restoreEpoch,
      canWriteNow: () => storeRef.current.backup.gate === 'idle',
      candidateLimit: TASK_PHOTO_CANDIDATE_LIMIT,
    })
  }
  const controller = controllerRef.current
  const [state, setState] = useState<TaskPhotosState>(() => controller.getState())

  useEffect(() => {
    // 与 PhotoImportScreen / PhotoLibraryScreen 同一套生命周期：
    // StrictMode / Fast Refresh 的 setup → cleanup → setup 不能把控制器永久废掉。
    // 先激活（作废旧读回 / 旧写入回调、清 busy / 旧快照），再订阅并补一次新鲜读取。
    controller.activate()
    const unsubscribe = controller.subscribe(() => setState(controller.getState()))
    setState(controller.getState())
    if (storeRef.current.status === 'ready') void controller.refresh()
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  // 路由参数换成另一条任务时：重置状态并重新读取；旧读回由控制器作废。
  useEffect(() => {
    controller.setTaskId(taskId)
  }, [controller, taskId])

  return { controller, state }
}

export function TaskPhotosScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const taskId = route.params.id

  const routeAvailable = Number.isSafeInteger(taskId) && taskId > 0
  const { controller, state } = useTaskPhotosController(routeAvailable ? taskId : 0)
  const [viewing, setViewing] = useState<TaskPhotoAttempt | null>(null)
  const [pendingDetach, setPendingDetach] = useState<TaskPhoto | null>(null)

  const task = useMemo(() => store.data.tasks.find((item) => item.id === taskId) ?? null, [store.data.tasks, taskId])

  useFocusEffect(
    useCallback(() => {
      // 数据库还没就绪时不要读：否则「仓库还没准备好」会被误当成「任务不在」。
      if (store.status !== 'ready') return undefined
      void store.refresh()
      void controller.refresh()
      return undefined
    }, [controller, store.refresh, store.status]),
  )

  // 任务切换 / 离开时关掉旧任务的全屏原图。
  useEffect(() => {
    setViewing(null)
    setPendingDetach(null)
  }, [taskId])

  const canWrite =
    state.loaded &&
    state.taskExists &&
    !state.busy &&
    !state.loading &&
    state.loadError === null &&
    state.staleAfterCommit === null &&
    state.commitRefreshWarning === null &&
    store.refreshError === null &&
    store.backup.gate === 'idle' &&
    routeAvailable

  const addBusy = state.busyAction === 'add'
  const addLabel =
    state.addPhase === 'picking'
      ? '等待选择…'
      : state.addPhase === 'saving'
        ? '正在保存到截图库…'
        : state.addPhase === 'attaching'
          ? '正在关联…'
          : '从相册添加截图'

  /** 重新读取本页列表 + store 的任务快照；只读动作，绝不写入。 */
  const refreshAll = useCallback(() => {
    void store.refresh()
    void controller.refresh()
  }, [controller, store.refresh])

  const onConfirmDetach = useCallback(() => {
    const target = pendingDetach
    setPendingDetach(null)
    if (target) void controller.detach(target.attempt.id)
  }, [controller, pendingDetach])

  if (!routeAvailable) {
    return (
      <ScreenScaffold title="任务原图">
        <ErrorState
          message="这个页面没有拿到有效的任务编号，无法显示任务原图。"
          onRetry={() => navigation.goBack()}
          retryLabel="返回"
        />
      </ScreenScaffold>
    )
  }

  if (store.status === 'ready' && state.loaded && !state.taskExists) {
    return (
      <ScreenScaffold title="任务原图" subtitle={`任务 #${taskId}`}>
        <EmptyState
          title="这条任务已经不在本机了"
          description="它可能已经被删除。这里不会再显示或写入任何关联；原图与其它任务的历史关联仍然保留在截图库。"
          actionLabel="返回任务详情"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  return (
    <>
      <ScreenScaffold
        title="任务原图"
        subtitle={
          task
            ? `属于「${task.title}」· 原图仍保存在截图库`
            : `任务 #${taskId} · 原图仍保存在截图库`
        }
      >
        {store.status === 'error' ? (
          <ErrorState message={store.error ?? '本机数据读取失败。'} onRetry={() => void store.retryBootstrap()} />
        ) : null}

        {store.refreshError ? (
          <SectionCard title="任务列表没能刷新" subtitle="这不代表原图关联没有保存">
            <Text style={styles.warnLine}>{store.refreshError}</Text>
            <Text style={styles.caption}>
              这只影响任务标题 / 列表的刷新，不代表原图关联没有保存；重新读取即可。
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读取"
                onPress={refreshAll}
                variant="secondary"
                compact
                disabled={state.busy || state.loading}
                accessibilityLabel="重新读取任务列表"
              />
            </View>
          </SectionCard>
        ) : null}

        {store.status === 'loading' || (!state.loaded && state.loading) ? (
          <LoadingState message="正在读取这条任务的原图…" />
        ) : null}

        {state.staleAfterCommit !== null ? (
          <SectionCard title="这次操作已经保存" subtitle="只差把列表重新读出来">
            <Text style={styles.warnLine} accessibilityRole="alert">
              {state.staleAfterCommit}
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读取列表"
                onPress={refreshAll}
                variant="secondary"
                compact
                disabled={state.loading || state.busy}
                accessibilityLabel="重新读取任务原图列表"
              />
            </View>
          </SectionCard>
        ) : null}

        {state.commitRefreshWarning !== null ? (
          <SectionCard title="关联已经保存" subtitle="任务列表刷新失败，不需要重新添加 / 解除">
            <Text style={styles.warnLine} accessibilityRole="alert">
              {state.commitRefreshWarning}
            </Text>
            <Text style={styles.caption}>
              写入已经完成；这里只差把列表重新读出来。不要重复添加或解除。
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读取"
                onPress={refreshAll}
                variant="secondary"
                compact
                disabled={state.loading || state.busy}
                accessibilityLabel="重新读取任务原图列表与任务列表"
              />
            </View>
          </SectionCard>
        ) : null}

        {state.loadError !== null && state.staleAfterCommit === null ? (
          <SectionCard title="任务原图暂时读不出来" subtitle="这不代表没有关联；已有的图片和关联没有被改动">
            <Text style={styles.errorLine} accessibilityRole="alert">
              {state.loadError}
            </Text>
            <View style={styles.buttonRow}>
              <AppButton
                label="重新读取"
                onPress={refreshAll}
                variant="secondary"
                compact
                disabled={state.loading || state.busy}
                accessibilityLabel="重新读取任务原图"
              />
            </View>
          </SectionCard>
        ) : null}

        {state.loaded && state.loadError === null ? (
          <>
            <SectionCard
              title="直接放一张截图"
              subtitle="选择照片或拍照，保存到这条任务，也能在截图库中查看。"
            >
              <Text style={styles.caption}>不会识别，也不会上传。</Text>
              <View style={styles.buttonRow}>
                <AppButton
                  label={addBusy ? addLabel : '从相册添加截图'}
                  onPress={() => void controller.addFromLibrary()}
                  variant="secondary"
                  loading={addBusy && state.addPhase !== 'attaching'}
                  disabled={!canWrite || state.busy}
                  accessibilityLabel="从手机相册选一张截图，保存到这条任务，也能在截图库中查看"
                  accessibilityHint="只在本机保存原图，并添加到这条任务；不会上传到电脑或第三方"
                />
                <AppButton
                  label={addBusy && state.addPhase === 'picking' ? '等待选择…' : '拍照添加截图'}
                  onPress={() => void controller.addFromCamera()}
                  variant="ghost"
                  loading={addBusy && state.addPhase === 'picking'}
                  disabled={!canWrite || state.busy}
                  accessibilityLabel="拍一张截图，保存到这条任务，也能在截图库中查看"
                  accessibilityHint="先保存到本机截图库，再添加到这条任务；不会识别或上传"
                />
              </View>
              {addBusy && state.addPhase === 'attaching' ? (
                <Text style={styles.caption} accessibilityRole="alert">
                  图片已保存到截图库，正在添加到这条任务…
                </Text>
              ) : null}
              {!canWrite && state.staleAfterCommit === null && store.backup.gate !== 'idle' ? (
                <Text style={styles.caption}>现在有备份 / 导入动作正在进行，结束之后才能添加截图。</Text>
              ) : null}
            </SectionCard>

            <SectionCard
              title="已关联的原图"
              subtitle={
                state.photos.length > 0
                  ? `共 ${state.photos.length} 张 · 点缩略图全屏缩放查看`
                  : '这里只显示真实保存在截图库里的原图'
              }
            >
              {state.photos.length === 0 ? (
                <EmptyState
                  title="还没有关联原图"
                  description="可以从下面的截图库里挑一张；也可以先去「课程 → 截图库」保存一张通知或课表截图。"
                />
              ) : (
                state.photos.map((photo) => {
                  const attempt = photo.attempt
                  const status = STATUS_LABEL[attempt.status] ?? { text: attempt.status, tone: 'muted' as const }
                  const detaching =
                    state.busy && state.busyAction === 'detach' && state.busyAttemptId === attempt.id
                  return (
                    <View key={attempt.id} style={styles.row}>
                      <PhotoThumb
                        attempt={attempt}
                        onOpen={() => setViewing(attempt)}
                        accessibilityLabel={`查看第 ${attempt.id} 条关联原图`}
                      />
                      <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>{photoLabel(attempt)}</Text>
                        <Text style={styles.caption}>
                          {formatTime(attempt.capturedAt)} · {describeBytes(attempt.byteLength)}
                          {attempt.width && attempt.height ? ` · ${attempt.width}×${attempt.height}` : ''}
                        </Text>
                        <View style={styles.badgeRow}>
                          {photo.manual ? (
                            <Badge text="手动关联" tone="primary" />
                          ) : (
                            <Badge text="历史关联（只读）" tone="muted" />
                          )}
                          <Badge text={status.text} tone={status.tone} />
                        </View>
                        {photo.otherRelations.length > 0 ? (
                          <Text style={styles.caption}>
                            这张图还留着其它历史关联，不会在这里被改动。
                          </Text>
                        ) : null}
                        {!attempt.archivedPath ? (
                          <Text style={styles.warnLine}>
                            这一条没有可查看的原图（当初没有保存成功），不能显示成一张存在的图片。
                          </Text>
                        ) : null}
                        {!photo.manual ? (
                          <Text style={styles.caption}>
                            这张图不是在本页添加的，所以这里只能查看，不能解除。
                          </Text>
                        ) : null}
                        <View style={styles.actions}>
                          {attempt.archivedPath ? (
                            <AppButton
                              label="全屏查看"
                              onPress={() => setViewing(attempt)}
                              variant="ghost"
                              compact
                              accessibilityLabel={`全屏查看第 ${attempt.id} 条关联原图`}
                            />
                          ) : null}
                          {photo.manual ? (
                            <AppButton
                              label={detaching ? '正在解除…' : '解除关联'}
                              onPress={() => setPendingDetach(photo)}
                              variant="ghost"
                              compact
                              loading={detaching}
                              disabled={!canWrite || detaching}
                              accessibilityLabel={`解除第 ${attempt.id} 条原图与这条任务的关联`}
                              accessibilityHint="只删除这条任务的手动关联；原图仍保留在截图库"
                            />
                          ) : null}
                        </View>
                      </View>
                    </View>
                  )
                })
              )}
            </SectionCard>

            <SectionCard
              title="从截图库添加"
              subtitle={`最多显示 ${TASK_PHOTO_CANDIDATE_LIMIT} 张最近保存、且还没有手动关联到这条任务的原图；一次只添加一张，点「添加」才会写入。`}
            >
              {state.candidates.length === 0 ? (
                <EmptyState
                  title="没有可添加的原图"
                  description="截图库为空，或最近保存的原图都已经手动关联到这条任务。可以先去「课程 → 截图库」保存更多截图。"
                />
              ) : (
                state.candidates.map((attempt) => {
                  const status = STATUS_LABEL[attempt.status] ?? { text: attempt.status, tone: 'muted' as const }
                  const adding =
                    state.busy && state.busyAction === 'attach' && state.busyAttemptId === attempt.id
                  return (
                    <View key={attempt.id} style={styles.row}>
                      <PhotoThumb
                        attempt={attempt}
                        onOpen={() => setViewing(attempt)}
                        accessibilityLabel={`预览第 ${attempt.id} 条可添加原图`}
                      />
                      <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>{photoLabel(attempt)}</Text>
                        <Text style={styles.caption}>
                          {formatTime(attempt.capturedAt)} · {describeBytes(attempt.byteLength)}
                        </Text>
                        <View style={styles.badgeRow}>
                          <Badge text={status.text} tone={status.tone} />
                        </View>
                        <View style={styles.actions}>
                          {attempt.archivedPath ? (
                            <AppButton
                              label="预览"
                              onPress={() => setViewing(attempt)}
                              variant="ghost"
                              compact
                              accessibilityLabel={`预览第 ${attempt.id} 条原图`}
                            />
                          ) : null}
                          <AppButton
                            label={adding ? '正在添加…' : '添加'}
                            onPress={() => void controller.attach(attempt.id)}
                            variant="secondary"
                            compact
                            loading={adding}
                            disabled={!canWrite || adding}
                            accessibilityLabel={`把第 ${attempt.id} 条原图添加到这条任务`}
                            accessibilityHint="只会新增一条任务原图关联，不会改动原图或任务内容"
                          />
                        </View>
                      </View>
                    </View>
                  )
                })
              )}
            </SectionCard>

            <SectionCard title="说明">
              <Text style={styles.caption}>· 从截图库挑一张时，只会把这张图加到这条任务；直接从相册 / 相机添加时，会先把图片保存进截图库，再放到这条任务上。</Text>
              <Text style={styles.caption}>
                · 解除关联只影响这条任务；原图仍保留在截图库，其它任务、课程与历史识别结果不受影响。
              </Text>
              <Text style={styles.caption}>· 同一张原图可以分别关联到多条任务；这里没有自动挑选，也没有批量待定选择。</Text>
              <Text style={styles.caption}>· 这一页不上传、不识别，也不会改动任务的截止时间或状态。</Text>
              {!canWrite && state.staleAfterCommit === null ? (
                <Text style={styles.caption}>· 现在不能写入；请先按上面的提示重新读取，列表恢复后按钮才会重新可用。</Text>
              ) : null}
            </SectionCard>
          </>
        ) : null}
      </ScreenScaffold>

      <ScreenshotViewer
        photo={viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `#${viewing.id} · ${formatTime(viewing.capturedAt)}` : ''}
        footerNote="这里显示的是截图库里的原图；可以双指缩放查看细节。"
        onRetry={() => {
          setViewing(null)
          refreshAll()
        }}
      />

      <ConfirmDialog
        visible={pendingDetach !== null && !state.busy}
        title="解除这条任务与原图的关联？"
        message="只会去掉这条任务上由你手动添加的那一条关联。"
        details={[
          '只解除这条任务的关联，原图仍保留在截图库。',
          '其它任务、课程与历史识别结果里的关联不会被改动。',
          '这条任务本身不会被删除。',
        ]}
        confirmLabel="解除关联"
        danger
        busy={state.busy}
        onConfirm={onConfirmDetach}
        onCancel={() => setPendingDetach(null)}
      />

      {state.notice ? <Toast text={state.notice.text} tone={state.notice.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  thumbBox: {
    width: 88,
    height: 88,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumb: { width: '100%', height: '100%' },
  thumbMissing: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  thumbRetry: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  thumbRetryText: { ...typography.caption, color: colors.primary, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption, marginTop: 2 },
  warnLine: { ...typography.caption, color: colors.warn, marginTop: 2 },
  errorLine: { ...typography.caption, color: colors.clay, marginTop: 2 },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
})
