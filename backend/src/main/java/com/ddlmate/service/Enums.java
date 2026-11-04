package com.ddlmate.service;

import java.util.Arrays;
import java.util.Locale;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.domain.TaskPriority;
import com.ddlmate.domain.TaskStatus;
import com.ddlmate.domain.TaskType;

/** 字符串 → 枚举的安全解析，非法值统一抛 400。 */
public final class Enums {

    private Enums() {
    }

    public static TaskType taskType(String raw, TaskType defaultValue) {
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        return parse(TaskType.class, raw, "任务类型");
    }

    public static TaskStatus taskStatus(String raw, TaskStatus defaultValue) {
        if (raw == null || raw.isBlank()) {
            return defaultValue;
        }
        return parse(TaskStatus.class, raw, "任务状态");
    }

    public static TaskPriority taskPriority(Integer level) {
        if (level == null) {
            return TaskPriority.NORMAL;
        }
        try {
            return TaskPriority.fromLevel(level);
        } catch (IllegalArgumentException ex) {
            throw new InvalidRequestException("priority", "优先级必须是 1-5 之间的整数");
        }
    }

    private static <E extends Enum<E>> E parse(Class<E> type, String raw, String label) {
        String normalized = raw.trim().toUpperCase(Locale.ROOT);
        try {
            return Enum.valueOf(type, normalized);
        } catch (IllegalArgumentException ex) {
            throw new InvalidRequestException(label + "非法：" + raw + "，可选值：" + Arrays.toString(type.getEnumConstants()));
        }
    }

    /** 星期标签，1=周一。 */
    public static String weekdayLabel(Integer weekday) {
        if (weekday == null) {
            return "";
        }
        return switch (weekday) {
            case 1 -> "周一";
            case 2 -> "周二";
            case 3 -> "周三";
            case 4 -> "周四";
            case 5 -> "周五";
            case 6 -> "周六";
            case 7 -> "周日";
            default -> "未知";
        };
    }
}
