/**
 * 周视图课表照片的完整识别流水线（浏览器与离线校验共用同一套规则）。
 *
 * 分工：
 *   - 几何与文本规则在 weekGridLayout.js（纯函数）；
 *   - 预处理在 imageOps.js（纯函数）；
 *   - OCR 由调用方传入的 recognize 完成（浏览器用 tesseractClient 的 worker + generation 取消）；
 *   本文件只做"编排"，不含任何针对某张图的常数、文件名或课程字典。
 *
 * 产出：
 *   { matched, week, candidates, warnings, diagnostics }
 *   matched=false 表示这张图不像"卡片式周视图"，调用方应回退到旧的整图识别路径。
 */
import { prepareCardImage, toGray } from './imageOps.js'
import {
  HEADER_ONLY_MESSAGE,
  OcrLayoutError,
  isHeaderCardText,
  isStructuralCandidate,
} from './structuralLabels.js'
import {
  buildCardMask,
  buildWeekGridCandidates,
  detectCardColor,
  detectDisplayedWeek,
  findComponents,
  groupColumns,
  mapStripBox,
  parseCardText,
  parseGutterLines,
  resolveWeekdayColumns,
} from './weekGridLayout.js'

/** 卡片底色至少要覆盖这么大比例，才认为这是"卡片式周视图"（白底表格/列表不会命中）。 */
const MIN_CARD_COVERAGE = 0.05
const CARD_SCALE = 1
const CARD_RETRIES = [{ maxScale: 2, mode: 'contrast' }, { maxScale: 2, mode: 'otsu' }]

/**
 * 把灰度缓冲放进 canvas（浏览器端直接喂给 Tesseract，比转 dataURL 快）。
 * 导出给「有线框表格」流水线（tableGridOcr.js）复用，保证两条路径喂给 Tesseract 的图完全一致。
 */
export function grayToCanvas(gray, width, height, { pad = 12, createCanvas } = {}) {
  const make = createCanvas || (() => document.createElement('canvas'))
  const canvas = make()
  canvas.width = width + pad * 2
  canvas.height = height + pad * 2
  const context = canvas.getContext('2d')
  const image = context.createImageData(canvas.width, canvas.height)
  image.data.fill(255)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = gray[y * width + x]
      const index = ((y + pad) * canvas.width + (x + pad)) * 4
      image.data[index] = value
      image.data[index + 1] = value
      image.data[index + 2] = value
      image.data[index + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return canvas
}

/**
 * 读数质量分：只用来在"有限重试"之间挑一个更可信的结果，不作为正确性判定。
 * 依据：中文课程名通常含中文；括号要配平；有 @ 说明名称与地点分开了。
 * 刻意**不惩罚括号里的拉丁字母**——"C++""B-2""(3)"本来就该有字母；
 * 但中文名里夹着括号外的拉丁串（"面向对象程序设计人C++ti"）通常是误读，要扣分。
 */
export function scoreCardRead(text) {
  const raw = String(text || '').replace(/\s/g, '')
  if (!raw) return -100
  const namePart = raw.split(/[@＠]/)[0]
  const cjk = (namePart.match(/[\u4e00-\u9fa5]/g) || []).length
  const opens = (raw.match(/[(（]/g) || []).length
  const closes = (raw.match(/[)）]/g) || []).length
  const hasAt = /[@＠]/.test(raw)
  const balanced = opens === closes ? 1 : -2
  const outsideBrackets = namePart.replace(/[(（][^)）]*[)）]/g, '')
  const strayLatin = cjk > 0 ? (outsideBrackets.match(/[A-Za-z]/g) || []).length : 0
  return cjk * 2 + balanced + (hasAt ? 2 : 0) + (namePart.length ? 1 : 0) - strayLatin * 3
}

