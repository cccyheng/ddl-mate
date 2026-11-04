/**
 * 照片导入课表 —— 第二步：逐行核对 + **一个明确的导入动作**。
 *
 * 用户的硬要求：
 * - 候选行可以**全选 / 逐行勾选**，每行可改课程名、星期、时间、地点、教学周与单双周；
 * - 只有点了「导入」才写数据库，而且**整批一条事务**：任何一行不合法就整批不写；
 * - 重复点导入 / 失败重试都**不会产生重复行**（仓库层按「同天同时段同周次范围」判重后跳过）；
 * - 失败时**不清空**用户改好的内容，留在页面让用户改完再试；
 * - 教程说明：截图里显示「第 N 周」时按第 N 周导入（不是整学期重复）。
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { ValidationError } from '../domain/errors'
import { normalizeCourseNameForCompare } from '../domain/courseDraft'
import { findTeacherConflicts, type TeacherConflict } from '../domain/scheduleImportRepository'
import { weekdayName, weekdayOptions } from '../domain/datetime'
import {
  WEEK_PATTERN_OPTIONS,
  countRowsNeedingFix,
  describeRow,
  describeWeekRange,
  deriveWeekEvidence,
  deriveWeekScope,
  hasWeekScope,
  rowToDrafts,
  validateRow,
  type PhotoImportRow,
  type WeekPatternValue,
  type WeekScope,
} from '../domain/photoImport'
import { describeCalibration, type TeachingWeekCalibration } from '../domain/teachingWeek'
import { useAppStore } from '../store/AppStore'
import { AppButton, AppTextField, Badge, OptionGroup, SectionCard } from '../ui/components'
import { ConfirmDialog, Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { TimeWheelField } from '../ui/timeWheel'
import { colors, radius, spacing, typography } from '../ui/theme'
import type { CourseStackParamList } from '../navigation/types'

type Nav = NativeStackNavigationProp<CourseStackParamList>
type Route = RouteProp<CourseStackParamList, 'PhotoReview'>

interface ReviewPayload {
  rows: PhotoImportRow[]
  week: number | null
  /** 这批行来自哪一次截图归档（导入时写持久关联）。 */
  attemptId: number | null
  /** 这批行来自哪一条识别结果（可选，用于标记候选行「已导入」）。 */
  resultId: number | null
}

function parsePayload(raw: string | undefined): ReviewPayload {
  if (!raw) return { rows: [], week: null, attemptId: null, resultId: null }
  try {
    const parsed = JSON.parse(raw) as ReviewPayload
    return {
      rows: Array.isArray(parsed.rows) ? parsed.rows.map(normalizeParsedRow) : [],
      week: parsed.week ?? null,
      attemptId: Number.isInteger(parsed.attemptId) ? Number(parsed.attemptId) : null,
      resultId: Number.isInteger(parsed.resultId) ? Number(parsed.resultId) : null,
    }
  } catch {
    return { rows: [], week: null, attemptId: null, resultId: null }
  }
}

/**
 * 旧导航参数里的行**没有 `teacher` 字段**（这次改动之前进入核对页、之后热重载）。
 *
 * 补成空串而不是让它保持 `undefined`：后面对 `row.teacher` 的读写都按字符串处理，
 * 缺字段的正确含义是「没有老师信息」，不是崩溃，也不是编一个。
 */
function normalizeParsedRow(row: PhotoImportRow): PhotoImportRow {
  return { ...row, teacher: typeof row.teacher === 'string' ? row.teacher : '' }
}

/**
 * 截图给出的周次**证据**有哪几种（范围 vs 快照 vs 没有）。
 *
 * 这是复核对点名的「范围 / 快照标签误导」的修法：不再只看 `payload.week`
 * （整图级的单一周次），而是逐行看每行真实的 `weekScope`。
 */
export interface WeekEvidenceSummary {
  hasSnapshot: boolean
  hasRange: boolean
  /** 范围行的示例（`1–16` 这种），最多 3 条。 */
  ranges: string[]
  /** 快照行示例（`7` 这种），最多 3 条。 */
  snapshots: number[]
}

