/**
 * 原生端时间助手（可折叠卡片）—— 纯本地计算，无网络 / 无权限 / 不写库。
 *
 * 交互契约（与 Web 端时间助手一致，见 `docs/native-time-assistant.md`）：
 * - 收起时只显示**当前可编辑的参考时间**、课程与结论摘要，点一下才展开；
 * - 展开后：短语 + **可编辑的通知参考时间**（默认在首次挂载时取一次「现在」，可改；有「重新设为现在」）；
 *   课程沿用表单里**明确选择**的那门课，助手不会从文字里替你挑课；
 * - 解析**只读**：不管解析多少次，都不会改任务草稿、不会写数据库；
 * - **只有**「采用此时间」才会把结果写进截止时间草稿；写完之后仍然可以手工修改；
 * - 短语 / 参考时间 / 课程 / 课表快照 / 手工改截止时间，任一变化都会让已展示的建议**作废**；
 *   采用时会用最新输入再校验一次（规则在 `domain/timeAssistantState.ts` 里，可单测）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { shanghaiDeadlineLabel, shanghaiNowWallClock } from '../domain/datetime'
import {
  assistantView,
  initialAssistantState,
  prepareAdoption,
  resolveForState,
  stepAssistantState,
  type AssistantState,
} from '../domain/timeAssistantState'
import type { Course, Schedule } from '../domain/types'
import { AppButton, AppTextField, Badge, SectionCard } from './components'
import { WallClockField } from './datetimeField'
import { colors, radius, spacing, typography } from './theme'
import { useFocusClock } from './useFocusClock'

export interface TimeAssistantProps {
  /** 当前任务草稿里的截止时间（北京墙上时间 `YYYY-MM-DDTHH:mm`；空串 = 未设置）。 */
  deadline: string
  /** 表单里明确选择的课程（`null` 表示没选）。 */
  courseId: number | null
  courses: ReadonlyArray<Course>
  schedules: ReadonlyArray<Schedule>
  /** 只有用户点「采用此时间」时才会回调。 */
  onAdoptDeadline: (wallClock: string) => void
  /** 保存中 / 数据未就绪时整体禁用（不弹任何权限提示）。 */
  disabled?: boolean
}

const STATUS_BADGES: Record<string, { text: string; tone: 'primary' | 'clay' | 'warn' | 'muted' | 'neutral' }> = {
  RESOLVED: { text: '已解析', tone: 'primary' },
  NEEDS_INFO: { text: '需要补全', tone: 'warn' },
  UNSUPPORTED: { text: '暂不支持', tone: 'clay' },
  NO_COURSE_MATCH: { text: '没有匹配的课', tone: 'muted' },
}

/** 与参考时间无关的「现在」读数：只在页面可见时按分钟推进，用来提示「这个时间已经过去了」。 */
const readNow = (): string => shanghaiNowWallClock()

