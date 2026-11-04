package com.ddlmate.web;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.CalendarService;
import com.ddlmate.web.dto.ScheduleCalendarResponse;

/** 月历：一次返回当月每天的任务 DDL 与课程（课程已按教学周 + 单双周规则过滤）。 */
@RestController
@RequestMapping("/api/calendar")
public class CalendarController {

    private final CalendarService calendarService;

    public CalendarController(CalendarService calendarService) {
        this.calendarService = calendarService;
    }

    @GetMapping
    public ScheduleCalendarResponse month(@RequestParam int year, @RequestParam int month) {
        return calendarService.month(year, month);
    }
}
