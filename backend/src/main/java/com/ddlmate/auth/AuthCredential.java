package com.ddlmate.auth;

import java.time.OffsetDateTime;

import org.hibernate.annotations.UpdateTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * 在网页上设置过的登录密码（PBKDF2 哈希）。存在时优先于环境变量里的哈希。
 *
 * <p>单独一张表：不经过设置接口（读不到也写不了），也不进整库备份，备份文件里不会带着密码哈希。</p>
 */
@Entity
@Table(name = "auth_credentials")
public class AuthCredential {

    @Id
    @Column(name = "username", length = 64)
    private String username;

    @Column(name = "password_hash", nullable = false, length = 255)
    private String passwordHash;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected AuthCredential() {
    }

    public AuthCredential(String username, String passwordHash) {
        this.username = username;
        this.passwordHash = passwordHash;
    }

    public String getUsername() {
        return username;
    }

    public String getPasswordHash() {
        return passwordHash;
    }

    public void setPasswordHash(String passwordHash) {
        this.passwordHash = passwordHash;
    }
}
