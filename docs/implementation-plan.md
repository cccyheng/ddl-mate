# DDL Mate 实施方案（V1 第一阶段）

- 项目：DDL Mate —— 面向大学生多来源课程通知的任务管理与规划系统
- 文档版本：v1（第一阶段启动时编写；2026-10-10 更新至 V1.2 时间助手**已交付：实现 + 隔离验收通过 + 已更新 8080**）
- 工作区：`C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl`
- 初版交付目标：**可运行的 V1 基础闭环**（任务 / 课表 / 日历 / 原通知），并给出 V1.1–V2 的可执行方案。
- **当前状态（2026-10-10）**：V1 本机单人版、课表照片 OCR、**V1.1 本地版（通知截图 / 文字 → 待办）**、
  **整站 UI 视觉升级**与 **V1.2 时间助手**均已实现并验收通过，最新版本已按用户授权部署到本机 `http://127.0.0.1:8080`。
  - **V1.2 时间助手（2026-10-10，实现 = DeepSeek Harness；独立审查 / 构建 / 验收 / 部署 = Codex）：已交付。**
    新增只读 `POST /api/tasks/resolve-time`（本地确定性规则 + 真实课表匹配），并在「新建 / 编辑任务」与通知候选中
    接入可折叠的「时间助手」（显式采用才写入）。说明与保守边界见 [`v1.2-time-assistant.md`](v1.2-time-assistant.md)，
    逐项验收证据见 [`verification.md`](verification.md) §0.5。
    验收数字：后端完整 **156 项**（原 124 + 解析 14 + 接口 18）、前端 **11 文件 159 项**（助手 20 + 既有 139）、
    独立 HTTP **48 项**、助手真实 Chrome **16 项** + 生命周期 **3 项**、只读视觉 **36 组合**全过；
    原通知 11 / 通知边界 4 / 课表 10 项在新版隔离 8081 回归通过（**与助手 16 + 3 是两组独立数字**）；
    助手最终 20 项只补跑了 UTC，早前 17 项曾在 `TZ=UTC / Asia/Shanghai / America/New_York` 三时区通过。
    构建成功（`.supervision/v12-build.log`）；实现阶段沙箱的 esbuild `spawn EPERM` 已由 Codex 提权正常构建解决。
  - UI 重做（2026-10-09，历史时间线）：实现 = DeepSeek Harness；部署与独立验收 = Codex。仅改前端界面与文案，
    **后端 Java 源码自 2026-10-08 15:19 起未改动**；前端 139 项测试全通过，隔离 QA 36 个页面/宽度无溢出、
    交互 7 项 + 通知导入 11 项 + 通知边界 4 项 + 课表回归 10 项全过；原库当时为 3 课程 / 5 课表 / 3 任务 / 1 原通知且与更新前逐条一致。
    设计说明见 [`ui-design.md`](ui-design.md)，验收见 [`verification.md`](verification.md) §0.4。
  - V1.1 本地版终验（§0.3，历史时间线）：后端 124 项（**2026-10-08 结果**）、
    前端 10 个文件 139 项、Codex 解析复核 10 项、真实浏览器通知 11 + 边界 4 项、通知 HTTP 13 + 边界 3 项（**通知阶段验收包结果**）、
    课表回归 10 项全部通过；验收只覆盖 8 张**合成**样图。
  - 仍未实现：LLM 语义抽取（V1.1 剩余）、需要校历的时间说法（国庆 / 寒假 / 考试周）、任务拆分 / 冲突检测 / 每日计划 / 提醒（V2）；
    MySQL profile 属**配置已提供、尚待实测**（不是未实现功能：建库脚本与 `application-mysql.yml` 已写好，本机无 MySQL/Docker）。
  - 本机 8080 运行的是 **V1.2**：发布包 `.supervision/releases/v12-20261010/ddl-mate.jar`
    （SHA256 `D73BB1C9748F4F2BB9646DC6CCBF7721EB9EB65A486A93CE536A12E13719EF13`，PID 262344），
    部署前已备份原库到 `.supervision/backups/before-v12-20261010-171552`；
    原库 3 课程 / 6 课表 / 3 任务 / 1 原通知更新前后**逐条一致**。隔离 8081 用于本轮验收，验收结束后关闭，8080 保持运行。

---

## 1. 版本范围

原需求的十个功能（A/C/E/F/G/K/L/M/N/O）按期拆分，避免一次性铺开：

