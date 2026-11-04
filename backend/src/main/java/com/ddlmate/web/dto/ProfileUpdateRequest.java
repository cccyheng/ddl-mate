package com.ddlmate.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record ProfileUpdateRequest(
        @NotBlank(message = "显示名称不能为空")
        @Size(max = 64, message = "显示名称最长 64 个字符")
        String displayName) {
}
