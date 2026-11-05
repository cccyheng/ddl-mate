package com.ddlmate.web.dto;

import java.time.LocalDate;
import java.time.LocalTime;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 课表节次请求。weekday 为 ISO-8601：1=周一 … 7=周日。
 * startTime/endTime 为本地时间，格式 HH:mm 或 HH:mm:ss。
 *
 * <p>教学周相关字段均可选，用于兼容旧数据：</p>
 * <ul>
 *   <li>{@code semesterStartDate}：学期第一周周一（必须是周一）；</li>
 *   <li>{@code startWeek} / {@code endWeek}：起止教学周（1-53，必须同时给出）；</li>
 *   <li>{@code weekPattern}：ALL（每周，默认）/ ODD（单周）/ EVEN（双周）。</li>
 * </ul>
 * 跨字段约束（例如"单双周必须有学期起点"）在服务层校验，以便返回明确的中文提示。
 */
public record CourseScheduleRequest(
        @NotNull(message = "星期不能为空")
        @Min(value = 1, message = "星期取值范围是 1（周一）到 7（周日）")
        @Max(value = 7, message = "星期取值范围是 1（周一）到 7（周日）")
        Integer weekday,

        @NotNull(message = "开始时间不能为空")
        LocalTime startTime,

        @NotNull(message = "结束时间不能为空")
        LocalTime endTime,

        @Size(max = 128, message = "上课地点最长 128 个字符")
        String location,

        @Min(value = 1, message = "起始节次最小为 1")
        @Max(value = 12, message = "起始节次最大为 12")
        Integer periodStart,

        @Min(value = 1, message = "结束节次最小为 1")
        @Max(value = 12, message = "结束节次最大为 12")
        Integer periodEnd,

        @Size(max = 32, message = "教学周范围最长 32 个字符")
        String weekRange,

        LocalDate semesterStartDate,

        @Min(value = 1, message = "起始周最小为 1")
        @Max(value = 53, message = "起始周最大为 53")
        Integer startWeek,

        @Min(value = 1, message = "结束周最小为 1")
        @Max(value = 53, message = "结束周最大为 53")
        Integer endWeek,

        @Size(max = 8, message = "上课周次规律非法")
        String weekPattern,

        @Size(max = 128, message = "任课教师最长 128 个字符")
        String teacher) {

    /** 旧调用方（不带教师）的便捷构造。 */
    public CourseScheduleRequest(Integer weekday, LocalTime startTime, LocalTime endTime, String location,
            Integer periodStart, Integer periodEnd, String weekRange, LocalDate semesterStartDate,
            Integer startWeek, Integer endWeek, String weekPattern) {
        this(weekday, startTime, endTime, location, periodStart, periodEnd, weekRange, semesterStartDate,
                startWeek, endWeek, weekPattern, null);
    }
}
