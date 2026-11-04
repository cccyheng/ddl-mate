/**
 * 照片导入课表 —— 第一步：拍/选一张课表截图，在本机电脑上识别成候选行。
 *
 * 关键边界（与任务书一致）：
 * - **照片只会发给用户自己这台电脑上的伴侣服务**（同一 Wi-Fi），
 *   界面在预览处用一行小字说清楚，不偷偷上传到任何第三方；
 * - 识别失败 / 服务没开 / 权限被拒 / 图片过大，都给可读中文提示 + 重试或换图；
 * - 识别阶段**不写数据库**：真正写库只在下一步的「导入」按钮里、并且是一次事务；
 * - 用户离开页面会**真的取消**这次识别，回来的结果直接丢弃（不写状态、不写库）。
 *
 * 这一版重写的重点是「选完照片没有任何反应」这个真问题：
 * - 焦点回调只依赖稳定引用的 `refresh`，页面重渲染不再打断正在进行的识别；
 * - 每次识别都有独立的尝试号与 `AbortController`，迟到的结果绝不会串到新一轮；
 * - 系统权限弹窗 / 相册选择器导致的失焦**不会**误杀正常流程，真的离开才算取消；
 * - 无论成功、失败、取消，busy 一定收掉，进度至少可见 0.7 秒，不会「闪一下像没反应」。
 *
 * 生命周期主体在 `photoImportController.ts`（不依赖 React / React Native，可单测），
 * 这里只负责把原生选择器、store 和界面接上去。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { checkCompanionHealth, recognizeTimetableImage } from '../domain/photoOcrClient'
import { preparePhotoForUpload } from '../domain/photoFiles'
import { capturePhotoFromCamera, pickPhotoFromLibrary } from '../domain/photoPicker'
import type { PhotoImportRow } from '../domain/photoImport'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { AppButton, Badge, SectionCard } from '../ui/components'
import { Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'
import {
  createInitialPhotoImportState,
  createPhotoImportFocusBinding,
  createPhotoImportOperation,
  type PhotoImportOperation,
  type PhotoImportState,
} from './photoImportController'

type Nav = NativeStackNavigationProp<CourseStackParamList>

/** 界面初始状态：与控制器内部默认值同源，避免两边字段漂移。 */
const EMPTY_STATE: PhotoImportState = createInitialPhotoImportState()