function isSuspicious(text) {
  const raw = String(text || '').replace(/\s/g, '')
  if (!raw) return true
  const namePart = raw.split(/[@＠]/)[0]
  const cjk = (namePart.match(/[\u4e00-\u9fa5]/g) || []).length
  const opens = (raw.match(/[(（]/g) || []).length
  const closes = (raw.match(/[)）]/g) || []).length
  if (cjk < 2) return true
  if (opens !== closes) return true
  // 中文名里夹着孤立的拉丁串（"世界电影ZR"）通常是被读坏了
  if (/[\u4e00-\u9fa5][A-Za-z]{1,3}$/.test(namePart) || /[A-Za-z]{2,}/.test(namePart.replace(/\([^)]*\)/g, ''))) {
    return true
  }
  return false
}

function collectLines(data, kind = 'line') {
  const result = []
  for (const block of data?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        if (kind === 'word') {
          for (const word of line.words || []) {
            const text = String(word.text || '').trim()
            if (!text) continue
            result.push({
              text,
              x0: word.bbox.x0,
              x1: word.bbox.x1,
              y0: word.bbox.y0,
              y1: word.bbox.y1,
              cx: (word.bbox.x0 + word.bbox.x1) / 2,
              cy: (word.bbox.y0 + word.bbox.y1) / 2,
            })
          }
        } else {
          const text = String(line.text || '').trim()
          if (!text) continue
          result.push({
            text,
            x0: line.bbox.x0,
            x1: line.bbox.x1,
            y0: line.bbox.y0,
            y1: line.bbox.y1,
            cx: (line.bbox.x0 + line.bbox.x1) / 2,
            cy: (line.bbox.y0 + line.bbox.y1) / 2,
          })
        }
      }
    }
  }
  return result
}

/**
 * 只要几何（不跑 OCR），用于"这张图是不是卡片式周视图"的快速判断。
 * 对白底表格/列表图片会返回 matched=false，从而回退旧路径。
 */
export function analyzeWeekGridGeometry(imageData) {
  const { data, width, height } = imageData
  const colors = detectCardColor(data, width, height)
  if (!colors.card) return { matched: false, reason: '没有找到成片的卡片底色' }
  const mask = buildCardMask(data, width, height, colors.card, colors.background)
  const components = findComponents(mask, width, height)
  const coverage = components.reduce((sum, component) => sum + component.area, 0) / (width * height)
  const columns = groupColumns(components)
  const matched = columns.length >= 3 && components.length >= 3 && coverage >= MIN_CARD_COVERAGE
  return { matched, colors, mask, components, columns, coverage, reason: matched ? '' : '卡片面积占比不足或无列结构' }
}

/**
 * 完整流水线。recognize(canvas, { psm }) 由调用方提供；isCancelled() 用于取消；
 * onStage(text, ratio) 用于进度显示。每块最多识别三次，取消时不再发出后续请求。
 */
