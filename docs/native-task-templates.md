# 原生任务模板与重复任务

本轮原生版本新增「任务模板」与「重复任务（按规则批量创建）」。两者都只写入本机
SQLite，不联网、不依赖新依赖、不创建后台定时任务。

> 状态：代码与自动化测试已完成，**尚未做真机 / iOS Bundle 验收**。真机、Bundle 与
> 二维码由 Codex 在最终独立检查阶段处理；本文只记录实际实现、实际测试结果与验收步骤。

## 功能范围

### 任务模板

- 入口：任务列表「任务模板」、今天页「任务模板与重复任务」、任务详情「存为模板 / 任务模板」。
- 从现有任务保存为模板时，按**显式勾选**复制：
  标题、说明、任务类型、优先级、预计用时、提交要求、提交方式、所属课程。
- **不复制**：截止时间、完成状态 / 完成时间、创建/更新时间、原始通知文本、通知规则、
  截图或任务原图关联。
- 空白的预计用时保存为 `null`，应用模板后表单仍留空；不会补 `0` 或默认分钟。
- 应用模板只会生成一份**可编辑的 TaskForm 草稿**（状态固定 `TODO`、截止时间留空），
  只有用户再点「创建任务」才会写入；绝不修改源任务。
- 模板原关联课程已不存在时，草稿的「所属课程」留空并显示复核提示，
  不会静默挂到别的课程上。
- 模板支持新建 / 编辑 / 删除；删除前二次确认，已有任务不受影响。
- 编辑模板采用**单调 `revision`**（每次 +1），同毫秒编辑也能让旧预览失效；
  没有 `revision` 的旧模板记录按 1 读取。
- 模板保存 / 任务保存 / 规则生成都使用同步 `submissionGuard` ref 与 disabled/loading
  状态双重防重：React 重新渲染前连续两次点击也只允许一次写入，`finally` 释放；
  成功后的短窗口再由 success ref 拒绝迟到提交。

### 重复任务

- 频率：每天，或每周多选周几（`周一`…`周日`）。
- 开始 / 结束日期都是北京时间自然日，**首尾都包含**；上限 90 天、100 个候选任务。
- 时间可选：留空表示每条任务按**裸日期**截止（当天结束前），不会强补 `23:59` / `00:00`；
  填写时间后按北京时间精确到分钟入库（`+08:00`）。
- 流程固定为：填写规则 →「预览实际日期与任务」→ 显式确认「按规则批量创建」。
- 本版本**只做用户确认后的有限批量创建**；没有后台任务、没有通知调度，
  应用关闭后不会自动生成任何任务。界面文案明确写「先预览再创建 / 按规则批量创建」。
- **零新日期也能保存规则修改**：已有规则的所有日期都创建 / 删除后，预览仍会显示
  「只保存规则（创建 0 条任务）」；它走同一个事务和指纹校验，只保存规则内容，
  不创建任务、不修改已有任务、不重建已删除日期。
- 每条生成的任务都是独立可编辑任务，初始 `TODO`，不创建提醒设置。
- 规则、任务、生成账本在**同一个 SQLite 事务**里写入；任何一步失败整体回滚。
- 去重身份是持久化账本 `(规则ID, 日期)`：
  - 同一份已确认预览重复提交会被事务内指纹 / `nextRuleId` 令牌拒绝；
  - 重新打开后预览会显示「已创建」；
  - 用户删掉某次任务后，账本保留历史，再生成会显示「已删除（不会重建）」并跳过；
  - 不同规则可以合法地拥有相同标题 / 相同日期（不按标题哈希全局去重）。
- 修改规则内容、来源模板 revision、课程是否存在、规则 revision 都会让旧预览失效；
  生成时在事务内部重新校验。新建规则额外使用持久化的 `nextRuleId` 作为一次性确认令牌。
- 删除规则 / 模板不会删除任何已创建任务；删除规则会同时删除该规则的账本。

## 存储与备份

- 复用既有 `app_settings` 键值表，**没有改变数据库版本（仍为 3）**，没有破坏性迁移：
  - `task_templates.v1`：`{version:1,nextId,templates:[...]}`
  - `task_recurrence.v1`：`{version:1,nextRuleId,rules:[...],ledger:[...]}`