export function PhotoImportScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [state, setState] = useState<PhotoImportState>(EMPTY_STATE)

  /** 一直指向**最新**的 store 值：控制器与事件回调都从这里读，不订阅整个 store 对象。 */
  const storeRef = useRef<AppStoreValue>(store)
  storeRef.current = store

  const controllerRef = useRef<PhotoImportOperation | null>(null)

  // 控制器只建一次：它跨渲染保持自己的尝试号 / 取消状态，绝不会被 store 变化重建。
  if (controllerRef.current === null) {
    controllerRef.current = createPhotoImportOperation({
      state: EMPTY_STATE,
      pickFromLibrary: pickPhotoFromLibrary,
      captureFromCamera: capturePhotoFromCamera,
      preparePhoto: (uri, source) => preparePhotoForUpload(uri, { source }),
      checkHealth: async (endpoint, timeoutMs) => {
        const result = await checkCompanionHealth(endpoint, { timeoutMs })
        return result.ok
      },
      recognize: (endpoint, options) => recognizeTimetableImage(endpoint, options),
      subscribe: () => ({ unsubscribe: () => undefined }),
      /**
       * 识别**之前**归档原图。
       *
       * 这一步失败不阻断识别（图片字节还在内存里），但状态里会留下可读原因，
       * 界面据此如实说明「这次识别能看，但这张图没存住」。
       */
      archiveOriginal: (uri, source, attemptSource) => storeRef.current.archiveOriginal(uri, source, attemptSource),
      /**
       * 识别结果登记：**返回 Promise 让控制器自己 await/catch**，
       * 这样「结果没存住」（例如磁盘写不进去）会变成可见提示，而不是未处理的拒绝。
       */
      recordResult: (input) => storeRef.current.recordScreenshotResult(input),
      onAttemptFinished: () => {
        void storeRef.current.refresh()
      },
      getEndpoint: () => storeRef.current.ocrEndpoint ?? null,
      getInferredEndpoint: () => storeRef.current.inferredOcrEndpoint ?? null,
      configureEndpoint: async (candidate) => {
        void candidate
        const result = await storeRef.current.autoConfigureOcrEndpoint()
        return { ok: result.ok, endpoint: result.endpoint, message: result.message }
      },
      refreshStore: () => storeRef.current.refresh(),
      emit: (event) => {
        if (event.type === 'toast') {
          setToast(event.toast)
          return
        }
        // 归档 / 结果登记失败这类「必须让用户知道」的问题：
        // 页面可能已经被卸载（选完图就离开），但错误不能静默消失。
        if (event.type === 'error' && event.error) {
          setToast({ text: event.error.message, tone: 'error' })
        }
      },
    })
  }

  const controller = controllerRef.current

  /**
   * 挂载 / 卸载的生命周期。
   *
   * React StrictMode（开发模式）和 Fast Refresh 都会走 **setup → cleanup → setup**，
   * 所以 cleanup 必须写成「停下来但还能再用」，而不是把控制器永久废掉：
   * `dispose()` 取消在进行的请求并停止提交状态，`attach()` 让同一个控制器重新可用。
   * 真正离开页面时（组件被卸载、ref 被丢弃）后续的 `attach()` 不会再发生。
   */
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

  /**
   * 回到本页时：解除「用户已离开」标记，并重新读一次 store 快照；离开时取消本次识别。
   *
   * **绑定只依赖稳定引用的 `refresh`**（见 `createPhotoImportFocusBinding` 的说明）：
   * 旧代码把整个 `store` 放进依赖，而 `store` 每次刷新都是新对象
   * → 焦点回调被重建 → 清理函数取消识别 → 再次刷新，循环里把结果静默丢掉。
   */
  const refresh = store.refresh
  const focusBinding = useMemo(
    () => (controller ? createPhotoImportFocusBinding(controller, { refresh }) : null),
    [controller, refresh],
  )
  useFocusEffect(
    useCallback(() => {
      if (!focusBinding) return undefined
      focusBinding.onFocus()
      return () => focusBinding.onCleanup()
    }, [focusBinding]),
  )

  const endpoint = state.endpointUsed ?? store.ocrEndpoint ?? store.inferredOcrEndpoint
  const busy = state.busy || (state.stage !== 'idle' && state.stage !== 'done')

  const onTakePhoto = useCallback(() => {
    void controllerRef.current?.captureFromCamera()
  }, [])
  const onPickPhoto = useCallback(() => {
    void controllerRef.current?.pickFromLibrary()
  }, [])
  const onRetry = useCallback(() => {
    void controllerRef.current?.retryLastPhoto()
  }, [])
  const onConfigureEndpoint = useCallback(() => {
    void controllerRef.current?.configureInferredEndpoint()
  }, [])

  const warnings = state.response?.warnings ?? []
  const rowSummary = useMemo(() => {
    if (state.rows.length === 0) return null
    const names = new Set(state.rows.map((row: PhotoImportRow) => row.name.trim()).filter(Boolean))
    const missing = state.rows.filter((row) => !row.name || !row.weekday || !row.startTime || !row.endTime).length
    return { names: names.size, missing }
  }, [state.rows])

  /**
   * 预览下面的一行说明：用户只关心「有没有被偷偷降质」。
   *
   * 原分辨率直传 / 无损 PNG 时说「原始分辨率」；确实缩小了才说缩到多少。
   */
  const photoNote = state.photoBytes
    ? (() => {
        const size = `${(state.photoBytes / 1024).toFixed(0)}KB`
        const dimensions =
          state.photoWidth && state.photoHeight ? `${state.photoWidth}×${state.photoHeight}` : '尺寸未知'
        const original =
          state.sourceWidth && state.sourceHeight ? `原图 ${state.sourceWidth}×${state.sourceHeight}` : '原图尺寸未知'
        return state.photoScaled
          ? `这张照片超过了上传上限，已缩到 ${dimensions}（${size}）；${original}。`
          : `将按 ${dimensions} 原始分辨率上传（${size}，${state.photoFormat === 'png' ? '无损 PNG' : 'JPEG'}）。`
      })()
    : null

  return (
    <>
      <ScreenScaffold
        title="拍照导入课表"
        subtitle="把课表截图识别成可编辑的课表行；确认后才写进这台手机"
        headerAccessory={
          <AppButton
            label="识别服务设置"
            onPress={() => navigation.navigate('CompanionSettings')}
            variant="secondary"
            compact
            accessibilityLabel="打开识别服务设置"
          />
        }
      >
        <SectionCard title="截图库" subtitle="你提交过的每一张图都会保存在软件里，随时能回看原图">
          <Text style={styles.note}>
            选中的照片会**先原样保存到这台手机**（不缩小、不裁剪），然后才送去识别；
            就算识别失败或中途取消，原图也还在，可以之后再看或重新识别。
          </Text>
          <AppButton
            label="打开截图库"
            onPress={() => navigation.navigate('PhotoLibrary')}
            variant="secondary"
            compact
            style={styles.gap}
            accessibilityLabel="打开截图库"
          />
          <AppButton
            label="从电脑恢复历史截图"
            onPress={() => navigation.navigate('SourceArchive')}
            variant="ghost"
            compact
            style={styles.gap}
            accessibilityLabel="从电脑恢复历史截图"
          />
        </SectionCard>
        <SectionCard title="识别服务">
          <View style={styles.statusRow}>
            <Badge text={endpoint ? '地址可用' : '未设置地址'} tone={endpoint ? 'primary' : 'warn'} />
            <Text style={styles.endpointText}>{endpoint ?? '（还没有填写）'}</Text>
          </View>
          <Text style={styles.note}>
            照片只会在你自己这台电脑上用本地识别（手机与电脑连同一个 Wi-Fi），不会上传到任何第三方服务。
          </Text>
          {!endpoint ? (
            <Text style={styles.warn} accessibilityRole="alert">
              还没有可用的识别服务地址。请打开右上角「识别服务设置」填写电脑地址；
              如果电脑上的识别服务已经启动，也可以直接点下面的「检测并保存推断地址」。
            </Text>
          ) : null}
          {!store.ocrEndpoint && store.inferredOcrEndpoint ? (
            <>
              <Text style={styles.note}>
                按当前网络推断出这台电脑的地址是 {store.inferredOcrEndpoint}。可以一键检测并保存。
              </Text>
              <AppButton
                label="检测并保存推断地址"
                onPress={onConfigureEndpoint}
                variant="secondary"
                compact
                style={styles.gap}
                accessibilityLabel="检测并保存推断出来的识别服务地址"
              />
            </>
          ) : null}
        </SectionCard>

        <SectionCard title="1. 选择照片" subtitle="相机直拍，或从相册里选一张已有的课表截图">
          <View style={styles.previewBox}>
            {state.photoUri ? (
              <Image
                source={{ uri: state.photoUri }}
                style={styles.preview}
                resizeMode="contain"
                accessibilityLabel="待识别照片预览"
              />
            ) : (
              <Text style={styles.muted}>还没有选择照片</Text>
            )}
          </View>
          {photoNote ? <Text style={styles.note}>{photoNote}</Text> : null}
          {/* 归档状态如实说明：存住了就说存住了，没存住就给出原因，绝不假装成功。 */}
          {state.archivedOriginal ? (
            <Text style={styles.note}>
              原图已经保存到截图库（不缩小、不裁剪）{state.archivedAttemptId ? `，编号 #${state.archivedAttemptId}` : ''}；
              关掉 App 再打开仍然能看。
            </Text>
          ) : state.archiveError ? (
            <Text style={styles.warn} accessibilityRole="alert">
              这次识别照样进行，但这张图**没能保存到截图库**：{state.archiveError}
            </Text>
          ) : null}
          {busy ? (
            <View style={styles.progressRow} accessibilityRole="progressbar" accessibilityLabel={state.progress || '正在处理'}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.progressText}>{state.progress || '正在处理…'}</Text>
            </View>
          ) : null}
          <AppButton label="拍照" onPress={onTakePhoto} disabled={busy} accessibilityLabel="用相机拍课表" />
          <AppButton
            label="从相册选择"
            onPress={onPickPhoto}
            variant="secondary"
            disabled={busy}
            style={styles.gap}
            accessibilityLabel="从相册选择课表截图"
          />
        </SectionCard>

        {state.error ? (
          <SectionCard title="这次没有成功">
            <Text style={styles.error} accessibilityRole="alert">
              {state.error.message}
            </Text>
            <Text style={styles.note}>错误代码：{state.error.code}</Text>
            {/* 只读到表头/时间栏时，重试同一张图没有意义：引导用户换一张/裁剪。 */}
            {state.error.code === 'NO_STRUCTURE' ? (
              <Text style={styles.note}>
                这张图里没有读到课程方块。请让课程方块尽量占满画面（或直接在课表页截取课程区域）后再试。
              </Text>
            ) : null}
            <AppButton
              label={state.error.code === 'NO_ENDPOINT' ? '去识别服务设置' : '重试'}
              onPress={state.error.code === 'NO_ENDPOINT' ? () => navigation.navigate('CompanionSettings') : onRetry}
              variant="secondary"
              disabled={busy || state.error.code === 'NO_STRUCTURE'}
              accessibilityLabel={state.error.code === 'NO_ENDPOINT' ? '打开识别服务设置' : '重试这次识别'}
            />
            <AppButton label="换一张照片" onPress={onPickPhoto} variant="ghost" disabled={busy} style={styles.gap} />
          </SectionCard>
        ) : null}

        {state.response ? (
          <SectionCard
            title="2. 识别结果"
            subtitle={`${state.rows.length} 条候选 · 版面 ${state.response.layout}${
              state.response.week ? ` · 图片显示第 ${state.response.week} 教学周` : ' · 图片没有显示教学周'
            }`}
          >
            {rowSummary ? (
              <Text style={styles.note}>
                涉及 {rowSummary.names} 门课
                {rowSummary.missing > 0 ? `；其中 ${rowSummary.missing} 条缺少必填项，下一步需要你补上` : '；每条都识别到了必要字段'}。
              </Text>
            ) : (
              <Text style={styles.warn} accessibilityRole="alert">
                没有识别到任何课表块。可能是这张图不是课表截图，或者图片太小/太糊。
                可以点下面的「重新识别这张图」，或换一张更清晰的截图。
              </Text>
            )}
            {state.rows.length > 0 && state.rows.some((row) => !row.name || !row.startTime) ? (
              <Text style={styles.warn} accessibilityRole="alert">
                有字段没认出来（例如课程名或时间）。这些行在下一步可以手动补；补不齐的行不会被写进数据库。
              </Text>
            ) : null}
            {warnings.length > 0 ? (
              <View style={styles.warningBox}>
                <Text style={styles.warningTitle}>识别提示（{warnings.length} 条）</Text>
                {warnings.slice(0, 5).map((warning) => (
                  <Text key={warning} style={styles.muted}>
                    · {warning}
                  </Text>
                ))}
              </View>
            ) : null}
            {/* 诊断模式下的短标签：拿这个号就能在电脑上找到这次识别的原图与结果。 */}
            {state.diagnosticsMode && state.requestId ? (
              <Text style={styles.muted}>诊断请求号：{state.requestId}</Text>
            ) : null}
            <AppButton
              label="下一步：核对并导入"
              onPress={() =>
                navigation.navigate('PhotoReview', {
                  // 导航参数只传可序列化的普通对象。
                  payload: JSON.stringify({ rows: state.rows, week: state.response?.week ?? null }),
                })
              }
              disabled={busy || state.rows.length === 0}
              accessibilityLabel="打开核对页面"
            />
            <AppButton
              label="重新识别这张图"
              onPress={onRetry}
              variant="secondary"
              disabled={busy}
              style={styles.gap}
              accessibilityLabel="重新识别同一张照片"
            />
          </SectionCard>
        ) : null}

        <SectionCard title="说明">
          <Text style={styles.muted}>· 识别只是候选，不会自动写入数据库；导入前你可以逐行修改或取消勾选。</Text>
          <Text style={styles.muted}>· 导入是一整批的单事务：任何一行有问题就整批不写，不会留下半套课表。</Text>
          <Text style={styles.muted}>· 截图里显示「第 N 周」时，导入会按「第 N 周」这一周来填，而不是整学期重复。</Text>
          <Text style={styles.muted}>
            · 识别结果和你手改的内容只在这台手机上；离开这一页会取消正在进行的识别，回来可以点「重试」。
          </Text>
        </SectionCard>
      </ScreenScaffold>

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
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  progressText: { ...typography.caption, flexShrink: 1 },
  note: { ...typography.caption, marginTop: spacing.sm },
  muted: { ...typography.caption, marginTop: spacing.xs },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  error: { ...typography.bodySoft, color: colors.clayDark },
  warningBox: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
  },
  warningTitle: { ...typography.label },
  gap: { marginTop: spacing.sm },
})
