/**
 * 原生浮窗滚轮选择器（日期 / 时钟）。
 *
 * 用户的要求：所有需要输入时间的地方都改成「点一下弹出浮窗，用滚轮选」。
 * 这里刻意只用 React Native 自带能力：
 * - `Modal` 做浮层，底部卡片 + 半透明遮罩；
 * - `ScrollView` + `snapToInterval` + `decelerationRate="fast"` 做吸附滚轮；
 * - `Pressable` 做取消 / 确定 / 清除 / 点选某一项；
 * 没有 WebView、没有网页控件，也没有新增任何依赖。
 *
 * 关键行为（与 `domain/timeWheel.ts` 的纯逻辑一起保证）：
 * - 弹层里的滚轮值只是**草稿**：打开时从当前值初始化，取消 / 返回 / 点遮罩都会丢弃；
 * - 点「确定」才把草稿交给调用方；快速滚动后点确定读的是最后一次滚动位置；
 * - 选中行有居中高亮；点某一项会滚到居中；滚轮首尾都能完整滚到；
 * - 每列都有无障碍 adjustable 角色、当前值和加减操作；
 * - 底部留出安全区，小屏也不会把按钮顶出屏幕。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReducedMotion } from './motion'

import {
  shanghaiNowWallClock,
  shanghaiToday,
  weekdayName,
  weekdayOfDateKey,
} from '../domain/datetime'
import {
  WHEEL_HOURS,
  WHEEL_MAX_YEAR,
  WHEEL_MIN_YEAR,
  WHEEL_MINUTES,
  WHEEL_MONTHS,
  WHEEL_YEARS,
  clampWheelDate,
  formatWheelClock,
  formatWheelDate,
  initialWheelClock,
  initialWheelDate,
  parseWheelClock,
  wheelDaysForMonth,
  type WheelClockParts,
  type WheelDateParts,
} from '../domain/timeWheel'
import { AppButton } from './components'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from './theme'

/** 一行的高度；44pt 同时满足可点区域与稳定的吸附间距。 */
const WHEEL_ITEM_HEIGHT = 44
const WHEEL_VISIBLE_ITEMS = 5
const WHEEL_HEIGHT = WHEEL_ITEM_HEIGHT * WHEEL_VISIBLE_ITEMS
/** 上下留白 = (可视高度 - 一行) / 2，让第一项和最后一项都能滚到正中间。 */
const WHEEL_PADDING = (WHEEL_HEIGHT - WHEEL_ITEM_HEIGHT) / 2
const WHEEL_SELECT_THRESHOLD = WHEEL_ITEM_HEIGHT * 0.75

const formatYear = (value: number): string => `${value} 年`
const formatMonth = (value: number): string => `${value} 月`
const formatDay = (value: number): string => `${value} 日`
const formatHour = (value: number): string => `${String(value).padStart(2, '0')} 时`
const formatMinute = (value: number): string => `${String(value).padStart(2, '0')} 分`

function currentClockText(): string {
  const wallClock = shanghaiNowWallClock()
  return wallClock.length >= 16 ? wallClock.slice(11, 16) : '12:00'
}

/* ------------------------------- 滚轮的一列 ------------------------------- */

interface WheelColumnProps {
  label: string
  values: readonly number[]
  selectedIndex: number
  formatValue: (value: number) => string
  onChange: (index: number) => void
  disabled?: boolean
  testID?: string
}

