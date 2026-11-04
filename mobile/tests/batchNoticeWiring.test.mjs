/**
 * 批量识别通知 —— **接线（wiring）验证**。
 *
 * 只检查真正重要的接线约束（React Native 界面无法在 Node 里直接渲染）：
 * 1. 任务页入口、任务栈路由、参数类型；
 * 2. 只从相册多选（最多 8 张 / 保持选择顺序），没有相机路径；
 * 3. 每张图单独 `push` 全新 NoticeImport；采用只返回逐字文字，不写任务；
 * 4. 设置 / 截图库走父级「课程」栈既有路由；
 * 5. 历史登记只写通知 OCR 真实字段，不伪造课表 layout / week / candidates；
 * 6. 界面文案诚实：当前会话队列、原图全局保留、失败不冒充已保存；
 * 7. 只有展开的那一张渲染编辑框；缩略图上限 8；没有合并成一大段原文。
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

test('任务页入口 + 任务栈注册 BatchNotice，路由参数是 undefined', () => {
  const list = read('screens/TaskListScreen.tsx')
  assert.match(list, /label: '批量识别通知', onPress: \(\) => navigation\.navigate\('BatchNotice'\)/)
  assert.match(list, /navigation\.navigate\('BatchNotice'\)/)
  assert.match(list, /一次选最多8张截图/)

  const root = read('navigation/RootNavigator.tsx')
  assert.match(root, /import \{ BatchNoticeScreen \} from '\.\.\/screens\/BatchNoticeScreen'/)
  assert.match(root, /<TaskStack\.Screen name="BatchNotice" component=\{BatchNoticeScreen\}/)
  assert.equal([...root.matchAll(/name="BatchNotice"/g)].length, 1, '只在任务栈注册一次')

  const types = read('navigation/types.ts')
  const taskStack = types.slice(types.indexOf('TaskStackParamList'), types.indexOf('TodayStackParamList'))
  const todayStack = types.slice(types.indexOf('TodayStackParamList'), types.indexOf('CourseStackParamList'))
  assert.match(taskStack, /BatchNotice: undefined/)
  assert.doesNotMatch(todayStack, /BatchNotice/, '今天栈不注册这个页面')
})

test('相册多选配置：allowsMultipleSelection / selectionLimit 8 / orderedSelection，没有相机', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  assert.match(screen, /allowsMultipleSelection:\s*true/)
  assert.match(screen, /selectionLimit:\s*BATCH_NOTICE_MAX_IMAGES/)
  assert.match(screen, /orderedSelection:\s*true/)
  assert.match(screen, /launchImageLibraryAsync\(/)
  assert.doesNotMatch(screen, /launchCameraAsync|captureFromCamera|requestCameraPermissions|拍照/)
  const controller = read('screens/batchNoticeController.ts')
  assert.match(controller, /export const BATCH_NOTICE_MAX_IMAGES = 8/)
  assert.match(controller, /picked\.assets\.length > BATCH_NOTICE_MAX_IMAGES/)
  assert.match(controller, /这次没有改动任何图片/, '超过 8 张要整次拒绝并说明')
})

test('每张图单独 push 全新 NoticeImport，采用逐字文字；没有合并成一大段原文', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  assert.match(screen, /controller\.adoptText\(item\.id\)/)
  assert.match(screen, /navigation\.push\('NoticeImport',\s*\{\s*initialSourceText:\s*result\.text\s*\}\)/)
  assert.doesNotMatch(screen, /navigation\.navigate\('NoticeImport'/)
  assert.doesNotMatch(screen, /items\.map\([^)]*text[^)]*\)\.join|join\('\\n'\)|combinedSourceText|mergedText/, '不能把多张图合并成一份原文')
  assert.match(screen, /每张截图分别核对并保存任务/)

  const controller = read('screens/batchNoticeController.ts')
  assert.match(controller, /adoptText: \(itemId: string\) => BatchNoticeAdoptResult/)
  assert.match(controller, /return \{ ok: true, text: adoption\.text, itemId \}/)
  assert.match(controller, /const value = String\(text \?\? ''\)/, '采用保留原文字，不 trim / 不截断')
  assert.doesNotMatch(
    withoutComments(controller),
    /importNoticeCandidates|NoticeImportRepository|TaskRepository|createTask|importNotice/,
    '控制器不写任务',
  )
})

test('设置 / 截图库走父级 Courses 栈的既有页面；全屏查看器复用共享组件', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  assert.match(screen, /parent\.navigate\('Courses',\s*\{\s*screen,\s*params(?:,\s*initial:\s*false)?\s*\}\)/)
  assert.match(screen, /openCoursesScreen\(navigation,\s*'CompanionSettings'\)/)
  assert.match(screen, /openCoursesScreen\(navigation,\s*'PhotoLibrary'\)/)
  assert.ok(!/navigation\.navigate\('CompanionSettings'\)/.test(screen), 'TaskStack 没有 CompanionSettings 路由')
  assert.ok(!/navigation\.navigate\('PhotoLibrary'\)/.test(screen), 'TaskStack 没有 PhotoLibrary 路由')
  assert.match(screen, /import \{ ScreenshotViewer \} from '\.\.\/ui\/ScreenshotViewer'/)
  assert.match(screen, /resolveArchivedPath: \(attemptId\) => storeRef\.current\.screenshotLibrary\.getAttempt\(attemptId\)/)
  assert.match(screen, /archiveStatus === 'archived' && viewingItem\.archivedUri/, '只有真实归档路径才当已保存原图')
  assert.match(screen, /这张原图还没有保存成功；这里显示的是本次选择的临时文件/, '临时预览必须如实标注')
  assert.match(screen, /原图已经保存，但暂时读不到保存路径/, '读不到真实路径时不能冒充已保存字节')
  assert.match(screen, /actionLabel=\{[^}]*在截图库查看/s, '可从真实截图库记录再次打开')
  const store = read('store/AppStore.tsx')
  assert.match(store, /getAttempt: \(attemptId: number\) => Promise<ScreenshotAttempt \| null>/)
  assert.match(store, /getAttempt: async \(attemptId\) =>/)
})

test('实现细节收进次要入口：识别详情可折叠，常驻文案只讲实际用法', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  const rendered = withoutComments(screen)
  assert.match(rendered, /识别详情/)
  assert.match(rendered, /diagnosticsItemId/)
  assert.ok(!rendered.includes('没有百分比'), '主文案不再解释实现细节')
  assert.ok(!rendered.includes('不是 AI 语义理解'), '主文案不再解释实现细节')
  const alwaysVisible = rendered.slice(rendered.indexOf('第 {item.index} 张的识别文字'), rendered.indexOf('识别详情'))
  assert.ok(!alwaysVisible.includes('请求号'), '请求号放进折叠的识别详情')
  assert.ok(!alwaysVisible.includes('电脑读到的图'), '图片字节信息放进折叠的识别详情')
})

test('通知 OCR 历史只登记真实字段，不伪造课表 layout / week / candidates', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  assert.match(screen, /recordScreenshotResult\(\{/)
  assert.match(screen, /rawText:\s*input\.rawText/)
  assert.match(screen, /requestId:\s*input\.requestId \?\? null/)
  assert.match(screen, /durationMs:\s*input\.durationMs \?\? null/)
  assert.ok(!/response:\s*input\.response/.test(screen), '通知路径不能传 response')
  const recordBlock = screen.slice(screen.indexOf('recordScreenshotResult({'), screen.indexOf('getEndpoint:'))
  assert.doesNotMatch(recordBlock, /layout:|week:|candidates:/, '通知文字不是课表候选')

  const controller = read('screens/batchNoticeController.ts')
  const recordInterface = controller.slice(
    controller.indexOf('export interface BatchNoticeRecordInput'),
    controller.indexOf('export interface BatchNoticeDeps'),
  )
  assert.doesNotMatch(recordInterface, /layout|week|candidates|payload/, '历史输入不包含课表字段')
})

test('生命周期：activate 不重放，dispose 作废；界面 setup 先 activate 再订阅，cleanup 先退订再 dispose', () => {
  const controller = read('screens/batchNoticeController.ts')
  assert.match(controller, /activate: \(\) => \{/)
  assert.match(controller, /if \(mounted\) return/)
  assert.match(controller, /dispose: \(\) => \{/)
  assert.match(controller, /activeAttempt[\s\S]{0,200}controller\.abort\(\)/)
  assert.match(controller, /get attached\(\)/)
  assert.doesNotMatch(controller, /replay|reRunOnActivate/, '没有重放逻辑')

  const screen = read('screens/BatchNoticeScreen.tsx')
  const activateAt = screen.indexOf('controller.activate()')
  const subscribeAt = screen.indexOf('controller.subscribe(')
  const disposeAt = screen.indexOf('controller.dispose()')
  assert.ok(activateAt >= 0, 'setup 调用 activate')
  assert.ok(subscribeAt > activateAt, 'activate 在 subscribe 之前')
  assert.ok(disposeAt > subscribeAt, 'cleanup 最后调用 dispose')
  assert.match(screen, /return \(\) => \{\s*unsubscribe\(\)\s*controller\.dispose\(\)/)
})

test('同步 busy 闸门 + 生成号 + abort：覆盖选图 / 归档 / 整轮 / 采用', () => {
  const controller = read('screens/batchNoticeController.ts')
  assert.match(controller, /let busy = false/)
  assert.match(controller, /if \(busy\) return 'busy'/)
  assert.match(controller, /const token = \+\+generation/)
  assert.match(controller, /const isCurrent = \(token: number\): boolean => mounted && token === generation/)
  assert.match(controller, /generation \+= 1[\s\S]{0,260}attempt\.controller\.abort\(\)/, '取消推进 generation 再 abort')
  assert.match(controller, /if \(isCurrent\(token\)\) \{\s*busy = false[\s\S]{0,120}busyAction: null/, '旧 finally 只在仍是当前轮时清闸门')
  assert.match(controller, /if \(!isCurrent\(token\)\) return/, '迟到的结果被忽略')
  assert.match(controller, /if \(adoptGuard\) \{/, '采用有同步防连点')
  assert.match(controller, /archiveStatus === 'archived' && item\.archivedAttemptId !== null\) return true/, '成功归档不重复归档')
})

test('界面文案诚实：当前会话队列、原图全局保留、失败不冒充已保存、不声称自动关联', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  const rendered = withoutComments(screen)
  assert.doesNotMatch(rendered, /\*\*/, '原生 Text 不能出现 Markdown 星号')
  assert.match(rendered, /只在本次打开页面期间保留/)
  assert.match(rendered, /原图保存成功后仍然留在全局截图库/)
  assert.match(rendered, /这张原图还没有保存到截图库/)
  assert.match(rendered, /原图没保存/)
  assert.match(rendered, /已打开核对/)
  assert.match(rendered, /任务是否保存，以通知核对页显示的结果为准/)
  assert.match(rendered, /本页不会自动关联/)
  assert.match(rendered, /不会自动把图片逐条附到任务上/)
  assert.match(rendered, /任务只有在你于核对页勾选并保存时才会写入/)
  assert.ok(!rendered.includes('已导入'), '本切片没有导入反馈，不能显示已导入')
  assert.ok(!rendered.includes('已保存任务'), '本切片没有保存反馈，不能显示已保存任务')
  assert.ok(!rendered.includes('自动关联到任务'), '不能声称图片已自动关联到任务')
})

