/**
 * 同步提交闸门（纯逻辑，可测试）。
 *
 * 为什么不能只靠 React 的 `saving` / `generating` state：
 * setState 之后要到下一次渲染才会让 `disabled` 生效。用户（或自动化）在同一个
 * 事件循环里连续点两次时，第二次处理函数可能在 state 更新前就进入，从而重复
 * 入队一次模板写入 / 规则生成。
 *
 * 这个 guard 用同步布尔值把“进入处理函数”和“finally 释放”绑定起来：
 * - `tryEnter()` 第一次返回 true，之后立即变 false；
 * - `release()` 只能由拿到进入权的调用方在 finally 调用；
 * - 与 UI 的 disabled / loading 状态并存，后者负责视觉与可访问性。
 *
 * 不涉及 React，因此可以在 node 测试里真正验证“渲染前连续两次调用”的行为。
 */
export interface ImmediateSubmissionGuard {
  tryEnter: () => boolean
  release: () => void
  readonly busy: boolean
}

export function createImmediateSubmissionGuard(): ImmediateSubmissionGuard {
  let busy = false
  return {
    tryEnter() {
      if (busy) return false
      busy = true
      return true
    },
    release() {
      busy = false
    },
    get busy() {
      return busy
    },
  }
}
