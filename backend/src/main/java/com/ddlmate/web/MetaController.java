package com.ddlmate.web;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.common.TimeZones;
import com.ddlmate.domain.TaskPriority;
import com.ddlmate.domain.TaskStatus;
import com.ddlmate.domain.TaskType;
import com.ddlmate.service.NoticeImportService;

/** 枚举与时间语义元数据，前端下拉框与"关于"页都从这里取，避免前后端写两套。 */
@RestController
@RequestMapping("/api/meta")
public class MetaController {

    private final NoticeImportService noticeImportService;

    public MetaController(NoticeImportService noticeImportService) {
        this.noticeImportService = noticeImportService;
    }

    @GetMapping("/enums")
    public Map<String, Object> enums() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("taskTypes", options(List.of(TaskType.values())));
        result.put("taskStatuses", options(List.of(TaskStatus.values())));
        result.put("priorities", priorities());
        result.put("timeZone", TimeZones.zone().getId());
        result.put("apiTimeFormat", "ISO-8601 带偏移量，例如 2026-10-15T10:10:00+08:00");
        result.put("weekdayConvention", "1=周一 … 7=周日（ISO-8601）");
        return result;
    }

    /**
     * 附件与批量导入的真实限制：前端选择通知图片前先按这些值校验，
     * 避免"选了 8 张才发现总量超限"。数值来自配置与 {@link NoticeImportService}，不写死在界面里。
     */
    @GetMapping("/storage-limits")
    public Map<String, Object> storageLimits() {
        Map<String, Object> result = new LinkedHashMap<>(noticeImportService.limits());
        result.put("allowedContentTypes", List.of("image/png", "image/jpeg", "image/webp"));
        result.put("maxImagePixels", 12_000_000);
        return result;
    }

    private List<Map<String, String>> options(List<? extends Enum<?>> values) {
        List<Map<String, String>> result = new ArrayList<>();
        for (Enum<?> value : values) {
            String label = switch (value) {
                case TaskType type -> type.getLabel();
                case TaskStatus status -> status.getLabel();
                default -> value.name();
            };
            Map<String, String> option = new LinkedHashMap<>();
            option.put("value", value.name());
            option.put("label", label);
            result.add(option);
        }
        return result;
    }

    private List<Map<String, Object>> priorities() {
        List<Map<String, Object>> result = new ArrayList<>();
        for (TaskPriority priority : TaskPriority.values()) {
            Map<String, Object> option = new LinkedHashMap<>();
            option.put("value", priority.getLevel());
            option.put("label", priority.getLabel());
            result.add(option);
        }
        return result;
    }
}
