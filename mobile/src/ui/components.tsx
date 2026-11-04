/**
 * 通用原生组件：按钮 / 文本输入 / 徽标 / 状态视图。
 *
 * 可访问性约定：
 * - 所有可点控件 `minHeight: 44`，并带 `accessibilityRole` 与中文 `accessibilityLabel`；
 * - 输入框一律有可见 `label`（不是只有 placeholder），错误用 `accessibilityHint` 播报；
 * - 按钮的禁用态同时设置 `disabled` 与 `accessibilityState`，不做「看起来能点其实没反应」的死按钮。
 */

import React, { useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'

import { colors, MIN_TOUCH_SIZE, radius, spacing, toneColors, typography, type Tone } from './theme'
import { usePressMotion } from './motion'

/* --------------------------------- 按钮 --------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export interface AppButtonProps {
  label: string
  onPress: () => void
  variant?: ButtonVariant
  disabled?: boolean
  loading?: boolean
  /** 无障碍播报文案；默认用 label。 */
  accessibilityLabel?: string
  accessibilityHint?: string
  style?: StyleProp<ViewStyle>
  compact?: boolean
  testID?: string
}

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  accessibilityLabel,
  accessibilityHint,
  style,
  compact = false,
  testID,
}: AppButtonProps): React.ReactElement {
  const inactive = disabled || loading
  const motion = usePressMotion(inactive)
  return (
    <Animated.View style={[{ minWidth: 0, maxWidth: '100%' }, style, { transform: [{ scale: motion.scale }] }]}>
    <Pressable
      onPressIn={motion.onPressIn}
      onPressOut={motion.onPressOut}
      testID={testID}
      onPress={() => { if (!inactive) onPress() }}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={({ pressed }) => [
        styles.button,
        buttonVariantStyle(variant),
        compact && styles.buttonCompact,
        inactive && styles.buttonDisabled,
        pressed && !inactive && styles.buttonPressed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' || variant === 'danger' ? colors.white : colors.primary} />
      ) : (
        <Text style={[styles.buttonLabel, buttonLabelStyle(variant), inactive && styles.buttonLabelDisabled]}>
          {label}
        </Text>
      )}
    </Pressable>
    </Animated.View>
  )
}

function buttonVariantStyle(variant: ButtonVariant): ViewStyle {
  switch (variant) {
    case 'secondary':
      return { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderStrong }
    case 'danger':
      return { backgroundColor: colors.clay, borderWidth: 1, borderColor: colors.clay }
    case 'ghost':
      return { backgroundColor: 'transparent' }
    default:
      return { backgroundColor: colors.primary, borderWidth: 1, borderColor: colors.primary }
  }
}

function buttonLabelStyle(variant: ButtonVariant) {
  switch (variant) {
    case 'secondary':
      return { color: colors.text }
    case 'danger':
      return { color: colors.white }
    case 'ghost':
      return { color: colors.primary }
    default:
      return { color: colors.white }
  }
}

/* --------------------------------- 输入框 -------------------------------- */

export interface AppTextFieldProps extends Omit<TextInputProps, 'style'> {
  label: string
  error?: string | null
  hint?: string
  required?: boolean
  style?: StyleProp<ViewStyle>
}

export function AppTextField({
  label,
  error,
  hint,
  required = false,
  style,
  ...inputProps
}: AppTextFieldProps): React.ReactElement {
  const describedBy = error ?? hint
  const [focused, setFocused] = useState(false)
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabel} accessibilityRole="text">
        {label}
        {required ? <Text style={styles.requiredMark}> *</Text> : null}
      </Text>
      <TextInput
        {...inputProps}
        onFocus={event => { setFocused(true); inputProps.onFocus?.(event) }}
        onBlur={event => { setFocused(false); inputProps.onBlur?.(event) }}
        accessibilityLabel={inputProps.accessibilityLabel ?? label}
        accessibilityHint={describedBy}
        accessibilityState={{ disabled: inputProps.editable === false }}
        style={[styles.input, focused && styles.inputFocused, inputProps.multiline ? styles.inputMultiline : null, error ? styles.inputError : null]}
        placeholderTextColor={colors.textMuted}
      />
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

/** 一组「单选按钮」，原生 Pressable 实现，避免额外依赖。 */
export interface OptionGroupProps<T extends string | number> {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  error?: string | null
  disabled?: boolean
}

export function OptionGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
  error,
  disabled = false,
}: OptionGroupProps<T>): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.optionRow} accessibilityRole="radiogroup">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => onChange(option.value)}
              disabled={disabled}
              accessibilityRole="radio"
              accessibilityLabel={`${label}：${option.label}`}
              accessibilityState={{ selected, disabled }}
              style={({ pressed }) => [
                styles.option,
                selected && styles.optionSelected,
                pressed && !disabled && styles.optionPressed,
                disabled && styles.buttonDisabled,
              ]}
            >
              <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{option.label}</Text>
            </Pressable>
          )
        })}
      </View>
      {error ? (
        <Text style={styles.fieldError} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  )
}

/* ------------------------------ 多选按钮组 ------------------------------ */

/**
 * 一组可多选的原生按钮（模板字段 / 每周周几）。
 *
 * 与 `OptionGroup` 一样只依赖原生 Pressable，每个按钮保持 ≥44pt 触控高度，
 * 无障碍角色用 `checkbox` + `checked`，VoiceOver 能明确读出“已选 / 未选”。
 */
export interface MultiOptionGroupProps<T extends string | number> {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  values: readonly T[]
  onChange: (values: T[]) => void
  error?: string | null
  hint?: string
  disabled?: boolean
}

