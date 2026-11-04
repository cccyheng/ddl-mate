// 原生时间助手：短语解析器（纯函数）。
//
// 这组测试只关心**语法与日历语义**：支持什么写法、拒绝什么写法、绝不默认补时刻。
// 参考日固定传入，所以结果与运行测试的机器时间、时区都无关。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTimePhrase, phraseLengthError, normalizePhrase } from '../src/domain/timePhraseParser.ts'
import { isValidDateKey, weekdayOfDateKey } from '../src/domain/datetime.ts'

/** 2026-10-13 是周二（已核对）；下面所有「本周 / 下周」断言都以它为准。 */
const REFERENCE = '2026-10-13'

const resolve = (phrase, reference = REFERENCE) => parseTimePhrase(phrase, reference)

/** 断言「解析成功」并返回 `YYYY-MM-DDTHH:mm`。 */
function expectResolved(phrase, expected, reference = REFERENCE) {
  const parsed = resolve(phrase, reference)
  assert.equal(parsed.outcome, 'RESOLVED', `${phrase} → ${parsed.outcome}（${parsed.message}）`)
  const time = parsed.times[0]
  assert.ok(time, `${phrase} 应该解析出一个时间`)
  assert.equal(`${time.dateKey} ${time.clock}`, expected)
  return parsed
}

/** 断言「要求补全 / 不支持」，并且**没有**产出任何候选时间。 */
function expectBlocked(phrase, outcome = 'NEEDS_INFO', reference = REFERENCE) {
  const parsed = resolve(phrase, reference)
  assert.equal(parsed.outcome, outcome, `${phrase} → ${parsed.outcome}（${parsed.message}）`)
  assert.deepEqual(parsed.times, [], `${phrase} 不应该给出候选时间`)
  assert.ok(parsed.message.length > 0, `${phrase} 必须有可读的解释`)
  return parsed
}

/* ------------------------------ 参考日自检 ------------------------------ */

test('测试夹具自检：参考日是周二（本周一 10-12，本周日 10-18）', () => {
  assert.equal(isValidDateKey(REFERENCE), true)
  assert.equal(weekdayOfDateKey(REFERENCE), 2)
})

/* ------------------------------ 精确日期 ------------------------------ */

test('精确公历日期：YYYY-MM-DD / 中文年月日 + 时间都能解析', () => {
  expectResolved('2026-10-20 23:00', '2026-10-20 23:00')
  expectResolved('2026-10-20T23:00', '2026-10-20 23:00')
  expectResolved('2026年10月20日 23:00', '2026-10-20 23:00')
  expectResolved('2026 年 12 月 31 日 23:30', '2026-12-31 23:30')
  expectResolved('2027-01-01 00:00', '2027-01-01 00:00')
  expectResolved('2026/10/20 8:05', '2026-10-20 08:05')
})

test('整句覆盖：`2026年10月8日` 不会被拆成多个日期', () => {
  expectResolved('2026年10月8日 08:00', '2026-10-08 08:00')
})

test('跨月 / 跨年 / 闰日都按真实日历', () => {
  expectResolved('2026-01-31 23:59', '2026-01-31 23:59')
  expectResolved('2028-02-29 12:00', '2028-02-29 12:00', '2028-02-28')
  expectResolved('2026-12-31 23:00', '2026-12-31 23:00')
  expectResolved('2026-10-01 00:00', '2026-10-01 00:00')
})

test('不存在的日期 / 时刻被拒绝，不会被静默滚动', () => {
  expectBlocked('2026-02-30 10:00')
  expectBlocked('2027-02-29 10:00')
  expectBlocked('2026-13-01 10:00')
  expectBlocked('明天 25:00')
  expectBlocked('明天 22:75')
  expectBlocked('明天123:00')
})

test('支持范围的边界年份照实解析，越界的一律要求改写', () => {
  expectResolved('2199-12-31 23:00', '2199-12-31 23:00')
  expectBlocked('2200-01-01 00:00')
  expectBlocked('1899-12-31 23:00')
  // 相对推演越界：参考日在 2199-12-31 时说「明天」没有合法日期，不编一个出来
  expectBlocked('明天 08:00', 'NEEDS_INFO', '2199-12-31')
})

/* ------------------------------ 相对日 + 时刻 ------------------------------ */

test('今天 / 明天 / 后天 / 大后天 + 明确时刻', () => {
  expectResolved('今天 22:00', '2026-10-13 22:00')
  expectResolved('明天 18:00', '2026-10-14 18:00')
  expectResolved('后天 08:30', '2026-10-15 08:30')
  expectResolved('大后天 07:00', '2026-10-16 07:00')
})

