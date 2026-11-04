// 通知原文 → 待办候选：**解析 + 纯映射**测试。
//
// 这里验证的是「保守、可解释」这条主线的真实用例：
//   - 多任务中文通知各自带自己的时间，互不串联；
//   - 消息头（聊天发送时间）永远不是 DDL；
//   - 无年份 / 相对说法 / 不存在的日期 / 多组都像截止 → **留空**并给提示；
//   - 邮箱与 URL 原样保留；
//   - 课程歧义（同名长度冲突）→ 不关联任何课程；
//   - 超过单次上限时**明确报警**，而不是悄悄砍掉最后几条。
//
// 另外覆盖纯映射层：说明字段放不下时留空、课程被删掉时可见地标出来、
// 原文超出 10000 字时拒绝而不是截断。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_NOTICE_SOURCE_CHARS,
  MAX_NOTICE_TASKS,
  noticeRowToTaskDraft,
  noticeRowsFromCandidates,
  noticeSourceLengthError,
  parseNoticeSource,
  validateNoticeImportRows,
} from '../src/domain/noticeImport.ts'
import { NOTICE_HINTS } from '../src/domain/noticeParser.js'

const courses = [
  { id: 7, name: '数据结构', code: 'CS201' },
  { id: 8, name: '大学物理', code: 'PH101' },
]

/**
 * 真实的群公告写法：群名 + 消息头 + 三条编号任务，最后一条没有时间。
 *
 * 注意课程名写在**任务那一行**里（`数据结构作业三`）：解析器只对单条任务做
 * 「完全一致」的课程匹配，群名里的「数据结构课程群」不会用来猜课程 —— 这是有意的保守行为。
 */
const GROUP_NOTICE = [
  '数据结构课程群',
  '2026年10月8日 09:12 张老师',
  '',
  '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
  '2. 大学物理第三次作业：2026年11月3日 14:00 前交纸质稿',
  '3. 选课确认表交到教务处',
].join('\n')

test('多任务中文通知：每条各自成候选，时间不互串', () => {
  const summary = parseNoticeSource(GROUP_NOTICE, courses)
  assert.equal(summary.overflow, false)
  assert.equal(summary.candidates.length, 3)
  assert.equal(summary.candidates[0].deadline, '2026-10-20T22:00')
  assert.equal(summary.candidates[1].deadline, '2026-11-03T14:00')
  assert.equal(summary.candidates[2].deadline, '', '第三条没有时间：不能借用上一条的')
  assert.equal(summary.candidates[0].courseId, 7)
  assert.equal(summary.candidates[1].courseId, 8)
  // 消息头（2026年10月8日 09:12）绝不能被当成任何一条的截止时间
  for (const candidate of summary.candidates) {
    assert.notEqual(candidate.deadline, '2026-10-08T09:12')
  }
})

test('群名里的课程名不会替任务猜课程：只有任务那一行完全一致才关联', () => {
  const text = ['数据结构课程群', '2026年10月8日 09:12 张老师', '第三次作业请在 2026年10月20日 22:00 前提交到学习通'].join(
    '\n',
  )
  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.candidates.length, 1)
  assert.equal(summary.candidates[0].deadline, '2026-10-20T22:00')
  assert.equal(summary.candidates[0].courseId, null, '群名不算任务里的课程线索')
  assert.ok(summary.candidates[0].hints.includes(NOTICE_HINTS.courseUnmatched))
})

test('消息头日期与真正的 DDL 同时存在时只认 DDL', () => {
  const text = ['2026-10-08 08:30 王老师：', '通知时间：2026-10-08 08:30', '截止：2026-10-15 22:00 前提交实验报告'].join('\n')
  const summary = parseNoticeSource(text, courses)
  const withDeadline = summary.candidates.filter((candidate) => candidate.deadline)
  assert.ok(withDeadline.length >= 1, '至少要有一条解析出截止时间')
  for (const candidate of withDeadline) assert.equal(candidate.deadline, '2026-10-15T22:00')
})

test('只有一个月日（没有年份）→ 留空并提示缺年份', () => {
  const summary = parseNoticeSource('选课确认表请在 10月15日 交到教务处，过期不补。', courses)
  assert.ok(summary.candidates.length >= 1)
  for (const candidate of summary.candidates) {
    assert.equal(candidate.deadline, '')
    assert.ok(candidate.hints.includes(NOTICE_HINTS.deadlineNoYear), candidate.hints.join('|'))
  }
})

