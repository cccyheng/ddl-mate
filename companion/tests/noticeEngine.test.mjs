/**
 * `OcrEngine.recognizeNotice` 的纯编排测试（不跑 Tesseract）。
 *
 * 验证的是「通知接口」自己的语义：保留行顺序、空文字明确、PSM 6 → 3 的兜底、
 * 取消不返回成功，并且**不**套用课表的「只读到表头就报错」逻辑。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NOTICE_FALLBACK_PSM, NOTICE_PSM, OcrEngine, normalizeNoticeText } from '../src/ocrEngine.mjs'

function imageData() {
  return { data: new Uint8ClampedArray(2 * 2 * 4).fill(200), width: 2, height: 2 }
}

class FakeNoticeEngine extends OcrEngine {
  constructor(texts) {
    super({ neuralConfig: null })
    this.texts = [...texts]
    this.psms = []
  }

  async recognizeGray(_gray, _width, _height, { psm } = {}) {
    this.psms.push(psm)
    return { text: this.texts.shift() ?? '' }
  }
}

test('normalizeNoticeText：保留行顺序，只清行尾空白与首尾空行', () => {
  const input = '\r\n第一行  \r\n\r\n第三行\t\f第四行\r\n\r\n'
  assert.equal(normalizeNoticeText(input), '第一行\n\n第三行\n第四行')
  assert.equal(normalizeNoticeText(''), '')
  assert.equal(normalizeNoticeText(null), '')
})

test('recognizeNotice：PSM 6 一次识别，换行顺序原样保留', async () => {
  const engine = new FakeNoticeEngine(['2026年10月18日 09:12 张老师\n数据结构作业：10月20日 22:00 前提交\n大学英语作文：10月22日 18:00 前提交'])
  const result = await engine.recognizeNotice(imageData(), { isCancelled: () => false })
  assert.deepEqual(engine.psms, [NOTICE_PSM])
  assert.equal(result.cancelled, false)
  assert.equal(result.rawText.split('\n').length, 3)
  assert.equal(result.rawText.split('\n')[0], '2026年10月18日 09:12 张老师')
  assert.equal(result.empty, false)
  assert.deepEqual(result.warnings, [])
})

test('recognizeNotice：PSM 6 为空时用 PSM 3 兜底；仍为空就明确 empty + 提示', async () => {
  const engine = new FakeNoticeEngine(['', ''])
  const result = await engine.recognizeNotice(imageData(), { isCancelled: () => false })
  assert.deepEqual(engine.psms, [NOTICE_PSM, NOTICE_FALLBACK_PSM])
  assert.equal(result.rawText, '')
  assert.equal(result.empty, true)
  assert.ok(result.warnings.some((warning) => warning.includes('没有识别到任何文字')))
})

test('recognizeNotice：取消后不返回成功（rawText 为空、cancelled=true）', async () => {
  let cancelled = false
  const engine = new FakeNoticeEngine(['这一行不应该被当成结果'])
  const result = await engine.recognizeNotice(imageData(), { isCancelled: () => cancelled })
  // recognizeNotice 在第一次 recognizeGray 之后检查取消；这里让 recognizeGray 内把它置真。
  assert.equal(result.cancelled, false, '第一次调用时还没取消')
  assert.equal(result.rawText, '这一行不应该被当成结果')

  const engine2 = new FakeNoticeEngine(['文字'])
  const original = engine2.recognizeGray.bind(engine2)
  engine2.recognizeGray = async (...args) => {
    cancelled = true
    return original(...args)
  }
  const second = await engine2.recognizeNotice(imageData(), { isCancelled: () => cancelled })
  assert.equal(second.cancelled, true)
  assert.equal(second.rawText, '')
  assert.equal(second.empty, true)
})

test('recognizeNotice 不做课表表头拒绝：即使只有「星期一 星期二」也照原样返回', async () => {
  const engine = new FakeNoticeEngine(['星期一 星期二 星期三 星期四 星期五'])
  const result = await engine.recognizeNotice(imageData(), { isCancelled: () => false })
  assert.equal(result.cancelled, false)
  assert.equal(result.rawText, '星期一 星期二 星期三 星期四 星期五')
})
