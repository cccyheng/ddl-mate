# 原生任务截止提醒（K：本机固定提前量）

更新：2026-10-20（新增点击通知 → 任务详情）。范围：`mobile/` 原生 iOS 客户端；**不是**云推送、不是智能提醒、不是替别人设提醒。

## 1. 用户看到的行为

任务详情（「今天」栈和「任务」栈都可达）→「提醒设置」：

- **默认关闭**。打开页面、启动 App、回到前台都不会自动给任务开启提醒，也不会在启动时申请通知权限。
- 每条任务只能选一个提前量：**30 分钟 / 3 小时 / 1 天 / 3 天**。
- 页面显示真实任务标题、截止时间（北京时间）、当前保存的规则，以及按截止时间算出的**绝对提醒时刻**（例如「将在 2026-10-20 21:30 提醒（北京时间）」）。
- 只有用户显式点「开启提醒」并「保存提醒设置」才写规则；点「测试提醒」或显式开启时才可能申请通知权限。
- 保存后页面会另读系统已排队通知：
  - 确认匹配 → 显示「系统已排队」；
  - 规则已保存但权限 / 原生排程失败 → 明确显示「**设置已保存，提醒尚未安排**」并提供「重试安排提醒」；
  - 读不到系统通知列表 → 显示「无法确认」，不会说成已经排好。
- 已保存的规则如果因为任务改期、完成、取消而失效，页面会保留规则并解释「当前不会生效」；**关闭永远可用**，即使任务没有 DDL、截止时间坏了或通知权限被拒。
- 「测试提醒」固定安排 **10 秒后**一条测试通知，使用独立的命名空间，不会替换 / 取消任务提醒。文案只说「已经交给系统，约 10 秒后检查手机」，**不声称已送达**。

## 2. 明确不能做的事

- 不接远程推送、APNs、EAS、Expo push token、云函数或任何凭据。
- 不根据 AI 猜提前量；不自动替所有任务开启；不把提醒发给别人。
- 不因为用户打开 App 就弹权限；不操作角标。
- 不需要后台 JS 才能让**已经排好的**本机通知触发；但任务改期 / 改标题 / 完成 / 删除后，需要 App 再次运行（启动、回到前台、任务写入后）才能把变更同步给系统。
- 本地通知的最终展示由 iOS / Expo Go 决定。**未做真机送达验收**；Expo Go 里通知可能带 Expo Go 的品牌/容器提示。

## 3. 文件与 API

| 文件 | 作用 |
| --- | --- |
| `mobile/src/domain/taskReminder.ts` | 纯规则：提前量、版本化记录编解码、可安排性、稳定 ID / 载荷 / 指纹、32 条上限、对账计划 |
| `mobile/src/domain/taskReminderRepository.ts` | `app_settings` 持久化（键 `task_reminder.<正整数任务ID>`），事务、父任务检查、修订号、上限、精确删除 |
| `mobile/src/domain/taskReminderService.ts` | 中央串行服务：保存 → 权限 → 对账 → 回读系统列表；启动 / 前台 / 任务改动 / 手动重试共用一条队列 |
| `mobile/src/domain/expoTaskReminderPort.ts` | `expo-notifications` 原生适配器（只在原生运行时动态 import） |
| `mobile/src/screens/taskReminderController.ts` | 设置页纯状态机：草稿 / 基线 / busy 闸门 / 过期异步结果 |
| `mobile/src/screens/TaskReminderScreen.tsx` | 原生设置界面（44pt、共用 theme、无原始 ID / ISO / DB 术语） |
| `mobile/src/store/AppStore.tsx` | 创建服务、任务写入后不阻塞地对账、删除任务时同事务清理规则键、前台上报 |
| `mobile/src/navigation/taskReminderNotificationRouter.ts` | 纯路由控制器：严格解析、持久回执去重、编辑 / 隐藏 Tasks 栈暂缓、可见重试、只跳任务详情 |
| `mobile/src/navigation/useTaskReminderNotificationNavigation.ts` | 动态加载 `expo-notifications` response API，接 store fresh 查询 / 回执与根导航 |
| `mobile/src/domain/taskReminderNotificationReceipts.ts` | 有界回执的严格编解码（32 条、version 1、坏记录 fail closed） |
| `mobile/src/domain/taskReminderNotificationReceiptsRepository.ts` | 复用 `app_settings` 的事务回执仓库；无 schema 迁移 |
| `mobile/src/ui/TaskReminderNotificationBanner.tsx` | 非破坏性提示条：编辑暂缓 / 读取失败重试 / 缺失任务安全回列表 |
| `mobile/src/navigation/types.ts`、`RootNavigator.tsx` | 两条栈注册 `TaskReminder: { id }`；根标签参数声明嵌套栈；NavigationContainer ref / `onReady` / banner 接线 |
| `mobile/src/store/AppStore.tsx` | fresh 只读任务重查 + 回执窄接口；任务写入后的提醒对账与删除清理不变 |
| `mobile/src/screens/TaskDetailScreen.tsx` | 「提醒设置」入口；快照缺失时 fresh 重查，读失败可重试、明确删除才显示不在本机 |

