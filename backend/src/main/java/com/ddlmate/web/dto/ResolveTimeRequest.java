package com.ddlmate.web.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 时间助手解析请求（**只读**，不会写库）。
 *
 * <p>{@code text} 是用户在时间助手里输入的**简短时间短语**，不是整段通知：</p>
 * <ul>
 *   <li>支持：今天 / 明天 / 后天 / 本周X / 这周X / 下周X + 明确时刻、精确日期 {@code YYYY-MM-DD HH:mm}、
 *       「下节课前 / 下周这门课前 / 下周五上课前」这类课程边界说法（需要 {@code courseId}）；</li>
 *   <li>只有日期、只有时刻、今晚、尽快、周末、范围、多重时间等一律返回「需要补信息」，绝不补 23:59。</li>
 * </ul>
 *
 * <p>{@code referenceAt} 必须是**带偏移量的明确时间**（例如 {@code 2026-10-10T12:00:00+08:00}）；
 * 不带偏移量的一律 400，避免把「今天」算到错误的自然日。这里刻意用 String 接收，
 * 就是为了能把「缺偏移量」和「格式非法」区分成两种可读的 400 提示（见 {@code TimeResolveService}）。</p>
 */
public record ResolveTimeRequest(
        @NotBlank(message = "时间短语不能为空")
        @Size(max = 500, message = "时间短语最长 500 个字符")
        String text,

        @NotBlank(message = "参考时间不能为空")
        @Size(max = 64, message = "参考时间格式非法")
        String referenceAt,

        Long courseId) {
}
