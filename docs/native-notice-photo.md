# 原生端「截图转待办」：一张通知截图 → 本机电脑 OCR → 核对文字 → 既有任务保存

> 工作区：`C:\Users\33284\OneDrive\文档\ChatGPT\大学生ddl`
> 实现：DeepSeek · 独立复核：Codex · 状态：**实现并自测完成，等待复核 / 部署**
> 授权范围：`.supervision/native-notice-photo-assignment.md`
> 复核意见：`.supervision/native-notice-photo-review.md`
> 交接记录：`.supervision/native-notice-photo-handoff.md`

这是 iOS 原生端（Expo / React Native）的**单张**通知截图流程：在任务页选一张截图 →
先原样存进截图库 → 在你自己的电脑上用**本机 Tesseract** 识别成文字 → 在手机上改文字 →
点「使用这段文字」打开**新的**通知核对页 → 由既有的「通知转待办」流程逐条勾选、保存。

**不是批量，不是 AI 语义理解，不是云端 OCR**：图片只发到同一 Wi-Fi 下的本机电脑，
不经过任何第三方；OCR 与文字采用全程**不写任务**，只有既有核对页的「保存」才写库。

---

## 1. 入口与完整流程

入口在**任务页**：任务列表上方的「**截图转待办**」按钮（任务栈内新页面「截图转待办」）。

1. **选一张截图**（相册或相机）。选完**不会自动识别**。
   - 选到的原图会**先**通过既有 `store.archiveOriginal` 原样归档进截图库；
   - 归档用既有 `screenshot_attempts`，来源是 `LIBRARY` / `CAMERA`，**没有新增表 / 列 / 迁移**；
   - 归档失败会在页面上如实显示原因，并提供「重试保存原图」；**没成功就不说已保存**。
2. 确认页面上的电脑地址（手机与电脑同一 Wi-Fi）。没有地址时，右上角「识别服务设置」
   会跳到课程栈里既有的设置页；「打开截图库」同理跳到既有的截图库页。
3. 点「**识别文字**」才会发请求。页面显示：
   - 纯文字进度（正在保存原图 / 正在准备图片 / 电脑正在识别），**没有假百分比**；
   - 可取消（准备 / 识别阶段）、失败后可重试；
   - 服务返回的 `requestId`（没有开启本地诊断时，电脑也会给通知请求一个关联号）；
   - 图片尺寸 / 格式 / 字节数 / 耗时（只用于核对，不参与业务判断）。
4. 识别成功后，文字进入**可编辑输入框**。可以增删改；原文超过 10000 字时：
   - 明确显示当前字数与上限；
   - 要求**手动删减，或分成两次识别 / 导入**；
   - 「使用这段文字」禁用，**绝不静默截断**。
5. 点「**使用这段文字**」会用 `navigation.push('NoticeImport', { initialSourceText })`
   打开一个**全新的**通知核对页；当前页面上的文字不会被清空，返回后仍在。
   - 路由参数只传可序列化的字符串，传的是**完整 reviewed text**（已通过 10000 字校验）；
   - 不会覆盖用户已经打开的另一个 NoticeImport 草稿。
6. 在通知核对页里，既有的「提取任务 → 勾选 → 保存」是**唯一**写任务的入口。
   本流程不自动保存、不自动勾选、不自动写任何任务。

### 换图 / 重试时的文字保护

- 输入框里已经有文字时，换图或重新识别会先弹确认框；
- **确认之前**原文字原样保留，取消确认不会改动任何内容；
- 选择器被用户取消、权限被拒、读取失败：什么都不替换，原图 / 文字 / 归档状态保持；
- 识别失败 / 超时 / 断网：已选图片与已改文字都保留，可以直接重试；
- 识别期间如果用户通过硬件键盘 / 无障碍输入又改了文字，OCR 成功返回时**保留用户当前草稿**，
  原始 OCR 结果单独记在 `recognizedText` 与截图库历史里，不会覆盖用户的字。

---

## 2. 数据落在哪里（事实边界）

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 原始截图字节 | 既有截图库（应用私有 `Documents/screenshots`） | 识别**之前**归档，不缩小、不裁剪；内容寻址，同一张图只存一份字节 |
| OCR 结果 / 状态 | 既有 `screenshot_attempts` + `ocr_results` | 通过既有 `recordScreenshotResult` 记录；通知路径不伪造课表 `layout / week / candidates / payload` |
| 用户核对后的文字 | 既有 `task_sources`（保存任务时） | 用户在通知核对页真正采用 / 保存的那份文字；完整保留 |
| 任务 | 既有 `tasks` | 仍然只由通知核对页的「保存勾选」写入 |

### 2.1 原始 OCR 文字 vs 用户核对后的文字

