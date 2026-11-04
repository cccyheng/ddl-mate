/**
 * 今日学习计划 —— **接线（wiring）验证**。
 *
 * 这一份刻意只做「接线」级别的检查，不去断言实现细节（那种「照抄源码」的断言没有价值）：
 * 1. 两条原生栈都注册了 `TodayPlan` 路由，并且共用的路由类型里有它；
 * 2. 今天页与任务页都提供了入口按钮（都 `navigate('TodayPlan')`）；
 * 3. 计划屏里用到的「保存 / 读取」只有 store 暴露的两个方法（没有第二处 SQL / 第二个仓库实例）；
 * 4. 计划屏**不会**自己自动保存（保存只可能由「采用并保存」/替换确认触发）。
 *
 * 读的是真实源码文本，路径都写死，不走目录递归。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src')

function read(relative) {
  return readFileSync(join(src, relative), 'utf8')
}

test('路由类型：今天栈与任务栈都声明了 TodayPlan', () => {
  const types = read('navigation/types.ts')
  const taskStack = types.slice(types.indexOf('TaskStackParamList'), types.indexOf('TodayStackParamList'))
  const todayStack = types.slice(types.indexOf('TodayStackParamList'), types.indexOf('export type CourseStackParamList'))
  assert.match(taskStack, /TodayPlan: undefined/, '任务栈要有 TodayPlan 路由')
  assert.match(todayStack, /TodayPlan: undefined/, '今天栈要有 TodayPlan 路由')
  assert.match(
    types,
    /export type SharedTaskRoutes = Pick<TodayStackParamList, 'TaskForm' \| 'TaskDetail' \| 'Pressure' \| 'TodayPlan'>/,
    '共用路由类型要包含它',
  )
})

test('原生栈：两个栈都注册了同名的 TodayPlan 屏', () => {
  const navigator = read('navigation/RootNavigator.tsx')
  const taskRegistrations = [...navigator.matchAll(/<TaskStack\.Screen\s+name="TodayPlan"/g)]
  const todayRegistrations = [...navigator.matchAll(/<TodayStack\.Screen\s+name="TodayPlan"/g)]
  assert.equal(taskRegistrations.length, 1, '任务栈注册一次')
  assert.equal(todayRegistrations.length, 1, '今天栈注册一次')
  assert.match(navigator, /import \{ TodayPlanScreen \} from '\.\.\/screens\/TodayPlanScreen'/)
  assert.equal(
    [...navigator.matchAll(/component=\{TodayPlanScreen\}/g)].length,
    2,
    '两个注册都要指向同一个组件（不复制一份实现）',
  )
})

test('入口：今天页与任务列表页各有一个跳转按钮', () => {
  for (const screen of ['screens/TodayScreen.tsx', 'screens/TaskListScreen.tsx']) {
    const source = read(screen)
    assert.match(source, /navigate\('TodayPlan'\)/, `${screen} 要有入口`)
  }
})

test('计划屏的保存只可能由用户显式动作触发，不在加载/预览时自动写库', () => {
  const screen = read('screens/TodayPlanScreen.tsx')
  // 保存调用只出现在 commit 这一个回调里（由「采用并保存」或替换确认调用）。
  const saveCalls = [...screen.matchAll(/todayPlan\.saveTodayPlan\(/g)]
  assert.equal(saveCalls.length, 1, '保存只应有一处调用点')
  assert.match(screen, /const commit = useCallback\(async \(\) => \{/, '保存集中在 commit 回调里')
  // 预览生成是纯函数，没有写库调用。
  const previewBlock = screen.slice(screen.indexOf('const onGeneratePreview'), screen.indexOf('const commit = useCallback'))
  assert.doesNotMatch(previewBlock, /saveTodayPlan/, '生成预览绝不写库')
  // 读回是只读动作。
  assert.match(screen, /const loadSaved = useCallback\(/, '读回集中在 loadSaved 里')
  assert.doesNotMatch(screen, /Notification|expo-notifications|fetch\(|axios/, '计划屏不发通知、不联网')
})

test('计划屏只通过 store 的 todayPlan 读写（界面里没有 SQL、没有第二个仓库）', () => {
  const screen = read('screens/TodayPlanScreen.tsx')
  assert.match(screen, /const \{ refresh, todayPlan \} = store/)
  assert.match(screen, /todayPlan\.loadTodayPlan\(/)
  assert.match(screen, /todayPlan\.saveTodayPlan\(/)
  assert.doesNotMatch(screen, /SELECT |INSERT INTO|UPDATE app_settings|new TodayPlanRepository/, '界面不碰数据库')
})

test('store 复用公共写队列：保存计划走 enqueue，且不另开队列', () => {
  const store = read('store/AppStore.tsx')
  assert.match(store, /saveTodayPlan: async \(input\) =>[\s\S]{0,400}enqueue\(\(\) => todayPlanRepository\.saveTodayPlan\(input\)\)/)
  assert.doesNotMatch(store, /todayPlanQueue/, '不允许为计划另开一条写队列')
  assert.match(store, /ensureDailyPlanStorage\(\)/, '启动时确保 app_settings 表存在')
})
