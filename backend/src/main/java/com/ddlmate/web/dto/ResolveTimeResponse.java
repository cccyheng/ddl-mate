package com.ddlmate.web.dto;

import java.util.List;

/**
 * 时间助手解析结果（只读接口的响应）。
 *
 * <p>四种状态互斥，前端据此显示「可直接采用 / 需要补全 / 保守拒绝 / 课表里没有匹配」：</p>
 * <ul>
 *   <li>{@code RESOLVED}：有候选，每个候选都带**明确 +08:00 的 deadline** 与可读理由；</li>
 *   <li>{@code NEEDS_INFO}：说法能认出方向但信息不足（只有日期 / 只有时刻 / 今晚 / 尽快 / 周末 /
 *       多重时间 / 范围 / 缺课程），不猜；</li>
 *   <li>{@code UNSUPPORTED}：否定、延期、更改、需要校历等复杂说法，保守拒绝；</li>
 *   <li>{@code NO_COURSE_MATCH}：课程边界说法成立，但在约定的时间窗口里课表没有匹配（绝不越周硬找）。</li>
 * </ul>
 */
public record ResolveTimeResponse(
        String status,
        String message,
        List<String> hints,
        String referenceAt,
        String referenceLocal,
        String timeZone,
        List<Candidate> candidates) {

    public static final String STATUS_RESOLVED = "RESOLVED";
    public static final String STATUS_NEEDS_INFO = "NEEDS_INFO";
    public static final String STATUS_UNSUPPORTED = "UNSUPPORTED";
    public static final String STATUS_NO_COURSE_MATCH = "NO_COURSE_MATCH";

    /**
     * 一条候选时间。
     *
     * <p>{@code deadline} 一定是带 {@code +08:00} 的 ISO 字符串；课表匹配的候选还会带
     * {@code scheduleId / scheduleDate / scheduleStartTime}，且 {@code note} 明确说明
     * 「按开课时间作为截止边界，不做提前扣减」。</p>
     */
    public record Candidate(
            String deadline,
            String reason,
            String kind,
            boolean past,
            boolean courseBoundary,
            Long courseId,
            String courseName,
            Long scheduleId,
            String scheduleDate,
            String scheduleStartTime,
            String scheduleWeekday,
            String scheduleLocation,
            String note) {
    }
}