function WheelColumn({
  label,
  values,
  selectedIndex,
  formatValue,
  onChange,
  disabled = false,
  testID,
}: WheelColumnProps): React.ReactElement {
  const scrollRef = useRef<ScrollViewInstance | null>(null)
  const positionedRef = useRef(false)
  const safeIndex = Math.max(0, Math.min(values.length - 1, selectedIndex))
  const indexRef = useRef(safeIndex)
  const offsetRef = useRef(safeIndex * WHEEL_ITEM_HEIGHT)
  /** 初始 contentOffset 固定为打开弹层那一刻的值，之后不再随选中项重设，避免和手指抢。 */
  const initialOffsetRef = useRef({ x: 0, y: safeIndex * WHEEL_ITEM_HEIGHT })
  /** 程序化滚动的目标；动画途中的 onScroll 不覆盖已经选好的目标。 */
  const programmaticRef = useRef<number | null>(null)
  /** 手指正在拖 / 惯性还在走时，外部 effect 不抢滚动。 */
  const draggingRef = useRef(false)
  const momentumRef = useRef(false)

  const scrollToIndex = useCallback((index: number, animated: boolean) => {
    const target = index * WHEEL_ITEM_HEIGHT
    offsetRef.current = target
    indexRef.current = index
    programmaticRef.current = animated ? index : null
    scrollRef.current?.scrollTo({ y: target, animated })
  }, [])

  const positionInitial = useCallback(() => {
    if (positionedRef.current) return
    positionedRef.current = true
    scrollToIndex(safeIndex, false)
  }, [safeIndex, scrollToIndex])

  /**
   * 外部换了选中项（例如月份从 1 月改到 2 月后，31 日被钳到 28 日）时把滚轮带过去。
   * 用户自己滚动时 `offsetRef` 与目标只差不到半行，不会触发回弹，避免和手指抢。
   */
  useEffect(() => {
    if (!positionedRef.current) return
    // 手指拖动或惯性未结束时，渲染可能暂时落后于最新 offset；这时绝不能回滚。
    if (draggingRef.current || momentumRef.current) return
    const target = safeIndex * WHEEL_ITEM_HEIGHT
    if (Math.abs(offsetRef.current - target) > WHEEL_SELECT_THRESHOLD) {
      scrollToIndex(safeIndex, true)
    }
  }, [safeIndex, scrollToIndex])

  const readOffset = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>): number => {
      const maxOffset = Math.max(0, (values.length - 1) * WHEEL_ITEM_HEIGHT)
      const raw = event.nativeEvent.contentOffset.y
      return Math.max(0, Math.min(maxOffset, raw))
    },
    [values.length],
  )

  const syncSelection = useCallback(
    (offset: number): number => {
      offsetRef.current = offset
      const next = Math.max(0, Math.min(values.length - 1, Math.round(offset / WHEEL_ITEM_HEIGHT)))
      if (next !== indexRef.current) {
        indexRef.current = next
        onChange(next)
      }
      return next
    },
    [onChange, values.length],
  )

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = readOffset(event)
      offsetRef.current = offset
      // 程序化滚动（点某一项 / 外部日期钳制）途中不把中间项写回父级；
      // 目标已经在动画开始前选中，最终位置由 momentum / drag end 再对一次。
      if (programmaticRef.current !== null) return
      syncSelection(offset)
    },
    [readOffset, syncSelection],
  )

  const handleScrollBeginDrag = useCallback(() => {
    // 用户重新接管滚轮：取消「程序化目标」屏蔽，后续 onScroll 正常回写。
    draggingRef.current = true
    programmaticRef.current = null
  }, [])

  const handleScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // 没有惯性时可能只有 drag end：这里也要把最终可见位置同步给父级。
      draggingRef.current = false
      programmaticRef.current = null
      syncSelection(readOffset(event))
    },
    [readOffset, syncSelection],
  )

  const handleMomentumBegin = useCallback(() => {
    momentumRef.current = true
  }, [])

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = readOffset(event)
      const settled = Math.max(0, Math.min(values.length - 1, Math.round(offset / WHEEL_ITEM_HEIGHT)))
      draggingRef.current = false
      momentumRef.current = false
      programmaticRef.current = null
      // 关键：先同步父级选中值，再（必要时）把滚轮对齐到同一行。
      syncSelection(offset)
      if (Math.abs(offset - settled * WHEEL_ITEM_HEIGHT) > 0.5) {
        scrollToIndex(settled, false)
      }
    },
    [readOffset, scrollToIndex, syncSelection, values.length],
  )

  const selectIndex = useCallback(
    (index: number) => {
      if (disabled) return
      const next = Math.max(0, Math.min(values.length - 1, index))
      onChange(next)
      scrollToIndex(next, true)
    },
    [disabled, onChange, scrollToIndex, values.length],
  )

  const step = useCallback(
    (delta: number) => {
      selectIndex(indexRef.current + delta)
    },
    [selectIndex],
  )

  const selectedValue = values[safeIndex] ?? values[0] ?? 0

  return (
    <View style={styles.wheelColumn} testID={testID}>
      <Text style={styles.wheelColumnCaption}>{label}</Text>
      <View style={styles.wheelViewport}>
        <View pointerEvents="none" style={styles.wheelHighlight} />
        <ScrollView
          ref={scrollRef}
          style={styles.wheelScroll}
          contentContainerStyle={styles.wheelContent}
          contentOffset={initialOffsetRef.current}
          showsVerticalScrollIndicator={false}
          snapToInterval={WHEEL_ITEM_HEIGHT}
          decelerationRate="fast"
          bounces={false}
          scrollEventThrottle={16}
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumBegin}
          onMomentumScrollEnd={handleMomentumEnd}
          onContentSizeChange={positionInitial}
          accessibilityRole="adjustable"
          accessibilityLabel={`${label}滚轮`}
          accessibilityValue={{ text: formatValue(selectedValue) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === 'increment') step(1)
            else if (event.nativeEvent.actionName === 'decrement') step(-1)
          }}
          accessibilityState={{ disabled }}
        >
          {values.map((value, index) => {
            const selected = index === safeIndex
            return (
              <Pressable
                key={value}
                onPress={() => selectIndex(index)}
                disabled={disabled}
                accessible={false}
                style={({ pressed }) => [styles.wheelItem, pressed && !disabled && styles.wheelItemPressed]}
              >
                <Text
                  style={[
                    styles.wheelItemText,
                    selected && styles.wheelItemTextSelected,
                    Math.abs(index - safeIndex) > 1 && styles.wheelItemTextFar,
                  ]}
                >
                  {formatValue(value)}
                </Text>
              </Pressable>
            )
          })}
        </ScrollView>
      </View>
    </View>
  )
}