- 上限（读回时严格校验，绝不静默截断）：
  - 模板最多 100 个，序列化 ≤ 1.5 MB；
  - 规则最多 40 条、账本最多 4000 条，序列化 ≤ 1.5 MB；
  - 单规则范围 ≤ 90 个自然日、候选 ≤ 100。
- 两个键都进入现有 v1 备份的严格设置白名单，导出 / 预览 / 恢复都会包含；
  旧备份没有这两个键时按“没有模板 / 规则”读取，仍可正常恢复。
- 恢复时账本里的历史任务 id、模板 / 规则里的历史课程 id 会参与 AUTOINCREMENT
  高水位计算，防止恢复后新实体复用旧 id、把历史引用错误指向新任务 / 新课程。
- 备份 / 恢复继续使用既有写入闸门、恢复代次与导航 remount 保护；
  恢复后模板 / 规则随整库替换，旧页面会随根导航重建卸载。

## 实际改动的文件

新增：

- `mobile/src/domain/taskTemplate.ts`
- `mobile/src/domain/recurrence.ts`
- `mobile/src/domain/taskTemplateRepository.ts`
- `mobile/src/domain/submissionGuard.ts`
- `mobile/src/screens/TaskTemplateListScreen.tsx`
- `mobile/src/screens/TaskTemplateFormScreen.tsx`
- `mobile/src/screens/RecurrenceScreen.tsx`
- `mobile/tests/taskTemplates.test.mjs`
- `mobile/tests/recurrence.test.mjs`
- `mobile/tests/taskTemplatesBackup.test.mjs`
- `mobile/tests/taskTemplatesWiring.test.mjs`
- `mobile/tests/submissionGuard.test.mjs`

修改：

- `mobile/src/db/schema.ts` — 两个版本化设置键；`SCHEMA_VERSION` 仍为 3。
- `mobile/src/domain/taskRepository.ts` — 抽出 `createWithinTransaction()`，供重复任务在
  已有事务内复用规范任务创建 / 原文写入，不嵌套事务。
- `mobile/src/domain/backupFormat.ts` — 新设置键的严格解码与白名单；旧备份兼容。
- `mobile/src/domain/backupService.ts` — 恢复高水位与恢复提示。
- `mobile/src/store/AppStore.tsx` — 快照与 `taskTemplates` store API（创建 / 更新 / 删除 /
  存为模板 / 应用 / 预览 / 生成 / 删规则），全部复用既有串行写队列与备份闸门。
- `mobile/src/navigation/types.ts` — 两个栈的模板 / 规则 / TaskForm `templateId` 路由。
- `mobile/src/navigation/RootNavigator.tsx` — 三个新屏在任务栈与今天栈的注册。
- `mobile/src/screens/TaskFormScreen.tsx` — 模板一次性 hydration、模板警告、
  模板草稿离开确认；保存成功不会被离开守卫拦截。
- `mobile/src/screens/TaskListScreen.tsx` / `TaskDetailScreen.tsx` / `TodayScreen.tsx` — 入口。
- `mobile/src/ui/components.tsx` — 原生多选按钮组（周几 / 模板字段，44pt、checkbox 无障碍）。
- `.supervision/task-templates-review.log` — 不可变验收脚本实际输出。
- `.supervision/task-templates-handoff.md` — 最终交接。

回滚快照（仍保留）：`.supervision/task-templates-before-20261026-123350`。

## 实际测试命令与结果

环境：Windows sandbox；固定 Node
`C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。
由于本 sandbox 默认测试 runner 的子进程管道会 `EPERM`，统一加
`--experimental-test-isolation=none`。

1. 不可变监管验收（只读，未修改）：

```powershell
# 项目根目录
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  --experimental-test-isolation=none --import ./mobile/tests/setup.mjs `
  --test .supervision/task-templates-review.mjs
# tests 3 / pass 3 / fail 0 / exit 0
```

2. 本轮新增的模板 / 重复 / 备份 / 接线测试：

```powershell
# mobile 目录
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  --experimental-test-isolation=none --import ./tests/setup.mjs `
  --test tests/taskTemplates.test.mjs tests/recurrence.test.mjs `
         tests/taskTemplatesBackup.test.mjs tests/taskTemplatesWiring.test.mjs `
         tests/submissionGuard.test.mjs
