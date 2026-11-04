/**
 * 本地 SQLite 表结构与版本管理。
 *
 * 设计要点：
 * - **外键约束开启**（`PRAGMA foreign_keys = ON`），但 `tasks.course_id` 用 `ON DELETE SET NULL`：
 *   删除课程时任务会保留并变为「未关联课程」，绝不静默删除用户任务；
 *   删除是否真的执行由仓库层用「显式确认」把关。
 * - `schedules.course_id` 用 `ON DELETE CASCADE`（课表从属于课程，单独存在没有意义）。
 * - `task_sources` 保存**原始通知文本**，随任务级联删除，且编辑任务时不会被覆盖。
 * - 时间列存**带显式偏移的 ISO 字符串**（`2026-10-15T22:00:00+08:00`）；
 *   唯一的例外是 `tasks.deadline`：它还可能存只到日期的 `YYYY-MM-DD`
 *   （表示当天结束前），因此读 DDL 必须走 `deadline*` 辅助函数。
 */

export const SCHEMA_VERSION = 3

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS courses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  instructor    TEXT,
  semester      TEXT,
  color         TEXT,
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id           INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  weekday             INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time          TEXT    NOT NULL,
  end_time            TEXT    NOT NULL,
  location            TEXT,
  period_start        INTEGER,
  period_end          INTEGER,
  week_range          TEXT,
  semester_start_date TEXT,
  start_week          INTEGER,
  end_week            INTEGER,
  week_pattern        TEXT    NOT NULL DEFAULT 'ALL' CHECK (week_pattern IN ('ALL','ODD','EVEN')),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  title              TEXT    NOT NULL,
  description        TEXT,
  course_id          INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  type               TEXT    NOT NULL DEFAULT 'HOMEWORK',
  status             TEXT    NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','DOING','DONE','CANCELLED')),
  priority           INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
  deadline           TEXT,
  estimated_minutes  INTEGER,
  submit_requirement TEXT,
  submit_method      TEXT,
  completed_at       TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS task_sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'ORIGINAL_TEXT' CHECK (kind IN ('ORIGINAL_TEXT','MANUAL')),
  raw_text   TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_course   ON schedules(course_id);
CREATE INDEX IF NOT EXISTS idx_schedules_weekday  ON schedules(weekday);
CREATE INDEX IF NOT EXISTS idx_tasks_course       ON tasks(course_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline     ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_task_sources_task  ON task_sources(task_id);
`

/**
 * v2：全局「教学周校准」设置表。
 *
 * 为什么是独立的键值表而不是往 `schedules` 加列：
 * - 这是**每个学期一次**的全局设置，不属于任何一条课表；放在课表里会随课程级联删除丢掉；
 * - 只做 `ALTER TABLE ... ADD COLUMN` 无法表达「一次校准」的语义；
 * - 键值表让以后新增设置项不需要每次都改表结构。
 *
 * 非破坏性：只 `CREATE TABLE IF NOT EXISTS`，不动任何既有数据。
 */
export const APP_SETTINGS_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export const APP_SETTINGS_KEYS = {
  /** 学期第一周周一（`YYYY-MM-DD`）。 */
  SEMESTER_START_MONDAY: 'teaching_week.semester_start_monday',
  /** 校准当时的「今天是第几教学周」。 */
  CALIBRATED_WEEK: 'teaching_week.calibrated_week',
  /** 校准当时的北京时间自然日（`YYYY-MM-DD`）。 */
  CALIBRATED_TODAY: 'teaching_week.calibrated_today',
  /** 校准写入时间（ISO 字符串）。 */
  CALIBRATED_AT: 'teaching_week.calibrated_at',
  /**
   * 照片识别用的本机伴侣服务地址（例如 `http://192.168.1.5:8082`）。
   *
   * **刻意存成本机设置而不是编译期常量**：不想把某个人的局域网 IP 写死进 App。
   * 首次使用时会尝试用 Expo/Metro 的局域网主机名自动推断，用户也可以自己改。
   */
  OCR_COMPANION_ENDPOINT: 'photo_ocr.companion_endpoint',
  /**
   * 用户**可选**设置的每日学习参考用时（整数分钟，1–1440；未设置 = 这一项不存在）。
   *
   * 只用于「DDL 压力分析」里跟已填预计用时做比较的展示，**不是**日程、不是承诺，
   * 也不会被用来改动任何任务或课表。缺省就是「没有设置」，绝不编一个默认值。
   * 存在既有的 `app_settings` 键值表里，因此**不需要任何表结构或版本变更**。
   */
  DAILY_STUDY_REFERENCE_MINUTES: 'pressure.daily_study_reference_minutes',
  /**
   * 今日学习计划（**带版本号的紧凑 JSON**，见 `domain/todayPlanRepository.ts`）。
   *
   * 与参考用时同一个考虑：写进既有键值表，因此**不需要任何表结构或版本变更**。
   * 内容只有「用户显式填的时段 + 选中的任务与计划分钟数 + 重算出来的块 + 输入指纹」，
   * 不含任何凭据，也不含整个 App 的数据。
   */
  TODAY_PLAN: 'daily_plan.today',
  /**
   * **本机通知路由代次**（只在本机递增，绝不随备份导入）。
   *
   * 恢复成功后 +1，旧通知载荷里的代次就与当前值不一致，点击时不会按
   * 「可能被复用的任务 ID」打开恢复后的另一条任务。旧载荷没有这个字段时按 0 处理：
   * 第一次恢复后（当前值 ≥1）同样会被拒绝。
   */
  NOTIFICATION_ROUTE_GENERATION: 'notification.route_generation',
  /**
   * 任务模板库（**带版本号的紧凑 JSON**，见 `domain/taskTemplate.ts`）。
   *
   * 刻意复用既有 `app_settings` 键值表，而不是新增表：
   * - 一个学生用户的模板 / 重复规则数量很小，整表 JSON 读写足够；
   * - **不改变 `SCHEMA_VERSION`**，因此旧版 v1 备份（appSchemaVersion = 3）
   *   仍然能被当前应用解析，不会因为新增功能就要求用户先升级或重置数据；
   * - 备份 / 恢复的严格设置白名单只需认识这一个键，恢复时与其它设置同事务替换。
   *
   * 内容有严格上限（模板数、规则数、账本条数、序列化字节数），
   * 读回时任何一项不合法都报可读原因，绝不静默截断。
   */
  TASK_TEMPLATES: 'task_templates.v1',
  /**
   * 重复任务规则 + 生成账本（带版本号 JSON，见 `domain/recurrence.ts`）。
   *
   * 账本记录 `(规则ID, 日期) → 任务ID`，与任务创建在**同一个 SQLite 事务**里写入，
   * 因此重复点击 / 重试 / 重开同一份已确认预览不会创建重复任务；
   * 用户删掉某次生成的任务后，账本仍记得这个日期（任务ID 指向已删除的历史），
   * 再次生成会明确跳过，而不是悄悄补回来。
   */
  TASK_RECURRENCE: 'task_recurrence.v1',
} as const