| 版本 | 功能 | 内容 | 状态 |
| --- | --- | --- | --- |
| **V1** | F、M + 基础 | 课程、课表、任务 CRUD、DDL 排序与筛选、按月/按日查询、日历视图、原通知（文字 + 图片附件）留存与下载、本地单人资料 | **已实现，本机验收通过** |
| V1（追加） | — | 课表**照片**本地 OCR 导入、单双周与教学周规则、日历点进当天详情 | **已实现，2026-10-07 验收通过**（见 §6.5） |
| **V1.1（本地版）** | A、O | 批量**通知截图 / 文字** → 浏览器**本地 OCR** + 保守规则 → 可编辑候选 → 人工勾选确认 → 单事务写入 任务 + 原通知 + 原图（复用 V1 的 TaskSource/Task 接口） | **已实现，2026-10-09 验收通过**（用 8 张合成样图；见 §6.6） |
| V1.1（剩余） | A、O | LLM 结构化抽取（云端或本地模型）、抽取任务表 `extraction_jobs` / `extraction_candidates` | 方案已写，未实现 |
| **V1.2** | G、N | 课表结合自然语言时间解析（"下节课前""下周实验课前"→ 具体日期时间） | **已实现，2026-10-10 隔离验收通过并已更新 8080**（见 §6.7 与 [`v1.2-time-assistant.md`](v1.2-time-assistant.md)） |
| V2 | C、E、K、L | 大任务拆分、DDL 冲突检测、每日计划、手机提醒（固定 + 智能） | 方案已写，未实现 |

**明确不做、也不伪称完成**：任何大模型 / LLM 调用、手机推送与提醒、多用户鉴权、AI 计划生成。
前端不放置点击无效的 AI 按钮；相关能力只在"路线图"中说明。
（已实现且明确标注：**课表照片**的本地 OCR 见 §6.5；**通知截图 / 文字的本地 OCR + 保守规则 + 人工确认**见 §6.6；
**V1.2 时间助手**见 §6.7。三者都只做本地确定性规则，**都不包含 LLM 抽取**。）
**V1.2 的时间解析是规则解析**：支持短句（今天 / 明天 / 后天 / 本周X / 下周X + 明确时刻、精确日期、
「下节课前」这类课程说法），信息不足或复杂句（否定 / 延期 / 更改 / 范围 / 相对过去 / 需要校历）一律要求补全或保守拒绝。

### V1 的目标定义

> 一个刷新后数据仍在的、能录入课程与课表、能管理任务与 DDL、能在日历里看到任务、能随时回看"老师原话/原图"的本地 Web 应用。

---

## 2. 技术选型

| 层 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| 语言 | Java | 21（LTS，`C:\Program Files\Java\jdk-21.0.10`） | Spring Boot 3.5 支持 Java 17–25 |
| 构建 | Maven | 3.6.3+（复用 IDEA 自带 `plugins\maven\lib\maven3`） | 不安装全局 Maven |
| 后端框架 | Spring Boot | **3.5.6**（已由 Codex 核实 Maven Central 可下载） | `spring-boot-starter-web`、`-data-jpa`、`-validation`、`-test` |
| 持久化 | Spring Data JPA / Hibernate | 随 Boot BOM | 实体、Repository、`ddl-auto` |
| 数据库（开发） | H2 file 模式 | 由 Boot BOM 锁定 | `./data/ddlmate-dev`（经 `scripts\start-backend.ps1` 启动时实际落在 `backend/data/ddlmate-dev`），无需安装数据库 |
| 数据库（正式） | MySQL 8.0 | `mysql-connector-j` | 建库脚本 + `mysql` profile，本机无 MySQL 时未实测 |
| 校验 | Jakarta Bean Validation | 随 Boot BOM | `@Valid` + 统一错误响应 |
| 前端 | Vue 3 + Vite | Vue `3.5.13`、Vite `6.0.3`、`@vitejs/plugin-vue` `5.2.1`、`vue-router` `4.5.0` | 中文浅色界面，Composition API + `<script setup>` |
| 依赖缓存 | 工作区内 | `.tools/m2/repository`、`.tools/pnpm-store`、`.tools/npm-cache` | 不污染全局 `~/.m2`、不写全局 npm 缓存 |

版本锁定策略：后端数据库驱动与测试依赖的版本交给 `spring-boot-dependencies` 3.5.6 BOM 统一管理（不手写可能过期的版本号）；前端在 `package.json` 中写明确切版本并由 `pnpm-lock.yaml` 固化。

