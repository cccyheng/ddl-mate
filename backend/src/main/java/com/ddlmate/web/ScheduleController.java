package com.ddlmate.web;

import java.net.URI;
import java.time.LocalDate;
import java.util.List;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.ScheduleService;
import com.ddlmate.web.dto.CourseScheduleRequest;
import com.ddlmate.web.dto.CourseScheduleResponse;
import com.ddlmate.web.dto.ScheduleImportRequest;
import com.ddlmate.web.dto.ScheduleImportResponse;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api")
public class ScheduleController {

    private final ScheduleService scheduleService;

    public ScheduleController(ScheduleService scheduleService) {
        this.scheduleService = scheduleService;
    }

    /**
     * 全部课表，前端"课程表"页使用。
     *
     * @param weekday 可选，按星期过滤（1=周一 … 7=周日）
     * @param date    可选，按"这一天是否上课"过滤（教学周 + 单双周规则生效）
     */
    @GetMapping("/schedules")
    public List<CourseScheduleResponse> list(@RequestParam(required = false) Integer weekday,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return scheduleService.list(weekday, date);
    }

    /** 今日课程（教学周 + 单双周规则生效）。 */
    @GetMapping("/schedules/today")
    public List<CourseScheduleResponse> today() {
        return scheduleService.today();
    }

    /** 指定日期实际要上的课，日期详情页使用。 */
    @GetMapping("/schedules/by-date")
    public List<CourseScheduleResponse> byDate(
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return scheduleService.occurringOn(date);
    }

    /** 批量导入课表（照片导入确认后）：新建课程与课表在同一事务内完成。 */
    @PostMapping("/schedules/import")
    public ResponseEntity<ScheduleImportResponse> importBatch(@Valid @RequestBody ScheduleImportRequest request) {
        ScheduleImportResponse result = scheduleService.importBatch(request);
        return ResponseEntity.created(URI.create("/api/schedules")).body(result);
    }

    @GetMapping("/courses/{courseId}/schedules")
    public List<CourseScheduleResponse> listByCourse(@PathVariable Long courseId) {
        return scheduleService.listByCourse(courseId);
    }

    @PostMapping("/courses/{courseId}/schedules")
    public ResponseEntity<CourseScheduleResponse> create(@PathVariable Long courseId,
            @Valid @RequestBody CourseScheduleRequest request) {
        CourseScheduleResponse created = scheduleService.create(courseId, request);
        return ResponseEntity.created(URI.create("/api/courses/" + courseId + "/schedules/" + created.id()))
                .body(created);
    }

    @PutMapping("/courses/{courseId}/schedules/{scheduleId}")
    public CourseScheduleResponse update(@PathVariable Long courseId, @PathVariable Long scheduleId,
            @Valid @RequestBody CourseScheduleRequest request) {
        return scheduleService.update(courseId, scheduleId, request);
    }

    @DeleteMapping("/courses/{courseId}/schedules/{scheduleId}")
    public ResponseEntity<Void> delete(@PathVariable Long courseId, @PathVariable Long scheduleId) {
        scheduleService.delete(courseId, scheduleId);
        return ResponseEntity.noContent().build();
    }
}
