import React, { useEffect, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { AppButton } from './components'
import { useReducedMotion } from './motion'
import { MIN_TOUCH_SIZE, spacing, typography } from './theme'

/**
 * 沉浸式专注钟：只负责「展示」，不持有计时器、快照或写入逻辑。
 *
 * 为什么用原生 `Modal`：它是唯一能可靠盖住 React Navigation 标题栏与底部
 * 标签栏、同时保留同一条 FocusTimeScreen 状态的方式。全屏内不再打开第二个
 * Modal：完成/放弃确认用同一棵视图里的内联卡片，避免 iOS 上嵌套
 * `presentation` 的竞态。退出只关闭展示，不调用任何 act。
 */
export type FocusConfirmAction = 'finish' | 'finishAndRest' | 'nextFocus' | 'discard' | 'recover'

export interface FocusFullscreenProps {
  visible: boolean
  /** 首次读取尚未完成时只显示读取状态。 */
  loading: boolean
  active: boolean
  /** 当前活动是否有定时器（番茄专注/休息）；正计时为 false。 */
  countdown: boolean
  rest: boolean
  expired: boolean
  paused: boolean
  issue: string | null
  time: string
  stateLabel: string
  caption: string
  taskTitle: string
  courseName: string
  progress: number | null
  error: string
  message: string
  busy: boolean
  canStart: boolean
  startHint: string
  confirm: FocusConfirmAction | null
  confirmTitle: string
  confirmMessage: string
  confirmLabel: string
  confirmDanger: boolean
  onExit: () => void
  onPauseResume: () => void
  onFinishAndRest: () => void
  onNextFocus: () => void
  onFinish: () => void
  onDiscard: () => void
  onRecover: () => void
  onRetry: () => void
  onStart: () => void
  onCancelConfirm: () => void
  onConfirm: () => void
}

/** 暖白纸色 + 深绿；休息只用一点暖赭石，避免整屏变色。 */
const palette = {
  bg: '#f4f1e8',
  surface: '#fffdf7',
  ink: '#1e3b2f',
  inkSoft: '#52645a',
  muted: '#7b8175',
  line: '#d9d5c6',
  accent: '#2a5743',
  rest: '#7c6436',
  overlay: 'rgba(30, 59, 47, 0.26)',
} as const

function clockFontSize(time: string, width: number, height: number, fontScale: number, compact: boolean): number {
  const chars = Math.max(5, time.length)
  // Digits at ~0.62em wide. Divide by fontScale because Text still scales it.
  const widthBudget = Math.max(200, width - 48) / (chars * 0.62)
  const heightBudget = Math.max(150, height * (compact ? 0.32 : 0.4)) / 1.08
  return Math.max(40, Math.min(132, Math.min(widthBudget, heightBudget) / Math.max(1, fontScale)))
}

export function FocusFullscreen(props: FocusFullscreenProps): React.ReactElement {
  const { width, height, fontScale } = useWindowDimensions()
  const reducedMotion = useReducedMotion()
  const compact = width < 360 || height < 620 || fontScale > 1.25
  const timeSize = clockFontSize(props.time, width, height, fontScale, compact)
  const accent = props.rest ? palette.rest : palette.accent
  const progress = props.progress === null ? null : Math.round(Math.max(0, Math.min(1, props.progress)) * 100)
  const phase = props.loading ? 'loading' : props.issue ? 'issue' : props.active ? `${props.expired ? 'expired' : 'running'}:${props.paused ? 'paused' : 'live'}:${props.rest ? 'rest' : 'focus'}` : 'ready'
  // 展示层自己的轻量展开状态；每次进入/退出全屏或阶段变化时收起。
  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => { setMoreOpen(false) }, [phase, props.visible])
  const moreAction = (action: () => void) => () => { setMoreOpen(false); action() }
  const requestClose = () => { if (!props.busy) props.onExit() }
  const moreToggle = (
    <AppButton
      label={moreOpen ? '收起更多操作' : '更多操作'}
      variant="ghost"
      compact
      disabled={props.busy}
      accessibilityHint="展开保存并休息、下一轮专注或放弃本次"
      onPress={() => setMoreOpen(open => !open)}
      style={styles.moreToggle}
    />
  )

  return (
    <Modal
      visible={props.visible}
      animationType={reducedMotion ? 'none' : 'fade'}
      presentationStyle="fullScreen"
      transparent={false}
      onRequestClose={requestClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.topBar}>
          <Pressable
            onPress={requestClose}
            disabled={props.busy}
            accessibilityRole="button"
            accessibilityLabel="退出全屏"
            accessibilityHint="关闭全屏展示，计时继续，不会停止或保存"
            accessibilityState={{ disabled: props.busy }}
            hitSlop={8}
            style={[styles.exitButton, props.busy && styles.exitDisabled]}
          >
            <Text style={styles.exitGlyph}>×</Text>
            <Text style={styles.exitLabel}>退出</Text>
          </Pressable>
          <Text style={[styles.mode, { color: accent }]} accessibilityRole="text" accessibilityLiveRegion="polite">
            {props.busy ? '保存中…' : props.rest ? '休息' : props.active ? '专注' : '准备'}
          </Text>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, compact && styles.scrollContentCompact]}
          bounces={false}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          accessibilityElementsHidden={props.confirm !== null}
          importantForAccessibility={props.confirm !== null ? 'no-hide-descendants' : 'auto'}
        >
          <View style={styles.body}>
            <View style={styles.heading}>
              <Text style={[styles.state, { color: accent }]}>{props.stateLabel}</Text>
              <Text style={styles.task} numberOfLines={2} ellipsizeMode="tail">
                {props.taskTitle}
              </Text>
              {props.courseName ? (
                <Text style={styles.course} numberOfLines={1} ellipsizeMode="tail">
                  {props.courseName}
                </Text>
              ) : null}
            </View>

            <View style={styles.clockArea}>
              <Text
                accessibilityRole="timer"
                accessibilityLabel={`${props.stateLabel}，${props.time}`}
                adjustsFontSizeToFit
                minimumFontScale={0.55}
                numberOfLines={1}
                allowFontScaling
                style={[styles.time, { color: accent, fontSize: timeSize }]}
              >
                {props.time}
              </Text>
              {progress === null ? null : (
                <View
                  style={styles.progressTrack}
                  accessibilityRole="progressbar"
                  accessibilityLabel={`已完成 ${progress}%`}
                  accessibilityValue={{ min: 0, max: 100, now: progress }}
                >
                  <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: accent }]} />
                </View>
              )}
              <Text style={styles.caption}>{props.caption}</Text>
            </View>

            <View style={styles.feedback}>
              {props.error ? (
                <View style={styles.errorCard} accessibilityRole="alert">
                  <Text style={styles.errorText}>{props.error}</Text>
                  <AppButton
                    label="重新读取状态"
                    variant="secondary"
                    compact
                    disabled={props.busy}
                    onPress={props.onRetry}
                    style={styles.retry}
                  />
                </View>
              ) : null}
              {props.message ? (
                <Text style={styles.message} accessibilityRole="alert" accessibilityLiveRegion="polite">
                  {props.message}
                </Text>
              ) : null}
            </View>

            <View style={styles.controls}>
              {props.loading ? (
                <Text style={styles.loading}>{props.error ? '读取失败，请重试后再开始计时。' : '正在读取手机中的记录…'}</Text>
              ) : props.issue ? (
                <>
                  <Text style={styles.warning} accessibilityRole="alert">{props.issue}</Text>
                  <AppButton
                    label="舍弃未确认时段"
                    variant="danger"
                    disabled={props.busy}
                    onPress={props.onRecover}
                    style={styles.action}
                  />
                  {moreToggle}
                  {moreOpen ? (
                    <View style={styles.morePanel}>
                      <AppButton label="放弃本次" variant="ghost" disabled={props.busy} onPress={moreAction(props.onDiscard)} style={styles.action} />
                    </View>
                  ) : null}
                </>
              ) : props.active && !props.expired ? (
                <>
                  <AppButton
                    label={props.paused ? (props.rest ? '继续休息' : '继续专注') : '暂停一下'}
                    disabled={props.busy}
                    onPress={props.onPauseResume}
                    style={styles.action}
                  />
                  <AppButton
                    label={props.rest ? '结束休息' : '结束并保存'}
                    variant="secondary"
                    disabled={props.busy}
                    onPress={props.onFinish}
                    style={styles.action}
                  />
                  {moreToggle}
                  {moreOpen ? (
                    <View style={styles.morePanel}>
                      {props.rest ? (
                        <AppButton label="开始下一轮专注" variant="secondary" disabled={props.busy} onPress={moreAction(props.onNextFocus)} style={styles.action} />
                      ) : props.countdown ? (
                        <AppButton label="保存并开始休息" variant="secondary" disabled={props.busy} onPress={moreAction(props.onFinishAndRest)} style={styles.action} />
                      ) : null}
                      <AppButton label="放弃本次" variant="ghost" disabled={props.busy} onPress={moreAction(props.onDiscard)} style={styles.action} />
                    </View>
                  ) : null}
                </>
              ) : props.active && props.expired ? (
                <>
                  {props.rest ? (
                    <AppButton
                      label="开始下一轮专注"
                      disabled={props.busy}
                      onPress={props.onNextFocus}
                      style={styles.action}
                    />
                  ) : (
                    <AppButton
                      label="保存并开始休息"
                      disabled={props.busy}
                      onPress={props.onFinishAndRest}
                      style={styles.action}
                    />
                  )}
                  <AppButton
                    label={props.rest ? '结束休息' : '结束并保存'}
                    variant="secondary"
                    disabled={props.busy}
                    onPress={props.onFinish}
                    style={styles.action}
                  />
                  {moreToggle}
                  {moreOpen ? (
                    <View style={styles.morePanel}>
                      <AppButton label="放弃本次" variant="ghost" disabled={props.busy} onPress={moreAction(props.onDiscard)} style={styles.action} />
                    </View>
                  ) : null}
                </>
              ) : (
                <>
                  <AppButton
                    label="开始专注"
                    disabled={props.busy || !props.canStart}
                    onPress={props.onStart}
                    style={styles.action}
                  />
                  {props.startHint ? <Text style={styles.hint}>{props.startHint}</Text> : null}
                  <AppButton label="返回设置" variant="ghost" onPress={requestClose} style={styles.action} />
                </>
              )}
              {props.active && !props.loading ? <Text style={styles.footnote}>退出后计时继续</Text> : null}
            </View>
          </View>
        </ScrollView>

        {props.confirm ? (
          <View
            style={styles.confirmBackdrop}
            accessibilityViewIsModal
            onAccessibilityEscape={props.onCancelConfirm}
          >
            <View style={styles.confirmCard} accessibilityRole="alert">
              <ScrollView style={styles.confirmScroll} contentContainerStyle={styles.confirmScrollContent}>
                <Text style={styles.confirmTitle}>{props.confirmTitle}</Text>
                <Text style={styles.confirmMessage}>{props.confirmMessage}</Text>
              </ScrollView>
              <View style={styles.confirmActions}>
                <AppButton
                  label="取消"
                  variant="secondary"
                  disabled={props.busy}
                  onPress={props.onCancelConfirm}
                  style={styles.confirmAction}
                />
                <AppButton
                  label={props.confirmLabel}
                  variant={props.confirmDanger ? 'danger' : 'primary'}
                  loading={props.busy}
                  onPress={props.onConfirm}
                  style={styles.confirmAction}
                />
              </View>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.bg },
  topBar: {
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  exitButton: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  exitGlyph: { fontSize: 22, lineHeight: 24, color: palette.ink },
  exitLabel: { ...typography.label, color: palette.ink },
  exitDisabled: { opacity: 0.4 },
  mode: { ...typography.label, fontSize: 12, letterSpacing: 2 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: spacing.xl, paddingBottom: spacing.lg },
  scrollContentCompact: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  body: { flexGrow: 1, justifyContent: 'space-between', gap: spacing.lg, paddingTop: spacing.sm },
  heading: { alignItems: 'center', gap: 4, paddingTop: spacing.xs },
  state: { ...typography.label, fontSize: 12, letterSpacing: 1.5 },
  task: { ...typography.title, textAlign: 'center', fontSize: 20, lineHeight: 26, color: palette.ink, maxWidth: '100%' },
  course: { ...typography.caption, textAlign: 'center', maxWidth: '100%' },
  clockArea: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  time: { textAlign: 'center', fontWeight: '300', fontVariant: ['tabular-nums'], letterSpacing: -3, includeFontPadding: false, maxWidth: '100%' },
  progressTrack: { width: '74%', maxWidth: 360, height: 3, borderRadius: 2, backgroundColor: palette.line, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  caption: { ...typography.caption, textAlign: 'center', color: palette.muted },
  feedback: { gap: spacing.sm },
  errorCard: { gap: spacing.sm, padding: spacing.md, borderRadius: 16, borderWidth: 1, borderColor: '#c98a74', backgroundColor: '#fbeee8' },
  errorText: { ...typography.bodySoft, color: '#8f4530' },
  retry: { alignSelf: 'flex-start' },
  message: { ...typography.caption, textAlign: 'center', color: palette.inkSoft },
  controls: { gap: spacing.sm, paddingTop: spacing.xs },
  action: { alignSelf: 'stretch', minHeight: 52 },
  moreToggle: { alignSelf: 'center', minHeight: MIN_TOUCH_SIZE },
  morePanel: { gap: spacing.sm, paddingTop: spacing.xs },
  warning: { ...typography.bodySoft, color: '#8a4b35' },
  loading: { ...typography.bodySoft, textAlign: 'center', color: palette.muted },
  hint: { ...typography.caption, textAlign: 'center', color: palette.muted },
  footnote: { ...typography.caption, textAlign: 'center', color: palette.muted, fontSize: 11, lineHeight: 16, paddingTop: spacing.xs },
  confirmBackdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: palette.overlay,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  confirmCard: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 520,
    maxHeight: '84%',
    padding: spacing.lg,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
  },
  confirmScroll: { flexGrow: 0, flexShrink: 1 },
  confirmScrollContent: { paddingBottom: spacing.sm },
  confirmTitle: { ...typography.title, color: palette.ink, marginBottom: spacing.md },
  confirmMessage: { ...typography.bodySoft, color: palette.inkSoft },
  confirmActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  confirmAction: { flexGrow: 1, flexBasis: 112, minHeight: MIN_TOUCH_SIZE },
})