test('离开 / 换批确认：usePreventRemove 存在，只有展开的那一张渲染编辑框，缩略图最多 8', () => {
  const screen = read('screens/BatchNoticeScreen.tsx')
  assert.match(screen, /usePreventRemove\(state\.items\.length > 0 \|\| busy/)
  assert.match(screen, /替换当前这一批/)
  assert.match(screen, /离开并丢弃这一批/)
  assert.match(screen, /手动修改只在本次打开页面期间保留|离开后需要重新选择/)
  assert.match(screen, /expanded \? \(/, '只有展开项渲染编辑区')
  assert.match(screen, /expandedItemId === item\.id/)
  assert.match(screen, /state\.items\.map\(\(item\) =>/, '只渲染当前这一批（最多 8 项）')
  assert.match(screen, /MIN_TOUCH_SIZE/, '可点击项保持 44pt 触控目标')

  const controller = read('screens/batchNoticeController.ts')
  assert.match(controller, /hasUnsavedBatchNoticeQueue/)
  assert.match(controller, /needs-replace-confirm/)
})

test('store 的 archiveOriginal 返回归档 URI，截图库 / 单张流程保持原样', () => {
  const store = read('store/AppStore.tsx')
  assert.match(store, /archivedUri\?: string \| null/)
  assert.match(store, /archivedUri: outcome\.ok \? outcome\.archivedUri : null/)
  // 既有的单张通知 / 课表导入仍然调用同一个 archiveOriginal，没有被替换成批量专用通道。
  const noticePhoto = read('screens/NoticePhotoScreen.tsx')
  assert.match(noticePhoto, /archiveOriginal: \(uri, source, attemptSource\) => storeRef\.current\.archiveOriginal\(uri, source, attemptSource\)/)
  const photoImport = read('screens/PhotoImportScreen.tsx')
  assert.match(photoImport, /archiveOriginal: \(uri, source, attemptSource\) => storeRef\.current\.archiveOriginal\(uri, source, attemptSource\)/)
})

test('文档与交接文件存在，明确说明上限 / 当前会话 / 不写任务', () => {
  const docs = readFileSync(join(here, '..', '..', 'docs', 'native-batch-notices.md'), 'utf8')
  assert.match(docs, /8 张/)
  assert.match(docs, /10000/)
  assert.match(docs, /当前页面会话/)
  assert.match(docs, /NoticeImport/)
  const handoff = readFileSync(
    join(here, '..', '..', '.supervision', 'native-batch-notices-handoff.md'),
    'utf8',
  )
  assert.match(handoff, /batchNoticeController\.ts/)
  assert.match(handoff, /batchNoticeController\.test\.mjs/)
  assert.match(handoff, /tsc/)
})
