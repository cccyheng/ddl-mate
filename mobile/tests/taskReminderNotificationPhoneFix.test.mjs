/**
 * 真机点击通知「没打开 / 打开了错的页」的回归测试。
 *
 * 与之前的接线正则测试不同，这里直接用**安装的 React Navigation routers**
 * 构造真实的根标签 + 任务栈状态，验证：
 * - 干净 TaskDetail / TaskReminder 不再被当成编辑中；
 * - 真正有草稿的 TaskDetail、隐藏的表单页仍然阻塞；
 * - 导航确实落到目标任务详情；静默失败不得写持久回执；
 * - 本机诊断只记录状态码，不包含通知标题 / 正文 / 原始 payload。
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { CommonActions, StackRouter, TabRouter } from '@react-navigation/routers'

import {
  buildTestReminderNotificationPayload,
  testReminderNotificationId,
} from '../src/domain/taskReminder.ts'
import {
  createTaskReminderNotificationRouter,
  currentRouteBlocksNotificationOpen,
  taskStackBlockingRouteName,
} from '../src/navigation/taskReminderNotificationRouter.ts'
import {
  clearNavigationDraft,
  isNavigationDraftDirty,
  resetNavigationDraftGuardForTests,
  setNavigationDraftDirty,
  subscribeNavigationDraftChanges,
} from '../src/navigation/navigationDraftGuard.ts'
import {
  applyNotificationTapEvent,
  getNotificationDiagnosticSnapshot,
  NOTIFICATION_NAVIGATION_BUILD,
  notificationDiagnosticBlockedPageLabel,
  notificationDiagnosticLines,
  notificationDiagnosticSummary,
  resetNotificationDiagnosticsForTests,
  updateNotificationDiagnostic,
} from '../src/navigation/notificationNavigationDiagnostics.ts'
import {
  isTaskDetailRouteFor,
  waitForTaskDetailRoute,
} from '../src/navigation/taskReminderNavigationTarget.ts'

const ACTION = 'expo.modules.notifications.actions.DEFAULT'
const DELIVERY = 1_800_000_000_000
const TASK_ID = 7

const TAB_OPTIONS = {
  routeNames: ['Today', 'Tasks', 'Courses', 'Calendar'],
  routeParamList: {},
  routeGetIdList: {},
}
const STACK_OPTIONS = {
  routeNames: ['TaskList', 'TaskForm', 'TaskDetail', 'TaskPhotos', 'TaskReminder'],
  routeParamList: {},
  routeGetIdList: {
    // 与 RootNavigator 的 TaskDetail `getId` 保持一致：不同任务得到不同路由实例。
    TaskDetail: ({ params }) => String(params?.id),
  },
}

function freshTabs() {
  return TabRouter({ initialRouteName: 'Today' }).getInitialState(TAB_OPTIONS)
}

function freshTasks() {
  return StackRouter({ initialRouteName: 'TaskList' }).getInitialState(STACK_OPTIONS)
}

function withTasksState(rootState, tasksState) {
  return {
    ...rootState,
    routes: rootState.routes.map((route) =>
      route.name === 'Tasks' ? { ...route, state: tasksState } : route,
    ),
  }
}

function focusTab(rootState, name) {
  return TabRouter({ initialRouteName: 'Today' }).getStateForAction(
    rootState,
    CommonActions.navigate(name),
    TAB_OPTIONS,
  )
}

function pushTaskRoute(tasksState, name, params) {
  return StackRouter({ initialRouteName: 'TaskList' }).getStateForAction(
    tasksState,
    CommonActions.navigate(name, params),
    STACK_OPTIONS,
  )
}

function currentRoute(state) {
  return state.routes[state.index]
}

function responseFor(payload, extra = {}) {
  return {
    actionIdentifier: ACTION,
    notification: {
      date: DELIVERY,
      request: {
        identifier: testReminderNotificationId(payload.taskId),
        content: {
          title: '私密通知标题',
          body: '私密通知正文，不应出现在诊断里',
          data: payload,
        },
      },
    },
    ...extra,
  }
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function controllerHarness(overrides = {}) {
  let listener = null
  const events = []
  const writes = []
  const navigations = []
  const { navigateToTask: overrideNavigate, ...rest } = overrides
  const router = createTaskReminderNotificationRouter({
    loadNotifications: async () => ({
      DEFAULT_ACTION_IDENTIFIER: ACTION,
      getLastNotificationResponse: () => null,
      addNotificationResponseReceivedListener: (callback) => {
        listener = callback
        return { remove: () => {} }
      },
    }),
    lookupTaskFresh: async (taskId) => ({ ok: true, task: { id: taskId, title: '任务' }, reason: null }),
    receipts: {
      hasConsumed: async () => ({ ok: true, consumed: false, reason: null }),
      recordConsumption: async (receipt) => {
        writes.push(receipt)
        return { ok: true, stored: true, reason: null }
      },
    },
    navigateToTask: (taskId) => {
      navigations.push(taskId)
      return overrideNavigate ? overrideNavigate(taskId) : undefined
    },
    navigateToTaskList: () => {},
    isEditing: () => false,
    isNavigationReady: () => true,
    onTapEvent: (event) => events.push(event),
    ...rest,
  })
  return {
    router,
    events,
    writes,
    navigations,
    emit: (response) => listener?.(response),
    async start() {
      router.markNavigationReady()
      await router.start()
      await settle()
    },
  }
}

beforeEach(() => {
  resetNavigationDraftGuardForTests()
  resetNotificationDiagnosticsForTests()
})

/* ------------------- 真实导航状态：草稿感知的阻塞判断 ------------------- */

