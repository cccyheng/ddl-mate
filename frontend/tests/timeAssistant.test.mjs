/**
 * V1.2 时间助手的前端单测（纯 Node，不依赖浏览器）。
 *
 * 覆盖三件事：
 *   1. 业务时区换算：全部用显式 timeZone 计算，**运行电脑在 UTC 还是上海结果一致**；
 *   2. 「过期建议」守卫：短语 / 参考时间 / 课程 / DDL 变化或组件卸载后，迟到的响应不能被采用；
 *   3. 接线守卫（源码级）：TaskForm / ImportNoticesView 必须走「显式采用才写入」，
 *      且不能把全局的 fromDatetimeLocal / toDatetimeLocal 改坏（其它入口仍在用）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  isoToShanghaiWallClock,
  isValidShanghaiWallClock,
  shanghaiDeadlineLabel,
  shanghaiNowWallClock,
  shanghaiWallClockToOffset,
  SHANGHAI_ZONE,
} from '../src/utils/datetime.js'
import {
  TIME_ASSISTANT_EXAMPLES,
  canAdoptSuggestion,
  createResolutionGate,
  panelToggleInvalidates,
  resolveStatusLabel,
  timeAssistantContext,
} from '../src/utils/timeAssistantGuards.js'

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')

/* ------------------------------------------------------------ 时区换算 */

test('业务时区固定 Asia/Shanghai', () => {
  assert.equal(SHANGHAI_ZONE, 'Asia/Shanghai')
})

test('带偏移量的 ISO → 上海墙上时间（与本机时区无关）', () => {
  assert.equal(isoToShanghaiWallClock('2026-10-15T10:10:00+08:00'), '2026-10-15T10:10')
  // 02:10Z 就是上海 10:10：在 UTC 浏览器里也必须得到 10:10，而不是 02:10
  assert.equal(isoToShanghaiWallClock('2026-10-15T02:10:00Z'), '2026-10-15T10:10')
  // 纽约时间 2026-10-14T22:10-04:00 同样是上海 10-15 10:10
  assert.equal(isoToShanghaiWallClock('2026-10-14T22:10:00-04:00'), '2026-10-15T10:10')
})

test('不带偏移的墙上时间原样保留，不经过 new Date（避免本机时区搬运）', () => {
  assert.equal(isoToShanghaiWallClock('2026-10-15T10:10'), '2026-10-15T10:10')
  assert.equal(isoToShanghaiWallClock('2026-10-15 10:10'), '2026-10-15T10:10')
  assert.equal(isoToShanghaiWallClock(''), '')
  assert.equal(isoToShanghaiWallClock('不是时间'), '')
})

test('datetime-local 值 → +08:00 ISO，严格校验日期与时分', () => {
  assert.equal(shanghaiWallClockToOffset('2026-10-12T18:00'), '2026-10-12T18:00:00+08:00')
  assert.equal(shanghaiWallClockToOffset('2026-10-12 18:00'), '2026-10-12T18:00:00+08:00')
  assert.equal(shanghaiWallClockToOffset('2026-02-30T10:00'), null, '2 月 30 日不存在')
  assert.equal(shanghaiWallClockToOffset('2027-02-29T10:00'), null, '2027 不是闰年')
  assert.equal(shanghaiWallClockToOffset('2028-02-29T10:00'), '2028-02-29T10:00:00+08:00')
  assert.equal(shanghaiWallClockToOffset('2026-13-01T10:00'), null)
  assert.equal(shanghaiWallClockToOffset('2026-10-12T25:00'), null)
  assert.equal(shanghaiWallClockToOffset('2026-10-12T18:75'), null)
  assert.equal(shanghaiWallClockToOffset(''), null)
  assert.equal(isValidShanghaiWallClock('2026-10-12T18:00'), true)
  assert.equal(isValidShanghaiWallClock('2026-10-12T18:00:30'), true)
})

test('「现在的北京时间」：UTC 时刻也能得到上海的墙上时间', () => {
  assert.equal(shanghaiNowWallClock(new Date('2026-10-10T00:30:00Z')), '2026-10-10T08:30')
  assert.equal(shanghaiNowWallClock(new Date('2026-10-09T16:30:00Z')), '2026-10-10T00:30')
})

test('北京时间可读标签带星期（周一开头）', () => {
  assert.equal(shanghaiDeadlineLabel('2026-10-12T18:00:00+08:00'), '2026-10-12 18:00 周一')
  assert.equal(shanghaiDeadlineLabel('2026-10-11T08:30:00+08:00'), '2026-10-11 08:30 周日')
})

