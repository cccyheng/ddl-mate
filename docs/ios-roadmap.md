# DDL Mate 原生 iOS 路线图

> 更新时间：2026-10-11（**多天课表表单轮**：需求 1 + 需求 3 已实现；需求 2 / 4 明确未做）
> 实现：DeepSeek Harness · 监督 / 独立复核：Codex
> **状态：依赖、编译、测试、独立真实 SQLite、依赖版本、含 Hermes 字节码的完整 iOS 导出，
> 以及 Codex 侧 `-Lan` Metro 服务的局域网可达性（HTTP 200）均已验证；
> 用户已在 iPhone 的 Expo Go 上自报确认首页与底部标签栏可显示（冒烟测试 PASS），
> 但完整交互流程与真机 SQLite 持久化仍未验收。**
> 本轮的具体改动见 §0.0（**只改了 `mobile/` 源码与测试，未重建 JAR、未改 `backend/` / `frontend/`**）。

### 0.0 本轮实际改动（多天课表表单，2026-10-11）

用户这次的四条要求，本轮**只做第 1、3 条**，第 2、4 条等 Codex 追问有结论后再动：

| 要求 | 本轮状态 |
| --- | --- |
| 1. 移除「开始节次 / 结束节次」输入 | ✅ **已做**：表单不再有这两个输入框；`period_start` / `period_end` 字段、`ScheduleDraft`、仓库读写与旧数据全部保留，编辑既有课表时原样写回（有回归测试） |
| 2. 照片识别课表导入 | ⛔ **未做**（本轮明确不引入 OCR 依赖、不加服务端） |
| 3. 星期可多选 / 全选、每天独立时间地点、激活天颜色更深、保存前逐天校验 | ✅ **已做** |
| 4. 移除「学期第一周周一」输入 | ⛔ **未做**（不猜教学周基准，等 Codex 结论） |

**新增源码**

- `mobile/src/domain/scheduleMultidayDraft.ts`：纯领域草稿（可测试）。多选、全选、激活天、
  「至少保留一天」、逐天校验（返回 `firstInvalidWeekday` 与 `day:<星期>:<字段>` 错误键）、
  以及**保存计划** `buildMultidaySavePlan()`——原记录只在仍被勾选时更新、新天只新增、
  同一天已有别的记录则记为冲突而不覆盖。
- `mobile/src/domain/courseRepository.ts` 新增 `applyScheduleBatch(courseId, { updates, creates })`：
  **先纯校验整批，再 `BEGIN IMMEDIATE` 单事务写入**；任一步失败 `ROLLBACK`；
  更新只按 id 命中指定行，新增的天若同一课程已有别的行则显式报错（错误键 `weekday:<n>`）。
- `mobile/src/store/AppStore.tsx`：把 `applyScheduleBatch` 接进原有的**串行写入队列**。
- `mobile/src/screens/ScheduleFormScreen.tsx`：重写为多天版——星期 chips（已选=浅绿
  `primarySoft`、正在编辑=深绿 `primary`、未选=中性）、「已选 N 天」「正在编辑：周X」、
  「全选七天」「取消周X」、逐天时间/地点输入、出错时自动切到第一个出错的天并聚焦该字段。

**测试**：`mobile/tests/scheduleMultidayDraft.test.mjs`（15 项纯领域）+ `mobile/tests/scheduleBatch.test.mjs`
（9 项真实内存 SQLite），覆盖草稿保留、非激活天校验、**原子批量失败回滚**、每天独立持久化、
不覆盖无关天、旧节次字段保留。`mobile/tests/helpers/sqliteHarness.mjs` 增加了
`failingRunDatabase()`（在第 N 次写入注入失败，用来证明真的回滚）。

