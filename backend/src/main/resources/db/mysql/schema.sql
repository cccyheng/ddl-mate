-- =====================================================================
-- DDL Mate 正式数据库建库脚本（MySQL 8.0）
-- 用法：
--   mysql -u root -p < backend/src/main/resources/db/mysql/schema.sql
-- 然后使用 mysql profile 启动（ddl-auto=validate 只校验实体与表结构一致）：
--   mvn -f backend/pom.xml spring-boot:run -Dspring-boot.run.profiles=mysql
--
-- 注意：本机当前没有 MySQL，本脚本未经实测（见 docs/verification.md）。
-- =====================================================================

CREATE DATABASE IF NOT EXISTS ddl_mate
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_0900_ai_ci;

-- 应用账号（请把密码改成自己的）
CREATE USER IF NOT EXISTS 'ddl_mate'@'127.0.0.1' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON ddl_mate.* TO 'ddl_mate'@'127.0.0.1';
FLUSH PRIVILEGES;

USE ddl_mate;

-- 本地用户资料（V1 单人；多用户上线前会在这里扩展并给业务表加 user_id）
CREATE TABLE IF NOT EXISTS app_users (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    username     VARCHAR(64)  NOT NULL,
    display_name VARCHAR(64)  NOT NULL,
    time_zone    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
    created_at   DATETIME(6)  NOT NULL,
    updated_at   DATETIME(6)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_app_users_username (username)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS courses (
    id         BIGINT       NOT NULL AUTO_INCREMENT,
    code       VARCHAR(32)  NOT NULL,
    name       VARCHAR(128) NOT NULL,
    instructor VARCHAR(64)  NULL,
    semester   VARCHAR(32)  NULL,
    color      VARCHAR(16)  NULL,
    note       VARCHAR(500) NULL,
    created_at DATETIME(6)  NOT NULL,
    updated_at DATETIME(6)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_courses_code (code)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS course_schedules (
    id                  BIGINT       NOT NULL AUTO_INCREMENT,
    course_id           BIGINT       NOT NULL,
    weekday             INT          NOT NULL,
    start_time          TIME         NOT NULL,
    end_time            TIME         NOT NULL,
    location            VARCHAR(128) NULL,
    teacher             VARCHAR(128) NULL,
    period_start        INT          NULL,
    period_end          INT          NULL,
    week_range          VARCHAR(32)  NULL,
    -- 教学周规则（2026-10 新增，全部可空以兼容旧数据）：
    -- semester_start_date 为学期第一周周一；三者齐全时才按起止周 + 单双周过滤，否则按"每周"处理。
    semester_start_date DATE         NULL,
    start_week          INT          NULL,
    end_week            INT          NULL,
    week_pattern        VARCHAR(8)   NULL,
    created_at          DATETIME(6)  NOT NULL,
    updated_at          DATETIME(6)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_schedule_weekday (weekday),
    KEY idx_schedule_course (course_id),
    CONSTRAINT fk_schedule_course FOREIGN KEY (course_id) REFERENCES courses (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- ---------------------------------------------------------------------
-- 旧库升级（已有 ddl_mate 库时执行一次；新库无需执行）
-- H2 开发库由 Hibernate ddl-auto=update 自动加列，不会丢数据。
-- ---------------------------------------------------------------------
-- ALTER TABLE course_schedules
--     ADD COLUMN semester_start_date DATE         NULL AFTER week_range,
--     ADD COLUMN start_week          INT          NULL AFTER semester_start_date,
--     ADD COLUMN end_week            INT          NULL AFTER start_week,
--     ADD COLUMN week_pattern        VARCHAR(8)   NULL AFTER end_week;


CREATE TABLE IF NOT EXISTS tasks (
    id                 BIGINT        NOT NULL AUTO_INCREMENT,
    title              VARCHAR(200)  NOT NULL,
    description        VARCHAR(1000) NULL,
    course_id          BIGINT        NULL,
    type               VARCHAR(32)   NOT NULL,
    status             VARCHAR(16)   NOT NULL,
    priority           INT           NOT NULL,
    deadline           DATETIME(6)   NULL,
    estimated_minutes  INT           NULL,
    submit_requirement VARCHAR(500)  NULL,
    submit_method      VARCHAR(128)  NULL,
    completed_at       DATETIME(6)   NULL,
    created_at         DATETIME(6)   NOT NULL,
    updated_at         DATETIME(6)   NOT NULL,
    PRIMARY KEY (id),
    KEY idx_task_deadline (deadline),
    KEY idx_task_status (status),
    KEY idx_task_course (course_id),
    CONSTRAINT fk_task_course FOREIGN KEY (course_id) REFERENCES courses (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS task_sources (
    id          BIGINT        NOT NULL AUTO_INCREMENT,
    task_id     BIGINT        NULL,
    source_name VARCHAR(128)  NOT NULL,
    source_type VARCHAR(32)   NULL,
    raw_text    VARCHAR(4000) NULL,
    captured_at DATETIME(6)   NULL,
    created_at  DATETIME(6)   NOT NULL,
    PRIMARY KEY (id),
    KEY idx_source_task (task_id),
    CONSTRAINT fk_source_task FOREIGN KEY (task_id) REFERENCES tasks (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS attachments (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    task_source_id BIGINT       NOT NULL,
    stored_name    VARCHAR(128) NOT NULL,
    original_name  VARCHAR(255) NOT NULL,
    content_type   VARCHAR(64)  NOT NULL,
    size_bytes     BIGINT       NOT NULL,
    relative_path  VARCHAR(255) NOT NULL,
    created_at     DATETIME(6)  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_attachment_source (task_source_id),
    CONSTRAINT fk_attachment_source FOREIGN KEY (task_source_id) REFERENCES task_sources (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 键值设置：专注 / 计划 / 模板 / 复习等功能的紧凑 JSON（键名与取值格式同手机端 app_settings）
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key   VARCHAR(96)  NOT NULL,
    setting_value LONGTEXT     NOT NULL,
    revision      BIGINT       NOT NULL,
    updated_at    DATETIME(6)  NOT NULL,
    PRIMARY KEY (setting_key)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 问题反馈：不按用户隔离，站长查看全部；普通用户只能查自己的
CREATE TABLE IF NOT EXISTS feedback (
    id          BIGINT        NOT NULL AUTO_INCREMENT,
    user_id     BIGINT        NOT NULL,
    username    VARCHAR(64)   NOT NULL,
    category    VARCHAR(16)   NOT NULL,
    content     VARCHAR(2000) NOT NULL,
    contact     VARCHAR(100)  NULL,
    page        VARCHAR(200)  NULL,
    user_agent  VARCHAR(300)  NULL,
    status      VARCHAR(16)   NOT NULL,
    reply       VARCHAR(1000) NULL,
    replied_at  DATETIME(6)   NULL,
    created_at  DATETIME(6)   NOT NULL,
    updated_at  DATETIME(6)   NOT NULL,
    PRIMARY KEY (id),
    KEY idx_feedback_user (user_id),
    KEY idx_feedback_status (status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