test('真实 Tasks 栈：干净 TaskDetail / TaskList 不阻塞；登记草稿后才阻塞', () => {
  const tab = focusTab(freshTabs(), 'Tasks')
  let tasks = freshTasks()
  let root = withTasksState(tab, tasks)

  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), null)
  assert.equal(currentRouteBlocksNotificationOpen(currentRoute(tasks), isNavigationDraftDirty), false)

  tasks = pushTaskRoute(tasks, 'TaskDetail', { id: TASK_ID })
  root = withTasksState(tab, tasks)
  const detailRoute = currentRoute(tasks)
  assert.equal(detailRoute.name, 'TaskDetail')
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), null, '干净详情页不该阻塞')
  assert.equal(
    currentRouteBlocksNotificationOpen(detailRoute, isNavigationDraftDirty),
    false,
    '聚焦的干净详情页不该阻塞',
  )

  setNavigationDraftDirty(detailRoute.key, 'TaskDetail', true)
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), 'TaskDetail')
  assert.equal(currentRouteBlocksNotificationOpen(detailRoute, isNavigationDraftDirty), true)

  setNavigationDraftDirty(detailRoute.key, 'TaskDetail', false)
  clearNavigationDraft(detailRoute.key)
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), null)
})

test('隐藏 Tasks 栈：干净详情页不阻塞；草稿详情 / 埋在中间的 TaskForm 仍阻塞', () => {
  const calendar = focusTab(freshTabs(), 'Calendar')
  let tasks = pushTaskRoute(freshTasks(), 'TaskDetail', { id: TASK_ID })
  const detailKey = currentRoute(tasks).key
  let root = withTasksState(calendar, tasks)

  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), null)
  setNavigationDraftDirty(detailKey, 'TaskDetail', true)
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), 'TaskDetail')
  setNavigationDraftDirty(detailKey, 'TaskDetail', false)

  tasks = pushTaskRoute(tasks, 'TaskForm', { id: TASK_ID })
  tasks = pushTaskRoute(tasks, 'TaskPhotos', { id: TASK_ID })
  root = withTasksState(calendar, tasks)
  assert.equal(currentRoute(tasks).name, 'TaskPhotos')
  assert.equal(
    taskStackBlockingRouteName(root, isNavigationDraftDirty),
    'TaskForm',
    '藏在栈中间的未保存表单仍然不能被通知导航 pop 掉',
  )
})

test('干净 TaskReminder 不阻塞；真实 dirty 才阻塞', () => {
  const tab = focusTab(freshTabs(), 'Tasks')
  let tasks = pushTaskRoute(freshTasks(), 'TaskDetail', { id: TASK_ID })
  tasks = pushTaskRoute(tasks, 'TaskReminder', { id: TASK_ID })
  const reminder = currentRoute(tasks)
  const root = withTasksState(tab, tasks)

  assert.equal(reminder.name, 'TaskReminder')
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), null, '干净提醒页不该阻塞')
  setNavigationDraftDirty(reminder.key, 'TaskReminder', true)
  assert.equal(taskStackBlockingRouteName(root, isNavigationDraftDirty), 'TaskReminder')
})

test('草稿清理延迟到微任务：同 key 立即重登记不会发出「短暂干净」通知', async () => {
  const key = 'detail-strict-mode'
  let notifications = 0
  const unsubscribe = subscribeNavigationDraftChanges(() => {
    notifications += 1
  })
  setNavigationDraftDirty(key, 'TaskDetail', true)
  const before = notifications

  // 模拟 StrictMode cleanup → setup 或 dirty→dirty 的 effect 重跑：清理后立刻重新登记。
  clearNavigationDraft(key)
  setNavigationDraftDirty(key, 'TaskDetail', true)
  await Promise.resolve()
  assert.equal(isNavigationDraftDirty(key), true, '真实草稿不能因 cleanup / setup 被清掉')
  assert.equal(notifications, before, '这一轮不能通知 controller 说页面变干净了')

  clearNavigationDraft(key)
  await Promise.resolve()
  assert.equal(isNavigationDraftDirty(key), false, '真正卸载后才清掉')
  assert.ok(notifications > before)
  unsubscribe()
})