- 截图库历史里记录的是**这次 OCR 的结果**（`rawText`、成功 / 失败 / 取消状态、
  `requestId`、耗时、图片元数据）。它按既有截图库的字段口径保存，不代表用户最终采用的文字。
- 任务来源（`task_sources`）记录的是**用户核对后实际采用**的完整文字。
- 两者不是同一个东西：OCR 可能有错、可能把一段需求拆成两条候选，用户改过之后再保存，
  任务来源就是改过的那份。

### 2.2 本轮**没有**做的事

- **没有**把原图逐条挂到每个任务上。截图只保留在**全局截图库**；
  任务只保留核对后的文字。既有 `screenshot_refs` 虽然支持 `TASK`，
  但这轮有意不新增关联，也不声称「每张任务都能追溯到自己那张原图」。
- 没有新增数据库表 / 列 / 迁移，没有新增依赖，没有改 Metro / Expo 配置。
- 没有还原图到每个任务的附件，也没有删除入口。

---

## 3. 电脑端接口：`POST /v1/ocr/notice`

### 请求

```json
{ "imageBase64": "..." }
```

### 成功响应

```json
{
  "ok": true,
  "rawText": "按阅读顺序保留换行的纯文字",
  "requestId": "notice-...",
  "image": { "width": 1080, "height": 1920, "format": "png", "bytes": 123456 },
  "warnings": [],
  "ms": 812,
  "empty": false
}
```

- `rawText` 是**字符串**；图里确实没字时是空串，并附 `empty: true` 与明确提示。
- **不做课表解析**，也不因为「只读到标题 / 时间栏」而拒绝；通知本来就是一段文字。
- 行顺序按 Tesseract 的阅读顺序保留，只清理行尾空白与首尾空行，不重排、不合并行。
- PSM 用 6（一整块均匀文本）；如果 6 什么都没读到，再用 PSM 3（自动版面）兜底一次，
  仍为空就如实返回空，**不伪造候选**。
- 引擎返回的 `rawText` 不是字符串时，服务端返回 500 `OCR_FAILED`，**不会强转成空串成功**。
- 请求在引擎启动前 / 引擎返回后都会独立检查 `signal.aborted`；
  被取消 / 超时的请求返回非 2xx（本服务用 499），不会变成 200 成功，容量也只在引擎真正结束后释放。

### 共用的边界

- 与课表路由**共用**：`MAX_CONCURRENT = 2`、`REQUEST_TIMEOUT_MS`（默认 180s）、
  `MAX_BODY_BYTES`、PNG / JPEG 解码校验、客户端断开取消、请求号。
- `GET /v1/health` 新增 `noticeOcr: true`；旧版伴侣服务没有这个接口时，手机端会提示
  「电脑上的识别服务版本较旧，需要更新」，而不是笼统的 404。
- 普通日志只记尺寸 / 字数 / 耗时，**不打印通知正文**；本地诊断目录仍遵循既有显式开启策略。

### 手机端客户端

`mobile/src/domain/noticeOcrClient.ts` 与 `photoOcrClient.ts` 共用端点规范化、取消、超时、
HTTP 错误语义。额外保证：

- 响应必须 `ok === true` 且 `rawText` 是字符串；`ok:false` / 对象 / 数字一律拒绝；
- 取消与超时竞速覆盖**整个 fetch + response.json 解码**，不是只保护 fetch；
- 外部取消映射 `CANCELLED`，内部截止时间映射 `TIMEOUT`；清理计时器、轮询与 abort 监听；
- 只访问用户配置的本机地址，没有第三方请求。

---

## 4. 生命周期（可单测，不依赖 React）

实现：`mobile/src/screens/noticePhotoController.ts`。

- 每轮有递增 `generation` 与自己的 `AbortController`；取消 / 换图 / 卸载后迟到的结果
  只可能记历史，不会更新当前尝试 / 状态；
- 选择、归档、准备、OCR、采用文字之前都有**同步 busy 闸门**，连点不会发起两次；
- 归档成功的结果会保留；同一张图重试 OCR 不会再归档一份；
- 归档失败可以重试；识别内部重试归档时，**busy 不会在 preparePhoto 等待期间被提前放开**；
- 文字非空时，换图 / 重新识别必须显式确认；取消确认不丢草稿；
- 采用文字有一次性闸门，回到页面后重新可用；打开子核对页**不会**清空已采用的完整文字；
- 离开页面有未保存文字（或正在识别）时拦截并明确说明；
- 没有自动保存、没有假进度。

---

## 5. 已知限制（诚实声明）

1. **没有真机验证**：所有结论来自 Node 真实后端 / 真实 SQLite / 真实 Tesseract 与类型检查。
   Expo Go 上的系统相册 / 相机弹窗、原生返回手势、真机文件持久化仍需设备确认；
   本轮没有启动 Metro / Expo，也不声称真机通过。