**本轮真实验证结果**

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `mobile/tests`（`node --import ./tests/setup.mjs --test --test-isolation=none tests/*.test.mjs`） | ✅ **123 / 123 PASS，exit 0** | `.supervision/ios-timetable-revision-tests.log` |
| `tsc --noEmit` | ✅ **exit 0，0 error** | `.supervision/ios-timetable-revision-tsc.log`（空输出） |
| `expo export --platform ios --no-bytecode` | ✅ **exit 0**，`iOS Bundled 11358ms index.ts (907 modules)`，输出到一次性目录 `.tools/expo-multiday-check` | 本轮终端输出；**未**覆盖 `dist-ios` 里上一轮的 `.hbc` |
| 含 Hermes 字节码的完整导出 | ⏸ **本轮未重跑**（沙箱下 `hermesc` 需要提权）。上一轮的 2.2MB `.hbc` 仍是改动前代码的证据 |
| 真机 Expo Go | ⏸ **本轮未验证**（Metro pid 298524 / 8081 一直保持运行，未重启、未停止） |

**必须说清**：`--no-bytecode` 的导出只证明新代码能打进 JS bundle（907 个模块，比上一轮多 1 个新模块），
**不等于**原生验收、不等于真机通过、也不等于含字节码的 release 导出仍然可行。

## 0. 当前检查点（最需要先看的一节）

| 项 | 实际状态 |
| --- | --- |
| `mobile/node_modules` | ✅ **完整可用**：309 个顶层条目、`expo-sqlite` 在位、**0 个残留 `*_tmp_*`** |
| 依赖安装（本轮） | ✅ **exit 0，28.5 秒**，`521 added`；命令与日志见 §0.2 |
| `pnpm-workspace.yaml` | ✅ `nodeLinker: hoisted` + **`packageImportMethod: copy`** |
| 旧损坏依赖树 | 📦 已隔离为 `mobile/node_modules-quarantine-20261011-083755/`（未删除，已从 tsc 排除） |
| `tsc --noEmit` | ✅ **exit 0，0 error**；Codex 独立复跑同样 0 error（`.supervision/ios-20261011-tsc-final.log`）；**多天课表轮重跑仍为 exit 0**（`.supervision/ios-timetable-revision-tsc.log`） |
| 领域与仓库测试 | ✅ **99 / 99 通过，0 失败**（改动前基线，Codex 独立复跑 PASS，`.supervision/ios-20261011-tests-final.log`）；**多天课表轮为 123 / 123 PASS**（+24 项新测试，`.supervision/ios-timetable-revision-tests.log`） |
| 独立真实 SQLite 探测 | ✅ **8 / 8 PASS**（`.supervision/ios-20261011-sqlite-review.log`） |
| `expo install --check` | ✅ **exit 0**：`Dependencies are up to date`（`.supervision/ios-20261011-checkdeps-supervisor.log`） |
| iOS JS bundle（**含 Hermes 字节码**） | ✅ **完整导出 PASS**：在**已获批准的高权限（elevated）shell** 中并设 `TEMP`/`TMP`=工作区内 `.tools/expo-tmp`，`mobile/dist-ios` 里有 **2.2MB 的 `.hbc`**（`.supervision/ios-20261011-export-supervisor.log`）。**这是 JS 字节码，不是 IPA；且依赖提权，不能保证不开提权也通过。** |
| Codex 侧 `-Lan` Metro + 局域网可达性 | ✅ 由 Codex 用 `scripts/start-mobile.ps1 -Lan`（端口 8081）启动，**保留用户登录态**；实际 LAN `192.168.31.73`；iOS manifest 与 bundle **HTTP 200**（bundle 4,921,027 bytes）（`.supervision/ios-20261011-lan-check.json`）。**截至 2026-10-11 08:49（Asia/Shanghai）Metro 仍在运行：pid 298524、端口 8081。** |
| **用户手机（Expo Go）冒烟测试** | ✅ **PASS（用户自报，2026-10-11）**：iPhone 上**成功显示首页与底部标签栏**。**仅此一项**；完整流程与真机 SQLite 持久化**未验证**（待测清单见 §7）。 |
| 用户侧登录 | ✅ 手机与电脑均已登录；脚本**沿用默认 Expo 家目录**，不再覆盖（本文件不记录任何凭据） |
| `backend/` `frontend/` `.codex` | ✅ 未改动 |