---

## 3. 数据关系

```text
AppUser (本地单人资料)
   │ 1
   │
   ├──< Course ──< CourseSchedule
   │        │ 1
   │        └──< Task ──< TaskSource ──< Attachment
   │                            │
   └────────────────────────────┘ (TaskSource 可独立于 Course 存在)
```

表与职责：

| 表 | 职责 | 关键字段 |
| --- | --- | --- |
| `app_users` | 本地单人资料（迁移到多用户的锚点） | `id`, `display_name`, `time_zone` |
| `courses` | 课程 | `code`, `name`, `instructor`, `semester`, `color`, `note` |
| `course_schedules` | 课表节次 | `course_id`, `weekday`(1–7), `start_time`, `end_time`, `location`, `period_start/end`, `week_range` |
| `tasks` | 任务 / DDL | `title`, `course_id`(nullable), `type`, `deadline`(UTC 存储), `priority`(1–5), `status`, `estimated_minutes`, `submit_requirement`, `submit_method` |
| `task_sources` | 原通知（M 功能） | `task_id`, `source_name`, `raw_text`, `captured_at` |
| `attachments` | 原通知图片 | `task_source_id`, `stored_name`(服务器生成), `original_name`, `content_type`, `size_bytes` |

设计约定：

1. **附件二进制不入库**，落盘到 `ddlmate.storage.upload-dir`，数据库只存元数据；服务器生成 `UUID.ext` 文件名，原始文件名仅作展示，防止路径穿越。
2. **课程删除保护**：课程下仍有任务或课表时返回 `409`，除非显式 `?force=true`；`force=true` 时先解绑任务的课程引用、再级联删除课表（安全、可预期、写入响应体说明）。
3. **任务删除**级联删除其来源与附件（含磁盘文件）。
4. `TaskSource` 允许 `task_id` 为空：预留 V1.1 "批量截图先入库、人工确认后再绑定任务"的暂存区，V1 前端只创建已绑定来源。
5. 为 V1.1/V2 预留但**本轮不建表**：`sub_tasks`、`reminders`、`daily_plans`、`plan_items`（见 §7 排期）。

键与约束：

- 主键统一 `BIGINT AUTO_INCREMENT`（H2/MySQL 一致）。
- 唯一约束：`courses.code`、`app_users.username`。
- 外键：`course_schedules.course_id → courses.id`、`tasks.course_id → courses.id`、`task_sources.task_id → tasks.id`、`attachments.task_source_id → task_sources.id`。
- 索引：`tasks(deadline)`、`tasks(status)`、`tasks(course_id)`、`course_schedules(weekday)`。

---

## 4. 时间语义（必须严格遵守）

| 概念 | Java 类型 | JSON 格式 | 存储 | 说明 |
| --- | --- | --- | --- | --- |
| 业务时区 | — | — | — | 固定 `Asia/Shanghai`（`ddlmate.time-zone`，JVM 默认时区与 Jackson 时区都设为此值） |
| 任务截止 | `OffsetDateTime` | `2026-10-15T10:10:00+08:00` | 数据库存 UTC (`hibernate.jdbc.time_zone=UTC`) | 带偏移量，跨时区不产生歧义 |
| 创建/更新时间 | `OffsetDateTime` | 同上 | UTC | `@CreationTimestamp` / `@UpdateTimestamp` |
| 通知捕获时间 | `OffsetDateTime` | 同上 | UTC | 图片/文字被记录的时间 |
| 课表星期 | `Integer` 1–7 | `1` | — | **1 = 周一 … 7 = 周日**（ISO-8601），与前端日历一致 |
| 课表时刻 | `LocalTime` | `08:00:00` | 本地墙钟时间 | 周课表是"每周几几点"，不含日期与时区 |
| 节次 | `Integer` | `1` | — | 第 1–12 节；`period_start/end` 仅作展示，真实时间以 `start_time/end_time` 为准 |

规则：

- 数据库连接串带 `serverTimezone=Asia/Shanghai`（MySQL）或直接使用本地时间（H2 file）。
- 客户端提交截止时间必须带偏移量（如 `+08:00`）；只提交本地时间字符串按业务时区解释（容错，但文档推荐带偏移量）。
- "今天"的判定：以业务时区的自然日 `[00:00, 次日 00:00)` 计算，不是 UTC 日。
- 剩余时间展示：`< 0` 已逾期；`< 24h` 显示小时；否则显示天数（前端 `src/utils/datetime.js` 统一实现）。

