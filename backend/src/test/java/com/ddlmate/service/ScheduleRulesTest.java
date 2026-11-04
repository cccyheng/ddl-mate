package com.ddlmate.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalTime;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.WeekPattern;

/**
 * 教学周 / 单双周规则的纯单元测试（不需要 Spring 上下文）。
 *
 * <p>学期起点用 2026-09-07（周一）：第 1 周 9/7-9/13、第 2 周 9/14-9/20、第 3 周 9/21-9/27、
 * 第 4 周 9/28-10/4、第 5 周 10/5-10/11、第 6 周 10/12-10/18。</p>
 */
class ScheduleRulesTest {

    private static final LocalDate SEMESTER_START = LocalDate.of(2026, 9, 7);

    @Test
    @DisplayName("学期起点必须是周一（用到的日期常量自检）")
    void semesterStartIsMonday() {
        assertThat(SEMESTER_START.getDayOfWeek()).isEqualTo(DayOfWeek.MONDAY);
        assertThat(ScheduleRules.isMonday(SEMESTER_START)).isTrue();
        assertThat(ScheduleRules.isMonday(LocalDate.of(2026, 9, 8))).isFalse();
        assertThat(ScheduleRules.isMonday(null)).isFalse();
    }

    @Test
    @DisplayName("教学周序号：起点所在周为第 1 周")
    void teachingWeekIndex() {
        assertThat(ScheduleRules.teachingWeek(SEMESTER_START, LocalDate.of(2026, 9, 7))).isEqualTo(1);
        assertThat(ScheduleRules.teachingWeek(SEMESTER_START, LocalDate.of(2026, 9, 13))).isEqualTo(1);
        assertThat(ScheduleRules.teachingWeek(SEMESTER_START, LocalDate.of(2026, 9, 14))).isEqualTo(2);
        assertThat(ScheduleRules.teachingWeek(SEMESTER_START, LocalDate.of(2026, 10, 5))).isEqualTo(5);
        assertThat(ScheduleRules.teachingWeek(SEMESTER_START, LocalDate.of(2026, 10, 12))).isEqualTo(6);
    }

    @Test
    @DisplayName("星期不匹配一律不上课")
    void weekdayMismatch() {
        CourseSchedule monday = schedule(1, WeekPattern.ALL, 1, 16);
        assertThat(ScheduleRules.occursOn(monday, LocalDate.of(2026, 9, 7))).isTrue();
        assertThat(ScheduleRules.occursOn(monday, LocalDate.of(2026, 9, 8))).isFalse();
    }

    @Test
    @DisplayName("每周（ALL）：起止周内每周都上，边界包含起止周")
    void allPatternRespectsWeekRange() {
        CourseSchedule schedule = schedule(1, WeekPattern.ALL, 2, 4);
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 7))).isFalse();   // 第 1 周 < 2
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 14))).isTrue();   // 第 2 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 21))).isTrue();   // 第 3 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 28))).isTrue();   // 第 4 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 10, 5))).isFalse();  // 第 5 周 > 4
    }

    @Test
    @DisplayName("单周（ODD）：只保留奇数教学周，与日期奇偶无关")
    void oddPatternUsesTeachingWeekParity() {
        CourseSchedule schedule = schedule(1, WeekPattern.ODD, 1, 6);
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 7))).isTrue();    // 第 1 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 14))).isFalse();  // 第 2 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 21))).isTrue();   // 第 3 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 28))).isFalse();  // 第 4 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 10, 5))).isTrue();   // 第 5 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 10, 12))).isFalse(); // 第 6 周（偶数）
    }

    @Test
    @DisplayName("双周（EVEN）：只保留偶数教学周")
    void evenPatternUsesTeachingWeekParity() {
        CourseSchedule schedule = schedule(1, WeekPattern.EVEN, 1, 6);
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 7))).isFalse();   // 第 1 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 14))).isTrue();   // 第 2 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 21))).isFalse();  // 第 3 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 28))).isTrue();   // 第 4 周
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 10, 12))).isTrue();  // 第 6 周
    }

    @Test
    @DisplayName("学期开始之前不上课，结束周之后不上课")
    void outsideSemesterRange() {
        CourseSchedule schedule = schedule(1, WeekPattern.ALL, 1, 16);
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 8, 31))).isFalse();  // 学期前一周一
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 7))).isTrue();
        CourseSchedule shortTerm = schedule(1, WeekPattern.ALL, 1, 2);
        assertThat(ScheduleRules.occursOn(shortTerm, LocalDate.of(2026, 9, 21))).isFalse(); // 第 3 周 > 2
    }

    @Test
    @DisplayName("缺少学期起点或起止周时按每周处理（兼容旧数据）")
    void missingWeekInfoFallsBackToEveryWeek() {
        CourseSchedule noInfo = new CourseSchedule(new Course("T1", "测试课"), 1,
                LocalTime.of(8, 0), LocalTime.of(9, 40));
        assertThat(noInfo.hasTeachingWeeks()).isFalse();
        assertThat(ScheduleRules.occursOn(noInfo, LocalDate.of(2026, 9, 7))).isTrue();
        assertThat(ScheduleRules.occursOn(noInfo, LocalDate.of(2026, 12, 7))).isTrue();
        assertThat(ScheduleRules.occursOn(noInfo, LocalDate.of(2026, 9, 8))).isFalse();

        CourseSchedule partial = schedule(1, WeekPattern.ODD, 1, 6);
        partial.setSemesterStartDate(null);
        assertThat(partial.hasTeachingWeeks()).isFalse();
        assertThat(ScheduleRules.occursOn(partial, LocalDate.of(2026, 9, 14))).isTrue(); // 没有起点 → 不按单周过滤
    }

    @Test
    @DisplayName("null 参数安全")
    void nullSafety() {
        assertThat(ScheduleRules.occursOn(null, LocalDate.of(2026, 9, 7))).isFalse();
        CourseSchedule schedule = schedule(1, WeekPattern.ALL, 1, 6);
        assertThat(ScheduleRules.occursOn(schedule, null)).isFalse();
        schedule.setWeekday(null);
        assertThat(ScheduleRules.occursOn(schedule, LocalDate.of(2026, 9, 7))).isFalse();
    }

    @Test
    @DisplayName("WeekPattern.fromNullable：null/空为 ALL，非法值报错")
    void weekPatternParsing() {
        assertThat(WeekPattern.fromNullable(null)).isEqualTo(WeekPattern.ALL);
        assertThat(WeekPattern.fromNullable("  ")).isEqualTo(WeekPattern.ALL);
        assertThat(WeekPattern.fromNullable("odd")).isEqualTo(WeekPattern.ODD);
        assertThat(WeekPattern.fromNullable("EVEN")).isEqualTo(WeekPattern.EVEN);
        try {
            WeekPattern.fromNullable("WEEKLY");
            throw new AssertionError("非法值应当抛异常");
        } catch (IllegalArgumentException expected) {
            assertThat(expected.getMessage()).contains("ALL");
        }
    }

    private static CourseSchedule schedule(int weekday, WeekPattern pattern, int startWeek, int endWeek) {
        CourseSchedule schedule = new CourseSchedule(new Course("T1", "测试课"), weekday,
                LocalTime.of(8, 0), LocalTime.of(9, 40));
        schedule.setSemesterStartDate(SEMESTER_START);
        schedule.setStartWeek(startWeek);
        schedule.setEndWeek(endWeek);
        schedule.setWeekPattern(pattern);
        return schedule;
    }
}
