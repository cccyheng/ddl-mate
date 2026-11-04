/**
 * 课表照片的 OCR 结果解析器。
 *
 * 输入是 Tesseract.js 的识别结果（带 bbox 的行/字），输出是**候选课表**，供人工确认后写入数据库。
 * 三条策略，按顺序尝试：
 *   1. grid  ：常见"周一到周日分列 + 左侧时间/节次"的表格照片（用 bbox 分栏分行）；
 *   2. list  ：一行一门课的列表式课表（"课程 周X 起-止 地点 第A-B周 单/双/每周"）；
 *   3. region：用户框选单门课区域后的整块识别。
 *
 * 设计原则：
 *   - 只用文字规则 + 位置信息，不依赖某一种固定句式；
 *   - 缺失字段一律留空并给出 warnings，**不臆测**上课时间（例如不把"第1-2节"换算成具体时刻）；
 *   - 识别不确定的结果明确标注，交给人确认。
 *
 * 表头守卫（真实手机照片上出现的故障）：
 *   回退到整图识别时，OCR 最容易读准的是表头（周一…周日、10/12）与左侧时间栏（1、08:00）。
 *   这些**纯结构性标签**以前会以"名字恰好是周一/08:00"的形式混进候选，导进用户课表。
 *   现在由 `structuralLabels.js` 统一拦掉，并在"整批结果只有标签"时抛出明确的失败，
 *   而不是给一个看起来成功的空/垃圾结果。
 */

import { isStructuralCandidate, isStructuralLabel } from './structuralLabels.js'

const WEEKDAY_TEXT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 表头里常见的非星期列名（"时间"列会占掉最左边一列）。 */
const NON_WEEKDAY_HEADERS = /^(时间|节次|课程|星期|周次|备注|时段)$/

