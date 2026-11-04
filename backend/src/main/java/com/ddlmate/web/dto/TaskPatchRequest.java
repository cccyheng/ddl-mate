package com.ddlmate.web.dto;

import java.time.OffsetDateTime;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;

/**
 * 任务局部更新请求（PATCH）。字段为 null 表示"不修改"。
 *
 * <p>无法用 null 表达的字段请用 PUT 全量更新，或者 useCourseId/clearCourse 这类显式开关，
 * 避免"想把课程清空"和"不想改课程"这两种语义混淆。</p>
 */
public record TaskPatchRequest(
        @Size(max = 200, message = "任务标题最长 200 个字符")
        String title,

        @Size(max = 1000, message = "任务说明最长 1000 个字符")
        String description,

        Long courseId,

        /** 置为 true 时把任务从课程上解绑（courseId 会被忽略）。 */
        Boolean clearCourse,

        @Size(max = 32, message = "任务类型非法")
        String type,

        @Size(max = 16, message = "任务状态非法")
        String status,

        @Min(value = 1, message = "优先级取值范围是 1-5")
        @Max(value = 5, message = "优先级取值范围是 1-5")
        Integer priority,

        OffsetDateTime deadline,

        /** 置为 true 时清空截止时间。 */
        Boolean clearDeadline,

        @Min(value = 1, message = "预计耗时最小 1 分钟")
        @Max(value = 10000, message = "预计耗时最大 10000 分钟")
        Integer estimatedMinutes,

        @Size(max = 500, message = "提交要求最长 500 个字符")
        String submitRequirement,

        @Size(max = 128, message = "提交方式最长 128 个字符")
        String submitMethod) {
}
