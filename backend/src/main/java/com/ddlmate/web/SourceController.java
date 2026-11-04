package com.ddlmate.web;

import java.net.URI;
import java.util.List;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.service.AttachmentService;
import com.ddlmate.service.SourceService;
import com.ddlmate.web.dto.AttachmentResponse;
import com.ddlmate.web.dto.TaskSourceRequest;
import com.ddlmate.web.dto.TaskSourceResponse;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api")
public class SourceController {

    private final SourceService sourceService;

    private final AttachmentService attachmentService;

    public SourceController(SourceService sourceService, AttachmentService attachmentService) {
        this.sourceService = sourceService;
        this.attachmentService = attachmentService;
    }

    @GetMapping("/tasks/{taskId}/sources")
    public List<TaskSourceResponse> listByTask(@PathVariable Long taskId) {
        return sourceService.listByTask(taskId);
    }

    @PostMapping("/tasks/{taskId}/sources")
    public ResponseEntity<TaskSourceResponse> create(@PathVariable Long taskId,
            @Valid @RequestBody TaskSourceRequest request) {
        TaskSourceResponse created = sourceService.createForTask(taskId, request);
        return ResponseEntity.created(URI.create("/api/sources/" + created.id())).body(created);
    }

    /** 暂存原通知（暂不绑定任务），为 V1.1 批量截图确认流程预留。 */
    @GetMapping("/sources")
    public List<TaskSourceResponse> listAll() {
        return sourceService.listAll();
    }

    @PostMapping("/sources")
    public ResponseEntity<TaskSourceResponse> createDraft(@Valid @RequestBody TaskSourceRequest request) {
        TaskSourceResponse created = sourceService.createDraft(request);
        return ResponseEntity.created(URI.create("/api/sources/" + created.id())).body(created);
    }

    @GetMapping("/sources/{id}")
    public TaskSourceResponse get(@PathVariable Long id) {
        return sourceService.get(id);
    }

    @DeleteMapping("/sources/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        sourceService.delete(id);
        return ResponseEntity.noContent().build();
    }

    /** 绑定/解绑任务（V1.1 人工确认流程会调用）。 */
    @PostMapping("/sources/{id}/bind")
    public TaskSourceResponse bind(@PathVariable Long id, @RequestParam Long taskId) {
        sourceService.bindToTask(id, taskId);
        return sourceService.get(id);
    }

    /** 上传原通知图片，可一次多张。 */
    @PostMapping(value = "/sources/{id}/attachments", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<List<AttachmentResponse>> upload(@PathVariable Long id,
            @RequestParam("file") List<MultipartFile> files) {
        List<AttachmentResponse> created = attachmentService.upload(id, files);
        return ResponseEntity.created(URI.create("/api/sources/" + id)).body(created);
    }

    // 注意：附件的查看/下载/删除统一由 AttachmentController 提供（/api/attachments/{id}），
    // 这里不再重复声明，否则 Spring 启动时会因重复映射直接失败。
}