test('中文时刻写法：X点 / X点YY分 / 半 / 一刻', () => {
  expectResolved('明天22点', '2026-10-14 22:00')
  expectResolved('明天22点30', '2026-10-14 22:30')
  expectResolved('明天22点30分', '2026-10-14 22:30')
  expectResolved('明天8点半', '2026-10-14 08:30')
  expectResolved('明天3点一刻', '2026-10-14 03:15')
})

test('半日前缀做无歧义的 12 小时换算（含题目点名的「明天晚上8点」）', () => {
  expectResolved('明天晚上8点', '2026-10-14 20:00')
  expectResolved('明天下午3点', '2026-10-14 15:00')
  expectResolved('明天晚上8点半', '2026-10-14 20:30')
  expectResolved('明天凌晨1点', '2026-10-14 01:00')
  expectResolved('明天上午9点', '2026-10-14 09:00')
  expectResolved('明天早上7点', '2026-10-14 07:00')
  expectResolved('明天中午1点', '2026-10-14 13:00')
  expectResolved('今晚8点', '2026-10-13 20:00')
  expectResolved('明晚8点', '2026-10-14 20:00')
  expectResolved('今天下午4点', '2026-10-13 16:00')
})

test('有歧义 / 矛盾的半日写法被拒绝（下午15点 / 凌晨12点 / 晚上12点）', () => {
  expectBlocked('明天下午15点')
  expectBlocked('明天上午23点')
  expectBlocked('明天凌晨12点')
  expectBlocked('晚上12点')
  expectBlocked('明天下午0点')
  expectBlocked('明天下午12点')
  expectBlocked('明天中午15点')
})

test('缺少时刻时**绝不**补 23:59 / 18:00', () => {
  const parsed = expectBlocked('明天')
  assert.match(parsed.message, /没有具体时刻/)
  expectBlocked('下周五')
  expectBlocked('今晚')
  expectBlocked('大后天')
  expectBlocked('22:00')
  expectBlocked('下午3点')
})

/* ------------------------------ 本周 / 下周 ------------------------------ */

test('本周 / 这周 / 下周 + 星期 + 明确时刻（周从周一开始）', () => {
  expectResolved('本周五 18:00', '2026-10-16 18:00')
  expectResolved('这周六 09:00', '2026-10-17 09:00')
  expectResolved('下周一 08:00', '2026-10-19 08:00')
  expectResolved('下星期五 20:00', '2026-10-23 20:00')
  expectResolved('下个星期三 10:00', '2026-10-21 10:00')
  expectResolved('本星期天 10:00', '2026-10-18 10:00')
  expectResolved('这个星期二 08:00', '2026-10-13 08:00')
})

test('显式过去的日期照实解析并带说明，绝不偷偷滚到下周', () => {
  const parsed = expectResolved('本周一 08:00', '2026-10-12 08:00')
  assert.equal(parsed.times[0].dateKey < REFERENCE, true, '本周一确实已经过去')
})

test('不带周前缀的「周五」按本周理解；已经过去时不自动跳周，而是要求写清楚', () => {
  // 参考日 2026-10-13（周二）：本周五还没到 → 按本周算
  expectResolved('周五 18:00', '2026-10-16 18:00')
  // 参考日 2026-10-17（周六）：本周五已经过去 → 必须由用户写「下周五」
  const blocked = expectBlocked('周五 18:00', 'NEEDS_INFO', '2026-10-17')
  assert.match(blocked.message, /已经过去/)
  expectResolved('下周五 18:00', '2026-10-23 18:00', '2026-10-17')
})

test('周前缀跨月 / 跨年时按自然周推演（周起点是周一）', () => {
  expectResolved('下周五 18:00', '2027-01-01 18:00', '2026-12-25')
  expectResolved('下周一 08:00', '2027-01-04 08:00', '2026-12-31')
})

test('未支持的周偏移 / 多余数字不会截断后静默采用', () => {
  expectBlocked('下下周五18:00')
  expectBlocked('明天18:000')
  expectBlocked('明天18:00之后')
  expectBlocked('明天18点开始')
  expectBlocked('明天 10:00 左右')
})

/* ------------------------------ 多重 / 范围 / 重复 ------------------------------ */

test('多个日期 / 多个时刻 / 范围 / 重复一律要求补全，不取第一个', () => {
  expectBlocked('明天 10:00，后天 12:00')
  expectBlocked('明天 10:00 或 14:00')
  expectBlocked('本周一到周五')
  expectBlocked('2026-10-01 到 2026-10-07')
  expectBlocked('每周五 18:00')
  expectBlocked('每月 1 日 09:00')
  expectBlocked('每天 08:00')
})

