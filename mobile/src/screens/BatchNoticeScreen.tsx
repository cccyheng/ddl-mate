/**
 * 「批量识别通知截图」原生页（最多 8 张，一张一张识别，每张分别核对并保存任务）。
 *
 * 边界（逐条对应授权书）：
 * - 只从**相册**多选（`allowsMultipleSelection` / `selectionLimit` / `orderedSelection`），
 *   不用相机；选完**只归档原图，不自动识别**；
 * - 一次最多 8 张；系统返回超过 8 张时整次拒绝并显示说明，绝不静默丢弃；
 * - 只有显式点「识别待处理图片」才按顺序识别 pending / failed / cancelled，
 *   一次只有一个本地 OCR 请求；失败一张不影响其它张；
 * - 取消 / 换批 / 离开都会保留已经完成的结果与用户手改文字（换批 / 离开前明确确认）；
 * - 每张图单独编辑文字，单独 `push` 一个**全新**的既有 NoticeImport；
 *   任务只能在那边由用户核对并保存。本页不写任何任务，也不产生合并成一大段的原文；
 * - 原图属于全局截图库；本页不声称自动把图片关联到任务，也不删除任何照片。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { recognizeNoticeImage } from '../domain/noticeOcrClient'
import { preparePhotoForUpload } from '../domain/photoFiles'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { AppButton, AppTextField, Badge, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { ScreenshotViewer } from '../ui/ScreenshotViewer'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography, type Tone } from '../ui/theme'
import type { TaskStackParamList } from '../navigation/types'
import {
  BATCH_NOTICE_MAX_IMAGES,
  BATCH_NOTICE_MAX_TEXT_CHARS,
  batchNoticeProgress,
  batchNoticeTextAdoption,
  createBatchNoticeOperation,
  createInitialBatchNoticeState,
  type BatchNoticeItem,
  type BatchNoticeItemStatus,
  type BatchNoticeOperation,
  type BatchNoticePickResult,
  type BatchNoticeStartResult,
  type BatchNoticeState,
} from './batchNoticeController'

type Nav = NativeStackNavigationProp<TaskStackParamList>

/** 父级 Tab 导航的最小形状：设置 / 截图库在既有的「课程」栈里。 */
interface TabNavigatorLike {
  navigate: (name: 'Courses', params: { screen: 'CompanionSettings' | 'PhotoLibrary'; params?: object; initial: false }) => void
}

function openCoursesScreen(
  navigation: Nav,
  screen: 'CompanionSettings' | 'PhotoLibrary',
  params?: object,
): void {
  const parent = navigation.getParent() as unknown as TabNavigatorLike | undefined
  if (parent && typeof parent.navigate === 'function') parent.navigate('Courses', { screen, params, initial: false })
}

const EMPTY_STATE = createInitialBatchNoticeState()

/** 本批多选：安装版的 expo-image-picker 类型里确实有这三个选项（见 ImagePicker.types.d.ts）。 */
async function pickNoticeScreenshots(): Promise<BatchNoticePickResult> {
  const ImagePicker = await import('expo-image-picker')
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    return {
      status: 'permission',
      canAskAgain: permission.canAskAgain,
      message: '还没有允许访问相册。请在系统提示里允许，或到 iOS「设置 → Expo Go → 照片」打开后重试。',
    }
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: BATCH_NOTICE_MAX_IMAGES,
    orderedSelection: true,
    quality: 1,
    allowsEditing: false,
  })
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' }

  const assets: Array<{ uri: string; source: { width: number; height: number; mimeType: string | null } }> = []
  for (let index = 0; index < result.assets.length; index += 1) {
    const asset = result.assets[index]!
    // 系统没给 URI 时不能悄悄跳过这一张：整次选择如实报错，上一批保持不动。
    if (typeof asset.uri !== 'string' || asset.uri.length === 0) {
      return { status: 'error', message: `系统没有返回第 ${index + 1} 张图片的内容，请重新选择。` }
    }
    assets.push({
      uri: asset.uri,
      source: { width: asset.width, height: asset.height, mimeType: asset.mimeType ?? null },
    })
  }
  return { status: 'picked', assets }
}

