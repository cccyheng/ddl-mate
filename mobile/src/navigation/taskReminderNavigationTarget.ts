/**
 * 通知点击的**导航落地确认**。
 *
 * `navigationRef.navigate(...)` 在 React Navigation 里不返回「有没有被处理」；
 * 如果嵌套目标因为状态 / 路由配置变化被静默忽略，旧实现会立刻写持久回执，造成
 * 「点了没打开，但以后也不再提示」的假成功。这里在导航后等待根状态里真的出现
 * 目标任务详情（或确认本来就已经在它上面），超时则抛错，让 controller 走可见重试，
 * 而不是写回执。
 *
 * 只读导航状态；不 pop、不 reset、不碰业务数据。
 */

export const TASK_REMINDER_NAVIGATION_CONFIRM_MS = 1_500

interface RouteLike {
  name?: unknown
  params?: unknown
}

export interface TaskDetailNavigationRefLike {
  getCurrentRoute: () => RouteLike | undefined
  addListener: (event: 'state', listener: () => void) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 当前聚焦路由是否就是目标任务的详情页。 */
export function isTaskDetailRouteFor(route: RouteLike | undefined, taskId: number): boolean {
  if (!route || route.name !== 'TaskDetail' || !isRecord(route.params)) return false
  return route.params.id === taskId
}

/**
 * 等待 `Tasks → TaskDetail(id)` 真正成为当前路由。
 *
 * - 已经在目标详情上：立即成功（同一任务的重复点击不制造无意义跳转）；
 * - 导航状态事件里出现目标：成功；
 * - 超时仍不是目标：reject，调用方不得写回执。
 */
export function waitForTaskDetailRoute(
  navigationRef: TaskDetailNavigationRefLike,
  taskId: number,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? TASK_REMINDER_NAVIGATION_CONFIRM_MS
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (unsubscribe) {
        try {
          unsubscribe()
        } catch {
          // 容器已经卸载；不再抛错。
        }
        unsubscribe = null
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      cleanup()
      if (ok) resolve()
      else reject(new Error('导航没有打开目标任务详情。'))
    }

    const check = () => {
      try {
        if (isTaskDetailRouteFor(navigationRef.getCurrentRoute(), taskId)) finish(true)
      } catch {
        finish(false)
      }
    }

    try {
      unsubscribe = navigationRef.addListener('state', check)
    } catch {
      finish(false)
      return
    }
    timer = setTimeout(() => {
      // 状态可能刚好在超时前一帧落地：最后再看一次。
      check()
      finish(false)
    }, timeoutMs)
    check()
  })
}