test('范围太宽 / 不确定的说法要求补全', () => {
  expectBlocked('尽快')
  expectBlocked('随时')
  expectBlocked('以后')
  expectBlocked('周末')
  expectBlocked('月底')
  expectBlocked('下周')
  expectBlocked('10月20日 22:00')
  expectBlocked('20号 10:00')
})

test('否定 / 延期 / 更改 / 相对过去 / 需要校历 → UNSUPPORTED', () => {
  expectBlocked('取消明天的作业', 'UNSUPPORTED')
  expectBlocked('延期到下周五', 'UNSUPPORTED')
  expectBlocked('改到下周 22:00', 'UNSUPPORTED')
  expectBlocked('三天以前', 'UNSUPPORTED')
  expectBlocked('国庆后第一节课前', 'UNSUPPORTED')
  expectBlocked('寒假前 18:00', 'UNSUPPORTED')
})

/* ------------------------------ 包装词白名单 ------------------------------ */

test('有限包装词可以通过（前 / 之前 / 截止 / 提交 / 请于…）', () => {
  expectResolved('明天18:00前交', '2026-10-14 18:00')
  expectResolved('明天 22:00 截止', '2026-10-14 22:00')
  expectResolved('请在明天18:00之前提交', '2026-10-14 18:00')
  expectResolved('务必于 本周五 18:00 完成', '2026-10-16 18:00')
})

test('未定义的修饰词一律拒绝（整句覆盖，不靠否定词黑名单）', () => {
  expectBlocked('明天18:00左右')
  expectBlocked('明天18:00大概')
  expectBlocked('明天 18:00 之前之后')
})

/* ------------------------------ 课程边界短语 ------------------------------ */

test('课前说法被识别成课程窗口（具体匹配在解析层用真实课表完成）', () => {
  const next = resolve('下节课前')
  assert.equal(next.outcome, 'COURSE_WINDOW')
  assert.equal(next.window.scope, 'NEXT')
  assert.equal(next.window.startDateKey, REFERENCE)
  assert.equal(next.window.endDateKeyExclusive, '2027-10-14', '最多向后 366 天，不越界')

  const day = resolve('下周五上课前')
  assert.equal(day.outcome, 'COURSE_WINDOW')
  assert.equal(day.window.scope, 'DAY')
  assert.equal(day.window.startDateKey, '2026-10-23')
  assert.equal(day.window.endDateKeyExclusive, '2026-10-24')

  const thisWeek = resolve('本周这门课前')
  assert.equal(thisWeek.outcome, 'COURSE_WINDOW')
  assert.equal(thisWeek.window.scope, 'WEEK')
  assert.equal(thisWeek.window.startDateKey, REFERENCE, '本周只从参考当天算起')
  assert.equal(thisWeek.window.endDateKeyExclusive, '2026-10-19')

  const nextWeek = resolve('下周这门课前')
  assert.equal(nextWeek.window.scope, 'WEEK')
  assert.equal(nextWeek.window.startDateKey, '2026-10-19', '下周严格从下周一算起')
  assert.equal(nextWeek.window.endDateKeyExclusive, '2026-10-26')
})

test('带课程名 / 类型限定 / 多重条件的「课前」不猜，要求写明确', () => {
  expectBlocked('下次数学课前')
  expectBlocked('下周实验课前')
  expectBlocked('上课前')
  expectBlocked('课前')
  expectBlocked('下节课前两小时')
  expectBlocked('下节课前或下周五上课前')
  expectBlocked('下周五上课前 18:00')
})

/* ------------------------------ 长度与输入校验 ------------------------------ */

test('空短语 / 超 500 字 → 可见校验', () => {
  assert.match(phraseLengthError('') ?? '', /请先写/)
  assert.match(phraseLengthError('   ') ?? '', /请先写/)
  assert.equal(phraseLengthError('明天 18:00'), null)
  const long = '明'.repeat(501)
  assert.match(phraseLengthError(long) ?? '', /最多 500 字/)
  expectBlocked(long)
  expectBlocked('明天 18:00' + '后'.repeat(500))
})

test('全角数字 / 全角冒号被归一化（不改动任何文字含义）', () => {
  assert.equal(normalizePhrase('明天１８：００'), '明天18:00')
  expectResolved('明天１８：００', '2026-10-14 18:00')
})

test('参考日非法时直接要求补全，不产出时间', () => {
  assert.equal(resolve('明天 18:00', '2026-02-30').outcome, 'NEEDS_INFO')
  assert.equal(resolve('明天 18:00', '').outcome, 'NEEDS_INFO')
})
