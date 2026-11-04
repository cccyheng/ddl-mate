package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 任务全量创建/更新请求（PUT 与 POST 共用）。 */
public record TaskRequest(
        @NotBlank(message = "任务标题不能为空")
        @Size(max = 200, message = "任务标题最长 200 个字符")
        String title,

        @Size(max = 1000, message = "任务说明最长 1000 个字符")
        String description,

        Long courseId,

        @Size(max = 32, message = "任务类型非法")
        String type,

        @Size(max = 16, message = "任务状态非法")
        String status,

        @Min(value = 1, message = "优先级取值范围是 1-5")
        @Max(value = 5, message = "优先级取值范围是 1-5")
        Integer priority,

        OffsetDateTime deadline,

        @Min(value = 1, message = "预计耗时最小 1 分钟")
        @Max(value = 10000, message = "预计耗时最大 10000 分钟")
        Integer estimatedMinutes,

        @Size(max = 500, message = "提交要求最长 500 个字符")
        String submitRequirement,

        @Size(max = 128, message = "提交方式最长 128 个字符")
        String submitMethod) {
}
