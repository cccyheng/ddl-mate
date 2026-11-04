# 批量识别通知截图（原生）

一次从相册选最多 **8 张**通知截图，先逐张保存原图，再由用户显式点「识别待处理图片」，
按顺序在本机电脑上识别文字；每张图的文字单独可改、单独打开既有的「通知转待办」核对页。
任务只在那个核对页里由用户核对并保存，本模块**不写任何任务**。

## 从哪里进

- 「任务」标签页 →「批量识别通知」；
- 路由名 `BatchNotice`（`TaskStackParamList`，参数 `undefined`）；
- 既有的「截图转待办」（单张）与「通知转待办」（粘贴原文）入口保持不变。

## 使用流程

1. **选一批**：从相册多选，`allowsMultipleSelection: true`、`selectionLimit: 8`、
   `orderedSelection: true`。选完立刻按顺序把原图保存到既有截图库，**不会自动识别**。
   - 一次最多 8 张。系统若返回超过 8 张，整次选择都拒绝并显示「你一次选择了 N 张，超过上限 8 张」，
     绝不静默截断或丢弃多出来的图。
   - 相册取消、权限拒绝、系统没返回某一张内容：上一批保持原样，不会改动已有队列。
   - 已有队列时重新选图必须先明确确认；确认后旧队列（含识别结果与手改文字）才会被替换。
2. **显式识别**：点「识别待处理图片」后，按 `pending` / `failed` / `cancelled` 的顺序一张一张识别，
   同一时刻只有一个本机 OCR 请求。识别成功的图不会被整轮识别重新 OCR。
   - 进度是真实张数：`正在识别第 2/5 张…`、`已完成 3 张`、`待处理 2 张`，没有假百分比。
   - 一张失败不会中断后面的图；失败的图保留错误信息，可以单张重试。
3. **停止 / 离开**：识别中可「停止这一轮」。停止会 abort 当前请求并停止推进；
   已完成结果与手改文字保留。离开页面 / 换批会先确认，确认后队列丢失（原图已保存的仍在截图库）。
4. **逐张核对**：展开某一张 → 可改文字、查看原图（复用 `ScreenshotViewer`）→
   「核对这张图的待办」会用 `navigation.push` 打开一个**全新**的既有 `NoticeImport`，
   路由参数 `{ initialSourceText: 精确文字 }`。返回后队列与结果仍在。
   - 文字逐字传入：不 trim、不截断；空文字或超过 10000 字禁止进入核对页。
   - 本页状态只会显示「已打开核对」，并提示「任务是否保存，以通知核对页显示的结果为准」；
     没有导入反馈，绝不显示「已导入 / 已保存任务」。
5. **单张重试**：只有 `failed` / `cancelled` / `empty` 可以单张重试。
   若这张图已有非空手改文字，先确认才会替换；成功归档的同一张图复用原归档，不重复保存。
6. **归档失败**：原图没保存成功会单独显示原因与「重试保存原图」，不会说成已保存；
   归档失败与识别失败是两件独立的事，识别成功也不会改写归档失败。

## 原图、任务与关联

- 原图属于**全局截图库**；保存成功后关掉页面仍然能在截图库查看。批量页不删除任何照片。
- 队列与识别结果只在**当前页面会话**内保留；离开 / 换批后需要重新选择与识别。
- 每张图各自进入一次 `NoticeImport`；不会把所有图合并成一份超大原文。
- `NoticeImport` 仍是唯一任务写入方。批量控制器没有任务仓库依赖，
  不会自动勾选、自动保存或自动写任务。
- 本页不会自动把图片关联到任务。需要图片与任务的关联时，仍走任务详情的「任务原图」手动关联。

## 控制器 API（不依赖 React / Expo）

`mobile/src/screens/batchNoticeController.ts`：

```ts
createBatchNoticeOperation(deps) → BatchNoticeOperation

getState() / subscribe(listener)          // 只读状态与订阅
requestPick({ confirmReplace? })          // 选一批（最多 8 张），只归档不识别
retryArchive(itemId)                      // 重试某一张归档失败的原图，不触发 OCR
startRun({ confirmReplace? })             // 顺序识别 pending / failed / cancelled
retryItem(itemId, { confirmReplace? })    // 单张重试 failed / cancelled / empty
cancel()                                  // abort 当前并停止推进
setText(itemId, value)                    // 逐张编辑文字
adoptText(itemId)                         // 返回逐字文字；不写任务
focus()                                   // 从子页面返回，重新允许采用
activate() / dispose()                    // React setup / cleanup，不重放任何动作
```

