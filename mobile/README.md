# DDL Mate 原生 iOS 客户端（mobile/）

> Expo SDK **58** + React Native **0.88.0** + React **19.3.0** + TypeScript，**真实原生视图**（`View` / `Text` / `Pressable` / `TextInput` / `Modal`），
> 没有任何 WebView、iframe 或 PWA 外壳。数据存在手机本地的 `expo-sqlite`，业务操作不需要服务器。

## 1. 这个 App 现在能做什么（里程碑 1 范围）

| 能力 | 状态 |
| --- | --- |
| 底部导航「今天 / 任务 / 课程 / 日历」 | ✅ 原生标签栏 + 每栈内部原生导航 |
| 任务：新建 / 编辑 / 完成 / 删除（二次确认） | ✅ |
| 截止时间：显式北京时间、严格真实日历校验、不猜时间 | ✅ |
| 任务详情含**原始通知文本**，可追加、不可覆盖 | ✅ |
| 任务截止提醒（**本机**、固定提前量 30 分钟 / 3 小时 / 1 天 / 3 天） | ✅ 代码完成；默认关闭、每条任务显式开启、最多 32 条；保存后区分「规则已保存」与「系统已排队」。**仍待 iPhone 真机送达验收**；见 `../docs/native-task-reminders.md` |
| 课程与课表：增 / 改 / 删（删除有引用保护） | ✅ |
| 课表表单：星期**可多选（含「全选七天」）**，**每一天各自填开始 / 结束时间与地点** | ✅ 切换正在编辑的星期不会丢草稿 |
| 课表保存：多天**一次事务写入**，任一步失败整批回滚 | ✅ 有真实 SQLite 回归测试 |
| **同一天可以有多段课 / 同一时段单双周各一条** | ✅ 只拦「同天 + 同时段 + 同周次范围」的完全相同重复（复核对修正，有回归测试） |
| 课表表单不再显示「开始节次 / 结束节次」输入 | ✅ 界面移除；数据库字段与旧数据保留，编辑既有课表时原样写回 |
| **课表表单不再显示「学期第一周周一」输入** | ✅ 本机设置里**每个学期校准一次**「本周是第几教学周」；已有记录保留自己的学期起点，不因重新校准被改写 |
| 教学周校准：今天（北京）+ 当前教学周 → 学期首周一；重开自动重算周次 | ✅ `app_settings`（schema v2）；损坏/非周一的脏数据在读取时被拒绝并引导重新校准 |
| 课表导入：拍照 / 相册 → **本机电脑上的本地 OCR** → 原生可编辑候选 → 一次性导入手机 | ✅ 本轮新增；见第 8 节 |
| 月历可点某天 → 当天课程 + 截止任务 → 任务详情 | ✅ |
| 数据只存本机、重启后仍在 | ✅ 代码与事务测试已覆盖；**真机持久化尚未验收**（用户仅确认首页与底部标签栏可显示） |

**这一轮新增的能力**（对应任务书需求 2 / 4）：
「拍照导入课表」入口在**课程页**：拍/选一张课表截图 → 同一 Wi-Fi 上的**本机电脑**用本地
Tesseract 识别 → 手机上逐行核对 / 修改（课程名、星期、时间、地点、教学周、单双周）→
点一次「导入」把整批课程与课表**一次性**写进手机 SQLite。识别阶段不写任何数据；
重复点导入不会产生重复行；失败时保留你改好的内容。

**明确不在本轮范围**（路线图见 `../docs/ios-roadmap.md`）：
AI 拆解 / 每日计划 / 冲突检测、**云推送 / 智能提醒 / 点通知跳详情**、相对时间助手、
原生独立安装包。这些**不因为 Web 端已有就宣称原生已支持**。

> 手机提醒已实现的是**本机固定提前量**的任务截止提醒，不是云推送；**真机送达仍未验收**，
> 详见 `../docs/native-task-reminders.md`。C（AI 拆解）与 E（AI 每日计划）仍未实现。

## 2. 首次安装与启动

前置：Windows 电脑 + iPhone（用户机型 iOS 27，可装 Expo Go）+ 同一个 Wi-Fi。

```powershell
# 1) 安装依赖（缓存全部限制在工作区 .tools/ 下，不装全局软件）
cd mobile
pnpm install

# 2) 启动开发服务器
#    默认绑定 localhost（不把开发服务器暴露到局域网）
cd ..
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1

# 2b) 手机真机预览：必须显式加 -Lan
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1 -Lan
```

在 iPhone 上：

