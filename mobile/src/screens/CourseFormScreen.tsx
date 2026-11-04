/**
 * 课程新建 / 编辑表单。字段与后端 `CourseRequest` 对齐，校验在仓库层统一执行。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { courseToDraft } from '../domain/courseDraft'
import { ValidationError } from '../domain/errors'
import { courseColorChoices, emptyCourseDraft, type CourseDraft } from '../domain/types'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, EmptyState, LoadingState, SectionCard } from '../ui/components'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, MIN_TOUCH_SIZE, radius, spacing, typography } from '../ui/theme'
import { Pressable } from 'react-native'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>
type Route = RouteProp<CourseStackParamList, 'CourseForm'>

export function CourseFormScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const editingId = route.params?.id
  const isEditing = typeof editingId === 'number'

  const [draft, setDraft] = useState<CourseDraft>(() => emptyCourseDraft())
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  /** 已经为哪个课程做过初始化；同一 id 不会二次覆盖用户输入。 */
  const hydratedFor = useRef<number | null>(null)
  const [hydrated, setHydrated] = useState(!isEditing)

  const existing = useMemo(
    () => (isEditing ? (store.data.courses.find((course) => course.id === editingId) ?? null) : null),
    [editingId, isEditing, store.data.courses],
  )

  // 只按课程 id 初始化一次；后台刷新（store.data.courses 换引用）不会清掉未保存的输入。
  useEffect(() => {
    if (!isEditing || typeof editingId !== 'number') return
    if (store.status !== 'ready') return
    if (hydratedFor.current === editingId) return
    const target = store.data.courses.find((course) => course.id === editingId)
    if (!target) return
    setDraft(courseToDraft(target))
    hydratedFor.current = editingId
    setHydrated(true)
  }, [editingId, isEditing, store.data.courses, store.status])

  const missing = isEditing && store.status === 'ready' && hydratedFor.current !== editingId && !existing

  const update = useCallback(<K extends keyof CourseDraft>(key: K, value: CourseDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
    setFieldErrors((prev) => {
      if (!prev[key as string]) return prev
      const next = { ...prev }
      delete next[key as string]
      return next
    })
  }, [])

  const onSubmit = useCallback(async () => {
    setFormError(null)
    setSaving(true)
    try {
      if (isEditing && typeof editingId === 'number') {
        await store.updateCourse(editingId, draft)
        navigation.goBack()
      } else {
        const created = await store.createCourse(draft)
        navigation.replace('CourseDetail', { id: created.id })
      }
    } catch (cause) {
      if (cause instanceof ValidationError) {
        setFieldErrors(cause.fields)
        setFormError(cause.message)
      } else {
        setFormError(cause instanceof Error ? cause.message : '保存课程失败。')
      }
    } finally {
      setSaving(false)
    }
  }, [draft, editingId, isEditing, navigation, store])

  if (isEditing && !hydrated && !missing) {
    return (
      <ScreenScaffold title="编辑课程" subtitle="正在读取本机数据…">
        <LoadingState message="正在读取这门课程…" />
      </ScreenScaffold>
    )
  }

  if (missing) {
    return (
      <ScreenScaffold title="找不到这门课程" subtitle="它可能已经被删除">
        <EmptyState
          title="这门课程不在本机了"
          description="它可能已经被删除。返回课程列表即可继续。"
          actionLabel="返回课程列表"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  return (
    <ScreenScaffold
      title={isEditing ? '编辑课程' : '新建课程'}
      subtitle="课程信息保存在这台手机上，不需要网络"
    >
      {formError ? (
        <View style={styles.formError} accessibilityRole="alert">
          <Text style={styles.formErrorText}>{formError}</Text>
        </View>
      ) : null}

      <SectionCard title="课程信息">
        <AppTextField
          label="课程名称"
          required
          value={draft.name}
          onChangeText={(text) => update('name', text)}
          placeholder="例如：数据结构"
          error={fieldErrors.name ?? null}
          editable={!saving}
          maxLength={128}
        />
        {/*
          课程代码**不在界面上出现**：它是内部字段（新建时自动分配一个唯一内部编号，
          老数据里已有的代码原样保留用于匹配）。草稿里的空代码 = 保存时保留原有代码。
          选课序号与内部代码**分开**：截图里课程名后面括号里的那串数字是选课序号，
          留空 = 保留原来记录的值；要清空必须显式点下面的「清空选课序号」。
        */}
        <AppTextField
          label="选课序号"
          value={draft.selectionSerial ?? ''}
          onChangeText={(text) => {
            update('selectionSerial', text)
            update('clearSelectionSerial', false)
          }}
          placeholder="例如：9913000172.08（没有就留空）"
          error={fieldErrors.selectionSerial ?? null}
          hint="截图导入时会自动读出来，用来区分同名但其实是两门不同的课。"
          editable={!saving}
          maxLength={40}
          autoCorrect={false}
        />
        {isEditing && existing?.selectionSerial && (draft.selectionSerial ?? '').trim().length === 0 ? (
          <View style={styles.clearRow}>
            <Text style={styles.clearHint}>
              现在留空 = **保留**原来记录的选课序号（{existing.selectionSerial}）。
            </Text>
            <AppButton
              label="清空选课序号"
              onPress={() => {
                update('selectionSerial', '')
                update('clearSelectionSerial', true)
              }}
              variant="ghost"
              compact
              disabled={saving}
              accessibilityLabel="清空这门课的选课序号"
            />
            {draft.clearSelectionSerial ? (
              <Text style={styles.clearWarn}>已标记：保存后会清空选课序号。</Text>
            ) : null}
          </View>
        ) : null}
        <AppTextField
          label="老师姓名"
          value={draft.instructor}
          onChangeText={(text) => update('instructor', text)}
          placeholder="例如 张三（不填也可以）"
          error={fieldErrors.instructor ?? null}
          editable={!saving}
          maxLength={64}
        />
        <AppTextField
          label="学期"
          value={draft.semester}
          onChangeText={(text) => update('semester', text)}
          placeholder="例如：2026 秋"
          error={fieldErrors.semester ?? null}
          editable={!saving}
          maxLength={32}
        />
        <AppTextField
          label="备注"
          value={draft.note}
          onChangeText={(text) => update('note', text)}
          placeholder="可选"
          error={fieldErrors.note ?? null}
          editable={!saving}
          multiline
          maxLength={500}
        />
      </SectionCard>

      <SectionCard title="课程颜色" subtitle="用于列表与课表的视觉区分，不影响任何逻辑">
        <View style={styles.colorRow}>
          {courseColorChoices.map((color) => {
            const selected = draft.color.toLowerCase() === color.toLowerCase()
            return (
              <Pressable
                key={color}
                onPress={() => update('color', color)}
                accessibilityRole="radio"
                accessibilityLabel={`课程颜色 ${color}`}
                accessibilityState={{ selected }}
                style={[styles.colorSwatch, { backgroundColor: color }, selected && styles.colorSwatchSelected]}
              />
            )
          })}
          <AppButton
            label="清除颜色"
            onPress={() => update('color', '')}
            variant="ghost"
            compact
            accessibilityLabel="清除课程颜色"
            disabled={saving}
          />
        </View>
        {fieldErrors.color ? <Text style={styles.fieldError}>{fieldErrors.color}</Text> : null}
      </SectionCard>

      <AppButton
        label={isEditing ? '保存修改' : '创建课程'}
        onPress={() => void onSubmit()}
        loading={saving}
        disabled={saving}
      />
      <AppButton label="取消" onPress={() => navigation.goBack()} variant="secondary" disabled={saving} style={styles.gap} />
    </ScreenScaffold>
  )
}

const styles = StyleSheet.create({
  muted: { ...typography.bodySoft, color: colors.textMuted, marginBottom: spacing.md },
  formError: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  colorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  colorSwatch: {
    width: MIN_TOUCH_SIZE,
    height: MIN_TOUCH_SIZE,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  colorSwatchSelected: { borderColor: colors.text, borderWidth: 3 },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.sm },
  clearRow: { gap: spacing.xs, marginBottom: spacing.lg },
  clearHint: { ...typography.caption },
  clearWarn: { ...typography.caption, color: colors.warn },
  gap: { marginTop: spacing.md },
})