test('诊断摘要使用人话页面名，保留构建标记，不暴露内部路由名', () => {
  updateNotificationDiagnostic({
    outcome: 'deferred',
    editing: true,
    editingRoute: 'TaskReminder',
    taskId: TASK_ID,
    target: '任务 → 任务详情（任务 #7）',
    lastAt: new Date().toISOString(),
  })
  const summary = notificationDiagnosticSummary(getNotificationDiagnosticSnapshot())
  assert.match(summary, /提醒设置/)
  assert.match(summary, /phonefix-20261021-1/)
  assert.doesNotMatch(summary, /TaskReminder|TaskDetail|Tasks >/)

  assert.equal(notificationDiagnosticBlockedPageLabel('TaskDetail'), '任务详情')
  assert.equal(notificationDiagnosticBlockedPageLabel('TaskReminder'), '提醒设置')
  assert.equal(notificationDiagnosticBlockedPageLabel('UnknownInternalRoute'), '当前页面')
})

test('真实 keyed 任务栈：导航到同一任务详情复用实例，换任务则新推一个实例', () => {
  const stack = StackRouter({ initialRouteName: 'TaskList' })
  let tasks = freshTasks()

  tasks = stack.getStateForAction(
    tasks,
    CommonActions.navigate('TaskDetail', { id: TASK_ID }),
    STACK_OPTIONS,
  )
  const firstKey = currentRoute(tasks).key
  assert.equal(currentRoute(tasks).params.id, TASK_ID)

  tasks = stack.getStateForAction(
    tasks,
    CommonActions.navigate('TaskDetail', { id: TASK_ID }),
    STACK_OPTIONS,
  )
  assert.equal(tasks.routes.length, 2, '同一任务不重复堆叠详情')
  assert.equal(currentRoute(tasks).key, firstKey)

  tasks = stack.getStateForAction(
    tasks,
    CommonActions.navigate('TaskDetail', { id: 8 }),
    STACK_OPTIONS,
  )
  assert.equal(tasks.routes.length, 3, '不同任务要得到独立详情实例，不能改写旧实例参数')
  assert.equal(tasks.routes[1].key, firstKey, '旧任务详情实例与参数保留')
  assert.equal(currentRoute(tasks).params.id, 8)
})

/* ----------------------- 导航落地确认（真实语义） ----------------------- */

