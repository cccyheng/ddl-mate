// 原生时间助手：接线与边界守卫（静态断言）。
//
// 这些断言对着**源码文本**，防止后续把「不该做的」偷偷做进去：
// 不写库 / 不联网 / 不加权限 / 不引入新依赖，以及表单接线只改 deadline 一个字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')

const read = (relativePath) => readFileSync(join(mobileRoot, relativePath), 'utf8')

/** 去掉注释之后的源码（注释里的技术词 / 文档记号不该被当成产品行为断言）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const PARSER = read('src/domain/timePhraseParser.ts')
const ASSISTANT = read('src/domain/timeAssistant.ts')
const STATE = read('src/domain/timeAssistantState.ts')
const UI_RAW = read('src/ui/timeAssistant.tsx')
const UI = stripComments(UI_RAW)
const FORM = stripComments(read('src/screens/TaskFormScreen.tsx'))

/* ------------------------------ 只读 / 离线 ------------------------------ */

test('解析层与状态层不碰数据库、不联网、不申请权限', () => {
  for (const [name, source] of [
    ['timePhraseParser.ts', PARSER],
    ['timeAssistant.ts', ASSISTANT],
    ['timeAssistantState.ts', STATE],
  ]) {
    assert.doesNotMatch(source, /from '\.\.\/db/, `${name} 不得引用数据库层`)
    assert.doesNotMatch(source, /expo-sqlite|node:sqlite|DatabaseSync/, `${name} 不得直接打开数据库`)
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|axios|http:\/\//, `${name} 不得发网络请求`)
    assert.doesNotMatch(source, /requestPermission|PermissionsAndroid|Linking\.openSettings/, `${name} 不得申请权限`)
  }
})

test('交互状态只有「采用」会交出要写入的时间', () => {
  // 采用结算只有 prepareAdoption 一个入口，且它自己带 canAdopt 守卫
  assert.match(STATE, /export function prepareAdoption\(/)
  assert.match(STATE, /if \(!canAdopt\(state, contextKey, deadline, input\)\) return \{ next: state, adoptedWallClock: null \}/)
  // 状态机不再接受 adopt 动作（避免第二条写入路径）
  assert.doesNotMatch(STATE, /type: 'adopt'/)
  assert.doesNotMatch(STATE, /return \{ \.\.\.state, deadline/)
})

test('解析层与状态层是纯函数：当前时间只能通过参数注入', () => {
  for (const [name, source] of [
    ['timePhraseParser.ts', PARSER],
    ['timeAssistant.ts', ASSISTANT],
    ['timeAssistantState.ts', STATE],
  ]) {
    // 允许 `fn(now: Date = new Date())` 这种**可注入**的默认时钟，禁止在函数体里隐式读系统时间
    const withoutDefaults = source.replace(/=\s*new Date\(\)/g, '=<injected-clock>')
    assert.doesNotMatch(withoutDefaults, /new Date\(\)/, `${name} 不得隐式读取系统当前时间`)
    assert.doesNotMatch(source, /Math\.random|Date\.now/, `${name} 不得依赖随机/当前时间`)
  }
})

test('UI 组件不用系统时区，也不做数据库写入', () => {
  assert.doesNotMatch(UI, /new Date\(\)\.toLocaleString|getTimezoneOffset/, '不得按手机本地时区展示')
  assert.doesNotMatch(UI, /expo-sqlite|DatabaseSync|node:sqlite/)
  assert.doesNotMatch(UI, /\.(create|update|remove|delete|insert)\(\s*'?"?(INSERT|UPDATE|DELETE)/i, '不得出现 SQL 写入')
  assert.doesNotMatch(UI, /useAppStore|repositories/, '组件不直接拿仓库 / store：只通过 props 收快照')
  assert.match(UI, /shanghaiNowWallClock/, '默认参考时间取北京时间')
})

test('参考时间：只在首次挂载取一次「现在」，清空后不自动补值', () => {
  // 初值必须是惰性初始化（useState(() => ...)），不是每次渲染都读时钟
  assert.match(UI, /useState\(\(\) => shanghaiNowWallClock\(\)\)/)
  // 不得存在「参考时间为空就自动补回现在」的兜底 effect
  assert.doesNotMatch(UI, /if \(!referenceWallClock\)/)
  assert.doesNotMatch(UI, /setReferenceWallClock\(shanghaiNowWallClock\(\)\)\s*\n\s*\}, \[referenceWallClock\]/)
  // 清空时给出可见错误，并把错误交给输入框展示
  assert.match(UI, /referenceError/)
  assert.match(UI, /error=\{referenceError\}/)
  // 收起时的摘要显示**当前可编辑的参考时间**，不是上一次解析结果里的标签
  assert.match(UI, /const referenceLabel = referenceWallClock\.trim\(\)/)
  assert.doesNotMatch(UI, /resolution\?\.referenceLabel/)
})

test('真实「现在」的提示：用既有聚焦时钟，不新增依赖、不改候选时间', () => {
  assert.match(UI, /useFocusClock/)
  assert.match(UI, /import \{ useFocusClock \} from '\.\/useFocusClock'/)
  assert.match(UI, /alreadyElapsed/)
  assert.match(UI, /已经过去了/)
  // 只是提示，不得反过来改候选时间
  assert.doesNotMatch(UI, /candidate\.wallClock =/)
})

test('采用只在状态机真的采纳成功时才回调写入', () => {
  // 结算必须在**事件处理器**里用纯函数完成，顺序：纯结算 → 守卫 → setState → 单次回调
  assert.match(UI, /const prepared = prepareAdoption\(state, contextInput, deadline\)/)
  assert.match(UI, /if \(prepared\.next === state\) return/)
  assert.match(UI, /setState\(prepared\.next\)/)
  assert.match(UI, /if \(prepared\.adoptedWallClock\) onAdoptDeadline\(prepared\.adoptedWallClock\)/)
})

test('updater 里不得有任何副作用：父回调不能出现在函数式 setState 里', () => {
  const updaters = [...UI.matchAll(/setState\(\(previous\)[\s\S]*?\)\)/g)].map((match) => match[0])
  assert.equal(updaters.length >= 1, true, `应该能识别出函数式 updater，实际 ${updaters.length} 处`)
  for (const updater of updaters) {
    assert.doesNotMatch(updater, /onAdoptDeadline/, '父回调不得写在 updater 里')
    assert.doesNotMatch(updater, /prepareAdoption|type: 'adopt'/, 'updater 不做采用结算')
  }
  // 采用路径：纯结算 → 守卫 → setState → 单次回调（父回调在 updater 之外）
  assert.match(
    UI,
    /const prepared = prepareAdoption[\s\S]*?if \(prepared\.next === state\) return[\s\S]*?setState\(prepared\.next\)[\s\S]*?if \(prepared\.adoptedWallClock\) onAdoptDeadline\(prepared\.adoptedWallClock\)/,
    '采用的顺序应为：纯结算 → 守卫 → setState → 单次回调',
  )
  // 父回调在组件里只允许出现这一处调用
  assert.equal((UI.match(/onAdoptDeadline\(/g) ?? []).length, 1, '父回调只允许一个调用点')
})

test('课程 / 数据未就绪时的守卫：不显示助手，保存中禁用', () => {
  assert.match(FORM, /store\.status === 'ready' \? \(/)
  assert.match(FORM, /disabled=\{saving\}/)
  assert.match(UI, /selectedCourseAvailable/)
})

/* ------------------------------ 表单接线 ------------------------------ */

test('TaskFormScreen 在截止时间卡片里接入助手，且只改 deadline 一个字段', () => {
  assert.match(FORM, /import \{ TimeAssistant \} from '\.\.\/ui\/timeAssistant'/)
  assert.match(FORM, /<TimeAssistant/)
  assert.match(FORM, /deadline=\{draft\.deadline\}/)
  assert.match(FORM, /courseId=\{draft\.courseId\}/, '课程沿用表单里明确选择的课程')
  assert.match(FORM, /onAdoptDeadline=\{\(value\) => update\('deadline', value\)\}/)
  // 助手不参与原有流程：说明 / 原文 / 课程字段仍然只走原来的 update
  assert.match(FORM, /onChangeText=\{\(text\) => update\('originalText', text\)\}/)
  // 数据没就绪时不显示助手（避免用空课表下结论）
  assert.match(FORM, /store\.status === 'ready' \? \(/)
  // 保存中禁用
  assert.match(FORM, /disabled=\{saving\}/)
})

test('助手没有引入新的依赖 / 配置文件改动', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies['expo-sqlite'] !== undefined, true, '依赖清单只应包含原有依赖')
  assert.equal(Object.keys(pkg.dependencies).includes('dayjs'), false)
  assert.equal(Object.keys(pkg.dependencies).includes('chrono-node'), false)
})

/* ------------------------------ 无障碍与文案 ------------------------------ */

test('交互按钮都带可访问标签，界面文案里没有字面 Markdown', () => {
  const labels = (UI.match(/accessibilityLabel=/g) ?? []).length
  assert.equal(labels >= 4, true, `关键按钮都要有 accessibilityLabel，实际 ${labels} 处`)
  assert.match(UI, /accessibilityRole="alert"/)
  // 看真正会渲染出来的字符串字面量，而不是注释
  const strings = [...UI_RAW.matchAll(/'([^'\\]*)'/g), ...UI_RAW.matchAll(/"([^"\\]*)"/g)].map((match) => match[1])
  const chinese = strings.filter((text) => /[\u4e00-\u9fa5]/.test(text))
  assert.equal(chinese.length > 0, true, '必须找到中文界面文案')
  for (const text of chinese) {
    assert.doesNotMatch(text, /\*\*/, `界面文案里不写字面 Markdown：${text}`)
  }
})

test('文案不出现「数据库 / SQL / JSON」这类技术词', () => {
  const uiStrings = [...UI_RAW.matchAll(/'([^'\\]*)'/g), ...UI_RAW.matchAll(/"([^"\\]*)"/g)].map((match) => match[1])
  const chinese = uiStrings.filter((text) => /[\u4e00-\u9fa5]/.test(text))
  assert.equal(chinese.length > 0, true)
  for (const text of chinese) {
    assert.doesNotMatch(text, /数据库|SQL|JSON|API|token/i, `界面文案里不该出现技术词：${text}`)
  }
})
