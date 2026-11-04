# 原生数据备份与恢复（portable backup / restore）

> 状态：**代码与本机隔离测试完成；尚未在 iPhone 上验收系统「文件」选择器 / 目录保存**。
> 独立复核由 Codex 监督；iOS bundle / 真机验收见 `.supervision/backup-library-handoff.md`。
> 本轮只新增/修改 `mobile/` 与文档，没有改依赖、schema 版本、后端服务或用户真实数据。

## 1. 入口与用户流程

- 「今天」页 →「数据备份」→「打开备份与恢复」。
- 「课程」页 →「数据备份」→「打开备份与恢复」。
- 两个入口都进入同一个原生 `BackupScreen`（路由 `Backup`，分别注册在 Today / Course 栈）。

### 本机备份库（主要流程）

1. 点「创建本机备份」→ **不需要**选择外部目录。应用在
   `Documents/backups/library/` 原子写出
   `ddlmate-library-YYYYMMDD-HHmmss.ddlbackup.json`（同一秒重名时为
   `...ddlbackup-2.json`）。
2. 本机备份库每次从**实际存在的文件**重新发现，并逐份走严格 parser / 图片哈希校验；
   重启 App 后仍可查看。卸载 App 会删除，因此它不是离开设备的备份。
3. 每一行显示时间、大小、计数、校验状态；损坏 / 缺失会明确显示，不会静默跳过或自动删除。
4. 需要离开设备时，对**同一份本机快照**点「保存到「文件」」→ 系统目录选择器。
   外部另存前会重新校验源文件，并使用原子写入；源文件在列表后变坏会明确失败，不会写出
   半成品或从当前数据库重新生成快照。
5. 已有恢复备份（`Documents/backups/ddlmate-recovery-*`）也直接出现在库中，可查看 / 恢复 /
   另存，不需要先导出再选择。

### 只读内容预览

1. 本机备份行点「查看内容」→ 重新复制 / 解析 / 校验该快照，图片从备份字节写入唯一
   `Documents/backup-staging/view-*`；内容来自备份文件，不是当前数据库。
2. 分页浏览（任务 20 条/页、课程 20 条/页、课表 20 条/页、截图 6 张/页）：
   - 任务：标题、截止、状态、关联课程；
   - 课程：名称、教师、学期（不显示内部课程代码 / 选课序号）；
   - 课表：课程、星期、时间、周次（优先使用导入的显式 weekRange，支持不连续周）、教师、地点；
   - 截图：从暂存文件加载，点击全屏放大；不把 base64 放进 React state。
3. 内容页明确写「仅查看，不会替换当前数据」；没有编辑、跳转实时任务 / 课程或恢复按钮。
   返回 / 关闭只清理对应 `view-*`，备份库文件本身不删除。
4. 页面按 view identity 绑定；两个 Today/Course 栈各自的内容页不会互相删除新视图。
   释放按租约延迟，StrictMode 的 setup → cleanup → setup 不会误删当前视图；迟到 open
   在页面卸载或已切标签时只清理自己的 view，不导航隐藏栈。

### 恢复本机快照

1. 本机备份行点「恢复这份备份…」→ 使用该权威本地文件重新走
   `stageBackupForPreview`（大小限制、严格 parser、指纹、通知暂停/恢复、唯一
   `import-*` 暂存），再显示预览 / 替换影响。
2. 「查看内容」只调用内容预览，**绝不**调用恢复管线；恢复必须由用户从预览卡片点击
   「恢复这份备份（替换当前数据）」并在最终确认框再次确认。
3. 最终确认明确写出：恢复是**替换**当前任务 / 课程 / 课表 / 截图库 / 可恢复设置；
   恢复前会先生成当前数据的完整恢复备份，生成失败则不替换；恢复后所有提醒保持关闭，
   需要逐条复核；当前未保存草稿会关闭，导航重建回首页；本机 OCR 地址保留、通知回执不复制；
   空备份会清空当前数据（额外警告）。
4. 恢复成功时导航容器用新的 key **真正重建**，旧页面卸载并收到 onReady 确认后才释放写入闸门。
   如果重建超时，恢复仍算已提交，但闸门保持关闭，界面提供「重试界面重置」。

### 外部 / 以前导出的文件

