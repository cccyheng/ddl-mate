/**
 * 截图转待办（第一步）：**一张通知截图 → 本机电脑 OCR → 可编辑文字**。
 *
 * 边界（与授权书逐条对应）：
 * - 只把截图发给用户自己同一 Wi-Fi 的电脑（既有伴侣服务），不经过任何第三方；
 * - 选图后**不自动识别**，必须用户点「识别文字」；
 * - 选到图就先原样归档进**既有截图库**；归档失败会如实显示并给「重试保存」；
 * - 识别失败 / 取消 / 断网都**保留已选图片和已改文字**，不会静默丢掉；
 * - 识别成功后的文字可改；只有点「使用这段文字」才会打开**新的**通知核对页，
 *   由既有的「通知转待办」保存逻辑写任务。本页与 OCR 全程零任务写入。
 * - 原文超过 10000 字时明确要求手动缩短 / 分两次，**禁止采用**，绝不静默截断。
 *
 * 生命周期（取消 / 换图 / 卸载 / 连点）在 `noticePhotoController.ts` 里，
 * 不依赖 React，可单独测试。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, usePreventRemove } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { recognizeNoticeImage } from '../domain/noticeOcrClient'
import { MAX_NOTICE_SOURCE_CHARS } from '../domain/noticeImport'
import { preparePhotoForUpload } from '../domain/photoFiles'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { AppButton, AppTextField, Badge, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { TaskStackParamList } from '../navigation/types'
import { ExamPhotoCaptureView } from './ExamPhotoCaptureView'
import {
  createInitialNoticePhotoState,
  createNoticePhotoOperation,
  hasUnsavedNoticePhotoDraft,
  noticePhotoAdoption,
  type NoticePhotoOperation,
  type NoticePhotoPickResult,
  type NoticePhotoState,
} from './noticePhotoController'

type Nav = NativeStackNavigationProp<TaskStackParamList>

/** 父级 Tab 导航的最小形状：从任务栈跳到「课程」栈里既有的设置 / 截图库页面。 */
interface TabNavigatorLike {
  navigate: (name: 'Courses', params: { screen: 'CompanionSettings' | 'PhotoLibrary'; params?: object; initial: false }) => void
}

function openCoursesScreen(
  navigation: Nav,
  screen: 'CompanionSettings' | 'PhotoLibrary',
  params?: object,
): void {
  const parent = navigation.getParent() as unknown as TabNavigatorLike | undefined
  // 兼容旧导航状态：拿不到父级时退回任务栈，绝不调用不存在的 TaskStack 路由。
  if (parent && typeof parent.navigate === 'function') parent.navigate('Courses', { screen, params, initial: false })
}

const EMPTY_STATE = createInitialNoticePhotoState()

async function pickFromLibrary(): Promise<NoticePhotoPickResult> {
  const ImagePicker = await import('expo-image-picker')
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) {
    return {
      status: 'permission',
      canAskAgain: permission.canAskAgain,
      message: '还没有允许访问相册。请在系统提示里允许，或到 iOS「设置 → Expo Go → 照片」打开后重试。',
    }
  }
  const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false })
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' }
  const asset = result.assets[0]!
  if (!asset.uri) return { status: 'error', message: '系统没有返回图片内容，请换一张照片再试。' }
  return {
    status: 'picked',
    uri: asset.uri,
    source: { width: asset.width, height: asset.height, mimeType: asset.mimeType ?? null },
  }
}

async function captureFromCamera(): Promise<NoticePhotoPickResult> {
  const ImagePicker = await import('expo-image-picker')
  const permission = await ImagePicker.requestCameraPermissionsAsync()
  if (!permission.granted) {
    return {
      status: 'permission',
      canAskAgain: permission.canAskAgain,
      message: permission.canAskAgain
        ? '还没有允许使用相机。请再点一次并在系统提示里选择「允许」。'
        : '相机权限已被拒绝。请到 iOS「设置 → Expo Go → 相机」里打开，或改用「从相册选择」。',
    }
  }
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, allowsEditing: false })
  if (result.canceled || !result.assets?.length) return { status: 'cancelled' }
  const asset = result.assets[0]!
  if (!asset.uri) return { status: 'error', message: '相机没有返回图片，请再试一次。' }
  return {
    status: 'picked',
    uri: asset.uri,
    source: { width: asset.width, height: asset.height, mimeType: asset.mimeType ?? null },
  }
}

