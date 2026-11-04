package com.ddlmate.service;

import java.util.ArrayList;
import java.util.List;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.Attachment;
import com.ddlmate.domain.Task;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.repository.AttachmentRepository;
import com.ddlmate.repository.TaskSourceRepository;
import com.ddlmate.web.dto.TaskSourceRequest;
import com.ddlmate.web.dto.TaskSourceResponse;

/**
 * 原通知（需求里的 M 功能）：保存老师原话 + 来源名 + 原图，随时可追溯。
 */
@Service
public class SourceService {

    private final TaskSourceRepository sourceRepository;

    private final AttachmentRepository attachmentRepository;

    private final TaskService taskService;

    private final StorageService storageService;

    public SourceService(TaskSourceRepository sourceRepository, AttachmentRepository attachmentRepository,
            TaskService taskService, StorageService storageService) {
        this.sourceRepository = sourceRepository;
        this.attachmentRepository = attachmentRepository;
        this.taskService = taskService;
        this.storageService = storageService;
    }

    @Transactional(readOnly = true)
    public List<TaskSourceResponse> listByTask(Long taskId) {
        taskService.require(taskId);
        return toResponses(sourceRepository.findByTaskIdWithAttachments(taskId));
    }

    @Transactional(readOnly = true)
    public List<TaskSourceResponse> listAll() {
        List<TaskSourceResponse> result = new ArrayList<>();
        for (TaskSource source : sourceRepository.findAllByOrderByCreatedAtDesc()) {
            result.add(ApiMapper.source(source));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public TaskSource require(Long id) {
        return sourceRepository.findById(id)
                .orElseThrow(() -> new ResourceNotFoundException("原通知", id));
    }

    @Transactional(readOnly = true)
    public TaskSourceResponse get(Long id) {
        TaskSource source = require(id);
        source.getAttachments().size();
        return ApiMapper.source(source);
    }

    /** 给指定任务新建一条原通知。 */
    @Transactional
    public TaskSourceResponse createForTask(Long taskId, TaskSourceRequest request) {
        Task task = taskService.require(taskId);
        TaskSource source = new TaskSource(request.sourceName().trim(), blankToNull(request.rawText()));
        source.setSourceType(blankToNull(request.sourceType()));
        source.setCapturedAt(request.capturedAt() == null ? TimeZones.now() : request.capturedAt());
        source.setTask(task);
        return ApiMapper.source(sourceRepository.save(source));
    }

    /** 不带任务的暂存原通知：为 V1.1「批量截图先入库、人工确认后再绑定任务」预留。 */
    @Transactional
    public TaskSourceResponse createDraft(TaskSourceRequest request) {
        TaskSource source = new TaskSource(request.sourceName().trim(), blankToNull(request.rawText()));
        source.setSourceType(blankToNull(request.sourceType()));
        source.setCapturedAt(request.capturedAt() == null ? TimeZones.now() : request.capturedAt());
        return ApiMapper.source(sourceRepository.save(source));
    }

    /**
     * 删除原通知及其附件。
     *
     * <p>磁盘文件在**事务提交成功后**才删除：如果事务回滚，图片仍留在磁盘上，
     * 不会出现"数据库记录还在、文件已丢失"的情况。</p>
     */
    @Transactional
    public void delete(Long id) {
        TaskSource source = require(id);
        List<String> paths = new ArrayList<>();
        for (Attachment attachment : source.getAttachments()) {
            paths.add(attachment.getRelativePath());
        }
        sourceRepository.delete(source);
        registerAfterCommitFileDeletion(paths);
    }

    /** 事务提交后再删磁盘文件；没有活跃事务时立即删除。 */
    private void registerAfterCommitFileDeletion(List<String> relativePaths) {
        if (relativePaths.isEmpty()) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            for (String path : relativePaths) {
                storageService.deleteByRelativePath(path);
            }
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                for (String path : relativePaths) {
                    storageService.deleteByRelativePath(path);
                }
            }
        });
    }

    @Transactional
    public void bindToTask(Long sourceId, Long taskId) {
        TaskSource source = require(sourceId);
        source.setTask(taskService.require(taskId));
        sourceRepository.save(source);
    }

    @Transactional
    public void unbind(Long sourceId) {
        TaskSource source = require(sourceId);
        source.setTask(null);
        sourceRepository.save(source);
    }

    @Transactional
    public Attachment requireAttachment(Long attachmentId) {
        return attachmentRepository.findByIdWithSource(attachmentId)
                .orElseThrow(() -> new ResourceNotFoundException("附件", attachmentId));
    }

    private List<TaskSourceResponse> toResponses(List<TaskSource> sources) {
        List<TaskSourceResponse> result = new ArrayList<>(sources.size());
        for (TaskSource source : sources) {
            result.add(ApiMapper.source(source));
        }
        return result;
    }

    private String blankToNull(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
