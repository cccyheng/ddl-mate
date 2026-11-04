/**
 * 课表新建 / 编辑表单（**多天版 + 全局教学周**）。
 *
 * 用户的这一版要求：
 * 1. **移除「开始节次 / 结束节次」输入框**——字段与旧数据仍然保留在模型里，
 *    编辑既有课表时原样带回并写回，界面改版不会抹掉历史数据；
 * 2. 星期**可以多选**（也支持显式「全选」），**每一天各自填时间与地点**，
 *    切换正在编辑的星期不会丢草稿；
 * 3. 选中 = 浅绿、正在编辑 = 深绿、未选 = 中性；取消最后一天会被拒绝并提示；
 * 4. 保存前**逐天校验收所有已勾选的天**，出错时提示是哪一天，并自动切到那一天；
 * 5. **不再手填「学期第一周周一」**：改成「每周（不限周次）」或**点选第几周到第几周**，
 *    单双周按学期第一周计算；学期首周一来自课程页里**每个学期校准一次**的全局设置
 *    （见 `TeachingWeekScreen`）。没有校准又要用周次范围时，明确引导去校准，
 *    **绝不默认成第 1 周，也不替用户猜一个范围**。
 *
 * 保存走 `applyScheduleBatch()`：一次 `BEGIN IMMEDIATE` 事务，任一步失败整批回滚；
 * 返回的 `committed` 是判断「到底写没写进去」的唯一事实。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import { weekdayName, weekdayOptions } from '../domain/datetime'
import {
  buildMultidaySavePlan,
  createMultidayDraft,
  entryOf,
  multidayDraftFromSchedule,
  selectAllWeekdays,
  setActiveWeekday,
  toggleWeekday,
  updateActiveEntry,
  updateTerm,
  validateMultidayDraft,
  weekdayErrorKey,
  weekdayFieldErrorKey,
  type MultidayScheduleDraft,
} from '../domain/scheduleMultidayDraft'
import {
  describeWeekRangeSelection,
  describeWeekRule,
  hasApplicableWeekInRange,
  weekPatternLabels,
  type WeekPattern,
} from '../domain/scheduleRules'
import { resolveSemesterAnchor, usableSemesterAnchor } from '../domain/semesterAnchor'
import { parseTeachingWeek } from '../domain/teachingWeekRange'
import { describeCalibration } from '../domain/teachingWeek'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, EmptyState, LoadingState, OptionGroup, SectionCard } from '../ui/components'
import { Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { MIN_TOUCH_SIZE, colors, radius, spacing, typography } from '../ui/theme'
import { WeekRangeField } from '../ui/weekRangeField'
import { TimeWheelField } from '../ui/timeWheel'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>
type Route = RouteProp<CourseStackParamList, 'ScheduleForm'>

const PATTERN_OPTIONS: ReadonlyArray<{ value: WeekPattern; label: string }> = [
  { value: 'ALL', label: weekPatternLabels.ALL },
  { value: 'ODD', label: weekPatternLabels.ODD },
  { value: 'EVEN', label: weekPatternLabels.EVEN },
]

/** 教学周口径：整学期每周都上，还是只在指定的教学周内上。 */
type TermMode = 'every' | 'weeks'

const TERM_MODE_OPTIONS: ReadonlyArray<{ value: TermMode; label: string }> = [
  { value: 'every', label: '每周（不限周次）' },
  { value: 'weeks', label: '指定第几周到第几周' },
]

type FocusRequest = { weekday: number; field: string; nonce: number }

/** 由草稿判断当前的教学周口径（旧数据里没有任何周次信息 → 每周）。 */
function termModeOf(draft: MultidayScheduleDraft): TermMode {
  return draft.startWeek.trim().length > 0 || draft.endWeek.trim().length > 0 ? 'weeks' : 'every'
}

