/**
 * **截图库**：用户提交给 App 的每一张图都在这里，随时能回看原图。
 *
 * 为什么需要这一页（用户的原话是「记得把所有截图都要保存到软件中」）：
 * - `expo-image-picker` 只给临时 URI，关掉 Expo Go 就失效；
 * - 识别失败的那张图同样要留得下来，否则用户没法回头检查「到底是图的问题还是识别的问题」；
 * - 从课程 / 课表也能跳回原图（这里通过 `focusAttemptId` 高亮那一张）。
 *
 * 交互：
 * - 列表：缩略图 + 采集时间 + 来源 + 识别状态 + 「已存到本机」/「没存住」；
 * - 点缩略图 → 全屏查看（可双指缩放 / 双击放大，iOS 原生 `ScrollView` 缩放，不加依赖）；
 * - 「重新识别这张图」→ 用**归档的那份原图字节**重新走一遍识别 → 进入核对页；
 *   这样即使当初识别失败，也能不改图地再试一次。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { checkCompanionHealth, recognizeTimetableImage } from '../domain/photoOcrClient'
import { preparePhotoForUpload } from '../domain/photoFiles'
import type { ScreenshotAttempt } from '../domain/screenshotLibraryRepository'
import { useAppStore, type AppStoreValue } from '../store/AppStore'
import { AppButton, Badge, EmptyState, LoadingState, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { ScreenshotViewer } from '../ui/ScreenshotViewer'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'
import {
  createInitialPhotoImportState,
  createPhotoImportOperation,
  type PhotoImportOperation,
} from './photoImportController'

type Nav = NativeStackNavigationProp<CourseStackParamList>
type Route = RouteProp<CourseStackParamList, 'PhotoLibrary'>

/** 这一页只用于「重新识别」，因此初始状态用一份干净的默认值。 */
const EMPTY_LIBRARY_STATE = createInitialPhotoImportState()

/** 采集来源的中文说明。 */
const SOURCE_LABEL: Record<string, string> = {
  LIBRARY: '相册选择',
  CAMERA: '相机拍摄',
  ARCHIVE: '从电脑恢复',
  OTHER: '其它',
}

/** 尝试状态的中文说明（失败/取消也要说清楚，不能一律叫「已保存」）。 */
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

