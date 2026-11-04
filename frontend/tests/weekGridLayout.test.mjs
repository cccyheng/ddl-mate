/**
 * 周视图版式与文本规则的回归测试（全部用**合成像素**，不使用任何用户照片）。
 *
 * 覆盖：
 *   - 卡片底色自动识别（深底彩色卡片 / 浅底深色卡片两种主题）；
 *   - 连通域 → 列分组；空列不影响其它列；
 *   - 表头星期：日期交叉校验、误读纠正、缺列不硬猜；
 *   - 左侧时间栏：时刻两两配对 + 节号单调对齐（首节节号缺失也不串位）；
 *   - 卡片文本：跨行名称拼接、@ 地点、@ 丢失时的兜底切分（标记待确认）、噪声字符清理；
 *   - 节次映射：跨 2 节的卡片正好匹配 2 节；
 *   - 周视图候选默认 7-7 + 每周，并带确认提示；
 *   - 白底"表格/列表"截图不会被误判成卡片式周视图（保证旧路径不被劫持）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCardMask,
  buildWeekGridCandidates,
  cleanOcrText,
  detectCardColor,
  detectDisplayedWeek,
  findComponents,
  groupColumns,
  looksSuspect,
  mapStripBox,
  matchCardPeriods,
  parseCardText,
  parseGutterLines,
  resolveWeekdayColumns,
  weekdayFromText,
} from '../src/ocr/weekGridLayout.js'
import { analyzeWeekGridGeometry, scoreCardRead } from '../src/ocr/weekGridOcr.js'

// ------------------------------------------------------------------ 合成图像工具
/** 画一张"手机周视图"：深色背景 + N 列卡片（可指定空列 / 卡片颜色 / 缩放）。 */
function makeWeekGridImage(options = {}) {
  const {
    width = 700,
    height = 1400,
    columns = 7,
    emptyColumns = [],
    cardColor = { r: 69, g: 110, b: 236 },
    background = { r: 25, g: 25, b: 25 },
    rows = [0, 1, 2, 3, 4],
  } = options
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x, y, color) => {
    const index = (y * width + x) * 4
    data[index] = color.r
    data[index + 1] = color.g
    data[index + 2] = color.b
    data[index + 3] = 255
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, background)

  const gutter = Math.round(width * 0.08)
  const columnWidth = (width - gutter) / columns
  const cardWidth = Math.round(columnWidth * 0.72)
  const top = Math.round(height * 0.2)
  const rowHeight = Math.round((height - top) / 5)
  const cardHeight = Math.round(rowHeight * 0.86)
  for (let column = 0; column < columns; column += 1) {
    if (emptyColumns.includes(column)) continue
    for (const row of rows) {
      const x0 = Math.round(gutter + column * columnWidth + (columnWidth - cardWidth) / 2)
      const y0 = top + row * rowHeight
      for (let y = y0; y < y0 + cardHeight; y += 1) {
        for (let x = x0; x < x0 + cardWidth; x += 1) put(x, y, cardColor)
      }
      // 卡片里画几条浅色"文字"横线，模拟浅色字
      for (let line = 0; line < 3; line += 1) {
        const ly = y0 + 10 + line * 14
        for (let y = ly; y < ly + 4; y += 1) {
          for (let x = x0 + 6; x < x0 + cardWidth - 6; x += 1) put(x, y, { r: 210, g: 214, b: 222 })
        }
      }
    }
  }
  return { data, width, height }
}

/** 白底 + 细边框的"表格课表"（旧样例那种），应被判为"不是卡片式周视图"。 */
function makeWhiteGridImage() {
  const width = 600
  const height = 800
  const data = new Uint8ClampedArray(width * height * 4)
  const put = (x, y, value) => {
    const index = (y * width + x) * 4
    data[index] = value
    data[index + 1] = value
    data[index + 2] = value
    data[index + 3] = 255
  }
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, 250)
  // 竖线 + 几行文字线条
  for (let x = 0; x < width; x += 100) for (let y = 0; y < height; y += 1) put(x, y, 90)
  for (let y = 0; y < height; y += 40) for (let x = 0; x < width; x += 1) put(x, y, 120)
  return { data, width, height }
}

