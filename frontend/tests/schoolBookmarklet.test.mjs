import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBookmarklet, isTrustedSchoolOrigin } from '../src/import/schoolBookmarklet.js'

test('bookmarklet is a javascript: URL that embeds the app origin and parses as code', () => {
  const href = buildBookmarklet('https://ddlmate.example.com')
  assert.ok(href.startsWith('javascript:'))
  const code = decodeURIComponent(href.slice('javascript:'.length))
  assert.match(code, /"https:\/\/ddlmate\.example\.com"\)$/)
  assert.match(code, /courseTableForStd!courseTable\.action/)
  // 能被解析（不执行）
  assert.doesNotThrow(() => new Function(code))
})

test('only school origins (and localhost while developing) are trusted', () => {
  assert.equal(isTrustedSchoolOrigin('http://jw.xpaas.dlmu.edu.cn'), true)
  assert.equal(isTrustedSchoolOrigin('https://dlmu.edu.cn'), true)
  assert.equal(isTrustedSchoolOrigin('https://evil-dlmu.edu.cn'), false)
  assert.equal(isTrustedSchoolOrigin('https://dlmu.edu.cn.evil.com'), false)
  assert.equal(isTrustedSchoolOrigin('http://localhost:8099'), false)
  assert.equal(isTrustedSchoolOrigin('http://localhost:8099', 'localhost'), true)
  assert.equal(isTrustedSchoolOrigin('null'), false)
})
