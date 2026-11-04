package com.ddlmate.web.dto;

import java.util.List;

/**
 * 「通知 → 待办」批量导入结果。
 *
 * <p>{@code createdTaskIds} 是真实写入的任务 id，前端确认后可以直接跳转任务详情；
 * {@code notices} 用于说明被忽略的来源（例如没有任务引用它）。</p>
 */
public record NoticeImportResponse(
        int createdTasks,
        int createdSources,
        int createdAttachments,
        List<Long> createdTaskIds,
        List<TaskResponse> tasks,
        List<TaskSourceResponse> sources,
        List<AttachmentResponse> attachments,
        List<String> notices) {
}
