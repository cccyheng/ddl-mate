package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

public record AttachmentResponse(
        Long id,
        Long sourceId,
        Long taskId,
        String originalName,
        String contentType,
        long sizeBytes,
        OffsetDateTime createdAt,
        String viewUrl,
        String downloadUrl) {
}
