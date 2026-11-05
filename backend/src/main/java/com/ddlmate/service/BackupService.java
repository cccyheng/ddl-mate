package com.ddlmate.service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import javax.sql.DataSource;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import com.ddlmate.common.InvalidRequestException;
import com.ddlmate.common.TimeZones;
import com.ddlmate.tenant.OwnerResolver;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 网页版整库备份 / 恢复（格式 {@code ddlmate.web-backup} v1）。
 *
 * <p>导出：课程、课表、任务、原通知、附件（含图片字节）与键值设置，逐表逐列原样导出。
 * 时间列导出为不带时区的「库内原值」字符串，恢复时原样写回，与运行机器的时区无关。</p>
 *
 * <p>按用户：只导出 / 恢复当前登录用户自己的数据（owner_id 不写进备份文件，恢复时写成当前用户）。</p>
 *
 * <p>恢复：整体替换自己的数据，<strong>保留原 id</strong>。设置里的 JSON（今日计划、复习安排、
 * 重复任务账本、{@code task_steps.<id>} 等）引用的都是任务 / 课程 id，保留 id 后无需改写，
 * 也就不会出现引用错位。恢复前先把当前数据完整导出到 {@code backups/} 目录作为安全副本。</p>
 */
@Service
public class BackupService {

    public static final String FORMAT = "ddlmate.web-backup";
    public static final int VERSION = 2;

    /** 恢复写入顺序（删除时倒序），保证外键先有父后有子。 */
    static final List<String> TABLES = List.of("courses", "course_schedules", "tasks", "task_sources", "attachments",
            "user_settings");

    /** 有全站唯一 id、恢复时保留原 id 的表（设置行没有被引用，恢复时重新分配 id）。 */
    static final List<String> ID_TABLES = List.of("courses", "course_schedules", "tasks", "task_sources", "attachments");

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final JdbcTemplate jdbc;
    private final DataSource dataSource;
    private final StorageService storageService;
    private final ObjectMapper objectMapper;
    private final OwnerResolver ownerResolver;

    public BackupService(JdbcTemplate jdbc, DataSource dataSource, StorageService storageService,
            ObjectMapper objectMapper, OwnerResolver ownerResolver) {
        this.ownerResolver = ownerResolver;
        this.jdbc = jdbc;
        this.dataSource = dataSource;
        this.storageService = storageService;
        this.objectMapper = objectMapper;
    }

    /* ------------------------------------------------------------------ 导出 */