/* -------------------------------- 浮层骨架 -------------------------------- */

interface WheelSheetFrameProps {
  title: string
  subtitle?: string
  onCancel: () => void
  onConfirm: () => void
  confirmDisabled?: boolean
  clearLabel?: string
  onClear?: () => void
  clearDisabled?: boolean
  testID?: string
  children: React.ReactNode
}

function WheelSheetFrame({
  title,
  subtitle,
  onCancel,
  onConfirm,
  confirmDisabled = false,
  clearLabel,
  onClear,
  clearDisabled = false,
  testID,
  children,
}: WheelSheetFrameProps): React.ReactElement {
  const insets = useSafeAreaInsets()
  const reducedMotion = useReducedMotion()

  return (
    <Modal
      visible
      transparent
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onCancel}
      accessibilityViewIsModal
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="取消滚轮选择"
          onPress={onCancel}
          style={styles.backdropPress}
        />
        <View
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}
          testID={testID}
        >
          <View style={styles.sheetGrabber} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            {subtitle ? <Text style={styles.sheetSubtitle}>{subtitle}</Text> : null}
          </View>
          {children}
          <View style={styles.sheetFooter}>
            <View style={styles.sheetClearSlot}>
              {clearLabel && onClear ? (
                <Pressable
                  onPress={onClear}
                  disabled={clearDisabled}
                  accessibilityRole="button"
                  accessibilityLabel={clearLabel}
                  accessibilityState={{ disabled: clearDisabled }}
                  style={({ pressed }) => [
                    styles.clearButton,
                    pressed && !clearDisabled && styles.clearButtonPressed,
                    clearDisabled && styles.clearButtonDisabled,
                  ]}
                >
                  <Text style={styles.clearLabel}>{clearLabel}</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.sheetActions}>
              <AppButton
                label="取消"
                variant="secondary"
                compact
                onPress={onCancel}
                accessibilityLabel={`取消${title}`}
                accessibilityHint="关闭浮窗并丢弃这次滚轮改动"
              />
              <AppButton
                label="确定"
                compact
                disabled={confirmDisabled}
                onPress={onConfirm}
                accessibilityLabel={`确认${title}`}
                accessibilityHint="把当前居中的滚轮值填回去"
              />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  )
}

/* -------------------------------- 日期滚轮 -------------------------------- */

