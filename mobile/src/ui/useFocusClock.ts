/**
 * 「只在页面可见时走字」的时钟 hook。
 *
 * 为什么需要它（复核对点名的真实缺陷）：直接 `useEffect(() => setInterval(...), [])`
 * 的定时器在**标签切走之后依然在跑** —— React Navigation 的栈不会因为切标签而卸载页面，
 * 于是后台页面每 30 秒白算一次，跨天状态也可能停在旧值。这里把定时器与
 * `AppState` 监听都绑在**焦点**上：进入页面立刻同步一次，离开页面全部清理。
 *
 * 用法：
 * ```ts
 * const clock = useFocusClock(() => readShanghaiClock())
 * ```
 * `read` 必须返回同一个形状（本项目里是 `ShanghaiClock`）；它只在焦点事件与
 * 定时器回调里被调用，所以「读数」永远发生在需要的时刻，而不是渲染时的快照。
 */

import { useCallback, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'

export interface FocusClockOptions {
  /** 定时推进间隔（毫秒）。默认 30 秒：分钟级状态足够，也不明显耗电。 */
  intervalMs?: number
}

/**
 * 返回「当前时钟读数」，并在页面可见时按 `intervalMs` 自动推进。
 *
 * - **进入页面（focus）**：立刻 `read()` 一次，避免显示离开前的旧值；
 * - **离开页面（blur）**：清掉定时器与 AppState 监听，后台不再空转；
 * - **回到前台（active）**：立刻 `read()` 一次，锁屏一节课回来不会还显示旧状态。
 */
export function useFocusClock<T>(read: () => T, options: FocusClockOptions = {}): T {
  const intervalMs = options.intervalMs ?? 30_000
  const [value, setValue] = useState<T>(read)

  const sync = useCallback(() => {
    setValue(read())
    // `read` 由调用方稳定提供（模块级函数），这里刻意不把它放进依赖以免每次渲染重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useFocusEffect(
    useCallback(() => {
      sync()
      const timer = setInterval(sync, intervalMs)
      const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
        if (state === 'active') sync()
      })
      return () => {
        clearInterval(timer)
        subscription.remove()
      }
    }, [intervalMs, sync]),
  )

  return value
}
