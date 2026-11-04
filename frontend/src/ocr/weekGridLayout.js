/**
 * 周视图课表照片的版式分析（深色/浅色手机截图通用）。
 *
 * 思路（不依赖任何具体图片的像素常数、文件名或课程字典）：
 *   1. 从像素统计里自动找出"卡片底色"和"背景色"（出现次数最多的颜色是背景）；
 *   2. 掩膜 = 更接近卡片底色而不是背景色的像素 —— 于是卡片连同卡片上的文字成为一个连通块；
 *   3. 连通域 → 卡片矩形；按 x 重叠聚成"星期列"；
 *   4. 左侧时间栏与表头由调用方 OCR 后传进来，按几何位置映射：星期 ↔ 列，节次/时刻 ↔ 行；
 *   5. 每块卡片单独 OCR 后再做文本切分（名称 / @ 地点），跨行名称要拼起来。
 *
 * 本模块全部是纯函数：输入像素缓冲或几何/文本结构，便于离线测试与浏览器复用。
 */

const NEAR_WHITE = 225
const NEAR_BLACK = 40

function colorDistance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
}

/**
 * 自动识别卡片底色与背景色。
 * 背景 = 采样里出现次数最多的颜色；卡片底色 = 与背景差异足够大、成片出现最多的颜色。
 * 深色主题（深底 + 彩色卡片）与浅色主题（浅底 + 深色卡片）都能选出来。
 */
export function detectCardColor(data, width, height, options = {}) {
  const step = Math.max(1, options.step || 3)
  const buckets = new Map()
  let sampled = 0
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
      let bucket = buckets.get(key)
      if (!bucket) {
        bucket = { count: 0, r: 0, g: 0, b: 0 }
        buckets.set(key, bucket)
      }
      bucket.count += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
      sampled += 1
    }
  }
  const list = [...buckets.values()]
    .map((bucket) => ({
      count: bucket.count,
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
    }))
    .sort((a, b) => b.count - a.count)

  const background = list[0] || { r: 0, g: 0, b: 0, count: 0 }
  let card = null
  for (const color of list) {
    if (color.count < sampled * 0.02) continue
    if (colorDistance(color, background) < 60) continue
    const neutral = color.r < NEAR_BLACK && color.g < NEAR_BLACK && color.b < NEAR_BLACK
    const white = color.r > NEAR_WHITE && color.g > NEAR_WHITE && color.b > NEAR_WHITE
    // 彩色卡片优先；纯黑/纯白需要更大的面积才会被当成卡片底色
    const score = color.count * (neutral || white ? 0.35 : 1)
    if (!card || score > card.score) {
      card = { ...color, score }
    }
  }
  return { background, card, palette: list.slice(0, 8), sampled }
}

/** 掩膜：更接近卡片底色（而不是背景色）的像素记为 1。 */
export function buildCardMask(data, width, height, cardColor, backgroundColor) {
  const mask = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
    const pixel = { r: data[p], g: data[p + 1], b: data[p + 2] }
    if (colorDistance(pixel, cardColor) < colorDistance(pixel, backgroundColor)) {
      mask[i] = 1
    }
  }
  return mask
}

/** 连通域（4 邻域，迭代式避免爆栈），返回矩形与面积。 */
export function findComponents(mask, width, height, options = {}) {
  const minArea = options.minArea ?? Math.round(width * height * 0.001)
  const minWidth = options.minWidth ?? Math.round(width * 0.02)
  const minHeight = options.minHeight ?? Math.round(height * 0.03)
  const maxRatio = options.maxRatio ?? 12
  const visited = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  const components = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue
    let top = 0
    stack[top++] = start
    visited[start] = 1
    let area = 0
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    while (top > 0) {
      const index = stack[--top]
      const x = index % width
      const y = (index / width) | 0
      area += 1
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0) {
        const n = index - 1
        if (mask[n] && !visited[n]) {
          visited[n] = 1
          stack[top++] = n
        }
      }
      if (x < width - 1) {
        const n = index + 1
        if (mask[n] && !visited[n]) {
          visited[n] = 1
          stack[top++] = n
        }
      }
      if (y > 0) {
        const n = index - width
        if (mask[n] && !visited[n]) {
          visited[n] = 1
          stack[top++] = n
        }
      }
      if (y < height - 1) {
        const n = index + width
        if (mask[n] && !visited[n]) {
          visited[n] = 1
          stack[top++] = n
        }
      }
    }
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const ratio = h / Math.max(1, w)
    if (area < minArea || w < minWidth || h < minHeight) continue
    if (ratio > maxRatio || ratio < 1 / maxRatio) continue
    // 填充率太低说明不是实心卡片（可能是散落的文字/图标）
    if (area / (w * h) < 0.55) continue
    components.push({ x0, y0, x1, y1, width: w, height: h, area, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 })
  }
  return components.sort((a, b) => a.cy - b.cy || a.cx - b.cx)
}

