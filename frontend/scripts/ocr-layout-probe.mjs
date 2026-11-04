// 版式分析离线探针：对着一张"原始 RGBA 像素 + 尺寸"的转储跑 weekGridLayout 的纯几何部分，
// 打印卡片块、列、以及每块卡片的像素范围。
//
// 用途：
//   - 在没有浏览器/OCR 的环境里验证几何算法（例如本机 Playwright 被沙箱拦下时）；
//   - 出问题时快速看清"哪一列/哪一块被漏掉或并错"。
//
// 生成像素转储（pwsh + System.Drawing，本地解码，不上传任何地方）：
//   $bmp = New-Object System.Drawing.Bitmap <jpg>; LockBits → RGBA → real.rgba + real.json
//
// 用法：node scripts/ocr-layout-probe.mjs ..\..\.tools\photo\real.rgba ..\..\.tools\photo\real.json
import { readFileSync } from 'node:fs'

import {
  buildCardMask,
  detectCardColor,
  findComponents,
  groupColumns,
} from '../src/ocr/weekGridLayout.js'

const [, , dataPath, metaPath] = process.argv
if (!dataPath || !metaPath) {
  console.error('用法：node scripts/ocr-layout-probe.mjs <real.rgba> <real.json>')
  process.exit(1)
}
const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
const raw = readFileSync(dataPath)
const data = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength)
const { width, height } = meta

const started = Date.now()
const colors = detectCardColor(data, width, height)
const mask = buildCardMask(data, width, height, colors.card, colors.background)
const components = findComponents(mask, width, height)
const columns = groupColumns(components)
const elapsed = Date.now() - started

console.log(`尺寸 ${width}x${height}，采样 ${colors.sampled} 点，耗时 ${elapsed} ms`)
console.log(
  `背景 rgb(${colors.background.r.toFixed(0)},${colors.background.g.toFixed(0)},${colors.background.b.toFixed(0)}) ` +
    `→ 卡片 rgb(${colors.card?.r.toFixed(0)},${colors.card?.g.toFixed(0)},${colors.card?.b.toFixed(0)})`,
)
console.log(`卡片连通块 ${components.length} 个，聚成 ${columns.length} 列`)
columns.forEach((column, index) => {
  const spans = column.items
    .map((item) => `${item.y0}-${item.y1}`)
    .join(' ')
  console.log(
    `  列 ${index + 1}: x=[${column.x0},${column.x1}] cx=${Math.round(column.cx)} 卡片 ${column.items.length} 块  y: ${spans}`,
  )
})
const untouched = components.filter((component) => !columns.some((column) => column.items.includes(component)))
if (untouched.length) {
  console.log(`未归入任何列的连通块 ${untouched.length} 个（多为状态栏/图标等噪声）：`)
  untouched.slice(0, 10).forEach((item) => {
    console.log(`  x=[${item.x0},${item.x1}] y=[${item.y0},${item.y1}] 面积 ${item.area}`)
  })
}
