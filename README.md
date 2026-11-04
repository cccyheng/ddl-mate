# DDL Mate

面向大学生的**多来源课程通知任务管理与规划系统**（V1 + V1.1 本地版 + V1.2 时间助手）。

本版本实现的是一个**能真实跑起来的基础闭环**：课程与课表、任务与 DDL、日历、原通知（老师原话 + 群消息截图留存），
并支持**用课表照片直接导入课表**、**从通知截图 / 文字创建待办**（两者都是浏览器本地 OCR）、
**单双周 / 教学周规则**、**日历点进当天详情**，以及 **V1.2 时间助手**（把「明天 18:00」「下周五上课前」
这类简短时间短语解析成明确的北京时间，可结合真实课表）。所有数据持久化到本地数据库，刷新不丢。

> **明确说明**：已实现的是**浏览器本地 OCR + 保守规则 + 人工确认**，以及**本地确定性规则**的时间短语解析。
> 仍然**没有**大模型 / LLM 语义抽取、**没有**整段通知的自然语言理解、
> **没有**手机推送、**没有**登录鉴权。这些分别在 V1.1 剩余部分 / V2 计划中，
> 见 [`docs/implementation-plan.md`](docs/implementation-plan.md)、[`docs/v1.2-time-assistant.md`](docs/v1.2-time-assistant.md)
> 与界面里的「路线图」页。界面里不会放置点了没反应的假功能。

**当前状态（截至 2026-10-10）**

| 项 | 状态 |
| --- | --- |
| V1 本机单人版 | ✅ 已验收通过（首轮记录见 [`docs/verification.md`](docs/verification.md) §0） |
| 课表照片 OCR + 单双周 + 日期详情 | ✅ 已验收通过（同上 §0.1、§0.2） |
| 通知截图 / 文字 → 待办（V1.1 **本地版**） | ✅ **已实现并完成独立验收**（2026-10-08 实现 / 2026-10-09 终验；用 8 张合成样图验收，不保证任意截图 100% 正确） |
| 整站 UI 视觉升级 | ✅ **已实现、已本机部署并完成最终独立验收**（2026-10-09，见 §0.4 与 [`docs/ui-design.md`](docs/ui-design.md)） |
| **V1.2 时间助手（时间短语 + 真实课表匹配）** | ✅ **已实现、隔离验收通过并已更新 8080**（2026-10-10）：只读 `POST /api/tasks/resolve-time` + 任务表单 / 通知候选里的可折叠助手；后端 156、前端 11 文件 159、独立 HTTP 48、助手真实 Chrome 16 + 生命周期 3、只读视觉 36 组合全过（见 §V1.2 与 [`docs/verification.md`](docs/verification.md) §0.5） |
| LLM 语义抽取 / 推送与提醒 | ⛔ 未实现（路线图） |
| 需要校历的时间说法（国庆 / 寒假 / 考试周） | ⛔ 未实现，V1.2 明确保守拒绝而不是猜 |
| MySQL profile | ⛔ **配置已提供、尚待实测**（不是未实现功能：`schema.sql` 与 `application-mysql.yml` 已写好，本机无 MySQL/Docker 未连接过真实实例） |
| 本机 8080 服务 | ✅ **已按用户授权更新到 V1.2**（`http://127.0.0.1:8080`，PID 262344；发布包 `.supervision/releases/v12-20261010/ddl-mate.jar`，SHA256 `D73BB1C9748F4F2BB9646DC6CCBF7721EB9EB65A486A93CE536A12E13719EF13`；部署前备份 `.supervision/backups/before-v12-20261010-171552`）；原库 3 课程 / 6 课表 / 3 任务 / 1 原通知更新前后**逐条一致** |

> 下面「2026-10-09 最终独立验收」表与 UI / 通知 / 课表各节是**历史轮次记录**（当时的 124 项后端、139 项前端、UI 版 8080 状态），保留原文；V1.2 的当前状态以本节与 `docs/verification.md` §0.5 为准。

**2026-10-09 最终独立验收**（实现 = DeepSeek Harness，独立验收 = Codex）：

| 项 | 结果 |
| --- | --- |
| 后端测试 | ✅ **124 项 / 0 失败 / 0 错误**。后端 Java 源码自 2026-10-08 15:19 起未再改动，**2026-10-09 未重跑**，沿用已按 Surefire XML 核对的结果（⚠️ 属历史结果，本轮 UI 重做未改后端） |
| 前端测试 | ✅ **10 个测试文件 139 项全通过**（UI 重做后复跑仍全过）；另 Codex 解析复核脚本 10 项通过 |
| UI 重做构建与打包 | ✅ 最后一次实际构建成功 `2026-10-09T16:35:22+08:00`；发布包 `.supervision/releases/ui-20261009/ddl-mate.jar`，SHA256 `9FECC5161E95F4B5C1A1BE9B17FF956D69F2A0257FB4C5C2C617D00DF6204319` |
| UI 本机部署 + 真实验收 | ✅ **已部署并验收通过**（`DEPLOYED_AND_VERIFIED`）：真实页面 5 个 HTTP 200 + 可见标题、390px 无溢出、0 异常 / 0 外网 / 0 写操作；原库 3 课程 / 5 课表 / 3 任务 / 1 原通知与更新前**逐条一致**；部署前备份 `.supervision/backups/before-ui-20261009-163954` |
| UI 隔离 QA（8081） | ✅ 12 路由 × 1440 / 768 / 390 = **36 个页面/宽度**无溢出；交互 **7 项 PASS**；通知导入 11 项、通知边界 4 项、课表回归 10 项**在最终 UI 包上重跑全过**；验收结束后该 8081 内存 QA 服务已由 Codex 关闭（`.supervision/ui-qa-cleanup.json`），8080 保持运行 |
| 真实浏览器回归（通知 11 / 通知边界 4 / 课表 10 项：**UI 阶段在 UI 包 + 隔离 8081 内存库重跑**） | ✅ 通知导入 **11 项 PASS**（8 张合成图串行 OCR → 11 条候选、选中保存、原图逐字节比对、详情与日历可见、UTC 浏览器按上海时间保存、取消防回写、390px、0 异常 0 外网）；通知边界 **4 项 PASS**；课表回归 **10 项 PASS** |
| 通知 HTTP（**通知功能验收阶段结果，不是 UI 包**） | ✅ **13 项 + 边界 3 项**全部 PASS，但跑在**通知阶段验收包** jar SHA256 `153FBDB3FC163703A8B2562F4CFB765DA4D689EFCB96DEE23473E569744DDEEF`（2026-10-09T13:14:56）；UI 阶段后端未改、**未在 UI 包上重跑这 16 项**，UI 包上只重跑了上面的浏览器 11 + 4 + 10 项 |
| 本机 8080 | ✅ **已按用户授权启动并部署新版**（PID 291104，`http://127.0.0.1:8080`，仍在监听）；验收只读，未在原库写入数据 |