/**
 * 「任务步骤清单」在 `app_settings` 里的**键前缀**：`task_steps.<任务ID>`。
 *
 * 每个任务一条独立记录（键里带精确的任务 ID），因此：
 * - 删除某条任务时可以只删它自己那一个键，不会误伤别的任务的清单；
 * - 读取某个任务的清单是一次主键查询，不需要扫描 / 解析全部设置。
 *
 * 与今日计划同一个考虑：**复用既有键值表**，因此不需要任何表结构或版本变更。
 */
export const TASK_STEPS_KEY_PREFIX = 'task_steps.'

/**
 * 某个任务的步骤清单在 `app_settings` 里的**精确键**。
 *
 * 只接受**正整数**任务 ID；其它输入返回 `null`（调用方据此拒绝，
 * 绝不去拼一个 `task_steps.NaN` 之类的键）。
 */
export function taskStepsKey(taskId: number): string | null {
  if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return null
  return `${TASK_STEPS_KEY_PREFIX}${taskId}`
}

/**
 * v3：**截图库**（用户提交给 App 的每一张图都要留在软件里）+ **选课序号**。
 *
 * 为什么用「文件落盘 + 数据库索引」而不是把图片塞进 BLOB：
 * - 20 张课表截图各 0.5–2MB，塞进 SQLite 会让整库膨胀到几十 MB，
 *   每次 `VACUUM`/备份/读写都变慢，而且没有任何好处；
 * - 文件放在应用私有 `Documents` 目录里，关闭 Expo Go / 重开 App 之后仍然在
 *   （`expo-image-picker` 给的是**临时** URI，重开就失效 —— 那正是要修的问题）。
 *
 * 表之间的关系（**绝不静默删除用户数据**）：
 * - `screenshot_attempts`：一次「选图/拍照 → 归档 → 识别」的尝试。原图字节先归档，
 *   再开始识别；因此**识别失败/用户取消**的图同样留存，`status` 如实记录。
 * - `source_screenshots`：历史已知来源（例如 `.tools/photo/retained-original.png`）。
 *   它们**不是**用户手机上的图，只作为「可恢复来源」登记在册，不放进公开默认值。
 * - `screenshot_refs`：把截图挂到课程 / 课表 / 任务 / 尝试上。历史关联仍然没有业务删除路径；
 *   唯一的例外是「任务原图」模块里**用户显式解除**的自己添加的 `MANUAL_TASK_PHOTO`
 *   关联（只删这一条引用；原图文件、OCR 结果与其它历史 / 课程 / 其它任务关联一律保留）。
 * - `ocr_results`：每次识别的结果（成功或失败），与尝试 1:1 或 1:N。
 * - `ocr_candidate_rows`：识别出来的候选行原文 + 用户最终导入时用的值，
 *   便于「从课程回看当初是哪一行」。
 *
 * 全部是 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`，
 * 既不删表也不改既有列，既有课程 / 课表 / 任务 / 原始文本一律不动。
 */