服务公开 API（`createTaskReminderService(deps)`）：

`reconcile(reason)` / `notifyTaskChange(reason)` / `inspectTask(taskId)` /
`saveSettings(input)` / `testReminder(taskId)` / `getSnapshot()` / `subscribe(listener)`。

控制器公开 API（`createTaskReminderController(taskId, deps)`）：

`getState` / `subscribe` / `load` / `refreshAfterForeground` / `setEnabled` / `setLead` /
`save` / `retry` / `test` / `dispose`。

## 4. 持久化语义

- 不新增表、不改 schema 版本；复用 `app_settings`。每个任务一条记录：
  `{ version: 1, taskId, enabled, leadMinutes, revision, updatedAt }`。
- 没有记录 = 默认关闭（正常状态，不是错误）。显式关闭也会写一条 `enabled: false` 的记录，保留用户意图。
- 保存事务：父任务仍存在 → 重读旧记录 → 校验 `expectedRevision` → 启用时校验任务可安排且未超过 32 条 → 写入 `revision + 1`。
  - 版本不一致：拒绝覆盖，回传当前修订号；界面要求先刷新。
  - 损坏 / 未来版本：拒绝写入，原值一个字节不动；界面停止修改（fail closed）。
  - 写入已提交但读回失败：`committed: true` + `readbackError`，不谎报保存失败。
- 删除任务：`TaskRepository.remove` 的同一个事务里精确删除 `task_reminder.<id>` 与 `task_steps.<id>`；绝不按前缀批量删。
- 任务 ID 只接受正整数；键是精确拼出来的，不做 `LIKE 'task_reminder.%'` 的删除。
- 孤儿规则（任务已不存在但键还在）：对账时取消它的本应用通知并精确删除这一个键；绝不把规则转给新任务。
- 设置页生命周期：控制器按当前 route 的 `taskId` 创建；effect setup 调 `activate()`，cleanup 调 `dispose()`，因此 StrictMode 的 setup → cleanup → setup 不会永久失效，也不会重放写库 / 权限 / 测试请求；同一页面实例的 `params.id` 变化会换一个新的控制器。
- 冲突与显式载入：后台刷新遇到修订号变化时保留脏草稿并置 `needsReload`；普通编辑不会清掉它。只有用户按「载入最新（丢弃草稿）」才会采用最新修订并恢复可编辑。
- 关闭（OFF）后的取消重试：即使当前规则是关闭，只要系统里仍有 stale / unknown 的本应用通知，页面就显示「重新取消提醒」；确认系统里已经没有通知时才显示关闭成功，取消失败仍保留警告。

## 5. 通知 ID / 载荷 / 对账

- 稳定 ID：`ddlmate.task-reminder.v1.<taskId>`。
- 测试 ID：`ddlmate.task-reminder.v1.test.<taskId>`，与任务提醒完全分开。
- 只有同时满足以下条件的排队通知才算「本应用的任务提醒」：
  - ID 精确匹配上面的格式，任务 ID 是正整数字符串；
  - 载荷 `kind === 'ddlmate.task-reminder.v1'`、`version === 1`；
  - 载荷任务 ID 与 ID 一致；提前量、触发时刻、截止时间、标题、指纹都有效。
  任何不满足的通知都保留不动；**全仓没有 `cancelAllScheduledNotificationsAsync`**。
