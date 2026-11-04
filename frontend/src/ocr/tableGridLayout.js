/**
 * 通用「有线框课表」的版式分析（纯函数，浏览器与伴侣服务共用）。
 *
 * 目标版式（真实手机拍到的横版课表）：画面里是一张**有黑色边框线的表格**，
 * 表头一行是「节次 + 星期一…星期日」，最左一列是节次与上课时刻，
 * 单元格可能空着、可能一门课，也可能上下塞两门课；星期日这类可以纵向合并好几行。
 *
 * 全部由像素统计推导，没有针对任何一张图的坐标、颜色、文件名或课程名：
 *   1. 局部自适应「墨迹」判定：比周围明显暗的像素算墨迹（黑线、黑字），
 *      蓝底/黄底/白底这些大面积底色都不算——因此不会被"哪种颜色占多数"带偏；
 *   2. 逐行 / 逐列求**最长连续墨迹段**：文字笔画短、边框线长，这是区分"线"和"字"的关键；
 *   3. 长横线 / 长竖线 → 行带 / 列带 → 单元格矩形；
 *   4. 某条横线在某个列带里根本不存在 → 这一格纵向合并（星期日 1-4 节就是一格）；
 *   5. 一格两门课：用「课程号括号」作锚点把整格文本切成一条条课程，
 *      名称只取课程号之前的部分，课程号/老师/周次/地点不会被拼进课程名。
 *
 * 本模块只做几何与文本切分，不发起任何 OCR、不联网、不写文件。
 */

import { otsuThreshold, toGray } from './imageOps.js'
import { extractLocation, extractTeacher, extractWeeks, looksLikeCourseName } from './timetableParser.js'

/* ------------------------------- 判定阈值（比例，不是像素常数） ------------------------------- */

/** 局部均值的窗口半径：约为短边的 1/160，够覆盖一条 3~4px 的边框线两侧。 */
const RADIUS_DIVISOR = 160
const MIN_RADIUS = 4
/** 比局部均值暗这么多才算墨迹（抗 JPEG 噪点与抗锯齿边）。 */
const DEFAULT_INK_MARGIN = 34
/** "长线"至少要占画面这个比例，才可能是表格边框，而不是文字或卡片边缘。 */
const LONG_RUN_RATIO = 0.3
/** 表格外框：几乎贯穿整个表格。 */
const FULL_LINE_RATIO = 0.9
/** 内部隔线：允许被合并单元格截短，但仍要跨过大半张表。 */
const INNER_LINE_RATIO = 0.55
/** 隔线在某个列带里要"连成一条线"才算存在（文字永远连不成这么长的一条）。 */
const SEPARATOR_RUN_RATIO = 0.8
/** 单元格里有这么多墨迹才算"这一格有课"（空白色块是 0）。 */
const MIN_CELL_INK_RATIO = 0.004
/** 一条边至少要有这么多像素，避免小图被噪声凑出"长线"。 */
const MIN_LINE_PIXELS = 24
/**
 * 外框被裁掉时的恢复：一条**贯穿画面的**长线如果伸到离相应画面边缘这么近（相对短边），
 * 或者画面边上还留着墨迹（文字）却没有任何一条线把它框住，就说明"表格本来贴着画面边、
 * 只是最外面那一条外框没拍进来/被裁掉了"。
 *
 * 真机复现（`.tools/photo/user-20261013-dense/input.png`）：截图把表格右外框与下外框裁掉了，
 * 于是 8 列只剩 7 条竖线（最节次那一列被当成"星期一"）、最后一个行带只到画面下沿前 113px
 * （9-10 节整行落在表格外），而右边缘还留着"星期日"整列的课（形势与政策 / 马克思主义）。
 * 这不是"图片里有噪点"，而是**画面边缘本身就是表格边界**，因此按两条通用证据补回虚拟外框：
 *   1. 最外那条长线贴边；
 *   2. 贴边的窄条里还有墨迹，说明那里还有格子内容。
 * 两条都不成立（例如老图四周都留着白边）时行为与以前完全一致，不会多出任何行列。
 */
const CROPPED_EDGE_RATIO = 0.02

/* --------------------------------------- 墨迹判定 --------------------------------------- */

/** 灰度直方图中位数（不排序，O(n)）。 */
export function grayMedian(gray) {
  const histogram = new Uint32Array(256)
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1
  const half = gray.length / 2
  let seen = 0
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value]
    if (seen >= half) return value
  }
  return 255
}

/** 只用来说明"这张图有多暗"的诊断值，不参与几何判定。 */
export function inkThresholdReport(gray) {
  return { otsu: otsuThreshold(gray), median: grayMedian(gray) }
}

/**
 * 墨迹掩膜：比**局部均值**暗 `margin` 以上的像素记为 1。
 * 用局部均值而不是全局阈值，是因为表格里同时存在白底、蓝底、黄底：
 * 全局阈值会把某一种底色整片判成"暗"，局部对比度则只认真正的线和字。
 */
export function buildInkMask(gray, width, height, options = {}) {
  const margin = options.inkMargin ?? DEFAULT_INK_MARGIN
  const radius = Math.max(
    MIN_RADIUS,
    options.inkRadius ?? Math.round(Math.min(width, height) / RADIUS_DIVISOR),
  )
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x]
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum
    }
  }
  const mask = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum =
        integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
        integral[y0 * (width + 1) + (x1 + 1)] -
        integral[(y1 + 1) * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0]
      if (gray[y * width + x] < sum / area - margin) mask[y * width + x] = 1
    }
  }
  return mask
}

/* --------------------------------------- 线的检测 --------------------------------------- */

/** 每条扫描线（行/列）上最长的连续墨迹段，以及它的起止位置。 */
export function longestRunScan(mask, width, height, axis) {
  const count = axis === 'row' ? height : width
  const lineLength = axis === 'row' ? width : height
  const longest = new Float64Array(count)
  const starts = new Int32Array(count).fill(-1)
  const ends = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i += 1) {
    let best = 0
    let bestStart = -1
    let bestEnd = -1
    let run = 0
    let runStart = 0
    for (let j = 0; j < lineLength; j += 1) {
      const index = axis === 'row' ? i * width + j : j * width + i
      if (mask[index]) {
        if (run === 0) runStart = j
        run += 1
        if (run > best) {
          best = run
          bestStart = runStart
          bestEnd = j
        }
      } else {
        run = 0
      }
    }
    longest[i] = best
    starts[i] = bestStart
    ends[i] = bestEnd
  }
  return { longest, starts, ends }
}

/**
 * 把满足条件的相邻扫描线聚成"线带"（一条 3~4px 的实线会占好几行）。
 * `spanStart/spanEnd` 取带内所有扫描线最长段的最小/最大范围，也就是这条线实际覆盖的范围。
 */
export function groupLineBands(scan, count, minRun, gapTolerance = 1) {
  const bands = []
  let start = -1
  let end = -1
  let strength = 0
  let spanStart = 0
  let spanEnd = 0
  const flush = () => {
    bands.push({ start, end, center: (start + end) / 2, strength, spanStart, spanEnd })
    start = -1
  }
  for (let i = 0; i < count; i += 1) {
    const value = scan.longest[i]
    if (value >= minRun) {
      if (start < 0) {
        start = i
        strength = value
        spanStart = scan.starts[i]
        spanEnd = scan.ends[i]
      } else {
        strength = Math.max(strength, value)
        spanStart = Math.min(spanStart, scan.starts[i])
        spanEnd = Math.max(spanEnd, scan.ends[i])
      }
      end = i
    } else if (start >= 0 && i - end > gapTolerance) {
      flush()
    }
  }
  if (start >= 0) flush()
  return bands
}

