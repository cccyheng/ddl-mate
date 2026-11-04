/**
 * 真实引擎的样图路径测试（不是 mock OCR）。
 *
 * 复核对抓到的 bug：回退分支把 RGBA（每像素 4 字节）直接当成灰度传给了 `recognizeGray`，
 * 于是 Tesseract 拿到的是一张错位的图，基本什么都读不出来。
 *
 * 现在路由分成两条：
 * - `timetable-grid.png` 是**有线框表格**，由新的表格流水线接管（见下方"路由变更"说明），
 *   断言改为"确实读出了课程，而且名称/星期/时刻/周次全对"；
 * - `timetable-list.png` 不是任何表格版式，仍然走**整图回退**：
 *   断言 `diagnostics.fallback === true`、灰度尺寸等于 RGBA 尺寸、并且真的读出了候选。
 *
 * 路由变更说明（Supervisor 2026-10-12 已确认）：以前"表格样例必须走整图回退"这条断言
 * 只是当时的分支标签；有了通用的有线框表格识别后，让表格图走更准的那条流水线才是正确行为，
 * 因此这里把该断言的强度从"必须 fallback"改为"必须有正确课程"，并把
 * "RGBA→灰度"的证明留在列表样例上（那条路径才是整图回退本身）。
 *
 * 用法（需要真实 Tesseract，耗时约 1–3 分钟）：
 *   node --test --experimental-test-isolation=none tests/fallbackEngine.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeImage } from '../src/imageCodec.mjs'
import { OcrEngine } from '../src/ocrEngine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
const SAMPLES = join(workspaceRoot, 'frontend', 'public', 'samples')

test('有线框表格样例：走表格流水线，课程名称/星期/时刻都读对', { timeout: 300_000 }, async () => {
  const engine = new OcrEngine()
  try {
    const image = decodeImage(readFileSync(join(SAMPLES, 'timetable-grid.png')))
    const result = await engine.recognizeTimetable(image, { isCancelled: () => false })

    assert.equal(result.cancelled, false)
    assert.equal(result.layout, 'table-grid', `样例是有线框表格，实际走了 ${result.layout}`)
    assert.equal(result.candidates.length, 3, JSON.stringify(result.candidates.map((c) => c.name)))

    const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]))
    const math = byName.get('高等数学')
    assert.ok(math, `应识别出「高等数学」，实际 ${JSON.stringify([...byName.keys()])}`)
    assert.deepEqual(
      [math.weekday, math.startTime, math.endTime, math.startWeek, math.endWeek, math.weekPattern],
      [1, '08:00', '09:40', 1, 16, 'ODD'],
    )
    assert.ok(String(math.location).includes('教一101'), `地点实际 ${math.location}`)

    const structure = byName.get('数据结构')
    assert.ok(structure, '应识别出「数据结构」')
    assert.deepEqual(
      [structure.weekday, structure.startTime, structure.startWeek, structure.endWeek, structure.weekPattern],
      [2, '08:00', 1, 16, 'EVEN'],
    )

    const english = byName.get('大学英语')
    assert.ok(english, '应识别出「大学英语」')
    assert.deepEqual([english.weekday, english.startTime, english.startWeek, english.endWeek], [3, '14:00', 1, 16])
  } finally {
    await engine.terminate()
  }
})

test('列表样例：仍然走整图回退，RGBA 必须转灰度，并且真能读出候选', { timeout: 300_000 }, async () => {
  const engine = new OcrEngine()
  try {
    const image = decodeImage(readFileSync(join(SAMPLES, 'timetable-list.png')))
    const result = await engine.recognizeTimetable(image, { isCancelled: () => false })

    assert.equal(result.cancelled, false, 'timetable-list.png 不应被取消')
    assert.equal(result.diagnostics?.fallback, true, '列表样例应该走整图回退分支')
    assert.equal(
      result.diagnostics?.graySize,
      `${image.width}x${image.height}`,
      '灰度尺寸必须与解码后的 RGBA 尺寸一致（说明做过 RGBA→灰度转换，而不是把 4 字节/像素当灰度）',
    )
    assert.ok(
      result.candidates.length > 0,
      `回退路径必须至少读出一行候选，实际 ${result.candidates.length} 条；提示：${(result.warnings ?? []).join(' / ')}`,
    )
    const names = result.candidates.map((candidate) => candidate.name)
    assert.ok(names.includes('高等数学'), `应读出「高等数学」，实际 ${JSON.stringify(names)}`)
  } finally {
    await engine.terminate()
  }
})
