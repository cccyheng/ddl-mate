/**
 * 端到端守卫测试：**表头/时间栏绝不能被当成课程**。
 *
 * 复现的故障（用户在真机上遇到的）：整图回退识别时，OCR 只读准了表头（周一…周日、10/12）
 * 和左侧时间栏（节次、时刻），这些纯标签以前会变成一批"课程"，而真正的课程一条都没有。
 *
 * 这里用**合成像素** + **假 recognize** 精确控制每条路径返回什么文字：
 *   - 表头裁图（宽高比 ≥ 3）→ 返回表头文字；
 *   - 左侧时间栏裁图（宽高比 ≤ 0.2）→ 返回节次/时刻；
 *   - 课程卡片裁图 → 由用例指定（默认真课程名）；
 *   - 整图回退（PSM 11）→ 由用例单独指定。
 *
 * 钉住三件事：
 *   1. 只有表头 → 没有候选，并且 `structuralOnly` 为真（伴侣服务据此返回明确失败）；
 *   2. 表头 + 真课程混在一起 → 真课程必须原样保留；
 *   3. 真课程一块都不能丢（周视图流水线 + 回退解析器都不受影响）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeWeekGridGeometry, recognizeWeekGrid } from '../src/ocr/weekGridOcr.js'
import { flattenOcrLines, parseTimetable } from '../src/ocr/timetableParser.js'
import { HEADER_ONLY_MESSAGE, OcrLayoutError } from '../src/ocr/structuralLabels.js'

/* ------------------------------ 合成像素与假 OCR ------------------------------ */

/** 深底 + 蓝色卡片的合成周视图（列/行数与 weekGridLayout.test.mjs 保持一致）。 */
function makeWeekGridImage(options = {}) {
  const {
    width = 700,
    height = 1400,
    columns = 7,
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
    for (const row of rows) {
      const x0 = Math.round(gutter + column * columnWidth + (columnWidth - cardWidth) / 2)
      const y0 = top + row * rowHeight
      for (let y = y0; y < y0 + cardHeight; y += 1) {
        for (let x = x0; x < x0 + cardWidth; x += 1) put(x, y, cardColor)
      }
    }
  }
  return { data, width, height }
}

function line(text, bbox) {
  return {
    text,
    bbox: { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] },
    words: [{ text, bbox: { x0: bbox[0], y0: bbox[1], x1: bbox[2], y1: bbox[3] } }],
  }
}

function ocrResult(text, lines = []) {
  return {
    text,
    confidence: 92,
    blocks: lines.length ? [{ paragraphs: [{ lines }] }] : [],
  }
}

/**
 * 假 recognize：按裁图的宽高比区分"表头 / 时间栏 / 课程卡片"，
 * PSM 11 单独当作整图回退处理（`fullLines` 为函数时按调用现算）。
 */
function fakeRecognize({ cardText, headerText, gutterText, fullLines = [] }) {
  let cardCall = 0
  return async (canvas, { psm } = {}) => {
    if (psm === '11') {
      const list = typeof fullLines === 'function' ? fullLines() : fullLines
      return ocrResult(list.map((item) => item.text).join('\n'), list)
    }
    const ratio = canvas.width / Math.max(1, canvas.height)
    if (ratio >= 3) return ocrResult(headerText ?? '')
    if (ratio <= 0.2) return ocrResult(gutterText ?? '')
    cardCall += 1
    const text = typeof cardText === 'function' ? cardText(cardCall) : cardText
    return ocrResult(text ?? '')
  }
}

/** 与 companion/src/ocrEngine.mjs 同形状的假 canvas。 */
function createFakeCanvas() {
  const canvas = { width: 0, height: 0 }
  let image = null
  canvas.getContext = () => ({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: (value) => {
      image = value
      canvas.width = value.width
      canvas.height = value.height
    },
  })
  Object.defineProperty(canvas, 'gray', {
    get() {
      if (!image) return null
      const pixels = image.width * image.height
      const gray = new Uint8ClampedArray(pixels)
      for (let i = 0; i < pixels; i += 1) gray[i] = image.data[i * 4]
      return gray
    },
  })
  return canvas
}

/* ----------------------------------- 用例 ----------------------------------- */

test('合成周视图的几何仍然成立（守卫没有破坏正常输入）', () => {
  for (const columns of [3, 5, 7]) {
    const geometry = analyzeWeekGridGeometry(makeWeekGridImage({ columns }))
    assert.equal(geometry.matched, true, `columns=${columns}: ${geometry.reason}`)
    assert.ok(geometry.columns.length >= 3)
  }
})

test('整图回退只读到表头/时间栏 → 没有候选，并标记 structuralOnly（服务据此报明确失败）', () => {
  // 与真机失败时一模一样的输入：只有星期、日期、时刻、节次。
  const lines = [
    ...['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((text, index) =>
      line(text, [80 + index * 90, 100, 160 + index * 90, 140]),
    ),
    ...['10/12', '10/13', '10/14', '10/15'].map((text, index) => line(text, [80 + index * 90, 160, 160 + index * 90, 200])),
    ...['08:00', '08:45', '10:00', '10:45'].map((text, index) => line(text, [10, 240 + index * 60, 60, 280 + index * 60])),
    ...['1', '2', '3'].map((text, index) => line(text, [10, 520 + index * 120, 30, 560 + index * 120])),
  ]
  const parsed = parseTimetable(lines, { mode: 'auto' })
  assert.deepEqual(parsed.candidates, [], '表头文字不能变成课程候选')
  assert.equal(parsed.structuralOnly, true, '必须显式告诉调用方"只读到表头"')
  assert.ok(parsed.warnings.some((warning) => warning.includes('表头')))
})

