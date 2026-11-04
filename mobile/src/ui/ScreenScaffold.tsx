/**
 * 页面外壳：统一处理**安全区**（刘海 / 灵动岛 / 底部 Home 指示条）与键盘避让。
 *
 * - `SafeAreaView` 来自 `react-native-safe-area-context`，是 Expo Go 自带模块；
 * - `KeyboardAvoidingView` 让表单在小屏上不被键盘挡住（iOS 用 `padding`）；
 * - 滚动容器带 `keyboardShouldPersistTaps="handled"`，键盘弹出时按钮依然一次点得中。
 */

import React from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { colors, spacing, typography } from './theme'

export interface ScreenScaffoldProps {
  title: string
  subtitle?: string
  children: React.ReactNode
  /** 标题右侧的操作区（例如「新建」按钮）。 */
  headerAccessory?: React.ReactNode
  scroll?: boolean
  contentStyle?: StyleProp<ViewStyle>
  scrollRef?: React.Ref<React.ComponentRef<typeof ScrollView>>
  testID?: string
}

export function ScreenScaffold({
  title,
  subtitle,
  children,
  headerAccessory,
  scroll = true,
  contentStyle,
  scrollRef,
  testID,
}: ScreenScaffoldProps): React.ReactElement {
  const { width, fontScale } = useWindowDimensions()
  const compactHeader = width < 390 || fontScale > 1.15
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={[styles.content, contentStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.content, styles.contentFlex, contentStyle]}>{children}</View>
  )

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID={testID}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        <View style={[styles.header, compactHeader && styles.headerStacked]}>
          <View style={[styles.headerText, compactHeader && styles.headerTextStacked]}>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          {headerAccessory ? <View style={[styles.accessory, compactHeader && styles.accessoryStacked]}>{headerAccessory}</View> : null}
        </View>
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  headerText: { flex: 1, minWidth: 0 },
  headerStacked: { flexDirection: 'column' },
  headerTextStacked: { flex: 0, width: '100%' },
  title: { ...typography.display },
  subtitle: { ...typography.caption, marginTop: spacing.xs },
  accessory: { paddingTop: spacing.xs, flexShrink: 1, maxWidth: '50%' },
  accessoryStacked: { alignSelf: 'flex-end', maxWidth: '100%', paddingTop: 0 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  contentFlex: { flex: 1 },
})