export function PhotoLibraryScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()

  const returnFromLibrary = useCallback(() => {
    // Inspect this stack only: canGoBack() may include a parent tab's history.
    if (navigation.getState().index > 0) navigation.goBack()
    else navigation.replace('CourseList')
  }, [navigation])

  const [attempts, setAttempts] = useState<ScreenshotAttempt[] | null>(null)
  const [viewing, setViewing] = useState<ScreenshotAttempt | null>(null)
  /** 本机找不到原图字节的记录 id（来自启动 / 手动路径检查，以及 Image onError）。 */
  const [missingIds, setMissingIds] = useState<number[]>([])
  const [repairingPaths, setRepairingPaths] = useState(false)
  /** 正在重新识别的那条尝试 id（界面显示进度）。 */
  const [rerunning, setRerunning] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 控制器与 store 的最新引用（控制器只建一次，不订阅整个 store 对象）。 */
  const storeRef = useRef<AppStoreValue>(store)
  storeRef.current = store
  const autoRepairTriedRef = useRef(false)

  const load = useCallback(async () => {
    const list = await store.screenshotLibrary.listAttempts(300)
    setAttempts(list)
  }, [store.screenshotLibrary])

  // 每次回到这一页都重读：导入/恢复之后列表要立刻反映真实内容。
  useFocusEffect(
    useCallback(() => {
      // 启动时的自动修复失败 / 还没跑过：在本页再尝试一次；结果仍会如实显示。
      if ((!store.screenshotPathRepair || !store.screenshotPathRepair.ok) && !autoRepairTriedRef.current) {
        autoRepairTriedRef.current = true
        void store
          .repairScreenshotPaths()
          .then(() => load())
          .catch(() => load())
        return undefined
      }
      void load()
      return undefined
    }, [load, store.repairScreenshotPaths, store.screenshotPathRepair]),
  )

  const applyRepairReport = useCallback((report: NonNullable<AppStoreValue['screenshotPathRepair']>['report']) => {
    if (!report) return
    setMissingIds((previous) => {
      const next = new Set(previous)
      for (const update of report.updates) next.delete(update.attemptId)
      for (const id of report.missingAttemptIds) next.add(id)
      for (const id of report.rejectedAttemptIds) next.add(id)
      return [...next].sort((left, right) => left - right)
    })
  }, [])

  // 路径检查结果变化时同步「找不到」列表；修好的记录必须从缺失集合里移除。
  useEffect(() => {
    if (!store.screenshotPathRepair?.report) return
    applyRepairReport(store.screenshotPathRepair.report)
    void load()
  }, [applyRepairReport, load, store.screenshotPathRepair])

  const markMissing = useCallback((attemptId: number) => {
    setMissingIds((previous) => (previous.includes(attemptId) ? previous : [...previous, attemptId]))
  }, [])

  const repairPaths = useCallback(async () => {
    if (repairingPaths) return
    setRepairingPaths(true)
    setToast(null)
    try {
      const outcome = await store.repairScreenshotPaths()
      if (outcome.report) {
        applyRepairReport(outcome.report)
        setToast({
          text:
            outcome.reason ??
            (outcome.report.repaired > 0
              ? `已修复 ${outcome.report.repaired} 条旧图片路径；重新读取截图库即可查看。`
              : outcome.report.missing + outcome.report.rejected > 0
                ? '检查完成：仍有图片不在这台手机上，可以试试从备份文件只导入截图。'
                : '检查完成：没有发现需要修复的旧图片路径。'),
          tone: outcome.reason ? 'error' : 'success',
        })
      } else {
        setToast({ text: outcome.reason ?? '检查旧图片路径失败。', tone: 'error' })
      }
      await load()
    } finally {
      setRepairingPaths(false)
    }
  }, [applyRepairReport, load, repairingPaths, store])

  useEffect(() => {
    if (route.params?.focusAttemptId) return undefined
    return undefined
  }, [route.params?.focusAttemptId])

  const withFile = useMemo(() => (attempts ?? []).filter((attempt) => attempt.archivedPath), [attempts])

  /**
   * 用**归档的原图字节**重新识别。
   *
   * 复用 `photoImportController` 的完整尝试路径（`recognizeArchived`）而不是各写一套：
   * - 每一轮都新建一次尝试（新历史），**绝不覆盖**原来那条结果；
   * - 转码 / 上传有大小预算（归档允许 25MB，上传只允许 8MB），不会再出现
   *   「直接把 25MB 原图塞给伴侣服务」；
   * - 离开页面 / 重新选择会真的取消，迟到的结果不会把用户带到核对页
   *   （`onDone` 只在「这一轮仍是当前轮」时触发）。
   *
   * 结果登记失败会显式提示（`recordResult` 抛错 → 控制器把原因写进 `archiveError`）。
   */
  const controllerRef = useRef<PhotoImportOperation | null>(null)
  const pendingTargetRef = useRef<ScreenshotAttempt | null>(null)

  if (controllerRef.current === null) {
    controllerRef.current = createPhotoImportOperation({
      state: EMPTY_LIBRARY_STATE,
      pickFromLibrary: async () => ({ status: 'cancelled' }),
      captureFromCamera: async () => ({ status: 'cancelled' }),
      preparePhoto: (uri, source) => preparePhotoForUpload(uri, { source }),
      checkHealth: async (endpoint, timeoutMs) => {
        const result = await checkCompanionHealth(endpoint, { timeoutMs })
        return result.ok
      },
      recognize: (endpoint, options) => recognizeTimetableImage(endpoint, options),
      getEndpoint: () => storeRef.current.ocrEndpoint ?? null,
      getInferredEndpoint: () => storeRef.current.inferredOcrEndpoint ?? null,
      refreshStore: () => storeRef.current.refresh(),
      /** 归档：把这份**已经在库里**的原图再登记成一次新尝试（字节共用一份）。 */
      archiveOriginal: () => storeRef.current.rerunArchiveOriginal(pendingTargetRef.current),
      recordResult: (input) => storeRef.current.recordScreenshotResult(input),
      onDone: (input) => {
        const target = pendingTargetRef.current
        pendingTargetRef.current = null
        setToast({ text: `识别完成：${input.rows.length} 条候选。`, tone: 'success' })
        navigation.navigate('PhotoReview', {
          payload: JSON.stringify({
            rows: input.rows,
            week: input.week,
            attemptId: input.attemptId,
            resultId: null,
          }),
        })
        void target
        void load()
      },
      emit: (event) => {
        if (event.type === 'toast') {
          setToast(event.toast)
          return
        }
        // 「结果没能记进截图库」这类错误必须显示出来，而不是只留在控制器状态里
        // （这一页本来就是用户检查截图历史的地方）。
        if (event.type === 'error' && event.error) {
          setToast({ text: event.error.message, tone: 'error' })
        }
      },
    })
  }

  const controller = controllerRef.current

  // 与照片导入页同样的生命周期：StrictMode 的 setup → cleanup → setup 不能废掉控制器。
  useEffect(() => {
    if (!controller) return undefined
    controller.attach()
    const unsubscribe = controller.subscribe(() => {
      setRerunning(controller.active ? 1 : null)
    })
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  useFocusEffect(
    useCallback(() => {
      controller?.focus()
      return () => controller?.blur()
    }, [controller]),
  )

  const rerunRecognition = useCallback(
    (attempt: ScreenshotAttempt) => {
      if (!attempt.archivedPath || controller.active) return
      pendingTargetRef.current = attempt
      setRerunning(attempt.id)
      setToast(null)
      void controller.recognizeArchived(attempt.archivedPath).finally(() => {
        setRerunning(null)
        void load()
      })
    },
    [controller, load],
  )

  return (
    <>
      <ScreenScaffold
        title="截图库"
        subtitle="你提交过的每一张图都在这台手机上；识别失败的那张也留着"
        headerAccessory={
          <View style={styles.headerActions}>
            <AppButton
              label="返回"
              onPress={returnFromLibrary}
              variant="secondary"
              compact
              accessibilityLabel="返回上一页或课程列表"
              testID="photo-library-back"
            />
            <AppButton
              label="历史来源"
              onPress={() => navigation.navigate('SourceArchive')}
              variant="secondary"
              compact
              accessibilityLabel="打开历史截图来源"
            />
          </View>
        }
      >
        {attempts === null ? (
          <LoadingState message="正在读取本机截图库…" />
        ) : attempts.length === 0 ? (
          <EmptyState
            title="截图库还是空的"
            description="去「拍照导入课表」拍一张或从相册选一张，那张图就会保存到这里（识别失败也会留着）。"
            actionLabel="去拍照导入"
            onAction={() => navigation.navigate('PhotoImport')}
          />
        ) : (
          <SectionCard
            title="全部截图"
            subtitle={`共 ${attempts.length} 条截图，其中 ${withFile.length} 条能看到原图${missingIds.length > 0 ? `，${missingIds.length} 条找不到图片` : ''}`}
          >
            {attempts.map((attempt) => {
              const status = STATUS_LABEL[attempt.status] ?? { text: attempt.status, tone: 'muted' as const }
              const focused = route.params?.focusAttemptId === attempt.id
              const missing = missingIds.includes(attempt.id)
              return (
                <View key={attempt.id} style={[styles.row, focused && styles.rowFocused]}>
                  {attempt.archivedPath && !missing ? (
                    <Pressable
                      onPress={() => setViewing(attempt)}
                      accessibilityRole="imagebutton"
                      accessibilityLabel={`查看第 ${attempt.id} 条截图原图`}
                      accessibilityHint="打开全屏，可缩放"
                      style={({ pressed }) => [styles.thumbBox, pressed && styles.pressed]}
                    >
                      <Image
                        source={{ uri: attempt.archivedPath }}
                        style={styles.thumb}
                        resizeMode="contain"
                        onError={() => markMissing(attempt.id)}
                      />
                    </Pressable>
                  ) : (
                    <View style={styles.thumbBox}>
                      <Text style={styles.thumbMissing}>{missing ? '找不到原图' : '无原图'}</Text>
                    </View>
                  )}

                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>
                      #{attempt.id} · {SOURCE_LABEL[attempt.source] ?? attempt.source}
                    </Text>
                    <Text style={styles.caption}>
                      {formatTime(attempt.capturedAt)} · {describeBytes(attempt.byteLength)}
                      {attempt.width && attempt.height ? ` · ${attempt.width}×${attempt.height}` : ''}
                    </Text>
                    <View style={styles.badgeRow}>
                      <Badge text={status.text} tone={status.tone} />
                      {attempt.dedupOfAttemptId !== null ? (
                        <Badge text={`与 #${attempt.dedupOfAttemptId} 同图`} tone="muted" />
                      ) : null}
                      {attempt.resized ? <Badge text="上传前缩放" tone="muted" /> : null}
                    </View>
                    {attempt.errorMessage ? <Text style={styles.warn}>{attempt.errorMessage}</Text> : null}
                    {attempt.note ? <Text style={styles.caption}>{attempt.note}</Text> : null}
                    {missing ? (
                      <Text style={styles.warn}>
                        这台手机上找不到这张原图（原图还在列表里，没有删除）。可以从「备份与恢复」选择一份备份，
                        在预览里点「只导入截图」把图片找回来；不会恢复或替换当前任务、课程。
                      </Text>
                    ) : null}
                    <View style={styles.actions}>
                      {attempt.archivedPath && !missing ? (
                        <>
                          <AppButton
                            label={rerunning === attempt.id ? '正在重新识别…' : '重新识别这张图'}
                            onPress={() => void rerunRecognition(attempt)}
                            variant="secondary"
                            compact
                            loading={rerunning === attempt.id}
                            disabled={rerunning !== null}
                            accessibilityLabel={`重新识别第 ${attempt.id} 条截图`}
                          />
                          <AppButton
                            label="全屏查看"
                            onPress={() => setViewing(attempt)}
                            variant="ghost"
                            compact
                            accessibilityLabel={`全屏查看第 ${attempt.id} 条截图`}
                          />
                        </>
                      ) : missing ? (
                        <Text style={styles.caption}>可以先点下面的「从备份文件只导入截图」。</Text>
                      ) : (
                        <Text style={styles.caption}>这一条没有可查看的原图（当时没能保存）。</Text>
                      )}
                    </View>
                  </View>
                </View>
              )
            })}
          </SectionCard>
        )}

        <SectionCard title="原图找回" subtitle="系统更新后，旧图片位置可能已经失效">
          <Text style={styles.caption}>
            这里只会检查这台手机里的同一张图；对不上就保持原样，不会按文件名乱猜。
          </Text>
          <View style={styles.actions}>
            <AppButton
              label={repairingPaths ? '正在检查…' : '检查并修复旧图片路径'}
              onPress={() => void repairPaths()}
              variant="secondary"
              compact
              loading={repairingPaths}
              disabled={repairingPaths}
              accessibilityLabel="检查旧截图路径并安全修复"
              accessibilityHint="只更新检查通过的图片位置；缺失或对不上的图片保持原样"
            />
            <AppButton
              label="从备份文件只导入截图"
              onPress={() => navigation.navigate('Backup')}
              variant="ghost"
              compact
              accessibilityLabel="打开备份与恢复，只导入备份里的截图"
              accessibilityHint="不会恢复或替换当前任务、课程；只把备份里的图片复制到截图库"
            />
          </View>
        </SectionCard>

        <SectionCard title="说明">
          <Text style={styles.caption}>· 原图保存在这台手机的应用私有目录里，关掉 App 再打开也还在。</Text>
          <Text style={styles.caption}>· 同一张图重复提交只保存一份，但每次提交都会留下历史。</Text>
          <Text style={styles.caption}>· 这里没有删除入口：截图只增不减，避免误删掉唯一的原图。</Text>
        </SectionCard>
      </ScreenScaffold>

      <ScreenshotViewer
        photo={viewing}
        onClose={() => setViewing(null)}
        title={viewing ? `#${viewing.id} · ${formatTime(viewing.capturedAt)}` : ''}
        footerNote="可以双指缩放查看细节（原图未压缩）。这里显示的就是当初提交的那张图。"
        actionLabel="用这张图重新识别"
        onAction={() => {
          const attempt = viewing
          setViewing(null)
          if (attempt) void rerunRecognition(attempt)
        }}
        onRetry={() => {
          setViewing(null)
          void load()
        }}
      />

      {toast ? (
        <View style={styles.toast} accessibilityRole="alert">
          <Text style={styles.toastText}>{toast.text}</Text>
        </View>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  headerActions: { gap: spacing.xs },
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowFocused: { backgroundColor: colors.primarySoft, borderRadius: radius.md },
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
  thumbMissing: { ...typography.caption, color: colors.textMuted },
  pressed: { opacity: 0.8 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption, marginTop: 2 },
  warn: { ...typography.caption, color: colors.warn, marginTop: 2 },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  toastText: { ...typography.bodySoft },
})
