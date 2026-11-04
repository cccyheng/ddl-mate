# 学习周报（native learning report）

**一句话**：只读当前本机数据，按 **Asia/Shanghai 周一 00:00 至周日结束** 统计某一周的
「本周完成 / 本周到期 / 到期完成率 / 已逾期」，并能点进每个数字看真实任务。

- 入口：**今天**标签页的「学习周报」卡片（按钮「打开学习周报」）；
  **任务**标签页筛选行里的「学习周报」按钮。两个入口打开的是**同一个原生界面**。
- 退出：原生标题栏返回按钮 / 左滑返回手势。
- 路由：`TaskStack.LearningReport` 与 `TodayStack.LearningReport`（参数都是 `undefined`）。
- 实现：`mobile/src/domain/learningReport.ts`（纯统计）、
  `mobile/src/screens/learningReportScreenState.ts`（纯页面状态机）、
  `mobile/src/screens/LearningReportScreen.tsx`（原生界面）。

这一页不写库、不保存历史、不接网络 / 通知 / AI、不估算学习时长、不造连续天数或评分。

### 实际改动文件

新增：
`mobile/src/domain/learningReport.ts`、`mobile/src/screens/learningReportScreenState.ts`、
`mobile/src/screens/LearningReportScreen.tsx`、`mobile/tests/learningReport.test.mjs`、
`mobile/tests/learningReportScreenState.test.mjs`、`mobile/tests/learningReportWiring.test.mjs`、
`docs/native-learning-report.md`、`.supervision/learning-report-handoff.md`。

修改：
`mobile/src/navigation/types.ts`（两条栈的 `LearningReport` 路由 + 共用窄类型）、
`mobile/src/navigation/RootNavigator.tsx`（两条栈注册同一个屏幕）、
`mobile/src/screens/TodayScreen.tsx`（今天页入口卡片）、
`mobile/src/screens/TaskListScreen.tsx`（任务页入口按钮）。

未改：`package.json`、`pnpm-lock.yaml`、`app.json`、`tsconfig.json`、数据库 schema / migrations /
备份格式 / 提醒 / 导入 / 网络代码。改动前的副本在
`.supervision/learning-report-before-20261026-200116/`。

---

## 1. 周的选择

| 行为 | 实际规则 |
| --- | --- |
| 默认周 | 执行时的上海自然日所在周，周一到周日 |
| 上一周 / 下一周 | 按绝对周一前后移动；**下一周最多到当前周**（按钮 disabled） |
| 回到本周 | 显式按钮；清空绝对锚点，重新跟随当前周 |
| 可回看范围 | 含当前周在内 **52 周**（当前周 + 之前 51 周）；再往前按钮 disabled |
| 当前周跨周 | `weekAnchor === null` 时，页面在跨过周日午夜 / 回前台后自动显示新的一周 |
| 手动选过去周 | 记录那周的**绝对周一日期**；之后 now 前进不会把它漂走 |
| 翻周与筛选 | 翻周保留当前筛选（日期筛选存的是周几，不是绝对日期），页码重置为第 1 页 |
| 后台刷新 | 只替换数据快照，不改所选周、筛选或状态；不会把过去周冲回本周 |

周范围、最早可回看周、上一周 / 下一周 / 回到本周都由
`learningReportScreenState.ts` 的纯函数计算，屏幕不另写一套周算术。

---

## 2. 指标口径（全部来自同一份分析结果）

`analyzeLearningReport({ tasks, courses, weekStartDateKey, now })` 是唯一统计入口；
界面上的数字与明细选择器 `selectLearningReportTasks` 都从它的结果派生。