const FIELD_PATTERNS = {
  // 真实 OCR 里时间分隔符可能是 : . ：，结束时间也可能省略冒号（08.00-0940）
  timeRange: /(\d{1,2})\s*[:.：]\s*(\d{2})\s*[-–—~〜至到]\s*(\d{1,2})\s*[:.：]?\s*(\d{2})/,
  periodRange: /第?\s*(\d{1,2})\s*[-–—~〜至、,，]\s*(\d{1,2})\s*节/,
  weekRange: /第?\s*(\d{1,2})\s*[-–—~〜至到]\s*(\d{1,2})\s*周/,
  singleWeek: /第?\s*(\d{1,2})\s*周(?!\s*[-–—~〜至到])/,
  patternOdd: /单周|\(\s*单\s*\)|（\s*单\s*）|单数周/,
  patternEven: /双周|\(\s*双\s*\)|（\s*双\s*）|双数周/,
  patternAll: /每周/,
  location: /(教[一二三四五六七八九十\d]{1,3}[\dA-Za-z-]{0,6}|(?:实验|教学|综合|图书|体育|信息|工程)?楼\s?[\dA-Za-z-]{0,8}|[A-Za-z]?\d{2,4}\s*(?:教室|机房)|机房|实验室)/,
  teacher: /([\u4e00-\u9fa5]{1,5})\s*老师/,
  semesterStart: /第一周周一[^0-9]{0,6}(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/,
}

/** 全角转半角 + 去多余空白，便于正则匹配。 */
export function normalize(raw) {
  if (!raw) return ''
  let text = String(raw)
  text = text.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  text = text.replace(/\u3000/g, ' ')
  text = text.replace(/[—–−]/g, '-')
  text = text.replace(/〜|～/g, '~')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 真实 OCR 常把中文逐字分开（"高 等 数学"、"教 一 101"）。
 * 匹配字段前先把"汉字之间 / 汉字与数字之间"的空格去掉，这样规则不必为空格写两套。
 */
export function compact(raw) {
  let text = normalize(raw)
  for (let i = 0; i < 3; i += 1) {
    text = text
      .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
      .replace(/([\u4e00-\u9fa5])\s+(?=[\dA-Za-z])/g, '$1')
      .replace(/([\dA-Za-z])\s+(?=[\u4e00-\u9fa5])/g, '$1')
  }
  return text
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 对象是否有字段（空对象是 truthy，必须显式判断）。 */
function hasFields(value) {
  return Boolean(value) && Object.keys(value).length > 0
}

function formatTime(hour, minute) {
  const h = Number(hour)
  const m = Number(minute)
  if (Number.isNaN(h) || Number.isNaN(m) || h > 23 || m > 59) return null
  return `${pad2(h)}:${pad2(m)}`
}

/** 解析「08:00-09:40」→ { startTime, endTime }；识别不到返回空对象。 */
export function extractTime(text) {
  const match = compact(text).match(FIELD_PATTERNS.timeRange)
  if (!match) return {}
  const startTime = formatTime(match[1], match[2])
  const endTime = formatTime(match[3], match[4])
  return startTime && endTime ? { startTime, endTime } : {}
}

/** 解析「第1-2节」→ { periodStart, periodEnd }。不换算成具体时刻。 */
export function extractPeriods(text) {
  const match = compact(text).match(FIELD_PATTERNS.periodRange)
  if (!match) return {}
  return { periodStart: Number(match[1]), periodEnd: Number(match[2]) }
}

/** 解析教学周与单双周：「1-16周(单)」→ { startWeek, endWeek, weekPattern }。 */
export function extractWeeks(text) {
  const normalized = compact(text)
  const result = {}
  const range = normalized.match(FIELD_PATTERNS.weekRange)
  if (range) {
    let start = Number(range[1])
    let end = Number(range[2])
    if (start > end) [start, end] = [end, start]
    result.startWeek = start
    result.endWeek = end
  } else {
    const single = normalized.match(FIELD_PATTERNS.singleWeek)
    if (single) {
      result.startWeek = Number(single[1])
      result.endWeek = Number(single[1])
    }
  }
  if (FIELD_PATTERNS.patternOdd.test(normalized)) {
    result.weekPattern = 'ODD'
  } else if (FIELD_PATTERNS.patternEven.test(normalized)) {
    result.weekPattern = 'EVEN'
  } else if (FIELD_PATTERNS.patternAll.test(normalized)) {
    result.weekPattern = 'ALL'
  } else if (/单/.test(normalized) && /周/.test(normalized)) {
    result.weekPattern = 'ODD'
  } else if (/双/.test(normalized) && /周/.test(normalized)) {
    result.weekPattern = 'EVEN'
  } else if (result.startWeek) {
    // 写了起止周但没有任何"单/双/每周"字样 → 按每周处理（这是唯一合理的默认，不涉及时间臆测）
    result.weekPattern = 'ALL'
  }
  return result
}

export function extractLocation(text) {
  const match = compact(text).match(FIELD_PATTERNS.location)
  return match ? match[1].replace(/\s+/g, '') : null
}

export function extractTeacher(text) {
  const match = compact(text).match(FIELD_PATTERNS.teacher)
  if (!match) return null
  // 去掉"任课/授课/主讲/教师/教授"等前缀，只留姓氏
  const prefix = match[1].replace(/(任课|授课|主讲|教师|老师|教授)/g, '')
  const surname = prefix.slice(-2)
  return surname ? `${surname}老师` : null
}

/** 从「周一 / 星期一 / 礼拜一 / 一」等写法解析出 1-7。 */
export function extractWeekday(text) {
  const normalized = compact(text)
  const named = normalized.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/)
  if (named) {
    const token = named[1]
    if (/[1-7]/.test(token)) return Number(token)
    return WEEKDAY_TEXT[token] ?? null
  }
  return null
}

function weekdayFromToken(rawToken) {
  const clean = normalize(rawToken).replace(/[\s|]/g, '')
  if (!clean) return null
  if (NON_WEEKDAY_HEADERS.test(clean)) return null
  const match = clean.match(/^(?:周|星期|礼拜)?([一二三四五六日天1-7])$/)
  if (!match) return null
  const token = match[1]
  return /[1-7]/.test(token) ? Number(token) : WEEKDAY_TEXT[token] ?? null
}

function bboxOf(node) {
  const bbox = node?.bbox || {}
  const x0 = Number(bbox.x0 ?? 0)
  const x1 = Number(bbox.x1 ?? 0)
  const y0 = Number(bbox.y0 ?? 0)
  const y1 = Number(bbox.y1 ?? 0)
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

function lineCenter(line) {
  const bbox = bboxOf(line)
  return { cx: bbox.cx, cy: bbox.cy }
}

/** 把 Tesseract 的 blocks/paragraphs/lines(+words) 或 data.lines 统一成行数组。 */
export function flattenOcrLines(data) {
  if (!data) return []
  const lines = []
  const pushLine = (lineNode, fallbackBbox) => {
    const text = normalize(lineNode?.text || '')
    if (!text) return
    const bbox = bboxOf(Object.keys(lineNode?.bbox || {}).length ? lineNode : { bbox: fallbackBbox })
    const words = (lineNode?.words || [])
      .map((word) => ({ text: normalize(word?.text || ''), ...bboxOf(word) }))
      .filter((word) => word.text)
    lines.push({
      text,
      confidence: typeof lineNode?.confidence === 'number' ? lineNode.confidence : null,
      bbox,
      words,
    })
  }

  if (Array.isArray(data.lines) && data.lines.length) {
    data.lines.forEach((line) => pushLine(line, null))
  } else if (Array.isArray(data.blocks)) {
    for (const block of data.blocks) {
      for (const paragraph of block?.paragraphs || []) {
        for (const line of paragraph?.lines || []) {
          pushLine(line, paragraph?.bbox || block?.bbox)
        }
      }
    }
  }
  if (!lines.length && typeof data.text === 'string') {
    data.text
      .split(/\r?\n/)
      .map((text) => normalize(text))
      .filter(Boolean)
      .forEach((text, index) => {
        const bbox = { x0: 0, y0: index * 22, x1: 1000, y1: index * 22 + 18, cx: 500, cy: index * 22 + 9 }
        lines.push({ text, confidence: null, bbox, words: [] })
      })
  }
  return lines.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
}

/** 解析图片里的「第一周周一：YYYY-MM-DD」；不是周一则忽略并给出提示。 */
export function extractSemesterStart(lines) {
  const warnings = []
  for (const line of lines) {
    const match = normalize(line.text).match(FIELD_PATTERNS.semesterStart)
    if (match) {
      const date = `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`
      if (isMonday(date)) {
        return { semesterStartDate: date, warnings }
      }
      warnings.push(`图片里的学期起点 ${date} 不是周一，已忽略，请手动选择第一周周一`)
      return { semesterStartDate: null, warnings }
    }
  }
  return { semesterStartDate: null, warnings }
}

export function isMonday(dateString) {
  if (!dateString) return false
  const date = new Date(`${dateString}T00:00:00`)
  return !Number.isNaN(date.getTime()) && date.getDay() === 1
}

/** 导出给「有线框表格」单元格解析复用：一行文字像不像课程名。 */
export function looksLikeCourseName(text) {
  const normalized = compact(text)
  if (!normalized) return false
  if (FIELD_PATTERNS.teacher.test(normalized)) return false
  if (FIELD_PATTERNS.location.test(normalized)) return false
  if (FIELD_PATTERNS.timeRange.test(normalized)) return false
  if (FIELD_PATTERNS.periodRange.test(normalized)) return false
  if (FIELD_PATTERNS.weekRange.test(normalized) || /周/.test(normalized)) return false
  if (/^\d+$/.test(normalized)) return false
  if (NON_WEEKDAY_HEADERS.test(normalized)) return false
  if (/^\d{4}\s*[-/.年]/.test(normalized)) return false
  // 纯结构性标签（周一 / 10/12 / 08:00 / 第 7 周 …）不是课程名。
  if (isStructuralLabel(normalized)) return false
  if (isGarbled(normalized)) return false
  return /[\u4e00-\u9fa5A-Za-z]/.test(normalized)
}

/**
 * 识别 OCR 噪声：某个汉字反复出现（表头没认出来时常见「本本本可本本本」这类结果），
 * 或者整行几乎都是分隔符。这类行不能当课程名。
 */
function isGarbled(text) {
  const cjk = text.replace(/[^\u4e00-\u9fa5]/g, '')
  if (cjk.length >= 4) {
    const counts = new Map()
    for (const ch of cjk) counts.set(ch, (counts.get(ch) || 0) + 1)
    const max = Math.max(...counts.values())
    if (max / cjk.length > 0.6) return true
  }
  if ((text.match(/\|/g) || []).length >= 2 && cjk.length <= 6) return true
  return false
}

/** 该行是否是表头（包含多个星期列名）。返回命中的星期列数量。 */
export function countHeaderWeekdays(line) {
  const tokens = (line.words?.length ? line.words.map((word) => word.text) : line.text.split(/[\s|]+/))
    .map((token) => normalize(token))
    .filter(Boolean)
  return tokens.filter((token) => weekdayFromToken(token) !== null).length
}

export function findHeaderLine(lines) {
  let best = null
  for (const line of lines) {
    const hits = countHeaderWeekdays(line)
    if (hits >= 3 && (!best || hits > best.hits)) {
      best = { line, hits }
    }
  }
  return best
}

/** 表头行的每一列（星期 + x 中心）。优先用 word 级 bbox，回退到按 token 序号等分。 */
function headerColumns(line) {
  const columns = []
  if (line.words?.length) {
    for (const word of line.words) {
      const weekday = weekdayFromToken(word.text)
      if (weekday) columns.push({ weekday, cx: word.cx, inferred: false })
    }
    if (columns.length >= 3) return columns
  }
  const tokens = normalize(line.text).split(/[\s|]+/).filter(Boolean)
  const bbox = line.bbox
  const step = (bbox.x1 - bbox.x0) / Math.max(1, tokens.length)
  tokens.forEach((token, index) => {
    const weekday = weekdayFromToken(token)
    if (weekday) columns.push({ weekday, cx: bbox.x0 + step * (index + 0.5), inferred: false })
  })
  return columns
}

/** 该行是否像"星期列名"（例如 PSM 11 会把每个表头单元格识别成独立一行）。 */
function isWeekdayHeaderLine(line) {
  if (hasFields(extractTime(line.text)) || hasFields(extractPeriods(line.text))) return false
  if (/\d\s*[-–—~〜至到]\s*\d\s*周/.test(compact(line.text))) return false
  const weekday = weekdayFromToken(line.text)
  return weekday !== null
}

/**
 * 找表头列。
 *
 * 两种情况：
 *   1. 表头在一行里（"时间 周一 周二 …"）——用 word 级 bbox 定位每一列；
 *   2. 表头被拆成多行（PSM 11 SPARSE_TEXT 常见，每个单元格一行）——按 y 带聚成同一行表头，
 *      再用各自的 bbox x 中心定位列。
 *
 * 若检测到的星期之间有"空档"（例如漏识别了周三），按列间距推断出缺失列的位置，
 * 并标记 inferred=true —— 调用方必须提示用户确认，不能静默当成确定结果。
 */
export function findHeaderColumns(lines) {
  const single = findHeaderLine(lines)
  if (single) {
    const columns = headerColumns(single.line).sort((a, b) => a.cx - b.cx)
    if (columns.length >= 3) {
      return { columns, headerLine: single.line, headerLines: [single.line], inferredCount: 0 }
    }
  }

  // 情况 2：把同一 y 带里的星期标签行聚起来
  const labelled = lines.filter(isWeekdayHeaderLine)
  if (labelled.length < 2) return null
  const bands = []
  for (const line of labelled.slice().sort((a, b) => a.bbox.cy - b.bbox.cy)) {
    const last = bands[bands.length - 1]
    if (last && Math.abs(line.bbox.cy - last.cy) <= 40) {
      last.items.push(line)
      last.cy = (last.cy + line.bbox.cy) / 2
    } else {
      bands.push({ cy: line.bbox.cy, items: [line] })
    }
  }
  bands.sort((a, b) => b.items.length - a.items.length)
  const header = bands[0]
  if (header.items.length < 2) return null

  const detected = header.items
    .map((line) => ({ weekday: weekdayFromToken(line.text), cx: line.bbox.cx }))
    .filter((item) => item.weekday)
    .sort((a, b) => a.cx - b.cx)
  if (detected.length < 2) return null

  const columns = []
  let inferredCount = 0
  for (let index = 0; index < detected.length; index += 1) {
    const current = detected[index]
    const previous = columns[columns.length - 1]
    if (previous && current.weekday - previous.weekday > 1) {
      const missing = current.weekday - previous.weekday - 1
      const stepGuess = (current.cx - previous.cx) / (missing + 1)
      for (let step = 1; step <= missing; step += 1) {
        columns.push({
          weekday: previous.weekday + step,
          cx: previous.cx + stepGuess * step,
          inferred: true,
        })
        inferredCount += 1
      }
    }
    columns.push({ weekday: current.weekday, cx: current.cx, inferred: false })
  }

  return {
    columns,
    headerLine: null,
    headerLines: header.items,
    inferredCount,
  }
}

/** 把左侧时间/节次行聚成"行带"：同一行的时间行与节次行会挨得很近。 */
function buildRowBands(anchorLines) {
  const bands = []
  for (const anchor of anchorLines) {
    const last = bands[bands.length - 1]
    if (last && anchor.cy - last.maxCy <= 70) {
      last.lines.push(anchor.line)
      last.maxCy = Math.max(last.maxCy, anchor.cy)
      last.minCy = Math.min(last.minCy, anchor.cy)
      // 注意：空对象是 truthy，必须按"是否有字段"判断，否则会丢掉真正的时间/节次
      if (!hasFields(last.time)) last.time = anchor.time
      if (!hasFields(last.periods)) last.periods = anchor.periods
    } else {
      bands.push({
        lines: [anchor.line],
        minCy: anchor.cy,
        maxCy: anchor.cy,
        time: anchor.time,
        periods: anchor.periods,
      })
    }
  }
  return bands
}

/** 表格布局：按表头星期分列、按左侧时间/节次分行。 */
export function parseGrid(lines, options = {}) {
  const headerInfo = findHeaderColumns(lines)
  if (!headerInfo) return null
  const columns = headerInfo.columns.slice().sort((a, b) => a.cx - b.cx)
  if (columns.length < 2) return null
  const headerLines = new Set(headerInfo.headerLines)

  const firstColumnCx = columns[0].cx
  const columnStep = columns.length > 1
    ? (columns[columns.length - 1].cx - columns[0].cx) / (columns.length - 1)
    : 160

  const anchorLines = []
  for (const line of lines) {
    if (headerLines.has(line)) continue
    const center = lineCenter(line)
    if (center.cx > firstColumnCx - columnStep * 0.35) continue
    const time = extractTime(line.text)
    const periods = extractPeriods(line.text)
    if (!Object.keys(time).length && !Object.keys(periods).length) continue
    anchorLines.push({ line, cy: center.cy, time, periods })
  }
  anchorLines.sort((a, b) => a.cy - b.cy)
  const bands = buildRowBands(anchorLines)
  const headerBottom = Math.max(...headerInfo.headerLines.map((line) => line.bbox.y1))

  const cells = new Map()
  const orphans = []
  for (const line of lines) {
    if (headerLines.has(line)) continue
    if (anchorLines.some((anchor) => anchor.line === line)) continue
    const center = lineCenter(line)
    if (center.cy <= headerBottom + 2) continue // 标题/学期起点等表头上方内容

    const column = columns.reduce(
      (best, current) => (Math.abs(current.cx - center.cx) < Math.abs(best.cx - center.cx) ? current : best),
      columns[0],
    )
    if (Math.abs(column.cx - center.cx) > columnStep * 0.95) {
      orphans.push(line.text)
      continue
    }

    let bandIndex = -1
    for (let index = 0; index < bands.length; index += 1) {
      const band = bands[index]
      const next = bands[index + 1]
      const yStart = index === 0 ? headerBottom : band.minCy - 55
      const yEnd = next ? next.minCy - 55 : Number.MAX_SAFE_INTEGER
      if (center.cy >= yStart && center.cy < yEnd) {
        bandIndex = index
        break
      }
    }
    if (bandIndex < 0) {
      if (!bands.length) {
        bandIndex = 0
      } else {
        orphans.push(line.text)
        continue
      }
    }

    const key = `${column.weekday}|${bandIndex}`
    if (!cells.has(key)) {
      cells.set(key, {
        weekday: column.weekday,
        bandIndex,
        inferred: Boolean(column.inferred),
        lines: [],
      })
    }
    cells.get(key).lines.push(line)
  }

  const candidates = []
  for (const cell of cells.values()) {
    const weekday = cell.weekday
    const band = bands[cell.bandIndex] || {}
    const cellLines = cell.lines
    const nameLine = cellLines.find((line) => looksLikeCourseName(line.text))
    if (!nameLine) continue
    const joined = cellLines.map((line) => line.text).join(' | ')
    const weeks = extractWeeks(joined)
    const time = extractTime(joined)
    const periods = extractPeriods(joined)
    const parsedWeekday = extractWeekday(joined)
    const candidate = {
      layout: 'grid',
      name: normalize(nameLine.text),
      weekday: parsedWeekday && parsedWeekday !== weekday ? parsedWeekday : weekday,
      startTime: time.startTime || band.time?.startTime || null,
      endTime: time.endTime || band.time?.endTime || null,
      periodStart: periods.periodStart ?? band.periods?.periodStart ?? null,
      periodEnd: periods.periodEnd ?? band.periods?.periodEnd ?? null,
      startWeek: weeks.startWeek ?? null,
      endWeek: weeks.endWeek ?? null,
      weekPattern: weeks.weekPattern || null,
      location: extractLocation(joined),
      teacher: extractTeacher(joined),
      rawText: joined,
    }
    candidate.warnings = describeWarnings(candidate, options)
    if (cell.inferred) {
      candidate.warnings.unshift('这一列的星期是从相邻表头推断的（图上该列表头没识别出来），请确认')
      candidate.weekdayInferred = true
    }
    candidates.push(candidate)
  }

  // 同一格里多门课（例如上下两段）时，按行序输出更接近照片
  candidates.sort((a, b) => a.weekday - b.weekday || String(a.startTime).localeCompare(String(b.startTime)))
  return { layout: 'grid', candidates, orphans }
}

/**
 * 只有行锚点、没有识别出星期表头时的兜底：按"左侧时间/节次"分行，每行给一个候选。
 * 星期留空并提示用户选择——不猜。
 */
export function parseRowsOnly(lines, options = {}) {
  const anchors = []
  for (const line of lines) {
    const time = extractTime(line.text)
    const periods = extractPeriods(line.text)
    if (!Object.keys(time).length && !Object.keys(periods).length) continue
    const center = lineCenter(line)
    anchors.push({ line, cy: center.cy, cx: center.cx, time, periods })
  }
  if (!anchors.length) return null

  // 真实 OCR 常把同一行的多列文字并成一行（例如"08:00-09:40 | 王老师"），
  // 因此这里不再按 x 位置筛"左列"，而是：带具体时间的行作为行锚点（去重后），
  // 只有节次的行就近并入，行区间取相邻锚点的中点。
  const timeAnchors = []
  for (const anchor of anchors.sort((a, b) => a.cy - b.cy)) {
    if (!hasFields(anchor.time)) continue
    const last = timeAnchors[timeAnchors.length - 1]
    if (last && Math.abs(anchor.cy - last.cy) <= 40) {
      last.anchorLines.push(anchor.line)
      continue
    }
    timeAnchors.push({ cy: anchor.cy, time: anchor.time, periods: {}, anchorLines: [anchor.line] })
  }
  const periodAnchors = anchors.filter((anchor) => !hasFields(anchor.time) && hasFields(anchor.periods))

  let bands
  if (timeAnchors.length) {
    bands = timeAnchors
    for (const anchor of periodAnchors) {
      let best = null
      for (const band of bands) {
        const distance = Math.abs(band.cy - anchor.cy)
        if (distance <= 110 && (!best || distance < best.distance)) best = { band, distance }
      }
      if (best) {
        if (!hasFields(best.band.periods)) best.band.periods = anchor.periods
        best.band.anchorLines.push(anchor.line)
      }
    }
  } else {
    bands = buildRowBands(anchors).map((band) => ({
      cy: band.minCy,
      time: band.time,
      periods: band.periods,
      anchorLines: band.lines,
    }))
  }
  if (!bands.length) return null
  bands.sort((a, b) => a.cy - b.cy)

  const anchorLines = new Set(bands.flatMap((band) => band.anchorLines))
  const candidates = []
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]
    const next = bands[index + 1]
    // 第一行往前留 90px 作为"课程名在时间上方"的余量，再往上（标题等）不算
    const yStart = index === 0 ? band.cy - 90 : (bands[index - 1].cy + band.cy) / 2
    const yEnd = next ? (band.cy + next.cy) / 2 : Number.MAX_SAFE_INTEGER
    const cellLines = lines.filter((line) => {
      if (anchorLines.has(line)) return false
      const cy = lineCenter(line).cy
      return cy >= yStart && cy < yEnd
    })
    const nameLine = cellLines.find((line) => looksLikeCourseName(line.text))
    if (!nameLine) continue
    // 字段提取时把锚点行本身的文字也算进来：真实 OCR 常把时间/节次与教室、老师并成一行
    const anchorText = band.anchorLines.map((line) => line.text).join(' | ')
    const joined = [anchorText, ...cellLines.map((line) => line.text)].filter(Boolean).join(' | ')
    const weeks = extractWeeks(joined)
    const time = extractTime(joined)
    const periods = extractPeriods(joined)
    const candidate = {
      layout: 'grid-rows',
      name: compact(nameLine.text),
      weekday: extractWeekday(joined),
      startTime: time.startTime || band.time?.startTime || null,
      endTime: time.endTime || band.time?.endTime || null,
      periodStart: periods.periodStart ?? band.periods?.periodStart ?? null,
      periodEnd: periods.periodEnd ?? band.periods?.periodEnd ?? null,
      startWeek: weeks.startWeek ?? null,
      endWeek: weeks.endWeek ?? null,
      weekPattern: weeks.weekPattern || null,
      location: extractLocation(joined),
      teacher: extractTeacher(joined),
      rawText: joined,
    }
    candidate.warnings = describeWarnings(candidate, options)
    if (!candidate.weekday) {
      candidate.warnings.unshift('没有识别到星期表头，请为这条课选择星期')
    }
    candidates.push(candidate)
  }
  return candidates.length ? { layout: 'grid-rows', candidates, orphans: [] } : null
}

/** 列表布局：一行一门课。 */
export function parseList(lines, options = {}) {
  const candidates = []
  const orphans = []
  for (const line of lines) {
    const text = line.text
    const weekday = extractWeekday(text)
    const time = extractTime(text)
    const weeks = extractWeeks(text)
    const hasSignal = (weekday && Object.keys(time).length) || (weekday && Object.keys(weeks).length)
    if (!hasSignal) {
      if (!/课表|课程表|第一周/.test(text)) orphans.push(text)
      continue
    }
    const name = guessNameFromLine(text)
    if (!name) {
      orphans.push(text)
      continue
    }
    const periods = extractPeriods(text)
    const candidate = {
      layout: 'list',
      name,
      weekday,
      startTime: time.startTime || null,
      endTime: time.endTime || null,
      periodStart: periods.periodStart ?? null,
      periodEnd: periods.periodEnd ?? null,
      startWeek: weeks.startWeek ?? null,
      endWeek: weeks.endWeek ?? null,
      weekPattern: weeks.weekPattern || null,
      location: extractLocation(text),
      teacher: extractTeacher(text),
      rawText: text,
    }
    candidate.warnings = describeWarnings(candidate, options)
    candidates.push(candidate)
  }
  return { layout: 'list', candidates, orphans }
}

/** 一行里，第一个"已知字段"之前的文字就是课程名。 */
export function guessNameFromLine(text) {
  const normalized = compact(text)
  const markers = [
    /(?:周|星期|礼拜)\s*[一二三四五六日天1-7]/,
    FIELD_PATTERNS.timeRange,
    FIELD_PATTERNS.weekRange,
    FIELD_PATTERNS.periodRange,
    FIELD_PATTERNS.location,
    FIELD_PATTERNS.teacher,
  ]
  let cut = normalized.length
  for (const marker of markers) {
    const match = normalized.match(marker)
    if (match && match.index !== undefined && match.index < cut) {
      cut = match.index
    }
  }
  const name = normalize(normalized.slice(0, cut)).replace(/[|,，、:：-]+$/, '').trim()
  return name && /[\u4e00-\u9fa5A-Za-z]/.test(name) ? name : null
}

/** 框选区域识别：整块文字里找字段，星期尽量从文字里取。 */
export function parseRegion(lines, options = {}) {
  const text = lines.map((line) => line.text).join(' | ')
  const name = lines.map((line) => line.text).find((line) => looksLikeCourseName(line)) || guessNameFromLine(text)
  if (!name) {
    return { layout: 'region', candidates: [], orphans: [text] }
  }
  const weeks = extractWeeks(text)
  const time = extractTime(text)
  const periods = extractPeriods(text)
  const candidate = {
    layout: 'region',
    name: normalize(name),
    weekday: extractWeekday(text),
    startTime: time.startTime || null,
    endTime: time.endTime || null,
    periodStart: periods.periodStart ?? null,
    periodEnd: periods.periodEnd ?? null,
    startWeek: weeks.startWeek ?? null,
    endWeek: weeks.endWeek ?? null,
    weekPattern: weeks.weekPattern || null,
    location: extractLocation(text),
    teacher: extractTeacher(text),
    rawText: text,
  }
  candidate.warnings = describeWarnings(candidate, options)
  return { layout: 'region', candidates: [candidate], orphans: [] }
}

/** 文本里是否含有任何"课表信号"（时间/节次/周次/星期），用于决定要不要退化成整块解析。 */
function hasCourseSignal(lines) {
  return lines.some((line) => {
    const text = line.text
    return (
      Object.keys(extractTime(text)).length > 0 ||
      Object.keys(extractPeriods(text)).length > 0 ||
      Object.keys(extractWeeks(text)).length > 0 ||
      extractWeekday(text) !== null
    )
  })
}

/** 缺失字段与低置信度的提示（不臆测、不静默）。 */
export function describeWarnings(candidate, options = {}) {
  const warnings = []
  if (!candidate.weekday) {
    warnings.push('没有识别到星期，请手动选择')
  }
  if (!candidate.startTime || !candidate.endTime) {
    warnings.push('图片里没有具体上课时刻：请补充时间，或按你自己的节次时间设置')
  }
  if (!candidate.startWeek || !candidate.endWeek) {
    if (candidate.weekPattern === 'ODD' || candidate.weekPattern === 'EVEN') {
      warnings.push('识别到单/双周，但缺少起止周，请补充')
    } else if (!options.silentWeekWarning) {
      warnings.push('没有识别到教学周范围，确认后按"每周"处理（可手动补起止周）')
    }
  }
  if (options.lowConfidence) {
    warnings.push('识别置信度较低，请核对课程名与时间')
  }
  return warnings
}

/**
 * 去掉"名字本身就是表头/时间栏标签"的候选。
 *
 * 三道防线里最内的一道（另两道在周视图流水线与手机端导入校验）：
 * 无论哪个布局分支产出了这种候选，都不允许它继续往下走。
 */
function dropStructuralCandidates(candidates, options = {}) {
  const dropped = []
  const kept = []
  for (const candidate of candidates) {
    if (isStructuralCandidate(candidate)) dropped.push(candidate)
    else kept.push(candidate)
  }
  if (dropped.length && options.onDrop) options.onDrop(dropped)
  return { candidates: kept, dropped }
}

/**
 * 整张图是不是"只有表头 / 时间栏"（没有任何一行像课程内容）。
 *
 * 为什么不能只看"被丢掉的候选数"：真实故障里，某个布局分支可能**根本没产出候选**
 * （列表分支要求"星期 + 时刻"同时出现、表格分支会整个跳过表头行……），
 * 于是"候选为空"既可能是"过滤掉了表头"，也可能是"压根没解析出东西"。
 * 这里直接看 OCR 文本本身：
 *   - 每一行要么是纯结构性标签，要么是极短噪声/单字符 → 判定为**只有表头**；
 *   - 只要出现一行像课程名或地点的文字（"数字信号处理"、"教三 305"）→ 不是。
 */
function looksLikeHeaderOnlyText(lines) {
  let hasText = false
  for (const line of lines || []) {
    const text = String(line?.text ?? '').trim()
    if (!text) continue
    hasText = true
    if (isStructuralLabel(text)) continue
    // 单字符/纯数字（PSM 11 把左侧节次单独切出来时的常见形态）不算课程内容。
    if (text.replace(/\s/g, '').length <= 1) continue
    if (looksLikeCourseName(text)) return false
    if (FIELD_PATTERNS.location.test(compact(text))) return false
    // 其余（例如被读坏的零散汉字）按"有内容"处理：宁可判成不是纯表头，也不误报失败。
    return false
  }
  return hasText
}

/**
 * 主入口。
 *
 * @param {Array} lines flattenOcrLines 的结果
 * @param {Object} options { mode: 'auto'|'grid'|'list'|'region', lowConfidence: boolean }
 */
export function parseTimetable(lines, options = {}) {
  const mode = options.mode || 'auto'
  const semester = extractSemesterStart(lines)
  const warnings = [...semester.warnings]
  const rawText = lines.map((line) => line.text).join('\n')

  let result
  if (mode === 'grid') {
    result = parseGrid(lines, options)
  } else if (mode === 'list') {
    result = parseList(lines, options)
  } else if (mode === 'region') {
    result = parseRegion(lines, options)
  } else {
    const list = parseList(lines, options)
    const grid = parseGrid(lines, options)
    const rowsOnly = grid ? null : parseRowsOnly(lines, options)
    const listCount = dropStructuralCandidates(list?.candidates || []).candidates.length
    const gridCount = dropStructuralCandidates(grid?.candidates || []).candidates.length
    const rowsCount = dropStructuralCandidates(rowsOnly?.candidates || []).candidates.length
    if (gridCount > 0 && gridCount >= listCount) result = grid
    else if (listCount > gridCount) result = list
    else if (rowsCount > 0) result = rowsOnly
    else result = grid || (hasCourseSignal(lines) ? parseRegion(lines, options) : list)
  }

  if (!result) {
    result = parseRegion(lines, options)
  }

  const withoutStructural = dropStructuralCandidates(result.candidates || [])
  const candidates = withoutStructural.candidates.map((candidate, index) => ({
    ...candidate,
    id: `c${index + 1}`,
    selected: true,
    courseMode: 'new',
    existingCourseId: null,
    code: null,
    semester: null,
  }))

  const deduped = dedupeCandidates(candidates)

  // 整批结果只有表头/时间栏：候选清空，并把这件事**显式标出来**。
  //
  // 为什么这里不直接抛错：`parseTimetable` 是纯解析器，各布局分支（auto/grid/list/region）
  // 都应该"返回结构化的空结果"，由调用方决定怎么表达失败。
  // 识别流水线（`companion/src/ocrEngine.mjs`）看到 `structuralOnly` 就抛
  // `OcrLayoutError`，于是界面拿到的是明确失败，而不是"识别成功但 0 条候选"。
  //
  // 判定同时看两条证据：
  //   1. 过滤掉的候选数（表头曾经被当成候选的情况）；
  //   2. OCR 文本本身（某个分支压根没产出候选的情况，这才是真机上的形态）。
  const droppedCount = withoutStructural.dropped.length
  const headerOnlyText = looksLikeHeaderOnlyText(lines)
  const structuralOnly = deduped.length === 0 && (droppedCount > 0 || headerOnlyText)

  if (structuralOnly) {
    warnings.push(
      `这张图里只读到表头/时间栏文字${droppedCount > 0 ? `（已忽略 ${droppedCount} 处）` : ''}，没有读到任何课程。`,
    )
  } else if (droppedCount > 0) {
    warnings.push(
      `有 ${droppedCount} 处只读到表头/时间栏文字（已忽略，不会当成课程）：请核对下面的课程是否完整。`,
    )
  }

  return {
    layout: result.layout || 'unknown',
    semesterStartDate: semester.semesterStartDate,
    candidates: deduped,
    warnings,
    rawText,
    orphans: result.orphans || [],
    structuralOnly,
    structuralDropped: droppedCount,
    headerOnlyText,
  }
}

function dedupeCandidates(candidates) {
  const seen = new Set()
  const result = []
  for (const candidate of candidates) {
    const key = [
      candidate.name,
      candidate.weekday,
      candidate.startTime,
      candidate.endTime,
      candidate.startWeek,
      candidate.endWeek,
      candidate.weekPattern,
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

export { WEEKDAY_LABELS }
