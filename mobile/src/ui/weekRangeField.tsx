/**
 * 手动课表的教学周范围选择器。
 *
 * 用户的原话是「手动添加的课表无法选择第几周到第几周」，因此这里不再让人
 * 对着两个数字输入框猜，而是给出两个 44pt 的大按钮，点开后用原生 Modal
 * 列出第 1–53 周，点哪一周就是哪一周：
 * - 起始周、结束周分别选择，当前选中的周有明确的深绿选中态；
 * - 列表可滚动，小屏手机也能完整选到第 53 周；
 * - 未选择时显示「未选择」，**不替用户默认第 1 周**；
 * - 起始周晚于结束周时立即给出可见提示，不静默把另一个数字改掉。
 *
 * 范围本身仍由 `scheduleRules.validateTermRange()` 与保存事务做最终校验；
 * 这个组件只负责把用户明确点选的数字交回去。
 */

import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { MAX_TEACHING_WEEK, MIN_TEACHING_WEEK, parseTeachingWeek } from '../domain/teachingWeekRange'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from './theme'

/** 1–53 周，与领域层使用同一组常量，不在界面里另写一份范围。 */
const WEEK_OPTIONS: readonly number[] = Array.from(
  { length: MAX_TEACHING_WEEK - MIN_TEACHING_WEEK + 1 },
  (_, index) => MIN_TEACHING_WEEK + index,
)

type Picking = 'start' | 'end' | null

export interface WeekRangeFieldProps {
  startWeek: string
  endWeek: string
  /** 表单提交后的字段错误；未提交时的起止顺序问题由组件自己提示。 */
  error?: string | null
  disabled?: boolean
  onChangeStart: (week: number) => void
  onChangeEnd: (week: number) => void
}

/** 把草稿里的原始字符串显示成人话；非法旧值不隐藏，提示重新选择。 */
function weekValueLabel(raw: string): string {
  const parsed = parseTeachingWeek(raw)
  if (parsed !== null) return `第 ${parsed} 周`
  const text = raw.trim()
  return text.length > 0 ? `第 ${text} 周（需重选）` : '未选择'
}