| 指标 | 口径 |
| --- | --- |
| **本周完成** | **现在**状态是 `DONE`，且 `completedAt` 换算到上海后的日期落在所选周、`completedAt <= now`。**绝不用 `updatedAt`** |
| 完成时间缺失 / 无法识别 | 当前 `DONE`，但 `completedAt` 为空、解析失败、无偏移墙上时间或不存在的日期；单独计数，不猜时间、不用修改时间补 |
| 完成时间不在本周 | 当前 `DONE` 且 `completedAt` 合法，但上海日期不在所选周；单独计数 |
| 完成时间晚于现在 | 当前 `DONE`，完成日期在所选周内但时刻 > now（异常/未来数据）；单独计数，不冒充本周完成 |
| **本周到期** | `deadline` 的上海日期落在所选周的任务；**已取消（CANCELLED）不计入** |
| 到期已完成 | 「本周到期」中**现在**状态为 `DONE` 的任务。**没有完成时间的 DONE 仍算到期已完成**，但不会进入「本周完成」 |
| 到期未完成 | 「本周到期」中状态不是 `DONE` 的任务（待办 / 进行中） |
| **已逾期** | 「本周到期且未完成」中，按既有 `isDeadlineOverdue` 判定已过截止时刻的任务 |
| **到期完成率** | `到期已完成 ÷ 本周到期`；**本周到期为 0 时是 `null`，界面显示「—」，不是 100%** |
| 每日完成 | 把「本周完成」按完成时间的上海日期分到周一到周日；条形数字就是真实条数 |
| 课程拆分 | 「本周到期」按 **`courseId`** 分组（同名课程不合并）；每组给出到期 / 已完成 / 未完成（其中逾期），并分别标出「未关联课程」「课程已删除」 |

### 计数为什么对得上

- `到期已完成 + 到期未完成 = 本周到期`；
- `已逾期` 是「到期未完成」的子集，不重复计入完成率分子；
- 每日到期条数之和 = 本周到期；每日完成条数之和 = 本周完成；
- 每个当前 `DONE` 恰好落进：本周完成 / 完成时间缺失 / 不在本周 / 晚于现在 四类之一；
- 课程各组的到期、已完成、未完成、逾期之和分别等于总计数。

### 日期与边界

- 全部用 `Asia/Shanghai`；设备时区改成 UTC / 纽约不影响归周。
- 只到日期的截止（`YYYY-MM-DD`）在当天内不算逾期，跨过上海零点才算；
  精确时刻按毫秒比较，到点那一刻不算逾期。
- 只到日期的完成时间按「当天 00:00」参与 `<= now` 与排序，不编造具体完成时刻。
- 周 / now 无法解析时分析函数返回 `null`，界面显示错误，不猜日期。

---

## 3. 明细（点数字 / 课程 / 日期）

- 概览 6 个数字、每日条形、课程行、以及「完成时间缺失」提示都可以点开明细。
- 明细在**同一屏**内出现，有明确标题（例如「本周到期且已完成的任务（3 条）」）、
  返回汇总 / 清除筛选、空状态，以及每页 **20 条**的分页；只渲染当前页。
- 每条任务可点进原生「任务详情」；周报页本身不提供完成 / 删除 / 编辑入口。
- 明细列表与数字共用选择器，因此不会出现「数字 3 条、点进去 2 条」。
- 课程分组用 `courseId` 作键；界面不显示课程代码 / 选课序号。

---

## 4. 只读与刷新

- 页面只从 `AppStore` 快照读 `tasks` / `courses`；不直接访问 SQLite。
- 没有新表、没有新设置键、没有迁移、没有备份格式变化；`SCHEMA_VERSION` 保持 3。
- 没有新增依赖、权限、网络请求、通知、LLM、导入或提醒逻辑。
- 进入页面 / 回到前台用既有 `useFocusClock(readShanghaiEpochClock)` 推进时间；
  跨零点额外重读一次快照。页面没有自建定时器。
- 加载中 / 读取失败 / 数据可能过期沿用 `LoadingState`、`ErrorState`、`RefreshErrorBanner`
  与 `retryBootstrap`；读取失败不会冒充「本周没有数据」。

---

## 5. 明确没有做的事

- 不保存历史周报快照；删除任务、把 `DONE` 改回 `TODO` 后，周报按当前数据变化。
- 不展示实测学习时长；任务没有该字段，本模块也**不**把预计用时说成学习时长（完全不显示时长）。
- 不做 AI 总结、评分、连续天数、打卡、预测或排名。
- 不做通知、提醒、导入、备份、网络请求，也不修改任何任务 / 课程 / 课表。
- 不保证「完成率高 = 学习好」；页面只呈现当前数据里的事实。

---

## 6. 验证

在 `mobile/` 下：

```powershell
C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe node_modules/typescript/bin/tsc --noEmit
```

