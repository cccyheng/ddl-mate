/**
 * 应用根组件：安全区 → 数据层 → 导航。
 *
 * 这里没有任何 WebView / PWA 容器：整棵树都是原生 `View` / `Text` / `Pressable`。
 */

import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'

import { AppStoreProvider, useAppStore } from './store/AppStore'
import { RootNavigator } from './navigation/RootNavigator'
import { MotionProvider } from './ui/motion'
import { ErrorState, LoadingState } from './ui/components'
import { colors, spacing, typography } from './ui/theme'

/** 数据库引导期间的整屏状态：加载 / 失败（可重试），不会先显示空列表再闪一下。 */
function BootGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const { status, error, retryBootstrap } = useAppStore()

  if (status === 'loading') {
    return (
      <View style={styles.gate}>
        <LoadingState message="正在打开你的学习空间…" />
      </View>
    )
  }

  if (status === 'error') {
    return (
      <View style={styles.gate}>
        <Text style={styles.brand}>DDL Mate</Text>
        <ErrorState message={error ?? '本机数据库打开失败。'} onRetry={() => void retryBootstrap()} />
      </View>
    )
  }

  return <View style={styles.flex}>{children}</View>
}

export default function App(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <MotionProvider>
      <StatusBar style="dark" />
      <AppStoreProvider>
        <BootGate>
          <RootNavigator />
        </BootGate>
      </AppStoreProvider>
      </MotionProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  gate: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  brand: { ...typography.display, textAlign: 'center', color: colors.primaryDark },
})
