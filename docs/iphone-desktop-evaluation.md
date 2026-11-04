# DDL Mate：iPhone 桌面体验评估

核查日期：2026-11-02。状态：评估完成，功能未实施、手机未验收。本轮用户授权 Codex 接手评估；未安装依赖、付费、构建或发布。

## 推荐结论

先做免费的桌面快捷入口：点击图标打开 DDL Mate；后续补齐链接处理后，可直接进入番茄钟、新建任务、考试列表。当前 Expo Go 预览仍需要电脑上的开发服务和可达网络，快捷入口不会把它变成离线独立 App。

动态课程卡片、DDL 卡片和锁屏／灵动岛倒计时留到独立原生构建阶段。官方 `expo-widgets` 支持桌面小组件和 Live Activities，但不包含在 Expo Go 中。[Expo Widgets](https://docs.expo.dev/versions/latest/sdk/widgets/)

## 能力与前提

| 能力 | 当前结论 | 所需工作／限制 |
| --- | --- | --- |
| 主屏幕图标打开 DDL Mate | 可手动配置，尚未手机验证 | 使用 iPhone 快捷指令打开当前 `exp://` 地址，再添加到主屏幕；同网、服务在线、账号条件沿用现有预览 |
| 苹果“快捷指令”小组件放几个启动按钮 | 可作为快捷入口方案，尚未手机验证 | 它展示快捷指令按钮；不会自行读取 DDL Mate 的任务或显示课程数据 |
| 点击图标直达番茄钟／新建任务／考试列表 | 技术可行，项目尚未实现 | 补充冷启动和运行中链接处理、目标白名单、编辑保护与返回路径 |
| 桌面展示今日课表、最近 DDL | 当前 Expo Go 不支持 | 独立原生构建、widget 配置、数据快照与更新时间设计 |
| 锁屏／灵动岛显示当前番茄钟 | 当前 Expo Go 不支持 | 独立构建中的 Live Activity；与已有到时通知分别实现 |
| 电脑关闭后可靠地独立使用 | 快捷入口无法实现 | 需要打包内置应用代码的独立安装版本；只安装开发客户端并连接开发服务器仍不等于离线版本 |

Apple 支持把快捷指令添加到主屏幕，也支持从其小组件运行快捷指令。[主屏幕图标](https://support.apple.com/en-gb/guide/shortcuts/apd735880972/ios)、[快捷指令小组件](https://support.apple.com/en-gb/guide/shortcuts/apd029b36d05/ios)

用户目前没有 Mac、没有付费开发者会员，也暂缓了侧载方案。本评估不重新启动侧载。EAS 云构建的 iPhone 真机开发版需要 Apple 签名与设备配置；官方云端真机路线要求 Apple Developer Program 会员。仅把代码升级到 SDK 58 不能消除该条件。[Expo 环境要求](https://docs.expo.dev/get-started/set-up-your-environment/?device=physical&mode=development-build&platform=ios)、[真机云构建流程](https://docs.expo.dev/tutorial/eas/ios-development-build-for-devices/)

## 项目事实

- `mobile/package.json`：Expo `~58.0.19`、React Native `0.88.0`，当前没有 `expo-widgets` 或 `expo-dev-client` 直接依赖。
- `mobile/app.json`：已有 `scheme: ddlmate`，插件仅 `expo-sqlite`。这不会向已安装的 Expo Go 注册独立 `ddlmate://` 协议。官方要求自定义协议变更后重新构建原生 App。[Expo 链接文档](https://docs.expo.dev/linking/into-your-app/)
- `mobile/src/navigation/RootNavigator.tsx`：`NavigationContainer` 没有传入 `linking`；全项目 `mobile/src` 未检出 `getInitialURL`、`createURL`、`openURL` 或 `linking=`。因此不能提供一个 `/--/focus` 地址就声称现在能直达番茄钟。
- `mobile/src/navigation/types.ts`：已有 `Today → FocusTime`、`Tasks → TaskForm`、`Tasks → Exams` 路由，可作为下一阶段的实际目标。
- `mobile/src/navigation/navigationDraftGuard.ts`、`mobile/src/ui/FocusReminderNotificationBanner.tsx`：已有草稿保护、导航就绪、恢复备份期间保护。新增链接须沿用这些约束，不能直接重置导航覆盖未保存内容。
- 本机只读检查 `http://192.168.31.73:8081/status` 返回 `packager-status:running`。这是电脑端服务在线证据，不代表手机快捷指令已验证。

## 现在可以手动验证的基础入口

1. 在 iPhone“快捷指令”中新建一个快捷指令，添加“URL”操作，填写 `exp://192.168.31.73:8081`。
2. 接上“打开 URL”操作，先运行一次，确认打开当前 DDL Mate 项目。
3. 命名为“DDL Mate”，在该快捷指令的详情或分享菜单选择“添加到主屏幕”，可选择名称和图标。
4. 回到主屏幕点击图标，再验证退出 Expo Go 后启动是否成功。

这个地址只对应本次检查时的局域网。手机和电脑需保持可达；网络变化导致电脑 IP 改变时，快捷指令里的地址也要改。系统可能显示跳转确认；具体菜单位置以手机系统为准。本轮未代操作手机，也未制作或安装共享快捷指令文件。

基础入口只打开项目，不能保证跳到首页或指定页面；运行中的导航状态可能保留。当前不要使用未实现的页面路径，也不要改成 `ddlmate://`。

## 建议下一次实施范围

以下是待实施方案，不是已交付功能：

1. 应用内新增“桌面快捷入口”说明页，展示当前可用启动地址与网络依赖。地址从实际运行配置取得，无法确定时明确提示，禁止把本次 IP 写死。
2. 首批只支持三个明确目的地：番茄钟、新建任务、考试列表。图标仅负责打开页面；不自动开始计时、保存任务或执行数据恢复。
3. 使用 React Native 的链接接口接收冷启动 URL 与运行中事件，保留现有 React Navigation；严格匹配当前项目地址与路径白名单。Expo Go 路径使用 `/--/` 分隔，但须实现解析后才可交付。[Expo 链接规范](https://docs.expo.dev/linking/into-your-app/)
4. 等待数据库和导航就绪后再处理。用户正在编辑、确认弹窗打开或恢复备份时显示待处理入口，让用户完成当前操作后主动打开。去重不得吞掉用户随后有意再次点击的同一入口。
5. 优先复用现有依赖与 UI；新增包、独立构建、账号签名和任何付费均不属于本次评估。

## 后续验收标准

- 冷启动与后台唤回均到达指定页面，返回按钮可回到正常列表；同一入口重复点击不堆叠页面。
- 编辑任务／番茄钟设置、打开滚轮或正在恢复备份时，不丢失草稿、不提前导航、不触发写操作。
- 未知路径、其他项目 URL 和错误参数不执行操作，不跳到错误任务；应用仍可正常进入。
- 网络地址变化后显示并使用新地址；不把暂时缓存可用宣传为脱离电脑。
- 实际 iPhone 验证主屏幕图标，以及可选的苹果快捷指令小组件按钮。模拟事件测试只能证明应用逻辑，不能代替手机验收。

未来独立 App 阶段再评估：今日课表／最近 DDL 小组件的数据快照和系统刷新策略；番茄钟 Live Activity 的截止时间、暂停、结束及恢复一致性。小组件运行环境与 React 状态隔离，需单独设计同步，不能直接复用页面组件。[Expo Widgets 运行限制](https://docs.expo.dev/versions/latest/sdk/widgets/)
