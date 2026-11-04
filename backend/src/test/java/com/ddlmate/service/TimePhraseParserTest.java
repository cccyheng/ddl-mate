package com.ddlmate.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.time.LocalDateTime;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.ddlmate.service.TimePhraseParser.Outcome;
import com.ddlmate.service.TimePhraseParser.Parsed;
import com.ddlmate.service.TimePhraseParser.WindowScope;

/**
 * 时间短语解析的**纯单元测试**：固定参考日 2026-10-10（周六），不依赖系统时钟、不依赖数据库。
 *
 * <p>2026-10-10 是周六，所在自然周是 2026-10-05（周一）~ 2026-10-11（周日）；
 * 下一个自然周是 2026-10-12 ~ 2026-10-18。</p>
 */
class TimePhraseParserTest {

    private static final LocalDate REF = LocalDate.of(2026, 10, 10);

    private static Parsed parse(String text) {
        return TimePhraseParser.parse(text, REF);
    }

    private static LocalDateTime at(int year, int month, int day, int hour, int minute) {
        return LocalDateTime.of(year, month, day, hour, minute);
    }

    // ------------------------------------------------------------------ 相对日 + 时刻

    @Test
    @DisplayName("今天 / 明天 / 后天 + 明确时刻")
    void relativeDays() {
        assertThat(parse("今天 22:00").times()).extracting(TimePhraseParser.ResolvedTime::dateTime)
                .containsExactly(at(2026, 10, 10, 22, 0));
        assertThat(parse("明天 18:00").times()).extracting(TimePhraseParser.ResolvedTime::dateTime)
                .containsExactly(at(2026, 10, 11, 18, 0));
        assertThat(parse("后天08点30分").times()).extracting(TimePhraseParser.ResolvedTime::dateTime)
                .containsExactly(at(2026, 10, 12, 8, 30));
        assertThat(parse("明天").outcome()).isEqualTo(Outcome.NEEDS_INFO);
    }

