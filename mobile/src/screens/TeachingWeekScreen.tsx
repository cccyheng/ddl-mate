/**
 * 教学周设置（**每个学期只设置一次**）。
 *
 * 用户的要求：只问「本周是第几教学周」，由「今天（北京时间）+ 这个数字」
 * 反推出学期第一周周一，之后所有课表表单都用它，表单里不再手填「学期第一周周一」。
 *
 * 界面必须说清楚这个数字指的是**哪一周的哪一天**，所以这里同时展示：
 * - 今天（北京时间）是几月几日、星期几；
 * - 由这次校准算出的「学期第一周周一」；
 * - 以及**重新打开时按今天重算**的当前教学周（学期首周一固定，周次自动往前走）。
 *
 * 没有校准时**不默认成第 1 周**：输入框保持为空，保存时报错并说明原因。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { teachingWeekdayName } from '../domain/datetime'
import { describeCalibration, semesterStartMondayFrom } from '../domain/teachingWeek'
import { MAX_TEACHING_WEEK, MIN_TEACHING_WEEK } from '../domain/teachingWeekRange'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>

export function TeachingWeekScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()

  const [weekInput, setWeekInput] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)

  const summary = useMemo(() => describeCalibration(store.calibration, store.today), [store.calibration, store.today])
  const weekdayText = teachingWeekdayName(store.today)
  const previewMonday = useMemo(
    () => (weekInput.trim() ? semesterStartMondayFrom(store.today, weekInput.trim()) : null),
    [store.today, weekInput],
  )

  const onSave = useCallback(async () => {
    setFieldError(null)
    setFormError(null)
    const raw = weekInput.trim()
    if (!raw) {
      setFieldError(`请填写本周是第几教学周（${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK} 的整数）。`)
      return
    }
    setSaving(true)
    try {
      const result = await store.saveCalibration(raw)
      if (!result.ok) {
        setFormError(result.reason ?? '教学周没有保存成功。')
        return
      }
      setToast({
        text: `已按「今天（${store.today}）是第 ${raw} 教学周」校准，学期第一周周一 = ${result.calibration?.semesterStartMonday ?? '—'}。`,
        tone: 'success',
      })
      setWeekInput('')
    } finally {
      setSaving(false)
    }
  }, [store, weekInput])

  const onClear = useCallback(async () => {
    setSaving(true)
    try {
      await store.clearCalibration()
      setConfirmingClear(false)
      setToast({ text: '教学周校准已清除。需要周次的课表会提示重新设置。', tone: 'success' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : '清除失败。', tone: 'error' })
      setConfirmingClear(false)
    } finally {
      setSaving(false)
    }
  }, [store])

  return (
    <>
      <ScreenScaffold
        title="教学周设置"
        subtitle="每个学期设置一次：告诉我「本周是第几教学周」，我据此推出学期第一周周一"
      >
        {formError ? (
          <View style={styles.formError} accessibilityRole="alert">
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}

        <SectionCard title="当前状态">
          <Text style={styles.line}>
            今天（北京时间）：{store.today}
            {weekdayText ? `（${weekdayText}）` : ''}
          </Text>
          <Text style={styles.line}>
            当前教学周：
            {summary.currentWeek === null ? '未知（还没有校准，或校准数据不完整）' : `第 ${summary.currentWeek} 教学周`}
          </Text>
          <Text style={styles.line}>
            学期第一周周一：
            {store.calibration?.semesterStartMonday ?? '尚未设置'}
          </Text>
          {store.calibration?.setAt ? (
            <Text style={styles.muted}>上次校准写入时间：{store.calibration.setAt}</Text>
          ) : null}
          {summary.warning ? (
            <Text style={styles.warn} accessibilityRole="alert">
              {summary.warning}
            </Text>
          ) : null}
          <Text style={styles.note}>
            校准后当前教学周会**随日期自动往前走**，不需要每周重新设置；
            重新打开这个页面看到的是按今天重算的结果。
          </Text>
        </SectionCard>

        <SectionCard
          title="设置本周是第几教学周"
          subtitle={`填写 ${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK} 的整数；不确定就打开学校课表或教务系统看一眼`}
        >
          <AppTextField
            label={`今天（${store.today}${weekdayText ? ` ${weekdayText}` : ''}）是第几教学周`}
            required
            value={weekInput}
            onChangeText={(text) => {
              setWeekInput(text)
              setFieldError(null)
            }}
            placeholder={`${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK}`}
            keyboardType="number-pad"
            maxLength={2}
            error={fieldError}
            editable={!saving}
            hint={
              previewMonday
                ? `按这个数字推算，学期第一周周一 = ${previewMonday}`
                : `例如：填 7 表示「今天所在的这一周是第 7 教学周」（${MIN_TEACHING_WEEK}–${MAX_TEACHING_WEEK}）。`
            }
            accessibilityLabel="今天所在的这一周是第几教学周"
          />
          <Text style={styles.note}>
            推算方式：学期第一周周一 = 本周一 −（教学周 − 1）× 7 天。
            所以填 7 得到的是「第 7 教学周那一周的周一往前推 6 周」。
          </Text>
          <AppButton
            label={store.calibration ? '更新校准' : '保存校准'}
            onPress={() => void onSave()}
            loading={saving}
            disabled={saving}
          />
          <Text style={styles.note}>
            更新校准**只影响之后新建 / 编辑的课表**；已经保存的课表保留它们自己的学期起点，不会被改写。
          </Text>
        </SectionCard>

        <SectionCard title="清除校准">
          <Text style={styles.note}>
            清除后，要求填写周次范围或单双周的课表会提示你重新设置；
            已经是「每周都上」的课表不受影响。
          </Text>
          <AppButton
            label="清除教学周校准"
            onPress={() => setConfirmingClear(true)}
            variant="danger"
            disabled={saving || !store.calibration}
            accessibilityLabel="清除教学周校准"
          />
        </SectionCard>

        <AppButton label="返回" onPress={() => navigation.goBack()} variant="secondary" />
      </ScreenScaffold>

      <ConfirmDialog
        visible={confirmingClear}
        title="清除教学周校准？"
        details={[
          '保存的「学期第一周周一」会被删除。',
          '已经保存的课表不会被删除，也不会被改写。',
          '之后需要周次范围的课表会要求你重新设置一次。',
        ]}
        confirmLabel="清除校准"
        danger
        busy={saving}
        onConfirm={() => void onClear()}
        onCancel={() => setConfirmingClear(false)}
      />

      {toast ? <Toast text={toast.text} tone={toast.tone} /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  formError: {
    backgroundColor: colors.claySoft,
    borderColor: colors.clay,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  line: { ...typography.bodySoft, marginTop: spacing.xs },
  muted: { ...typography.caption, marginTop: spacing.sm },
  note: { ...typography.caption, marginTop: spacing.sm },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
})