- 指纹包含任务 ID、截止时间、提前量、标题、绝对触发时刻。只有指纹与触发时刻都一致才视为「已排好」；刷新不会重复安排。
- 原生触发与回读（与安装的 SDK 57 源码一致）：
  - **iOS** 用一次性 CALENDAR trigger：完整 `year/month/day/hour/minute/second`、`timezone: Asia/Shanghai`、`repeats: false`。系统回读同样的 `dateComponents`，按上海 +8 精确换算后与期望时刻**完全相等**才算 `queued`。
  - **Android** 用 DATE trigger；回读 timestamp 后精确比较。
  - 回读**不接受** `timeInterval`（iOS 的 DATE 会变成 `seconds`，而 seconds 是原生侧按 `Date()` 计算的，JS 排程时刻 + seconds 不能证明真实绝对时间），也不接受 `unknown` / `push` / `location` 等未知 type。
  - `repeats: true` 在任何类型上都先被拒绝；绝不把「重复 trigger」或「带一个看起来合理 timestamp 的未知 type」当作已排好。
  - **不回退**到载荷里的 `triggerAtMs`，也不使用任何时间容差来掩盖不符。**未验证 = stale/unknown，不会显示「已安排」。**
- **秒精度策略**：iOS CALENDAR 与 Android DATE 回读都只保证到秒。所有意图时刻统一规范到**下一个整秒**（`ceil(ms/1000)*1000`，绝不早于请求、最多 +999ms），可安排性 / 指纹 / 载荷 / 原生排程 / 测试提醒 / 回读比较全部使用这个规范值，再做**精确相等**比较。因此 `Date.now().321` 的真实小数毫秒不会让测试提醒或 fractional 截止时间永远 stale；这不是容差，也不使用 bridge 延迟估算 / timeInterval 验证。
- 任务标题 / DDL / 提前量变化：只对同一个 ID 执行「先取消、再安排」；如果取消失败，**不排新通知**，失败会显示并可重试。每次真正排程前还会用**此刻的最新任务**重新校验；等待期间过了触发时刻 / 任务改期 / 任务完成都不会再排旧请求。
- 任务 DONE / CANCELLED / 没有 DDL / **截止时间只到日期（没有 HH:mm）** / 截止时间非法 / 提醒时刻已过：取消本应用那条通知，保留规则并解释不生效；过去的时刻**绝不会**被补发或重新排到未来。只到日期的任务不会被猜成 23:59 的提醒；页面会明确提示「补上具体时刻即可开启」。
- 关闭：无论权限是否被拒，都尝试取消已排队的本应用通知；取消失败会显示「设置已保存，但通知操作失败」，不会说成已取消。
- 权限：
  - `granted` / iOS `provisional`（安静通知）可以安排；
  - `denied` / `undetermined` / 原生不可用不安排，已保存的规则保留；
  - 权限只在用户显式开启 / 测试时申请；启动、前台、刷新只读取。
- 系统通知列表读取失败 = **未知**，不会清空 / 取消，也不会当成「一条都没有」。
- 32 条上限：第 33 条启用被拒绝并解释，不会静默丢掉已有提醒。测试提醒不占名额。
- 其它 App / 本 App 其它模块的通知保留；服务记录 `foreignPendingCount`，只处理本应用精确 ID。

## 6. 数据库与系统通知不是原子操作

无法把 SQLite 提交和 OS 排程放在同一个事务里。实际语义是：

1. 先把用户的**意图**写进 SQLite（`committed` 是唯一保存事实）；
2. 再读最新任务 / 规则，尝试同步 OS；
3. 再读系统列表验证实际是否排好；
4. 同步失败不回滚规则，也不改写任务保存结果；界面显示「设置已保存，提醒尚未安排」；
5. 下次启动 / 回到前台 / 任务改动 / 手动重试会重新对账。孤儿规则会被精确清理，遗留通知只按本应用 ID 取消。

因此：**规则已保存 ≠ 系统已排队**，页面分别展示；**系统已排队 ≠ 已送达**，文案不承诺送达。

## 7. 点击通知

用户点击**本应用的任务提醒 / 测试提醒**时，切到「任务」标签并打开对应的**已有任务**详情；只跳详情，不修改任务状态、不标记完成、不打开提醒设置。

