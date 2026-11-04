/**
 * 「有线框表格」版式与单元格解析的单元测试（纯函数，不需要 OCR / 不需要网络）。
 *
 * 覆盖：
 *   1. 课程号 / 老师 / 周次 / 地点**绝不拼进课程名**（真机上最容易出的错）；
 *   2. 一个格子里两门课能切成两条（星期五 5-6 节就是这种格子）；
 *   3. 左侧节次格「1-2 + 8:00-9:35」→ 节次范围与时刻；
 *   4. 合成线框表格图：横竖线 → 行列带 → 单元格、以及"隔线缺失 = 纵向合并"；
 *   5. 反向守卫：卡片式周视图（深底 + 彩色卡片）不能被判成线框表格，
 *      线框表格也不能被判成卡片周视图 —— 版式路由据此选择流水线。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeTableGridGeometry,
  cellInkRatio,
  nameLooksClean,
  parseCellFieldLines,
  parseGutterCellText,
  parseTableCellText,
  rowSpanForCell,
  splitCellTextIntoEntries,
  weekClausesFromText,
  weeksFromText,
} from '../src/ocr/tableGridLayout.js'
import { chooseTimetableLayout } from '../src/ocr/timetableLayout.js'
import { analyzeWeekGridGeometry } from '../src/ocr/weekGridOcr.js'

/* ------------------------------ 合成像素 ------------------------------ */

function blankImage(width, height, color = { r: 255, g: 255, b: 255 }) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = color.r
    data[i * 4 + 1] = color.g
    data[i * 4 + 2] = color.b
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

function fillRect(image, x0, y0, x1, y1, color) {
  for (let y = Math.max(0, y0); y <= Math.min(image.height - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(image.width - 1, x1); x += 1) {
      const index = (y * image.width + x) * 4
      image.data[index] = color.r
      image.data[index + 1] = color.g
      image.data[index + 2] = color.b
      image.data[index + 3] = 255
    }
  }
}

/** 一张 3 列 × 3 行（表头 + 两行节次）的合成线框表格，第三列下面两行合并。 */
function makeBorderedTable() {
  const image = blankImage(400, 300)
  const black = { r: 0, g: 0, b: 0 }
  const blue = { r: 120, g: 150, b: 220 }
  for (const x of [20, 120, 250, 380]) fillRect(image, x, 20, x + 3, 280, black)
  for (const y of [20, 60, 280]) fillRect(image, 20, y, 380, y + 3, black)
  // 中间那条隔线只跨前两列：第三列因此纵向合并
  fillRect(image, 20, 170, 250, 173, black)
  // 两块"有课"的蓝底格子 + 里面的深色文字条
  fillRect(image, 124, 64, 248, 166, blue)
  fillRect(image, 254, 64, 378, 278, blue)
  fillRect(image, 140, 90, 220, 100, black)
  fillRect(image, 140, 120, 200, 130, black)
  fillRect(image, 270, 120, 360, 130, black)
  return image
}

/** 卡片式周视图：深底 + 彩色卡片（与 weekGridLayout.test.mjs 同构）。 */
function makeCardGridImage({ width = 700, height = 1400, columns = 7 } = {}) {
  const background = { r: 25, g: 25, b: 25 }
  const cardColor = { r: 69, g: 110, b: 236 }
  const image = blankImage(width, height, background)
  const gutter = Math.round(width * 0.08)
  const columnWidth = (width - gutter) / columns
  const cardWidth = Math.round(columnWidth * 0.72)
  const top = Math.round(height * 0.2)
  const rowHeight = Math.round((height - top) / 5)
  const cardHeight = Math.round(rowHeight * 0.86)
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < 5; row += 1) {
      const x0 = Math.round(gutter + column * columnWidth + (columnWidth - cardWidth) / 2)
      const y0 = top + row * rowHeight
      fillRect(image, x0, y0, x0 + cardWidth, y0 + cardHeight, cardColor)
    }
  }
  return image
}

/* ------------------------------ 文本规则 ------------------------------ */

