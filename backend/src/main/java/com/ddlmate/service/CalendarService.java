package com.ddlmate.service;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.web.dto.CalendarMonthResponse;
import com.ddlmate.web.dto.CourseScheduleResponse;
import com.ddlmate.web.dto.ScheduleCalendarResponse;
import com.ddlmate.web.dto.TaskResponse;

/**
 * 月历数据：把"课程"和"任务 DDL"合到一起，供日历页一次取回。
 *
 * <p>课程的判定复用 {@link ScheduleRules}（教学周 + 单双周），任务复用 TaskService 的按月分组。</p>
 */
@Service
public class CalendarService {

    private final ScheduleService scheduleService;

    private final TaskService taskService;

    public CalendarService(ScheduleService scheduleService, TaskService taskService) {
        this.scheduleService = scheduleService;
        this.taskService = taskService;
    }

    @Transactional(readOnly = true)
    public ScheduleCalendarResponse month(int year, int month) {
        if (month < 1 || month > 12) {
            throw new InvalidRequestException("month", "月份取值范围是 1-12");
        }
        if (year < 1970 || year > 2200) {
            throw new InvalidRequestException("year", "年份取值范围是 1970-2200");
        }
        LocalDate first = LocalDate.of(year, month, 1);
        LocalDate next = first.plusMonths(1);

        Map<LocalDate, List<TaskResponse>> tasksByDay = new LinkedHashMap<>();
        CalendarMonthResponse taskMonth = taskService.calendar(year, month);
        for (CalendarMonthResponse.DayTasks day : taskMonth.days()) {
            tasksByDay.put(day.date(), day.tasks());
        }
        Map<LocalDate, List<CourseScheduleResponse>> schedulesByDay = scheduleService.occurrencesInRange(first, next);

        List<ScheduleCalendarResponse.DayEntry> days = new ArrayList<>();
        for (LocalDate date = first; date.isBefore(next); date = date.plusDays(1)) {
            days.add(new ScheduleCalendarResponse.DayEntry(
                    date,
                    tasksByDay.getOrDefault(date, List.of()),
                    schedulesByDay.getOrDefault(date, List.of())));
        }
        return new ScheduleCalendarResponse(year, month, days);
    }
}
