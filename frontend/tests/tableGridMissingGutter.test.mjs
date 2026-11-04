/**
 * 回归测试：**正文行读不出节次，不能把课程整批丢掉**。
 *
 * 真机故障（Supervisor 复现）：左侧 5-6 节那一格的节次没读出来时，
 * 旧实现拿"最后一个读不出节次的行"当表头底线，于是表头被推到第 5 行，
 * 1-4 行的课程全被当成表头丢掉——20 条候选只剩 4 条，而且星期也丢了。
 *
 * 这里用**合成线框表格 + 假 OCR**（按阶段文字分派，不依赖调用次数）钉住两件事：
 *   1. 表头只取"开头连续、且比正文行矮"的行；正文行读不出节次不影响表头；
 *   2. 合并格里只要有一行节次缺失，整格节次与时刻留空并提示，**绝不拿相邻行的时间硬凑**。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeTableGridGeometry, cellInkRatio } from '../src/ocr/tableGridLayout.js'
import { applyCellDetails, bestLocation, combineCellReads, isGarbageName, recognizeTableGrid } from '../src/ocr/tableGridOcr.js'

test('独立中文地点校对保留周次和序号，重复课按对应记录取地点', () => {
  const entries = [1,16].map(week => ({name:'测试课',courseCode:'1234567890.01',startWeek:week,endWeek:week,weekPattern:'ALL',clauses:[{startWeek:week,endWeek:week,weekPattern:'ALL'}],location:null}))
  const result = applyCellDetails(entries, {confidence:0.95,text:'测试课(1234567890.01)\n(1,教学楼101)\n测试课(1234567890.01)\n(16,实验楼202)'})
  assert.deepEqual(result.map(row => row.location), ['教学楼101','实验楼202'])
  assert.deepEqual(result.map(row => row.clauses), entries.map(row => row.clauses))
  const mergedDigits = applyCellDetails([entries[0]], {confidence:0.9,text:'测试课(1234567890.01)\n(35-18,教学楼101)'})
  assert.equal(mergedDigits[0].startWeek,1, '中文模型合并数字时不可覆盖数字识别结果')
  const missing = applyCellDetails(entries, {confidence:0.9,text:'测试课(1234567890.01)\n(16,实验楼202)'})
  assert.equal(missing[0].location,null)
  assert.equal(missing[1].location,'实验楼202')
  assert.deepEqual(applyCellDetails(entries, {confidence:0.2,text:'测试课(1234567890.01)\n(1,教学楼101)'}),entries)
  assert.deepEqual(applyCellDetails(entries, {confidence:0.9,text:'别的课程(9999999999.01)\n(1,教学楼101)'}),entries)
})

test('地点附注先剥离，多媒体写法不同也属于同一个教室', () => {
  const entry = location => ({name:'测试课',courseCode:'1234567890.01',startWeek:1,endWeek:16,weekPattern:'ALL',location})
  const result = combineCellReads([
    {score:40,entries:[entry('育才楼-103多媒体西山校区')]},
    {score:30,entries:[entry('教学楼-103多媒体西山校区')]},
    {score:30,entries:[entry('教学楼-103儿媒体西山校区')]},
    {score:30,entries:[entry('教学楼-103侈媒体西山校区')]},
  ])
  assert.match(result.entries[0].location,/教学楼-103/)
})

test('同号课程重排不串地点，完整周次多数同步到 clauses', () => {
  const item = (week, location) => ({name:'测试课程',courseCode:'1234567890.01',startWeek:week,endWeek:week,weekPattern:'ALL',clauses:[{startWeek:week,endWeek:week,weekPattern:'ALL'}],location})
  const one = item(1,null), two = item(2,'教学楼202')
  assert.equal(bestLocation([{entries:[two,item(1,'教学楼101')]}], {...one,index:0,entryCount:2}), '教学楼101')
  assert.equal(bestLocation([{entries:[two]}], {...one,index:0,entryCount:2}), null)
  const minority = item(1,'教学楼101')
  const majority = {...minority,clauses:[...minority.clauses,{startWeek:5,endWeek:15,weekPattern:'ODD'}]}
  const combined = combineCellReads([{score:40,entries:[minority]},{score:30,entries:[majority]},{score:30,entries:[majority]}])
  assert.deepEqual(combined.entries[0].clauses,majority.clauses)
})

/* ------------------------------ 合成线框表格 ------------------------------ */

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