    @Test
    @DisplayName("半日前缀（下午 / 晚上 / 中午 / 凌晨）按口语换算成 24 小时制")
    void meridiem() {
        assertThat(parse("明天下午3点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 15, 0));
        assertThat(parse("明天晚上8点半").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 20, 30));
        assertThat(parse("今晚8点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 10, 20, 0));
        assertThat(parse("明晚8点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 20, 0));
        assertThat(parse("明天中午1点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 13, 0));
        assertThat(parse("明天凌晨1点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 1, 0));
        assertThat(parse("明天上午9点").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 9, 0));
    }

    @Test
    @DisplayName("坏时间严格拒绝：25:00 / 下午15点 / 上午23点 / 不存在的日期")
    void invalidTimes() {
        assertThat(parse("明天 25:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天 22:75").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天下午15点").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天上午23点").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天凌晨12点").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("2026-02-30 10:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("2027-02-29 10:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("2028-02-29 10:00").times().get(0).dateTime()).isEqualTo(at(2028, 2, 29, 10, 0));
    }

    // ------------------------------------------------------------------ 星期与周前缀

    @Test
    @DisplayName("本周X / 这周X / 下周X：周一开头的自然周")
    void weeks() {
        assertThat(parse("本周日 12:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 12, 0));
        assertThat(parse("这周六 09:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 10, 9, 0));
        assertThat(parse("下周一 08:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 12, 8, 0));
        assertThat(parse("下星期五 20:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 16, 20, 0));
        // 本周五（10-09）已经过去：显式写「本周」也如实解析（由服务标 past 提示），不偷偷滚到下周
        assertThat(parse("本周五 18:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 9, 18, 0));
    }

    @Test
    @DisplayName("未加周前缀的「周X」：本周内已过去时不自动跳周，要求写清楚")
    void bareWeekdayDoesNotJump() {
        // 周五（10-09）已过 → 不静默取下周五
        assertThat(parse("周五 18:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("周五 18:00").message()).contains("在本周已经过去");
        // 周日（10-11）还没到 → 按本周理解并给出可读语义
        Parsed sunday = parse("周日 12:00");
        assertThat(sunday.outcome()).isEqualTo(Outcome.RESOLVED);
        assertThat(sunday.times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 12, 0));
        assertThat(sunday.hints()).anyMatch(hint -> hint.contains("没有写「本周 / 下周」"));
    }

    @Test
    @DisplayName("下个星期 / 大后天 / 全角数字与冒号都能解析")
    void normalizationAndAliases() {
        assertThat(parse("下个星期三 10:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 14, 10, 0));
        assertThat(parse("大后天 07:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 13, 7, 0));
        assertThat(parse("明天　２２：００").times().get(0).dateTime()).isEqualTo(at(2026, 10, 11, 22, 0));
    }

    // ------------------------------------------------------------------ 精确日期

    @Test
    @DisplayName("精确日期 YYYY-MM-DD HH:mm（含跨月 / 跨年）")
    void absoluteDates() {
        assertThat(parse("2026-10-20 23:00").times().get(0).dateTime()).isEqualTo(at(2026, 10, 20, 23, 0));
        assertThat(parse("2026年12月31日 23:30").times().get(0).dateTime()).isEqualTo(at(2026, 12, 31, 23, 30));
        assertThat(parse("2027-01-01 00:00").times().get(0).dateTime()).isEqualTo(at(2027, 1, 1, 0, 0));
        assertThat(parse("2026-11-01 09:15").times().get(0).dateTime()).isEqualTo(at(2026, 11, 1, 9, 15));
    }

    // ------------------------------------------------------------------ 保守拒绝

    @Test
    @DisplayName("只有日期 / 只有时刻 / 今晚 / 尽快 / 周末 / 月范围：一律提示补全，不补 23:59")
    void needsMoreInfo() {
        assertThat(parse("明天").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("下周五").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("22:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("今晚").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("尽快交作业").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("周末").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("月底").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("每周五 18:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("下周").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        for (String text : new String[] { "明天", "22:00", "今晚", "尽快", "周末" }) {
            assertThat(parse(text).times()).as(text).isEmpty();
        }
    }

    @Test
    @DisplayName("多重日期 / 多重时刻 / 范围：不取第一个静默成功")
    void multipleAndRanges() {
        assertThat(parse("明天 10:00，后天 12:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天 10:00 或 14:00").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("本周一到周五").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("2026-10-01 到 2026-10-07").outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parse("明天 10:00，后天 12:00").message()).contains("多个日期");
        assertThat(parse("明天 10:00 或 14:00").message()).contains("多个时刻");
    }

    @Test
    @DisplayName("否定 / 延期 / 更改 / 「…以前」/ 需要校历：保守拒绝")
    void unsupportedComplex() {
        assertThat(parse("取消明天的作业").outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(parse("延期到下周五").outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(parse("改到下周 22:00").outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(parse("三天以前").outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(parse("国庆后第一节课前").outcome()).isEqualTo(Outcome.UNSUPPORTED);
        assertThat(parse("随便写点什么").outcome()).isEqualTo(Outcome.NEEDS_INFO);
    }

    @Test
    @DisplayName("只有月日没有年份 → 说明缺年份，不用当前年硬凑")
    void monthDayWithoutYear() {
        Parsed parsed = parse("10月20日 22:00");
        assertThat(parsed.outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parsed.message()).contains("没有年份");
    }

    // ------------------------------------------------------------------ 课程边界窗口

    @Test
    @DisplayName("课程边界说法产出正确的时间窗口（下周严格下一个自然周）")
    void courseWindows() {
        Parsed nextClass = parse("下节课前");
        assertThat(nextClass.outcome()).isEqualTo(Outcome.COURSE_WINDOW);
        assertThat(nextClass.window().scope()).isEqualTo(WindowScope.NEXT);
        assertThat(nextClass.window().start()).isEqualTo(REF);
        assertThat(nextClass.window().endExclusive()).isEqualTo(REF.plusDays(366));

        Parsed nextWeek = parse("下周这门课前");
        assertThat(nextWeek.window().scope()).isEqualTo(WindowScope.WEEK);
        assertThat(nextWeek.window().start()).isEqualTo(LocalDate.of(2026, 10, 12));
        assertThat(nextWeek.window().endExclusive()).isEqualTo(LocalDate.of(2026, 10, 19));

        Parsed thisWeek = parse("本周这门课前");
        assertThat(thisWeek.window().start()).isEqualTo(REF);
        assertThat(thisWeek.window().endExclusive()).isEqualTo(LocalDate.of(2026, 10, 12));

        Parsed friday = parse("下周五上课前");
        assertThat(friday.window().scope()).isEqualTo(WindowScope.DAY);
        assertThat(friday.window().start()).isEqualTo(LocalDate.of(2026, 10, 16));
        assertThat(friday.window().endExclusive()).isEqualTo(LocalDate.of(2026, 10, 17));

        Parsed thisFriday = parse("本周五上课前");
        assertThat(thisFriday.window().scope()).isEqualTo(WindowScope.DAY);
        assertThat(thisFriday.window().start()).isEqualTo(LocalDate.of(2026, 10, 9));

        assertThat(parse("下次上课前").window().scope()).isEqualTo(WindowScope.NEXT);
        assertThat(parse("下一节课之前").outcome()).isEqualTo(Outcome.COURSE_WINDOW);
    }

    @Test
    @DisplayName("Codex 实测反例：截断 / 多重条件 / 类型限定 / 额外修饰一律保守拒绝")
    void codexRound1Counterexamples() {
        LocalDate friday = LocalDate.of(2026, 10, 9);

        // 0) 正常短语仍然可用（回归）
        Parsed ok = TimePhraseParser.parse("明天18:00", friday);
        assertThat(ok.outcome()).isEqualTo(Outcome.RESOLVED);
        assertThat(ok.times().get(0).dateTime()).isEqualTo(at(2026, 10, 10, 18, 0));

        // 1) 「下下」不能被截成「下」
        assertThat(TimePhraseParser.parse("下下周五18:00", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        // 2) 坏数字不能被截取部分静默成功
        assertThat(TimePhraseParser.parse("明天18:000", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("明天123:00", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        // 3) 多个「课前」条件不能只取第一个
        assertThat(TimePhraseParser.parse("下节课前或下周五上课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("下周五上课前或下周一上课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        // 4) 额外修饰（两小时 / 之后 / 开始）不能丢弃后当成截止
        assertThat(TimePhraseParser.parse("下节课前两小时", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("明天18:00之后", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("明天18点开始", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        // 5) 带课程名 / 类型限定的「课前」不猜是哪一节
        assertThat(TimePhraseParser.parse("下次数学课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("下次实验课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(TimePhraseParser.parse("下周实验课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);
        // 6) 无作用域的「上课前」要求写清楚
        assertThat(TimePhraseParser.parse("上课前", friday).outcome()).isEqualTo(Outcome.NEEDS_INFO);

        // 7) 有限包装词仍然允许：前 / 之前 / 截止
        assertThat(TimePhraseParser.parse("明天18:00前交", friday).outcome()).isEqualTo(Outcome.RESOLVED);
        assertThat(TimePhraseParser.parse("明天 22:00 截止", friday).outcome()).isEqualTo(Outcome.RESOLVED);
        assertThat(TimePhraseParser.parse("明天18:00之前", friday).outcome()).isEqualTo(Outcome.RESOLVED);
    }

    @Test
    @DisplayName("「课前」和具体日期 / 时刻同时出现时不猜，要求二选一")
    void courseWindowConflict() {
        Parsed parsed = parse("下周五上课前 18:00");
        assertThat(parsed.outcome()).isEqualTo(Outcome.NEEDS_INFO);
        assertThat(parsed.message()).contains("无法确定");
    }
}
