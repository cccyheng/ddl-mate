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
import jakarta.persistence.Table;

/** 一次成功登录（含注册后自动登录）：站长在「用户管理」里查看每个账号的登录记录。 */
@Entity
@Table(name = "login_events", indexes = @Index(name = "idx_login_events_user", columnList = "user_id"))
public class LoginEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false, updatable = false)
    private Long userId;

    /** LOGIN / REGISTER / SETUP */
    @Column(name = "kind", nullable = false, length = 16, updatable = false)
    private String kind;

    @Column(name = "ip", length = 64, updatable = false)
    private String ip;

    @Column(name = "user_agent", length = 300, updatable = false)
    private String userAgent;

    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected LoginEvent() {
    }

    public LoginEvent(Long userId, String kind, String ip, String userAgent) {
        this.userId = userId;
        this.kind = kind;
        this.ip = ip == null ? null : ip.substring(0, Math.min(64, ip.length()));
        this.userAgent = userAgent == null ? null : userAgent.substring(0, Math.min(300, userAgent.length()));
    }

    @PrePersist
    void onCreate() {
        createdAt = TimeZones.now();
    }

    public Long getId() {
        return id;
    }

    public Long getUserId() {
        return userId;
    }

    public String getKind() {
        return kind;
    }

    public String getIp() {
        return ip;
    }

    public String getUserAgent() {
        return userAgent;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }
}
