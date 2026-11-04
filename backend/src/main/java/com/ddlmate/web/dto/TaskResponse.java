package com.ddlmate.web.dto;

import java.time.OffsetDateTime;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 任务响应。null 字段（例如未设置截止时间）不出现在 JSON 里，前端用可选值处理。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskResponse(
        Long id,
        String title,
        String description,
        CourseBrief course,
        String type,
        String typeLabel,
        String status,
        String statusLabel,
        int priority,
        String priorityLabel,
        OffsetDateTime deadline,
        Integer estimatedMinutes,
        String submitRequirement,
        String submitMethod,
        OffsetDateTime completedAt,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt,
        long sourceCount,
        List<AttachmentResponse> attachments) {
}