### 0.1 本轮修掉的真实缺陷（不是回归）

1. **`TaskFormScreen.tsx` 少 import `Text`**：第 183 行的表单错误横幅用了 `<Text>`，
   但只 `import { StyleSheet, View } from 'react-native'`，
   于是 `Text` 解析到 **DOM 全局 `Text` 构造器**（`lib: ["DOM", ...]` 带进来的），
   `tsc` 报 `TS2607 / TS2786: 'Text' cannot be used as a JSX component`；
   运行时该横幅（提交非法表单时出现）会让 `<Text>` 变成未定义标识符。
   已补 `Text` 到 react-native 的 import。**这是之前一直没被发现的原因**：
   上一轮 `tsc` 在配置层就以 `TS5101` 中止，根本没走到类型检查。
2. **`tsconfig.json` 的 `baseUrl` 在 TypeScript 6.0.3 下已废弃**（`TS5101`，TS 7.0 将移除）。
   已删除 `baseUrl`，并把 `paths` 改成 `"@/*": ["./src/*"]`（无 `baseUrl` 时 `paths` 必须写相对路径，
   否则 `TS5090`）。`@/` 目前没有任何源码在用，保留别名是为了以后可用。
3. **测试断言写错了层次**：`wallClockInput.test.mjs` 曾断言 `normalizeTaskDraft` 抛出的**顶层 message**
   含有「还差一个具体时刻」。实际契约是：顶层 message 只是「表单有问题」的横幅，
   **具体指引挂在 `error.fields.deadline` 上**（`TaskFormScreen` 正是把 `fields` 渲染到对应输入框；
   `repository.test.mjs` 也是这么断言的）。已改为断言
   「抛 `ValidationError` + `fields.deadline` 含指引 + `fields` 只有 `deadline` 一个键」，
   断言强度没有降低，只是对准了真实契约。

> 说明：上一轮文档里 §「Codex 那次 80/76 的 4 项失败」是**旧测试文件跑在新源码上**的过期期望
> （旧测试还在断言「静默忽略原文覆盖」）。本轮以当前 `tests/` 重跑为准：**99/99 全绿**，
> 那 4 项不再是未决项。

### 0.2 依赖安装：本轮真实执行记录

```powershell
$env:CI='true'
node <pnpm.cjs> install --dir mobile --frozen-lockfile --prefer-offline `
  --store-dir <工作区>\.tools\pnpm-store --package-import-method=copy --reporter=append-only
