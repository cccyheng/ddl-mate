# DDL Mate V1 验证记录

> 工作区：`C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl`
> 最新验收日期：**2026-10-10（Asia/Shanghai）**。
>
> **分工说明（各轮不同，请勿混用）**
> - **当前轮 = V1.2 时间助手（§0.5）**：实现 = **DeepSeek Harness**；独立审查、构建、隔离验收与本机更新 = **Codex**。
> - 上一轮 = 整站 UI 重做 + 本机部署（§0.4，历史时间线）：实现 = **DeepSeek Harness**；独立监督、部署与验收 = **Codex**。
>   用户授权原文：「允许启动8080，帮我设计一个好看的ui」。
> - 更早一轮 = 通知截图 / 文字 → 待办（V1.1 本地版，§0.3，历史时间线）：实现 = **DeepSeek Harness**，独立监督与验收 = **Codex**。
> - 早期 V1 一轮曾有「初始实现 DeepSeek Harness；连接连续失败后用户明确授权 Codex 接手**该轮**修复与验收」的安排，
>   那只适用于**当时那一轮**，**不是本轮**。其余历史轮次的分工与范围见各节原文。

## 0.5 V1.2 时间助手（2026-10-10 实现 · 隔离验收通过 · 已更新 8080）

**结论：V1.2 时间助手已完成实现、构建、隔离环境独立验收，并已更新本机 8080。**
实现 = **DeepSeek Harness**；独立审查、构建、验收与部署 = **Codex**。

### 交付与部署（Codex 执行）

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 发布包 | `.supervision/releases/v12-20261010/ddl-mate.jar`，SHA256 `D73BB1C9748F4F2BB9646DC6CCBF7721EB9EB65A486A93CE536A12E13719EF13` | `.supervision/v12-live-deploy.json` |
| 运行 | ✅ `http://127.0.0.1:8080`（PID 262344） | 同上 |
| 部署前备份 | `.supervision/backups/before-v12-20261010-171552` | 同上 |
| 原库数据完整性 | ✅ 3 课程 / 6 课表 / 3 任务 / 1 原通知，所有业务记录**逐条一致** | `.supervision/v12-live-data-verification.json` |
| 构建 | ✅ 成功（`.supervision/v12-build.log`）。实现阶段本机沙箱的 esbuild `spawn EPERM` 已由 Codex 提权正常构建解决，**不是当前构建失败** | `.supervision/v12-build.log` |

### 测试与验收（本机 / 隔离环境真实执行）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 后端完整测试 | ✅ **156 项通过**（原 124 + 新增解析 14 + 接口 18）。为 2026-10-10 早前结果；此后只改前端助手 UI，**后端未再改动** | `.supervision/v12-backend-full-tests.log`、`v12-resume-harness-20261010.jsonl` |
| 前端完整测试 | ✅ **11 个文件 159 项通过**（时间助手 20 项 + 既有 139 项） | `.supervision/v12-frontend-final-tests.json` |
| 助手三时区（早前） | ✅ 早前 17 项在 `TZ=UTC / Asia/Shanghai / America/New_York` 下均通过；**最终 20 项只补跑了 UTC**，不声称最终 20 项三时区全重跑 | 命令见 README §3.2 |
| 独立 HTTP | ✅ **48 项通过** | `.supervision/v12-http-review.json` |
| 助手真实 Chrome | ✅ **16 项通过**：390 / 768 / 1440 三档屏宽；UTC 与上海环境下新建 / 编辑的精确时间；真实单双周课表 + 手动采用；改短语 / 参考时间 / 课程 / 原 DDL / 关闭面板都能让迟到响应失效；网络失败重试；通知候选采用 + 保存冻结 + 原文读回 | `.supervision/v12-browser-review.json` |
| 助手生命周期边界 | ✅ **3 项通过**：离开页面、删除候选、全程无写入与无页面错误 | `.supervision/v12-browser-lifecycle.json` |
| 旧入口回归（新版隔离 8081） | ✅ 原通知 **11 项**、通知边界 **4 项**、课表 / 日历 **10 项**全部通过。**这与上面的助手 16 + 3 是两组独立数字，不合并计数** | `notice-browser-flow.json`、`notice-browser-edge.json`、`schedule-browser-flow.json` 及对应 `.log` |
| 只读视觉 | ✅ 12 路由 × 390 / 768 / 1440 = **36 个组合**全过，无溢出 / 页面错误 / HTTP 错误 / 外部请求；助手 390 与 1440 截图布局正常 | `.supervision/v12-final-visual.json` |
| 隔离 8081 | ℹ️ 用于本轮隔离验收，验收结束后关闭；8080 保持运行 | 具体清理结果以 Codex 后续文件为准，此处不臆测 |

### 本轮范围与仍未实现（不夸大）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| V1.2 能力 | ✅ 已交付 | 只读 `POST /api/tasks/resolve-time`（本地确定性规则 + 真实课表匹配）+ 任务表单 / 通知候选里的可折叠时间助手（**显式采用才写入**）；短语清单与保守边界见 [`v1.2-time-assistant.md`](v1.2-time-assistant.md) |
| 规则解析 ≠ LLM | ⚠️ 必须区分 | 时间助手是**本地确定性规则**，**不等同**大模型语义抽取；整段通知的语义理解仍未实现 |
| 不支持的时间说法 | ⛔ 明确拒绝 | 校历 / 调休（国庆、寒假、考试周）、不明确短语（只有日期、今晚、尽快、周末、范围）、课程类型限定（如「下次实验课前」） |
| 提醒 / 规划 / LLM | ⛔ 未实现 | 任务拆分、DDL 冲突检测、每日计划、手机提醒、LLM 抽取仍属 V2 / V1.1 剩余 |
| MySQL profile | ⛔ 配置已提供、仍未实测 | 本机无 MySQL/Docker，未连接过真实实例；H2 file profile 覆盖同一套后端逻辑 |

