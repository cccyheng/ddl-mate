package com.ddlmate.web.dto;

import java.util.List;

/** 首页概览统计。 */
public record TaskStatsResponse(
        long total,
        long open,
        long overdue,
        long dueToday,
        long dueIn7Days,
        long completed,
        long withoutDeadline,
        List<StatusCount> byStatus,
        List<TypeCount> byType) {

    public record StatusCount(String status, String label, long count) {
    }

    public record TypeCount(String type, String label, long count) {
    }
}