### API 时间格式约定（写入 README）

```http
POST /api/tasks
{ "title": "实验二", "deadline": "2026-10-15T10:10:00+08:00", ... }
```

按月查询用 `year` + `month` 参数，按日查询用 `date=2026-10-15`（业务时区的自然日）。

---

## 5. API 设计（V1 全量）

统一前缀 `/api`，统一响应：成功直接返回资源对象；失败返回一致的错误结构。

```json
{
  "timestamp": "2026-10-05T20:31:00+08:00",
  "status": 400,
  "error": "Bad Request",
  "code": "VALIDATION_FAILED",
  "message": "请求参数校验失败",
  "path": "/api/tasks",
  "fieldErrors": [{ "field": "title", "message": "任务标题不能为空" }]
}
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/courses` | 课程列表（`keyword`）/ 新建 |
| GET/PUT/DELETE | `/api/courses/{id}` | 详情 / 更新 / 删除（有引用返回 409，`?force=true` 安全级联） |
| GET/POST | `/api/courses/{id}/schedules` | 某课程课表 / 新建（非法时间 400） |
| PUT/DELETE | `/api/courses/{courseId}/schedules/{scheduleId}` | 更新 / 删除 |
| GET | `/api/schedules?weekday=` | 全部课表（可按星期过滤，前端课程表页用） |
| GET/POST | `/api/tasks` | 列表（筛选 + 排序 + 分页）/ 新建 |
| GET/PUT/PATCH/DELETE | `/api/tasks/{id}` | 详情 / 全量更新 / 局部更新（含状态切换）/ 删除 |
| PATCH | `/api/tasks/{id}/status` | 任务状态切换 `{"status":"DOING"}` |
| GET | `/api/tasks/deadlines` | DDL 排序列表（`sort=deadline\|priority\|course`，默认 `deadline` 升序，逾期在前） |
| GET | `/api/tasks/today` | 今日任务（今天截止 + 已逾期未完成） |
| GET | `/api/tasks/calendar?year=&month=` | 按月查询（返回按日期分组的任务） |
| GET | `/api/tasks/by-date?date=` | 按日期查询 |
| GET | `/api/tasks/stats` | 概览统计（总数、逾期、今日、7 天内、按状态/类型分组） |
| GET | `/api/schedules/today` | 今日课程（按星期匹配课表） |
| GET/POST | `/api/tasks/{taskId}/sources` | 原通知列表 / 新建（文字 + 来源名 + 可选图片） |
| GET/DELETE | `/api/sources/{id}` | 原通知详情 / 删除 |
| POST | `/api/sources/{id}/attachments` | 上传图片附件（multipart，`file` 字段，可多张） |
| GET | `/api/attachments/{id}` | 下载/查看原图（`inline`），`?download=true` 强制下载 |
| DELETE | `/api/attachments/{id}` | 删除附件（含磁盘文件） |
| GET | `/api/profile` | 本地单人资料（明确标注未启用鉴权） |
| PUT | `/api/profile` | 更新显示名 |
| GET | `/api/meta/enums` | 任务类型/状态/优先级枚举（前端下拉用） |

任务列表查询参数：`courseId, status, type, priority, keyword, dueFrom, dueTo, includeDone(默认 false 不显示 DONE/ARCHIVED), page(0), size(20), sort(deadline|priority|createdAt), direction(asc|desc)`。

**错误码约定**：`400 VALIDATION_FAILED / INVALID_ARGUMENT`、`404 RESOURCE_NOT_FOUND`、`409 RESOURCE_IN_USE / CONFLICT`、`413 FILE_TOO_LARGE`、`415 UNSUPPORTED_MEDIA_TYPE`、`500 INTERNAL_ERROR`。

**附件安全**：仅允许 `image/png, image/jpeg, image/webp, image/gif`；单文件 ≤ 5 MB（`ddlmate.storage.max-file-size`），单请求 ≤ 20 MB；内容嗅探（读文件头魔数）而非只信 `Content-Type`；服务器生成文件名 `UUID.png`；原始名做 `Path.getFileName` + 非法字符替换；下载时校验库中记录的文件名不含路径分隔符与 `..`。

---

## 6. 实施顺序与每阶段验收

> 顺序原则：先把"能存"做扎实，再上界面，最后闭环验证。

