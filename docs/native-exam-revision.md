# 考试与复习 — 2026-10-28 本机实现完成，等待手机验收

当前范围已由用户明确授权 Codex 接手。用户“继续别停”在获知 5% 紧急规则后明确要求继续，本轮按例外执行；最新账户读数短窗口剩95%、周窗口剩99%，ordinaryUsageAllowed=true。无 Harness 或子代理运行。

## 已实现
- 今天和任务页的“考试与复习”入口，按状态与日期显示考试倒计时；新建默认为考试，复用原任务表单、编辑与详情。
- 复习页面支持滚轮日期、多选星期、每行一个主题和每次预计分钟数；日期为今天至考试前一天，最多30次、跨度90天，主题顺序循环。先预览，再明确确认创建普通复习任务；可在任务、日历查看。
- 显示每份安排中真实任务的完成进度、已删除条目与任务详情入口。更改考试日期不自动移动已有任务，不承诺按空闲时段排课或AI生成。
- AppStore复用串行读写队列、备份闸门和恢复generation校验；仓库单事务保存任务与计划，幂等重放；同步防连点、旧考试/午夜/恢复后预览失效、离开草稿确认。已提交而刷新失败明确提示成功，不误导再次创建。
- 计划进入现有备份；严格校验元数据，恢复任务ID高水位；没有新字段的旧备份会清掉当前计划，不保留错误关联。通知跳转保守保护ExamRevision草稿。

## 文件与验证
新增 mobile/src/screens/ExamScreens.tsx，之前的 domain/examRevision.ts 与 examRevisionRepository.ts。修改AppStore、导航types/RootNavigator、TodayScreen/TaskListScreen、TaskFormScreen、backupFormat/backupService、taskReminderNotificationRouter、notificationNavigationDiagnostics。
新增 tests/examScreens.test.mjs（5项实际TSX回调）、examRevisionStore.test.mjs（3项真实AppStore API块+SQLite）。.supervision/exam-revision-ui-tests.log 8/8。原核心13、备份关联7的20个独立用例保持通过；备份用例扩展旧版本恢复后重跑成功，exam-revision-legacy-backup-tests.log 1/1。通知回归26/26（含新复习草稿断言），exam-notification-regression.log。合计54个独立用例，非全部本轮重新运行。最终类型检查exam-revision-final-tsc.log exit0。
测试修正记录：TSX测试在初次读取后才放入模拟计划，改为调用真实刷新回调；AppStore代码片段需TS编译后在VM执行，补相同Error构造器；临时备份改名受限目录EPERM后获审批在普通临时目录运行成功。未读取真实用户数据库或照片。

## 交付与剩余
SDK58真实iOS manifest和bundle已200，.supervision/exam-preview-result.json和exam-preview-check.mjs；最终预览将重验并记录。exp://172.20.10.4:8081，二维码.supervision/phone-preview-exams-20261028.png。此轮未检查/启动OCR，功能不依赖OCR。
无依赖/schema/app身份/用户数据变更，无git提交或清理；源目录依然untracked。改前快照.supervision/exam-revision-ui-before-20261028和exam-revision-before-20261028-backup。原已验收周报、模板、截图恢复保留。
手机验收待办：今天/任务→考试与复习→新增未来考试→安排两主题、短日期范围与星期→预览确认→任务列表/日历看到生成任务；完成一条后回安排页进度更新；完全关闭再开仍有安排。实际原生排版、触控和持久化不能只由本机模拟测试代替，尚未标记整版手机验收完成。
## 2026-10-28 EXAM PHONE OPEN FAILURE — AUTH IDENTITY CORRECTED, RETEST PENDING
User reported打不开新版. Actual MetroPID12252 log repeated Expo Go signedin account but CLI not signedin error. Port8081 listening; previous launch EXPO_OFFLINE=1 skips installedSDK58 CLI getUserAsync identity resolution (verified node_modules/@expo/cli/build/src/api/user/user.js and ManifestMiddleware), so manifest omitted username despite credentials valid. This was a preview launch configuration defect; acknowledged to user. Existing expo whoami with EXPO_OFFLINE removed returned matching phone account; no login needed, no credentials read or displayed. Stopped only ownPID12252 aftercommand verification, restarted existing CLI onlinewatchmode hiddenPID2596, same172.20.10.4:8081, logs exam-preview-auth.stdout/stderr.log. No appsource/data/deps/identity/firewallchanges. Updated .supervision/exam-preview-check.mjs to assert actualmanifest extra.expoGo.username matches phone; removed fakeunusedOCRhealth stub, OCRstillnotchecked. Final PASS2026-10-28T06:45:43.414Z manifest/bundle2007256629bytes SDK58 cliIdentityMatchesPhone:true, result exam-preview-result.json; currentQR and phone-preview-exams-20261028.png refreshed. Prior bundle200 alone didnotprove phoneopening; nowexplicitidentitychecked, stillawait actualphone reopen. Ask closeoldExpoGoerror andrescan sameQR on samenetwork; do not logphoneacceptanceuntiluserconfirms. Quota short80/week97remaining ordinarytrue atstart. Scope remains authorizedexamversion, no newmodule. Latestcheckpoint supersedesoffline launch guidance: doNOTuseEXPO_OFFLINE withsignedinExpoGo. Next userphoneoutcome thenfeatureacceptance list previouslysaved.
