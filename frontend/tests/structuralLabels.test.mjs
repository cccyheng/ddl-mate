/**
 * 表头/时间栏守卫的纯函数测试（不跑 OCR，毫秒级）。
 *
 * 这条守卫修的是**真机上出现过的故障**：整图回退识别时，OCR 最容易读准表头（周一…周日、
 * 10/12）和左侧时间栏（1、08:00），这些纯标签一旦被当成课程名，用户课表里就会出现
 * 一堆叫「周一」「08:00」的课，而真正的课程一条都没有。
 *
 * 两条铁律都要被测试钉住：
 *   1. 纯标签必须被识别出来（周一 / 10/12 / 08:00 / 第 7 周 / 课表 …）；
 *   2. **绝不能误伤真实课程名**（数字信号处理 / 时间序列分析 / 星期一的科学 / C++ / (3) …）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 前端（Vite / 伴侣服务）走的是转发文件；手机端（Metro）直接用 mobile 里的实现。
// 两个模块都导入进来，是为了钉住「两边永远是同一套行为」这件事。
import * as frontendModule from '../src/ocr/structuralLabels.js'
import * as mobileModule from '../../mobile/src/domain/headerLabels.ts'

import {
  HEADER_ONLY_MESSAGE,
  OcrLayoutError,
  classifyStructuralLabel,
  isHeaderCardText,
  isHeaderOnlyResult,
  isStructuralCandidate,
  isStructuralLabel,
  namePartOf,
} from '../src/ocr/structuralLabels.js'

/** 整段就是标签的样本 → 期望被识别为某个 kind（非 null）。 */
const LABEL_SAMPLES = [
  ['周一', 'weekday'],
  ['周二', 'weekday'],
  ['周日', 'weekday'],
  ['周天', 'weekday'],
  ['星期一', 'weekday'],
  ['星期天', 'weekday'],
  ['週三', 'weekday'],
  ['礼拜五', 'weekday'],
  ['周1', 'weekday'],
  ['周7', 'weekday'],
  ['第7周', 'week'],
  ['第 1-16 周', 'week'],
  ['1-16周', 'week'],
  ['10/12', 'date'],
  ['10-12', 'date'],
  ['10.12', 'date'],
  ['10月12日', 'date'],
  ['2026-10-12', 'date'],
  ['12日', 'date'],
  ['08:00', 'time'],
  ['8：00', 'time'],
  ['08:00-09:35', 'time'],
  ['08:00~09:35', 'time'],
  ['1', 'period'],
  ['10', 'period'],
  ['课表', 'container'],
  ['课程表', 'container'],
  ['上一周', 'container'],
  ['下一周', 'container'],
  ['时间', 'container'],
  ['节次', 'container'],
  ['星期一 | 10/12', 'weekday'],
  ['10/12 周一', 'weekday'],
  ['08:00 08:45', 'weekday'],
]

/** 必须是**真实课程名**的样本 → 期望 `null`（绝不能被拦）。 */
const COURSE_NAME_SAMPLES = [
  '数字信号处理',
  '时间序列分析',
  '星期一的科学',
  '面向对象程序设计(C++)',
  '大学英语(3)',
  '大学物理(B-2)',
  '形势与政策',
  '计算方法与应用',
  'C++程序设计',
  '概率论与数理统计',
  '数据结构实验',
  '侵权行为法',
  '体育(3)',
  '创新思维与创新方法(计算机类)',
  '世界电影艺术',
  '电路与电子技术(双语)',
  '大学物理实验(2)',
  '10月12日作业讲评',
  '1号教学楼导论',
  '第7周的复习课',
  '线性代数B',
  '编译原理课程设计',
]

test('纯标签（星期/日期/时刻/节次/周次/导航）都能被识别', () => {
  for (const [text, expected] of LABEL_SAMPLES) {
    assert.equal(classifyStructuralLabel(text), expected, `「${text}」应当是 ${expected} 标签`)
  }
})

test('真实课程名一个都不能被误判', () => {
  for (const name of COURSE_NAME_SAMPLES) {
    assert.equal(classifyStructuralLabel(name), null, `「${name}」是课程名，不能被当成标签`)
    assert.equal(isStructuralLabel(name), false)
  }
})

