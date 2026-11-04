/**
 * 通知点击的**本机诊断**（只在本进程内存里，不落盘、不发送）。
 *
 * 目标：真机上「收到了通知，但点了没打开」时，用户 / 复核者能在现有的
 * 「提醒设置」页和 banner 里看到最后一跳到底走到哪一步，而不是只能猜。
 *
 * 严格边界：
 * - 只记录状态、原因码、任务编号与目标路由名；
 * - **不记录**通知标题 / 正文 / 原始 payload / 通知文本 / 凭据；
 * - 不调用任何第三方、不联网、不写 SQLite。
 */

import { useSyncExternalStore } from 'react'

import type { TaskReminderNotificationTapEvent } from './taskReminderNotificationRouter'

/** 用户报告问题时需要能确认手机跑的是不是这一版。 */
export const NOTIFICATION_NAVIGATION_BUILD = 'phonefix-20261021-1'

export type NotificationDiagnosticOutcome =
  | 'none'
  | 'received'
  | 'rejected'
  | 'recognized'
  | 'deferred'
  | 'opened'
  | 'missing'
  | 'deduped'
  | 'failed'

export type NotificationDiagnosticReceipt = 'not-attempted' | 'not-needed' | 'stored' | 'failed'
export type NotificationDiagnosticListener = 'not-started' | 'listening' | 'unavailable'
export type NotificationDiagnosticColdRead = 'not-run' | 'ok' | 'empty' | 'failed'
export type NotificationDiagnosticSource = 'listener' | 'cold'

export interface NotificationDiagnosticSnapshot {
  build: string
  listener: NotificationDiagnosticListener
  coldRead: NotificationDiagnosticColdRead
  lastSource: NotificationDiagnosticSource | null
  lastAt: string | null
  outcome: NotificationDiagnosticOutcome
  reason: string | null
  taskId: number | null
  test: boolean | null
  editing: boolean | null
  editingRoute: string | null
  navigationReady: boolean | null
  target: string | null
  receipt: NotificationDiagnosticReceipt
}

const INITIAL: NotificationDiagnosticSnapshot = {
  build: NOTIFICATION_NAVIGATION_BUILD,
  listener: 'not-started',
  coldRead: 'not-run',
  lastSource: null,
  lastAt: null,
  outcome: 'none',
  reason: null,
  taskId: null,
  test: null,
  editing: null,
  editingRoute: null,
  navigationReady: null,
  target: null,
  receipt: 'not-attempted',
}

let snapshot: NotificationDiagnosticSnapshot = INITIAL
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 诊断订阅者的异常不能影响通知路由。
    }
  }
}

export function updateNotificationDiagnostic(
  patch: Partial<Omit<NotificationDiagnosticSnapshot, 'build'>>,
): void {
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
    if (snapshot[key] !== patch[key]) {
      changed = true
      break
    }
  }
  if (!changed) return
  snapshot = { ...snapshot, ...patch }
  notify()
}

export function getNotificationDiagnosticSnapshot(): NotificationDiagnosticSnapshot {
  return snapshot
}

