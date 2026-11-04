// 通知原文的**原生适配层**：独立任务标题行的保守切分 + 类型显式映射。
//
// 这一层是为了补上「复制来的解析器」在原生场景下的两个真实缺口（独立复核点名）：
//   1. 用户一次粘一整段、没有序号、没有空行时，两门课两条作业会被合并成一条候选；
//   2. 解析器会给出 `LAB` / `REPORT` 这类**原生任务类型里没有**的值。
//
// 自律：宁可少分，不可错分；不改复制来的解析器。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NATIVE_TASK_TYPE_LABELS,
  looksLikeNoticeTaskHeading,
  mapNoticeTaskType,
  preSplitNoticeText,
  splitIndependentNoticeTasks,
} from '../src/domain/noticeTextAdapter.ts'
import { noticeRowsFromCandidates, noticeRowToTaskDraft, parseNoticeSource } from '../src/domain/noticeImport.ts'

const courses = [
  { id: 1, name: '数据结构', code: 'CS101' },
  { id: 2, name: '英语', code: 'EN101' },
]

/* ------------------------- 标题行识别（逐条边界） ------------------------- */

test('标题行识别：短标签 + 冒号才算，附加信息与叙述性开头都不算', () => {
  // 真实标题（冒号后面可以带日期时间，时间属于任务内容）
  assert.equal(looksLikeNoticeTaskHeading('数据结构作业：请于2026年10月18日22:00前提交实验报告。'), true)
  assert.equal(looksLikeNoticeTaskHeading('英语作文：明天交'), true)
  assert.equal(looksLikeNoticeTaskHeading('高数实验报告: 见附件'), true)
  // 带数字编号的标签刻意**不**当作标题行：`1.` / `①` 这类序号交给解析器既有的
  // `SEGMENT_START_PATTERNS` 处理（适配层碰它只会把序号行切坏）。
  assert.equal(looksLikeNoticeTaskHeading('1. 数据结构作业：2026年10月20日 22:00 前提交'), false)
  assert.equal(looksLikeNoticeTaskHeading('英语作文一：明天交'), false)
  // 附加信息标签不是新任务
  assert.equal(looksLikeNoticeTaskHeading('提交要求：实验报告PDF'), false)
  assert.equal(looksLikeNoticeTaskHeading('截止时间：2026年10月18日'), false)
  assert.equal(looksLikeNoticeTaskHeading('邮箱：a@b.cn'), false)
  // 叙述性开头 / 称呼 / 没有任务名词
  assert.equal(looksLikeNoticeTaskHeading('各位同学：请注意'), false)
  assert.equal(looksLikeNoticeTaskHeading('通知：下周停课'), false)
  assert.equal(looksLikeNoticeTaskHeading('关于期末考试的通知：见教务系统'), false)
  // 标签里带日期时间（不是任务名）
  assert.equal(looksLikeNoticeTaskHeading('2026年10月18日 22:00：提交报告'), false)
  // 没有冒号 / 冒号后为空
  assert.equal(looksLikeNoticeTaskHeading('数据结构作业请于2026年10月18日22:00前提交'), false)
  assert.equal(looksLikeNoticeTaskHeading('数据结构作业：'), false)
})

/* ---------------------------- 保守切分行为 ---------------------------- */

test('两门课的两条标题行被切成两条（复核复现的真实缺陷）', () => {
  const text = [
    '数据结构作业：请于2026年10月18日22:00前提交实验报告。',
    '英语作业：请于2026年10月19日18:00前提交作文。',
  ].join('\n')
  const chunks = preSplitNoticeText(text)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0].text.startsWith('数据结构作业'))
  assert.ok(chunks[1].text.startsWith('英语作业'))

  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.candidates.length, 2)
  assert.equal(summary.candidates[0].deadline, '2026-10-18T22:00')
  assert.equal(summary.candidates[1].deadline, '2026-10-19T18:00')
  assert.equal(summary.candidates[0].courseId, 1)
  assert.equal(summary.candidates[1].courseId, 2)
})

test('折行续写的正文不会被切开（邮箱 / 提交要求 / 附件紧跟上一行）', () => {
  const text = [
    '软件工程课程设计：请于2026年10月18日18:00前发送到',
    'a+b@example.edu.cn，主题写学号。',
    '提交要求：实验报告PDF',
  ].join('\n')
  const chunks = preSplitNoticeText(text)
  assert.equal(chunks.length, 1, JSON.stringify(chunks))
  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.candidates.length, 1)
  assert.equal(summary.candidates[0].deadline, '2026-10-18T18:00')
  assert.ok(summary.candidates[0].rawText.includes('a+b@example.edu.cn'))
  assert.ok(summary.candidates[0].rawText.includes('提交要求'))
})

