package com.ddlmate.web.dto;

import java.util.List;

/** 批量导入结果。 */
public record ScheduleImportResponse(
        int createdCourses,
        int createdSchedules,
        /** 与数据库已有记录完全相同、被跳过（防重复提交）的条数。 */
        int skippedSchedules,
        List<CourseScheduleResponse> schedules,
        List<String> notices) {
}