- **严格来源**：复用 `parseOwnedReminderNotification` + `parseReminderNotificationPayload`；通知 ID、载荷任务 ID、正式提醒 fingerprint / 测试提醒 triggerAtMs 都必须有效且一致。其它 App / 本 App 其它模块的通知不导航、不写回执。
- **只认系统默认点击**：没有自定义动作；非默认 action 忽略。
- **只传正整数任务 ID**：不解析 URL / 任意路由名，不按标题搜索。路由固定 `Tasks → TaskDetail`，`initial: false` 让冷启动进入详情时任务列表仍在返回栈里。
- **fresh 数据库重查**：通知到达后通过 store 的 `getTaskFresh` 走同一条串行只读队列，直接 `Task::getById` 再重读全量快照；**内存快照里没有不等于已删除**。只有明确查到 `null` 才显示「任务已不在本机」。
- **读失败 ≠ 删除**：查库失败显示可重试错误，不导航、不写已消费回执。任务详情页自己也会在快照缺失时 fresh 重查；读失败显示「暂时读不到」+ 重试，只有明确查不到才显示已删除。
- **不调用 `clearLastNotificationResponse`**：避免把用户刚点的下一条（或别的模块）清掉。改用 `app_settings` 里的有界回执（键 `task_reminder.notification_receipts.v1`，最多 32 条，不新增表 / 不改 schema）。
- **回执 token**：`通知 ID + 展示时间 + 已验证载荷证据（正式 fingerprint / 测试 triggerAtMs） + 动作`。因此 A → B → A 不会重复打开 A；同一稳定 ID 的新日期 / 新载荷会视为新投递。
- **缺展示时间**：不写持久回执（避免永久吞掉未来同一 ID 的通知），只用 5 秒内存窗口去掉「监听器 + last response」的重复事件；窗口过后的新投递仍可打开。内存去重（已交付 / 已消费 / 缺时间窗口）都有 128 条上限，磁盘回执仍有界 32 条。
- **只在导航被接受后写回执**：导航未 ready、导航抛错、任务读失败都不写；回执写入失败会显示「已打开任务，但点击记录保存失败，重启后可能再次提示」。
- **冷启动 / 竞态**：先注册监听再读 `getLastNotificationResponse`；支持异步 cold read。重复 `start()` 会先移除旧监听；旧 generation / dispose 后的异步结果不能提交；较新的 live 点击到达后，延迟的旧 cold 结果被忽略。
- **编辑保护**：`TaskForm / CourseForm / ScheduleForm / NoticeImport / NoticePhoto / BatchNotice / PhotoReview / TaskSteps / TodayPlan / Pressure` 按路由名保守暂缓；`TaskDetail / TaskReminder` 改为**真实草稿感知**（追加原文有字 / 删除确认框 / busy，或提醒设置 dirty / busy）。干净详情页、刚点完测试提醒但没改设置的提醒页可以正常打开；有草稿时只显示非破坏性 banner「先完成当前编辑，离开后自动打开」，**不导航、不 pop、不弹草稿确认、不提供会丢草稿的直达按钮**；用户自己正常返回 / 离开后，controller 才交付排队点击。草稿按真实 route key 登记，卸载清理延迟到微任务，StrictMode cleanup → setup 不瞬时报「干净」。
- **隐藏 Tasks 栈**：即使用户在日历 / 今天 / 课程标签，也会扫描根状态里 **Tasks 栈的所有层级**（不只是当前路由）；即使 TaskForm 被压在 TaskPhotos 下面，也不会被通知导航 pop / 覆盖。没有用重置整个 stack 的方式「解决」。
- **任务已删除**：消费这条本应用点击（写回执），显示「任务已不在本机」，**不打开空详情**；banner 的「返回任务列表」只在非编辑、导航就绪时可用，不会帮用户丢掉别的草稿。
- **测试提醒**：`...v1.test.<taskId>` 同样跳该任务详情；测试提醒不占 32 条提醒上限。
- **导航落地确认**：`navigate` 后等待根状态真的出现目标 `TaskDetail(id)` 才写回执；静默失败 / 落到错误任务显示可重试错误，不写假回执。`TaskDetail` 用 `getId` 按任务 id 分实例，旧详情草稿不会被新任务改写。
- **本机诊断**：提醒设置页显示紧凑摘要（可展开），banner 也显示同一摘要；固定构建标记 `phonefix-20261021-1`。只记状态、页面名、任务编号、目标与回执，不含通知正文 / 原始载荷，不联网、不写库。
- **真机状态**：用户已确认真实手机**收到**通知；点击未正确打开详情，修复后**待同一台手机复测**。代码审查发现「干净详情 / 提醒页被误判编辑中」与「导航未确认就写回执」两个证据-backed 缺陷，但不能据此声称已证实手机失败的唯一原因。