⚠️ 这些是**合成样图**验收，不保证任意截图 100% 正确：样图 04 的邮箱仍有 OCR 错字，需人工校对；
通知原文里只有「无年份日期 / 相对日期（明天、下周五、下节课前）」时一律留空并提示核对。
仍**没有** LLM、推送、登录。上面这一段是 **2026-10-09 UI 重做**的结果，不包含也不声称 LLM 抽取或提醒。
逐项证据见 [`docs/verification.md`](docs/verification.md) §0.4（UI 重做）与 §0.3（通知导入）。

### V1.2 时间助手（2026-10-10 实现 · 隔离验收通过 · 已更新 8080）

**结论：已实现、构建、隔离环境独立验收，并已更新本机 8080。** 实现 = DeepSeek Harness；独立审查 / 构建 / 验收 / 部署 = Codex。
（逐项证据见 [`docs/verification.md`](docs/verification.md) §0.5；短语清单与保守边界见 [`docs/v1.2-time-assistant.md`](docs/v1.2-time-assistant.md)。）

- **只读接口**：`POST /api/tasks/resolve-time`，请求 `text`（1–500 字）+ **必带偏移量**的 `referenceAt` + 可选 `courseId`；
  响应区分 `RESOLVED / NEEDS_INFO / UNSUPPORTED / NO_COURSE_MATCH`，每个候选都带明确 `+08:00` 截止时间与可读理由；
  课表匹配还带 `scheduleId / scheduleDate / scheduleStartTime`。**不会写库**，极端输入返回 400/404 而不是 500。
- **支持**：「今天 / 明天 / 后天 + 明确时刻」（含下午 / 晚上 / 中午 / 凌晨、点半）、「本周X / 这周X / 下周X」、
  精确日期 `YYYY-MM-DD HH:mm`，以及「下节课前 / 下次上课前 / 本周五上课前 / 下周五上课前 / 下周这门课前」
  （课程必须由用户在表单 / 候选里明确选择，复用课表的教学周与单双周规则）。
- **保守边界**：只有日期 / 只有时刻 / 今晚 / 尽快 / 周末 / 范围 / 多重日期或时刻 → 提示补全，**绝不补 23:59**；
  否定 / 延期 / 更改 / 「…以前」/ 需要校历 / `下下周五18:00` / `明天18:000` / `下节课前两小时` /
  带课程名或类型限定的「课前」→ 保守拒绝（整句覆盖校验，不靠否定词黑名单）。
  **这是本地确定性规则，不等同 LLM**；校历 / 调休、不明确短语、课程类型限定都不支持。
- **前端**：任务表单（新建与编辑）与通知候选中都有可折叠「时间助手」；参考时间默认**现在的北京时间**、可改成通知发布时间；
  **只有点「采用此时间」才写入**表单 / 候选。改短语 / 参考时间 / 课程 / 手工 DDL 或**关闭面板**都会让旧建议作废且不可采用，
  迟到响应不污染，保存期间禁用。表单 DDL 统一按北京时间填写与提交，UTC 浏览器不偏移 8 小时。
- **验收结果（2026-10-10）**：后端完整 **156 项**（原 124 + 解析 14 + 接口 18）、前端 **11 文件 159 项**（助手 20 + 既有 139）、
  独立 HTTP **48 项**、助手真实 Chrome **16 项**（390 / 768 / 1440；UTC 与上海新建 / 编辑；真实单双周课表手动采用；
  迟到响应失效；网络失败重试；通知采用 + 保存冻结 + 原文读回）+ 生命周期 **3 项**、只读视觉 **36 组合**全过；
  原通知 11 / 通知边界 4 / 课表 10 项在新版隔离 8081 回归通过（与助手 16 + 3 是两组独立数字）。
  助手最终 20 项只补跑了 UTC；早前 17 项曾在 `TZ=UTC / Asia/Shanghai / America/New_York` 三时区通过。
  构建成功（`.supervision/v12-build.log`）；实现阶段沙箱的 esbuild `spawn EPERM` 已由 Codex 提权正常构建解决。

### UI 视觉升级（2026-10-09，已部署并验收）

