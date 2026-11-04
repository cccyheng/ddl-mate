/**
 * 任务提醒 —— 接线 / 文案 / 安全边界检查。
 *
 * 不启动 React Native；只读源码，确认：两条栈都注册了提醒页、任务详情有入口、
 * 页面有权限 / 测试 / 保存 / 重试文案、store 在任务写入后触发对账、
 * 删除任务时精确清理提醒键、并且全仓没有 `cancelAllScheduledNotificationsAsync`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobile = join(here, '..')
const read = (relative) => readFileSync(join(mobile, relative), 'utf8')

test('任务栈与今天栈都注册 TaskReminder，任务详情有“提醒设置”入口', () => {
  const types = read('src/navigation/types.ts')
  assert.match(types, /TaskReminder: \{ id: number \}/)
  assert.match(types, /SharedTaskRoutesWithReminders/)

  const nav = read('src/navigation/RootNavigator.tsx')
  assert.match(nav, /import \{ TaskReminderScreen \}/)
  const occurrences = nav.match(/name="TaskReminder"/g) ?? []
  assert.equal(occurrences.length, 2, '任务栈和今天栈各一条')

  const detail = read('src/screens/TaskDetailScreen.tsx')
  assert.match(detail, /label="提醒设置"/)
  assert.match(detail, /navigate\('TaskReminder', \{ id: task\.id \}\)/)
})

test('提醒页文案：默认关闭、实际系统状态、权限、测试 10 秒、保存 / 重试', () => {
  const screen = read('src/screens/TaskReminderScreen.tsx')
  for (const text of [
    '提醒设置',
    '本机通知 · 默认关闭',
    '开启提醒',
    '关闭提醒',
    '保存提醒设置',
    '测试提醒（10 秒后）',
    '打开手机通知设置',
    '重试安排提醒',
    '重新取消提醒',
    '重试同步提醒',
    '载入最新（丢弃草稿）',
    '系统已排队',
    '不代表已经确认送达',
    '设置已保存，提醒尚未安排',
  ]) {
    assert.ok(screen.includes(text), `缺少文案：${text}`)
  }
  assert.match(screen, /formatReminderMoment/)
  assert.match(screen, /shanghaiDeadlineLabel/)
  assert.doesNotMatch(screen, /task_reminder\.|ddlmate\.task-reminder|fingerprint/i, '界面不展示内部键 / 指纹')
  // 控制器按 route id 创建，并在 effect setup 里 activate；cleanup 才 dispose。
  assert.match(screen, /useMemo\(\s*\(\) => createTaskReminderController\(taskId,[\s\S]{0,120}\[taskId\]/)
  assert.match(screen, /controller\.activate\(\)/)
  assert.match(screen, /controller\.dispose\(\)/)
  assert.match(screen, /controller\.reloadLatest\(\)/)
  // 关闭状态的取消失败也必须能重试，不再依赖 savedEnabled。
  assert.doesNotMatch(screen, /showRetry =[\s\S]{0,80}savedEnabled &&/)
})

test('store：任务写入成功后对账；删除任务在同一事务里清步骤键与提醒键', () => {
  const store = read('src/store/AppStore.tsx')
  assert.match(store, /afterTaskMutation\('task-create'\)/)
  assert.match(store, /afterTaskMutation\('task-update'\)/)
  assert.match(store, /afterTaskMutation\('task-status'\)/)
  assert.match(store, /afterTaskMutation\('task-toggle'\)/)
  assert.match(store, /afterTaskMutation\('task-delete'\)/)
  assert.match(store, /reminderRepository\.removeReminderForTask\(taskId\)/)
  assert.match(store, /setRemoveCleanup\(async \(taskId\) =>/)
  assert.match(store, /createTaskReminderService/)
  assert.match(store, /createExpoTaskReminderPort/)
  assert.match(store, /runSerializedRead/)
  assert.match(store, /AppState\.addEventListener/)
})

test('原生适配器：只做本地通知；安装前台 handler；不申请 token / 远程推送', () => {
  const adapter = read('src/domain/expoTaskReminderPort.ts')
  assert.match(adapter, /setNotificationHandler/)
  assert.match(adapter, /shouldShowBanner: true/)
  assert.match(adapter, /shouldShowList: true/)
  assert.match(adapter, /shouldSetBadge: false/)
  assert.match(adapter, /scheduleNotificationAsync/)
  assert.match(adapter, /cancelScheduledNotificationAsync/)
  assert.match(adapter, /getAllScheduledNotificationsAsync/)
  assert.doesNotMatch(adapter, /getExpoPushTokenAsync|getDevicePushTokenAsync|registerTaskAsync|cancelAllScheduledNotificationsAsync/)
})

test('严格命名空间：服务只解析本应用 ID，并且全仓没有 cancelAllScheduledNotificationsAsync', () => {
  const reminder = read('src/domain/taskReminder.ts')
  assert.match(reminder, /ddlmate\\\.task-reminder\\\.v1/)
  assert.match(reminder, /parseOwnedReminderNotification/)

  for (const file of [
    'src/domain/taskReminder.ts',
    'src/domain/taskReminderService.ts',
    'src/domain/expoTaskReminderPort.ts',
    'src/store/AppStore.tsx',
    'src/screens/TaskReminderScreen.tsx',
  ]) {
    assert.doesNotMatch(read(file), /cancelAllScheduledNotificationsAsync/, file)
  }
})

test('依赖：只新增 expo-notifications（SDK 57 兼容版本）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.dependencies['expo-notifications'], /^~57\./)
  assert.equal(pkg.dependencies.expo, '~57.0.27')
  assert.equal(pkg.dependencies['expo-constants'], '~57.0.21')
})

test('文档存在并明确“本机固定提前量、不是云推送 / 智能提醒”', () => {
  const docs = readFileSync(join(mobile, '..', 'docs', 'native-task-reminders.md'), 'utf8')
  assert.match(docs, /本机/)
  assert.match(docs, /不是.*云推送|不.*远程推送/)
  assert.match(docs, /30/)
  assert.match(docs, /4320|3 天/)
  assert.match(docs, /测试提醒/)
})