export interface DateWheelSheetProps {
  value: string
  /** 当前值为空 / 非法时的建议日期（调用方用上海「今天」，不会写回）。 */
  fallbackDateKey: string
  title?: string
  subtitle?: string
  disabled?: boolean
  clearLabel?: string
  onCancel: () => void
  onConfirm: (dateKey: string) => void
  onClear?: () => void
  testID?: string
}

export function DateWheelSheet({
  value,
  fallbackDateKey,
  title = '选择日期',
  subtitle = '年 · 月 · 日（北京时间，与手机时区无关）',
  disabled = false,
  clearLabel,
  onCancel,
  onConfirm,
  onClear,
  testID,
}: DateWheelSheetProps): React.ReactElement {
  const [parts, setParts] = useState<WheelDateParts>(() => initialWheelDate(value, fallbackDateKey))
  /**
   * 同步的「最新滚轮选择」。
   *
   * 滚轮 onScroll 可能在 React 还没重渲染时紧接着触发确定；如果确定只读 `parts` 状态，
   * 就会提交上一帧的值。所有变更先写 ref、再 setState；确定只认这个 ref。
   * 日期在这里就先做闰年 / 月天数钳制，状态与 ref 不会出现两份不同的日期。
   */
  const partsRef = useRef<WheelDateParts>(parts)
  const days = useMemo(
    () => wheelDaysForMonth(parts.year, parts.month),
    [parts.month, parts.year],
  )
  const previewDate = formatWheelDate(parts)
  const weekday = weekdayOfDateKey(previewDate)
  const preview = weekday ? `${previewDate} ${weekdayName(weekday)}` : previewDate

  const commitParts = (next: WheelDateParts) => {
    const clamped = clampWheelDate(next)
    partsRef.current = clamped
    setParts(clamped)
  }

  const changeYear = (index: number) => {
    commitParts({ ...partsRef.current, year: WHEEL_MIN_YEAR + index })
  }
  const changeMonth = (index: number) => {
    commitParts({ ...partsRef.current, month: index + 1 })
  }
  const changeDay = (index: number) => {
    commitParts({ ...partsRef.current, day: index + 1 })
  }

  return (
    <WheelSheetFrame
      title={title}
      subtitle={subtitle}
      onCancel={onCancel}
      onConfirm={() => onConfirm(formatWheelDate(partsRef.current))}
      confirmDisabled={disabled}
      clearLabel={clearLabel}
      onClear={onClear}
      clearDisabled={disabled}
      testID={testID ?? 'date-wheel-sheet'}
    >
      <View style={styles.wheelRow}>
        <WheelColumn
          label="年"
          values={WHEEL_YEARS}
          selectedIndex={parts.year - WHEEL_MIN_YEAR}
          formatValue={formatYear}
          onChange={changeYear}
          disabled={disabled}
          testID="date-wheel-year"
        />
        <WheelColumn
          label="月"
          values={WHEEL_MONTHS}
          selectedIndex={parts.month - 1}
          formatValue={formatMonth}
          onChange={changeMonth}
          disabled={disabled}
          testID="date-wheel-month"
        />
        <WheelColumn
          label="日"
          values={days}
          selectedIndex={parts.day - 1}
          formatValue={formatDay}
          onChange={changeDay}
          disabled={disabled}
          testID="date-wheel-day"
        />
      </View>
      <Text style={styles.sheetPreview} accessibilityLiveRegion="polite">
        当前选择：{preview}
      </Text>
    </WheelSheetFrame>
  )
}

/* -------------------------------- 时钟滚轮 -------------------------------- */

export interface ClockWheelSheetProps {
  value: string
  /** 当前值为空 / 非法时的建议时刻（调用方用上海「现在」，不会写回）。 */
  fallbackClock: string
  title?: string
  subtitle?: string
  disabled?: boolean
  clearLabel?: string
  onCancel: () => void
  onConfirm: (clock: string) => void
  onClear?: () => void
  testID?: string
}

