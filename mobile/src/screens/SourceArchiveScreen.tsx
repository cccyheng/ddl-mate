/**
 * **历史截图**：把电脑上保留下来的那几张课表截图取回这台手机。
 *
 * 为什么需要单独一页 + 显式按钮：
 * - 那几张图只存在于电脑工作区（`.tools/photo/...`），手机相册里没有；
 * - 用户明确要求「以前的截图也要放进软件里」，但又不能读任意文件、
 *   更不能把某个人具体的课表事实写进产品默认值；
 * - 因此这里只列出**电脑上那份显式目录**里的来源，由用户在同一个 Wi-Fi 下
 *   点一下「恢复到手机」，App 才通过伴侣服务把那**一份**文件取回来，
 *   并且下载阶段就逐字节校验 SHA256。
 *
 * 界面刻意保持「用户语言」：
 * - 主流程只显示可读名称、图上有什么 / 没有什么、以及「是否已经在手机上」；
 * - 工作区路径、SHA256、内部编号收进「技术明细」，默认不展开；
 * - 标题与说明**优先取电脑上的目录**（`GET /v1/archive/sources`），
 *   拿不到时才退回本机内置的离线兜底清单。
 *
 * 不做的事：不自动扫描电脑目录、不自动下载、不因为「图上应该有体育」就替用户建课。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { normalizeEndpoint } from '../domain/photoOcrClient'
import type { SourceScreenshot } from '../domain/screenshotLibraryRepository'
import { useAppStore } from '../store/AppStore'
import { AppButton, Badge, LoadingState, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>

/** 界面上一条「可恢复的历史来源」（本地登记 + 电脑目录元数据合并后的形状）。 */
interface SourceRow {
  catalogKey: string
  title: string
  description: string | null
  knownFacts: string[]
  absentFacts: string[]
  byteLength: number | null
  width: number | null
  height: number | null
  /** 技术明细（默认折叠）。 */
  archiveRelPath: string | null
  sha256: string | null
  restoredAttemptId: number | null
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

export function SourceArchiveScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [sources, setSources] = useState<SourceScreenshot[] | null>(null)
  /** 电脑目录里的元数据（取不到时为 `null`，界面退回本地兜底清单）。 */
  const [remote, setRemote] = useState<
    Map<string, { title: string; description: string | null; knownFacts: string[]; absentFacts: string[] }> | null
  >(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const load = useCallback(async () => {
    // 本地登记（幂等）：保证离线也能列出条目。
    await store.syncKnownSources()
    setSources(await store.screenshotLibrary.listSources())
    // 电脑上的目录：只影响标题 / 说明这些展示文案，失败不打扰用户。
    const result = await store.fetchArchiveMetadata()
    if (result.ok) {
      setRemote(
        new Map(
          result.sources.map((entry) => [
            entry.catalogKey,
            {
              title: entry.title,
              description: entry.description,
              knownFacts: entry.knownFacts,
              absentFacts: entry.absentFacts,
            },
          ]),
        ),
      )
      setRemoteError(null)
    } else {
      setRemote(null)
      setRemoteError(result.error)
    }
  }, [store])

  useEffect(() => {
    void load()
  }, [load])

  useFocusEffect(
    useCallback(() => {
      void load()
      return undefined
    }, [load]),
  )

  const endpointText = normalizeEndpoint(store.ocrEndpoint ?? store.inferredOcrEndpoint ?? '')

  /** 本地登记 + 内置兜底 + 电脑目录元数据 → 界面行。 */
  const rows = useMemo<SourceRow[]>(() => {
    if (sources === null) return []
    return sources.map((source) => {
      // 文案优先级：本次从电脑读到的目录 > 本机登记表里持久化的文案 > 中性兜底。
      // 本机登记表里的文案在**上一次同步成功**时就已经写进去了，所以离线也有内容。
      const fallback = store.knownSources.find((entry) => entry.catalogKey === source.catalogKey) ?? null
      const fromCompanion = remote?.get(source.catalogKey) ?? null
      const facts = fromCompanion?.knownFacts?.length ? fromCompanion.knownFacts : []
      const absent = fromCompanion?.absentFacts?.length ? fromCompanion.absentFacts : []
      return {
        catalogKey: source.catalogKey,
        title: fromCompanion?.title ?? source.title ?? fallback?.neutralTitle ?? '历史截图',
        description: fromCompanion?.description ?? source.description,
        knownFacts: facts,
        absentFacts: absent,
        byteLength: source.byteLength,
        width: source.width,
        height: source.height,
        archiveRelPath: source.archiveRelPath,
        sha256: source.sha256,
        restoredAttemptId: source.foreignAttemptId,
      }
    })
  }, [remote, sources, store.knownSources])

  const restore = useCallback(
    async (catalogKey: string) => {
      setBusyKey(catalogKey)
      setMessage(null)
      const result = await store.restoreKnownSource(catalogKey)
      setMessage({ text: result.message, tone: result.ok ? 'success' : 'error' })
      setBusyKey(null)
      await load()
    },
    [load, store],
  )

  if (sources === null) {
    return (
      <ScreenScaffold title="历史截图" subtitle="正在读取电脑上登记的来源…">
        <LoadingState message="正在读取来源清单…" />
      </ScreenScaffold>
    )
  }

  return (
    <ScreenScaffold
      title="历史截图"
      subtitle="把电脑上保留的旧课表截图取回这台手机（同一个 Wi-Fi，点一下才取）"
    >
      <SectionCard title="怎么恢复" subtitle="只取下面列出的这几张，不做任何目录扫描">
        <Text style={styles.caption}>
          {endpointText
            ? `恢复时从这台电脑取：${endpointText}`
            : '还没有可用的电脑地址。请先到「识别服务设置」填好同一 Wi-Fi 下这台电脑的地址。'}
        </Text>
        <Text style={styles.caption}>
          恢复只是把**原始图片字节**复制到这台手机并校验内容与登记的一致，不会替你改课表；
          取回后可以在截图库里打开原图、重新识别，再逐行核对导入。
        </Text>
        {!endpointText ? (
          <AppButton
            label="去识别服务设置"
            onPress={() => navigation.navigate('CompanionSettings')}
            variant="secondary"
            compact
            style={styles.gap}
            accessibilityLabel="打开识别服务设置"
          />
        ) : null}
      </SectionCard>

      {message ? (
        <View
          style={[styles.message, message.tone === 'error' ? styles.messageError : styles.messageOk]}
          accessibilityRole="alert"
        >
          <Text style={styles.messageText}>{message.text}</Text>
        </View>
      ) : null}

      {rows.map((source) => (
        <SectionCard
          key={source.catalogKey}
          title={source.title}
          subtitle={source.restoredAttemptId === null ? '还没恢复到这台手机' : '已经在手机上（可以在截图库里查看）'}
        >
          {source.description ? <Text style={styles.caption}>{source.description}</Text> : null}

          {source.knownFacts.length > 0 ? (
            <View style={styles.factBlock}>
              <Text style={styles.factTitle}>这张图上确认有的是：</Text>
              {source.knownFacts.map((fact) => (
                <Text key={fact} style={styles.caption}>
                  · {fact}
                </Text>
              ))}
            </View>
          ) : null}
          {source.absentFacts.length > 0 ? (
            <View style={styles.factBlock}>
              <Text style={styles.factTitle}>图上确认没有的是：</Text>
              {source.absentFacts.map((fact) => (
                <Text key={fact} style={styles.caption}>
                  · {fact}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={styles.badgeRow}>
            <Badge
              text={source.restoredAttemptId === null ? '未恢复' : '已在本机'}
              tone={source.restoredAttemptId === null ? 'warn' : 'primary'}
            />
            {source.width && source.height ? <Badge text={`${source.width}×${source.height}`} tone="muted" /> : null}
            {formatBytes(source.byteLength) ? <Badge text={formatBytes(source.byteLength)!} tone="muted" /> : null}
          </View>

          <View style={styles.actions}>
            <AppButton
              label={source.restoredAttemptId === null ? '恢复到手机' : '再取一次'}
              onPress={() => void restore(source.catalogKey)}
              variant={source.restoredAttemptId === null ? 'primary' : 'secondary'}
              compact
              loading={busyKey === source.catalogKey}
              disabled={busyKey !== null || !endpointText}
              accessibilityLabel={`恢复历史截图：${source.title}`}
            />
            {source.restoredAttemptId !== null ? (
              <AppButton
                label="去截图库查看"
                onPress={() =>
                  navigation.navigate('PhotoLibrary', { focusAttemptId: source.restoredAttemptId ?? undefined })
                }
                variant="ghost"
                compact
                accessibilityLabel="在截图库里查看这张历史截图"
              />
            ) : null}
          </View>

          {/* 技术明细默认折叠：主流程用用户语言，排障信息按需展开。 */}
          <Pressable
            onPress={() => setShowDetail((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel="展开或收起技术明细"
            style={({ pressed }) => [styles.detailToggle, pressed && styles.pressed]}
          >
            <Text style={styles.detailToggleText}>
              {showDetail ? '收起技术明细 ▲' : '技术明细（来源文件 / 校验和）▼'}
            </Text>
          </Pressable>
          {showDetail ? (
            <View style={styles.detailBox}>
              <Text style={styles.caption}>来源文件：{source.archiveRelPath ?? '（未知）'}</Text>
              <Text style={styles.caption}>内容校验和（SHA256）：{source.sha256 ?? '（目录里没有登记）'}</Text>
              <Text style={styles.caption}>条目编号：{source.catalogKey}</Text>
              {source.restoredAttemptId !== null ? (
                <Text style={styles.caption}>本机记录编号：#{source.restoredAttemptId}</Text>
              ) : null}
            </View>
          ) : null}
        </SectionCard>
      ))}

      <SectionCard title="说明">
        <Text style={styles.caption}>
          · 上面每一张都来自电脑上**项目自己保留**的截图目录，只含图片本身；手机取回时会校验内容与登记的一致，
          不一致就不登记、也不留半份文件。
        </Text>
        {remoteError ? (
          <Text style={styles.caption}>· 这次没能读到电脑上的目录（{remoteError}），显示的是 App 里的离线清单。</Text>
        ) : null}
        <Text style={styles.caption}>· 图上没有的内容（例如周六的课）不会被推断或补造；需要的话请在核对页手动添加。</Text>
        <Text style={styles.caption}>· 恢复过的历史不会被静默覆盖，也没有删除入口。</Text>
      </SectionCard>
    </ScreenScaffold>
  )
}

const styles = StyleSheet.create({
  caption: { ...typography.caption, marginTop: spacing.xs },
  factBlock: { marginTop: spacing.sm },
  factTitle: { ...typography.caption, fontWeight: '700' },
  badgeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.md },
  gap: { marginTop: spacing.sm },
  pressed: { opacity: 0.8 },
  detailToggle: { minHeight: 44, justifyContent: 'center', marginTop: spacing.md },
  detailToggleText: { ...typography.caption, color: colors.textSoft },
  detailBox: {
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSoft,
    marginTop: spacing.xs,
  },
  message: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  messageOk: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  messageError: { backgroundColor: colors.claySoft, borderColor: colors.clay },
  messageText: { ...typography.bodySoft },
})
