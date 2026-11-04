/**
 * 通知点击时的「真实草稿」登记表（**只在本进程内存里**）。
 *
 * 为什么需要它：`TaskDetail` / `TaskReminder` 只有在用户真的改了文字、开着确认框、
 * 或正在保存时才有未保存内容。如果仅凭路由名就一律暂缓，用户只是正常浏览详情 /
 * 刚从提醒页点完「测试提醒」时，点击通知会被静默挡在 banner 后面。
 *
 * 这两个页面在草稿状态变化时**同步**登记 / 注销自己的路由 key；通知控制器只看
 * 当前导航状态里实际存在的路由 key，因此不会把已卸载页面的旧草稿当成阻塞。
 *
 * 边界：
 * - 不持久化、不读通知正文、不写数据库；
 * - 只登记 `TaskDetail` / `TaskReminder` 两个有明确 dirty 状态的页面；
 * - 表单 / 导入 / 核对页仍然按路由名保守暂缓（它们的草稿状态更复杂）。
 */

export type NavigationDraftRouteName = 'TaskDetail' | 'TaskReminder' | 'FocusTime' | 'Today' | 'LearningReport' | 'TaskList'

const dirtyRoutes = new Map<string, NavigationDraftRouteName>()
const listeners = new Set<() => void>()
/**
 * 卸载清理延迟到微任务：StrictMode 的 cleanup → setup、或一次 dirty→dirty 的
 * effect 重跑，只要 setup 同步重新登记，就不会向 controller 发出「短暂变干净」的
 * 假通知，也就不会误交付排队中的点击。
 */
const pendingClears = new Map<string, number>()
let clearToken = 0

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者的异常不能影响通知路由。
    }
  }
}

/** 同步登记 / 清除一条路由的草稿状态；重复写入相同值不触发订阅。 */
export function setNavigationDraftDirty(
  routeKey: string,
  routeName: NavigationDraftRouteName,
  dirty: boolean,
): void {
  if (typeof routeKey !== 'string' || routeKey.length === 0) return
  // 同步重新登记会取消尚未执行的卸载清理。
  pendingClears.delete(routeKey)
  const previous = dirtyRoutes.get(routeKey)
  if (!dirty) {
    if (previous === undefined) return
    dirtyRoutes.delete(routeKey)
    notify()
    return
  }
  if (previous === routeName) return
  dirtyRoutes.set(routeKey, routeName)
  notify()
}

/**
 * 页面卸载时调用：只清掉自己的 key，不误伤同名的另一条路由。
 *
 * 真正删除延迟到微任务，且被同一 key 的新登记取消；因此 StrictMode 的
 * cleanup → setup 不会产生「草稿消失再出现」的瞬时干净状态。
 */
export function clearNavigationDraft(routeKey: string): void {
  if (typeof routeKey !== 'string' || routeKey.length === 0) return
  const token = (clearToken += 1)
  pendingClears.set(routeKey, token)
  queueMicrotask(() => {
    if (pendingClears.get(routeKey) !== token) return
    pendingClears.delete(routeKey)
    if (dirtyRoutes.delete(routeKey)) notify()
  })
}

export function isNavigationDraftDirty(routeKey: string | null | undefined): boolean {
  return typeof routeKey === 'string' && dirtyRoutes.has(routeKey)
}

export function navigationDraftRouteName(routeKey: string | null | undefined): NavigationDraftRouteName | null {
  if (typeof routeKey !== 'string') return null
  return dirtyRoutes.get(routeKey) ?? null
}

export function subscribeNavigationDraftChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 根导航「已就绪的 remount key」是否等于当前 key。
 *
 * 恢复后用新 key 重建 NavigationContainer；旧容器的 ready=true 不能继续算数，
 * 也不能靠一个父 effect 事后把它改成 false（父子被动 effect 顺序不保证）。
 */
export function navigationReadyForRemount(readyKey: number | null, currentKey: number): boolean {
  return readyKey !== null && readyKey === currentKey
}

/** 只接受**当前最新 key** 的 onReady 回调；旧容器迟到的 onReady 不得推进状态。 */
export function shouldAcceptRemountReady(callbackKey: number, latestKey: number): boolean {
  return callbackKey === latestKey
}

/**
 * 通知 controller 只在**真实的恢复代次变化**时 dismiss。
 *
 * 初次创建 / 无关重渲染的 `[controller, restoreEpoch]` effect 不能清掉冷启动
 * 已经排队的通知点击。
 */
export function shouldDismissNotificationController(previousEpoch: number, nextEpoch: number): boolean {
  return previousEpoch !== nextEpoch
}

/** 仅供测试清理模块级状态。 */
export function resetNavigationDraftGuardForTests(): void {
  pendingClears.clear()
  if (dirtyRoutes.size === 0) return
  dirtyRoutes.clear()
  notify()
}
