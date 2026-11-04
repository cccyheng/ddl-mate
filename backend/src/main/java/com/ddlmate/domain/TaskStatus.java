package com.ddlmate.domain;

/** 任务状态。 */
public enum TaskStatus {
    TODO("未开始"),
    DOING("进行中"),
    DONE("已完成"),
    ARCHIVED("已归档");

    private final String label;

    TaskStatus(String label) {
        this.label = label;
    }

    public String getLabel() {
        return label;
    }

    /** 已完成/已归档的任务默认不出现在 DDL 列表与今日任务中。 */
    public boolean isClosed() {
        return this == DONE || this == ARCHIVED;
    }
}
