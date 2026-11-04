// 原生学习周报：接线 / 只读边界 / 无障碍与依赖守卫（静态断言，对着源码文本）。
//
// 与 learningReport.test.mjs / learningReportScreenState.test.mjs 的分工：
// 那两个文件**真的调用**统计、筛选、分页、翻周函数；这里只锁授权书点名的
// 接线事实与「不允许发生的事」（写库、新依赖、新表、网络、AI、时长估算等）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')
const read = (relativePath) => readFileSync(join(mobileRoot, relativePath), 'utf8')

/** 去掉注释之后的源码：注释里的技术词 / 说明不算产品行为。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SCREEN_RAW = read('src/screens/LearningReportScreen.tsx')
const SCREEN = stripComments(SCREEN_RAW)
const STATE = stripComments(read('src/screens/learningReportScreenState.ts'))
const ANALYZER = stripComments(read('src/domain/learningReport.ts'))
const TODAY = stripComments(read('src/screens/TodayScreen.tsx'))
const TASK_LIST = stripComments(read('src/screens/TaskListScreen.tsx'))
const ROOT_NAV = stripComments(read('src/navigation/RootNavigator.tsx'))
const NAV_TYPES = read('src/navigation/types.ts')
const SCHEMA = read('src/db/schema.ts')
const MIGRATIONS = stripComments(read('src/db/migrations.ts'))

/* ------------------------------ 纯统计层 ------------------------------ */

