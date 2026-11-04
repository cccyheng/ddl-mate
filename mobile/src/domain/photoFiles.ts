/**
 * 手机侧的图片准备：把相册/相机拿到的原图转成**能上传、且尽量不损失识别率**的字节。
 *
 * 为什么必须在手机侧先处理：iPhone 原图可能是 HEIC、也可能 10MB+ 且单边超过 4000 像素；
 * 伴侣服务只接受 PNG/JPEG（见 `companion/src/imageCodec.mjs`）；一次把 20MB base64
 * 塞进内存也容易把 Expo Go 拖崩。
 *
 * ## 编码策略（先无损、再降级；每一步都有真实对比数据支撑）
 *
 * 真实对比（`.supervision/ios-photo-quality-benchmark.json`）里，同一张 1279×2781 的
 * 课表截图：原样 PNG 与「原分辨率只转 JPEG」都拿到 21/21 课程名、21/21 时间；
 * 而「最长边 2000」只拿到 15/21 时间、「最长边 1600」只拿到 11/21。
 * 所以顺序是：
 *
 * 1. **原样直传**：来源已经是 PNG/JPEG、单边与像素都在服务端上限内、字节也在预算内时，
 *    直接把原始字节发出去（不重编码 = 零损失，手机侧几乎不花时间）；
 * 2. **原分辨率 PNG**（无损）——`saveAsync({ format: SaveFormat.PNG })`，适合截图；
 *    只有超过字节预算才继续往下走；
 * 3. **原分辨率 JPEG**（0.9）——像素数完全保留，只接受轻微有损；
 * 4. 仍然超预算才**按比例**缩小（0.8 / 0.64 / 0.5），并且缩小档从更低质量起步，
 *    避免「已缩小 + 最高质量」这种既糊又大的组合。
 *
 * **绝不放大**：旧实现固定 `resize({ width: 2000 })`，会把 1279×2781 的竖版图放大到
 * 2000×4349（字节更多、更慢、地点命中反而下降）。
 *
 * 原生边界：`SaveFormat` 是**对象**（`{ JPEG: 'jpeg', PNG: 'png' }`），
 * `saveAsync({ format })` 要的是**标量**。这里统一走 `selectSaveFormatValue()` 取值，
 * 绝不把整个枚举对象传下去（那是真机上直接坏掉的写法）。
 *
 * `expo-image-manipulator` 只在真机/模拟器里存在，因此走**动态 import**，
 * 这样 node 测试里 import 本文件不会失败。
 */

import { OcrClientError } from './photoOcrClient'

/** 和服务端 `IMAGE_LIMITS` 对齐的上限（手机侧先自己守住，避免白传一次被拒）。 */
export const COMPANION_MAX_BYTES = 12 * 1024 * 1024
export const COMPANION_MAX_PIXELS = 26_000_000
export const COMPANION_MAX_SIDE = 10_000

/** 上传预算：比服务端上限留出 JSON/base64 包装的余量。 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** 单边硬上限。 */
export const MAX_UPLOAD_SIDE = COMPANION_MAX_SIDE
/** 像素总数硬上限。 */
export const MAX_UPLOAD_PIXELS = COMPANION_MAX_PIXELS

/** 缩放阶梯：每档是相对**原始像素**的比例（1 = 不缩放）。 */
export const SCALE_STEPS = [1, 0.8, 0.64, 0.5] as const
/** JPEG 质量阶梯（只在需要时往下走）。 */
export const QUALITY_STEPS = [0.9, 0.75, 0.6] as const