---

## 0.4 UI 界面重做（2026-10-09 实现 · 已本机部署并完成最终独立验收）

**结论：整站 UI 视觉升级已完成实现、本机部署与最终独立验收。**
实现 = **DeepSeek Harness**；独立监督、部署与验收 = **Codex**。
用户明确授权原文：「允许启动8080，帮我设计一个好看的ui」。

> ⚠️ 本节取代 §0.3 里「本机更新未执行 / 8080 当前未运行」的**当时状态**；§0.3、§0.2、§0.1、§0
> 保留为各自轮次的历史时间线，其测试与结论仍然有效。
> **当前 8080 的版本与数据状态以 §0.5（V1.2）为准**；本节记录的是 2026-10-09 UI 版当时的状态。

### 部署（Codex 执行）

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 部署状态 | ✅ `DEPLOYED_AND_VERIFIED`（启动 2026-10-09T16:39:54+08:00，复核 2026-10-09T21:15:48+08:00） | `.supervision/ui-live-deploy.json` |
| 运行地址 | ✅ `http://127.0.0.1:8080`（进程 PID 291104） | 同上 |
| 发布包 | `.supervision/releases/ui-20261009/ddl-mate.jar`，SHA256 `9FECC5161E95F4B5C1A1BE9B17FF956D69F2A0257FB4C5C2C617D00DF6204319` | 同上 |
| 部署前备份 | `.supervision/backups/before-ui-20261009-163954` | 同上 |
| 用户授权 | 「允许启动8080，帮我设计一个好看的ui」 | 同上 |

### 真实验收（8080 原文件库，只读）

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 原库数据完整性 | ✅ 3 课程 / 5 课表 / 3 任务 / 1 原通知，`allRecordsUnchanged: true`（与更新前逐条一致） | `.supervision/ui-live-data-verification.json` |
| 真实页面 | ✅ 5 个页面 HTTP 200 + 可见标题；390px 无横向溢出；0 页面异常、0 外网请求、0 写操作；浏览器前后原数据 deepEqual | `.supervision/notice-live-verification.json` |
| 真实截图 | ✅ 原库首页 1440 / 390 两档尺寸截图，`errors/httpErrors/external/writes` 全空 | `.supervision/ui-live-visual.json`、`ui-live-home-1440.png`、`ui-live-home-390.png` |

### 隔离 QA（8081，最终 UI 包上的复跑）

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 页面尺寸检查 | ✅ 12 条路由 × 1440 / 768 / 390 = **36 个页面 / 宽度**全部 PASS，无横向溢出、无控制台异常、无外链、无写操作 | `.supervision/ui-final-visual.json` |
| 交互验收 | ✅ **7 项 PASS**：子路由高亮、关键词筛选与清空、高级筛选收起态与清空、手机导航 6 个入口可达、键盘 skip 链接、三档宽度任务正文可读、1280px 顶栏右边距 | `.supervision/ui-interaction-results.json` |
| 通知导入回归 | ✅ **11 项 PASS**（8 张合成图串行 OCR → 候选 → 保存 → 原图逐字节比对 → 390px） | `.supervision/notice-browser-flow.json` |
| 通知边界回归 | ✅ **4 项 PASS** | `.supervision/notice-browser-edge.json` |
| 课表 / 日历回归 | ✅ **10 项 PASS**（单双周过滤、月历当天课程与 DDL、跨月路由、非法日期与坏图提示） | `.supervision/schedule-browser-flow.json` |
| 前端测试 | ✅ **10 个文件 139 项全部 PASS**（每个文件 exit 0、fail 0）；布局收尾修复后复跑仍 139 项 PASS | `.supervision/ui-frontend-tests.json` |
| 构建 | ✅ 最后一次实际构建成功：`2026-10-09T16:35:22+08:00`（前端构建 + 打包） | `.supervision/ui-build.log` |

### 本轮范围与限制（不夸大）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 本轮改动范围 | ✅ 仅前端 | 界面重做只动 `frontend/src/**`（外壳、样式令牌、视图/组件布局与文案）与文档；**后端 Java 源码本机自 2026-10-08 15:19 起未改动**，数据库结构、API、OCR/解析算法、时区规则、路由路径与依赖版本均未变 |
| 后端测试 124 项 | ⚠️ 历史结果 | 为 2026-10-08 的结果；**后端本轮未改，因此没有重跑后端全套**，不代表本轮新跑过 |
| 数据只读 | ✅ | 真实验收只做 GET / 只读核对，未在原库写入任何测试数据；部署前已备份 |
| 隔离 8081 的 QA 服务 | ℹ️ **已关闭** | UI 验收结束后由 Codex 关闭该内存 QA 服务：`.supervision/ui-qa-cleanup.json`（`status: STOPPED`，PID 295064，`stoppedAt 2026-10-09T21:23:14+08:00`，原因「UI acceptance complete; original-data application remains on 8080」）。**当前只有 8080 在运行** |
| MySQL profile | ⛔ **配置已提供、尚待实测** | 不是「未实现功能」：`db/mysql/schema.sql` 与 `application-mysql.yml`（`ddl-auto=validate`）已写好，本机无 MySQL/Docker，未连接过真实实例；H2 file profile 已实测并覆盖同一套后端逻辑 |
| LLM / 提醒 / 自然语言日期 | ⛔ 未实现 | 本轮是**界面重做**，未实现也未声称：LLM 语义抽取（V1.1 剩余）、自然语言相对日期解析（V1.2）、任务拆分 / 冲突检测 / 每日计划 / 手机提醒（V2）、登录鉴权（MySQL profile 属「配置已提供、尚待实测」，见本表上一行） |