```

- 前置：把**旧的损坏 `node_modules`** 先隔离（不是删除）——
  先用 `Resolve-Path` 校验解析结果**必须等于**`<工作区>\mobile\node_modules` 才 `Move-Item`，
  目标是 `mobile/node_modules-quarantine-20261011-083755/`；lockfile 与 `src/` 均未动。
- 结果：**exit 0，28.5 秒，`521 added`，`Done in 28.3s using pnpm v11.7.0`**，
  完整日志 `.supervision/ios-20261011-install.log`，退出码记录 `.supervision/ios-20261011-install-result.txt`。
- 缓存仍是工作区内的 `.tools/pnpm-store`（安装前已有 647 个文件 / 约 39MB，被复用），**未安装任何全局软件**。
- `packageImportMethod: copy` 是这次的关键：上一次失败正是 hoisted 布局下 pnpm 先建
  `<pkg>_tmp_<pid>_<n>` 再改名时 `[ERR_PNPM_ENOENT] ... metro_tmp_284472_17\node_modules`，
  并留下 4 个残留临时目录、4 个 tarball `UND_ERR_DESTROYED`；改成 copy 后全程没有临时目录改名。

### 0.3 完整导出已通过（在**已批准的高权限 shell** + 工作区 TEMP/TMP 下）

`expo export --platform ios --output-dir dist-ios` 会在 Hermes 字节码步骤派生 `hermesc` 子进程，
写**系统默认临时目录**；沙箱只允许写工作区，因此报 `spawn EPERM`
（`Failed to generate Hermes bytecode for: ...\index.ts`）。**解法在环境层，不在源码**：

```powershell
cd mobile
$env:CI='true'; $env:EXPO_NO_TELEMETRY='1'
$env:TEMP="$PWD\..\.tools\expo-tmp"; $env:TMP=$env:TEMP
node ./node_modules/expo/bin/cli export --platform ios --output-dir dist-ios
```

Codex 的成功导出是在**已获批准的高权限（elevated）shell** 里跑的，并且设了上面的
`TEMP`/`TMP`（工作区内 `.tools/expo-tmp`）；日志 `.supervision/ios-20261011-export-supervisor.log`，
`mobile/dist-ios` 里产出 **2.2MB 的 Hermes 字节码（`.hbc`）**。
**必须说清两点**：① `.hbc` 仍是 **JS 字节码，不是 IPA**，也不等于原生验收；
② 这次成功**依赖了提权**，**不保证不开提权也通过**。
无论哪种方式都**没有改源码、没有重新构建**。

下面是上一次（未设 TEMP）的失败记录与 `--no-bytecode` 变体，保留备查：

- 尝试过的一次性提权被拒绝：`sandbox escalation to "danger-full-access" requires approval, but no approval channel is available`。
- 因此改用**同一命令 + `--no-bytecode`**：`expo export --platform ios --output-dir dist-ios --no-bytecode`
  → **exit 0**，`iOS Bundled 7532ms index.ts (906 modules)`，产出 `dist-ios/_expo/static/js/ios/index-*.js`（1.4MB）+ 16 个资源。
- **必须说清**：`--no-bytecode` 只证明 **JS 层能把 906 个模块打成 iOS bundle**，
  **不等于**完整的 release 导出（缺 Hermes 字节码），更不等于原生验收。

**该步骤已由 Codex 在已批准的提权 shell 中完成**（见上）；它并没有证明「不提权也能导出」。

`expo install --check` 同样需要写 Expo 家目录（`~/.expo/native-modules-cache`），
在沙箱里会 `EPERM`。本轮跑校验命令时临时用
`__UNSAFE_EXPO_HOME_DIRECTORY=<工作区>\.tools\expo-home` + `EXPO_NO_TELEMETRY=1`；
**注意**：该重定向只用于这些**离线校验命令**，`scripts/start-mobile.ps1` 里**不使用**它（见 §0.4）。

### 0.5 默认临时目录的权限回退（已文档化，无需改源码）

在本沙箱下，派生 `hermesc` 等子进程的命令需要把 `TEMP`/`TMP` 指到工作区内
（如 `.tools/expo-tmp`）。这是**环境层写法**，不涉及任何源码改动或重新构建。
但**仅设 TEMP/TMP 并不保证成功**：Codex 成功那次同时具备**已批准的提权 shell**。

另：CLI 在点目录（dot dir）缓存权限不足时会打印 **React Native DevTools 的 fallback 提示**，
**与 App 打包无关**，不是 bundling 阻塞。

### 0.4 `scripts/start-mobile.ps1` 启动脚本契约（本轮已修好）

上一版有三个问题：默认绑定 LAN、用 `__UNSAFE_EXPO_HOME_DIRECTORY` 覆盖 Expo 家目录
（于是**丢掉用户已保存的登录态**）、且没有透传 CLI 退出码。现已按下面契约重写：

| 项 | 现在的行为 |
| --- | --- |
| 绑定默认值 | **默认 `--localhost`**（最保守，不把开发服务器暴露到局域网） |
| LAN | 手机真机扫码必须**显式** `-Lan`；不再隐式暴露 |
| 互斥 | `-Lan` 与 `-Localhost` **同时给出直接报错退出**，不做隐式优先级 |
| Expo 家目录 | **完全不再设置 / 覆盖** `__UNSAFE_EXPO_HOME_DIRECTORY`，沿用默认家目录 → **复用用户已有登录态**；脚本不读取、不打印任何凭据 |
| `whoami` 预检 | **不做**。该检查本身就是读取登录态，且已确定要沿用默认登录；改为在输出里提示「手机与电脑需登录同一免费账号」 |
| 子进程 PATH | 把解析出的本机 Node **所在目录前置**到 `$env:PATH`，Metro / Expo 派生的子进程复用同一运行时 |
| 端口 | `[ValidateRange(1,65535)]`，越界在参数绑定阶段就报错（退出码 1） |
| 退出码 | `& $node @expoArgs` 后取 `$LASTEXITCODE` 并 `exit`，**原样透传** |
| `--go` | 默认传；`-NoGo` 才关掉 |
| 隧道 / 守护进程 / 防火墙 | 一律不动 |

验证（真实执行，非推断）：`-Lan -Localhost` → 退出码 1 且给出中文冲突提示；
`-Port 0` / `-Port 70000` / `-Port abc` → 参数校验失败、退出码 1；
`-Port 1`（预期绑定失败）→ 脚本打印横幅后 CLI 报错，脚本退出码 **1**（证明透传生效）。
同一次运行也证明脚本解析到了本机 Node `v24.19.0` 并成功加载了项目内 `@expo/cli`。

`mobile/README.md` 已同步记录默认 localhost、`-Lan` 显式开启、以及「不要覆盖 Expo 家目录，
否则要重新登录」这一点。

---

## 1. 技术栈（版本来自 npm registry 与 Expo 元数据，非记忆）

| 项 | 版本 | 来源 |
| --- | --- | --- |
| Expo SDK | **57.0.27**（CLI 实报 57.0.28） | `registry.npmjs.org/expo` dist-tags；本地 `expo --version` |
| React Native | **0.86.3** | expo@57.0.27 tarball 内 `bundledNativeModules.json` |
| React | **19.2.3** | 同上 |
| expo-sqlite | **57.0.4** | 同上（Expo Go 自带原生模块） |
| expo-status-bar / expo-constants | 57.0.1 / 57.0.21 | 同上 |
| react-native-safe-area-context / screens | 5.7.0 / 4.26.2 | 同上 |
| @react-navigation native / bottom-tabs / native-stack | 7.5.0 / 7.20.0 / 7.20.0 | `registry.npmjs.org` |
| TypeScript | **6.0.3** | `expo install --check` 要求 `~6.0.3`（Expo 官方兼容清单） |
| Node（项目锁定运行时） | **v24.19.0** | `C:\Users\33284\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe` |
| 包管理器 | pnpm **11.7.0** | `D:\DS Harness\resources\runtime\pnpm\bin\pnpm.cjs` |

依赖安装 **exit 0**（§0.2），lockfile 为 `mobile/pnpm-lock.yaml`（493 条目），
缓存全部限制在工作区 `.tools/pnpm-store`，未安装任何全局软件。

### 1.1 依赖布局修复（两轮）

**第一轮（isolated → hoisted）**：pnpm 默认 isolated 布局用符号链接 / junction；
本机 Node 的 `fs.realpathSync` **不会**把它解析到 `.pnpm` 目标，
因此 Expo CLI 报 `Cannot find module '@expo/cli'`（PowerShell 看得到 Junction，Node 看不到）。
改成 `nodeLinker: hoisted` 后 `node_modules` 是普通平铺目录，
`@expo/cli` 能被正常解析，**不需要任何 `NODE_PATH` 兜底**。

**第二轮（hoisted 的临时目录改名 bug）**：hoisted 布局下 pnpm 默认的 hardlink/auto 导入
仍会先建 `<pkg>_tmp_<pid>_<n>` 再改名，上一次安装就死在这里
（`[ERR_PNPM_ENOENT] ... metro_tmp_284472_17\node_modules`，随后 4 个 tarball `UND_ERR_DESTROYED`）。
因此加上 **`packageImportMethod: copy`**，安装改为
`--frozen-lockfile --prefer-offline --package-import-method=copy` + `CI=true`。

关于 `__UNSAFE_EXPO_HOME_DIRECTORY`：**应用与启动脚本都不再使用它**。
它会把 Expo 家目录换成一个空环境，从而让用户**已经在默认家目录里保存的登录态失效**。
只有在本沙箱里跑 **`expo install --check` / `expo export` 这类离线校验命令**时，
因为默认 `~/.expo` 不可写（`EPERM: mkdir 'C:\Users\33284\.expo\...'`）才临时重定向到
`.tools/expo-home`；这与「手机扫码预览的登录态」是两回事。

## 2. 实际文件清单

**工程与配置**

```
mobile/package.json  mobile/app.json  mobile/tsconfig.json  mobile/index.ts
mobile/.npmrc  mobile/pnpm-workspace.yaml  mobile/pnpm-lock.yaml  mobile/README.md
```

**源码（`mobile/src/`，35 个文件）**

```
App.tsx
db/         schema.ts  migrations.ts  expoSqliteAdapter.ts  types.ts  index.ts
domain/     datetime.ts  scheduleRules.ts  calendar.ts  wallClockInput.ts
            types.ts  errors.ts  taskDraft.ts  courseDraft.ts
            taskRepository.ts  courseRepository.ts
