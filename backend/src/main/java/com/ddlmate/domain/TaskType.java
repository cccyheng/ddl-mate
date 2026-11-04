package com.ddlmate.domain;

/** 任务类型。 */
public enum TaskType {
    HOMEWORK("作业"),
    LAB("实验"),
    REPORT("报告"),
    PROJECT("课程设计"),
    EXAM("考试"),
    PRESENTATION("展示/答辩"),
    READING("阅读"),
    OTHER("其他");

    private final String label;

    TaskType(String label) {
        this.label = label;
    }

    public String getLabel() {
        return label;
    }
}