## 8. 验证与真机步骤

本轮（2026-10-19）代码侧验证：

```powershell
cd mobile
node --import ./tests/setup.mjs --test --experimental-test-isolation=none `
  tests/taskReminder.test.mjs tests/taskReminderRepository.test.mjs `
  tests/taskReminderService.test.mjs tests/taskReminderController.test.mjs
node node_modules/typescript/bin/tsc --noEmit
```

- 纯规则 / 真实临时 SQLite / 假通知端口 / 控制器测试 **64/64 PASS**；接线测试 **7/7 PASS**；focused 合计 **71/71 PASS**；受影响既有任务 / 步骤 / 原图 / 通知导入测试 **159/159 PASS**。
- 独立 supervisor oracle（未改动，使用 `mobile/tests/setup.mjs` 解析器）：服务 oracle **7/7 PASS**；原生 trigger oracle **5/5 PASS**；save-truth oracle **1/1 PASS**；second-precision oracle **2/2 PASS**（共 15 项）。
- `tsc --noEmit` **exit 0**（成功时输出可能为空；以 exit code 为准，日志 `.supervision/native-reminders-tsc-early.log`）。
- 测试通知端口是**内存假端口**；没有真机通知硬件验证，也没有声称已送达。
- 依赖：`expo-notifications ~57.0.23`（SDK 57 兼容）。lockfile 新增 4 个包：`badgin@1.2.3`、`expo-application@57.0.3`、`expo-constants@57.0.22`（新的传递依赖；原有直接依赖 57.0.21 保留）、`expo-notifications@57.0.23`；没有删除包。大文本 diff 来自 pnpm 对既有 peer 后缀 `(supports-color@8.1.1)` 的规范化，既有包版本 / 依赖边不变（详见 `.supervision/native-reminders-handoff.md`）。

2026-10-20 点击通知模块（本地代码侧，不是手机验收）：

```powershell
# 在 mobile/；使用固定的 Codex Node
& 'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --import ./tests/setup.mjs --test --experimental-test-isolation=none `
  tests/taskReminderNotificationNavigation.test.mjs `
  tests/taskReminderNotificationReceipts.test.mjs `
  tests/taskReminderNotificationWiring.test.mjs
node node_modules/typescript/bin/tsc --noEmit

# 独立 parser oracle（未修改）
& 'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --experimental-test-isolation=none --import ./mobile/tests/setup.mjs `
  --test .supervision/notification-navigation-parser-review.mjs

# 独立 controller oracle（未修改）
& 'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --experimental-test-isolation=none --import ./mobile/tests/setup.mjs `
  --test .supervision/notification-navigation-controller-review.mjs
