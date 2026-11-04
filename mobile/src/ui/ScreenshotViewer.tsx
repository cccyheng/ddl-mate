/**
 * 全屏原图查看器（截图库与任务原图共用）。
 *
 * 行为与截图库原来的查看器一致：iOS 原生 `ScrollView` 双指缩放，不引入图片库。
 * 但额外把**打不开的原图**如实显示出来：
 * - 没有归档路径：明确说「本机找不到这张原图」，绝不显示一个空的加载圈；
 * - `Image` 加载失败（文件被系统清理 / 损坏）：显示错误与「重新加载图片」「关闭」；
 * - 正常时显示的就是归档的那份字节，不是临时 URI。
 */

import React, { useEffect, useState } from 'react'
import { Image, Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context'

import { AppButton } from './components'
import { colors, spacing, typography } from './theme'

export interface ScreenshotViewerPhoto {
  id: number
  capturedAt: string
  archivedPath: string | null
}

export interface ScreenshotViewerProps {
  photo: ScreenshotViewerPhoto | null
  onClose: () => void
  /** 标题；不传时用 `#id · 采集时间`。 */
  title?: string
  /** 底部说明（例如「这里显示的就是当初提交的那份字节」）。 */
  footerNote?: string
  /** 可选的显式动作（截图库用「用这张图重新识别」；任务原图不传）。 */
  actionLabel?: string
  onAction?: (photo: ScreenshotViewerPhoto) => void
  /**
   * 没有归档路径时的「重新读取」动作。
   *
   * 查看器自己无法让列表重新读库，因此由页面传入：关闭查看器并重新加载列表。
   * 不传时只显示「关闭」，仍然如实说明原图不在。
   */
  onRetry?: () => void
}

function formatTime(iso: string): string {
  const text = String(iso ?? '')
  if (text.length < 16) return text || '时间未知'
  return `${text.slice(0, 10)} ${text.slice(11, 16)}`.replace('T', ' ')
}

export function ScreenshotViewer({
  photo,
  onClose,
  title,
  footerNote,
  actionLabel,
  onAction,
  onRetry,
}: ScreenshotViewerProps): React.ReactElement {
  const [failed, setFailed] = useState(false)
  /** 改变这个值会强制 `Image` 重新尝试加载同一份文件。 */
  const [reloadToken, setReloadToken] = useState(0)
  const photoId = photo?.id ?? null
  const archivedPath = photo?.archivedPath ?? null

  useEffect(() => {
    setFailed(false)
    setReloadToken(0)
  }, [photoId, archivedPath])

  const heading = title ?? (photo ? `#${photo.id} · ${formatTime(photo.capturedAt)}` : '')
  const hasFile = typeof archivedPath === 'string' && archivedPath.length > 0
  const canAct = Boolean(photo) && hasFile && !failed && Boolean(actionLabel) && Boolean(onAction)

  /** 缺图时的「重新读取」也通过 onClose 关闭本模态，再让页面重读列表。 */
  const handleRetry = (): void => {
    try {
      onRetry?.()
    } finally {
      onClose()
    }
  }

  return (
    <Modal visible={photo !== null} animationType="fade" onRequestClose={onClose} transparent={false}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']} testID="screenshot-viewer">
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
              {heading}
            </Text>
            <AppButton
              label="关闭"
              onPress={onClose}
              variant="secondary"
              compact
              style={styles.headerClose}
              accessibilityLabel="关闭原图"
            />
          </View>

          {!hasFile ? (
            <View style={styles.stateBox} accessibilityRole="alert">
              <Text style={styles.stateTitle}>这张原图在本机找不到了</Text>
              <Text style={styles.stateText}>
                它可能被系统清理过，或当初就没有保存成功。可以关闭后回到截图库查看其它记录。
              </Text>
              <View style={styles.stateActions}>
                {onRetry ? (
                  <AppButton
                    label="重新读取"
                    onPress={handleRetry}
                    variant="secondary"
                    compact
                    accessibilityLabel="重新读取原图列表"
                  />
                ) : null}
                <AppButton label="关闭" onPress={onClose} variant="secondary" compact accessibilityLabel="关闭原图" />
              </View>
            </View>
          ) : failed ? (
            <View style={styles.stateBox} accessibilityRole="alert">
              <Text style={styles.stateTitle}>这张原图打不开</Text>
              <Text style={styles.stateText}>
                文件可能被系统清理过，或内容已经损坏。可以重新加载一次；还是不行就先关闭，原图记录不会被改动。
              </Text>
              <View style={styles.stateActions}>
                <AppButton
                  label="重新加载图片"
                  onPress={() => {
                    setFailed(false)
                    setReloadToken((value) => value + 1)
                  }}
                  variant="secondary"
                  compact
                  accessibilityLabel="重新加载这张原图"
                />
                <AppButton label="关闭" onPress={onClose} variant="secondary" compact accessibilityLabel="关闭原图" />
              </View>
            </View>
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.content}
              maximumZoomScale={6}
              minimumZoomScale={1}
              centerContent
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
            >
              <Image
                key={`${photoId ?? 'photo'}:${reloadToken}`}
                source={{ uri: archivedPath ?? '' }}
                style={styles.image}
                resizeMode="contain"
                onError={() => setFailed(true)}
                accessibilityLabel="截图原图"
              />
            </ScrollView>
          )}

          <View style={styles.footer}>
            {footerNote ? <Text style={styles.caption}>{footerNote}</Text> : null}
            <View style={styles.footerActions}>
              {canAct && photo && actionLabel && onAction ? (
                <AppButton
                  label={actionLabel}
                  onPress={() => onAction(photo)}
                  variant="secondary"
                  compact
                  accessibilityLabel={actionLabel}
                />
              ) : null}
              <AppButton
                label="返回"
                onPress={onClose}
                variant="secondary"
                compact
                style={styles.footerReturn}
                accessibilityLabel="返回并关闭原图"
              />
            </View>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'nowrap',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.md,
  },
  title: { ...typography.section, flexShrink: 1, minWidth: 0 },
  headerClose: { flexShrink: 0, minWidth: 44, minHeight: 44 },
  scroll: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: 520 },
  stateBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  stateTitle: { ...typography.section, color: colors.clayDark },
  stateText: { ...typography.bodySoft, textAlign: 'center' },
  stateActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  footer: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  footerActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  footerReturn: { flexShrink: 0, minWidth: 88, minHeight: 44 },
  caption: { ...typography.caption },
})
