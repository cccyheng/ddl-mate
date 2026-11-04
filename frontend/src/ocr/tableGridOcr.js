/**
 * 「有线框表格」课表照片的完整识别流水线（浏览器与伴侣服务共用同一份实现）。
 *
 * 与 weekGridOcr.js（卡片式周视图）的分工一样，这里只做编排：
 *   - 版式几何与单元格文本切分在 tableGridLayout.js（纯函数）；
 *   - 预处理在 imageOps.js（纯函数）；
 *   - OCR 由调用方传入的 recognize 完成。
 *
 * 流程：
 *   1. 左列逐格 OCR → 每个行带的节次范围与上课时刻；
 *   2. 表头逐格 OCR → 每一列是星期几（标签 + 日期交叉校验）；
 *   3. 有墨迹的格子逐个 OCR（最多六种预处理）→ 按「课程号括号」锚点切成一条条课程 →
 *      名称 / 老师 / 周次 / 地点；不同读数不一致时按多数读数取值，
 *      平票时取更可信的一次并**明确写"无法由多数决定"**；冲突提示跟到具体候选上；
 *   4. 每个格子用左侧节次对齐：合并单元格跨几个行带就跨几个节次（星期日 = 1-4 节，08:00-11:35）。
 *
 * 表头行怎么定：**只看开头连续几行"左侧节次栏读不出节次"的行，而且这些行必须比正文行矮**。
 * 正文里某一行读不出节次（真机上出现过 5-6 节那格没读出来），绝不能反过来把表头往下推——
 * 否则 1-4 行的课程会被整批当成表头丢掉。
 *
 * 只读画面内容：没有课程名字典、没有针对某张图的坐标、没有学期/年份臆测。
 * 读不到的字段留空并给出 warning，由用户确认。
 */

import { prepareCardImage } from './imageOps.js'
import { HEADER_ONLY_MESSAGE, OcrLayoutError, isStructuralCandidate } from './structuralLabels.js'
import { detectDisplayedWeek, resolveWeekdayColumns, weekdayFromText } from './weekGridLayout.js'
import {
  analyzeTableGridGeometry,
  cellInkRatio,
  nameLooksClean,
  parseCellEntries,
  parseGutterCellText,
  parseTableCellText,
  rowSpanForCell,
  splitCellTextIntoEntries,
} from './tableGridLayout.js'
import { grayToCanvas } from './weekGridOcr.js'

export { analyzeTableGridGeometry }

/** 格子里的墨迹至少要占这么大比例才算"这格有课"（与 tableGridLayout 保持一致）。 */
const MIN_CELL_INK_RATIO = 0.004
const GUTTER_PAD = 18
const HEADER_PAD = 16
const CELL_PAD = 12
/** 表头最多占开头两行；再多就不像表头了。 */
const MAX_HEADER_ROWS = 2
/** 表头行必须比正文行矮这么多才算表头，不能靠"读不出节次"去吞正文行。 */
const HEADER_HEIGHT_RATIO = 0.8

/**
 * 每格的固定读法集合（有界，最多六次）。
 *
 * 顺序与口径来自独立只读质量探针（`.supervision/dense-quality-report.md`，
 * 同一张密集原图上的 A/B 测量，都是与图片内容无关的通用结论）：
 *
 * 1. 灰底/蓝底格子在**放大之后必须做一次灰度归一化**，否则整格读不出文本
 *   （探针：不归一化时周日格 8 个变体全部返回空文本，conf 0）。
 * 2. 放大倍数取 **4–5 倍**，不要 6 倍（6 倍时笔画糊在一起，`电航楼` 丢字）。
 * 3. 归一化优先 `contrastForText`（快）；`binarizeForText`（全局 Otsu）逐字最准但慢
 *   （1.5–1.9 秒/格），所以只作为**低置信度时的一次兜底重试**。
 * 4. 自适应二值化只作兜底（探针里它把括号/楼名读成拉丁乱码 `CRIBAS`）。
 *
 * 六次读数参与字段校对。不能因为第一条课程的字段齐全就提前停止；
 * 同格可能还有其他安排，“齐全”也不代表文字准确。
 */
const CELL_ATTEMPTS = [
  { label: 's2-smooth-contrast', maxScale: 2, mode: 'contrast', smooth: true },
  { label: 's2-contrast', maxScale: 2, mode: 'contrast' },
  { label: 's1-otsu', maxScale: 1, mode: 'otsu' },
  { label: 's4-contrast', maxScale: 4, mode: 'contrast' },
  { label: 's5-otsu', maxScale: 5, mode: 'otsu' },
  { label: 's4-blue', maxScale: 4, mode: 'linear', channel: 'blue' },
]
/**
 * 诊断收集器（可选）。
 *
 * 只存"每个有课格子读到了什么、切成了几条候选"，供真机排查与离线回归对照原图使用；
 * 不参与任何判定，也不会被写进课程数据。不开诊断时整个收集过程是空操作。
 */