---

## 0.3 通知截图 / 文字 → 待办（V1.1 本地版，2026-10-08 实现 · **2026-10-09 终验通过**）

> ℹ️ **历史时间线**：本节记录当时的验收与状态。其中「本机更新未执行 / 8080 当前未运行」是
> **2026-10-09 早些时候的状态**；当日晚些时候的 UI 重做部署见 §0.4，**当前状态以 §0.4 为准**。

**结论：验收通过。** 实现 = DeepSeek Harness；独立监督与验收 = Codex。
**（历史状态）本轮当时未执行本机更新**：原 8080 当时未运行；授权询问已发出、暂无回答，获批后才可用最新 jar 连接原文件库。
→ 该授权与部署已在**当日晚些时候的 UI 重做轮次完成**，见 §0.4；**当前 8080 状态以 §0.4 为准**。

### 最终验收结果（2026-10-09）

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 后端测试 | ✅ **124 通过 / 0 失败 / 0 错误**。后端 Java 源码自 2026-10-08 15:19 起未再改动，**2026-10-09 未重跑**，沿用已按 Surefire XML 核对的结果（2026-10-09 的改动只是前端构建产物复制进 `static`） | `backend/target/surefire-reports` |
| 前端测试 | ✅ **10 个测试文件 139 项全通过**（每个文件 exit 0、fail 0）：日历 3、导入约束 8、通知守卫 11、通知请求体 36、通知解析 25、浏览器 OCR fixture 3、真实 OCR 9、图片生命周期 9、课表解析 13、周视图布局 22 | `.supervision/notice-frontend-test-results.json` |
| Codex 解析复核 | ✅ **10 项 PASS**（`failures` 为空，exit 0） | `.supervision/notice-parser-review.mjs`、`notice-parser-review.json` |
| 构建与打包 | ✅ `BUILD SUCCESS`（2026-10-09T13:14:56+08:00）；jar SHA256 `153FBDB3FC163703A8B2562F4CFB765DA4D689EFCB96DEE23473E569744DDEEF`（已与磁盘文件复核一致） | `.supervision/notice-final-build.log`、`notice-final-jar-hash.json` |
| 真实浏览器：通知导入 | ✅ **11 项 PASS**（`errors: []`、`external: []`）：真实 8 张现版合成 PNG 串行 OCR → **11 条候选**；选中保存；原图下载**逐字节**比对一致；任务详情与日历当天可见；UTC 浏览器下按**上海时间**保存；取消后换源无迟到回写；390px 无横向溢出 | `.supervision/notice-browser-flow.json`、`notice-browser-ocr-raw.json`、`notice-browser-ocr-sources.json`、`notice-mobile.png` |
| 真实浏览器：通知边界 | ✅ **4 项 PASS**：坏图可移除并只存文字；在途保存冻结字段与来源且只发一次请求；网络结果未知保留草稿、新标签页核对、不自动重试；删除 OCR 来源后不产生孤立候选 | `.supervision/notice-browser-edge.json` |
| 真实浏览器：课表回归 | ✅ **10 项 PASS**：单双周过滤、月历当天课程与 DDL、跨月路由、非法日期与坏图提示等既有流程未回归 | `.supervision/schedule-browser-flow.json` |
| 通知 HTTP（**通知功能验收阶段结果**） | ✅ **13 项 + 边界 3 项**，在**通知阶段验收包** jar SHA256 `153FBDB3FC163703A8B2562F4CFB765DA4D689EFCB96DEE23473E569744DDEEF` 上全部 PASS；**UI 阶段后端未改、未在 UI 包上重跑这 16 项**（UI 包上只重跑了浏览器 11 + 4 + 10 项） | `.supervision/notice-import-http-result.json`、`notice-http-boundaries.json` |
| 测试环境 | 最新 jar 运行在**隔离 8081**（dev profile + `jdbc:h2:mem:noticeqa` 内存库）；**（历史状态）该预览服务在通知验收当时仍在运行**（当时只读检查确认 8081 上 `GET /tasks/import-notices` 返回 200、PID 282136 仍在），内存数据不持久化，不进入原文件库；**该 QA 服务已在 UI 验收结束后由 Codex 关闭**（`.supervision/ui-qa-cleanup.json`，PID 295064，`stoppedAt 2026-10-09T21:23:14+08:00`），当前只有 8080 在运行 | `.supervision/notice-qa-server.log`、`ui-qa-cleanup.json` |
| 测试 fixture | 已固化为 `frontend/tests/fixtures/notice-browser-ocr.json`（与 `.supervision/notice-browser-ocr-raw.json` 内容一致），**测试不依赖实时证据覆盖文件** | 同上两个文件 |
| 合成样图 | `frontend/scripts/make-notice-samples.mjs` 成功生成 8 张 PNG（`frontend/public/samples/notices/`，页面标明示例）；样图生成已不再是环境阻碍 | 8 个 `notice-0*.png` |

