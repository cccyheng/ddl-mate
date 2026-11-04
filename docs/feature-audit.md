# DDL Mate 原始 10 项功能审计（Web 现状 vs 原生 iOS）

## 当前状态（截至 2026-10-22，先读这一节）

> 下面的历史表格是**里程碑 1 / 多天课表轮**的快照，不是当前全部实现。当前新增能力请以本节和
> `docs/native-task-reminders.md`、`docs/native-notification-navigation.md`、
> `docs/native-batch-notices.md`、`docs/native-task-steps.md`、`docs/native-plan.md`、
> **`docs/native-backup.md`** 等模块文档为准；本文件不重写历史，也不把计划当实现。
>
> - **数据备份与恢复**：已实现原生「备份与恢复」入口（今天页 / 课程页），导出**单文件**
>   `ddlmate.native-backup` v1（任务、课程/课表、原始通知文本、截图原图字节与引用、
>   步骤、教学周、参考用时、今日计划、提醒选择），用系统「文件」目录选择器保存；
>   选择备份文件后先预览计数 / 大小 / 格式版本 / 日期与替换影响，再二次确认替换式恢复。
>   恢复前生成当前数据的完整恢复备份；图片先落唯一暂存目录并逐张校验，再单事务替换 SQLite；
>   失败保持旧库 / 旧照片可用；提交后刷新失败与导航重建失败分别报告，不引导重复恢复。
>   通知载荷带本机恢复代次，旧通知点击不会打开恢复后复用 ID 的任务；提醒选择恢复后关闭待复核；
>   OCR 地址保留本机、通知回执不复制。已合法删除的任务/课程/课表的**历史截图关联**会保留，
>   恢复后新实体 ID 不会复用历史 target（SQLite AUTOINCREMENT 高水位）；导出物先用恢复 parser
>   自检。主要流程是**持久本机备份库**（应用内、重启仍在，卸载会删除），无需先导出；
>   同一快照可按需另存到「文件」。库内可只读分页查看任务/课程/课表/原始截图（截图走暂存
>   文件与全屏放大），内容来自备份而非当前 DB；本机快照可直接进入既有严格预览后恢复。
>   外部 / 旧文件可手动选择一次后保留到库。**tsc 0 error；聚焦备份测试 31/31、
>   独立 supervisor library oracle 5/5、聚焦提醒回归 96/96、聚焦数据层回归
>   115/115 通过；独立 supervisor final 12/12（上一修订）、其 tsc exit 0；尚未在 iPhone 上
>   验收系统文件选择器 / 目录写入 / iOS bundle**。证据：`docs/native-backup.md`、
>   `.supervision/backup-library-handoff.md`。
>
> - **K 手机提醒 / 通知**：已实现**本机、固定提前量**的任务截止提醒（30 分钟 / 3 小时 / 1 天 / 3 天，
>   每条任务默认关闭，最多 32 条启用规则；显式开启 / 测试才申请权限，保存后区分「规则已保存」与
>   「系统已排队」，任务完成 / 删除 / 改期会同步取消或替换）。
>   **真实手机已确认收到通知（送达已由用户确认）**；但点击通知**没有正确打开任务详情**。
>   2026-10-21 修复了两个有证据的代码缺陷：干净 `TaskDetail` / `TaskReminder` 被误判为编辑中，
>   以及导航未被确认就写已消费回执；并加入紧凑本机诊断（构建 `phonefix-20261021-1`）。
>   **修复后点击导航仍待同一台手机复测，尚未验收；这两个缺陷不是已被证实的唯一手机失败原因。**
>   它不是云推送、不是智能提醒。证据：`docs/native-task-reminders.md`、
>   `docs/native-notification-navigation.md`、`.supervision/notification-phone-fix-handoff.md`。
> - **C AI 拆解任务 / E AI 每日计划**：**仍然未实现**（Web 与原生都没有大模型接入）。
> - 历史表格里「手机通知提醒未实现」「截图通知 OCR 未实现」等行描述的是当时里程碑，不代表
>   2026-10-21 的现状；本文件的其它模块（A / F / G / M 等）也请结合各自最新文档阅读。
> - 独立安装包、远程推送、云端构建仍不在本模块授权范围。

