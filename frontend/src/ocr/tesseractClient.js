/**
 * 浏览器端 OCR 客户端：Tesseract.js（中文 + 英文），**资源全部同源**。
 *
 * - worker / core(wasm) / 语言模型都来自 /tesseract/*（由 scripts/prepare-ocr-assets.mjs 在构建时准备）；
 * - 运行期不访问任何 CDN，用户图片不上传，识别完全在浏览器里完成；
 * - 识别参数与 Node 冒烟脚本共用 src/ocr/ocrConfig.js（PSM 11 稀疏文本，表格照片必需）；
 * - 用 generation 序号做取消：取消 / 切换图片 / 组件卸载后，迟到的 worker 与识别结果一律作废，
 *   不会覆盖新图片的结果，也不会让旧 worker 继续跑。
 */
import { createWorker } from 'tesseract.js'
import { TESSERACT_FALLBACK_PARAMS, TESSERACT_PARAMS } from './ocrConfig.js'

const ASSET_BASE = '/tesseract'

/** 取消或已过期时抛出，调用方通常直接忽略。 */
export class OcrCancelledError extends Error {
  constructor() {
    super('识别已取消')
    this.name = 'OcrCancelledError'
  }
}

let workerPromise = null
let activeWorker = null
let progressHandler = null
let generation = 0

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/** 解码后的像素上限：超过先等比缩放，避免几万像素的图把内存打满。 */
export const MAX_IMAGE_PIXELS = 12_000_000
const MAX_EDGE_FACTOR = 1.6
const MAX_EDGE = 2600
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export function ocrSupported() {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined'
}

function assetPaths() {
  return {
    workerPath: `${ASSET_BASE}/worker.min.js`,
    coreDir: `${ASSET_BASE}/core`,
    langPath: `${ASSET_BASE}/lang`,
  }
}

/** core 在不同版本里可能是"目录"或"具体文件"，按顺序尝试。 */
function coreCandidates() {
  const { coreDir } = assetPaths()
  return [
    coreDir,
    `${coreDir}/tesseract-core-simd-lstm.wasm.js`,
    `${coreDir}/tesseract-core-lstm.wasm.js`,
    `${coreDir}/tesseract-core-simd.wasm.js`,
    `${coreDir}/tesseract-core.wasm.js`,
  ]
}

const STATUS_TEXT = {
  'loading tesseract core': '正在加载识别引擎…',
  'initializing tesseract': '正在初始化识别引擎…',
  'loading language traineddata': '正在加载中文/英文模型…',
  'initializing api': '正在准备识别接口…',
  'recognizing text': '正在识别文字…',
}

export function toChineseStatus(status) {
  return STATUS_TEXT[status] || '正在处理…'
}