/** 某条横线在 [x0,x1] 这段里是否真的连成了一条线（文字连不成）。 */
export function separatorPresent(ink, width, line, x0, x1) {
  const left = Math.max(0, Math.floor(x0))
  const right = Math.min(width - 1, Math.ceil(x1))
  const need = Math.max(8, (right - left + 1) * SEPARATOR_RUN_RATIO)
  for (let y = line.start; y <= line.end; y += 1) {
    let run = 0
    for (let x = left; x <= right; x += 1) {
      if (ink[y * width + x]) {
        run += 1
        if (run >= need) return true
      } else {
        run = 0
      }
    }
  }
  return false
}

/* --------------------------------------- 单元格 --------------------------------------- */

/**
 * 线带之间就是格子：横线两两之间是行带，竖线两两之间是列带。
 *
 * 单元格范围取**线带边缘之间**的空白（`lines[i].end+1 … lines[i+1].start-1`），
 * 而不是两条线的中心：外框被裁掉时最外那条线会被延长到画面边，中心会跟着跑到
 * 线的另一端，按中心切格就会把最外那一列/一行整格切没（真机复现：
 * 星期日整列与 9-10 节整行因此消失）。取边缘之间的空白对"线很粗"和"线被延长"
 * 两种情况都稳定。
 */
export function bandsBetween(lines) {
  const bands = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const y0 = lines[i].end + 1
    const y1 = lines[i + 1].start - 1
    if (y1 <= y0) continue
    bands.push({ index: bands.length, from: y0, to: y1, y0, y1, size: y1 - y0 + 1 })
  }
  return bands
}

/** 行带 × 列带 → 单元格；内部横线在某个列带里不存在就把上下两格合并。 */
export function buildTableCells({ horizontal, vertical, ink, width }) {
  const rowBands = bandsBetween(horizontal)
  const columnBands = bandsBetween(vertical)
  const cells = []
  for (const column of columnBands) {
    let rowStart = 0
    for (let row = 0; row < rowBands.length; row += 1) {
      const isLast = row === rowBands.length - 1
      const separator = isLast ? null : horizontal[row + 1]
      // 隔线在这一列带里连成一条线 → 上下两格断开；连不成线 → 这一列跨行合并（星期日 1-4 节）。
      const closed = isLast || separatorPresent(ink, width, separator, column.y0, column.y1)
      if (closed) {
        const top = rowBands[rowStart]
        const bottom = rowBands[row]
        cells.push({
          rowStart,
          rowEnd: row,
          colIndex: column.index,
          x0: column.y0,
          x1: column.y1,
          y0: top.y0,
          y1: bottom.y1,
          width: column.y1 - column.y0 + 1,
          height: bottom.y1 - top.y0 + 1,
          mergedRows: row - rowStart + 1,
        })
        rowStart = row + 1
      }
    }
  }
  return { rowBands, columnBands, cells }
}

/** 单元格内部（避开边框）的墨迹比例：判断"这格有没有课"。 */export function cellInkRatio(ink, width, cell, inset = 2) {
  const x0 = Math.max(0, Math.floor(cell.x0 + inset))
  const x1 = Math.min(width - 1, Math.ceil(cell.x1 - inset))
  const y0 = Math.max(0, Math.floor(cell.y0 + inset))
  const y1 = Math.max(y0, Math.floor(cell.y1 - inset))
  let count = 0
  let total = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1
      if (ink[y * width + x]) count += 1
    }
  }
  return total ? count / total : 0
}

/**
 * 一个单元格覆盖了哪些节次。
 *
 * 行带是"节次对"（1-2 / 3-4 …），合并单元格会跨好几个行带：星期日那一格跨 1-2 与 3-4，
 * 于是节次范围是 1-4、时刻是 08:00-11:35 —— 直接按行带序号取首尾，不做任何换算。
 *
 * **起止时刻只在各自的边界行里取**：开始时刻只看第一行、结束时刻只看最后一行。
 * 以前写成 `last.endTime || first.endTime`，于是"最后一行只读到 10:00、没读到结束时刻"时，
 * 合并格的结束时刻会借来第一行的 09:35 —— 一节课被悄悄缩短成 08:00-09:35，
 * 这是编出来的时间。缺就留空并打标记，由调用方按候选给出提示。
 */
export function rowSpanForCell(cell, periodRows) {
  const bands = (periodRows || []).filter(
    (entry) => entry.rowIndex >= cell.rowStart && entry.rowIndex <= cell.rowEnd,
  )
  const covered = bands.filter((entry) => entry.periodStart !== null)
  // 合并格里只要有一行没读出节次，就**整格留空**：不能拿相邻行的时间把课"缩短"
  // （星期日 1-4 节那种合并格，少读一行就会被缩成 3-4 节，那是编出来的时间）。
  if (!bands.length || covered.length !== bands.length) {
    return {
      periodStart: null,
      periodEnd: null,
      startTime: null,
      endTime: null,
      missingStartTime: true,
      missingEndTime: true,
      rowIndexes: covered.map((entry) => entry.rowIndex),
      missingRows: bands.length - covered.length,
    }
  }
  const first = covered[0]
  const last = covered[covered.length - 1]
  return {
    periodStart: first.periodStart,
    periodEnd: last.periodEnd,
    startTime: first.startTime || null,
    endTime: last.endTime || null,
    missingStartTime: !first.startTime,
    missingEndTime: !last.endTime,
    rowIndexes: covered.map((entry) => entry.rowIndex),
    missingRows: 0,
  }
}

/* ------------------------------- 整图 → 网格几何 ------------------------------- */

/**
 * 被裁掉的外框：**新增一条独立的虚拟边界**，绝不改动任何已经识别到的隔线。
 *
 * 为什么必须是"新增一条"而不是"把最外那条线拉长"（复核对已否决的旧做法）：
 * 被裁掉的是**外框**，不是隔线。把 `719` 那条隔线拉成 `719..height-1` 会同时干两件坏事——
 * 改写了一条真实隔线的坐标（老图几何跟着变），又只把最后一格"撑大"而没有真正补出新的一行。
 *
 * 虚拟边界只放在画面边上，宽度取 1 像素（`start=end=边缘`），因此它不会遮住任何内容，
 * 也不会把相邻格子并掉。是否需要补，见 `analyzeTableGridGeometry` 里的长线端点证据。
 */
function addVirtualBoundary(bands, axisLength, edge) {
  const at = edge === 'start' ? 0 : axisLength - 1
  const virtual = { start: at, end: at, center: at, strength: 0, spanStart: at, spanEnd: at, virtual: true }
  return edge === 'start' ? [virtual, ...bands] : [...bands, virtual]
}

/**
 * 整图 → 表格网格几何。
 *
 * 返回 `matched=true` 时带：`ink`（墨迹掩膜）、`horizontal`/`vertical`（线带）、
 * `rowBands`/`columnBands`（行带/列带）、`cells`（含合并后的单元格）、`table`（外框）。
 * `matched=false` 时只带 `reason`，调用方据此回退到别的版式分支。
 */
