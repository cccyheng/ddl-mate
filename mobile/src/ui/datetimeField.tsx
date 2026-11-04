/**
 * 日期时间与截止时间输入组件（原生浮窗滚轮版）。
 *
 * 用户这一版的要求：凡是需要输入时间的地方，都改成「点一下弹出浮窗，用滚轮选」。
 * 因此日期和时刻不再让用户对着文本键盘逐字敲，而是各有一个可点字段：
 * - 日期：年 / 月 / 日三列滚轮；
 * - 时刻：24 小时制的时 / 分两列滚轮，每一分钟都可选；
 * - 两个浮层都有「取消 / 确定 / 清除」，返回键与点遮罩也会丢弃草稿。
 *
 * 仍然保留的核心口径（与上一版文本输入一致）：
 * - **留空就是「未设置 DDL」**；
 * - 任务表单可选「只填日期」：表示当天结束前，**不会**因为选了日期就补 18:00 / 23:59；
 * - 通知导入 / 时间助手等仍要求精确时刻的场景不传 `allowDateOnly`；
 * - 校验与持久化口径不变：`H:mm` / `HH:mm` 都接受，落库统一补零成 `HH:mm`；
 * - 清除时刻保留日期；清除日期则把整个值清空，绝不留下「有时刻没日期」的假截止时间；
 * - 浮层里的滚轮只是草稿：打开时不写回，确定才写回；取消 / 返回 / 点遮罩丢弃。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'

import {
  addDaysToDateKey,
  isValidDateKey,
  shanghaiNowWallClock,
  shanghaiToday,
  weekdayName,
  weekdayOfDateKey,
} from '../domain/datetime'
import {
  isDateWithoutTime,
  joinWallClock,
  padClockText,
  splitWallClock,
  validateWallClockInput,
} from '../domain/wallClockInput'
import {
  clearWallClockDate,
  clearWallClockTime,
  withWallClockDate,
  withWallClockTime,
} from '../domain/timeWheel'
import {
  ClockWheelSheet,
  DateWheelSheet,
  WallClockPickerButton,
  suggestedCurrentClock,
  suggestedTodayDateKey,
} from './timeWheel'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from './theme'

// 纯逻辑都在 `domain/wallClockInput.ts`（便于测试），这里原样再导出，
// 让调用方仍然可以只 import 这个组件文件。
export {
  isDateWithoutTime,
  joinWallClock,
  padClockText,
  splitWallClock,
  validateWallClockInput,
  type SplitWallClock,
} from '../domain/wallClockInput'

export interface WallClockFieldProps {
  label: string
  /** 北京时间墙上时间 `YYYY-MM-DDTHH:mm`，或只到日期的 `YYYY-MM-DD`；空表示未设置。 */
  value: string
  onChange: (value: string) => void
  /** 校验错误（来自提交时的表单校验，或本地实时校验）。 */
  error?: string | null
  hint?: string
  /** 是否允许只填日期（任务表单开启；通知导入 / 时间助手保持精确到分钟）。 */
  allowDateOnly?: boolean
  /** 是否显示「只填今天 / 只填明天 / 设为现在」快捷填充。 */
  showQuickFill?: boolean
  required?: boolean
  style?: StyleProp<ViewStyle>
  disabled?: boolean
  /**
   * 这一份日期/时刻属于哪一行 / 哪个任务。
   *
   * 浮层开着时如果身份变了（例如通知导入切到另一行、任务表单换成另一个任务），
   * 旧滚轮草稿不会被确认到新的行上。
   */
  identityKey?: string
}

type PickerMode = 'date' | 'clock'

