/**
 * 任务列表：关键词 / 课程 / 状态 / 排序筛选 + 真实任务卡片。
 *
 * 所有筛选都在本机内存快照上做（数据只来自 expo-sqlite），
 * 没有网络请求，也没有任何示例数据。
 */

import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Keyboard, StyleSheet, Text, View, type ScrollView } from 'react-native'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { compareByDeadline, deadlineToShanghaiDateKey } from '../domain/datetime'
import { isTaskDone, type Task } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { TaskCard } from '../ui/TaskCard'
import { TaskBatchManager } from '../ui/TaskBatchManager'
import { AppButton, AppTextField, EmptyState, OptionGroup, RefreshErrorBanner, SectionCard } from '../ui/components'
import { ReminderSyncNotice } from '../ui/ReminderSyncNotice'
import { ConfirmDialog, Toast, taskDeleteDetails } from '../ui/dialog'
import { QuickActions, ToolDisclosure } from '../ui/QuickActions'
import { MotionReveal } from '../ui/motion'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { TaskStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<TaskStackParamList>

type StatusFilter = 'OPEN' | 'DONE' | 'ALL'
type SortKey = 'deadline' | 'created' | 'priority'

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'OPEN', label: '未完成' },
  { value: 'DONE', label: '已完成' },
  { value: 'ALL', label: '全部' },
]

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'deadline', label: '按截止时间' },
  { value: 'created', label: '按创建时间' },
  { value: 'priority', label: '按优先级' },
]

