// 原生课表冲突检查：接线与边界守卫（静态断言，对着源码文本）。
//
// 锁的是授权书点名的行为：只读、路由 / 入口、聚焦刷新与跨零点、完整列表不截断、
// 正确的课程 / 课表跳转参数、坏数据 / 缺失课程的明确披露。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')

const read = (relativePath) => readFileSync(join(mobileRoot, relativePath), 'utf8')

/** 去掉注释，避免注释里的说明被当成真实产品行为。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SCREEN_RAW = read('src/screens/CourseConflictsScreen.tsx')
const SCREEN = stripComments(SCREEN_RAW)
const DOMAIN_RAW = read('src/domain/courseConflicts.ts')
const DOMAIN = stripComments(DOMAIN_RAW)
const NAV_TYPES = read('src/navigation/types.ts')
const ROOT_NAV = stripComments(read('src/navigation/RootNavigator.tsx'))
const COURSE_LIST = stripComments(read('src/screens/CourseListScreen.tsx'))

/* ------------------------------ 纯函数 / 只读 ------------------------------ */

test('冲突判定是纯函数：不碰数据库、不发请求、不用随机数、不隐式读系统时间', () => {
  assert.doesNotMatch(DOMAIN, /from '\.\.\/db|expo-sqlite|node:sqlite|DatabaseSync/)
  assert.doesNotMatch(DOMAIN, /fetch\(|XMLHttpRequest|axios|https?:\/\//)
  assert.doesNotMatch(DOMAIN, /Math\.random|Date\.now|new Date\(\)/)
  assert.match(DOMAIN, /buildCourseConflicts/)
  assert.match(DOMAIN, /COURSE_CONFLICTS_WINDOW_DAYS = 14/)
})

test('复用既有的上课日 / 时刻 / 教学周规则，不重写单双周或周次公式', () => {
  assert.match(DOMAIN, /occursOn\(/, '某天是否上课必须调用既有 occursOn')
  assert.match(DOMAIN, /validateTermRange\(/, '教学周组合必须调用既有校验')
  assert.match(DOMAIN, /canonicalClock\(/, '时刻规范化复用既有 helper')
  assert.match(DOMAIN, /clockToMinutes\(/, '分钟换算复用既有 helper')
  assert.doesNotMatch(DOMAIN, /% 2/, '不得自己写单双周奇偶')
  assert.doesNotMatch(DOMAIN, /weekNumberSet/, '不存在也不得新增 weekNumberSet 模型')
})

test('缺课程不解引用空值：安全兜底名 + 仍参与检测', () => {
  assert.match(DOMAIN, /courseMissing/)
  assert.match(DOMAIN, /未知课程（可能已删除）/)
  assert.match(DOMAIN, /course\?\.instructor/)
})

test('纯函数没有写库 / 通知 / AI / 日程逻辑', () => {
  for (const pattern of [/INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i, /Notification|expo-notifications/, /\bAI\b|openai|gpt|llm|大模型/i, /autoReschedule|生成日程/]) {
    assert.doesNotMatch(DOMAIN, pattern, `domain 撞上了不该出现的模式：${pattern}`)
  }
})

/* ------------------------------ 路由与入口 ------------------------------ */

test('CourseStack 声明并注册 CourseConflicts 路由', () => {
  assert.match(NAV_TYPES, /export type CourseStackParamList = \{[\s\S]*?CourseConflicts: undefined/)
  assert.match(
    ROOT_NAV,
    /import \{ CourseConflictsScreen \} from '\.\.\/screens\/CourseConflictsScreen'/,
  )
  assert.match(
    ROOT_NAV,
    /<CourseStack\.Screen\s+name="CourseConflicts"\s+component=\{CourseConflictsScreen\}\s+options=\{\{ title: '课表冲突检查' \}\}\s*\/>/,
  )
})

test('课程列表提供可见入口，跳转到 CourseConflicts', () => {
  assert.match(COURSE_LIST, /title="课程工具与设置"/)
  assert.match(COURSE_LIST, /navigation\.navigate\('CourseConflicts'\)/)
  assert.match(COURSE_LIST, /label: '课表冲突检查', onPress: \(\) => navigation\.navigate\('CourseConflicts'\)/)
})

/* ------------------------- 刷新 / 时钟 / 当前窗口 ------------------------- */

test('聚焦刷新 + 既有焦点时钟（含回前台与跨零点），页面不自建定时器', () => {
  assert.match(SCREEN, /useFocusClock\(readShanghaiClock\)/)
  assert.match(SCREEN, /useFocusEffect\(/)
  assert.match(SCREEN, /void refresh\(\)/)
  assert.doesNotMatch(SCREEN, /setInterval\(|clearInterval\(/, '定时器与清理必须交给 useFocusClock')
  assert.doesNotMatch(SCREEN, /AppState\.addEventListener/, 'AppState 监听必须交给 useFocusClock')
  assert.match(SCREEN, /fromDateKey: clock\.dateKey/, '窗口起点来自当前上海日期')
  assert.match(SCREEN, /\[clock, store\.data\.courses, store\.data\.schedules\]/, '聚焦 / 回前台读数变化会触发重算')
})

test('刷新失败时保留上一次快照，并明确说明可能不是最新', () => {
  assert.match(SCREEN, /store\.refreshError/)
  assert.match(SCREEN, /下面显示的是上一次成功读取的课表快照/)
  assert.match(SCREEN, /可能不是最新/)
  assert.match(SCREEN, /onRetry=\{\(\) => void store\.refresh\(\)\}/)
})

test('页面完整渲染所有冲突对：没有 slice / 截断 / 收起', () => {
  assert.match(SCREEN, /conflicts\.pairs/)
  assert.doesNotMatch(SCREEN, /pairs\.slice|pairCount.*slice|slice\(0,/, '不允许用 slice 隐藏冲突')
  assert.doesNotMatch(SCREEN, /limit|maxItems|显示更多冲突/, '不允许截断入口')
})

/* ------------------------------ 明确状态 ------------------------------ */

test('加载 / 错误 / 不可用 / 空 / 无冲突 / 部分数据是不同状态', () => {
  assert.match(SCREEN, /<LoadingState/)
  assert.match(SCREEN, /<ErrorState/)
  assert.match(SCREEN, /status === 'unavailable'/)
  assert.match(SCREEN, /<EmptyState/)
  assert.match(SCREEN, /没有可参与比较的课表/)
  assert.match(SCREEN, /在可比较的课表中，这 14 天没有发现时间冲突/)
  assert.match(SCREEN, /有数据未能完整参与检查/)
  assert.match(SCREEN, /conflicts\.warnings\.map/)
  assert.match(SCREEN, /conflicts\.missingCourseCount/)
})

test('页头摘要在 ready 之后才给出结果；全部无效时不下「0 对冲突」的结论', () => {
  assert.match(SCREEN, /store\.status === 'loading'/)
  assert.match(SCREEN, /只读检查 · 正在读取本机课表…/)
  assert.match(SCREEN, /conflicts\.validScheduleCount === 0/)
  assert.match(SCREEN, /没有可参与比较的课表 · 当前无法给出结论/)
  assert.match(SCREEN, /stalePrefix/)
  assert.match(SCREEN, /刷新失败 · 可能是旧快照/)
})

test('校验条数同时披露 total 与 valid，刷新失败另有可见标注', () => {
  assert.match(SCREEN, /\$\{conflicts\.validScheduleCount\}\/\$\{conflicts\.scheduleCount\} 条通过校验/)
  assert.match(SCREEN, /其中 \$\{conflicts\.validScheduleCount\} 条通过校验/)
  assert.match(SCREEN, /刷新失败 · 可能不是最新/)
})

test('文案不声称回到前台 / 跨零点会重新读库', () => {
  assert.match(SCREEN_RAW, /回到前台和跨过零点会用当前已加载的数据重算/)
  assert.doesNotMatch(SCREEN_RAW, /回到前台和跨过零点都会重新读取课表/)
})

test('检查范围始终可见：固定 14 天文案 + 真实起止日期', () => {
  assert.match(SCREEN, /今天起 \$\{COURSE_CONFLICTS_WINDOW_DAYS\} 天（含今天）/)
  assert.match(SCREEN, /conflicts\.fromDateKey/)
  assert.match(SCREEN, /conflicts\.toDateKey/)
  assert.match(SCREEN_RAW, /不是整个学期/)
  assert.match(SCREEN_RAW, /包括今天已经过去的时段/)
})

test('摘要区分「冲突对」与「不同日期」，不暗示冲突课程数', () => {
  assert.match(SCREEN, /conflicts\.pairCount/)
  assert.match(SCREEN, /conflicts\.dateCount/)
  assert.match(SCREEN_RAW, /不是冲突课程数/)
})

/* ------------------------------ 跳转与只读 ------------------------------ */

test('每条课表都给出查看课程 / 编辑课表的正确参数', () => {
  assert.match(SCREEN, /navigation\.navigate\('CourseDetail', \{ id: entry\.courseId \}\)/)
  assert.match(
    SCREEN,
    /navigation\.navigate\('ScheduleForm', \{ courseId: entry\.courseId, scheduleId: entry\.scheduleId \}\)/,
  )
  assert.match(SCREEN, /entry\.scheduleId/)
})

test('课程缺失时不提供打不开的课程 / 课表入口', () => {
  assert.match(SCREEN, /const actionsAvailable = !entry\.courseMissing && entry\.courseId !== null/)
  assert.match(SCREEN, /\{actionsAvailable \?/)
  assert.match(SCREEN, /if \(entry\.courseId === null \|\| entry\.courseMissing\) return/)
})

test('页面只读：不调用任何课程 / 课表 / 导入写接口，不出现 SQL', () => {
  assert.doesNotMatch(
    SCREEN,
    /store\.(createCourse|updateCourse|deleteCourse|createSchedule|updateSchedule|deleteSchedule|applyScheduleBatch|importSchedules)\(/,
  )
  assert.doesNotMatch(SCREEN, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i)
  assert.doesNotMatch(SCREEN, /useEffect\([\s\S]{0,200}?store\.(create|update|delete)/)
  assert.match(SCREEN_RAW, /本页只读/)
})

test('不显示内部课程代码，不暗示任务 / DDL 冲突', () => {
  assert.doesNotMatch(SCREEN, /selectionSerial|\.code\b/)
  assert.doesNotMatch(SCREEN_RAW, /任务冲突|DDL 冲突|作业冲突/)
  assert.match(SCREEN_RAW, /不检查任务与 DDL|不.*任务.*DDL/)
})

/* ------------------------------ 可访问性 / 依赖 ------------------------------ */

test('关键操作有中文可访问标签，触控目标沿用 44pt 令牌', () => {
  const labels = (SCREEN.match(/accessibilityLabel=/g) ?? []).length
  assert.ok(labels >= 8, `关键控件都要有 accessibilityLabel，实际 ${labels} 处`)
  assert.match(SCREEN, /MIN_TOUCH_SIZE/)
  assert.match(SCREEN, /accessibilityRole="alert"/)
  assert.match(SCREEN, /accessibilityRole="summary"/)
})

test('本轮没有新增依赖', () => {
  const pkg = JSON.parse(read('package.json'))
  const allowed = new Set([
    '@react-native-async-storage/async-storage',
    '@react-navigation/bottom-tabs',
    '@react-navigation/native',
    '@react-navigation/native-stack',
    'expo',
    'expo-constants',
    'expo-file-system',
    'expo-image-manipulator',
    'expo-image-picker',
    'expo-sqlite',
    'expo-status-bar',
    'react',
    'react-native',
    'react-native-safe-area-context',
    'react-native-screens',
  ])
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(allowed.has(name), `不认识的依赖 ${name}：本轮不允许新增依赖`)
  }
})
