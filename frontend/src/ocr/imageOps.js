/**
 * 与运行环境无关的图像基础操作（纯函数，输入输出都是 {data,width,height} 形式的像素缓冲）。
 *
 * 这些函数同时被浏览器（canvas + ImageData）和 Node 离线校验脚本使用，
 * 因此不依赖 document / canvas，只处理 Uint8ClampedArray。
 */

/** 取一个区域并转灰度（Rec.601），返回 { gray, width, height }。 */
export function toGray(data, width, height, region) {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0))
  const y0 = Math.max(0, Math.floor(region?.y ?? 0))
  const x1 = Math.min(width, Math.ceil(region ? x0 + region.width : width))
  const y1 = Math.min(height, Math.ceil(region ? y0 + region.height : height))
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const gray = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y += 1) {
    const srcRow = (y0 + y) * width
    for (let x = 0; x < w; x += 1) {
      const index = (srcRow + x0 + x) * 4
      gray[y * w + x] = (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000
    }
  }
  return { gray, width: w, height: h, x0, y0 }
}

/** Otsu 阈值（0-255）。 */
export function otsuThreshold(gray) {
  const histogram = new Array(256).fill(0)
  for (let i = 0; i < gray.length; i += 1) histogram[gray[i]] += 1
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i]
  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let bestVariance = -1
  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue
    const weightForeground = total - weightBackground
    if (weightForeground === 0) break
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      best = t
    }
  }
  return best
}

/**
 * 把区域二值化成"黑字白底"，用于喂给 OCR：
 * 先用 Otsu 分成两类，像素更多的那一类视为背景 → 输出白色；另一类（笔画）→ 黑色。
 * 这样深色卡片上的浅色字 与 浅色背景上的深色字 都能得到同样的输入。
 */
export function binarizeForText(gray) {
  const threshold = otsuThreshold(gray)
  const out = new Uint8ClampedArray(gray.length)
  let dark = 0
  for (let i = 0; i < gray.length; i += 1) {
    if (gray[i] <= threshold) dark += 1
  }
  const darkIsBackground = dark * 2 > gray.length
  for (let i = 0; i < gray.length; i += 1) {
    const isDark = gray[i] <= threshold
    // 背景 → 255（白）；笔画 → 0（黑）
    out[i] = isDark === darkIsBackground ? 255 : 0
  }
  return out
}

/** 均匀底色卡片：拉伸灰度而不二值化，保留括号、小字的抗锯齿笔画。 */
export function contrastForText(gray) {
  const histogram = new Uint32Array(256)
  for (const value of gray) histogram[value]++
  let background = 0
  for (let i = 1; i < 256; i++) if (histogram[i] > histogram[background]) background = i
  const threshold = otsuThreshold(gray)
  let dark = 0
  for (let i = 0; i <= threshold; i++) dark += histogram[i]
  const brighter = dark > gray.length / 2
  let sum = 0, count = 0
  for (let i = 0; i < 256; i++) {
    if (brighter ? i > threshold : i <= threshold) { sum += i * histogram[i]; count += histogram[i] }
  }
  const foreground = count ? sum / count : background
  const span = foreground - background
  if (Math.abs(span) < 5) return new Uint8ClampedArray(gray.length).fill(255)
  return Uint8ClampedArray.from(gray, value => Math.max(0, Math.min(255, 255 * (1 - (value - background) / span))))
}

/**
 * 灰度图按整数倍放大（小字号时能让 Tesseract 更稳）。
 *
 * `mode: 'bilinear'`（默认）做双线性插值；`mode: 'nearest'` 保留旧的最近邻行为。
 * 为什么默认改成双线性：独立只读质量探针（`.supervision/dense-quality-report.md`）
 * 在密集小字原图上实测，最近邻放大把笔画拉成方块、相邻字符粘连
 *（`电航楼`→`电航衬`、`模电实验室`→`樟电详验室`），双线性在同一批格子上明显更准。
 * 对"本来就读得好"的图，双线性只会让读数更平滑，不会改变字段结构。
 */