store/      AppStore.tsx
navigation/ RootNavigator.tsx  types.ts
screens/    TodayScreen  TaskListScreen  TaskFormScreen  TaskDetailScreen
            CourseListScreen  CourseFormScreen  CourseDetailScreen  ScheduleFormScreen
            CalendarMonthScreen  CalendarDayScreen
ui/         theme.ts  components.tsx  ScreenScaffold.tsx  datetimeField.tsx
            dialog.tsx  TaskCard.tsx
```

> 多天课表轮在 `domain/` 下新增 `scheduleMultidayDraft.ts`（多天草稿与保存计划的纯逻辑），
> 其余改动都在既有文件的 `ScheduleFormScreen` / `courseRepository` / `AppStore` 内。

**测试（`mobile/tests/`）**

```
datetime.test.mjs       15 项
scheduleRules.test.mjs  19 项
calendar.test.mjs       15 项
wallClockInput.test.mjs 13 项
repository.test.mjs     37 项（含迁移、事务回归、原文保护、课程删除保护）
scheduleMultidayDraft.test.mjs 15 项（多天草稿保留 / 至少一天 / 逐天校验 / 保存计划）
scheduleBatch.test.mjs   9 项（批量单事务原子性 / 每天独立持久化 / 不覆盖已有天 / 旧节次保留）
helpers/sqliteHarness.mjs（Node 内置 node:sqlite 真实内存库夹具 + 写入失败注入）
setup.mjs + tsResolveHooks.mjs（主线程 ESM 解析钩子）
```

**脚本**

```
scripts/start-mobile.ps1   （默认 localhost / -Lan 显式 / -Clear / -NoGo / -Port 1..65535）
```

## 3. 复核跟进：上一轮修掉的具体问题（保留备查）

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | 表单 `useEffect` 依赖 `existing` / `originalTexts` 引用，后台刷新会**清掉未保存的输入** | 改为按目标 id 只 hydrate 一次（`hydratedFor` ref），并新增明确的 `missing` 状态；编辑态不再无限转圈 |
| 2 | 快捷「今天 / 明天」静默补 `18:00`；`validateWallClockInput` 接受 `9:00` 但 normalize 拒绝 | 快捷按钮改为**只填日期**并提示补时刻；保存路径先补零，两条口径完全一致（有一致性测试锁定） |
| 3 | 界面泄漏原始 ISO 串、`存储值`、`本机数据库` 等实现细节 | 全部改成「保存在这台手机上」+ 格式化时间（`2026-10-15 22:00 周四`） |
| 4 | 刷新失败被当成「保存失败」，会引导用户重复保存 | 新增 `refreshError` 独立状态 + `RefreshErrorBanner`；写入与刷新走**串行队列**避免快照竞态 |
| 5 | 启动脚本必须用本机固定 Node 路径，且要有 LAN 与 `--go` | `scripts/start-mobile.ps1` 实现；**本轮进一步改为默认 localhost、`-Lan` 显式**，见 §0.4 |
| 6 | pnpm isolated 链接在本机 Node 下不可用，Expo CLI 找不到 `@expo/cli` | `nodeLinker: hoisted`；**本轮再补 `packageImportMethod: copy`**，见 §1.1 |
| 7 | `update` 用 `originalText !== description` 这个**巧合判断**决定是否保存原文，导致「说明 = 原文」时原文被静默丢弃；已有原文时被忽略的输入也不报错；提交后读回失败被当成保存失败 | 改为只看「是否已有留存原文」；已有原文时界面只读、仓库对不一致输入**明确报错**；新增 `appendOriginalText` 追加入口；`create`/`update` 返回 `SaveOutcome`，用 `committed` 区分「没写进去」与「写了但读不回」 |

## 4. 验证状态（严格区分「已验证」与「未验证」）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 依赖安装（最终态） | ✅ **已验证** | `.supervision/ios-20261011-install.log`（exit 0 / 28.5s / 521 added）；`node_modules` 309 项、0 个 `*_tmp_*` |
| `tsc --noEmit` | ✅ **已验证 0 error** | `.supervision/ios-20261011-tsc.log`（空输出 = 无错误） |
| 领域与仓库测试 | ✅ **99/99 通过** | `.supervision/ios-20261011-tests.log`；`node --import ./tests/setup.mjs --test --test-isolation=none` |
| `expo install --check` | ✅ **已验证 exit 0** | `.supervision/ios-20261011-checkdeps.log`：`Dependencies are up to date` |
| iOS JS bundle（含 Hermes 字节码） | ✅ **已验证 PASS（需提权）** | `.supervision/ios-20261011-export-supervisor.log`；在已批准的 elevated shell + 工作区 `TEMP`/`TMP` 下产出 `dist-ios` 内 2.2MB `.hbc`（JS 字节码，**不是 IPA**）；**不保证不开提权可行** |
| 独立真实 SQLite 探测 | ✅ **8/8 PASS** | `.supervision/ios-20261011-sqlite-review.log` |
| Codex 侧 `-Lan` Metro + 局域网可达性 | ✅ **HTTP 200** | `.supervision/ios-20261011-lan-check.json`：LAN `192.168.31.73`、bundle 4,921,027 bytes；**2026-10-11 08:49 仍在运行（pid 298524 / 8081）** |
| **用户手机冒烟测试（首页 + 底部标签栏）** | ✅ **PASS（用户自报）** | 用户确认 Expo Go 能显示首页与底部标签；**完整 UI 流程与真机 SQLite 持久化未验证**，待测项见 §7 |

**JS bundle ≠ 原生验收**：`expo export` 成功只说明 JS 能打包，
不证明原生模块在 iOS 上可加载、不证明 SQLite 在沙盒里真的写盘、不证明 UI 正确。
只有真机跑过才算原生验收。

## 5. 在 iPhone 上预览（路线 A，当前唯一现实路径）

```powershell
# 手机真机扫码：必须显式 -Lan（默认是 localhost，手机连不上属于预期）
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1 -Lan

