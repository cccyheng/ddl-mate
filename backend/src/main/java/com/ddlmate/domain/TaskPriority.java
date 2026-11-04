package com.ddlmate.domain;

/** 优先级，1 最低、5 最高；默认 3。 */
public enum TaskPriority {
    LOWEST(1, "最低"),
    LOW(2, "较低"),
    NORMAL(3, "普通"),
    HIGH(4, "较高"),
    URGENT(5, "紧急");

    private final int level;

    private final String label;

    TaskPriority(int level, String label) {
        this.level = level;
        this.label = label;
    }

    public int getLevel() {
        return level;
    }

    public String getLabel() {
        return label;
    }

    public static TaskPriority fromLevel(Integer level) {
        if (level == null) {
            return NORMAL;
        }
        for (TaskPriority value : values()) {
            if (value.level == level) {
                return value;
            }
        }
        throw new IllegalArgumentException("优先级必须是 1-5，实际：" + level);
    }
}