export function analyzeTableGridGeometry(imageData, options = {}) {
  const { data, width, height } = imageData || {}
  if (!data || !width || !height) return { matched: false, reason: '图像尺寸无效' }

  const gray = toGray(data, width, height).gray
  const report = inkThresholdReport(gray)
  const ink = buildInkMask(gray, width, height, options)

  const rowScan = longestRunScan(ink, width, height, 'row')
  const colScan = longestRunScan(ink, width, height, 'col')
  const horizontals = groupLineBands(rowScan, height, Math.max(MIN_LINE_PIXELS, width * LONG_RUN_RATIO))
  const verticals = groupLineBands(colScan, width, Math.max(MIN_LINE_PIXELS, height * LONG_RUN_RATIO))
  if (horizontals.length < 2 || verticals.length < 2) {
    return { matched: false, reason: '没有找到成对的横线/竖线', report }
  }

  const tableWidth = Math.max(...horizontals.map((band) => band.strength))
  const tableHeight = Math.max(...verticals.map((band) => band.strength))
  if (tableWidth < width * 0.45 || tableHeight < height * 0.45) {
    return {
      matched: false,
      reason: '最长横线/竖线没有贯穿画面，不像一张课表',
      report,
      longestHorizontal: tableWidth,
      longestVertical: tableHeight,
    }
  }

  const fullHorizontal = horizontals.filter((band) => band.strength >= tableWidth * FULL_LINE_RATIO)
  const fullVertical = verticals.filter((band) => band.strength >= tableHeight * FULL_LINE_RATIO)
  if (fullHorizontal.length < 2 || fullVertical.length < 2) {
    return { matched: false, reason: '表格外框不闭合', report }
  }

  // 被裁掉的外框：只**新增**画面边上的虚拟边界，一条已识别到的隔线都不动。
  const sortedFullHorizontal = [...fullHorizontal].sort((a, b) => a.start - b.start)
  const sortedFullVertical = [...fullVertical].sort((a, b) => a.start - b.start)
  const firstHorizontal = sortedFullHorizontal[0]
  const lastHorizontal = sortedFullHorizontal[sortedFullHorizontal.length - 1]
  const firstVertical = sortedFullVertical[0]
  const lastVertical = sortedFullVertical[sortedFullVertical.length - 1]
  // 长线端点给出的"表格可见范围"：横线的 x 范围 / 竖线的 y 范围。
  const horizontalMinX = Math.min(...horizontals.map((band) => band.spanStart))
  const horizontalMaxX = Math.max(...horizontals.map((band) => band.spanEnd))
  const verticalMinY = Math.min(...verticals.map((band) => band.spanStart))
  const verticalMaxY = Math.max(...verticals.map((band) => band.spanEnd))
  // 被裁掉的外框：这一侧还有格子、却没有线把它框住，就在画面边补一条**独立**虚拟边界。
  //
  // 判定只用一条几何证据 —— **本方向最外那条线，没有盖住垂直方向长线的可见范围**：
  //   - 左：横线一直画到 x=0，而第一条竖线还在 x=98 之后 → 左边还有"节次"这一列；
  //   - 右：竖线一直画到画面右边，而最后一条竖线的端点还在更左边 → 右边还有"星期日"一列；
  //   - 下：竖线一直画到 y=832，而最后一条横线的端点只到 719 → 下面还有"9-10 节"一整行。
  // 缺的那一段要大于外框线本身的粗细（几像素）：老图四周白边完整，横线与竖线的可见范围
  // 最多差几像素，因此不会补任何边，坐标与以前完全一致。
  //
  // 为什么不用"贴边窄带里有没有墨迹"当证据：外框线本身横跨整幅画面，一定会落进那条窄带，
  // 而墨迹掩膜分不清"边框线"和"格子里的文字"，那会给出假阳性（老图因此被加出空行空列）。
  const edgeOverhangTolerance = Math.max(6, Math.round(Math.max(width, height) * 0.005))
  const coversAtLeast = (outer, extent) => outer - extent >= edgeOverhangTolerance
  const virtualEdges = {
    left: coversAtLeast(firstVertical.start, horizontalMinX),
    right: coversAtLeast(horizontalMaxX, lastVertical.end),
    top: coversAtLeast(firstHorizontal.start, verticalMinY),
    bottom: coversAtLeast(verticalMaxY, lastHorizontal.end),
  }
  let horizontalsWithEdges = horizontals
  let verticalsWithEdges = verticals
  if (virtualEdges.top) horizontalsWithEdges = addVirtualBoundary(horizontalsWithEdges, height, 'start')
  if (virtualEdges.bottom) horizontalsWithEdges = addVirtualBoundary(horizontalsWithEdges, height, 'end')
  if (virtualEdges.left) verticalsWithEdges = addVirtualBoundary(verticalsWithEdges, width, 'start')
  if (virtualEdges.right) verticalsWithEdges = addVirtualBoundary(verticalsWithEdges, width, 'end')

  const top = Math.min(...horizontalsWithEdges.map((band) => band.start))
  const bottom = Math.max(...horizontalsWithEdges.map((band) => band.end))
  const left = Math.min(...verticalsWithEdges.map((band) => band.start))
  const right = Math.max(...verticalsWithEdges.map((band) => band.end))

  const horizontal = horizontalsWithEdges.filter(
    (band) => band.virtual || (band.start >= top - 2 && band.end <= bottom + 2 && band.strength >= tableWidth * INNER_LINE_RATIO),
  )
  const vertical = verticalsWithEdges.filter(
    (band) => band.virtual || (band.start >= left - 2 && band.end <= right + 2 && band.strength >= tableHeight * INNER_LINE_RATIO),
  )
  if (horizontal.length < 3 || vertical.length < 4) {
    return {
      matched: false,
      reason: `横线 ${horizontal.length} 条 / 竖线 ${vertical.length} 条，凑不出课表网格`,
      report,
    }
  }

  const { rowBands, columnBands, cells } = buildTableCells({ horizontal, vertical, ink, width })
  if (rowBands.length < 3 || columnBands.length < 3) {
    return { matched: false, reason: '行带或列带太少，凑不出课表网格', report }
  }
  const minColumn = Math.min(...columnBands.map((band) => band.size))
  const minRow = Math.min(...rowBands.map((band) => band.size))
  if (minColumn < 12 || minRow < 12) {
    return { matched: false, reason: '网格太密（格子小于 12px），多半不是课表', report }
  }

  return {
    matched: true,
    reason: '',
    report,
    gray,
    ink,
    width,
    height,
    horizontal,
    vertical,
    rowBands,
    columnBands,
    cells,
    virtualEdges,
    table: { x0: left, y0: top, x1: right, y1: bottom, width: right - left + 1, height: bottom - top + 1 },
  }
}

/* ------------------------------- 单元格文本 → 课程字段 ------------------------------- */

const VENUE_WORDS = /(多媒体|校区|楼|馆|中心|教室|机房|实验室|场地|园区)/
/**
 * 周次切分用的"地点起点"：比 `VENUE_WORDS` 多认几个**只有地点才会用**的字。
 *
 * `海` / `山` 单独出现不像课程名（"海洋科学"这种课名里虽然有"海"，
 * 但它前面会紧跟着一个周次数字，仍然会被正确切出来）；而真机 OCR 会把
 * "四海楼"读成"四海释"、把"凌海/西山"读成"姿海/西川/次海"，
 * 这些错读都会丢掉"楼/校区"两个字，只留下"海"。不认这个字，
 * 教室号 `201` 就会被当成"第 201 周"。
 */
const VENUE_START_WORDS = /(多媒体|校区|楼|馆|中心|教室|机房|实验室|场地|园区|海|山)/
const WEEK_TOKEN = /(单|双)?\s*(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})/
const SINGLE_WEEK_TOKEN = /(单|双)?\s*第?\s*(\d{1,2})\s*周/
/**
 * 课程号（选课序号）的形态：`(9913000172.08)`、`(9913000192.B0)`（版本号是字母）、
 * 以及 OCR 读丢左括号后的 `9913010460.01)`。
 *
 * 版本号那一节**也必须允许字母**：真机上 `(9913000192.B0)` 的 `.B0` 是字母，
 * 只认数字会让课程号读不出来，周次解析还会把 `B0` 的 `0` 当成"第 0 周"混进来。
 * 开头那个 `[（(]?` 是可选的：括号被读丢时同样要能认出课程号。
 */
