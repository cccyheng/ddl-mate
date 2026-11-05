package com.ddlmate.service;

import java.util.ArrayList;
import java.util.List;

import com.ddlmate.domain.Attachment;
import com.ddlmate.domain.Course;
import com.ddlmate.domain.CourseSchedule;
import com.ddlmate.domain.Task;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.domain.WeekPattern;
import com.ddlmate.web.dto.AttachmentResponse;
import com.ddlmate.web.dto.CourseBrief;
import com.ddlmate.web.dto.CourseResponse;
import com.ddlmate.web.dto.CourseScheduleResponse;
import com.ddlmate.web.dto.TaskResponse;
import com.ddlmate.web.dto.TaskSourceResponse;

/** 实体 → DTO。所有调用都必须发生在事务内部，因为会触发懒加载。 */
public final class ApiMapper {

    private ApiMapper() {
    }

    public static CourseBrief brief(Course course) {
        if (course == null) {
            return null;
        }
        return new CourseBrief(course.getId(), course.getCode(), course.getName(), course.getColor());
    }

    public static CourseResponse course(Course course, long taskCount, long scheduleCount) {
        return new CourseResponse(
                course.getId(),
                course.getCode(),
                course.getName(),
                course.getInstructor(),
                course.getSemester(),
                course.getColor(),
                course.getNote(),
                taskCount,
                scheduleCount,
                course.getCreatedAt(),
                course.getUpdatedAt());
    }

    public static CourseScheduleResponse schedule(CourseSchedule schedule) {
        Course course = schedule.getCourse();
        WeekPattern pattern = schedule.getWeekPattern() == null ? WeekPattern.ALL : schedule.getWeekPattern();
        return new CourseScheduleResponse(
                schedule.getId(),
                course == null ? null : course.getId(),
                course == null ? null : course.getName(),
                course == null ? null : course.getCode(),
                course == null ? null : course.getColor(),
                schedule.getWeekday(),
                Enums.weekdayLabel(schedule.getWeekday()),
                schedule.getStartTime(),
                schedule.getEndTime(),
                schedule.getLocation(),
                schedule.getTeacher(),
                schedule.getPeriodStart(),
                schedule.getPeriodEnd(),
                schedule.getWeekRange(),
                schedule.getSemesterStartDate(),
                schedule.getStartWeek(),
                schedule.getEndWeek(),
                pattern.name(),
                pattern.getLabel(),
                weekSummary(schedule, pattern),
                schedule.hasTeachingWeeks(),
                schedule.getCreatedAt(),
                schedule.getUpdatedAt());
    }

    /** 教学周中文摘要：配置齐全时给出「起-止 周 · 规律」，否则明确说明未设置。 */
    private static String weekSummary(CourseSchedule schedule, WeekPattern pattern) {
        if (!schedule.hasTeachingWeeks()) {
            if (schedule.getWeekRange() != null && !schedule.getWeekRange().isBlank()) {
                return "第 " + schedule.getWeekRange() + " 周（文字，未启用过滤）";
            }
            return "未设置教学周（按每周显示）";
        }
        return "第 " + schedule.getStartWeek() + "-" + schedule.getEndWeek() + " 周 · " + pattern.getLabel();
    }

    public static TaskResponse task(Task task, long sourceCount, List<Attachment> attachments) {
        List<AttachmentResponse> attachmentResponses = new ArrayList<>();
        if (attachments != null) {
            for (Attachment attachment : attachments) {
                attachmentResponses.add(attachment(attachment));
            }
        }
        return new TaskResponse(
                task.getId(),
                task.getTitle(),
                task.getDescription(),
                brief(task.getCourse()),
                task.getType().name(),
                task.getType().getLabel(),
                task.getStatus().name(),
                task.getStatus().getLabel(),
                task.getPriority().getLevel(),
                task.getPriority().getLabel(),
                task.getDeadline(),
                task.getEstimatedMinutes(),
                task.getSubmitRequirement(),
                task.getSubmitMethod(),
                task.getCompletedAt(),
                task.getCreatedAt(),
                task.getUpdatedAt(),
                sourceCount,
                attachmentResponses);
    }

    public static TaskSourceResponse source(TaskSource source) {
        List<AttachmentResponse> attachments = new ArrayList<>();
        for (Attachment attachment : source.getAttachments()) {
            attachments.add(attachment(attachment));
        }
        Task task = source.getTask();
        return new TaskSourceResponse(
                source.getId(),
                task == null ? null : task.getId(),
                task == null ? null : task.getTitle(),
                source.getSourceName(),
                source.getSourceType(),
                source.getRawText(),
                source.getCapturedAt(),
                source.getCreatedAt(),
                attachments);
    }

    public static AttachmentResponse attachment(Attachment attachment) {
        TaskSource source = attachment.getTaskSource();
        return new AttachmentResponse(
                attachment.getId(),
                source == null ? null : source.getId(),
                source == null || source.getTask() == null ? null : source.getTask().getId(),
                attachment.getOriginalName(),
                attachment.getContentType(),
                attachment.getSizeBytes(),
                attachment.getCreatedAt(),
                "/api/attachments/" + attachment.getId(),
                "/api/attachments/" + attachment.getId() + "?download=true");
    }
}
