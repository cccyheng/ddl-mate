package com.ddlmate.domain;

import java.time.LocalTime;
import java.time.OffsetDateTime;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.TenantId;
import org.hibernate.annotations.UpdateTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/**
 * 课表节次：某门课"每周几、几点到几点、在哪"。
 *
 * <p>weekday 使用 ISO-8601：1=周一 … 7=周日（与前端日历一致）。
 * startTime/endTime 是本地墙钟时间，不含日期与时区。</p>
 */
@Entity
@Table(name = "course_schedules")
public class CourseSchedule {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** 数据归属的用户（app_users.id）。由 Hibernate 按当前登录用户自动写入并在所有查询里过滤。 */
    @TenantId
    @Column(name = "owner_id", updatable = false)
    private Long ownerId;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "course_id", nullable = false, foreignKey = @jakarta.persistence.ForeignKey(name = "fk_schedule_course"))
    private Course course;

    @Column(name = "weekday", nullable = false)
    private Integer weekday;

    @Column(name = "start_time", nullable = false)
    private LocalTime startTime;

    @Column(name = "end_time", nullable = false)
    private LocalTime endTime;

    @Column(name = "location", length = 128)
    private String location;

    /** 第几节开始，如 3。仅作展示，真实时间以 startTime 为准。 */
    @Column(name = "period_start")
    private Integer periodStart;

    @Column(name = "period_end")
    private Integer periodEnd;

    /** 教学周范围，如 "1-16"。仅作展示，真实过滤以 startWeek/endWeek 为准。 */
    @Column(name = "week_range", length = 32)
    private String weekRange;

    /**
     * 学期第一周周一（必须为周一）。为 null 表示该记录没有教学周信息（旧数据），
     * 此时不做教学周过滤，按"每周都上"展示。
     */
    @Column(name = "semester_start_date")
    private java.time.LocalDate semesterStartDate;

    /** 起始教学周（1-53），可为 null（兼容旧数据）。 */
    @Column(name = "start_week")
    private Integer startWeek;

    /** 结束教学周（1-53），可为 null（兼容旧数据）。 */
    @Column(name = "end_week")
    private Integer endWeek;

    /** 上课周次规律：ALL（每周）/ ODD（单周）/ EVEN（双周），null 视为 ALL。 */
    @Enumerated(EnumType.STRING)
    @Column(name = "week_pattern", length = 8)
    private WeekPattern weekPattern;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected CourseSchedule() {
    }

    public CourseSchedule(Course course, Integer weekday, LocalTime startTime, LocalTime endTime) {
        this.course = course;
        this.weekday = weekday;
        this.startTime = startTime;
        this.endTime = endTime;
    }

    public Long getId() {
        return id;
    }

    public Course getCourse() {
        return course;
    }

    public void setCourse(Course course) {
        this.course = course;
    }

    public Integer getWeekday() {
        return weekday;
    }

    public void setWeekday(Integer weekday) {
        this.weekday = weekday;
    }

    public LocalTime getStartTime() {
        return startTime;
    }

    public void setStartTime(LocalTime startTime) {
        this.startTime = startTime;
    }

    public LocalTime getEndTime() {
        return endTime;
    }

    public void setEndTime(LocalTime endTime) {
        this.endTime = endTime;
    }

    public String getLocation() {
        return location;
    }

    public void setLocation(String location) {
        this.location = location;
    }

    public Integer getPeriodStart() {
        return periodStart;
    }

    public void setPeriodStart(Integer periodStart) {
        this.periodStart = periodStart;
    }

    public Integer getPeriodEnd() {
        return periodEnd;
    }

    public void setPeriodEnd(Integer periodEnd) {
        this.periodEnd = periodEnd;
    }

    public String getWeekRange() {
        return weekRange;
    }

    public void setWeekRange(String weekRange) {
        this.weekRange = weekRange;
    }

    public java.time.LocalDate getSemesterStartDate() {
        return semesterStartDate;
    }

    public void setSemesterStartDate(java.time.LocalDate semesterStartDate) {
        this.semesterStartDate = semesterStartDate;
    }

    public Integer getStartWeek() {
        return startWeek;
    }

    public void setStartWeek(Integer startWeek) {
        this.startWeek = startWeek;
    }

    public Integer getEndWeek() {
        return endWeek;
    }

    public void setEndWeek(Integer endWeek) {
        this.endWeek = endWeek;
    }

    public WeekPattern getWeekPattern() {
        return weekPattern;
    }

    public void setWeekPattern(WeekPattern weekPattern) {
        this.weekPattern = weekPattern;
    }

    /** 是否配置了教学周过滤（三者齐全才生效）。 */
    public boolean hasTeachingWeeks() {
        return semesterStartDate != null && startWeek != null && endWeek != null;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public Long getOwnerId() {
        return ownerId;
    }
}