test('相对说法（明天 / 下周五 / 下节课前）→ 留空并提示，不按当前日期猜', () => {
  for (const text of ['明天下午交实验报告', '下周五前交作业', '下节课前把预习报告写好带过来']) {
    const summary = parseNoticeSource(text, courses)
    assert.ok(summary.candidates.length >= 1, text)
    for (const candidate of summary.candidates) {
      assert.equal(candidate.deadline, '', text)
      assert.ok(candidate.hints.length > 0, text)
    }
  }
})

test('不存在的日期 / 非法时刻 → 留空并提示，不会落一个假日期', () => {
  for (const text of ['2026年2月30日 23:59 截止', '2026-10-15 25:00 截止']) {
    const summary = parseNoticeSource(text, courses)
    for (const candidate of summary.candidates) {
      assert.equal(candidate.deadline, '', text)
      assert.ok(candidate.hints.some((hint) => hint.includes('不存在') || hint.includes('忽略')), text)
    }
  }
})

test('多组完整时间都像截止 → 留空并提示需要用户自己选', () => {
  const summary = parseNoticeSource('提交截止 2026年10月15日 22:00，补交截止 2026年10月20日 22:00', courses)
  for (const candidate of summary.candidates) {
    assert.equal(candidate.deadline, '')
    assert.ok(candidate.hints.includes(NOTICE_HINTS.deadlineAmbiguous), candidate.hints.join('|'))
  }
})

test('邮箱与 URL 原样保留，不被标点切碎，也不会变成垃圾任务', () => {
  const text = [
    '2026年10月9日 15:40 李老师',
    '课程设计开题报告请于 2026年10月18日 18:00 前发送到',
    'a+b@example.edu.cn，主题写学号。',
    '入口见 https://example.edu/eval?term=2026F 。',
  ].join('\n')
  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.candidates.length, 1)
  const candidate = summary.candidates[0]
  assert.equal(candidate.deadline, '2026-10-18T18:00')
  assert.equal(candidate.submitMethod, 'a+b@example.edu.cn')
  assert.ok(candidate.rawText.includes('https://example.edu/eval?term=2026F'))
})

test('课程歧义：真同名同长时拒绝关联；能唯一确定较长的课名时按最长匹配', () => {
  // 真歧义（两条课程名都被文本包含且长度相同）→ 解析器拒绝关联，留给用户选
  const ambiguous = [
    { id: 1, name: '数据结构', code: 'A' },
    { id: 2, name: '大学物理', code: 'B' },
    { id: 3, name: '大学化学', code: 'C' },
  ]
  const tied = parseNoticeSource('数据结构作业：2026年10月20日 22:00 前提交 大学物理与大学化学', ambiguous)
  for (const candidate of tied.candidates) {
    // 文本里同时出现两门同长课程名 → 不猜
    if (candidate.rawText.includes('大学物理与大学化学')) assert.equal(candidate.courseId, null)
  }

  // 最长匹配优先：更具体的长名会赢过长名的一部分（与解析器既有语义一致）
  const overlapping = parseNoticeSource('大学化学作业：2026年10月20日 22:00 前提交', [
    { id: 1, name: '大学物理', code: 'B' },
    { id: 2, name: '大学化学', code: 'C' },
  ])
  assert.equal(overlapping.candidates[0].courseId, 2)
})

test('非群聊的简单说明文字：有任务线索就给一条候选，没有就不给垃圾候选', () => {
  const meaningful = parseNoticeSource('下周三前把选课确认表交到教务', courses)
  assert.equal(meaningful.candidates.length, 1)
  assert.equal(meaningful.candidates[0].deadline, '')
  assert.ok(meaningful.candidates[0].hints.length > 0)

  const junk = parseNoticeSource('（合成示例图，不是真实聊天记录）', courses)
  assert.deepEqual(
    junk.candidates.map((candidate) => candidate.title).filter((title) => title.length > 0),
    [],
    '纯页脚说明不该产生候选',
  )
})

test('超过上限：明确 overflow 报警，只返回上限条，不假装全导了', () => {
  const atLimit = Array.from(
    { length: MAX_NOTICE_TASKS },
    (_, index) => `${index + 1}. 作业${index + 1}：2026年10月10日 10:00 前交`,
  ).join('\n')
  const exactly = parseNoticeSource(atLimit, courses)
  assert.equal(exactly.candidates.length, MAX_NOTICE_TASKS)
  assert.equal(exactly.overflow, false, '正好等于上限不算超')

  const overLimit = `${atLimit}\n${MAX_NOTICE_TASKS + 1}. 作业${MAX_NOTICE_TASKS + 1}：2026年10月11日 10:00 前交`
  const overflowed = parseNoticeSource(overLimit, courses)
  assert.equal(overflowed.candidates.length, MAX_NOTICE_TASKS)
  assert.equal(overflowed.overflow, true, '超过上限必须显式报警')
})