export function summarizeWeekEvidence(rows: readonly PhotoImportRow[]): WeekEvidenceSummary {
  const ranges: string[] = []
  const snapshots: number[] = []
  for (const row of rows) {
    if (!hasWeekScope(row)) continue
    if (row.weekScope === 'range') {
      const text = `${row.startWeek.trim()}–${row.endWeek.trim()}`
      if (!ranges.includes(text) && ranges.length < 3) ranges.push(text)
    } else if (row.weekScope === 'snapshot' && snapshots.length < 3) {
      const value = Number(row.startWeek)
      if (Number.isInteger(value) && !snapshots.includes(value)) snapshots.push(value)
    }
  }
  return { hasSnapshot: snapshots.length > 0, hasRange: ranges.length > 0, ranges, snapshots }
}

/**
 * 找出「同名但选课序号不同」的行。
 *
 * 这类行是**两门不同的课**（导入时不会被合并），所以必须在核对页就明确提醒：
 * 否则用户会以为识别重复了，手动删掉其中一行 —— 那就丢数据了。
 */
export function findSerialConflicts(rows: readonly PhotoImportRow[]): Map<string, string[]> {
  const groups = new Map<string, { rowId: string; serial: string }[]>()
  for (const row of rows) {
    const name = normalizeCourseNameForCompare(row.name)
    const serial = row.selectionSerial.trim()
    if (!name || !serial) continue
    const list = groups.get(name)
    if (list) list.push({ rowId: row.id, serial })
    else groups.set(name, [{ rowId: row.id, serial }])
  }
  const conflicts = new Map<string, string[]>()
  for (const list of groups.values()) {
    const serials = [...new Set(list.map((entry) => entry.serial))]
    if (serials.length < 2) continue
    for (const entry of list) conflicts.set(entry.rowId, serials)
  }
  return conflicts
}

/** 把行上的错误摊平成 `row<id>:<field>` 键，便于逐字段显示。 */
function errorMap(rows: readonly PhotoImportRow[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of rows) {
    if (!row.include) continue
    for (const issue of validateRow(row)) {
      map[`${row.id}:${issue.field}`] = issue.message
    }
  }
  return map
}

/**
 * 仓库层的 `ValidationError.fields` 用的是 `row:<行号>:<字段>` 键（见 `scheduleImportRepository`）。
 *
 * 这里翻译成界面按行 id 索引的键，并给出**到底是哪几行**有问题，
 * 这样保存失败时错误会落在出错的那一行上，而不是只弹一句笼统的话。
 */
export function repositoryErrorsToRowKeys(
  rows: readonly PhotoImportRow[],
  fields: Record<string, string>,
): { byRowId: Record<string, string>; rowNumbers: number[] } {
  const byRowId: Record<string, string> = {}
  const rowNumbers: number[] = []
  for (const [key, message] of Object.entries(fields)) {
    const match = /^row:(\d+):(.+)$/.exec(key)
    if (!match) {
      // 没有行号的字段错误（例如整批的 `candidates`）先保留在 `candidates` 键上。
      byRowId[key] = message
      continue
    }
    const rowNumber = Number(match[1])
    const field = match[2] ?? ''
    const row = rows.find((candidate) => candidate.rowNumber === rowNumber)
    if (row) byRowId[`${row.id}:${field}`] = message
    if (!rowNumbers.includes(rowNumber)) rowNumbers.push(rowNumber)
  }
  rowNumbers.sort((left, right) => left - right)
  return { byRowId, rowNumbers }
}

/**
 * 把导入时的老师姓名冲突说成人话（保留了什么、忽略了什么、下一步怎么办）。
 *
 * 措辞刻意说「保留 / 忽略」而不是「失败」：导入本身是成功的，
 * 课程记录也没有被破坏，只是一部分老师值没有写进去，需要用户自己决定怎么处理。
 */
export function describeTeacherConflicts(conflicts: readonly TeacherConflict[]): string {
  const detail = conflicts
    .slice(0, 3)
    .map((conflict) => `《${conflict.courseName}》保留了「${conflict.keptTeacher}」，忽略了识别到的「${conflict.ignoredTeacher}」`)
    .join('；')
  const more = conflicts.length > 3 ? `（另有 ${conflicts.length - 3} 条同类冲突）` : ''
  return (
    `导入已完成，但同一门课识别出了不同的老师：${detail}${more}。` +
    `每门课只保留先写入或库里已有的那一位老师，其它老师没有写进课程记录。` +
    `要修正的话，可以在课程详情或编辑里改成正确的老师，或者把其实是两门课的行用课程名、选课序号区分开。`
  )
}