> 编写时间：2026-10-10（复核跟进轮）；2026-10-11 更新（Codex 监督复核 + 最终验收；随后**多天课表轮**）
> 审计人：DeepSeek Harness；独立复核：Codex
> 状态：**原生里程碑 1 的代码、依赖与本地校验已完成（2026-10-11 多天课表轮后为 123/123 测试通过、
> tsc 0 error、独立真实 SQLite 8/8、依赖版本一致、含 Hermes 字节码的完整导出 PASS（需提权）、
> Codex 侧 `-Lan` Metro 局域网 HTTP 200、`--no-bytecode` 的 iOS 打包 exit 0）；用户已在 iPhone 的
> Expo Go 上自报确认首页与底部标签栏可显示（冒烟测试 PASS），但完整流程与真机 SQLite 持久化仍未验收（见 §5）。**
> 需求 2（照片识别导入）与需求 4（移除学期首周一输入）本轮**未实现**。
> 本表只记录「代码里实际有什么」，不把计划当实现。
>
> 术语：**WEB** = 已部署的 Vue3 前端（`127.0.0.1:8080`，V1.2 已验收）；
> **NATIVE** = `mobile/`（Expo SDK 57 + React Native，真实原生视图，非 WebView/PWA）。
> 「原生可用」严格指：有真实屏幕、能写进 expo-sqlite、**真机跑过**。
> 因此下表 NATIVE 列即使写「已实现（代码）」，也不等于「原生可用」——
> **目前没有任何一条达到真机验收**。

## 1. 用户原始 10 项需求对照

| # | 功能 | WEB 现状 | NATIVE 本轮实际进度 | 判定 |
| --- | --- | --- | --- | --- |
| A | 截图 OCR 识别通知 | 已实现：浏览器本地 Tesseract（中+英），可框选、重识别、候选核对后写库 | **未实现**。没有照片选择、没有 OCR、没有候选表；`app.json` 未引入 `expo-image-picker`。原生 Vision OCR 需要 dev build（Expo Go 不可用） | ⛔ 原生待做 |
| C | AI 拆解任务 | **未实现**（无大模型接入） | **未实现**，本里程碑明确排除 | ⛔ 双侧都无 |
| E | AI 每日计划 | **未实现** | **未实现**，本里程碑明确排除 | ⛔ 双侧都无 |
| F | 日历 | 已实现：月视图 + 日期详情 + 任务 DDL | **已实现（代码）**：`CalendarMonthScreen` 6×7 可点网格（周一起始、今天高亮、逾期圆点、真实课程/DDL 计数）→ `CalendarDayScreen` 当天课程（时间 + 地点 + 周次规律）与截止任务 → 点任务进详情。逻辑在 `domain/calendar.ts` | ⚠️ 代码完成，**真机未验收** |
| G | 课程关联 | 已实现：任务关联课程、课程删除保护（409 + 强制确认） | **已实现（代码）**：`CourseListScreen` / `CourseFormScreen` / `CourseDetailScreen` / `ScheduleFormScreen` 完整；**2026-10-11 多天课表轮**：课表表单改为星期**可多选 / 全选七天**，每天各自填开始 / 结束时间与地点，保存前逐天校验并自动切到出错的天；多天一次 `applyScheduleBatch()` **单事务**写入，任何一步失败整批回滚；同一天已有别的记录时显式报错而不覆盖；「开始 / 结束节次」输入已从界面移除但字段与旧数据保留（编辑时原样写回）。`removeCourse` 默认抛 `CourseInUseError`，确认后**任务保留并解除关联**、课表级联删除；`describeReferences` 给 UI 展示真实引用计数 | ⚠️ 代码完成，**真机未验收** |
| K | 手机提醒 / 通知 | **未实现**（无推送、无本地通知） | **未实现**。未引入 `expo-notifications`（需要权限流程与真机验证，留到里程碑 2） | ⛔ 原生待做 |
| L | 冲突检测 | **未实现** | **未实现**，本里程碑明确排除 | ⛔ 双侧都无 |
| M | 原始通知留存 | 已实现：`task_sources` 存原文 + 原图附件 | **已实现（代码）**：`task_sources` 表 + `addSource` / `appendOriginalText` / `getOriginalSource` / `listAllOriginalSources`；表单可粘贴留档，**已有原文时字段只读**（避免覆盖），详情页可**追加**新原文。原文与任务在**同一事务**写入，任一步失败整体回滚 | ⚠️ 代码完成，**真机未验收** |
| N | 相对时间（时间助手） | 已实现「显式采用才写入」的确定性规则助手（`docs/v1.2-time-assistant.md`） | **未实现**。`domain/datetime.ts` 已提供同一套北京时间墙上时间工具与严格校验（可复用为基础设施），但没有短语解析器与助手 UI | ⛔ 原生待做 |
| O | 批量截图导入 | 已实现：一次最多 8 张 → 本地 OCR → 候选 → 勾选保存 | **未实现**，依赖 A | ⛔ 原生待做 |