export function WeekRangeField({
  startWeek,
  endWeek,
  error,
  disabled = false,
  onChangeStart,
  onChangeEnd,
}: WeekRangeFieldProps): React.ReactElement {
  const [picking, setPicking] = useState<Picking>(null)
  const start = parseTeachingWeek(startWeek)
  const end = parseTeachingWeek(endWeek)
  const localError = start !== null && end !== null && start > end ? '起始周不能晚于结束周，请重新选择。' : null
  const shownError = error ?? localError
  const selectedWeek = picking === 'start' ? start : picking === 'end' ? end : null
  const currentLabel = weekValueLabel(picking === 'start' ? startWeek : endWeek)

  const openPicker = (target: Exclude<Picking, null>): void => {
    if (disabled) return
    setPicking(target)
  }

  const closePicker = (): void => setPicking(null)

  const selectWeek = (week: number): void => {
    if (picking === 'start') onChangeStart(week)
    else if (picking === 'end') onChangeEnd(week)
    setPicking(null)
  }

  return (
    <View style={styles.field} testID="week-range-field">
      <Text style={styles.fieldLabel}>
        第几周到第几周
        <Text style={styles.requiredMark}> *</Text>
      </Text>

      <View style={styles.rangeRow}>
        <Pressable
          testID="week-range-start"
          onPress={() => openPicker('start')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`起始教学周，当前${weekValueLabel(startWeek)}，点按选择`}
          accessibilityHint={shownError ?? '打开教学周选择器，选择 1 到 53 周'}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.weekButton,
            pressed && !disabled && styles.weekButtonPressed,
            disabled && styles.weekButtonDisabled,
          ]}
        >
          <Text style={styles.weekButtonCaption}>起始周</Text>
          <Text style={styles.weekButtonValue}>{weekValueLabel(startWeek)}</Text>
        </Pressable>

        <Text style={styles.rangeDash}>到</Text>

        <Pressable
          testID="week-range-end"
          onPress={() => openPicker('end')}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`结束教学周，当前${weekValueLabel(endWeek)}，点按选择`}
          accessibilityHint={shownError ?? '打开教学周选择器，选择 1 到 53 周'}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.weekButton,
            pressed && !disabled && styles.weekButtonPressed,
            disabled && styles.weekButtonDisabled,
          ]}
        >
          <Text style={styles.weekButtonCaption}>结束周</Text>
          <Text style={styles.weekButtonValue}>{weekValueLabel(endWeek)}</Text>
        </Pressable>
      </View>

      {shownError ? (
        <Text style={styles.fieldError} accessibilityRole="alert">
          {shownError}
        </Text>
      ) : (
        <Text style={styles.hint}>点按「起始周」「结束周」选择，范围是第 1–53 周。</Text>
      )}

      <Modal
        visible={picking !== null}
        transparent
        animationType="fade"
        onRequestClose={closePicker}
        accessibilityViewIsModal
        statusBarTranslucent
      >
        <View style={styles.backdrop}>
          <View style={styles.sheet} testID="week-range-picker">
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>
                  {picking === 'start' ? '选择起始教学周' : '选择结束教学周'}
                </Text>
                <Text style={styles.sheetSubtitle}>
                  {picking === 'start' ? '这门课从第几周开始上' : '这门课上到第几周'} · 共 1–53 周
                </Text>
              </View>
              <Pressable
                onPress={closePicker}
                accessibilityRole="button"
                accessibilityLabel="关闭教学周选择"
                style={({ pressed }) => [styles.closeButton, pressed && styles.weekButtonPressed]}
              >
                <Text style={styles.closeLabel}>关闭</Text>
              </Pressable>
            </View>

            <Text style={styles.sheetCurrent} accessibilityLiveRegion="polite">
              当前选择：{currentLabel}
            </Text>

            <ScrollView
              style={styles.weekScroll}
              contentContainerStyle={styles.weekGrid}
              accessibilityRole="radiogroup"
              accessibilityLabel="教学周 1 到 53"
              showsVerticalScrollIndicator
            >
              {WEEK_OPTIONS.map((week) => {
                const selected = selectedWeek === week
                return (
                  <Pressable
                    key={week}
                    testID={`week-option-${week}`}
                    onPress={() => selectWeek(week)}
                    accessibilityRole="radio"
                    accessibilityLabel={`第 ${week} 周${selected ? '，已选择' : ''}`}
                    accessibilityHint={selected ? '当前选择' : '点按选择这个教学周'}
                    accessibilityState={{ selected }}
                    style={({ pressed }) => [
                      styles.weekCell,
                      selected && styles.weekCellSelected,
                      pressed && styles.weekCellPressed,
                    ]}
                  >
                    <Text style={[styles.weekCellLabel, selected && styles.weekCellLabelSelected]}>{week}</Text>
                  </Pressable>
                )
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.lg },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs },
  requiredMark: { color: colors.clay },
  rangeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  weekButton: {
    flex: 1,
    minHeight: MIN_TOUCH_SIZE + 8,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekButtonPressed: { backgroundColor: colors.surfaceMute },
  weekButtonDisabled: { opacity: 0.45 },
  weekButtonCaption: { ...typography.caption, color: colors.textSoft },
  weekButtonValue: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '700', marginTop: 2 },
  rangeDash: { ...typography.bodySoft, color: colors.textMuted },
  hint: { ...typography.caption, marginTop: spacing.xs },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },

  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  sheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    maxHeight: '86%',
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  sheetHeaderText: { flex: 1 },
  sheetTitle: { ...typography.section },
  sheetSubtitle: { ...typography.caption, marginTop: 2 },
  closeButton: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeLabel: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600' },
  sheetCurrent: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600', marginTop: spacing.sm },
  weekScroll: { flexGrow: 0, flexShrink: 1, marginTop: spacing.sm },
  weekGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingBottom: spacing.sm },
  weekCell: {
    width: 48,
    minHeight: MIN_TOUCH_SIZE,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekCellSelected: { backgroundColor: colors.primary, borderColor: colors.primaryDark },
  weekCellPressed: { opacity: 0.8 },
  weekCellLabel: { ...typography.bodySoft, color: colors.text, fontWeight: '600' },
  weekCellLabelSelected: { color: colors.white, fontWeight: '700' },
})