const hasPixel = (data, width, x, y) => {
  const index = (y * width + x) * 4
  return data[index] > 60 && data[index + 2] > 120
}

// ------------------------------------------------------------------ 几何
test('深色背景 + 彩色卡片：识别卡片底色、连通域与列分组', () => {
  const image = makeWeekGridImage()
  const colors = detectCardColor(image.data, image.width, image.height)
  assert.ok(colors.card, '应该找到卡片底色')
  assert.ok(colors.card.b > colors.card.r, '合成图卡片是蓝色系')
  assert.ok(Math.abs(colors.background.r - 25) <= 12, '背景色应接近深色背景')

  const mask = buildCardMask(image.data, image.width, image.height, colors.card, colors.background)
  const components = findComponents(mask, image.width, image.height)
  assert.equal(components.length, 35, '7 列 × 5 行 = 35 块卡片')

  const columns = groupColumns(components)
  assert.equal(columns.length, 7, '应聚成 7 列')
  for (const column of columns) assert.equal(column.items.length, 5)
})

test('空列（例如周六）不产生卡片，也不影响其它列的位置', () => {
  const image = makeWeekGridImage({ emptyColumns: [5] })
  const geometry = analyzeWeekGridGeometry(image)
  assert.equal(geometry.matched, true)
  const occupied = geometry.columns.map((column) => column.items.length)
  assert.deepEqual(occupied, [5, 5, 5, 5, 5, 5], '空列不出现，其它列仍有 5 块')
  // 第 6 个非空列（周日）在被清空的那一列右边，x 中心应明显大于第 5 列
  const centers = geometry.columns.map((column) => column.cx)
  assert.ok(centers[5] - centers[4] > centers[1] - centers[0], '空列会在几何上留下更大的间距')
})

test('换一种卡片颜色仍然能识别（不依赖固定颜色常数）', () => {
  for (const cardColor of [
    { r: 200, g: 90, b: 120 },
    { r: 60, g: 160, b: 110 },
    { r: 220, g: 170, b: 40 },
  ]) {
    const image = makeWeekGridImage({ cardColor })
    const geometry = analyzeWeekGridGeometry(image)
    assert.equal(geometry.matched, true, `卡片颜色 rgb(${cardColor.r},${cardColor.g},${cardColor.b}) 应仍可识别`)
    assert.equal(geometry.components.length, 35)
  }
})

test('浅色主题（浅底 + 深色卡片）也能识别', () => {
  const image = makeWeekGridImage({
    background: { r: 244, g: 246, b: 250 },
    cardColor: { r: 40, g: 60, b: 120 },
  })
  const geometry = analyzeWeekGridGeometry(image)
  assert.equal(geometry.matched, true)
  assert.equal(geometry.components.length, 35)
})

test('白底表格/列表截图不会被误判成卡片式周视图（旧路径不被劫持）', () => {
  const image = makeWhiteGridImage()
  const geometry = analyzeWeekGridGeometry(image)
  assert.equal(geometry.matched, false, '白底细线表格不应命中卡片式周视图')
})

test('图片整体缩放后仍然识别（不依赖原始像素尺寸）', () => {
  const base = makeWeekGridImage({ width: 700, height: 1400 })
  const scale = 2
  const width = base.width * scale
  const height = base.height * scale
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((y / scale) | 0) * base.width + ((x / scale) | 0)
      const target = (y * width + x) * 4
      data[target] = base.data[source * 4]
      data[target + 1] = base.data[source * 4 + 1]
      data[target + 2] = base.data[source * 4 + 2]
      data[target + 3] = 255
    }
  }
  const geometry = analyzeWeekGridGeometry({ data, width, height })
  assert.equal(geometry.matched, true)
  assert.equal(geometry.components.length, 35)
})

