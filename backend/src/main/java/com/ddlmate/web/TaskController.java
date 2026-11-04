package com.ddlmate.web;

import java.net.URI;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;

import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.service.Enums;
import com.ddlmate.service.NoticeImportService;
import com.ddlmate.service.TaskService;
import com.ddlmate.service.TimeResolveService;
import com.ddlmate.web.dto.CalendarMonthResponse;
import com.ddlmate.web.dto.NoticeImportRequest;
import com.ddlmate.web.dto.NoticeImportResponse;
import com.ddlmate.web.dto.PageResponse;
import com.ddlmate.web.dto.ResolveTimeRequest;
import com.ddlmate.web.dto.ResolveTimeResponse;
import com.ddlmate.web.dto.TaskPatchRequest;
import com.ddlmate.web.dto.TaskRequest;
import com.ddlmate.web.dto.TaskResponse;
import com.ddlmate.web.dto.TaskStatsResponse;
import com.ddlmate.web.dto.TaskStatusRequest;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/tasks")
public class TaskController {

    private final TaskService taskService;

    private final NoticeImportService noticeImportService;

    private final TimeResolveService timeResolveService;

    public TaskController(TaskService taskService, NoticeImportService noticeImportService,
            TimeResolveService timeResolveService) {
        this.taskService = taskService;
        this.noticeImportService = noticeImportService;
        this.timeResolveService = timeResolveService;
    }

    /** 任务列表：筛选 + 排序 + 分页。默认按 DDL 升序，默认隐藏已完成。 */
    @GetMapping
    public PageResponse<TaskResponse> list(
            @RequestParam(required = false) Long courseId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) Integer priority,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime dueFrom,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) OffsetDateTime dueTo,
            @RequestParam(required = false) Boolean includeDone,
            @RequestParam(required = false) Boolean overdueOnly,
            @RequestParam(required = false, defaultValue = "0") Integer page,
            @RequestParam(required = false, defaultValue = "20") Integer size,
            @RequestParam(required = false, defaultValue = "deadline") String sort,
            @RequestParam(required = false, defaultValue = "asc") String direction) {
        return taskService.search(TaskService.TaskQuery.of(courseId, status, type, priority, keyword, dueFrom, dueTo,
                includeDone, page, size, sort, direction, overdueOnly));
    }

    /** DDL 排序列表（逾期在前）。 */
    @GetMapping("/deadlines")
    public List<TaskResponse> deadlines(
            @RequestParam(required = false, defaultValue = "deadline") String sort,
            @RequestParam(required = false, defaultValue = "asc") String direction,
            @RequestParam(required = false) Long courseId,
            @RequestParam(required = false, defaultValue = "false") boolean includeDone) {
        return taskService.deadlines(sort, direction, courseId, includeDone);
    }

    /** 今日任务：今天截止的 + 已逾期未完成的。 */
    @GetMapping("/today")
    public List<TaskResponse> today() {
        return taskService.today();
    }

    /** 按月查询，返回按日期分组的任务（前端日历用）。 */
    @GetMapping("/calendar")
    public CalendarMonthResponse calendar(@RequestParam int year, @RequestParam int month) {
        return taskService.calendar(year, month);
    }

    /** 按日期查询。 */
    @GetMapping("/by-date")
    public List<TaskResponse> byDate(@RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
        return taskService.byDate(date);
    }

    /** 首页概览统计。 */
    @GetMapping("/stats")
    public TaskStatsResponse stats() {
        return taskService.stats();
    }

    /**
     * V1.2 时间助手：把简短时间短语解析成明确时间（可选结合课程课表）。
     *
     * <p><strong>只读</strong>：不会创建 / 修改任何任务、课程或课表，也不落任何解析日志。
     * 响应区分 {@code RESOLVED / NEEDS_INFO / UNSUPPORTED / NO_COURSE_MATCH}，
     * 具体支持范围见 {@code docs/v1.2-time-assistant.md}。</p>
     */
    @PostMapping("/resolve-time")
    public ResolveTimeResponse resolveTime(@Valid @RequestBody ResolveTimeRequest request) {
        return timeResolveService.resolve(request);
    }

    @GetMapping("/{id}")
    public TaskResponse get(@PathVariable Long id) {
        return taskService.get(id);
    }

    @PostMapping
    public ResponseEntity<TaskResponse> create(@Valid @RequestBody TaskRequest request) {
        TaskResponse created = taskService.create(request);
        return ResponseEntity.created(URI.create("/api/tasks/" + created.id())).body(created);
    }

    /**
     * 「通知截图 / 文字 → 待办」批量导入：一次请求里创建 任务 + 原通知 + 原图附件。
     *
     * <p>任务候选由前端在浏览器里用本地 OCR + 保守规则生成、经用户确认后提交；
     * 后端只做校验与落库，**不调用任何外部模型**。整个导入在同一个事务里完成：
     * 任何候选不合法都整体不写入，已经落盘的图片也会被清理。</p>
     *
     * <p>请求体是 {@code multipart/form-data}：{@code notice} 部分是 JSON（UTF-8），
     * {@code files} 部分可重复出现，下标与 JSON 里的 {@code sourceRefs/attachmentIndexes} 对应；
     * 不传文件也合法（只保存粘贴的文字）。</p>
     */
    @PostMapping(value = "/import-notices", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<NoticeImportResponse> importNotices(
            @Valid @RequestPart("notice") NoticeImportRequest request,
            @RequestPart(value = "files", required = false) List<MultipartFile> files) {
        NoticeImportResponse created = noticeImportService.importNotices(request, files);
        return ResponseEntity.created(URI.create("/api/tasks/import-notices")).body(created);
    }

    /** 全量更新。 */
    @PutMapping(value = "/{id}", params = "!patch")
    public TaskResponse update(@PathVariable Long id, @Valid @RequestBody TaskRequest request) {
        return taskService.update(id, request);
    }

    /** 局部更新：只改传入的字段；clearCourse / clearDeadline 用于显式清空。 */
    @PatchMapping("/{id}")
    public TaskResponse patch(@PathVariable Long id, @Valid @RequestBody TaskPatchRequest request) {
        return taskService.patch(id, request);
    }

    /** 状态切换。 */
    @PatchMapping("/{id}/status")
    public TaskResponse changeStatus(@PathVariable Long id, @Valid @RequestBody TaskStatusRequest request) {
        return taskService.changeStatus(id, Enums.taskStatus(request.status(), null));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        taskService.delete(id);
        return ResponseEntity.noContent().build();
    }
}