export function ClockWheelSheet({
  value,
  fallbackClock,
  title = '选择时间',
  subtitle = '24 小时制 · 精确到每一分钟（北京时间）',
  disabled = false,
  clearLabel,
  onCancel,
  onConfirm,
  onClear,
  testID,
}: ClockWheelSheetProps): React.ReactElement {
  const [parts, setParts] = useState<WheelClockParts>(() => initialWheelClock(value, fallbackClock))
  /** 同 DateWheelSheet：确定只读同步 ref，避免「滚动后立即确定」提交上一帧。 */
  const partsRef = useRef<WheelClockParts>(parts)

  const commitParts = (next: WheelClockParts) => {
    partsRef.current = next
    setParts(next)
  }

  const changeHour = (index: number) => {
    commitParts({ ...partsRef.current, hour: index })
  }
  const changeMinute = (index: number) => {
    commitParts({ ...partsRef.current, minute: index })
  }

  return (
    <WheelSheetFrame
      title={title}
      subtitle={subtitle}
      onCancel={onCancel}
      onConfirm={() => onConfirm(formatWheelClock(partsRef.current))}
      confirmDisabled={disabled}
      clearLabel={clearLabel}
      onClear={onClear}
      clearDisabled={disabled}
      testID={testID ?? 'clock-wheel-sheet'}
    >
      <View style={styles.wheelRow}>
        <WheelColumn
          label="时"
          values={WHEEL_HOURS}
          selectedIndex={parts.hour}
          formatValue={formatHour}
          onChange={changeHour}
          disabled={disabled}
          testID="clock-wheel-hour"
        />
        <Text style={styles.clockColon}>:</Text>
        <WheelColumn
          label="分"
          values={WHEEL_MINUTES}
          selectedIndex={parts.minute}
          formatValue={formatMinute}
          onChange={changeMinute}
          disabled={disabled}
          testID="clock-wheel-minute"
        />
      </View>
      <Text style={styles.sheetPreview} accessibilityLiveRegion="polite">
        当前选择：{formatWheelClock(parts)}（24 小时制）
      </Text>
    </WheelSheetFrame>
  )
}

/** Duration uses the same accessible wheel and synchronous draft commit as clock/date fields. */
export function DurationWheelSheet({ value, max, title, onCancel, onConfirm }: {
  value: number; max: number; title: string; onCancel: () => void; onConfirm: (minutes: number) => void
}): React.ReactElement {
  const values = useMemo(() => Array.from({ length: max }, (_, i) => i + 1), [max])
  const [minutes, setMinutes] = useState(Math.max(1, Math.min(max, value)))
  const draft = useRef(minutes)
  return <WheelSheetFrame title={title} subtitle={`1–${max} 分钟`} onCancel={onCancel} onConfirm={() => onConfirm(draft.current)} testID="duration-wheel-sheet">
    <View style={styles.wheelRow}><WheelColumn label="分钟" values={values} selectedIndex={minutes - 1}
      formatValue={v => `${v} 分钟`} onChange={i => { draft.current = i + 1; setMinutes(i + 1) }} testID="duration-wheel-minutes" /></View>
    <Text style={styles.sheetPreview}>当前选择：{minutes} 分钟</Text>
  </WheelSheetFrame>
}

/** Weekly durations: a bounded hour wheel plus quarter-hours, using synchronous draft values. */
export function WeeklyGoalWheelSheet({ value, onCancel, onConfirm }: {
  value: number; onCancel: () => void; onConfirm: (minutes: number) => void
}): React.ReactElement {
  const initial = Math.max(15, Math.min(10080, Math.round(value / 15) * 15))
  const [hours, setHours] = useState(Math.floor(initial / 60))
  const [quarter, setQuarter] = useState(initial % 60)
  const draft = useRef({ hours, quarter })
  const hourValues = useMemo(() => Array.from({ length: 169 }, (_, i) => i), [])
  const normalize = () => Math.max(15, Math.min(10080, draft.current.hours * 60 + draft.current.quarter))
  return <WheelSheetFrame title="本周学习目标" subtitle="以 15 分钟为一格，最多 168 小时" onCancel={onCancel} onConfirm={() => onConfirm(normalize())} testID="weekly-goal-wheel">
    <View style={styles.wheelRow}>
      <WheelColumn label="小时" values={hourValues} selectedIndex={hours} formatValue={v => `${v} 小时`} onChange={i => { draft.current.hours = i; setHours(i) }} testID="weekly-goal-hours" />
      <WheelColumn label="分钟" values={[0, 15, 30, 45]} selectedIndex={quarter / 15} formatValue={v => `${v} 分钟`} onChange={i => { draft.current.quarter = i * 15; setQuarter(i * 15) }} testID="weekly-goal-minutes" />
    </View>
    <Text style={styles.sheetPreview}>将设置：{Math.floor(normalize() / 60)} 小时 {normalize() % 60} 分钟</Text>
    <Text style={styles.sheetSubtitle}>零时长按 15 分钟计算；超过一周按 168 小时计算。</Text>
  </WheelSheetFrame>
}