const PHONE_CELLS = [
  ['大学物理(B-2)(9913000172.08)\n(李华)\n(1-16,励志楼-204 (多媒体) (西山校区))', '大学物理(B-2)', '李华', '1-16', 'ALL', '励志楼-204'],
  ['电路与电子技术(双语)(9913030310.02)\n(周文静)\n(1-16,学汇楼-412 (多媒体) (西山校区))', '电路与电子技术(双语)', '周文静', '1-16', 'ALL', '学汇楼-412'],
  ['大学英语(3)(9913027703.04)\n(王文娟)\n(3-18,四海楼-101 (多媒体) (西山校区))', '大学英语(3)', '王文娟', '3-18', 'ALL', '四海楼-101'],
  ['计算方法与应用(9913030380.02)\n(王芳)\n(单1-15,四海楼-406 (多媒体) (西山校区))', '计算方法与应用', '王芳', '1-15', 'ODD', '四海楼-406'],
  ['专业导论(计算机)(9913018280.01)\n(郑雅琴,吴建国)\n(1-8,学汇楼-108(多媒体)(西山校区))', '专业导论(计算机)', '郑雅琴,吴建国', '1-8', 'ALL', '学汇楼-108'],
  ['创新思维与创新方法(计算机类)(9913030460.01)\n(陈媛媛)\n(1-8,德济楼-103 (多媒体) (西山校区))', '创新思维与创新方法(计算机类)', '陈媛媛', '1-8', 'ALL', '德济楼-103'],
  ['大学物理实验(2)(9913000192.B0)\n(林秀英)\n(1-12,基础楼-数理楼物理实验6(东山校区))', '大学物理实验(2)', '林秀英', '1-12', 'ALL', '基础楼-数理楼物理实验6'],
  ['数据结构实验(9913010470.01)\n(陈立明)\n(6-17,扬帆楼-101(凌海校区))', '数据结构实验', '陈立明', '6-17', 'ALL', '扬帆楼-101'],
  ['面向对象程序设计(C++)(9913011990.01)\n(刘洋)\n(1-16,扬帆楼-102(西山校区))', '面向对象程序设计(C++)', '刘洋', '1-16', 'ALL', '扬帆楼-102'],
  ['形势与政策(9913025343.25)\n(黄志强)\n(7-8,百川楼-103(多媒体)(西山校区))', '形势与政策', '黄志强', '7-8', 'ALL', '百川楼-103'],
]

for (const [cell, name, teacher, weeks, pattern, location] of PHONE_CELLS) {
  test(`单元格解析：${name} 的课程名只留课程名`, () => {
    const parsed = parseTableCellText(cell)
    assert.equal(parsed.name, name)
    assert.equal(parsed.teacher, teacher)
    assert.equal(`${parsed.startWeek}-${parsed.endWeek}`, weeks)
    assert.equal(parsed.weekPattern, pattern)
    assert.ok(parsed.location.includes(location), `地点应包含 ${location}，实际 ${parsed.location}`)
    // 铁律：课程号 / 老师 / 周次 / 地点不许拼进课程名
    assert.ok(!/\d{6,}/.test(parsed.name), `课程号被拼进名称：${parsed.name}`)
    assert.ok(!parsed.name.includes(teacher), `老师被拼进名称：${parsed.name}`)
    assert.ok(!/周/.test(parsed.name), `教学周被拼进名称：${parsed.name}`)
    assert.ok(!/(校区|多媒体)/.test(parsed.name), `地点被拼进名称：${parsed.name}`)
    assert.equal(nameLooksClean(parsed.name), true)
    assert.equal(parsed.courseCode.length >= 5, true)
  })
}

test('一个格子里两门课：按课程号锚点切成两条，名称/周次/单双周各自正确', () => {
  const cell =
    '马克思主义基本原理(9913000050.04) (张伟)\n(单1-15,学汇楼-302(多媒体)(西山校区))\n' +
    '数据结构(9913010460.01) (陈立明)\n(双2-16,德济楼-103 (多媒体) (西山校区))'
  const entries = splitCellTextIntoEntries(cell)
  assert.equal(entries.length, 2)

  const [first, second] = entries.map((entry) => parseTableCellText(entry.text))
  assert.equal(first.name, '马克思主义基本原理')
  assert.equal(first.teacher, '张伟')
  assert.deepEqual([first.startWeek, first.endWeek, first.weekPattern], [1, 15, 'ODD'])
  assert.ok(first.location.includes('学汇楼-302'))

  assert.equal(second.name, '数据结构')
  assert.equal(second.teacher, '陈立明')
  assert.deepEqual([second.startWeek, second.endWeek, second.weekPattern], [2, 16, 'EVEN'])
  assert.ok(second.location.includes('德济楼-103'))
})