1. App Store 安装 **Expo Go**。
2. 用**免费 Expo 账号**登录 Expo Go；电脑这边首次启动也会要求登录，**必须登录同一个账号**
   （Expo 官方 changelog：SDK 57 起 Expo Go 需要登录才能运行项目）。
3. 确认手机与电脑在**同一 Wi-Fi**。
4. 扫描终端里的二维码。

### 必须说清的边界

- **Expo Go 是原生开发容器，不是独立签名的 App。** 它按官方方式加载你的原生 JS，但没有自己的图标与独立分发。
- 首次加载与每次重载都**依赖电脑上的 Metro 在运行**：这不是「独立安装」，也不是「离线冷启动」。
- 电脑与手机需要同一 Wi-Fi；脚本不建隧道（`--tunnel`）、不改防火墙、不注册守护进程。
  换网络导致连不上时，请在同一网段重试，而不是改防火墙。
- 独立安装包需要 **macOS + Xcode 免费 Personal Team 签名**（证书 7 天过期），
  或付费开发者账号 + 云端 macOS 构建 / TestFlight。两者本轮都**不在授权范围**，未购买、未上传。
- 原生 OCR（Vision 框架）等自定义原生模块**不能在 Expo Go 里跑**，需要 dev build；本里程碑不包含。

## 3. 脚本参数

```powershell
# 默认：localhost 绑定（模拟器 / 本机预览）
.\scripts\start-mobile.ps1

# 手机真机（Expo Go 扫码）：显式开启 LAN
.\scripts\start-mobile.ps1 -Lan

# -Lan 与 -Localhost 互斥，同时给出会直接报错（不做隐式优先级）
.\scripts\start-mobile.ps1 -Lan -Localhost   # ❌ 报错退出

# 清 Metro 缓存后启动
.\scripts\start-mobile.ps1 -Lan -Clear

# 不传 --go（默认会传，强制解析到 Expo Go）
.\scripts\start-mobile.ps1 -Lan -NoGo

# 换端口（校验范围 1..65535，越界直接报错）
.\scripts\start-mobile.ps1 -Lan -Port 8082
```

脚本使用**项目内**的 CLI（`mobile/node_modules/expo/bin/cli`），并默认用本机固定的 Node 绝对路径；
两者都找不到时才回退 PATH 里的 `node`。它还会把该 Node 所在目录**前置**到子进程的 PATH，
让 Metro / Expo 派生的进程复用同一个运行时。它不会调用全局 `npm`，也不会把东西装到全局。

脚本会把 Expo CLI 的退出码**原样透传**（`exit $LASTEXITCODE`），方便上层脚本与 CI 判断失败。

## 4. 本地开发命令

```powershell
cd mobile

# 类型检查
npm run typecheck          # 等价于 tsc --noEmit

# 领域与仓库测试（真实内存 SQLite）：147 项
npm test

# 检查依赖版本是否与当前 Expo SDK 匹配
npm run check:deps

# 只导出 iOS 的 JS bundle（不是 IPA，也不是 Xcode 构建）
npm run export:ios
```

### 在受限沙箱里跑测试

`npm test` 默认让 Node 的测试运行器**为每个文件开子进程**；本机受限沙箱不允许子进程用管道
捕获输出，会报 `spawn EPERM`。沙箱里请改成**单进程**运行（语义相同）：

```powershell
node --import ./tests/setup.mjs --test --experimental-test-isolation=none tests/*.test.mjs
```

（Node 24 里这个开关叫 `--experimental-test-isolation=none`；写成 `--test-isolation=none` 会被当成未知参数。）

`expo install --check` 与 `expo export` 会写 Expo 的家目录（`~/.expo`），沙箱里同样会 `EPERM`；
离线校验命令可临时设 `EXPO_NO_TELEMETRY=1` 与
`__UNSAFE_EXPO_HOME_DIRECTORY=<工作区>\.tools\expo-home`（**只用于校验**；
`scripts/start-mobile.ps1` 故意不设它，见上文「关于 Expo 的缓存与登录态目录」）。
### `expo export` 与临时目录（重要）

`expo export` 的 Hermes 字节码步骤会派生 `hermesc` 子进程去写**系统默认临时目录**；
沙箱下那里不可写，于是报 `Failed to generate Hermes bytecode` + `spawn EPERM`。
Codex **成功**的那次完整导出是在**已获批准的高权限（elevated）shell** 里跑的，
同时把 `TEMP`/`TMP` 指到工作区内 `.tools/expo-tmp`（产出 `dist-ios` 里 2.2MB `.hbc`）。
**没有证据表明不开提权也能通过**——不要把「设了 TEMP/TMP」当成普通沙箱下必然可行的保证。
无论哪种方式都**不需要改任何源码、也不需要重新构建**：