/** 3 列（节次 + 两个星期列）× 3 行（表头 + 两行正文）；第三列上下两行合并。 */
function makeTwoBodyRowTable() {
  const image = blankImage(400, 300)
  const black = { r: 0, g: 0, b: 0 }
  const blue = { r: 120, g: 150, b: 220 }
  for (const x of [20, 120, 250, 380]) fillRect(image, x, 20, x + 3, 280, black)
  for (const y of [20, 60, 280]) fillRect(image, 20, y, 380, y + 3, black)
  fillRect(image, 20, 170, 250, 173, black) // 只跨前两列：第三列合并
  // 第一列两个正文格都有课（旧实现里下面这格会被整批丢掉）
  fillRect(image, 124, 64, 248, 166, blue)
  fillRect(image, 124, 174, 248, 278, blue)
  fillRect(image, 140, 90, 220, 100, black)
  fillRect(image, 140, 120, 200, 130, black)
  fillRect(image, 140, 200, 220, 210, black)
  fillRect(image, 140, 230, 200, 240, black)
  // 第三列是合并格
  fillRect(image, 254, 64, 378, 278, blue)
  fillRect(image, 270, 150, 360, 160, black)
  return image
}

/* ------------------------------ 假 OCR ------------------------------ */

function ocrResult(text, confidence = 92) {
  return { text, confidence, blocks: [] }
}

/** 与 companion/src/ocrEngine.mjs 同形状的假 canvas（Node 里没有 document）。 */
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

/**
 * 按**阶段文字**分派（`onStage` 在每次 OCR 之前都会被调用），
 * 因此与"一格重试几次"的实现细节无关，也不依赖调用计数。
 */
function stageAwareRecognize({ gutter, header, cells, stageRef }) {
  return async (canvas, { psm } = {}) => {
    const stage = stageRef.current ?? ''
    const headerMatch = stage.match(/表头第 (\d+)/)
    if (psm === '7' || headerMatch) {
      const index = headerMatch ? Number(headerMatch[1]) - 1 : 0
      return ocrResult(header[index] ?? '')
    }
    const gutterMatch = stage.match(/左侧第 (\d+)/)
    if (gutterMatch) return ocrResult(gutter[Number(gutterMatch[1]) - 1] ?? '')
    const cellMatch = stage.match(/识别第 (\d+)\/(\d+) 格/)
    if (cellMatch) return ocrResult(cells[Number(cellMatch[1]) - 1] ?? '')
    return ocrResult('')
  }
}

const HEADER = ['星期一', '星期二']
const CELLS = [
  '高等数学(9913000001.01)\n(王敏)\n(1-16,教一101(多媒体))',
  '数据结构(9913000002.01)\n(李强)\n(1-16,教二203(多媒体))',
  '大学英语(9913000003.01)\n(陈静)\n(1-16,教三305(多媒体))',
]

async function run(gutter, options = {}) {
  const image = makeTwoBodyRowTable()
  const stageRef = { current: '' }
  const result = await recognizeTableGrid(image, {
    recognize: stageAwareRecognize({ gutter, header: HEADER, cells: CELLS, stageRef }),
    createCanvas: createFakeCanvas,
    onStage: (text) => {
      stageRef.current = text
    },
    isCancelled: () => false,
    ...options,
  })
  return result
}

/* --------------------------------- 用例 --------------------------------- */

test('本地精读失败时保留基础候选并提示；取消时不返回成功结果', async () => {
  const gutter=['节次','1-2\n8:00-9:35','3-4\n10:00-11:35']
  const fallback=await run(gutter,{recognizeCellDetails:async()=>{throw new Error('worker unavailable')}})
  assert.equal(fallback.candidates.length,3)
  assert.ok(fallback.warnings.some(w=>w.includes('精读暂时不可用')))
  let cancelled=false
  const result=await run(gutter,{isCancelled:()=>cancelled,recognizeCellDetails:async()=>{cancelled=true;throw new Error('cancelled')}})
  assert.equal(result.cancelled,true)
  assert.equal(result.candidates,undefined)
})