const CELL_DIAGNOSTIC_LIMIT = 60
const GUTTER_ATTEMPTS = [
  { label: 's2-contrast', maxScale: 2, mode: 'contrast' },
  { label: 's1-otsu', maxScale: 1, mode: 'otsu' },
]
const HEADER_ATTEMPTS = [
  { label: 's2-contrast', maxScale: 2, mode: 'contrast' },
  { label: 's2-smooth-contrast', maxScale: 2, mode: 'contrast', smooth: true },
]

function regionOf(box, pad) {
  return {
    x: box.x0 + pad,
    y: box.y0 + pad,
    width: Math.max(1, box.width - pad * 2),
    height: Math.max(1, box.height - pad * 2),
  }
}

/**
 * 一次读数（一种预处理）的好坏：**字段完整度**为主，不是"名字看起来干净"。
 *
 * 真机复现：`人和人30001720)` 这种乱码名字也能通过 `nameLooksClean`，
 * 只按"名字干净"打分会让它压过真正读到课程号/周次/地点的读数
 *（`大学物理(B-2)` 那次读数反而被丢掉）。所以这里按
 * 「课程号 + 周次 + 地点 + 老师」的完整度打分，再给课程名一点权重。
 */
function scoreEntries(entries) {
  let score = 0
  for (const entry of entries) {
    if (entry.name && nameLooksClean(entry.name)) score += 4
    else if (entry.name) score += 1
    if (entry.courseCode) score += 4
    if (entry.startWeek) score += 5
    if (entry.location) score += 3
    if (entry.teacher) score += 1
    // 一条记录四个字段都齐：说明这次读数是完整的一行，优先。
    if (entry.name && entry.courseCode && entry.startWeek && entry.location) score += 3
  }
  return score
}

const weekKey = (entry) => (entry.startWeek ? (entry.clauses?.length ? entry.clauses : [entry]).map(c => `${c.startWeek}-${c.endWeek}-${c.weekPattern}`).join(';') : null)

// 同号课程可以在同一格出现多次。仅凭课程号不能配对地点；先匹配完整周次，
// 无周次时只允许唯一课程，或同条数、同序号的同一位置。
function matchingPeer(read, entry, index, count) {
  const same = read.entries.filter(p => entry.courseCode ? p.courseCode === entry.courseCode : p.name === entry.name)
  if (same.length === 1) {
    if (count > 1 && weekKey(entry) && weekKey(same[0]) && weekKey(entry) !== weekKey(same[0])) return null
    return same[0]
  }
  const sameWeeks = same.filter(p => weekKey(p) && weekKey(p) === weekKey(entry))
  if (sameWeeks.length === 1) return sameWeeks[0]
  const at = read.entries[index]
  return read.entries.length === count && same.includes(at) ? at : null
}

function locationKey(location) {
  // 附注和标点的小差异不应拆散同一教室的票数；不移植另一条安排的教室。
  return String(location ?? '').replace(/[多作侈儿字寡]媒体(?:教室)?/g, '')
    .replace(/[\u4e00-\u9fa5]{0,3}校区/g, '')
    .replace(/[\s()（）{}\[\]【】,，.。\-–—]/g, '')
}

const describe = (votes) => votes.map(([key, count]) => `${key}×${count}`).join(' / ')

/**
 * 多次读数合成一条：以分数最高的一次为主，名称与教学周按**多数读数**修正。
 *
 * 措辞按证据强弱分开写：有严格多数才说"按多数读数取…"；平票只能说"无法由多数决定，
 * 已取更可信的一次"。冲突提示挂到**对应的那条候选**上（readNotes），不再只给一句全局提示。
 */