状态里的每项包含：`id`、`index`、`uri` / `source`、`archiveStatus`（`pending` / `archiving` /
`archived` / `failed`）、`archivedAttemptId` / `archivedUri` / `archiveError`、`status`
（`pending` / `running` / `success` / `empty` / `failed` / `cancelled`）、`rawText`、`text`、
`requestId`、`image`、`ocrMs`、`warnings`、`error`、`historyError`、`reviewOpened`。

运行纪律：

- **同步 busy 闸门**覆盖选图、归档、准备 + 整轮识别、采用；同一帧双击只发一次。
- 每轮有递增 generation；取消 / 换批 / `dispose` 会 abort 当前请求，迟到的结果只能被忽略。
- 旧一轮的 `finally` 只在仍是当前轮时清 busy，不会放掉新一轮的闸门。
- **归档文件写入无法 abort**：`dispose` / `activate` 期间用独立的队列身份（`queueToken`）继续对账；
  真正落盘成功就写回 `archived` / attemptId，失败则如实 `failed`，不重放、不重复归档。
  只有换了一批图才会变队列身份，旧归档结果绝不写进新队列。
- 归档成功后**优先**通过可选的 `resolveArchivedPath`（界面上是只读
  `store.screenshotLibrary.getAttempt`）读回真实的 `archivedPath`；读不到才退回归档端口
  自己报的 `archivedUri`。两者都没有就留空，查看器明确标成临时预览，
  绝不把相册临时 URI 冒充成已保存原图。
- 识别成功后**先**写入状态与文字，再登记截图库历史；历史写入失败只单独显示
  「识别结果已经保留，但截图库历史没有写进去」，不会把结论改成失败、不会清空文字。
- 停止只给**真正在途的 OCR** 记 `CANCELLED`；识别已经成功、只是历史还在写时，
  停止只负责不再推进下一张，不会给成功项补一条假的取消历史。
- 历史登记只写通知 OCR 真实字段（`rawText` / `requestId` / `durationMs` / `image` / `warnings`），
  不伪造课表 `layout` / `week` / `candidates` / `payload`。

## 范围与限制

- 最多 **8 张 / 批**；单张文字最多 **10000 字**（与既有通知原文上限一致），不截断。
- 只有相册多选，没有相机；不支持追加、重排或删除队列中的子集。
- 一次只识别一张；没有并发 OCR、没有离线 OCR、没有第三方上传。
- 不新增依赖、不改 DB schema、不改伴侣服务 / 后端 API、不重启服务。
- 没有真机验证结论；本模块只在 Node 测试与 TypeScript 检查层面验证。

## 验证

命令（`mobile/` 下）：

```powershell
node --import ./tests/setup.mjs --test --experimental-test-isolation=none `
  tests/batchNoticeController.test.mjs tests/batchNoticeWiring.test.mjs `
  tests/batchNoticeIntegration.test.mjs

node node_modules/typescript/bin/tsc --noEmit
```

- `batchNoticeController.test.mjs`：24 项。顺序识别 / 中间失败 / 取消 / 迟到结果 /
  双击闸门 / 归档失败与重试 / 超 8 张 / 采用边界 / 历史写失败 / dispose→activate 等。
- `batchNoticeWiring.test.mjs`：12 项。入口、路由、picker 配置、逐张 push、设置栈、
  历史字段、生命周期、文案与文档存在性。
- `batchNoticeIntegration.test.mjs`：1 项。真实夹具 `notice-01-homework.png` 与
  `notice-02-chat-time.png` → 实际批量控制器 → 真实本机 HTTP/Tesseract
  → 逐张既有解析器 → 隔离 SQLite 导入 → 完整原文读回；夹具 01 截止时间为
  10 月 20 日 22:00，夹具 02 的消息时间不会变成 DDL。归档 / 相册端口是测试替身
  （登记隔离 SQLite、字节来自真实夹具），OCR 引擎与仓库是真实的。
- 本次同时回归的既有文件：`noticeOcrClient`、`noticePhotoController`、`noticePhotoWiring`、
  `noticeImport`、`noticeImportRepository`、`noticeImportState`、`screenshotArchiveDisk`、
  `taskPhotosWiring`。合计 133 项 focused tests；结果与日志见
  `.supervision/native-batch-notices-tests.log`。