### 本轮修正的两个业务缺陷（含在 124 项测试内）

1. **判重误报**：旧实现只用「标题 + 截止时间」判重，会把不同课程或不同原通知里的同名同时间作业错误判成 409。
   现改为语义签名 —— 标题 / 说明 / 课程 / 类型 / 状态（规范化默认值）/ 截止时间（按时刻）/
   提交要求 / 提交方式 / 来源集合（与书写顺序无关）**全部相同**才拒绝。
   **该判重只在一次请求内有效，不是跨请求幂等**，也没有数据库唯一约束。
2. **副本容量上限**：新增 **100 MiB** 实际写盘副本总量上限（按每个 `(任务, 来源)` 绑定引用的文件大小求和），
   超过时在**落盘与写库之前**整体 400 并提示分批导入，磁盘与数据库均零副作用。
   既有 5 MiB 单张 / 20 MiB 请求 / 8 张图 / 30 条候选 / 12 个来源上限不变。

两项修正各有独立的非空断言反证：把判重还原成「仅标题 + 截止」后，新用例由 201 变 409；
禁用容量判断后，新用例由 400 变 201。两次临时改动均已还原并核对文件 SHA256 一致。

### 边界与限制（未写成通过）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 合成样图 ≠ 任意截图 | ⚠️ 已知 | 只证明这 8 张合成图；**样图 04 的邮箱仍有 OCR 错字**，需人工校对；真实截图的字体、光照、裁剪、群聊气泡均未验证 |
| 相对 / 模糊日期 | ⚠️ 按设计留空 | 无年份、月日无年、明天 / 下周五 / 下节课前一律保留原话并提示核对，不猜今天日期或 23:59；自然语言相对日期解析属 V1.2 |
| 判重范围 | ⚠️ 已知 | 仅请求内去重，无跨请求幂等、无唯一约束；防重复点击依赖前端 |
| 100 MiB 边界 | ⚠️ 已知 | 判断为严格大于，恰好等于上限时放行；该边界未用 100 MiB 真实写盘验证 |
| 原文件库 | ⛔ 未改动 | 今日只读核对：`backend/data/ddlmate-dev.mv.db` 的 SHA256 仍为 `177F3818B78E95F78B409BBE5CA452A7136E60664D3DAB06538CBECA3384B770`，与 `.supervision/backups/before-notice-import-20261008/` 备份相同；**未连接原库写入业务数据，仅只读核验文件哈希** |
| 本机更新 | ⛔ 当时未执行（历史） | §0.3 验收当时 8080 未运行、授权询问未答复；**该授权与部署已在同日 UI 重做轮次完成，见 §0.4** |
| LLM 语义抽取 / 推送 / 登录 | ⛔ 未实现 | V1.1 剩余部分与 V2 |

---

## 0.2 真实用户课表照片优化（2026-10-08）

**该轮记录：当时已完成本机更新和真实浏览器验收，仍保留两处文字识别误差供人工核对。
（历史状态）§0.2 与 §0.3 写作时本机 8080 未运行、尚未按最新代码更新；
当前状态是 **8080 已按用户授权运行 UI 新版**，见 §0.4。**
测试图为用户提供的 1279×2781 深色手机周视图，标题第 7 周，21 个课程块、15 门课，
周一至周日分布为 5/4/2/4/4/0/2。图片没有年份、学期第一周日期和整学期重复规律。
微信临时 JPEG 在续接任务时已失效；本轮从此前保留的原始 RGBA 无损写成 PNG，目视确认与原附件一致。
测试读取 `.tools/photo/retained-original.png`，未把私图加入产品资产、示例或识别词典。

| 检查项 | 实际结果 | 本地证据 |
| --- | --- | --- |
| 优化前浏览器 | 仅 6 条，按星期错误拼接多门课，时间为空 | `.supervision/user-photo-browser-baseline.json` |
| 最新版真实 Chrome OCR | 21/21 块；星期、节次、开始/结束时间 21/21；课程名严格匹配 20/21，地点 20/21 | `.supervision/user-photo-browser-final.json`、`user-photo-assessment-final.log` |
| 严格匹配口径 | 统一全半角、空格和连接符，保留括号差异；离线脚本会忽略括号，其名称 21/21 不能代替浏览器的严格 20/21 | `.supervision/assess-user-photo.cjs` |
| 剩余误差 | 周三 3–4 节「大学物理(B-2)」漏括号；周日 3–4 节「百川楼」误读为「百咱楼」。两条均有核对提醒和原文 | 同上浏览器 JSON |
| 周视图导入约束 | 未填学期起点、非周一、清空周次或未确认时阻止提交；修改周次/单双周、框选、换图、重新识别后重新确认 | `.supervision/user-photo-flow.json` |
| 原图完整交互 | 10 项通过：上述约束、框选追加/替换、原候选保护、手机布局、隔离库导入、日期过滤、日历详情、识别中取消后换图 | `.supervision/user-photo-flow.json` |
| 原图实际导入 | **人工核对并改正文字**后导入隔离内存库：15 门课程、21 条课表；第 7 周各日 5/4/2/4/4/0/2，第 6/8 周无测试课程；同名周日课程保留两条 | 同上；测试用学期起点为 2026-08-31，由测试明确填写，不是从截图推测 |
| 既有功能回归 | 旧表格识别、单双周修改、课程/DDL 日历详情等 10 项；取消、框选、候选唯一编号、手机布局 4 项全部通过 | `.supervision/schedule-browser-flow.json`、`schedule-browser-edge.json` |
| 手机真实照片结果 | 390px 页面无横向溢出，表格内部可左右滑动；最大行高约 188px；长图预览限制显示高度，OCR 仍使用完整像素 | `.supervision/user-photo-mobile.png`、`user-photo-flow.json` |
| 前端测试 | 55 项通过：解析器 13、月历 3、图片生命周期 9、周视图布局 22、导入约束等 8 | `.supervision/user-photo-tests.log` |
| 打包 | 前端构建与 Maven 打包成功；打包使用 skipTests，不计作后端测试 | `.supervision/user-photo-build.log` |
| 原文件库升级 | 启动前已备份并比对 SHA256；最新版运行于 8080；原 3 门课程/5 条课表/3 个任务与上次完整 API 快照严格相等 | `.supervision/backups/before-photo-optimization/manifest.json`、`user-photo-live-data.json` |
| 原库只读浏览器检查 | 原图 21 条，旧列表/表格各 3 条，4 个路由和 390px 布局正常，页面错误/外站请求/HTTP 错误均为 0 | `.supervision/schedule-browser-probe.json`、`user-photo-browser-final.json` |