export function TimeAssistant({
  deadline,
  courseId,
  courses,
  schedules,
  onAdoptDeadline,
  disabled = false,
}: TimeAssistantProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [phrase, setPhrase] = useState('')
  /**
   * 参考时间的初值：**只在首次挂载时取一次「现在」**。
   *
   * 刻意没有「为空就自动补回现在」的兜底：用户把参考时间清空时，必须**如实报错**并停在那里
   * （见 `resolveForState`），否则相对时间会被悄悄算到另一天。
   */
  const [referenceWallClock, setReferenceWallClock] = useState(() => shanghaiNowWallClock())
  const [state, setState] = useState<AssistantState>(initialAssistantState)

  const nowWallClock = useFocusClock(readNow)
  /** 真实的「现在」：只用于「这个时间已经过去了」的提示，绝不参与推算。 */
  const now = useMemo(() => new Date(), [nowWallClock])

  const resetReference = useCallback(() => setReferenceWallClock(shanghaiNowWallClock()), [])

  const selectedCourse = useMemo(
    () => (courseId === null ? null : (courses.find((course) => course.id === courseId) ?? null)),
    [courseId, courses],
  )

  const contextInput = useMemo(
    () => ({ phrase, referenceWallClock, courseId, schedules, courses }),
    [courseId, courses, phrase, referenceWallClock, schedules],
  )
  const view = useMemo(
    () => assistantView(state, contextInput, deadline, now),
    [contextInput, deadline, now, state],
  )

  /** 参考时间输入框为空时立刻给出可见提示（不自动填值）。 */
  const referenceError = referenceWallClock.trim().length === 0 ? '请填写通知参考时间，或点「重新设为现在」。' : null

  /**
   * 上下文或截止时间变化 → 立刻把「已展示但已过期」这件事落到状态里。
   *
   * 用纯函数算出来的 `view.stale` 作为唯一判据（不重复实现一遍规则），
   * 因此后台刷新导致课表 / 课程快照变化时也会走到这里。
   */
  useEffect(() => {
    if (state.stale !== view.stale) {
      setState((previous) => (previous.stale === view.stale ? previous : { ...previous, stale: view.stale }))
    }
  }, [state.stale, view.stale])

  const onResolve = useCallback(() => {
    const { error, result } = resolveForState({
      phrase,
      referenceWallClock,
      courseId,
      courses,
      schedules,
    })
    if (error || !result) {
      setState((previous) =>
        stepAssistantState(previous, { type: 'invalid', error: error ?? '短语不可用。' }, contextInput, deadline),
      )
      return
    }
    setState((previous) => stepAssistantState(previous, { type: 'resolve', result }, contextInput, deadline))
  }, [contextInput, courseId, courses, deadline, phrase, referenceWallClock, schedules])

  /**
   * 采用路径：**事件处理器里做纯结算，updater 里没有任何副作用**。
   *
   * `setState(updater)` 的 updater 必须是纯函数（React 可能在渲染期重放 / 延迟它），
   * 所以这里先用 `prepareAdoption` 算好「下一个状态 + 要写入的时间」，
   * 再 `setState(next)`，并且**只在真的采纳成功时调用一次** `onAdoptDeadline`。
   * 这样父回调永远不在 updater 里执行，也不会因为 updater 被重放而调用两次。
   */
  const onAdopt = useCallback(() => {
    const prepared = prepareAdoption(state, contextInput, deadline)
    if (prepared.next === state) return
    setState(prepared.next)
    if (prepared.adoptedWallClock) onAdoptDeadline(prepared.adoptedWallClock)
  }, [contextInput, deadline, onAdoptDeadline, state])

  const courseLabel = selectedCourse ? `课程：${selectedCourse.name}` : '课程：未选择'
  const referenceLabel = referenceWallClock.trim() ? shanghaiDeadlineLabel(referenceWallClock) : '（未填写）'
  const summary = view.candidate
    ? view.stale
      ? '输入已变化，需要重新解析'
      : view.candidate.label
    : view.error
      ? '输入还需要补全'
      : '还没有解析'

  return (
    <View style={styles.wrapper}>
      <AppButton
        label={expanded ? '收起时间助手' : '展开时间助手'}
        variant="secondary"
        compact
        disabled={disabled}
        accessibilityLabel={expanded ? '收起时间助手' : '展开时间助手'}
        accessibilityHint="助手只在本机做时间换算，不会改你的任务，也不会联网"
        onPress={() => setExpanded((previous) => !previous)}
      />

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          参考时间 {referenceLabel}　{courseLabel}
        </Text>
        <Text style={styles.summaryText}>当前建议：{summary}</Text>
      </View>

      {expanded ? (
        <SectionCard title="时间助手" style={styles.card}>
          <View style={styles.hintRow}>
            <Badge text="本机计算" tone="muted" accessibilityLabel="本机计算，不联网" />
            <Text style={styles.hintText}>按北京时间换算，和手机时区无关；解析不会改动任务，采用后仍可手改。</Text>
          </View>

          <AppTextField
            label="时间短语"
            value={phrase}
            onChangeText={setPhrase}
            placeholder="例如：明天晚上8点 / 本周五 18:00 / 下周五上课前"
            editable={!disabled}
            maxLength={500}
            autoCorrect={false}
            hint="只写一个时间点；助手不支持整段通知的语义抽取。"
            accessibilityLabel="时间短语"
          />

          <WallClockField
            label="通知参考时间"
            value={referenceWallClock}
            onChange={setReferenceWallClock}
            disabled={disabled}
            error={referenceError}
            hint="相对时间（今天 / 明天 / 下周五）按这个时间计算；默认是打开页面时的现在，可改成通知发布的时间。"
            identityKey="time-assistant-reference"
          />

          <View style={styles.buttonRow}>
            <AppButton
              label="重新设为现在"
              variant="secondary"
              compact
              disabled={disabled}
              onPress={resetReference}
              accessibilityLabel="把通知参考时间重新设为现在"
            />
            <AppButton
              label="解析这个短语"
              compact
              disabled={disabled}
              onPress={onResolve}
              accessibilityLabel="解析时间短语"
            />
          </View>

          <Text style={styles.courseNote}>
            {selectedCourse
              ? `课程边界说法（下节课前）按「${selectedCourse.name}」的真实课表计算；想换课请改表单里的「所属课程」。`
              : '「下节课前」这类说法需要先在表单里选好「所属课程」；助手不会从文字里替你挑课。'}
          </Text>

          {view.error ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              {view.error}
            </Text>
          ) : null}

          {view.stale ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              输入已经在解析之后变化（短语 / 参考时间 / 课程 / 课表 / 手工改过的截止时间），这条建议已作废：请重新解析。
            </Text>
          ) : null}

          {!view.selectedCourseAvailable && view.resolution ? (
            <Text style={styles.errorText} accessibilityRole="alert">
              这条建议用到的课程在本机已经找不到了：请重新选择「所属课程」，再解析一次。
            </Text>
          ) : null}

          {view.resolution ? (
            <View style={styles.resultBox}>
              <View style={styles.resultHead}>
                <Badge
                  text={STATUS_BADGES[view.resolution.status]?.text ?? view.resolution.status}
                  tone={STATUS_BADGES[view.resolution.status]?.tone ?? 'neutral'}
                />
              </View>
              <Text style={styles.resultMessage}>{view.resolution.message}</Text>

              {view.candidate ? (
                <>
                  <Text style={styles.resultDeadline}>
                    {view.candidate.label}
                    {view.candidate.past ? '（早于参考时间）' : ''}
                    {view.adopted && view.alreadyElapsed ? '（已经过去了）' : ''}
                  </Text>
                  <Text style={styles.resultLine}>{view.candidate.reason}</Text>
                  {view.candidate.courseBoundary ? (
                    <Text style={styles.resultLine}>
                      课程：{view.candidate.courseName ?? '所选课程'}
                      {view.candidate.scheduleLocation ? `　地点：${view.candidate.scheduleLocation}` : '　地点：课表未填写'}
                    </Text>
                  ) : null}
                  {view.candidate.note ? <Text style={styles.resultLine}>{view.candidate.note}</Text> : null}
                  {view.candidate.past ? (
                    <Text style={styles.warnText} accessibilityRole="alert">
                      这个时间在通知参考时间之前，请确认是不是你要的那一天。
                    </Text>
                  ) : null}
                  {view.alreadyElapsed ? (
                    <Text style={styles.warnText} accessibilityRole="alert">
                      按现在的北京时间看，这个时间已经过去了；助手不会替你改成别的时间。
                    </Text>
                  ) : null}
                  <AppButton
                    label={view.adopted ? '已采用这条时间' : '采用此时间'}
                    compact
                    disabled={disabled || !view.canAdopt}
                    onPress={onAdopt}
                    accessibilityLabel="采用此时间作为截止时间"
                    accessibilityHint="只填入截止时间，保存仍然要用页面下方的保存按钮"
                    style={styles.adoptButton}
                  />
                  <Text style={styles.footNote}>
                    采用只会填入上面的截止时间；不点页面下方的保存就不会保存。
                  </Text>
                </>
              ) : null}

              {view.resolution.hints.map((hint) => (
                <Text key={hint} style={styles.resultHint}>
                  {hint}
                </Text>
              ))}
            </View>
          ) : null}
        </SectionCard>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrapper: { marginTop: spacing.md },
  summary: { marginTop: spacing.xs },
  summaryText: { ...typography.caption },
  card: { marginTop: spacing.md, backgroundColor: colors.surfaceSoft },
  hintRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  hintText: { ...typography.caption, flexShrink: 1 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  courseNote: { ...typography.caption, marginBottom: spacing.sm },
  errorText: { ...typography.caption, color: colors.clay, marginBottom: spacing.sm },
  warnText: { ...typography.caption, color: colors.warn, marginBottom: spacing.sm },
  resultBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  resultHead: { flexDirection: 'row', marginBottom: spacing.sm },
  resultMessage: { ...typography.bodySoft, marginBottom: spacing.sm },
  resultDeadline: { ...typography.section, marginBottom: spacing.xs },
  resultLine: { ...typography.caption, marginBottom: spacing.xs },
  resultHint: { ...typography.caption, marginTop: spacing.xs },
  adoptButton: { marginTop: spacing.sm },
  footNote: { ...typography.caption, marginTop: spacing.xs },
})
