package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 原通知新建请求：文字 + 来源名。图片走 /api/sources/{id}/attachments 单独上传。 */
public record TaskSourceRequest(
        @NotBlank(message = "来源名称不能为空")
        @Size(max = 128, message = "来源名称最长 128 个字符")
        String sourceName,

        @Size(max = 32, message = "来源类型最长 32 个字符")
        String sourceType,

        @Size(max = 4000, message = "原通知文字最长 4000 个字符")
        String rawText,

        OffsetDateTime capturedAt) {
}