export interface PreparedPhoto {
  /** 本机文件 URI（只用于本机预览，不上传路径本身）。 */
  uri: string
  /** base64 内容（不含 `data:` 前缀）。 */
  base64: string
  byteLength: number
  mimeType: string
  width: number | null
  height: number | null
  /** 原图像素尺寸（能拿到就带上，拿不到为 `null`）。 */
  sourceWidth: number | null
  sourceHeight: number | null
  /** 是否真的做了缩放（false = 只转码/直传，原始分辨率保留）。 */
  resized: boolean
  /** 本次用的缩放比例（1 = 原始分辨率）。 */
  scale: number
  /** 本次用的质量（PNG 为 1）。 */
  quality: number
  /** 最终编码：`png`（无损）或 `jpeg`。 */
  format: 'png' | 'jpeg'
  /** 原始字节直接上传（没有重编码）。 */
  preservedSource: boolean
  /** 一共尝试了几档（1 表示第一档就够小）。 */
  attempts: number
}

/** 原图信息：相册/相机能给出多少就给多少，缺了也不影响流程。 */
export interface PhotoSourceInfo {
  width?: number | null
  height?: number | null
  /** 原始 MIME（例如 `image/heic`）；只用于说明，不参与判定。 */
  mimeType?: string | null
}

/** base64 字符串 → 原始字节数（不必再读一次文件）。 */
export function base64ByteLength(base64: string): number {
  const clean = base64.replace(/\s/g, '')
  if (clean.length === 0) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

/** 去掉可能存在的 `data:image/xxx;base64,` 前缀。 */
export function stripDataUriPrefix(value: string): string {
  return String(value ?? '').replace(/^data:[^,]*,/, '')
}

/**
 * 只看 base64 开头的魔数判断真实格式（**不信任**扩展名或 MIME）。
 *
 * 用途：iOS 相册有时报 `image/heic`，取回来的字节其实已经是 JPEG；也可能反过来。
 * 直传前必须先确认真实格式，否则会把 HEIC 原样发给只认 PNG/JPEG 的服务。
 *
 * 刻意**不用 `Buffer`**：这是跑在 React Native 里的代码，`Buffer` 不保证存在。
 */
export function sniffBase64Format(base64: string): 'png' | 'jpeg' | null {
  const clean = stripDataUriPrefix(base64).slice(0, 24)
  if (clean.length < 8) return null
  // 只解前几个字节就够了：PNG 是 0x89 'P' 'N' 'G'，JPEG 是 0xFF 0xD8。
  const bytes: number[] = []
  for (let index = 0; index + 3 < clean.length && bytes.length < 8; index += 4) {
    const chunk = base64Chunk(clean.slice(index, index + 4))
    if (chunk === null) return null
    bytes.push((chunk >> 16) & 0xff, (chunk >> 8) & 0xff, chunk & 0xff)
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  return null
}

/** 把 4 个 base64 字符解成 24 位整数；非法字符返回 `null`。 */
function base64Chunk(text: string): number | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let value = 0
  for (const char of text) {
    if (char === '=') return value << ((4 - text.length) * 6)
    const index = alphabet.indexOf(char)
    if (index < 0) return null
    value = (value << 6) | index
  }
  return value
}

/**
 * 只读图片**头部**拿真实像素尺寸（PNG 的 IHDR / JPEG 的 SOF）。
 *
 * 为什么必须自己解析：`expo-image-manipulator` 回报的尺寸在个别机型/格式上不可靠，
 * 而「单边 10000 / 2600 万像素」是服务端的硬上限，超了整张图会被拒。
 * 这里直接量**真正要发出去的字节**，而不是相信元数据。
 *
 * 只读前若干字节，不解码像素（与 `companion/src/imageCodec.mjs` 的思路一致）。
 */
export function readEncodedSize(base64: string): { width: number; height: number; format: 'png' | 'jpeg' } | null {
  const clean = stripDataUriPrefix(base64)
  const format = sniffBase64Format(clean)
  if (!format) return null
  // 约 96KB 的头部足够覆盖 PNG 的 IHDR 与 JPEG 的 SOF（正常都在最前面）。
  const head = decodeBase64Prefix(clean, 96 * 1024)
  if (head.length < 24) return null

  if (format === 'png') {
    if (head.length < 24 || head[12] !== 0x49 || head[13] !== 0x48 || head[14] !== 0x44 || head[15] !== 0x52) return null
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20), format }
  }

  // JPEG：逐段找 SOF0–SOF15（跳过无参数标记与填充 0xFF）。
  let offset = 2
  while (offset + 9 < head.length) {
    if (head[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = head[offset + 1]
    if (marker === undefined) return null
    if (marker === 0xff) {
      offset += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = ((head[offset + 2] ?? 0) << 8) | (head[offset + 3] ?? 0)
    if (length < 2) return null
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      const height = ((head[offset + 5] ?? 0) << 8) | (head[offset + 6] ?? 0)
      const width = ((head[offset + 7] ?? 0) << 8) | (head[offset + 8] ?? 0)
      return { width, height, format }
    }
    if (marker === 0xda) break // 进入压缩数据，后面不会再有 SOF
    offset += 2 + length
  }
  return null
}

/** 解出 base64 的**前 N 个字节**（不整段解码，避免多占内存）。 */
function decodeBase64Prefix(base64: string, maxBytes: number): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const usable = base64.slice(0, Math.ceil(maxBytes / 3) * 4)
  const bytes = new Uint8Array(Math.floor((usable.length * 3) / 4))
  let byteIndex = 0
  for (let index = 0; index + 3 < usable.length; index += 4) {
    const chunk = base64Chunk(usable.slice(index, index + 4))
    if (chunk === null) break
    bytes[byteIndex] = (chunk >> 16) & 0xff
    bytes[byteIndex + 1] = (chunk >> 8) & 0xff
    bytes[byteIndex + 2] = chunk & 0xff
    byteIndex += 3
  }
  return bytes.subarray(0, byteIndex)
}