export function WallClockField({
  label,
  value,
  onChange,
  error,
  hint,
  allowDateOnly = false,
  showQuickFill = false,
  required = false,
  style,
  disabled = false,
  identityKey = '',
}: WallClockFieldProps): React.ReactElement {
  const { date, time } = splitWallClock(value)
  const localError = validateWallClockInput(date, time, { allowDateOnly })
  const shownError = error ?? localError
  const dateValid = isValidDateKey(date)

  const [picker, setPicker] = useState<PickerMode | null>(null)
  const openIdentityRef = useRef('')

  const weekday = dateValid ? weekdayOfDateKey(date) : null
  const derivedHint =
    hint ??
    (weekday
      ? `${date} 是${weekdayName(weekday)}（按北京时间解释，与手机时区无关）。`
      : '按北京时间选择日期与时刻，例如 2026-10-15 与 22:00。设备时区不会改变它的含义。')

  const openPicker = useCallback(
    (mode: PickerMode) => {
      if (disabled) return
      if (mode === 'clock' && !dateValid) return
      Keyboard.dismiss()
      openIdentityRef.current = identityKey
      setPicker(mode)
    },
    [dateValid, disabled, identityKey],
  )

  const closePicker = useCallback(() => setPicker(null), [])

  // 保存中 / 这一份值的身份变了：关闭浮层，滚轮草稿随卸载一起丢弃，绝不提交到别处。
  useEffect(() => {
    if (!picker) return
    if (disabled || openIdentityRef.current !== identityKey) setPicker(null)
  }, [disabled, identityKey, picker])

  const canCommit = useCallback((): boolean => {
    if (disabled || openIdentityRef.current !== identityKey) {
      setPicker(null)
      return false
    }
    return true
  }, [disabled, identityKey])

  const commitDate = useCallback(
    (nextDate: string) => {
      if (!canCommit()) return
      // 只换日期；原来没有时刻就仍然只到日期，不自动补时刻。
      onChange(withWallClockDate(value, nextDate))
      setPicker(null)
    },
    [canCommit, onChange, value],
  )

  const commitTime = useCallback(
    (nextTime: string) => {
      if (!canCommit()) return
      onChange(withWallClockTime(value, nextTime))
      setPicker(null)
    },
    [canCommit, onChange, value],
  )

  const clearDate = useCallback(() => {
    if (!canCommit()) return
    // 有时刻也一起清掉：宁可回到「未设置」，也不留下半截的假截止时间。
    onChange(clearWallClockDate(value))
    setPicker(null)
  }, [canCommit, onChange, value])

  const clearTime = useCallback(() => {
    if (!canCommit()) return
    // 保留日期，只去掉时刻（任务表单会得到「当天结束前」）。
    onChange(clearWallClockTime(value))
    setPicker(null)
  }, [canCommit, onChange, value])

  // 「设为现在」本来就同时确定了日期与时刻，所以可以填完整。
  const applyNow = () => {
    const now = shanghaiNowWallClock()
    const { date: nowDate, time: nowTime } = splitWallClock(now)
    onChange(joinWallClock(nowDate, nowTime))
  }
  // 只填日期：**不**补默认时刻；任务表单会把它保存成「当天结束前」。
  const applyToday = () => onChange(joinWallClock(shanghaiToday(), time))
  const applyTomorrow = () => {
    const tomorrow = addDaysToDateKey(shanghaiToday(), 1) ?? shanghaiToday()
    onChange(joinWallClock(tomorrow, time))
  }

  const dateWithoutTime = isDateWithoutTime(date, time)
  const needsTime = dateWithoutTime && !allowDateOnly
  const dateOnly = dateWithoutTime && allowDateOnly && dateValid

  return (
    <View style={[styles.wrapper, style]}>
      <WallClockPickerButton
        label={label}
        required={required}
        value={date}
        placeholder={allowDateOnly ? 'YYYY-MM-DD（选填）' : 'YYYY-MM-DD'}
        onPress={() => openPicker('date')}
        error={shownError && !dateValid ? shownError : null}
        hint={dateValid ? derivedHint : undefined}
        disabled={disabled}
        accessibilityLabel={`${label}的日期`}
        accessibilityHint="打开年 / 月 / 日三列滚轮；确定前不会改动表单"
        testID="wall-clock-date"
      />
      <WallClockPickerButton
        label={allowDateOnly ? '时间（HH:mm，选填）' : '时间（HH:mm，北京时间）'}
        required={!allowDateOnly && date.trim().length > 0}
        value={time}
        placeholder={allowDateOnly ? 'HH:mm（选填）' : 'HH:mm'}
        onPress={() => openPicker('clock')}
        error={shownError && dateValid ? shownError : null}
        hint={dateValid ? undefined : '先选择日期，再用滚轮选择时间；应用不会替你补时刻。'}
        disabled={disabled || !dateValid}
        accessibilityLabel={`${label}的时间`}
        accessibilityHint={
          !dateValid
            ? '先选择日期，才能选择具体时刻'
            : needsTime
              ? '已经选了日期，还需要一个具体时刻'
              : dateOnly
                ? '时间可留空，按日期当天截止；定时提醒需填写具体时间'
                : '打开 24 小时制滚轮，按分钟选择'
        }
        testID="wall-clock-time"
      />
      {showQuickFill ? (
        <View style={styles.quickRow}>
          <QuickChip label="设为现在" onPress={applyNow} disabled={disabled} />
          <QuickChip
            label="只填今天日期"
            onPress={applyToday}
            disabled={disabled}
            accessibilityHint={
              allowDateOnly ? '只填入日期，时间可以留空' : '只填入日期，时间仍需填写具体时刻'
            }
          />
          <QuickChip
            label="只填明天日期"
            onPress={applyTomorrow}
            disabled={disabled}
            accessibilityHint={
              allowDateOnly ? '只填入日期，时间可以留空' : '只填入日期，时间仍需填写具体时刻'
            }
          />
          {value.trim().length > 0 ? (
            <QuickChip label="清空（不设 DDL）" onPress={() => onChange('')} disabled={disabled} />
          ) : null}
        </View>
      ) : null}
      {needsTime ? (
        <Text style={styles.inlineNote} accessibilityRole="alert">
          已选日期，还没有时刻：截止时间需要明确到分钟，应用不会替你猜 18:00 或 23:59。
        </Text>
      ) : null}
      {dateOnly ? (
        <Text style={styles.inlineNote}>
          时间可留空：按 {date} 当天截止（北京时间）；定时提醒需填写具体时间。
        </Text>
      ) : null}

      {picker === 'date' ? (
        <DateWheelSheet
          value={date}
          fallbackDateKey={suggestedTodayDateKey()}
          title="选择日期"
          subtitle={`${label} · 年 / 月 / 日（北京时间）`}
          disabled={disabled}
          clearLabel={value.trim().length > 0 ? (time.trim().length > 0 ? '清除日期与时间' : '清除日期') : undefined}
          onClear={value.trim().length > 0 ? clearDate : undefined}
          onCancel={closePicker}
          onConfirm={commitDate}
          testID="wall-clock-date-sheet"
        />
      ) : null}

      {picker === 'clock' ? (
        <ClockWheelSheet
          value={time}
          fallbackClock={suggestedCurrentClock()}
          title="选择时间"
          subtitle={`${label} · 24 小时制 · 精确到每一分钟（北京时间）`}
          disabled={disabled}
          clearLabel={time.trim().length > 0 ? '清除时间（保留日期）' : undefined}
          onClear={time.trim().length > 0 ? clearTime : undefined}
          onCancel={closePicker}
          onConfirm={commitTime}
          testID="wall-clock-time-sheet"
        />
      ) : null}
    </View>
  )
}

function QuickChip({
  label,
  onPress,
  disabled,
  accessibilityHint,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  accessibilityHint?: string
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [styles.chip, pressed && !disabled && styles.chipPressed, disabled && styles.chipDisabled]}
    >
      <Text style={styles.chipLabel}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrapper: { marginBottom: spacing.sm },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.primaryTint,
    borderWidth: 1,
    borderColor: colors.primarySoft,
  },
  chipPressed: { opacity: 0.8 },
  chipDisabled: { opacity: 0.45 },
  chipLabel: { fontSize: 14, color: colors.primaryDark, fontWeight: '600' },
  inlineNote: { ...typography.caption, marginTop: spacing.xs },
})
