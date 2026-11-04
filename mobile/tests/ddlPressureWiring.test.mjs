// 原生 DDL 压力分析：接线与边界守卫（静态断言，对着源码文本）。
//
// 这些断言锁的是**授权书里点名的行为**，不是实现细节：
// 只读不写库、两条原生栈都注册、用同一份纯函数结果（不重复公式）、
// 展开状态与草稿不被后台刷新重置、文案不说「足够 / 安全」、不做日程 / 通知 / AI。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')

const read = (relativePath) => readFileSync(join(mobileRoot, relativePath), 'utf8')

/** 去掉注释之后的源码（注释里的技术词 / 说明不该被当成产品行为断言）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SCREEN_RAW = read('src/screens/PressureScreen.tsx')
const SCREEN = stripComments(SCREEN_RAW)
const TODAY = stripComments(read('src/screens/TodayScreen.tsx'))
const TASK_LIST = stripComments(read('src/screens/TaskListScreen.tsx'))
const ROOT_NAV = stripComments(read('src/navigation/RootNavigator.tsx'))
const NAV_TYPES = read('src/navigation/types.ts')
const STORE = stripComments(read('src/store/AppStore.tsx'))
const ANALYZER = stripComments(read('src/domain/ddlPressure.ts'))
const SETTINGS_REPO = stripComments(read('src/domain/settingsRepository.ts'))
const SCHEMA = read('src/db/schema.ts')
const MIGRATIONS = stripComments(read('src/db/migrations.ts'))

/* ------------------------------ 只读 / 离线 ------------------------------ */

