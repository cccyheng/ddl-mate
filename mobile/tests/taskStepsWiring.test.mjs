/**
 * 任务步骤清单 —— **接线（wiring）验证**。
 *
 * 这一份刻意只做「接线」级别的检查，不去断言实现细节（那种「照抄源码」的断言没有价值）：
 * 1. 两条原生栈都注册了 `TaskSteps` 路由，并且共用的路由类型里有它（参数是 `{ id }`）；
 * 2. 任务详情页提供了入口按钮（`navigate('TaskSteps', { id })`）；
 * 3. 步骤屏里用到的「读 / 写」只有 store 暴露的 `taskSteps` 两个方法（没有第二处 SQL）；
 * 4. 步骤屏**只在用户点「保存步骤」时才写库**（加载 / 刷新 / 勾选都不写）；
 * 5. 步骤屏有未保存改动时的离开守卫，并且确认后**重放原来那个导航动作**。
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

test('路由类型：今天栈与任务栈都声明了 TaskSteps，参数共用 { id: number }', () => {
  const types = read('navigation/types.ts')
  const taskStack = types.slice(types.indexOf('TaskStackParamList'), types.indexOf('TodayStackParamList'))
  const todayStack = types.slice(types.indexOf('TodayStackParamList'), types.indexOf('CourseStackParamList'))
  assert.match(taskStack, /TaskSteps: \{ id: number \}/, '任务栈要有 TaskSteps 路由')
  assert.match(todayStack, /TaskSteps: \{ id: number \}/, '今天栈要有 TaskSteps 路由')
})

test('原生栈：两个栈都注册了同名的 TaskSteps 屏，且指向同一个组件', () => {
  const navigator = read('navigation/RootNavigator.tsx')
  assert.equal([...navigator.matchAll(/<TaskStack\.Screen\s+name="TaskSteps"/g)].length, 1, '任务栈注册一次')
  assert.equal([...navigator.matchAll(/<TodayStack\.Screen\s+name="TaskSteps"/g)].length, 1, '今天栈注册一次')
  assert.match(navigator, /import \{ TaskStepsScreen \} from '\.\.\/screens\/TaskStepsScreen'/)
  assert.equal(
    [...navigator.matchAll(/component=\{TaskStepsScreen\}/g)].length,
    2,
    '两个注册都要指向同一个组件（不复制一份实现）',
  )
})

test('入口：任务详情页有跳转按钮，参数带任务 id', () => {
  const detail = read('screens/TaskDetailScreen.tsx')
  assert.match(detail, /navigate\('TaskSteps', \{ id: task\.id \}\)/, '任务详情页要有步骤清单入口')
})

test('步骤屏只通过 store 的 taskSteps 读写（界面里没有 SQL、没有第二个仓库）', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  assert.match(screen, /const \{ refresh, taskSteps \} = store/)
  assert.match(screen, /taskSteps\.loadSteps\(taskId\)/)
  assert.match(screen, /taskSteps\.saveSteps\(\{/)
  assert.doesNotMatch(screen, /SELECT |INSERT INTO|UPDATE app_settings|new TaskStepsRepository/, '界面不碰数据库')
  assert.doesNotMatch(screen, /Notification|expo-notifications|fetch\(|axios/, '步骤屏不发通知、不联网')
})

test('显式保存：写库只在「保存步骤」那条路径上，加载 / 勾选 / 删除都不写', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  const saveCalls = [...screen.matchAll(/taskSteps\.saveSteps\(/g)]
  assert.equal(saveCalls.length, 1, '保存只应有一处调用点')
  assert.match(screen, /const commit = useCallback\(async \(\) => \{/, '保存集中在 commit 回调里')

  // 加载函数（聚焦刷新）里绝不能出现写库调用。
  const loadBlock = screen.slice(screen.indexOf('const loadSteps = useCallback'), screen.indexOf('const loadRef = useRef'))
  assert.doesNotMatch(loadBlock, /saveSteps/, '读取路径绝不写库')

  // 勾选 / 改标题 / 删除只是改草稿，不写库（草稿操作集中在这几个纯函数回调里）。
  const draftBlock = screen.slice(screen.indexOf('const onAddStep'), screen.indexOf('const onReloadLatest'))
  assert.match(draftBlock, /const onRemoveStep/, '草稿编辑区确实在这段源码里')
  assert.doesNotMatch(draftBlock, /saveSteps/, '草稿编辑绝不写库')
})

test('草稿只在加载 / 显式载入时被铺：没有第二次「顺手补草稿」的写入口', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  // 回归：旧实现除了 applySavedStepsRead 之外还有第二次 setState 去补草稿，
  // 会把「用户有意清空的草稿」在聚焦时又填回已保存内容。
  assert.doesNotMatch(screen, /draftFromSteps/, '界面不该自己拼草稿（那是状态机的职责）')
  assert.doesNotMatch(screen, /\{ \.\.\.previous, draft:/, '不允许绕过状态机直接改草稿')
  assert.match(screen, /applySavedStepsRead\(/, '草稿由状态机统一铺设')
  // 显式载入最新（丢弃草稿）是唯一的强制替换入口。
  assert.match(screen, /loadRef\.current\('reload'\)/)
})

test('冲突不能用新版本号覆盖草稿：保存只用草稿基版本', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  assert.match(screen, /expectedRevision: state\.draftBaseRevision/, '乐观锁只用草稿基版本')
  assert.doesNotMatch(screen, /expectedRevision: state\.latestRevision/, '绝不用后台读到的最新版本')
  assert.match(screen, /const canSave = canEdit && !state\.conflict && dirty && issues\.ok/)
  assert.match(screen, /pendingConflictReload/, '冲突要有显式确认的恢复动作')
})

test('初始读取完成前不许编辑 / 保存，点击处也有同步守卫', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  assert.match(screen, /const canEdit = state\.loaded && !unavailable && !parentGone && !pending && !reloading/)
  assert.match(screen, /if \(!canSave\) return/, '保存按钮的处理函数自己再挡一次')
  assert.match(screen, /if \(mode !== 'reload' && loadingRef\.current\) return/, '普通刷新不重入')
  assert.doesNotMatch(screen, /setState\(\(previous\) => \{[\s\S]{0,300}setPending/, 'setState 更新函数里不许再有副作用')
})

test('显式载入最新：确认后同步冻结编辑，取消不碰草稿，收尾一定解冻', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  // 在 await 之前立起冻结闸门（ref + state 两个），并且只在 reload 模式设置。
  assert.match(screen, /if \(mode === 'reload'\) \{[\s\S]{0,200}reloadingRef\.current = true[\s\S]{0,80}setReloading\(true\)/)
  // 编辑 / 勾选 / 保存的处理函数都用同一个同步闸门。
  assert.match(screen, /if \(inFlightRef\.current \|\| reloadingRef\.current\) return/)
  assert.match(screen, /const canEdit = [^\n]*!reloading/)
  // 取消只清标志，草稿一个字都不动。
  assert.match(screen, /onCancel=\{\(\) => setPendingConflictReload\(false\)\}/)
  // 无论是成功、失败还是被作废，最后一次读取收尾都会解冻。
  assert.match(screen, /reloadingRef\.current = false[\s\S]{0,160}setReloading\(false\)/)
  assert.match(screen, /usePreventRemove\(dirty \|\| pending \|\| reloading,/)
})

test('用户文案不带实现细节与 Markdown 星号', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  // 只看真正的渲染内容：源码注释里的 Markdown 强调不算用户文案。
  const rendered = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(rendered, /\*\*/, '原生 Text 里不许出现 Markdown 星号')
  assert.doesNotMatch(rendered, /task_steps\.|app_settings|JSON|schema/, '界面不出现存储实现名词')
})

