package com.ddlmate.web.dto;

import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;

public record CourseScheduleResponse(
        Long id,
        Long courseId,
        String courseName,
        String courseCode,
        String courseColor,
        Integer weekday,
        String weekdayLabel,
        LocalTime startTime,
        LocalTime endTime,
        String location,
        Integer periodStart,
        Integer periodEnd,
        String weekRange,
        LocalDate semesterStartDate,
        Integer startWeek,
        Integer endWeek,
        String weekPattern,
        String weekPatternLabel,
        /** 中文摘要，例如「1-16 周 · 每周」「3-15 周 · 单周」「未设置教学周（按每周显示）」。 */
        String weekSummary,
        /** 是否已配置教学周过滤（旧数据为 false，界面应提示补充）。 */
        boolean teachingWeeksConfigured,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt) {
}