// ------------------------------------------------------------------ 表头星期
test('表头星期：日期顺序可纠正误读的星期标签，并给出提示', () => {
  const columns = [{ cx: 100 }, { cx: 200 }, { cx: 300 }]
  const tokens = [
    { text: '周一', cx: 100, cy: 50, y0: 40, y1: 60 },
    { text: '周一', cx: 200, cy: 50, y0: 40, y1: 60 }, // 周二被误读成周一
    { text: '周三', cx: 300, cy: 50, y0: 40, y1: 60 },
    { text: '10/12', cx: 100, cy: 80, y0: 70, y1: 90 },
    { text: '10/13', cx: 200, cy: 80, y0: 70, y1: 90 },
    { text: '10/14', cx: 300, cy: 80, y0: 70, y1: 90 },
  ]
  const { columns: resolved, warnings } = resolveWeekdayColumns(tokens, columns)
  assert.deepEqual(
    resolved.map((column) => column.weekday),
    [1, 2, 3],
  )
  assert.equal(resolved[1].corrected, true, '第 2 列应标记为已按日期校正')
  assert.ok(warnings.some((text) => text.includes('10/13')), '提示里应说明依据的日期')
})

test('表头缺列（周六空白）不会被硬猜成别的星期', () => {
  const columns = [{ cx: 100 }, { cx: 200 }, { cx: 400 }] // 400 是周日列，中间空了周六
  const tokens = [
    { text: '周一', cx: 100, cy: 50, y0: 40, y1: 60 },
    { text: '周二', cx: 200, cy: 50, y0: 40, y1: 60 },
    { text: '周六', cx: 300, cy: 50, y0: 40, y1: 60 }, // 这一列没有卡片，不该被认领
    { text: '周日', cx: 400, cy: 50, y0: 40, y1: 60 },
    { text: '10/12', cx: 100, cy: 80, y0: 70, y1: 90 },
    { text: '10/13', cx: 200, cy: 80, y0: 70, y1: 90 },
    { text: '10/18', cx: 400, cy: 80, y0: 70, y1: 90 },
  ]
  const { columns: resolved } = resolveWeekdayColumns(tokens, columns)
  assert.deepEqual(
    resolved.map((column) => column.weekday),
    [1, 2, 7],
    '第三列应该按日期算出是周日，而不是顺序推成周三',
  )
})

test('星期与日期的解析', () => {
  assert.equal(weekdayFromText('周一'), 1)
  assert.equal(weekdayFromText('星期天'), 7)
  assert.equal(weekdayFromText('10/12'), null)
  assert.equal(detectDisplayedWeek(['课表', '第 7 周', '上一周']), 7)
  assert.equal(detectDisplayedWeek(['课表', '上一周']), null)
})

// ------------------------------------------------------------------ 左侧时间栏
test('左侧时间栏：时刻两两配对成节次，首节节号缺失也不串位', () => {
  const lines = [
    { text: '08:00', cy: 100, y0: 90, y1: 110 },
    { text: '08:45', cy: 130, y0: 120, y1: 140 },
    { text: '2', cy: 200, y0: 190, y1: 210 },
    { text: '08:50', cy: 230, y0: 220, y1: 240 },
    { text: '09:35', cy: 260, y0: 250, y1: 270 },
    { text: '3', cy: 330, y0: 320, y1: 340 },
    { text: '10:00', cy: 360, y0: 350, y1: 370 },
    { text: '10:45', cy: 390, y0: 380, y1: 400 },
    { text: '4', cy: 460, y0: 450, y1: 470 },
    { text: '10:50', cy: 490, y0: 480, y1: 500 },
    { text: '11:35', cy: 520, y0: 510, y1: 530 },
  ]
  const periods = parseGutterLines(lines)
  assert.equal(periods.length, 4)
  assert.deepEqual(
    periods.map((period) => period.period),
    [1, 2, 3, 4],
    '第一个节号（1）缺失时应补成 1，后面的节号不能整体前移',
  )
  assert.deepEqual(
    periods.map((period) => [period.startTime, period.endTime]),
    [
      ['08:00', '08:45'],
      ['08:50', '09:35'],
      ['10:00', '10:45'],
      ['10:50', '11:35'],
    ],
  )
})