整站换成暖白 + 深绿 + 陶土橙的校园日程风格：桌面 232px 左侧栏（小屏换紧凑顶栏 + 横向导航）、
首页布局重做（欢迎区 → 4 个真实统计格 → 深绿通知整理入口 → 主宽列「今天与逾期 / 即将截止（7 天内）」+ 窄列「今日课程 / 最近一个 DDL」）、
统一按钮 / 输入 / 标签 / 表格 / 空态，本地 stroke SVG 图标替代 emoji，任务条目按容器宽度自适应。
设计说明与令牌见 [`docs/ui-design.md`](docs/ui-design.md)。
本轮只改前端界面与文案：**后端 API、数据库、OCR 与解析算法、时区规则、路由路径与依赖版本均未改动**。

### 历史轮次：真实课表照片优化（2026-10-08，已验收）

用户提供的深色周视图，从原先错误合并的 6 条候选提升为 **21/21 个独立课程块**，星期、节次和时间全部对应；
课程名严格匹配 **20/21**、地点 **20/21**。一处课程名漏括号、一处楼名误字仍需人工核对，均保留原文并显示提醒。
周视图默认只导入图上的第 N 周，填写学期第一周周一并确认后才能提交；可自行修改起止教学周和单双周，修改后需要重新确认。
长图预览、框选追加/替换、取消识别和手机表格布局一并优化。
该轮前端 55 项测试、真实 Chrome 交互 24 项通过；原图经人工核对后在隔离内存库成功导入 15 门课程、21 条课表。
后端 108 项测试与独立 HTTP 18 项检查为**那一轮的历史结果**。当时演示包运行于 8080，原文件库
3 门课程 / 5 条课表 / 3 个任务与快照逐项一致，启动前备份在 `.supervision/backups/before-photo-optimization/`。
逐项证据与 OCR 剩余误差见 [`docs/verification.md`](docs/verification.md) §0.2。

---

## 1. 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | Java 21 · Spring Boot 3.5.6 · Spring Data JPA (Hibernate) · Bean Validation · Maven |
| 数据库 | 开发/演示：H2 file 模式（无需安装数据库）· 正式：MySQL 8 |
| 前端 | Vue 3.5 · Vite 6 · Vue Router 4（无额外 UI 框架；手写暖白 + 深绿 + 陶土橙的响应式样式，2026-10-09 视觉升级） |
| 界面设计说明 | [`docs/ui-design.md`](docs/ui-design.md)（设计令牌、外壳与各页布局、可访问性、验证状态） |
| 时区 | 业务固定 `Asia/Shanghai` |

---

## 2. 环境要求

- **JDK 21**（`C:\Program Files\Java\jdk-21.0.10`，脚本会自动使用）
- **Maven 3.6.3+**：本机 PATH 中没有 `mvn`，脚本默认复用 IntelliJ 自带
  `C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.1\plugins\maven\lib\maven3\bin\mvn.cmd`
- **Node 18+ / pnpm**（本机 Node 为 24，pnpm 可用；没有 pnpm 时用 `npm` 亦可，见下文）
- MySQL **仅正式 profile 需要**，本机未安装也不影响开发与演示

依赖缓存全部落在工作区内的 `.tools\`（Maven 本地仓库、pnpm store），**不会写入全局 `~/.m2` 或全局 npm 缓存**。

---

## 3. 快速开始

### 3.1 一键脚本（推荐）

```powershell
# 后端：启动在 http://127.0.0.1:8080（dev profile，H2 文件库，数据在 backend\data）
.\scripts\start-backend.ps1

# 前端开发服务器：http://127.0.0.1:5173（/api 自动代理到 8080）
.\scripts\start-frontend.ps1

# 运行后端测试（当前 156 项：10 个集成测试类 + 3 个单元测试类，MockMvc + H2 内存库）
.\scripts\test-backend.ps1

# 只构建
.\scripts\build-backend.ps1
.\scripts\build-frontend.ps1

# 演示模式：前端打包进后端，一个端口就能看完整界面
.\scripts\build-all.ps1
.\scripts\start-backend.ps1   # 然后访问 http://127.0.0.1:8080
```

> 脚本需要在 pwsh（PowerShell 7）里运行；若 `powershell` 不在 PATH，可用 `pwsh -NoProfile -File .\scripts\xxx.ps1`，
> 或直接点上面的 `.\scripts\*.ps1`。前端测试命令见 §3.2 末尾。

首次运行会自动创建 H2 文件数据库并写入 `dev` 示例数据（3 门课程、4 条课表、3 个任务、1 条原通知，均标注为示例）。

### 3.2 手动命令（等价写法）

```powershell
# ---- 后端 ----
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21.0.10'
$mvn = 'C:\Program Files\JetBrains\IntelliJ IDEA 2026.1.1\plugins\maven\lib\maven3\bin\mvn.cmd'
$repo = "$PWD\.tools\m2\repository"     # 依赖缓存在工作区内

# 编译 + 测试
& $mvn -B "-Dmaven.repo.local=$repo" -f backend\pom.xml test
# 启动 dev profile
& $mvn -B "-Dmaven.repo.local=$repo" -f backend\pom.xml spring-boot:run "-Dspring-boot.run.profiles=dev"
# 打包
& $mvn -B "-Dmaven.repo.local=$repo" -f backend\pom.xml -DskipTests package

# ---- 前端 ----
$env:npm_config_store_dir = "$PWD\.tools\pnpm-store"
$env:npm_config_cache     = "$PWD\.tools\npm-cache"
pnpm -C frontend install
node frontend\scripts\prepare-ocr-assets.mjs   # 准备 OCR worker/core/中英文模型到 frontend/public/tesseract
pnpm -C frontend build
# 没有 pnpm 时：npm --prefix frontend install && npm --prefix frontend run build