test('合成表格几何成立（两行正文都有课，第三列合并）', () => {
  const geometry = analyzeTableGridGeometry(makeTwoBodyRowTable())
  assert.equal(geometry.matched, true, geometry.reason)
  const firstBody = geometry.cells.find((cell) => cell.colIndex === 1 && cell.rowStart === 1)
  const secondBody = geometry.cells.find((cell) => cell.colIndex === 1 && cell.rowStart === 2)
  const merged = geometry.cells.find((cell) => cell.colIndex === 2 && cell.rowStart === 1)
  assert.ok(firstBody && secondBody && merged)
  assert.equal(merged.mergedRows, 2)
  assert.ok(cellInkRatio(geometry.ink, geometry.width, firstBody) > 0.004)
  assert.ok(cellInkRatio(geometry.ink, geometry.width, secondBody) > 0.004)
})

test('左侧节次全部读得出：3 条候选，合并格是 1-4 节 08:00-11:35', async () => {
  const result = await run(['节次', '1-2\n8:00-9:35', '3-4\n10:00-11:35'])
  assert.equal(result.candidates.length, 3)
  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))
  const math = byName.get('高等数学')
  assert.deepEqual(
    [math.weekday, math.periodStart, math.periodEnd, math.startTime, math.endTime],
    [1, 1, 2, '08:00', '09:35'],
  )
  const structure = byName.get('数据结构')
  assert.deepEqual(
    [structure.weekday, structure.periodStart, structure.periodEnd, structure.startTime, structure.endTime],
    [1, 3, 4, '10:00', '11:35'],
  )
  const english = byName.get('大学英语')
  assert.deepEqual(
    [english.weekday, english.periodStart, english.periodEnd, english.startTime, english.endTime],
    [2, 1, 4, '08:00', '11:35'],
  )
  assert.equal(result.diagnostics.headerRowCount, 1)
  assert.equal(result.diagnostics.periodCount, 2)
})

test('正文某行节次读不出：表头不被推下去，课程一条都不能丢，缺节次的那格留空并提示', async () => {
  // 第一行正文（1-2 节）的左侧节次读不出来——真机上这就是"20 条只剩 4 条"的触发条件
  const result = await run(['节次', '', '3-4\n10:00-11:35'])

  assert.equal(result.diagnostics.headerRowCount, 1, '表头必须仍然只有第一行')
  assert.equal(result.diagnostics.periodCount, 1, '只读到 1-2 个节次行带（不能凭空补）')
  assert.equal(result.candidates.length, 3, '课程数不能因为一行节次读不出就变少')

  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))
  assert.equal(byName.size, 3)
  for (const candidate of result.candidates) {
    assert.ok([1, 2].includes(candidate.weekday), `星期不能被丢掉，实际 ${candidate.weekday}`)
  }

  const math = byName.get('高等数学')
  assert.equal(math.periodStart, null)
  assert.equal(math.startTime, null, '节次读不出就不能编一个时间')
  assert.equal(math.endTime, null)
  assert.ok(
    math.warnings.some((warning) => warning.includes('节次')),
    `缺节次必须提示，实际 ${JSON.stringify(math.warnings)}`,
  )

  const structure = byName.get('数据结构')
  assert.deepEqual([structure.periodStart, structure.periodEnd, structure.startTime], [3, 4, '10:00'])

  const english = byName.get('大学英语')
  assert.equal(english.periodStart, null, '合并格里有一行节次缺失：整格留空，不能缩成 3-4 节')
  assert.equal(english.startTime, null, '不能借用相邻行的时间')
  assert.ok(english.warnings.some((warning) => warning.includes('合并格')))
})

test('多次读数合成：有严格多数才说"按多数读数取"，平票必须说"无法由多数决定"', () => {
  const entry = (over = {}) => ({
    name: '大学物理(B-2)',
    teacher: '李华',
    courseCode: '9913000172.08',
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'ALL',
    location: '励志楼-204',
    ...over,
  })
  const read = (label, entries, score) => ({ label, entries, score, confidence: 80 })

  // 严格多数（2:1）且主读数不是多数派 → 按多数改正，并写清依据
  const majority = combineCellReads([
    read('a', [entry({ startWeek: 4, endWeek: 16 })], 40),
    read('b', [entry()], 30),
    read('c', [entry()], 30),
  ])
  assert.equal(majority.entries[0].startWeek, 1)
  assert.equal(majority.entries[0].endWeek, 16)
  assert.equal(majority.resolved, 1)
  assert.ok(
    majority.entries[0].readNotes.some((note) => note.includes('按多数读数取') && note.includes('1-16-ALL')),
    `实际提示：${JSON.stringify(majority.entries[0].readNotes)}`,
  )

  // 平票（1:1）→ 只能取更可信的一次，措辞不能声称"多数"
  const tie = combineCellReads([
    read('a', [entry({ startWeek: 4, endWeek: 16 })], 40),
    read('b', [entry()], 20),
  ])
  assert.equal(tie.entries[0].startWeek, 4, '平票时保留更可信的那次读数')
  assert.equal(tie.ties, 1)
  assert.ok(
    tie.entries[0].readNotes.some((note) => note.includes('无法由多数决定')),
    `实际提示：${JSON.stringify(tie.entries[0].readNotes)}`,
  )
  assert.ok(
    !tie.entries[0].readNotes.some((note) => note.includes('按多数读数取')),
    '平票不能声称按多数取',
  )
})