export function combineCellReads(reads) {
  const sorted = [...reads].sort((a, b) => b.score - a.score)
  const base = sorted[0]
  let resolved = 0
  let ties = 0
  const entries = base.entries.map((entry, index) => {
    const merged = { ...entry, readNotes: [] }
    const peers = sorted
      .map((read) => matchingPeer(read, entry, index, base.entries.length))
      .filter(Boolean)

    const cleanNames = peers.filter((peer) => peer.name && nameLooksClean(peer.name))
    if (cleanNames.length > 1) {
      const votes = new Map()
      for (const peer of cleanNames) votes.set(peer.name, (votes.get(peer.name) ?? 0) + 1)
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
      if (ranked.length > 1) {
        if (ranked[0][1] === ranked[1][1]) {
          ties += 1
          merged.readNotes.push(
            `课程名有不止一种读数（${describe(ranked)}），无法由多数决定，已取更可信的一次，请对照原图核对`,
          )
        } else if (ranked[0][0] !== merged.name) {
          merged.readNotes.push(`课程名按多数读数取「${ranked[0][0]}」（${describe(ranked)}），请核对`)
          merged.name = ranked[0][0]
          resolved += 1
        }
      }
    }

    const weekPeers = peers.filter((peer) => peer.startWeek)
    if (weekPeers.length > 1) {
      const votes = new Map()
      for (const peer of weekPeers) {
        const key = weekKey(peer)
        votes.set(key, (votes.get(key) ?? 0) + 1)
      }
      const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1])
      if (ranked.length > 1) {
        if (ranked[0][1] === ranked[1][1]) {
          ties += 1
          merged.readNotes.push(
            `教学周有不止一种读数（${describe(ranked)}），无法由多数决定，已取更可信的一次，请对照原图核对`,
          )
        } else if (ranked[0][0] !== weekKey(merged)) {
          merged.readNotes.push(`教学周按多数读数取 ${ranked[0][0]}（${describe(ranked)}），请核对`)
          const winner = weekPeers.find(peer => weekKey(peer) === ranked[0][0])
          merged.startWeek = winner.startWeek
          merged.endWeek = winner.endWeek
          merged.weekPattern = winner.weekPattern
          merged.clauses = winner.clauses?.map(c => ({ ...c }))
          resolved += 1
        }
      }
    }
    const locations = peers.filter(p => hasVenueBuilding(p.location))
    if (locations.length) {
      const votes = new Map()
      for (const peer of locations) { const key = locationKey(peer.location); votes.set(key, (votes.get(key) ?? 0) + 1) }
      const ranked = [...votes].sort((a,b) => b[1]-a[1])
      if (!hasVenueBuilding(merged.location) || ranked[0][1] > (votes.get(locationKey(merged.location)) ?? 0)) {
        merged.location = locations.find(p => locationKey(p.location) === ranked[0][0]).location
      }
      if (ranked.length > 1) merged.readNotes.push('上课地点存在不同识别结果，请对照原图核对')
    }
    return merged
  })
  return { entries, resolved, ties, confidence: base.confidence ?? 0 }
}

/**
 * 按**选课序号**对课程名做全表多数投票（纯统计，没有课程名字典）。
 *
 * 同一门课在一张表里可能出现好几次，每次 OCR 都可能有别的错字
 *（`大学英滞(3)` / `形驮与政策` / `电路与电子技术(MX启)`）。
 * 单格的三次读数票数太少，平票时只能"取更可信的一次"；而同一个选课序号
 * 在整张表里的读数合起来投票，票数多得多，名称就能自动收敛到对的那一种。
 * 这里只做投票，**不新增、不改写任何课程事实**：候选写法全部来自 OCR 读数本身。
 *
 * 两条刻意的设计（都是真机复现逼出来的）：
 *   1. **每格只投一票**。同一格的三种预处理读的是同一张图，错法高度相关
 *      （`电路与电子技术(双启)` 会在三次里出现三次），按读数计票会被一格刷票；
 *      按"格子"计票才代表独立的版面证据。
 *   2. 序号按完整字母数字串配对，不截断前缀，不把不同序号的课程合并。
 *
 * @param {Array<{cell: object, reads: Array<{label: string, confidence?: number, entries: Array<object>}>}>} cellAttempts
 * @returns {Map<string, string>} 原始选课序号 → 得票最多的课程名
 */
export function resolveBySerial(cellAttempts) {
  const familyNames = new Map()
  for (const { reads } of cellAttempts) {
    // 第一步：本格内取"单格票数最多、再比置信度"的写法，作为这一格的一票。
    const perCell = new Map()
    for (const read of reads) {
      const confidence = Number(read.confidence) || 0
      for (const entry of read.entries) {
        if (!entry.courseCode || !entry.name) continue
        const bucket = perCell.get(entry.name) ?? { reads: 0, confidence: 0 }
        bucket.reads += 1
        bucket.confidence = Math.max(bucket.confidence, confidence)
        perCell.set(entry.name, bucket)
      }
    }
    if (!perCell.size) continue
    const [cellName] = [...perCell.entries()].sort(
      (a, b) => b[1].reads - a[1].reads || b[1].confidence - a[1].confidence,
    )[0]
    // 第二步：这一票投给"本格里与这个名字**配对的**选课序号家族"。
    // 只认与获胜名字同时出现的条目：一格有多个课程号读数时，不能把无关序号拉进来投票。
    // 同一门课的序号变体（`9913000192.80` / `9913000192.B0`）会被一起投上。
    const families = new Set()
    for (const read of reads) {
      for (const entry of read.entries) {
        if (entry.courseCode && entry.name === cellName) families.add(serialFamily(entry.courseCode))
      }
    }
    const confidence = [...perCell.values()].reduce((max, bucket) => Math.max(max, bucket.confidence), 0)
    for (const family of families) {
      const votes = familyNames.get(family) ?? new Map()
      const bucket = votes.get(cellName) ?? { cells: 0, confidence: 0 }
      bucket.cells += 1
      bucket.confidence = Math.max(bucket.confidence, confidence)
      votes.set(cellName, bucket)
      familyNames.set(family, votes)
    }
    // 地点**不做全表投票**：同一门课不同星期可能真的在不同教室
    //（`电路与电子技术` 周一学汇楼、周二/周五电航楼），全表共识会把地点改错。
    // 地点只在同一格内取最完整的一条（见 `bestLocation`）。
  }
  const familyWinner = new Map()
  for (const [family, votes] of familyNames) {
    const [name] = [...votes.entries()].sort(
      (a, b) => b[1].cells - a[1].cells || b[1].confidence - a[1].confidence,
    )[0]
    familyWinner.set(family, name)
  }
  // 平票很常见（同一门课只有两格、各读到一种写法）。平票时不再比置信度，
  // 而是看**哪一种写法与全表所有候选写法最一致**：逐字统计"这个字在别的候选里也出现过"
  // 的次数，得分最高者胜；同分再取更长的一条（信息更全）。
  // 真机复现：`电路与电子技术(双启)` 与 `(双亲)` / `(双记)` 的 `双` 出现 3 次，
  // 而只出现 1 次的 `(双语)` 反而会被置信度挑错 —— 按一致性挑能选回多数派。
  for (const [family, votes] of familyNames) {
    if (votes.size < 2) continue
    // 一致性同分时再比置信度，最后取更长的一条（OCR 常见的错法是丢字）。
    const [name] = [...votes.entries()].sort(
      (a, b) =>
        b[1].cells - a[1].cells ||
        b[1].confidence - a[1].confidence ||
        b[0].length - a[0].length,
    )[0]
    familyWinner.set(family, name)
  }
  const names = new Map()
  for (const { reads } of cellAttempts) {
    for (const read of reads) {
      for (const entry of read.entries) {
        if (!entry.courseCode) continue
        const name = familyWinner.get(serialFamily(entry.courseCode))
        if (name) names.set(entry.courseCode, name)
      }
    }
  }
  return names
}