1. 「选择备份文件并预览」→ 系统**文件**选择器（`File.pickFileAsync({
   mimeTypes: ['*/*'], initialUri? })`，SDK 57 返回 `{ result, canceled }`）。
   以前导出到「文件」的备份需要手动选择一次；应用不会扫描外部目录或猜测旧文件。
2. 选中文件复制到唯一 `import-*` 暂存并严格校验；预览不写数据库。
3. 预览后点「保留到本机备份库」→ 从已校验暂存文件重新 parse，再原子写入库；成功后
   重启仍可查看。预览成功但保留失败会明确报错，不会假装已保存。
4. 取消 / 校验失败不写库、不改数据库、不暂停通知（暂停发生在正式预览前）。

## 2. 单文件格式（version 1）

```json
{
  "format": "ddlmate.native-backup",
  "version": 1,
  "createdAt": "2026-10-22T...",
  "appSchemaVersion": 3,
  "manifest": { "counts": { ... }, "totalImageBytes": 123, "isEmpty": false },
  "integrity": { "algorithm": "sha256", "digest": "..." },
  "data": {
    "tasks": [], "courses": [], "schedules": [], "taskSources": [],
    "images": [{ "id": "img-1", "sha256": "...", "byteLength": 1, "width": 1, "height": 1, "format": "png", "base64": "..." }],
    "attempts": [], "sources": [], "refs": [],
    "ocrResults": [], "ocrCandidates": [], "settings": []
  }
}
```

- 截图字节**真的在文件里**，同一份 SHA-256 只嵌入一次；截图行通过 `imageId` 引用，
  绝不信任导出的绝对路径。
- `integrity.digest` 覆盖所有可恢复数据 + 图片元数据（图片字节本身另有逐张 SHA-256）；
  解析后重算，计数/摘要不一致直接拒绝。
- 顶层 / 各数据段都做**精确字段**校验；未来格式版本或更高 `appSchemaVersion` 明确拒绝，
  不尝试猜字段。

## 3. 包含与不包含

包含：
- 任务（标题 / 说明 / 状态 / 优先级 / 类型 / 预计用时 / 提交要求与方式 / 完成时间）；
- **只到日期的 DDL** 原样保留为 `YYYY-MM-DD`；带时刻的 DDL 原样保留 `+08:00` 与秒精度；
- 原始通知 / 追加原文（`task_sources.raw_text` 逐字保留）；
- 课程（教师 / 学期 / 颜色 / 备注 / 选课序号 / 内部代码）与课表
  （星期、时间、地点、节次、学期首周一、起止教学周、单双周）；
- 所有本地截图尝试、原图字节、识别结果、候选行、截图与课程/课表/任务/尝试的关联；
- `app_settings` 中的教学周校准、每日参考用时、今日计划、每条任务的步骤清单；
- 每条任务的提醒**选择**（提前量、修订号）——恢复时改写为 `enabled:false`、修订号 +1，
  并保留提前量，等待用户复核后重新开启。

不包含（并说明原因）：
- **本机 OCR 服务地址**：这是当前手机/当前 Wi-Fi 的设备设置；恢复时保留当前值，
  不从备份注入地址。
- **已消费通知点击回执 / 旧 OS 通知 ID**：旧设备的投递标识在恢复后没有意义；
  回执在恢复时清空。
- **本机通知路由代次**（`notification.route_generation`）：只在本机递增，恢复事务里 +1；
  绝不从备份导入。
- 任何云端、账号、凭据、第三方数据或网络传输。

## 4. 校验与上限

恢复在写库前完成：
- 文件大小上限检查（绝对路径 / 穿越路径不会被使用）；
- 精确 schema、格式/版本、manifest 计数、内容摘要；
- 各表主键唯一、真实 SQLite 外键（任务的课程、来源的尝试、截图尝试等）存在、重复引用拒绝；
  `screenshot_refs` 的 COURSE / SCHEDULE / TASK 是**多态历史关联**，允许指向已被合法删除的实体，
  不重建、不丢弃；ATTEMPT 目标缺失仍按真坏外键拒绝；
- 任务标题/说明/字段长度、课程规则、课表 `ALL/ODD/EVEN` 与起止周/学期周一；
- DDL 日期精度（裸日期或规范 `+08:00` 秒级）、设置项（教学周自洽、参考用时 1–1440、
  今日计划结构、步骤清单、提醒规则）；