```powershell
$env:TEMP="$PWD\..\.tools\expo-tmp"; $env:TMP=$env:TEMP
npm run export:ios
```

`.hbc` 是 **JS 字节码，不是 IPA**，更不等于原生验收；`--no-bytecode` 仍可用于只验证「JS 能否打包」。

另：CLI 在缓存目录不可写时会打印 **React Native DevTools 的 fallback 提示**，
那是点目录（dot dir）缓存权限问题，**与 App 打包无关**，不是 bundling 失败。

### 关于依赖布局（重要）

`pnpm-workspace.yaml` 里设置了：

```yaml
nodeLinker: hoisted
```

原因：pnpm 默认的 isolated 布局会用符号链接 / junction 组织 `node_modules`，
但本机 Node 的 `fs.realpathSync` 不会把 pnpm 的 junction 解析到 `.pnpm` 目标，
于是 **Expo CLI 会以 `Cannot find module '@expo/cli'` 失败**（PowerShell 里能看到 Junction，Node 里看不到）。
改成 hoisted 后 `node_modules` 是普通平铺目录，Node / Expo CLI / Metro 都按常规方式解析，
不需要任何 `NODE_PATH` 兜底（手工拼 `NODE_PATH` 反而会命中不兼容的嵌套依赖）。

### 关于 Expo 的缓存与登录态目录

Expo CLI 会把缓存与**登录态**写到用户主目录的默认位置（`~/.expo`）。

- `scripts/start-mobile.ps1` **不再覆盖** `__UNSAFE_EXPO_HOME_DIRECTORY`：
  它沿用默认目录，从而直接复用你**已经登录过**的 Expo 登录态；
  脚本既不读取、也不打印任何凭据。换目录会让 Expo 认为是全新环境而要求重新登录。
- 只有在你**手工**跑 CLI、且默认目录确实不可写（`EPERM: operation not permitted, mkdir 'C:\Users\<你>\.expo'`）时，
  才需要自己设一个可写目录，例如 `__UNSAFE_EXPO_HOME_DIRECTORY=<工作区>\.tools\expo-home`；
  注意那样等于换了一个空环境，**需要在那个目录下重新登录一次**。

这些目录只保存 Expo 自己的缓存与登录态，**不会上传任何项目内容**。

## 5. 数据存在哪

- 数据库文件：应用私有目录下的 `ddl-mate.db`（iOS 上是沙盒内的 SQLite 目录）。
- 卸载 App 才会清除；本里程碑不做导入 / 导出与云同步。
- 时间统一按**北京时间（Asia/Shanghai）**记录并带显式 `+08:00` 偏移，
  手机时区改成 UTC 或纽约都不会改变任务的日期归组（有对应测试）。
- 仓库层对所有 SQL 使用**参数化绑定**，不做字符串拼接。

## 6. 已知限制与未验证项（诚实声明）

- **用户手机冒烟测试 PASS（用户自报，2026-10-11）**：iPhone 上的 **Expo Go 成功显示首页与底部标签栏**。
  这是**用户自行确认**的结果，本仓库没有截图或日志佐证。
- **仍未验证**：完整交互流程与**真机 SQLite 持久化**都没有结论——「首页能显示」不能推断它们通过。
  待用户测试：新建带**原始通知文本**的任务、新建带**单周课表**的课程、
  日历 / 当天 / 详情跳转、以及**关掉 App 再打开**确认数据仍在。
- 电脑侧已验证项（**2026-10-11 拍照导入 + 全局教学周轮更新**）：**147/147** 领域与仓库测试
  （真实内存 SQLite；包含同日多段课 / 单双周 / 周次范围并存、提交后读回失败不谎报、
  两行导入原子回滚、导入重复幂等、校准不被改写、脏校准被拒绝、端点规范化、周次映射等新用例）、
  `tsc --noEmit` **0 error**、`expo install --check` 依赖一致。
  伴侣服务侧另有 **19 项**测试（13 项 HTTP/解码边界 + 5 项真实 socket HTTP，
  含客户端中途断开、超大请求体 413、未知路径 404；PNG/JPEG 头部超限在解码前拒绝）
  与 **1 项真实引擎整图回退测试**（用 `frontend/public/samples` 两张合成图，断言做过 RGBA→灰度转换）。
- **真实用户照片的识别证据**：`.supervision/phase2-real-image-ocr.json` 与
  `.supervision/ios-photo-engine-review.json` —— 21 块 / 21 名称 / 21 时刻 / 20 地点 / 显示第 7 周，
  约 2.8 秒。对照用的 `.supervision/user-photo-expected.json` **只用于报告命中率，不参与识别**。
  已知一处 OCR 地点误读（百川 → 百咱）**不做硬编码修正**，靠导入页的「原生可编辑候选」让用户改。