/** 按 x 重叠把卡片聚成"星期列"。 */
export function groupColumns(components, options = {}) {
  const minOverlap = options.minOverlap ?? 0.5
  const groups = []
  for (const component of [...components].sort((a, b) => a.cx - b.cx)) {
    let target = null
    let bestOverlap = 0
    for (const group of groups) {
      const overlap = Math.min(group.x1, component.x1) - Math.max(group.x0, component.x0)
      const minWidth = Math.min(group.x1 - group.x0, component.width)
      const ratio = overlap / Math.max(1, minWidth)
      if (ratio > minOverlap && ratio > bestOverlap) {
        target = group
        bestOverlap = ratio
      }
    }
    if (target) {
      target.items.push(component)
      target.x0 = Math.min(target.x0, component.x0)
      target.x1 = Math.max(target.x1, component.x1)
      target.cy = (target.cy * (target.items.length - 1) + component.cy) / target.items.length
    } else {
      groups.push({ x0: component.x0, x1: component.x1, cy: component.cy, items: [component] })
    }
  }
  return groups
    .map((group) => ({
      x0: group.x0,
      x1: group.x1,
      cx: (group.x0 + group.x1) / 2,
      items: group.items.sort((a, b) => a.cy - b.cy),
    }))
    .sort((a, b) => a.cx - b.cx)
}

const WEEKDAY_NAMES = [
  { weekday: 1, patterns: ['周一', '星期一', '礼拜一', '週一'] },
  { weekday: 2, patterns: ['周二', '星期二', '礼拜二', '週二', '周ニ'] },
  { weekday: 3, patterns: ['周三', '星期三', '礼拜三', '週三'] },
  { weekday: 4, patterns: ['周四', '星期四', '礼拜四', '週四'] },
  { weekday: 5, patterns: ['周五', '星期五', '礼拜五', '週五'] },
  { weekday: 6, patterns: ['周六', '星期六', '礼拜六', '週六'] },
  { weekday: 7, patterns: ['周日', '周天', '星期日', '星期天', '礼拜日', '礼拜天', '週日'] },
]

/** 从一行文本里读出星期（1-7），读不出返回 null。 */
export function weekdayFromText(text) {
  const value = String(text || '').replace(/\s+/g, '')
  for (const entry of WEEKDAY_NAMES) {
    if (entry.patterns.some((pattern) => value.includes(pattern))) return entry.weekday
  }
  return null
}

/** 日期 "10/12" → {month, day}，读不出返回 null。 */
export function dateFromText(text) {
  const match = String(text || '').match(/(\d{1,2})\s*[/月-]\s*(\d{1,2})/)
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { month, day }
}

/** 非闰年的"日序"，用来计算同一屏里两个日期相差几天（不需要年份）。 */
function dayOfYear(month, day) {
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let total = day
  for (let index = 0; index < month - 1; index += 1) total += lengths[index]
  return total
}

/**
 * 把表头 OCR 出的 token 归到各列，并解析出每列的星期。
 *
 * 单纯按标签映射会出现"周二被识别成周一"这类重复；这里用两个相互独立的证据交叉校验：
 *   1. 星期标签本身（可能有个别错字）；
 *   2. 日期序列（10/12、10/13… 连续且识别较稳）→ 给出各列之间的"天数偏移"。
 * 做法：枚举第 0 列的星期 w0（1-7），用日期偏移推出各列应为什么星期，与识别到的标签比对打分，
 * 取分最高者；被校正的列会带上警告。没有任何日期时才退回纯标签映射（并提示确认）。
 */