实现变化：自动识别卡片颜色和几何结构；用表头星期与日期校验列位置，按左侧时间栏映射节次；
卡片内部裁剪去边框，灰度拉伸保留细笔画，少量重试并提示读法分歧。课程名和地点分别清理，避免一侧括号影响另一侧。
候选保存周视图来源，框选或清空周次不能绕过导入约束；候选使用页面内递增编号，避免框选追加后选错替换目标。

所有识别在浏览器本地运行。写入测试只在独立 8081 内存库执行，临时课程已清理，测试服务已关闭。
真实文件库只读核验，没有自动导入这张照片。后端源码本轮未修改，108 项后端测试与 18 项 HTTP 验收为上一轮历史结果。
本轮结果仅证明这张实图和已有样图的表现，不保证任意截图 100% 准确；MySQL 仍未实测。

---

## 0.1 追加轮次：课表照片 OCR + 单双周 + 日期详情（2026-10-06 实现 · **2026-10-07 验收通过**）

本轮在已验收的 V1 之上追加三项功能。**结论：验收通过**（唯一遗留项仍是 MySQL 未实测）。
以下均为 Codex 在最新版本上实际执行的结果，证据文件可逐一核对。

### 后端（本轮后未再改动）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 后端全量测试（既有 69 + 新增 39） | ✅ **108 通过 / 0 失败 / 0 错误** | `.tools/test-run-18.log`、`backend/target/surefire-reports` |
| 新增：教学周/单双周规则单元测试 | ✅ 10 项 | `ScheduleRulesTest` |
| 新增：接口层单双周过滤与校验边界 | ✅ 8 项 | `ScheduleWeekPatternIT` |
| 新增：批量导入事务/去重/冲突/未引用课程/null 元素 | ✅ 17 项 | `ScheduleImportIT` |
| 新增：月历课程+DDL、按日查询、非法月份 | ✅ 4 项 | `ScheduleCalendarIT` |
| 既有 69 项（V1 验收用例） | ✅ 全部保持通过（无回归） | `.tools/test-run-18.log` |
| 源码实测类数 | 8 个集成测试类（91 项）+ 2 个单元测试类（17 项）= **108 项**（另有 2 个不含用例的支撑类 `BaseIntegrationTest` / `ApiTestSupport`） | `backend/src/test/java` 统计 |

### 前端测试（25 项，实测命令见 README §3.2）

| 检查项 | 结果 | 命令 |
| --- | --- | --- |
| 课表解析器（含 2 项真实 OCR 输出快照回归） | ✅ 13 通过 / 0 失败 | `node tests\timetableParser.test.mjs` |
| 月历"有安排天数"统计（空月必须为 0） | ✅ 3 通过 / 0 失败 | `node tests\calendarStats.test.mjs` |
| 图片生命周期（canvas 化 / 临时 URL 释放顺序 / drawImage 参数） | ✅ 9 通过 / 0 失败 | `node tests\ocrImageLifecycle.test.mjs` |
| **合计** | ✅ **25 通过 / 0 失败** | 三个文件逐个执行（刻意不用目录形式） |

### 构建与打包

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 前端生产构建（OCR 资源就绪 + vite） | ✅ `79 modules transformed`，构建成功 | `.supervision/schedule-build-final.log` |
| 演示包（前端产物复制进后端 static + Maven 打包） | ✅ BUILD SUCCESS；`backend/target/ddl-mate-backend-1.0.0-SNAPSHOT.jar` 约 74.9 MB（71.4 MiB） | `.supervision/schedule-build-final.log`；jar 文件实测 |
| 打包与测试的关系 | 说明：`build-all.ps1` 使用 `-DskipTests`，**打包成功不等于测试通过**；测试结论以上表 `108 项` 独立运行为准 | `scripts/build-all.ps1` |

### 独立 HTTP 检查（18 项）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 单双周持久化与学期前后/期间过滤、月历同规则、11 项校验边界（缺学期起点、非周一、周次倒置/0/54、非法单双周、非法星期/时间）、旧数据每周仍可读、批量边界与回滚、单周+双周同时间可共存 | ✅ **18/18 PASS** | `.supervision/schedule-http-result.json` |

