# 大学生ddl / DDL Mate — Claude Code 交接

> 交接快照：2026-11-03，依据 Codex checkpoint 尾部与当前源码抽样核对。
> **本文件只做交接，不启动新任务；也不证明 Claude UI 已接通**（工作区连接由 Codex 另行处理）。
> 用户已选择 Claude Code 作为接手工具，但**尚未要求开始新的代码改动**。

## 1. 唯一真实工作区

`C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl`

产品中文名 **大学生ddl**，英文名 **DDL Mate**。本机这个文件夹是当前源码与文档的 source of truth；Claude Code 直接在这个文件夹继续开发。它不是云端上传副本，链接/克隆文件夹也不等于迁移了手机数据或完整聊天记录。

## 2. 当前主线与历史线

| 线 | 状态 | 位置 |
| --- | --- | --- |
| 原生 iOS App | **当前主产品**：Expo SDK 58 + React Native 0.88.0 + React 19.3.0 + TypeScript，真实原生视图，非 WebView/PWA | `mobile/` |
| 本地 OCR 伴侣 | **当前配套**：电脑同一 Wi-Fi 上运行，Node + Tesseract，默认端口 **8082**，图片不传第三方 | `companion/` |
| 旧 Web 版 | **归档历史**：Vue 3 前端 + Spring Boot 后端，旧 8080 Web 线；文件保留供参考，不是当前交付 | `frontend/`, `backend/` |

- 根 `README.md` 描述的是 2026-10-10 的 Web V1/V1.2 和 8080 服务，**不是当前移动端功能状态**。
- `mobile/README.md` 也保留了早期“里程碑 1”、SDK 57、147 项测试等旧表述；当前以 `mobile/package.json`、`docs/` 最新模块文档和实际源码为准。
- 独立 iOS 安装包目前搁置：没有 Mac，也没有付费开发者账号；真机通道是 **iPhone Expo Go + 局域网 Metro**，不是 IPA/TestFlight。

## 3. 实际功能面

实屏代码在 `mobile/src/screens/`（44 个文件，含少量 controller/state 模块），当前功能说明在 `docs/`（**34 篇 Markdown**），测试在 `mobile/tests/`（132 个 `.test.mjs` 文件，不代表需要一次全跑）。

入口仍是四个原生标签：**今天 / 任务 / 课程 / 日历**（`mobile/src/navigation/RootNavigator.tsx`）。主要已实现模块：

| 模块 | 代表实屏 / 核心路径 | 说明 |
| --- | --- | --- |
| 任务管理 | `TaskListScreen`, `TaskFormScreen`, `TaskDetailScreen` | 新建、编辑、完成、删除、截止时间、筛选、关键词反馈 |
| 批量与模板 | `TaskBatchManager`, `TaskTemplate*`, `RecurrenceScreen` | 多选完成/统一截止日期；任务模板、重复任务 |
| 任务增强 | `TaskStepsScreen`, `TaskPhotosScreen`, `TaskReminderScreen` | 步骤、原图、本机固定提前量截止提醒 |
| 通知/截图转待办 | `NoticeImportScreen`, `NoticePhotoScreen`, `BatchNoticeScreen` | 原文解析、截图 OCR、批量候选核对后写入 |
| 课程与课表 | `Course*Screen`, `ScheduleFormScreen`, `TeachingWeekScreen` | 课程、课表、多天/单双周、教学周、冲突检查、上课前提醒 |
| 课表 OCR 导入 | `PhotoImportScreen`, `PhotoReviewScreen`, `PhotoLibraryScreen` | 手机拍照 → 电脑本地 OCR 8082 → 核对 → 单事务导入 |
| 日历 | `CalendarMonthScreen`, `CalendarDayScreen` | 月历、当天课程与 DDL；返回月份保留已修复 |
| 考试与复习 | `ExamScreens`, `ExamPhoto*`, `ExamRevisionScreen` | 考试列表、照片识别、复习安排 |
| 规划与统计 | `TodayPlanScreen`, `PressureScreen`, `LearningReportScreen` | 今日计划、DDL 压力、学习周报、每周目标 |
| 专注 | `FocusTimeScreen`, `ui/FocusFullscreen.tsx`, `FocusRecordManager` | 正计时、番茄钟、全屏专注、休息、提醒、专注记录 |
| 备份与恢复 | `BackupScreen`, `BackupContentScreen` | 本机备份库、内容预览、系统“文件”导出/恢复 |
| 搜索 | `GlobalSearchScreen` | 任务、课程、考试、笔记/原文的本地搜索 |