const COURSE_CODE = /^[（(]?\s*\d{5,}\s*[.．]?\s*[0-9A-Za-z]{0,4}\s*[)）]?$/
const COURSE_CODE_GLOBAL = /[（(]?\s*\d{6,}\s*[.．]\s*[0-9A-Za-z]{1,4}\s*[)）]?|[（(]\s*\d{6,}\s*[)）]/g
/** 裸露的课程号（括号被读丢）：连续 6 位以上数字 + `.版本号`，版本号允许字母。 */
const COURSE_CODE_SERIAL = /\d{6,}\s*[.．]\s*[0-9A-Za-z]{1,4}\s*[)）]?/
const COURSE_CODE_RE = new RegExp(COURSE_CODE_SERIAL.source, 'g')
const TEACHER_LIKE = /^[\u4e00-\u9fa5]{2,4}([,，、][\u4e00-\u9fa5]{2,4}){0,3}$/
const CN_NAME = /[\u4e00-\u9fa5]{2,}/

/** 全角括号统一成半角、破折号统一成 '-'，方便后面的规则只写一套。 */
export function normalizeCellText(raw) {
  return String(raw || '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[—–−]/g, '-')
    .replace(/[\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 把一段文字切成"括号组 / 非括号文字"。
 *
 * **不做嵌套配对**：OCR 经常把课程名里的右括号读丢（"(B-2"、"(双语"、"(C++"），
 * 一旦按嵌套解析，后面所有字段都会被并进同一个括号组，名称与地点就全乱了。
 * 只认"最内层、括号配对完整"的组，剩下的文字按原样当普通段落，由分类逻辑逐段判断。
 *
 * **左括号被读成 `[` 也算括号起点**：真机复现（密集横版课表）里，
 * `计算方法与应用[9913030380.02)` 的 `(` 被读成 `[`，若只认 `(`，
 * 课程号就要么进不了括号组、要么被当成课程名的一部分（"计算方法与应用[)(E5i8)…"）。
 * 这里只在**配对不完整**时才动手：把找不到配对的 `[`/`(` 补一个 `)`、把多出来的 `)` 去掉，
 * 不改动任何已经配对好的括号组，因此别的版式读数一个字符都不会变。
 */
export function splitParenSegments(text) {
  const value = String(text || '')
  const segments = []
  const pattern = /[（(\[【]([^()（）\[\]【】]*)[)）\]】]/g
  let cursor = 0
  let match = pattern.exec(value)
  while (match) {
    if (match.index > cursor) segments.push({ text: value.slice(cursor, match.index), paren: false })
    segments.push({ text: match[0], paren: true })
    cursor = match.index + match[0].length
    match = pattern.exec(value)
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor), paren: false })
  return segments.filter((segment) => segment.text.trim())
}

/**
 * 课程名清理：去掉课程号、去掉首尾 OCR 噪声，并把被读丢/读多的括号补齐。
 * 只做"补全括号"这种可逆的形态修复，不改任何汉字。
 */
export function repairName(raw) {
  let name = String(raw || '')
    // 括号写全的课程号，以及 OCR 把左括号读丢时裸露的课程号（十几位数字 + . 版本号）
    .replace(COURSE_CODE_GLOBAL, '')
    .replace(COURSE_CODE_RE, '')
    .replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9)）+]+$/, '')
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH)
  const opens = (name.match(/[（(]/g) || []).length
  const closes = (name.match(/[)）]/g) || []).length
  if (opens > closes) return name + ')'.repeat(opens - closes)
  if (closes > opens) return name.slice(0, name.length - (closes - opens))
  return name
}

function stripParens(text) {
  return String(text || '').replace(/^[（(]/, '').replace(/[)）]$/, '').trim()
}

/** 汉字（不含全角标点）。
 *
 * `[\u4e00-\u9fa5]` 这个常用范围**把全角标点也包进去了**（`，` `：` `；` `、` 都在里面），
 * 于是"最后一段连续汉字"会把 `,励志楼` 连成一段、把地点起点算错。
 * 这里显式排掉全角标点，只留真正的汉字。
 */
const HANZI = /[\u4e00-\u9fa5]/
const HANZI_RUN = /[\u4e00-\u9fa5]+/g

/**
 * 一格文本里所有**课程号（选课序号）**出现的位置 `{at, end}`。
 *
 * 判据只有一条，不作任何课程名/地点猜测：括号组的内容就是课程号
 * （6 位以上数字 + `.版本号`，允许 OCR 读丢左括号）。于是
 *   - `(9913000050.04)` / `9913010460.01)` 都算；
 *   - 课程名自带的 `(双语)` / `(计算机类)` / `(C++)`、老师括号 `(张伟)`、
 *     周次/地点括号 `(1-15,学汇楼-302(多媒体)(西山校区))` 都**不算**。
 *
 * **优先用括号里的课程号**：括号里的没有歧义；只有整格都找不到括号课程号
 * （左括号被 OCR 读丢）时才退化到裸露的课程号。不这样分，地点括号里
 * "恰好有 6 位以上数字"的场地编号会被当成第二个课程号，一门课被切成两条
 *（`(1-12,基础楼-数理楼物理实验6(东山校区))`）。
 */
function courseCodeSpans(value) {
  const bracketed = []
  const bare = []
  const pattern = new RegExp(COURSE_CODE_SERIAL.source, 'g')
  let match = pattern.exec(value)
  while (match) {
    const span = { at: match.index, end: match.index + match[0].length }
    const before = match.index > 0 ? value[match.index - 1] : ''
    if (/[（(\[【]/.test(before)) bracketed.push(span)
    else bare.push(span)
    match = pattern.exec(value)
  }
  return bracketed.length ? bracketed : bare
}

/**
 * 去掉汉字串**尾部**夹带的地点字段（`专业导论学汇楼` → `专业导论`），没有地点词时原样返回。
 *
 * 真机上"课程名"这一段经常被上一条的地点粘住（`…(9913018280.01) 学汇楼-108…`），
 * 或地点被读坏后仍带地点字（`(次海校区)` 里的 `海`）。判据只认地点词字符，
 * 不认识任何具体课程名：从**最后一个**地点字往前退到"最后一个非地点汉字"，
 * 再跳过紧挨着的收尾符号（`）` / `,` / 数字），剩下的就是名字。
 */
function trimTrailingVenueFields(value) {
  const at = value.search(VENUE_WORDS)
  if (at < 0) return value
  let end = at
  while (end > 0 && !HANZI.test(value[end - 1])) end -= 1
  return value.slice(0, end)
}

/**
 * 在 [from, to) 里挑**记录开头**（课程名）的位置，取不到返回 -1。
 *
 * 一个格子里每条记录都写成「课程名 + 课程号 + (周次, 地点)」，所以两条记录之间
 * 可能夹着上一条的周次/地点、老师括号、甚至**地点名**（`…(西山校区))\n数据结构(1713…)`）。
 * 判据（不认识任何具体课程名）：
 *   - 汉字串尾部粘着地点字段的（`专业导论学汇楼`）先削掉地点再判定；
 *   - 削完仍带 `楼馆区校场地…` 或 `多媒体` 的是地点，不是课程名；
 *   - 剩下的候选里取**最长**的一段（`电路与电子技术(双语)` 要取整名而不是 `双语`），
 *     长度相同时取**靠前**的一段（`西山校区` / `数据结构` 等长时必须取课程名）。
 */
function nameStartIn(value, from, to) {
  const candidates = []
  let runStart = -1
  for (let i = from; i <= to; i += 1) {
    const isHanzi = i < to && HANZI.test(value[i])
    if (isHanzi) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      const span = trimTrailingVenueFields(value.slice(runStart, i))
      if (span && !VENUE_WORDS.test(span) && !VENUE_BUILDING.test(span)) {
        candidates.push({ start: runStart, end: runStart + span.length })
      }
      runStart = -1
    }
  }
  if (!candidates.length) return -1
  return candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)[0].start
}