test('分析层是纯函数：不碰数据库、不发请求、不隐式读时钟、不用随机数', () => {
  assert.doesNotMatch(ANALYZER, /from '\.\.\/db/)
  assert.doesNotMatch(ANALYZER, /expo-sqlite|node:sqlite|DatabaseSync/)
  assert.doesNotMatch(ANALYZER, /fetch\(|XMLHttpRequest|axios|http:\/\//)
  assert.doesNotMatch(ANALYZER, /Math\.random|Date\.now/)
  // 「现在」只能通过参数注入（`fetch(now)` 之类的允许，但函数体里不能隐式 new Date()）
  const withoutDefaults = ANALYZER.replace(/=\s*new Date\(\)/g, '=<injected-clock>')
  assert.doesNotMatch(withoutDefaults, /new Date\(\)/, '分析层不得隐式读取系统当前时间')
  assert.match(ANALYZER, /now: Date/, '「现在」必须由调用方注入')
})

test('压力分析页不直接写库：所有写入都经过 store 的显式动作', () => {
  assert.doesNotMatch(SCREEN, /expo-sqlite|DatabaseSync|node:sqlite/)
  assert.doesNotMatch(SCREEN, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i, '界面里不得出现 SQL 写入')
  assert.match(SCREEN, /store\.saveStudyReferenceMinutes\(/, '参考用时只能通过 store 保存')
  // 只允许这两个显式动作，不允许调用任何任务写接口
  assert.doesNotMatch(SCREEN, /store\.(createTask|updateTask|deleteTask|changeTaskStatus|toggleTaskComplete)\(/)
})

test('渲染不产生写入：没有「打开页面就保存」的 effect', () => {
  // 唯一的保存入口是事件处理器；不得出现「加载后自动保存」的写法
  assert.doesNotMatch(SCREEN, /useEffect\([\s\S]{0,200}?saveStudyReferenceMinutes/)
  const saveCalls = [...SCREEN.matchAll(/store\.saveStudyReferenceMinutes\(/g)]
  assert.equal(saveCalls.length, 2, '只有「保存」与「清除」两个显式入口')
})

/* ------------------------------ 路由注册 ------------------------------ */

test('TaskStack 注册了 Pressure 路由', () => {
  assert.match(NAV_TYPES, /export type TaskStackParamList = \{[\s\S]*?Pressure: undefined/)
  assert.match(ROOT_NAV, /<TaskStack\.Screen name="Pressure" component=\{PressureScreen\}/)
})

test('今天标签有自己的原生栈，并且也注册了 Pressure / TaskDetail / TaskForm', () => {
  assert.match(NAV_TYPES, /export type TodayStackParamList = \{[\s\S]*?Today: undefined[\s\S]*?TaskForm[\s\S]*?TaskDetail[\s\S]*?Pressure: undefined/)
  assert.match(ROOT_NAV, /const TodayStack = createNativeStackNavigator<TodayStackParamList>\(\)/)
  assert.match(ROOT_NAV, /<TodayStack\.Screen name="Today" component=\{TodayScreen\}/)
  assert.match(ROOT_NAV, /<TodayStack\.Screen name="Pressure" component=\{PressureScreen\}/)
  assert.match(ROOT_NAV, /<TodayStack\.Screen name="TaskDetail" component=\{TaskDetailScreen\}/)
  // 「今天」这一屏自己已有标题区，隐藏原生标题栏避免两套标题
  assert.match(ROOT_NAV, /name="Today" component=\{TodayScreen\} options=\{\{ headerShown: false \}\}/)
  // 标签指向栈而不是裸屏幕
  assert.match(ROOT_NAV, /<Tab\.Screen\s+name="Today"\s+component=\{TodayStackNavigator\}/)
})

test('两个入口都真的能跳到压力分析（今天的小结入口 + 任务页的可见入口）', () => {
  assert.match(TODAY, /navigation\.navigate\('Pressure'\)/)
  assert.match(TASK_LIST, /navigation\.navigate\('Pressure'\)/)
  // 今天页与任务页都用「两条栈共有」的路由类型，避免再出现「在栈外 navigate」的旧缺陷
  assert.match(TODAY, /SharedTaskRoutes/)
  assert.match(
    NAV_TYPES,
    /export type SharedTaskRoutes = Pick<TodayStackParamList, 'TaskForm' \| 'TaskDetail' \| 'Pressure' \| 'TodayPlan'>/,
  )
})

/* ------------------------- 同一份纯函数结果 ------------------------- */

test('今天页与压力分析页共用同一份纯分析结果，页面里没有重复公式', () => {
  assert.match(TODAY, /analyzeDdlPressure\(/)
  assert.match(SCREEN, /analyzeDdlPressure\(/)
  for (const [name, source] of [
    ['TodayScreen.tsx', TODAY],
    ['PressureScreen.tsx', SCREEN],
  ]) {
    assert.doesNotMatch(source, /estimatedMinutes\s*\?\?|reduce\(.*estimatedMinutes/, `${name} 不得自己算合计`)
    assert.doesNotMatch(source, /isoToShanghaiDateKey\(/, `${name} 的分组必须来自分析结果`)
  }
})

test('今天页的入口是「小结 + 一个按钮」，不是一个塞满首页的大表', () => {
  assert.match(TODAY, /title="DDL 压力分析"/)
  assert.match(TODAY, /label="打开 7 天压力分析"/)
  assert.doesNotMatch(TODAY, /analysis\.days\.map/, '首页不展开 7 天明细')
  assert.match(TODAY, /pressure\.includedCount/)
  assert.match(TODAY, /pressure\.includedKnownMinutes/)
  assert.match(TODAY, /CONCENTRATION_THRESHOLD/)
})

/* ------------------------------ 设置区行为 ------------------------------ */

test('参考用时默认未设置，且界面明确说明「未设置」就是默认', () => {
  assert.match(SCHEMA, /DAILY_STUDY_REFERENCE_MINUTES: 'pressure\.daily_study_reference_minutes'/)
  assert.match(SETTINGS_REPO, /loadDailyStudyReferenceMinutes/)
  assert.match(SETTINGS_REPO, /saveDailyStudyReferenceMinutes/)
  assert.match(SETTINGS_REPO, /clearDailyStudyReferenceMinutes/)
  // 库里脏值按未设置处理（读回时过滤），而不是抛异常
  assert.match(SETTINGS_REPO, /readStoredStudyReferenceMinutes/)
  // 只写这一个键，而且不需要新的迁移版本
  assert.doesNotMatch(MIGRATIONS, /daily_study_reference/, '不得为设置新增迁移 / 表结构变更')
  assert.match(STORE, /loadDailyStudyReferenceMinutes/)
  assert.match(STORE, /saveStudyReferenceMinutes/)
  assert.match(STORE, /studyReferenceMinutes: number \| null/)
})

test('设置提示明确写出「7 天一视同仁」「不自动扣上课时间」「不考虑夜里可用时间」', () => {
  assert.match(SCREEN_RAW, /这个参考值对 7 天一视同仁，不会自动扣掉上课时间，也没有考虑夜里还剩多少时间可用/)
  assert.match(SCREEN, /hint=\{draftError \? undefined : referenceHint\}/)
})

test('清除参考用时需要明确确认，并且不写 0', () => {
  assert.match(SCREEN, /setPendingClear\(true\)/)
  assert.match(SCREEN, /title="清除每日参考用时？"/)
  assert.match(SCREEN, /store\.saveStudyReferenceMinutes\(null\)/)
})

test('保存 / 清除结果如实区分「写入」与「刷新」', () => {
  assert.match(STORE, /refreshError: refreshErrorRef\.current/)
  assert.match(STORE, /refreshErrorRef/)
  assert.match(SCREEN, /resolveStudyReferenceSave/)
})

/* --------------------- 刷新 / 草稿 / 展开状态稳定性 --------------------- */

test('展开状态与设置草稿不会被后台刷新重置', () => {
  // 展开集合只由 toggleDay 改变（不得出现在 refresh / snapshot 相关的 effect 里）
  assert.match(SCREEN, /const \[expandedDates, setExpandedDates\] = useState<ReadonlySet<string>>\(\(\) => new Set<string>\(\)\)/)
  const toggles = [...SCREEN.matchAll(/setExpandedDates\(/g)]
  assert.equal(toggles.length, 1, '只允许 toggleDay 一处改展开状态')
  // 草稿同步必须走纯函数，并且**只在已保存值变化时**才改写
  assert.match(SCREEN, /syncStudyReferenceDraft\(\{ state: previous, observed: observedReference, committed: false \}\)/)
  assert.match(SCREEN, /return next\.changed \? next\.state : previous/)
  // 没有「每次渲染重置草稿」的写法
  assert.doesNotMatch(SCREEN, /setDraftState\(\s*\{\s*draft: studyReferenceToDraft\(store\.studyReferenceMinutes\)/)
})

test('离开时只对**真的有改动**的草稿弹确认（用原生 usePreventRemove 原始动作）', () => {
  assert.match(SCREEN, /usePreventRemove\(dirty \|\| saving \|\| clearing/)
  assert.match(SCREEN, /setPendingLeaveAction\(data\.action\)/)
  assert.match(SCREEN, /navigation\.dispatch\(action\)/, '确认后派发被拦下来的原始导航动作')
  assert.match(SCREEN, /const dirty = guard\.dirty/)
})

test('用既有聚焦时钟处理回到前台 / 跨零点，且逾期比较用真实毫秒', () => {
  assert.match(SCREEN, /useFocusClock\(readShanghaiEpochClock\)/)
  assert.match(SCREEN, /new Date\(clock\.epochMs\)/, '不能把「现在」截断到分钟')
  assert.doesNotMatch(SCREEN, /readShanghaiClock/, '不得再用只有分钟精度的读数还原「现在」')
  assert.match(SCREEN, /lastDateKey\.current === clock\.dateKey/)
  assert.doesNotMatch(SCREEN, /setInterval\(/, '不得在页面里自建定时器')
})

test('今天页与压力页用同一个「真实毫秒」时钟口径（首页小结不会与压力页给出不同逾期数）', () => {
  for (const [name, source] of [
    ['TodayScreen.tsx', TODAY],
    ['PressureScreen.tsx', SCREEN],
  ]) {
    assert.match(source, /useFocusClock\(readShanghaiEpochClock\)/, `${name} 必须读带毫秒的时钟`)
    assert.match(source, /new Date\(clock\.epochMs\)/, `${name} 的「现在」必须来自真实毫秒`)
    assert.doesNotMatch(source, /readShanghaiClock/, `${name} 不得再用只有分钟精度的读数`)
    // 不得再出现「用 dateKey + minutes 拼一个墙上时间」的还原写法
    assert.doesNotMatch(source, /dateKey\}T\$\{/, `${name} 不得从 dateKey/minutes 还原「现在」`)
  }
  // 分钟级读数仍然留给「正在上课 / 下一节」这类高亮
  assert.match(TODAY, /clock\.minutes/, '今天页的课程高亮仍用分钟级读数')
})

test('今天页与压力页都把同一份 now 交给 analyzeDdlPressure（口径一致）', () => {
  assert.match(TODAY, /analyzeDdlPressure\(\{[\s\S]{0,200}?now,\s*\}\)/)
  assert.match(SCREEN, /analyzeDdlPressure\(\{[\s\S]{0,200}?now,\s*\}\)/)
})

test('参考用时输入不做静默截断，超长 / 非法输入当场可见地拒绝', () => {
  assert.doesNotMatch(SCREEN, /maxLength=/, '不得用 maxLength 把粘贴的超长输入悄悄截短')
  assert.match(SCREEN, /error=\{draftError\}/)
  assert.match(SCREEN, /guard\.canSave/)
})

test('保存 / 清除共用**同步**在途闸门，重复点击不会发出第二次写入', () => {
  assert.match(SCREEN, /const inFlightRef = useRef\(false\)/)
  assert.equal(
    [...SCREEN.matchAll(/if \(inFlightRef\.current[^\n]*\) return/g)].length,
    2,
    '保存与清除各拦一次',
  )
  assert.equal([...SCREEN.matchAll(/inFlightRef\.current = true/g)].length, 2)
  assert.equal([...SCREEN.matchAll(/inFlightRef\.current = false/g)].length, 2, 'finally 里必须复位')
  assert.match(SCREEN, /const pending = saving \|\| clearing/)
  assert.match(SCREEN, /editable=\{!pending\}/)
  assert.match(SCREEN, /disabled=\{!guard\.canSave \|\| pending\}/)
})

test('加载 / 刷新失败沿用既有模式：Loading / Error / 重试 / 刷新提示条', () => {
  assert.match(SCREEN, /<LoadingState/)
  assert.match(SCREEN, /<ErrorState/)
  assert.match(SCREEN, /retryBootstrap\(\)/)
  assert.match(SCREEN, /<RefreshErrorBanner/)
})

/* ------------------------------ 内容与口径 ------------------------------ */

test('页头给出日期窗口、纳入条数与不完整披露', () => {
  assert.match(SCREEN, /analysis\.windowStartDateKey/)
  assert.match(SCREEN, /analysis\.windowEndDateKey/)
  assert.match(SCREEN, /analysis\.includedCount/)
  assert.match(SCREEN, /analysis\.includedKnownMinutes/)
  assert.match(SCREEN, /缺预计用时/)
})

test('口径说明逐条写清楚（可用性、已排除、非日程）', () => {
  assert.match(SCREEN_RAW, /已完成与已取消的任务不参与任何一天/)
  assert.match(SCREEN_RAW, /预计用时合计是任务自己填的原始值，不是剩余工作量/)
  assert.match(SCREEN_RAW, /这是按截止日期的集中度统计，不是排好的日程/)
  assert.match(SCREEN_RAW, /不等于「时间一定够」/)
})

test('每一天都给出：条数 / 预计用时合计 / 缺用时条数 / 最早 DDL / 任务集中', () => {
  for (const needle of ['未完成任务', '预计用时合计', '缺预计用时', '最早 DDL', '任务集中']) {
    assert.ok(SCREEN.includes(needle), `每日卡片缺少「${needle}」`)
  }
  assert.match(SCREEN, /day\.concentrationThreshold/)
  assert.match(SCREEN, /任务集中（每天 ≥\$\{day\.concentrationThreshold\} 项）/)
})

test('三种比较结论的文案都在，并且不出现「足够 / 安全 / 一定做得完」', () => {
  assert.match(SCREEN_RAW, /预计用时合计超过参考/)
  assert.match(SCREEN_RAW, /预计用时合计未超过参考/)
  assert.match(SCREEN_RAW, /未设置参考用时/)
  assert.match(SCREEN_RAW, /缺预计用时/)
  // 看**去掉注释之后**的源码：注释里可以写「不允许出现哪些词」，真正渲染的文案里不能有
  for (const banned of ['足够', '安全', '一定做得完', '保证完成', '来得完']) {
    assert.equal(SCREEN.includes(banned), false, `界面文案不得出现「${banned}」`)
  }
})

test('用户可见标签保持简短，口径说明只讲一遍', () => {
  for (const label of ['未完成任务', '任务集中', '预计用时合计', '缺预计用时']) {
    assert.ok(SCREEN_RAW.includes(label), `应该使用简短标签「${label}」`)
  }
  const verbose = [...SCREEN_RAW.matchAll(/不会自动扣掉上课时间/g)]
  assert.equal(verbose.length, 1, '「不会自动扣掉上课时间」这句用户可见的说明只应出现一次（设置区提示）')
})

test('逾期 / 无 DDL / 脏 DDL / 7 天之外都是独立可见区块，且各自说明不重复计数', () => {
  assert.match(SCREEN_RAW, /title="已逾期（未完成）"/)
  assert.match(SCREEN_RAW, /title="没有截止时间（未计入上面的日期）"/)
  assert.match(SCREEN_RAW, /title="截止时间无法识别（需要修复）"/)
  assert.match(SCREEN_RAW, /title="7 天之外"/)
  assert.match(SCREEN_RAW, /不再计入下面的任何一天，避免重复统计/)
})

test('逾期列表默认折叠但有「显示全部」出口（不静默截断）', () => {
  assert.match(SCREEN, /showAllOverdue \? analysis\.overdue : analysis\.overdue\.slice\(0, 5\)/)
  assert.match(SCREEN, /显示全部 \$\{analysis\.overdue\.length\} 条/)
})

test('每条任务都能进详情、也能进编辑页补预计用时（不自动写用时）', () => {
  assert.match(SCREEN, /navigation\.navigate\('TaskDetail', \{ id: task\.id \}\)/)
  assert.match(SCREEN, /navigation\.navigate\('TaskForm', \{ id: task\.id \}\)/)
  assert.match(SCREEN_RAW, /补预计用时/)
  assert.match(SCREEN_RAW, /应用不会替你填/)
  // 不得自动补 / 自动估算用时
  assert.doesNotMatch(SCREEN, /estimatedMinutes\s*=\s*\d/, '界面不得写死用时')
  assert.doesNotMatch(SCREEN, /autoEstimate|suggestEstimate/)
})

test('零数据时给出真实可用的新建任务动作', () => {
  assert.match(SCREEN, /title="这 7 天没有到期的未完成任务"/)
  assert.match(SCREEN, /actionLabel="新建任务"/)
  assert.match(SCREEN, /navigation\.navigate\('TaskForm', \{\}\)/)
})

test('压力分析本身仍然只读：不排日程、不发通知、不自动改任务', () => {
  // 压力分析页（本测试的**范围**）：不得出现自动排日程 / 自动改任务 / 通知 / AI。
  // 允许「不会生成日程 / 不是排好的日程」这类**免责声明**；禁止的是真的去做。
  for (const pattern of [
    /(?<!不会[^，。；]{0,4})(?<!不是[^，。；]{0,4})(生成日程|自动排|自动重排|重排任务|排好的日程)/,
    /dailyPlan|autoReschedule/,
    /Notification|expo-notifications|scheduleNotification/,
    /\bAI\b|openai|gpt|llm|大模型|智能分析/i,
    /冲突检测|classOverlap|overlap/,
  ]) {
    assert.doesNotMatch(SCREEN, pattern, `PressureScreen.tsx 撞上了不该出现的模式：${pattern}`)
  }
  // 压力分析页从不写任务数据，也不会因为「打开这一页」就保存参考用时。
  assert.doesNotMatch(SCREEN, /store\.(createTask|updateTask|deleteTask|changeTaskStatus|toggleTaskComplete|importNoticeCandidates|importSchedules)\(/)
  assert.doesNotMatch(SCREEN, /useEffect\([\s\S]{0,200}?saveStudyReferenceMinutes/)
})

test('今天页对压力分析只做「小结 + 入口」，分析逻辑与写法都没有被搬进首页', () => {
  // 今天页可以有**用户显式点开**的其他功能入口（例如今日学习计划），
  // 但压力分析的规则本身不能被复制到首页：这里只允许展示分析结果，不允许出现排布 / 通知 / AI。
  for (const pattern of [
    /(?<!不会[^，。；]{0,4})(?<!不是[^，。；]{0,4})(生成日程|自动排|自动重排|重排任务|排好的日程)/,
    /dailyPlan|autoReschedule/,
    /Notification|expo-notifications|scheduleNotification/,
    /\bAI\b|openai|gpt|llm|大模型|智能分析/i,
    /冲突检测|classOverlap|overlap/,
  ]) {
    assert.doesNotMatch(TODAY, pattern, `TodayScreen.tsx 撞上了不该出现的模式：${pattern}`)
  }
  // 首页不得出现 SQL；也不得「打开这一页就写库」。
  assert.doesNotMatch(TODAY, /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i)
  assert.doesNotMatch(TODAY, /useEffect\([\s\S]{0,200}?store\.(toggleTaskComplete|deleteTask|changeTaskStatus|createTask|updateTask)\(/)
  // 首页对压力分析只呈现纯函数结果 + 一个入口按钮（压力分析自己不做任何写操作）。
  assert.match(TODAY, /analyzeDdlPressure\(/)
  assert.match(TODAY, /navigation\.navigate\('Pressure'\)/)
  assert.match(TODAY, /navigation\.navigate\('TodayPlan'\)/, '显式点开的今日学习计划入口')
})

test('不做 OCR / 截图，也不引入新的数据库或依赖', () => {
  assert.doesNotMatch(SCREEN, /ocr|OCR|screenshot|Screenshot/)
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

/* ------------------------------ 无障碍与文案 ------------------------------ */

test('关键控件都带中文可访问标签，触控目标沿用 44pt 令牌', () => {
  const labels = (SCREEN.match(/accessibilityLabel=/g) ?? []).length
  assert.ok(labels >= 10, `关键控件都要有 accessibilityLabel，实际 ${labels} 处`)
  assert.match(SCREEN, /MIN_TOUCH_SIZE/)
  assert.match(SCREEN, /accessibilityState=\{\{ expanded \}\}/)
  assert.match(SCREEN, /accessibilityRole="button"/)
})

test('界面文案不出现技术词与字面 Markdown', () => {
  const strings = [...SCREEN_RAW.matchAll(/'([^'\\]*)'/g), ...SCREEN_RAW.matchAll(/"([^"\\]*)"/g)].map(
    (match) => match[1],
  )
  const chinese = strings.filter((text) => /[\u4e00-\u9fa5]/.test(text))
  assert.ok(chinese.length > 0, '必须找到中文界面文案')
  for (const text of chinese) {
    assert.doesNotMatch(text, /数据库|SQL|JSON|API|token/i, `界面文案里不该出现技术词：${text}`)
    assert.doesNotMatch(text, /\*\*/, `界面文案里不写字面 Markdown：${text}`)
  }
})

test('参考用时的保存动作只用 store 的公共串行队列（写 + 刷新严格串行）', () => {
  assert.match(STORE, /const chained = queue\.current\.then\(run, run\)[\s\S]{0,400}?return chained/)
  const referenceSave = STORE.slice(STORE.indexOf('saveStudyReferenceMinutes: async'))
  assert.match(referenceSave.slice(0, 1200), /repos\.settings\.saveDailyStudyReferenceMinutes\(raw\)/)
  assert.match(referenceSave.slice(0, 1200), /if \(!result\.ok\)/)
})