test('统计层是纯函数：不碰 React / 数据库 / 网络 / 隐式时钟 / 随机数', () => {
  assert.doesNotMatch(ANALYZER, /from 'react|react-native/)
  assert.doesNotMatch(ANALYZER, /from '\.\.\/db|from '\.\.\/store|expo-sqlite|node:sqlite|DatabaseSync/)
  assert.doesNotMatch(ANALYZER, /fetch\(|XMLHttpRequest|axios|https?:\/\//)
  assert.doesNotMatch(ANALYZER, /Math\.random|Date\.now|new Date\(\)/)
  assert.match(ANALYZER, /now: Date/, '「现在」必须由调用方注入')
  assert.match(ANALYZER, /export function analyzeLearningReport/, '分析函数必须可被界面 / 测试直接调用')
})

test('统计层从不使用 updatedAt 当完成时间，也不估算学习时长', () => {
  assert.doesNotMatch(ANALYZER, /updatedAt/, '完成 cohort 只能依赖 completedAt')
  assert.doesNotMatch(ANALYZER, /estimatedMinutes/, '本模块不显示时长，避免把预计用时说成实测学习时长')
  assert.match(ANALYZER, /completedAt/, '必须显式读取完成时间')
  assert.match(ANALYZER, /CANCELLED/, '取消状态必须被排除')
  assert.match(ANALYZER, /isDeadlineOverdue\(/, '逾期必须复用既有日期 / 时刻助手')
})

test('「本周完成」与「本周到期」是两个独立 cohort，各自有明确字段', () => {
  for (const field of [
    'completedThisWeek',
    'doneMissingCompletion',
    'doneOutsideWeek',
    'doneFutureThisWeek',
    'dueTasks',
    'dueDone',
    'dueOpen',
    'overdueNow',
    'dueCompletionRate',
    'courseGroups',
    'courseTotals',
  ]) {
    assert.match(ANALYZER, new RegExp(`${field}`), `分析结果缺少 ${field}`)
  }
})

/* ------------------------------ 只读边界 ------------------------------ */

test('周报页不直接写库：没有 SQL 写入、没有 store 写接口、没有新依赖', () => {
  assert.doesNotMatch(SCREEN, /expo-sqlite|DatabaseSync|node:sqlite/)
  assert.doesNotMatch(SCREEN, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i)
  assert.doesNotMatch(
    SCREEN,
    /store\.(create|update|delete|save|import|append|apply|clear|toggle|change|remove)[A-Za-z]*\(/,
    '只允许 store.refresh / retryBootstrap 这类读取动作',
  )
  assert.doesNotMatch(SCREEN, /fetch\(|XMLHttpRequest|axios|https?:\/\//, '不接网络')
  assert.doesNotMatch(SCREEN, /Notification|expo-notifications|scheduleNotification/, '不接通知')
  assert.doesNotMatch(SCREEN, /\bAI\b|openai|gpt|llm|大模型|智能分析/i, '不做 AI 总结')
  assert.doesNotMatch(SCREEN, /Math\.random|连续|打卡|streak|评分|score/i, '不造连续天数 / 评分')
  assert.doesNotMatch(SCREEN, /estimatedMinutes|学习时长|学习分钟/, '没有实测时长字段，就不显示时长')
})

test('打开页面只读当前快照：只有焦点刷新与跨零点刷新，没有自动保存 effect', () => {
  assert.match(SCREEN, /store\.refresh\(\)/)
  assert.match(SCREEN, /retryBootstrap\(\)/)
  // 唯一的 useEffect 只用于跨零点 refresh；不得调用任何 setScreen / 保存入口。
  const effects = [...SCREEN.matchAll(/useEffect\(([\s\S]*?)\}, \[/g)].map((match) => match[1])
  assert.ok(effects.length >= 1, '应该有跨零点刷新 effect')
  for (const body of effects) {
    assert.doesNotMatch(body, /setScreen|openFilter|save|write|create|update|delete/)
  }
  assert.doesNotMatch(SCREEN, /useEffect\([\s\S]{0,220}?setScreen/)
})

test('不新增设置 / 表 / 迁移；现有数据库 schema 完全没被这个模块碰到', () => {
  assert.doesNotMatch(SCHEMA, /learning_report|learningReport|weeklyReport/i)
  assert.doesNotMatch(MIGRATIONS, /learning_report|learningReport|weeklyReport/i)
  assert.doesNotMatch(STATE, /expo-sqlite|DatabaseSync|node:sqlite|app_settings/)
  assert.doesNotMatch(SCREEN, /learning_report|app_settings/)
})

test('不引入图表库或新依赖：package.json 依赖集合保持本轮基线', () => {
  const pkg = JSON.parse(read('package.json'))
  const expected = [
    '@react-native-async-storage/async-storage',
    '@react-navigation/bottom-tabs',
    '@react-navigation/native',
    '@react-navigation/native-stack',
    'expo',
    'expo-constants',
    'expo-file-system',
    'expo-image-manipulator',
    'expo-image-picker',
    'expo-notifications',
    'expo-sqlite',
    'expo-status-bar',
    'react',
    'react-native',
    'react-native-safe-area-context',
    'react-native-screens',
  ].sort()
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), expected, '本轮不允许新增依赖')
  assert.doesNotMatch(SCREEN, /react-native-chart|victory|d3|react-native-svg|svg/i)
  // 条形图只用原生 View 高度，没有第三方图表。
  assert.match(SCREEN, /barTrack/)
  assert.match(SCREEN, /barFill/)
})

/* ------------------------------ 路由与入口 ------------------------------ */

test('任务栈与今天栈都注册了 LearningReport，并使用同一个原生屏幕', () => {
  assert.match(NAV_TYPES, /export type TaskStackParamList = \{[\s\S]*?LearningReport: undefined[\s\S]*?\}/)
  assert.match(NAV_TYPES, /export type TodayStackParamList = \{[\s\S]*?LearningReport: undefined[\s\S]*?\}/)
  assert.match(NAV_TYPES, /SharedLearningReportRoutes = Pick<TodayStackParamList, 'LearningReport' \| 'TaskDetail'/)
  assert.match(ROOT_NAV, /import \{ LearningReportScreen \} from '\.\.\/screens\/LearningReportScreen'/)
  assert.equal([...ROOT_NAV.matchAll(/<TaskStack\.Screen\s+name="LearningReport"/g)].length, 1)
  assert.equal([...ROOT_NAV.matchAll(/<TodayStack\.Screen\s+name="LearningReport"/g)].length, 1)
  assert.match(ROOT_NAV, /name="LearningReport" component=\{LearningReportScreen\} options=\{\{ title: '学习周报' \}\}/)
})

test('今天页与任务页都有真实入口', () => {
  assert.match(TODAY, /label: '学习周报', onPress: \(\) => navigation\.navigate\('LearningReport'\)/)
  assert.match(TODAY, /navigation\.navigate\('LearningReport'\)/)
  assert.match(TASK_LIST, /navigation\.navigate\('LearningReport'\)/)
  assert.match(TASK_LIST, /label: '学习周报', onPress: \(\) => navigation\.navigate\('LearningReport'\)/)
})

/* --------------------------- 屏幕只渲染纯结果 --------------------------- */

test('屏幕与状态机共用同一份分析结果，不在页面里重复周算术 / 筛选公式', () => {
  assert.match(SCREEN, /analyzeLearningReport\(/)
  assert.match(SCREEN, /selectLearningReportTasks\(/)
  assert.match(SCREEN, /describeLearningReportFilter\(/)
  assert.match(SCREEN, /paginateLearningReportTasks\(/)
  assert.match(SCREEN, /resolveLearningReportScreenView\(/)
  // 页面不得自己算 cohort（例如按 deadline / completedAt 分组）。
  assert.doesNotMatch(SCREEN, /deadlineToShanghaiDateKey|isoToShanghaiDateKey|isDeadlineOverdue/)
  assert.doesNotMatch(SCREEN, /\.filter\([^)]*status/)
  assert.match(STATE, /isDateKeyInLearningWeek|learningWeekHistoryBounds|shiftLearningWeek/)
  assert.match(STATE, /learningReportPageCount|paginateLearningReportTasks/)
})

test('用既有聚焦时钟：跨零点 / 回前台重算，页面不自建定时器', () => {
  assert.match(SCREEN, /useFocusClock\(readShanghaiEpochClock\)/)
  assert.match(SCREEN, /new Date\(clock\.epochMs\)/)
  assert.match(SCREEN, /lastDateKey\.current === clock\.dateKey/)
  assert.doesNotMatch(SCREEN, /setInterval\(/)
  assert.doesNotMatch(SCREEN, /Date\.now\(\)/, '「现在」只来自聚焦时钟')
})

test('加载 / 读取失败 / 数据可能过期都沿用既有组件与重试路径', () => {
  assert.match(SCREEN, /<LoadingState/)
  assert.match(SCREEN, /<ErrorState/)
  assert.match(SCREEN, /<RefreshErrorBanner/)
  assert.match(SCREEN, /retryBootstrap/)
  assert.match(SCREEN, /正在读取本机数据/)
})

test('六个汇总数字都可点，且明细有明确标题 / 返回 / 清除 / 空状态 / 分页', () => {
  for (const label of ['到期完成率', '到期已完成', '到期未完成', '已逾期']) {
    assert.ok(SCREEN.includes(`label="${label}"`), `概览缺少「${label}」`)
  }
  assert.ok(SCREEN.includes('label={`${periodLabel}完成`}'))
  assert.ok(SCREEN.includes('label={`${periodLabel}到期`}'))
  assert.match(SCREEN, /完成时间缺失的已完成任务仍算进「到期已完成」/, '必须解释到期 cohort 与完成 cohort 的区别')
  const filterOpens = [...SCREEN.matchAll(/openFilter\(\{/g)]
  assert.ok(filterOpens.length >= 8, `汇总 / 每日 / 课程 / 缺失完成时间都应能打开明细，实际 ${filterOpens.length} 处`)
  assert.match(SCREEN, /返回汇总/)
  assert.match(SCREEN, /清除筛选/)
  assert.match(SCREEN, /<EmptyState/)
  assert.match(SCREEN, /上一页/)
  assert.match(SCREEN, /下一页/)
  assert.match(SCREEN, /第 \{shownPage\} \/ \{page\.pageCount\} 页/)
  assert.match(SCREEN, /page\.items\.map/, '只渲染当前页')
  assert.match(SCREEN, /navigation\.navigate\('TaskDetail', \{ id: task\.id \}\)/)
})

test('7 日完成条有真实数字、可访问文案与零数据说明，不画假数据', () => {
  assert.match(SCREEN, /\{day\.completedCount\}/)
  assert.match(SCREEN, /完成 \$\{day\.completedCount\} 个/)
  assert.match(SCREEN, /\{periodLabel\}还没有完成记录/)
  assert.match(SCREEN, /analysis\.completedThisWeek\.length === 0/)
  assert.doesNotMatch(SCREEN, /Math\.random|mock|fake|sample/i)
})

test('课程拆分按 id 分组、同名不合并，并清楚标出未关联 / 缺课程', () => {
  assert.match(SCREEN, /group\.courseId === null/)
  assert.match(SCREEN, /group\.missingCourse/)
  assert.match(SCREEN, /未关联课程/)
  assert.match(SCREEN, /课程已删除/)
  assert.match(SCREEN, /key=\{String\(group\.courseId\)\}/)
  // 不显示内部课程代码 / 选课序号。
  assert.doesNotMatch(SCREEN, /selectionSerial/)
  assert.doesNotMatch(SCREEN, /\.code\b/)
})

test('用户可见文案不出现技术词、字面 Markdown 或工程黑话', () => {
  const strings = [...SCREEN.matchAll(/'([^'\\]*)'/g), ...SCREEN.matchAll(/"([^"\\]*)"/g)].map((match) => match[1])
  const chinese = strings.filter((text) => /[\u4e00-\u9fa5]/.test(text))
  assert.ok(chinese.length > 0, '必须找到中文界面文案')
  for (const text of chinese) {
    assert.doesNotMatch(text, /数据库|SQL|JSON|API|token|AppStore|cohort|id\b/i, `界面文案里不该出现技术词：${text}`)
    assert.doesNotMatch(text, /\*\*/, `界面文案里不写字面 Markdown：${text}`)
    assert.doesNotMatch(text, /分母|样本|聚合|透视/, `界面文案里不该出现统计黑话：${text}`)
  }
  assert.doesNotMatch(SCREEN, /课程 id/i)
})

/* ------------------------------ 小屏 / 无障碍 ------------------------------ */

test('安全区 / 返回 / 触控目标 / 可访问标签沿用既有模式', () => {
  assert.match(SCREEN, /<ScreenScaffold/)
  const labels = (SCREEN.match(/accessibilityLabel=/g) ?? []).length
  assert.ok(labels >= 12, `关键控件都要有中文可访问标签，实际 ${labels} 处`)
  assert.match(SCREEN, /MIN_TOUCH_SIZE/)
  assert.match(SCREEN, /accessibilityRole="button"/)
  assert.match(SCREEN, /accessibilityState=\{\{ selected \}\}/)
  assert.match(SCREEN, /fontVariant: \['tabular-nums'\]/)
})

test('小屏 / 大字号不横向溢出：汇总与周导航可换行，条形图用弹性列', () => {
  assert.match(SCREEN, /flexWrap: 'wrap'/)
  assert.match(SCREEN, /minWidth: LEARNING_REPORT_DAY_COLUMN_MIN_WIDTH/)
  assert.match(SCREEN, /flexShrink: 0/)
  assert.match(SCREEN, /metricCell: \{\s*flexGrow: 1,\s*flexBasis: '30%'/s)
  assert.doesNotMatch(SCREEN, /ScrollView[\s\S]{0,80}horizontal/, '不做横向滚动')
  assert.doesNotMatch(SCREEN, /width:\s*[3-9]\d\d/, '不写死超过手机宽度的尺寸')
})