export function PhotoReviewScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const payload = useMemo(() => parsePayload(route.params?.payload), [route.params?.payload])

  const [rows, setRows] = useState<PhotoImportRow[]>(payload.rows)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  /** 已经成功提交过一次的标记：提交后即便读回失败也**不允许**再点导入（否则会重复写）。 */
  const [committed, setCommitted] = useState(false)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [toast, setToast] = useState<{ text: string; tone: 'success' | 'error' } | null>(null)
  /** 导入后「老师姓名冲突」的说明（有值时留在页面上让用户看清，不悄悄返回）。 */
  const [importNotice, setImportNotice] = useState<string | null>(null)

  const calibration: TeachingWeekCalibration | null = store.calibration
  const summary = useMemo(() => describeCalibration(calibration, store.today), [calibration, store.today])
  const included = rows.filter((row) => row.include)
  const needingFix = countRowsNeedingFix(rows)
  /** 整图级的周次（只在图上明确标了「第 N 周」时才有）。 */
  const weekFromImage = payload.week
  /** 逐行的周次证据：范围 / 快照分别统计，用来给出**不误导**的文案。 */
  const weekEvidence = useMemo(() => summarizeWeekEvidence(included), [included])
  /** 同名但选课序号不同的行：必须提醒「这是两门课」，不能静静合并。 */
  const serialConflicts = useMemo(() => findSerialConflicts(included), [included])
  /**
   * 同一门课的多条记录给了**不同的老师**。
   *
   * 导入时每门课只会保留先写下的那一个老师（仓库层不覆盖已存在的值），
   * 因此在核对页就要让用户看见，而不是导入后才发现少了一位老师。
   */
  const teacherConflicts = useMemo(() => findTeacherConflicts(included), [included])

  const patchRow = useCallback((id: string, patch: Partial<PhotoImportRow>) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row
        const next = { ...row, ...patch, edited: true }
        // 用户手改起止周时，周次证据类型要跟着走，否则「范围 / 快照」标签会撒谎。
        if ('startWeek' in patch || 'endWeek' in patch) {
          next.weekScope = deriveWeekScope(next.startWeek, next.endWeek)
          next.weekFromImage = deriveWeekEvidence(next.startWeek, next.endWeek, next.weekScope)
        }
        return next
      }),
    )
    setErrors((prev) => {
      let next: Record<string, string> | null = null
      for (const key of Object.keys(patch)) {
        // 行上的字段名与仓库/草稿的字段名有两处不一致，这里必须显式对上，
        // 否则用户改好了字段、错误提示却清不掉（或清错到别的字段上）：
        // - `weekPattern` 的错误报在 `weekRange`；
        // - 「老师姓名」在草稿/仓库里叫 `instructor`。
        const errorKey = `${id}:${key === 'weekPattern' ? 'weekRange' : key === 'teacher' ? 'instructor' : key}`
        if (prev[errorKey]) {
          next = next ?? { ...prev }
          delete next[errorKey]
        }
      }
      return next ?? prev
    })
  }, [])

  const toggleInclude = useCallback((id: string) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, include: !row.include, edited: true } : row)))
  }, [])

  /**
   * 批量勾选 / 取消勾选。
   *
   * 只改 `include`，**不碰周次**（早期版本会顺手清空周次，等于静默扩大范围）。
   */
  const setAllIncluded = useCallback((include: boolean) => {
    setRows((prev) => prev.map((row) => ({ ...row, include })))
  }, [])

  const onImport = useCallback(async () => {
    if (importing || committed) return
    setFormError(null)

    if (included.length === 0) {
      setFormError('一行都没有勾选，没有东西可以导入。请先勾选要导入的行。')
      return
    }
    const localErrors = errorMap(rows)
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors)
      setFormError(
        `还有 ${needingFix} 行需要补充或修改（缺少必填项的行不会写进数据库）。改好后可以再点导入。`,
      )
      return
    }

    setImporting(true)
    try {
      const outcome = await store.importSchedules({
        candidates: included.map((row) => {
          const { course, schedule } = rowToDrafts(row, {
            semesterStartMonday: calibration?.semesterStartMonday ?? null,
            applySemesterStart: true,
          })
          return {
            rowNumber: row.rowNumber,
            include: true,
            course,
            schedule,
            note: row.rawText,
            // 逐行挂回截图来源：导入成功后写持久关联（关掉 App 也还在）。
            originAttemptId: row.linkedAttemptId ?? payload.attemptId,
            originResultId: payload.resultId,
            originRowIndex: row.rowNumber - 1,
          }
        }),
        originAttemptId: payload.attemptId,
      })

      // 只要 committed 为真，就绝不允许再点一次导入（否则会产生重复行）。
      setCommitted(true)
      /*
       * 老师姓名冲突：课程记录没有被改写（保留的是先写入/库里已有的老师），
       * 但用户必须知道哪些值被忽略了。
       *
       * **必须在 `readbackError` 的提前返回之前设置**：读回失败与老师冲突可以同时发生，
       * 两件事都要如实说；否则用户只会看到「列表没刷新」，永远不知道有老师被忽略。
       * 有冲突时留在核对页，`committed: true` 已经保证不会再点一次导入。
       */
      const conflictNotice =
        outcome.teacherConflicts.length > 0 ? describeTeacherConflicts(outcome.teacherConflicts) : null
      if (conflictNotice) setImportNotice(conflictNotice)

      if (outcome.readbackError) {
        setToast({
          text: `已经导入 ${outcome.schedules.length} 条课表，只是列表还没刷新。返回课程页重新进入即可看到；不要重复导入。`,
          tone: 'success',
        })
        return
      }
      const skipped = outcome.skippedDuplicates
      const reused = outcome.courses.filter((entry) => entry.reused).length
      setToast({
        text:
          `导入完成：新增 ${outcome.schedules.length} 条课表` +
          `${reused > 0 ? `，复用 ${reused} 门已有课程` : ''}` +
          `${skipped > 0 ? `，跳过 ${skipped} 条已存在的重复` : ''}。`,
        tone: 'success',
      })
      if (conflictNotice) return
      navigation.goBack()
    } catch (cause) {
      if (cause instanceof ValidationError) {
        const translated = repositoryErrorsToRowKeys(rows, cause.fields)
        setErrors(translated.byRowId)
        setFormError(
          translated.rowNumbers.length > 0
            ? `${cause.message} 需要修改第 ${translated.rowNumbers.join('、')} 行（错误已经标在对应字段上）。`
            : cause.message,
        )
      } else {
        setFormError(cause instanceof Error ? cause.message : '导入失败，本次没有写入任何数据。')
      }
      // 失败时**保留**用户改好的内容，不清空、不返回。
    } finally {
      setImporting(false)
    }
  }, [calibration?.semesterStartMonday, committed, importing, included, navigation, needingFix, payload.attemptId, payload.resultId, rows, store])

  const currentMonday = calibration?.semesterStartMonday ?? null
  /** 只有真的需要教学周范围（填了起止周）时，校准才是硬前提。 */
  const needsCalibration = included.some((row) => row.startWeek.trim().length > 0 && row.endWeek.trim().length > 0)
  /**
   * 按**课程名归一化**统计「这次到底涉及几门课」。
   *
   * 用归一化统计的原因：同一门课在不同格子里可能被识别成 `大学物理(B-2)` 与 `大学物理B-2`
   * （括号被拆行丢掉）。导入时仓库层会把它们合并成一门课，界面上的数字必须和导入结果一致，
   * 否则用户会以为「怎么少了一门」。合并只做排版/标点层面的归并，不会把 `C++` 和 `C` 并掉。
   */
  const includedCourses = useMemo(() => {
    const groups = new Map<string, PhotoImportRow[]>()
    for (const row of included) {
      const key = normalizeCourseNameForCompare(row.name)
      if (!key) continue
      const list = groups.get(key)
      if (list) list.push(row)
      else groups.set(key, [row])
    }
    return groups
  }, [included])
  const mergedGroups = [...includedCourses.values()].filter((group) => group.length > 1)

  return (
    <>
      <ScreenScaffold
        title="核对识别结果"
        subtitle={`共 ${rows.length} 条候选，已勾选 ${included.length} 条${needingFix > 0 ? `，其中 ${needingFix} 条待补充` : ''}`}
      >
        {formError ? (
          <View style={styles.formError} accessibilityRole="alert">
            <Text style={styles.formErrorText}>{formError}</Text>
          </View>
        ) : null}
        {importNotice ? (
          <View style={styles.conflictNotice} accessibilityRole="alert">
            <Text style={styles.conflictNoticeText}>{importNotice}</Text>
          </View>
        ) : null}

        <SectionCard title="导入范围" subtitle="导入会把勾选的行一次性写进这台手机（单事务）">
          <Text style={styles.line}>
            学期第一周周一：{currentMonday ?? '尚未校准（本次导入的教学周将不带学期起点）'}
          </Text>
          <Text style={styles.line}>今天：{summary.todayLine}{summary.currentWeek === null ? '' : ` · 第 ${summary.currentWeek} 教学周`}</Text>
          <Text style={styles.line}>
            这次会导入 {included.length} 条课表，涉及 {includedCourses.size} 门课
            {mergedGroups.length > 0 ? `（其中 ${mergedGroups.length} 门在图上出现了多段）` : ''}。
          </Text>
          {mergedGroups.length > 0 ? (
            <Text style={styles.note}>
              识别出的同名课程会合并成同一门课，例如：
              {mergedGroups
                .slice(0, 3)
                .map((group) => group.map((row) => row.name).join(' / '))
                .join('；')}
              。如果它们其实是不同的课，请改掉其中一行的课程名称或代码。
            </Text>
          ) : null}
          {/* 范围 vs 快照：逐行看真实证据，分别说清楚，绝不把 1–16 说成「没有显示教学周」。 */}
          {weekEvidence.hasRange ? (
            <Text style={styles.highlight}>
              这张图给的是**教学周范围**：{weekEvidence.ranges.map((text) => `第 ${text} 周`).join('、')}
              {weekEvidence.ranges.length >= 3 ? ' 等' : ''}。识别到的行已按原样填入这段范围，
              **不是**整学期每周重复，也不会被压缩成某一周。
            </Text>
          ) : null}
          {weekEvidence.hasSnapshot ? (
            <Text style={styles.highlight}>
              这张图是**某一周的快照**（图上显示：第 {weekEvidence.snapshots.map((week) => `${week}`).join('、')} 周）：
              识别到的行按那一周填入（只在那一周出现），不是整学期每周重复。
            </Text>
          ) : null}
          {!weekEvidence.hasRange && !weekEvidence.hasSnapshot ? (
            <Text style={styles.note}>
              这张图没有显示教学周：识别到的行默认按「每周」处理；如果实际有周次范围，请逐行填写。
            </Text>
          ) : null}
          {weekFromImage !== null ? (
            <Text style={styles.note}>整张图上标注的周次：第 {weekFromImage} 周。</Text>
          ) : null}
          {serialConflicts.size > 0 ? (
            <Text style={styles.warn} accessibilityRole="alert">
              有同名课程但**选课序号不同**（例如
              {[...new Set([...serialConflicts.values()].flat())].slice(0, 3).join(' / ')}）：
              这些是**不同的课**，导入时会各自保留，不会合并成一门。请不要当成重复删掉。
            </Text>
          ) : null}
          {teacherConflicts.size > 0 ? (
            <Text style={styles.warn} accessibilityRole="alert">
              同一门课识别出了不同的老师（
              {[...new Set([...teacherConflicts.values()].flat())].slice(0, 3).join(' / ')}）：
              每门课只会保留先写入的那一位老师，其它老师不会写进课程记录。
              先把同一门课的老师改成一致，或者确认它们其实是两门课（用课程名或选课序号区分）。
            </Text>
          ) : null}
          {!currentMonday && needsCalibration ? (
            <Text style={styles.warn} accessibilityRole="alert">
              这些行填了起止教学周，但还没有校准学期第一周周一，导入会被拒绝。
              点下面「去设置教学周」按今天实际是第几周校准一次即可。
            </Text>
          ) : null}
          {!currentMonday && needsCalibration ? (
            <AppButton
              label="去设置教学周"
              onPress={() => navigation.navigate('TeachingWeek')}
              variant="secondary"
              compact
              disabled={importing || committed}
              style={styles.gap}
              accessibilityLabel="打开教学周设置"
            />
          ) : null}
          {included.some((row) => row.selectionSerial.trim().length > 0) ? (
            <Text style={styles.note}>
              截图里的**选课序号**（例如 9913000172.08）已经逐行读出来，显示在每行的「选课序号」里：
              导入后可以在课程详情里看到，用来区分同名但其实是两门不同的课。
            </Text>
          ) : null}
          <View style={styles.bulkRow}>
            <AppButton
              label="全部勾选"
              onPress={() => setAllIncluded(true)}
              variant="secondary"
              compact
              disabled={importing || committed}
            />
            <AppButton
              label="全部取消"
              onPress={() => setAllIncluded(false)}
              variant="ghost"
              compact
              disabled={importing || committed}
            />
          </View>
        </SectionCard>

        {rows.map((row) => {
          const rowErrors = Object.fromEntries(
            Object.entries(errors)
              .filter(([key]) => key.startsWith(`${row.id}:`))
              .map(([key, value]) => [key.slice(row.id.length + 1), value]),
          )
          const issues = validateRow(row)
          const multipleSameName = rows.filter((other) => other.name.trim() === row.name.trim() && row.name.trim()).length > 1
          return (
            <SectionCard
              key={row.id}
              title={`第 ${row.rowNumber} 行${row.include ? '' : '（不导入）'}`}
              subtitle={describeRow(row)}
            >
              <View style={styles.badgeRow}>
                <Pressable
                  onPress={() => toggleInclude(row.id)}
                  disabled={importing || committed}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: row.include, disabled: importing || committed }}
                  accessibilityLabel={`第 ${row.rowNumber} 行${row.include ? '已勾选' : '未勾选'}`}
                  style={({ pressed }) => [
                    styles.includeChip,
                    row.include && styles.includeChipOn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.includeLabel, row.include && styles.includeLabelOn]}>
                    {row.include ? '✓ 导入这一行' : '○ 不导入'}
                  </Text>
                </Pressable>
                {row.edited ? <Badge text="已手动修改" tone="muted" /> : null}
                {multipleSameName ? <Badge text="同名课程多段" tone="muted" /> : null}
                {serialConflicts.has(row.id) ? <Badge text="同名但选课序号不同" tone="warn" /> : null}
                {teacherConflicts.has(row.id) ? <Badge text="同名但老师不同" tone="warn" /> : null}
                {row.weekScope === 'range' ? <Badge text="图片给的是范围" tone="muted" /> : null}
                {row.weekScope === 'snapshot' ? <Badge text="图片是某一周快照" tone="muted" /> : null}
                {issues.length > 0 ? <Badge text={`待补充 ${issues.length} 项`} tone="warn" /> : null}
              </View>

              {/* 周次依据分开说：范围行说范围，快照行说那一周，没有周次就直说没有。 */}
              {row.weekScope === 'range' && hasWeekScope(row) ? (
                <Text style={styles.note}>
                  来自图片：{describeWeekRange(row)} 这个**范围**（图上给的是起止周，不是单独某一周）。
                </Text>
              ) : row.weekScope === 'snapshot' && row.weekFromImage !== null ? (
                <Text style={styles.note}>来自图片：第 {row.weekFromImage} 周（图上只有这一周）。</Text>
              ) : (
                <Text style={styles.note}>这张图上这一行没有周次信息：留空 = 每周都上。</Text>
              )}
              {row.selectionSerial.trim() ? (
                <Text style={styles.note}>选课序号（图上括号里的数字）：{row.selectionSerial.trim()}</Text>
              ) : null}
              {row.warnings.length > 0 ? (
                <View style={styles.warningBox}>
                  {row.warnings.slice(0, 3).map((warning) => (
                    <Text key={warning} style={styles.warningText}>
                      · {warning}
                    </Text>
                  ))}
                </View>
              ) : null}

              <AppTextField
                label="课程名称"
                required
                value={row.name}
                onChangeText={(text) => patchRow(row.id, { name: text })}
                error={rowErrors.name ?? null}
                editable={!importing && !committed}
                maxLength={128}
                accessibilityLabel={`第 ${row.rowNumber} 行课程名称`}
              />
              {/*
                课程代码**不在核对页出现**：截图里通常没有代码，它是 App 内部用来匹配 / 去重的字段，
                用户不需要看懂、也不需要输入。每行的代码原样带下去（同名课程导入时复用已有代码）。
              */}
              <AppTextField
                label="选课序号（图上课程名后面括号里的数字）"
                value={row.selectionSerial}
                onChangeText={(text) => patchRow(row.id, { selectionSerial: text })}
                placeholder="例如 9913000172.08（图上没有就留空）"
                hint={
                  '这是学校选课系统的序号，用来区分「同名但其实是两门课」的情况；留空不会编一个。' +
                  '导入后可以在课程详情里看到。'
                }
                editable={!importing && !committed}
                maxLength={40}
                autoCorrect={false}
                accessibilityLabel={`第 ${row.rowNumber} 行选课序号`}
              />

              {/*
                老师姓名：图上识别出来的原样带出来，用户可以改。
                留空 = 图上没有 / 用户不想填，不会凭空编一个；
                导入后写进这门课的「老师姓名」，在课程详情与列表里都能看到。
              */}
              <AppTextField
                label="老师姓名"
                value={row.teacher}
                onChangeText={(text) => patchRow(row.id, { teacher: text })}
                placeholder="例如 张三（图上没有就留空）"
                hint={
                  '图上识别到的老师会填在这里，可以改；留空不会编一个。' +
                  '同一门课的多段记录若出现不同的老师，导入时只会保留先写入的那一位，并会明确提醒你。'
                }
                // 仓库层的 `row:<行号>:instructor` 与行内的长度预校验都报在这个字段上，
                // 让超长的识别结果当场可见、可改，而不是只在导入时给一句笼统的失败。
                error={rowErrors.instructor ?? null}
                editable={!importing && !committed}
                maxLength={64}
                autoCorrect={false}
                accessibilityLabel={`第 ${row.rowNumber} 行老师姓名`}
              />

              <Text style={styles.fieldLabel}>星期 *</Text>
              <View style={styles.weekdayRow}>
                {weekdayOptions.map((option) => {
                  const selected = row.weekday === String(option.value)
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => patchRow(row.id, { weekday: String(option.value) })}
                      disabled={importing || committed}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled: importing || committed }}
                      accessibilityLabel={`第 ${row.rowNumber} 行星期${option.label}`}
                      style={({ pressed }) => [styles.weekdayChip, selected && styles.weekdayChipOn, pressed && styles.pressed]}
                    >
                      <Text style={[styles.weekdayLabel, selected && styles.weekdayLabelOn]}>{option.label}</Text>
                    </Pressable>
                  )
                })}
              </View>
              {rowErrors.weekday ? <Text style={styles.fieldError}>{rowErrors.weekday}</Text> : null}

              <TimeWheelField
                label="开始时间"
                required
                value={row.startTime}
                onChange={(value) => patchRow(row.id, { startTime: value })}
                placeholder="选择开始时间"
                error={rowErrors.startTime ?? null}
                hint="点按后用 24 小时制滚轮选择，仍然可以逐分钟调整。"
                disabled={importing || committed}
                identityKey={`photo-row:${row.id}`}
                accessibilityLabel={`第 ${row.rowNumber} 行开始时间`}
                testID={`photo-row-${row.id}-start-time`}
              />
              <TimeWheelField
                label="结束时间"
                required
                value={row.endTime}
                onChange={(value) => patchRow(row.id, { endTime: value })}
                placeholder="选择结束时间"
                error={rowErrors.endTime ?? null}
                hint="结束时间必须晚于开始时间；原有保存校验不变。"
                disabled={importing || committed}
                identityKey={`photo-row:${row.id}`}
                accessibilityLabel={`第 ${row.rowNumber} 行结束时间`}
                testID={`photo-row-${row.id}-end-time`}
              />
              <AppTextField
                label="上课地点"
                value={row.location}
                onChangeText={(text) => patchRow(row.id, { location: text })}
                placeholder="例如 教三 305"
                error={rowErrors.location ?? null}
                editable={!importing && !committed}
                maxLength={128}
                accessibilityLabel={`第 ${row.rowNumber} 行上课地点`}
              />
              <AppTextField
                label="起始教学周"
                value={row.startWeek}
                onChangeText={(text) => patchRow(row.id, { startWeek: text })}
                placeholder="留空 = 每周都上"
                keyboardType="number-pad"
                maxLength={2}
                error={rowErrors.weekRange ?? null}
                editable={!importing && !committed}
                accessibilityLabel={`第 ${row.rowNumber} 行起始教学周`}
              />
              <AppTextField
                label="结束教学周"
                value={row.endWeek}
                onChangeText={(text) => patchRow(row.id, { endWeek: text })}
                placeholder="留空 = 每周都上"
                keyboardType="number-pad"
                maxLength={2}
                editable={!importing && !committed}
                accessibilityLabel={`第 ${row.rowNumber} 行结束教学周`}
              />
              <OptionGroup
                label="周次规律"
                options={WEEK_PATTERN_OPTIONS}
                value={row.weekPattern}
                onChange={(value: WeekPatternValue) => patchRow(row.id, { weekPattern: value })}
                disabled={importing || committed}
              />
              {row.weekFromImage !== null && !row.startWeek.trim() && !row.endWeek.trim() ? (
                <Pressable
                  onPress={() =>
                    patchRow(row.id, { confirmedBroadenToEveryWeek: !row.confirmedBroadenToEveryWeek })
                  }
                  disabled={importing || committed}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: row.confirmedBroadenToEveryWeek, disabled: importing || committed }}
                  accessibilityLabel={`第 ${row.rowNumber} 行确认改成每周都上`}
                  style={({ pressed }) => [
                    styles.broadenRow,
                    row.confirmedBroadenToEveryWeek && styles.broadenRowOn,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.broadenText}>
                    {row.confirmedBroadenToEveryWeek ? '☑' : '☐'} 确认改成「整学期每周都上」
                    （原本是第 {row.weekFromImage} 周，清空周次会扩大范围）
                  </Text>
                </Pressable>
              ) : null}
              {row.rawText ? <Text style={styles.rawText}>识别原文：{row.rawText}</Text> : null}
            </SectionCard>
          )
        })}

        <AppButton
          label={
            committed
              ? '已经导入（不要重复点）'
              : importing
                ? '正在导入…'
                : `导入 ${included.length} 条课表`
          }
          onPress={() => void onImport()}
          loading={importing}
          disabled={importing || committed || included.length === 0}
          accessibilityLabel="导入勾选的课表"
        />
        <AppButton
          label="放弃这次导入"
          onPress={() => setConfirmingDiscard(true)}
          variant="secondary"
          disabled={importing}
          style={styles.gap}
        />
      </ScreenScaffold>

      <ConfirmDialog
        visible={confirmingDiscard}
        title="放弃这次导入？"
        details={[
          '识别结果和你刚才的修改都不会保存。',
          '数据库没有被写过任何东西（导入只在点「导入」时发生）。',
          '可以重新拍/选一张图再来一次。',
        ]}
        confirmLabel="放弃"
        danger
        onConfirm={() => {
          setConfirmingDiscard(false)
          navigation.goBack()
        }}
        onCancel={() => setConfirmingDiscard(false)}
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
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  formErrorText: { ...typography.bodySoft, color: colors.clayDark },
  conflictNotice: {
    backgroundColor: colors.warnSoft,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  conflictNoticeText: { ...typography.bodySoft, color: colors.warn },
  line: { ...typography.bodySoft, marginTop: spacing.xs },
  note: { ...typography.caption, marginTop: spacing.sm },
  warn: { ...typography.caption, color: colors.warn, marginTop: spacing.sm },
  highlight: { ...typography.caption, color: colors.primaryDark, marginTop: spacing.sm, fontWeight: '600' },
  bulkRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap', marginBottom: spacing.sm },
  includeChip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  includeChipOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  includeLabel: { ...typography.bodySoft },
  includeLabelOn: { color: colors.primaryDark, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  warningBox: { marginBottom: spacing.sm },
  warningText: { ...typography.caption, color: colors.warn },
  fieldLabel: { ...typography.label, marginBottom: spacing.xs },
  fieldError: { ...typography.caption, color: colors.clay, marginTop: spacing.xs },
  weekdayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  weekdayChip: {
    minWidth: 56,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
  },
  weekdayChipOn: { backgroundColor: colors.primary, borderColor: colors.primaryDark },
  weekdayLabel: { ...typography.bodySoft, color: colors.textSoft, fontWeight: '600' },
  weekdayLabelOn: { color: colors.white },
  rawText: { ...typography.caption, marginTop: spacing.sm, color: colors.textMuted },
  broadenRow: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.warnSoft,
    marginBottom: spacing.md,
  },
  broadenRowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  broadenText: { ...typography.caption, color: colors.text },
  gap: { marginTop: spacing.md },
})
