package com.ddlmate.domain;

import java.time.OffsetDateTime;

import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

/**
 * 用户账号：本机单人版只有一个；服务器版每个注册用户一个，所有业务数据按 id 归属（owner_id）。
 *
 * <p>密码只存 PBKDF2 哈希；角色 ADMIN 可以开关注册等（第一个账号即站长）。</p>
 */
@Entity
@Table(name = "app_users", uniqueConstraints = @UniqueConstraint(name = "uk_app_users_username", columnNames = "username"))
public class AppUser {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "username", nullable = false, length = 64)
    private String username;

    @Column(name = "display_name", nullable = false, length = 64)
    private String displayName;

    @Column(name = "time_zone", nullable = false, length = 64)
    private String timeZone = "Asia/Shanghai";

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private OffsetDateTime createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    /** PBKDF2 哈希；本机单人版没有密码时为空。 */
    @Column(name = "password_hash", length = 255)
    private String passwordHash;

    /** ADMIN / USER；老数据为空时按 USER 处理。 */
    @Column(name = "role", length = 16)
    private String role;

    /** 站长发了临时密码后为 true：登录后必须先改密码才能用别的功能。 */
    @Column(name = "must_change_password")
    private Boolean mustChangePassword;

    /** 临时密码的过期时间；过期后不能再用它登录。 */
    @Column(name = "temp_password_expires_at")
    private OffsetDateTime tempPasswordExpiresAt;

    protected AppUser() {
    }

    public AppUser(String username, String displayName, String timeZone) {
        this.username = username;
        this.displayName = displayName;
        this.timeZone = timeZone;
    }

    public Long getId() {
        return id;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getDisplayName() {
        return displayName;
    }

    public void setDisplayName(String displayName) {
        this.displayName = displayName;
    }

    public String getTimeZone() {
        return timeZone;
    }

    public void setTimeZone(String timeZone) {
        this.timeZone = timeZone;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }

    public boolean isMustChangePassword() {
        return Boolean.TRUE.equals(mustChangePassword);
    }

    public void setMustChangePassword(boolean value) {
        this.mustChangePassword = value;
    }

    public OffsetDateTime getTempPasswordExpiresAt() {
        return tempPasswordExpiresAt;
    }

    public void setTempPasswordExpiresAt(OffsetDateTime value) {
        this.tempPasswordExpiresAt = value;
    }

    public boolean isAdmin() {
        return "ADMIN".equals(role);
    }

    public void setRole(String role) {
        this.role = role;
    }
}
