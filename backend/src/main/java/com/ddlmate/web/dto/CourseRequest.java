package com.ddlmate.web.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** 课程新建/更新请求。 */
public record CourseRequest(
        @NotBlank(message = "课程代码不能为空")
        @Size(max = 32, message = "课程代码最长 32 个字符")
        String code,

        @NotBlank(message = "课程名称不能为空")
        @Size(max = 128, message = "课程名称最长 128 个字符")
        String name,

        @Size(max = 64, message = "任课教师最长 64 个字符")
        String instructor,

        @Size(max = 32, message = "学期最长 32 个字符")
        String semester,

        @Size(max = 16, message = "颜色值最长 16 个字符")
        String color,

        @Size(max = 500, message = "备注最长 500 个字符")
        String note) {
}