# 本机 / 模拟器（也是不传参数时的默认行为）
powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile.ps1
```

1. App Store 安装 **Expo Go**（用户手机 iOS 27 已安装）。
2. 用**免费 Expo 账号**登录 Expo Go；电脑端沿用**默认家目录里已保存的登录态**（用户已登录），
   脚本既不覆盖家目录也不读取凭据。
3. 手机与电脑连**同一 Wi-Fi**。
4. 扫描终端二维码。

**当前进展（用户自报，2026-10-11）**：iPhone 的 Expo Go **已成功显示首页与底部标签栏**。
仍未验证：完整交互流程与真机 SQLite 持久化（待测清单见 §7）。

**边界（必须对用户说清）：**
- Expo Go 是**原生开发容器**，不是独立签名的 App；
- 首屏与每次重载都依赖电脑上的 Metro，**不是离线冷启动**；
- 不建隧道、不改防火墙、不注册守护进程；
- 原生 OCR / 自定义原生模块需要 dev build，Expo Go 里不可用。

## 6. 独立安装包（路线 B，本轮不授权、未尝试）

| 方式 | 前提 | 代价 |
| --- | --- | --- |
| 免费 Personal Team 签名 | **必须有 macOS + Xcode** | 证书 **7 天**过期，需重签 |
| 付费开发者账号（$99/年）+ EAS 云构建 / TestFlight | 需付费账号 + 上传 | 本轮明确排除购买与上传 |

用户**没有 Mac、没有付费开发者账号**，因此现在只能走路线 A。本轮**未购买、未上传、未配置任何服务账号**。

## 7. 下一步

1. ~~Codex 提权跑完整 `expo export`~~ ✅ **已完成**（§0.3：产出 2.2MB `.hbc`）。
2. **多天课表轮遗留（等 Codex 追问有结论，本轮刻意没做）**：
   - **需求 2「照片识别课表导入」**：本轮只做了调研准备，**未接入任何 OCR 依赖、未加服务端**。
     Web 端已有的识别管线在 `frontend/src/ocr`（浏览器本地 Tesseract）与通知导入流程里，
     真要复用需要考虑「手机上拍照 → 谁来做识别」的架构（本机 dev build 原生 Vision / 走局域网伙伴服务），
     这两个方向都需要 Codex 先拍板，本轮不擅自选一个。
   - **需求 4「移除学期第一周周一输入」**：本轮**未动**。删掉这个输入就意味着教学周基准必须来自别的来源
     （每门课各自存？全局学期设置？从课表导入里识别？），**不能静默取默认值**，所以必须先确定基准来源。
   - **编辑时取消原记录所在的那一天**：当前语义是**保持原记录不动**（不更新、不删除），
     界面上有明确说明；是否需要改成「取消即删除」需要产品层面确认。
3. **用户已确认首屏**（首页 + 底部标签栏，用户自报，2026-10-11）。**剩余待测**：
   - 新建一条带**原始通知文本**的任务；
   - 新建一门带**单周（ODD）课表**的课程；
   - 日历 → 当天 → 任务详情 的跳转；
   - **关掉 App 再打开**，确认数据仍在（真机 SQLite 持久化）。
4. 真机问题修复后，再考虑里程碑 2：
   - `expo-notifications` 本地提醒（原需求 K）；
   - 时间助手 UI（原需求 N，可复用 `domain/datetime.ts` 的北京时间工具）；
   - dev build 后的原生 Vision OCR（原需求 A / O）。
5. 可选：接入 `@react-native-community/datetimepicker`（**Expo Go 官方支持**，见
   <https://docs.expo.dev/versions/latest/sdk/date-time-picker/>）作为文本输入之外的补充。
   本轮不做，因为文本输入能明确表达「只选了日期、还没定时刻」这个状态。
6. 清理：确认新依赖树稳定后，可删除 `mobile/node_modules-quarantine-20261011-083755/`（约 306 个包）。

## 8. 明确「不声称」的项

- ❌ 原生里程碑 1 已通过真机验收（用户自报的冒烟测试**不算**里程碑验收）
- ❌ 完整 UI 流程已在真机上跑通（用户只确认了**首页 + 底部标签栏**）
- ❌ SQLite 在真机上写过盘 / 重启后数据仍在（**未验证**）
- ~~含 Hermes 字节码的完整 iOS 导出~~ ✅ 已成功（2.2MB `.hbc`）——但**它只是 JS 字节码，不是 IPA**
- ❌ 独立安装包 / 离线冷启动
- ❌ 照片识别 / 批量截图导入课表（需求 2，本轮**未实现**：没有照片选择、没有 OCR、没有伙伴服务）
- ❌ 「学期第一周周一」输入已移除（需求 4，本轮**未动**；也没有为教学周猜任何默认基准）
- ❌ 多天课表表单已在真机上跑通（本轮只做了 123/123 测试、`tsc` 0 error 与 `--no-bytecode` JS 打包，
  **没有**真机验收，Metro 也未被重启）
- ❌ A / O 原生 OCR、C / E / L AI 能力、K 提醒、N 相对时间助手
- ❌ Web 端已有的能力等同于原生已实现