| 阶段 | 内容 | 验收标准（可执行） |
| --- | --- | --- |
| **S0 方案** | 本文档 + `.supervision/status.json` | 文档落地，范围/时间语义/错误约定明确 |
| **S1 骨架** | `backend/pom.xml`、`application*.yml`、主类、统一异常、枚举 | `mvn -o -B test-compile` 通过 |
| **S2 领域与 API** | 6 个实体 + Repository + Service + Controller + 校验 + 附件存储 | `mvn -o -B test` 全绿 |
| **S3 集成测试** | 课程/课表/任务/筛选排序/状态/来源上传/删除保护/非法输入 | 8 类场景全部有断言，失败必暴露 |
| **S4 前端** | Vue3+Vite 全部页面与真实 API 客户端 | `pnpm -C frontend build` 成功，产物可被后端托管 |
| **S5 闭环验证** | 启动后端（H2 file）→ 真实 HTTP 调一遍核心链路 → 前端构建产物托管访问 | `docs/verification.md` 记录真实请求与响应；未执行项明确标注"未执行" |
| **S6 交接** | README、建库脚本、环境变量示例、`.gitignore`、构建命令清单 | Codex 可按 README 一键复现 |

### 后端验收用例清单（S3）

1. 创建课程 → 201 + Location；重复 `code` → 409。
2. 创建课表 → 201；`start_time >= end_time` → 400；`weekday=0/8` → 400。
3. 创建任务 → 201；缺标题 / 截止时间非法 → 400 且 `fieldErrors` 非空。
4. 任务列表按截止时间升序；`status=TODO`、`courseId`、`keyword` 过滤生效；`includeDone=false` 默认隐藏已完成。
5. `PATCH /api/tasks/{id}/status` 切换为 `DONE` → 200，`/api/tasks/deadlines` 不再返回该任务。
6. `GET /api/tasks/{id}` 不存在 ID → 404 且响应体为标准错误结构。
7. 删除被任务引用的课程 → 409；`?force=true` → 204 且任务 `courseId` 变为 `null`、课表被删除。
8. 上传 PNG 到来源 → 附件可 `GET` 下载且字节一致；上传 `.txt` → 415；超大文件 → 413；文件名 `../../evil.png` 不产生越权写入。

---

## 6.5 追加轮次：课表照片 OCR + 单双周 + 日期详情（已实现，2026-10-06 实现 · 2026-10-07 验收通过）

在 V1 已验收的基础上追加三项能力（不属于新的四期划分，属于 V1 的可用性补强）：

| 能力 | 范围 | 验收门槛 |
| --- | --- | --- |
| **课表照片导入** | 浏览器本地 Tesseract.js（中文+英文，资源同源自托管）→ 解析为可编辑候选 → 勾选确认 → `POST /api/schedules/import` 单事务批量导入；支持整图/框选/手工补；缺字段留空提示，不臆测时间 | 真实样例图能产出候选（列表式 3/3 正确）；全部取消不落库；导入失败整体回滚不产生孤立课程 |
| **单双周与教学周** | `CourseSchedule` 增加 `semesterStartDate`（必须周一）/`startWeek`/`endWeek`/`weekPattern`；`ScheduleRules` 统一判定（教学周序号奇偶）；`today`/按日期/`calendar` 全部复用；旧数据缺字段按每周 | 单周只在奇数教学周出现、双周只在偶数周；学期前后不出现；非法输入（非周一起点、单双周缺起点、周次越界、倒置）返回 400 |
| **日历日期详情** | `/calendar/day/:date`（可刷新可分享）+ 月历同时显示课程与 DDL 数量/摘要；详情按选定日期单独请求，含课程（周次/单双周/节次/地点）与当天 DDL（状态/优先级/课程/提交要求/截止时间） | 深链直接打开不白屏；快速切日不出现旧响应覆盖；回月历保留月份；无内容/失败有可读提示 |

实现细节与真实测试结果见 [`verification.md`](verification.md) §0.1（结论：验收通过；后端 108 项、前端 25 项、
独立 HTTP 18 项、真实 Chrome 10 + 边界 3 项全部通过）。该节同时列明仍然存在的限制：
**MySQL 未实测**、识别准确率受照片质量限制（表格样例周三表头需人工确认），
以及尚未实现的部分（当时只交付课表照片的本地 OCR）。

---

## 6.6 追加轮次：通知截图 / 文字 → 待办（V1.1 **本地版**，2026-10-08 实现）

