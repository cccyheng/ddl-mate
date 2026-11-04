package com.ddlmate.service;

import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.ddlmate.common.ErrorCodes;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.ResourceInUseException;
import com.ddlmate.domain.AppSetting;
import com.ddlmate.repository.AppSettingRepository;
import com.ddlmate.web.dto.SettingResponse;

/**
 * 键值设置读写。
 *
 * <p>键名采用白名单：与手机端 {@code APP_SETTINGS_KEYS} 及各模块常量保持一致，
 * 避免前端拼错键名后悄悄写出一堆无人读取的垃圾数据。按任务存放的设置（步骤、提醒）
 * 用 {@code 前缀.<任务 id>}。</p>
 */
@Service
public class SettingsService {

    /** 单个取值上限（字符）：手机端最大的模板库约 1.5 MB，这里留出余量。 */
    public static final int MAX_VALUE_LENGTH = 2_000_000;

    static final Set<String> KEYS = Set.of(
            "teaching_week.semester_start_monday",
            "teaching_week.calibrated_week",
            "teaching_week.calibrated_today",
            "teaching_week.calibrated_at",
            "pressure.daily_study_reference_minutes",
            "daily_plan.today",
            "task_templates.v1",
            "task_recurrence.v1",
            "focus.sessions.v1",
            "learning.weekly-goals.v1",
            "exam_revision.v1",
            "class_reminder.v1");

    private static final Pattern PER_TASK = Pattern.compile("^(task_steps|task_reminder)\\.[1-9][0-9]{0,18}$");
    private static final Set<String> PREFIXES = Set.of("task_steps.", "task_reminder.");

    private final AppSettingRepository repository;

    public SettingsService(AppSettingRepository repository) {
        this.repository = repository;
    }

    public static boolean isAllowedKey(String key) {
        return key != null && (KEYS.contains(key) || PER_TASK.matcher(key).matches());
    }

    @Transactional(readOnly = true)
    public SettingResponse get(String key) {
        requireKey(key);
        return repository.findById(key)
                .map(SettingsService::toResponse)
                .orElseGet(() -> new SettingResponse(key, null, 0, null));
    }

    /** 按前缀列出（只允许按任务存放的两类前缀），供提醒总览等页面一次取齐。 */
    @Transactional(readOnly = true)
    public List<SettingResponse> listByPrefix(String prefix) {
        if (!PREFIXES.contains(prefix)) {
            throw new InvalidRequestException("prefix", "不支持的前缀：" + prefix);
        }
        return repository.findByKeyStartingWithOrderByKeyAsc(prefix).stream()
                .map(SettingsService::toResponse)
                .toList();
    }

    @Transactional
    public SettingResponse put(String key, String value, long expectedRevision) {
        requireKey(key);
        if (value.length() > MAX_VALUE_LENGTH) {
            throw new InvalidRequestException("value", "取值过大（上限 " + MAX_VALUE_LENGTH + " 字符）");
        }
        AppSetting setting = repository.findById(key).orElse(null);
        long current = setting == null ? 0 : setting.getRevision();
        if (current != expectedRevision) {
            throw new ResourceInUseException(
                    "这项设置已在别处被修改（当前版本 " + current + "），请刷新后再保存", ErrorCodes.SETTING_CONFLICT);
        }
        if (setting == null) {
            setting = new AppSetting(key);
        }
        setting.setValue(value);
        setting.setRevision(current + 1);
        return toResponse(repository.saveAndFlush(setting));
    }

    @Transactional
    public void delete(String key) {
        requireKey(key);
        repository.deleteById(key);
    }

    private static void requireKey(String key) {
        if (!isAllowedKey(key)) {
            throw new InvalidRequestException("key", "不认识的设置项：" + key);
        }
    }

    private static SettingResponse toResponse(AppSetting setting) {
        return new SettingResponse(setting.getKey(), setting.getValue(), setting.getRevision(), setting.getUpdatedAt());
    }
}