export const SCREENSHOT_LIBRARY_SQL = `
CREATE TABLE IF NOT EXISTS screenshot_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at       TEXT    NOT NULL,
  source            TEXT    NOT NULL CHECK (source IN ('LIBRARY','CAMERA','ARCHIVE','OTHER')),
  status            TEXT    NOT NULL CHECK (status IN ('ARCHIVED','UPLOADING','SUCCEEDED','FAILED','CANCELLED','ARCHIVE_FAILED')),
  archived_path     TEXT,
  original_uri      TEXT,
  sha256            TEXT,
  byte_length       INTEGER,
  width             INTEGER,
  height            INTEGER,
  format            TEXT,
  mime_type         TEXT,
  upload_format     TEXT,
  upload_scale      REAL,
  upload_quality    REAL,
  upload_byte_length INTEGER,
  resized           INTEGER NOT NULL DEFAULT 0,
  dedup_of_attempt_id INTEGER REFERENCES screenshot_attempts(id) ON DELETE SET NULL,
  error_code        TEXT,
  error_message     TEXT,
  note              TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS source_screenshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  catalog_key     TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  description     TEXT,
  archive_rel_path TEXT   NOT NULL,
  sha256          TEXT,
  byte_length     INTEGER,
  width           INTEGER,
  height          INTEGER,
  layout          TEXT,
  captured_at     TEXT,
  provenance      TEXT,
  foreign_attempt_id INTEGER REFERENCES screenshot_attempts(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS screenshot_refs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id    INTEGER NOT NULL REFERENCES screenshot_attempts(id) ON DELETE CASCADE,
  target_kind   TEXT    NOT NULL CHECK (target_kind IN ('COURSE','SCHEDULE','TASK','ATTEMPT')),
  target_id     INTEGER NOT NULL,
  relation      TEXT    NOT NULL DEFAULT 'SOURCE',
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ocr_results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id     INTEGER NOT NULL REFERENCES screenshot_attempts(id) ON DELETE CASCADE,
  request_id     TEXT,
  layout         TEXT,
  week           integer,
  status         TEXT    NOT NULL CHECK (status IN ('SUCCESS','FAILED','CANCELLED')),
  error_code     TEXT,
  error_message  TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  warnings_json  TEXT,
  payload_json   TEXT,
  raw_text       TEXT,
  ocr_calls      INTEGER,
  duration_ms    INTEGER,
  image_width    INTEGER,
  image_height   INTEGER,
  image_format   TEXT,
  image_bytes    INTEGER,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS ocr_candidate_rows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id     INTEGER NOT NULL REFERENCES ocr_results(id) ON DELETE CASCADE,
  row_index     INTEGER NOT NULL,
  name          TEXT,
  weekday       INTEGER,
  start_time    TEXT,
  end_time    TEXT,
  location      TEXT,
  start_week    INTEGER,
  end_week      INTEGER,
  week_pattern  TEXT,
  selection_serial TEXT,
  raw_text      TEXT,
  warnings_json TEXT,
  imported      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_captured   ON screenshot_attempts(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_sha        ON screenshot_attempts(sha256);
CREATE INDEX IF NOT EXISTS idx_refs_attempt        ON screenshot_refs(attempt_id);
CREATE INDEX IF NOT EXISTS idx_refs_target         ON screenshot_refs(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_ocr_results_attempt ON ocr_results(attempt_id);
CREATE INDEX IF NOT EXISTS idx_ocr_rows_result     ON ocr_candidate_rows(result_id);
CREATE INDEX IF NOT EXISTS idx_source_attempt      ON source_screenshots(foreign_attempt_id);
`

/**
 * v3 的列扩展（幂等：先查 `PRAGMA table_info` 再决定加不加）。
 *
 * `selection_serial` = 选课序号（截图里课程名后面括号里的那串，例如 `9913000172.08`）。
 * 它**不是**学校课程代码，也**不是** App 自己生成的 `AUTO-01` 内部编号，
 * 因此必须是独立列，既不覆盖 `courses.code`，也不被任何自动流程改写。
 */
export const SCREENSHOT_LIBRARY_COLUMNS: readonly {
  table: string
  column: string
  definition: string
}[] = [
  { table: 'courses', column: 'selection_serial', definition: 'TEXT' },
]

/**
 * 版本迁移脚本：数组下标 + 1 即为目标版本。
 * 升级时按顺序执行 `version > user_version` 的脚本，全程单事务。
 */
export const MIGRATIONS: readonly { version: number; statements: string }[] = [
  { version: 1, statements: SCHEMA_SQL },
  { version: 2, statements: APP_SETTINGS_SQL },
  { version: 3, statements: SCREENSHOT_LIBRARY_SQL },
]