export async function recognizeWeekGrid(imageData, options) {
  const { recognize, isCancelled = () => false, onStage = () => {}, createCanvas } = options || {}
  const { data, width, height } = imageData

  onStage('正在定位课块…', 0.02)
  const geometry = analyzeWeekGridGeometry(imageData)
  if (!geometry.matched) return { matched: false, reason: geometry.reason }

  const { colors, components, columns: detectedColumns, coverage } = geometry
  const headerBottom = Math.min(...components.map((component) => component.y0))
  const gutterRight = Math.min(...components.map((component) => component.x0))
  const warnings = []

  const cropGray = (region, cropOptions) => prepareCardImage(data, width, height, region, { scaleMode: 'nearest', ...cropOptions })

  // ---- 表头（需要 word 级坐标，一行里可能有 7 个星期标签）
  onStage('正在识别表头…', 0.05)
  const headerRegion = {
    x: 0,
    y: Math.max(0, headerBottom - Math.round(height * 0.12)),
    width,
    height: Math.round(height * 0.12),
  }
  const headerPad = 16
  const headerPrepared = cropGray(headerRegion, { pad: headerPad })
  if (isCancelled()) return { matched: true, cancelled: true }
  const headerData = await recognize(grayToCanvas(headerPrepared.gray, headerPrepared.width, headerPrepared.height, { pad: 0, createCanvas }), {
    psm: '6',
  })
  const headerWords = collectLines(headerData, 'word').map((word) =>
    mapStripBox(word, { x0: headerRegion.x, y0: headerRegion.y, scale: headerPrepared.scale, pad: headerPad }),
  )
  const headerText = String(headerData?.text || '')
  const week = detectDisplayedWeek([headerText, ...headerWords.map((word) => word.text)])
  const weekdayResult = resolveWeekdayColumns(
    headerWords.filter((word) => word.cy > headerRegion.y + headerRegion.height * 0.45),
    detectedColumns,
  )
  warnings.push(...weekdayResult.warnings)
  if (!week) {
    warnings.push('没有识别到"第 N 周"标题：无法确定这几课属于哪一周，请手动填写起止教学周')
  }

  // ---- 左侧时间栏
  onStage('正在识别节次时间…', 0.1)
  const gutterRegion = {
    x: 0,
    y: Math.max(0, headerBottom - 10),
    width: Math.max(24, gutterRight),
    height: height - Math.max(0, headerBottom - 10),
  }
  const gutterPad = 18
  const gutterPrepared = cropGray(gutterRegion, { pad: gutterPad, maxScale: 3, targetHeight: 4200 })
  if (isCancelled()) return { matched: true, cancelled: true }
  const gutterData = await recognize(grayToCanvas(gutterPrepared.gray, gutterPrepared.width, gutterPrepared.height, { pad: 0, createCanvas }), {
    psm: '6',
  })
  const gutterLines = collectLines(gutterData, 'line').map((line) =>
    mapStripBox(line, { x0: gutterRegion.x, y0: gutterRegion.y, scale: gutterPrepared.scale, pad: gutterPad }),
  )
  const periods = parseGutterLines(gutterLines)
  if (!periods.length) {
    warnings.push('没有识别到左侧的节次与时间，导入前请手动补充开始/结束时间')
  }

  // ---- 逐块识别（顺序执行 + 有限重试，避免无上限并发）
  const cardEntries = weekdayResult.columns.flatMap((column, columnIndex) =>
    column.items.map((item) => ({ card: item, columnIndex })),
  )
  const cardTexts = new Map()
  const uncertain = new Set()
  for (const [index, entry] of cardEntries.entries()) {
    if (isCancelled()) return { matched: true, cancelled: true }
    onStage(`正在识别第 ${index + 1}/${cardEntries.length} 块…`, 0.15 + (0.8 * index) / Math.max(1, cardEntries.length))
    const inset = Math.max(1, Math.round(entry.card.width * 0.015))
    const cardRegion = {
      x: entry.card.x0 + inset, y: entry.card.y0 + inset,
      width: Math.max(1, entry.card.width - 2 * inset), height: Math.max(1, entry.card.height - 2 * inset),
    }
    const first = cropGray(cardRegion, { maxScale: CARD_SCALE, mode: 'contrast' })
    const firstData = await recognize(grayToCanvas(first.gray, first.width, first.height, { pad: 0, createCanvas }), { psm: '6' })
    let text = String(firstData?.text || '')
    const quality = data => (Number(data.confidence) || 0) + Math.max(-10, Math.min(10, scoreCardRead(data.text))) * 0.15
    let confidence = Number(firstData.confidence) || 0
    let best = quality(firstData)
    if (confidence < 88 || isSuspicious(text)) {
      for (const retry of CARD_RETRIES) {
        if (isCancelled()) return { matched: true, cancelled: true }
        const prepared = cropGray(cardRegion, retry)
        const retryData = await recognize(
          grayToCanvas(prepared.gray, prepared.width, prepared.height, { pad: 0, createCanvas }),
          { psm: '6' },
        )
        const candidateText = String(retryData?.text || '')
        const score = quality(retryData)
        if (candidateText.replace(/\s/g, '') !== text.replace(/\s/g, '')) uncertain.add(entry.card)
        if (score > best) {
          best = score
          text = candidateText
          confidence = Number(retryData.confidence) || 0
        }
      }
    }
    if (confidence < 88 || isSuspicious(text)) uncertain.add(entry.card)
    cardTexts.set(entry.card, text)
  }
  if (isCancelled()) return { matched: true, cancelled: true }

  const built = buildWeekGridCandidates({
    columns: weekdayResult.columns,
    cardTexts,
    periods,
    options: { weekViewWeek: week },
  })

  const candidates = []
  /** 卡片区域里读出来的是"表头 / 时间栏"文字（周一、08:00…），绝不是课程。 */
  let headerOnlyCards = 0
  let unreadableCards = 0
  for (const candidate of built.candidates) {
    // 表头行与左侧时间栏在几何上会落在表头/左侧区域，个别情况下仍可能被当成卡片；
    // 这里按"名字就是纯标签"再拦一道，避免把「周一」「08:00」导成课程。
    if (isStructuralCandidate(candidate)) {
      headerOnlyCards += 1
      continue
    }
    const extra = [...(candidate.warnings || [])]
    if (candidate.cardRef && uncertain.has(candidate.cardRef)) {
      extra.push('这一块识别可信度较低或不同读法存在分歧，请对照原图核对名称和地点')
    }
    candidates.push({ ...candidate, warnings: extra })
  }

  // 表头区域被当成卡片读出来的文字（仅在诊断里体现，不进入候选）。
  const headerRegionText = [...cardTexts.values()].filter((text) => isHeaderCardText(text)).length
  if (headerRegionText) headerOnlyCards = Math.max(headerOnlyCards, headerRegionText)

  // 课块存在、但 OCR 文本切不出课程名：这些课确实丢了，必须显式提示（不能假装完整）。
  for (const text of cardTexts.values()) {
    if (isHeaderCardText(text)) continue
    const parsed = parseCardText(text)
    if (!parsed.name || isStructuralCandidate(parsed)) unreadableCards += 1
  }

  // 定位到 N 个课块但一块都没读出名字：这是识别失败，不是"识别成功但没有课"。
  if (candidates.length === 0 && cardEntries.length > 0) {
    throw new OcrLayoutError(HEADER_ONLY_MESSAGE, {
      code: 'STRUCTURE_NOT_FOUND',
      layout: 'week-grid',
      headerOnly: headerOnlyCards || cardEntries.length,
      candidateCount: 0,
    })
  }

  if (headerOnlyCards > 0) {
    warnings.push(
      `有 ${headerOnlyCards} 块位置读到的是表头/时间栏文字（已忽略，不会当成课程），请核对其余课程是否完整。`,
    )
  }
  if (unreadableCards > 0) {
    warnings.push(`有 ${unreadableCards} 块课块没有读出课程名，这些课可能缺失，请对照原图补上。`)
  }

  return {
    matched: true,
    cancelled: false,
    week,
    columns: weekdayResult.columns,
    periods,
    candidates,
    warnings: [...warnings, ...built.columnWarnings],
    diagnostics: {
      coverage: Number(coverage.toFixed(3)),
      componentCount: components.length,
      columnCount: weekdayResult.columns.length,
      periodCount: periods.length,
      cardCount: cardEntries.length,
      candidateCount: candidates.length,
      headerOnlyCards,
      cardColor: colors.card
        ? `rgb(${Math.round(colors.card.r)},${Math.round(colors.card.g)},${Math.round(colors.card.b)})`
        : null,
    },
  }
}

/** 供离线/测试使用：不经过 canvas 的灰度裁剪（与浏览器同一套 weekGridLayout 规则）。 */
export function grayFromImageData(imageData, region) {
  const { data, width, height } = imageData
  return toGray(data, width, height, region)
}