export function resolveWeekdayColumns(headerTokens, columns) {
  const warnings = []
  const result = columns.map((column) => ({ ...column, weekday: null, date: null, labelWeekday: null, corrected: false }))

  const tokens = (headerTokens || []).filter((token) => String(token?.text || '').trim())
  // 归属：每个 token 找到 x 最近的列（超过半个列距就不认领）
  const pitches = result.slice(1).map((column, index) => column.cx - result[index].cx)
  const pitch = pitches.length ? [...pitches].sort((a, b) => a - b)[Math.floor(pitches.length / 2)] : 100
  const assigned = result.map(() => [])
  for (const token of tokens) {
    let best = null
    result.forEach((column, index) => {
      const distance = Math.abs(column.cx - token.cx)
      if (!best || distance < best.distance) best = { index, distance }
    })
    if (best && best.distance <= pitch * 0.7) assigned[best.index].push(token)
  }

  assigned.forEach((list, index) => {
    for (const token of list) {
      const weekday = typeof token.weekday === 'number' ? token.weekday : weekdayFromText(token.text)
      const date = dateFromText(token.text)
      if (weekday && !result[index].labelWeekday) result[index].labelWeekday = weekday
      if (date && !result[index].date) result[index].date = `${date.month}/${date.day}`
    }
  })

  const offsets = result.map((column) => {
    if (!column.date) return null
    const [month, day] = column.date.split('/').map(Number)
    return dayOfYear(month, day)
  })
  const dated = offsets.filter((value) => value !== null).length
  const base = offsets.find((value) => value !== null)
  const canUseDates = dated >= 3 && base !== undefined

  const labelScore = (candidateFirstWeekday) => {
    let score = 0
    result.forEach((column, index) => {
      if (offsets[index] === null || !column.labelWeekday) return
      const offset = offsets[index] - base
      const expected = ((candidateFirstWeekday - 1 + offset) % 7 + 7) % 7 + 1
      if (expected === column.labelWeekday) score += 1
    })
    return score
  }

  if (canUseDates) {
    let bestFirst = null
    for (let first = 1; first <= 7; first += 1) {
      const score = labelScore(first)
      const anchored = result[0].labelWeekday === first ? 0.5 : 0
      if (!bestFirst || score + anchored > bestFirst.score) bestFirst = { first, score, total: score + anchored }
    }
    result.forEach((column, index) => {
      if (offsets[index] === null) {
        column.weekday = column.labelWeekday
        if (!column.weekday) warnings.push(`有一列既没有日期也没有星期标签，请手动选择星期`)
        else warnings.push(`这一列只有星期标签（${column.weekday}），没有日期可交叉校验，请确认`)
        return
      }
      const offset = offsets[index] - base
      column.weekday = ((bestFirst.first - 1 + offset) % 7 + 7) % 7 + 1
      if (column.labelWeekday && column.labelWeekday !== column.weekday) {
        column.corrected = true
        warnings.push(
          `表头第 ${index + 1} 列的星期标签读成「周${'一二三四五六日'[column.labelWeekday - 1]}」，` +
            `按日期顺序（${column.date}）应为「周${'一二三四五六日'[column.weekday - 1]}」，已按日期取后者，请确认`,
        )
      }
    })
    if (bestFirst.score === 0 && result.some((column) => column.labelWeekday)) {
      warnings.push('日期顺序与识别到的星期标签对不上，已按日期推算，请仔细确认每一列的星期')
    }
  } else {
    result.forEach((column) => {
      column.weekday = column.labelWeekday
      if (!column.weekday) warnings.push(`有一列没有识别到星期标签，请手动选择星期`)
    })
    if (!dated) warnings.push('没有识别到日期，星期只能按标签判断，请确认')
  }
  return { columns: result, warnings }
}

/**
 * 解析左侧时间栏的行：把"节号 + 起止时刻"组合成节次条目。
 * 兼容两种版式：
 *   a) 每节一行（"1"、"08:00"、"08:45" 三行）
 *   b) 一行里带节号与时刻（"1 08:00 08:45"）
 */
