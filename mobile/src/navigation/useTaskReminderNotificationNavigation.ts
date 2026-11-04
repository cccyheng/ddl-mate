/**
 * 原生任务提醒点击接线：`expo-notifications` response → 任务栈详情。
 *
 * 只在原生运行时动态 import，因此 Web / Node / 测试不会加载原生模块。
 * 严格解析、持久回执、编辑暂缓、失败重试都在 `taskReminderNotificationRouter`，
 * 本 hook 只负责接真实通知 API、store 的只读重查 / 回执和 NavigationContainer。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native'

import { useAppStore } from '../store/AppStore'
import type { RootTabParamList } from './types'
import {
  createTaskReminderNotificationRouter,
  currentRouteBlocksNotificationOpen,
  taskStackBlockingRouteName,
  type TaskReminderNotificationRouter,
  type TaskReminderNotificationState,
  type TaskReminderNotificationsApi,
} from './taskReminderNotificationRouter'
import {
  isNavigationDraftDirty,
  shouldDismissNotificationController,
  subscribeNavigationDraftChanges,
} from './navigationDraftGuard'
import {
  applyNotificationTapEvent,
  updateNotificationDiagnostic,
  updateNotificationDiagnosticEditing,
} from './notificationNavigationDiagnostics'
import { waitForTaskDetailRoute } from './taskReminderNavigationTarget'

const IDLE_STATE: TaskReminderNotificationState = {
  notice: null,
  editing: false,
  navigationReady: false,
}

async function loadNotifications(): Promise<TaskReminderNotificationsApi> {
  const Notifications = await import('expo-notifications')
  return {
    DEFAULT_ACTION_IDENTIFIER: Notifications.DEFAULT_ACTION_IDENTIFIER,
    getLastNotificationResponse: () => Notifications.getLastNotificationResponse(),
    addNotificationResponseReceivedListener: (listener) =>
      Notifications.addNotificationResponseReceivedListener((response) => listener(response)),
  }
}

export interface TaskReminderNotificationNavigation {
  state: TaskReminderNotificationState
  retry: () => void
  dismiss: () => void
  openTaskList: () => void
}

/**
 * @param navigationRef 根 NavigationContainer 的 ref（带 `isReady()` / `getCurrentRoute()`）。
 * @param navigationReady `onReady` 之后才为 true；之前收到的点击只排队、不导航。
 */