/* ------------------------------- 纯映射层 ------------------------------- */

test('映射层：候选 → 行草稿，课程关联、类型、时间与只读片段都在', () => {
  const summary = parseNoticeSource('数据结构第三次作业：2026年10月20日 22:00 前提交到学习通', courses)
  const rows = noticeRowsFromCandidates(summary.candidates, courses)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].courseId, 7)
  assert.equal(rows[0].courseMissing, false)
  assert.equal(rows[0].type, 'HOMEWORK')
  assert.equal(rows[0].deadline, '2026-10-20T22:00')
  assert.equal(rows[0].selected, true)
  assert.ok(rows[0].segmentText.includes('数据结构'))
  const draft = noticeRowToTaskDraft(rows[0])
  assert.equal(draft.courseId, 7)
  assert.equal(draft.deadline, '2026-10-20T22:00')
  assert.equal(draft.description, rows[0].segmentText.trim(), '能放下时整段作为说明')
})

test('映射层：课程在本机被删掉时可见地标出来，而不是静默变成「未关联」', () => {
  const summary = parseNoticeSource('数据结构第三次作业：2026年10月20日 22:00 前提交', courses)
  const rows = noticeRowsFromCandidates(summary.candidates, []) // 课程全没了
  assert.equal(rows[0].courseMissing, true)
  assert.equal(rows[0].courseId, null)
  const validation = validateNoticeImportRows(rows, [])
  assert.equal(validation.selectedCount, 1)
  const messages = Object.values(validation.fieldErrors)
  assert.ok(messages.some((message) => message.includes('已经找不到')), messages.join('|'))
})

test('映射层：说明放不下时留空并标记，原文仍然完整保留在行上', () => {
  const long = `1. 作业：2026年10月20日 22:00 前提交 ${'补充说明'.repeat(260)}`
  assert.ok(long.length > 1000)
  const summary = parseNoticeSource(long, courses)
  assert.equal(summary.candidates.length, 1)
  const rows = noticeRowsFromCandidates(summary.candidates, courses)
  assert.equal(rows[0].descriptionFits, false, '放不下要如实标出来')
  assert.equal(noticeRowToTaskDraft(rows[0]).description, '', '放不下就留空，不截断成半句')
  assert.equal(rows[0].segmentText, summary.candidates[0].rawText, '行上仍保留完整原文段')
})

test('映射层：没勾选任何一条时给出可见的错误，而不是静默保存 0 条', () => {
  const summary = parseNoticeSource(GROUP_NOTICE, courses)
  const rows = noticeRowsFromCandidates(summary.candidates, courses).map((row) => ({ ...row, selected: false }))
  const validation = validateNoticeImportRows(rows, courses)
  assert.equal(validation.selectedCount, 0)
  assert.ok(validation.fieldErrors.selection)
})

test('映射层：标题为空的行会被拦下来（带行号）', () => {
  const summary = parseNoticeSource(GROUP_NOTICE, courses)
  const rows = noticeRowsFromCandidates(summary.candidates, courses)
  rows[1] = { ...rows[1], title: '   ' }
  const validation = validateNoticeImportRows(rows, courses)
  const key = `row:${rows[1].rowIndex}:title`
  assert.ok(validation.fieldErrors[key], JSON.stringify(validation.fieldErrors))
  assert.ok(validation.fieldErrors[key].includes(`第 ${rows[1].rowIndex} 行`))
})

test('原文长度上限：超了明确报错，绝不静默截断', () => {
  assert.equal(noticeSourceLengthError('短原文'), null)
  assert.equal(noticeSourceLengthError('x'.repeat(MAX_NOTICE_SOURCE_CHARS)), null)
  const tooLong = 'x'.repeat(MAX_NOTICE_SOURCE_CHARS + 1)
  const error = noticeSourceLengthError(tooLong)
  assert.ok(error)
  assert.ok(error.includes(String(tooLong.length)))
  assert.ok(error.includes(String(MAX_NOTICE_SOURCE_CHARS)))
  assert.ok(error.includes('不会替你截断'))
})

test('超长原文：解析不会被调用方悄悄截断（这里显式验证解析函数本身不截断输入）', () => {
  // 解析函数不做长度校验（校验在映射/仓库层），但**不能**把输入改短再解析：
  // 两条任务都在，说明文本是原样交给解析器的。
  const text = [
    `1. ${'长'.repeat(6000)}作业：2026年10月20日 22:00 前提交`,
    `2. ${'长'.repeat(6000)}实验：2026年11月3日 14:00 前提交`,
  ].join('\n')
  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.sourceText, text, '原文原样保留，不做任何截断')
  assert.ok(summary.candidates.length >= 1)
})
