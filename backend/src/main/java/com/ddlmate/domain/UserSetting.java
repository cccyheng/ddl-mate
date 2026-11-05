package com.ddlmate.domain;

import java.time.OffsetDateTime;

import org.hibernate.annotations.TenantId;
import org.hibernate.annotations.UpdateTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

/**
 * 每个用户自己的键值设置：键名与取值格式同手机端 {@code app_settings}。
 *
 * <p>专注记录、每周目标、今日计划、任务步骤 / 模板 / 重复规则、复习安排、提醒等都以
 * "带版本号的紧凑 JSON"存在这里，取值原样保存，后端不解释其内容。</p>
 *
 * <p>{@code revision} 每次写入加一，用于乐观并发：两个标签页同时编辑时后写的一方会收到 409。</p>
 */
@Entity
@Table(name = "user_settings",
        uniqueConstraints = @UniqueConstraint(name = "uk_user_settings_owner_key", columnNames = { "owner_id", "setting_key" }))
public class UserSetting {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @TenantId
    @Column(name = "owner_id", updatable = false)
    private Long ownerId;

    @Column(name = "setting_key", nullable = false, length = 96)
    private String key;

    @Lob
    @Column(name = "setting_value", nullable = false)
    private String value;

    @Column(name = "revision", nullable = false)
    private long revision;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected UserSetting() {
    }

    public UserSetting(String key) {
        this.key = key;
    }

    public Long getId() {
        return id;
    }

    public Long getOwnerId() {
        return ownerId;
    }

    public String getKey() {
        return key;
    }

    public String getValue() {
        return value;
    }

    public void setValue(String value) {
        this.value = value;
    }

    public long getRevision() {
        return revision;
    }

    public void setRevision(long revision) {
        this.revision = revision;
    }

    public OffsetDateTime getUpdatedAt() {
        return updatedAt;
    }
}