# ---- 前端测试（2026-10-10 最终：11 个文件 159 项全通过，逐个执行）----
cd frontend
node tests\timetableParser.test.mjs             # 13 项：解析器（含 2 项真实 OCR 输出快照回归）
node tests\calendarStats.test.mjs               # 3 项：月历"有安排天数"统计
node tests\ocrImageLifecycle.test.mjs           # 9 项：图片生命周期（canvas 化 / 临时 URL 释放 / drawImage 参数）
node tests\weekGridLayout.test.mjs              # 22 项：卡片几何、星期、节次与文本规则
node tests\importScope.test.mjs                 # 8 项：周视图导入约束、灰度细笔画、字段清理
node tests\noticeParser.test.mjs                # 25 项：通知正文解析与保守日期规则
node tests\noticeImportPayload.test.mjs         # 36 项：候选合并、请求体组装与上限校验
node tests\noticeImportGuards.test.mjs          # 11 项：选图额度、保存冻结快照、来源身份判定
node tests\noticeParserBrowserOcr.test.mjs      # 3 项：浏览器 OCR 固定 fixture 回归
node tests\noticeParserRealOcr.test.mjs         # 9 项：真实 OCR 输出回归
node tests\timeAssistant.test.mjs               # 20 项：V1.2 时间助手（上海时区 / 过期建议与关闭失效 / 接线守卫 / 文案守卫）
# 时区无关性：最终 20 项只补跑了 UTC；早前 17 项曾在下面三个时区都通过
#   $env:TZ='UTC'; node tests\timeAssistant.test.mjs
#   $env:TZ='Asia/Shanghai'; node tests\timeAssistant.test.mjs
#   $env:TZ='America/New_York'; node tests\timeAssistant.test.mjs
# 真实 OCR 冒烟（可选，会写 .supervision\ocr-real-*.json）
node scripts\ocr-smoke.mjs
```

### 3.3 访问地址

| 场景 | 地址 |
| --- | --- |
| 前端开发服务器 | http://127.0.0.1:5173 |
| 后端 API | http://127.0.0.1:8080/api |
| 演示模式（后端托管前端） | http://127.0.0.1:8080 |
| 照片导入课表 | http://127.0.0.1:8080/courses/import-schedule |
| 从通知创建任务（粘贴文字 / 截图） | http://127.0.0.1:8080/tasks/import-notices |
| 日历日期详情 | http://127.0.0.1:8080/calendar/day/2026-10-06 |
| H2 控制台（仅 dev profile） | http://127.0.0.1:8080/h2-console |

后端只绑定 `127.0.0.1`（`server.address`），不要改成 `0.0.0.0`。

---

## 4. 目录结构

```text
大学生ddl/
├─ backend/                       Spring Boot 后端
│  ├─ pom.xml
│  └─ src/
│     ├─ main/java/com/ddlmate/
│     │  ├─ DdlMateApplication.java
│     │  ├─ common/               时区、错误码、统一错误体、业务异常
│     │  ├─ config/               Web/API 配置、本地用户引导、dev 示例数据
│     │  ├─ domain/               AppUser / Course / CourseSchedule / Task / TaskSource / Attachment
│     │  ├─ repository/           Spring Data JPA
│     │  ├─ service/              业务逻辑（含 ScheduleRules / CalendarService）+ 附件落盘（防路径穿越）
│     │  └─ web/                  REST 控制器 + 全局异常处理 + SPA 回退
│     ├─ main/resources/
│     │  ├─ application.yml       / application-dev.yml (H2) / application-mysql.yml
│     │  ├─ db/mysql/schema.sql   正式库建库脚本
│     │  └─ static/               （可选）前端构建产物由这里托管
│     └─ test/java/com/ddlmate/   10 个集成测试类 + 3 个单元测试类（共 156 项，MockMvc + H2 内存库）
├─ frontend/                      Vue 3 + Vite 前端
│  ├─ package.json / vite.config.js / .npmrc（缓存指向工作区）
│  ├─ public/samples/             样例课表图（导入页可一键载入，走真实 OCR）
│  ├─ public/tesseract/           构建时生成的 OCR 资源（worker/core/语言模型，已 gitignore）
│  ├─ scripts/                    prepare-ocr-assets.mjs（构建前置）、ocr-smoke.mjs（真实 OCR 冒烟）、copy-dist.mjs
│  ├─ tests/                      前端测试 11 个文件 159 项（2026-10-10 最终验收：助手 20 + 既有 139）+ fixtures（含 notice-browser-ocr.json 固定 OCR 结果）
│  └─ src/
│     ├─ api/                     真实 REST 客户端（统一错误处理）
│     ├─ components/              任务条目、附件画廊、加载/空态/错误组件、任务表单、本地 SVG 图标（AppIcon）
│     ├─ ocr/                     tesseractClient（同源 worker + 取消序号）、timetableParser（无猜测解析）、ocrConfig；
│     │                           通知正文解析、候选池、导入请求体与守卫（2026-10-09 随前端一并验收）
│     ├─ views/                   首页、任务列表、任务表单、任务详情、课程、课程详情、照片导入课表、从通知创建任务、日历、日期详情、原通知、路线图
│     ├─ router/ · styles/ · utils/
├─ docs/
│  ├─ implementation-plan.md      四期实施方案（范围、选型、数据关系、时间语义、验收、风险）
│  ├─ verification.md             真实验证记录（已执行 / 未执行都写清楚；§0.4 为 UI 重做与部署）
│  └─ ui-design.md                界面设计说明（设计令牌、外壳与各页布局、可访问性、验证状态）
├─ scripts/                       env / start / build / test 脚本
├─ .env.example                   环境变量示例
└─ .supervision/                  阶段状态、验收证据与日志（notice-import-status.json 等）
```

---

## 5. 时间语义（重要）

| 概念 | 格式 / 规则 |
| --- | --- |
| 业务时区 | `Asia/Shanghai`，无法通过界面修改 |
| API 时间格式 | ISO-8601 带偏移量：`2026-10-15T10:10:00+08:00` |
| 数据库存储 | 时间列按 **UTC** 存储（`hibernate.jdbc.time_zone=UTC`），读取后转回业务时区输出 |
| 课表时间 | 本地墙钟时间 `HH:mm`，**不含日期与时区** |
| 星期 | ISO-8601：`1` = 周一 … `7` = 周日 |
| 「今天」 | 按业务时区的自然日 `[00:00, 次日 00:00)` 计算，不是 UTC 日 |
| 查询 | `GET /api/tasks/calendar?year=2026&month=10`、`GET /api/tasks/by-date?date=2026-10-15` |

H2 的 `TIMESTAMP WITH TIME ZONE` 与 MySQL 的 `DATETIME(6)` 在实体里都由 `OffsetDateTime` 映射。
**H2 file profile 已实测**（V1 / V1.1 / UI 各轮验收都在 H2 上跑通）；**MySQL 的建库脚本与 profile 配置已提供，
但本机无 MySQL/Docker，映射与配置尚待实测**（见 §7.2 与 §10 第 2 条）。

---

## 6. API 一览

统一前缀 `/api`。错误响应结构一致：

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

错误码：`VALIDATION_FAILED` / `INVALID_ARGUMENT` / `RESOURCE_NOT_FOUND`(404) / `RESOURCE_IN_USE`(409) /
`FILE_TOO_LARGE`(413) / `UNSUPPORTED_MEDIA_TYPE`(415) / `INTERNAL_ERROR`(500)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/courses` | 课程列表（`keyword`）/ 新建 |
| GET / PUT / DELETE | `/api/courses/{id}` | 详情 / 更新 / 删除（有引用返回 409，`?force=true` 安全级联） |
| GET / POST | `/api/courses/{id}/schedules` | 课程课表 / 新建 |
| PUT / DELETE | `/api/courses/{courseId}/schedules/{scheduleId}` | 更新 / 删除 |
| GET | `/api/schedules?weekday=&date=` | 全部课表（可按星期、按"这一天是否上课"筛选） |
| GET | `/api/schedules/today` | 今日课程（教学周 + 单双周规则生效） |
| GET | `/api/schedules/by-date?date=` | 指定日期实际要上的课（日期详情页使用） |
| POST | `/api/schedules/import` | 批量导入课表（照片导入确认后；新建课程 + 课表单事务） |
| GET | `/api/calendar?year=&month=` | 月历：当月每天的任务 DDL + 课程（一次返回） |
| GET / POST | `/api/tasks` | 列表（筛选+排序+分页）/ 新建 |
| **POST** | **`/api/tasks/resolve-time`** | **V1.2 时间助手（只读）：简短时间短语 + 带偏移量的 `referenceAt` + 可选 `courseId` → 候选时间 / 需补信息 / 不支持 / 课表无匹配；不写库** |
| GET / PUT / PATCH / DELETE | `/api/tasks/{id}` | 详情 / 全量更新 / 局部更新 / 删除 |
| PATCH | `/api/tasks/{id}/status` | 状态切换 `{"status":"DOING"}` |
| GET | `/api/tasks/deadlines?sort=deadline\|priority` | DDL 排序列表（逾期在前，默认不含已完成） |
| GET | `/api/tasks/today` | 今日任务（今天截止 + 已逾期未完成） |
| GET | `/api/tasks/calendar?year=&month=` | 按月查询（按日期分组） |
| GET | `/api/tasks/by-date?date=` | 按日期查询 |
| GET | `/api/tasks/stats` | 首页概览统计 |
| GET / POST | `/api/tasks/{taskId}/sources` | 原通知列表 / 新建 |
| GET / POST | `/api/sources` | 全部原通知 / 创建暂存原通知（V1.1 预留） |
| GET / DELETE | `/api/sources/{id}` | 原通知详情 / 删除（含附件文件） |
| POST | `/api/sources/{id}/attachments` | 上传图片（multipart `file`，可多张） |
| GET / DELETE | `/api/attachments/{id}` | 查看（`inline`）/ 下载（`?download=true`）/ 删除 |
| GET / PUT | `/api/profile` | 本地资料 |
| GET | `/api/meta/enums` | 枚举与时间格式元数据 |
| GET | `/api/meta/storage-limits` | 图片与批量导入的真实上限（单张 / 请求 / 张数 / 候选数 / 来源数 / 副本总量） |
| POST | `/api/tasks/import-notices` | 「通知 → 待办」批量导入（multipart：`notice` JSON + 可重复的 `files`），单事务写入任务 + 原通知 + 原图 |