export function parseGutterLines(lines) {
  const entries = []
  const sorted = [...(lines || [])].sort((a, b) => a.cy - b.cy)
  let current = null
  for (const line of sorted) {
    const text = String(line.text || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const times = [...text.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/g)].map(
      (match) => `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`,
    )
    const periodMatch = text.match(/^(\d{1,2})$/) || text.match(/(?:^|\s)(\d{1,2})(?:\s|$)/)
    const bareNumber = periodMatch && !times.length ? Number(periodMatch[1]) : null
    // 只有"节号后面不是冒号/数字"时才算"一行里带节号"；否则会把 "08:00" 的 08 当成节号
    const leadingMatch = text.match(/^(\d{1,2})(?![\d:：])/)
    const leadingPeriod = times.length && leadingMatch ? Number(leadingMatch[1]) : NaN

    if (Number.isFinite(leadingPeriod) && leadingPeriod >= 1 && leadingPeriod <= 12) {
      // 版式 b：一行里同时有节号与时刻
      entries.push({
        period: leadingPeriod,
        startTime: times[0] || null,
        endTime: times[1] || times[0] || null,
        y0: line.y0,
        y1: line.y1,
        cy: line.cy,
      })
      current = null
      continue
    }
    if (bareNumber !== null && bareNumber >= 1 && bareNumber <= 12 && !times.length) {
      if (current && !current.startTime) continue // 同一节重复出现，忽略
      current = { period: bareNumber, startTime: null, endTime: null, y0: line.y0, y1: line.y1, cy: line.cy }
      entries.push(current)
      continue
    }
    if (times.length && current) {
      // 版式 a：紧随节号的时间行
      if (!current.startTime) current.startTime = times[0]
      else if (!current.endTime) current.endTime = times[1] || times[0]
      current.y1 = Math.max(current.y1, line.y1)
      current.cy = (current.y0 + current.y1) / 2
      continue
    }
    if (times.length && !current) {
      // 完全没有节号的兜底：每两行时间算一节
      const last = entries[entries.length - 1]
      if (last && last.startTime && !last.endTime) {
        last.endTime = times[0]
        last.y1 = Math.max(last.y1, line.y1)
      } else {
        entries.push({
          period: entries.length + 1,
          startTime: times[0],
          endTime: times[1] || null,
          y0: line.y0,
          y1: line.y1,
          cy: line.cy,
        })
      }
    }
  }
  return entries
    .filter((entry) => entry.period >= 1)
    .sort((a, b) => a.period - b.period || a.y0 - b.y0)
}

/**
 * 卡片覆盖了哪些节次。
 * 先把节次条目变成"槽位"（相邻节次中心的中点为边界），再用卡片 y 范围与槽位的重叠比例判断：
 * 比"中心点落在卡片内"更稳——卡片正好对齐槽位时，不会把上下相邻的节次吸进来。
 */
export function matchCardPeriods(component, periods) {
  if (!periods || !periods.length) {
    return { periodStart: null, periodEnd: null, startTime: null, endTime: null }
  }
  const sorted = [...periods].sort((a, b) => a.cy - b.cy)
  const gaps = sorted
    .slice(1)
    .map((period, index) => period.cy - sorted[index].cy)
    .filter((gap) => gap > 0)
  const medianGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 80

  const slots = sorted.map((period, index) => {
    const top = index === 0 ? period.cy - medianGap / 2 : (sorted[index - 1].cy + period.cy) / 2
    const bottom =
      index === sorted.length - 1 ? period.cy + medianGap / 2 : (period.cy + sorted[index + 1].cy) / 2
    return { period, top, bottom, height: Math.max(1, bottom - top) }
  })

  const covered = slots.filter((slot) => {
    const overlap = Math.min(slot.bottom, component.y1) - Math.max(slot.top, component.y0)
    return overlap > slot.height * 0.5
  })
  if (!covered.length) {
    return { periodStart: null, periodEnd: null, startTime: null, endTime: null }
  }
  const first = covered[0].period
  const last = covered[covered.length - 1].period
  return {
    periodStart: first.period,
    periodEnd: last.period,
    startTime: first.startTime || null,
    endTime: last.endTime || first.endTime || null,
    periods: covered.map((slot) => slot.period.period),
    matchedCount: covered.length,
  }
}