/**
 * 同一格里挑最完整的地点：优先"带楼名"的读数，其次更长的一条。
 *
 * （`学汇楼-412多媒体西山校区` 胜过 `体西山校区` —— 后者是整段读丢后的残片。）
 */
export function bestLocation(reads, entry) {
  const index = Number.isInteger(entry?.index) ? entry.index : 0
  const candidates = []
  for (const read of reads) {
    // 同一格多门课时，"第 index 条"在别的读数里未必是同一门课：
    // 优先按**同一选课序号 + 同一课程名**找回那条记录的地点，找不到才退回位置。
    const matched = matchingPeer(read, entry, index, entry.entryCount)
    if (matched?.location) candidates.push(matched.location)
  }
  if (!candidates.length) return null
  return candidates.sort(
    (a, b) => Number(hasVenueBuilding(b)) - Number(hasVenueBuilding(a)) || b.length - a.length,
  )[0]
}

/** 独立中文模型只补充地点，不改已由数字读数校对的周次、时间或序号。
 * 同格重复课程按原文顺序配对，要求该课程的记录数一致；缺条时只接受唯一的完整周次匹配。
 */
export function applyCellDetails(entries, detail) {
  if (!detail || detail.confidence < 0.7) return entries
  const alternatives = parseCellEntries(detail.text)
  return entries.map((entry, index) => {
    if (!entry.courseCode) return entry
    const peers = alternatives.filter(peer => peer.courseCode === entry.courseCode)
    const originals = entries.filter(peer => peer.courseCode === entry.courseCode)
    let peer
    if (peers.length === originals.length) {
      const rank = entries.slice(0, index).filter(item => item.courseCode === entry.courseCode).length
      peer = peers[rank]
    } else {
      const matching = peers.filter(item => weekKey(item) === weekKey(entry))
      if (matching.length === 1) peer = matching[0]
    }
    if (!peer || !hasVenueBuilding(peer.location)) return entry
    return {
      ...entry,
      location: peer.location,
      readNotes: [...(entry.readNotes ?? []), ...(locationKey(peer.location) !== locationKey(entry.location)
        ? ['上课地点已用本机中文识别校对，请对照原图确认'] : [])],
    }
  })
}

/** 地点里是否有楼名（`楼/馆/中心/…`）——只有带楼名的读数才算完整地点。 */
function hasVenueBuilding(location) {
  return /(楼|馆|中心|教室|机房|实验室|场地|园区|基地)/.test(String(location ?? ''))
}

/**
 * 课程名是不是**结构性乱码**（不是"非中文"）。
 *
 * 故意**不按语言判断**：英文课名（`English`、`College Physics`）是合法课程名，
 * 一律按"没有汉字"拒绝会误杀。这里只用**版面/结构证据**：
 *   1. 括号不配对（`BETEEESEISETAITEY IZ)(1` 的 `)(`）；
 *   2. 连续 8 个以上拉丁字母且**整段没有任何分隔/停顿**（`BETEEESEISETAITEY` 这种
 *      不是任何一个英文单词，正常课名会有空格或多段）；
 *   3. 夹着竖线/反斜杠这种表格线噪声。
 * 真机复现：`BETEEESEISETAITEY IZ)(1` / `AINIB-2)` 都属于第 1、2 类。
 */