/* ------------------------------- 表单单字段 ------------------------------- */

interface WheelValueButtonProps {
  label: string
  value: string
  placeholder: string
  onPress: () => void
  error?: string | null
  hint?: string
  required?: boolean
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  testID?: string
  style?: StyleProp<ViewStyle>
}

function WheelValueButton({
  label,
  value,
  placeholder,
  onPress,
  error,
  hint,
  required = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
}: WheelValueButtonProps): React.ReactElement {
  const shown = value.trim().length > 0
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel}>
        {label}
        {required ? <Text style={styles.requiredMark}> *</Text> : null}
      </Text>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${accessibilityLabel ?? label}，当前${shown ? value : '未选择'}，点按打开滚轮选择`}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.fieldButton,
          error ? styles.fieldButtonError : null,
          pressed && !disabled && styles.fieldButtonPressed,
          disabled && styles.fieldButtonDisabled,
        ]}
      >
        <Text style={[styles.fieldValue, !shown && styles.fieldPlaceholder]} numberOfLines={1}>
          {shown ? value : placeholder}
        </Text>
        <Text style={styles.fieldAction}>{disabled ? '不可修改' : '滚轮选择'}</Text>
      </Pressable>
      {error ? (
        <Text style={styles.fieldError} accessibilityRole="alert">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  )
}

/** 只选时刻的表单字段：课表起止时间、截图导入核对、今日学习时段共用。 */
export interface TimeWheelFieldProps {
  label: string
  /** `HH:mm`；空串表示没填，交给调用方既有校验决定是否必填。 */
  value: string
  onChange: (value: string) => void
  error?: string | null
  hint?: string
  required?: boolean
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  placeholder?: string
  /** 当前值为空时的建议时刻；默认用打开弹层时的上海「现在」。 */
  fallbackTime?: string
  /** 行 / 星期身份变化时丢弃旧草稿；由列表调用方传入。 */
  identityKey?: string
  testID?: string
  style?: StyleProp<ViewStyle>
}

export function TimeWheelField({
  label,
  value,
  onChange,
  error,
  hint,
  required = false,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  placeholder = '选择时间',
  fallbackTime,
  identityKey = '',
  testID,
  style,
}: TimeWheelFieldProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const openIdentityRef = useRef('')
  const hasValue = value.trim().length > 0

  const openPicker = useCallback(() => {
    if (disabled) return
    Keyboard.dismiss()
    openIdentityRef.current = identityKey
    setOpen(true)
  }, [disabled, identityKey])

  const closePicker = useCallback(() => setOpen(false), [])

  // 保存中 / 这一行换了身份：弹层立即关闭，旧滚轮草稿随组件卸载一起丢弃。
  useEffect(() => {
    if (!open) return
    if (disabled || openIdentityRef.current !== identityKey) setOpen(false)
  }, [disabled, identityKey, open])

  const commit = useCallback(
    (next: string) => {
      if (disabled || openIdentityRef.current !== identityKey) {
        setOpen(false)
        return
      }
      onChange(next)
      setOpen(false)
    },
    [disabled, identityKey, onChange],
  )

  return (
    <>
      <WheelValueButton
        label={label}
        value={value}
        placeholder={placeholder}
        onPress={openPicker}
        error={error}
        hint={hint}
        required={required}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint ?? '打开 24 小时制滚轮，按分钟选择'}
        testID={testID}
        style={style}
      />
      {open ? (
        <ClockWheelSheet
          value={value}
          fallbackClock={fallbackTime ?? currentClockText()}
          title="选择时间"
          subtitle={`${label} · 24 小时制 · 精确到每一分钟（北京时间）`}
          disabled={disabled}
          clearLabel={hasValue ? '清除时间' : undefined}
          onClear={hasValue ? () => commit('') : undefined}
          onCancel={closePicker}
          onConfirm={commit}
          testID={testID ? `${testID}-sheet` : 'time-wheel-sheet'}
        />
      ) : null}
    </>
  )
}

/* -------------------------- 日期 + 时刻组合字段入口 ------------------------- */

export interface WallClockPickerButtonProps extends WheelValueButtonProps {}

/** 截止时间用的可点字段（日期与时刻各一个），由 `datetimeField.tsx` 组装。 */
export function WallClockPickerButton(props: WallClockPickerButtonProps): React.ReactElement {
  return <WheelValueButton {...props} />
}

/** 供组合字段打开日期弹层时使用。 */
export function suggestedTodayDateKey(): string {
  return shanghaiToday()
}

/** 供组合字段打开时钟弹层时使用。 */
export function suggestedCurrentClock(): string {
  return currentClockText()
}

export { WHEEL_ITEM_HEIGHT, WHEEL_VISIBLE_ITEMS, WHEEL_HEIGHT }

const styles = StyleSheet.create({
  wheelColumn: { flex: 1, alignItems: 'stretch' },
  wheelColumnCaption: {
    ...typography.caption,
    textAlign: 'center',
    color: colors.textSoft,
    marginBottom: 2,
  },
  wheelViewport: {
    height: WHEEL_HEIGHT,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceSoft,
  },
  wheelHighlight: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: WHEEL_PADDING,
    height: WHEEL_ITEM_HEIGHT,
    backgroundColor: colors.primaryTint,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.primarySoft,
  },
  wheelScroll: { flex: 1 },
  wheelContent: { paddingVertical: WHEEL_PADDING },
  wheelItem: {
    height: WHEEL_ITEM_HEIGHT,
    minHeight: WHEEL_ITEM_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wheelItemPressed: { opacity: 0.65 },
  wheelItemText: {
    fontSize: 20,
    lineHeight: 24,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  wheelItemTextSelected: { color: colors.primaryDark, fontWeight: '700' },
  wheelItemTextFar: { color: colors.textMuted },

  backdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  backdropPress: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: '92%',
  },
  sheetGrabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.sm,
  },
  sheetHeader: { alignItems: 'center', marginBottom: spacing.sm },
  sheetTitle: { ...typography.section },
  sheetSubtitle: { ...typography.caption, textAlign: 'center', marginTop: 2 },
  wheelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  clockColon: {
    ...typography.title,
    color: colors.textMuted,
    paddingTop: MIN_TOUCH_SIZE / 4,
  },
  sheetPreview: {
    ...typography.bodySoft,
    color: colors.primaryDark,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  sheetFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  sheetClearSlot: { flex: 1, alignItems: 'flex-start' },
  sheetActions: { flexDirection: 'row', gap: spacing.sm },
  clearButton: {
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  clearButtonPressed: { backgroundColor: colors.claySoft },
  clearButtonDisabled: { opacity: 0.45 },
  clearLabel: { ...typography.bodySoft, color: colors.clayDark, fontWeight: '600' },

  field: { marginBottom: spacing.md, minWidth: 0, maxWidth: '100%' },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs },
  requiredMark: { color: colors.clay },
  fieldButton: {
    minHeight: MIN_TOUCH_SIZE + 4,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  fieldButtonError: { borderColor: colors.clay },
  fieldButtonPressed: { backgroundColor: colors.surfaceMute },
  fieldButtonDisabled: { opacity: 0.5 },
  fieldValue: { ...typography.body, flexShrink: 1, fontVariant: ['tabular-nums'] },
  fieldPlaceholder: { color: colors.textMuted },
  fieldAction: { ...typography.caption, color: colors.primaryDark, fontWeight: '600', flexShrink: 1 },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },
  fieldHint: { ...typography.caption, marginTop: spacing.xs },
})
