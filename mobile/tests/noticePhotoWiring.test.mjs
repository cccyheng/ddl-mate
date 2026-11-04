/**
 * 「截图转待办」接线检查（React Native 界面无法在 Node 里直接渲染）。
 *
 * 这里断言的都是**真实源码接线**，不是另写一遍规则：
 * - 任务页有入口；任务栈注册了 NoticePhoto；通知核对页从路由参数只初始化一次；
 * - 采用文字用 `push` 打开**新的** NoticeImport（不覆盖已打开草稿）；
 * - 设置 / 截图库走父级「课程」栈里既有的路由，不硬造 TaskStack 不存在的路由；
 * - 通知 OCR 的结果登记不伪造课表 layout / week / candidates。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(join(here, '..', 'src', ...parts), 'utf8')

test('任务页入口 + 任务栈注册 NoticePhoto', () => {
  const list = read('screens', 'TaskListScreen.tsx')
  assert.match(list, /label: '截图转待办', onPress: \(\) => navigation\.navigate\('NoticePhoto'\)/)
  assert.match(list, /navigation\.navigate\('NoticePhoto'\)/)

  const root = read('navigation', 'RootNavigator.tsx')
  assert.match(root, /import \{ NoticePhotoScreen(?:, ExamPhotoScreen)? \}/)
  assert.match(root, /name="NoticePhoto"\s+component=\{NoticePhotoScreen\}/)
})

test('路由参数：NoticeImport 接受 initialSourceText，NoticePhoto 在任务栈内', () => {
  const types = read('navigation', 'types.ts')
  assert.match(types, /NoticeImport:\s*\{\s*initialSourceText\?: string\s*\}\s*\|\s*undefined/)
  assert.match(types, /NoticePhoto:\s*undefined/)
})

test('NoticeImport 只把路由参数当初始值（不会覆盖用户后续输入）', () => {
  const screen = read('screens', 'NoticeImportScreen.tsx')
  assert.match(screen, /useRoute<Route>\(\)/)
  assert.match(screen, /useState\(\(\) => route\.params\?\.initialSourceText \?\? ''\)/)
  // 输入框仍然由用户编辑，而不是每次渲染从路由参数回写。
  assert.match(screen, /onChangeText=\{onChangeSource\}/)
})

test('采用文字：push 全新 NoticeImport，传完整文字；超长时禁止采用', () => {
  const screen = read('screens', 'NoticePhotoScreen.tsx')
  assert.match(screen, /controller\.adoptText\(\)/)
  assert.match(screen, /navigation\.push\('NoticeImport',\s*\{\s*initialSourceText:\s*result\.text\s*\}\)/)
  assert.match(screen, /noticePhotoAdoption/)
  assert.match(screen, /MAX_NOTICE_SOURCE_CHARS/)
  // 识别按钮是显式动作，选图函数里不能夹带 OCR。
  const controller = read('screens', 'noticePhotoController.ts')
  assert.match(controller, /await archiveSelected\(token, false\)/)
  assert.match(controller, /requestRecognize/)
})

test('设置 / 截图库走父级 Courses 栈的既有页面，不调用不存在的 TaskStack 路由', () => {
  const screen = read('screens', 'NoticePhotoScreen.tsx')
  assert.match(screen, /parent\.navigate\('Courses',\s*\{\s*screen,\s*params,\s*initial:\s*false\s*\}\)/)
  assert.match(screen, /openCoursesScreen\(navigation,\s*'CompanionSettings'\)/)
  assert.match(screen, /openCoursesScreen\(navigation,\s*'PhotoLibrary',\s*\{\s*focusAttemptId:/)
  assert.ok(!/navigation\.navigate\('CompanionSettings'\)/.test(screen), 'TaskStack 没有 CompanionSettings 路由')
  assert.ok(!/navigation\.navigate\('PhotoLibrary'\)/.test(screen), 'TaskStack 没有 PhotoLibrary 路由')
})

test('界面文案诚实：没有原生 Text 星号；原图只在真正保存成功后才说已保存', () => {
  const screen = read('screens', 'NoticePhotoScreen.tsx')
  // 这两条曾经是裸的 Markdown 字面量，原生 Text 不会解析。
  assert.ok(!screen.includes('这张图**没能保存到截图库**'), '原生 Text 不能出现 Markdown 星号')
  assert.ok(!screen.includes('**不会自动逐条附到每个任务上**'), '原生 Text 不能出现 Markdown 星号')
  assert.ok(!screen.includes('这张原图保留在全局截图库'), '不能无条件声称原图已经留在截图库')
  assert.ok(!screen.includes('已经选好的原图仍会保留在截图库'), '识别中离开时不能承诺原图已保存')

  // 采用文字时，原图状态必须按真实归档结果分两种说法。
  assert.match(
    screen,
    /state\.archivedOriginal\s*\?[\s\S]{0,220}已经保存在截图库[\s\S]{0,220}还没有保存成功/,
    '原图已保存 / 未保存必须是两种显式文案',
  )
  // 识别中离开的确认只能让用户看上面的保存状态，不能替归档结果打包票。
  assert.match(screen, /原图是否已经保存到截图库，以上面的保存状态为准/)
  assert.ok(!/本轮|既有/.test(screen.replace(/\/\*[\s\S]*?\*\//g, '')), '用户可见文案不出现实现术语')
})

test('通知 OCR 的结果登记不伪造课表字段；只记录真实 rawText / requestId / 状态', () => {
  const screen = read('screens', 'NoticePhotoScreen.tsx')
  assert.match(screen, /recordScreenshotResult\(\{/)
  // 通知路径不传 response（那会把通知文字塞进 layout / week / candidates）。
  assert.ok(!/response:\s*input\.response/.test(screen))
  assert.match(screen, /rawText:\s*input\.rawText/)
  assert.match(screen, /requestId:\s*input\.requestId \?\? null/)

  const store = read('store', 'AppStore.tsx')
  assert.match(store, /layout:\s*input\.response\?\.layout \?\? null/)
  assert.match(store, /requestId:\s*input\.requestId \?\? input\.response\?\.requestId \?\? null/)
  assert.match(store, /durationMs:\s*input\.durationMs \?\? input\.response\?\.ms \?\? null/)
})
