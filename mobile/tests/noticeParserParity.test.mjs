// 通知原文 → 待办：解析器复制品的**逐字节一致性**测试。
//
// 授权书的硬约束：「不得跨 Metro 根 import、不得在 frontend 里改解析器、不得维护一份
// 重写过的正则」。mobile 侧因此保留了一份**逐字节复制**的 parser。这个测试用 SHA256
// 证明两边完全一致 —— 任何一次「顺手改一行」都会在这里被拦下来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileCopy = join(here, '..', 'src', 'domain', 'noticeParser.js')
const frontendOriginal = join(here, '..', '..', 'frontend', 'src', 'ocr', 'noticeParser.js')

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('mobile 的通知解析器与 frontend 原件逐字节一致（SHA256）', () => {
  let original
  try {
    original = readFileSync(frontendOriginal)
  } catch {
    // frontend 不存在时跳过：这条测试的意义是「防止漂移」，本地开发机上它应当存在。
    return
  }
  const copy = readFileSync(mobileCopy)
  assert.equal(
    sha256(mobileCopy),
    createHash('sha256').update(original).digest('hex'),
    'mobile/src/domain/noticeParser.js 与 frontend/src/ocr/noticeParser.js 已经不一致：' +
      '请重新逐字节复制，不要在 mobile 侧手改解析规则。',
  )
  assert.deepEqual(copy, original)
})

test('复制品仍然导出界面依赖的全部函数', async () => {
  const parser = await import('../src/domain/noticeParser.js')
  for (const name of [
    'parseNoticeText',
    'splitSegments',
    'extractDeadline',
    'extractTitle',
    'extractSubmitMethod',
    'extractSubmitRequirement',
    'guessTaskType',
    'matchCourse',
    'normalizeOcrText',
    'toOffsetDateTime',
    'NOTICE_HINTS',
  ]) {
    assert.ok(name in parser, `解析器缺少导出 ${name}`)
  }
})
