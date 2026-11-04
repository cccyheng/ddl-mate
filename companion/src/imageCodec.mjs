/**
 * 图片解码 / 灰度 PNG 编码（伴侣服务内部使用）。
 *
 * 只支持 **PNG 与 JPEG**，其余格式（含 HEIC）由手机端先用 Expo 的
 * `expo-image-manipulator` 转成 JPEG 再上传 —— 服务端不引入额外解码器，
 * 也不接受「任意格式猜一猜」。
 *
 * 所有上限都在这里硬性检查，避免一张超大图把内存吃光：
 * - 字节数（HTTP 层与这里各查一次）；
 * - 像素数（宽×高）；
 * - 单边长度。
 */

import { deflateSync } from 'node:zlib'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

export class ImageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ImageError'
    this.code = code
  }
}

export const IMAGE_LIMITS = {
  /** 单个请求体上限（字节）。手机端会先压缩，正常课表截图在 0.3–3MB。 */
  maxBytes: 12 * 1024 * 1024,
  /** 像素总数上限（约 2600 万像素，覆盖 iPhone 原图而不至于 OOM）。 */
  maxPixels: 26_000_000,
  /** 单边上限。 */
  maxSide: 10_000,
}

/** 识别文件头，返回 `'png' | 'jpeg' | null`。只看魔数，不信任扩展名或 MIME。 */
export function sniffImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) {
    return 'jpeg'
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg'
  return null
}

function assertWithinLimits(format, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ImageError('BAD_IMAGE', '图片尺寸无法识别，请换一张截图重试。')
  }
  if (width > IMAGE_LIMITS.maxSide || height > IMAGE_LIMITS.maxSide) {
    throw new ImageError(
      'IMAGE_TOO_LARGE',
      `图片单边最长 ${IMAGE_LIMITS.maxSide} 像素（当前 ${width}×${height}），请裁剪或缩小后再试。`,
    )
  }
  if (width * height > IMAGE_LIMITS.maxPixels) {
    throw new ImageError(
      'IMAGE_TOO_LARGE',
      `图片像素总数超过上限（当前 ${width}×${height} = ${width * height} 像素），请缩小后再试。`,
    )
  }
  if (format !== 'png' && format !== 'jpeg') {
    throw new ImageError('UNSUPPORTED_FORMAT', '只支持 PNG 或 JPEG 图片，请先转换成 JPEG 再试。')
  }
}

/**
 * 只读 PNG 的 IHDR 拿尺寸（**不解码像素**）。
 *
 * 复核对的关键点：`PNG.sync.read()` 会按头部尺寸**先分配**整块缓冲，
 * 所以「先解码再检查尺寸」对一张声明 50000×50000 的 PNG 等于先申请 10GB。
 * 必须在解码前就从头部拿到尺寸并拒绝。
 */
function readPngSize(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (buffer.length < 33) throw new ImageError('BAD_IMAGE', 'PNG 数据不完整。')
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) throw new ImageError('UNSUPPORTED_FORMAT', '这不是有效的 PNG 图片。')
  }
  // 第一个 chunk 必须是 IHDR：长度(4) + 'IHDR'(4) + width(4) + height(4)
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageError('BAD_IMAGE', 'PNG 头部不是 IHDR，图片可能已损坏。')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * 只读 JPEG 的 SOF 段拿尺寸（**不解码像素**）。
 *
 * 照 JPEG 的段结构逐段跳过，遇到 SOF0–SOF15（除 DHT/DAC 等非 SOF 标记）即取尺寸。
 */
function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new ImageError('UNSUPPORTED_FORMAT', '这不是有效的 JPEG 图片。')
  }
  const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // 无参数标记段
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) throw new ImageError('BAD_IMAGE', 'JPEG 段长度非法，图片可能已损坏。')
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 >= buffer.length) throw new ImageError('BAD_IMAGE', 'JPEG 数据不完整。')
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (marker === 0xda) break // 进入压缩数据，后面没有 SOF 了
    offset += 2 + length
  }
  throw new ImageError('BAD_IMAGE', 'JPEG 里找不到尺寸信息，图片可能已损坏。')
}

/**
 * 把 PNG / JPEG 字节解码成 RGBA（`{ data, width, height }`）。
 *
 * 顺序很关键：**先只读头部拿尺寸并校验上限，再解码像素**。
 * 格式不符、超出上限、数据损坏都会抛 `ImageError`（带机器可读的 `code`）。
 */
export function decodeImage(buffer) {
  const format = sniffImageFormat(buffer)
  if (!format) {
    throw new ImageError('UNSUPPORTED_FORMAT', '这不是 PNG 或 JPEG 图片（可能是不支持的格式，例如 HEIC）。')
  }

  if (format === 'png') {
    const size = readPngSize(buffer)
    assertWithinLimits('png', size.width, size.height)
    let png
    try {
      png = PNG.sync.read(buffer)
    } catch (cause) {
      throw new ImageError('BAD_IMAGE', `PNG 解码失败：${cause instanceof Error ? cause.message : String(cause)}`)
    }
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height, format }
  }

  const size = readJpegSize(buffer)
  assertWithinLimits('jpeg', size.width, size.height)
  let info
  try {
    info = jpeg.decode(buffer, { formatAsRGBA: false, useTArray: true, tolerantDecoding: false })
  } catch (cause) {
    throw new ImageError('BAD_IMAGE', `JPEG 解码失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
  // jpeg-js 在 formatAsRGBA:false 时给出 RGB 三通道，这里统一补成 RGBA。
  const pixels = info.width * info.height
  const rgba = new Uint8ClampedArray(pixels * 4)
  const source = info.data
  for (let i = 0; i < pixels; i += 1) {
    rgba[i * 4] = source[i * 3]
    rgba[i * 4 + 1] = source[i * 3 + 1]
    rgba[i * 4 + 2] = source[i * 3 + 2]
    rgba[i * 4 + 3] = 255
  }
  return { data: rgba, width: info.width, height: info.height, format }
}

/* ------------------------------ 最小灰度 PNG 编码器 ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** 灰度缓冲（每像素 1 字节）→ 灰度 PNG 字节。 */
export function encodeGrayPng(gray, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ImageError('BAD_IMAGE', '无法编码空图片。')
  }
  if (gray.length < width * height) {
    throw new ImageError('BAD_IMAGE', '灰度缓冲长度与尺寸不匹配。')
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  const raw = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0
    Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
