# DDL Mate 界面设计说明（2026-10-09 视觉升级）

本轮只做界面与前端样式，不动后端 API、数据库、OCR/解析算法、时区规则、路由路径与依赖版本。
目标是「有质感的校园日程工具」：温暖、安静、可快速扫读。

## 1. 设计令牌（`frontend/src/styles/main.css` 顶部 `:root`）

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 暖白底 | `--bg` | `#f6f5ef` |
| 内容纸面 | `--surface` | `#ffffff` |
| 次级/凹陷面 | `--surface-soft` `--surface-mute` | `#f8f7f1` `#f1efe6` |
| 墨色正文 | `--text` | `#23352e` |
| 次级/弱文字 | `--text-soft` `--text-muted` | `#4f6157` `#65746b` |
| 主操作深绿 | `--primary` `--primary-dark` | `#285b47` `#1d4636` |
| 浅鼠尾草点缀 | `--primary-soft` `--primary-tint` | `#e7efea` `#f1f6f3` |
| 陶土橙（紧迫/逾期） | `--clay` `--clay-soft` | `#b4573a` `#fbeee8` |
| 分隔线 | `--border` `--border-strong` | `#e6e2d5` `#d5d0be` |
| 焦点环 | `--focus-ring` | `0 0 0 3px rgba(40,91,71,.28)` |

语义色全部由墨绿 / 陶土橙派生：`--danger` = 陶土橙，`--success` = 深绿，`--warn` = 暖赭石，
因此全站不会再出现蓝紫渐变。背景装饰只有一层 `radial-gradient` 纸纹（`background-attachment: fixed`），
不拦截任何指针事件。

字体只用两套本机字体栈：`--font-sans`（系统 UI + PingFang/微软雅黑）与 `--font-mono`；
不加载任何网络字体、CDN 或图片资源。

## 2. 全站外壳（`frontend/src/App.vue`）

- **桌面 ≥960px**：左侧 `232px` 边栏（品牌字标 + 分组导航 + 底部「本地资料」入口），右侧内容区。
  品牌是本地 SVG 打勾标记 + 字标「DDL Mate」+ 副标「学习工作台」。
  导航按「学习（首页 / DDL 列表 / 日历 / 课程与课表）」与「资料（原通知 / 路线图）」分组，
  活动项是浅绿底 + 深绿字 + 图标着色。
- **小屏 <960px**：边栏隐藏，换成吸顶紧凑顶栏（品牌 + 当天日期）与一行可横向滚动的导航条，
  所有入口都在，active 状态一致；不遮盖内容、不盖住按钮与页脚。
- **路由高亮**：`SECTION_BY_ROUTE` 把子路由归到一级导航，
  包含 `task-import-notices → 任务`、`schedule-import → 课程`、`calendar-day → 日历`、
  `task-new/task-edit/task-detail → 任务`、`course-detail → 课程`。
- 工程细节（端口、Java、鉴权）从界面移出：页脚只保留「本地单人版，数据只保存在这台电脑」，
  时区与显示名收进边栏底部「本地资料」卡片，细节仍在路线图页。
- 新增「跳到主要内容」跳转链接（键盘聚焦时可见）。

## 3. 首页（`frontend/src/views/HomeView.vue`）

真正的布局重做，不是换色：

1. **欢迎区**：问候语 + 日期行（含日历图标）+ 「新建任务」「看日历」。
2. **4 个精简统计格**：逾期 / 今天 / 7 天内 / 已完成。数字全部来自 `taskApi.stats()` 真实返回；
   没有假进度、假连续打卡、假效率分数、假月历或随机数据。只有计数非 0 时才上色（逾期=陶土橙底、今天=暖赭石底）。
3. **深绿通知整理入口**（视觉焦点）：整行深绿条，链到真实的 `/tasks/import-notices`，
   文案说明「在本机识别成可编辑候选，勾选确认后才写入」。
4. **主工作区**（显式两列，不依赖自动摆放）：
   - `.home-focus` 只有两个孩子：`.home-focus__main`（主列）与 `.home-focus__side`（右窄列），
     两列 `align-items: start`；≥1080px 时主列显式 `grid-column/row: 1 / 1`、右列 `2 / 1`。
   - 主列内部上下排列「今天与逾期」与「即将截止（7 天内）」两张卡；「今天与逾期」再分
     「今天截止」「已逾期」两组小标题 + 真实条数（数据来自 `taskApi.today()`，
     含今天截止与之前逾期未完成，前端不重排后端给的顺序）；副标题写成
     「待处理 N 个 · 其中已逾期 M 个」，不再把含逾期任务的列表说成「今天截止」。
   - 「即将截止（7 天内）」最多 6 条，继续用 `TaskItem`，原操作与空态都保留。
   - 右窄列放「今日课程」「最近的一个 DDL」（倒计时徽标 + 一次完整截止时间）与「现在能做什么」。
   - ≤1079px 退化为单列：整块主列在前、右列在后，自然堆叠。