/** 把一格文本切成"一门课一段"：每段从**自己那条记录的课程名**开始。 */
export function splitCellTextIntoEntries(rawText) {
  const text = normalizeCellText(rawText)
  if (!text) return []
  const codeSpans = courseCodeSpans(text)
  if (!codeSpans.length) return [{ text, index: 0 }]
  const starts = [0]
  if (codeSpans.length) {
    let previousEnd = 0
    for (const span of codeSpans) {
      // 每一条记录从"自己的课程名"开始：在**上一组课程号之后**、这一组课程号之前
      // 挑出课程名（地点/老师那种汉字串不算）。课程名紧跟着课程号写
      //（`高等数学(1713…)`）时挑到的就是课程名；课程号另起一行、名称自带括号时
      //（`…(双语)\n(1713…)`）挑到的是名称尾部的括号，这种碎片由 parseCellEntries
      // 并回上一条，不会多出候选。
      const at = nameStartIn(text, previousEnd, span.at)
      if (at >= 0 && at > starts[starts.length - 1]) starts.push(at)
      previousEnd = span.end
    }
  }
  const entries = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : text.length
    const slice = text.slice(from, to).trim()
    if (slice) entries.push({ text: slice, index: entries.length })
  }
  return entries
}

/**
 * [from, to) 之内**最后一段像地点的连续汉字**（地点名的起点），取不到返回 null。
 *
 * 为什么不取"最后一段连续汉字"：`励志楼-204多媒体西山校区` 里最后一段是"西山校区"，
 * 会把真正的楼名（励志楼-204）丢掉。也不取"第一段带楼字的"：`(1-16,学汇楼-302(多媒体)…`
 * 前面还有老师括号 `(李华)` 那种噪声。取"最后一段不短于 3 个字的汉字串"最稳：
 * 楼名（励志楼 / 学汇楼 / 电航楼 / 扬帆楼 / 百川楼）都至少有 3 个字，
 * 而 `楼-302`、`西山校区` 这种被切碎的片段要么太短、要么根本不是起点。
 */
/**
 * [from, to) 之内**第一段像地点的连续汉字**（地点名的起点），取不到返回 null。
 *
 * 为什么取"第一段"而不是"最后一段"：真机上地点可能写成两个楼名连用
 * （`基础楼-数理楼物理实验6(东山校区)`），取最后一段只剩 `数理楼…`，会把场地名读丢。
 *
 * 为什么从"周次里的第一个数字"之后才开始找：老师括号里也可能带地点字
 * （`(林秀英)` / `(林敏)` 这种被 OCR 读成 `馆`、`园` 的噪声），
 * 而周次字段**总是以数字开头**，跳过它前面的字就不会把老师当楼名。
 */
function locationStart(value, from, to) {
  HANZI_RUN.lastIndex = from
  let match = HANZI_RUN.exec(value)
  while (match && match.index + match[0].length <= to) {
    if (match[0].length >= 2 && VENUE_BUILDING.test(match[0])) return match.index
    match = HANZI_RUN.exec(value)
  }
  return -1
}

/** 楼宇类地点词：只有带这些字的汉字串才可能是"地点名的起点"。 */
const VENUE_BUILDING = /(楼|馆|中心|教室|机房|实验室|场地|园区|基地)/

/**
 * 从字符串开头读"楼名 + 教室号"（`学汇楼-412` / `基础楼-数理楼物理实验6` / `教一101`）。
 *
 * 用逐字扫描而不是一条正则：`[\u4e00-\u9fa5]{0,7}` 会把教室号的数字一起吃掉，
 * 回溯时又吐不出来，`…物理实验6` 就丢了 `6`。扫描规则：
 *   - 开头最多 4 个汉字里必须出现一个地点字（`楼/馆/…/教`）；
 *   - 之后可以继续吃汉字与 `-` / 空格（`基础楼-数理楼物理实验`），
 *     但**遇到数字先停**（数字是教室号），汉字最多吃到 12 个（名字长度上限）；
 *   - 收尾吃可选分隔符 + 教室号数字；没有数字也接受（`体育馆`）。
 */
function venueNamePrefix(value) {
  let cursor = 0
  let venueAt = -1
  // 楼名前缀最多看 6 个汉字：`学汇楼` / `基础楼` 的地点字在第 3 位，
  // 只看 4 个会把 `学汇楼` 误判成"没有楼名"，整段地点就丢了
  //（真机复现：`德济楼-103` 被降低成 `多媒体西山校区`）。
  for (let i = 0; i < value.length && i < 6; i += 1) {
    if (!HANZI.test(value[i])) break
    cursor = i + 1
    if (VENUE_CHAR.test(value[i])) {
      venueAt = i
      break
    }
  }
  if (venueAt < 0) return ''
  // 楼名的余下汉字与教室号：**遇到数字先停**（数字是教室号）。
  let digitsAt = -1
  for (let i = cursor; i < value.length && i < venueAt + 12; i += 1) {
    const ch = value[i]
    if (/\d/.test(ch)) {
      digitsAt = i
      break
    }
    if (HANZI.test(ch) || /[-\s]/.test(ch)) {
      cursor = i + 1
      continue
    }
    break
  }
  if (digitsAt < 0) return value.slice(0, cursor).replace(/\s/g, '')
  // 教室号之后如果还有汉字，可能只是地点词（`教一101多媒体`），也可能是楼名的后半段
  // 与真正的教室号（`基础楼-数理楼物理实验6`）。判据：地点词就停；
  // 否则继续看，**下一个数字才是教室号**。
  let lastDigitEnd = digitsAt
  let i = digitsAt
  while (i < value.length && i < venueAt + 12) {
    if (/\d/.test(value[i])) {
      lastDigitEnd = i + 1
      i += 1
      continue
    }
    if (/[-\s]/.test(value[i])) {
      i += 1
      continue
    }
    if (HANZI.test(value[i])) {
      const word = VENUE_WORD_TOKEN.exec(value.slice(i))
      if (word && word.index === 0) break
      i += 1
      continue
    }
    break
  }
  return value.slice(0, lastDigitEnd).replace(/\s/g, '')
}

/**
 * 地点字段的形状（按固定书写顺序拼）：
 *   1. 楼名 + 教室号（`学汇楼-412`，教室号可省：`体育馆-副馆场地 1`）；
 *   2. 地点词：`(多媒体)` / `(多媒体教室)`；
 *   3. 校区：`(西山校区)` / `(凌海校区)`。
 * 只保留这三类里的汉字与教室号数字，**丢弃**其余一切 ——
 * `E=H)(3.四海楼-604…` 的 `E=H)(3.`、`励志楼-204SHE` 的 `SHE`、多余的括号，
 * 都是 OCR 噪声或排版碎片，混进地点会让"地点对不对"没法判。
 * 判据只用地点字与标点，不认识任何具体楼名或课程。
 */
const VENUE_CHAR = /[楼馆区场室心教]/
/** 地点词。 */
const VENUE_WORD_TOKEN = /多媒体[教教]?室?|语音室|机房|实验室|实训室|报告厅|阶梯教室|体育馆|体育场/
/** 校区：`校区` 前面最多 3 个汉字（`西山校区` / `凌海校区` / `东山校区`）。 */
const VENUE_CAMPUS_TOKEN = /[\u4e00-\u9fa5]{0,3}校区/