test('单门课的格子不会被切碎', () => {
  const entries = splitCellTextIntoEntries('大学物理(B-2)(9913000172.08)\n(李华)\n(1-16,励志楼-204 (多媒体) (西山校区))')
  assert.equal(entries.length, 1)
})

test('左侧节次格：节次范围 + 起止时刻', () => {
  assert.deepEqual(parseGutterCellText('1-2\n8:00-9:35'), {
    periodStart: 1,
    periodEnd: 2,
    startTime: '08:00',
    endTime: '09:35',
  })
  assert.deepEqual(parseGutterCellText('9-10\n18:00-19:35'), {
    periodStart: 9,
    periodEnd: 10,
    startTime: '18:00',
    endTime: '19:35',
  })
  // 另一种版式：一行里带时刻与"第N-M节"
  assert.deepEqual(parseGutterCellText('08:00-09:40 第1-2节'), {
    periodStart: 1,
    periodEnd: 2,
    startTime: '08:00',
    endTime: '09:40',
  })
  // 表头格「节次」读不出节次 → 说明这一行是表头，不能当课程行
  assert.equal(parseGutterCellText('节次').periodStart, null)
})

test('左侧节次格只读到一个时刻：结束时刻留空，不拿开始时刻当结束时刻', () => {
  assert.deepEqual(parseGutterCellText('3-4\n10:00'), {
    periodStart: 3,
    periodEnd: 4,
    startTime: '10:00',
    endTime: null,
  })
  // 两行各一个时刻：第一段是开始、最后一段是结束
  assert.deepEqual(parseGutterCellText('3-4\n10:00\n11:35'), {
    periodStart: 3,
    periodEnd: 4,
    startTime: '10:00',
    endTime: '11:35',
  })
  assert.deepEqual(parseGutterCellText('1-2'), {
    periodStart: 1,
    periodEnd: 2,
    startTime: null,
    endTime: null,
  })
})

/* -------- rowSpanForCell：合并格的起止时刻只在各自边界行取，绝不跨行借用 -------- */

const periodRow = (rowIndex, periodStart, periodEnd, startTime, endTime) => ({
  rowIndex,
  periodStart,
  periodEnd,
  startTime,
  endTime,
})
const mergedCell = { rowStart: 1, rowEnd: 2, mergedRows: 2 }

test('合并格：最后一行缺结束时刻 → 结束时刻留空，不借用第一行的结束时刻', () => {
  const span = rowSpanForCell(mergedCell, [
    periodRow(1, 1, 2, '08:00', '09:35'),
    periodRow(2, 3, 4, '10:00', null),
  ])
  assert.deepEqual(
    [span.periodStart, span.periodEnd, span.startTime, span.endTime],
    [1, 4, '08:00', null],
    '节次范围 1-4 保留，但结束时刻必须是"未知"，不能变成 09:35',
  )
  assert.equal(span.missingEndTime, true)
  assert.equal(span.missingStartTime, false)
})

test('合并格：第一行缺开始时刻 → 开始时刻留空，但仍保留最后一行读到的结束时刻', () => {
  const span = rowSpanForCell(mergedCell, [
    periodRow(1, 1, 2, null, null),
    periodRow(2, 3, 4, '10:00', '11:35'),
  ])
  assert.deepEqual(
    [span.periodStart, span.periodEnd, span.startTime, span.endTime],
    [1, 4, null, '11:35'],
  )
  assert.equal(span.missingStartTime, true)
  assert.equal(span.missingEndTime, false)
})

test('合并格：两行时刻齐全 → 首尾各取一个，没有缺失标记', () => {
  const span = rowSpanForCell(mergedCell, [
    periodRow(1, 1, 2, '08:00', '09:35'),
    periodRow(2, 3, 4, '10:00', '11:35'),
  ])
  assert.deepEqual(
    [span.periodStart, span.periodEnd, span.startTime, span.endTime],
    [1, 4, '08:00', '11:35'],
  )
  assert.equal(span.missingStartTime, false)
  assert.equal(span.missingEndTime, false)
})

test('合并格：中间一行读不出节次 → 整格留空（连时刻一起留空）', () => {
  const span = rowSpanForCell({ rowStart: 1, rowEnd: 3, mergedRows: 3 }, [
    periodRow(1, 1, 2, '08:00', '09:35'),
    periodRow(2, null, null, null, null),
    periodRow(3, 5, 6, '13:30', '15:05'),
  ])
  assert.equal(span.periodStart, null)
  assert.equal(span.endTime, null)
  assert.equal(span.missingRows, 1)
  assert.equal(span.missingStartTime, true)
  assert.equal(span.missingEndTime, true)
})

