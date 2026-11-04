/**
 * 任务提醒点击 → 任务详情：接线 / 安全边界检查（不启动 React Native）。
 *
 * 锁定 supervisor 复核的关键约束：根标签嵌套类型、onReady、fresh DB 重查、
 * 持久回执、编辑 / 隐藏 Tasks 栈暂缓、非破坏性 banner、没有原生 clear。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = join(here, '..')
const read = (relative) => readFileSync(join(mobile, relative), 'utf8')

test('根标签参数声明嵌套栈；任务 / 今天栈都保留 TaskDetail', () => {
  const types = read('src/navigation/types.ts')
  assert.match(types, /import type \{ NavigatorScreenParams \} from '@react-navigation\/native'/)
  assert.match(types, /Today: NavigatorScreenParams<TodayStackParamList> \| undefined/)
  assert.match(types, /Tasks: NavigatorScreenParams<TaskStackParamList> \| undefined/)
  assert.match(types, /Courses: NavigatorScreenParams<CourseStackParamList> \| undefined/)
  assert.match(types, /Calendar: NavigatorScreenParams<CalendarStackParamList> \| undefined/)
  assert.match(types, /TaskDetail: \{ id: number \}/)
})

test('RootNavigator：ref + onReady + hook + 非破坏性 banner', () => {
  const nav = read('src/navigation/RootNavigator.tsx')
  assert.match(nav, /useNavigationContainerRef<RootTabParamList>\(\)/)
  assert.match(nav, /<NavigationContainer ref=\{navigationRef\}/)
  assert.match(nav, /onReady=\{handleNavigationReady\}/)
  assert.match(nav, /useTaskReminderNotificationNavigation\(navigationRef, navigationReady\)/)
  assert.match(nav, /getId=\{\(\{ params \}\) => String\(params\.id\)\}/)
  assert.match(nav, /<TaskReminderNotificationBanner/)
  assert.match(nav, /onRetry=\{notificationNavigation\.retry\}/)
  assert.match(nav, /onOpenTaskList=\{notificationNavigation\.openTaskList\}/)
})

test('hook：动态加载 response API，不调用 clear；fresh 查库 + 回执 + 隐藏 Tasks 栈', () => {
  const hook = read('src/navigation/useTaskReminderNotificationNavigation.ts')
  assert.match(hook, /await import\('expo-notifications'\)/)
  assert.match(hook, /getLastNotificationResponse/)
  assert.match(hook, /addNotificationResponseReceivedListener/)
  assert.doesNotMatch(hook, /\.clearLastNotificationResponse\(/)
  assert.match(hook, /getTaskFresh\(taskId\)/)
  assert.match(hook, /notificationReceipts\.hasConsumed/)
  assert.match(hook, /notificationReceipts\.recordConsumption/)
  assert.match(hook, /taskStackBlockingRouteName\(root/)
  assert.match(hook, /currentRouteBlocksNotificationOpen\(focused/)
  assert.match(hook, /isNavigationDraftDirty/)
  assert.match(hook, /waitForTaskDetailRoute\(navigationRef, taskId\)/)
  assert.match(hook, /subscribeNavigationDraftChanges/)
  assert.match(hook, /applyNotificationTapEvent/)
  assert.match(hook, /navigationRef\.navigate\('Tasks', \{/)
  assert.match(hook, /screen: 'TaskDetail'/)
  assert.match(hook, /initial: false/)
  assert.doesNotMatch(hook, /Linking\.openURL|openURL\(|data\.url|https?:\/\//)
  assert.doesNotMatch(hook, /getExpoPushTokenAsync|getDevicePushTokenAsync|registerTaskAsync|cancelAllScheduledNotificationsAsync/)
})

test('纯路由：严格 parser + 持久 token + 编辑暂缓 + 不写原生 clear', () => {
  const router = read('src/navigation/taskReminderNotificationRouter.ts')
  assert.match(router, /parseOwnedReminderNotification/)
  assert.match(router, /parseReminderNotificationPayload/)
  assert.match(router, /response\.actionIdentifier !== defaultActionIdentifier/)
  assert.match(router, /TASK_REMINDER_EDITING_ROUTES/)
  assert.match(router, /'TaskDetail'/)
  assert.match(router, /taskStackCurrentRouteName/)
  assert.match(router, /durableToken/)
  assert.match(router, /deliveredTokens/)
  assert.doesNotMatch(router, /\.clearLastNotificationResponse\(/)
  assert.doesNotMatch(router, /cancelAllScheduledNotificationsAsync|getExpoPushTokenAsync/)
})

test('持久回执：复用 app_settings、有界 32 条、坏记录 fail closed', () => {
  const receipts = read('src/domain/taskReminderNotificationReceipts.ts')
  assert.match(receipts, /TASK_REMINDER_RECEIPT_KEY = 'task_reminder\.notification_receipts\.v1'/)
  assert.match(receipts, /MAX_TASK_REMINDER_RECEIPTS = 32/)
  assert.match(receipts, /decodeTaskReminderNotificationReceipts/)
  const repo = read('src/domain/taskReminderNotificationReceiptsRepository.ts')
  assert.match(repo, /INSERT INTO app_settings/)
  assert.match(repo, /withTransactionAsync/)
  assert.match(repo, /decodeTaskReminderNotificationReceipts/)
})

test('store：只读 fresh 查询 + 回执窄接口；TaskDetail 读失败可重试', () => {
  const store = read('src/store/AppStore.tsx')
  assert.match(store, /getTaskFresh/)
  assert.match(store, /runSerializedRead/)
  assert.match(store, /const task = await repos\.tasks\.getById\(taskId\)/)
  assert.match(store, /notificationReceipts: \{/)
  assert.match(store, /TaskReminderNotificationReceiptsRepository/)

  const detail = read('src/screens/TaskDetailScreen.tsx')
  assert.match(detail, /store\.getTaskFresh\(taskId\)/)
  assert.match(detail, /ErrorState/)
  assert.match(detail, /暂时读不到这条任务/)
  assert.match(detail, /fresh\.task\?\.id === taskId/)
})

test('banner：编辑中不提供直接打开；失败可重试；缺失任务可安全回列表', () => {
  const banner = read('src/ui/TaskReminderNotificationBanner.tsx')
  assert.match(banner, /离开这一页后会自动打开任务详情/)
  assert.match(banner, /先不打开/)
  assert.match(banner, /重试/)
  assert.match(banner, /返回任务列表/)
  assert.match(banner, /canOpenTaskList = notice\.kind === 'missing' && !state\.editing/)
  assert.doesNotMatch(banner, /Alert\.alert|navigation\.goBack|popToTop|reset\(/)
})

test('依赖不变：没有为本模块新增包', () => {
  const pkg = JSON.parse(read('package.json'))
  const sdkMajor = pkg.dependencies.expo.match(/^~(\d+)\./)[1]
  assert.match(pkg.dependencies['expo-notifications'], new RegExp(`^~${sdkMajor}\\.`))
  assert.equal(pkg.dependencies['@react-navigation/native'], '^7.5.0')
})

test('真机修复接线：草稿登记、导航落地确认、bounded 本机诊断（不联网 / 不写正文）', () => {
  const router = read('src/navigation/taskReminderNotificationRouter.ts')
  assert.match(router, /TASK_REMINDER_DRAFT_AWARE_ROUTES/)
  assert.match(router, /taskStackBlockingRouteName/)
  assert.match(router, /parseTaskReminderNotificationTapDetailed/)
  assert.match(router, /await deps\.navigateToTask\(tap\.taskId\)/)
  assert.match(router, /onTapEvent/)

  const guard = read('src/navigation/navigationDraftGuard.ts')
  assert.match(guard, /setNavigationDraftDirty/)
  assert.match(guard, /subscribeNavigationDraftChanges/)
  assert.match(guard, /dirtyRoutes/)

  const target = read('src/navigation/taskReminderNavigationTarget.ts')
  assert.match(target, /waitForTaskDetailRoute/)
  assert.match(target, /TASK_REMINDER_NAVIGATION_CONFIRM_MS/)
  assert.doesNotMatch(target, /popToTop|resetRoot|goBack\(/)

  const diagnostics = read('src/navigation/notificationNavigationDiagnostics.ts')
  assert.match(diagnostics, /NOTIFICATION_NAVIGATION_BUILD = 'phonefix-20261021-1'/)
  assert.match(diagnostics, /不记录\*\*通知标题/)
  assert.match(diagnostics, /notificationDiagnosticLines/)
  assert.match(diagnostics, /notificationDiagnosticSummary/)
  assert.match(diagnostics, /notificationDiagnosticBlockedPageLabel/)
  assert.doesNotMatch(diagnostics, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//)

  const detail = read('src/screens/TaskDetailScreen.tsx')
  assert.match(detail, /setNavigationDraftDirty\(route\.key, 'TaskDetail'/)
  assert.match(detail, /changeAppendText/)
  assert.match(detail, /changeConfirming/)
  assert.match(detail, /changeBusy/)
  assert.match(detail, /busyRef\.current/)
  assert.match(detail, /appendTextRef\.current/)
  assert.match(detail, /clearNavigationDraft\(route\.key\)/)
  assert.match(detail, /setToast\(null\)/, '复用干净详情实例时要清掉旧任务的 toast')
  assert.match(detail, /next \|\| busyRef\.current/, 'busy 也必须登记为未保存状态')

  const reminder = read('src/screens/TaskReminderScreen.tsx')
  assert.match(reminder, /setNavigationDraftDirty\(route\.key, 'TaskReminder'/)
  assert.match(reminder, /current\.dirty \|\| current\.busy/)
  assert.match(reminder, /notificationDiagnosticSummary/)
  assert.match(reminder, /notificationDiagnosticLines/)
  assert.match(reminder, /diagnosticsExpanded/)
  assert.match(reminder, /展开详情/)
  assert.match(reminder, /通知点击诊断/)

  const banner = read('src/ui/TaskReminderNotificationBanner.tsx')
  assert.match(banner, /useNotificationNavigationDiagnostics/)
  assert.match(banner, /notificationDiagnosticSummary/)
  assert.match(banner, /本机诊断/)
})

test('文档：点击通知、冷启动、回执、编辑暂缓、删除任务边界', () => {
  const docs = readFileSync(join(mobile, '..', 'docs', 'native-task-reminders.md'), 'utf8')
  assert.match(docs, /## 7\. 点击通知/)
  assert.match(docs, /Tasks → TaskDetail/)
  assert.match(docs, /冷启动/)
  assert.match(docs, /回执/)
  assert.match(docs, /编辑/)
  assert.match(docs, /任务.*删除.*不打开|已删除.*不打开/)
  assert.match(docs, /真机.*点击.*未|未做真机点击/)
})