test('同一行里带节号与时刻也能解析', () => {
  const periods = parseGutterLines([
    { text: '1 08:00 08:45', cy: 100, y0: 90, y1: 110 },
    { text: '2 08:50 09:35', cy: 200, y0: 190, y1: 210 },
    { text: '3 10:00 10:45', cy: 300, y0: 290, y1: 310 },
    { text: '4 10:50 11:35', cy: 400, y0: 390, y1: 410 },
  ])
  assert.deepEqual(
    periods.map((period) => period.period),
    [1, 2, 3, 4],
  )
  assert.equal(periods[2].startTime, '10:00')
})

test('节次映射：跨 2 节的卡片正好匹配 2 节，且起止时刻来自首末节', () => {
  const periods = [
    { period: 1, cy: 100, startTime: '08:00', endTime: '08:45' },
    { period: 2, cy: 200, startTime: '08:50', endTime: '09:35' },
    { period: 3, cy: 300, startTime: '10:00', endTime: '10:45' },
    { period: 4, cy: 400, startTime: '10:50', endTime: '11:35' },
  ]
  const span = matchCardPeriods({ y0: 60, y1: 240 }, periods)
  assert.deepEqual([span.periodStart, span.periodEnd], [1, 2])
  assert.equal(span.startTime, '08:00')
  assert.equal(span.endTime, '09:35')
  assert.equal(span.matchedCount, 2)
})

// ------------------------------------------------------------------ 卡片文本
test('卡片文本：跨行名称拼合、@ 后是地点', () => {
  const parsed = parseCardText('面向对象程序\n设计(C++)@扬\n帆楼-101')
  assert.equal(parsed.name, '面向对象程序设计(C++)')
  assert.equal(parsed.location, '扬帆楼-101')
  assert.equal(parsed.suspect, false)
})

test('卡片文本：丢 @ 时按地点特征兜底切分，并标记为待确认', () => {
  const parsed = parseCardText('数据结构实验扬帆楼-101')
  assert.equal(parsed.name, '数据结构实验')
  assert.equal(parsed.location, '扬帆楼-101')
  assert.equal(parsed.locationStitched, true, '兜底切分必须标记出来，不能当确定结果')
})

test('卡片文本：清理结构性噪声（竖线、半截括号、括号后多出的字母）', () => {
  assert.equal(cleanOcrText('电路与电|子技术(双语)'), '电路与电子技术(双语)')
  assert.equal(cleanOcrText('[大学物理实验(2)'), '大学物理实验2')
  assert.equal(cleanOcrText('大学物理(B-2)G'), '大学物理(B-2)')
  const parsed = parseCardText('电路与电|子技术(双语)@学汇楼-412(多媒体)')
  assert.equal(parsed.name, '电路与电子技术(双语)')
  assert.equal(parsed.location, '学汇楼-412(多媒体)')
})

test('可疑读法会被标记（中文里夹拉丁乱码 / 括号不配平）', () => {
  assert.equal(looksSuspect('世界电影ZR@远航楼-1区303(多媒体)'), true)
  assert.equal(looksSuspect('面向对象程序设计(C++)@扬帆楼-101'), false)
  assert.equal(parseCardText('世界电影ZR@远航楼-1区303').suspect, true)
})

test('拉丁字母本身不扣分：C++ / B-2 / 英文课名都是正常分数', () => {
  assert.ok(scoreCardRead('面向对象程序设计(C++)@扬帆楼-101') > scoreCardRead('面向对象程序设计人C++ti@扬帆楼-101'))
  assert.ok(scoreCardRead('大学物理(B-2)@励志楼-204') > 0)
  assert.ok(scoreCardRead('English Writing@Room 301') > 0)
})

