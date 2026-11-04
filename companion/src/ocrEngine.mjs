/**
 * 识别引擎：把**前端产品里的那套周视图流水线**跑在 Node 上。
 *
 * 复用（不是重写）：
 * - `frontend/src/ocr/weekGridOcr.js`：卡片式周视图的完整编排（几何 + 逐块识别 + 重试）；
 * - `frontend/src/ocr/weekGridLayout.js` / `imageOps.js`：几何与预处理纯函数；
 * - `frontend/src/ocr/timetableParser.js`：不像周视图时的整图回退解析；
 * - `frontend/src/ocr/ocrConfig.js`：与浏览器相同的 Tesseract 参数；
 * - `frontend/public/tesseract/lang`：本地语言模型，**没有任何第三方上传**。
 *
 * 这里只替换两件浏览器特有的东西：`canvas`（用假 canvas 存灰度）与
 * PNG 编码（用 `imageCodec.mjs` 的最小实现），其余规则一行不改。
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TESSERACT_PARAMS } from '../../frontend/src/ocr/ocrConfig.js'
import { toGray } from '../../frontend/src/ocr/imageOps.js'
import { HEADER_ONLY_MESSAGE, OcrLayoutError } from '../../frontend/src/ocr/structuralLabels.js'
import { recognizeTimetableLayout } from '../../frontend/src/ocr/timetableLayout.js'
import { flattenOcrLines, parseTimetable } from '../../frontend/src/ocr/timetableParser.js'

import { encodeGrayPng } from './imageCodec.mjs'
import { loadNeuralConfig, recognizeCellDetails } from './neuralOcr.mjs'
import { recognizeExamCards } from './examOcr.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const frontendRoot = join(workspaceRoot, 'frontend')

/**
 * 前端源码是 ESM、`tesseract.js` 装在前端的 node_modules 里。
 * 用 `createRequire` 以前端目录为基准解析，等价于「在前端里跑」——
 * 不需要改前端的 package.json，也不需要把依赖再装一遍。
 */
const frontendRequire = createRequire(join(frontendRoot, 'package.json'))
const tesseract = frontendRequire('tesseract.js')

export const LANG_PATH = join(frontendRoot, 'public', 'tesseract', 'lang')

/** 通知截图：优先按「一整块均匀文本」识别。 */
export const NOTICE_PSM = '6'
/** 通知截图：PSM 6 什么都没读出来时的自动版面兜底。 */
export const NOTICE_FALLBACK_PSM = '3'

/**
 * 把 Tesseract 的整段输出整理成「保留行顺序」的纯文字。
 *
 * 只做三件事：统一换行、去掉每行行尾空白、去掉首尾空行。
 * **不合并行、不重排、不改写任何字** —— 行与行之间的先后顺序就是用户看到的顺序。
 */
export function normalizeNoticeText(text) {
  const raw = typeof text === 'string' ? text : ''
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[0].trim().length === 0) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop()
  return lines.join('\n')
}

/**
 * 假 canvas：只有 `grayToCanvas()` 用到 `createImageData` / `putImageData`。
 * 灰度值就是 RGBA 里四个通道的同一个值，取 R 通道即可还原。
 */