/**
 * 把"裁剪条 OCR 出来的坐标"换算回整图坐标。
 * OCR 输入是"放大 + 补白边"后的图像，所以要先减掉白边、再除以放大倍数、最后加回裁剪原点。
 */
export function mapStripBox(box, { x0 = 0, y0 = 0, scale = 1, pad = 0 }) {
  const map = (value, origin) => (value - pad) / scale + origin
  const sourceX0 = box.x0 ?? box.cx
  const sourceX1 = box.x1 ?? box.cx
  const sourceY0 = box.y0 ?? box.cy
  const sourceY1 = box.y1 ?? box.cy
  return {
    ...box,
    x0: map(sourceX0, x0),
    x1: map(sourceX1, x0),
    y0: map(sourceY0, y0),
    y1: map(sourceY1, y0),
    cx: map(box.cx, x0),
    cy: map(box.cy, y0),
  }
}

/** 周视图标题："第 7 周" → 7；只有"周"没有数字时返回 null。 */
export function detectDisplayedWeek(texts) {
  for (const text of texts || []) {
    const value = String(text || '').replace(/\s+/g, '')
    const match = value.match(/第(\d{1,2})周/)
    if (match) {
      const week = Number(match[1])
      if (week >= 1 && week <= 60) return week
    }
  }
  return null
}

/**
 * 清理 OCR 文本里的"结构性噪声"（不是猜词）：
 *   - 去掉孤立的竖线等分隔噪声（"电路与电|子技术" → "电路与电子技术"）；
 *   - 括号不配平时（少了一边），把同类括号整体去掉，避免半截括号；
 *   - 去掉右括号后面孤零零的一个拉丁字母（"(B-2)G" → "(B-2)"）。
 * 清理后仍可疑的地方由 parseCardText 打 suspect 标记，交给用户核对，不擅自改文字内容。
 */
export function cleanOcrText(text) {
  let value = String(text || '').replace(/[|¦丨]/g, '')
  const opens = (value.match(/[(（[]/g) || []).length
  const closes = (value.match(/[)）\]]/g) || []).length
  if (opens !== closes) {
    // 括号不配平说明这一块没读准：两边都去掉，避免留下半截括号（字段值仍会带 suspect 提示）
    value = value.replace(/[(（[\]）)]/g, '')
  }
  return value.replace(/([)）])([A-Za-z])$/g, '$1')
}

/** 清理后仍然可疑的迹象（只用于提示，不改字段值）。 */
export function looksSuspect(text) {
  const value = String(text || '')
  const opens = (value.match(/[(（]/g) || []).length
  const closes = (value.match(/[)）]/g) || []).length
  if (opens !== closes) return true
  const outside = value.replace(/[(（][^)）]*[)）]/g, '')
  // 中文之间夹着 2 个以上连续拉丁字母（"世界电影ZR"）通常是被读坏了；
  // 括号里的 C++ / B-2 / (3) 不算，所以先去掉括号内容再判断。
  return /[\u4e00-\u9fa5][A-Za-z]{2,}/.test(outside)
}

/**
 * 地点样式的兜底切分（仅在 @ 丢失时使用，结果一定标记为待确认）。
 * 只在"楼/馆/中心/机房/实验室/校区"后面紧跟房间号时才切分，并且只往前取 2 个汉字当楼名
 * （中文楼名一般 2-3 字，取 2 字可避免把课程名末尾的"实验"等吞进地点）；
 * 切不出来就返回 null，让调用方保留整段文字并提示人工补地点。
 */
export function splitNameAndLocation(text) {
  const value = String(text || '')
  const pattern = /(楼|馆|中心|机房|实验室|校区)/g
  let match = pattern.exec(value)
  while (match) {
    const suffixEnd = match.index + match[1].length
    if (/^[\-–—]?\d/.test(value.slice(suffixEnd))) {
      const start = match.index - 2
      if (start >= 2) {
        const name = value.slice(0, start)
        const location = value.slice(start)
        if (/[\u4e00-\u9fa5A-Za-z]/.test(name) && location) return { name, location }
      }
    }
    match = pattern.exec(value)
  }
  return null
}