### 教学周与单双周规则

- 每条课表可选填：**学期第一周周一**（必须是周一）、**起始 / 结束教学周**（1-53）、**上课周次**（每周 / 单周 / 双周）。
- 三者齐全时才按教学周过滤：先算教学周序号（学期第一周所在周为第 1 周），再取 `[起始周, 结束周]`，
  最后按**教学周序号的奇偶**判断单双周（不是日期奇偶，也不是 ISO 年周数）。
- 旧数据（新增列全部为空）**按每周处理**，行为与升级前一致；界面会提示"建议补学期起点后启用教学周"。
- `GET /api/schedules/today`、`GET /api/schedules?date=`、`GET /api/schedules/by-date`、
  `GET /api/calendar` 全部复用同一套判定（`ScheduleRules`），不会各处一套。
- 校验（服务端，单条与批量导入一致）：星期 1-7、节次 1-12、周次 1-53、起止周不能倒置、
  学期起点必须是周一、填了起止周就必须有学期起点、单双周必须有学期起点与起止周。

### 照片导入课表（本地 OCR）

- 入口：课程与课表页的「照片导入课表」按钮，或直接访问 `/courses/import-schedule`。
- 流程：选图片（PNG/JPEG/WebP，≤12 MB）→ **在浏览器里**用 Tesseract.js（中文 + 英文）识别 →
  解析成可编辑候选（课程 / 星期 / 起止时间 / 节次 / 地点 / 起止周 / 每周·单周·双周）→ 勾选确认 → 批量写库。