/* ------------------------------------------------------------ 过期结果保护 */

test('上下文指纹：短语 / 参考时间 / 课程 / DDL 任一变化都会变', () => {
  const base = { text: '明天 18:00', referenceAt: '2026-10-10T12:00', courseId: 1, deadline: '' }
  const same = { ...base, text: ' 明天 18:00 ' }
  assert.equal(timeAssistantContext(base), timeAssistantContext(same), '首尾空白不算变化')
  assert.notEqual(timeAssistantContext(base), timeAssistantContext({ ...base, text: '明天 19:00' }))
  assert.notEqual(timeAssistantContext(base), timeAssistantContext({ ...base, referenceAt: '2026-10-10T13:00' }))
  assert.notEqual(timeAssistantContext(base), timeAssistantContext({ ...base, courseId: 2 }))
  assert.notEqual(timeAssistantContext(base), timeAssistantContext({ ...base, courseId: null }))
  assert.notEqual(timeAssistantContext(base), timeAssistantContext({ ...base, deadline: '2026-10-11T18:00' }))
})

test('解析闸门：只有「同一序号 + 同一上下文」的响应才算当前', () => {
  const gate = createResolutionGate()
  const token = gate.begin('A')
  assert.equal(gate.isCurrent(token, 'A'), true)
  assert.equal(gate.isCurrent(token, 'B'), false, '上下文变了不能采用')
  // 新的解析开始后，旧响应不能再写回
  gate.begin('B')
  assert.equal(gate.isCurrent(token, 'A'), false)
  // 依赖被改动 / 组件卸载：invalidate 后一律不可用
  const second = gate.snapshot().token
  gate.invalidate()
  assert.equal(gate.isCurrent(second, 'B'), false)
})

test('慢响应场景：先发的请求晚回来不能覆盖新结果', () => {
  const gate = createResolutionGate()
  const slow = gate.begin(timeAssistantContext({ text: '明天 18:00', courseId: null }))
  const fast = gate.begin(timeAssistantContext({ text: '后天 09:00', courseId: null }))
  const slowContext = timeAssistantContext({ text: '明天 18:00', courseId: null })
  const fastContext = timeAssistantContext({ text: '后天 09:00', courseId: null })
  // 「后天 09:00」先回来：可以采用
  assert.equal(gate.isCurrent(fast, fastContext), true)
  // 「明天 18:00」后回来：必须丢弃
  assert.equal(gate.isCurrent(slow, slowContext), false)
})

test('canAdoptSuggestion：禁用 / 无结果 / 已过期都不能采用', () => {
  assert.equal(canAdoptSuggestion({ disabled: false, hasResult: true, current: true }), true)
  assert.equal(canAdoptSuggestion({ disabled: true, hasResult: true, current: true }), false, '保存期间禁止采用')
  assert.equal(canAdoptSuggestion({ disabled: false, hasResult: false, current: true }), false)
  assert.equal(canAdoptSuggestion({ disabled: false, hasResult: true, current: false }), false, '过期建议禁止采用')
})

test('关闭助手面板后作废在途请求与已展示建议，重新展开看不到旧候选', () => {
  // 规则本身：关闭必须作废，展开本身不作废
  assert.equal(panelToggleInvalidates(false), true, '关闭必须作废')
  assert.equal(panelToggleInvalidates(true), false, '展开不作废')

  const gate = createResolutionGate()
  const context = timeAssistantContext({ text: '明天 18:00', courseId: null })
  const inFlight = gate.begin(context)
  // 与组件 onToggle 一致：关闭时先判定再 invalidate
  if (panelToggleInvalidates(false)) gate.invalidate()
  // 关闭期间回来的响应
  assert.equal(gate.isCurrent(inFlight, context), false, '关闭后的迟到响应不能被采用')
  // 重新展开只是重新开始：必须重新解析，旧 token 永远失效
  const reopened = gate.begin(context)
  assert.equal(gate.isCurrent(inFlight, context), false, '重新展开后旧建议仍然无效')
  assert.equal(gate.isCurrent(reopened, context), true, '重新解析后的结果才有效')
})

test('状态文案与快捷填词都覆盖后端四态', () => {
  assert.equal(resolveStatusLabel('RESOLVED'), '已解析出候选时间')
  assert.equal(resolveStatusLabel('NEEDS_INFO'), '还需要补充信息')
  assert.equal(resolveStatusLabel('UNSUPPORTED'), '这种说法暂不支持')
  assert.equal(resolveStatusLabel('NO_COURSE_MATCH'), '课表里没有匹配的课')
  assert.ok(TIME_ASSISTANT_EXAMPLES.length >= 4)
  assert.ok(TIME_ASSISTANT_EXAMPLES.every((item) => item.text && item.label))
})