export function TaskListScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [keyword, setKeyword] = useState('')
  const keywordRef = useRef('')
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const [status, setStatus] = useState<StatusFilter>('OPEN')
  const [courseId, setCourseId] = useState<number | 'ALL'>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('deadline')
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [batchMode, setBatchMode] = useState(false)

  // 从表单页返回后重新读取，保证列表反映最新数据。
  // 依赖只放 `refresh`（自身是稳定引用），避免把每次渲染都新建的 store 对象放进依赖导致循环重读。
  const { refresh } = store
  useFocusEffect(
    useCallback(() => {
      void refresh()
      return undefined
    }, [refresh]),
  )

  const courseOptions = useMemo(
    () => [
      { value: 'ALL' as const, label: '全部课程' },
      { value: 0 as const, label: '未关联课程' },
      ...store.data.courses.map((course) => ({ value: course.id, label: course.name })),
    ],
    [store.data.courses],
  )

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    let list = store.data.tasks.filter((task) => {
      if (status === 'OPEN' && task.status !== 'TODO' && task.status !== 'DOING') return false
      if (status === 'DONE' && !isTaskDone(task)) return false
      if (courseId === 0 && task.courseId !== null) return false
      if (typeof courseId === 'number' && courseId > 0 && task.courseId !== courseId) return false
      if (needle.length > 0) {
        const haystack = `${task.title} ${task.description ?? ''}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })

    if (sortKey === 'deadline') {
      list = [...list].sort(compareByDeadline)
    } else if (sortKey === 'created') {
      list = [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id))
    } else {
      list = [...list].sort((a, b) => b.priority - a.priority || compareByDeadline(a, b))
    }

    // 未设置 DDL 的任务单列在最后，避免看起来像「没有截止时间也能排序」。
    if (sortKey === 'deadline') {
      const withDeadline = list.filter((task) => task.deadline)
      const without = list.filter((task) => !task.deadline)
      return { withDeadline, without }
    }
    return { withDeadline: list, without: [] as Task[] }
  }, [courseId, keyword, sortKey, status, store.data.tasks])

  const openDetail = useCallback((task: Task) => navigation.navigate('TaskDetail', { id: task.id }), [navigation])

  const toggle = useCallback(
    async (task: Task) => {
      setBusyId(task.id)
      try {
        const updated = await store.toggleTaskComplete(task.id)
        setToast({ text: updated.status === 'DONE' ? `已完成「${updated.title}」。` : `「${updated.title}」已恢复未完成。`, tone: 'success' })
      } catch (cause) {
        setToast({ text: cause instanceof Error ? cause.message : '更新失败。', tone: 'error' })
      } finally {
        setBusyId(null)
      }
    },
    [store],
  )

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const target = pendingDelete
    setBusyId(target.id)
    try {
      await store.deleteTask(target.id)
      setToast({ text: `已删除任务「${target.title}」。`, tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '删除失败。', tone: 'error' })
    } finally {
      setBusyId(null)
      setPendingDelete(null)
    }
  }, [pendingDelete, store])

  const renderTask = (task: Task) => (
    <TaskCard
      key={task.id}
      task={task}
      course={store.courseById(task.courseId)}
      onPress={openDetail}
      onToggleComplete={toggle}
      onRequestDelete={setPendingDelete}
      busy={busyId === task.id}
    />
  )

  const total = filtered.withDeadline.length + filtered.without.length
  const searchScope = [STATUS_OPTIONS.find(option => option.value === status)?.label,
    courseId === 'ALL' ? '全部课程' : courseId === 0 ? '未关联课程' : store.courseById(courseId)?.name ?? '指定课程'].join(' · ')
  function changeKeyword(value: string): void { keywordRef.current = value; setKeyword(value) }
  function submitKeyword(value = keywordRef.current): void {
    changeKeyword(value)
    Keyboard.dismiss()
    scrollRef.current?.scrollTo({ y: 0, animated: false })
    void refresh()
  }

  return (
    <>
      <ScreenScaffold
        scrollRef={scrollRef}
        title="任务"
        subtitle={`共 ${store.data.tasks.length} 条，当前筛选出 ${total} 条`}
        headerAccessory={
          <AppButton label="新建" onPress={() => navigation.navigate('TaskForm', {})} compact accessibilityLabel="新建任务" />
        }
      >
        {store.refreshError ? (
          <RefreshErrorBanner message={store.refreshError} onRetry={() => void store.refresh()} />
        ) : null}
        <ReminderSyncNotice />
        <AppButton label="全局搜索 · 课程、考试与笔记" variant="secondary" onPress={() => navigation.navigate('GlobalSearch')} style={{ marginBottom: spacing.md }} accessibilityLabel="打开全局搜索" />
        <AppTextField
          label="关键词"
          value={keyword}
          onChangeText={changeKeyword}
          placeholder="搜索标题或说明"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={event => submitKeyword(event.nativeEvent.text)}
          accessibilityLabel="按关键词搜索任务"
          style={styles.searchField}
        />
        {keyword.trim() ? <View style={styles.searchFeedback} testID="task-keyword-feedback">
          <Text style={styles.searchFeedbackTitle} accessibilityLiveRegion="polite">
            {store.status === 'loading' ? '正在读取任务…' : store.status === 'error' ? '任务暂时无法读取，请重试。'
              : `“${keyword.trim()}”：${total > 0 ? `找到 ${total} 条任务` : '没有找到任务'}`}
          </Text>
          <Text style={styles.searchScope}>搜索范围：{searchScope}。只匹配任务标题和说明。</Text>
          {total === 0 && (status !== 'ALL' || courseId !== 'ALL') && store.status === 'ready' ?
            <AppButton label="在全部任务中查找" compact variant="secondary" onPress={() => { Keyboard.dismiss(); setStatus('ALL'); setCourseId('ALL') }} /> : null}
        </View> : null}
        <View style={styles.filterToggleRow}>
          <AppButton label="搜索任务" compact disabled={store.status !== 'ready'} onPress={() => submitKeyword()} />
          {keyword ? <AppButton label="清空关键词" compact variant="ghost" onPress={() => changeKeyword('')} /> : null}
        </View>

        <ToolDisclosure title="任务工具">
          <QuickActions title="收集与复用" actions={[
            { label: '截图转待办', onPress: () => navigation.navigate('NoticePhoto') },
            { label: '批量识别通知', onPress: () => navigation.navigate('BatchNotice'), hint: '一次选最多8张截图，分别核对后保存' },
            { label: '通知转待办', onPress: () => navigation.navigate('NoticeImport') },
            { label: '任务模板', onPress: () => navigation.navigate('TaskTemplateList') },
          ]} />
          <QuickActions title="学习安排" actions={[
            { label: '专注计时', onPress: () => navigation.navigate('FocusTime') },
            { label: '今日学习计划', onPress: () => navigation.navigate('TodayPlan') },
            { label: 'DDL 压力分析', onPress: () => navigation.navigate('Pressure') },
            { label: '考试与复习', onPress: () => navigation.navigate('Exams') },
            { label: '学习周报', onPress: () => navigation.navigate('LearningReport') },
          ]} />
        </ToolDisclosure>
        <View style={styles.filterToggleRow}>
          {!batchMode ? <AppButton label="批量管理" variant="secondary" onPress={() => setBatchMode(true)} disabled={busyId !== null} /> : null}
          <AppButton
            label={showFilters ? '收起筛选' : '更多筛选'}
            onPress={() => setShowFilters((prev) => !prev)}
            variant="secondary"
            compact
            accessibilityLabel={showFilters ? '收起更多筛选' : '展开更多筛选'}
          />
        </View>

        {showFilters ? (
          <MotionReveal><SectionCard title="筛选条件">
            <OptionGroup label="状态" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
            <OptionGroup label="课程" options={courseOptions} value={courseId} onChange={setCourseId} />
            <OptionGroup label="排序" options={SORT_OPTIONS} value={sortKey} onChange={setSortKey} />
          </SectionCard></MotionReveal>
        ) : (
          <>
            <OptionGroup label="状态" options={STATUS_OPTIONS} value={status} onChange={setStatus} />
            <OptionGroup label="排序" options={SORT_OPTIONS} value={sortKey} onChange={setSortKey} />
          </>
        )}

        {batchMode ? <TaskBatchManager tasks={[...filtered.withDeadline, ...filtered.without]}
          filterKey={JSON.stringify([keyword, status, courseId])} onExit={() => setBatchMode(false)} /> : total === 0 ? (
          <EmptyState
            title="没有符合条件的任务"
            description={
              store.data.tasks.length === 0
                ? '这台手机上还没有任务。点右上角「新建」添加，应用不会自动生成示例任务。'
                : '试着放宽筛选条件，或清空关键词。'
            }
            actionLabel={store.data.tasks.length === 0 ? '新建任务' : '清空筛选'}
            onAction={() => {
              if (store.data.tasks.length === 0) navigation.navigate('TaskForm', {})
              else {
                changeKeyword('')
                setStatus('ALL')
                setCourseId('ALL')
              }
            }}
          />
        ) : (
          <>
            {filtered.withDeadline.map(renderTask)}
            {filtered.without.length > 0 ? (
              <SectionCard
                title="未设置截止时间"
                subtitle={`${filtered.without.length} 条 · 不会出现在日历上，也不会被自动补时间`}
              >
                {filtered.without.map(renderTask)}
              </SectionCard>
            ) : null}
          </>
        )}

        <Text style={styles.footnote}>
          当前筛选：{STATUS_OPTIONS.find((option) => option.value === status)?.label} ·{' '}
          {typeof courseId === 'number' && courseId > 0
            ? (store.data.courses.find((course) => course.id === courseId)?.name ?? '未知课程')
            : courseId === 0
              ? '未关联课程'
              : '全部课程'}
          {sortKey === 'deadline' && filtered.withDeadline.some((task) => task.deadline)
            ? ` · 最近一条 ${deadlineToShanghaiDateKey(filtered.withDeadline[0]?.deadline ?? '')}`
            : ''}
        </Text>
      </ScreenScaffold>

      <ConfirmDialog
        visible={pendingDelete !== null}
        title="删除这个任务？"
        details={pendingDelete ? taskDeleteDetails(pendingDelete.title, store.data.originalTexts.has(pendingDelete.id)) : []}
        confirmLabel="删除任务"
        danger
        busy={busyId !== null}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  searchFeedback: { backgroundColor: colors.primarySoft, borderRadius: 14, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.sm },
  searchFeedbackTitle: { ...typography.section, color: colors.primaryDark },
  searchScope: { ...typography.caption },
  searchField: { marginBottom: spacing.sm },
  filterToggleRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  footnote: { ...typography.caption, marginTop: spacing.md },
})
