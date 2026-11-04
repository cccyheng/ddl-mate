/**
 * 任务截止提醒设置（原生界面）。
 *
 * 这一页只做一件事：让用户**显式**为一条任务选择「提前多久」并开启 / 关闭本机通知。
 * - 默认关闭；不会自动给任务打开提醒，也不会在启动时申请权限；
 * - 保存成功只代表「规则写进了本机」；页面会另读系统列表，区分「系统已排队」与
 *   「设置已保存，提醒尚未安排」；
 * - 关闭永远可用（即使任务的 DDL 已经失效 / 权限被拒）；
 * - 任务完成 / 取消 / 删除 / 改时间 / 改标题后的对账由中央服务处理，本页不写任务。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AppState, Linking, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'

import { isDateOnlyDeadline, shanghaiDeadlineLabel } from '../domain/datetime'
import {
  REMINDER_LEAD_OPTIONS,
  formatReminderMoment,
  reminderLeadLabel,
  reminderPermissionLabel,
  type ReminderLeadMinutes,
} from '../domain/taskReminder'
import type { SharedTaskRoutesWithReminders } from '../navigation/types'
import { useAppStore } from '../store/AppStore'
import { taskStatusLabels } from '../domain/types'
import { AppButton, Badge, EmptyState, ErrorState, LoadingState, OptionGroup, SectionCard } from '../ui/components'
import { Toast } from '../ui/dialog'
import { ScreenScaffold } from '../ui/ScreenScaffold'
import { colors, radius, spacing, typography } from '../ui/theme'
import { clearNavigationDraft, setNavigationDraftDirty } from '../navigation/navigationDraftGuard'
import {
  notificationDiagnosticLines,
  notificationDiagnosticSummary,
  useNotificationNavigationDiagnostics,
} from '../navigation/notificationNavigationDiagnostics'
import {
  createTaskReminderController,
  permissionScheduleNote,
  type ReminderNoticeTone,
  type TaskReminderControllerState,
} from './taskReminderController'

type Nav = NativeStackNavigationProp<SharedTaskRoutesWithReminders>
type Route = RouteProp<SharedTaskRoutesWithReminders, 'TaskReminder'>

const NOTICE_STYLE: Record<ReminderNoticeTone, { bg: string; border: string; title: string }> = {
  success: { bg: colors.primarySoft, border: colors.primary, title: colors.primaryDark },
  warning: { bg: colors.warnSoft, border: colors.warn, title: colors.warn },
  error: { bg: colors.claySoft, border: colors.clay, title: colors.clayDark },
  info: { bg: colors.surfaceSoft, border: colors.border, title: colors.textSoft },
}

function osStateText(state: TaskReminderControllerState): string {
  const inspection = state.inspection
  if (!inspection) return '正在读取系统通知状态…'
  if (inspection.osState === 'unknown') return '暂时读不到系统通知列表，无法确认是否排好；可以重试。'
  if (inspection.osState === 'queued') {
    return inspection.pending?.triggerAtMs
      ? `系统已排队：${formatReminderMoment(inspection.pending.triggerAtMs)}（北京时间）。`
      : '系统已排队。'
  }
  if (inspection.osState === 'stale') {
    return inspection.pendingReason ?? '系统里排着的提醒与当前任务不一致，重试对账会替换或取消它。'
  }
  if (inspection.osState === 'not-queued') {
    return inspection.pendingReason ?? '系统里还没有排这条提醒。'
  }
  return inspection.pendingReason ?? '提醒已关闭。'
}

function NoticeCard({ notice }: { notice: { tone: ReminderNoticeTone; text: string } }): React.ReactElement {
  const palette = NOTICE_STYLE[notice.tone]
  return (
    <View
      style={[styles.notice, { backgroundColor: palette.bg, borderColor: palette.border }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.noticeText, { color: palette.title }]}>{notice.text}</Text>
    </View>
  )
}

export function TaskReminderScreen(): React.ReactElement {
  const store = useAppStore()
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const taskId = route.params.id

  /** 方法本身通过 store 的 service ref 读最新服务，因此这里只取一次也安全。 */
  const apiRef = useRef(store.taskReminder)
  apiRef.current = store.taskReminder
  const depsRef = useRef<Parameters<typeof createTaskReminderController>[1] | null>(null)
  if (!depsRef.current) {
    depsRef.current = {
      inspect: (id) => apiRef.current.inspect(id),
      save: (input) => apiRef.current.save(input),
      test: (id) => apiRef.current.test(id),
      retry: (id) => apiRef.current.retry(id),
    }
  }
  /**
   * **按当前 route id 创建**控制器：同一页面实例的 params.id 变化时换一个控制器，
   * 旧控制器在 effect cleanup 里 dispose；StrictMode 的 setup → cleanup → setup
   * 通过 `activate()` 恢复同一个控制器，不重放任何写库或权限请求。
   */
  const controller = useMemo(
    () => createTaskReminderController(taskId, depsRef.current!),
    [taskId],
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const notificationDiagnostics = useNotificationNavigationDiagnostics()
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false)

  /**
   * 只有真的改了设置 / 正在保存时才算「有未保存内容」。
   * 刚从详情页进来、只点了「测试提醒」的干净提醒页不应该阻塞通知导航。
   */
  useEffect(() => {
    const sync = () => {
      const current = controller.getState()
      setNavigationDraftDirty(route.key, 'TaskReminder', current.dirty || current.busy)
    }
    sync()
    const unsubscribe = controller.subscribe(sync)
    return () => {
      unsubscribe()
      clearNavigationDraft(route.key)
    }
  }, [controller, route.key])

  useEffect(() => {
    controller.activate()
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return
      // 从系统设置返回 / 回到前台：只刷新权限与系统状态，不弹权限，也不覆盖脏草稿。
      void controller.refreshAfterForeground()
    })
    return () => {
      subscription.remove()
      controller.dispose()
    }
  }, [controller])

  useFocusEffect(
    useCallback(() => {
      void controller.load('refresh')
      return undefined
    }, [controller]),
  )

  const openPhoneSettings = useCallback(async () => {
    try {
      await Linking.openSettings()
    } catch (cause) {
      setSettingsMessage(
        `没能打开系统设置：${cause instanceof Error ? cause.message : String(cause)}。可以手动到手机的「设置 → 通知」里找到本应用。`,
      )
    }
  }, [])

  const locked = state.inspection?.intentState === 'corrupt' || state.inspection?.intentState === 'future'
  const busy = state.busy
  const draftTime =
    state.draftEnabled && state.draftEligibility?.eligible ? state.draftEligibility.triggerAtMs : null
  const savedEnabled = state.baselineEnabled
  const savedIntentEnabled = state.inspection?.intent?.enabled === true
  const showRetry =
    !state.dirty &&
    state.inspection !== null &&
    (state.inspection.osState === 'stale' ||
      state.inspection.osState === 'unknown' ||
      (savedIntentEnabled && state.inspection.osState !== 'queued'))
  const retryLabel = savedIntentEnabled
    ? '重试安排提醒'
    : state.inspection?.osState === 'unknown'
      ? '重试同步提醒'
      : '重新取消提醒'

  if (state.phase === 'loading' && !state.inspection) {
    return (
      <ScreenScaffold title="提醒设置">
        <LoadingState message="正在读取这条任务的提醒设置…" />
      </ScreenScaffold>
    )
  }

  if (state.loadError && !state.inspection) {
    return (
      <ScreenScaffold title="提醒设置">
        <ErrorState message={state.loadError} onRetry={() => void controller.load('initial')} retryLabel="重新读取" />
      </ScreenScaffold>
    )
  }

  if (!state.task) {
    return (
      <ScreenScaffold title="提醒设置">
        <EmptyState
          title="这条任务不在本机了"
          description="它可能已经被删除。返回任务列表可以继续；不会为已经删除的任务安排提醒。"
          actionLabel="返回"
          onAction={() => navigation.goBack()}
        />
      </ScreenScaffold>
    )
  }

  return (
    <>
      <ScreenScaffold title="提醒设置" subtitle="本机通知 · 默认关闭 · 不会自动替所有任务开启">
        {state.loadError ? <NoticeCard notice={{ tone: 'error', text: state.loadError }} /> : null}
        {locked ? (
          <NoticeCard
            notice={{
              tone: 'error',
              text:
                state.inspection?.readReason ??
                '本机保存的提醒设置读不出来，已停止修改，以免覆盖它。任务本身不受影响。',
            }}
          />
        ) : null}
        {state.notice ? <NoticeCard notice={state.notice} /> : null}

        <SectionCard title="这条任务">
          <Text style={styles.taskTitle}>{state.task.title}</Text>
          <Text style={styles.muted}>
            截止：{state.task.deadline ? shanghaiDeadlineLabel(state.task.deadline) : '没有设置截止时间'}
          </Text>
          {isDateOnlyDeadline(state.task.deadline) ? (
            <Text style={styles.muted}>
              这条任务只记到日期，没有具体时刻，所以不能安排定时提醒；编辑任务补上 HH:mm 后即可开启。
            </Text>
          ) : null}
          <Text style={styles.muted}>状态：{taskStatusLabels[state.task.status]}</Text>
        </SectionCard>

        <SectionCard
          title="提醒"
          subtitle="只能选一个提前量；只有你显式保存并开启后，才会交给手机安排"
        >
          <View style={styles.badgeRow}>
            <Badge text={savedEnabled ? '已保存：开启' : '已保存：关闭'} tone={savedEnabled ? 'primary' : 'muted'} />
            {state.dirty ? <Badge text="有未保存修改" tone="warn" /> : null}
            {locked ? <Badge text="停止修改" tone="clay" /> : null}
          </View>

          <Text style={styles.muted}>
            {savedEnabled
              ? `当前规则：${reminderLeadLabel(state.baselineLead)}。`
              : '当前规则：关闭。开启后才会在截止前提醒。'}
          </Text>

          <View style={styles.gap}>
            <AppButton
              label={state.draftEnabled ? '关闭提醒' : '开启提醒'}
              onPress={() => controller.setEnabled(!state.draftEnabled)}
              variant="secondary"
              disabled={busy || locked}
              accessibilityLabel={state.draftEnabled ? '关闭这条任务的提醒' : '开启这条任务的提醒'}
              accessibilityHint="只是编辑草稿，点保存后才会写入；关闭会同时尝试取消系统里已经排好的提醒"
            />
          </View>

          {state.draftEnabled ? (
            <>
              <View style={styles.gap}>
                <OptionGroup
                  label="提前多久提醒"
                  options={REMINDER_LEAD_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  value={state.draftLead}
                  onChange={(value: ReminderLeadMinutes) => controller.setLead(value)}
                  disabled={busy || locked}
                />
              </View>
              {draftTime !== null ? (
                <Text style={styles.calculated}>
                  将在 {formatReminderMoment(draftTime)} 提醒（北京时间）。
                </Text>
              ) : (
                <Text style={styles.warningText}>
                  {state.draftEligibility?.reason ?? '当前任务还不能启用提醒。'}
                </Text>
              )}
            </>
          ) : (
            <Text style={styles.muted}>
              关闭后，系统里本应用为这条任务排着的提醒会被尝试取消；取消失败会明确提示，不会假装已经取消。
            </Text>
          )}

          {savedEnabled && state.inspection && !state.inspection.eligibility.eligible ? (
            <Text style={styles.warningText}>
              已保存的规则当前不会生效：{state.inspection.eligibility.reason ?? '任务条件已变化。'} 你仍然可以关闭它。
            </Text>
          ) : null}

          <View style={styles.actions}>
            <AppButton
              label="保存提醒设置"
              onPress={() => void controller.save()}
              loading={state.busyAction === 'save'}
              disabled={
                busy ||
                locked ||
                !state.dirty ||
                state.needsReload ||
                (state.draftEnabled && !state.canEnable)
              }
              accessibilityLabel="保存这条任务的提醒设置"
              accessibilityHint="保存后还会检查系统是否真的排好了提醒"
            />
            <AppButton
              label={state.dirty || state.needsReload ? '载入最新（丢弃草稿）' : '载入最新设置'}
              onPress={() => void controller.reloadLatest()}
              variant="secondary"
              compact
              disabled={busy}
              style={styles.gap}
              accessibilityLabel="载入最新的提醒设置"
              accessibilityHint={
                state.dirty || state.needsReload
                  ? '这会丢弃当前未保存的草稿，采用本机最新的提醒设置'
                  : '重新读取这条任务的最新提醒设置'
              }
            />
          </View>
        </SectionCard>

        <SectionCard title="手机通知状态">
          <Text style={styles.value}>{reminderPermissionLabel(state.permission ?? state.inspection?.permission ?? {
            status: 'undetermined',
            canAskAgain: true,
            detail: null,
          })}</Text>
          <Text style={styles.muted}>
            {permissionScheduleNote(
              state.permission ??
                state.inspection?.permission ?? { status: 'undetermined', canAskAgain: true, detail: null },
            )}
          </Text>
          <Text style={styles.muted}>系统里的实际状态：{osStateText(state)}</Text>

          {showRetry ? (
            <View style={styles.gap}>
              <AppButton
                label={retryLabel}
                onPress={() => void controller.retry()}
                variant="secondary"
                compact
                loading={state.busyAction === 'retry'}
                disabled={busy}
                accessibilityLabel={
                  savedIntentEnabled ? '重新对账并尝试安排这条任务的提醒' : '重新对账并尝试取消这条任务的提醒'
                }
              />
            </View>
          ) : null}

          <View style={styles.actions}>
            <AppButton
              label="测试提醒（10 秒后）"
              onPress={() => void controller.test()}
              variant="secondary"
              compact
              loading={state.busyAction === 'test'}
              disabled={busy || locked}
              accessibilityLabel="安排一条十秒后的测试提醒"
              accessibilityHint="只在你按下时申请通知权限；测试提醒安排成功不代表已经确认送达"
            />
            <AppButton
              label="打开手机通知设置"
              onPress={() => void openPhoneSettings()}
              variant="ghost"
              compact
              accessibilityLabel="打开手机的通知设置"
            />
          </View>

          {state.testStatus ? (
            <Text
              style={[
                styles.testText,
                state.testStatus.tone === 'error'
                  ? styles.warningText
                  : state.testStatus.tone === 'success'
                    ? styles.calculated
                    : styles.muted,
              ]}
            >
              {state.testStatus.text}
            </Text>
          ) : null}

          <Text style={styles.footnote}>
            本地通知由手机系统负责送达。这里显示「系统已排队」只代表通知已经交给系统，不代表已经确认送达；
            真正是否弹出请以手机为准。
          </Text>
        </SectionCard>

        <SectionCard
          title="通知点击诊断"
          subtitle="只在本机内存里，不包含通知正文，也不会发送给任何人"
        >
          <Text style={styles.diagnostic}>{notificationDiagnosticSummary(notificationDiagnostics)}</Text>
          <AppButton
            label={diagnosticsExpanded ? '收起详情' : '展开详情'}
            onPress={() => setDiagnosticsExpanded((value) => !value)}
            variant="ghost"
            compact
            accessibilityLabel={diagnosticsExpanded ? '收起通知点击诊断详情' : '展开通知点击诊断详情'}
            accessibilityHint="详情只包含状态、页面名称和任务编号，不包含通知正文"
          />
          {diagnosticsExpanded ? (
            <>
              {notificationDiagnosticLines(notificationDiagnostics).map((line, index) => (
                <Text key={`${index}-${line}`} style={styles.diagnostic}>
                  {line}
                </Text>
              ))}
              <Text style={styles.footnote}>
                如果点了提醒却没有打开任务详情，把上面这行摘要、手机型号，以及是否用 Expo Go 一起告诉复核者即可。
              </Text>
            </>
          ) : null}
        </SectionCard>
      </ScreenScaffold>

      {settingsMessage ? <Toast text={settingsMessage} tone="error" /> : null}
    </>
  )
}

const styles = StyleSheet.create({
  taskTitle: { ...typography.section, marginBottom: spacing.xs },
  value: { ...typography.body },
  muted: { ...typography.caption, marginTop: spacing.xs },
  calculated: { ...typography.bodySoft, marginTop: spacing.sm, color: colors.primaryDark },
  warningText: { ...typography.bodySoft, marginTop: spacing.sm, color: colors.clayDark },
  testText: { ...typography.caption, marginTop: spacing.sm },
  diagnostic: { ...typography.caption, color: colors.text, marginTop: spacing.xs },
  footnote: { ...typography.caption, marginTop: spacing.md, color: colors.textMuted },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  gap: { marginTop: spacing.md },
  actions: { marginTop: spacing.lg, gap: spacing.sm },
  notice: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeText: { ...typography.bodySoft },
})