## 2. 本里程碑额外交付（原 10 项之外，属于「真的能用」的地基）

| 能力 | 说明 |
| --- | --- |
| 任务 CRUD | 新建 / 编辑 / 完成 / 取消 / 删除（二次确认），含类型、优先级、预计用时、提交要求与方式 |
| 严格时间输入 | 显式北京时间；真实日历校验（`2026-02-30`、`2027-02-29`、`25:00` 全拒绝）；**空白即未设置，不猜时间**；只填日期会提示补时刻 |
| 教学周规则 | 学期第一周周一（必须是周一）、起止教学周 1–53、ALL/ODD/EVEN **相对学期首周**的奇偶；课表查询遵循范围、单双周与学期边界 |
| 多天课表（本轮） | 星期多选 / 全选七天；每天独立的开始结束时间与地点；切换编辑的天不丢草稿；至少保留一天；保存前逐天校验并自动跳到出错的天；多天**单事务**写入（失败整批回滚）；同一天已有记录不覆盖；旧「节次」字段随草稿保留 |
| 本地持久化 | `expo-sqlite`、schema 版本 `user_version` + 单事务迁移、外键开启、全部参数化绑定 |
| 删除保护 | 删除课程必须显式确认，且**永不静默删除任务**；删除课表不影响课程与任务 |
| 安全写入 | 任务与原文同事务；提交后读回失败**不谎报保存失败**（`SaveOutcome.committed`） |
| 文案与可访问性 | 中文象牙白 / 森林绿 / 陶土橙；安全区、≥44pt 触控目标、`accessibilityLabel`、键盘避让、加载 / 空 / 错误态 |

## 3. Codex 独立复核发现的问题与修复（本轮）

| # | 复核发现 | 修复 | 回归证据 |
| --- | --- | --- | --- |
| 1 | 表单后台刷新会覆盖用户未保存的输入 | 按目标 id 只 hydrate 一次 | `TaskFormScreen` / `CourseFormScreen` / `ScheduleFormScreen` |
| 2 | 快捷填充静默补 `18:00`；输入校验与保存校验口径不一致 | 只填日期 + 提示补时刻；保存先补零，两口径由一致性测试锁定 | `tests/wallClockInput.test.mjs` |
| 3 | 界面泄漏原始 ISO / 数据库术语 | 改为「保存在这台手机上」+ 格式化时间 | 各屏文案 |
| 4 | 刷新失败被当成保存失败 | `refreshError` 独立状态 + `RefreshErrorBanner`；写入与刷新串行 | `store/AppStore.tsx` |
| 5 | 启动脚本未落地 | `scripts/start-mobile.ps1`（**默认 localhost、`-Lan` 显式、`-Lan`/`-Localhost` 互斥、端口 1..65535、透传 CLI 退出码**；不覆盖 Expo 家目录以复用已有登录；无隧道、无守护进程） | 脚本（退出码与参数守卫已实测） |
| 6 | pnpm isolated 链接导致 Expo CLI 找不到 `@expo/cli` | `nodeLinker: hoisted` + 重装；**本轮再补 `packageImportMethod: copy`**，解决 hoisted 下 `*_tmp_*` 改名 `ERR_PNPM_ENOENT` | 安装 exit 0（`.supervision/ios-20261011-install.log`）；`node_modules` 309 项、0 个残留临时目录 |
| 7 | `update` 用「原文 ≠ 说明」判断是否保存原文，导致原文被静默丢弃；已有原文时忽略输入不报错；读回失败被当成保存失败 | 改为只看是否已有留存原文；已有原文时只读 + 明确报错；新增追加原文；`SaveOutcome.committed` | `tests/repository.test.mjs` 原文回归用例 |

## 4. 证据路径