function createFakeCanvas() {
  const canvas = { width: 0, height: 0 }
  let image = null
  canvas.getContext = () => ({
    createImageData: (width, height) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    }),
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

/** 识别引擎：Tesseract worker 只创建一次，之后串行复用（内存有界）。 */
export class OcrEngine {
  async recognizeExams(imageData, options = {}) { return recognizeExamCards(this, imageData, options) }
  constructor(options = {}) {
    this.neuralConfig = options.neuralConfig === undefined ? loadNeuralConfig() : options.neuralConfig
    this.langPath = options.langPath ?? LANG_PATH
    this.langs = options.langs ?? 'chi_sim+eng'
    this.worker = null
    this.starting = null
    /** worker 只能串行使用；并发请求在 HTTP 层排队，这里再做一层保险。 */
    this.chain = Promise.resolve()
    this.calls = 0
  }

  async start() {
    if (this.worker) return this.worker
    if (!this.starting) {
      this.starting = tesseract
        .createWorker(this.langs, 1, { langPath: this.langPath, cacheMethod: 'none' })
        .then((worker) => {
          this.worker = worker
          return worker
        })
        .catch((cause) => {
          this.starting = null
          throw cause
        })
    }
    return this.starting
  }

  async terminate() {
    const worker = this.worker
    this.worker = null
    this.starting = null
    if (worker) await worker.terminate()
  }

  /** 把一段灰度缓冲交给 Tesseract（与浏览器脚本用同一组参数）。 */
  async recognizeGray(gray, width, height, { psm } = {}) {
    const worker = await this.start()
    const run = async () => {
      this.calls += 1
      await worker.setParameters({ ...TESSERACT_PARAMS, tessedit_pageseg_mode: String(psm || '11') })
      const png = encodeGrayPng(gray, width, height)
      const out = await worker.recognize(png, {}, { blocks: true, text: true })
      return out.data
    }
    const next = this.chain.then(run, run)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 识别一张**通知 / 公告截图**，只返回按阅读顺序保留换行的纯文字。
   *
   * 与 `recognizeTimetable` 的区别（刻意的边界）：
   * - **不做任何课表解析**，也不因为「只读到标题/时间栏」而拒绝 —— 通知本来就可能是
   *   一段没有表格结构的文字；
   * - 保留 Tesseract 给出的行顺序（`data.text` 就是阅读顺序），只清理行尾空白与
   *   首尾空行，不重排、不合并行；
   * - 没有文字时返回 `rawText: ''` 与一条明确的 `warnings`，**绝不编造候选内容**。
   *
   * 版面模式用 PSM 6（一整块均匀文本），这是通知截图最常见的样子；万一 PSM 6
   * 什么都没读出来，再用 PSM 3（自动版面）重试一次，仍然为空就如实返回空。
   *
   * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData RGBA
   * @param {{isCancelled?: () => boolean}} options
   */
  async recognizeNotice(imageData, options = {}) {
    const isCancelled = options.isCancelled ?? (() => false)
    const startedAt = Date.now()
    const gray = toGray(imageData.data, imageData.width, imageData.height)
    const warnings = []

    const run = (psm) => this.recognizeGray(gray.gray, gray.width, gray.height, { psm })
    let full = await run(NOTICE_PSM)
    let rawText = normalizeNoticeText(full?.text)
    if (isCancelled()) {
      return { cancelled: true, rawText: '', empty: true, warnings: [], ms: Date.now() - startedAt, ocrCalls: this.calls }
    }
    if (rawText.length === 0) {
      // PSM 6 没读到东西：换自动版面再试一次（不改变「空就是空」的语义）。
      warnings.push('第一遍没有读到文字，已自动换一种版面再试一次。')
      full = await run(NOTICE_FALLBACK_PSM)
      rawText = normalizeNoticeText(full?.text)
      if (isCancelled()) {
        return { cancelled: true, rawText: '', empty: true, warnings, ms: Date.now() - startedAt, ocrCalls: this.calls }
      }
    }
    if (rawText.length === 0) {
      warnings.push('这张图里没有识别到任何文字（不是识别失败，是确实没读到字）。')
    }
    return {
      cancelled: false,
      rawText,
      empty: rawText.length === 0,
      warnings,
      ms: Date.now() - startedAt,
      ocrCalls: this.calls,
    }
  }

  /**
   * 识别一张已解码的图片。
   *
   * @param {{data: Uint8ClampedArray, width: number, height: number}} imageData RGBA
   * @param {{isCancelled?: () => boolean, onStage?: (text: string, ratio: number) => void}} options
   */
  async recognizeTimetable(imageData, options = {}) {
    const isCancelled = options.isCancelled ?? (() => false)
    const onStage = options.onStage ?? (() => {})
    const stages = []
    const startedAt = Date.now()

    const recognize = (canvas, { psm } = {}) =>
      this.recognizeGray(canvas.gray, canvas.width, canvas.height, { psm })

    onStage('正在定位课块…', 0.02)
    // 版式路由：有线框表格（真实手机拍的横版课表）优先按网格切格，
    // 卡片式周视图截图走原来的卡片流水线；先跑的那条读不出课程时还有另一条兜底。
    const routed = await recognizeTimetableLayout(imageData, {
      recognize,
      recognizeCellDetails: this.neuralConfig
        ? (cells) => recognizeCellDetails(this.neuralConfig, imageData, cells, { isCancelled })
        : undefined,
      createCanvas: createFakeCanvas,
      isCancelled,
      onStage: (text, ratio) => {
        stages.push(`${text}(${Math.round(ratio * 100)}%)`)
        onStage(text, ratio)
      },
    })

    if (routed.cancelled) {
      return { cancelled: true, layout: routed.layout ?? 'table-grid', candidates: [], warnings: [], diagnostics: {}, ocrCalls: this.calls }
    }

    if (routed.matched && (routed.candidates ?? []).length) {
      return {
        cancelled: false,
        layout: routed.layout ?? 'week-grid',
        week: routed.week ?? null,
        candidates: routed.candidates,
        warnings: routed.warnings ?? [],
        diagnostics: routed.diagnostics ?? {},
        rawText: (routed.candidates ?? []).map((candidate) => candidate.rawText ?? '').filter(Boolean).join('\n'),
        stages,
        ms: Date.now() - startedAt,
        ocrCalls: this.calls,
      }
    }

    // 两种版式都没读出课程：回退到整图识别 + 前端同一个解析器（列表 / 表格 / 区域）。
    //
    // 注意：`recognizeGray` 要的是**每像素 1 字节的灰度**，而这里手上是 RGBA
    // （每像素 4 字节）。复核对 bug 就是直接传了 RGBA，于是图片被当成「宽度不变的
    // 1/4 高度」错位图，整图回退基本读不出东西。必须先用前端同一份 `toGray` 转换。
    onStage('看起来不是周视图，改用整图识别…', 0.15)
    const gray = toGray(imageData.data, imageData.width, imageData.height)
    const full = await this.recognizeGray(gray.gray, gray.width, gray.height, { psm: '11' })
    if (isCancelled()) {
      return { cancelled: true, layout: 'full-image', candidates: [], warnings: [], diagnostics: {}, ocrCalls: this.calls }
    }
    const lines = flattenOcrLines(full)
    const parsed = parseTimetable(lines, { mode: 'auto' })
    // 整图回退只读到表头/时间栏：这是**明确失败**，不能返回"识别成功但 0 条候选"。
    // 真机上最常见的形态就是：OCR 读准了周一…周日与左侧时刻，课程方块一个都没读出来。
    if (parsed.structuralOnly) {
      throw new OcrLayoutError(HEADER_ONLY_MESSAGE, {
        code: 'STRUCTURE_NOT_FOUND',
        layout: parsed.layout || 'full-image',
        headerOnly: parsed.structuralDropped ?? 0,
        candidateCount: 0,
      })
    }
    return {
      cancelled: false,
      layout: parsed.layout || 'full-image',
      week: null,
      candidates: parsed.candidates ?? [],
      warnings: [...(routed.warnings ?? []), ...(parsed.warnings ?? [])],
      diagnostics: { ...(routed.diagnostics ?? {}), fallback: true, graySize: `${gray.width}x${gray.height}` },
      rawText: parsed.rawText ?? full.text ?? '',
      stages,
      ms: Date.now() - startedAt,
      ocrCalls: this.calls,
    }
  }
}