- 资源全部同源：`frontend/public/tesseract/{worker.min.js,core/,lang/}`，由
  `scripts/prepare-ocr-assets.mjs` 在构建时从官方 npm 包复制（Apache-2.0，来源写在 `public/tesseract/README.txt`）。
  **运行期不访问 CDN，图片不上传**，识别完全在本机浏览器完成。
- 识别不理想时：可以拖拽框选**单门课**区域重新识别、查看 OCR 原文、手工添加候选、随时取消识别。
- 解析不到具体时刻时**留空并提示**，不会把"第 1-2 节"猜成某个固定时间；星期 / 周次缺失同样留空提示。
- 确认导入调用 `POST /api/schedules/import`：新建课程与课表在**一个事务**里完成；请求内完全相同的行会被拒绝，
  与库里完全相同的行会被跳过并计数（防重复提交），同一天时间重叠且周次无法共存的安排会明确报错。

```powershell
cd frontend
node scripts\prepare-ocr-assets.mjs      # 复制 OCR 资源（worker/core/中英文模型）
node tests\timetableParser.test.mjs      # 解析器测试（13 项，含 2 项真实 OCR 输出快照回归）
node tests\ocrImageLifecycle.test.mjs    # 图片生命周期测试（9 项）
node scripts\ocr-smoke.mjs               # 真实 OCR 冒烟：识别样例图并保存原始结果
```

### 从通知截图 / 文字创建待办（V1.1 本地版）

- 入口：任务列表页的「从通知导入」、原通知页的「从通知创建任务」，或直接访问 `/tasks/import-notices`。
- 流程：粘贴通知文字、选择最多 8 张截图（PNG/JPEG/WebP，单张 ≤ 5 MB、单次请求 ≤ 20 MB），或两者并用 →
  **在浏览器里**用 Tesseract.js 逐张**串行**识别（可取消；坏图不阻塞其它图）→ 生成**可编辑候选**
  （课程 / 标题 / 类型 / 截止时间 / 提交要求 / 提交方式，并保留来源关联）→ 勾选并确认后才写库。
- 识别与解析**全部在浏览器本地完成**，图片不上传、不访问 CDN；后端不调用任何模型，只做校验与落库。
- **保守规则，不猜时间**：只有「完整日期 + 时刻」才会直接作为候选截止时间；
  「10月15日交」「下周五」「明天下午」这类会**保留原话并提示核对**，不会静默用今天日期或 23:59 顶替。
  通知解析器的默认保守逻辑在 V1.2 中**没有改动**（相对时间仍然留空）；需要相对时间时用下面 §「时间助手」手工输入短句。
- 不确定就留空：课程可为空、截止时间可缺（沿用任务规则显示"待补充"），提交前会显式提示这些缺失项。
- 确认保存调用 `POST /api/tasks/import-notices`（`multipart/form-data`：`notice` 是 JSON，`files` 可重复出现）：
  在**一个事务**里创建 任务 + 该任务自己的原通知 + 该任务自己的原图；任何候选不合法都整体不写库，
  已落盘的文件按记录清理。
- 原图**每条任务各存一份独立文件与独立记录**：同一张截图被多条任务引用时不共用磁盘路径，
  删除其中一条任务不会让另一条任务的原图失效。
- 请求内去重：**只拒绝语义字段（标题 / 说明 / 课程 / 类型 / 状态 / 截止时间 / 提交要求 / 提交方式）
  与来源集合完全相同的候选**；不同课程或不同来源的同名同时间任务可以同时导入。
  ⚠️ 这是**同一次请求内**的去重，**不是跨请求幂等**：同样的候选分两次提交仍会各写一份，防重复点击依赖前端。
- 容量上限（可用 `GET /api/meta/storage-limits` 读取）：单张 5 MiB、单次请求 20 MiB、最多 8 张图、
  最多 30 条候选、最多 12 个来源，以及**实际写盘副本总量 100 MiB**。副本总量按「每个
  （任务, 来源）绑定实际引用的文件大小」求和，超过时在**落盘与写库之前**整体 400 并提示分批导入。
- 合成样图：`frontend/public/samples/notices/` 下有 8 张**合成**通知图（`frontend/scripts/make-notice-samples.mjs` 生成，页面标明示例），
  本轮就是用它做的端到端验收（8 张 → 11 条候选）。**样图 04 的邮箱仍有 OCR 错字，需人工校对**。
- 验收状态：**已完成**（2026-10-09）——后端 124 项、前端 139 项、浏览器通知 11 + 边界 4 项、
  通知 HTTP 13 + 边界 3 项、课表回归 10 项全部通过。这些结论只覆盖合成样图，不保证任意截图正确。
  详见 [`docs/verification.md`](docs/verification.md) §0.3。

### 时间助手（V1.2，本地确定性规则，只读）

- 接口：`POST /api/tasks/resolve-time`，请求 `{ "text": "下周五上课前", "referenceAt": "2026-10-10T12:00:00+08:00", "courseId": 3 }`。
  `text` 必须是**简短时间短语**（1–500 字），`referenceAt` **必须带时区偏移量**（否则 400）。