const ITEM_STATUS: Record<BatchNoticeItemStatus, { label: string; tone: Tone }> = {
  pending: { label: '还没识别', tone: 'muted' },
  running: { label: '正在识别', tone: 'primary' },
  success: { label: '识别完成', tone: 'primary' },
  empty: { label: '没有读到文字', tone: 'warn' },
  failed: { label: '识别失败', tone: 'clay' },
  cancelled: { label: '已取消', tone: 'warn' },
}

function archiveLabel(item: BatchNoticeItem): { label: string; tone: Tone } {
  if (item.archiveStatus === 'archived') {
    return {
      label: item.archivedAttemptId ? `原图已保存 #${item.archivedAttemptId}` : '原图已保存',
      tone: 'primary',
    }
  }
  if (item.archiveStatus === 'archiving') return { label: '正在保存原图', tone: 'muted' }
  if (item.archiveStatus === 'failed') return { label: '原图没保存', tone: 'clay' }
  return { label: '原图待保存', tone: 'warn' }
}

function itemSummary(item: BatchNoticeItem): string {
  if (item.status === 'pending') return '还没识别；点下面的「识别待处理图片」才会开始。'
  if (item.status === 'running') return '正在把这一张送到你自己电脑上识别文字…'
  if (item.status === 'success') return `已识别 ${item.text.length} 字，可以展开核对。`
  if (item.status === 'empty') {
    return item.text.trim().length > 0
      ? '这次没有读到文字；你已经手动补了字，可以核对。'
      : '这张图里没有读到文字；可以手动补字，或重试这张图。'
  }
  if (item.status === 'cancelled') return '这次识别已取消；已完成的其它图不受影响，可以重试这张。'
  return item.error?.message ?? '这次识别没有成功；可以重试这张图。'
}

type PendingReplace =
  | { kind: 'pick' }
  | { kind: 'run' }
  | { kind: 'retry'; itemId: string; index: number }