5. **移动端**：按 统计 → 通知入口 → 主列（今天与逾期 / 即将截止）→ 右列（今日课程 / 最近 DDL / 能力说明）堆叠。
6. 首页旧文案「通知截图尚未识别」已删除，改为描述用户现在能做的事，
   相对时间与 AI 拆分等边界统一放到路线图页。

> 第一轮 Codex 复核（`.supervision/ui-review-round1.md`）的 4 点已全部修正：
> 恢复 7 天内任务列表、修正卡片副标题口径、去掉重复时间与误导性的「逾期 0 天」、
> 把 `--text-muted` 提升为 `#65746b`（小号辅助文字在暖白底上对比度约 4.8:1）。
>
> 第一轮目视复验（`.supervision/ui-after-home-1440.png`，整页高达 2625px）暴露的三处布局缺陷也已修正：
> `.home-focus` 自动摆放错位、`.task-item` 固定 `1fr auto` 把中文标题压成一字一行、
> 桌面顶栏日期贴屏幕右上角。做法见第 4 节与第 6 节。

## 4. 任务列表与条目

- `TaskListView.vue`：筛选区改为「一行主筛选（关键词 / 课程 / 状态 / 排序 + 清空）」+
  可折叠「更多筛选（类型 / 优先级 / 截止范围 / 方向 / 包含已完成）」，**没有删除任何筛选项**，
  并在折叠标题上显示已启用条数。列表卡片头部显示分页与总数。
- `TaskItem.vue` 的排布按**列表容器宽度**决定，不按视口宽度（不再靠 `overflow: hidden` 掩盖）：

  | 条件 | 排布 |
  | --- | --- |
  | 基础（任意宽度） | 单列：主信息占满整行，操作紧随其下、左对齐 |
  | `@container tasklist (min-width: 680px)` | 主信息 `minmax(0, 1fr)` + 操作列 `auto`（有上限），操作右对齐 |
  | 不支持 container queries 的回退 | 包在 `@supports not (container-type: inline-size)` 内的 `@media (min-width: 1080px)` 才让 `.task-list .task-item` 并排 |

  实现是给 `.task-list` 加 `container-type: inline-size; container-name: tasklist`。
  效果：任务页大宽列（约 1152px）并排；首页中等宽主列（约 620px，低于 680px 阈值）改成
  主信息满宽、操作在下一行，避免操作区占掉一半以上宽度；首页右窄列（约 340px）与 390px 手机
  同样落回单列。回退规则用 `@supports` 隔离，避免支持容器查询的浏览器又按视口宽度把窄列撑成并排。
- 「从通知导入」提示语更新为现在的真实行为（本地识别 → 候选 → 确认后写库）。

## 5. 统一组件与内页

- 同一套 `.btn`（主要 / 次要 / 危险 / 幽灵 / 小尺寸 / 图标）、`input`、`select`、`textarea`、
  `.badge`、`.table-wrap`、`.state`（空态）、`.alert`、间距刻度。
- 表格一律在 `.table-wrap` 内横向滚动（含 OCR 候选表），页面本身不横向溢出。
- 课程与课表、课程详情、日历 / 日期详情、任务详情 / 表单、原通知、两个导入页
  都改用 `AppIcon`（本地 stroke SVG）替换原本当图标用的 emoji；
  课程默认色从蓝紫改为陶土橙 `#b4573a`，课程没有颜色时统一用 `#65746b`。
- 导入页的候选核对区、确认提示、学期起点与时间字段、OCR 原文区全部保留，只调整了外层排版。
- 未改动任何业务函数：OCR、解析、校验、保存、分页、过滤逻辑保持原样。

## 6. 可访问性与响应式

- 键盘可见 `:focus-visible` 焦点环；图标按钮带 `aria-label`（如上一月 / 下一月、菜单），
  表单 `label` 全部保留，导航活动项带 `aria-current="page"`。
