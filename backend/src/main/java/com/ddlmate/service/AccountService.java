package com.ddlmate.service;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.ddlmate.common.ForbiddenException;
import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.domain.AppUser;
import com.ddlmate.repository.AppUserRepository;

/**
 * 注销账号：在一个事务里删掉这个账号的全部数据（课程、课表、任务、原通知、附件、设置、反馈、找回密码申请）
 * 和账号本身；事务提交后再删磁盘上的图片文件和恢复前的安全副本。站长账号不能注销。
 */
@Service
public class AccountService {

    private static final Logger log = LoggerFactory.getLogger(AccountService.class);

    private final JdbcTemplate jdbc;
    private final AppUserRepository users;
    private final StorageService storageService;

    public AccountService(JdbcTemplate jdbc, AppUserRepository users, StorageService storageService) {
        this.jdbc = jdbc;
        this.users = users;
        this.storageService = storageService;
    }

    @Transactional
    public void deleteAccount(long userId, String confirmUsername) {
        AppUser user = users.findById(userId).orElseThrow(() -> new InvalidRequestException("账号不存在"));
        if (user.isAdmin()) {
            throw new ForbiddenException("站长账号不能注销，否则网站就没有管理员了。");
        }
        if (confirmUsername == null || !confirmUsername.trim().equalsIgnoreCase(user.getUsername())) {
            throw new InvalidRequestException("confirmUsername", "请输入你的用户名「" + user.getUsername() + "」确认注销");
        }
        List<String> files = jdbc.queryForList("SELECT relative_path FROM attachments WHERE owner_id = ?", String.class,
                userId);
        // 子表先删（附件 → 原通知 → 任务 → 课表 → 课程 → 设置）
        List<String> tables = BackupService.TABLES;
        int rows = 0;
        for (int i = tables.size() - 1; i >= 0; i--) {
            rows += jdbc.update("DELETE FROM " + tables.get(i) + " WHERE owner_id = ?", userId);
        }
        rows += jdbc.update("DELETE FROM feedback WHERE user_id = ?", userId);
        rows += jdbc.update("DELETE FROM password_reset_requests WHERE user_id = ?", userId);
        users.delete(user);
        users.flush();
        log.warn("用户 {}（id={}）注销了账号，删除 {} 行数据、{} 个附件文件", user.getUsername(), userId, rows, files.size());

        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                files.forEach(storageService::deleteByRelativePath);
                deleteSafetyCopies(userId);
            }
        });
    }

    /** 恢复备份时为这个账号留下的「恢复前安全副本」也一并删除。 */
    private void deleteSafetyCopies(long userId) {
        Path dir = storageService.getRoot().toAbsolutePath().getParent().resolve("backups");
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir, "pre-restore-u" + userId + "-*.json")) {
            for (Path file : stream) {
                Files.deleteIfExists(file);
            }
        } catch (IOException ex) {
            log.warn("删除注销账号的安全副本失败：{}", ex.getMessage());
        }
    }
}
