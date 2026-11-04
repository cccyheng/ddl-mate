// 手动课表「第几周到第几周」的接线守卫（静态断言，对着源码文本）。
//
// 锁的是本轮用户点名要的行为：
// - 表单不再把起止周藏在两个数字输入框里，而是给出可点选的起止周控件；
// - 选择器真的覆盖 1–53 周、44pt、可滚动、当前选中周清楚；
// - 周次与单双周的组合校验接入既有领域规则，不静默改范围；
// - 编辑既有 / 导入的周次范围、学期起点与单双周原样保留。
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

const SCREEN = stripComments(read('src/screens/ScheduleFormScreen.tsx'))
const PICKER = stripComments(read('src/ui/weekRangeField.tsx'))
const RULES = stripComments(read('src/domain/scheduleRules.ts'))
const DRAFT = stripComments(read('src/domain/courseDraft.ts'))

test('表单用可点选的起止周控件，不再要求用户猜两个数字输入框', () => {
  assert.match(SCREEN, /<WeekRangeField/, '必须渲染新的起止周选择控件')
  assert.match(SCREEN, /onChangeStart=\{onPickStartWeek\}/)
  assert.match(SCREEN, /onChangeEnd=\{onPickEndWeek\}/)
  assert.match(SCREEN, /每周（不限周次）/, '「每周」口径要明确且容易选')
  assert.match(SCREEN, /指定第几周到第几周/, '选项本身就说清楚是第几周到第几周')
  assert.match(SCREEN, /已选范围/)
  assert.match(SCREEN, /weekSummary/, '选好后要有紧凑的范围摘要')

  assert.doesNotMatch(SCREEN, /label="起始教学周"/, '起止周不能再退回文本输入')
  assert.doesNotMatch(SCREEN, /label="结束教学周"/)
  assert.doesNotMatch(SCREEN, /onEditTerm\(\{ startWeek: text \}\)/)
  assert.doesNotMatch(SCREEN, /onEditTerm\(\{ endWeek: text \}\)/)
})

test('选择器覆盖 1–53 周、44pt、可滚动，当前选中周有明确状态', () => {
  assert.match(PICKER, /MIN_TEACHING_WEEK/)
  assert.match(PICKER, /MAX_TEACHING_WEEK/)
  assert.match(PICKER, /WEEK_OPTIONS/)
  assert.match(PICKER, /<Modal/)
  assert.match(PICKER, /<ScrollView/)
  assert.match(PICKER, /minHeight: MIN_TOUCH_SIZE/, '可点周次与关闭按钮至少 44pt')
  assert.match(PICKER, /weekScroll/, '小屏时列表必须能滚动')
  assert.match(PICKER, /accessibilityRole="radio"/)
  assert.match(PICKER, /accessibilityState=\{\{ selected \}\}/)
  assert.match(PICKER, /weekCellSelected/)
  assert.match(PICKER, /sheetCurrent/, '弹层里要写明当前选择的是第几周')
  assert.match(PICKER, /起始周/)
  assert.match(PICKER, /结束周/)
})

test('没有替用户默认新范围；编辑/导入的起止周与单双周原样带回', () => {
  assert.match(SCREEN, /multidayDraftFromSchedule/)
  assert.match(SCREEN, /termModeOf\(next\)/)
  assert.match(SCREEN, /draft\.startWeek/)
  assert.match(SCREEN, /draft\.endWeek/)
  assert.match(SCREEN, /draft\.weekPattern/)
  assert.match(SCREEN, /resolveSemesterAnchor/, '全局/记录自己的学期起点解析必须保留')

  // 切到「指定」时不能偷偷塞一个第 1–16 周之类的默认范围。
  const modeBlock = /const onPickTermMode[\s\S]*?\n  \}, \[\]\)/.exec(SCREEN)?.[0] ?? ''
  assert.ok(modeBlock.length > 0, '没有找到 onPickTermMode')
  assert.doesNotMatch(modeBlock, /startWeek:\s*'1'/)
  assert.doesNotMatch(modeBlock, /endWeek:\s*'16'/)
  assert.doesNotMatch(modeBlock, /semesterStartDate:\s*''/)
})

test('周次范围与单双周校验复用既有领域规则，空规则会被拒绝而不是扩范围', () => {
  assert.match(SCREEN, /validateMultidayDraft/)
  assert.match(SCREEN, /hasApplicableWeekInRange/)
  assert.match(SCREEN, /parityWarning/)

  assert.match(RULES, /export function hasApplicableWeekInRange/)
  assert.match(RULES, /没有可上课的周/)
  assert.match(DRAFT, /weekPattern: draft\.weekPattern/, '保存校验必须把单双周一起交给 validateTermRange')
  assert.match(DRAFT, /没有可上课的周/, '空规则要落到 weekPattern 字段错误')
})

test('没有重新引入学期第一周周一或节次输入框', () => {
  assert.doesNotMatch(SCREEN, /label="学期第一周周一"/)
  assert.doesNotMatch(SCREEN, /label="开始节次"/)
  assert.doesNotMatch(SCREEN, /label="结束节次"/)
  assert.doesNotMatch(SCREEN, /periodStart|periodEnd/)
})

test('本轮仍然只用原生 Modal / ScrollView / Pressable，没有新增选择器依赖', () => {
  assert.match(PICKER, /from 'react-native'/)
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies['@react-native-picker/picker'], undefined)
  assert.equal(pkg.dependencies['@react-native-community/datetimepicker'], undefined)
})
