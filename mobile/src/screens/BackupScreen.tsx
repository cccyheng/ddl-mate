/**
 * 数据备份与恢复（原生界面）。
 *
 * 主流程：
 * 1. 「创建本机备份」→ 写入应用私有 `Documents/backups/library`，不需要外部目录选择；
 * 2. 本机备份库列出实际存在的文件，可「查看内容」只读浏览任务 / 课程 / 课表 / 截图；
 * 3. 需要时再把同一份本机快照「保存到「文件」」（系统目录选择器）；
 * 4. 外部备份文件可以手动选择 → 预览 → 保留到本机备份库 → 查看内容 / 恢复。
 *
 * 预览、查看内容和恢复是三种不同动作：前两者不写数据库，恢复必须二次确认。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import type { BackupLibraryEntry, BackupPreviewSummary } from '../domain/backupService'
import { shouldNavigateContentView } from '../domain/backupOperationGate'
import { useAppStore, type BackupPreviewOutcome } from '../store/AppStore'
import type { SharedBackupRoutes } from '../navigation/types'
import { AppButton, Badge, RefreshErrorBanner, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'

type Busy = 'createLocal' | 'preview' | 'retain' | 'restore' | 'view' | 'saveLibrary' | 'importImages'
type Nav = NativeStackNavigationProp<SharedBackupRoutes>

function formatBytes(bytes: number | null | undefined): string {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

function formatDate(iso: string): string {
  if (!iso) return '时间未知'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return iso.replace('T', ' ').slice(0, 19)
  }
}

function countsText(counts: BackupPreviewSummary['counts'] | null): string {
  if (!counts) return '内容无法读取'
  return `${counts.tasks} 个任务、${counts.courses} 门课程、${counts.schedules} 条课表、${counts.images} 张截图、${counts.ocrResults} 条识别结果`
}

function kindLabel(kind: BackupLibraryEntry['kind']): string {
  return kind === 'library' ? '本机快照' : '恢复备份'
}

export function BackupScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const [busy, setBusy] = useState<Busy | null>(null)
  const [preview, setPreview] = useState<BackupPreviewSummary | null>(null)
  const [previewOrigin, setPreviewOrigin] = useState<'manual' | 'library' | null>(null)
  const [library, setLibrary] = useState<BackupLibraryEntry[]>([])
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [imageCount, setImageCount] = useState(0)
  const [lastFailure, setLastFailure] = useState<string | null>(null)
  const [confirmVisible, setConfirmVisible] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const storeRef = useRef(store)
  storeRef.current = store
  const previewRef = useRef(preview)
  previewRef.current = preview
  const busyRef = useRef<Busy | null>(null)
  const mountedRef = useRef(true)
  const setLocalBusy = useCallback((value: Busy | null): void => {
    // 同步写 ref：第二次点击在 React 重渲染之前也能被挡住。
    busyRef.current = value
    if (mountedRef.current) setBusy(value)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadLibrary = useCallback(async (): Promise<void> => {
    const current = storeRef.current
    try {
      const [entries, count] = await Promise.all([
        current.backup.listLibrary(),
        current.screenshotLibrary.countAttemptsWithFile(),
      ])
      if (!mountedRef.current) return
      setLibrary(entries.entries)
      setLibraryError(entries.reason)
      setImageCount(count)
    } catch (cause) {
      if (!mountedRef.current) return
      setLibraryError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      void loadLibrary()
      return undefined
    }, [loadLibrary]),
  )

  // 离开页面时清理本次预览的唯一暂存目录；恢复 / 只导入截图进行中绝不删它正在用的目录。
  useEffect(() => {
    return () => {
      const currentPreview = previewRef.current
      if (currentPreview && busyRef.current !== 'restore' && busyRef.current !== 'importImages') {
        void storeRef.current.backup.discardPreview(currentPreview)
      }
    }
  }, [])

  const showError = useCallback((message: string) => {
    if (!mountedRef.current) return
    setLastFailure(message)
    setToast({ text: message, tone: 'error' })
  }, [])

  const applyPreviewOutcome = useCallback(
    (outcome: BackupPreviewOutcome, origin: 'manual' | 'library' | null): void => {
      if (!mountedRef.current) {
        if (outcome.kind === 'ok' && outcome.preview) {
          void storeRef.current.backup.discardPreview(outcome.preview)
        }
        return
      }
      if (outcome.kind === 'ok' && outcome.preview) {
        // 替换预览前先删旧暂存目录，避免多个 import-* 泄漏。
        const previous = previewRef.current
        if (previous && previous.stageDir !== outcome.preview.stageDir) {
          void storeRef.current.backup.discardPreview(previous)
        }
        setPreview(outcome.preview)
        setPreviewOrigin(origin)
        setToast({ text: '已读取并校验备份；预览不会改变数据。请确认下面的内容与替换影响。', tone: 'success' })
      } else if (outcome.kind === 'canceled') {
        setToast({ text: '已取消，没有读取或改动任何数据。', tone: 'success' })
      } else if (outcome.kind === 'error') {
        showError(outcome.reason ?? '这份备份没有通过校验。')
      }
    },
    [showError],
  )

  const handleCreateLocal = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    setLocalBusy('createLocal')
    setLastFailure(null)
    try {
      const outcome = await storeRef.current.backup.createLocalBackup()
      if (!mountedRef.current) return
      if (outcome.kind === 'ok' && outcome.result) {
        setToast({ text: '本机备份已创建。关闭重开后仍可查看。', tone: 'success' })
        await loadLibrary()
      } else if (outcome.kind === 'error') {
        showError(outcome.reason ?? '创建本机备份失败。')
      } else if (outcome.kind === 'busy') {
        showError(outcome.reason ?? '已有备份动作正在进行。')
      }
    } finally {
      setLocalBusy(null)
    }
  }, [loadLibrary, setLocalBusy, showError])

  const handlePickPreview = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    setLocalBusy('preview')
    setLastFailure(null)
    try {
      applyPreviewOutcome(await storeRef.current.backup.pickPreview(), 'manual')
    } finally {
      setLocalBusy(null)
    }
  }, [applyPreviewOutcome, setLocalBusy])

  const handlePreviewLibrary = useCallback(
    async (entry: BackupLibraryEntry): Promise<void> => {
      if (busyRef.current) return
      setLocalBusy('preview')
      setLastFailure(null)
      try {
        applyPreviewOutcome(await storeRef.current.backup.previewLibraryEntry(entry), 'library')
      } finally {
        setLocalBusy(null)
      }
    },
    [applyPreviewOutcome, setLocalBusy],
  )

  const handleRetainPreview = useCallback(async (): Promise<void> => {
    const target = previewRef.current
    if (!target || busyRef.current) return
    setLocalBusy('retain')
    setLastFailure(null)
    try {
      const outcome = await storeRef.current.backup.retainPreviewInLibrary(target)
      if (!mountedRef.current) return
      if (outcome.kind === 'ok') {
        setToast({ text: '已保留到本机备份库；以后重启 App 也能直接查看内容。', tone: 'success' })
        await loadLibrary()
      } else if (outcome.kind === 'error') {
        showError(outcome.reason ?? '保存到本机备份库失败。')
      } else if (outcome.kind === 'busy') {
        showError(outcome.reason ?? '已有备份动作正在进行。')
      }
    } finally {
      setLocalBusy(null)
    }
  }, [loadLibrary, setLocalBusy, showError])

  /**
   * 只把预览里校验过的**图片字节**导入截图库；任务、课程、课表、设置一条都不动。
   * 这不是恢复：按钮文案与结果提示都明确区分，避免用户以为当前数据会被替换。
   */
  const handleImportImagesOnly = useCallback(async (): Promise<void> => {
    const target = previewRef.current
    if (!target || busyRef.current) return
    setLocalBusy('importImages')
    setLastFailure(null)
    try {
      const outcome = await storeRef.current.backup.importImagesFromPreview(target)
      if (!mountedRef.current) return
      const result = outcome.kind === 'committed' ? outcome.result : null
      if (result?.committed) {
        setToast({ text: result.message, tone: 'success' })
        if (outcome.refreshError) {
          setToast({
            text: `${result.message} 截图库列表需要重新读取一次才能看到最新内容，不用再导入一遍。`,
            tone: 'success',
          })
        }
        await loadLibrary()
      } else if (outcome.kind === 'error') {
        showError(outcome.reason ?? '只导入截图没有完成；任务和课程没有被改动。')
      } else if (outcome.kind === 'busy') {
        showError(outcome.reason ?? '已有备份动作正在进行。')
      }
    } finally {
      setLocalBusy(null)
    }
  }, [loadLibrary, setLocalBusy, showError])

  const handleOpenContent = useCallback(
    async (entry: BackupLibraryEntry): Promise<void> => {
      if (busyRef.current) return
      setLocalBusy('view')
      setLastFailure(null)
      try {
        const outcome = await storeRef.current.backup.openContentView(entry)
        if (!shouldNavigateContentView(mountedRef.current, navigation.isFocused())) {
          // 迟到的 open 结果：不导航隐藏栈，并只清掉这次返回的 view。
          if (outcome.kind === 'ok' && outcome.view) {
            await storeRef.current.backup.closeContentView(outcome.view.viewDir)
          }
          return
        }
        if (outcome.kind === 'ok' && outcome.view) {
          navigation.navigate('BackupContent', { viewDir: outcome.view.viewDir })
        } else if (outcome.kind === 'error') {
          showError(outcome.reason ?? '无法打开这份备份的内容。')
        } else if (outcome.kind === 'busy') {
          showError(outcome.reason ?? '已有备份动作正在进行。')
        }
      } finally {
        setLocalBusy(null)
      }
    },
    [navigation, setLocalBusy, showError],
  )

  const handleSaveLibrary = useCallback(
    async (entry: BackupLibraryEntry): Promise<void> => {
      if (busyRef.current) return
      setLocalBusy('saveLibrary')
      setLastFailure(null)
      try {
        const outcome = await storeRef.current.backup.saveLibraryEntryToFiles(entry)
        if (!mountedRef.current) return
        if (outcome.kind === 'ok') {
          setToast({ text: `已保存到「文件」：${outcome.fileName ?? entry.fileName}`, tone: 'success' })
        } else if (outcome.kind === 'canceled') {
          setToast({ text: '已取消，没有写出文件。', tone: 'success' })
        } else if (outcome.kind === 'error') {
          showError(outcome.reason ?? '保存到「文件」失败。')
        } else if (outcome.kind === 'busy') {
          showError(outcome.reason ?? '已有备份动作正在进行。')
        }
      } finally {
        setLocalBusy(null)
      }
    },
    [setLocalBusy, showError],
  )

  const handleCancelPreview = useCallback(async (): Promise<void> => {
    const target = previewRef.current
    setPreview(null)
    setPreviewOrigin(null)
    setConfirmVisible(false)
    if (target) await storeRef.current.backup.discardPreview(target)
    if (mountedRef.current) setToast({ text: '已取消，没有恢复任何数据。', tone: 'success' })
  }, [])

  const handleConfirmRestore = useCallback(async (): Promise<void> => {
    const target = previewRef.current
    if (!target || busyRef.current) return
    setConfirmVisible(false)
    setLocalBusy('restore')
    setLastFailure(null)
    try {
      const outcome = await storeRef.current.backup.restore(target)
      if (!mountedRef.current) return
      if (outcome.kind === 'committed' && outcome.result) {
        setPreview(null)
        setPreviewOrigin(null)
        setToast({ text: '数据已恢复。', tone: 'success' })
        await loadLibrary()
      } else if (outcome.kind === 'failed') {
        setPreview(null)
        setPreviewOrigin(null)
        showError(outcome.reason ?? '恢复没有完成；当前数据没有被替换。')
        await storeRef.current.backup.discardPreview(target)
      } else if (outcome.kind === 'busy') {
        showError(outcome.reason ?? '已有备份动作正在进行，这份预览已保留。')
      }
    } finally {
      setLocalBusy(null)
    }
  }, [loadLibrary, setLocalBusy, showError])

  const confirmDetails = useMemo((): string[] => {
    if (!preview) return []
    const lines = [
      `备份文件：${preview.sourceName}（${formatBytes(preview.fileByteLength)}，格式 ${preview.format} v${preview.version}，创建于 ${formatDate(preview.createdAt)}）。`,
      `备份内容：${countsText(preview.counts)}；截图字节合计 ${formatBytes(preview.totalImageBytes)}。`,
      `恢复会替换当前 ${store.data.tasks.length} 个任务、${store.data.courses.length} 门课程、${store.data.schedules.length} 条课表、${imageCount} 张截图，以及可恢复设置。`,
      '恢复前会先生成当前数据的完整恢复备份；如果恢复备份没有成功生成，就不会替换当前数据。',
      '恢复后所有任务提醒都会保持关闭，需要到「提醒设置」逐条复核并重新开启。',
      '恢复会关闭当前未保存的表单草稿（包括其它标签页里隐藏的草稿），并把导航重置回首页。',
      '本机 OCR 服务地址保留当前手机的设置；已消费的通知点击回执不会复制。',
    ]
    if (preview.isEmpty) {
      lines.unshift('⚠️ 这是一份空备份：没有任何任务、课程、课表、截图或设置；恢复会清空当前数据。')
    }
    return lines
  }, [imageCount, preview, store.data.courses.length, store.data.schedules.length, store.data.tasks.length])

  return (
    <>
      <ScreenScaffold
        title="备份与恢复"
        subtitle={`当前：${store.data.tasks.length} 个任务 · ${store.data.courses.length} 门课程 · ${store.data.schedules.length} 条课表 · ${imageCount} 张截图`}
      >
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}

        {lastFailure ? (
          <SectionCard title="这次没有完成" subtitle="当前数据没有被替换">
            <Text style={styles.errorText}>{lastFailure}</Text>
            <AppButton label="知道了" variant="secondary" compact onPress={() => setLastFailure(null)} />
          </SectionCard>
        ) : null}

        <SectionCard
          title="本机备份库"
          subtitle="保存在此应用中的备份；关闭重开后仍可查看"
        >
          <Text style={styles.muted}>
            本机备份保存在此应用中，关闭重开后仍可查看。卸载应用会删除本机备份；重要备份请
            用下面每一行的「保存到「文件」」另存一份。
          </Text>
          <AppButton
            label="创建本机备份"
            onPress={() => void handleCreateLocal()}
            loading={busy === 'createLocal'}
            disabled={busy !== null}
            style={styles.action}
            accessibilityHint="把当前数据保存到本机备份库，不打开系统目录选择器"
          />

          {libraryError ? <Text style={styles.warnText}>读取本机备份库失败：{libraryError}</Text> : null}
          {library.length === 0 ? (
            <Text style={styles.muted}>还没有本机备份。点上面「创建本机备份」就会生成第一份。</Text>
          ) : (
            library.map((entry) => (
              <View key={`${entry.kind}:${entry.fileName}`} style={styles.libraryRow}>
                <View style={styles.libraryInfo}>
                  <View style={styles.badgeRow}>
                    <Badge text={kindLabel(entry.kind)} tone={entry.kind === 'recovery' ? 'warn' : 'primary'} />
                    {entry.valid ? <Badge text="已校验" tone="success" /> : <Badge text="无法读取" tone="clay" />}
                  </View>
                  <Text style={styles.libraryName} selectable>
                    {entry.fileName}
                  </Text>
                  <Text style={styles.muted}>
                    {formatDate(entry.createdAt)} · {formatBytes(entry.byteLength)}
                  </Text>
                  {entry.valid ? (
                    <Text style={styles.muted}>{countsText(entry.counts)}</Text>
                  ) : (
                    <Text style={styles.warnText}>文件损坏 / 不完整：{entry.error ?? '无法解析'}</Text>
                  )}
                </View>
                {entry.valid ? (
                  <View style={styles.libraryActions}>
                    <AppButton
                      label="查看内容"
                      compact
                      variant="secondary"
                      loading={busy === 'view'}
                      disabled={busy !== null}
                      onPress={() => void handleOpenContent(entry)}
                      accessibilityLabel={`查看备份 ${entry.fileName} 的内容`}
                    />
                    <AppButton
                      label="恢复这份备份…"
                      compact
                      variant="ghost"
                      loading={busy === 'preview'}
                      disabled={busy !== null}
                      onPress={() => void handlePreviewLibrary(entry)}
                      accessibilityLabel={`先预览再恢复备份 ${entry.fileName}`}
                    />
                    <AppButton
                      label="保存到「文件」"
                      compact
                      variant="ghost"
                      loading={busy === 'saveLibrary'}
                      disabled={busy !== null}
                      onPress={() => void handleSaveLibrary(entry)}
                      accessibilityLabel={`把本机备份 ${entry.fileName} 保存到系统文件`}
                    />
                  </View>
                ) : null}
              </View>
            ))
          )}
          <Text style={styles.muted}>
            应用不会自动删除这些备份。文件损坏或缺失时会明确显示，不会静默忽略。
          </Text>
        </SectionCard>

        {preview ? (
          <SectionCard
            title="备份预览"
            subtitle="预览不改变任何数据；下面的恢复按钮才会替换当前数据"
          >
            <View style={styles.previewBox}>
              <Text style={styles.previewSafety}>预览不会写入或替换任何当前数据。</Text>
              <Text style={styles.previewFileName}>{preview.sourceName}</Text>
              <Text style={styles.muted}>
                {formatBytes(preview.fileByteLength)} · 格式 {preview.format} v{preview.version} · 创建于{' '}
                {formatDate(preview.createdAt)}
              </Text>
              <Text style={styles.previewCounts}>{countsText(preview.counts)}</Text>
              <Text style={styles.muted}>截图字节合计：{formatBytes(preview.totalImageBytes)}</Text>
              {preview.isEmpty ? (
                <Text style={styles.warnText}>
                  ⚠️ 这是一份空备份：没有任何任务、课程、课表、截图或设置。恢复会清空当前数据。
                </Text>
              ) : null}
              <Text style={styles.warnText}>
                恢复会替换当前数据；恢复后所有任务提醒都会保持关闭（提前量保留），需要逐条重新开启。
              </Text>
              <Text style={styles.muted}>
                恢复前会先生成当前数据的完整恢复备份；生成失败则不会替换当前数据。恢复会关闭未保存草稿并重置导航。
              </Text>
              <View style={styles.badgeRow}>
                <Badge text={`${preview.counts.reminders} 条提醒待复核`} tone="warn" />
                <Badge text="保留本机 OCR 地址" tone="muted" />
                <Badge text="不复制通知回执" tone="muted" />
              </View>
              {previewOrigin === 'manual' ? (
                <AppButton
                  label="保留到本机备份库"
                  variant="secondary"
                  onPress={() => void handleRetainPreview()}
                  loading={busy === 'retain'}
                  disabled={busy !== null}
                  style={styles.action}
                  accessibilityHint="把这份已校验的外部备份保留到本机备份库，之后关闭重开也能查看"
                />
              ) : null}

              <Text style={styles.label}>只找回截图（不恢复）</Text>
              {preview.counts.images > 0 ? (
                <>
                  <Text style={styles.muted}>
                    图片会加入当前截图库，保留现有任务和课表。不会恢复或替换任务、课程、课表、设置。同一张图重复导入不会多出新的图片。
                  </Text>
                  <AppButton
                    label="只导入截图"
                    variant="secondary"
                    onPress={() => void handleImportImagesOnly()}
                    loading={busy === 'importImages'}
                    disabled={busy !== null}
                    style={styles.action}
                    accessibilityLabel="只导入截图，不恢复任务或课程"
                    accessibilityHint="图片会加入当前截图库，保留现有任务和课表。"
                  />
                </>
              ) : (
                <Text style={styles.muted}>
                  这份备份里没有截图，无法只导入截图；任务和课程也不会被改动。
                </Text>
              )}
              <AppButton
                label="恢复这份备份（替换当前数据）"
                variant="danger"
                onPress={() => setConfirmVisible(true)}
                disabled={busy !== null}
                style={styles.action}
                accessibilityHint="打开最终确认，恢复前会先创建当前数据的恢复备份"
              />
              <AppButton
                label="取消，不恢复"
                variant="secondary"
                onPress={() => void handleCancelPreview()}
                disabled={busy !== null}
                style={styles.action}
                accessibilityLabel="取消恢复并清理预览"
              />
            </View>
          </SectionCard>
        ) : null}

        <SectionCard
          title="选择其他备份文件"
          subtitle="外部文件 / 以前导出的文件可以先预览；需要长期留在本机时再「保留到本机备份库」"
        >
          <Text style={styles.muted}>
            这里会打开系统文件选择器。以前导出到「文件」的备份需要手动选择一次，才能保留到本机备份库；
            应用不会扫描外部目录或猜测旧文件。预览本身不会恢复任何数据。
          </Text>
          <AppButton
            label="选择备份文件并预览"
            onPress={() => void handlePickPreview()}
            loading={busy === 'preview'}
            disabled={busy !== null}
            variant="secondary"
            style={styles.action}
            accessibilityHint="打开系统文件选择器，读取并校验一份外部备份"
          />
        </SectionCard>

        <SectionCard title="包含与不包含" subtitle="恢复后的设置为什么是这样">
          <Text style={styles.label}>包含</Text>
          <Text style={styles.muted}>任务与原始通知文本；课程 / 课表（教师、单双周、起止周）；截图原图字节与引用；任务步骤；教学周校准；每日参考用时；今日计划；任务提醒选择（恢复后关闭待复核）。</Text>
          <Text style={styles.label}>不包含</Text>
          <Text style={styles.muted}>本机 OCR 服务地址（保留当前手机设置）；已消费通知点击回执 / 旧 OS 通知 ID；任何云端、账号或第三方数据。</Text>
          <Text style={styles.label}>上限</Text>
          <Text style={styles.muted}>单个备份文件 96 MiB；内嵌图片合计 64 MiB；单张 25 MiB；最多 300 张唯一图片。超过上限会明确拒绝，不会截断或静默漏掉。</Text>
          <Text style={styles.muted}>
            本机备份由当前 App 管理；真机系统文件选择 / 保存能力仍需在手机上验收。
          </Text>
        </SectionCard>
      </ScreenScaffold>

      <ConfirmDialog
        visible={confirmVisible}
        title="确认替换当前数据？"
        details={confirmDetails}
        confirmLabel="确认恢复并替换"
        cancelLabel="取消"
        danger
        busy={busy === 'restore'}
        onConfirm={() => void handleConfirmRestore()}
        onCancel={() => setConfirmVisible(false)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  muted: { ...typography.caption, marginTop: spacing.xs },
  errorText: { ...typography.bodySoft, color: colors.clayDark, marginBottom: spacing.md },
  warnText: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  label: { ...typography.label, marginTop: spacing.md },
  action: { marginTop: spacing.md },
  previewBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.warnSoft,
    gap: 2,
  },
  previewSafety: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600' },
  previewFileName: { ...typography.body, fontWeight: '600', marginTop: spacing.xs },
  previewCounts: { ...typography.bodySoft, fontWeight: '600', marginTop: spacing.xs },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  libraryRow: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.sm,
  },
  libraryInfo: { gap: 2 },
  libraryName: { ...typography.bodySoft, fontWeight: '600' },
  libraryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
})
