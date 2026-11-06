package com.ddlmate.service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.sql.Connection;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import com.ddlmate.common.TimeZones;

/**
 * 每晚自动备份（服务器版默认开启）：
 * <ul>
 *   <li>数据库：用 H2 的 {@code SCRIPT TO} 导出 SQL 脚本再 gzip 压缩——在运行中导出也是一致的，
 *       不像直接复制正在写的数据库文件那样可能得到坏副本；</li>
 *   <li>上传的图片：打包成一个 zip；</li>
 *   <li>只保留最近 N 天（默认 14 天），更早的自动删除。</li>
 * </ul>
 * 文件放在数据目录下的 {@code backups/nightly/}。恢复：解压出 .sql 后在空库里执行 {@code RUNSCRIPT FROM '文件.sql'}。
 */
@Service
@ConditionalOnProperty(name = "ddlmate.backup.nightly.enabled", havingValue = "true")
public class NightlyBackupService {

    private static final Logger log = LoggerFactory.getLogger(NightlyBackupService.class);
    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final JdbcTemplate jdbc;
    private final DataSource dataSource;
    private final StorageService storageService;
    private final int retentionDays;

    public NightlyBackupService(JdbcTemplate jdbc, DataSource dataSource, StorageService storageService,
            @Value("${ddlmate.backup.nightly.retention-days:14}") int retentionDays) {
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.storageService = storageService;
        this.retentionDays = Math.max(1, retentionDays);
    }

    /** 启动时：说明已开启；如果最近 24 小时还没有备份（例如刚部署），马上补一份。 */
    @EventListener(ApplicationReadyEvent.class)
    public void onStartup() {
        log.info("每晚自动备份已开启：每天 03:00（北京时间），保留 {} 天，目录 {}", retentionDays, backupDir());
        try {
            if (!hasRecentBackup()) {
                runBackup();
            }
        } catch (RuntimeException ex) {
            log.error("启动时补做备份失败：{}", ex.getMessage(), ex);
        }
    }

    private boolean hasRecentBackup() {
        Path dir = backupDir();
        if (!Files.isDirectory(dir)) {
            return false;
        }
        Instant since = Instant.now().minus(24, ChronoUnit.HOURS);
        try (Stream<Path> list = Files.list(dir)) {
            return list.anyMatch(f -> f.getFileName().toString().endsWith(".sql.gz") && modifiedAfter(f, since));
        } catch (IOException ex) {
            return false;
        }
    }

    private static boolean modifiedAfter(Path file, Instant since) {
        try {
            return Files.getLastModifiedTime(file).toInstant().isAfter(since);
        } catch (IOException ex) {
            return false;
        }
    }

    @Scheduled(cron = "${ddlmate.backup.nightly.cron:0 0 3 * * *}", zone = "Asia/Shanghai")
    public void scheduled() {
        try {
            runBackup();
        } catch (RuntimeException ex) {
            log.error("每晚自动备份失败：{}", ex.getMessage(), ex);
        }
    }

    /** 立即做一次备份，返回生成的文件（测试和运维手动调用）。 */
    public List<Path> runBackup() {
        if (!isH2()) {
            log.info("当前数据库不是 H2，跳过每晚自动备份（请使用数据库自带的备份）");
            return List.of();
        }
        Path dir = backupDir();
        String stamp = TimeZones.now().format(STAMP);
        try {
            Files.createDirectories(dir);
            Path sql = dir.resolve("ddlmate-" + stamp + ".sql.gz");
            // 先导出成纯 SQL，再用 gzip 压缩（不依赖 H2 自带的压缩选项），最后删掉未压缩的临时文件
            Path plain = dir.resolve("ddlmate-" + stamp + ".sql.tmp");
            try {
                jdbc.execute("SCRIPT TO '" + plain.toAbsolutePath().toString().replace("'", "''") + "' CHARSET 'UTF-8'");
                try (InputStream in = Files.newInputStream(plain);
                        OutputStream out = new GZIPOutputStream(Files.newOutputStream(sql))) {
                    in.transferTo(out);
                }
            } finally {
                Files.deleteIfExists(plain);
            }
            Path uploads = dir.resolve("uploads-" + stamp + ".zip");
            int files = zipUploads(uploads);
            int pruned = prune(dir);
            log.info("每晚自动备份完成：{}（{} KB），图片 {} 个；清理过期备份 {} 个", sql.getFileName(),
                    Files.size(sql) / 1024, files, pruned);
            return files > 0 ? List.of(sql, uploads) : List.of(sql);
        } catch (IOException ex) {
            throw new IllegalStateException("写备份文件失败：" + ex.getMessage(), ex);
        }
    }

    public Path backupDir() {
        return storageService.getRoot().toAbsolutePath().getParent().resolve("backups").resolve("nightly");
    }

    private boolean isH2() {
        try (Connection connection = dataSource.getConnection()) {
            return connection.getMetaData().getDatabaseProductName().toUpperCase().contains("H2");
        } catch (Exception ex) {
            return false;
        }
    }

    /** 把上传目录打包；目录不存在或为空时不生成文件。 */
    private int zipUploads(Path target) throws IOException {
        Path root = storageService.getRoot().toAbsolutePath();
        if (!Files.isDirectory(root)) {
            return 0;
        }
        List<Path> files;
        try (Stream<Path> walk = Files.walk(root)) {
            files = walk.filter(Files::isRegularFile).toList();
        }
        if (files.isEmpty()) {
            return 0;
        }
        try (OutputStream out = Files.newOutputStream(target); ZipOutputStream zip = new ZipOutputStream(out)) {
            for (Path file : files) {
                zip.putNextEntry(new ZipEntry(root.relativize(file).toString().replace('\\', '/')));
                Files.copy(file, zip);
                zip.closeEntry();
            }
        }
        return files.size();
    }

    /** 删除超过保留天数的备份文件。 */
    int prune(Path dir) throws IOException {
        Instant cutoff = Instant.now().minus(retentionDays, ChronoUnit.DAYS);
        int removed = 0;
        try (Stream<Path> list = Files.list(dir)) {
            for (Path file : list.filter(Files::isRegularFile).toList()) {
                String name = file.getFileName().toString();
                boolean ours = (name.startsWith("ddlmate-") && name.endsWith(".sql.gz"))
                        || (name.startsWith("uploads-") && name.endsWith(".zip"));
                FileTime modified = Files.getLastModifiedTime(file);
                if (ours && modified.toInstant().isBefore(cutoff)) {
                    Files.deleteIfExists(file);
                    removed++;
                }
            }
        }
        return removed;
    }
}