注意：当前**没有** LLM/AI 拆解、云推送、账号体系、多设备同步；旧 Web 的能力不能自动算作原生已验收。

## 4. 最近交付与验收边界

### 4.1 番茄钟全屏：已完成，用户已接受

- 实现由 DeepSeek `session-18e79be4-d1da-4569-9a91-d93653470f19` 完成，已 `exit 0`；Codex 监督并完成复核修正。
- 最终 **65 项测试、17 个文件通过**，`tsc --noEmit` exit 0；实际 iOS manifest/bundle 加载通过（HTTP 200、SDK 58、身份与标记检查）。
- 用户在真机问答后明确确认：**“全屏效果、暂停和退出都正常”**。
- 该确认只覆盖全屏外观、暂停、退出；不要外推为通知送达、横屏/最大字号、所有保存失败/休息路径都已逐项真机验收。
- 详情：`docs/native-focus-fullscreen.md`，证据：`.supervision/focus-fullscreen-handoff-20261103.md`、`.supervision/focus-fullscreen-focused-tests-20261103-final6.log`、`.supervision/focus-fullscreen-tsc-20261103-final6.log`、`.supervision/focus-fullscreen-preview-20261103-result.json`。

### 4.2 仍在等手机 QA，不能写成已验收

- **任务页关键词反馈**：已针对任务页原“关键词”框（不是全局搜索页）补了显式搜索、结果/零结果数量、筛选范围与清空；“全部任务中查找”可覆盖已完成任务。8/8 相关检查通过、tsc 通过、实际 iOS bundle 通过；**手机验收未知**。
  - 文档：`docs/native-global-search.md`；日志：`.supervision/task-keyword-feedback-tests-20261103.log`。
- **日历返回保留月份**：从日期详情返回时不再无条件 reset，保留所浏览月份；tab 再次进入默认今天、显式“今天”按钮行为保持。35/35 相关测试通过、tsc 通过、实际 iOS bundle 通过；**手机验收未知**。
  - 证据：`.supervision/calendar-return-handoff-20261103.md`、`.supervision/calendar-return-tests-20261103.log`。
- 全局搜索本体也已有本地实现与测试，但手机最终验收同样待定。其余提醒、备份、OCR 等模块以各自 `docs/` 文档为准，**不要用局部确认推断“全部功能已验收”**。

## 5. 环境、启动与验证命令

### Node

机器上已验证的固定 Node：`C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`（**v24.22.1**，满足项目 `>=20.19.4`）。`scripts/start-mobile.ps1` 会优先使用它；路径不存在时才回退 PATH。该绝对路径是本机环境，不是项目依赖。

### 启动手机预览

```powershell
cd "C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl"
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1 -Lan
```

- 端口默认 **8081**。上次 checkpoint 的局域网地址是 `exp://192.168.31.73:8081`，**IP 可能变化**：以本次启动输出/二维码为准，不要写死旧 IP。
- iPhone 安装 **Expo Go**，手机与电脑同一 Wi-Fi，Expo Go 登录与电脑相同的免费账号，扫码加载。
- 这是 Metro 开发预览，不是独立 App；电脑 Metro 停掉后手机不能冷启动。

### 本地 OCR 伴侣（需要拍照导入时）

```powershell
cd "C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl\companion"
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" src\server.mjs --lan
```

手机端在“课程 → 识别服务设置”填终端打印的 `http://电脑当前IP:8082`，先“测试连接”。不加 `--lan` 只监听 `127.0.0.1`，手机连不上。

### 测试与类型检查（定向执行，避免无意义全跑）