test('复杂度兜底：表头被 OCR 拼成一行（含分隔符丢失）时仍然是标签', () => {
  const compoundLabels = [
    '周一 周二 周三 周四 周五 周六 周日',
    '10/12 10/13 10/14 10/15 10/16 10/17 10/18',
    '08:00 08:45 10:00',
    '课表 | 第7周 | 上一周 | 下一周',
    '课表第7周上一周下一周',
    '周一 | 10/12',
    '第1-2节',
    '1-2节',
    '1、2节',
    '08:00-09:35 10:00-11:35',
  ]
  for (const text of compoundLabels) {
    assert.notEqual(classifyStructuralLabel(text), null, `「${text}」应当是结构性标签`)
  }

  // 只要夹了一个"非标签"的词，整段就不能被当成标签。
  const notLabels = [
    '数字信号处理 周三 10:00-11:35',
    '10月12日作业讲评',
    '第7周的复习课',
    '周一见的约定',
    '数学分析2',
  ]
  for (const text of notLabels) {
    assert.equal(classifyStructuralLabel(text), null, `「${text}」不能被当成标签`)
  }
})

test('两处实现必须是同一套行为（转发文件 vs mobile 实现）', () => {
  const exportNames = Object.keys(frontendModule).sort()
  assert.deepEqual(exportNames, Object.keys(mobileModule).sort(), '导出集合必须一致')
  const samples = [...LABEL_SAMPLES.map(([text]) => text), ...COURSE_NAME_SAMPLES, '', '|', null]
  for (const text of samples) {
    assert.equal(
      frontendModule.classifyStructuralLabel(text),
      mobileModule.classifyStructuralLabel(text),
      `「${text}」在两个模块里的判定必须一致`,
    )
  }
})

test('空串 / 空白 / 标点不算标签，也不算课程名', () => {
  for (const text of ['', '   ', null, undefined, '···', '|']) {
    assert.equal(classifyStructuralLabel(text), null)
  }
})

test('候选层面：只有"名字就是标签且没有地点"才算结构性候选', () => {
  assert.equal(isStructuralCandidate({ name: '周一' }), true)
  assert.equal(isStructuralCandidate({ name: '08:00' }), true)
  assert.equal(isStructuralCandidate({ name: '10/12' }), true)
  // 有地点 = 读到的是一块课程卡片（名称恰好叫"周一"的课仍然允许用户自行决定）。
  assert.equal(isStructuralCandidate({ name: '周一', location: '教三 305' }), false)
  assert.equal(isStructuralCandidate({ name: '数字信号处理' }), false)
  assert.equal(isStructuralCandidate({ name: '' }), false)
  assert.equal(isStructuralCandidate(null), false)
})

test('卡片 OCR 文本层面：多行拼接后仍是纯标签才拦', () => {
  assert.equal(isHeaderCardText('周一\n10/12'), true, '「周一 + 10/12」两行拼起来就是表头单元格')
  assert.equal(isHeaderCardText('周一 | 10/12'), true)
  assert.equal(isHeaderCardText('周一'), true)
  assert.equal(isHeaderCardText('08:00'), true)
  assert.equal(isHeaderCardText('08:00\n08:45'), true)
  assert.equal(isHeaderCardText('大学物理(\nB-2)@励志楼-204\n'), false)
  assert.equal(isHeaderCardText(''), false)
  assert.equal(isHeaderCardText(null), false)
})

test('整批结果全是标签 → headerOnly；只要有一条真课程就不算', () => {
  const headerOnly = isHeaderOnlyResult([{ name: '周一' }, { name: '10/12' }, { name: '08:00' }])
  assert.equal(headerOnly.headerOnly, true)
  assert.equal(headerOnly.structural, 3)

  const mixed = isHeaderOnlyResult([{ name: '周一' }, { name: '数字信号处理' }])
  assert.equal(mixed.headerOnly, false)
  assert.equal(mixed.structural, 1)

  assert.equal(isHeaderOnlyResult([]).headerOnly, false)
  assert.equal(isHeaderOnlyResult([{ name: '' }]).headerOnly, false)
})

test('名称拆分：@ 后面是地点，不参与标签判断', () => {
  assert.equal(namePartOf('周一@教三305'), '周一')
  assert.equal(namePartOf('数字信号处理@教三305'), '数字信号处理')
})

test('OcrLayoutError 带机器可读的 code 与版面信息', () => {
  const error = new OcrLayoutError(HEADER_ONLY_MESSAGE, { layout: 'week-grid', headerOnly: 2 })
  assert.equal(error.name, 'OcrLayoutError')
  assert.equal(error.code, 'STRUCTURE_NOT_FOUND')
  assert.equal(error.layout, 'week-grid')
  assert.equal(error.headerOnly, 2)
  assert.match(error.message, /表头与时间栏/)
})
