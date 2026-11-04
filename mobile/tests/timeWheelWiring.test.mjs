// 原生日期 / 时钟浮窗滚轮的接线守卫（静态断言，对着实际源码文本）。
//
// 这里锁的是复核点名的行为与用户要求：
// - 所有日期 / 时钟输入都迁到原生浮窗滚轮，数量输入与自由时间短语保持原样；
// - 浮层只用 Modal + ScrollView 吸附，不引入新依赖 / WebView；
// - 滚轮最终位置（drag end / momentum end）先同步父级选中值，再谈对齐；
// - 日期 / 时刻弹层的确定读同步 ref，不读上一帧 state；
// - 初始 contentOffset 不在每次选择时重设；程序化滚动不被中间 onScroll 覆盖；
// - 取消 / 遮罩 / 返回丢弃草稿；disabled 与行身份变化时不提交；
// - 选日期不补时刻，清除时刻保留日期，清除日期不伪造有效截止时间。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = join(here, '..')

const read = (relativePath) => readFileSync(join(mobileRoot, relativePath), 'utf8')

/** 去掉注释，避免注释里的说明被当成真实产品行为。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 从原始源码（含注释标记）里切出一段，再对切出的代码去注释。 */
function section(source, start, end) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `没有找到片段起点：${start}`)
  const to = source.indexOf(end, from + start.length)
  assert.ok(to > from, `没有找到片段终点：${end}`)
  return stripComments(source.slice(from, to))
}

const UI_RAW = read('src/ui/timeWheel.tsx')
const UI = stripComments(UI_RAW)
const DATE_FIELD_RAW = read('src/ui/datetimeField.tsx')
const DATE_FIELD = stripComments(DATE_FIELD_RAW)
const TASK = stripComments(read('src/screens/TaskFormScreen.tsx'))
const NOTICE = stripComments(read('src/screens/NoticeImportScreen.tsx'))
const ASSISTANT = stripComments(read('src/ui/timeAssistant.tsx'))
const SCHEDULE = stripComments(read('src/screens/ScheduleFormScreen.tsx'))
const PHOTO = stripComments(read('src/screens/PhotoReviewScreen.tsx'))
const TODAY = stripComments(read('src/screens/TodayPlanScreen.tsx'))

test('浮层是原生 Modal + ScrollView 吸附滚轮，没有 WebView / 新选择器依赖', () => {
  assert.match(UI, /from 'react-native'/)
  assert.match(UI, /<Modal/)
  assert.match(UI, /onRequestClose=\{onCancel\}/)
  assert.match(UI, /<ScrollView/)
  assert.match(UI, /snapToInterval=\{WHEEL_ITEM_HEIGHT\}/)
  assert.match(UI, /decelerationRate="fast"/)
  assert.match(UI, /WHEEL_ITEM_HEIGHT = 44/)
  assert.match(UI, /WHEEL_VISIBLE_ITEMS = 5/)
  assert.match(UI, /paddingVertical: WHEEL_PADDING/)
  assert.doesNotMatch(UI, /WebView|react-native-web|dangerouslySetInnerHTML/)

  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.dependencies['@react-native-picker/picker'], undefined)
  assert.equal(pkg.dependencies['@react-native-community/datetimepicker'], undefined)
})

