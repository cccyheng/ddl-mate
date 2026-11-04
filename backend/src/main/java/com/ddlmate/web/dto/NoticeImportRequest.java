package com.ddlmate.web.dto;

import java.time.OffsetDateTime;
import java.util.List;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 「通知 → 待办」批量导入请求。
 *
 * <p>结构上把「来源」与「任务候选」分开：</p>
 * <ul>
 *   <li>{@code sources}：原通知（粘贴的文字 / 图片 OCR 原文），前端用 {@code sourceRef} 引用；</li>
 *   <li>{@code attachments}：图片在 multipart 请求里的下标 + 原始文件名，
 *       再通过来源声明自己引用哪些图片；</li>
 *   <li>{@code tasks}：要真正写入的任务候选，必须引用至少一个来源。</li>
 * </ul>
 *
 * <p>导入阶段只是"确认后的落库"：任务候选由前端（本地 OCR + 保守规则）生成，后端不调用任何外部模型。
 * 只有被任务引用的来源与图片会被写库；没被引用的候选不落库。</p>
 */
public record NoticeImportRequest(
        @NotNull(message = "来源列表不能为空")
        @Size(max = 12, message = "一次最多 12 个来源")
        @Valid
        List<SourceSpec> sources,

        @Size(max = 8, message = "一次最多 8 张图片")
        @Valid
        List<AttachmentSpec> attachments,

        @NotNull(message = "任务候选列表不能为空")
        @Size(max = 30, message = "一次最多导入 30 条任务候选")
        @Valid
        List<TaskSpec> tasks) {

    /** 一条原通知。sourceRef 仅在本请求内有效，不会入库。 */
    public record SourceSpec(
            @NotBlank(message = "来源标识不能为空")
            @Size(max = 40, message = "来源标识最长 40 个字符")
            String sourceRef,

            @NotBlank(message = "来源名称不能为空")
            @Size(max = 128, message = "来源名称最长 128 个字符")
            String sourceName,

            @Size(max = 32, message = "来源类型最长 32 个字符")
            String sourceType,

            @Size(max = 4000, message = "原通知文字最长 4000 个字符")
            String rawText,

            OffsetDateTime capturedAt,

            /** 本来源引用的图片下标（对应 multipart 里 files 的顺序），可为空。 */
            List<Integer> attachmentIndexes) {
    }

    /** 一张待保存的原通知图片。bytes 来自 multipart，下标从 0 开始。 */
    public record AttachmentSpec(
            @NotNull(message = "图片下标不能为空")
            Integer fileIndex,

            @Size(max = 255, message = "原始文件名最长 255 个字符")
            String originalName) {
    }

    /** 一条要写入的任务候选。 */
    public record TaskSpec(
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

            OffsetDateTime deadline,

            @Size(max = 500, message = "提交要求最长 500 个字符")
            String submitRequirement,

            @Size(max = 128, message = "提交方式最长 128 个字符")
            String submitMethod,

            @NotNull(message = "任务必须关联至少一个来源")
            @Size(min = 1, max = 12, message = "任务必须关联 1-12 个来源")
            List<@NotBlank(message = "来源标识不能为空") String> sourceRefs) {
    }
}