| 内容 | 路径 |
| --- | --- |
| 原生工程 | `mobile/` |
| 纯领域逻辑（日历 / 教学周 / 时区 / 校验 / 输入口径） | `mobile/src/domain/` |
| SQLite schema 与迁移 | `mobile/src/db/schema.ts`、`mobile/src/db/migrations.ts` |
| 仓库层 | `mobile/src/domain/taskRepository.ts`、`mobile/src/domain/courseRepository.ts`（含多天批量 `applyScheduleBatch`） |
| 多天课表纯逻辑（本轮新增） | `mobile/src/domain/scheduleMultidayDraft.ts` |
| 应用状态（引导 / 串行写入 / 刷新错误分离） | `mobile/src/store/AppStore.tsx` |
| 测试（真实内存 SQLite） | `mobile/tests/`、`mobile/tests/helpers/sqliteHarness.mjs`（含写入失败注入） |
| 多天课表测试与证据（本轮） | `mobile/tests/scheduleMultidayDraft.test.mjs`、`mobile/tests/scheduleBatch.test.mjs`；`.supervision/ios-timetable-revision-{tests,tsc}.log`、`ios-timetable-revision-handoff.md` |
| 启动脚本 | `scripts/start-mobile.ps1` |
| 本机使用说明与限制 | `mobile/README.md` |
| 路线图与真机步骤 | `docs/ios-roadmap.md` |
| Codex 独立 SQLite 探测（历史：5 PASS / 1 FAIL，缺陷已修） | `.supervision/ios-review-loader.cjs` |
| 探测完整日志 | `.supervision/ios-sqlite-review.log` |
| 复核跟进清单（本轮输入） | `.supervision/ios-review-followup.md` |
| 原始任务书 | `.supervision/ios-assignment.md` |
| Web 端时间助手（N 的 Web 实现，可作为原生 N 的语义参考） | `docs/v1.2-time-assistant.md` |
| Web 端界面设计令牌（原生主题同源） | `docs/ui-design.md` |

## 5. 未完成 / 不声称

| 项 | 状态 |
| --- | --- |
| **用户手机冒烟测试（Expo Go 首页 + 底部标签栏）** | ✅ **PASS（用户自报，2026-10-11）**：用户明确确认 iPhone 上能显示首页与底部标签栏。**仅此一项**；完整 UI 流程与真机 SQLite 写盘**仍未验证**，待测：带原文的任务、单周课表课程、日历/当天/详情跳转、关掉重开确认持久化 |
| iOS JS bundle（含 Hermes 字节码） | ✅ **PASS（需提权）**：Codex 在**已批准的 elevated shell** + 工作区 `TEMP`/`TMP`（`.tools/expo-tmp`）下完整导出成功，`mobile/dist-ios` 内有 **2.2MB `.hbc`**（`.supervision/ios-20261011-export-supervisor.log`）。**这是 JS 字节码，不是 IPA**；**不保证不开提权也能通过** |
| 独立真实 SQLite 探测（Codex） | ✅ **8/8 PASS**（`.supervision/ios-20261011-sqlite-review.log`） |
| Codex 侧 `-Lan` Metro + 局域网可达性 | ✅ `scripts/start-mobile.ps1 -Lan`（8081，保留用户登录态）；LAN `192.168.31.73`；iOS manifest + bundle **HTTP 200**（4,921,027 bytes）（`.supervision/ios-20261011-lan-check.json`）；**2026-10-11 08:49（Asia/Shanghai）仍在运行：pid 298524、端口 8081** |
| 本轮依赖安装 / 测试 / 类型检查 | ✅ 安装 exit 0（28.5s）；测试 **99/99**（15+19+15+13+37，Codex 独立复跑 PASS）；`tsc --noEmit` **0 error**（Codex 独立复跑 0 error）；`expo install --check` **Dependencies are up to date**；日志 `.supervision/ios-20261011-*.log` |
| **多天课表轮（2026-10-11，需求 1 + 3）** | ✅ 代码完成：星期多选 / 全选、每天独立时间地点、逐天校验与自动定位、单事务批量写入、不覆盖既有天、旧节次字段保留。测试 **123/123 PASS**（99 + 24 项新增，`.supervision/ios-timetable-revision-tests.log`）；`tsc --noEmit` **exit 0**（`.supervision/ios-timetable-revision-tsc.log`）；`expo export --platform ios --no-bytecode` **exit 0**（907 modules，一次性目录 `.tools/expo-multiday-check`）。**真机未验收，Metro（pid 298524 / 8081）全程未重启** |
| **需求 2 照片识别课表导入 / 需求 4 移除学期首周一输入** | ⛔ **本轮明确未实现**：没有引入任何 OCR 依赖、没有加服务端、没有为教学周猜默认基准。两条都等 Codex 追问有结论后再动（见 `../docs/ios-roadmap.md` §7.2） |
| A / O 原生 OCR、C / E / L AI 能力、K 通知提醒、N 相对时间助手 | ⛔ 未实现，不声称 |
| 独立签名安装包 / 离线冷启动 | ⛔ 需要 macOS + Xcode 或付费账号，本轮不授权 |
