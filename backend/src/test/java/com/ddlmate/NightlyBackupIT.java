package com.ddlmate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipInputStream;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.ddlmate.service.NightlyBackupService;
import com.ddlmate.service.StorageService;

/** 每晚自动备份：数据库导出成压缩 SQL、图片打包、过期文件清理；以及扫描器的乱请求返回 405。 */
class NightlyBackupIT extends BaseIntegrationTest {

    @Autowired
    NightlyBackupService nightly;

    @Autowired
    StorageService storageService;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url",
                () -> "jdbc:h2:mem:nightlyit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        registry.add("ddlmate.backup.nightly.enabled", () -> "true");
        registry.add("ddlmate.backup.nightly.retention-days", () -> "14");
    }

    @Test
    @DisplayName("备份：生成压缩 SQL（含数据）和图片包；超过保留天数的旧备份被删除，新的保留")
    void backupWritesSqlAndUploadsAndPrunesOldFiles() throws Exception {
        mvc.perform(ApiTestSupport.json(post("/api/courses"), ApiTestSupport.course("BK101", "备份测试课程")))
                .andExpect(status().isCreated());
        Path uploads = storageService.getRoot().resolve("nightly-test");
        Files.createDirectories(uploads);
        Files.writeString(uploads.resolve("a.png"), "fake-image");

        Path dir = nightly.backupDir();
        Files.createDirectories(dir);
        Path old = dir.resolve("ddlmate-20200101-030000.sql.gz");
        Files.writeString(old, "old");
        Files.setLastModifiedTime(old, FileTime.from(Instant.now().minus(30, ChronoUnit.DAYS)));
        Path recent = dir.resolve("ddlmate-20991231-030000.sql.gz");
        Files.writeString(recent, "recent");
        Path unrelated = dir.resolve("keep-me.txt");
        Files.writeString(unrelated, "not ours");
        Files.setLastModifiedTime(unrelated, FileTime.from(Instant.now().minus(30, ChronoUnit.DAYS)));

        List<Path> files = nightly.runBackup();

        assertThat(files).hasSize(2);
        String sql = gunzip(files.get(0));
        assertThat(sql).contains("CREATE").contains("BK101");

        // 真能恢复：把备份载入一个全新的空库，课程（含中文名）原样回来
        Path restoreScript = Files.createTempFile("nightly-restore", ".sql");
        Files.writeString(restoreScript, sql);
        try (java.sql.Connection fresh = java.sql.DriverManager.getConnection(
                "jdbc:h2:mem:nightlyrestore;MODE=MySQL;DATABASE_TO_LOWER=TRUE", "sa", "");
                java.sql.Statement st = fresh.createStatement()) {
            st.execute("RUNSCRIPT FROM '" + restoreScript.toAbsolutePath().toString().replace("'", "''") + "' CHARSET 'UTF-8'");
            try (java.sql.ResultSet rs = st.executeQuery("SELECT name FROM courses WHERE code = 'BK101'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString(1)).isEqualTo("备份测试课程");
            }
        } finally {
            Files.deleteIfExists(restoreScript);
        }

        assertThat(unzipEntryNamed(files.get(1), "nightly-test/a.png")).isEqualTo("fake-image");
        assertThat(old).doesNotExist();
        assertThat(recent).exists();
        assertThat(unrelated).exists();
    }

    @Test
    @DisplayName("扫描器的 POST / 和自造方法：返回 405，不是 500")
    void unsupportedMethodsAre405() throws Exception {
        mvc.perform(post("/")).andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"));
        mvc.perform(request(HttpMethod.valueOf("GWCQ"), "/")).andExpect(status().isMethodNotAllowed());
    }

    private static String gunzip(Path file) throws Exception {
        try (InputStream in = new GZIPInputStream(Files.newInputStream(file))) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String unzipEntryNamed(Path zip, String name) throws Exception {
        try (InputStream in = Files.newInputStream(zip); ZipInputStream z = new ZipInputStream(in)) {
            for (var entry = z.getNextEntry(); entry != null; entry = z.getNextEntry()) {
                if (entry.getName().equals(name)) {
                    return new String(z.readAllBytes(), StandardCharsets.UTF_8);
                }
            }
        }
        throw new AssertionError("zip 里没有 " + name);
    }
}