/**
 * 把一块卡片 OCR 出来的多行文本切成"课程名 + @ 地点"。
 * 名称会跨行拼接（中文换行不加空格），@ 之后是地点；@ 丢了就按地点特征兜底切分。
 */
export function parseCardText(rawText) {
  const joined = String(rawText || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('')
  if (!joined) return { name: '', location: null, raw: '' }

  // 名称与地点分别清理，地点漏掉一个括号不能影响课程名称里正确的括号。
  const text = joined.replace(/[@＠©®]/g, '@').split('@').map(cleanOcrText).join('@')
  const suspect = looksSuspect(joined) || text !== joined || looksSuspect(text)
  const normalized = text
    .replace(/[@＠©®]/g, '@')
    .replace(/[，,](?=多媒体)/g, '')
  const atIndex = normalized.indexOf('@')
  let name = atIndex >= 0 ? normalized.slice(0, atIndex) : normalized
  let location = atIndex >= 0 ? normalized.slice(atIndex + 1) : null

  name = name
    .replace(/^[\s·、,，.。\-–—|]+/, '')
    .replace(/[\s·、,，.。|]+$/, '')
    .replace(/\s+/g, '')
  if (location !== null) {
    location = location.replace(/\s+/g, '').replace(/^[\s·、,，.。\-–—|]+/, '')
    if (!location) location = null
  }
  if (location === null) {
    const split = splitNameAndLocation(name)
    if (split) {
      return { name: split.name, location: split.location, raw: normalized, locationStitched: true, suspect }
    }
  }
  return { name, location, raw: normalized, suspect }
}

/**
 * 组装候选：列（星期）× 卡片 → 候选行。
 * 没有识别出星期的列会产生"星期待确认"的候选，而不是按顺序硬猜。
 */
export function buildWeekGridCandidates({ columns, cardTexts, periods, periodFallback = null, options = {} }) {
  const candidates = []
  const columnWarnings = []
  columns.forEach((column, index) => {
    if (!column.weekday) {
      columnWarnings.push(
        `从左数第 ${index + 1} 个有课列没有识别到星期表头，请手动选择星期`,
      )
    }
  })

  for (const column of columns) {
    const cards = column.items || []
    for (const card of cards) {
      const text = cardTexts.get(card) ?? card.text ?? ''
      const { name, location, locationStitched, suspect } = parseCardText(text)
      if (!name) continue
      const span = matchCardPeriods(card, periods)
      const warnings = []
      if (!column.weekday) warnings.push('没有识别到这列的星期表头，请确认星期')
      if (span.periodStart === null) {
        warnings.push('没有把这块课对齐到左侧节次，请补充节次与时间')
      } else if (span.periodStart === span.periodEnd) {
        warnings.push('这节课只落在 1 个节次上，请确认节次范围')
      }
      if (!span.startTime || !span.endTime) {
        warnings.push('左侧时间没识别出来，请补充开始/结束时间')
      }
      if (!location) warnings.push('没有识别到地点，请补充上课地点')
      if (locationStitched) {
        warnings.push('地点是按文字特征从整段文字里拆出来的（图上 @ 没识别到），请确认拆分是否正确')
      }
      if (suspect) {
        warnings.push('这一块可能有字没读准（原文保留在下方 OCR 原文里），请核对名称与地点')
      }
      if (options.weekViewWeek) {
        warnings.push(
          `图片是第 ${options.weekViewWeek} 周的周视图：已按"第 ${options.weekViewWeek} 周"填入，导入前请确认教学周范围`,
        )
      }
      candidates.push({
        layout: 'week-grid',
        name,
        weekday: column.weekday ?? null,
        startTime: span.startTime || periodFallback?.startTime || null,
        endTime: span.endTime || periodFallback?.endTime || null,
        periodStart: span.periodStart,
        periodEnd: span.periodEnd,
        startWeek: options.weekViewWeek ?? null,
        endWeek: options.weekViewWeek ?? null,
        weekPattern: options.weekViewWeek ? 'ALL' : null,
        location,
        locationStitched: Boolean(locationStitched),
        suspect: Boolean(suspect),
        teacher: null,
        weekdayDate: column.date || null,
        rawText: text,
        warnings,
        cardRef: card,
      })
    }
  }
  return { candidates, columnWarnings }
}
