package com.ddlmate.web.dto;

import java.time.LocalDate;
import java.util.List;

/** 月历数据：每天的课程（按新的教学周规则过滤）与当天截止的任务。 */
public record ScheduleCalendarResponse(int year, int month, List<DayEntry> days) {

    public record DayEntry(LocalDate date, List<TaskResponse> tasks, List<CourseScheduleResponse> schedules) {
    }
}