- **仍未验证（必须由用户在真机上确认）**：相机/相册权限弹窗、拍照到导入的完整交互、
  真机 SQLite 持久化、Expo Go 里 `expo-image-picker` / `expo-image-manipulator` 的实际表现。
  Node 侧测试与识别证据都**不能**替代真机验收。
- Expo Go 预览依赖电脑上的 Metro，见上文边界说明。
- 照片识别需要电脑上跑 `companion/` 的伴侣服务（见第 7 节）；不跑它时拍照导入会给出可读错误与重试入口。
- 本里程碑不含：通知识别、AI 能力、本地通知、相对时间助手、独立 IPA。
- 没有账号体系、没有多设备同步、没有数据导出。

## 7. 拍照导入课表（本轮新增）

```
手机（Expo Go）                          电脑（同一 Wi-Fi）
┌──────────────────────────┐            ┌─────────────────────────────────┐
│ 课程页 →「拍照导入课表」   │            │ companion/ 本地 OCR 伴侣服务     │
│  拍照 / 相册 → 压缩成 JPEG │  HTTP POST │  :8082（后端 8080 / Metro 8081  │
│  → base64                 │ ─────────► │  都不动）                        │
│                           │  /v1/ocr/  │  - 本地 Tesseract + 工作区语言模型│
│  逐行核对 / 修改           │  timetable │  - 复用 frontend/src/ocr/* 流水线│
│  点「导入」→ 手机 SQLite   │ ◄───────── │  - 不提供文件服务、不接受任意网址 │
│  （整批单事务，重复不重复写）│  候选 JSON │  - 图片不上传任何第三方           │
└──────────────────────────┘            └─────────────────────────────────┘
```

启动伴侣服务（**只有加 `--lan` 手机才连得上**）：

```powershell
cd companion
pnpm install          # 依赖已装好时跳过
pnpm start:lan        # 终端会打印「手机端地址可以填：http://电脑IP:8082」
```

在手机上：**课程页 → 识别服务设置** → 填入终端打印的地址 → 「测试连接」→ 回到「拍照导入课表」。

- 默认地址会**自动按 Expo/Metro 的局域网主机名推断**（把 8081 换成 8082），不需要手抄 IP，
  也**没有**把任何 IP 写死在代码里；
- 服务默认只监听 `127.0.0.1`；`--lan` 才绑到局域网，不开隧道、不改防火墙；
- 服务端对请求体大小、图片字节数、像素数、单边长度都有上限；只接受 PNG/JPEG（HEIC 由手机先转 JPEG）；
- 识别阶段**不写数据库**；只有点「导入」才会把整批课程 + 课表在**一条事务**里写进手机。

## 8. 目录结构

```
mobile/
  index.ts                 # registerRootComponent 入口
  app.json                 # Expo 应用配置（bundleIdentifier、expo-sqlite / image-picker 插件）
  src/
    App.tsx                # 安全区 → 数据层 → 导航
    db/                    # schema（v2 含 app_settings）、迁移、expo-sqlite 适配器、数据库接口
    domain/                # 纯逻辑：datetime、scheduleRules、calendar、scheduleSession（判重）、
                           #       semesterAnchor（学期起点解析）、teachingWeek（校准）、
                           #       photoImport / photoOcrClient / photoFiles、校验与仓库
    store/AppStore.tsx     # 数据库引导 + 内存快照 + 串行写入队列 + 导入串行队列
    navigation/            # 底部标签 + 各栈路由与参数类型
    screens/               # 今天 / 任务 / 课程 / 日历 / 教学周 / 拍照导入 / 核对 / 识别服务设置
    ui/                    # 设计令牌、通用组件、日期时间输入、确认对话框
  tests/                   # node:test 测试 + 真实内存 SQLite 夹具
```

伴侣服务与它自己的测试：

```
companion/
  src/imageCodec.mjs       # PNG/JPEG 解码（先读头部尺寸再解码）+ 灰度 PNG 编码
  src/ocrEngine.mjs        # 复用 frontend/src/ocr/*，注入假 canvas 与 PNG 编码
  src/server.mjs           # :8082，默认本机、--lan 才暴露；无文件服务
  tests/server.test.mjs    # 13 项 HTTP 边界测试（不需要 OCR）
  tests/fallbackEngine.test.mjs # 1 项真实引擎整图回退测试
  tests/realImageHttp.mjs  # 真实照片走 HTTP 的端到端验收报告
```