在 V1 基础上追加「从通知创建任务」的本地闭环。**这不是 V1.1 的全部**：本轮没有大模型。

| 能力 | 范围 | 验收门槛 |
| --- | --- | --- |
| **通知文字 / 截图导入** | `/tasks/import-notices`：粘贴文字、最多 8 张截图或两者并用 → **浏览器本地** Tesseract.js 串行识别（可取消、坏图不阻塞）→ 正文模式的可编辑候选（课程 / 标题 / 类型 / 截止 / 提交要求 / 提交方式，保留来源关联）→ 勾选确认 → `POST /api/tasks/import-notices` 单事务写入 任务 + 原通知 + 原图 | 识别与解析阶段不写库；全部取消不写库；候选非法整体回滚且不残留文件 |
| **保守日期规则** | 只有「完整日期 + 时刻」才直接作为候选 DDL；月日无年、仅日期、明天 / 下周五等**保留原话并提示核对**，不静默用今天日期或 23:59 | 模糊日期必须留空 + 提示 |
| **原图归属** | 每条任务持有自己的 `TaskSource` 与 `Attachment`，磁盘上每个 `(任务, 来源)` 组合各一份独立副本 | 同一张图被两条任务引用 → 不同的附件 id 与不同的物理路径；删除一条后另一条原图仍可下载且字节一致 |
| **副本容量上限** | 实际写盘副本总量按「每个 `(任务, 来源)` 绑定引用的文件大小」求和，上限 **100 MiB**；单张 5 MiB、单次请求 20 MiB、8 张图、30 条候选、12 个来源不变 | 超限时在落盘与写库**之前**整体 400 并提示分批导入，磁盘与数据库零副作用 |
| **请求内去重** | 只拒绝「语义字段 + 来源集合」完全相同的候选；不同课程 / 来源的同名同时间任务允许导入 | 完全重复（含来源书写顺序不同）→ 409；不同课程 / 来源 / 说明 → 201。**仅请求内，不跨请求幂等** |

真实实现与测试结果见 [`verification.md`](verification.md) §0.3（**2026-10-09 终验**）：
后端 124 项 / 前端 10 个文件 139 项 / Codex 解析复核 10 项 / 真实浏览器通知 11 + 边界 4 项 /
通知 HTTP 13 + 边界 3 项 / 课表回归 10 项全部通过，构建与打包成功。
验收用的是 8 张**合成**样图（`frontend/scripts/make-notice-samples.mjs` 生成，页面标明示例），
**不保证任意截图 100% 正确**：样图 04 的邮箱仍有 OCR 错字，需人工校对。

**仍未做**：LLM 结构化抽取、`extraction_jobs` / `extraction_candidates` 表、云端或本地大模型、
自然语言相对日期解析（V1.2）、推送与提醒（V2）。

---

## 6.7 追加轮次：V1.2 时间助手（2026-10-10 实现 · **隔离验收通过 · 已更新 8080**）

在已验收的 V1.1 + UI 之上追加「可解释的自然语言截止时间建议 + 真实课表匹配」。
**仍是本地确定性规则，没有大模型、没有外部服务、没有新增依赖、没有实体 / 数据库迁移。**

| 能力 | 范围 | 验收门槛（已由 Codex 独立执行） |
| --- | --- | --- |
| **只读解析接口** | `POST /api/tasks/resolve-time`：`text`（1–500 字）+ 必带偏移量的 `referenceAt` + 可选 `courseId`；响应区分 `RESOLVED / NEEDS_INFO / UNSUPPORTED / NO_COURSE_MATCH`，每个候选带明确 `+08:00` deadline 与理由 | 极端输入不 500；缺偏移量 400；不存在课程 404；调用前后任务 / 课程 / 课表数量不变 |
| **确定性的短语解析** | 今天 / 明天 / 后天 + 明确时刻（含下午 / 晚上 / 中午 / 凌晨、点半）· 本周X / 这周X / 下周X · 精确日期 `YYYY-MM-DD HH:mm` | 固定参考时间可断言；跨日 / 跨月 / 跨年 / 闰日 / 时区换算；只有日期、只有时刻、今晚、尽快、周末、范围、多重时间一律 `NEEDS_INFO`，**不补 23:59、不取第一个** |
| **保守拒绝** | 否定 / 延期 / 更改 / 「…以前」/ 需要校历；`下下周五18:00`、`明天18:000`、`明天123:00`、`明天18:00之后`、`下节课前两小时`、`下次数学课前` 等一律拒绝 | 整句覆盖校验（有限包装词白名单），不靠否定词黑名单 |
| **真实课表匹配** | 「下节课前 / 下次课前 / 下次上课前 / 本周五上课前 / 下周五上课前 / 下周这门课前」；复用 `ScheduleRules.occursOn`（学期起点 / 起止教学周 / ODD-EVEN），旧课表按每周 | 正在上的课不算下一次；下周严格下个自然周、无课不越周；多节取最早并说明；同一时刻去重；候选截止 = 上课开始边界 |
| **前端助手** | `TimeAssistant.vue`（可折叠）接入新建 / 编辑任务与通知候选；参考时间默认现在的北京时间、可改为通知发布时间；课程沿用当前选择 | 显式「采用此时间」才写入；改短语 / 参考 / 课程 / 手工 DDL 后旧建议作废且不可采用；迟到响应不污染；保存期间禁用；UTC 浏览器不偏移 8 小时 |