- 响应 `status` 四态：`RESOLVED`（候选带明确 `+08:00` deadline 与理由）/ `NEEDS_INFO`（信息不足，要求补全）/
  `UNSUPPORTED`（否定 / 延期 / 更改 / 需要校历等，保守拒绝）/ `NO_COURSE_MATCH`（课程说法成立但窗口内课表没有匹配）。
- 支持与拒绝的完整清单、课程窗口语义（教学周 / 单双周 / 不越周 / 取最早一节 / 截止 = 上课开始边界）
  见 [`docs/v1.2-time-assistant.md`](docs/v1.2-time-assistant.md)。
- 前端入口：
  - 「新建任务」「编辑任务」页面，**截止时间输入框下方**的可折叠「时间助手」（课程沿用表单当前选择）；
  - 「从通知创建任务」页，**每条候选的截止时间旁**的可折叠「时间助手」（课程沿用该候选的课程）。
  两处都是**点「采用此时间」才写入**，参考时间默认现在的北京时间、可改成通知发布时间；保存期间禁用。
- 时区契约：固定 `Asia/Shanghai`，所有 deadline 都是 `+08:00`；表单 DDL 也统一按北京时间填写与提交。

### 任务列表查询参数

`courseId, status, type, priority, keyword, dueFrom, dueTo, includeDone(默认 false), overdueOnly, page(0), size(20), sort(deadline|priority|createdAt|updatedAt|title|course), direction(asc|desc)`

### 附件安全策略

- 只接受图片：`image/png` `image/jpeg` `image/webp` `image/gif`，**按文件头魔数嗅探**，不信任客户端声明的 Content-Type
- 单文件 ≤ 5 MB（`DDLMATE_MAX_FILE_SIZE`），单请求 ≤ 20 MB
- 通知导入另有上限：最多 8 张图、12 个来源、30 条候选；**实际写盘副本总量 ≤ 100 MiB**
  （同一张图被多条任务引用时会各存一份副本，按每个「任务 + 来源」绑定引用的文件大小求和）
- 文件名由服务器生成（`UUID.ext`）；用户原始名只做展示，且去掉目录部分与非法字符
- 读取时对路径做 `normalize` + 强制位于上传目录内，阻止 `../` 路径穿越

---

## 7. 数据库配置

### 7.1 开发 / 演示：H2 文件库（默认）

无需安装任何数据库。`ddl-auto=update` 会自动建表，启动时若课程表为空会写入示例数据（见 `DevDataSeeder`）。

**数据落在哪里（容易踩坑）**：`application-dev.yml` 里用的是相对路径 `./data`，
而通过 `scripts\start-backend.ps1`（即 `mvn -f backend/pom.xml spring-boot:run`）启动时，
Maven 把**进程工作目录设为 `backend/`**，所以实际位置是：

| 内容 | 实际路径 |
| --- | --- |
| H2 数据库文件 | `backend\data\ddlmate-dev.mv.db` |
| 上传的附件 | `backend\data\uploads\`（按 `年/月` 分目录） |

> 仓库根目录下的 `data\` 只在你手动以仓库根为工作目录启动时才会用到。
> 想固定位置，用环境变量指定绝对路径：`DDLMATE_UPLOAD_DIR`（附件）与 `DDLMATE_H2_*`（账号），
> 或直接用 `java -jar backend\target\ddl-mate-backend-1.0.0-SNAPSHOT.jar`（此时工作目录就是当前所在目录）。

### 7.2 正式：MySQL 8

```powershell
# 1) 建库建表（会创建 ddl_mate 库与 ddl_mate 用户，请先改脚本里的密码）
mysql -u root -p < backend\src\main\resources\db\mysql\schema.sql

# 2) 用 mysql profile 启动（ddl-auto=validate，只校验不建表）
$env:DDLMATE_MYSQL_URL = 'jdbc:mysql://127.0.0.1:3306/ddl_mate?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&useSSL=false'
$env:DDLMATE_MYSQL_USER = 'ddl_mate'
$env:DDLMATE_MYSQL_PASSWORD = '<你的密码>'
& $mvn -B "-Dmaven.repo.local=$PWD\.tools\m2\repository" -f backend\pom.xml spring-boot:run "-Dspring-boot.run.profiles=mysql"
```

> ⚠️ **本机没有安装 MySQL，也没有 Docker，所以 `mysql` profile 未经实测**，细节见 [`docs/verification.md`](docs/verification.md)。

环境变量完整列表见 [`.env.example`](.env.example)。

---

## 8. 数据模型

```text
AppUser (本地单人资料，非认证)
Course ──< CourseSchedule
   │
   └──< Task ──< TaskSource ──< Attachment