export function scaleGray(gray, width, height, factor, options = {}) {
  const scale = Math.max(1, Math.round(factor))
  if (scale === 1) return { gray, width, height }
  const w = width * scale
  const h = height * scale
  const out = new Uint8ClampedArray(w * h)
  if (options.mode === 'nearest') {
    for (let y = 0; y < h; y += 1) {
      const srcRow = (y / scale) | 0
      for (let x = 0; x < w; x += 1) {
        out[y * w + x] = gray[srcRow * width + ((x / scale) | 0)]
      }
    }
    return { gray: out, width: w, height: h }
  }
  // 双线性：把目标像素中心映射回源图，按四个邻居加权。
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(height - 1, y0 + 1)
    const wy = sy - y0
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(width - 1, x0 + 1)
      const wx = sx - x0
      const top = gray[y0 * width + x0] * (1 - wx) + gray[y0 * width + x1] * wx
      const bottom = gray[y1 * width + x0] * (1 - wx) + gray[y1 * width + x1] * wx
      out[y * w + x] = top * (1 - wy) + bottom * wy
    }
  }
  return { gray: out, width: w, height: h }
}

/**
 * 自适应二值化（局部均值 + 偏移），输出"黑字白底"。
 * 比全局 Otsu 更适合照片：细笔画（括号、标点）只要比局部背景亮/暗一点点就能保住。
 * 极性（字比底亮还是暗）由全局 Otsu 的两类占比推断，深色卡片与浅色背景都适用。
 */
export function adaptiveBinarize(gray, width, height, options = {}) {
  const radius = Math.max(2, options.radius ?? (Math.round(Math.min(width, height) / 12) || 6))
  const offset = options.offset ?? 10
  const threshold = otsuThreshold(gray)
  let dark = 0
  for (let i = 0; i < gray.length; i += 1) if (gray[i] <= threshold) dark += 1
  const textIsBrighter = dark * 2 > gray.length

  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x]
      integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum
    }
  }
  const out = new Uint8ClampedArray(gray.length)
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
      const mean = sum / area
      const value = gray[y * width + x]
      const isText = textIsBrighter ? value > mean + offset : value < mean - offset
      out[y * width + x] = isText ? 0 : 255
    }
  }
  return out
}

/**
 * 按"墨迹行"把二值图切成若干文本行（行投影 + 小间隙合并）。
 * 卡片是窄条、文字逐行折行，逐行喂给 OCR（PSM 7）通常比整块识别更稳。
 * 返回 [{ y0, y1 }]，坐标基于传入的灰度图。
 */
export function splitGrayLines(gray, width, height, options = {}) {
  const minInk = options.minInk ?? Math.max(1, Math.round(width * 0.02))
  const gap = options.gap ?? Math.max(2, Math.round(height * 0.004))
  const rows = new Array(height).fill(0)
  for (let y = 0; y < height; y += 1) {
    let ink = 0
    for (let x = 0; x < width; x += 1) {
      if (gray[y * width + x] < 128) ink += 1
    }
    rows[y] = ink
  }
  const bands = []
  let start = -1
  let lastInk = -1
  for (let y = 0; y < height; y += 1) {
    if (rows[y] >= minInk) {
      if (start < 0) start = y
      lastInk = y
    } else if (start >= 0 && y - lastInk > gap) {
      bands.push({ y0: start, y1: lastInk })
      start = -1
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: lastInk })
  return bands.filter((band) => band.y1 - band.y0 >= 2)
}

/** 从灰度图里裁出一条水平带（用于逐行 OCR）。 */
export function cropGrayRows(gray, width, height, y0, y1) {
  const top = Math.max(0, y0)
  const bottom = Math.min(height, y1)
  const h = Math.max(1, bottom - top)
  return { gray: gray.slice(top * width, (top + h) * width), width, height: h }
}

