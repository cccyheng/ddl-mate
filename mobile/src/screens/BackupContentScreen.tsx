/**
 * 备份内容的**只读**预览。
 *
 * 数据来自 AppStore 中由 `openBackupContentView` 从备份文件重新解析 / 校验的 DTO，
 * 不是当前 Live DB；本页没有编辑、跳转任务/课程详情或恢复动作。
 *
 * 列表按页渲染（任务/课程/课表 20 条一页，截图 6 张一页），截图用 app-private
 * 暂存文件 URI + 全屏 Modal，不把 base64 放进 React state。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from 'react-native-safe-area-context'

import { deadlineToShanghaiWallClock, weekdayName } from '../domain/datetime'
import { weekPatternLabels } from '../domain/scheduleRules'
import { taskStatusLabels, type TaskStatus } from '../domain/types'
import type { BackupContentImage } from '../domain/backupService'
import { useAppStore } from '../store/AppStore'
import type { SharedBackupRoutes } from '../navigation/types'
import { AppButton, Badge, EmptyState, SectionCard } from '../ui/components'
import { Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'

type Tab = 'tasks' | 'courses' | 'schedules' | 'images'
type Nav = NativeStackNavigationProp<SharedBackupRoutes>

const PAGE_SIZE = 20
const IMAGE_PAGE_SIZE = 6

function formatDateTime(iso: string): string {
  if (!iso) return '时间未知'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '时间未知'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return iso
  }
}

function displayDeadline(deadline: string | null): string {
  if (!deadline) return '未设置截止'
  if (/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return `${deadline}（当天结束前）`
  const wallClock = deadlineToShanghaiWallClock(deadline)
  return wallClock ? wallClock.replace('T', ' ') : deadline
}

function weekLabel(
  weekRange: string | null,
  startWeek: number | null,
  endWeek: number | null,
  pattern: string,
): string {
  const patternLabel = weekPatternLabels[pattern as keyof typeof weekPatternLabels] ?? '每周'
  // 导入的显式 weekRange（可能是不连续周）优先；没有才退回起止周。
  if (weekRange && weekRange.trim().length > 0) return `周次 ${weekRange.trim()} · ${patternLabel}`
  if (startWeek === null || endWeek === null) return '每周（未设置教学周）'
  return `第 ${startWeek}–${endWeek} 周 · ${patternLabel}`
}

function Pager({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
}): React.ReactElement | null {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null
  return (
    <View style={styles.pager}>
      <AppButton
        label="上一页"
        compact
        variant="secondary"
        disabled={page <= 0}
        onPress={() => onChange(page - 1)}
      />
      <Text style={styles.pagerText}>
        第 {page + 1} / {totalPages} 页
      </Text>
      <AppButton
        label="下一页"
        compact
        variant="secondary"
        disabled={page >= totalPages - 1}
        onPress={() => onChange(page + 1)}
      />
    </View>
  )
}

export function BackupContentScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<RouteProp<SharedBackupRoutes, 'BackupContent'>>()
  const routeViewDir = route.params.viewDir
  const currentView = store.backupContentView
  // 路由绑定 view identity：旧内容页不能显示另一个快照，也不能关闭新快照。
  const view = currentView && currentView.viewDir === routeViewDir ? currentView : null
  const activeViewDir = view?.viewDir ?? null
  const storeRef = useRef(store)
  storeRef.current = store
  const [tab, setTab] = useState<Tab>('tasks')
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<BackupContentImage | null>(null)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /**
   * 只按自己的 viewDir 租用 / 释放；释放延迟到下一轮，StrictMode 的
   * setup → cleanup → setup 会重新 retain 并取消关闭。旧页面卸载不会删新视图。
   */
  useEffect(() => {
    if (!activeViewDir) return
    storeRef.current.backup.retainContentView(activeViewDir)
    return () => {
      storeRef.current.backup.releaseContentView(activeViewDir)
    }
  }, [activeViewDir])

  // 切换快照 / 关闭后清掉旧的分页与大图状态。
  useEffect(() => {
    setTab('tasks')
    setPage(0)
    setExpanded(null)
  }, [activeViewDir])

  useEffect(() => {
    setPage(0)
  }, [tab])

  // 离开页面（切标签 / 返回）时清掉大图与旧分页；视图本身仍由租约按 identity 管理。
  useFocusEffect(
    useCallback(() => {
      setExpanded(null)
      setPage(0)
      return () => {
        setExpanded(null)
        setPage(0)
      }
    }, []),
  )

  const tasks = view?.tasks ?? []
  const courses = view?.courses ?? []
  const schedules = view?.schedules ?? []
  const images = view?.images ?? []

  const pageTasks = useMemo(() => tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [page, tasks])
  const pageCourses = useMemo(
    () => courses.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [courses, page],
  )
  const pageSchedules = useMemo(
    () => schedules.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [page, schedules],
  )
  const pageImages = useMemo(
    () => images.slice(page * IMAGE_PAGE_SIZE, (page + 1) * IMAGE_PAGE_SIZE),
    [images, page],
  )

  const handleImportImagesOnly = useCallback(async (): Promise<void> => {
    if (!view || importing) return
    setImporting(true)
    setToast(null)
    // 导入期间额外持有一份视图租约：即使页面立刻被卸载，也不能删掉正在读取的图片。
    store.backup.retainContentView(view.viewDir)
    try {
      const outcome = await store.backup.importImagesFromContentView(view)
      if (!mountedRef.current) return
      const result = outcome.kind === 'committed' ? outcome.result : null
      if (result?.committed) {
        setToast({
          text: outcome.refreshError
            ? `${result.message} 截图库列表需要重新读取一次才能看到最新内容，不用再导入一遍。`
            : result.message,
          tone: 'success',
        })
      } else if (outcome.kind === 'busy') {
        setToast({ text: outcome.reason ?? '已有备份动作正在进行。', tone: 'error' })
      } else {
        setToast({ text: outcome.reason ?? '只导入截图没有完成；任务和课程没有被改动。', tone: 'error' })
      }
    } finally {
      store.backup.releaseContentView(view.viewDir)
      if (mountedRef.current) setImporting(false)
    }
  }, [importing, store.backup, view])

  if (!view) {
    return (
      <ScreenScaffold title="备份内容预览" subtitle="只读预览；不会恢复或改动当前数据">
        <SectionCard title="没有可预览的内容" subtitle="预览已关闭或已切换到另一份备份">
          <EmptyState title="预览已关闭" description="请返回备份列表重新「查看内容」。" />
          <AppButton label="返回备份列表" onPress={() => navigation.goBack()} />
        </SectionCard>
      </ScreenScaffold>
    )
  }

  const tabButton = (value: Tab, label: string, count: number) => (
    <AppButton
      key={value}
      label={`${label} ${count}`}
      compact
      variant={tab === value ? 'primary' : 'secondary'}
      onPress={() => setTab(value)}
      accessibilityLabel={`查看备份中的${label}，共 ${count} 条`}
    />
  )

  const totalForPager =
    tab === 'tasks' ? tasks.length : tab === 'courses' ? courses.length : tab === 'schedules' ? schedules.length : images.length
  const pageForPager = tab === 'images' ? page : page
  const pageSize = tab === 'images' ? IMAGE_PAGE_SIZE : PAGE_SIZE

  return (
    <>
      <ScreenScaffold
        title="备份内容预览"
        subtitle={`只读 · ${view.sourceName} · 创建于 ${formatDateTime(view.createdAt)}`}
        headerAccessory={<Badge text="只读" tone="primary" />}
      >
      <SectionCard title="只读预览" subtitle="这是备份中的内容，不是当前数据">
        <Text style={styles.readOnly}>
          仅查看，不会替换当前数据。返回或关闭本页不会改变任何东西；恢复只能在备份列表里通过最终确认执行。
          截图页的「只导入截图」是单独的显式动作：只把图片复制进当前截图库，不恢复任务、课程或课表。
        </Text>
        <Text style={styles.muted}>
          这份备份：{view.counts.tasks} 个任务、{view.counts.courses} 门课程、{view.counts.schedules} 条课表、
          {view.counts.images} 张截图。
        </Text>
      </SectionCard>

      <View style={styles.tabs}>
        {tabButton('tasks', '任务', tasks.length)}
        {tabButton('courses', '课程', courses.length)}
        {tabButton('schedules', '课表', schedules.length)}
        {tabButton('images', '截图', images.length)}
      </View>

      {tab === 'tasks' ? (
        <SectionCard title="备份中的任务" subtitle="只显示标题 / 截止 / 状态 / 关联课程，不可编辑">
          {tasks.length === 0 ? (
            <EmptyState title="这份备份没有任务" description="创建备份时本机还没有任务。" />
          ) : (
            <>
              {pageTasks.map((task) => (
                <View key={`task-${task.id}`} style={styles.row}>
                  <Text style={styles.rowTitle}>{task.title}</Text>
                  <Text style={styles.muted}>截止：{displayDeadline(task.deadline)}</Text>
                  <View style={styles.badgeRow}>
                    <Badge text={taskStatusLabels[task.status as TaskStatus] ?? task.status} tone="neutral" />
                    {task.courseName ? <Badge text={task.courseName} tone="muted" /> : null}
                  </View>
                </View>
              ))}
              <Pager page={pageForPager} total={totalForPager} pageSize={pageSize} onChange={setPage} />
            </>
          )}
        </SectionCard>
      ) : null}

      {tab === 'courses' ? (
        <SectionCard title="备份中的课程" subtitle="课程名称 / 教师 / 学期">
          {courses.length === 0 ? (
            <EmptyState title="这份备份没有课程" description="创建备份时本机还没有课程。" />
          ) : (
            <>
              {pageCourses.map((course) => (
                <View key={`course-${course.id}`} style={styles.row}>
                  <Text style={styles.rowTitle}>{course.name}</Text>
                  <Text style={styles.muted}>教师：{course.instructor ?? '未填写'}</Text>
                  {course.semester ? <Text style={styles.muted}>学期：{course.semester}</Text> : null}
                </View>
              ))}
              <Pager page={pageForPager} total={totalForPager} pageSize={pageSize} onChange={setPage} />
            </>
          )}
        </SectionCard>
      ) : null}

      {tab === 'schedules' ? (
        <SectionCard title="备份中的课表" subtitle="星期 / 时间 / 周次 / 教师 / 地点；不可编辑">
          {schedules.length === 0 ? (
            <EmptyState title="这份备份没有课表" description="创建备份时本机还没有课表。" />
          ) : (
            <>
              {pageSchedules.map((schedule) => (
                <View key={`schedule-${schedule.id}`} style={styles.row}>
                  <Text style={styles.rowTitle}>
                    {schedule.courseName} · {weekdayName(schedule.weekday)} {schedule.startTime}–{schedule.endTime}
                  </Text>
                  <Text style={styles.muted}>
                    {weekLabel(schedule.weekRange, schedule.startWeek, schedule.endWeek, schedule.weekPattern)}
                  </Text>
                  <Text style={styles.muted}>教师：{schedule.instructor ?? '未填写'}</Text>
                  <Text style={styles.muted}>地点：{schedule.location ?? '未填写'}</Text>
                  {schedule.semesterStartDate ? (
                    <Text style={styles.muted}>学期首周一：{schedule.semesterStartDate}</Text>
                  ) : null}
                </View>
              ))}
              <Pager page={pageForPager} total={totalForPager} pageSize={pageSize} onChange={setPage} />
            </>
          )}
        </SectionCard>
      ) : null}

      {tab === 'images' ? (
        <SectionCard title="备份中的原始截图" subtitle="来自备份里的图片；点击可放大查看">
          {images.length > 0 ? (
            <>
              <Text style={styles.muted}>
                图片会加入当前截图库，保留现有任务和课表。不会恢复或替换任务、课程、课表、设置。同一张图重复导入不会多出新的图片。
              </Text>
              <AppButton
                label="只导入截图"
                variant="secondary"
                onPress={() => void handleImportImagesOnly()}
                loading={importing}
                disabled={importing}
                accessibilityLabel="只导入截图，不恢复任务或课程"
                accessibilityHint="图片会加入当前截图库，保留现有任务和课表。"
              />
            </>
          ) : (
            <Text style={styles.muted}>这份备份里没有截图，无法只导入截图；任务和课程也不会被改动。</Text>
          )}
          {images.length === 0 ? (
            <EmptyState title="这份备份没有截图" description="创建备份时本机截图库还没有可查看的原图。" />
          ) : (
            <>
              {pageImages.map((image) => (
                <Pressable
                  key={`image-${image.imageId}`}
                  onPress={() => setExpanded(image)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel="放大查看这张备份截图"
                  style={styles.imageCard}
                >
                  <Image source={{ uri: image.stagedUri }} style={styles.image} resizeMode="contain" />
                  <Text style={styles.muted}>
                    {image.width ?? '?'}×{image.height ?? '?'} · {(image.byteLength / 1024).toFixed(1)} KB ·{' '}
                    {image.format.toUpperCase()}
                  </Text>
                  <Text style={styles.muted}>
                    {image.capturedAt ? `采集：${formatDateTime(image.capturedAt)}` : '采集时间未知'}
                    {image.source ? ` · 来源：${image.source}` : ''}
                  </Text>
                </Pressable>
              ))}
              <Pager page={pageForPager} total={totalForPager} pageSize={pageSize} onChange={setPage} />
            </>
          )}
        </SectionCard>
      ) : null}

      <Text style={styles.footer}>
        共 {totalForPager} 条；每页最多 {pageSize} 条。只读预览不会产生任务、课程或恢复操作。
      </Text>

      <AppButton label="返回备份列表" variant="secondary" onPress={() => navigation.goBack()} />

      <Modal
        visible={expanded !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setExpanded(null)}
        statusBarTranslucent
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom', 'left', 'right']}>
            <View style={styles.modalBackdrop}>
              <ScrollView contentContainerStyle={styles.modalContent} maximumZoomScale={4} minimumZoomScale={1}>
                {expanded ? (
                  <>
                    <Image source={{ uri: expanded.stagedUri }} style={styles.modalImage} resizeMode="contain" />
                    <Text style={styles.modalMeta}>
                      {expanded.width ?? '?'}×{expanded.height ?? '?'} · {(expanded.byteLength / 1024).toFixed(1)} KB
                    </Text>
                  </>
                ) : null}
              </ScrollView>
              <AppButton
                label="返回"
                variant="secondary"
                onPress={() => setExpanded(null)}
                style={styles.modalReturn}
                accessibilityLabel="返回并关闭大图"
              />
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
      </ScreenScaffold>
      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  readOnly: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600' },
  muted: { ...typography.caption, marginTop: spacing.xs },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  row: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 2,
  },
  rowTitle: { ...typography.section, fontSize: 16 },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  pager: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pagerText: { ...typography.caption, textAlign: 'center' },
  imageCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    gap: 2,
  },
  image: { width: '100%', height: 200, backgroundColor: colors.surfaceMute, borderRadius: radius.sm },
  footer: { ...typography.caption, marginBottom: spacing.md },
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalSafe: { flex: 1, backgroundColor: colors.overlay },
  modalContent: { flexGrow: 1, justifyContent: 'center', gap: spacing.sm },
  modalImage: { width: '100%', height: '82%', backgroundColor: colors.white },
  modalMeta: { ...typography.caption, color: colors.white, textAlign: 'center' },
  modalReturn: { flexShrink: 0, minWidth: 88, minHeight: 44 },
})