2. **真实 OCR 不是完美的**：复用既有合成夹具
   `frontend/public/samples/notices/notice-01-homework.png` 与 `notice-02-chat-time.png`
   做真实 Tesseract / HTTP 验证。`notice-01` 实际会解析出 **2 条候选**
   （完整截止时间一条，「提交要求」可能单独一条），需要用户在核对页**手动勾选 / 取消**；
   同一次 OCR 还会把「学习通」拆成「学习\n通」两行。这些是真实识别结果，
   **没有修改夹具去迁就识别错误**，也不声称真实聊天记录的准确率。
3. **只做单张**：没有批量选图、没有队列、没有 LLM、没有云端。
4. **没有逐任务原图关联**：原图只在全局截图库；任务只保留核对后的文字。
5. **截图库历史的 rawText 沿用既有仓库的保存口径**；任务来源保存的是用户采用的那份完整文字。
6. **相机是可选路径**：相册与相机都走既有 `expo-image-picker` 模式；权限被拒有中文提示。

---

## 6. 验证与证据

固定 Node：`C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`

| 项目 | 结果 | 日志 |
| --- | --- | --- |
| 受影响原生测试（通知导入 / 解析器 / 仓库 / 状态 / 照片 / 运行时 / 导航接线等，显式文件） | **209 / 209 通过** | `.supervision/native-notice-photo-mobile-tests.log` |
| `tsc --noEmit` | **0 error**（exit 0） | `.supervision/native-notice-photo-tsc.log` |
| 客户端独立复核 oracle（未改） | **5 / 5 PASS** | `.supervision/native-notice-photo-client-oracle.log` |
| 运行时独立复核 oracle（未改） | **3 / 3 PASS** | `.supervision/native-notice-photo-runtime-oracle.log` |
| 真实 OCR oracle（通知 01/02，未改） | **PASS**：01 `["2026-10-20T22:00",""]` 2 条 / 2 条入库；02 `[""]` 1 条 | `.supervision/native-notice-photo-real-oracle.log` |
| 伴侣服务相关测试（显式文件） | **64 / 65 通过，1 项环境跳过**（符号链接 EPERM，0 失败） | `.supervision/native-notice-photo-companion-tests.log` |
| 真实 OCR → 解析器 → SQLite 导入 → 关库重开 | **2 / 2 通过** | `.supervision/native-notice-photo-e2e.log` |

真实夹具（未修改）：

- `frontend/public/samples/notices/notice-01-homework.png`
- `frontend/public/samples/notices/notice-02-chat-time.png`
- 期望说明：`frontend/public/samples/notices/expected.json`

生产服务器覆盖：`companion/tests/noticeStartServer.test.mjs` 直接调用 `startServer`，
用最小可选注入（`engine` / `requestTimeoutMs`，默认值不变）验证超时、断开、容量释放与
超大请求体不进入引擎；不是复制一份 HTTP wrapper 自测。

---

## 7. 相关文件

**新增**

- `mobile/src/domain/noticeOcrClient.ts`
- `mobile/src/screens/noticePhotoController.ts`
- `mobile/src/screens/NoticePhotoScreen.tsx`
- `mobile/tests/noticeOcrClient.test.mjs`
- `mobile/tests/noticePhotoController.test.mjs`
- `mobile/tests/noticePhotoWiring.test.mjs`
- `companion/tests/noticeEngine.test.mjs`
- `companion/tests/noticeServer.test.mjs`
- `companion/tests/noticeStartServer.test.mjs`
- `companion/tests/noticeOcrImport.test.mjs`
- 本文件

**最小改动**

- `companion/src/ocrEngine.mjs`：新增 `recognizeNotice`、PSM / 文本整理与空结果语义
- `companion/src/server.mjs`：新增 `/v1/ocr/notice`、健康能力位、共用 OCR 路由边界、
  生产 `startServer` 的最小可选注入
- `mobile/src/navigation/types.ts` / `RootNavigator.tsx`：任务栈新增 `NoticePhoto`；
  `NoticeImport` 增加可选 `initialSourceText`
- `mobile/src/screens/TaskListScreen.tsx`：任务页入口
- `mobile/src/screens/NoticeImportScreen.tsx`：只从路由参数初始化一次原文
- `mobile/src/store/AppStore.tsx`：`recordScreenshotResult` 增加通知 OCR 的真实可选字段
  （`requestId` / `warnings` / `durationMs` / `image`），不伪造课表字段
- `mobile/src/domain/photoOcrClient.ts`：仅导出既有内部辅助（取消竞速 / HTTP 错误映射）
