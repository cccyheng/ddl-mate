package com.ddlmate.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 任务状态切换请求。 */
public record TaskStatusRequest(
        @NotBlank(message = "状态不能为空")
        @Size(max = 16, message = "状态非法")
        String status) {
}