```

- **课程删除保护**：课程下还有任务或课表时，`DELETE /api/courses/{id}` 返回 **409**；
  显式 `?force=true` 时先解除任务的课程关联、再删除该课程的课表，然后删除课程（响应体里会说明）。
- **任务删除**：级联删除其原通知与附件记录；附件的磁盘文件在服务层显式清理。
- **附件二进制不入库**，只保存元数据 + 磁盘相对路径。
- 为 V1.1 / V2 预留但**本轮未建表**：`sub_tasks`、`reminders`、`daily_plans`、`plan_items`。

### 多用户迁移路径（正式上线前）

1. 引入 Spring Security + JWT，`/api/**` 全部要求认证；
2. `app_users` 增加 `password_hash` 等字段，`courses` / `tasks` / `task_sources` 增加 `user_id` 外键；
3. 所有 Repository 查询追加 `user_id` 条件（建议用 Hibernate Filter 或 `@Where`）；
4. 前端增加登录页与 token 注入（当前 `src/api/client.js` 已集中处理请求，改动点集中）。

---

## 9. 源码自检工具

```powershell
# 机械检查：括号/引号配对、JSON 可解析、必需文件齐全（不替代 mvn test / pnpm build）
node .tools\_selfcheck.mjs .
```

---

## 10. 已知限制

1. **无鉴权**：仅绑定 `127.0.0.1` 的单人开发版本，`/api/profile` 返回 `authenticationEnabled=false` 明确标注。
2. **MySQL 未实测**：本机无 MySQL/Docker；H2 file profile 覆盖同一套后端逻辑，MySQL 建库脚本与配置已提供但未连接过真实实例。
3. **仍未实现的路线图功能**：大模型 / LLM 语义抽取（V1.1 剩余部分）、
   任务拆分 / 冲突检测 / 每日计划 / 手机提醒（V2）。
   界面不提供假的 AI 按钮，全部写在「路线图」页。
   注意区分：**课表照片 OCR**、**通知截图 / 文字 → 待办**（V1.1 本地版）
   与 **V1.2 时间助手**都已在本地实现，用的都是确定性规则 / 浏览器端 OCR，**都不包含 LLM 抽取**。
4. **课表校历**：已支持教学周与单双周（按教学周序号奇偶），但**不做**单双周以外的校历推算
   （停课周、调休、国庆假期等）；这类需要教学日历表，V1.2 时间助手对这类说法**明确保守拒绝**，是后续扩展点。
5. **任务列表排序/分页在内存完成**：`GET /api/tasks`、`/api/tasks/deadlines` 的排序与分页由服务层完成，
   原因是 Hibernate 6.6 的 Criteria 查询不支持 `NULLS LAST`，而「没有 DDL 的任务排在最后」需要空值偏好
   （`Sort.Order.nullsLast()` 会直接抛 `UnsupportedOperationException`）。
   单人本机数据量下没有问题；数据量增长后应改为数据库侧排序（显式 `CASE WHEN` 排序表达式或原生 SQL）。
6. **照片 OCR 的准确率取决于照片质量**：已用两张样例图做过**真实 OCR** 验证（Node 冒烟脚本 + 真实 Chrome 各跑一次，结果一致）——
   列表式课表（置信度 91）3/3 完全正确；表格式课表（置信度 91）也能还原出 **3 条独立候选**，
   但该图 **周三表头未被识别**，解析器按相邻表头位置 + 星期顺序推断该列，并用提示标出"这一列是推断的，请确认"，
   不会静默当成确定结果。识别不准时可以：框选单门课重新识别（默认追加，也可指定替换某一条，不会丢掉已确认的其它课）、
   查看 OCR 原文，或手工添加候选（手工入口始终可用）。
   深色卡片周视图会先按卡片拆分，再分别识别表头、左侧时间和课程文字。用户实图 21 个块全部定位，
   名称与地点各有 1 处误差，需在导入前核对。单张周视图无法证明整个学期的重复规律，默认只保留所示教学周。
   > 参数说明：普通整页表格采用 **PSM 11（稀疏文本）**；分割后的单个课块采用 PSM 6。
   > 参数集中在 `frontend/src/ocr/ocrConfig.js`，浏览器端与 Node 冒烟脚本共用。
7. **通知导入的验收只覆盖 8 张合成样图**：样图 04 的邮箱识别出错字，需人工校对；无年份 / 相对日期一律留空提示。
   真实截图（不同字体、光照、裁剪、群聊气泡）尚未验证，实际效果可能更差。
8. **V1.2 时间助手是规则解析，不是语义理解**：只接受简短时间短语；
   只有日期 / 只有时刻 / 今晚 / 尽快 / 周末 / 范围 / 多重日期或时刻一律提示补全（**绝不补 23:59**）；
   否定 / 延期 / 更改 / 「…以前」/ 需要校历 / `下下周五18:00` / `明天18:000` / `下节课前两小时` /
   带课程名或类型限定的「课前」（如「下次实验课前」）一律保守拒绝。
   课程匹配只按课程 + 星期 + 教学周规则，不区分同一门课的理论 / 实验课堂类型。
   实现阶段本机沙箱的 esbuild `spawn EPERM` 已由 Codex 提权正常构建解决（不是当前构建失败）；
   最终构建、真实浏览器验收与 8080 更新均由 Codex 完成，见 [`docs/verification.md`](docs/verification.md) §0.5。

---

## 11. 相关文档

- 实施方案与四期计划：[`docs/implementation-plan.md`](docs/implementation-plan.md)
- V1.2 时间助手（支持短语 / 保守边界 / 接口契约）：[`docs/v1.2-time-assistant.md`](docs/v1.2-time-assistant.md)
- 验证记录（真实执行结果）：[`docs/verification.md`](docs/verification.md)（§0.4 = UI 重做与部署验收）
- 界面设计说明：[`docs/ui-design.md`](docs/ui-design.md)
- 阶段状态：[`.supervision/status.json`](.supervision/status.json)
- V1.2 本轮状态：[`.supervision/v12-status.json`](.supervision/v12-status.json)、审查意见：[`.supervision/v12-review-round1.md`](.supervision/v12-review-round1.md)
- UI 本轮状态与部署证据：[`.supervision/ui-refresh-status.json`](.supervision/ui-refresh-status.json)、[`.supervision/ui-live-deploy.json`](.supervision/ui-live-deploy.json)
- 真实课表照片历史轮次状态：[`.supervision/user-photo-status.json`](.supervision/user-photo-status.json)
- 通知导入本轮状态：[`.supervision/notice-import-status.json`](.supervision/notice-import-status.json)
