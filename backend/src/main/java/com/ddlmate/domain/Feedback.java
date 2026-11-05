package com.ddlmate.domain;

import java.time.OffsetDateTime;

import com.ddlmate.common.TimeZones;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;

/**
 * 用户提交的问题反馈。
 *
 * <p>与课程、任务不同，这张表<strong>不按用户隔离</strong>（没有 {@code @TenantId}）：
 * 站长要能看到所有人的反馈。普通用户只能通过「我的反馈」接口按自己的 userId 查询。</p>
 */
@Entity
@Table(name = "feedback", indexes = {
        @Index(name = "idx_feedback_user", columnList = "user_id"),
        @Index(name = "idx_feedback_status", columnList = "status") })
public class Feedback {

    public static final String NEW = "NEW";
    public static final String READ = "READ";
    public static final String DONE = "DONE";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    @Column(name = "username", nullable = false, length = 64, updatable = false)
    private String username;

    /** BUG / SUGGESTION / OTHER */
    @Column(name = "category", nullable = false, length = 16)
    private String category;

    @Column(name = "content", nullable = false, length = 2000)
    private String content;

    @Column(name = "contact", length = 100)
    private String contact;

    /** 提交时所在的页面（例如 /courses/import-schedule），方便定位问题。 */
    @Column(name = "page", length = 200)
    private String page;

    @Column(name = "user_agent", length = 300)
    private String userAgent;

    @Column(name = "status", nullable = false, length = 16)
    private String status = NEW;

    @Column(name = "reply", length = 1000)
    private String reply;

    @Column(name = "replied_at")
    private OffsetDateTime repliedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected Feedback() {
    }

    public Feedback(Long userId, String username, String category, String content) {
        this.userId = userId;
        this.username = username;
        this.category = category;
        this.content = content;
    }

    @PrePersist
    void onCreate() {
        createdAt = TimeZones.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = TimeZones.now();
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public String getUsername() {
        return username;
    }

    public String getCategory() {
        return category;
    }

    public String getContent() {
        return content;
    }

    public String getContact() {
        return contact;
    }

    public void setContact(String contact) {
        this.contact = contact;
    }

    public String getPage() {
        return page;
    }

    public void setPage(String page) {
        this.page = page;
    }

    public String getUserAgent() {
        return userAgent;
    }

    public void setUserAgent(String userAgent) {
        this.userAgent = userAgent;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getReply() {
        return reply;
    }

    public void setReply(String reply) {
        this.reply = reply;
    }

    public OffsetDateTime getRepliedAt() {
        return repliedAt;
    }

    public void setRepliedAt(OffsetDateTime repliedAt) {
        this.repliedAt = repliedAt;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }
}