test('年 / 月 / 日 / 时 / 分滚轮齐全，选中行有居中高亮，初始值能滚到可见位置', () => {
  assert.match(UI, /values=\{WHEEL_YEARS\}/)
  assert.match(UI, /values=\{WHEEL_MONTHS\}/)
  assert.match(UI, /values=\{days\}/)
  assert.match(UI, /values=\{WHEEL_HOURS\}/)
  assert.match(UI, /values=\{WHEEL_MINUTES\}/)
  assert.match(UI, /index === safeIndex/)
  assert.match(UI, /wheelItemTextSelected/)
  assert.match(UI, /wheelHighlight/)
  assert.match(UI, /contentOffset=\{initialOffsetRef\.current\}/)
  assert.match(UI, /onContentSizeChange=\{positionInitial\}/)
  assert.doesNotMatch(UI, /contentOffset=\{\{ x: 0, y: safeIndex/, 'contentOffset 不能随每次选择重设')
})

test('滚轮最终位置会回写父级：momentum end 与无惯性 drag end 都同步', () => {
  const column = section(UI_RAW, 'function WheelColumn(', '/* -------------------------------- 浮层骨架')
  assert.match(column, /const syncSelection = useCallback/)
  assert.match(column, /onScrollEndDrag=\{handleScrollEndDrag\}/)
  assert.match(column, /onMomentumScrollBegin=\{handleMomentumBegin\}/)
  assert.match(column, /onMomentumScrollEnd=\{handleMomentumEnd\}/)

  const dragEnd = section(UI_RAW, 'const handleScrollEndDrag', 'const handleMomentumBegin')
  assert.match(dragEnd, /syncSelection\(readOffset\(event\)\)/)

  const momentumEnd = section(UI_RAW, 'const handleMomentumEnd', 'const selectIndex')
  assert.match(momentumEnd, /syncSelection\(offset\)/)
  assert.match(momentumEnd, /if \(Math\.abs\(offset - settled \* WHEEL_ITEM_HEIGHT\) > 0\.5\)/)
  assert.ok(
    momentumEnd.indexOf('syncSelection(offset)') < momentumEnd.indexOf('scrollToIndex(settled, false)'),
    'momentum end 必须先把最终位置交给父级，再做对齐',
  )
  assert.doesNotMatch(momentumEnd, /scrollToIndex\(settled, true\)\s*\n\s*\},/, '不能只对齐而不回写')
})

test('程序化滚动不覆盖目标；拖动 / 惯性期间外部 effect 不抢滚动', () => {
  const column = section(UI_RAW, 'function WheelColumn(', '/* -------------------------------- 浮层骨架')
  assert.match(column, /if \(programmaticRef\.current !== null\) return/)
  assert.match(column, /programmaticRef\.current = animated \? index : null/)
  assert.match(column, /onScrollBeginDrag=\{handleScrollBeginDrag\}/)
  assert.match(column, /draggingRef\.current = true/)
  assert.match(column, /momentumRef\.current = true/)
  assert.match(column, /if \(draggingRef\.current \|\| momentumRef\.current\) return/, 'effect 不能在用户滚动时回滚')
  assert.match(column, /const initialOffsetRef = useRef\(\{ x: 0, y: safeIndex \* WHEEL_ITEM_HEIGHT \}\)/)
})

test('日期弹层的确定读同步 ref：滚动回调后立即确定不会提交上一帧', () => {
  const dateSheet = section(UI_RAW, 'export function DateWheelSheet', '/* -------------------------------- 时钟滚轮')
  assert.match(dateSheet, /const partsRef = useRef<WheelDateParts>\(parts\)/)
  assert.match(dateSheet, /const clamped = clampWheelDate\(next\)/)
  assert.ok(
    dateSheet.indexOf('partsRef.current = clamped') < dateSheet.indexOf('setParts(clamped)'),
    '先写同步 ref，再 setState',
  )
  assert.match(dateSheet, /onConfirm=\{\(\) => onConfirm\(formatWheelDate\(partsRef\.current\)\)\}/)
  assert.doesNotMatch(dateSheet, /onConfirm=\{\(\) => onConfirm\(formatWheelDate\(parts\)\)\}/)
  assert.match(dateSheet, /onChange=\{changeYear\}/)
  assert.match(dateSheet, /onChange=\{changeMonth\}/)
  assert.match(dateSheet, /onChange=\{changeDay\}/)
})

test('时钟弹层的确定读同步 ref，且日期钳制在 ref 里完成', () => {
  const clockSheet = section(UI_RAW, 'export function ClockWheelSheet', '/* ------------------------------- 表单单字段')
  assert.match(clockSheet, /const partsRef = useRef<WheelClockParts>\(parts\)/)
  assert.ok(
    clockSheet.indexOf('partsRef.current = next') < clockSheet.indexOf('setParts(next)'),
    '先写同步 ref，再 setState',
  )
  assert.match(clockSheet, /onConfirm=\{\(\) => onConfirm\(formatWheelClock\(partsRef\.current\)\)\}/)
  assert.match(clockSheet, /values=\{WHEEL_MINUTES\}/)
  assert.match(clockSheet, /精确到每一分钟/)
})

test('取消 / 返回 / 点遮罩丢弃草稿；清除与确定都在底部可见操作里', () => {
  assert.match(UI, /accessibilityLabel="取消滚轮选择"/)
  assert.match(UI, /onPress=\{onCancel\}/)
  assert.match(UI, /label="取消"/)
  assert.match(UI, /label="确定"/)
  assert.match(UI, /clearLabel && onClear/)
  assert.match(UI, /accessibilityHint="关闭浮窗并丢弃这次滚轮改动"/)
  assert.match(UI, /useSafeAreaInsets/)
  assert.match(UI, /paddingBottom: Math\.max\(insets\.bottom, spacing\.md\)/)
})

test('打开弹层只记身份、不写回；确定 / 清除才调用 onChange', () => {
  const wallOpen = section(DATE_FIELD_RAW, 'const openPicker = useCallback', 'const closePicker')
  assert.doesNotMatch(wallOpen, /onChange\(/, '打开日期 / 时钟浮层时不能写表单')
  assert.match(wallOpen, /openIdentityRef\.current = identityKey/)

  assert.match(DATE_FIELD, /const commitDate = useCallback/)
  assert.match(DATE_FIELD, /withWallClockDate\(value, nextDate\)/)
  assert.match(DATE_FIELD, /const commitTime = useCallback/)
  assert.match(DATE_FIELD, /withWallClockTime\(value, nextTime\)/)
  assert.match(DATE_FIELD, /const clearTime = useCallback/)
  assert.match(DATE_FIELD, /clearWallClockTime\(value\)/)
  assert.match(DATE_FIELD, /const clearDate = useCallback/)
  assert.match(DATE_FIELD, /clearWallClockDate\(value\)/)

  const commitDateBlock = section(DATE_FIELD_RAW, 'const commitDate = useCallback', 'const commitTime')
  assert.doesNotMatch(commitDateBlock, /shanghaiNowWallClock|18:00|23:59/, '选日期不能自动补时刻')
})

test('disabled / 行身份变化时不提交旧滚轮值；重开按当前值初始化', () => {
  assert.match(DATE_FIELD, /if \(disabled \|\| openIdentityRef\.current !== identityKey\) setPicker\(null\)/)
  assert.match(DATE_FIELD, /if \(disabled \|\| openIdentityRef\.current !== identityKey\)/)
  assert.match(UI, /if \(disabled \|\| openIdentityRef\.current !== identityKey\) setOpen\(false\)/)
  assert.match(UI, /if \(disabled \|\| openIdentityRef\.current !== identityKey\) \{/)
  // 条件挂载 => 每次打开都是新的 useState 初值，不会沿用上次草稿。
  assert.match(DATE_FIELD, /\{picker === 'date' \? \(/)
  assert.match(DATE_FIELD, /\{picker === 'clock' \? \(/)
  assert.match(UI, /\{open \? \(/)
})

test('可选截止时间口径保留：日期可单独保存，清除时刻保留日期', () => {
  assert.match(DATE_FIELD, /allowDateOnly = false/)
  assert.match(DATE_FIELD, /isDateWithoutTime/)
  assert.match(DATE_FIELD, /时间可留空：按 \{date\} 当天截止/)
  assert.match(DATE_FIELD, /不会替你猜 18:00 或 23:59/)
  assert.match(DATE_FIELD, /清除时间（保留日期）/)
  assert.match(DATE_FIELD, /清除日期与时间/)
  assert.match(TASK, /allowDateOnly/)
  assert.match(TASK, /showQuickFill/)
  assert.match(TASK, /identityKey=\{`task:/)
})

test('六个入口全部接入滚轮字段；截图 / 课表 / 今日时段都带行身份', () => {
  assert.match(TASK, /<WallClockField/)
  assert.match(TASK, /onChange=\{\(value\) => update\('deadline', value\)\}/)

  const noticeField = section(NOTICE, '<WallClockField', '/>')
  assert.match(noticeField, /label="截止时间"/)
  assert.match(noticeField, /value=\{row\.deadline\}/)
  assert.match(noticeField, /identityKey=\{`notice:\$\{row\.rowIndex\}`\}/)
  assert.doesNotMatch(noticeField, /allowDateOnly/, '通知导入仍要求具体时刻')

  const assistantField = section(ASSISTANT, '<WallClockField', '/>')
  assert.match(assistantField, /label="通知参考时间"/)
  assert.match(assistantField, /identityKey="time-assistant-reference"/)
  assert.doesNotMatch(assistantField, /allowDateOnly/)

  assert.match(SCHEDULE, /<TimeWheelField/)
  assert.match(SCHEDULE, /onChange=\{\(value\) => onEditEntryField\('startTime', value\)\}/)
  assert.match(SCHEDULE, /onChange=\{\(value\) => onEditEntryField\('endTime', value\)\}/)
  assert.match(SCHEDULE, /identityKey=\{`weekday:\$\{draft\.activeWeekday\}`\}/)

  assert.match(PHOTO, /<TimeWheelField/)
  assert.match(PHOTO, /patchRow\(row\.id, \{ startTime: value \}\)/)
  assert.match(PHOTO, /patchRow\(row\.id, \{ endTime: value \}\)/)
  assert.match(PHOTO, /identityKey=\{`photo-row:\$\{row\.id\}`\}/)

  assert.match(TODAY, /<TimeWheelField/)
  assert.match(TODAY, /setStudyWindow\(previous\.draft, index, 'start', text\)/)
  assert.match(TODAY, /setStudyWindow\(previous\.draft, index, 'end', text\)/)
  assert.match(TODAY, /identityKey=\{`today-window:/)
})

test('所有屏幕不再保留时钟文本输入；数量与自由短语仍是原输入', () => {
  const screenDir = join(mobileRoot, 'src/screens')
  const offenders = []
  for (const file of readdirSync(screenDir).filter((name) => name.endsWith('.tsx'))) {
    const source = stripComments(readFileSync(join(screenDir, file), 'utf8'))
    if (/placeholder="HH:mm"|placeholder="08:00"|placeholder="09:30"|keyboardType="numbers-and-punctuation"/.test(source)) {
      offenders.push(file)
    }
  }
  assert.deepEqual(offenders, [], `这些屏幕仍有钟点文本输入：${offenders.join('、')}`)

  assert.match(TASK, /label="预计用时（分钟）"[\s\S]{0,240}?keyboardType="number-pad"/)
  assert.match(TODAY, /label="本次安排分钟数"[\s\S]{0,240}?keyboardType="number-pad"/)
  assert.match(ASSISTANT, /label="时间短语"/)
  assert.match(ASSISTANT, /<AppTextField[\s\S]{0,160}?label="时间短语"/)
})

test('无障碍：可点字段有标签，滚轮有 adjustable 当前值与加减动作', () => {
  assert.match(UI, /accessibilityRole="adjustable"/)
  assert.match(UI, /accessibilityValue=\{\{ text: formatValue\(selectedValue\) \}\}/)
  assert.match(UI, /accessibilityActions=\{\[\{ name: 'increment' \}, \{ name: 'decrement' \}\]\}/)
  assert.match(UI, /onAccessibilityAction=/)
  assert.match(UI, /accessibilityLabel=\{`\$\{accessibilityLabel \?\? label\}，当前/)
  assert.match(UI, /accessibilityHint=\{accessibilityHint\}/)
  assert.match(DATE_FIELD, /accessibilityLabel=\{`\$\{label\}的日期`\}/)
  assert.match(DATE_FIELD, /accessibilityLabel=\{`\$\{label\}的时间`\}/)
})