```

- 点击路由 / 持久回执 / 接线：**39/39 PASS**（26 控制器 / 解析 / 竞态 + 4 回执仓库 + 9 接线）。
- 既有任务提醒 focused 回归：**71/71 PASS**（`taskReminder*` 五个文件，未改动断言）。
- 独立 parser oracle（未改动）：**3/3 PASS**；独立 controller oracle（未改动）：**5/5 PASS**。日志 `.supervision/notification-navigation-parser-review.log`、`.supervision/notification-navigation-controller-review.log`。
- `tsc --noEmit`：**exit 0**（`.supervision/notification-navigation-tsc.log`）。
- 先前全仓 `mobile/tests/*.test.mjs` 运行 **907/910 PASS**；3 个失败是既有无关测试的陈旧断言（`courseConflictsWiring` / `ddlPressureWiring` 的依赖白名单尚未包含之前已验收的 `expo-notifications`；`noticeImportQueue` 仍匹配旧版 `AppStore` 写法）。按 supervisor 要求，最终修改后**没有重跑全仓**，只跑 targeted + 提醒回归 + tsc + 两个 oracle；未改这些无关测试来绕过。
- 测试用的是假通知 API + 真实临时 SQLite；**没有真机通知送达或点击验收**。Codex 负责 LAN preview / 手机验证。

2026-10-21 手机失败修复（本地代码侧，不是真机点击验收）：

- 用户已确认真实手机**收到**本机通知；点击没有正确打开任务详情。具体是停留原页面、编辑暂缓 banner、还是 Expo Go 回首页 / 错任务，**尚未得到答复**。
- 证据-backed 代码缺陷：旧实现把任意 `TaskDetail` / 聚焦 `TaskReminder` 一律当编辑中（干净页面也被 banner 挡）；旧实现 `navigate` 后立即写回执，即使导航被静默忽略。**不能据此声称已证实手机失败的唯一原因。**
- 修复：草稿感知阻塞、按 task id 的 `TaskDetail` 路由 key、导航落地确认后才写回执、紧凑本机诊断（构建 `phonefix-20261021-1`，不含通知正文 / 原始载荷 / 联网）。

```powershell
# mobile/
& 'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --import ./tests/setup.mjs --test --experimental-test-isolation=none `
  tests/taskReminderNotificationNavigation.test.mjs `
  tests/taskReminderNotificationReceipts.test.mjs `
  tests/taskReminderNotificationWiring.test.mjs `
  tests/taskReminderNotificationPhoneFix.test.mjs
# 53/53 PASS（40 既有 targeted + 13 新真机失败回归）

& 'C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  --import ./tests/setup.mjs --test --experimental-test-isolation=none `
  tests/taskReminder.test.mjs tests/taskReminderRepository.test.mjs `
  tests/taskReminderService.test.mjs tests/taskReminderController.test.mjs `
  tests/taskReminderWiring.test.mjs
# 71/71 PASS（既有提醒回归，未改断言）

node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

- 独立 oracle（均未改动）：parser **3/3**、controller **5/5**、新增 async-navigation **3/3**。
- 日志：`.supervision/notification-phone-fix-tests.log`、`notification-phone-fix-reminder-regression.log`、`notification-phone-fix-oracles.log`、`notification-phone-fix-tsc.log`。
- **没有重跑全仓**；既有 3 个无关陈旧接线断言仍在，不声称全仓绿色。
- **真机点击导航仍待同一台手机复测**；送达确认 ≠ 点击导航验收。

手机手工验收（建议 iOS 真机 / Expo Go）：

1. 打开一条**未来截止**的任务 → 详情 →「提醒设置」。
2. 确认默认是「关闭」，页面没有弹权限。
3. 点「开启提醒」→ 选「提前 30 分钟」→ 保存；允许通知。
4. 页面应显示「系统已排队」；等提醒时刻（或先点「测试提醒」等约 10 秒）检查手机。
5. 回到任务，把 DDL 改早到已经过去 / 标记完成 / 删除；回到提醒页或前台，确认系统通知被取消或解释失效。
6. 到手机系统设置拒绝通知，再保存一条提醒：应显示「设置已保存，提醒尚未安排」，打开系统设置授权后回前台可重试。
7. 关闭 App 重开，确认已保存规则仍在；确认没有自动开启别的任务、没有自动弹权限。
8. 点「测试提醒」约 10 秒后点通知：应切到「任务」并打开对应任务详情；从详情返回应回到任务列表。若仍停留原页面，先看提醒设置页底部的「通知点击诊断」摘要（构建应为 `phonefix-20261021-1`）并报告给复核者。**真机送达已确认，点击导航仍待同一台手机复测。**
9. 杀掉 App，等测试提醒到达后点通知：冷启动应只打开一次详情，没有重复跳转。
10. 删除该任务后再点旧通知：应显示「任务已不在本机」，不打开空详情；「返回任务列表」可用。
11. 在任务表单里输入未保存内容，再点提醒：应只出现「先完成当前编辑」的提示条，不跳走、不丢草稿；正常返回 / 离开后才自动打开目标详情。
12. 在日历标签、但「任务」标签里还压着未保存表单时点提醒：不应把隐藏的任务表单 pop 掉；等离开表单后才交付。
13. 编辑任务详情里的「追加原文」时点另一条提醒：应保守暂缓，不把未追加文本带到别的任务。

## 9. 未完成 / 不声称

- **真机送达已由用户确认**（手机收到测试提醒）；**真机点击通知跳详情的修复仍待同一台手机复测**，尚未验收；iOS bundle 由 supervisor 在接收后执行。
- 未做云推送 / 远程通知 / 智能提前量 / AI 每日计划。
- 未做后台 JS 同步；App 不在运行时无法同步任务改动，已经排好的本机通知仍会按原计划触发。
