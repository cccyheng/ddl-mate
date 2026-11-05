package com.ddlmate.config;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;
import java.util.Locale;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.boot.autoconfigure.orm.jpa.EntityManagerFactoryDependsOnPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 在 Hibernate 更新表结构<strong>之前</strong>执行的迁移：给已有数据的旧表补上 owner_id 并填好值。
 *
 * <p>原因：带 {@code @TenantId} 的列 Hibernate 一律按 NOT NULL 添加，在已有数据的表上
 * {@code ALTER TABLE ... ADD COLUMN owner_id BIGINT NOT NULL} 会失败（旧行没有值）。
 * 所以先以可空列加上、把旧数据归到最早的用户，Hibernate 再更新时看到列已存在就不会再动它。</p>
 *
 * <p>只处理「表已存在且还没有 owner_id 列」的情况；新库或已迁移过的库什么都不做。</p>
 */
@Configuration
public class PreSchemaMigration {

    static final List<String> LEGACY_TABLES = List.of("courses", "course_schedules", "tasks", "task_sources", "attachments");

    @Bean
    OwnerColumnBackfill ownerColumnBackfill(DataSource dataSource) {
        return new OwnerColumnBackfill(dataSource);
    }

    /** 让 EntityManagerFactory（也就是 Hibernate 的表结构更新）等这一步完成。 */
    @Bean
    static EntityManagerFactoryDependsOnPostProcessor ownerColumnBackfillBeforeJpa() {
        return new EntityManagerFactoryDependsOnPostProcessor("ownerColumnBackfill");
    }

    static final class OwnerColumnBackfill implements InitializingBean {

        private static final Logger log = LoggerFactory.getLogger(OwnerColumnBackfill.class);

        private final DataSource dataSource;

        OwnerColumnBackfill(DataSource dataSource) {
            this.dataSource = dataSource;
        }

        @Override
        public void afterPropertiesSet() throws SQLException {
            try (Connection connection = dataSource.getConnection()) {
                DatabaseMetaData meta = connection.getMetaData();
                if (!exists(meta, "app_users", null)) {
                    return; // 全新库：表都由 Hibernate 创建
                }
                Long owner = firstUserId(connection);
                for (String table : LEGACY_TABLES) {
                    if (!exists(meta, table, null) || exists(meta, table, "owner_id")) {
                        continue;
                    }
                    try (Statement st = connection.createStatement()) {
                        st.execute("ALTER TABLE " + table + " ADD COLUMN owner_id BIGINT");
                        if (owner != null) {
                            int n = st.executeUpdate("UPDATE " + table + " SET owner_id = " + owner + " WHERE owner_id IS NULL");
                            log.info("迁移（表结构前）：{} 补上 owner_id，{} 条旧数据归到用户 id={}", table, n, owner);
                        }
                    }
                }
            }
        }

        private static Long firstUserId(Connection connection) throws SQLException {
            try (Statement st = connection.createStatement(); ResultSet rs = st.executeQuery("SELECT MIN(id) FROM app_users")) {
                if (rs.next()) {
                    long id = rs.getLong(1);
                    return rs.wasNull() ? null : id;
                }
                return null;
            }
        }

        private static boolean exists(DatabaseMetaData meta, String table, String column) throws SQLException {
            for (String t : new String[] { table, table.toUpperCase(Locale.ROOT) }) {
                if (column == null) {
                    try (ResultSet rs = meta.getTables(null, null, t, new String[] { "TABLE" })) {
                        if (rs.next()) {
                            return true;
                        }
                    }
                } else {
                    for (String c : new String[] { column, column.toUpperCase(Locale.ROOT) }) {
                        try (ResultSet rs = meta.getColumns(null, null, t, c)) {
                            if (rs.next()) {
                                return true;
                            }
                        }
                    }
                }
            }
            return false;
        }
    }
}
