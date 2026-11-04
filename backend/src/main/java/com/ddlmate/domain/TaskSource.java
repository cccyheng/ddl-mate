package com.ddlmate.domain;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import org.hibernate.annotations.CreationTimestamp;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.ForeignKey;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;

/**
 * 原通知（对应需求里的 M 功能）：老师原话 + 来源 + 原图。
 *
 * <p>task 允许为空：V1.1 的"批量截图先入库、人工确认后再绑定任务"会用到这个暂存能力，
 * 因此这里不把 task_id 设为非空。</p>
 */
@Entity
@Table(name = "task_sources")
public class TaskSource {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "task_id", foreignKey = @ForeignKey(name = "fk_source_task"))
    private Task task;

    /** 来源名，如"数据结构课程群"。 */
    @Column(name = "source_name", nullable = false, length = 128)
    private String sourceName;

    /** 来源类型，如 WECHAT_GROUP / QQ_GROUP / LMS / EMAIL / MANUAL。 */
    @Column(name = "source_type", length = 32)
    private String sourceType;

    /** 原通知文字，逐字保存，便于以后追溯"老师到底怎么说的"。 */
    @Column(name = "raw_text", length = 4000)
    private String rawText;

    /** 通知发生/截图时间。 */
    @Column(name = "captured_at")
    private OffsetDateTime capturedAt;

    @OneToMany(mappedBy = "taskSource", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @OrderBy("id ASC")
    private List<Attachment> attachments = new ArrayList<>();

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected TaskSource() {
    }

    public TaskSource(String sourceName, String rawText) {
        this.sourceName = sourceName;
        this.rawText = rawText;
    }

    public void addAttachment(Attachment attachment) {
        attachment.setTaskSource(this);
        this.attachments.add(attachment);
    }

    public void removeAttachment(Attachment attachment) {
        this.attachments.remove(attachment);
        attachment.setTaskSource(null);
    }

    public Long getId() {
        return id;
    }

    public Task getTask() {
        return task;
    }

    public void setTask(Task task) {
        this.task = task;
    }

    public String getSourceName() {
        return sourceName;
    }

    public void setSourceName(String sourceName) {
        this.sourceName = sourceName;
    }

    public String getSourceType() {
        return sourceType;
    }

    public void setSourceType(String sourceType) {
        this.sourceType = sourceType;
    }

    public String getRawText() {
        return rawText;
    }

    public void setRawText(String rawText) {
        this.rawText = rawText;
    }

    public OffsetDateTime getCapturedAt() {
        return capturedAt;
    }

    public void setCapturedAt(OffsetDateTime capturedAt) {
        this.capturedAt = capturedAt;
    }

    public List<Attachment> getAttachments() {
        return attachments;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }
}
