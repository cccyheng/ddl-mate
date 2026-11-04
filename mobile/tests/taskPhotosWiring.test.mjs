/**
 * 任务原图 —— **接线（wiring）验证**。
 *
 * 只检查真正重要的接线约束，不去照抄实现细节：
 * 1. 今天栈与任务栈都注册了 `TaskPhotos`，参数是 `{ id: number }`，共用同一个组件；
 * 2. 任务详情页有明确命名的「任务原图」入口；
 * 3. 界面只通过 store 的 `taskPhotos` 读 / 写，没有 SQL、没有第二个仓库、没有上传 / OCR / 拍照；
 * 4. 只有显式点击「添加 / 解除关联」才走写入，读取路径不写；
 * 5. 解除确认文案明确说「只解除这条任务的关联，原图仍保留在截图库」；
 * 6. 全屏查看器从截图库抽出来共用，且截图库不再保留第二份实现；
 * 7. 候选上限在界面文案里明确写出，历史只读关联不会被标成可解除。
 *
 * 读的是真实源码文本，路径写死，不做目录递归。
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

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

test('路由类型：今天栈与任务栈都声明了 TaskPhotos，参数共用 { id: number }', () => {
  const types = read('navigation/types.ts')
  const taskStack = types.slice(types.indexOf('TaskStackParamList'), types.indexOf('TodayStackParamList'))
  const todayStack = types.slice(types.indexOf('TodayStackParamList'), types.indexOf('CourseStackParamList'))
  assert.match(taskStack, /TaskPhotos: \{ id: number \}/, '任务栈要有 TaskPhotos 路由')
  assert.match(todayStack, /TaskPhotos: \{ id: number \}/, '今天栈要有 TaskPhotos 路由')
  assert.match(types, /SharedTaskRoutesWithPhotos/, '任务详情用带 TaskPhotos 的窄类型')
})

test('原生栈：两个栈都注册了同名的 TaskPhotos 屏，且指向同一个组件', () => {
  const navigator = read('navigation/RootNavigator.tsx')
  assert.equal([...navigator.matchAll(/<TaskStack\.Screen\s+name="TaskPhotos"/g)].length, 1, '任务栈注册一次')
  assert.equal([...navigator.matchAll(/<TodayStack\.Screen\s+name="TaskPhotos"/g)].length, 1, '今天栈注册一次')
  assert.match(navigator, /import \{ TaskPhotosScreen \} from '\.\.\/screens\/TaskPhotosScreen'/)
  assert.equal(
    [...navigator.matchAll(/component=\{TaskPhotosScreen\}/g)].length,
    2,
    '两个注册都要指向同一个组件（不复制一份实现）',
  )
})

test('入口：任务详情页有明确命名的「任务原图」按钮，参数带任务 id', () => {
  const detail = read('screens/TaskDetailScreen.tsx')
  assert.match(detail, /label="任务原图"/)
  assert.match(detail, /navigate\('TaskPhotos', \{ id: task\.id \}\)/)
  assert.match(detail, /accessibilityHint="查看关联到这条任务的截图/)
})

test('界面只通过 store 的 taskPhotos 读 / 写；直接选图走共享 picker，不在屏幕里碰原生模块 / OCR', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /taskPhotos\.listPhotos\(/)
  assert.match(screen, /taskPhotos\.listAddable\(/)
  assert.match(screen, /taskPhotos\.attachPhoto\(/)
  assert.match(screen, /taskPhotos\.detachPhoto\(/)
  assert.doesNotMatch(screen, /SELECT |INSERT INTO|DELETE FROM|UPDATE screenshot|new TaskPhotoRepository/, '界面不碰数据库')
  assert.match(screen, /from '\.\.\/domain\/photoPicker'/, '选图复用共享 picker 模块')
  assert.match(screen, /controller\.addFromLibrary\(\)/, '相册直接添加是显式动作')
  assert.match(screen, /controller\.addFromCamera\(\)/, '相机直接添加是显式动作')
  assert.doesNotMatch(
    screen,
    /expo-image-picker|launchImageLibrary|launchCamera|expo-file-system|readAsStringAsync|fetch\(|axios|recognize/,
    '屏幕不直接调用原生选择器 / 文件写入 / OCR；这些都封装在 store 或共享 domain 模块里',
  )
})

test('显式写入：添加 / 解除只在两个控制器动作里，读取路径没有写入', () => {
  const controller = read('screens/taskPhotosController.ts')
  assert.equal([...controller.matchAll(/deps\.attach\(/g)].length, 1, '添加只在一个公共 helper 里调用')
  assert.equal([...controller.matchAll(/deps\.detach\(/g)].length, 1, '解除只在一个地方调用')
  assert.match(controller, /performAttachWrite\(/, '从截图库添加与直接选图共用同一次写关联路径')

  const loadBlock = controller.slice(controller.indexOf('async function performLoad'), controller.indexOf('async function refresh'))
  assert.doesNotMatch(loadBlock, /deps\.attach\(|deps\.detach\(/, '读取路径绝不写库')

  const screen = read('screens/TaskPhotosScreen.tsx')
  const addCalls = [...screen.matchAll(/controller\.attach\(/g)]
  const detachCalls = [...screen.matchAll(/controller\.detach\(/g)]
  assert.equal(addCalls.length, 1, '从截图库添加按钮是唯一 attach 入口')
  assert.equal(detachCalls.length, 1, '确认解除是唯一解除入口')
  assert.match(controller, /deps\.archiveOriginal\(/, '直接选图复用既有归档路径')
  assert.match(controller, /deps\.getRestoreEpoch/, '关联前检查恢复代次')
  assert.match(controller, /deps\.canWriteNow/, '关联前检查共享备份闸门')
})

test('同步 busy 闸门 + 提交后只允许重试刷新', () => {
  const controller = read('screens/taskPhotosController.ts')
  assert.match(controller, /if \(busyRef\.current\) return 'busy'/, '同步闸门挡住双击')
  assert.match(controller, /busyRef\.current = true[\s\S]{0,400}await performAttachWrite/, '写之前同步置位')
  assert.match(controller, /busyRef\.current = true[\s\S]{0,2600}await deps\.archiveOriginal/, '直接选图也在第一个 await 之前置位')
  assert.match(controller, /SAVED_BUT_STALE/, '提交后刷新失败有固定文案')
  assert.match(controller, /function writeBlocked\(\): boolean/, '写入有一个统一门禁')
  assert.match(controller, /staleAfterCommit !== null/, '提交后待刷新时禁止写入')
  assert.match(controller, /commitRefreshWarning !== null/, '全量快照刷新失败时禁止写入')
  assert.match(controller, /state\.loadError !== null/, '读取失败时禁止写入')
  assert.match(controller, /state\.loading/, '读取中禁止写入')
  assert.match(controller, /mode === 'postCommit' \|\| state\.staleAfterCommit !== null/)
  assert.match(controller, /if \(active\(epochAtStart, taskIdAtStart\)\) \{\s*busyRef\.current = false/, '旧任务完成不能放掉新任务闸门')
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /state\.staleAfterCommit !== null/, '界面在提交后刷新失败时进入只重试状态')
  assert.match(screen, /重新读取列表/, '只提供重新读取')
  assert.doesNotMatch(screen, /retryAttach|retryDetach|再次添加/, '不提供重复写入入口')
})

test('生命周期：setup 先 activate 再 subscribe/新鲜读取，cleanup 先退订再 dispose，重挂不永久失效', () => {
  const controller = read('screens/taskPhotosController.ts')
  assert.match(controller, /activate: \(\) => void/, '操作接口暴露 activate（不与添加原图的 attach 混淆）')
  assert.match(controller, /readonly attached: boolean/, '暴露 attached 供诊断 / 测试')
  assert.match(controller, /let mounted = true/, '初始是挂上的')
  assert.match(controller, /function activate\(\): void \{\s*if \(mounted\) return/, 'activate 在已挂上时幂等')
  assert.match(controller, /mounted = true[\s\S]{0,260}state = createInitialTaskPhotosState\(currentTaskId\)/, '重新挂上清回未读取状态')
  assert.match(controller, /mounted = false[\s\S]{0,180}epoch \+= 1/, 'dispose 作废在途回调')
  assert.doesNotMatch(controller, /let disposed = false/, 'dispose 不再是永久失效开关')

  const activateBlock = controller.slice(controller.indexOf('function activate()'), controller.indexOf('return {\n    getState'))
  assert.doesNotMatch(activateBlock, /deps\.attach\(|deps\.detach\(/, 'activate 绝不重放业务写入')

  // 写入门禁必须有 fresh-read：activate 之后 loaded=false，直到新的 refresh 成功。
  assert.match(controller, /function writeBlocked\(\): boolean \{[\s\S]{0,260}!state\.loaded/, '未完成新鲜读取时禁止写入')

  const screen = read('screens/TaskPhotosScreen.tsx')
  const activateAt = screen.indexOf('controller.activate()')
  const subscribeAt = screen.indexOf('controller.subscribe(')
  const refreshAt = screen.indexOf('void controller.refresh()', subscribeAt)
  const disposeAt = screen.indexOf('controller.dispose()')
  assert.ok(activateAt >= 0, '屏幕 setup 调用 activate')
  assert.ok(subscribeAt > activateAt, 'activate 必须在 subscribe 之前')
  assert.ok(refreshAt > subscribeAt, 'subscribe 之后补一次新鲜读取')
  assert.ok(disposeAt > refreshAt, 'cleanup 最后调用 dispose')
  assert.match(screen, /return \(\) => \{\s*unsubscribe\(\)\s*controller\.dispose\(\)/, 'cleanup 先退订再 dispose')

  // dispose → activate 的回归测试必须存在（读 / 写都覆盖）。
  const tests = read('../tests/taskPhotosController.test.mjs')
  assert.match(tests, /dispose → activate：作废旧快照/)
  assert.match(tests, /旧读取跨越 dispose → activate/)
  assert.match(tests, /旧写入跨越 dispose → activate/)
})

test('store 的 refreshError 只影响提示，不被冒充成写入失败', () => {
  const controller = read('screens/taskPhotosController.ts')
  assert.match(controller, /committedRefreshWarning\(outcome\)/, '读取 store 的 refreshError')
  assert.match(controller, /原图关联已经保存好了，但任务列表没能刷新/)
  assert.match(controller, /outcome\.committed/)
  assert.doesNotMatch(
    controller,
    /if \(outcome\.refreshError\)[\s\S]{0,120}(添加失败|解除关联失败|committed: false)/,
    '全量快照刷新失败不能被当成写入失败',
  )
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /state\.commitRefreshWarning !== null/, '界面单独展示「已保存但任务列表刷新失败」')
  assert.match(screen, /不要重复添加或解除/, '只提示重新读取，不引导重做')
  assert.match(screen, /canWrite =[\s\S]{0,300}commitRefreshWarning === null/, '提示期间禁用写入')
  assert.match(screen, /canWrite =[\s\S]{0,320}store\.refreshError === null/, '任务列表刷新失败时也禁用写入')
})

test('解除确认明确说明只解除关联、原图仍保留在截图库；历史关联只读', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /只解除这条任务的关联，原图仍保留在截图库。/, '确认文案要有原话')
  assert.match(screen, /其它任务、课程与历史识别结果里的关联不会被改动。/)
  assert.match(screen, /历史关联（只读）/, '历史关联要标只读')
  assert.match(screen, /photo\.manual \? \(/, '只有手动关联渲染解除按钮')
  assert.match(screen, /这张图不是在本页添加的，所以这里只能查看，不能解除。/)

  const controller = read('screens/taskPhotosController.ts')
  assert.match(controller, /if \(!target \|\| !target\.manual\) return 'invalid'/, '状态机也拒绝解除历史关联')
})

test('候选上限 300 在界面文案里明确写出，且没有自动选择', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /最多显示 \$\{TASK_PHOTO_CANDIDATE_LIMIT\} 张最近保存/, '界面写明上限')
  assert.match(screen, /点「添加」才会写入/, '只有显式点击才写')
  const controller = read('screens/taskPhotosController.ts')
  assert.match(controller, /TASK_PHOTO_CANDIDATE_LIMIT as REPOSITORY_TASK_PHOTO_CANDIDATE_LIMIT/)
  assert.doesNotMatch(controller, /forEach\([^)]*attach|map\([^)]*attach/, '没有自动选择并关联')
})

test('读取失败时不冒充「还没有关联」：错误态下不渲染空列表，也不允许写入', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /state\.loaded && state\.loadError === null \? \(/, '读取失败时隐藏列表，避免被误读成空列表')
  assert.match(screen, /任务原图暂时读不出来/, '读取失败有明确错误卡片')
  assert.match(screen, /这不代表没有关联；已有的图片和关联没有被改动/, '错误文案不冒充没有关联')
  assert.match(screen, /canWrite =[\s\S]{0,220}!state\.loading[\s\S]{0,120}state\.loadError === null/, '读取中 / 读取失败时禁用写入')
})

test('数据库就绪之前不把「仓库未准备好」误判成「任务不在」', () => {
  const screen = read('screens/TaskPhotosScreen.tsx')
  assert.match(screen, /if \(store\.status !== 'ready'\) return undefined/, '未就绪时不发起读取')
  assert.match(screen, /if \(store\.status === 'ready' && state\.loaded && !state\.taskExists\)/, '只有就绪后才显示任务不在')
  assert.match(screen, /store\.status === 'loading' \|\| \(!state\.loaded && state\.loading\)/, '数据库加载时显示加载态')
})

test('store 复用公共写队列：任务原图的添加 / 解除走 enqueue，不另开队列', () => {
  const store = read('store/AppStore.tsx')
  assert.match(store, /taskPhotos: app\.taskPhotos/, '数据库引导只建一个任务原图仓库')
  assert.match(store, /attachPhoto: async \(taskId, attemptId\) =>[\s\S]{0,500}enqueue\(\(current\) => current\.taskPhotos\.attach/)
  assert.match(store, /detachPhoto: async \(taskId, attemptId\) =>[\s\S]{0,500}enqueue\(\(current\) => current\.taskPhotos\.detach/)
  assert.doesNotMatch(store, /taskPhotosQueue|photoQueue/, '不另开任务原图写队列')
})

test('共用全屏查看器：截图库与任务原图都 import 同一份，截图库没有第二份实现', () => {
  const library = read('screens/PhotoLibraryScreen.tsx')
  const taskPhotos = read('screens/TaskPhotosScreen.tsx')
  assert.match(library, /import \{ ScreenshotViewer \} from '\.\.\/ui\/ScreenshotViewer'/)
  assert.match(taskPhotos, /import \{ ScreenshotViewer \} from '\.\.\/ui\/ScreenshotViewer'/)
  assert.doesNotMatch(library, /function ScreenshotViewer\(/, '截图库不再保留本地副本')

  const viewer = read('ui/ScreenshotViewer.tsx')
  assert.match(viewer, /maximumZoomScale=\{6\}/, '保留原有双指缩放行为')
  assert.match(viewer, /onError=\{\(\) => setFailed\(true\)\}/, '图片加载失败必须可见')
  assert.match(viewer, /重新加载图片/, '失败时可以重试')
  assert.match(viewer, /这张原图在本机找不到了/, '没有归档路径时如实说明')
  assert.match(viewer, /onRetry\?: \(\) => void/, '没有归档路径时页面可以重新读取')
  assert.doesNotMatch(viewer, /这里不会假装图片还在/, '移除面向用户的元叙述')
  assert.match(viewer, /useEffect\(\(\) => \{\s*setFailed\(false\)[\s\S]{0,120}\[photoId, archivedPath\]\)/, '换一张图必须清掉上一张的 onError')
  assert.match(viewer, /initialWindowMetrics/, '模态内使用当前窗口初始安全区')
  assert.match(viewer, /SafeAreaProvider/, '模态内重新提供安全区上下文，不依赖根节点旧测量')
  assert.match(viewer, /<SafeAreaView[\s\S]{0,160}edges=\{\['top', 'bottom', 'left', 'right'\]\}/, '全屏页四边都有安全区')
  assert.match(library, /const attempt = viewing[\s\S]{0,120}rerunRecognition\(attempt\)/, '截图库保留原来的重新识别行为')
  assert.doesNotMatch(withoutComments(library), /\*\*/, '抽共享查看器后截图库用户文案不再带 Markdown 星号')
})

test('用户文案不带 Markdown 星号，也不出现存储实现名词', () => {
  const rendered = withoutComments(read('screens/TaskPhotosScreen.tsx'))
  assert.doesNotMatch(rendered, /\*\*/, '原生 Text 里不许出现 Markdown 星号')
  assert.doesNotMatch(rendered, /screenshot_refs|screenshot_attempts|archived_path|MANUAL_TASK_PHOTO|SQL|schema/, '界面不出现存储实现名词')
})
