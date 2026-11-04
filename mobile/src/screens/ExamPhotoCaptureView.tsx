import React, { useState } from 'react'
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native'
import { MAX_NOTICE_SOURCE_CHARS } from '../domain/noticeImport'
import { AppButton, AppTextField, Badge, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { NoticePhotoState } from './noticePhotoController'

export function ExamPhotoSteps({ current }: { current: 1 | 2 | 3 }): React.ReactElement {
  return <View style={styles.steps} accessibilityLabel={`第 ${current} 步，共 3 步`}>
    {['选照片', '识别', '核对导入'].map((label, index) => <View key={label} style={styles.step}>
      <View style={[styles.stepTrack, index + 1 <= current && styles.activeTrack]} />
      <View style={[styles.stepNumber, index + 1 <= current && styles.activeNumber]}>
        <Text style={[styles.numberText, index + 1 <= current && styles.activeText]}>{index + 1 < current ? '✓' : index + 1}</Text>
      </View>
      <Text style={[styles.stepLabel, index + 1 === current && styles.activeLabel]}>{label}</Text>
    </View>)}
  </View>
}

interface Props {
  state: NoticePhotoState
  endpoint: string | null | undefined
  lengthError: string | null
  canAdopt: boolean
  stale: boolean
  onPick: (kind: 'library' | 'camera') => void
  onRecognize: () => void
  onCancel: () => void
  onAdopt: () => void
  onEditText: (text: string) => void
  onRetryArchive: () => void
  onSettings: () => void
  onLibrary: () => void
  onOriginal: () => void
}

/** Exam-specific presentation; the shared controller still owns every operation. */
export function ExamPhotoCaptureView(props: Props): React.ReactElement {
  const { state, endpoint, stale, lengthError } = props
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [textOpen, setTextOpen] = useState(false)
  const hasText = state.text.trim().length > 0
  const hasPhoto = !!state.photoUri
  const busy = state.busy
  const canContinue = props.canAdopt && !busy && !stale && state.archivedOriginal && state.archivedAttemptId !== null

  return <ScreenScaffold title="照片识别考试" subtitle="选一张考试安排，核对后保存到考试与复习。">
    <ExamPhotoSteps current={hasPhoto ? 2 : 1} />
    <SectionCard style={styles.photoCard}>
      <View style={styles.headingRow}>
        <View style={styles.headingCopy}>
          <Text style={styles.eyebrow}>从照片到考试日程</Text>
          <Text style={styles.heading}>考试安排照片</Text>
        </View>
        {state.archivedOriginal ? <Badge text="原图已保存" tone="primary" /> : null}
      </View>
      <View style={[styles.previewBox, !hasPhoto && styles.emptyPreview]}>
        {state.photoUri ? <Image source={{ uri: state.photoUri }} style={styles.preview} resizeMode="contain" accessibilityLabel="已选考试安排照片预览" /> : <>
          <View style={styles.documentArt} accessible={false} importantForAccessibility="no-hide-descendants">
            <View style={styles.documentBack} />
            <View style={styles.documentFront}>
              <View style={styles.documentHeader}><View style={styles.documentDot} /><View style={styles.documentTitle} /></View>
              <View style={styles.documentLine} /><View style={[styles.documentLine, styles.documentShortLine]} />
              <View style={styles.documentCheck}><Text style={styles.documentCheckText}>✓</Text></View>
            </View>
          </View>
          <Text style={styles.emptyTitle}>把考试安排放进来</Text>
          <Text style={[styles.hint, styles.centered]}>支持考试截图或拍照，一张照片可识别多场考试。</Text>
        </>}
      </View>
      <Text style={styles.photoTip}>拍完整 · 保留左侧时间栏 · 避免反光</Text>
      <View style={styles.pickRow}>
        <AppButton label={hasPhoto ? '换一张照片' : '从相册选择'} onPress={() => props.onPick('library')} disabled={busy || stale} variant={hasPhoto ? 'secondary' : 'primary'} style={styles.pickButton} accessibilityLabel="从相册选择考试安排照片" />
        <AppButton label="拍照" onPress={() => props.onPick('camera')} disabled={busy || stale} variant="secondary" style={styles.pickButton} accessibilityLabel="拍摄考试安排" />
      </View>
      {state.archivedOriginal && state.archivedAttemptId !== null ? <AppButton label="查看已保存的原图" onPress={props.onOriginal} variant="ghost" compact disabled={busy} /> : null}
      {state.archiveError && !state.archivedOriginal ? <View style={styles.warningBox}>
        <Text style={styles.warning} accessibilityRole="alert">原图尚未保存：{state.archiveError}</Text>
        <AppButton label="重试保存原图" onPress={props.onRetryArchive} disabled={busy || stale} variant="secondary" compact />
      </View> : null}
      {stale ? <Text style={styles.warning} accessibilityRole="alert">数据已恢复，请返回重新打开考试照片识别。</Text> : null}
      <View style={styles.actionArea}>
        {busy ? <View style={styles.progress} accessibilityRole="progressbar" accessibilityLabel={state.statusText || '正在处理考试照片'}>
          <ActivityIndicator color={colors.primary} /><Text style={styles.progressText}>{state.statusText || '正在处理考试照片…'}</Text>
        </View> : null}
        {busy && (state.phase === 'preparing' || state.phase === 'recognizing') ? <AppButton label="取消这次识别" onPress={props.onCancel} variant="secondary" /> : null}
        {hasText && !busy ? <View style={styles.readyBox}>
          <Text style={styles.resultTitle}>文字已准备好，下一步核对考试</Text>
          <Text style={styles.hint}>确认名称、日期、时间和考场后再导入。</Text>
          <AppButton label="下一步：核对考试" onPress={props.onAdopt} disabled={!canContinue} testID="exam-photo-next" />
          {!state.archivedOriginal ? <Text style={styles.warning}>请先保存原图，再进入核对。</Text> : null}
        </View> : null}
        <AppButton label={hasText ? '重新识别' : '识别考试安排'} onPress={props.onRecognize}
          variant={hasText ? 'secondary' : 'primary'} loading={busy}
          disabled={!hasPhoto || busy || stale || !endpoint}
          accessibilityHint="点击后才开始识别，核对并确认导入后才会保存考试" />
        {!hasPhoto ? <Text style={styles.hint}>先选照片，再点击识别。</Text> : null}
        {!endpoint ? <View style={styles.warningBox}>
          <Text style={styles.warning}>还没有设置识别电脑，请先连接同一 Wi-Fi 并填写地址。</Text>
          <AppButton label="设置识别电脑" onPress={props.onSettings} variant="secondary" compact disabled={busy} />
        </View> : null}
      </View>
      {state.error ? <View style={styles.warningBox} accessibilityRole="alert">
        <Text style={styles.warningTitle}>这次识别未完成</Text>
        <Text style={styles.warning}>{state.error.message}</Text>
        <AppButton label="检查识别设置" onPress={props.onSettings} variant="secondary" compact disabled={busy} />
      </View> : null}
      {state.empty && !hasText ? <Text style={styles.warning} accessibilityRole="alert">没有读到考试文字，请换一张更清晰、信息完整的照片再试。</Text> : null}
      {state.warnings.length ? <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>这些内容需要留意</Text>
        {state.warnings.map((warning, index) => <Text key={`${index}-${warning}`} style={styles.warning}>{warning}</Text>)}
      </View> : null}
      {lengthError ? <Text style={styles.warning} accessibilityRole="alert">{lengthError} 请展开下方识别文字进行修改。</Text> : null}
    </SectionCard>

    {(hasText || state.recognizedText !== null || state.empty || textOpen) ? <SectionCard>
      <AppButton label={textOpen ? '收起识别文字' : '查看或修改识别文字'} onPress={() => setTextOpen(!textOpen)} variant="ghost" />
      {textOpen ? <AppTextField label="识别文字" value={state.text} onChangeText={props.onEditText} editable={!busy && !stale} multiline
        placeholder="可以对照原图补字，保留考试分隔标记。" error={lengthError}
        hint={`${state.text.length} / ${MAX_NOTICE_SOURCE_CHARS} 字；编辑后仍需逐场核对。`} accessibilityLabel="可编辑的考试识别文字" /> : null}
    </SectionCard> : null}

    <SectionCard>
      <Text style={styles.hint}>{endpoint ? '已设置识别电脑 · 使用时需保持同一 Wi-Fi' : '需要同一 Wi-Fi 下的电脑协助识别'}</Text>
      <AppButton label={detailsOpen ? '收起连接与识别详情' : '连接与识别详情'} onPress={() => setDetailsOpen(!detailsOpen)} variant="ghost" compact />
      {detailsOpen ? <View style={styles.details}>
        <Text selectable style={styles.hint}>电脑地址：{endpoint || '未设置'}。是否连接成功以实际识别结果为准。</Text>
        <Text style={styles.hint}>照片只传到你的电脑，原图保存在本机截图库。</Text>
        {state.requestId ? <Text selectable style={styles.hint}>请求号：{state.requestId}</Text> : null}
        {state.error ? <Text selectable style={styles.hint}>错误代码：{state.error.code}</Text> : null}
        {state.image ? <Text style={styles.hint}>图片：{state.image.width}×{state.image.height} · {state.image.format}</Text> : null}
        {state.ocrMs !== null ? <Text style={styles.hint}>识别用时：{(state.ocrMs / 1000).toFixed(1)} 秒</Text> : null}
        <AppButton label="识别服务设置" onPress={props.onSettings} variant="secondary" compact disabled={busy} />
        <AppButton label="打开截图库" onPress={props.onLibrary} variant="secondary" compact disabled={busy} />
      </View> : null}
    </SectionCard>
  </ScreenScaffold>
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  step: { flex: 1, minWidth: 0, alignItems: 'center', gap: spacing.sm },
  stepTrack: { height: 3, borderRadius: radius.pill, backgroundColor: colors.border, alignSelf: 'stretch', marginBottom: spacing.xs },
  activeTrack: { backgroundColor: colors.primary },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMute },
  activeNumber: { backgroundColor: colors.primary },
  numberText: { ...typography.label }, activeText: { color: colors.white },
  stepLabel: { ...typography.caption }, activeLabel: { color: colors.primary, fontWeight: '700' },
  photoCard: { borderRadius: 24 },
  headingRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  headingCopy: { flexGrow: 1, gap: spacing.xs },
  eyebrow: { ...typography.caption, color: colors.primary },
  heading: { ...typography.title, flexShrink: 1 },
  previewBox: { backgroundColor: colors.surfaceSoft, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', marginBottom: spacing.md },
  preview: { width: '100%', height: 240 },
  emptyPreview: { minHeight: 224, backgroundColor: colors.primaryTint, borderStyle: 'dashed', borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  documentArt: { width: 88, height: 88, marginBottom: spacing.sm },
  documentBack: { position: 'absolute', top: 5, left: 12, width: 58, height: 72, borderRadius: radius.md, backgroundColor: colors.primarySoft, transform: [{ rotate: '-12deg' }] },
  documentFront: { position: 'absolute', top: 9, left: 22, width: 58, height: 72, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.white, padding: 10, gap: 8 },
  documentHeader: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  documentDot: { width: 8, height: 8, borderRadius: 3, backgroundColor: colors.primary },
  documentTitle: { height: 4, flex: 1, borderRadius: 2, backgroundColor: colors.primary },
  documentLine: { height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  documentShortLine: { width: '65%' },
  documentCheck: { position: 'absolute', right: -9, bottom: -4, width: 27, height: 27, backgroundColor: colors.primary, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  documentCheckText: { color: colors.white, fontSize: 17, fontWeight: '700' },
  emptyTitle: { ...typography.section },
  centered: { textAlign: 'center' },
  photoTip: { ...typography.caption, textAlign: 'center', marginBottom: spacing.md },
  pickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  pickButton: { flexGrow: 1, flexBasis: 110, minWidth: 110 },
  actionArea: { marginTop: spacing.lg, gap: spacing.sm },
  progress: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  progressText: { ...typography.bodySoft, flex: 1 },
  resultTitle: { ...typography.section, color: colors.primary },
  readyBox: { backgroundColor: colors.primaryTint, borderRadius: radius.lg, padding: spacing.md, gap: spacing.sm },
  hint: { ...typography.caption },
  warningBox: { marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.warnSoft, borderRadius: radius.md, gap: spacing.sm },
  warningTitle: { ...typography.label, color: colors.warn },
  warning: { ...typography.caption, color: colors.warn },
  details: { gap: spacing.sm },
})