### 真实 Chrome 端到端（10 项 + 边界 3 项）

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 真实识别把表格三门课分开且保留时间/单双周；识别后不勾选不写库；编辑并确认导入三条（含成功提示）；月历只统计有内容的日期；点日期看到课程与 DDL（含提交方式/要求）；刷新；跨月日期路由稳定；单双周过滤；UI 把单周改成双周后真实日期显示随之改变；非法日期与坏图均有可读提示 | ✅ **10/10 PASS**（`errors: []`、`external: []`，无 pageerror、无外站请求） | `.supervision/schedule-browser-flow.json`、截图 `schedule-import-success.png`、`calendar-day-desktop.png` |
| 边界：worker 初始化期间取消再识别新图无陈旧覆盖；框选识别追加且保留原有候选；候选表在 390px 移动布局无溢出 | ✅ **3/3 PASS**（`errors: []`，视口 390 无溢出） | `.supervision/schedule-browser-edge.json`、`schedule-import-mobile.png` |
| 测试数据隔离 | 只写入 `QA` 前缀数据，已在隔离内存库中清理；未污染用户文件库 | 同上两个 JSON 的检查项 |

### 最新版在真实用户数据上的运行验证

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 隔离 8081 已关闭，最新版运行在 `http://127.0.0.1:8080`（dev profile，原 `backend/data/ddlmate-dev` 文件库） | ✅ 启动成功，跳过已有种子数据 | `.supervision/schedule-live-server.log` |
| 数据未被清空/重建 | ✅ 启动前备份：`.supervision/backups/before-schedule-upgrade/data/`，SHA256 清单同目录 `manifest.json` | 备份目录 + `manifest.json` |
| 现有数据规模 | ✅ 3 门课程 / 5 条课表 / 3 个任务 | `.supervision/schedule-live-data.json` |
| 原数据上再次真实识别（list / grid 各 3 条）+ 4 个页面桌面与 390px 布局 | ✅ 通过；`errors: []`、`external: []`、`responses: []` | `.supervision/schedule-browser-probe.json`、截图 `schedule-import-grid.png`、`schedule-import-list.png`、`calendar-day-mobile.png` |
| 说明 | ⚠️ 本轮**不是**"重启持久性"专项测试（该项属 V1 首轮验收，见 §0）；本轮只确认原数据在升级后完整可读 | — |

### OCR 链路的关键修复（本轮实际发生）

> **PSM 修复**：Tesseract 默认 PSM 6（统一文本块）会把表格同一行的多列文字合并成一行 —— 实测把
> "高等数学"和"数据结构"并成一门课。改用 **PSM 11（稀疏文本）** 后置信度从 75 升到 91，每个单元格独立成行、
> 表头星期各自带 bbox；解析器同时支持"表头被拆成多行"的版面，表头缺列时按位置 + 星期顺序推断并显式提示。
> 参数集中在 `frontend/src/ocr/ocrConfig.js`，浏览器端 `tesseractClient.js` 与 Node 冒烟脚本
> `scripts/ocr-smoke.mjs` 共用，两条路径行为一致。

> **浏览器图片生命周期修复**（真实 Chrome 暴露、已由本轮浏览器验收确认修好）：
> 1) 临时 blob URL 曾在 `img.onload` 里立即释放，而 Tesseract 收到 `HTMLImageElement` 会再取一次 `src`，
>    导致 `net::ERR_FILE_NOT_FOUND` + `Failed to fetch`（0 候选）→ 现在 `prepareImage` **始终返回 canvas**，
>    临时 URL 在绘制完成之后才释放；
> 2) `toDrawable` 的非 Canvas 分支曾返回 `{ image }` 而调用方解构 `drawable`，
>    导致 `drawImage(undefined)` 抛 "The provided value is not of type 'CanvasImageSource'" → 现已统一返回 `drawable`。
> 两条都被 `tests\ocrImageLifecycle.test.mjs`（9 项，stub 的 `drawImage` 会像浏览器一样拒绝非 CanvasImageSource）覆盖。

### 本轮仍存在的限制（未写成通过）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| MySQL profile | ⛔ 未实测 | 本机无 MySQL；新增 4 列已在 `db/mysql/schema.sql` 给出建表与旧库 `ALTER` 说明 |
| 识别准确率受照片质量限制 | ⚠️ 已知 | 表格样例的 **周三表头未被 OCR 识别**，该列由相邻表头位置 + 星期顺序推断并提示人工确认（`weekdayInferred`）；其他字段不确定时一律留空提示，不臆测 |
| 通知截图 OCR 与大模型抽取 | ⛔ 未实现（后续路线图） | 本轮只交付**课表照片**的本地 OCR；微信群 / QQ 群**通知截图**的识别与 AI 抽取属 V1.1，手机提醒等属 V2 |

