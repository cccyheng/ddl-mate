/**
 * 识别服务设置：填写/修改这台电脑上的伴侣服务地址，并做真实健康检查。
 *
 * 三条设计取舍（都来自任务书）：
 * 1. **不把地址写死在代码里**：默认值由 Expo/Metro 的局域网主机名自动推断
 *    （`hostUri` → 同一台电脑的伴侣端口），用户也可以自己改成任何地址；
 * 2. 地址存进本机 SQLite（`app_settings`），下次打开自动带出来；
 * 3. 「测试连接」会真的发一次 `GET /v1/health`，明确告诉用户连上了还是连不上，
 *    以及连上的是不是 DDL Mate 的伴侣服务（避免填错端口连到别的服务）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Constants from 'expo-constants'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { checkCompanionHealth, endpointFromHostUri, normalizeEndpoint } from '../domain/photoOcrClient'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, SectionCard } from '../ui/components'
import { Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>

/** 默认端口与 `companion/src/server.mjs` 的 `DEFAULT_PORT` 一致（后端 8080 / Metro 8081 都错开）。 */
const DEFAULT_COMPANION_PORT = 8082

/** 从 Expo 的 manifest 里取 Metro 的局域网主机名（不同 SDK 字段名不一样，都兜一下）。 */
export function readMetroHostUri(): string | null {
  const manifest = Constants.expoConfig as unknown as {
    hostUri?: string
    debuggerHost?: string
  } | null
  const legacy = Constants.manifest2 as unknown as { extra?: { expoGo?: { debuggerHost?: string } } } | null
  return (
    manifest?.hostUri ??
    manifest?.debuggerHost ??
    legacy?.extra?.expoGo?.debuggerHost ??
    null
  )
}

export function PhotoCompanionSettingsScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const inferred = useMemo(() => endpointFromHostUri(readMetroHostUri(), DEFAULT_COMPANION_PORT), [])
  const [endpoint, setEndpoint] = useState(store.ocrEndpoint ?? inferred ?? '')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [health, setHealth] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  useEffect(() => {
    setEndpoint(store.ocrEndpoint ?? inferred ?? '')
  }, [inferred, store.ocrEndpoint])

  const onSave = useCallback(async () => {
    setFieldError(null)
    const raw = endpoint.trim()
    if (raw.length === 0) {
      setSaving(true)
      try {
        await store.saveOcrEndpoint(null)
        setToast({ text: '已清除识别服务地址。', tone: 'success' })
      } finally {
        setSaving(false)
      }
      return
    }
    const normalized = normalizeEndpoint(raw)
    if (!normalized) {
      setFieldError('地址要写成 http://电脑IP:端口，例如 http://192.168.1.5:8082。')
      return
    }
    setSaving(true)
    try {
      await store.saveOcrEndpoint(normalized)
      setEndpoint(normalized)
      setToast({ text: `已保存：${normalized}`, tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '保存失败。', tone: 'error' })
    } finally {
      setSaving(false)
    }
  }, [endpoint, store])

  const onTest = useCallback(async () => {
    setHealth(null)
    setChecking(true)
    try {
      const normalized = normalizeEndpoint(endpoint)
      if (!normalized) {
        setFieldError('地址要写成 http://电脑IP:端口，例如 http://192.168.1.5:8082。')
        setHealth('地址格式不对，先改好再测。')
        return
      }
      const result = await checkCompanionHealth(normalized)
      setHealth(
        result.ok
          ? `连接成功：${normalized} 上跑着 ${result.service} v${result.version}。可以回去拍照识别了。`
          : `连接失败：${result.error.message}`,
      )
    } finally {
      setChecking(false)
    }
  }, [endpoint])

  return (
    <>
      <ScreenScaffold
        title="识别服务设置"
        subtitle="填写这台电脑在局域网里的地址；照片只会发到这台电脑上做本地 OCR"
      >
        <SectionCard title="电脑上的伴侣服务地址">
          <AppTextField
            label="服务地址"
            value={endpoint}
            onChangeText={(text) => {
              setEndpoint(text)
              setFieldError(null)
              setHealth(null)
            }}
            placeholder={`http://192.168.x.x:${DEFAULT_COMPANION_PORT}`}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            error={fieldError}
            editable={!saving}
            hint={
              inferred
                ? `推断出来的电脑地址是 ${inferred}（可以直接用，也可以改成别的）。`
                : '没有推断出电脑地址：先在电脑上启动识别服务，它会在屏幕上显示一个可以填的地址，照抄即可。'
            }
            accessibilityLabel="识别服务地址"
          />
          <AppButton label="测试连接" onPress={() => void onTest()} variant="secondary" loading={checking} disabled={saving} />
          {health ? (
            <Text style={[styles.health, health.startsWith('连接成功') ? styles.healthOk : styles.healthBad]} accessibilityRole="alert">
              {health}
            </Text>
          ) : null}
          <AppButton label="保存地址" onPress={() => void onSave()} loading={saving} style={styles.gap} />
          <AppButton
            label="清除地址"
            onPress={() => {
              setEndpoint('')
              setHealth(null)
              setFieldError(null)
            }}
            variant="ghost"
            disabled={saving}
            style={styles.gap}
            accessibilityLabel="清空输入框里的地址（还需要点保存才会生效）"
          />
        </SectionCard>

        <SectionCard title="怎么在电脑上启动">
          <Text style={styles.note}>
            在电脑上启动识别服务后，它会显示「手机可以填的地址」，把那个地址填到上面即可。
            手机和电脑要连同一个 Wi-Fi；只在电脑本机启动时手机连不上，需要允许局域网访问。
          </Text>
          <Text style={styles.note}>
            本地识别用 Tesseract 与工作区里的中英文语言模型，不需要联网下载，
            也不会上传到任何第三方服务；服务不提供文件下载、不接受任意网址。
          </Text>
        </SectionCard>

        <AppButton label="返回" onPress={() => navigation.goBack()} variant="secondary" />
      </ScreenScaffold>

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  health: { ...typography.caption, marginTop: spacing.sm },
  healthOk: { color: colors.primaryDark, fontWeight: '600' },
  healthBad: { color: colors.clayDark },
  note: { ...typography.caption, marginTop: spacing.sm },
  gap: { marginTop: spacing.sm },
})