export function subscribeNotificationDiagnostics(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** UI 里的响应式读取；没有事件时也显示构建标记。 */
export function useNotificationNavigationDiagnostics(): NotificationDiagnosticSnapshot {
  return useSyncExternalStore(
    subscribeNotificationDiagnostics,
    getNotificationDiagnosticSnapshot,
    getNotificationDiagnosticSnapshot,
  )
}

function targetLabel(taskId: number): string {
  return `任务 → 任务详情（任务 #${taskId}）`
}

/**
 * 把 controller 的结构化事件写进诊断快照。
 *
 * 注意：事件里没有通知标题 / 正文 / 原始 payload；这里也不会去读它们。
 */
export function applyNotificationTapEvent(event: TaskReminderNotificationTapEvent): void {
  switch (event.stage) {
    case 'received':
      updateNotificationDiagnostic({
        lastSource: event.source,
        lastAt: new Date().toISOString(),
        outcome: 'received',
        reason: null,
        taskId: null,
        test: null,
        target: null,
        receipt: 'not-attempted',
      })
      return
    case 'rejected':
      updateNotificationDiagnostic({
        lastSource: event.source,
        lastAt: new Date().toISOString(),
        outcome: 'rejected',
        reason: event.reason,
        taskId: null,
        test: null,
        target: null,
      })
      return
    case 'recognized':
      updateNotificationDiagnostic({
        lastSource: event.source,
        lastAt: new Date().toISOString(),
        outcome: 'recognized',
        reason: null,
        taskId: event.taskId,
        test: event.test,
      })
      return
    case 'deferred':
      updateNotificationDiagnostic({
        outcome: 'deferred',
        taskId: event.taskId,
        editing: event.editing,
        navigationReady: event.navigationReady,
        target: targetLabel(event.taskId),
      })
      return
    case 'opened':
      updateNotificationDiagnostic({
        outcome: 'opened',
        taskId: event.taskId,
        target: targetLabel(event.taskId),
        receipt: 'not-attempted',
      })
      return
    case 'missing':
      updateNotificationDiagnostic({ outcome: 'missing', taskId: event.taskId, target: null })
      return
    case 'deduped':
      updateNotificationDiagnostic({ outcome: 'deduped', taskId: event.taskId, reason: event.reason })
      return
    case 'failed':
      updateNotificationDiagnostic({
        outcome: 'failed',
        taskId: event.taskId,
        reason: event.reason,
        target: event.taskId === null ? null : targetLabel(event.taskId),
      })
      return
    case 'receipt':
      updateNotificationDiagnostic({
        receipt: event.ok ? (event.stored ? 'stored' : 'not-needed') : 'failed',
      })
      return
    case 'listener':
      updateNotificationDiagnostic({
        listener:
          event.state === 'registered' ? 'listening' : event.state === 'failed' ? 'unavailable' : 'not-started',
      })
      return
    case 'cold-read':
      updateNotificationDiagnostic({ coldRead: event.state })
      return
    default:
      return
  }
}

/** 当前阻塞页 / 是否阻塞；由 hook 在每次导航状态变化时更新。 */
export function updateNotificationDiagnosticEditing(
  editing: boolean,
  editingRoute: string | null,
): void {
  updateNotificationDiagnostic({
    editing,
    editingRoute: editing ? editingRoute : null,
  })
}

const ROUTE_LABELS: Record<string, string> = {
  TaskList: '任务列表',
  TaskDetail: '任务详情',
  TaskForm: '任务表单',
  CourseForm: '课程表单',
  ScheduleForm: '课表表单',
  NoticeImport: '通知转待办',
  NoticePhoto: '截图转待办',
  BatchNotice: '批量识别通知',
  PhotoReview: '核对并导入',
  TaskSteps: '任务步骤',
  TaskReminder: '提醒设置',
  TodayPlan: '今日学习计划',
  ExamRevision: '复习安排',
  Pressure: 'DDL 压力分析',
  Today: '今天',
  CalendarMonth: '日历',
  CalendarDay: '日历某一天',
}

/** 内部路由名 → 用户看得懂的页面名；未知路由不把英文名直接抛给用户。 */
export function notificationDiagnosticBlockedPageLabel(routeName: string | null): string | null {
  if (!routeName) return null
  return ROUTE_LABELS[routeName] ?? '当前页面'
}

const REASON_LABELS: Record<string, string> = {
  'non-default-action': '不是系统默认点击动作',
  'not-owned': '不是本应用的任务提醒，或载荷没有严格通过校验',
  'bad-shape': '通知数据结构不完整',
  'duplicate-delivery': '同一投递已经处理过',
  'already-consumed': '同一投递在重启前已经打开过',
  'editing': '当前页面有未保存内容，先暂缓',
  'navigation-not-ready': '导航还没有准备好',
  'lookup-failed': '读取本机任务失败',
  'navigation-failed': '导航没有真正打开任务详情',
  'receipt-failed': '点击记录没有保存',
  'native-unavailable': '本机通知模块不可用',
  'cold-read-failed': '读取冷启动点击失败',
}

export function notificationDiagnosticReasonLabel(reason: string | null): string | null {
  if (!reason) return null
  return REASON_LABELS[reason] ?? reason
}

export function notificationDiagnosticOutcomeLabel(value: NotificationDiagnosticSnapshot): string {
  switch (value.outcome) {
    case 'none':
      return '还没有收到本机通知点击'
    case 'received':
      return '已收到点击，正在识别'
    case 'rejected':
      return `已忽略（${notificationDiagnosticReasonLabel(value.reason) ?? '未通过校验'}）`
    case 'recognized':
      return `已识别为提醒${value.taskId === null ? '' : `（任务 #${value.taskId}）`}`
    case 'deferred':
      return value.editing
        ? '已识别；当前页面有未保存内容，暂缓打开'
        : '已识别；等待导航就绪'
    case 'opened':
      return `已打开任务详情${value.taskId === null ? '' : `（任务 #${value.taskId}）`}`
    case 'missing':
      return `已识别；任务${value.taskId === null ? '' : ` #${value.taskId}`} 已不在本机`
    case 'deduped':
      return '同一投递已经处理过'
    case 'failed':
      return `打开失败：${notificationDiagnosticReasonLabel(value.reason) ?? '未知原因'}`
    default:
      return '未知状态'
  }
}

export function notificationDiagnosticTimestampLabel(iso: string | null): string | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return null
  try {
    return new Date(parsed).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return iso.slice(11, 19)
  }
}