### 本轮接口变更

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/schedules?weekday=&date=` | 新增 `date` 过滤（教学周 + 单双周） |
| GET | `/api/schedules/by-date?date=` | 指定日期实际要上的课 |
| GET | `/api/calendar?year=&month=` | 月历：每天的任务 + 课程 |
| POST | `/api/schedules/import` | 批量导入（新建课程 + 课表单事务） |

---

## 0. 结论（V1 首轮验收）

**V1 第一阶段（本机单人版）验收通过。**

后端 69 项测试全部通过；前端构建与演示打包成功；后端真实启动在 `127.0.0.1:8080`；
HTTP 全链路与浏览器 9 条路由、完整用户操作流程均通过，重启后数据仍在。

唯一未验证项：**MySQL profile**（本机无 MySQL 环境），作为已知限制保留在 §4。

---

## 1. 验收环境

| 项 | 值 |
| --- | --- |
| Java / 构建 | Java 21（`C:\Program Files\Java\jdk-21.0.10`）+ Maven（IDEA 自带 `maven3`） |
| 前端工具链 | Node 24 / pnpm 11.19.0 / Vite 6.0.3 / Vue 3.5.13 |
| 后端运行 | `scripts\start-backend.ps1`，dev profile，Tomcat 8080，context path `/` |
| 数据库 | H2 file：`backend\data\ddlmate-dev.mv.db`（Maven 以 `backend/` 为工作目录） |
| 附件目录 | `backend\data\uploads\` |
| 进程 | 首次 pid `293872`，重启后 pid `276664`（**历史**：V1 首轮验收当时仍在运行；当前 8080 为 UI 新版 PID 291104，见 §0.4） |

复现命令（README §3 中同一套脚本，已实际验证可用）：

```powershell
powershell -NoProfile -File scripts\build-all.ps1       # 前端构建 + 复制进后端 static + 打包
powershell -NoProfile -File scripts\start-backend.ps1   # http://127.0.0.1:8080
powershell -NoProfile -File scripts\test-backend.ps1    # 69 项后端测试
```

> `build-all.ps1` 打包时使用 `-DskipTests`：完整的 69 项测试由 `test-backend.ps1` 单独执行，
> 不要理解为 `build-all` 也跑了测试。

---

## 2. 验收结果一览

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 后端测试（69 项） | ✅ 69 通过 / 0 失败 / 0 错误 | `.tools\test-run-13.log`、`backend\target\surefire-reports\` |
| 前端构建（含非交互 pnpm 安装） | ✅ 45 modules transformed，19 个产物 | `.supervision\frontend-build-final.log` |
| 演示打包 `build-all` | ✅ `BUILD SUCCESS`（Spring Boot jar，skipTests） | `.supervision\build-all-final.log` |
| 后端真实启动 | ✅ `Started DdlMateApplication`，Tomcat 8080，profile=dev | `.supervision\server.log`、`server-restarted.log` |
| HTTP 全链路验收 | ✅ 9 项检查全部通过 | `.supervision\http-smoke-state.json` |
| 重启持久性 | ✅ `restartPersistence: PASS` | `.supervision\http-restart-result.json` |
| 浏览器 9 条桌面路由 + 首页手机宽度检查 | ✅ 9 路由 HTTP 200、内容非空、控制台 0 错误；首页 390px 无横向溢出 | `.supervision\browser-smoke.json` |
| 浏览器完整操作流程 | ✅ 9 步全部通过，控制台 0 错误 | `.supervision\browser-flow.json` |
| 截图核对 | ✅ 首页/课表/最近 DDL/任务详情 | `home-desktop.png`、`home-mobile.png`、`calendar-desktop.png`、`task-with-source.png` |
| MySQL profile | ⛔ **配置已提供、尚待实测**（非未实现功能） | 见 §4 |

---

## 3. 功能验收明细

### 3.1 后端测试（69 项）

```text
Tests run: 6,  Failures: 0, Errors: 0 -- CourseDeletionIT
Tests run: 7,  Failures: 0, Errors: 0 -- StorageServiceTest
Tests run: 16, Failures: 0, Errors: 0 -- SourceAttachmentIT
Tests run: 8,  Failures: 0, Errors: 0 -- TaskLifecycleIT
Tests run: 18, Failures: 0, Errors: 0 -- TaskQueryIT
Tests run: 14, Failures: 0, Errors: 0 -- ValidationErrorIT
Tests run: 69, Failures: 0, Errors: 0, Skipped: 0 → BUILD SUCCESS
```

覆盖：课程/课表/任务 CRUD、状态切换、DDL 排序与筛选、月历与按日查询、统一错误响应与校验、
原通知留存、附件魔数校验（HTML 伪装 / 截断签名 415）、大小限制 413、路径穿越防护、
删除保护 409 与 `force` 级联、删除后磁盘文件清理。前端修复未改动后端逻辑，该结果不受影响。

### 3.2 HTTP 全链路（真实请求，`http-smoke-state.json` 的 checks）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | 课程 CRUD（创建 `QA-...` 临时课程） | ✅ |
| 2 | 课表校验（非法时间返回 400） | ✅ |
| 3 | 任务创建（关联课程、DDL `2026-10-15T22:00:00+08:00`） | ✅ |
| 4 | 原通知留存（来源名 + 原文） | ✅ |
| 5 | 图片上传后下载字节一致（SHA256 相同） | ✅ |
| 6 | 月历定位（2026-10 月份查询） | ✅ |
| 7 | DDL 排序 | ✅ |
| 8 | 课程删除保护（被引用返回 409） | ✅ |
| 9 | 任务状态变更 | ✅ |

**重启持久性**：重启后端后再次查询，任务标题、`DOING` 状态、原通知文字、图片字节
（SHA256 `4cc3fc2a…4cd5bd`）全部保持一致 → `PASS`。临时测试记录已清理，示例种子数据保留。

### 3.3 浏览器验收（Chrome 真实渲染）

路由检查（桌面 Chrome，9 条）：`/`、`/tasks`、`/tasks/new`、`/tasks/1`、`/calendar`、`/courses`、`/courses/1`、`/sources`、`/about`
—— 9 条全部 HTTP 200、正文非空、**控制台错误 0**。

手机宽度检查：仅首页在 390px 宽度下测量（`viewport 390 / content 390`），无横向溢出。

完整操作流程：首页课表与最近 DDL 显示 → 表单新建任务 → 北京时间 DDL 转换正确 →
详情页刷新 → 保存原文并上传图片 → 图片可正常渲染 → 编辑任务 → 标记完成并刷新 → 点击月历切换日期
—— 全部通过，控制台错误 0，临时 UI 测试数据已清理。

### 3.4 浏览器阶段修复回归

此前巡检发现的 4 个页面缺陷（深层地址因 `base:'./'` 白屏、首页今日课程不显示、
「最近的一个 DDL」判断错误、favicon 404）已修复，并在本轮浏览器巡检与截图中确认回归通过。

---

## 4. 已知限制（未验证 / 未实现）

| 项 | 说明 |
| --- | --- |
| **MySQL 未实测** | 本机无 MySQL 服务、无 Docker。`db/mysql/schema.sql` 与 `application-mysql.yml`（`ddl-auto=validate`）已提供但从未连接真实 MySQL；dev profile 的 H2 文件库覆盖同一套后端逻辑。切换时需确认 `validate` 通过、`DATETIME(6)` 与 `OffsetDateTime` 映射正常。 |
| 排序/分页在内存 | `GET /api/tasks`、`/api/tasks/deadlines` 的排序与分页在服务层完成（Hibernate 6.6 的 Criteria 查询不支持 `NULLS LAST`）。适合当前单人本机 MVP；数据量增长后应改为数据库侧排序（`CASE WHEN` 表达式或原生 SQL）。 |
| 无鉴权 | 仅绑定 `127.0.0.1` 的单人开发版，`/api/profile` 返回 `authenticationEnabled=false`。正式上线前需引入 Spring Security + JWT 与 `user_id` 外键。 |
| 未实现功能（**V1 首轮状态**） | **通知截图**的 OCR 与 **AI 抽取**（V1.1）、课表结合的自然语言时间解析（V1.2）、任务拆分 / 冲突检测 / 每日计划 / 手机提醒（V2）。界面无对应假按钮，均写入路线图页。**注意：课表照片的本地 OCR 已在 §0.1 实现并通过验收，二者不是同一件事。**<br>**更新（2026-10-09）**：通知截图 / 文字的**本地 OCR + 保守规则 + 人工确认**已在 §0.3 实现并**完成独立验收**（V1.1 本地版；后端 124 项、前端 139 项、浏览器 11+4 项、通知 HTTP 13+3 项〔**通知阶段验收包结果**〕、课表回归 10 项全部通过）。仍未实现的只有 **LLM 语义抽取**、自然语言相对日期解析（V1.2）、推送与提醒（V2）。<br>**MySQL profile 单独说明**：它属于「配置已提供、尚待实测」，不是未实现功能，见本表第一行。 |
| 课表校历（**V1 首轮状态**） | 首轮 `week_range` 仅作展示；**单双周与教学周过滤已在 §0.1 实现**（`semesterStartDate` + `startWeek/endWeek` + 每周/单周/双周）。仍不做的部分是**单双周以外**的校历推算（停课周、调休、假期），属 V1.2 扩展点。 |

---

## 5. 证据索引

| 内容 | 位置 |
| --- | --- |
| 后端测试日志 / 报告 | `.tools\test-run-13.log`、`backend\target\surefire-reports\` |
| 前端构建 / 演示打包日志 | `.supervision\frontend-build-final.log`、`.supervision\build-all-final.log` |
| 服务启动日志（两次） | `.supervision\server.log`、`.supervision\server-restarted.log` |
| HTTP 验收与重启结果 | `.supervision\http-smoke-state.json`、`.supervision\http-restart-result.json` |
| 浏览器巡检与流程 | `.supervision\browser-smoke.json`、`.supervision\browser-flow.json` |
| 截图 | `.supervision\home-desktop.png`、`home-mobile.png`、`calendar-desktop.png`、`task-with-source.png` |
| 通知导入（V1.1 本地版，2026-10-09 终验） | `backend\target\surefire-reports\`（124 项，Codex 按 Surefire XML 核对）、`.supervision\notice-import-status.json`、`notice-frontend-test-results.json`、`notice-parser-review.json`、`notice-final-build.log`、`notice-final-jar-hash.json`、`notice-browser-flow.json`、`notice-browser-edge.json`、`schedule-browser-flow.json`、`notice-import-http-result.json`、`notice-http-boundaries.json`、`notice-qa-server.log` |
| UI 重做与部署（§0.4） | `.supervision\ui-live-deploy.json`（`DEPLOYED_AND_VERIFIED`、jar SHA256、备份路径）、`ui-live-data-verification.json`、`notice-live-verification.json`、`ui-live-visual.json`、`ui-final-visual.json`、`ui-interaction-results.json`、`notice-browser-flow.json`、`notice-browser-edge.json`、`schedule-browser-flow.json`、`ui-frontend-tests.json`、`ui-build.log`、`docs\ui-design.md` |
| 验收汇总 | `.supervision\final-acceptance.md` |
| 实施方案（四阶段） | `docs\implementation-plan.md` |
| 启动 / 构建 / 测试脚本 | `scripts\*.ps1` |
