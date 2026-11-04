/**
 * 备份闸门与恢复导航/通知过渡的**行为逻辑**。
 *
 * 不渲染 React 树；这里直接运行 RootNavigator / useTaskReminderNotificationNavigation
 * 实际使用的同一份纯过渡函数，覆盖 review 点名的「子 onReady 先于父 effect」、
 * 「旧容器迟到 onReady」与「初次 controller 不能 dismiss 冷启动点击」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BackupContentViewLeases,
  BackupOperationGate,
  shouldCloseContentView,
  shouldNavigateContentView,
} from '../src/domain/backupOperationGate.ts'
import {
  navigationReadyForRemount,
  shouldAcceptRemountReady,
  shouldDismissNotificationController,
} from '../src/navigation/navigationDraftGuard.ts'

test('全局闸门：双击 / 并发导出恢复只能进入一个，结束后可再进入', () => {
  const gate = new BackupOperationGate()
  assert.equal(gate.begin('exporting'), true)
  assert.equal(gate.state, 'exporting')
  assert.equal(gate.begin('restoring'), false, '第二次点击必须立即被拒绝')
  assert.equal(gate.state, 'exporting')
  gate.end()
  assert.equal(gate.state, 'idle')
  assert.equal(gate.begin('previewing'), true)
  assert.equal(gate.begin('previewing'), false)
  gate.end()
})

test('恢复 remount：子 onReady 先到也算就绪，旧容器迟到 onReady 不能解锁', () => {
  // 初始容器 key 0 就绪。
  assert.equal(navigationReadyForRemount(null, 0), false)
  assert.equal(shouldAcceptRemountReady(0, 0), true)
  assert.equal(navigationReadyForRemount(0, 0), true)

  // 恢复请求新 key 1：旧 readyKey=0 立刻不再代表当前容器就绪。
  assert.equal(navigationReadyForRemount(0, 1), false)
  // 即使子容器先触发 onReady，也不需要父 effect 再做任何置 false 的动作。
  assert.equal(shouldAcceptRemountReady(1, 1), true)
  assert.equal(navigationReadyForRemount(1, 1), true)

  // 旧容器迟到的 onReady(0) 必须被拒绝；它不能 ack 当前 key=1 的恢复。
  assert.equal(shouldAcceptRemountReady(0, 1), false)
  assert.equal(navigationReadyForRemount(0, 1), false)
})

test('通知 controller：初次创建不 dismiss；只有真实恢复代次变化才清 pending', () => {
  assert.equal(shouldDismissNotificationController(0, 0), false, '初次创建不能清掉冷启动点击')
  assert.equal(shouldDismissNotificationController(0, 1), true, '真实恢复提交才 dismiss')
  assert.equal(shouldDismissNotificationController(1, 1), false, '无关重渲染不能 dismiss')
  assert.equal(shouldDismissNotificationController(1, 2), true)
})

test('内容视图 identity：旧页面不能关闭新 view；迟到的 open 只在挂载且聚焦时导航', () => {
  assert.equal(shouldCloseContentView('view-a'), true)
  assert.equal(shouldCloseContentView('view-a', 'view-a'), true)
  assert.equal(shouldCloseContentView('view-new', 'view-old'), false, '旧页面卸载不能删新页面的 view')
  assert.equal(shouldCloseContentView(null, 'view-old'), false)
  assert.equal(shouldNavigateContentView(true, true), true)
  assert.equal(shouldNavigateContentView(false, true), false)
  assert.equal(shouldNavigateContentView(true, false), false, '切到别的标签后不能导航隐藏栈')
})

test('内容视图租约：StrictMode retain 取消关闭；多租约全部释放才清理', async () => {
  const leases = new BackupContentViewLeases()
  const closed = []
  leases.retain('view-a')
  leases.release('view-a', (dir) => closed.push(dir))
  leases.retain('view-a') // StrictMode cleanup → setup 的同步重新登记
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(closed, [], '重新 retain 必须取消待关闭')

  leases.release('view-a', (dir) => closed.push(dir))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(closed, ['view-a'])

  leases.retain('view-b')
  leases.retain('view-b')
  leases.release('view-b', (dir) => closed.push(dir))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(closed, ['view-a'], '仍有租约时不能关闭')
  leases.release('view-b', (dir) => closed.push(dir))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(closed, ['view-a', 'view-b'])
})