export function BatchNoticeScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [state, setState] = useState<BatchNoticeState>(EMPTY_STATE)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const [viewingItemId, setViewingItemId] = useState<string | null>(null)
  const [diagnosticsItemId, setDiagnosticsItemId] = useState<string | null>(null)
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null)
  const [pendingLeave, setPendingLeave] = useState<{ action: Parameters<Nav['dispatch']>[0] | null } | null>(null)
  const confirmedLeaveRef = useRef(false)

  /** 控制器只建一次：跨渲染保持 generation / 队列 / abort。 */
  const storeRef = useRef<AppStoreValue>(store)
  storeRef.current = store
  const controllerRef = useRef<BatchNoticeOperation | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createBatchNoticeOperation({
      state: EMPTY_STATE,
      pickFromLibrary: pickNoticeScreenshots,
      preparePhoto: async (uri, source) => {
        const prepared = await preparePhotoForUpload(uri, { source })
        return { base64: prepared.base64, mimeType: prepared.mimeType }
      },
      archiveOriginal: (uri, source) => storeRef.current.archiveOriginal(uri, source, 'LIBRARY'),
      // 归档端口即使只回 attemptId，也用只读截图库读回真正落盘的路径；
      // 绝不把相册临时 URI 当成「已保存原图」。
      resolveArchivedPath: (attemptId) => storeRef.current.screenshotLibrary.getAttempt(attemptId),
      recognize: (endpoint, options) => recognizeNoticeImage(endpoint, options),
      recordResult: async (input) => {
        await storeRef.current.recordScreenshotResult({
          attemptId: input.attemptId,
          status: input.status,
          rawText: input.rawText,
          // 通知文字不是课表候选：不传 response，避免写进假的 layout / week / candidates。
          requestId: input.requestId ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          warnings: input.warnings ?? null,
          durationMs: input.durationMs ?? null,
          image: input.image ?? null,
        })
      },
      getEndpoint: () => storeRef.current.ocrEndpoint ?? null,
      getInferredEndpoint: () => storeRef.current.inferredOcrEndpoint ?? null,
      onAttemptFinished: () => {
        void storeRef.current.refresh()
      },
      emit: (event) => {
        if (event.type === 'toast') {
          setToast(event.toast)
          return
        }
        if (event.type === 'error' && event.error) {
          setToast({ text: event.error.message, tone: 'error' })
        }
      },
    })
  }
  const controller = controllerRef.current

  useEffect(() => {
    if (!controller) return undefined
    // setup → cleanup → setup（StrictMode / Fast Refresh）不能作废控制器；
    // activate 不重放选图 / 归档 / 识别，只把上一轮遗留的「进行中」收成取消。
    controller.activate()
    setState(controller.getState())
    const unsubscribe = controller.subscribe(() => setState(controller.getState()))
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  const refresh = store.refresh
  useFocusEffect(
    useCallback(() => {
      // 从子页面（通知核对页 / 设置 / 截图库）回来后，允许再次采用文字。
      controller.focus()
      void refresh()
      return undefined
    }, [controller, refresh]),
  )

  const progress = useMemo(() => batchNoticeProgress(state.items), [state.items])
  const eligibleCount = progress.remaining
  const endpoint = store.ocrEndpoint ?? store.inferredOcrEndpoint
  const busy = state.busy
  const canEdit = !busy
  const viewingItem = viewingItemId ? state.items.find((item) => item.id === viewingItemId) ?? null : null

  usePreventRemove(state.items.length > 0 || busy, ({ data }) => {
    if (confirmedLeaveRef.current) return
    setPendingLeave({ action: data.action })
  })

  const showResult = useCallback((result: BatchNoticeStartResult) => {
    if (result === 'busy') setToast({ text: '上一张 / 上一批还在处理，请等这一轮结束。', tone: 'error' })
    else if (result === 'needs-endpoint') {
      setToast({ text: '还没有可用的电脑识别地址：请先打开「识别服务设置」填写。', tone: 'error' })
    } else if (result === 'nothing') setToast({ text: '没有待识别的图片：识别成功的不会重复识别。', tone: 'error' })
    else if (result === 'already-archived') setToast({ text: '这张原图已经保存过了，不会重复保存。', tone: 'success' })
    else if (result === 'invalid') setToast({ text: '这张图现在不能这样操作。', tone: 'error' })
  }, [])

  const resetItemUi = useCallback(() => {
    setExpandedItemId(null)
    setViewingItemId(null)
    setDiagnosticsItemId(null)
  }, [])

  const startPick = useCallback(() => {
    const result = controller.requestPick()
    if (result === 'needs-replace-confirm') {
      setPendingReplace({ kind: 'pick' })
      return
    }
    if (result === 'started') resetItemUi()
    showResult(result)
  }, [controller, resetItemUi, showResult])

  const startRun = useCallback(() => {
    const result = controller.startRun()
    if (result === 'needs-replace-confirm') {
      setPendingReplace({ kind: 'run' })
      return
    }
    showResult(result)
  }, [controller, showResult])

  const retryItem = useCallback(
    (item: BatchNoticeItem) => {
      const result = controller.retryItem(item.id)
      if (result === 'needs-replace-confirm') {
        setPendingReplace({ kind: 'retry', itemId: item.id, index: item.index })
        return
      }
      showResult(result)
    },
    [controller, showResult],
  )

  const retryArchive = useCallback(
    async (item: BatchNoticeItem) => {
      const result = await controller.retryArchive(item.id)
      showResult(result)
    },
    [controller, showResult],
  )

  const confirmReplace = useCallback(() => {
    const pending = pendingReplace
    if (!pending) return
    setPendingReplace(null)
    if (pending.kind === 'pick') {
      resetItemUi()
      showResult(controller.requestPick({ confirmReplace: true }))
      return
    }
    if (pending.kind === 'run') {
      showResult(controller.startRun({ confirmReplace: true }))
      return
    }
    showResult(controller.retryItem(pending.itemId, { confirmReplace: true }))
  }, [controller, pendingReplace, resetItemUi, showResult])

  const confirmLeave = useCallback(() => {
    const pending = pendingLeave
    if (!pending) return
    setPendingLeave(null)
    // 先停掉正在进行的这一张；已完成的结果仍在控制器里，但这一页马上卸载。
    controller.cancel()
    confirmedLeaveRef.current = true
    if (pending.action) navigation.dispatch(pending.action)
    else navigation.goBack()
  }, [controller, navigation, pendingLeave])

  const onAdopt = useCallback(
    (item: BatchNoticeItem) => {
      const result = controller.adoptText(item.id)
      if (!result.ok) {
        setToast({ text: result.message, tone: 'error' })
        return
      }
      // 全新的 NoticeImport 实例：不覆盖用户已经打开的核对草稿；参数是逐字 reviewed text。
      navigation.push('NoticeImport', { initialSourceText: result.text })
    },
    [controller, navigation],
  )

  const anyManualText = state.items.some(
    (item) =>
      (item.status === 'pending' || item.status === 'failed' || item.status === 'cancelled') &&
      item.text.trim().length > 0,
  )

  return (
    <>
      <ScreenScaffold
        title="批量识别通知"
        subtitle={`一次最多 ${BATCH_NOTICE_MAX_IMAGES} 张；一张一张识别，每张截图分别核对并保存任务`}
        headerAccessory={
          <AppButton
            label="识别服务设置"
            onPress={() => openCoursesScreen(navigation, 'CompanionSettings')}
            variant="secondary"
            compact
            accessibilityLabel="打开识别服务设置"
          />
        }
      >
        <SectionCard
          title="开始前"
          subtitle={`手机与电脑连同一个 Wi-Fi；一次最多 ${BATCH_NOTICE_MAX_IMAGES} 张，每张分别核对并保存任务`}
        >
          <View style={styles.statusRow}>
            <Badge text={endpoint ? '已设置电脑地址' : '未设置电脑地址'} tone={endpoint ? 'primary' : 'warn'} />
            <Text style={styles.endpointText}>{endpoint ?? '（还没有填写）'}</Text>
          </View>
          {!endpoint ? (
            <Text style={styles.warn} accessibilityRole="alert">
              还没有可用的文字识别地址。请先到「识别服务设置」填写这台电脑的地址。
            </Text>
          ) : null}
          <Text style={styles.note}>
            从相册选最多 {BATCH_NOTICE_MAX_IMAGES} 张通知截图。选图只会保存原图；
            识别要由你点「识别待处理图片」开始，一次识别一张。
          </Text>
          <Text style={styles.note}>
            这批结果只在本次打开页面期间保留；原图保存成功后仍然留在全局截图库，
            离开页面不会删除已保存的原图。
          </Text>
          <View style={styles.buttonRow}>
            <AppButton
              label={state.items.length > 0 ? `重新选择一批（最多 ${BATCH_NOTICE_MAX_IMAGES} 张）` : `选择通知截图（最多 ${BATCH_NOTICE_MAX_IMAGES} 张）`}
              onPress={startPick}
              disabled={busy}
              accessibilityLabel="从相册选择最多 8 张通知截图"
              accessibilityHint="选完只会保存原图，不会自动识别，也不会创建任务"
            />
            <AppButton
              label="打开截图库"
              onPress={() => openCoursesScreen(navigation, 'PhotoLibrary')}
              variant="secondary"
              compact
              accessibilityLabel="打开全局截图库"
            />
          </View>
        </SectionCard>

        {state.items.length > 0 ? (
          <SectionCard title="识别这一批" subtitle="按顺序一张一张识别；进度按张数显示">
            <View style={styles.progressRow}>
              <Badge text={`已选 ${progress.total} 张`} tone="muted" />
              <Badge text={`已完成 ${progress.completed} 张`} tone="primary" />
              <Badge text={`待处理 ${progress.remaining} 张`} tone={progress.remaining > 0 ? 'warn' : 'muted'} />
              {progress.failed + progress.cancelled > 0 ? (
                <Badge text={`失败/取消 ${progress.failed + progress.cancelled} 张`} tone="clay" />
              ) : null}
            </View>
            {state.statusText ? (
              <View style={styles.progressLine} accessibilityRole="progressbar" accessibilityLabel={state.statusText}>
                {state.phase === 'running' ? <ActivityIndicator color={colors.primary} /> : null}
                <Text style={styles.progressText}>{state.statusText}</Text>
              </View>
            ) : null}
            {state.run ? (
              <Text style={styles.metaText}>
                本轮第 {Math.min(state.run.done + 1, state.run.total)}/{state.run.total} 张
              </Text>
            ) : null}
            <View style={styles.buttonRow}>
              <AppButton
                label="识别待处理图片"
                onPress={startRun}
                disabled={busy || eligibleCount === 0}
                loading={state.phase === 'running'}
                accessibilityLabel="按顺序识别还没识别、失败或取消的图片"
                accessibilityHint="识别成功的图片不会重复识别；一次只发一个本机识别请求"
              />
              {state.phase === 'running' ? (
                <AppButton
                  label="停止这一轮"
                  onPress={() => {
                    if (controller.cancel()) {
                      setToast({ text: '已停止这一轮；已经完成的结果和手动修改都保留。', tone: 'success' })
                    }
                  }}
                  variant="secondary"
                  compact
                  accessibilityLabel="停止正在进行的批量识别"
                />
              ) : null}
            </View>
            {eligibleCount === 0 && progress.total > 0 ? (
              <Text style={styles.metaText}>
                所有图片都已有结论：成功的不会重复识别；想再试某一张时，用那张图上的「重试这张图」。
              </Text>
            ) : null}
          </SectionCard>
        ) : null}

        {state.error ? (
          <View style={styles.errorBox} accessibilityRole="alert">
            <Text style={styles.errorTitle}>这次没有成功</Text>
            <Text style={styles.errorText}>{state.error.message}</Text>
            {state.error.code === 'NO_ENDPOINT' ? (
              <AppButton
                label="去识别服务设置"
                onPress={() => openCoursesScreen(navigation, 'CompanionSettings')}
                variant="secondary"
                compact
                accessibilityLabel="打开识别服务设置"
              />
            ) : null}
          </View>
        ) : null}

        {state.notice ? (
          <View
            style={[styles.noticeBox, state.notice.tone === 'error' ? styles.noticeBoxError : null]}
            accessibilityRole="alert"
          >
            <Text style={styles.noticeText}>{state.notice.text}</Text>
          </View>
        ) : null}

        <SectionCard
          title="这一批图片"
          subtitle="点开一张改文字、看原图，再单独进入通知核对页；这里不会自动勾选或保存"
        >
          {state.items.length === 0 ? (
            <Text style={styles.muted}>
              还没有选择图片。点上面的「选择通知截图」，从相册一次选最多 {BATCH_NOTICE_MAX_IMAGES} 张。
            </Text>
          ) : (
            state.items.map((item) => {
              const status = ITEM_STATUS[item.status]
              const archive = archiveLabel(item)
              const expanded = expandedItemId === item.id
              const diagnosticsOpen = diagnosticsItemId === item.id
              const lengthError =
                item.text.length > BATCH_NOTICE_MAX_TEXT_CHARS
                  ? `这张图 ${item.text.length} 字，超过 ${BATCH_NOTICE_MAX_TEXT_CHARS} 字：请手动删减；应用不会替你截断。`
                  : null
              const adoption = batchNoticeTextAdoption(item.text)
              const canRetry =
                item.status === 'failed' || item.status === 'cancelled' || item.status === 'empty'
              return (
                <View key={item.id} style={[styles.itemCard, expanded ? styles.itemCardExpanded : null]}>
                  <Pressable
                    onPress={() => setExpandedItemId((previous) => (previous === item.id ? null : item.id))}
                    accessibilityRole="button"
                    accessibilityLabel={`第 ${item.index} 张：${status.label}，${expanded ? '收起' : '展开'}`}
                    accessibilityState={{ expanded }}
                    style={styles.itemHead}
                  >
                    <Image
                      source={{ uri: item.archivedUri ?? item.uri }}
                      style={styles.thumb}
                      resizeMode="cover"
                      accessibilityLabel={`第 ${item.index} 张通知截图缩略图`}
                    />
                    <View style={styles.itemHeadText}>
                      <Text style={styles.itemTitle}>第 {item.index} 张</Text>
                      <View style={styles.badgeRow}>
                        <Badge text={status.label} tone={status.tone} />
                        <Badge text={archive.label} tone={archive.tone} />
                      </View>
                      <Text style={styles.itemSummary} numberOfLines={2}>
                        {itemSummary(item)}
                      </Text>
                      <Text style={styles.itemToggle}>{expanded ? '收起' : '展开并核对文字'}</Text>
                    </View>
                  </Pressable>

                  {item.reviewOpened ? (
                    <>
                      <Text style={styles.reviewOpened}>已打开核对</Text>
                      <Text style={styles.metaText}>任务是否保存，以通知核对页显示的结果为准。</Text>
                    </>
                  ) : null}

                  {item.archiveStatus === 'failed' ? (
                    <View style={styles.archiveFailBox}>
                      <Text style={styles.archiveFailText} accessibilityRole="alert">
                        这张原图还没有保存到截图库：{item.archiveError ?? '原因未知'}。这不代表识别失败；
                        原图不会因此被删除。
                      </Text>
                      <AppButton
                        label="重试保存原图"
                        onPress={() => void retryArchive(item)}
                        variant="secondary"
                        compact
                        disabled={busy}
                        accessibilityLabel={`重试保存第 ${item.index} 张原图`}
                      />
                    </View>
                  ) : null}

                  {expanded ? (
                    <View style={styles.itemBody}>
                      <AppTextField
                        label={`第 ${item.index} 张的识别文字`}
                        value={item.text}
                        onChangeText={(value) => controller.setText(item.id, value)}
                        editable={canEdit && item.status !== 'running'}
                        multiline
                        placeholder="识别后会显示在这里；也可以手动补字或删掉无关内容。"
                        error={lengthError}
                        hint={
                          lengthError
                            ? undefined
                            : `已输入 ${item.text.length} / ${BATCH_NOTICE_MAX_TEXT_CHARS} 字。`
                        }
                        accessibilityLabel={`第 ${item.index} 张可编辑的识别文字`}
                      />
                      {item.error ? (
                        <Text style={styles.errorText} accessibilityRole="alert">
                          识别失败：{item.error.message}
                        </Text>
                      ) : null}
                      {item.historyError ? (
                        <Text style={styles.warn} accessibilityRole="alert">
                          {item.historyError}
                        </Text>
                      ) : null}
                      {item.empty && item.text.trim().length === 0 ? (
                        <Text style={styles.warn} accessibilityRole="alert">
                          这张图里没有读到文字。可以手动补字，或点「重试这张图」再识别一次。
                        </Text>
                      ) : null}
                      {item.archiveStatus === 'archived' ? (
                        <Text style={styles.metaText}>原图已经保存到截图库。</Text>
                      ) : null}
                      {item.warnings.length > 0 ? (
                        <View style={styles.warnBox}>
                          {item.warnings.map((warning) => (
                            <Text key={warning} style={styles.metaText}>
                              · {warning}
                            </Text>
                          ))}
                        </View>
                      ) : null}
                      <AppButton
                        label={diagnosticsOpen ? '收起识别详情' : '识别详情'}
                        onPress={() =>
                          setDiagnosticsItemId((previous) => (previous === item.id ? null : item.id))
                        }
                        variant="ghost"
                        compact
                        accessibilityLabel={`第 ${item.index} 张识别详情`}
                      />
                      {diagnosticsOpen ? (
                        <View style={styles.readonlyBox}>
                          {item.error ? (
                            <Text style={styles.metaText}>错误代码：{item.error.code}</Text>
                          ) : null}
                          {item.requestId ? (
                            <Text style={styles.metaText}>请求号：{item.requestId}</Text>
                          ) : null}
                          {item.image ? (
                            <Text style={styles.metaText}>
                              图片：{item.image.width}×{item.image.height} · {item.image.format} ·{' '}
                              {Math.max(1, Math.round(item.image.bytes / 1024))}KB
                            </Text>
                          ) : null}
                          {item.ocrMs !== null ? (
                            <Text style={styles.metaText}>识别用时：{Math.round(item.ocrMs)}ms</Text>
                          ) : null}
                          {item.archivedAttemptId ? (
                            <Text style={styles.metaText}>截图库记录：#{item.archivedAttemptId}</Text>
                          ) : null}
                        </View>
                      ) : null}
                      <Text style={styles.note}>
                        这张图会单独打开一个通知核对页；任务只有在你于核对页勾选并保存时才会写入。
                        原图属于全局截图库；需要关联任务时，请到任务详情里手动关联（本页不会自动关联）。
                      </Text>
                      <View style={styles.buttonRow}>
                        <AppButton
                          label="查看原图"
                          onPress={() => setViewingItemId(item.id)}
                          variant="secondary"
                          compact
                          accessibilityLabel={`查看第 ${item.index} 张原图`}
                        />
                        <AppButton
                          label="核对这张图的待办"
                          onPress={() => onAdopt(item)}
                          disabled={busy || !adoption.allowed}
                          compact
                          accessibilityLabel={`核对第 ${item.index} 张图的待办`}
                          accessibilityHint={
                            adoption.allowed
                              ? '会打开一个全新的通知核对页，不会直接写任务'
                              : adoption.message
                          }
                        />
                        {canRetry ? (
                          <AppButton
                            label="重试这张图"
                            onPress={() => retryItem(item)}
                            variant="secondary"
                            compact
                            disabled={busy}
                            accessibilityLabel={`重试识别第 ${item.index} 张图`}
                            accessibilityHint="只重试失败、取消或空文字的图片；有手改文字时会先确认"
                          />
                        ) : null}
                      </View>
                      {!adoption.allowed && adoption.message ? (
                        <Text style={styles.warn} accessibilityRole="alert">
                          {adoption.message}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              )
            })
          )}
          <Text style={styles.footnote}>
            原图保留在全局截图库；已完成的识别结果和手动修改只保留在当前页面会话里。
            这里不提供「全部合并成一段原文」，也不会自动把图片逐条附到任务上。
          </Text>
        </SectionCard>
      </ScreenScaffold>

      {/* 查看器：只有真的有归档路径时才说「截图库里的原图」；
          否则如实标成临时预览，并可从截图库记录里再打开。 */}
      <ScreenshotViewer
        photo={
          viewingItem
            ? {
                id: viewingItem.archivedAttemptId ?? 0,
                capturedAt: '',
                archivedPath:
                  viewingItem.archiveStatus === 'archived' && viewingItem.archivedUri
                    ? viewingItem.archivedUri
                    : viewingItem.uri,
              }
            : null
        }
        title={viewingItem ? `第 ${viewingItem.index} 张原图` : undefined}
        footerNote={
          viewingItem
            ? viewingItem.archiveStatus !== 'archived'
              ? '这张原图还没有保存成功；这里显示的是本次选择的临时文件，关掉页面后可能失效。'
              : viewingItem.archivedUri
                ? '这里显示的是截图库里保存的原图字节。'
                : '原图已经保存，但暂时读不到保存路径；这里显示的是本次选择的临时预览，关掉页面后可能失效。'
            : undefined
        }
        actionLabel={
          viewingItem?.archiveStatus === 'archived' && viewingItem.archivedAttemptId
            ? '在截图库查看'
            : undefined
        }
        onAction={() => {
          const attemptId = viewingItem?.archivedAttemptId
          if (!attemptId) return
          setViewingItemId(null)
          openCoursesScreen(navigation, 'PhotoLibrary', { focusAttemptId: attemptId })
        }}
        onClose={() => setViewingItemId(null)}
      />

      <ConfirmDialog
        visible={pendingReplace !== null}
        title={
          pendingReplace?.kind === 'pick'
            ? '替换当前这一批？'
            : pendingReplace?.kind === 'retry'
              ? '重试会覆盖手动改过的文字'
              : '重新识别会覆盖手动改过的文字'
        }
        message={
          pendingReplace?.kind === 'pick'
            ? `当前队列里的 ${state.items.length} 张图、识别结果和手动修改都会被清空，然后重新从相册选择。`
            : pendingReplace?.kind === 'retry'
              ? `第 ${pendingReplace.index} 张已经有手动修改过的文字；重试识别会把它替换成新的识别结果。`
              : anyManualText
                ? '待识别的图片里有手动修改过的文字；继续识别会把那些文字替换成新的识别结果。'
                : '继续识别会从第一张待处理图片开始，按顺序一张一张识别。'
        }
        details={[
          '已经保存到截图库的原图不会被删除。',
          '没有保存的任务不受影响；本页不会写任务。',
        ]}
        confirmLabel={pendingReplace?.kind === 'pick' ? '替换并重新选择' : '识别并替换'}
        danger={pendingReplace?.kind !== 'run'}
        onConfirm={confirmReplace}
        onCancel={() => setPendingReplace(null)}
      />

      <ConfirmDialog
        visible={pendingLeave !== null}
        title={state.phase === 'running' ? '正在识别，离开会取消当前这张' : '离开并丢弃这一批？'}
        message={
          state.phase === 'running'
            ? '离开会中止当前这一张；已经完成的结果和手动修改只在当前页面会话里，离开后就看不到了。'
            : `这一批 ${state.items.length} 张图的识别结果和手动修改只在本次打开页面期间保留；离开后需要重新选择。`
        }
        details={[
          '已经保存到截图库的原图不会被删除。',
          '没有保存的任务不受影响；任务只会在通知核对页里由你保存。',
        ]}
        confirmLabel="离开"
        danger
        onConfirm={confirmLeave}
        onCancel={() => setPendingLeave(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  endpointText: { ...typography.bodySoft, flexShrink: 1 },
  note: { ...typography.caption, marginTop: spacing.sm },
  muted: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  warnBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  progressRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  progressLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  progressText: { ...typography.caption, flexShrink: 1 },
  metaText: { ...typography.caption, marginTop: spacing.xs },
  noticeBox: {
    backgroundColor: colors.primaryTint,
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeBoxError: { backgroundColor: colors.warnSoft, borderColor: colors.warn },
  noticeText: { ...typography.bodySoft },
  errorBox: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  errorTitle: { ...typography.label, color: colors.clayDark },
  errorText: { ...typography.caption, color: colors.clayDark, marginTop: spacing.xs },
  itemCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  itemCardExpanded: { borderColor: colors.primary, backgroundColor: colors.primaryTint },
  itemHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, minHeight: MIN_TOUCH_SIZE },
  thumb: {
    width: 72,
    height: 96,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMute,
  },
  itemHeadText: { flex: 1 },
  itemTitle: { ...typography.body, fontWeight: '600' },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  itemSummary: { ...typography.caption, marginTop: spacing.xs },
  itemToggle: { ...typography.caption, color: colors.primary, marginTop: spacing.xs },
  reviewOpened: { ...typography.caption, color: colors.primaryDark, marginTop: spacing.sm },
  archiveFailBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.claySoft,
    borderWidth: 1,
    borderColor: colors.clay,
  },
  archiveFailText: { ...typography.caption, color: colors.clayDark },
  itemBody: { marginTop: spacing.md },
  readonlyBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
  },
  footnote: { ...typography.caption, marginTop: spacing.sm },
})