test('教学周解析：单/双/普通范围与"第N周"', () => {
  assert.deepEqual(weeksFromText('单1-15'), { startWeek: 1, endWeek: 15, weekPattern: 'ODD', token: '单1-15' })
  assert.deepEqual(weeksFromText('双2-16'), { startWeek: 2, endWeek: 16, weekPattern: 'EVEN', token: '双2-16' })
  assert.equal(weeksFromText('1-16').weekPattern, 'ALL')
  assert.equal(weeksFromText('第7周').startWeek, 7)
  assert.equal(weeksFromText('B-2'), null)
})

/* -------- 真实原图上的周次前缀：空格/逗号后的独立周次一条都不能丢 -------- */

const clauseKeys = (text) => weekClausesFromText(text).map((c) => `${c.startWeek}-${c.endWeek}-${c.weekPattern}`)

test('周次前缀：空格隔开的独立周次保留，不因为后面跟着范围就丢掉', () => {
  // 真机（密集横版课表）里同一格会写「3 5-18」这种"单周 + 范围"，两个都是图上写着的周次。
  assert.deepEqual(clauseKeys('(3 5-18,四海楼-604(多媒体)(西山校区))'), ['3-3-ALL', '5-18-ALL'])
  // 空格后面跟"单 + 范围"时，空格前的第 1 周同样是真实周次。
  assert.deepEqual(clauseKeys('(1 单5-15,学汇楼-302(多媒体)(西山校区))'), ['1-1-ALL', '5-15-ODD'])
  // 空格后面的两位数（第 16 周）不能被当成"紧贴数字"而丢掉。
  assert.deepEqual(clauseKeys('(1-13 16,四海楼-406(多媒体)(西山校区))'), ['1-13-ALL', '16-16-ALL'])
  // 逗号隔开的列表同样两段都保留。
  assert.deepEqual(clauseKeys('(3,5-18)'), ['3-3-ALL', '5-18-ALL'])
})

test('周次前缀：教室号不会变成周次（103 不能造出"第 10 周"）', () => {
  // 楼名被读坏（德济楼 → 德齐习）时，`103` 仍然是教室号。
  assert.deepEqual(clauseKeys('(1-8德齐习103(多媒体)(西山校区)'), ['1-8-ALL'])
  assert.deepEqual(clauseKeys('(1-8,德济楼-103 (多媒体) (西山校区))'), ['1-8-ALL'])
  assert.deepEqual(clauseKeys('(1-16,学汇楼-412 (多媒体) (西山校区))'), ['1-16-ALL'])
  // 课程号（十几位数字 + .版本号）也不是周次。
  assert.deepEqual(clauseKeys('(9913000172.08)'), [])
  // 课程名自带的 `B-2` 不是周次。
  assert.deepEqual(clauseKeys('(B-2)'), [])
})

test('周次前缀：整格的字段解析也保留这些独立周次', () => {
  const english = parseTableCellText(
    '大学英语(3)(9913027703.43)\n(王文娟)\n(3 5-18,四海楼-604 (多媒体) (西山校区))',
  )
  assert.equal(english.name, '大学英语(3)')
  assert.deepEqual(
    english.clauses.map((c) => `${c.startWeek}-${c.endWeek}-${c.weekPattern}`),
    ['3-3-ALL', '5-18-ALL'],
  )
  assert.ok(english.location.includes('四海楼-604'))

  const methods = parseTableCellText(
    '计算方法与应用(9913030380.02)\n(王芳)\n(1 单5-15,四海楼-406 (多媒体) (西山校区))',
  )
  assert.deepEqual(
    methods.clauses.map((c) => `${c.startWeek}-${c.endWeek}-${c.weekPattern}`),
    ['1-1-ALL', '5-15-ODD'],
  )
})


