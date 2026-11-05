package com.ddlmate.config;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Locale;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import com.ddlmate.auth.AuthProperties;
import com.ddlmate.auth.AuthService;
import com.ddlmate.domain.AppUser;
import com.ddlmate.service.UserService;

/**
 * 启动时的数据迁移（每次启动都执行，重复执行无副作用）：单人版 → 多用户版。
 *
 * <ol>
 *   <li>确保至少有一个用户（本机单人版的那个）；</li>
 *   <li>启用登录时，把最早的用户改名为站长用户名并设为 ADMIN（已有数据本来就属于他）；</li>
 *   <li>所有还没有 owner_id 的业务数据归到这个用户；</li>
 *   <li>旧的全站设置表 app_settings → 每人一份的 user_settings；旧的 auth_credentials 密码 → app_users；</li>
 *   <li>课程代码唯一性从「全站」改为「每个用户」：去掉旧约束 uk_courses_code；</li>
 *   <li>最后检查站长账号可以登录。</li>
 * </ol>
 *
 * 表结构本身（新列、新表）由 Hibernate 的 ddl-auto=update 在这之前创建。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class StartupMigration implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(StartupMigration.class);

    static final List<String> OWNED_TABLES = List.of("courses", "course_schedules", "tasks", "task_sources", "attachments",
            "user_settings");

    private final UserService userService;
    private final AuthProperties authProperties;
    private final AuthService authService;
    private final JdbcTemplate jdbc;
    private final DataSource dataSource;
    private final TransactionTemplate tx;

    public StartupMigration(UserService userService, AuthProperties authProperties, AuthService authService,
            JdbcTemplate jdbc, DataSource dataSource, TransactionTemplate tx) {
        this.userService = userService;
        this.authProperties = authProperties;
        this.authService = authService;
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.tx = tx;
    }

    @Override
    public void run(ApplicationArguments args) {
        AppUser first = userService.firstUser();
        long ownerId = first.getId();
        tx.executeWithoutResult(status -> {
            promoteAdmin(ownerId);
            for (String table : OWNED_TABLES) {
                int n = jdbc.update("UPDATE " + table + " SET owner_id = ? WHERE owner_id IS NULL", ownerId);
                if (n > 0) {
                    log.info("迁移：{} 条 {} 归到用户 id={}", n, table, ownerId);
                }
            }
            migrateLegacySettings(ownerId);
            migrateLegacyCredential();
        });
        relaxCourseCodeUniqueness();
        authService.checkConfiguration();
        log.info("用户与数据就绪：最早的用户 id={} username={}", ownerId, userService.firstUser().getUsername());
    }

    private void promoteAdmin(long firstUserId) {
        String admin = authProperties.username();
        if (!authProperties.enabled() || admin == null || admin.isBlank()) {
            return;
        }
        String name = admin.trim().toLowerCase(Locale.ROOT);
        Integer existing = jdbc.queryForObject("SELECT COUNT(*) FROM app_users WHERE LOWER(username) = ?", Integer.class, name);
        if (existing != null && existing == 0) {
            jdbc.update("UPDATE app_users SET username = ? WHERE id = ?", name, firstUserId);
            log.info("迁移：用户 id={} 改名为站长 {}", firstUserId, name);
        }
        jdbc.update("UPDATE app_users SET role = 'ADMIN' WHERE LOWER(username) = ?", name);
    }

    private void migrateLegacySettings(long ownerId) {
        if (!tableExists("app_settings")) {
            return;
        }
        int copied = jdbc.update("""
                INSERT INTO user_settings (owner_id, setting_key, setting_value, revision, updated_at)
                SELECT ?, a.setting_key, a.setting_value, a.revision, a.updated_at FROM app_settings a
                WHERE NOT EXISTS (SELECT 1 FROM user_settings u WHERE u.owner_id = ? AND u.setting_key = a.setting_key)
                """, ownerId, ownerId);
        jdbc.execute("ALTER TABLE app_settings RENAME TO app_settings_migrated");
        log.info("迁移：旧设置 {} 条复制到 user_settings（旧表改名为 app_settings_migrated 留底）", copied);
    }

    private void migrateLegacyCredential() {
        if (!tableExists("auth_credentials")) {
            return;
        }
        int moved = jdbc.update("""
                UPDATE app_users SET password_hash = (
                    SELECT c.password_hash FROM auth_credentials c WHERE LOWER(c.username) = LOWER(app_users.username))
                WHERE password_hash IS NULL AND EXISTS (
                    SELECT 1 FROM auth_credentials c WHERE LOWER(c.username) = LOWER(app_users.username))
                """);
        jdbc.execute("ALTER TABLE auth_credentials RENAME TO auth_credentials_migrated");
        log.info("迁移：{} 个账号的密码从 auth_credentials 移到 app_users", moved);
    }

    /** 旧版的「课程代码全站唯一」约束会让不同用户不能用同一个课程代码，去掉；新的「每人唯一」约束由实体声明。 */
    private void relaxCourseCodeUniqueness() {
        try {
            if (isH2()) {
                jdbc.execute("ALTER TABLE courses DROP CONSTRAINT IF EXISTS uk_courses_code");
                jdbc.execute("ALTER TABLE courses ADD CONSTRAINT IF NOT EXISTS uk_courses_owner_code UNIQUE (owner_id, code)");
            } else {
                Integer old = jdbc.queryForObject("""
                        SELECT COUNT(*) FROM information_schema.statistics
                        WHERE table_schema = DATABASE() AND table_name = 'courses' AND index_name = 'uk_courses_code'
                        """, Integer.class);
                if (old != null && old > 0) {
                    jdbc.execute("ALTER TABLE courses DROP INDEX uk_courses_code");
                }
            }
        } catch (RuntimeException ex) {
            throw new IllegalStateException("迁移课程代码唯一约束失败：" + ex.getMessage(), ex);
        }
    }

    private boolean tableExists(String table) {
        try (Connection connection = dataSource.getConnection()) {
            var meta = connection.getMetaData();
            for (String name : new String[] { table, table.toUpperCase(Locale.ROOT) }) {
                try (var rs = meta.getTables(null, null, name, new String[] { "TABLE" })) {
                    if (rs.next()) {
                        return true;
                    }
                }
            }
            return false;
        } catch (SQLException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private boolean isH2() {
        try (Connection connection = dataSource.getConnection()) {
            return connection.getMetaData().getDatabaseProductName().toLowerCase(Locale.ROOT).contains("h2");
        } catch (SQLException ex) {
            throw new IllegalStateException(ex);
        }
    }
}
