package com.ddlmate.domain;

import java.time.OffsetDateTime;

import org.hibernate.annotations.UpdateTimestamp;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;

/**
 * 键值设置：与手机端 {@code app_settings} 表同一设计（键名、取值格式一致）。
 *
 * <p>专注记录、每周目标、今日计划、任务步骤 / 模板 / 重复规则、复习安排、提醒等
 * 都以"带版本号的紧凑 JSON"存在这里，取值原样保存，后端不解释其内容。</p>
 *
 * <p>{@code revision} 每次写入加一，用于乐观并发：两个标签页同时编辑时后写的一方会收到 409。</p>
 */
@Entity
@Table(name = "app_settings")
public class AppSetting {

    @Id
    @Column(name = "setting_key", length = 96)
    private String key;

    @Lob
    @Column(name = "setting_value", nullable = false)
    private String value;

    @Column(name = "revision", nullable = false)
    private long revision;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private OffsetDateTime updatedAt;

    protected AppSetting() {
    }

    public AppSetting(String key) {
        this.key = key;
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