/** 正数像素值才算「已知尺寸」；`0` / `undefined` / `NaN` 都当未知。 */
function positivePixels(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export interface ResizeTier {
  /** 相对原始像素的缩放比例（可能被单边/像素上限再收小）。 */
  scale: number
  width: number | null
  height: number | null
  /** 需不需要真的调用 `resize`。 */
  resized: boolean
  /** 尺寸是否已知（未知时第一档先渲染一次拿尺寸，不缩放）。 */
  known: boolean
}

/**
 * 给定原图尺寸与缩放比例，算出这一档的目标尺寸（纯函数，便于单测）。
 *
 * 硬约束（服务端接受不了就直接拒绝，所以必须自己先守住）：
 * - **绝不放大**；
 * - 保持长宽比，两边同比例；
 * - 单边 ≤ `maxSide`；宽×高 ≤ `maxPixels`；
 * - 尺寸未知：`scale >= 1` 时返回「不缩放」，缩小时只给宽度
 *   （`resize({ width })` 自带等比）——绝不传 `null, null`。
 */
export function planResizeTier(
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
  scale: number,
  maxSide: number = MAX_UPLOAD_SIDE,
  maxPixels: number = MAX_UPLOAD_PIXELS,
): ResizeTier {
  const width = positivePixels(sourceWidth)
  const height = positivePixels(sourceHeight)
  if (width === null || height === null) {
    if (scale >= 1) return { scale: 1, width: null, height: null, resized: false, known: false }
    return { scale, width: null, height: null, resized: true, known: false }
  }

  const longest = Math.max(width, height)
  const bySide = longest > maxSide ? maxSide / longest : 1
  const byPixels = width * height > maxPixels ? Math.sqrt(maxPixels / (width * height)) : 1
  const effective = Math.min(scale, bySide, byPixels)

  if (effective >= 1) {
    return { scale: 1, width, height, resized: false, known: true }
  }
  const aspect = width / height
  // 用 floor 而不是 round：四舍五入会把「刚好等于上限」的尺寸推到上限之上，
  // 于是服务端会说图片太大 —— 这正是要避免的（必须自己先满足硬上限）。
  let targetWidth = Math.max(1, Math.floor(width * effective))
  let targetHeight = Math.max(1, Math.floor(height * effective))
  while (targetWidth * targetHeight > maxPixels) {
    targetWidth = Math.max(1, targetWidth - 1)
    targetHeight = Math.max(1, Math.round(targetWidth / aspect))
  }
  return {
    scale: effective,
    width: targetWidth,
    height: targetHeight,
    resized: true,
    known: true,
  }
}

/** 目标尺寸是否还在服务端硬上限内。 */
export function withinEncodeLimits(
  width: number | null | undefined,
  height: number | null | undefined,
  maxSide: number = MAX_UPLOAD_SIDE,
  maxPixels: number = MAX_UPLOAD_PIXELS,
): boolean {
  const w = positivePixels(width)
  const h = positivePixels(height)
  if (w === null || h === null) return true // 未知就不做无根据的拒绝，交给原生层
  return w <= maxSide && h <= maxSide && w * h <= maxPixels
}

/** 一档编码：无损 PNG 或某个质量的 JPEG。 */
export interface EncodeStep {
  format: 'png' | 'jpeg'
  quality: number
  scale: number
}

/**
 * 编码阶梯（纯函数，便于单测）。
 *
 * 先原分辨率 PNG（无损）→ 原分辨率 JPEG（0.9 / 0.75 / 0.6）→ 0.8 倍
 * （PNG → JPEG 0.75 / 0.6）→ 0.64 → 0.5。缩小档不再回到最高质量，避免白花时间。
 */
export function buildEncodeLadder(scales: readonly number[] = SCALE_STEPS): EncodeStep[] {
  const steps: EncodeStep[] = []
  for (const scale of scales) {
    steps.push({ format: 'png', quality: 1, scale })
    const qualities = scale >= 1 ? QUALITY_STEPS : QUALITY_STEPS.slice(1)
    for (const quality of qualities) {
      steps.push({ format: 'jpeg', quality, scale })
    }
  }
  return steps
}

/** 一档编码要调用的 `saveAsync` 参数（**格式必须是标量**）。 */
export interface SavePlan {
  format: 'png' | 'jpeg'
  compress: number
  resize: { width: number | null; height: number | null } | null
}

/**
 * 把「阶梯 + 原图尺寸」翻成真正的 `saveAsync` 参数。
 *
 * 这里是原生边界最容易出错的地方：`SaveFormat` 是一个**对象**
 * （`{ JPEG: 'jpeg', PNG: 'png' }`），必须取它的**属性值**。
 * 另外：未知尺寸 + 不缩放时**不能**传 `{ width: null, height: null }`（原生不接受），
 * 这种情况直接不调用 `resize`。
 */
export function selectSavePlan(
  step: EncodeStep,
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
  maxSide: number = MAX_UPLOAD_SIDE,
  maxPixels: number = MAX_UPLOAD_PIXELS,
): SavePlan {
  const tier = planResizeTier(sourceWidth, sourceHeight, step.scale, maxSide, maxPixels)
  return {
    format: step.format,
    compress: step.quality,
    resize:
      tier.resized && (tier.width !== null || tier.height !== null)
        ? { width: tier.width, height: tier.height }
        : null,
  }
}

/** 从原生枚举对象里取标量格式值；传入字符串也接受（测试替身用字符串）。 */
export function selectSaveFormatValue(
  saveFormat: { JPEG?: string | number; PNG?: string | number } | string | number,
  format: 'png' | 'jpeg',
): string | number {
  if (typeof saveFormat === 'string' || typeof saveFormat === 'number') {
    return format === 'png' ? 'png' : saveFormat
  }
  const value = format === 'png' ? saveFormat.PNG : saveFormat.JPEG
  if (value === undefined) {
    // 枚举里没有这一项（版本差异）时退化成字符串常量，而不是把整个对象传下去。
    return format
  }
  return value
}

interface ManipulatorImageLike {
  width?: number
  height?: number
  saveAsync: (options: { format: string | number; compress: number; base64: boolean }) => Promise<{
    uri: string
    width?: number
    height?: number
    base64?: string
  }>
}

interface ManipulatorContextLike {
  resize: (size: {
    width?: number | null
    height?: number | null
  }) => { renderAsync: () => Promise<ManipulatorImageLike> }
  renderAsync: () => Promise<ManipulatorImageLike>
}

interface ManipulatorLike {
  manipulate: (uri: string) => ManipulatorContextLike
}

/** 只在测试里注入；正常运行时不传，走真实的动态 import。 */
export interface PreparePhotoDeps {
  manipulator?: ManipulatorLike
  /** 真实原生枚举对象（`{ JPEG: 'jpeg', PNG: 'png' }`）。 */
  saveFormat?: { JPEG?: string | number; PNG?: string | number } | string | number
  /** 读原图字节；用于「原样直传」那一档。 */
  readSourceBase64?: (uri: string) => Promise<string>
}

export interface PreparePhotoOptions {
  maxBytes?: number
  maxSide?: number
  maxPixels?: number
  source?: PhotoSourceInfo
  deps?: PreparePhotoDeps
}

/**
 * 把一张图片准备成可上传的 base64。
 *
 * 顺序：原样直传（PNG/JPEG 且各项上限内）→ 原分辨率 PNG → 原分辨率 JPEG →
 * 按比例缩小后的各档。任何一步失败都抛可读的 `OcrClientError`。
 */
export async function preparePhotoForUpload(uri: string, options: PreparePhotoOptions = {}): Promise<PreparedPhoto> {
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES
  const maxSide = options.maxSide ?? MAX_UPLOAD_SIDE
  const maxPixels = options.maxPixels ?? MAX_UPLOAD_PIXELS
  if (!uri) {
    throw new OcrClientError('BAD_REQUEST', '没有拿到图片地址，请重新拍照或选择一张图片。', { retryable: true })
  }

  const source = options.source
  let sourceWidth = positivePixels(source?.width)
  let sourceHeight = positivePixels(source?.height)

  let ImageManipulator: ManipulatorLike
  let saveFormat: { JPEG?: string | number; PNG?: string | number } | string | number
  let readSourceBase64: ((uri: string) => Promise<string>) | undefined
  if (options.deps?.manipulator) {
    ImageManipulator = options.deps.manipulator
    saveFormat = options.deps.saveFormat ?? 'jpeg'
    readSourceBase64 = options.deps.readSourceBase64
  } else {
    const imported = await import('expo-image-manipulator')
    ImageManipulator = imported.ImageManipulator as unknown as ManipulatorLike
    saveFormat = imported.SaveFormat as unknown as { JPEG?: string; PNG?: string }
    readSourceBase64 = undefined
  }

  let attempts = 0

  /** 渲染一档并返回结果（统一的错误翻译）。 */
  const renderStep = async (
    step: EncodeStep,
    plan: SavePlan,
  ): Promise<{ base64: string; byteLength: number; width: number | null; height: number | null; uri: string }> => {
    attempts += 1
    try {
      const context = ImageManipulator.manipulate(uri)
      const rendered = plan.resize
        ? await context.resize({ width: plan.resize.width, height: plan.resize.height }).renderAsync()
        : await context.renderAsync()
      // `format` 必须是标量：`SaveFormat` 是对象，取值而不是把对象传下去。
      const saved = await rendered.saveAsync({
        format: selectSaveFormatValue(saveFormat, plan.format),
        compress: plan.compress,
        base64: true,
      })
      const base64 = stripDataUriPrefix(saved.base64 ?? '')
      return {
        base64,
        byteLength: base64ByteLength(base64),
        width: positivePixels(saved.width) ?? plan.resize?.width ?? null,
        height: positivePixels(saved.height) ?? plan.resize?.height ?? null,
        uri: saved.uri,
      }
    } catch (cause) {
      throw new OcrClientError(
        'BAD_REQUEST',
        `这台手机没能处理这张图片（可能是格式或存储问题）：${cause instanceof Error ? cause.message : String(cause)}`,
        { retryable: true, detail: cause instanceof Error ? cause.message : String(cause) },
      )
    }
  }

  // ---------- 第 0 步：尺寸未知时先渲染一次拿尺寸（不缩放） ----------
  if (sourceWidth === null || sourceHeight === null) {
    const probePlan: SavePlan = { format: 'png', compress: 1, resize: null }
    const probe = await renderStep({ format: 'png', quality: 1, scale: 1 }, probePlan)
    sourceWidth = sourceWidth ?? probe.width
    sourceHeight = sourceHeight ?? probe.height
    if (withinEncodeLimits(probe.width, probe.height, maxSide, maxPixels) && probe.byteLength <= maxBytes && probe.base64) {
      return {
        uri: probe.uri,
        base64: probe.base64,
        byteLength: probe.byteLength,
        mimeType: 'image/png',
        width: probe.width,
        height: probe.height,
        sourceWidth,
        sourceHeight,
        resized: false,
        scale: 1,
        quality: 1,
        format: 'png',
        preservedSource: false,
        attempts,
      }
    }
  }

  // ---------- 第 1 步：原样直传（原图已经是 PNG/JPEG 且在各项上限内） ----------
  if (readSourceBase64) {
    try {
      const raw = stripDataUriPrefix(await readSourceBase64(uri))
      const rawBytes = base64ByteLength(raw)
      const format = sniffBase64Format(raw)
      if (
        format &&
        rawBytes > 0 &&
        rawBytes <= maxBytes &&
        withinEncodeLimits(sourceWidth, sourceHeight, maxSide, maxPixels)
      ) {
        return {
          uri,
          base64: raw,
          byteLength: rawBytes,
          mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
          width: sourceWidth,
          height: sourceHeight,
          sourceWidth,
          sourceHeight,
          resized: false,
          scale: 1,
          quality: 1,
          format,
          preservedSource: true,
          attempts,
        }
      }
    } catch {
      // 读原图失败不是致命错误：继续走「渲染 + 编码」这条正常路径。
    }
  }

  // ---------- 第 2 步起：按编码阶梯逐档尝试 ----------
  let lastByteLength = 0
  for (const step of buildEncodeLadder(SCALE_STEPS)) {
    const plan = selectSavePlan(step, sourceWidth, sourceHeight, maxSide, maxPixels)
    const result = await renderStep(step, plan)
    lastByteLength = result.byteLength
    // 直接量**真正要发出去的字节**：元数据可能不可靠，而单边/像素是服务端硬上限。
    const measured = readEncodedSize(result.base64)
    const effectiveWidth = measured?.width ?? result.width
    const effectiveHeight = measured?.height ?? result.height
    if (!withinEncodeLimits(effectiveWidth, effectiveHeight, maxSide, maxPixels)) continue
    if (result.base64 && result.byteLength <= maxBytes) {
      return {
        uri: result.uri,
        base64: result.base64,
        byteLength: result.byteLength,
        mimeType: plan.format === 'png' ? 'image/png' : 'image/jpeg',
        width: effectiveWidth,
        height: effectiveHeight,
        sourceWidth,
        sourceHeight,
        resized: plan.resize !== null,
        scale: plan.resize !== null ? step.scale : 1,
        quality: plan.compress,
        format: plan.format,
        preservedSource: false,
        attempts,
      }
    }
  }

  throw new OcrClientError(
    'IMAGE_TOO_LARGE',
    `压缩到最后一档后仍有 ${(lastByteLength / 1024 / 1024).toFixed(1)}MB，超过上传上限。请只截取课表那一块再试。`,
    { retryable: false },
  )
}

/** 把底层的文件/权限异常翻译成可读的 OCR 错误。 */
export function toPhotoError(cause: unknown, fallbackMessage: string): OcrClientError {
  if (cause instanceof OcrClientError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return new OcrClientError('BAD_REQUEST', `${fallbackMessage}（${message}）`, { retryable: true, detail: message })
}
