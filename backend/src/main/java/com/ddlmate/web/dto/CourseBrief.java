package com.ddlmate.web.dto;

/** 课程精简信息，内嵌在任务、课表响应里。 */
public record CourseBrief(Long id, String code, String name, String color) {
}
