import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Keyboard, Pressable, StyleSheet, Text, View, type ScrollView } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { buildSearchIndex, searchLocal, searchCategoryLabels, type SearchFilter, type SearchResult } from '../domain/globalSearch'
import type { TaskStackParamList } from '../navigation/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, Badge, EmptyState, LoadingState, OptionGroup, RefreshErrorBanner, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'

type Nav = NativeStackNavigationProp<Pick<TaskStackParamList, 'GlobalSearch' | 'TaskDetail' | 'CourseDetail'>>
const categories: SearchFilter[] = ['ALL', 'TASK', 'COURSE', 'EXAM', 'NOTE']

export function GlobalSearchScreen(): React.ReactElement {
  const store = useAppStore(), navigation = useNavigation<Nav>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SearchFilter>('ALL')
  const [page, setPage] = useState(0)
  const [searchRevision, setSearchRevision] = useState(0)
  const queryRef = useRef('')
  const [message, setMessage] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const request = useRef(0), visible = useRef(false), openingRef = useRef(false)
  const latestStore = useRef(store)
  latestStore.current = store
  const { refresh } = store
  useFocusEffect(useCallback(() => {
    visible.current = true
    setOpening(null); openingRef.current = false
    void refresh()
    return () => { visible.current = false; request.current++; openingRef.current = false }
  }, [refresh]))
  const generation = store.getNotificationRouteGeneration()
  const index = useMemo(() => buildSearchIndex(store.data), [store.data.tasks, store.data.courses, store.data.originalTexts, searchRevision])
  const results = useMemo(() => searchLocal(index, query, filter, page), [index, query, filter, page])
  function cancelPending(): void {
    request.current++; openingRef.current = false; setOpening(null); setMessage(null)
  }
  function changeQuery(value: string): void { cancelPending(); queryRef.current = value; setQuery(value); setPage(0) }
  function submitSearch(value = queryRef.current): void {
    // Native submit text includes the last committed IME characters, even before a rerender.
    changeQuery(value)
    setSearchRevision(revision => revision + 1)
    Keyboard.dismiss()
    scrollRef.current?.scrollTo({ y: 0, animated: false })
    void latestStore.current.refresh()
  }
  function changeFilter(value: SearchFilter): void { cancelPending(); setFilter(value); setPage(0) }
  function changePage(value: number): void {
    cancelPending(); setPage(value)
    scrollRef.current?.scrollTo({ y: 0, animated: false })
  }
  async function openResult(result: SearchResult): Promise<void> {
    if (openingRef.current || !visible.current) return
    const operation = ++request.current
    openingRef.current = true; setOpening(result.key); setMessage(null)
    try {
      const exists = await latestStore.current.readSearchTarget({ owner: result.owner, generation })
      if (!visible.current || operation !== request.current) return
      if (latestStore.current.getNotificationRouteGeneration() !== generation) throw new Error('数据已恢复，请重新核对搜索结果。')
      if (!exists) {
        setMessage('这条内容已被删除，正在更新搜索结果。')
        void latestStore.current.refresh()
        return
      }
      if (result.owner.kind === 'course') navigation.navigate('CourseDetail', { id: result.owner.id })
      else navigation.navigate('TaskDetail', { id: result.owner.id })
    } catch (cause) {
      if (visible.current && operation === request.current) setMessage(cause instanceof Error ? cause.message : '暂时无法打开，请稍后重试。')
    } finally {
      if (operation === request.current) { openingRef.current = false; setOpening(null) }
    }
  }
  const ready = store.status === 'ready'
  return <ScreenScaffold title="全局搜索" subtitle="任务、课程、考试，还有你记下的内容" scrollRef={scrollRef}>
    <AppTextField label="搜索内容" value={query} onChangeText={changeQuery} maxLength={200}
      placeholder="试试课程名、老师或通知里的关键词" autoCorrect={false} autoCapitalize="none" returnKeyType="search"
      onSubmitEditing={event => submitSearch(event.nativeEvent.text)}
      accessibilityLabel="全局搜索关键词" />
    <Text testID="global-search-feedback" accessibilityLiveRegion="polite" style={styles.feedback}>
      {!ready ? store.status === 'loading' ? '正在读取本机内容…' : '本机内容暂时无法读取，请重试。'
        : !results.hasQuery ? `已读取 ${store.data.tasks.length} 条任务与考试、${store.data.courses.length} 门课程。输入关键词开始搜索。`
          : `“${query.trim().slice(0, 50)}” · ${searchCategoryLabels[filter]}：${results.total > 0 ? `找到 ${results.total} 条结果 · 第 ${results.page + 1} / ${results.pages} 页` : '没有匹配结果'}`}
    </Text>
    <View style={styles.searchActions}>
      <AppButton label="搜索" onPress={() => submitSearch()} disabled={!ready} accessibilityLabel="执行全局搜索" />
      {query ? <AppButton label="清空搜索" variant="ghost" compact onPress={() => { changeQuery(''); setFilter('ALL') }} /> : null}
      {ready && results.hasQuery && results.total === 0 && filter !== 'ALL' && results.counts.ALL > 0 ?
        <AppButton label={`查看全部 ${results.counts.ALL} 条`} variant="secondary" onPress={() => { Keyboard.dismiss(); changeFilter('ALL') }} /> : null}
    </View>
    <OptionGroup label="搜索范围" value={filter} onChange={changeFilter}
      options={categories.map(value => ({ value, label: results.hasQuery && ready ? `${searchCategoryLabels[value]} ${results.counts[value]}` : searchCategoryLabels[value] }))} />
    {filter === 'NOTE' || !results.hasQuery ? <Text style={styles.hint}>笔记与原文包含任务说明、通知原文和课程备注。仅搜索已保存的文字。</Text> : null}
    {store.status === 'loading' ? <LoadingState message="正在读取本机内容…" /> : null}
    {store.status === 'error' ? <SectionCard title="内容暂时无法读取"><Text style={styles.error}>{store.error}</Text><AppButton label="重新读取" onPress={() => void store.retryBootstrap()} /></SectionCard> : null}
    {store.refreshError ? <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} /> : null}
    {message ? <Text accessibilityRole="alert" style={styles.error}>{message}</Text> : null}
    {ready && !results.hasQuery ? <EmptyState title="从一个关键词开始" description="也可以用空格分开多个词，例如“物理 实验”。" compact /> : null}
    {ready && results.hasQuery && !results.total ? <EmptyState title="没有找到相关内容" description="换个关键词，或切换到“全部”再试试。" compact /> : null}
    {ready && results.total > 0 ? <>
      {results.items.map(result => <Pressable key={result.key} disabled={opening !== null}
        accessibilityRole="button" accessibilityLabel={`查看${searchCategoryLabels[result.category]}：${result.title}`}
        accessibilityState={{ disabled: opening !== null, busy: opening === result.key }} onPress={() => void openResult(result)}
        style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
        <View style={styles.top}><Badge text={searchCategoryLabels[result.category]} tone={result.category === 'EXAM' ? 'warn' : 'primary'} /><Text style={styles.openLabel}>{opening === result.key ? '正在打开…' : '查看 ›'}</Text></View>
        <Text style={styles.title} numberOfLines={2}>{result.title}</Text>
        <Text style={styles.meta} numberOfLines={2}>{result.subtitle}</Text>
        {result.snippet ? <Text style={styles.snippet} numberOfLines={3}>{result.snippet}</Text> : null}
      </Pressable>)}
      {results.pages > 1 ? <View style={styles.pager}>
        <AppButton label="上一页" variant="secondary" disabled={results.page === 0} onPress={() => changePage(results.page - 1)} />
        <AppButton label="下一页" variant="secondary" disabled={results.page + 1 === results.pages} onPress={() => changePage(results.page + 1)} />
      </View> : null}
    </> : null}
  </ScreenScaffold>
}
const styles = StyleSheet.create({
  hint: { ...typography.caption, marginBottom: spacing.lg },
  feedback: { ...typography.label, color: colors.primaryDark, marginBottom: spacing.sm },
  searchActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  error: { ...typography.bodySoft, color: colors.clayDark, marginBottom: spacing.md },
  card: { backgroundColor: colors.surface, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md, minHeight: 64 },
  pressed: { backgroundColor: colors.primarySoft },
  top: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm, marginBottom: spacing.sm },
  openLabel: { ...typography.caption, color: colors.primary },
  title: { ...typography.section, marginBottom: spacing.xs },
  meta: { ...typography.caption },
  snippet: { ...typography.bodySoft, marginTop: spacing.sm },
  pager: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.sm, marginVertical: spacing.md },
})