test('结构性乱码课程名会被拒绝，英文/中英混排的正常课名不会被误杀', () => {
  // 真机复现：密集格子读丢后出现的碎片，括号不配对、或一长串无分隔的拉丁字母。
  assert.equal(isGarbageName('BETEEESEISETAITEY IZ)(1 '), true)
  assert.equal(isGarbageName('AINIB-2)'), true)
  // 合法课程名（包括纯英文、中英混排、带符号的课程名）必须保留。
  for (const name of ['English', 'College Physics', 'English Writing', 'C++', 'AI 导论', '数据结构', '面向对短程序设计(C++if)']) {
    assert.equal(isGarbageName(name), false, `${name} 不应该被判成乱码`)
  }
})

/* ------- 只剩"半个时刻"的情况：只能保留已知的一半，缺的那一端必须留空 + 提示 ------- */
test('合并格最后的结束时刻缺失：结束时刻留空并提示，绝不借用上一行的结束时刻', async () => {
  // 两行节次都读到了，但每行只读到一个时刻（只有开始，没有结束）
  const result = await run(['节次', '1-2\n8:00', '3-4\n10:00'])
  assert.equal(result.candidates.length, 3, '课程一条都不能少')

  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))

  const math = byName.get('高等数学')
  assert.deepEqual(
    [math.periodStart, math.periodEnd, math.startTime, math.endTime],
    [1, 2, '08:00', null],
    '缺结束时刻就留空',
  )
  assert.ok(
    math.warnings.some((warning) => warning.includes('结束时刻')),
    `必须提示缺结束时刻，实际 ${JSON.stringify(math.warnings)}`,
  )

  const english = byName.get('大学英语')
  assert.deepEqual(
    [english.periodStart, english.periodEnd, english.startTime, english.endTime],
    [1, 4, '08:00', null],
    '合并格必须保留 1-4 节，但结束时刻只能是"未知"，不能变成第一行的 09:35',
  )
  assert.ok(
    english.warnings.some((warning) => warning.includes('结束时刻')),
    `合并格也要提示缺结束时刻，实际 ${JSON.stringify(english.warnings)}`,
  )
  assert.equal(result.diagnostics.missingClockCells, 3, '3 个格子各缺一端时刻')
  assert.ok(result.warnings.some((warning) => warning.includes('没读全起止时刻')))
})

test('合并格第一行的开始时刻缺失：开始时刻留空并提示，仍保留最后一行读到的结束时刻', async () => {
  // 第一行只读到节次、没有时刻；第二行时刻完整
  const result = await run(['节次', '1-2', '3-4\n10:00-11:35'])
  assert.equal(result.candidates.length, 3)

  const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))

  const math = byName.get('高等数学')
  assert.deepEqual([math.startTime, math.endTime], [null, null])
  assert.ok(
    math.warnings.some((warning) => warning.includes('开始与结束时刻')),
    `开始与结束都缺时要一次说清，实际 ${JSON.stringify(math.warnings)}`,
  )

  const structure = byName.get('数据结构')
  assert.deepEqual(
    [structure.periodStart, structure.periodEnd, structure.startTime, structure.endTime],
    [3, 4, '10:00', '11:35'],
    '后一行时刻完整时不受影响',
  )

  const english = byName.get('大学英语')
  assert.deepEqual(
    [english.periodStart, english.periodEnd, english.startTime, english.endTime],
    [1, 4, null, '11:35'],
    '开始时刻未知就留空，但最后一行读到的结束时刻要保留',
  )
  assert.ok(
    english.warnings.some((warning) => warning.includes('开始时刻') && !warning.includes('结束时刻')),
    `合并格只缺开始时刻时提示要精确，实际 ${JSON.stringify(english.warnings)}`,
  )
  assert.equal(result.diagnostics.missingClockCells, 2)
})
