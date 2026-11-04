package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record TaskSourceResponse(
        Long id,
        Long taskId,
        String taskTitle,
        String sourceName,
        String sourceType,
        String rawText,
        OffsetDateTime capturedAt,
        OffsetDateTime createdAt,
        java.util.List<AttachmentResponse> attachments) {
}