/**
 * 从"课程号之后"的整段文字里抽出干净的地点文本 → 找不到地点返回 null。
 *
 * 为什么不是"从楼名原样截到结尾"：真机（密集横版课表）里楼名后面常粘着
 * 半个括号、OCR 噪声与错读的校区名（`励志楼-204SHE西山校区`、`E=H)(3.四海楼-604…`），
 * 原样保留会把噪声写进用户的课表，也没法判断识别对不对。
 * 这里只认"楼名 / 多媒体 / 校区"三种记号，按上表顺序拼出去，其它字符一律不要。
 */
function extractVenueText(value) {
  // 跳过地点字段开头的 ASCII / 符号噪声（`EPD1-16学汇楼-412…` 的 `EPD1-16`）：
  // 这些是老师名或课程号被读坏后的残渣，楼名一定从汉字开始。
  const from = value.search(/[\u4e00-\u9fa5]/)
  const source = from >= 0 ? value.slice(from) : value
  const head = venueNamePrefix(source)
  // 地点词与校区**只在楼名之后**找：书写顺序固定，楼名之前的字都是噪声或错读的老师名。
  const rest = source.slice(head.length)
  const word = VENUE_WORD_TOKEN.exec(rest)
  const afterWord = word ? rest.slice(word.index + word[0].length) : rest
  const campus = VENUE_CAMPUS_TOKEN.exec(afterWord)
  const pieces = [head.replace(/\s/g, '')]
  if (word) pieces.push(word[0])
  if (campus) pieces.push(campus[0])
  const text = pieces.join('')
  return text.length > 1 ? text : null
}

/**
 * 从"课程号之后"的文字里取上课地点。
 *
 * 调用方已经把开头那段序号（`人3,` / `间,` / `售.`）切掉了，这里只做清理：
 * 去掉括号与空白，并补上被读丢的右括号（`(1-16,学汇楼-302(多媒体)(西山校区)`）。
 * 念不出地点词、或长得不像地点的一律返回 null（不猜）。
 */
