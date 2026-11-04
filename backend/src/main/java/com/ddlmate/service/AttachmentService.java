package com.ddlmate.service;

import java.util.ArrayList;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.multipart.MultipartFile;

import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.FileStorageException;
import com.ddlmate.common.ResourceNotFoundException;
import com.ddlmate.domain.Attachment;
import com.ddlmate.domain.TaskSource;
import com.ddlmate.repository.AttachmentRepository;
import com.ddlmate.repository.TaskSourceRepository;
import com.ddlmate.web.dto.AttachmentResponse;

@Service
public class AttachmentService {

    private static final Logger log = LoggerFactory.getLogger(AttachmentService.class);

    private final AttachmentRepository attachmentRepository;

    private final TaskSourceRepository sourceRepository;

    private final SourceService sourceService;

    private final StorageService storageService;

    public AttachmentService(AttachmentRepository attachmentRepository, TaskSourceRepository sourceRepository,
            SourceService sourceService, StorageService storageService) {
        this.attachmentRepository = attachmentRepository;
        this.sourceRepository = sourceRepository;
        this.sourceService = sourceService;
        this.storageService = storageService;
    }

    /**
     * 给原通知上传一张或多张图片。
     *
     * <p>要点：</p>
     * <ol>
     *   <li>先把元数据 flush 到数据库拿到自增 ID，再构造响应，保证响应里的 id 与下载 URL 立即可用；</li>
     *   <li>过程中任何一步失败（校验不通过、磁盘写失败、数据库回滚），
     *       都会把本次已经写盘的文件全部删掉，并让事务回滚，不留孤儿文件。</li>
     * </ol>
     */
    @Transactional
    public List<AttachmentResponse> upload(Long sourceId, List<MultipartFile> files) {
        if (files == null || files.isEmpty()) {
            throw new FileStorageException(400, ErrorCodes.INVALID_ARGUMENT, "没有收到任何文件");
        }
        TaskSource source = sourceRepository.findById(sourceId)
                .orElseThrow(() -> new ResourceNotFoundException("原通知", sourceId));

        List<Attachment> written = new ArrayList<>(files.size());
        // 已落盘的文件路径：在 store() 成功那一刻就记录，
        // 这样即使随后的 saveAndFlush 失败，也不会留下孤儿文件。
        List<String> writtenPaths = new ArrayList<>(files.size());
        try {
            for (MultipartFile file : files) {
                Attachment attachment = storageService.store(file);
                writtenPaths.add(attachment.getRelativePath());
                // 关键顺序：先把双向关联补好，再持久化。
                // task_source_id 是非空外键，先 save 再 setTaskSource 会在 INSERT 时写入 NULL。
                attachment.setTaskSource(source);
                // 显式持久化并 flush，用返回值（已回填真实主键）构造响应，
                // 不依赖 source 的级联 persist（级联不会把生成的主键回填到我们持有的实例上）。
                Attachment managed = attachmentRepository.saveAndFlush(attachment);
                source.getAttachments().add(managed);
                written.add(managed);
            }
        } catch (RuntimeException ex) {
            // 本次调用写过的所有文件（含数据库写失败的那一个）都要清理
            deleteFilesQuietly(writtenPaths);
            throw ex;
        }

        // 事务最终回滚时（例如提交阶段失败）也要清掉磁盘文件
        registerRollbackCleanup(writtenPaths);

        List<AttachmentResponse> result = new ArrayList<>(written.size());
        for (Attachment attachment : written) {
            if (attachment.getId() == null) {
                throw new IllegalStateException("附件元数据未持久化，无法返回可下载的附件：" + attachment.getOriginalName());
            }
            result.add(ApiMapper.attachment(attachment));
        }
        return result;
    }

    @Transactional(readOnly = true)
    public Resource loadResource(Long attachmentId) {
        Attachment attachment = sourceService.requireAttachment(attachmentId);
        return storageService.loadAsResource(attachment);
    }

    /** 下载用元数据（文件名 + 类型），读取本身仍走 loadResource。 */
    @Transactional(readOnly = true)
    public Attachment metadata(Long attachmentId) {
        return sourceService.requireAttachment(attachmentId);
    }

    /** 删除附件：数据库删除成功提交后才删磁盘文件，避免"文件已删但事务回滚"。 */
    @Transactional
    public void delete(Long attachmentId) {
        Attachment attachment = sourceService.requireAttachment(attachmentId);
        TaskSource source = attachment.getTaskSource();
        String relativePath = attachment.getRelativePath();
        if (source != null) {
            source.removeAttachment(attachment);
            sourceRepository.save(source);
        }
        attachmentRepository.delete(attachment);
        registerAfterCommitFileDeletion(List.of(relativePath));
    }

    /** 事务回滚时清理本次已写入的磁盘文件（按落盘路径，不依赖数据库状态）。 */
    private void registerRollbackCleanup(List<String> relativePaths) {
        if (relativePaths.isEmpty() || !TransactionSynchronizationManager.isSynchronizationActive()) {
            return;
        }
        List<String> paths = List.copyOf(relativePaths);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                if (status != TransactionSynchronization.STATUS_COMMITTED) {
                    log.warn("事务未提交（status={}），清理本次已写入的 {} 个附件文件", status, paths.size());
                    deleteFilesQuietly(paths);
                }
            }
        });
    }

    /** 事务提交后再删文件；没有活跃事务时立即删除。 */
    private void registerAfterCommitFileDeletion(List<String> relativePaths) {
        if (relativePaths.isEmpty()) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            deleteFilesQuietly(relativePaths);
            return;
        }
        List<String> paths = List.copyOf(relativePaths);
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                deleteFilesQuietly(paths);
            }
        });
    }

    /** 按路径清理文件，失败只记日志（清理路径本身不应再抛异常）。 */
    private void deleteFilesQuietly(List<String> relativePaths) {
        for (String path : relativePaths) {
            storageService.deleteByRelativePath(path);
        }
    }
}