export function ScheduleFormScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const { courseId, scheduleId } = route.params
  const isEditing = typeof scheduleId === 'number'

  const course = store.courseById(courseId)
  const existing = useMemo(
    () => (isEditing ? (store.data.schedules.find((schedule) => schedule.id === scheduleId) ?? null) : null),
    [isEditing, scheduleId, store.data.schedules],
  )

  const [draft, setDraft] = useState<MultidayScheduleDraft>(() => createMultidayDraft({ weekday: 1 }))
  const [termMode, setTermMode] = useState<TermMode>('every')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [weekdayNotice, setWeekdayNotice] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 已经为哪条课表做过初始化；同一 id 不会二次覆盖用户输入。 */
  const hydratedFor = useRef<number | null>(null)
  const focusNonce = useRef(0)
  const [hydrated, setHydrated] = useState(!isEditing)

  const summary = useMemo(() => describeCalibration(store.calibration, store.today), [store.calibration, store.today])
  const calibrationMonday = store.calibration?.semesterStartMonday ?? ''

  /**
   * 学期第一周周一怎么来的 —— 这是复核对第 11 条点名的 CRITICAL：
   *
   * - **编辑既有课表时，记录自己的锚点优先**：全局教学周后来重新校准过，也**不再**
   *   回头改写这条老课表的学期起点（那会静默挪动用户已经排好的课）；
   * - 新建课表、或用的是没有锚点的老记录时，才使用全局校准算出来的那个周一；
   * - 两者都没有就是 `null`，由 `onSubmit` 明确要求先去校准，绝不猜。
   */
  const anchorResolution = useMemo(
    () =>
      resolveSemesterAnchor({
        existingAnchor: draft.semesterStartDate,
        calibrationMonday,
      }),
    [calibrationMonday, draft.semesterStartDate],
  )
  const resolvedAnchor = anchorResolution.anchor

  /**
   * 提交时真正写进库的草稿：界面里没有「学期第一周周一」输入，
   * 保存这一刻把上面解析出来的学期首周一填进去（已有记录保持原值）。
   */
  const resolvedDraft = useMemo<MultidayScheduleDraft>(() => {
    if (termMode === 'every') {
      return { ...draft, semesterStartDate: '', startWeek: '', endWeek: '', weekPattern: 'ALL' }
    }
    if (resolvedAnchor === null || draft.semesterStartDate === resolvedAnchor) return draft
    return { ...draft, semesterStartDate: resolvedAnchor }
  }, [draft, resolvedAnchor, termMode])

  /** 编辑一条已经有学期起点的老记录：即使全局校准被清掉，也允许继续保存。 */
  const hasOwnAnchor = usableSemesterAnchor(draft.semesterStartDate) !== null

  // 只按课表 id 初始化一次；后台刷新不会覆盖用户正在填的内容。
  useEffect(() => {
    if (!isEditing || typeof scheduleId !== 'number') return
    if (store.status !== 'ready') return
    if (hydratedFor.current === scheduleId) return
    const target = store.data.schedules.find((schedule) => schedule.id === scheduleId)
    if (!target) return
    const next = multidayDraftFromSchedule(target)
    setDraft(next)
    setTermMode(termModeOf(next))
    hydratedFor.current = scheduleId
    setHydrated(true)
  }, [isEditing, scheduleId, store.data.schedules, store.status])

  const missingSchedule =
    isEditing && store.status === 'ready' && hydratedFor.current !== scheduleId && !existing

  /** 正在编辑的既有行（新建时为 null）。 */
  const original = useMemo(
    () => (isEditing && existing ? { scheduleId: existing.id, weekday: existing.weekday } : null),
    [existing, isEditing],
  )

  /**
   * 同一课程里**其它**课表行的实际时段与教学周范围（不含正在编辑的这一条）。
   *
   * 复核定稿：这里传的是「哪一天、哪一段时间、哪个教学周范围」，不是「这一天被占用」。
   * 因此同一天的第二段课（周日 08:00–09:35 与 10:00–11:35）、
   * 以及同一时段的单周/双周各一条都不会被误判成重复。
   */
  const existingSessions = useMemo(
    () =>
      store.data.schedules
        .filter((schedule) => schedule.courseId === courseId && schedule.id !== original?.scheduleId)
        .map((schedule) => ({
          weekday: schedule.weekday,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          weekPattern: schedule.weekPattern,
          semesterStartDate: schedule.semesterStartDate,
          startWeek: schedule.startWeek,
          endWeek: schedule.endWeek,
        })),
    [courseId, original?.scheduleId, store.data.schedules],
  )

  const activeEntry = entryOf(draft, draft.activeWeekday)
  const selectedCount = draft.selectedWeekdays.length
  const invalidWeekdays = useMemo(() => {
    const days = new Set<number>()
    for (const key of Object.keys(fieldErrors)) {
      const dayMatch = /^day:(\d):/.exec(key)
      if (dayMatch) days.add(Number(dayMatch[1]))
      const weekdayMatch = /^weekday:(\d)$/.exec(key)
      if (weekdayMatch) days.add(Number(weekdayMatch[1]))
    }
    return days
  }, [fieldErrors])

  const preview = useMemo(
    () =>
      describeWeekRule({
        weekday: resolvedDraft.selectedWeekdays[0] ?? 1,
        semesterStartDate: resolvedDraft.semesterStartDate.trim() || null,
        startWeek: resolvedDraft.startWeek.trim() ? Number(resolvedDraft.startWeek) : null,
        endWeek: resolvedDraft.endWeek.trim() ? Number(resolvedDraft.endWeek) : null,
        weekPattern: resolvedDraft.weekPattern,
      }),
    [resolvedDraft],
  )

  const parsedStartWeek = parseTeachingWeek(draft.startWeek)
  const parsedEndWeek = parseTeachingWeek(draft.endWeek)
  const weekSummary = useMemo(
    () => describeWeekRangeSelection(draft.startWeek, draft.endWeek, draft.weekPattern),
    [draft.endWeek, draft.startWeek, draft.weekPattern],
  )
  /**
   * 「第 7–7 周 + 双周」这类范围合法、但一周课都没有的组合，在选择后立即提示；
   * 不静默把范围扩成 1–16，也不偷偷把单双周改成每周。
   */
  const parityWarning = useMemo(() => {
    if (termMode !== 'weeks' || draft.weekPattern === 'ALL') return null
    if (parsedStartWeek === null || parsedEndWeek === null || parsedStartWeek > parsedEndWeek) return null
    if (hasApplicableWeekInRange(parsedStartWeek, parsedEndWeek, draft.weekPattern)) return null
    const range =
      parsedStartWeek === parsedEndWeek ? `第 ${parsedStartWeek} 周` : `第 ${parsedStartWeek}–${parsedEndWeek} 周`
    return `${range}里没有${weekPatternLabels[draft.weekPattern]}的周次，请调整范围或改成每周。`
  }, [draft.weekPattern, parsedEndWeek, parsedStartWeek, termMode])

  const clearDayError = useCallback((weekday: number, field: string) => {
    setFieldErrors((prev) => {
      const key = weekdayFieldErrorKey(weekday, field)
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const onToggleWeekday = useCallback(
    (weekday: number) => {
      setFocusRequest(null)
      const result = toggleWeekday(draft, weekday)
      if (!result.changed) {
        setWeekdayNotice(
          `至少要保留一天。请先勾选其它星期，再取消${weekdayName(weekday)}；否则这节课就没有上课时间了。`,
        )
        return
      }
      setWeekdayNotice(null)
      setDraft(result.draft)
    },
    [draft],
  )

  const onSelectAll = useCallback(() => {
    setFocusRequest(null)
    setWeekdayNotice(null)
    setDraft((prev) => selectAllWeekdays(prev))
  }, [])

  const onPickActive = useCallback((weekday: number) => {
    setFocusRequest(null)
    setDraft((prev) => setActiveWeekday(prev, weekday))
  }, [])

  const onEditEntryField = useCallback(
    (field: 'startTime' | 'endTime' | 'location', value: string) => {
      setFocusRequest(null)
      setDraft((prev) => updateActiveEntry(prev, { [field]: value }))
      clearDayError(draft.activeWeekday, field)
    },
    [clearDayError, draft.activeWeekday],
  )

  const onEditTerm = useCallback((patch: Partial<MultidayScheduleDraft>) => {
    setDraft((prev) => updateTerm(prev, patch))
    setFieldErrors((prev) => {
      const keys = new Set(Object.keys(patch))
      // 起止周是成对校验的：改动任一端都清掉两端的旧错误，避免过时提示。
      if ('startWeek' in patch || 'endWeek' in patch) {
        keys.add('startWeek')
        keys.add('endWeek')
      }
      let next: Record<string, string> | null = null
      for (const key of keys) {
        if (prev[key]) {
          next = next ?? { ...prev }
          delete next[key]
        }
      }
      return next ?? prev
    })
  }, [])

  const onPickTermMode = useCallback((mode: TermMode) => {
    setTermMode(mode)
    setFormError(null)
    setFieldErrors((prev) => {
      const next = { ...prev }
      delete next.semesterStartDate
      delete next.startWeek
      delete next.endWeek
      delete next.weekPattern
      return next
    })
    // 切到「每周（不限周次）」时**不清空已选周次**：保存时本来就会按每周写空，
    // 但用户如果只是点错再点回来，原来的起止周仍然在，不会被静默重置。
  }, [])

  const onPickStartWeek = useCallback(
    (week: number) => onEditTerm({ startWeek: String(week) }),
    [onEditTerm],
  )
  const onPickEndWeek = useCallback(
    (week: number) => onEditTerm({ endWeek: String(week) }),
    [onEditTerm],
  )

  /** 出错时切到第一个出问题的星期，并让那个字段自动获得焦点。 */
  const focusInvalidWeekday = useCallback((weekday: number | null, field: string) => {
    if (weekday === null) return
    focusNonce.current += 1
    setDraft((prev) => setActiveWeekday(prev, weekday))
    setFocusRequest({ weekday, field, nonce: focusNonce.current })
  }, [])

  const onSubmit = useCallback(async () => {
    setFormError(null)
    setWeekdayNotice(null)

    // 教学周口径在「表单级」先校验：缺学期起点、只填一半都在这里拦下来。
    // 注意：**编辑一条自带学期起点的老记录时，不需要全局校准也能保存**
    // （复核对第 11 条：不能因为全局没设置就拦住老数据，更不能拿全局去改写它）。
    if (termMode === 'weeks') {
      if (resolvedAnchor === null) {
        setFormError(
          hasOwnAnchor
            ? '这条课表的学期起点不完整，请重新校准教学周后再保存。'
            : '还没有设置过教学周。请先到「教学周设置」里选一次「本周是第几教学周」，之后再填周次范围。',
        )
        return
      }
      const missingStart = !resolvedDraft.startWeek.trim()
      const missingEnd = !resolvedDraft.endWeek.trim()
      if (missingStart || missingEnd) {
        setFieldErrors((prev) => ({
          ...prev,
          ...(missingStart ? { startWeek: '请选择起始教学周。' } : {}),
          ...(missingEnd ? { endWeek: '请选择结束教学周。' } : {}),
        }))
        setFormError(
          missingStart && missingEnd
            ? '请点按「起始周」「结束周」选择第几周到第几周。'
            : missingStart
              ? '还差起始教学周，请点按「起始周」选择。'
              : '还差结束教学周，请点按「结束周」选择。',
        )
        return
      }
    }

    setSaving(true)
    try {
      const validation = validateMultidayDraft(resolvedDraft)
      if (!validation.ok) {
        setFieldErrors({ ...validation.sharedErrors, ...validation.dayErrors })
        const sharedDetails = Object.values(validation.sharedErrors).slice(0, 2)
        const dayDetails = validation.issues
          .slice(0, 3)
          .map((issue) => `${weekdayName(issue.weekday)}：${issue.message}`)
        const details = [...sharedDetails, ...dayDetails].join('；')
        setFormError(details ? `课表信息还有问题需要修改。${details}` : '课表信息还有问题需要修改。')
        const firstIssue = validation.issues.find((issue) => issue.weekday === validation.firstInvalidWeekday)
        focusInvalidWeekday(validation.firstInvalidWeekday, firstIssue?.field ?? 'startTime')
        return
      }

      const plan = buildMultidaySavePlan(resolvedDraft, { original, existingSessions })
      if (plan.duplicates.length > 0) {
        const duplicates: Record<string, string> = {}
        for (const weekday of plan.duplicates) {
          duplicates[weekdayErrorKey(weekday)] =
            `${weekdayName(weekday)}的这个时段已经有这门课的一条完全相同的课表了，请到课程详情页直接编辑那一条。`
        }
        setFieldErrors(duplicates)
        setFormError(
          plan.duplicates
            .map((weekday) => `${weekdayName(weekday)}的这个时段已经有完全相同的课表。`)
            .join('') + '如果这是同一天的另一段课，请把时间改成不同的时段。',
        )
        const firstDuplicate = plan.duplicates[0] ?? null
        if (firstDuplicate !== null) setDraft((prev) => setActiveWeekday(prev, firstDuplicate))
        return
      }

      const outcome = await store.applyScheduleBatch(courseId, { updates: plan.updates, creates: plan.creates })
      if (outcome.readbackError) {
        // 事务已经提交：只说「已保存，列表还没刷新」，绝不引导用户再存一次。
        setToast({ text: '课表已经保存好了，只是列表还没刷新。返回后重新进入课程详情即可看到。', tone: 'success' })
        navigation.goBack()
        return
      }
      setToast({ text: isEditing ? '课表已保存。' : `已添加 ${selectedCount} 天课表。`, tone: 'success' })
      navigation.goBack()
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setFieldErrors(cause.fields)
        setFormError(cause.message)
      } else {
        setFormError(cause instanceof Error ? cause.message : '保存课表失败。')
      }
    } finally {
      setSaving(false)
    }
  }, [
    courseId,
    existingSessions,
    focusInvalidWeekday,
    hasOwnAnchor,
    isEditing,
    navigation,
    original,
    resolvedAnchor,
    resolvedDraft,
    selectedCount,
    store,
    termMode,
  ])

  if (!course) {
    return (
      <ScreenScaffold title="找不到这门课程" subtitle="无法添加课表">
        <EmptyState
          title="课程不在这台手机上了"
          description="它可能已经被删除。返回课程列表后可以重新添加课表。"
          actionLabel="返回课程列表"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  if (isEditing && !hydrated && !missingSchedule) {
    return (
      <ScreenScaffold title="编辑课表" subtitle="正在读取本机数据…">
        <LoadingState message="正在读取这条课表…" />
      </ScreenScaffold>
    )
  }

  if (missingSchedule) {
    return (
      <ScreenScaffold title="找不到这条课表" subtitle="它可能已经被删除">
        <EmptyState
          title="这条课表不在本机了"
          description="它可能已经被删除。返回课程详情可以重新添加。"
          actionLabel="返回"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  const originalNotRetained = original !== null && !draft.selectedWeekdays.includes(original.weekday)
  const focusField = focusRequest && focusRequest.weekday === draft.activeWeekday ? focusRequest.field : null
  const editorKey = `${draft.activeWeekday}:${focusRequest?.weekday === draft.activeWeekday ? focusRequest.nonce : 0}`

  return (
    <>
      <ScreenScaffold
        title={isEditing ? '编辑课表' : '添加课表'}
        subtitle={course.name}
      >
        {formError ? (
          <View style={styles.formError} accessibilityRole="alert">
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}

        <SectionCard
          title="上课时间与地点"
          subtitle="先勾选上课的星期（可多选），再为每一天分别填写时间与地点"
        >
          <View style={styles.weekdayHeader}>
            <Text style={styles.fieldLabel}>星期（可多选）</Text>
            <Text style={styles.selectedCount} accessibilityLabel={`已经选择 ${selectedCount} 天`}>
              已选 {selectedCount} 天
            </Text>
          </View>

          <View style={styles.weekdayRow} accessibilityRole="list">
            {weekdayOptions.map((option) => {
              const selected = draft.selectedWeekdays.includes(option.value)
              const active = draft.activeWeekday === option.value
              const invalid = invalidWeekdays.has(option.value)
              return (
                <Pressable
                  key={option.value}
                  onPress={() =>
                    active ? onToggleWeekday(option.value) : selected ? onPickActive(option.value) : onToggleWeekday(option.value)
                  }
                  disabled={saving}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${option.label}${active ? '，正在编辑' : selected ? '，已选择' : '，未选择'}`}
                  accessibilityHint={
                    active
                      ? '点按取消这一天（至少要保留一天）'
                      : selected
                        ? '点按切换为正在编辑'
                        : '点按选择这一天'
                  }
                  accessibilityState={{ checked: selected, selected: active, disabled: saving }}
                  style={({ pressed }) => [
                    styles.chip,
                    selected && styles.chipSelected,
                    active && styles.chipActive,
                    invalid && styles.chipInvalid,
                    pressed && !saving && styles.chipPressed,
                  ]}
                >
                  <Text
                    style={[styles.chipLabel, selected && styles.chipLabelSelected, active && styles.chipLabelActive]}
                  >
                    {option.label}
                  </Text>
                  {invalid ? <Text style={styles.chipBadge}>需修改</Text> : null}
                </Pressable>
              )
            })}
          </View>

          <View style={styles.weekdayActions}>
            <Pressable
              onPress={onSelectAll}
              disabled={saving || selectedCount === weekdayOptions.length}
              accessibilityRole="button"
              accessibilityLabel="全选七天"
              accessibilityState={{ disabled: saving || selectedCount === weekdayOptions.length }}
              style={({ pressed }) => [
                styles.smallButton,
                (saving || selectedCount === weekdayOptions.length) && styles.smallButtonDisabled,
                pressed && styles.smallButtonPressed,
              ]}
            >
              <Text style={styles.smallButtonLabel}>全选七天</Text>
            </Pressable>
            <Pressable
              onPress={() => onToggleWeekday(draft.activeWeekday)}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel={`取消${weekdayName(draft.activeWeekday)}（至少保留一天）`}
              accessibilityState={{ disabled: saving }}
              style={({ pressed }) => [
                styles.smallButton,
                saving && styles.smallButtonDisabled,
                pressed && styles.smallButtonPressed,
              ]}
            >
              <Text style={styles.smallButtonLabel}>取消{weekdayName(draft.activeWeekday)}</Text>
            </Pressable>
          </View>

          <Text style={styles.activeDayLabel}>
            正在编辑：{weekdayName(draft.activeWeekday)}（{draft.selectedWeekdays.map((day) => weekdayName(day)).join('、')}）
          </Text>

          {weekdayNotice ? (
            <Text style={styles.weekdayNotice} accessibilityRole="alert">
              {weekdayNotice}
            </Text>
          ) : null}
          {originalNotRetained ? (
            <Text style={styles.weekdayNotice}>
              你取消了原来的{weekdayName(original?.weekday ?? 1)}。保存时不会删除这条原有课表，
              它保持原样；如需删除请回到课程详情页。
            </Text>
          ) : null}
          {fieldErrors.weekdays ? <Text style={styles.fieldError}>{fieldErrors.weekdays}</Text> : null}
          {draft.selectedWeekdays
            .filter((weekday) => fieldErrors[weekdayErrorKey(weekday)])
            .map((weekday) => (
              <Text key={`conflict-${weekday}`} style={styles.fieldError} accessibilityRole="alert">
                {fieldErrors[weekdayErrorKey(weekday)]}
              </Text>
            ))}

          <View key={editorKey} style={styles.dayEditor}>
            <TimeWheelField
              label={`${weekdayName(draft.activeWeekday)} · 开始时间`}
              required
              value={activeEntry.startTime}
              onChange={(value) => onEditEntryField('startTime', value)}
              error={fieldErrors[weekdayFieldErrorKey(draft.activeWeekday, 'startTime')] ?? null}
              hint="点按后用 24 小时制滚轮选择，精确到分钟。"
              disabled={saving}
              identityKey={`weekday:${draft.activeWeekday}`}
              accessibilityLabel={`${weekdayName(draft.activeWeekday)}的开始时间`}
              testID="schedule-start-time"
            />
            <TimeWheelField
              label={`${weekdayName(draft.activeWeekday)} · 结束时间`}
              required
              value={activeEntry.endTime}
              onChange={(value) => onEditEntryField('endTime', value)}
              error={fieldErrors[weekdayFieldErrorKey(draft.activeWeekday, 'endTime')] ?? null}
              hint="结束时间可以晚于开始时间；同一天的第二段课请分开添加。"
              disabled={saving}
              identityKey={`weekday:${draft.activeWeekday}`}
              accessibilityLabel={`${weekdayName(draft.activeWeekday)}的结束时间`}
              testID="schedule-end-time"
            />
            <AppTextField
              label={`${weekdayName(draft.activeWeekday)} · 地点`}
              value={activeEntry.location}
              onChangeText={(text) => onEditEntryField('location', text)}
              placeholder="例如：教三 305"
              error={fieldErrors[weekdayFieldErrorKey(draft.activeWeekday, 'location')] ?? null}
              editable={!saving}
              maxLength={128}
              autoFocus={focusField === 'location'}
              accessibilityLabel={`${weekdayName(draft.activeWeekday)}的上课地点`}
            />
          </View>
        </SectionCard>

        <SectionCard
          title="教学周"
          subtitle="选「每周（不限周次）」，或直接点选第几周到第几周；单双周按学期第一周计算"
        >
          <OptionGroup
            label="上课周次"
            options={TERM_MODE_OPTIONS}
            value={termMode}
            onChange={onPickTermMode}
            disabled={saving}
          />

          {termMode === 'weeks' ? (
            <>
              <WeekRangeField
                startWeek={draft.startWeek}
                endWeek={draft.endWeek}
                error={fieldErrors.startWeek ?? fieldErrors.endWeek ?? null}
                disabled={saving}
                onChangeStart={onPickStartWeek}
                onChangeEnd={onPickEndWeek}
              />
              <OptionGroup
                label="周次规律"
                options={PATTERN_OPTIONS}
                value={draft.weekPattern}
                onChange={(value) => onEditTerm({ weekPattern: value })}
                error={fieldErrors.weekPattern ?? parityWarning}
                disabled={saving}
              />
              <View style={styles.weekSummaryBox} accessibilityLabel={`已选教学周：${weekSummary}`}>
                <Text style={styles.weekSummaryLabel}>已选范围</Text>
                <Text style={styles.weekSummaryText}>{weekSummary}</Text>
              </View>
              <Text style={styles.note}>
                单双周是相对「学期第一周」的奇偶：第 1、3、5… 周算单周，第 2、4、6… 周算双周。
              </Text>
            </>
          ) : (
            <Text style={styles.note}>
              每周（不限周次）：这门课每周都会出现在日历与今日课程里，不受教学周限制。
            </Text>
          )}

          <View style={styles.calibrationBox}>
            <Text style={styles.calibrationTitle}>教学周状态（全局，每个学期设置一次）</Text>
            <Text style={styles.calibrationLine}>今天：{summary.todayLine}</Text>
            <Text style={styles.calibrationLine}>
              {summary.currentWeek === null ? '当前教学周：未知' : `本周：第 ${summary.currentWeek} 教学周`}
            </Text>
            {/*
              用户明确要求课表表单里**不再出现「学期第一周周一」**这个日期，
              只显示当前教学周状态。已有记录自己的起止周与学期起点在保存时原样保留，
              不会被全局设置改写（见 domain/semesterAnchor.ts）。
            */}
            <Text style={styles.calibrationLine}>
              {termMode === 'every' ? '这条课表不受教学周限制。' : `这条课表的周次：${weekSummary}。`}
            </Text>
            {fieldErrors.semesterStartDate ? (
              <Text style={styles.fieldError} accessibilityRole="alert">
                {fieldErrors.semesterStartDate}
              </Text>
            ) : null}
            {termMode === 'weeks' && resolvedAnchor === null ? (
              <Text style={styles.calibrationWarn} accessibilityRole="alert">
                要按教学周上课，请先设置一次「本周是第几教学周」。
              </Text>
            ) : null}
            {termMode === 'weeks' && resolvedAnchor !== null && anchorResolution.source === 'existing' ? (
              <Text style={styles.calibrationLine}>
                这条课表沿用自己保存时的学期起点，全局重新校准不会改动它。
              </Text>
            ) : null}
            {!calibrationMonday || summary.warning ? (
              <AppButton
                label={calibrationMonday ? '重新校准教学周' : '去设置教学周'}
                onPress={() => navigation.navigate('TeachingWeek')}
                variant="secondary"
                compact
                style={styles.calibrationAction}
                accessibilityLabel="打开教学周设置"
              />
            ) : null}
          </View>

          <Text style={styles.preview}>当前规则预览：{preview}</Text>
        </SectionCard>

        <AppButton
          label={isEditing ? '保存课表' : selectedCount > 1 ? `添加 ${selectedCount} 天课表` : '添加课表'}
          onPress={() => void onSubmit()}
          loading={saving}
          disabled={saving}
        />
        <AppButton label="取消" onPress={() => navigation.goBack()} variant="secondary" disabled={saving} style={styles.gap} />
      </ScreenScaffold>

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  formError: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  fieldLabel: { ...typography.label },
  weekdayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectedCount: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600' },
  weekdayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    minWidth: 64,
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** 已选 = 浅绿。 */
  chipSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  /** 正在编辑 = 深绿（比已选更深）。 */
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primaryDark },
  chipInvalid: { borderColor: colors.clay, borderWidth: 2 },
  chipPressed: { opacity: 0.75 },
  chipLabel: { ...typography.bodySoft, color: colors.textSoft, fontWeight: '600' },
  chipLabelSelected: { color: colors.primaryDark },
  chipLabelActive: { color: colors.white },
  chipBadge: { ...typography.caption, color: colors.clay, fontSize: 11 },
  weekdayActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  smallButton: {
    minHeight: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButtonDisabled: { opacity: 0.45 },
  smallButtonPressed: { backgroundColor: colors.surfaceMute },
  smallButtonLabel: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600' },
  activeDayLabel: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '600', marginTop: spacing.md },
  weekdayNotice: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.sm },
  dayEditor: { marginTop: spacing.md, gap: spacing.sm },
  note: { ...typography.caption, marginTop: spacing.sm },
  weekSummaryBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primarySoft,
    backgroundColor: colors.primaryTint,
  },
  weekSummaryLabel: { ...typography.caption, color: colors.textSoft },
  weekSummaryText: { ...typography.bodySoft, color: colors.primaryDark, fontWeight: '700', marginTop: 2 },
  preview: { ...typography.bodySoft, marginTop: spacing.sm, color: colors.primaryDark, fontWeight: '600' },
  calibrationBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
  },
  calibrationTitle: { ...typography.label },
  calibrationLine: { ...typography.caption, marginTop: 2 },
  calibrationWarn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  calibrationAction: { marginTop: spacing.sm },
  gap: { marginTop: spacing.md },
})
