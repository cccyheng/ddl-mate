package com.ddlmate.domain;

import java.time.OffsetDateTime;

import com.ddlmate.common.TimeZones;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;

/**
 * 「忘记密码」申请：账号没有绑定邮箱 / 手机，由站长核对后发临时密码。
 * userId 为空表示申请里写的用户名不存在（对申请人不透露这一点，避免被用来探测用户名）。
 */
@Entity
@Table(name = "password_reset_requests")
public class PasswordResetRequest {

    public static final String PENDING = "PENDING";
    public static final String ISSUED = "ISSUED";
    public static final String DISMISSED = "DISMISSED";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "username", nullable = false, length = 64)
    private String username;

    @Column(name = "user_id")
    private Long userId;

    @Column(name = "contact", nullable = false, length = 100)
    private String contact;

    @Column(name = "note", length = 500)
    private String note;

    @Column(name = "client_key", length = 64)
    private String clientKey;

    @Column(name = "status", nullable = false, length = 16)
    private String status = PENDING;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @Column(name = "handled_at")
    private OffsetDateTime handledAt;

    protected PasswordResetRequest() {
    }

    public PasswordResetRequest(String username, Long userId, String contact, String note, String clientKey) {
        this.username = username;
        this.userId = userId;
        this.contact = contact;
        this.note = note;
        this.clientKey = clientKey;
    }

    @PrePersist
    void onCreate() {
        createdAt = TimeZones.now();
    }

    public Long getId() {
        return id;
    }

    public String getUsername() {
        return username;
    }

    public Long getUserId() {
        return userId;
    }

    public String getContact() {
        return contact;
    }

    public String getNote() {
        return note;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
        this.handledAt = TimeZones.now();
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public OffsetDateTime getHandledAt() {
        return handledAt;
    }
}