test('完整记录保留末尾独立周次、单周安排，并排除教师行数字', () => {
  const cases = [
    ['1-13 16', [[1,13,'ALL'],[16,16,'ALL']]],
    ['12', [[12,12,'ALL']]],
    ['单1-15 2', [[1,15,'ODD'],[2,2,'ALL']]],
    ['3 5-18', [[3,3,'ALL'],[5,18,'ALL']]],
    ['1 单5-15', [[1,1,'ALL'],[5,15,'ODD']]],
  ]
  for (const [weeks, expected] of cases) {
    const parsed = parseTableCellText(`测试课程(1234567890.01)\n(教师)\n(${weeks},教学楼-604(多媒体)(西山校区))`)
    assert.deepEqual(parsed.clauses.map(c => [c.startWeek,c.endWeek,c.weekPattern]), expected, weeks)
  }
  const noise = parseTableCellText('测试课程(1234567890.01)\n10\n(1-16,教学楼-103)')
  assert.deepEqual(noise.clauses.map(c => [c.startWeek,c.endWeek]), [[1,16]])
})

test('地点提取保留双地点以及没有逗号的周次后地点', () => {
  for (const separator of [',',' ','.','']) {
    const parsed = parseTableCellText(`测试课程(1234567890.01)\n(王老师)\n(1-16${separator}教学楼-103(多媒体))`)
    assert.ok(parsed.location.includes('教学楼-103'))
    assert.ok(!parsed.location.includes('王老师'))
  }
  const parsed = parseTableCellText('测试课程(1234567890.01)\n(教师)\n(13,电航楼-模电实验室201(西山校区),电航楼-226(西山校\n区))')
  assert.ok(parsed.location.includes('电航楼-模电实验室201'))
  assert.ok(parsed.location.includes('电航楼-226'))
})

test('"每行一个字段"的通用兜底：同样不把老师/地点/周次拼进课程名', () => {
  const parsed = parseCellFieldLines('高等数学\n王老师\n教一101\n1-16周(单)')
  assert.equal(parsed.name, '高等数学')
  assert.equal(parsed.teacher, '王老师')
  assert.equal(parsed.location, '教一101')
  assert.deepEqual([parsed.startWeek, parsed.endWeek, parsed.weekPattern], [1, 16, 'ODD'])
})

test('nameLooksClean 能认出被字段污染的名字', () => {
  assert.equal(nameLooksClean('大学物理(B-2)'), true)
  assert.equal(nameLooksClean('创新思维与创新方法(计算机类)'), true)
  assert.equal(nameLooksClean('高等数学王老师教一1011-16周'), false)
  assert.equal(nameLooksClean('数据结构德济楼-103'), false)
  assert.equal(nameLooksClean(''), false)
})

/* ------------------------------ 几何与路由 ------------------------------ */

test('合成线框表格：横竖线 → 行列带 → 单元格，隔线缺失处纵向合并', () => {
  const image = makeBorderedTable()
  const geometry = analyzeTableGridGeometry(image)
  assert.equal(geometry.matched, true, geometry.reason)
  assert.equal(geometry.horizontal.length, 4)
  assert.equal(geometry.vertical.length, 4)
  assert.equal(geometry.rowBands.length, 3)
  assert.equal(geometry.columnBands.length, 3)

  const merged = geometry.cells.find((cell) => cell.colIndex === 2 && cell.rowStart === 1)
  assert.ok(merged, '第三列从第一行开始的格子应该存在')
  assert.equal(merged.rowEnd, 2)
  assert.equal(merged.mergedRows, 2)

  const separate = geometry.cells.find((cell) => cell.colIndex === 1 && cell.rowStart === 1)
  assert.equal(separate.rowEnd, 1)
  assert.equal(separate.mergedRows, 1)

  const filled = cellInkRatio(geometry.ink, geometry.width, separate)
  const empty = cellInkRatio(
    geometry.ink,
    geometry.width,
    geometry.cells.find((cell) => cell.colIndex === 1 && cell.rowStart === 2),
  )
  assert.ok(filled > 0.004, `有课的格子应该有墨迹，实际 ${filled}`)
  assert.ok(empty < filled / 4, `空格子的墨迹应该远少于有课的格子，实际 ${empty}`)
})

test('反向守卫：卡片式周视图不会被判成线框表格', () => {
  const image = makeCardGridImage()
  assert.equal(analyzeTableGridGeometry(image).matched, false)
  assert.equal(analyzeWeekGridGeometry(image).matched, true)
  assert.equal(chooseTimetableLayout(image).choice, 'week-grid')
})

test('反向守卫：线框表格不会被判成卡片周视图', () => {
  const image = makeBorderedTable()
  assert.equal(analyzeWeekGridGeometry(image).matched, false)
  assert.equal(analyzeTableGridGeometry(image).matched, true)
  assert.equal(chooseTimetableLayout(image).choice, 'table-grid')
})
