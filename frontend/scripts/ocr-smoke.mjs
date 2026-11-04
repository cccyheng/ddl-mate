// 真实 OCR 冒烟脚本（Node 环境，使用自托管的 worker/core/语言模型，不联网）。
//
// 用途：用 Codex 生成的样例课表图跑一次**真实**中文 OCR，并：
//   1. 保存原始识别结果（blocks/lines，作为证据）；
//   2. 用同一个解析器（src/ocr/timetableParser.js）解析出候选课表并打印。
//
// 用法：
//   node scripts/ocr-smoke.mjs                      # 默认跑 public/samples 下两张样例图
//   node scripts/ocr-smoke.mjs <图片路径> [输出目录]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createWorker } from 'tesseract.js'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flattenOcrLines, parseTimetable } from '../src/ocr/timetableParser.js'
import { TESSERACT_PARAMS } from '../src/ocr/ocrConfig.js'

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(frontendDir, 'public', 'tesseract')
const defaultImages = [
  join(frontendDir, 'public', 'samples', 'timetable-grid.png'),
  join(frontendDir, 'public', 'samples', 'timetable-list.png'),
]

const args = process.argv.slice(2)
const images = args.filter((arg) => !arg.endsWith('/') && (arg.endsWith('.png') || arg.endsWith('.jpg') || arg.endsWith('.jpeg') || arg.endsWith('.webp')))
const outDir = resolve(args.find((arg) => !images.includes(arg)) || join(frontendDir, '..', '.supervision'))
const targets = images.length ? images : defaultImages

for (const file of [join(assetsDir, 'worker.min.js'), join(assetsDir, 'core'), join(assetsDir, 'lang')]) {
  if (!existsSync(file)) {
    console.error(`[ocr-smoke] 缺少 OCR 资源：${file}\n请先执行：node scripts/prepare-ocr-assets.mjs`)
    process.exit(1)
  }
}
mkdirSync(outDir, { recursive: true })

console.log(`[ocr-smoke] assets: ${assetsDir}`)
console.log(`[ocr-smoke] 输出目录: ${outDir}`)

// 注意 Node 与浏览器的差异：
//   - 浏览器（应用里）用 public/tesseract 下的 worker.min.js + core + lang，全部同源；
//   - Node（本脚本）不能用浏览器版 worker.min.js，因此不传 workerPath/corePath，
//     让 tesseract.js 使用它自带的 Node worker 与 node_modules 里的 core，
//     只把 langPath 指向我们本地准备的语言模型，保证离线、可复现。
const worker = await createWorker('chi_sim+eng', 1, {
  langPath: join(assetsDir, 'lang'),
  cacheMethod: 'none',
  logger: (message) => {
    if (message.status === 'recognizing text' && typeof message.progress === 'number') {
      process.stdout.write(`\r[ocr-smoke] 识别中 ${(message.progress * 100).toFixed(0)}%   `)
    }
  },
})

// 与浏览器端一致：稀疏文本模式（表格/课表照片），参数来自 src/ocr/ocrConfig.js
await worker.setParameters(process.env.OCR_PSM
  ? { ...TESSERACT_PARAMS, tessedit_pageseg_mode: process.env.OCR_PSM }
  : TESSERACT_PARAMS)

let failed = 0
for (const image of targets) {
  if (!existsSync(image)) {
    console.error(`\n[ocr-smoke] 找不到图片：${image}`)
    failed += 1
    continue
  }
  const name = image.split(/[\\/]/).pop().replace(/\.[a-z]+$/i, '')
  const started = Date.now()
  const { data } = await worker.recognize(image, {}, { blocks: true, text: true })
  const elapsed = Date.now() - started
  process.stdout.write('\r')

  const lines = flattenOcrLines(data)
  const parsed = parseTimetable(lines)

  const evidencePath = join(outDir, `ocr-real-${name}.json`)
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        image,
        text: data.text,
        confidence: data.confidence,
        blocks: (data.blocks || []).map((block) => ({
          bbox: block.bbox,
          text: block.text,
          paragraphs: (block.paragraphs || []).map((paragraph) => ({
            bbox: paragraph.bbox,
            lines: (paragraph.lines || []).map((line) => ({
              bbox: line.bbox,
              text: line.text,
              confidence: line.confidence,
              words: (line.words || []).map((word) => ({ bbox: word.bbox, text: word.text, confidence: word.confidence })),
            })),
          })),
        })),
        parsed: {
          layout: parsed.layout,
          semesterStartDate: parsed.semesterStartDate,
          warnings: parsed.warnings,
          candidates: parsed.candidates,
          orphans: parsed.orphans,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`\n=== ${name}（${elapsed} ms，平均置信度 ${data.confidence ?? 'n/a'}）===`)
  console.log(`原始文本：\n${(data.text || '').trim().split('\n').slice(0, 12).join('\n')}`)
  console.log(`解析布局：${parsed.layout}，学期起点：${parsed.semesterStartDate || '未识别'}`)
  console.log(`候选课表 ${parsed.candidates.length} 条：`)
  for (const candidate of parsed.candidates) {
    console.log(
      `  - ${candidate.name} | ${candidate.weekday ? `周${'一二三四五六日'[candidate.weekday - 1]}` : '星期?'} | ` +
        `${candidate.startTime || '??:??'}-${candidate.endTime || '??:??'} | ${candidate.location || '地点?'} | ` +
        `${candidate.startWeek ? `第${candidate.startWeek}-${candidate.endWeek}周` : '周次?'} | ${candidate.weekPattern || 'ALL'}` +
        (candidate.warnings?.length ? ` | 提示: ${candidate.warnings.join('；')}` : ''),
    )
  }
  if (parsed.warnings.length) console.log(`解析提示：${parsed.warnings.join('；')}`)
  console.log(`原始结果已保存：${evidencePath}`)
}

await worker.terminate()
console.log(`\n[ocr-smoke] 完成，失败 ${failed} 张`)
process.exit(failed ? 1 : 0)