- base64 严格形状、单张大小、解码字节数、PNG/JPEG 头、SHA-256；
- `source_screenshots.archive_rel_path` 只允许安全相对路径（拒绝绝对路径、盘符、
  反斜杠、`..`、空段）；
- 空备份标记与实际计数一致。

| 上限 | 值 |
| --- | --- |
| 单个备份文件 | 96 MiB |
| 内嵌图片合计 | 64 MiB |
| 单张图片 | 25 MiB（沿用截图库归档上限） |
| 唯一图片数 | 300 |
| 任务 / 课程 / 课表 | 20,000 / 5,000 / 50,000 |
| 截图尝试 / 来源 / 关联 | 5,000 / 5,000 / 200,000 |
| OCR 结果 / 候选行 | 20,000 / 400,000 |
| 设置项 | 20,000 |
| 单条文本 / JSON 设置 | 1 MB / 2 MB |

超限会明确拒绝，**不截断、不静默漏掉**。导出时如果某条截图的 `archived_path` 指向的文件
已不存在，会报告并停止导出，而不是生成「看起来完整」的备份。

导出在写出最终文件之前，会用**恢复时同一个 parser**重新解析自己生成的 JSON；自己的格式
如果自己都恢复不了，就不会报告成功，也不会留下文件。

历史 target 缺失本身是合法的（任务 / 课程 / 课表删除时 `screenshot_refs` 被刻意保留）。
恢复事务会把 `tasks` / `courses` / `schedules` 的 `sqlite_sequence` 高水位推到
「恢复出的最大 ID」与「历史 target ID」的较大者；只升不降。这样在新库恢复后，未来新建的
实体不会复用缺失的历史 ID，也就不会把旧截图误挂到无关的新任务 / 课程 / 课表上。
`ATTEMPT` 目标没有历史缺失语义，仍严格拒绝。

## 5. 一致性与失败语义

- 导出 / 预览 / 恢复共享一个 `BackupOperationGate`：双击或并发只能进入一个；
  备份期间普通任务 / 课程 / 通知导入 / 步骤 / 计划 / 提醒保存等写入会被拒绝。
- 导出在 AppStore 公共写队列 + 照片导入队列都排空后读取 SQLite；通知对账在导出期间暂停。
- 恢复：
  1. 先做**无副作用 preflight**（数据指纹、暂存文件大小、重新解析 / 摘要 / 计数）；
     过期预览 / 文件变化 / 坏备份在这里拒绝，**不会先取消旧通知**。
  2. 暂停提醒服务并取消本应用精确命名空间的旧 OS 通知（失败则不开始替换）。
  3. 把每张图写入唯一 `restore-*` 暂存目录并逐张回读校验；再写成应用自己的
     内容寻址文件（同名同内容复用，同名不同内容绝不覆盖，用唯一新名）。
  4. 用当前数据库生成完整**恢复备份**（`Documents/backups/ddlmate-recovery-*.ddlbackup.json`）；
     失败则不进入事务。
  5. 一个 SQLite 事务内删除/重插所有 v3 表 + 可恢复设置；保留当前 OCR 地址；
     通知代次 +1；所有提醒关闭待复核；清空旧回执。
  6. 事务内 `foreign_key_check`、逐表行数、设置 key 集合核对；失败整体回滚。
  7. 提交后重建导航；只有 onReady 带**本次 remount key** 的确认才释放写入闸门。
     提交后刷新失败返回 `committed:true + refreshError`，界面只提供「重新读取」，
     不引导重复破坏性恢复。
- 恢复失败（过期预览 / 图片暂存 / 恢复备份 / 数据库写入）：
  - 数据库与旧照片保持原样；只清理本次唯一 `restore-*` 暂存目录与本次新建的最终文件；
  - 不生成/不声称恢复备份（除已成功生成的外）；
  - 如果旧 OS 通知已经被取消，释放暂停后按**未改变的数据库**重新对账，补回原提醒；
    重新安排失败会附加在错误原因里，不静默吞掉。
- 恢复成功但旧通知取消失败：数据已提交；提醒服务保持暂停，界面提供「重试取消旧提醒」。
- 取消预览 / 离开页面：只清理本次唯一 `import-*` 暂存目录；不接受根目录 / `restore-*` /
  其它会话目录（`discardBackupStaging` 有严格路径守卫）。

## 6. 通知恢复边界（重要）