// ------------------------------------------------------------------ 候选组装
test('周视图候选：起止周默认 7-7 + 每周，并提示确认，不推断单双周', () => {
  const card = { x0: 0, y0: 60, x1: 100, y1: 240, cx: 50, cy: 150, width: 100, height: 180, area: 18000 }
  const columns = [{ x0: 0, x1: 100, cx: 50, weekday: 1, date: '10/12', items: [card] }]
  const periods = [
    { period: 1, cy: 100, startTime: '08:00', endTime: '08:45' },
    { period: 2, cy: 200, startTime: '08:50', endTime: '09:35' },
  ]
  const cardTexts = new Map([[card, '高等数学\n@教一101']])
  const { candidates } = buildWeekGridCandidates({ columns, cardTexts, periods, options: { weekViewWeek: 7 } })
  assert.equal(candidates.length, 1)
  const [candidate] = candidates
  assert.equal(candidate.startWeek, 7)
  assert.equal(candidate.endWeek, 7)
  assert.equal(candidate.weekPattern, 'ALL', '周视图不能推断成单周或整学期')
  assert.equal(candidate.name, '高等数学')
  assert.equal(candidate.location, '教一101')
  assert.equal(candidate.weekday, 1)
  assert.deepEqual([candidate.periodStart, candidate.periodEnd], [1, 2])
  assert.ok(candidate.warnings.some((text) => text.includes('第 7 周')))
})

test('同名课程在不同节次应输出两条候选（不合并）', () => {
  const first = { x0: 0, y0: 60, x1: 100, y1: 240, cx: 50, cy: 150, width: 100, height: 180, area: 18000 }
  const second = { x0: 0, y0: 300, x1: 100, y1: 480, cx: 50, cy: 390, width: 100, height: 180, area: 18000 }
  const columns = [{ x0: 0, x1: 100, cx: 50, weekday: 7, date: '10/18', items: [first, second] }]
  const periods = [
    { period: 1, cy: 100, startTime: '08:00', endTime: '08:45' },
    { period: 2, cy: 200, startTime: '08:50', endTime: '09:35' },
    { period: 3, cy: 340, startTime: '10:00', endTime: '10:45' },
    { period: 4, cy: 440, startTime: '10:50', endTime: '11:35' },
  ]
  const cardTexts = new Map([
    [first, '形势与政策@百川楼-103(多媒体)'],
    [second, '形势与政策@百川楼-103(多媒体)'],
  ])
  const { candidates } = buildWeekGridCandidates({ columns, cardTexts, periods, options: { weekViewWeek: 7 } })
  assert.equal(candidates.length, 2)
  assert.deepEqual(
    candidates.map((candidate) => candidate.periodStart),
    [1, 3],
  )
  assert.equal(candidates[0].name, candidates[1].name)
})

test('没有识别到星期的列会提示，而不是按顺序硬猜', () => {
  const card = { x0: 0, y0: 60, x1: 100, y1: 240, cx: 50, cy: 150, width: 100, height: 180, area: 18000 }
  const columns = [{ x0: 0, x1: 100, cx: 50, weekday: null, items: [card] }]
  const cardTexts = new Map([[card, '高等数学@教一101']])
  const { candidates, columnWarnings } = buildWeekGridCandidates({ columns, cardTexts, periods: [], options: {} })
  assert.equal(candidates[0].weekday, null)
  assert.ok(columnWarnings.length > 0)
  assert.ok(candidates[0].warnings.some((text) => text.includes('星期')))
})

test('裁剪条坐标能换算回整图坐标（放大 + 补边）', () => {
  const mapped = mapStripBox({ cx: 320, cy: 260, x0: 300, x1: 340, y0: 250, y1: 270 }, {
    x0: 10,
    y0: 20,
    scale: 3,
    pad: 16,
  })
  assert.equal(Math.round(mapped.cx), Math.round((320 - 16) / 3 + 10))
  assert.equal(Math.round(mapped.cy), Math.round((260 - 16) / 3 + 20))
})

test('合成图上的卡片是卡片色而不是背景色（几何判定的前提）', () => {
  const image = makeWeekGridImage({ width: 300, height: 400, columns: 3, rows: [0] })
  const colors = detectCardColor(image.data, image.width, image.height)
  assert.ok(hasPixel(image.data, image.width, 150, 120), '样本点应在卡片内')
  assert.ok(colors.card.b > 150)
})