# tests 38 / pass 38 / fail 0 / exit 0
```

3. 受影响回归（任务仓库、备份往返、通知导航）：

```powershell
# mobile 目录
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  --experimental-test-isolation=none --import ./tests/setup.mjs `
  --test tests/repository.test.mjs tests/backupRoundtrip.test.mjs `
         tests/taskReminderNotificationNavigation.test.mjs
# tests 70 / pass 70 / fail 0 / exit 0
```

（更早一次“新测试 + 这些回归”合并运行是 101/101；新增精确时刻用例后，
最终分别记录为 38/38 与 70/70，未再合并运行。）

4. 备份失败 / 历史引用 / UI 闸门聚焦回归：

```powershell
# mobile 目录
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  --experimental-test-isolation=none --import ./tests/setup.mjs `
  --test tests/backupFailure.test.mjs tests/backupHistoricalRefs.test.mjs tests/backupUiGate.test.mjs
# tests 14 / pass 14 / fail 0 / exit 0
```

5. TypeScript：

```powershell
# mobile 目录
& "C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  .\node_modules\typescript\bin\tsc --noEmit
# exit 0
```

没有跑整套历史测试；按授权只跑了受影响的回归。

实际退出日志保存在：
`.supervision/task-templates-review.log`、
`.supervision/task-templates-final-focused.log`、
`.supervision/task-templates-final-regressions.log`、
`.supervision/task-templates-final-tsc.log`。

## 已知限制 / 刻意取舍

- **没有后台生成**：关闭 App 后不会自动创建任务。以后需要更多，必须重新预览并确认。
- 规则内容在“用模板填入”时是**快照**；之后编辑模板只影响未来显式应用模板的新任务，
  不会回写既有规则或既有任务。规则上仍记录来源模板 id 供说明。
- 模板课程缺失时：应用模板留空并提示复核；重复规则生成会被阻断，直到用户重新选择课程。
- 模板 / 规则 / 账本存在 `app_settings` JSON，受上述上限约束；达到上限会给出可读错误，
  不会静默截断或重置。
- 恢复旧备份（没有新键）会按旧数据恢复：模板 / 规则 / 账本为空，这是备份内容本身如此。
- 本功能未触碰既有的“备份只导入截图”未解问题，也没有宣称修复它。
- 没有新增依赖、没有改 lockfile / Metro / SDK，没有 service / 网络 / LLM / 通知定时任务。

## 真机验收清单（Codex 最终阶段）

1. 任务列表 →「任务模板」；任务详情 →「存为模板」；保存后源任务逐字段不变。
2. 应用模板 → 草稿可编辑；空白分钟仍空白；缺失课程提示复核且课程留空；显式保存才建任务。
3. 模板编辑 / 删除：确认框；已有任务保留；同毫秒编辑后旧预览不生效（自动化已覆盖）。
4. 重复规则：每天 / 每周多选周几，开始/结束日期用现有日期滚轮，首尾包含；
   可选时间用现有时间滚轮；留空为裸日期。
5. 预览列表显示实际日期、可创建 / 已创建 / 已删除（不会重建）/ 已跳过；
   确认后一次性创建；重复点按 / 重开不会重复。
6. 删除一条生成的任务 → 重新预览 / 生成：该日期显示已删除且不重建。
7. 已有规则全部日期都已创建 / 删除 → 编辑名称 / 标题 / 时间 → 预览 →「只保存规则
   （创建 0 条任务）」：规则更新、已有任务不变、已删除日期仍不存在。
8. 连续快速点保存 / 批量创建：只发生一次写入（同步 guard；真机复核）。
9. 删除规则 / 模板：任务全部保留；确认文案清楚。
10. 小屏 + 安全区 + 返回手势 / 返回键；有草稿离开时确认；按钮不重复提交。
11. 备份导出包含模板 / 规则 / 账本；恢复后仍在；旧备份可恢复；恢复后根导航重建。

## 备注

- 模板与规则的标识来自版本化 JSON 内单调分配的 id；账本与任务的关联在恢复时按
  备份中的任务 id 保留，并通过 SQLite 高水位避免复用。
- 本文件不声明任何 App Store 版本号或发布日期。