    @Transactional(readOnly = true)
    public Map<String, Object> export() {
        long owner = currentOwner();
        Map<String, Object> tables = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String table : TABLES) {
            List<Map<String, Object>> rows = readTable(table, owner);
            tables.put(table, rows);
            counts.put(table, rows.size());
        }
        Map<String, String> files = new LinkedHashMap<>();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> attachments = (List<Map<String, Object>>) tables.get("attachments");
        int missingFiles = 0;
        for (Map<String, Object> row : attachments) {
            String relative = String.valueOf(row.get("relative_path"));
            Path path = storageService.resolveInsideRoot(relative);
            try {
                files.put(relative, Base64.getEncoder().encodeToString(Files.readAllBytes(path)));
            } catch (IOException ex) {
                missingFiles++;
            }
        }
        Map<String, Object> backup = new LinkedHashMap<>();
        backup.put("format", FORMAT);
        backup.put("version", VERSION);
        backup.put("exportedAt", TimeZones.now().toString());
        backup.put("counts", counts);
        backup.put("missingFiles", missingFiles);
        backup.put("tables", tables);
        backup.put("files", files);
        return backup;
    }

    /** 只读当前用户的行；owner_id 不导出，设置行的 id 也不导出（恢复时重新分配）。 */
    private List<Map<String, Object>> readTable(String table, long owner) {
        boolean dropId = !ID_TABLES.contains(table);
        ResultSetExtractor<List<Map<String, Object>>> extractor = (ResultSet rs) -> {
            List<Map<String, Object>> rows = new ArrayList<>();
            ResultSetMetaData meta = rs.getMetaData();
            while (rs.next()) {
                Map<String, Object> row = new LinkedHashMap<>();
                for (int i = 1; i <= meta.getColumnCount(); i++) {
                    String column = meta.getColumnLabel(i).toLowerCase(Locale.ROOT);
                    if ("owner_id".equals(column) || (dropId && "id".equals(column))) {
                        continue;
                    }
                    row.put(column, readValue(rs, i, meta.getColumnType(i)));
                }
                rows.add(row);
            }
            return rows;
        };
        return jdbc.query("SELECT * FROM " + table + " WHERE owner_id = ? ORDER BY id", extractor, owner);
    }

    private static Object readValue(ResultSet rs, int index, int sqlType) throws SQLException {
        Object value = switch (sqlType) {
            case Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> rs.getObject(index, LocalDateTime.class);
            case Types.DATE -> rs.getObject(index, LocalDate.class);
            case Types.TIME, Types.TIME_WITH_TIMEZONE -> rs.getObject(index, LocalTime.class);
            case Types.CLOB, Types.NCLOB -> rs.getString(index);
            default -> rs.getObject(index);
        };
        return value instanceof LocalDateTime || value instanceof LocalDate || value instanceof LocalTime
                ? value.toString()
                : value;
    }

    /* ------------------------------------------------------------------ 校验 / 预览 */

    /** 只读校验并返回计数；不合法直接抛 400，绝不写库。 */
    public Map<String, Object> preview(Map<String, Object> backup) {
        Map<String, List<Map<String, Object>>> tables = validate(backup);
        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        tables.forEach((table, rows) -> counts.put(table, rows.size()));
        result.put("format", FORMAT);
        result.put("version", VERSION);
        result.put("exportedAt", backup.get("exportedAt"));
        result.put("counts", counts);
        result.put("fileCount", filesOf(backup).size());
        long owner = currentOwner();
        Map<String, Integer> current = new LinkedHashMap<>();
        for (String table : TABLES) {
            current.put(table, jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE owner_id = ?", Integer.class, owner));
        }
        result.put("currentCounts", current);
        return result;
    }

    @SuppressWarnings("unchecked")
    private Map<String, List<Map<String, Object>>> validate(Map<String, Object> backup) {
        if (backup == null || !FORMAT.equals(backup.get("format"))) {
            throw new InvalidRequestException("format", "这不是 DDL Mate 网页版备份文件。");
        }
        if (!(backup.get("version") instanceof Number number) || (number.intValue() != VERSION && number.intValue() != 1)) {
            throw new InvalidRequestException("version", "备份文件版本不认识（支持 v1、v" + VERSION + "）。");
        }
        if (!(backup.get("tables") instanceof Map<?, ?> raw)) {
            throw new InvalidRequestException("tables", "备份文件缺少数据表。");
        }
        // v1（单人版）：设置在 app_settings 表里，列名相同
        boolean v1 = number.intValue() == 1;
        Map<String, List<Map<String, Object>>> tables = new LinkedHashMap<>();
        for (String table : TABLES) {
            Object rows = raw.get(v1 && "user_settings".equals(table) ? "app_settings" : table);
            if (!(rows instanceof List<?> list)) {
                throw new InvalidRequestException("tables", "备份文件缺少数据表：" + table);
            }
            for (Object row : list) {
                if (!(row instanceof Map<?, ?>)) {
                    throw new InvalidRequestException("tables", table + " 里有无法识别的记录。");
                }
            }
            tables.put(table, (List<Map<String, Object>>) rows);
        }
        Set<Object> courseIds = ids(tables.get("courses"), "id");
        Set<Object> taskIds = ids(tables.get("tasks"), "id");
        Set<Object> sourceIds = ids(tables.get("task_sources"), "id");
        requireRefs(tables.get("course_schedules"), "course_id", courseIds, false, "课表引用了不存在的课程。");
        requireRefs(tables.get("tasks"), "course_id", courseIds, true, "任务引用了不存在的课程。");
        requireRefs(tables.get("task_sources"), "task_id", taskIds, true, "原通知引用了不存在的任务。");
        requireRefs(tables.get("attachments"), "task_source_id", sourceIds, false, "附件引用了不存在的原通知。");
        Map<String, String> files = filesOf(backup);
        for (Map<String, Object> attachment : tables.get("attachments")) {
            String relative = String.valueOf(attachment.get("relative_path"));
            storageService.resolveInsideRoot(relative); // 路径越界直接拒绝
            if (!files.containsKey(relative)) {
                throw new InvalidRequestException("files", "附件文件缺失：" + relative);
            }
        }
        for (Map<String, Object> setting : tables.get("user_settings")) {
            if (!SettingsService.isAllowedKey(String.valueOf(setting.get("setting_key")))) {
                throw new InvalidRequestException("user_settings", "备份里有不认识的设置项：" + setting.get("setting_key"));
            }
        }
        return tables;
    }

    private static Set<Object> ids(List<Map<String, Object>> rows, String column) {
        Set<Object> ids = new HashSet<>();
        for (Map<String, Object> row : rows) {
            Object id = row.get(column);
            if (!(id instanceof Number number) || !ids.add(number.longValue())) {
                throw new InvalidRequestException("tables", "备份里有缺失或重复的 id。");
            }
        }
        return ids;
    }

    private static void requireRefs(List<Map<String, Object>> rows, String column, Set<Object> parents,
            boolean nullable, String message) {
        for (Map<String, Object> row : rows) {
            Object ref = row.get(column);
            if (ref == null && nullable) {
                continue;
            }
            if (!(ref instanceof Number number) || !parents.contains(number.longValue())) {
                throw new InvalidRequestException("tables", message);
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> filesOf(Map<String, Object> backup) {
        Object files = backup.get("files");
        return files instanceof Map<?, ?> map ? (Map<String, String>) map : Map.of();
    }

    /* ------------------------------------------------------------------ 恢复 */

    /**
     * 整体替换。先写安全副本，再在同一事务里清空并按原 id 写回；任何一步失败整体回滚，旧数据保持原样。
     *
     * @return 恢复后的计数与安全副本的位置
     */
    @Transactional
    public Map<String, Object> restore(Map<String, Object> backup) {
        Map<String, List<Map<String, Object>>> tables = validate(backup);
        long owner = currentOwner();
        rejectForeignIds(tables, owner);
        Path safetyCopy = writeSafetyCopy(owner);

        for (int i = TABLES.size() - 1; i >= 0; i--) {
            jdbc.update("DELETE FROM " + TABLES.get(i) + " WHERE owner_id = ?", owner);
        }
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String table : TABLES) {
            Map<String, Integer> columnTypes = columnTypes(table);
            boolean keepId = ID_TABLES.contains(table);
            for (Map<String, Object> row : tables.get(table)) {
                Map<String, Object> owned = new LinkedHashMap<>(row);
                owned.remove("owner_id");
                if (!keepId) {
                    owned.remove("id");
                }
                owned.put("owner_id", owner);
                insert(table, owned, columnTypes);
            }
            counts.put(table, tables.get(table).size());
        }
        // ALTER TABLE 在 H2 / MySQL 里都会隐式提交，必须放到事务提交之后，否则会破坏「失败整体回滚」
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                for (String table : TABLES) {
                    restartIdentity(table);
                }
            }
        });

        Map<String, String> files = filesOf(backup);
        for (Map<String, Object> attachment : tables.get("attachments")) {
            String relative = String.valueOf(attachment.get("relative_path"));
            Path target = storageService.resolveInsideRoot(relative);
            try {
                Files.createDirectories(target.getParent());
                Files.write(target, Base64.getDecoder().decode(files.get(relative)));
            } catch (IOException | IllegalArgumentException ex) {
                throw new InvalidRequestException("files", "附件写回失败：" + relative);
            }
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("counts", counts);
        result.put("safetyCopy", safetyCopy.toAbsolutePath().toString());
        return result;
    }

    /**
     * id 是全站共用的：备份里的 id 如果已经属于别的账号（例如拿别人的备份来恢复），按原 id 写回会冲突，直接拒绝。
     * 自己导出、自己恢复时，这些 id 只会属于自己（或已被自己删掉），不会冲突。
     */
    private void rejectForeignIds(Map<String, List<Map<String, Object>>> tables, long owner) {
        for (String table : ID_TABLES) {
            List<Long> ids = tables.get(table).stream().map(r -> ((Number) r.get("id")).longValue()).toList();
            for (int from = 0; from < ids.size(); from += 500) {
                List<Long> chunk = ids.subList(from, Math.min(ids.size(), from + 500));
                String marks = String.join(",", chunk.stream().map(x -> "?").toList());
                List<Object> params = new ArrayList<>(chunk);
                params.add(owner);
                Integer clash = jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE id IN (" + marks
                        + ") AND (owner_id IS NULL OR owner_id <> ?)", Integer.class, params.toArray());
                if (clash != null && clash > 0) {
                    throw new InvalidRequestException("tables",
                            "这份备份里的数据编号已被本站其他账号使用（可能不是你自己导出的备份），无法恢复。");
                }
            }
        }
    }

    private long currentOwner() {
        long owner = ownerResolver.resolveCurrentTenantIdentifier();
        if (owner <= 0) {
            throw new IllegalStateException("没有登录用户，不能备份或恢复");
        }
        return owner;
    }

    private Path writeSafetyCopy(long owner) {
        Path dir = storageService.getRoot().toAbsolutePath().getParent().resolve("backups");
        Path file = dir.resolve("pre-restore-u" + owner + "-" + TimeZones.now().format(STAMP) + ".json");
        try {
            Files.createDirectories(dir);
            objectMapper.writeValue(file.toFile(), export());
        } catch (IOException ex) {
            throw new IllegalStateException("恢复前的安全副本写入失败，已取消恢复：" + ex.getMessage(), ex);
        }
        return file;
    }

    private Map<String, Integer> columnTypes(String table) {
        try (Connection connection = dataSource.getConnection()) {
            DatabaseMetaData meta = connection.getMetaData();
            Map<String, Integer> types = new LinkedHashMap<>();
            for (String name : new String[] { table, table.toUpperCase(Locale.ROOT) }) {
                try (ResultSet columns = meta.getColumns(null, null, name, null)) {
                    while (columns.next()) {
                        types.put(columns.getString("COLUMN_NAME").toLowerCase(Locale.ROOT), columns.getInt("DATA_TYPE"));
                    }
                }
                if (!types.isEmpty()) {
                    break;
                }
            }
            return types;
        } catch (SQLException ex) {
            throw new IllegalStateException("读取表结构失败：" + table, ex);
        }
    }

    private void insert(String table, Map<String, Object> row, Map<String, Integer> columnTypes) {
        List<String> columns = new ArrayList<>();
        List<Object> values = new ArrayList<>();
        for (Map.Entry<String, Object> entry : row.entrySet()) {
            String column = entry.getKey().toLowerCase(Locale.ROOT);
            Integer type = columnTypes.get(column);
            if (type == null) {
                continue; // 备份里有、当前库已没有的列：忽略
            }
            columns.add(column);
            values.add(convert(entry.getValue(), type));
        }
        String placeholders = String.join(",", columns.stream().map(c -> "?").toList());
        jdbc.update("INSERT INTO " + table + " (" + String.join(",", columns) + ") VALUES (" + placeholders + ")",
                values.toArray());
    }

    private static Object convert(Object value, int sqlType) {
        if (!(value instanceof String text)) {
            return value;
        }
        return switch (sqlType) {
            case Types.TIMESTAMP, Types.TIMESTAMP_WITH_TIMEZONE -> LocalDateTime.parse(text);
            case Types.DATE -> LocalDate.parse(text);
            case Types.TIME, Types.TIME_WITH_TIMEZONE -> LocalTime.parse(text);
            default -> text;
        };
    }

    /** 保留原 id 写回后，把自增起点推到最大 id 之后，后续新建不会撞号。 */
    private void restartIdentity(String table) {
        Long max = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM " + table, Long.class);
        long next = (max == null ? 0 : max) + 1;
        String product;
        try (Connection connection = dataSource.getConnection()) {
            product = connection.getMetaData().getDatabaseProductName().toLowerCase(Locale.ROOT);
        } catch (SQLException ex) {
            throw new IllegalStateException(ex);
        }
        if (product.contains("h2")) {
            jdbc.execute("ALTER TABLE " + table + " ALTER COLUMN id RESTART WITH " + next);
        } else {
            jdbc.execute("ALTER TABLE " + table + " AUTO_INCREMENT = " + next);
        }
    }
}