```powershell
C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe `
  --experimental-test-isolation=none --import ./tests/setup.mjs --test `
  tests/learningReport.test.mjs tests/learningReportScreenState.test.mjs tests/learningReportWiring.test.mjs `
  tests/batchNoticeWiring.test.mjs tests/taskPhotosWiring.test.mjs tests/taskStepsWiring.test.mjs `
  tests/taskTemplatesWiring.test.mjs tests/todayPlanWiring.test.mjs
```

结果：`tsc` 通过；上述 8 个文件共 **102 个测试全部通过**。

- `learningReport.test.mjs`：纯统计、周算术、完成 / 到期 cohort、只到日期边界、上海滚动、
  跨年、闰日、同名 / 缺 / 未关联课程、零分母、完成率、选择器成员完全一致。
- `learningReportScreenState.test.mjs`：**真实调用**上一周 / 下一周 / 回到本周 / 点数字 /
  点课程 / 点日期 / 翻页，以及当前周跟随、过去周绝对锚点、52 周边界、分页夹取。
- `learningReportWiring.test.mjs`：两条栈注册、两个入口、只读边界、无新表 / 新依赖 /
  网络 / AI / 时长、聚焦时钟、无障碍与小屏换行守卫。

---

## 7. 已知边界 / 待真机检查

- 当前数据集是唯一来源；没有服务器侧历史，也没有跨设备同步。
- 只到日期的 `completedAt` 是历史脏数据的容错，正常写入仍是带偏移的时间戳。
- 未来完成时间 / 缺失完成时间只单独披露，不会被补成某个日期。
- 尚未做 iOS bundle 与 iPhone 真机视觉验收（由监督流程完成）。

### 手机检查清单

1. 今天页「学习周报」卡片、任务页「学习周报」按钮都能打开同一个原生屏；原生返回 / 手势可退出。
2. 默认当前周（周一至周日），日期范围正确；「下一周」在当前周 disabled；「上一周」可翻；「回到本周」可回。
3. 翻到过去周后切标签再回来，仍停在那一个过去周；跨过周日午夜回到前台，未锁定的当前周会前进。
4. 六个概览数字、每日条形、课程行都能在**同一屏**打开对应任务列表；标题里的条数与点击的数字一致。
5. 明细可翻页 / 返回汇总 / 清除筛选；没有对应任务时显示空状态；点任务能进任务详情，返回后周与筛选不丢。
6. 小屏 + 大字号：无横向溢出；条形数字与无障碍文案可读；按钮触控目标舒适。
7. 只读检查：不出现新权限 / 新设置 / 新表；读取失败只出现提示与重试，不冒充「本周没有数据」。

## 2026-10-27 周报界面验收更新
用户已允许 Codex 接手完成。此前 DeepSeek 三项未完成 UI 修复现已完成本机验证：
- 汇总和任务明细分开显示，点数字、日期或课程后立即显示对应明细；翻周/筛选/页码切换重置滚动。普通数据刷新保持所选周和列表；数据减少导致页码越界时使用实际显示页重置滚动。
- 历史周使用“所选周”；统计说明可展开收起，主页面保留简短说明。
- 每日图表换行，最小点击宽高44pt；测试读取实际屏幕/卡片边距，验证320pt宽度下7天分两行。
本轮只修改 LearningReportScreen.tsx、对应静态接线测试，新增 learningReportScreen.test.mjs；指标公式、数据库、依赖、提醒和学习计划不变。
验证：learning-report-codex-tests.log 54/54（含6项实际TSX回调测试），独立 learning-report-codex-review.log 5/5，learning-report-codex-tsc.log exit0。共59项。测试采用合成数据，不操作用户数据库。
最终iOS预览 learning-report-final-preview-result.json：2026-10-27T00:14:00.382Z SDK58、manifest/bundle200、7220206bytes。地址 exp://172.20.10.2:8081。手机确认待进行：今天/任务→学习周报→点数字/日期/课程查看明细→打开任务返回→翻往周→返回汇总，核对布局和数字。
注意：以上为本机验证，不等于iPhone视觉验收。统计反映当前任务状态，不保存历史快照。上一版课前提醒手机验证仍待答复，备份图片导入旧问题未处理。
