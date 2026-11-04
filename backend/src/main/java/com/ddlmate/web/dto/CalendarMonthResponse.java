package com.ddlmate.web.dto;

import java.time.LocalDate;
import java.util.List;

/** 月历响应：按日期分组的任务，外加一个便于前端直接渲染的日期数组。 */
public record CalendarMonthResponse(
        int year,
        int month,
        List<DayTasks> days) {

    public record DayTasks(LocalDate date, List<TaskResponse> tasks) {
    }
}