export function MultiOptionGroup<T extends string | number>({
  label,
  options,
  values,
  onChange,
  error,
  hint,
  disabled = false,
}: MultiOptionGroupProps<T>): React.ReactElement {
  const selected = new Set(values)
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.optionRow}>
        {options.map((option) => {
          const checked = selected.has(option.value)
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => {
                if (checked) onChange(values.filter((value) => value !== option.value))
                else onChange([...values, option.value])
              }}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityLabel={`${label}：${option.label}`}
              accessibilityState={{ checked, disabled }}
              style={({ pressed }) => [
                styles.option,
                checked && styles.optionSelected,
                pressed && !disabled && styles.optionPressed,
                disabled && styles.buttonDisabled,
              ]}
            >
              <Text style={[styles.optionLabel, checked && styles.optionLabelSelected]}>
                {checked ? '✓ ' : ''}
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
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

/* --------------------------------- 徽标 --------------------------------- */

export function Badge({
  text,
  tone = 'neutral',
  accessibilityLabel,
}: {
  text: string
  tone?: Tone
  accessibilityLabel?: string
}): React.ReactElement {
  const palette = toneColors[tone]
  return (
    <View
      style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? text}
    >
      <Text style={[styles.badgeText, { color: palette.fg }]}>{text}</Text>
    </View>
  )
}

/* ------------------------------- 状态视图 ------------------------------- */

export function LoadingState({ message = '正在读取本机数据…' }: { message?: string }): React.ReactElement {
  return (
    <View style={styles.stateBox} accessibilityRole="progressbar" accessibilityLabel={message}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.stateText}>{message}</Text>
    </View>
  )
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  compact = false,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  compact?: boolean
}): React.ReactElement {
  return (
    <View style={[styles.stateBox, compact && styles.stateBoxCompact]}>
      {!compact ? <View style={styles.emptyMark} accessible={false}><Text style={styles.emptyGlyph}>＋</Text></View> : null}
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateText}>{description}</Text>
      {actionLabel && onAction ? (
        <AppButton label={actionLabel} onPress={onAction} variant="secondary" compact style={styles.stateAction} />
      ) : null}
    </View>
  )
}

export function ErrorState({
  message,
  onRetry,
  retryLabel = '重试',
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
}): React.ReactElement {
  return (
    <View style={[styles.stateBox, styles.stateBoxError]} accessibilityRole="alert">
      <Text style={styles.stateTitleError}>出错了</Text>
      <Text style={styles.stateText}>{message}</Text>
      {onRetry ? <AppButton label={retryLabel} onPress={onRetry} variant="secondary" compact style={styles.stateAction} /> : null}
    </View>
  )
}

export function SectionCard({
  title,
  subtitle,
  children,
  style,
}: {
  title?: string
  subtitle?: string
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  return (
    <View style={[styles.card, style]}>
      {title ? (
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{title}</Text>
          {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  )
}

/**
 * 「列表刷新失败」提示条。
 *
 * 与「保存失败」**必须分开**：这时保存其实已经写进去了，只是重新读列表出错。
 * 如果说成「保存失败」，用户会再点一次保存，从而产生重复任务。
 * 因此文案明确说「已经保存好了」，并且只提供「重新读取」这一个动作。
 */
export function RefreshErrorBanner({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.ReactElement {
  return (
    <View style={[styles.stateBox, styles.refreshBanner]} accessibilityRole="alert">
      <Text style={styles.refreshTitle}>列表没能刷新</Text>
      <Text style={styles.stateText}>{message}</Text>
      <Text style={styles.stateText}>
        你的修改已经保存在这台手机上，不需要再保存一次；重新读取即可看到最新内容。
      </Text>
      <AppButton label="重新读取" onPress={onRetry} variant="secondary" compact style={styles.stateAction} />
    </View>
  )
}

const styles = StyleSheet.create({
  button: {
    // Content-sized vertically, including inside a ScrollView's unbounded column.
    flexGrow: 0,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  buttonCompact: { minHeight: MIN_TOUCH_SIZE, paddingHorizontal: spacing.md },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.82 },
  buttonLabel: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  buttonLabelDisabled: { opacity: 0.9 },

  field: { marginBottom: spacing.lg },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs },
  requiredMark: { color: colors.clay },
  input: {
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  inputFocused: { borderColor: colors.primary, backgroundColor: colors.primaryTint },
  inputError: { borderColor: colors.clay },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },
  fieldHint: { ...typography.caption, marginTop: spacing.xs },

  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  option: {
    maxWidth: '100%',
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  optionSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  optionPressed: { opacity: 0.8 },
  optionLabel: { fontSize: 15, color: colors.text },
  optionLabelSelected: { color: colors.primaryDark, fontWeight: '700' },

  badge: {
    maxWidth: '100%',
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeText: { fontSize: 12, fontWeight: '600' },

  stateBox: {
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stateBoxError: { borderColor: colors.clay, backgroundColor: colors.claySoft },
  stateBoxCompact: { padding: spacing.md, borderWidth: 0, backgroundColor: 'transparent', alignSelf: 'stretch', flexGrow: 0 },
  refreshBanner: { borderColor: colors.warn, backgroundColor: colors.warnSoft, alignItems: 'stretch' },
  refreshTitle: { ...typography.section, color: colors.warn, textAlign: 'center' },
  emptyMark: { width: 52, height: 52, borderRadius: 18, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  emptyGlyph: { color: colors.primary, fontSize: 28 },
  stateTitle: { ...typography.section, textAlign: 'center' },
  stateTitleError: { ...typography.section, color: colors.clayDark },
  stateText: { ...typography.caption, textAlign: 'center' },
  stateAction: { marginTop: spacing.sm },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  cardHeader: { marginBottom: spacing.lg, gap: spacing.xs },
  cardTitle: { ...typography.section },
  cardSubtitle: { ...typography.caption, marginTop: 2 },
})
