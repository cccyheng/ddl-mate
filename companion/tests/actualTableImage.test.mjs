/**
 * 真实手机原图的端到端验收（`.tools/photo/phone-20261012-122524/input.png`）。
 *
 * 这张图是用户实际拍到的**横版有线框课表**：左侧节次 1-2/3-4/5-6/7-8/9-10，
 * 表头星期一…星期日，蓝底格子是课，星期五 5-6 节那格上下两门课，星期日那一格纵向合并（1-4 节）。
 *
 * 两个测试：
 *   1. 纯几何（不跑 OCR，秒级）：网格线 → 行列带 → 19 个有课格子、星期日合并 2 行；
 *   2. 真实 OCR（秒级~十几秒）：跑产品同一条流水线，对照**人工目视抄录**逐条核对
 *      名称 / 星期 / 起止时刻 / 教学周与单双周 / 地点。
 *
 * 下面这份 EXPECTED 是人工目视抄录，**只用于验收断言**；产品代码（含
 * frontend/src/ocr/*、companion/src/*）从不读取它，也没有任何课程名字典。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { analyzeTableGridGeometry, cellInkRatio } from '../../frontend/src/ocr/tableGridLayout.js'
import { decodeImage } from '../src/imageCodec.mjs'
import { OcrEngine } from '../src/ocrEngine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const IMAGE_PATH = join(workspaceRoot, '.tools', 'photo', 'phone-20261012-122524', 'input.png')

/** [星期, 课程名, 开始, 结束, 起始周, 结束周, 单双周, 地点核心] */
const EXPECTED = [
  [1, '大学物理(B-2)', '08:00', '09:35', 1, 16, 'ALL', '励志楼-204'],
  [1, '电路与电子技术(双语)', '10:00', '11:35', 1, 16, 'ALL', '学汇楼-412'],
  [1, '大学英语(3)', '13:30', '15:05', 3, 18, 'ALL', '四海楼-101'],
  [1, '侵权行为法', '18:00', '19:35', 1, 16, 'ALL', '学汇楼-101'],
  [2, '计算方法与应用', '08:00', '09:35', 1, 15, 'ODD', '四海楼-406'],
  [2, '专业导论(计算机)', '10:00', '11:35', 1, 8, 'ALL', '学汇楼-108'],
  [2, '创新思维与创新方法(计算机类)', '13:30', '15:05', 1, 8, 'ALL', '德济楼-103'],
  [2, '马克思主义基本原理', '15:30', '17:05', 1, 16, 'ALL', '学汇楼-302'],
  [3, '数据结构', '08:00', '09:35', 1, 16, 'ALL', '德济楼-103'],
  [3, '大学物理(B-2)', '10:00', '11:35', 1, 16, 'ALL', '励志楼-204'],
  [4, '创新思维与创新方法(计算机类)', '08:00', '09:35', 1, 8, 'ALL', '德济楼-103'],
  [4, '面向对象程序设计(C++)', '10:00', '11:35', 1, 16, 'ALL', '扬帆楼-102'],
  [4, '世界电影艺术', '13:30', '15:05', 1, 16, 'ALL', '远航楼-1区303'],
  [4, '电路与电子技术(双语)', '15:30', '17:05', 1, 16, 'ALL', '学汇楼-412'],
  [5, '大学物理实验(2)', '08:00', '09:35', 1, 12, 'ALL', '基础楼-数理楼物理实验6'],
  [5, '数据结构实验', '10:00', '11:35', 6, 17, 'ALL', '扬帆楼-101'],
  [5, '马克思主义基本原理', '13:30', '15:05', 1, 15, 'ODD', '学汇楼-302'],
  [5, '数据结构', '13:30', '15:05', 2, 16, 'EVEN', '德济楼-103'],
  [5, '计算方法与应用', '15:30', '17:05', 1, 16, 'ALL', '四海楼-406'],
  [7, '形势与政策', '08:00', '11:35', 7, 8, 'ALL', '百川楼-103'],
]

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\s()（）\-—–·、,，.。]/g, '')
    .toLowerCase()
}

test('真实原图几何：19 个有课格子、星期日纵向合并 2 行', () => {
  const image = decodeImage(readFileSync(IMAGE_PATH))
  assert.equal(image.width, 2868)
  assert.equal(image.height, 1320)

  const geometry = analyzeTableGridGeometry(image)
  assert.equal(geometry.matched, true, geometry.reason)
  assert.equal(geometry.horizontal.length, 7)
  assert.equal(geometry.vertical.length, 9)
  assert.equal(geometry.rowBands.length, 6) // 1 行表头 + 5 行节次
  assert.equal(geometry.columnBands.length, 8) // 1 列节次 + 7 列星期

  const sunday = geometry.cells.find((cell) => cell.colIndex === 7 && cell.rowStart === 1)
  assert.ok(sunday, '星期日那一列应该有格子')
  assert.equal(sunday.mergedRows, 2, '星期日 1-4 节是一个纵向合并格')

  const occupied = geometry.cells.filter(
    (cell) => cell.colIndex >= 1 && cell.rowStart >= 1 && cellInkRatio(geometry.ink, geometry.width, cell) >= 0.004,
  )
  assert.equal(occupied.length, 19, '19 个有课格子（20 条课程里有两条共用一个格子）')
})

test('真实原图 OCR：20 条课程，名称/星期/时刻/教学周与单双周/地点全对', { timeout: 600_000 }, async () => {
  const image = decodeImage(readFileSync(IMAGE_PATH))
  const engine = new OcrEngine()
  try {
    const result = await engine.recognizeTimetable(image, { isCancelled: () => false })

    assert.equal(result.cancelled, false)
    assert.equal(result.layout, 'table-grid')
    assert.equal(result.week, null, '这张图没有"第 N 周"标题，不能编一个显示周次')
    assert.equal(result.candidates.length, 20, JSON.stringify(result.candidates.map((c) => c.name)))
    assert.equal(
      new Set(result.candidates.map((candidate) => normalize(candidate.name))).size,
      14,
      '14 门不同课程',
    )

    const remaining = [...result.candidates]
    for (const [weekday, name, startTime, endTime, startWeek, endWeek, weekPattern, location] of EXPECTED) {
      const label = `周${weekday} ${startTime}「${name}」`
      const index = remaining.findIndex(
        (candidate) =>
          candidate.weekday === weekday &&
          candidate.startTime === startTime &&
          normalize(candidate.name) === normalize(name),
      )
      assert.notEqual(index, -1, `${label} 未识别到（当前候选：${JSON.stringify(remaining.map((c) => `${c.weekday}/${c.startTime}/${c.name}`))}）`)
      const found = remaining.splice(index, 1)[0]
      assert.equal(found.endTime, endTime, `${label} 结束时刻`)
      assert.deepEqual(
        [found.startWeek, found.endWeek, found.weekPattern],
        [startWeek, endWeek, weekPattern],
        `${label} 教学周/单双周`,
      )
      assert.ok(normalize(found.location).includes(normalize(location)), `${label} 地点（实际 ${found.location}）`)
      // 课程号 / 老师不能被拼进课程名
      assert.ok(!/\d{6,}/.test(found.name), `${label} 名称里混进了课程号`)
    }
    assert.equal(remaining.length, 0, `多出来的候选：${JSON.stringify(remaining.map((c) => c.name))}`)
    assert.equal(result.diagnostics?.twoCourseCells, 1, '星期五 5-6 节那一格应识别出两门课')
    assert.equal(result.diagnostics?.missingPeriodCells, 0)
  } finally {
    await engine.terminate()
  }
})