async function createWorkerWithFallback(generationAtStart) {
  const { workerPath, langPath } = assetPaths()
  let lastError = null
  for (const corePath of coreCandidates()) {
    if (generation !== generationAtStart) throw new OcrCancelledError()
    let worker = null
    try {
      worker = await createWorker('chi_sim+eng', 1, {
        workerPath,
        corePath,
        langPath,
        logger: (message) => {
          if (generation !== generationAtStart) return
          if (progressHandler) progressHandler(message)
        },
        errorHandler: (error) => console.error('[ocr] worker error', error),
      })
      // 迟到的 worker：已被取消 / 换图 → 立刻销毁，不让它继续跑
      if (generation !== generationAtStart) {
        try {
          await worker.terminate()
        } catch {
          /* ignore */
        }
        throw new OcrCancelledError()
      }
      activeWorker = worker
      console.info('[ocr] worker 就绪，core =', corePath)
      return worker
    } catch (error) {
      if (error instanceof OcrCancelledError) throw error
      lastError = error
      try {
        await worker?.terminate()
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error(
    `OCR 资源加载失败：${lastError?.message || '未知错误'}。` +
      '请确认已执行 pnpm build（会准备 /tesseract 下的 worker、core 与语言模型）。',
  )
}

/** 取得（必要时创建）共享 worker。onProgress 会覆盖上一次的回调。 */
export async function getWorker(onProgress) {
  progressHandler = onProgress || null
  const currentGeneration = generation
  if (!workerPromise) {
    const promise = createWorkerWithFallback(currentGeneration)
    workerPromise = promise
    // 失败清理：只清掉"还是这一个 promise"的情况，避免把后来的新 promise 误清空。
    // 这里 catch 掉是为了不产生未处理的 rejection；调用方拿到的是原始 promise。
    promise.catch(() => {
      if (workerPromise === promise) workerPromise = null
    })
  }
  return workerPromise
}

/**
 * 确保交给 Tesseract 的东西不需要"再取一次网络/blob 资源"。
 * Tesseract 收到 HTMLImageElement 时会再次 fetch image.src，若该地址（例如临时 blob URL）
 * 已失效就会报 net::ERR_FILE_NOT_FOUND —— 所以这里把图片元素统一转换成 canvas。
 * File / Blob / URL / Canvas 原样返回（Tesseract 自己会读 Blob，不存在二次取失效地址的问题）。
 */
export async function toRecognizableImage(image) {
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) {
    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height
    if (!width || !height) throw new Error('图片尺寸异常，无法识别')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(image, 0, 0)
    return canvas
  }
  return image
}

/**
 * 识别一张图片，返回带位置信息的识别结果（blocks/lines）。
 * psm 可选：默认用稀疏文本（整页课表照片）；分块识别时传 '6'（统一文本块）。
 */
export async function recognizeImage(image, { onProgress, onStatus, psm } = {}) {
  const myGeneration = generation
  const worker = await getWorker((message) => {
    if (message?.status === 'recognizing text') {
      onProgress?.(message.progress || 0)
    } else if (message?.status) {
      onStatus?.(message.status)
    }
  })
  if (myGeneration !== generation) throw new OcrCancelledError()

  const input = await toRecognizableImage(image)
  if (myGeneration !== generation) throw new OcrCancelledError()

  // 课表照片是稀疏表格版面：默认用稀疏文本模式（见 ocrConfig.js 的实测说明）；
  // 分块/逐行识别时由调用方指定更合适的模式。
  const params = psm ? { ...TESSERACT_PARAMS, tessedit_pageseg_mode: String(psm) } : TESSERACT_PARAMS
  await worker.setParameters(params)
  let data = (await worker.recognize(input, {}, { blocks: true, text: true })).data
  if (myGeneration !== generation) throw new OcrCancelledError()

  // 万一整页什么都没识别到，退回 auto 模式再试一次（仍以同一次任务为准）
  if (!data?.text?.trim()) {
    await worker.setParameters(TESSERACT_FALLBACK_PARAMS)
    data = (await worker.recognize(input, {}, { blocks: true, text: true })).data
    if (myGeneration !== generation) throw new OcrCancelledError()
  }
  return data
}

/** 取整张图片的像素数据（周视图流水线需要自己分析像素）。 */
export function imageToImageData(image, maxPixels = MAX_IMAGE_PIXELS) {
  const canvas = typeof image === 'string' || image instanceof Blob || image instanceof File
    ? null
    : image
  const source = canvas
  const width = source?.width || source?.naturalWidth
  const height = source?.height || source?.naturalHeight
  if (!width || !height) throw new Error('图片尺寸异常，无法分析版面')
  const ratio = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  const targetWidth = Math.max(1, Math.round(width * ratio))
  const targetHeight = Math.max(1, Math.round(height * ratio))
  const scratch = document.createElement('canvas')
  scratch.width = targetWidth
  scratch.height = targetHeight
  const context = scratch.getContext('2d', { willReadFrequently: true })
  context.drawImage(source, 0, 0, targetWidth, targetHeight)
  return context.getImageData(0, 0, targetWidth, targetHeight)
}

/** 取消并释放当前 worker；进行中的创建/识别结果都会因 generation 变化而作废。 */
export async function terminateWorker() {
  generation += 1
  progressHandler = null
  const worker = activeWorker
  activeWorker = null
  const pending = workerPromise
  workerPromise = null
  // 吃掉进行中创建 promise 的 rejection（它已因 generation 变化作废，不该冒泡成未处理异常）
  pending?.catch(() => {})
  if (worker) {
    try {
      await worker.terminate()
    } catch (error) {
      console.warn('[ocr] terminate 失败', error)
    }
  }
}

export function validateImageFile(file) {
  if (!file) return '请选择一张课表照片'
  if (!ALLOWED_TYPES.includes(file.type)) return '只支持 PNG / JPEG / WebP 图片'
  if (file.size > MAX_IMAGE_BYTES) {
    return `图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），请压缩到 12 MB 以内`
  }
  return null
}

/**
 * 内部：把任意来源（File / Blob / URL 字符串 / HTMLImageElement）加载成已解码的图片元素。
 * 返回 { image, width, height, release }：release() 负责释放本函数自己创建的临时 objectURL。
 *
 * 注意：临时 URL 必须留到"调用方绘制完成"之后再释放 —— 提前 revoke 会让后续按 src
 * 重新取图的消费者（如 Tesseract 收到 HTMLImageElement 时会再 fetch 一次）拿到
 * net::ERR_FILE_NOT_FOUND。因此这里不在 onload 里 revoke。
 */
function loadImageElement(source) {
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    // 已经是解码好的图片元素：直接用，不产生临时 URL
    return Promise.resolve({
      image: source,
      width: source.naturalWidth || source.width,
      height: source.naturalHeight || source.height,
      release: () => {},
    })
  }
  return new Promise((resolve, reject) => {
    const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source)
    const release = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    const image = new Image()
    image.onload = () =>
      resolve({
        image,
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
        release,
      })
    image.onerror = () => {
      release()
      reject(new Error('图片解码失败，请换一张图片或重新导出后再试'))
    }
    image.src = objectUrl || source
  })
}

