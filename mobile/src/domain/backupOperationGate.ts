/**
 * 备份动作的**纯闸门**（无 React / 文件系统 / SQLite）。
 *
 * 导出、预览、恢复三者共享同一个闸门：已有动作在跑时，第二次点击必须立刻被拒绝，
 * 不能两个流程同时读队列、暂停通知或写暂存目录。`AppStore` 用它做真正的状态源，
 * 测试则直接验证同一份规则。
 */
export type BackupGateState = 'idle' | 'exporting' | 'previewing' | 'restoring' | 'importing' | 'repairing'

export class BackupOperationGate {
  private current: BackupGateState = 'idle'

  get state(): BackupGateState {
    return this.current
  }

  /** 只有完全空闲时才能进入下一个动作；返回是否真的进入了。 */
  begin(next: Exclude<BackupGateState, 'idle'>): boolean {
    if (this.current !== 'idle') return false
    this.current = next
    return true
  }

  /** 结束当前动作；重复调用安全。 */
  end(): void {
    this.current = 'idle'
  }
}

/**
 * 只保留**最近一次成功写出文件**的导出元数据。
 *
 * 导出失败 / 取消时传 `null`，必须保留上一条有效记录（不能把“上次成功”清掉，
 * 也不能把失败当成新的成功入口）。该记录只在当前 AppStore 内存里，不落盘，
 * 因此不声称能跨强制关闭 / 重启。
 */
export function retainLastSuccessfulExport<T>(previous: T | null, succeeded: T | null): T | null {
  return succeeded ?? previous
}

/** 只关闭调用方实际持有的 view；旧页面不能清掉新页面的 view。 */
export function shouldCloseContentView(
  currentViewDir: string | null,
  expectedViewDir?: string,
): boolean {
  return Boolean(currentViewDir) && (!expectedViewDir || currentViewDir === expectedViewDir)
}

/** 迟到的 open 结果只在页面仍挂载且仍聚焦时导航，否则只清理返回的 view。 */
export function shouldNavigateContentView(mounted: boolean, focused: boolean): boolean {
  return mounted && focused
}

/**
 * 只读内容视图的**按 identity 租约**。
 *
 * 同一时刻可能有两个原生栈各挂着一个内容页；旧页面卸载时不能删除新页面正在用的
 * view-*。释放延迟到下一轮事件循环，并在同一 viewDir 重新 retain 时取消，因此
 * React StrictMode 的 setup → cleanup → setup 也不会误删当前视图。
 */
export class BackupContentViewLeases {
  private readonly leases = new Map<string, number>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  retain(viewDir: string): void {
    const pending = this.pending.get(viewDir)
    if (pending) {
      clearTimeout(pending)
      this.pending.delete(viewDir)
    }
    this.leases.set(viewDir, (this.leases.get(viewDir) ?? 0) + 1)
  }

  release(viewDir: string, onClose: (viewDir: string) => void, delayMs = 0): void {
    const count = (this.leases.get(viewDir) ?? 0) - 1
    if (count > 0) {
      this.leases.set(viewDir, count)
      return
    }
    this.leases.delete(viewDir)
    const pending = this.pending.get(viewDir)
    if (pending) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.pending.delete(viewDir)
      onClose(viewDir)
    }, Math.max(0, delayMs))
    this.pending.set(viewDir, timer)
  }

  isLeased(viewDir: string): boolean {
    return (this.leases.get(viewDir) ?? 0) > 0
  }
}