恢复前已送达 / 仍留在系统里的旧通知，**不能**仅靠取消排队和清回执来防：
用户可能已经点开、或系统在重启后仍投递旧 response。因此：

- 通知载荷新增 `deliveryGeneration`（正式提醒与测试提醒都有；旧载荷缺省按 0）。
- 本机 `app_settings.notification.route_generation` 在每次成功恢复事务里 +1，且不从备份导入。
- 通知 router 在**每次 await 之后**、导航前比较载荷代次与当前代次；不一致就提示
  「这条提醒来自数据恢复之前，已经失效」，不导航、不打开可能被复用的任务 ID。
- 恢复期间通知导航被 `setBackupBusy(true)` 暂缓；恢复提交后 controller 清 pending。
- 只有真实 `restoreEpoch` 变化才 dismiss controller，初次创建 / 无关重渲染不会清掉
  冷启动已经排队的点击。
- 新排程写入当前代次；新通知仍能正常打开任务详情。
- 用户提醒选择恢复后是**明确关闭、待复核**，不会自动猜着重新开启。

## 7. 验证（本轮实际运行）

运行时：`C:/Users/33284/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`，
测试加载器 `mobile/tests/setup.mjs`，`--test-isolation=none`。

```text
tsc --noEmit                                                PASS (0 error)
focused backup suite (8 files)                             31/31 PASS
supervisor library oracle (immutable)                       5/5 PASS
focused reminder regressions (6 files)                      96/96 PASS (先前进度)
focused data-layer regressions (7 files)                   115/115 PASS (先前进度)
supervisor final suite (previous revision)                 12/12 PASS
supervisor tsc                                              exit 0
```

日志：
- `.supervision/backup-library-tests.log`
- `.supervision/backup-library-tsc.log`
- `.supervision/backup-library-focused-backup-tests.log`
- `.supervision/backup-library-ui-gate.log`
- `.supervision/backup-library-review-rerun.log`
- `.supervision/backup-direct-preview-tsc.log`
- `.supervision/backup-direct-preview-tests.log`
- `.supervision/backup-direct-preview-regression.log`
- `.supervision/native-backup-tsc-final.log`
- `.supervision/native-backup-final-focused-tests.log`
- `.supervision/native-backup-historical-tests.log`
- `.supervision/native-backup-supervisor-final.log`
- `.supervision/native-backup-supervisor-tsc.log`
- `.supervision/native-backup-roundtrip-tests.log`
- `.supervision/native-backup-failure-tests.log`
- `.supervision/native-backup-notification-tests.log`
- `.supervision/native-backup-router-tests.log`
- `.supervision/native-backup-ui-gate-tests.log`
- `.supervision/native-backup-focused-reminder-regressions.log`
- `.supervision/native-backup-focused-data-regressions.log`

测试只用**系统临时目录里的真实 SQLite 文件和图片**，没有读取/写入用户真实手机数据库或照片。
覆盖点：逐字段往返、原始文本、日期 DDL、秒级 DDL、ALL/ODD/EVEN、教师/选课序号、图片字节
相等、截图 refs、步骤/计划/校准/参考用时、恢复备份、空备份、取消、过期预览、数据库
删除后插入失败回滚、图片暂存失败、恢复备份写入失败、提交后刷新失败、坏版本/重复/坏外键/
路径穿越/坏图片/超限、暂存目录根守卫、部分取消后重新对账、旧代次点击拒绝、新代次点击打开、
闸门双击、remount ready key、controller 初次不 dismiss。

## 8. 限制 / 未声称

- **未在 iPhone 真机上测试系统「文件」目录/文件选择器、security-scoped / SAF 写入**；
  也未做 iOS bundle（由 Codex 监督）。不能声称真机可用。
- 「预览刚导出的备份」只依赖本会话内存中的成功导出元数据；强制关闭 / 重启后不存在。
  如果文件被移动、删除或访问权限过期，会明确失败并要求手动选择；不会扫描 Files。
- 只支持 PNG / JPEG 截图（与既有截图库一致）；HEIC 仍走既有拒绝路径。
- 备份/恢复上限见 §4；接近上限时内存占用较高，超限会明确失败。
- 恢复是单机替换，不做合并、不保留恢复后的旧任务（恢复前的完整数据在恢复备份里）。
- 恢复会关闭未保存草稿并重建导航；这是最终确认里明确警告的行为。
- 没有云、服务器、账号、远程推送或第三方传输。
