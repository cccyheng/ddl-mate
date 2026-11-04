package com.ddlmate.web.dto;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 批量导入课表（照片导入确认后调用）。
 *
 * <p>设计要点：</p>
 * <ul>
 *   <li>新建课程与课表在同一个事务里完成，任何一条非法就整体回滚，不会留下孤立课程；</li>
 *   <li>课程用 {@code ref} 在请求内部互相引用，课表二选一：{@code courseId}（已有课程）或 {@code courseRef}（本次新建）；</li>
 *   <li>字段约束与单条新增/编辑**完全一致**（星期、节次、教学周范围都在这里校验），服务层再校验跨字段规则；</li>
 *   <li>请求内部完全相同的课表会被拒绝（400）；与数据库已有记录完全相同的课表会被跳过并计数（防重复提交）；
 *       真正冲突（同一天时间重叠且周次规律无法共存）会明确报错，而不是静默丢弃。</li>
 * </ul>
 */
public record ScheduleImportRequest(
        @Valid
        @Size(max = 50, message = "一次最多导入 50 门新课程")
        List<ImportCourse> courses,

        @Valid
        @NotNull(message = "课表列表不能为空")
        @Size(min = 1, max = 300, message = "一次导入的课表条数必须在 1-300 之间")
        List<ImportSchedule> schedules) {

    /** 本次新建的课程。ref 只在本次请求内有效。 */
    public record ImportCourse(
            @NotBlank(message = "课程标识不能为空")
            @Size(max = 40, message = "课程标识最长 40 个字符")
            String ref,

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
            String color) {
    }

    /** 一条课表。courseId 与 courseRef 必须且只能给一个。 */
    public record ImportSchedule(
            Long courseId,

            @Size(max = 40, message = "课程标识最长 40 个字符")
            String courseRef,

            @NotNull(message = "星期不能为空")
            @Min(value = 1, message = "星期取值范围是 1（周一）到 7（周日）")
            @Max(value = 7, message = "星期取值范围是 1（周一）到 7（周日）")
            Integer weekday,

            @NotNull(message = "开始时间不能为空")
            LocalTime startTime,

            @NotNull(message = "结束时间不能为空")
            LocalTime endTime,

            @Size(max = 128, message = "上课地点最长 128 个字符")
            String location,

            @Min(value = 1, message = "起始节次最小为 1")
            @Max(value = 12, message = "起始节次最大为 12")
            Integer periodStart,

            @Min(value = 1, message = "结束节次最小为 1")
            @Max(value = 12, message = "结束节次最大为 12")
            Integer periodEnd,

            @Size(max = 32, message = "教学周范围最长 32 个字符")
            String weekRange,

            LocalDate semesterStartDate,

            @Min(value = 1, message = "起始周最小为 1")
            @Max(value = 53, message = "起始周最大为 53")
            Integer startWeek,

            @Min(value = 1, message = "结束周最小为 1")
            @Max(value = 53, message = "结束周最大为 53")
            Integer endWeek,

            @Size(max = 8, message = "上课周次规律非法")
            String weekPattern) {
    }
}