test('上一行明显没写完时不分（`…提交到` ／ `…邮箱是`）', () => {
  const wrapped = ['数据结构作业：请于2026年10月18日22:00前提交到', '英语作业：学习通'].join('\n')
  const chunks = preSplitNoticeText(wrapped)
  assert.equal(chunks.length, 1, JSON.stringify(chunks))
})

test('序号条目仍然是序号条目（不因为适配层而改变既有分段）', () => {
  const text = ['1. 数据结构作业：2026年10月20日 22:00 前提交', '2. 英语作业：2026年11月3日 14:00 前提交'].join('\n')
  const chunks = splitIndependentNoticeTasks(text)
  const summary = parseNoticeSource(text, courses)
  assert.equal(summary.candidates.length, 2)
  assert.equal(summary.candidates[0].deadline, '2026-10-20T22:00')
  assert.equal(summary.candidates[1].deadline, '2026-11-03T14:00')
  // 序号行本身以数字开头，不是「短标签 + 冒号」，因此适配层不额外切分
  assert.equal(chunks.length, 1)
})

test('不确定的内容仍然合成一条（宁可少分，不可错分）', () => {
  const ambiguous = [
    '各位同学请注意：本周的作业安排如下',
    '具体情况见附件，有问题问助教。',
    '另外下周的讲座时间待定。',
  ].join('\n')
  const chunks = preSplitNoticeText(ambiguous)
  assert.equal(chunks.length, 1, JSON.stringify(chunks))
})

test('分出来的碎片组必须每一组都真的有任务线索，否则整块保持原样', () => {
  // 第二组只有寒暄，没有动作词 / 任务名词 → 不采纳切分
  const text = ['数据结构作业：提交报告。', '祝大家学习顺利。'].join('\n')
  const chunks = preSplitNoticeText(text)
  assert.equal(chunks.length, 1, JSON.stringify(chunks))
})

/* ------------------------------ 类型映射 ------------------------------ */

test('解析器的 LAB / REPORT 显式映射成原生类型，不做 cast-only', () => {
  const lab = mapNoticeTaskType('LAB')
  assert.equal(lab.type, 'PROJECT')
  assert.equal(lab.mapped, true)
  assert.ok(lab.note.includes('LAB'))

  const report = mapNoticeTaskType('REPORT')
  assert.equal(report.type, 'PROJECT')
  assert.equal(report.mapped, true)

  // 本来就是原生类型：原样保留，不标记为映射
  for (const type of ['HOMEWORK', 'EXAM', 'READING', 'PRESENTATION', 'ADMIN', 'OTHER']) {
    const mapping = mapNoticeTaskType(type)
    assert.equal(mapping.type, type)
    assert.equal(mapping.mapped, false)
    assert.equal(mapping.note, '')
  }
})

test('未知类型落到 OTHER 并如实说明，不会变成非法类型', () => {
  for (const raw of ['NOTICE_SOMETHING', '', null, undefined]) {
    const mapping = mapNoticeTaskType(raw)
    assert.equal(mapping.type, 'OTHER')
    assert.equal(mapping.mapped, true)
    assert.ok(mapping.note.includes('其它'))
  }
})

test('映射说明会写进任务说明，方便保存后核对；说明放不下时不截断正文', () => {
  const summary = parseNoticeSource('数据结构实验：请于2026年10月18日22:00前提交实验报告。', courses)
  const rows = noticeRowsFromCandidates(summary.candidates, courses)
  assert.equal(rows[0].type, 'PROJECT')
  assert.equal(rows[0].mappedFromType, 'LAB')
  assert.ok(rows[0].hints.some((hint) => hint.includes('LAB')))

  const draft = noticeRowToTaskDraft(rows[0])
  assert.equal(draft.type, 'PROJECT')
  assert.ok(draft.description.includes(rows[0].segmentText.trim()))
  assert.ok(draft.description.includes('LAB'), draft.description)

  // 说明已经接近上限时：只保留原文，不把映射说明硬塞进去（也就不会超长）
  const longRow = { ...rows[0], segmentText: 'x'.repeat(990) }
  const longDraft = noticeRowToTaskDraft(longRow)
  assert.equal(longDraft.description.length, 990)
  assert.ok(!longDraft.description.includes('LAB'))
})

test('每一种原生类型都有中文名（保存结果可以照着核对）', () => {
  for (const [type, label] of Object.entries(NATIVE_TASK_TYPE_LABELS)) {
    assert.ok(label.length > 0, type)
  }
})