/**
 * 「提醒设置」页默认显示的**一行**摘要：只讲用户看得懂的状态，并带构建标记。
 * 详细原因 / 目标 / 回执放在展开区。
 */
export function notificationDiagnosticSummary(value: NotificationDiagnosticSnapshot): string {
  const build = `构建 ${value.build}`
  switch (value.outcome) {
    case 'none':
      return `还没有收到本机点击 · ${build}`
    case 'received':
      return `已收到点击，正在识别 · ${build}`
    case 'rejected':
      return `已忽略：${notificationDiagnosticReasonLabel(value.reason) ?? '未通过校验'} · ${build}`
    case 'recognized':
      return `已识别为任务提醒 · ${build}`
    case 'deferred': {
      if (!value.editing) return `已识别，等待页面就绪 · ${build}`
      const page = notificationDiagnosticBlockedPageLabel(value.editingRoute) ?? '当前页面'
      return `已识别，但「${page}」有未保存内容，稍后打开 · ${build}`
    }
    case 'opened':
      return `已打开任务详情${value.taskId === null ? '' : `（任务 #${value.taskId}）`} · ${build}`
    case 'missing':
      return `任务${value.taskId === null ? '' : ` #${value.taskId}`} 已不在本机 · ${build}`
    case 'deduped':
      return `同一投递已经处理过 · ${build}`
    case 'failed':
      return `打开失败：${notificationDiagnosticReasonLabel(value.reason) ?? '未知原因'} · ${build}`
    default:
      return `状态未知 · ${build}`
  }
}

/**
 * 给「提醒设置」页用的短行；不包含任何通知正文。
 * 顺序固定，方便用户逐行报告。
 */
export function notificationDiagnosticLines(value: NotificationDiagnosticSnapshot): string[] {
  const lines = [`构建：${value.build}`]
  if (value.lastAt === null) {
    lines.push('最近点击：还没有收到本机通知点击')
  } else {
    const at = notificationDiagnosticTimestampLabel(value.lastAt)
    const source = value.lastSource === 'cold' ? '冷启动' : '运行中监听'
    lines.push(`最近点击：${at ? `${at} · ` : ''}${source}`)
    lines.push(`结果：${notificationDiagnosticOutcomeLabel(value)}`)
  }
  if (value.editingRoute) {
    const page = notificationDiagnosticBlockedPageLabel(value.editingRoute) ?? '当前页面'
    lines.push(`当前阻塞页：${page}${value.editing ? '（有未保存内容）' : '（无未保存内容）'}`)
  }
  if (value.target) lines.push(`导航目标：${value.target}`)
  if (value.receipt !== 'not-attempted') {
    const receipt =
      value.receipt === 'stored'
        ? '已保存'
        : value.receipt === 'not-needed'
          ? '无需保存（缺少展示时间）'
          : '保存失败'
    lines.push(`持久回执：${receipt}`)
  }
  lines.push(`本机通知模块：${listenerLabel(value.listener)} · 冷启动读取：${coldReadLabel(value.coldRead)}`)
  return lines
}

function listenerLabel(value: NotificationDiagnosticListener): string {
  switch (value) {
    case 'listening':
      return '监听中'
    case 'unavailable':
      return '不可用'
    default:
      return '未启动'
  }
}

function coldReadLabel(value: NotificationDiagnosticColdRead): string {
  switch (value) {
    case 'ok':
      return '成功'
    case 'empty':
      return '没有待处理点击'
    case 'failed':
      return '失败'
    default:
      return '未读取'
  }
}

/** 仅供测试清理模块级状态。 */
export function resetNotificationDiagnosticsForTests(): void {
  snapshot = INITIAL
  notify()
}