test('整图回退：表头 + 真课程混在一起时，真课程保留、structuralOnly 为假', () => {
  const lines = [
    line('周一', [80, 100, 160, 140]),
    line('周二', [170, 100, 250, 140]),
    line('周三', [260, 100, 340, 140]),
    line('08:00', [10, 240, 60, 280]),
    line('08:45', [10, 300, 60, 340]),
    line('数字信号处理', [120, 250, 260, 290]),
    line('教三 305', [120, 300, 240, 340]),
  ]
  const parsed = parseTimetable(lines, { mode: 'auto' })
  assert.equal(parsed.structuralOnly, false)
  assert.ok(parsed.candidates.length >= 1, '真课程不能丢')
  assert.ok(parsed.candidates.every((candidate) => candidate.name !== '周一'), '表头不能变成课程')
  assert.ok(parsed.candidates.some((candidate) => candidate.name.includes('数字信号处理')))
})

test('周视图：卡片区域读到的全是表头/时间栏文字 → 抛 OcrLayoutError（不是 0 条"成功"）', async () => {
  const image = makeWeekGridImage({ columns: 5 })
  await assert.rejects(
    recognizeWeekGrid(image, {
      recognize: fakeRecognize({
        // 关键：几何定位出来的"课块"里，OCR 读出来的却是表头/时间栏文字。
        cardText: '周一\n10/12',
        headerText: '周一 周二 周三 周四 周五',
        gutterText: '1 08:00',
      }),
      createCanvas: createFakeCanvas,
      isCancelled: () => false,
    }),
    (cause) => {
      assert.ok(cause instanceof OcrLayoutError, `应当是 OcrLayoutError，实际 ${cause?.name}`)
      assert.equal(cause.layout, 'week-grid')
      assert.equal(cause.code, 'STRUCTURE_NOT_FOUND')
      return true
    },
  )
})

test('周视图：真课程被正常保留（守卫不能误删）', async () => {
  const image = makeWeekGridImage({ columns: 5 })
  const result = await recognizeWeekGrid(image, {
    recognize: fakeRecognize({
      cardText: '数字信号处理@教三305',
      headerText: '周一 周二 周三 周四 周五',
      gutterText: '1 08:00',
    }),
    createCanvas: createFakeCanvas,
    isCancelled: () => false,
  })
  assert.equal(result.matched, true)
  assert.ok(result.candidates.length >= 1)
  assert.ok(result.candidates.every((candidate) => candidate.name === '数字信号处理'))
  assert.equal(result.diagnostics.headerOnlyCards, 0)
  assert.equal(result.diagnostics.candidateCount, result.candidates.length)
})

test('周视图：个别课块读到表头时被忽略，并在 warnings / diagnostics 里说清楚', async () => {
  const image = makeWeekGridImage({ columns: 5 })
  const result = await recognizeWeekGrid(image, {
    recognize: fakeRecognize({
      cardText: (call) => (call <= 3 ? '周一 10/12' : '数据结构@德济楼103'),
      headerText: '周一 周二 周三 周四 周五',
      gutterText: '1 08:00',
    }),
    createCanvas: createFakeCanvas,
    isCancelled: () => false,
  })
  assert.equal(result.matched, true)
  assert.ok(result.candidates.length >= 1)
  assert.ok(result.candidates.every((candidate) => candidate.name === '数据结构'))
  assert.ok(
    result.warnings.some((warning) => warning.includes('表头/时间栏')),
    `应当提示忽略了表头文字，实际：${JSON.stringify(result.warnings)}`,
  )
  assert.ok(result.diagnostics.headerOnlyCards >= 1)
})

test('周视图：课块读不出课程名时给出"可能缺失"的显式提示', async () => {
  const image = makeWeekGridImage({ columns: 5 })
  const result = await recognizeWeekGrid(image, {
    recognize: fakeRecognize({
      // 第一块 OCR 只吐出标点（切不出任何课程名，重试也一样），其余正常：
      // 不能因为一块丢了就报"整批失败"，但必须显式提示"有课块没读出名字"。
      // 注意块内最多重试 3 次，所以按"前 3 次"而不是"第 1 次"来区分。
      cardText: (call) => (call <= 3 ? '···' : '数据结构@德济楼103'),
      headerText: '周一 周二 周三 周四 周五',
      gutterText: '1 08:00',
    }),
    createCanvas: createFakeCanvas,
    isCancelled: () => false,
  })
  assert.ok(result.candidates.length >= 1)
  assert.ok(
    result.warnings.some((warning) => warning.includes('没有读出课程名')),
    `应当提示有课块没读出名字，实际：${JSON.stringify(result.warnings)}`,
  )
})

test('列表布局里的"周一 08:00"这种标签行不会变成课程', () => {
  const lines = [line('周一 08:00-09:35', [40, 100, 400, 140]), line('周二 10:00-11:35', [40, 200, 400, 240])]
  const parsed = parseTimetable(lines, { mode: 'list' })
  assert.deepEqual(parsed.candidates, [])
  assert.equal(parsed.structuralOnly, true)
})

test('flattenOcrLines 仍然吃 OcrEngine 的输出结构（回归保护）', () => {
  const lines = flattenOcrLines(
    ocrResult('周一\n数字信号处理', [line('周一', [10, 10, 60, 40]), line('数字信号处理', [10, 60, 200, 100])]),
  )
  assert.equal(lines.length, 2)
  assert.equal(lines[1].text, '数字信号处理')
})

test('失败文案是给用户看的（不是"识别成功 0 条"）', () => {
  const error = new OcrLayoutError(HEADER_ONLY_MESSAGE, { layout: 'grid-rows', headerOnly: 4 })
  assert.equal(error.code, 'STRUCTURE_NOT_FOUND')
  assert.match(error.message, /表头与时间栏/)
  assert.match(error.message, /重新截取|拍摄/)
})
