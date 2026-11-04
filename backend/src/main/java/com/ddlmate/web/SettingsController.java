package com.ddlmate.web;

import java.util.List;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.service.SettingsService;
import com.ddlmate.web.dto.SettingRequest;
import com.ddlmate.web.dto.SettingResponse;

import jakarta.validation.Valid;

/** 键值设置：专注、计划、模板、复习等功能的 JSON 存储（格式与手机端一致）。 */
@RestController
@RequestMapping("/api/settings")
public class SettingsController {

    private final SettingsService settingsService;

    public SettingsController(SettingsService settingsService) {
        this.settingsService = settingsService;
    }

    @GetMapping
    public List<SettingResponse> list(@RequestParam String prefix) {
        return settingsService.listByPrefix(prefix);
    }

    @GetMapping("/{key}")
    public SettingResponse get(@PathVariable String key) {
        return settingsService.get(key);
    }

    @PutMapping("/{key}")
    public SettingResponse put(@PathVariable String key, @Valid @RequestBody SettingRequest request) {
        return settingsService.put(key, request.value(), request.expectedRevision());
    }

    @DeleteMapping("/{key}")
    public ResponseEntity<Void> delete(@PathVariable String key) {
        settingsService.delete(key);
        return ResponseEntity.noContent().build();
    }
}
