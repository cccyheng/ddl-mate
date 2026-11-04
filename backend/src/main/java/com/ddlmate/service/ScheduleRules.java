package com.ddlmate.service;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.WeekPattern;

/**
 * 课表"某天是否上课"的唯一判定规则。
 *
 * <p>全系统（今日课程、按日期查询、月历、日期详情）都必须复用这里的逻辑，避免各处各写一套。</p>
 *
 * <p>规则：</p>
 * <ol>
 *   <li>星期必须匹配（1=周一 … 7=周日）；</li>
 *   <li>若没有学期第一周周一或起止周（旧数据），视为"每周都上"，不做教学周限制；</li>
 *   <li>否则计算教学周序号 = (该日期 - 学期第一周周一) / 7 + 1，必须落在 [startWeek, endWeek]；</li>
 *   <li>再按 {@link WeekPattern} 过滤：ALL 全要，ODD 只保留奇数教学周，EVEN 只保留偶数教学周。</li>
 * </ol>
 */
public final class ScheduleRules {

    private ScheduleRules() {
    }

    /** 该课表是否在指定日期上课。 */
    public static boolean occursOn(CourseSchedule schedule, LocalDate date) {
        if (schedule == null || date == null || schedule.getWeekday() == null) {
            return false;
        }
        if (date.getDayOfWeek().getValue() != schedule.getWeekday()) {
            return false;
        }
        LocalDate semesterStart = schedule.getSemesterStartDate();
        Integer startWeek = schedule.getStartWeek();
        Integer endWeek = schedule.getEndWeek();
        if (semesterStart == null || startWeek == null || endWeek == null) {
            // 旧数据：没有教学周信息，按"每周"展示
            return true;
        }
        if (date.isBefore(semesterStart)) {
            return false;
        }
        long weekIndex = teachingWeek(semesterStart, date);
        if (weekIndex < startWeek || weekIndex > endWeek) {
            return false;
        }
        WeekPattern pattern = schedule.getWeekPattern() == null ? WeekPattern.ALL : schedule.getWeekPattern();
        return switch (pattern) {
            case ALL -> true;
            case ODD -> weekIndex % 2 == 1;
            case EVEN -> weekIndex % 2 == 0;
        };
    }

    /** 教学周序号：学期第一周周一所在周为第 1 周。日期早于起点时返回 0 或负数。 */
    public static long teachingWeek(LocalDate semesterStartMonday, LocalDate date) {
        return ChronoUnit.WEEKS.between(semesterStartMonday, date) + 1;
    }

    public static boolean isMonday(LocalDate date) {
        return date != null && date.getDayOfWeek() == DayOfWeek.MONDAY;
    }
}