说明与保守边界清单见 [`v1.2-time-assistant.md`](v1.2-time-assistant.md)。

本机 / 隔离环境已执行（实现阶段用 H2 内存库，未触碰 8080 与真实库；验收阶段由 Codex 在隔离 8081 与 8080 上完成）：

- 后端**完整 156 项通过**（原 124 + `TimePhraseParserTest` 14 + `TimeResolveIT` 18）；为 2026-10-10 早前结果，此后只改前端助手 UI，后端未改；
- 前端**11 个文件 159 项通过**（时间助手 20 项 + 既有 139 项）；助手最终 20 项只补跑了 UTC，
  早前 17 项曾在 `TZ=UTC / Asia/Shanghai / America/New_York` 三时区通过；
- 独立 HTTP **48 项**、助手真实 Chrome **16 项**（390 / 768 / 1440；UTC 与上海新建 / 编辑；真实单双周课表手动采用；
  迟到响应失效；网络失败重试；通知采用 + 保存冻结 + 原文读回）+ 生命周期 **3 项**、只读视觉 **36 组合**全过；
- 旧入口回归（新版隔离 8081）：原通知 **11 项**、通知边界 **4 项**、课表 / 日历 **10 项**通过
  （**与助手 16 + 3 是两组独立数字，不合并计数**）；
- 24 个 `.vue` 文件通过仓库自带的 `frontend/scripts/check-vue-syntax.mjs`；构建成功（`.supervision/v12-build.log`）。

**仍未做 / 仍不支持**：需要校历的时间说法（国庆 / 寒假 / 考试周、调休）、不明确短语（只有日期、今晚、尽快、周末、范围）、
课程类型限定（如「下次实验课前」）—— V1.2 明确保守拒绝而不是猜；LLM 语义抽取、任务拆分 / 冲突检测 / 每日计划 / 提醒仍未实现；
MySQL profile 仍未实测。实现阶段沙箱的 esbuild `spawn EPERM` 已由 Codex 提权正常构建解决，不是当前构建失败。
逐项证据见 [`verification.md`](verification.md) §0.5。

---

## 7. 后续阶段方案（尚未实现）

> 注意：**课表照片 OCR（§6.5）、通知截图 / 文字的本地 OCR + 人工确认（§6.6）与 V1.2 时间助手（§6.7）都已实现**；
> 下面 V1.1 指的是**尚未实现的大模型结构化抽取**部分。

### V1.1 —— 截图/文字 → 任务（A + O）

- 新增 `extraction_jobs` / `extraction_candidates` 表；复用 `TaskSource`/`Attachment` 作为原件留存。
  （**本地 OCR、保守规则与人工确认已在 §6.6 落地**；这里剩下的是大模型抽取与抽取任务表本身。）
- 流程：批量上传图片（复用现有附件存储，限制不变）→ OCR（本地 PaddleOCR/Tesseract 或云 OCR，二选一）→ LLM 结构化抽取（输出 JSON Schema：课程/类型/名称/截止/提交要求/提交方式/预计耗时）→ **人工确认页**（逐条勾选、可改字段）→ 调用现有 `POST /api/tasks` 落库。
- 关键约束：LLM 只做"候选生成"，未经用户确认不得写库；OCR/LLM 全部有超时、失败降级（保留原图 + 原始文字，让用户手填）。
- 验收门槛（进入 V1.1 时必须满足）：上传 8 张截图能产出候选列表；取消勾选不落库；抽取失败不阻塞手工录入。