test('导航落地确认：已在目标详情立即成功；状态事件到达目标后成功', async () => {
  assert.equal(isTaskDetailRouteFor({ name: 'TaskDetail', params: { id: TASK_ID } }, TASK_ID), true)
  assert.equal(isTaskDetailRouteFor({ name: 'TaskDetail', params: { id: 8 } }, TASK_ID), false)
  assert.equal(isTaskDetailRouteFor({ name: 'TaskList' }, TASK_ID), false)

  let route = { name: 'TaskDetail', params: { id: TASK_ID } }
  const listeners = new Set()
  const ref = {
    getCurrentRoute: () => route,
    addListener: (_event, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  await waitForTaskDetailRoute(ref, TASK_ID, { timeoutMs: 50 })
  assert.equal(listeners.size, 0, '成功后要移除监听')

  route = { name: 'TaskList' }
  const pending = waitForTaskDetailRoute(ref, TASK_ID, { timeoutMs: 200 })
  route = { name: 'TaskDetail', params: { id: TASK_ID } }
  for (const listener of listeners) listener()
  await pending
})

test('导航落地确认：导航被静默忽略 / 落到错误任务时拒绝（不写假回执）', async () => {
  let route = { name: 'TaskList' }
  const listeners = new Set()
  const ref = {
    getCurrentRoute: () => route,
    addListener: (_event, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  await assert.rejects(waitForTaskDetailRoute(ref, TASK_ID, { timeoutMs: 20 }))

  route = { name: 'TaskDetail', params: { id: 8 } }
  await assert.rejects(waitForTaskDetailRoute(ref, TASK_ID, { timeoutMs: 20 }), /没有打开目标任务详情/)
  assert.equal(listeners.size, 0, '失败后也要移除监听')
})

/* ------------------- controller：导航未被确认就不写回执 ------------------- */

test('导航 Promise 拒绝：显示可重试错误、不写回执、不发假的已打开状态', async () => {
  const harness = controllerHarness({
    navigateToTask: async () => {
      throw new Error('导航没有打开目标任务详情。')
    },
  })
  await harness.start()
  harness.emit(responseFor(buildTestReminderNotificationPayload(TASK_ID, DELIVERY)))
  await settle()

  assert.deepEqual(harness.navigations, [TASK_ID])
  assert.equal(harness.writes.length, 0, '导航未被确认时绝不能写已消费回执')
  assert.equal(harness.router.getState().notice?.kind, 'error')
  assert.equal(
    harness.events.some((event) => event.stage === 'failed' && event.reason === 'navigation-failed'),
    true,
  )
  assert.equal(harness.events.some((event) => event.stage === 'opened'), false)
})

test('导航确认 Promise 未完成前不写回执；确认成功后才写一次', async () => {
  const navigation = deferred()
  const harness = controllerHarness({ navigateToTask: () => navigation.promise })
  await harness.start()
  harness.emit(responseFor(buildTestReminderNotificationPayload(TASK_ID, DELIVERY)))
  await settle()

  assert.deepEqual(harness.navigations, [TASK_ID])
  assert.equal(harness.writes.length, 0, '等待导航确认期间不能先写回执')
  navigation.resolve()
  await settle()
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.router.getState().notice, null)
  assert.equal(
    harness.events.some((event) => event.stage === 'opened' && event.taskId === TASK_ID),
    true,
  )
})

test('等待导航确认时 dismiss：不再写回执，也不在用户关闭提示后又跳一次', async () => {
  const navigation = deferred()
  const harness = controllerHarness({ navigateToTask: () => navigation.promise })
  await harness.start()
  harness.emit(responseFor(buildTestReminderNotificationPayload(TASK_ID, DELIVERY)))
  await settle()
  assert.equal(harness.writes.length, 0)

  harness.router.dismiss()
  navigation.resolve()
  await settle()
  assert.equal(harness.writes.length, 0)
  assert.equal(harness.router.getState().notice, null)
})

/* --------------------------- 本机诊断安全边界 --------------------------- */

test('诊断只记录状态码 / 任务编号 / 目标，不包含通知标题、正文或原始载荷', async () => {
  const harness = controllerHarness()
  await harness.start()
  harness.emit(responseFor(buildTestReminderNotificationPayload(TASK_ID, DELIVERY)))
  await settle()

  const serializedEvents = JSON.stringify(harness.events)
  assert.doesNotMatch(serializedEvents, /私密通知标题/)
  assert.doesNotMatch(serializedEvents, /私密通知正文/)
  assert.doesNotMatch(serializedEvents, /fingerprint|secret|payload/i)

  for (const event of harness.events) applyNotificationTapEvent(event)
  const snapshot = getNotificationDiagnosticSnapshot()
  assert.equal(snapshot.build, NOTIFICATION_NAVIGATION_BUILD)
  assert.equal(snapshot.outcome, 'opened')
  assert.equal(snapshot.taskId, TASK_ID)
  assert.equal(snapshot.target, '任务 → 任务详情（任务 #7）')
  assert.equal(snapshot.receipt, 'stored')

  const text = notificationDiagnosticLines(snapshot).join('\n')
  assert.doesNotMatch(text, /私密通知标题/)
  assert.doesNotMatch(text, /私密通知正文/)
  assert.doesNotMatch(text, /secret|fingerprint/i)
  assert.match(text, /构建：phonefix-20261021-1/)
  assert.match(text, /导航目标：任务 → 任务详情/)
  assert.doesNotMatch(text, /Tasks > TaskDetail/)
})

test('诊断能区分「非本应用点击」与「本应用点击」，且不泄露载荷', async () => {
  const harness = controllerHarness()
  await harness.start()
  harness.emit({ actionIdentifier: ACTION, notification: { date: DELIVERY, request: { identifier: 'foreign.7', content: { data: { secret: '不应出现' } } } } })
  await settle()

  const rejected = harness.events.find((event) => event.stage === 'rejected')
  assert.ok(rejected, '应记录一次被拒绝的点击')
  assert.equal(rejected.reason, 'not-owned')
  assert.doesNotMatch(JSON.stringify(harness.events), /不应出现/)

  applyNotificationTapEvent(rejected)
  const snapshot = getNotificationDiagnosticSnapshot()
  assert.equal(snapshot.outcome, 'rejected')
  assert.equal(snapshot.reason, 'not-owned')
  assert.match(notificationDiagnosticLines(snapshot).join('\n'), /不是本应用的任务提醒/)
})