/**
 * 内部：得到"可直接绘制"的对象（Canvas 原样用，其它来源先解码）。
 * 返回 { drawable, width, height, release } —— 无论哪条分支都必须带 drawable，
 * 否则 drawImage(undefined) 会在浏览器抛 "The provided value is not of type CanvasImageSource"。
 */
async function toDrawable(source) {
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    return { drawable: source, width: source.width, height: source.height, release: () => {} }
  }
  // 注意：loadImageElement 返回的是 { image, ... }，这里必须显式改名成 drawable
  const { image, width, height, release } = await loadImageElement(source)
  return { drawable: image, width, height, release }
}

/**
 * 读取图片并做像素保护，**始终返回 Canvas**：
 *   - 不缩放的小图也要画到 canvas —— 这样识别/裁剪都不再依赖任何临时 URL 的生命周期；
 *   - 超过 MAX_IMAGE_PIXELS 时等比缩小后再识别。
 * 返回 { image: HTMLCanvasElement, width, height, scaled }（width/height 是实际用于识别的尺寸）。
 */
export async function prepareImage(source) {
  const { drawable, width, height, release } = await toDrawable(source)
  try {
    if (!width || !height) {
      throw new Error('图片尺寸异常，无法识别')
    }
    const pixels = width * height
    const longest = Math.max(width, height)
    const needsScale = pixels > MAX_IMAGE_PIXELS || longest > MAX_EDGE * MAX_EDGE_FACTOR
    const ratio = needsScale
      ? Math.min(Math.sqrt(MAX_IMAGE_PIXELS / pixels), (MAX_EDGE * MAX_EDGE_FACTOR) / longest)
      : 1
    const targetWidth = Math.max(1, Math.round(width * ratio))
    const targetHeight = Math.max(1, Math.round(height * ratio))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    canvas.getContext('2d').drawImage(drawable, 0, 0, targetWidth, targetHeight)
    // 绘制完成之后才允许释放临时 URL
    return { image: canvas, width: targetWidth, height: targetHeight, scaled: targetWidth !== width }
  } finally {
    release()
  }
}

/**
 * 把图片按框选区域裁剪出来，坐标基于用于识别的尺寸。
 * 支持 File / Blob / URL / HTMLImageElement / HTMLCanvasElement：
 *   - Canvas 直接绘制（绝不 URL.createObjectURL(canvas)，那会抛 TypeError）；
 *   - 其它来源先解码成图片元素，绘制完成后再释放临时 URL。
 */
export async function cropImage(source, region) {
  const { drawable, width, height, release } = await toDrawable(source)
  try {
    if (!width || !height) {
      throw new Error('图片尺寸异常，无法裁剪')
    }
    // 裁剪范围必须落在图内，避免越界后画出空白区域
    const sx = Math.min(Math.max(Math.round(region.x), 0), Math.max(0, width - 1))
    const sy = Math.min(Math.max(Math.round(region.y), 0), Math.max(0, height - 1))
    const sw = Math.max(1, Math.min(Math.round(region.width), width - sx))
    const sh = Math.max(1, Math.min(Math.round(region.height), height - sy))

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    canvas.getContext('2d').drawImage(drawable, sx, sy, sw, sh, 0, 0, sw, sh)
    return { canvas, width: canvas.width, height: canvas.height }
  } finally {
    release()
  }
}

export function releaseObjectUrl(url) {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url)
  }
}
