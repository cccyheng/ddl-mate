/**
 * 真实图片的 HTTP 端到端验收：把 `.tools/photo/retained-original.png` 通过
 * **真实的 HTTP 请求**发给伴侣服务，报告识别结果，并与独立目视转录对照。
 *
 * 用法：
 *   node tests/realImageHttp.mjs                       # 自带服务，自动选端口
 *   node tests/realImageHttp.mjs --url http://127.0.0.1:8082   # 打已经在跑的服务
 *   node tests/realImageHttp.mjs --json report.json    # 同时把完整报告写文件
 *
 * 重要：对照用 `.supervision/user-photo-expected.json` **只用于报告命中率**，
 * 绝不参与识别（伴侣服务不知道这个文件的存在）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startServer } from '../src/server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const IMAGE_PATH = join(workspaceRoot, '.tools', 'photo', 'retained-original.png')
const EXPECTED_PATH = join(workspaceRoot, '.supervision', 'user-photo-expected.json')

const argv = process.argv.slice(2)
const urlIndex = argv.indexOf('--url')
const externalUrl = urlIndex >= 0 ? argv[urlIndex + 1] : null
const jsonIndex = argv.indexOf('--json')
const reportPath = jsonIndex >= 0 ? argv[jsonIndex + 1] : null

function normalize(value) {
  return String(value ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s()（）\-—–·、,，.。]/g, '')
    .toLowerCase()
}

async function main() {
  const started = Date.now()
  let handle = null
  let baseUrl = externalUrl
  if (!baseUrl) {
    handle = await startServer(['--port', '0'], { info() {}, warn() {}, error: console.error })
    const address = handle.server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  }

  const health = await fetch(`${baseUrl}/v1/health`).then((response) => response.json())
  console.log(`health: ok=${health.ok} service=${health.service} v${health.serviceVersion}`)

  const bytes = readFileSync(IMAGE_PATH)
  console.log(`image: ${IMAGE_PATH} (${(bytes.length / 1024 / 1024).toFixed(2)}MB)`)

  const response = await fetch(`${baseUrl}/v1/ocr/timetable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64: bytes.toString('base64') }),
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    console.error(`OCR 请求失败：HTTP ${response.status} ${payload.code ?? ''} ${payload.message ?? ''}`)
    if (handle) await handle.close()
    process.exitCode = 1
    return
  }

  console.log(
    `\nlayout=${payload.layout} week=${payload.week ?? '?'} candidates=${payload.candidates.length} ` +
      `ocrCalls=${payload.ocrCalls} ${payload.ms}ms (总 ${Date.now() - started}ms)`,
  )
  console.log(`diagnostics: ${JSON.stringify(payload.diagnostics)}`)
  if (payload.warnings?.length) {
    console.log(`服务端提示 ${payload.warnings.length} 条：`)
    for (const warning of payload.warnings.slice(0, 8)) console.log(`  · ${warning}`)
  }

  console.log('\n识别到的候选：')
  for (const candidate of payload.candidates) {
    console.log(
      `  周${candidate.weekday ?? '?'} 第${candidate.periodStart ?? '?'}-${candidate.periodEnd ?? '?'}节 ` +
        `${candidate.startTime ?? '??:??'}-${candidate.endTime ?? '??:??'} 起止周${candidate.startWeek ?? '?'}-${candidate.endWeek ?? '?'}(${candidate.weekPattern ?? '-'}) ` +
        `「${candidate.name ?? ''}」@「${candidate.location ?? ''}」${candidate.warnings?.length ? ` ⚠${candidate.warnings.length}` : ''}`,
    )
  }

  let expected = null
  try {
    expected = JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'))
  } catch {
    expected = null
  }

  if (expected) {
    const remaining = [...payload.candidates]
    let nameHits = 0
    let timeHits = 0
    let locationHits = 0
    const missing = []
    for (const item of expected.courses) {
      const index = remaining.findIndex(
        (candidate) =>
          candidate.weekday === item.weekday &&
          (candidate.periodStart === item.periodStart || normalize(candidate.name) === normalize(item.name)),
      )
      if (index < 0) {
        missing.push(`周${item.weekday} 第${item.periodStart}节「${item.name}」`)
        continue
      }
      const found = remaining.splice(index, 1)[0]
      nameHits += 1
      if (found.startTime === item.startTime && found.endTime === item.endTime) timeHits += 1
      if (normalize(found.location) === normalize(item.location)) locationHits += 1
    }
    const perWeekday = (list) =>
      [1, 2, 3, 4, 5, 6, 7].map((day) => list.filter((item) => item.weekday === day).length).join('/')
    const uniqueNames = new Set(payload.candidates.map((candidate) => normalize(candidate.name)).filter(Boolean)).size

    console.log(
      `\n对照独立目视转录（**仅用于报告，不参与识别**）：\n` +
        `  块数 ${payload.candidates.length} / 期望 ${expected.expectedBlockCount}` +
        `（按星期分布 ${perWeekday(payload.candidates)} vs 期望 ${perWeekday(expected.courses)}）\n` +
        `  唯一课程名 ${uniqueNames} / 期望 ${expected.expectedUniqueCourseCount}\n` +
        `  星期+节次命中 ${nameHits}/${expected.expectedBlockCount}，时刻命中 ${timeHits}，地点命中 ${locationHits}\n` +
        `  显示周次：${payload.week ?? '(未识别)'} / 期望第 ${expected.displayedWeek} 周`,
    )
    if (missing.length) {
      console.log('  未命中：')
      for (const item of missing) console.log(`    - ${item}`)
    }

    const report = {
      image: IMAGE_PATH,
      imageBytes: bytes.length,
      endpoint: `${baseUrl}/v1/ocr/timetable`,
      layout: payload.layout,
      week: payload.week,
      displayedWeekExpected: expected.displayedWeek,
      candidates: payload.candidates.length,
      expectedBlocks: expected.expectedBlockCount,
      uniqueCourseNames: uniqueNames,
      expectedUniqueCourses: expected.expectedUniqueCourseCount,
      slotHits: nameHits,
      timeHits,
      locationHits,
      missing,
      perWeekdayDetected: perWeekday(payload.candidates),
      perWeekdayExpected: perWeekday(expected.courses),
      warnings: payload.warnings,
      diagnostics: payload.diagnostics,
      ocrCalls: payload.ocrCalls,
      ms: payload.ms,
      rows: payload.candidates.map((candidate) => ({
        weekday: candidate.weekday,
        periodStart: candidate.periodStart,
        periodEnd: candidate.periodEnd,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
        name: candidate.name,
        location: candidate.location,
        startWeek: candidate.startWeek,
        weekPattern: candidate.weekPattern,
      })),
    }
    if (reportPath) {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      console.log(`\n报告已写入 ${reportPath}`)
    }
  }

  if (handle) await handle.close()
}

await main()
