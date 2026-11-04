package com.ddlmate.domain;

import java.time.OffsetDateTime;

import org.hibernate.annotations.CreationTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.ForeignKey;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/**
 * 原通知的图片附件元数据。二进制不入库，落盘到 ddlmate.storage.upload-dir。
 *
 * <p>storedName 由服务器生成（UUID + 扩展名），originalName 只用于展示，
 * 两者都做路径校验，防止路径穿越。</p>
 */
@Entity
@Table(name = "attachments")
public class Attachment {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "task_source_id", nullable = false, foreignKey = @ForeignKey(name = "fk_attachment_source"))
    private TaskSource taskSource;

    /** 服务器生成的文件名，例如 5f1c...-a.png。 */
    @Column(name = "stored_name", nullable = false, length = 128)
    private String storedName;

    /** 用户上传时的原始文件名，仅展示用。 */
    @Column(name = "original_name", nullable = false, length = 255)
    private String originalName;

    @Column(name = "content_type", nullable = false, length = 64)
    private String contentType;

    @Column(name = "size_bytes", nullable = false)
    private long sizeBytes;

    /** 相对上传目录的子路径，例如 2026/02/xxx.png，便于以后分目录。 */
    @Column(name = "relative_path", nullable = false, length = 255)
    private String relativePath;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected Attachment() {
    }

    public Attachment(String storedName, String originalName, String contentType, long sizeBytes, String relativePath) {
        this.storedName = storedName;
        this.originalName = originalName;
        this.contentType = contentType;
        this.sizeBytes = sizeBytes;
        this.relativePath = relativePath;
    }

    public Long getId() {
        return id;
    }

    public TaskSource getTaskSource() {
        return taskSource;
    }

    public void setTaskSource(TaskSource taskSource) {
        this.taskSource = taskSource;
    }

    public String getStoredName() {
        return storedName;
    }

    public String getOriginalName() {
        return originalName;
    }

    public String getContentType() {
        return contentType;
    }

    public long getSizeBytes() {
        return sizeBytes;
    }

    public String getRelativePath() {
        return relativePath;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }
}
