package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

public record CourseResponse(
        Long id,
        String code,
        String name,
        String instructor,
        String semester,
        String color,
        String note,
        long taskCount,
        long scheduleCount,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt) {
}