test('离开守卫：有未保存改动时拦截并重放原来的导航动作', () => {
  const screen = read('screens/TaskStepsScreen.tsx')
  assert.match(screen, /usePreventRemove\(dirty \|\| pending \|\| reloading, \(\{ data \}\) => \{/)
  assert.match(screen, /setPendingLeaveAction\(data\.action\)/)
  assert.match(screen, /navigation\.dispatch\(action\)/, '确认后要重放原来那个动作，而不是简单 goBack')
  assert.match(screen, /inFlightRef\.current = true/, '同步在途闸门挡住双击')
})

test('store 复用公共写队列：步骤保存走 enqueue，不另开队列', () => {
  const store = read('store/AppStore.tsx')
  assert.match(store, /saveSteps: async \(input\) =>[\s\S]{0,400}enqueue\(\(\) => taskStepsRepository\.saveSteps\(input\)\)/)
  assert.doesNotMatch(store, /taskStepsQueue/, '不允许为步骤另开一条写队列')
  assert.match(store, /stepsRepository\.removeStepsForTask\(taskId\)/, '删任务时精确清理步骤键')
  assert.match(store, /reminderRepository\.removeReminderForTask\(taskId\)/, '同一个事务里也精确清理提醒键')
})

test('删除任务的清理是精确单键：源码里没有前缀批量删除', () => {
  const repo = read('domain/taskStepsRepository.ts')
  assert.match(repo, /removeStepsForTask\(taskId: number\)/)
  assert.match(repo, /DELETE FROM app_settings WHERE key = \?;/, '只按精确键删除')
  assert.doesNotMatch(repo, /DELETE\s+FROM\s+app_settings[\s\S]{0,80}?LIKE/i, '不允许前缀 / LIKE 批量删除')
  const taskRepo = read('domain/taskRepository.ts')
  assert.match(taskRepo, /withTransactionAsync\(async \(\) => \{[\s\S]{0,400}cleanupOnRemove/, '清理与删任务在同一个事务里')
})
