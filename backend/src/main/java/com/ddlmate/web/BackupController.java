package com.ddlmate.web;

import java.util.Map;

import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.ddlmate.common.TimeZones;
import com.ddlmate.service.BackupService;

/** 整库备份：导出 → 预览（只读校验）→ 确认后整体替换恢复。 */
@RestController
@RequestMapping("/api/backup")
public class BackupController {

    private final BackupService backupService;

    public BackupController(BackupService backupService) {
        this.backupService = backupService;
    }

    @GetMapping("/export")
    public ResponseEntity<Map<String, Object>> export() {
        String name = "ddlmate-web-backup-" + TimeZones.now().toLocalDate() + ".json";
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"")
                .body(backupService.export());
    }

    @PostMapping("/preview")
    public Map<String, Object> preview(@RequestBody Map<String, Object> backup) {
        return backupService.preview(backup);
    }

    @PostMapping("/restore")
    public Map<String, Object> restore(@RequestBody Map<String, Object> backup) {
        return backupService.restore(backup);
    }
}