/* ------------------------------------------------------------ 接线守卫（源码级） */

test('TimeAssistant.vue：用闸门保护迟到响应，只有「采用此时间」才 emit', () => {
  const source = read('../src/components/TimeAssistant.vue')
  assert.match(source, /createResolutionGate/)
  assert.match(source, /gate\.isCurrent\(token, context\)/)
  assert.match(source, /gate\.invalidate\(\)/)
  assert.match(source, /resolvedKey\.value === contextKey\.value/)
  assert.match(source, /采用此时间/)
  assert.match(source, /emit\('apply'/)
  assert.match(source, /Asia\/Shanghai|北京时间/)
})

test('TimeAssistant.vue：关闭折叠面板即作废在途请求与已展示建议', () => {
  const source = read('../src/components/TimeAssistant.vue')
  assert.match(source, /@toggle="onToggle"/, 'toggle 必须走 onToggle')
  assert.match(source, /panelToggleInvalidates\(isOpen\)/, '关闭时按规则作废')
  assert.match(source, /if \(panelToggleInvalidates\(isOpen\)\) invalidate\(/, '关闭时调用 invalidate')
})

test('TimeAssistant.vue：界面只讲用户需要的信息，不出现实现术语', () => {
  const source = read('../src/components/TimeAssistant.vue')
  // 只看模板（注释里说明内部实现是可以的，界面上不能出现）
  const template = source.slice(source.indexOf('<template>'))
  assert.doesNotMatch(template, /提交给后端的参考时间/, '不要暴露参考时间的 ISO')
  assert.doesNotMatch(template, /只读|不写库/, '不要解释接口读写语义')
  assert.doesNotMatch(template, /会被直接丢弃|期间如果改了/, '不要解释请求序号机制')
  assert.match(template, /才会填入/, '保留「点采用才填入」')
  assert.match(template, /北京时间/, '保留北京时间说明')
  assert.match(template, /通知发布时间/, '保留「可改为通知发布时间」')
  assert.match(template, /信息不足时只提示补全/, '保留「缺失信息不会猜」')
  assert.match(template, /支持哪些写法/, '支持范围放进较短帮助')
  assert.match(template, /v-if="error"/, '保留错误反馈')
  assert.match(template, /result\.message/, '保留无匹配 / 需补信息的原因')
})

test('TaskForm.vue：DDL 走北京时间，并接入可折叠时间助手', () => {
  const source = read('../src/components/TaskForm.vue')
  assert.match(source, /isoToShanghaiWallClock\(props\.initial\?\.deadline\)/)
  assert.doesNotMatch(source, /toDatetimeLocal/)
  assert.match(source, /<TimeAssistant/)
  assert.match(source, /@apply="applyAssistantTime"/)
  assert.match(source, /form\.deadline = payload\.deadline/)
})

test('TaskFormView.vue：提交时显式补 +08:00，不再走本机时区', () => {
  const source = read('../src/views/TaskFormView.vue')
  assert.match(source, /shanghaiWallClockToOffset\(payload\.deadline\)/)
  assert.doesNotMatch(source, /fromDatetimeLocal/)
})

test('ImportNoticesView.vue：助手只在显式采用后改候选，并复用 markEdited', () => {
  const source = read('../src/views/ImportNoticesView.vue')
  assert.match(source, /onAssistantDeadline/)
  assert.match(source, /markEdited\(candidate, 'deadline'\)/)
  assert.match(source, /<TimeAssistant[\s\S]*?:disabled="saving"/)
  // 不得为了助手去改候选生成身份 / 冲突 / stale 规则
  assert.match(source, /mergeSourceCandidates/)
})

test('其它入口不受影响：任务列表筛选仍在用本机时区的 fromDatetimeLocal', () => {
  const source = read('../src/views/TaskListView.vue')
  assert.match(source, /fromDatetimeLocal\(filters\.dueFrom\)/)
})

test('noticeParser.js 的默认保守逻辑没有被本功能改动（仍不用 23:59 兜底）', () => {
  const source = read('../src/ocr/noticeParser.js')
  assert.match(source, /绝不拿系统当前年份、当前日期或 23:59 去猜/)
  assert.match(source, /deadlineNoTime/)
  assert.doesNotMatch(source, /\?\?\s*'23:59'|\|\|\s*'23:59'/, '不得用 23:59 兜底')
})
