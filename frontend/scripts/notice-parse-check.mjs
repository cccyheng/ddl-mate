/**
 * 用真实 OCR 输出检查解析器（不联网、不替换识别文字）。
 *
 *   node frontend/scripts/notice-parse-check.mjs [probe.json]
 *
 * 默认读取 .supervision/notice-ocr-probe.json（由验收方用真实 Tesseract 识别 8 张合成样图产生），
 * 逐张打印：规范化后的原文、解析出的候选（标题 / 截止时间 / 类型 / 提示）。
 * 输出同时写入 .supervision/notice-parse-check.json，便于复核。
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeOcrText, parseNoticeText } from '../src/ocr/noticeParser.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const workspace = path.join(here, '..', '..')
const probePath = process.argv[2] ?? path.join(workspace, '.supervision', 'notice-ocr-probe.json')
const courses = [
  { id: 1, name: '数据结构', code: 'CS201' },
  { id: 2, name: '大学物理', code: 'PH101' },
  { id: 3, name: '大学英语', code: 'EN101' },
  { id: 4, name: '高等数学', code: 'MA101' },
  { id: 5, name: '软件工程', code: 'SE301' },
]

const probe = JSON.parse(await readFile(probePath, 'utf8'))
const report = []
for (const item of probe) {
  const normalized = normalizeOcrText(item.text)
  const candidates = parseNoticeText(normalized, { courses, sourceRef: 'src-1', sourceName: item.file })
  report.push({
    file: item.file,
    confidence: item.confidence,
    normalized,
    candidates: candidates.map((candidate) => ({
      title: candidate.title,
      deadline: candidate.deadline,
      type: candidate.type,
      courseId: candidate.courseId,
      submitMethod: candidate.submitMethod,
      hints: candidate.hints,
      deadlineOptions: candidate.deadlineOptions,
      rawText: candidate.rawText,
    })),
  })
  console.log(`\n===== ${item.file}（置信度 ${item.confidence}）=====`)
  console.log('--- 规范化原文 ---')
  console.log(normalized)
  console.log('--- 候选 ---')
  for (const candidate of candidates) {
    console.log(
      `  · ${candidate.title || '(无标题)'} | DDL=${candidate.deadline || '(留空)'} | ${candidate.type} | 课程=${candidate.courseId ?? '未关联'}`,
    )
    for (const hint of candidate.hints) console.log(`      ⚠ ${hint}`)
  }
}

const outPath = path.join(workspace, '.supervision', 'notice-parse-check.json')
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`\n已写入 ${outPath}`)