### V1.2 —— 课表结合的时间解析（G + N）—— **已实现，见 §6.7**

- `POST /api/tasks/resolve-time` 已落地（确定性规则 + 真实课表匹配，只读）。
- 仍未支持（明确记录，不夸大）：`下次实验课前` 这类**课程类型限定**（课表没有可靠的理论 / 实验分类字段，拒绝而不是猜）、
  「国庆回来第一节课」这类需要**校历**的说法（规划为教学周表 `semesters` 的扩展项）、
  整段通知的语义抽取（属于 V1.1 剩余的大模型部分）。

### V2 —— 规划与提醒（C + E + K + L）

- 表：`sub_tasks`（拆分结果，父子任务）、`daily_plans` / `plan_items`（每日计划）、`reminders`（固定 + 智能）。
- C 拆分：任务 → 子任务（LLM 生成 + 用户调整），子任务进日历。
- L 冲突检测：按日聚合"预计分钟 + 优先级 + 截止"，超过阈值（如 6h/天）产出告警与错峰建议。
- E 每日计划：在课表空档内按 `deadline + estimated_minutes + priority` 贪心装箱生成时间块。
- K 提醒：桌面/手机推送（Web Push 或自建调度 + 邮件/微信），固定节点（3 天/1 天/3 小时/30 分钟前）+ 状态驱动智能提醒。

---

## 8. 风险与依赖

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 沙箱无外网（实现会话实测：从 `pwsh` 访问 Maven Central / npm registry 均 TLS 失败） | 实现会话内无法执行 `mvn test` / `pnpm install` | **已解决**：依赖由 Codex 以授权方式下载到工作区 `.tools`（Maven 本地仓库、pnpm store），后续构建与测试均已真实跑通 |
| 本机无 MySQL、无 Docker | MySQL profile 无法实测 | 提供建库脚本 + `application-mysql.yml`，`docs/verification.md` 明确标注"未实测"（已知限制），H2 file profile 覆盖同一后端全部功能并已通过验收 |
| H2 与 MySQL 方言差异（如 `ddl-auto`、`AUTO_INCREMENT`） | 切换后可能出现建表差异 | 生产 profile 用 `ddl-auto=validate` + 建库脚本手写 DDL；实体只使用两库共同支持的映射 |
| 附件写入路径权限 | 上传失败 | 上传目录可配置 `DDLMATE_UPLOAD_DIR`，启动时自动创建；失败返回 500 并记录日志 |
| 无鉴权（仅 localhost） | 不能上线 | 仅绑定 `127.0.0.1`；`app_users` 与 `/api/profile` 作为迁移锚点，正式上线前引入 Spring Security + JWT 并把 `user_id` 加到各表 |
| 单人模型迁移多用户 | 后期改动面大 | 所有表已预留 `app_users` 关联路径；迁移步骤写在 README |

---

## 9. 复现命令（已验证可用）

推荐直接使用脚本（README §3，均已实际跑通）：

```powershell
powershell -NoProfile -File scripts\test-backend.ps1     # 156 项后端测试（2026-10-10）
powershell -NoProfile -File scripts\build-frontend.ps1   # 前端构建（非交互 pnpm + vite build）
powershell -NoProfile -File scripts\build-all.ps1        # 前端产物打进后端并打包（skipTests）
powershell -NoProfile -File scripts\start-backend.ps1    # http://127.0.0.1:8080
```

等价的裸命令：

```powershell
# 1) Maven（Java 21，缓存与依赖全部落在工作区 .tools）
$env:JAVA_HOME='C:\Program Files\Java\jdk-21.0.10'
$mvn='C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.1\plugins\maven\lib\maven3\bin\mvn.cmd'
& $mvn -B "-Dmaven.repo.local=$PWD\.tools\m2\repository" -f backend\pom.xml test

# 2) 前端（pnpm store 落在工作区 .tools）
$env:npm_config_store_dir="$PWD\.tools\pnpm-store"
$env:npm_config_cache="$PWD\.tools\npm-cache"
pnpm -C frontend install
pnpm -C frontend build
```

启动见 `README.md`（后端 `8080`、前端 `5173`，均绑定 `127.0.0.1`）。
运行期数据位置：H2 `backend\data\ddlmate-dev.mv.db`、附件 `backend\data\uploads\`。