export function isGarbageName(name) {
  const value = String(name ?? '').trim()
  if (!value) return false
  // 括号必须配对，否则是读坏的碎片（`)(` / 半个括号）。
  const opens = (value.match(/[（(\[【]/g) || []).length
  const closes = (value.match(/[)）\]】]/g) || []).length
  if (opens !== closes) return true
  if (/[|\\]/.test(value)) return true
  // 8 个以上连续拉丁字母、且整段只有这一个词：不是正常课名。
  const latinRuns = value.match(/[A-Za-z]{8,}/g) ?? []
  if (latinRuns.length && value.replace(/[A-Za-z]+/g, '').replace(/[\s\d.,，。()（）\-+]/g, '').length === 0) {
    return latinRuns.every((run) => run.length >= 8)
  }
  return false
}

/** 选课序号的"同一门课"归一化键：去掉 `.` 等标点，其余原样保留。 */
function serialFamily(serial) {
  return String(serial ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
}

/**
 * 识别一张"有线框表格"课表。
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData RGBA
 * @param {{recognize: Function, createCanvas?: Function, isCancelled?: Function, onStage?: Function, geometry?: object}} options
 * @returns 与 recognizeWeekGrid 同形状：{ matched, layout, week, candidates, warnings, diagnostics }
 *          matched=false 表示这张图不是有线框表格，调用方应回退到别的分支。
 */
export async function recognizeTableGrid(imageData, options = {}) {
  const { recognize, isCancelled = () => false, onStage = () => {}, createCanvas } = options || {}
  const { data, width, height } = imageData
  const geometry = options.geometry || analyzeTableGridGeometry(imageData, options.geometryOptions)
  if (!geometry.matched) return { matched: false, reason: geometry.reason }

  const { ink, rowBands, columnBands, cells, table, horizontal, vertical } = geometry
  const warnings = []
  const diagnosticsExtra = {}
  const recognizeCanvas = async (prepared, psm) =>
    recognize(grayToCanvas(prepared.gray, prepared.width, prepared.height, { pad: 0, createCanvas }), { psm })

  // ---- 1) 左列：逐格识别节次与时刻
  //
  // 为什么不整条竖条一次 OCR：竖条是 190×1150 这种极端长宽比，缩放后会被 Tesseract 降采样，
  // "15:30" 很容易被读成 "16:30"。逐格裁（约 180×205）识别率明显更高。
  const gutterColumn = columnBands[0]
  const periodRows = []
  for (const [index, band] of rowBands.entries()) {
    if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
    onStage(
      `正在识别左侧第 ${index + 1}/${rowBands.length} 行节次…`,
      0.06 + (0.06 * index) / Math.max(1, rowBands.length),
    )
    const cellRegion = {
      x: gutterColumn.y0 + 2,
      y: band.y0 + 2,
      width: Math.max(4, gutterColumn.size - 4),
      height: Math.max(4, band.size - 4),
    }
    let parsed = null
    let text = ''
    for (const attempt of GUTTER_ATTEMPTS) {
      const prepared = prepareCardImage(data, width, height, cellRegion, { pad: GUTTER_PAD, ...attempt })
      const recognized = await recognizeCanvas(prepared, '6')
      text = String(recognized?.text || '').trim()
      const candidate = parseGutterCellText(text)
      const complete = candidate.periodStart !== null && candidate.startTime && candidate.endTime
      if (complete) {
        parsed = candidate
        break
      }
      if (!parsed) parsed = candidate
    }
    periodRows.push({
      ...parsed,
      rowIndex: index,
      cy: (band.y0 + band.y1) / 2,
      y0: band.y0,
      y1: band.y1,
      size: band.size,
      text,
    })
  }
  diagnosticsExtra.gutterReads = periodRows.map((entry) => `r${entry.rowIndex}:${entry.text.replace(/\s+/g, '/')}`)
  const periods = periodRows.filter((entry) => entry.periodStart !== null)
  if (!periods.length) {
    warnings.push('没有识别到左侧的节次与时刻，导入前请手动补充开始/结束时间')
  }

  // ---- 2) 表头行：只看**开头**连续几行"读不出节次、而且比正文行矮"的行
  //
  // 反例（真机复现）：5-6 节那一格的节次没读出来，如果按"最后一行读不出节次的行"当表头底，
  // 表头就被推到第 5 行，1-4 行的课程全被当成表头丢掉（20 条只剩 4 条）。这里必须只看开头。
  const bodyHeights = periodRows
    .filter((entry) => entry.periodStart !== null)
    .map((entry) => entry.size)
    .sort((a, b) => a - b)
  const medianBodyHeight = bodyHeights.length ? bodyHeights[Math.floor(bodyHeights.length / 2)] : 0
  const headerCap = medianBodyHeight > 0 ? MAX_HEADER_ROWS : 1
  let contentStartRow = 0
  if (periodRows[0].periodStart === null) {
    contentStartRow = 1
    while (
      contentStartRow < rowBands.length &&
      contentStartRow < headerCap &&
      periodRows[contentStartRow].periodStart === null
    ) {
      // 正文行即使节次没读出来也比表头高：够高就不再算表头，课程不会被吞。
      if (medianBodyHeight > 0 && rowBands[contentStartRow].size >= medianBodyHeight * HEADER_HEIGHT_RATIO) break
      contentStartRow += 1
    }
  }
  const weekdayColumns = columnBands
    .filter((band) => band.index >= 1)
    .map((band) => ({ index: band.index, cx: (band.y0 + band.y1) / 2, x0: band.y0, x1: band.y1 }))
  const headerTokens = []
  if (contentStartRow > 0) {
    onStage('正在识别表头星期…', 0.14)
    const headerBottom = rowBands[contentStartRow - 1].y1
    // 表头逐格识别：格子里只有一个"星期X"，比把 2500×50 的窄条整体丢给 Tesseract 稳得多。
    for (const [index, column] of weekdayColumns.entries()) {
      if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
      onStage(
        `正在识别表头第 ${index + 1}/${weekdayColumns.length} 列…`,
        0.14 + (0.04 * index) / Math.max(1, weekdayColumns.length),
      )
      const cellRegion = {
        x: column.x0 + 2,
        y: table.y0 + 2,
        width: Math.max(4, column.x1 - column.x0 - 3),
        height: Math.max(4, headerBottom - table.y0 - 2),
      }
      let text = ''
      for (const attempt of HEADER_ATTEMPTS) {
        const prepared = prepareCardImage(data, width, height, cellRegion, { pad: HEADER_PAD, ...attempt })
        const recognized = await recognizeCanvas(prepared, '7')
        text = String(recognized?.text || '').trim()
        if (weekdayFromText(text)) break
      }
      headerTokens.push({ text, cx: column.cx, x0: column.x0, x1: column.x1 })
    }
  } else {
    warnings.push('这张表没有识别到表头行，星期需要手动选择')
  }
  diagnosticsExtra.headerReads = headerTokens.map((token, index) => `c${index + 1}:${token.text.replace(/\s+/g, '/')}`)
  const week = detectDisplayedWeek(headerTokens.map((token) => token.text))
  const weekdayResult = resolveWeekdayColumns(headerTokens, weekdayColumns)
  warnings.push(...weekdayResult.warnings)
  const weekdayByColumn = new Map(weekdayResult.columns.map((column) => [column.index, column.weekday]))

  // ---- 3) 有墨迹的格子逐个识别（固定 3 种预处理，取多数读数）
  const contentCells = cells.filter(
    (cell) =>
      cell.colIndex >= 1 && cell.rowStart >= contentStartRow && cellInkRatio(ink, width, cell) >= MIN_CELL_INK_RATIO,
  )
  if (!contentCells.length) {
    warnings.push('这张表里没有识别到任何有课的格子，请确认拍的是课程内容区域')
  }

  const cellReads = []
  const readAudit = []
  const cellDiagnostics = []
  let multiReadResolved = 0
  let consensusTies = 0
  const cellAttempts = []
  let cellDetails = []
  if (options.recognizeCellDetails) {
    onStage('正在本机精读课程地点…', 0.19)
    try {
      cellDetails = await options.recognizeCellDetails(contentCells)
    } catch {
      if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
      warnings.push('本机中文精读暂时不可用，已使用基础识别；请核对上课地点')
    }
  }
  for (const [index, cell] of contentCells.entries()) {
    if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
    onStage(`正在识别第 ${index + 1}/${contentCells.length} 格…`, 0.2 + (0.7 * index) / Math.max(1, contentCells.length))
    const region = regionOf(cell, 1)
    const reads = []
    // 固定六次上限，每次调用之前检查取消。
    let attemptsUsed = 0
    for (const [attemptIndex, attempt] of CELL_ATTEMPTS.entries()) {
      if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
      const prepared = prepareCardImage(data, width, height, region, { pad: CELL_PAD, ...attempt })
      const recognized = await recognizeCanvas(prepared, '6')
      const text = String(recognized?.text || '').trim()
      const entries = parseCellEntries(text).map((entry) => ({ ...entry, raw: entry.raw ?? text }))
      reads.push({
        label: attempt.label,
        text,
        entries,
        confidence: Number(recognized?.confidence) || 0,
      })
      attemptsUsed = attemptIndex + 1
    }
    cellAttempts.push({ cell, reads, attemptsUsed, detail: cellDetails[index] })
  }
  // 按选课序号做**全表共识**修正（纯统计，没有课程名字典）：
  // 一门课多次被读成 `马克轧主义基本原理` / `马克思主义基本原理` 时取得票最多的写法。
  const resolvedNames = resolveBySerial(cellAttempts)
  for (const { reads } of cellAttempts) {
    for (const read of reads) {
      read.entries = read.entries.map((entry) => ({
        ...entry,
        name: (entry.courseCode && resolvedNames.get(entry.courseCode)) || entry.name,
      }))
      read.score = scoreEntries(read.entries) + (Number(read.confidence) || 0) / 25
    }
  }
  for (const { cell, reads, detail } of cellAttempts) {
    if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }
    const best = [...reads].sort((a, b) => b.score - a.score)[0]
    const combined = combineCellReads(reads)
    // 地点按"同一格里最完整的一条"补齐（这个格子读丢的那半段，别的读数里可能有）。
    combined.entries = combined.entries.map((entry, index) => ({
      ...entry,
      index,
      location: hasVenueBuilding(entry.location) ? entry.location : bestLocation(reads, { ...entry, index, entryCount: combined.entries.length }) || entry.location,
    }))
    combined.entries = applyCellDetails(combined.entries, detail)
    multiReadResolved += combined.resolved
    consensusTies += combined.ties
    // 诊断：每个有课格子保留"最好那次读数的原始文本 + 切出来的条目"，便于对照原图排查。
    if (cellDiagnostics.length < CELL_DIAGNOSTIC_LIMIT) {
      cellDiagnostics.push({
        cell: `r${cell.rowStart}-${cell.rowEnd}c${cell.colIndex}`,
        box: [cell.x0, cell.y0, cell.x1, cell.y1],
        best: best.label,
        detail: detail ? { engine: 'pp-ocr-v5-local', ...detail } : null,
        text: best.text,
        entries: combined.entries.map((entry) => ({
          name: entry.name,
          teacher: entry.teacher ?? null,
          courseCode: entry.courseCode ?? null,
          startWeek: entry.startWeek ?? null,
          endWeek: entry.endWeek ?? null,
          weekPattern: entry.weekPattern ?? null,
          location: entry.location ?? null,
        })),
        allReads: reads.map((read) => ({ label: read.label, text: read.text, score: Math.round(read.score) })),
      })
    }
    // 诊断：只在"几种读数确实不一致"时记录，便于对照原图排查（正常格子不占空间）。
    const weekKeys = new Set(reads.flatMap((read) => read.entries.map((entry) => weekKey(entry))))
    const names = new Set(reads.flatMap((read) => read.entries.map((entry) => entry.name)))
    if (weekKeys.size > 1 || names.size > 1) {
      readAudit.push({
        cell: `r${cell.rowStart}-${cell.rowEnd}c${cell.colIndex}`,
        chosen: combined.entries.map((entry) => `${entry.name}|${weekKey(entry)}`).join(' / '),
        reads: reads.map(
          (read) => `${read.label}:${read.entries.map((entry) => `${entry.name}|${weekKey(entry)}`).join('+')}`,
        ),
      })
    }
    cellReads.push({ cell, text: best.text, entries: combined.entries })
  }
  if (isCancelled()) return { matched: true, cancelled: true, layout: 'table-grid' }

  // ---- 4) 组装候选
  const candidates = []
  let headerOnlyCells = 0
  let unreadableCells = 0
  let twoCourseCells = 0
  let missingPeriodCells = 0
  let missingClockCells = 0
  let garbageEntries = 0
  for (const read of cellReads) {
    const weekday = weekdayByColumn.get(read.cell.colIndex) ?? null
    const span = rowSpanForCell(read.cell, periodRows)
    const named = read.entries.filter((entry) => entry.name)
    if (read.entries.length > 1 && named.length > 1) twoCourseCells += 1
    if (!named.length) {
      unreadableCells += 1
      continue
    }
    if (span.periodStart === null) missingPeriodCells += 1
    else if (span.missingStartTime || span.missingEndTime) missingClockCells += 1
    for (const parsed of named) {
      // 纯拉丁乱码（`BETEEESEISETAITEY IZ)(1` / `AINIB-2)`）不是课程名：
      // 这种候选没有任何可用信息，混进课程列表只会让用户以为识别到了新课。
      // 判据保守：**一个汉字都没有、也没有课程号**才算乱码；中英混排（`C++` / 英文课名）不受影响。
      if (isGarbageName(parsed.name) && !parsed.courseCode) {
        garbageEntries += 1
        continue
      }
      const cellWarnings = [...(parsed.readNotes ?? [])]
      if (!weekday) cellWarnings.push('没有识别到这列的星期表头，请确认星期')
      if (span.periodStart === null) {
        cellWarnings.push(
          read.cell.mergedRows > 1 && span.missingRows
            ? '这个合并格里有一行的节次没读出来：整格的节次与时刻都留空（不拿相邻行的时间硬凑），请对照原图补上'
            : '没有把这一格对齐到左侧节次，请补充节次与时间（不会替你猜时间）',
        )
      } else if (span.missingStartTime && span.missingEndTime) {
        // 节次读到了，但边界行没读到时刻：留空并说明，绝不拿别的行的时间顶上。
        cellWarnings.push('节次读到了，但这一格的开始与结束时刻都没读出来：时刻留空（不替你猜），请对照原图补上')
      } else if (span.missingStartTime) {
        cellWarnings.push('节次读到了，但这一格的开始时刻没读出来：开始时间留空（不借用相邻行的时间），请对照原图补上')
      } else if (span.missingEndTime) {
        cellWarnings.push('节次读到了，但这一格的结束时刻没读出来：结束时间留空（不借用相邻行的时间），请对照原图补上')
      }
      if (!parsed.startWeek || !parsed.endWeek) {
        cellWarnings.push('这一格没有读到教学周范围，确认后按"每周"处理（可手动补起止周）')
      }
      if (!hasVenueBuilding(parsed.location)) cellWarnings.push('没有完整识别到地点，请对照原图补充上课地点')
      // 一个格子里可能写了**互不相邻**的周次片段（`3,5-18` / `单5-7` + `单13-15`）。
      // 每段各生成一条候选：DB 的"连续范围 + 单双周"表达不了中间的空档，
      // 合成一条会把空档也变成有课（凭空加周）。读不到周次时仍出一条，交给用户补。
      const clauses = Array.isArray(parsed.clauses) && parsed.clauses.length
        ? parsed.clauses
        : [{ startWeek: parsed.startWeek ?? null, endWeek: parsed.endWeek ?? null, weekPattern: parsed.weekPattern ?? null }]
      for (const clause of clauses) {
        const candidate = {
          layout: 'table-grid',
          name: parsed.name,
          weekday,
          startTime: span.startTime || null,
          endTime: span.endTime || null,
          periodStart: span.periodStart,
          periodEnd: span.periodEnd,
          startWeek: clause.startWeek ?? null,
          endWeek: clause.endWeek ?? null,
          weekPattern: clause.weekPattern ?? null,
          location: parsed.location,
          teacher: parsed.teacher,
          courseCode: parsed.courseCode,
          weekdayDate: null,
          rawText: parsed.raw || read.text,
          warnings: [...cellWarnings],
          suspect: false,
        }
        // 表头/时间栏文字绝不能被当成课程（与卡片路径同一道守卫）。
        if (isStructuralCandidate(candidate)) {
          headerOnlyCells += 1
          continue
        }
        candidates.push(candidate)
      }
    }
  }

  candidates.sort(
    (a, b) =>
      (a.weekday ?? 99) - (b.weekday ?? 99) ||
      (a.periodStart ?? 99) - (b.periodStart ?? 99) ||
      String(a.name).localeCompare(String(b.name)),
  )

  if (!candidates.length && contentCells.length > 0) {
    throw new OcrLayoutError(HEADER_ONLY_MESSAGE, {
      code: 'STRUCTURE_NOT_FOUND',
      layout: 'table-grid',
      headerOnly: headerOnlyCells || contentCells.length,
      candidateCount: 0,
    })
  }
  if (headerOnlyCells > 0) {
    warnings.push(`有 ${headerOnlyCells} 处读到的是表头/时间栏文字（已忽略，不会当成课程），请核对其余课程是否完整。`)
  }
  if (unreadableCells > 0) {
    warnings.push(`有 ${unreadableCells} 个格子没有读出课程名，这些课可能缺失，请对照原图补上。`)
  }
  if (twoCourseCells > 0) {
    warnings.push(`有 ${twoCourseCells} 个格子里识别到两门课（已各算一条），请核对其周次与单双周。`)
  }
  if (missingPeriodCells > 0) {
    warnings.push(`有 ${missingPeriodCells} 个格子没有对齐到左侧节次（这些候选的节次/时刻留空），请对照原图补上。`)
  }
  if (missingClockCells > 0) {
    warnings.push(`有 ${missingClockCells} 个格子只读到节次、没读全起止时刻（缺失的那一端留空，没有借用相邻行的时间），请对照原图补上。`)
  }
  if (consensusTies > 0) {
    warnings.push(`有 ${consensusTies} 处不同读数互不一致且票数相同，已取更可信的一次，请对照原图核对。`)
  }

  return {
    matched: true,
    cancelled: false,
    layout: 'table-grid',
    week,
    candidates,
    warnings,
    diagnostics: {
      layoutReason: '有线框表格：按检测到的横线/竖线切格，合并单元格按隔线缺失判定',
      threshold: geometry.report,
      horizontalLines: horizontal.length,
      verticalLines: vertical.length,
      rowCount: rowBands.length,
      columnCount: columnBands.length,
      contentCells: contentCells.length,
      candidateCount: candidates.length,
      headerRowCount: contentStartRow,
      periodCount: periods.length,
      twoCourseCells,
      headerOnlyCells,
      unreadableCells,
      missingPeriodCells,
      missingClockCells,
      multiReadResolved,
      consensusTies,
      readAudit,
      cellDiagnostics,
      ...diagnosticsExtra,
    },
  }
}