/** 灰度图四周补白边（Tesseract 对贴边文字识别较差）。 */
export function padGray(gray, width, height, pad, value = 255) {
  const w = width + pad * 2
  const h = height + pad * 2
  const out = new Uint8ClampedArray(w * h).fill(value)
  for (let y = 0; y < height; y += 1) {
    out.set(gray.subarray(y * width, y * width + width), (y + pad) * w + pad)
  }
  return { gray: out, width: w, height: h }
}

/** 一维中值/均值混合平滑，去掉 JPEG 噪点让 Otsu 更稳（可选）。 */
export function smoothGray(gray, width, height) {
  const out = new Uint8ClampedArray(gray.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          sum += gray[yy * width + xx]
          count += 1
        }
      }
      out[y * width + x] = sum / count
    }
  }
  return out
}

/** 把灰度缓冲包成 ImageData 形状（浏览器端可直接 putImageData）。 */
export function grayToImageData(gray, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < gray.length; i += 1) {
    const value = gray[i]
    data[i * 4] = value
    data[i * 4 + 1] = value
    data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

/**
 * 生成"黑字白底"的 OCR 输入：灰度 → 放大 → （可选）平滑 → 二值化 → 补边。
 * 默认先放大再自适应二值化（细笔画更容易保住）；mode:'otsu' 可退回全局阈值。
 *
 * `smooth: true` 会在二值化前做一次 3×3 均值平滑。为什么需要它：`scaleGray` 是最近邻放大，
 * 笔画会被拉成方块、相邻字符容易粘在一起（真机上 "(1-16" 被读成 "4-16" 就是这么来的）；
 * 平滑把方块边缘重新变成抗锯齿的过渡，实测同一批格子的读数明显更准。
 * 默认关闭，保持既有调用方行为不变。
 *
 * 返回 { gray, width, height, scale }。
 */
export function prepareCardImage(data, width, height, region, options = {}) {
  const { pad = 12, maxScale = 2.5, mode = 'adaptive', smooth = false, scaleMode = 'bilinear' } = options
  const crop = toGray(data, width, height, region)
  // 彩色背景中的细字另取蓝通道作独立读数；不改变默认预处理。
  if (options.channel === 'blue') {
    for (let y = 0; y < crop.height; y++) for (let x = 0; x < crop.width; x++) {
      crop.gray[y * crop.width + x] = data[((crop.y0 + y) * width + crop.x0 + x) * 4 + 2]
    }
    const counts = new Uint32Array(256)
    for (const v of crop.gray) counts[v]++
    let bg = 0
    for (let v = 1; v < 256; v++) if (counts[v] > counts[bg]) bg = v
    if (bg > 0) crop.gray = Uint8ClampedArray.from(crop.gray, v => Math.min(255, 255 * v / bg))
  }
  const desired = options.targetHeight
    ? options.targetHeight / Math.max(1, crop.height)
    : 1100 / Math.max(1, crop.height)
  // 必须是整数倍：scaleGray 内部会取整，这里先取整再返回，保证"报告的倍数"与"实际倍数"一致。
  // 否则调用方按报告的倍数反算坐标会整体偏移（列/行随之错位）。
  const factor = Math.max(1, Math.min(Math.round(maxScale), Math.round(desired)))
  const scaled = scaleGray(crop.gray, crop.width, crop.height, factor, { mode: scaleMode })
  const base = smooth ? smoothGray(scaled.gray, scaled.width, scaled.height) : scaled.gray
  const binary =
    mode === 'linear'
      ? base
      : mode === 'contrast'
      ? contrastForText(base)
      : mode === 'otsu'
      ? binarizeForText(smooth ? base : smoothGray(base, scaled.width, scaled.height))
      : adaptiveBinarize(base, scaled.width, scaled.height, options)
  const padded = padGray(binary, scaled.width, scaled.height, pad)
  return { gray: padded.gray, width: padded.width, height: padded.height, scale: factor }
}