export function useTaskReminderNotificationNavigation(
  navigationRef: NavigationContainerRefWithCurrent<RootTabParamList>,
  navigationReady: boolean,
): TaskReminderNotificationNavigation {
  const store = useAppStore()
  /** store 在任务刷新后会换引用；用 ref 避免每次刷新都重建通知控制器 / 重注册监听。 */
  const storeRef = useRef(store)
  storeRef.current = store
  const backupGate = store.backup.gate
  const restoreEpoch = store.restoreEpoch

  const [controller, setController] = useState<TaskReminderNotificationRouter | null>(null)
  const [state, setState] = useState<TaskReminderNotificationState>(IDLE_STATE)

  /**
   * 通知的目标是 Tasks 栈。用户可能正在别的标签，而隐藏的 Tasks 栈里还压着
   * TaskForm / TaskDetail 等页面；只看当前聚焦路由会漏掉它们。
   *
   * 但 `TaskDetail` / `TaskReminder` 只在**真的登记了草稿**时才算阻塞：
   * 干净详情页 / 刚点完测试提醒的提醒页不应被静默挡下。
   */
  const editingContext = useCallback((): boolean => {
    if (!navigationRef.isReady()) return false
    try {
      const focused = navigationRef.getCurrentRoute()
      const root = navigationRef.getRootState()
      const focusedBlocks = currentRouteBlocksNotificationOpen(focused, isNavigationDraftDirty)
      const hiddenBlocking = taskStackBlockingRouteName(root, isNavigationDraftDirty)
      const editing = focusedBlocks || hiddenBlocking !== null
      updateNotificationDiagnosticEditing(
        editing,
        focusedBlocks ? (focused?.name ?? null) : hiddenBlocking,
      )
      return editing
    } catch {
      // 状态尚不可读时保守当作「编辑中」：不抢跳，等下一次导航状态事件再判断。
      updateNotificationDiagnosticEditing(true, '导航状态不可读')
      return true
    }
  }, [navigationRef])

  useEffect(() => {
    const router = createTaskReminderNotificationRouter({
      loadNotifications,
      lookupTaskFresh: (taskId) => storeRef.current.getTaskFresh(taskId),
      receipts: {
        hasConsumed: (token) => storeRef.current.notificationReceipts.hasConsumed(token),
        recordConsumption: (receipt) => storeRef.current.notificationReceipts.recordConsumption(receipt),
      },
      navigateToTask: (taskId) => {
        if (!navigationRef.isReady()) throw new Error('导航还没有准备好。')
        /**
         * `initial: false`：冷启动直接点通知时，任务栈先按正常初始路由挂载（任务列表），
         * 再导航到详情，因此返回按钮有正常退路。只传正整数 taskId，不解析任意 URL。
         *
         * 导航调用本身不返回「是否被处理」；`waitForTaskDetailRoute` 会等根状态里真的
         * 出现目标任务详情。静默失败的导航会让 controller 显示可重试错误，而不是写回执。
         */
        navigationRef.navigate('Tasks', {
          screen: 'TaskDetail',
          params: { id: taskId },
          initial: false,
        })
        return waitForTaskDetailRoute(navigationRef, taskId)
      },
      navigateToTaskList: () => {
        if (!navigationRef.isReady()) throw new Error('导航还没有准备好。')
        navigationRef.navigate('Tasks', { screen: 'TaskList', initial: false })
      },
      isEditing: editingContext,
      isNavigationReady: () => navigationRef.isReady(),
      getNotificationGeneration: () => storeRef.current.getNotificationRouteGeneration(),
      onTapEvent: (event) => {
        applyNotificationTapEvent(event)
        if (event.stage === 'received') {
          updateNotificationDiagnostic({ listener: 'listening' })
        }
      },
    })

    setController(router)
    setState(router.getState())
    const unsubscribe = router.subscribe(() => setState(router.getState()))
    void router.start()
    return () => {
      unsubscribe()
      router.dispose()
    }
  }, [editingContext, navigationRef])

  useEffect(() => {
    if (controller && navigationReady) controller.markNavigationReady()
  }, [controller, navigationReady])

  /** 备份 / 恢复期间暂缓通知导航；结束后再交付（旧代次会被拒绝）。 */
  useEffect(() => {
    controller?.setBackupBusy(backupGate !== 'idle')
  }, [backupGate, controller])

  /**
   * 只在**真实的恢复代次变化**时清掉 controller 的旧 pending / retry / 在途点击。
   *
   * 初次的 `[controller, restoreEpoch]` effect 不能 dismiss：否则冷启动已经排队
   * 的有效点击会被创建 controller 的同一轮渲染清掉。
   * 真正的身份边界仍是通知载荷代次：恢复事务会把本机代次 +1，旧载荷在导航前
   * 的最后一次检查会被拒绝。
   */
  const previousRestoreEpochRef = useRef(restoreEpoch)
  useEffect(() => {
    const previous = previousRestoreEpochRef.current
    previousRestoreEpochRef.current = restoreEpoch
    if (!controller) return
    if (!shouldDismissNotificationController(previous, restoreEpoch)) return
    controller.dismiss()
  }, [controller, restoreEpoch])

  /**
   * 编辑路由的进入 / 离开由导航状态驱动：离开编辑页后控制器才会交付排队点击，
   * 不主动 pop、不派发返回动作，未保存草稿由各页面自己的 `usePreventRemove` 保护。
   *
   * 同时订阅「真实草稿」登记表：用户清空追加原文 / 关闭确认框后，即使没有发生
   * 导航事件，也会重新计算并交付排队点击。
   */
  useEffect(() => {
    if (!controller || !navigationReady) return
    const sync = () => controller.setEditing(editingContext())
    sync()
    const removeStateListener = navigationRef.addListener('state', sync)
    const removeDraftListener = subscribeNavigationDraftChanges(sync)
    return () => {
      removeStateListener()
      removeDraftListener()
    }
  }, [controller, editingContext, navigationReady, navigationRef])

  const retry = useCallback(() => {
    if (controller) void controller.retry()
  }, [controller])
  const dismiss = useCallback(() => controller?.dismiss(), [controller])
  const openTaskList = useCallback(() => {
    controller?.openTaskList()
  }, [controller])

  return { state, retry, dismiss, openTaskList }
}
