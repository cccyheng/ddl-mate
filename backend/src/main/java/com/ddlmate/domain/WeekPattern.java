package com.ddlmate.domain;

/** 教学周的上课规律：每周 / 单周 / 双周。判断依据是"教学周序号"的奇偶，不是日期的奇偶。 */
public enum WeekPattern {
    ALL("每周"),
    ODD("单周"),
    EVEN("双周");

    private final String label;

    WeekPattern(String label) {
        this.label = label;
    }

    public String getLabel() {
        return label;
    }

    /** 未知/null 一律按"每周"处理，兼容旧数据。 */
    public static WeekPattern fromNullable(String raw) {
        if (raw == null || raw.isBlank()) {
            return ALL;
        }
        for (WeekPattern value : values()) {
            if (value.name().equalsIgnoreCase(raw.trim())) {
                return value;
            }
        }
        throw new IllegalArgumentException("上课周次规律非法：" + raw + "，可选值：ALL（每周）、ODD（单周）、EVEN（双周）");
    }
}