```powershell
cd "C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl\mobile"
$node = "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
& $node --import ./tests/setup.mjs --test --experimental-test-isolation=none tests/focusFullscreen.test.mjs tests/focusTimeScreen.test.mjs
& $node .\node_modules\typescript\bin\tsc --noEmit
```

全量测试入口（可能较慢，不是交接必跑项）：

```powershell
& $node --import ./tests/setup.mjs --test --experimental-test-isolation=none tests/*.test.mjs
```

`--experimental-test-isolation=none` 是受限沙箱/本机测试的关键，避免测试子进程管道 `spawn EPERM`。`expo export`/`expo install --check` 会写 Expo 家目录，沙箱下可能还需要临时 `__UNSAFE_EXPO_HOME_DIRECTORY` 或更高权限；不要把导出成功误称为 IPA 构建成功。

## 6. 数据与迁移边界

- 手机的实时数据主要存在 **iPhone 应用沙盒**的 SQLite（`ddl-mate.db`），以及应用 `Documents/` 下的截图、备份等文件；本机备份库在 `Documents/backups/library/`。它们**不是全部位于源码文件夹**。
- 仅把 `C:\...\大学生ddl` 链接给 Claude Code，只会得到代码、文档和仓库内测试材料；**不会自动复制手机 SQLite、照片、备份，也不会复制完整 Codex 聊天记录**。
- 不要把“打开同一个文件夹”说成“手机数据已迁移/已同步”。如以后需要迁移，必须另行设计并明确授权，不能覆盖现有手机数据。
- 阅读代码和文档**不需要任何账号、token 或凭据**；不要把 Cookie、API key、Expo 登录信息、账号密码写入交接文件。

## 7. 历史快照与生成物（不要混淆）

- **最新事实来源**：`mobile/src/`、`mobile/tests/`、`docs/*.md`、`companion/src/`、`scripts/`。
- **历史快照/证据**：`.supervision/` 中的 `*-before-*`、旧 handoff、测试日志、preview 结果、Harness 记录。保留本地供追溯，不是当前产品源码；不要用旧快照覆盖最新文件。
- **生成物/依赖**：`mobile/node_modules*`、`mobile/dist-ios/`、`mobile/.expo/`、`.tools/`、`.pnpm-store/`、`node_modules/`。这些不是作者维护的产品逻辑，不要从中反推需求，也不要为了“清理”而删除。
- `.codex/` 归 Codex 管理：**Claude Code 不写、不改、不移动**。需要当前状态时只读 `.codex/resume/01a10c75-208b-7723-9935-89ce4a2a2e00.md` 尾部，不要整份倾倒历史日志。

## 8. 接手时的硬性边界

- 当前只是交接，**不要自动开始新版本、重构或“顺手修”**；等用户明确的新请求。
- 不重装依赖、不升级 Expo SDK、不改 lockfile/schema/应用身份、不删除或移动项目文件夹、不跑 `git clean`/`git reset`。
- 现有 `master` 工作树中，**顶层未跟踪文件也是现状基线**，不能当垃圾清理。先保留、先确认，再改动。
- 不要运行会改写手机真实数据的恢复/导入流程；不要覆盖用户现有 SQLite、截图或备份。
- 历史协作默认是 **DeepSeek Harness 执行、Codex 监督**；切换执行者需要用户同意或明确指定。当前用户已选择 Claude Code 作为承接工具，但**没有授权某个新功能立即开工**；不要把“换工具”理解为“范围扩大”。
- 本文件不等于 Claude UI 已连接；连接状态由 Codex 侧确认。

## 9. 建议的接手顺序

1. 先读本文件、`mobile/package.json`、`mobile/src/navigation/RootNavigator.tsx`。
2. 只读对应模块的 `docs/native-*.md` 和实际屏幕/领域/仓库文件。
3. 若用户给出具体新任务，再做最小范围改动；先跑定向测试和 `tsc`，再决定是否需要实际 Expo/iOS 预览。
4. 手机验收必须由用户真机确认后才可记录为“已验收”，不能以组件测试或 bundle 200 代替。