function locationFromTail(tail) {
  const value = normalizeCellText(tail)
  // 从带教室号的地点开始，而非最后一个逗号；一条安排可能包含两个实验地点。
  // 不跨数字/括号匹配前缀，避免把前面的教师和教学周拼进楼名。
  const firstVenue = value.match(/[\u4e00-\u9fa5]{1,7}(?:楼|馆|中心|场地|教室|实验室)[\u4e00-\u9fa5\s-]*\d+|教[\u4e00-\u9fa5]+\d+/)
  if (firstVenue) {
    return value.slice(firstVenue.index).replace(/\s+/g, '').replace(/[()（）{}\[\]【】]/g, '').replace(/[,，;；]+$/, '') || null
  }
  // 锚点：课程号之后的**第一个左括号**才是"周次/地点"字段的开头。
  // 它前面的文字是老师（`(李华)`）或 OCR 噪声（`FEn`），不能进地点。
  const bracketAt = value.search(/[（(\[【]/)
  const cleaned =
    bracketAt >= 0
      ? value.slice(bracketAt).replace(/[（()\[\]【】]/g, '')
      : value.replace(/[（()\[\]【】]/g, '')
  const collapsed = cleaned.replace(/\s+/g, '').replace(/^[,，、;；:：.\-–—]+/, '').replace(/[,，、;；:：]+$/, '')
  // 周次字段与地点之间用 `,` / 空格隔开（`1-16,学汇楼-302…`）。**只用分隔符右边**那段：
  // 分隔符左边是周次，再往左是老师名（`王敏1-16,教一101…` 里的 `王敏`），
  // 不能拿它们当楼名。OCR 把分隔符读丢时（`王敏1-16教一101…`）只能退回整段，
  // 由后面的提取器挑出"带地点字的那一段"。
  const lastSeparator = Math.max(collapsed.lastIndexOf(','), collapsed.lastIndexOf('，'))
  const head = lastSeparator >= 0 ? collapsed.slice(lastSeparator + 1) : collapsed
  // 分隔符右边优先；但真机里逗号常被读成别的符号（`(3 5-18 .四海楼-604…)`），
  // 此时 head 里没有楼名，只剩 `多媒体西山校区`。**只要有楼名就优先楼名**：
  // 只认"带楼/馆/中心…的那一段"，所以 `王敏1-16,教一101…` 里的老师名不会被误选。
  const fromHead = extractVenueText(head)
  const fromWhole = extractVenueText(collapsed)
  const venue = hasBuilding(fromHead) || !fromWhole ? fromHead : fromWhole
  return venue && venue.length <= 40 ? venue : null
}

/** 地点文本里是否带"楼/馆/中心…"这类楼名（`西山校区`/`多媒体` 只有校区或地点词）。 */
function hasBuilding(venue) {
  return Boolean(venue) && VENUE_BUILDING.test(venue)
}

/**
 * 一格文本 → 一门课的字段。**一格多课时**把切开以后"没有自己课程号"的碎片并回上一条：
 * 那种碎片只是课程名被切成两半（`电路与电子技术` + `双语(9913030310.02)…`），
 * 自己单独成条会凭空多出一条无名的候选。并回时**周次片段按原文补齐**，
 * 上面的碎片里漏掉的周次不会丢（`(9913030310.02)` 与周次分在两段的情形）。
 */
export function parseCellEntries(rawText) {
  const text = normalizeCellText(rawText)
  if (!text) return []
  const pieces = splitCellTextIntoEntries(text).map((entry) => ({
    ...parseTableCellText(entry.text),
    raw: entry.text,
  }))
  const merged = []
  for (const piece of pieces) {
    const previous = merged[merged.length - 1]
    if (previous && !piece.courseCode) {
      const byKey = new Map()
      for (const clause of [...(previous.clauses ?? []), ...(piece.clauses ?? [])]) {
        const key = `${clause.startWeek}-${clause.endWeek}-${clause.weekPattern}`
        if (!byKey.has(key)) byKey.set(key, clause)
      }
      previous.clauses = [...byKey.values()]
      previous.raw = `${previous.raw}${piece.raw}`
      continue
    }
    merged.push(piece)
  }
  return merged
}

/**
 * 一格文本 → 一门课的字段。**整格一条**的旧接口（多课场景用 parseCellEntries）。
 *
 * 铁律：课程号、老师、周次、地点**绝不拼进课程名**。名称只取课程号之前的文字，
 * 以及课程名自带的括号（(B-2) / (双语) / (2) / (C++) / (计算机类)）。
 * 周次**全部**取出来放进 `clauses`（`单5-7` 与 `单13-15` 各算一段），
 * `startWeek/endWeek/weekPattern` 保持"第一段"的旧语义，供只看单段的调用方使用。
 * 读不出来的字段留 null，由调用方给出 warning，不猜。
 */
export function parseTableCellText(rawText) {
  const text = normalizeCellText(rawText)
  // 课程号：优先括号里的（`(9913000172.08)` / `(9913000192.B0)`），其次裸露的（括号被读丢）。
  const codeMatch = text.match(COURSE_CODE_SERIAL)
  const codeStart = codeMatch?.index ?? text.length
  const codeEnd = codeMatch ? codeMatch.index + codeMatch[0].length : text.length
  // 名称 = 课程号之前的文字，但要在**第一个地点词**处截断（`EPD(1-16学汇楼-412(多媒体)`）。
  const before = text.slice(0, codeStart)
  const venueAt = before.search(VENUE_START_WORDS)
  const nameRegion = venueAt >= 0 ? before.slice(0, venueAt) : before
  const name = repairName(nameRegion)
  const body = text.slice(codeEnd)
  const location = locationFromTail(body)
  const clauses = weekClausesFromText(body)
  const teacher = teacherFromTail(body)
  const primary = {
    name,
    teacher,
    courseCode: codeMatch ? codeMatch[0].replace(/[.．]/g, '.').replace(/[（()）\s]/g, '') : null,
    startWeek: clauses[0]?.startWeek ?? null,
    endWeek: clauses[0]?.endWeek ?? null,
    weekPattern: clauses[0]?.weekPattern ?? null,
    clauses,
    location,
    raw: text,
  }
  // 名称里混进了老师/周次/地点，说明这一格的版式不是"课程号 + 括号字段"，
  // 退到"每行一个字段"的通用拆法（同样不把字段拼进课程名）。
  if (!nameLooksClean(primary.name)) {
    const fieldParsed = parseCellFieldLines(text)
    if (nameLooksClean(fieldParsed.name)) {
      return { ...fieldParsed, clauses: weekClausesFromText(text), raw: text }
    }
  }
  return primary
}

/** 课程号之后的第一个"像人名"的括号（2-4 个汉字、不含地点词）当老师。 */
function teacherFromTail(tail) {
  const pattern = /[（(]([^()（）]*)[)）]/g
  let match = pattern.exec(tail)
  while (match) {
    const content = match[1].trim()
    if (TEACHER_LIKE.test(content) && !VENUE_WORDS.test(content) && !/\d/.test(content)) return content
    match = pattern.exec(tail)
  }
  return null
}

/** 「单1-15」「双2-16」「1-16」「7-8」→ 起止周与单双周。读不出返回 null。 */
export function weeksFromText(text) {
  const clauses = weekClausesFromText(text)
  return clauses[0] ?? null
}

/**
 * 一段文字里**所有**教学周片段（顺序保留）。
 *
 * 真机复现（密集横版课表）里同一个格子会写「单5-7」「单13-15」两段互不相邻的周次，
 * 也可能写「3,5-18」「1,5-15(单)」「1-13,16」这种"单周 + 范围"的混合。
 * 只取第一段会丢掉后面的课（复核对要求"不丢周、不加周"），因此这里全部取出来，
 * 由调用方按"DB 里连续范围/单双周可以表示成多条候选"的方式各生成一条候选。
 *
 * 规则只认数字与单双周标记，不认任何课程名：
 *   - `单5-7` / `双2-16` / `5-7` → 起止周 + ODD/EVEN/ALL；
 *   - 单独的 `12` / `3` 这类 1-53 的整数 → 单周快照；
 *   - 前面带 `/` 的（`1-13 / 16`）算新片段，其余先并成范围（`3 5-18` → `3`,`5-18`）。
 */
export function weekClausesFromText(text) {
  const value = stripNonWeekTokens(normalizeCellText(text))
  const clauses = []
  const pattern = /(单|双)?\s*(?:第\s*)?(\d{1,2})\s*(?:(?:[-–—~至到]\s*(\d{1,2}))|周)?/g
  let match = pattern.exec(value)
  while (match) {
    const marker = match[1]
    const first = Number(match[2])
    const hasRange = match[3] !== undefined
    const second = hasRange ? Number(match[3]) : first
    const consumedTo = match.index + match[0].length
    // 前置判断按**数字本身**的位置算，不能按匹配起点：正则会把分隔空格
    //（`1-13 16` 里 `16` 前面的空格）一起吃进来，按匹配起点看会误判成"紧贴数字"。
    const digitAt = match.index + match[0].indexOf(match[2])
    const prevChar = digitAt > 0 ? value[digitAt - 1] : ''
    // 空格是周次列表的分隔符（`1-13 16` / `3 5-18`），不是"紧贴数字"。
    const separatedBySpace = /\s/.test(prevChar)
    // 课名/课程号里的数字不算周次："B-2" 的 2 前面是字母，"9913000172.08" 里的数字更长。
    const blockedByNeighbour = !separatedBySpace && /[0-9A-Za-z.．]/.test(prevChar)
    // 教室号（"楼-302" / "场地 1" 这种）不是周次：数字紧跟在一根横杠或某个地点字后面。
    const roomNumber = /[楼馆区场室心\-–—]/.test(prevChar)
    // 单独的数字（`3` / `12` / `16`）就是真实的"第 N 周"：空格与逗号都只是分隔符
    //（`3 5-18` / `3,5-18` / `1 单5-15` / `1-13 16` 里的每一个数字都是图上写着的周次）。
    // **不能**因为它后面跟着范围就丢掉 —— 那样会把图上明明白白写着的第 3 周 / 第 1 周 /
    // 第 16 周整条丢掉（复核对要求"不丢周"）。唯一的排除项是真正的歧义来源：
    // 紧贴在数字/小数点后面（课程号残留）或紧跟在横杠/地点字后面（教室号）。
    const after = value.slice(consumedTo)
    const followedBySlash = /^\s*[\/／]\s*\d/.test(after)
    const standalone = !hasRange && !blockedByNeighbour && !roomNumber && !marker && !followedBySlash
    const marked = Boolean(marker) || /周/.test(match[0])
    if (first >= 1 && second >= 1 && first <= 53 && second <= 53 && !blockedByNeighbour && !roomNumber && (hasRange || standalone || marked)) {
      // 单独的周次必须落在**周次字段**里，才可能是周次。判据（都来自真机复现）：
      //   - 带"周"或"单/双"字样（`第7周` / `1周` / `单5-15`）；
      //   - 或与相邻周次用**逗号/空格/制表符**分隔成一段列表
      //     （`3,5-18` / `3 5-18` / `1-13 16` / `1 单5-15`）。
      // 否则只是散落在格子里的数字碎片 —— 例如老师名被读坏后**单独占一行**的 `10`
      //（`…(9913000172.08)\n10\n(1-16 .励志楼-204…)`），当成"第 10 周"会凭空多一条候选。
      // 换行**不算**列表分隔符：那是"另一行"，不是同一段周次列表。
      const precededByComma = /[,，、]\s*$/.test(value.slice(0, match.index))
      const precededBySpace = /[ \t]$/.test(value.slice(0, digitAt))
      const followedByComma = /^[ \t]*[,，、]/.test(after)
      const followedBySpace = /^[ \t]/.test(after)
      // 正则会把分隔空格吃进上一段（`3 ` 后面才是 `5-18`），
      // 所以"匹配自己以空格结尾"同样是**列表分隔**的证据。
      const tokenEndsWithSpace = /[ \t]$/.test(match[0])
      const inWeekField =
        marked || precededByComma || followedByComma || precededBySpace || followedBySpace || tokenEndsWithSpace
      if ((hasRange || marked || (standalone && inWeekField))) {
        const start = Math.min(first, second)
        const end = Math.max(first, second)
        const weekPattern = marker === '单' ? 'ODD' : marker === '双' ? 'EVEN' : 'ALL'
        clauses.push({ startWeek: start, endWeek: end, weekPattern, token: match[0].trim() })
        // 「1-13 / 16」这种斜杠分段：第二个数字要单独成段。
        const slash = value.slice(consumedTo).match(/^\s*[\/／]\s*(\d{1,2})(?!\d)/)
        if (slash) {
          const week = Number(slash[1])
          if (week >= 1 && week <= 53) {
            clauses.push({ startWeek: week, endWeek: week, weekPattern, token: `/${week}` })
          }
          pattern.lastIndex = consumedTo + slash[0].length
        }
      }
    }
    match = pattern.exec(value)
  }
  // 单双周标记也可能写在周次**后面**另起一段（`1-16周(单)` / `(1-16)(单)`）：
  // 这不是新周次，而是给**上一段周次**加的单双周限定，必须回填，
  // 否则整周规律被读成"每周"（样例 `timetable-grid.png` 就是这样退化的）。
  const trailingMarker = value.match(/[（(]\s*([单双])\s*[)）]\s*$/)
  if (trailingMarker && clauses.length) {
    const last = clauses[clauses.length - 1]
    if (last.weekPattern === 'ALL' && last.endWeek - last.startWeek >= 2) {
      last.weekPattern = trailingMarker[1] === '单' ? 'ODD' : 'EVEN'
    }
  }
  return mergeAdjacentSingleWeeks(clauses)
}

/**
 * 先把"不可能是周次"的长数字（课程号）与"地点"部分去掉，再去找周次。
 *
 * 真机复现：`(1-16,学汇楼-302(多媒体)(西山校区))` 里的 `302` 是教室号，
 * `(1,扬帆楼-102(西山校区))` 里的 `102` 也是教室号 —— 不先去地点，
 * 它们都会被当成"第 302 周 / 第 102 周"这种荒唐的周次。
 * 规则只说"哪里不可能是周次"，不认识任何具体课程或教室。
 */
function stripNonWeekTokens(value) {
  // 课程号：连续 6 位以上数字（含 `9913000172.08`、`9913000192.B0` 这种带版本号的写法）。
  // 连带它后面的右括号一起去掉，免得留下孤零零的 `)` 打乱后面的括号组判定。
  const withoutCodes = value.replace(/\d{6,}(?:[.．][0-9A-Za-z]{1,4})?[)）]?/g, ' ')
  // 老师括号（纯汉字、无数字）不是周次字段：`(王敏)(1-16,教一101(多媒体))` 里
  // 老师名紧跟周次，不先去掉，"王敏" 会被 地点截断逻辑当成本格第一个地点词。
  // **单/双/周标记的括号不能去**（`1-16周(单)` 的 `(单)` 是单双周证据，
  // 去掉它整周规律就被读成"每周"了）。
  const withoutTeacher = withoutCodes.replace(/[（(][^0-9()（）]*[)）]/g, (group) => {
    const content = group.replace(/^[（(]|[)）]$/g, '')
    // 只含单/双/周标记的括号是周次证据，不能当老师去掉。
    return /^[单双周第]+$/.test(content) ? group : ' '
  })
  // 教室号一定是 **3–4 位数字**（`103` / `302` / `604` / `数理楼物理实验6` 除外），
  // 而且前面不会紧挨着数字或横杠（周次范围写成 `1-16`，横杠隔开）。
  // 真机复现：`德济楼-103` 被读成 `德齐习103`，不先去掉 `103`，
  // `10` 就会被当成"第 10 周"，凭空多出一门课。
  const withoutRooms = withoutTeacher.replace(/(?<![\d\-])\d{3,4}(?!\d)/g, ' ')
  // 地点：第一个"地点词"之后的整段都不参与周次判定（周次总写在楼名/教室号前面）。
  const at = withoutRooms.search(VENUE_START_WORDS)
  return at >= 0 ? withoutRooms.slice(0, at) : withoutRooms
}

/**
 * 「7-8」这种范围本身就是 7 与 8 两周；相邻的单周片段（`1`,`5-15`）不能合并，
 * 但 `3`,`5-18` 里 3 不在范围内，同样保持两条 —— 这里只把**完全被前一段包住**的
 * 单周片段去掉（`(1,1-16)` 这种 OCR 重复读数），其余原样保留。
 */
function mergeAdjacentSingleWeeks(clauses) {
  const result = []
  for (const clause of clauses) {
    const covered = result.some(
      (kept) =>
        kept.startWeek <= clause.startWeek &&
        kept.endWeek >= clause.endWeek &&
        (kept.weekPattern === 'ALL' || kept.weekPattern === clause.weekPattern ||
          (clause.startWeek === clause.endWeek &&
            clause.startWeek % 2 === (kept.weekPattern === 'ODD' ? 1 : 0))),
    )
    if (!covered) result.push(clause)
  }
  return result
}


/**
 * 课程名里出现这些，说明字段被拼进名字了：老师后缀、周次、地点词、教学楼房间号。
 * 只用来决定"要不要换一种拆法"，不用来改写名字内容。
 */
const FIELD_LEAK = /(老师|周|多媒体|校区|教学楼|楼-?\s?\d|馆-?\s?\d|教室|机房|实验室|\d{1,2}\s*[-–—~]\s*\d{1,2})/
const MAX_NAME_LENGTH = 24

/** 拆出来的课程名是否干净（像课程名、没有夹带字段）。 */
export function nameLooksClean(name) {
  const value = String(name || '').replace(/\s+/g, '')
  if (!value || !CN_NAME.test(value)) return false
  if (value.length > MAX_NAME_LENGTH) return false
  if (FIELD_LEAK.test(value)) return false
  return true
}

/**
 * 单元格的通用兜底拆法：一行一个字段（"课程名 / 王老师 / 教一101 / 1-16周(单)"）。
 * 复用整图解析器里已经验证过的 extractWeeks / extractLocation / extractTeacher / looksLikeCourseName，
 * 规则只有一份；课程号、老师、周次、地点同样不会被拼进课程名。
 */
export function parseCellFieldLines(rawText) {
  const text = normalizeCellText(rawText)
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const withoutCode = (line) => normalizeCellText(line).replace(COURSE_CODE_GLOBAL, '')
  // 周次统一走 `weekClausesFromText`：单双周标记可能写在括号里另起一段
  //（`1-16周(单)`），只看 `extractWeeks` 会漏掉，整周规律被读成"每周"。
  const clauses = weekClausesFromText(text)
  const nameLine =
    lines.find((line) => !/^\(.*\)$/.test(line) && looksLikeCourseName(withoutCode(line))) || ''
  // 老师与地点逐行取：整段拼起来取会把上一行的字吃进姓氏里。
  const teacherLine = lines.find((line) => /老师/.test(line))
  const locationLine = lines.find((line) => line !== nameLine && extractLocation(withoutCode(line)))
  return {
    name: repairName(withoutCode(nameLine)),
    teacher: teacherLine ? extractTeacher(teacherLine) : null,
    courseCode: null,
    startWeek: clauses[0]?.startWeek ?? null,
    endWeek: clauses[0]?.endWeek ?? null,
    weekPattern: clauses[0]?.weekPattern ?? null,
    clauses,
    location: locationLine ? extractLocation(withoutCode(locationLine)) : extractLocation(text),
    raw: text,
  }
}

/** 左侧节次格：「1-2 / 8:00-9:35」→ 节次范围与上课时刻。
 *
 * 时刻按"读到的先后"取：第一段是开始时刻，最后一段是结束时刻。
 * 只读到一段时刻时**结束时刻留空**——不能拿开始时刻当结束时刻（那是编出来的时间），
 * 缺的那一段由调用方按候选给出提示。
 */
export function parseGutterCellText(rawText) {
  const lines = String(rawText || '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[—–−]/g, '-')
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const clocks = []
  for (const line of lines) {
    for (const match of line.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/g)) {
      clocks.push(`${String(Number(match[1])).padStart(2, '0')}:${match[2]}`)
    }
  }
  const startTime = clocks.length ? clocks[0] : null
  const endTime = clocks.length > 1 ? clocks[clocks.length - 1] : null

  let periodStart = null
  let periodEnd = null
  const withoutTimes = lines.join(' ').replace(/\d{1,2}\s*[:：]\s*\d{2}/g, ' ')
  const range = withoutTimes.match(/(\d{1,2})\s*[-–—~至到]\s*(\d{1,2})/)
  const single = withoutTimes.match(/(\d{1,2})/)
  if (range) {
    let start = Number(range[1])
    let end = Number(range[2])
    if (start > end) [start, end] = [end, start]
    if (start >= 1 && end <= 12) {
      periodStart = start
      periodEnd = end
    }
  }
  if (periodStart === null && single) {
    const value = Number(single[1])
    if (value >= 1 && value <= 12) {
      periodStart = value
      periodEnd = value
    }
  }
  return { periodStart, periodEnd, startTime, endTime }
}