- `@media (pointer: coarse)` 下主要按钮 ≥44px 触控目标，导航项 44px。
- `@media (prefers-reduced-motion: reduce)` 关闭动画与过渡。
- 断点：390px 手机（两列统计、单列内容）、768px 平板（顶栏 + 横向导航、双列统计）、
  1080px 起首页分主宽列 / 窄列、1440px 桌面（232px 边栏 + 最宽 1160px 内容）。
- 桌面顶栏与正文同宽同边距：桌面下 `.topbar__inner` 用 `width: calc(100% - 64px)`、`max-width: none`、
  `margin-inline: auto`、内边距 `16px 0 14px`，因此在任何桌面宽度（含 1280px 这类 app-body 不足 1160px 的视口）
  都与 `app-main` 的左右 32px 严格对齐，不再贴屏幕右上角。
- 加载态（`LoadingState`）与错误态（`ErrorState` / `alert--danger`）都没有隐藏或削弱。

## 7. 交付与验证状态（2026-10-09）

**结论：已实现、已本机部署，并通过最终独立验收（`DEPLOYED_AND_VERIFIED`）。**
实现 = DeepSeek Harness；监督、部署与独立验收 = Codex。用户授权原文：「允许启动8080，帮我设计一个好看的ui」。

| 项 | 实际结果 | 证据 |
| --- | --- | --- |
| 部署 | ✅ `http://127.0.0.1:8080`（PID 291104）；发布包 `.supervision/releases/ui-20261009/ddl-mate.jar`，SHA256 `9FECC5161E95F4B5C1A1BE9B17FF956D69F2A0257FB4C5C2C617D00DF6204319`；部署前备份 `.supervision/backups/before-ui-20261009-163954` | `ui-live-deploy.json` |
| 原库数据完整性 | ✅ 3 课程 / 5 课表 / 3 任务 / 1 原通知，与更新前逐条一致（只读核对） | `ui-live-data-verification.json` |
| 真实页面 | ✅ 5 个页面 HTTP 200 + 可见标题；390px 无溢出；0 异常 / 0 外网 / 0 写操作 | `notice-live-verification.json`、`ui-live-visual.json` |
| 隔离 QA 页面尺寸 | ✅ 12 路由 × 1440 / 768 / 390 = 36 个页面/宽度，无横向溢出（该 8081 QA 服务已在验收结束后由 Codex 关闭，见下表） | `ui-final-visual.json`、`ui-qa-cleanup.json` |
| 交互验收 | ✅ 7 项 PASS（子路由高亮、筛选、手机导航、键盘 skip、三档宽度可读性、1280px 边距） | `ui-interaction-results.json` |
| 通知 / 课表回归 | ✅ 通知导入 11 项、通知边界 4 项、课表回归 10 项在最终 UI 包上重跑全过 | `notice-browser-flow.json`、`notice-browser-edge.json`、`schedule-browser-flow.json` |
| 前端测试 | ✅ 10 个文件 139 项全通过（布局与文案收尾后复跑仍全过） | `ui-frontend-tests.json` |
| 构建 | ✅ 最后一次实际构建成功 `2026-10-09T16:35:22+08:00` | `ui-build.log` |

离线自检（实现阶段用过，保留说明）：`frontend/scripts/check-vue-syntax.mjs` 用官方 `@vue/compiler-sfc`
编译 23 个 `.vue` 文件全部通过；`scripts/build-frontend.ps1` 最初在受限沙箱内因 esbuild 管道 stdio
子进程 `spawn EPERM` 无法完成，**该阻碍已由 Codex 在正常权限下解除**，构建与浏览器验收均已完成。

### 未完成 / 不声称

| 项 | 状态 |
| --- | --- |
| LLM 语义抽取、自然语言相对日期解析、任务拆分 / 冲突检测 / 每日计划 / 提醒、登录鉴权 | ⛔ 未实现。本轮是**界面重做**，不包含也不声称这些能力 |
| MySQL profile | ⛔ **配置已提供、尚待实测**（不是未实现功能：建库脚本与 `application-mysql.yml` 已写好，本机无 MySQL/Docker，未连接过真实实例；H2 file profile 已实测） |
| 后端 124 项测试 | ⚠️ 2026-10-08 历史结果；后端 Java 源码自 2026-10-08 15:19 起未改动，**本轮未重跑后端全套** |
| 隔离 8081 的 QA 服务 | ℹ️ **已关闭**：UI 验收结束后由 Codex 关闭（`ui-qa-cleanup.json`，PID 295064，`stoppedAt 2026-10-09T21:23:14+08:00`）；**当前只有 8080 在运行** |

逐项验收记录见 [`verification.md`](verification.md) §0.4。