export function ExamPhotoScreen(): React.ReactElement { return <NoticePhotoScreen examMode /> }

export function NoticePhotoScreen({ examMode = false }: { examMode?: boolean } = {}): React.ReactElement {
  const store = useAppStore()
  const examGeneration = useRef(store.notificationRouteGeneration)
  const navigation = useNavigation<Nav>()

  const [state, setState] = useState<NoticePhotoState>(EMPTY_STATE)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 需要用户确认「替换已经改好的文字」的待执行动作。 */
  const [pendingReplace, setPendingReplace] = useState<null | { kind: 'library' | 'camera' | 'recognize' }>(null)
  /** 被拦截下来的原始导航动作。 */
  const [pendingLeave, setPendingLeave] = useState<{ action: Parameters<Nav['dispatch']>[0] | null } | null>(null)
  const confirmedLeaveRef = useRef(false)

  /** 控制器只建一次：跨渲染保持 generation / abort / 已采用文字。 */
  const storeRef = useRef<AppStoreValue>(store)
  storeRef.current = store
  const controllerRef = useRef<NoticePhotoOperation | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createNoticePhotoOperation({
      state: EMPTY_STATE,
      pickFromLibrary,
      captureFromCamera,
      preparePhoto: (uri, source) => preparePhotoForUpload(uri, { source }),
      archiveOriginal: (uri, source, attemptSource) => storeRef.current.archiveOriginal(uri, source, attemptSource),
      recognize: (endpoint, options) => recognizeNoticeImage(endpoint, { ...options, kind: examMode ? 'exams' : 'notice' }),
      recordResult: async (input) => {
        await storeRef.current.recordScreenshotResult({
          attemptId: input.attemptId,
          status: input.status,
          rawText: input.rawText,
          // 这是通知文字，不是课表候选：不传 response，避免写进假的 layout / candidates / week。
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
    controller.attach()
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

  const hasDraft = hasUnsavedNoticePhotoDraft(state)
  const adoption = useMemo(() => noticePhotoAdoption(state), [state])
  const endpoint = store.ocrEndpoint ?? store.inferredOcrEndpoint
  const busy = state.busy
  const canEdit = !busy
  const canRecognize = state.photoUri !== null && !busy

  usePreventRemove(hasDraft || busy, ({ data }) => {
    if (confirmedLeaveRef.current) return
    setPendingLeave({ action: data.action })
  })

  const confirmLeave = useCallback(() => {
    const pending = pendingLeave
    if (!pending) return
    setPendingLeave(null)
    controller.cancel()
    confirmedLeaveRef.current = true
    if (pending.action) navigation.dispatch(pending.action)
    else navigation.goBack()
  }, [controller, navigation, pendingLeave])

  const startPick = useCallback(
    (kind: 'library' | 'camera') => {
      const result = controller.requestPick(kind)
      if (result === 'needs-replace-confirm') {
        setPendingReplace({ kind })
        return
      }
      if (result === 'busy') setToast({ text: '上一张图还在处理，请等这一轮结束。', tone: 'error' })
    },
    [controller],
  )

  const startRecognize = useCallback(() => {
    const result = controller.requestRecognize()
    if (result === 'needs-replace-confirm') {
      setPendingReplace({ kind: 'recognize' })
      return
    }
    if (result === 'needs-photo') setToast({ text: examMode ? '请先选择或拍摄考试安排照片。' : '请先从相册选一张通知截图（或拍一张）。', tone: 'error' })
    if (result === 'needs-endpoint') {
      setToast({ text: '还没有可用的电脑识别地址：请先打开「识别服务设置」填写。', tone: 'error' })
    }
    if (result === 'busy') setToast({ text: '上一轮还在处理，请稍等。', tone: 'error' })
  }, [controller, examMode])

  const confirmReplace = useCallback(() => {
    const pending = pendingReplace
    if (!pending) return
    setPendingReplace(null)
    if (pending.kind === 'recognize') {
      const result = controller.requestRecognize({ confirmReplace: true })
      if (result === 'needs-endpoint') {
        setToast({ text: '还没有可用的电脑识别地址：请先打开「识别服务设置」填写。', tone: 'error' })
      }
      return
    }
    const result = controller.requestPick(pending.kind, { confirmReplace: true })
    if (result === 'busy') setToast({ text: '上一张图还在处理，请等这一轮结束。', tone: 'error' })
  }, [controller, pendingReplace])

  const onAdopt = useCallback(() => {
    if (examMode && examGeneration.current !== storeRef.current.notificationRouteGeneration) {
      setToast({ text: '数据已恢复，请返回重新打开考试照片识别。', tone: 'error' }); return
    }
    const current = controller.getState()
    if (examMode && (!current.archivedOriginal || current.archivedAttemptId === null)) {
      setToast({ text: '请先重试保存原图，再核对考试。', tone: 'error' }); return
    }
    const result = controller.adoptText()
    if (!result.ok) {
      setToast({ text: result.message, tone: 'error' })
      return
    }
    // `push` 保证是**全新**的 NoticeImport 实例：不会覆盖用户已经打开的核对草稿。
    // 路由参数只传可序列化的字符串，且是**完整**的 reviewed text（不截断）。
    if (examMode) navigation.push('ExamPhotoReview', { sourceText: result.text, attemptId: current.archivedAttemptId!, generation: storeRef.current.notificationRouteGeneration })
    else navigation.push('NoticeImport', { initialSourceText: result.text })
  }, [controller, navigation, examMode])

  const lengthError = useMemo(() => {
    const length = state.text.length
    return length > MAX_NOTICE_SOURCE_CHARS
      ? `识别文字 ${length} 字，超过单次上限 ${MAX_NOTICE_SOURCE_CHARS} 字：请手动删减，或分成两次识别与导入。应用不会替你截断。`
      : null
  }, [state.text])

  return (
    <>
      {examMode ? <ExamPhotoCaptureView
        state={state} endpoint={endpoint} lengthError={lengthError} canAdopt={adoption.allowed}
        stale={examGeneration.current !== store.notificationRouteGeneration}
        onPick={startPick} onRecognize={startRecognize} onCancel={() => controller.cancel()} onAdopt={onAdopt}
        onEditText={(text) => controller.setText(text)} onRetryArchive={() => void controller.retryArchive()}
        onSettings={() => openCoursesScreen(navigation, 'CompanionSettings')}
        onLibrary={() => openCoursesScreen(navigation, 'PhotoLibrary')}
        onOriginal={() => openCoursesScreen(navigation, 'PhotoLibrary', { focusAttemptId: state.archivedAttemptId })}
      /> : <ScreenScaffold
        title={examMode ? '照片识别考试' : '截图转待办'}
        subtitle={examMode ? '识别考试卡片 → 校对日期、时间、地点和座位 → 导入考试' : '一张通知截图 → 本机电脑识别文字 → 核对后进入通知转待办'}
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
        <SectionCard title="使用前须知" subtitle="照片只发到你自己这台电脑，不经过任何第三方">
          <View style={styles.statusRow}>
            <Badge text={endpoint ? '电脑地址可用' : '未设置电脑地址'} tone={endpoint ? 'primary' : 'warn'} />
            <Text style={styles.endpointText}>{endpoint ?? '（还没有填写）'}</Text>
          </View>
          <Text style={styles.note}>
            手机与电脑要连同一个 Wi-Fi，电脑上的本机识别服务要已经启动。这一页只做「截图 → 文字」，
            不会创建任何任务；只有下一步核对并确认后才保存。
          </Text>
          {!endpoint ? (
            <Text style={styles.warn} accessibilityRole="alert">
              还没有可用的文字识别地址。请先到「识别服务设置」填写这台电脑的地址。
            </Text>
          ) : null}
          <View style={styles.buttonRow}>
            <AppButton
              label="识别服务设置"
              onPress={() => openCoursesScreen(navigation, 'CompanionSettings')}
              variant="secondary"
              compact
              accessibilityLabel="打开识别服务设置"
            />
            <AppButton
              label="打开截图库"
              onPress={() => openCoursesScreen(navigation, 'PhotoLibrary')}
              variant="secondary"
              compact
              accessibilityLabel="打开截图库"
            />
          </View>
        </SectionCard>

        <SectionCard title={examMode ? '1. 选择考试安排照片' : '1. 选择一张通知截图'} subtitle="从相册选，或直接拍一张；选完不会自动识别">
          <View style={styles.previewBox}>
            {state.photoUri ? (
              <Image source={{ uri: state.photoUri }} style={styles.preview} resizeMode="contain" accessibilityLabel="已选通知截图预览" />
            ) : (
              <Text style={styles.muted}>还没有选择截图</Text>
            )}
          </View>
          <View style={styles.buttonRow}>
            <AppButton
              label="从相册选择"
              onPress={() => startPick('library')}
              disabled={busy}
              accessibilityLabel="从相册选择通知截图"
            />
            <AppButton
              label="拍照"
              onPress={() => startPick('camera')}
              variant="secondary"
              disabled={busy}
              accessibilityLabel="用相机拍通知截图"
            />
          </View>

          {/* 归档状态必须如实：存住了才说存住，没存住给原因与重试。 */}
          {state.archivedOriginal ? (
            <Text style={styles.note}>
              原图已经保存到截图库（不缩小、不裁剪）
              {state.archivedAttemptId ? `，记录 #${state.archivedAttemptId}` : ''}；关掉 App 再打开仍然能看。
            </Text>
          ) : state.archiveError ? (
            <Text style={styles.warn} accessibilityRole="alert">
              这张图没能保存到截图库：{state.archiveError}
            </Text>
          ) : null}
          {state.archivedOriginal && state.archivedAttemptId ? (
            <AppButton
              label="查看已保存的原图"
              onPress={() => openCoursesScreen(navigation, 'PhotoLibrary', { focusAttemptId: state.archivedAttemptId })}
              variant="ghost"
              compact
              accessibilityLabel="在截图库中查看这张原图"
            />
          ) : null}
          {state.archiveError && !state.archivedOriginal ? (
            <AppButton
              label="重试保存原图"
              onPress={() => void controller.retryArchive()}
              variant="secondary"
              compact
              disabled={busy}
              accessibilityLabel="重试把原图保存到截图库"
            />
          ) : null}
        </SectionCard>

        <SectionCard title="2. 识别文字" subtitle="明确点一下才会把这张图送到电脑识别">
          {busy ? (
            <View style={styles.progressRow} accessibilityRole="progressbar" accessibilityLabel={state.statusText || '正在处理'}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.progressText}>{state.statusText || '正在处理…'}</Text>
            </View>
          ) : null}
          {busy && (state.phase === 'preparing' || state.phase === 'recognizing') ? (
            <AppButton
              label="取消这次识别"
              onPress={() => controller.cancel()}
              variant="secondary"
              compact
              accessibilityLabel="取消正在进行的文字识别"
            />
          ) : null}
          <AppButton
            label="识别文字"
            onPress={startRecognize}
            disabled={!canRecognize}
            loading={busy}
            accessibilityLabel="识别这张截图里的文字"
            accessibilityHint="只在本机电脑上识别，不会自动创建任务"
          />
          {state.error ? (
            <View style={styles.errorBox} accessibilityRole="alert">
              <Text style={styles.errorTitle}>这次没有成功</Text>
              <Text style={styles.errorText}>{state.error.message}</Text>
              <Text style={styles.metaText}>错误代码：{state.error.code}</Text>
              <View style={styles.buttonRow}>
                {state.error.code === 'NO_ENDPOINT' ? (
                  <AppButton
                    label="去识别服务设置"
                    onPress={() => openCoursesScreen(navigation, 'CompanionSettings')}
                    variant="secondary"
                    compact
                    accessibilityLabel="打开识别服务设置"
                  />
                ) : (
                  <AppButton
                    label="重试识别"
                    onPress={startRecognize}
                    variant="secondary"
                    compact
                    disabled={busy || !state.photoUri || !state.error.retryable}
                    accessibilityLabel="重试识别这张截图"
                  />
                )}
              </View>
            </View>
          ) : null}
          {state.requestId ? (
            <Text style={styles.metaText}>
              请求号：{state.requestId}
              {state.diagnosticsMode ? '（电脑上的本地诊断已开启）' : ''}
            </Text>
          ) : null}
          {state.image ? (
            <Text style={styles.metaText}>
              电脑读到的图：{state.image.width}×{state.image.height} · {state.image.format} ·{' '}
              {Math.max(1, Math.round(state.image.bytes / 1024))}KB
              {state.ocrMs !== null ? ` · 用时 ${Math.round(state.ocrMs)}ms` : ''}
            </Text>
          ) : null}
          {state.warnings.length > 0 ? (
            <View style={styles.warnBox}>
              {state.warnings.map((warning) => (
                <Text key={warning} style={styles.metaText}>
                  · {warning}
                </Text>
              ))}
            </View>
          ) : null}
        </SectionCard>

        <SectionCard
          title="3. 核对识别文字"
          subtitle={examMode ? '可以修改识别文字；下一步逐场核对，原图会附在导入的考试上。' : '可以直接改；只有点「使用这段文字」才会进入通知核对页'}
        >
          <AppTextField
            label="识别到的文字"
            value={state.text}
            onChangeText={(value) => controller.setText(value)}
            editable={canEdit}
            multiline
            placeholder="识别成功后会显示在这里；也可以自己补字或删掉无关内容。"
            error={lengthError}
            hint={
              lengthError
                ? undefined
                : `已输入 ${state.text.length} / ${MAX_NOTICE_SOURCE_CHARS} 字。这里只做本机规则提取，不是 AI 语义理解；识别文字只在你自己的电脑上完成。`
            }
            accessibilityLabel="可编辑的识别文字"
          />
          {state.empty && state.text.trim().length === 0 ? (
            <Text style={styles.warn} accessibilityRole="alert">
              这张图里没有识别到文字。可以换一张更清晰、只截通知正文的截图再试。
            </Text>
          ) : null}
          <Text style={styles.note}>
            {examMode ? '下一步核对考试名称、日期、时段、地点和座位号；不清楚的时间请补选，过期考试默认不勾选。' : '点「使用这段文字」会打开一个新的通知核对页；任务只有在你于那边勾选并保存时才会写入。'}
            {examMode ? '导入的考试会关联这张原图，可在任务原图和截图库查看。' : state.archivedOriginal
              ? '这张原图已经保存在截图库，可以到截图库查看；任务只保留你核对后的文字，不会自动把图片逐条附到每个任务上。'
              : '这张原图还没有保存成功，截图库里暂时看不到；可以先重试保存原图。任务只保留你核对后的文字。'}
          </Text>
          <AppButton
            label={examMode ? '下一步：核对考试' : '使用这段文字'}
            onPress={onAdopt}
            disabled={busy || !adoption.allowed || (examMode && !state.archivedOriginal)}
            accessibilityLabel={examMode ? '进入考试核对页' : '使用这段识别文字进入通知核对页'}
            accessibilityHint={adoption.allowed ? '会打开新的通知核对页，不会直接写任务' : adoption.message}
          />
          {!adoption.allowed && adoption.message ? (
            <Text style={styles.warn} accessibilityRole="alert">
              {adoption.message}
            </Text>
          ) : null}
        </SectionCard>
      </ScreenScaffold>}

      <ConfirmDialog
        visible={pendingReplace !== null}
        title="替换已经改好的识别文字？"
        message={
          pendingReplace?.kind === 'recognize'
            ? '重新识别会把当前编辑框里的文字替换成新的识别结果；在明确确认之前，原文字不会被改动。'
            : '换一张图会把当前编辑框里的文字清空，并重新保存新的原图；在明确确认之前，原文字不会被改动。'
        }
        details={['截图库里的原图不会被删除。', '没有保存的任务不受影响。']}
        confirmLabel={pendingReplace?.kind === 'recognize' ? '重新识别并替换' : '换图并替换'}
        danger
        onConfirm={confirmReplace}
        onCancel={() => setPendingReplace(null)}
      />

      <ConfirmDialog
        visible={pendingLeave !== null}
        title={busy ? '正在识别，离开会取消' : '离开并丢弃这次的结果？'}
        message={
          busy
            ? '这次识别还在进行；离开会取消它。原图是否已经保存到截图库，以上面的保存状态为准。'
            : examMode ? '识别结果尚未导入考试，离开后需要重新选择与识别。' : '识别出来的文字还没有进入通知核对页，离开后需要重新选择与识别。'
        }
        details={['截图库里的原图不会被删除。', '没有保存的任务不受影响。']}
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
  previewBox: {
    minHeight: 180,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  preview: { width: '100%', height: 260 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  progressText: { ...typography.caption, flexShrink: 1 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  note: { ...typography.caption, marginTop: spacing.sm },
  muted: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  metaText: { ...typography.caption, marginTop: spacing.xs },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  warnBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  errorBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.claySoft,
    borderWidth: 1,
    borderColor: colors.clay,
  },
  errorTitle: { ...typography.label, color: colors.clayDark },
  errorText: { ...typography.caption, color: colors.clayDark, marginTop: spacing.xs },
})
