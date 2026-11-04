# 考试照片识别 — 2026-10-28 本机交付，待手机验收

用户在本轮考试版本验收中追加照片识别，提供 9590e04a09c018592e1178c84a8fbd54.jpg。按默认分工派发 DeepSeek session-70e3fbb8-236b-4119-9aa8-3a5066fd098f，两轮均 TRANSPORT、step1、无代码修改。Codex 已向用户说明沿用本轮考试版本的明确接手授权完成扩展。无 Harness 或子代理运行。

## 已实现
- 今天/任务 → 考试与复习 → 拍照／相册识别考试；复用已安装 Expo 图片选择、原图归档和识别取消控制器。
- 本机 POST /v1/ocr/exams：按图像像素定位浅色考试卡片，分离左侧暗色时段与正文，对比度处理后用现有本地中文模型识别，未安装模型时沿用本地 Tesseract。无第三方图片上传，无新增依赖。
- 校对页可修改考试名称、日期、开始/结束时刻、地点、座位、关联课程，日期/时间均滚轮。未读清的时段保留空白并警示；过去的考试保留候选但默认不勾选。最多20场，可补充遗漏项。
- 明确确认导入 EXAM 任务，倒计时采用开始时间；未知时刻仅保存日期。地点/座位/结束时间保存在描述，识别原文完整保存；同一事务写任务与截图关联。原图保留在截图库与任务原图，备份恢复保留关联。
- 同图同候选幂等；同名同开始时间的已有考试不覆盖，关联图片并提示已存在。AppStore串行队列/恢复代次/备份闸门、同步防连点、离开草稿保护、已提交但刷新失败提示、通知跳转草稿保护。

## 原图真实结果与限制
原图本机副本 .tools/photo/exam-example-20261028.jpg，未改图像字节。生产HTTP+手机同一解析逻辑的报告 .supervision/exam-photo-original-http-result.json，脚本 exam-photo-original-http.mjs；最后2026-10-28T14:55:27.781Z，约5004ms，状态 PASS_WITH_REVIEW_REQUIRED。
三场名称、日期、地点、座位均读出：大学物理实验(2)/2026-12-02/励志楼-501/7；马克思主义基本原理/2026-12-20/远航楼-1区301/59；专业导论(计算机)/2026-10-20/学汇楼-403/26。第一场12:00–13:00、第三场10:00–11:35正确。第二场暗色时间无法可靠识别，起止均留空待人工校对，绝不把09:35误当开始时间；没有在识别器写入示例答案。标点括号偶有全半角混用。支持此类浅卡片/暗背景截图；其他布局可能只输出文字，需要手动补充候选，不声称通用完美识别。已向用户明确第二场限制。

## 文件
新增 companion/src/examOcr.mjs，mobile/src/domain/examPhoto.ts、examPhotoRepository.ts、screens/ExamPhotoReviewScreen.tsx。修改 server/ocrEngine、noticeOcrClient、NoticePhotoScreen(可选examMode，默认通知不变)、ExamScreens入口、AppStore、导航types/RootNavigator/taskReminderNotificationRouter。
快照 .supervision/exam-photo-before-20261028。保留原任务/课表/截图；无schema、依赖、锁文件、app身份变更，无git清理/提交。原图副本仅留本机回归，尚未写入历史来源目录；手机自己选图时会按既有方式归档，不声称已自动在手机导入例图。

## 验证
55个独立本机检查已通过（分批）：新解析/真实SQLite导入3；原照片控制器和客户端26；实际校对TSX回调3；真实AppStore接口块/客户端路由/真实临时文件备份往返3；既有通知接线7；服务端卡片几何、实际HTTP、共享容量取消及既有通知服务回归13。日志 exam-photo-repository-tests.log、exam-photo-core-tests.log(初次fixture失败，后3/3修复)、exam-photo-screen-tests.log、exam-photo-integration-final.log、exam-photo-integration-tests.log(含7/7接线)、exam-photo-server-tests.log。最终tsc exam-photo-final-tsc.log exit0。人工视觉/手机触控仍需用户验收。
测试失败修复：合成截图status应为ARCHIVED而非SUCCESS；备份合成原图需实际file URI而非相对路径。受限环境回环fetch EACCES后审批普通本机HTTP运行通过。无真实用户数据库测试。统计调用次数最后修正为实际识别次数，最终HTTP再次核对。

## 手机预览
Expo在线预览原PID2596，exp://172.20.10.4:8081。本机OCR最终PID40496，0.0.0.0:8082，日志 exam-photo-ocr-final.stdout/stderr.log。不得用EXPO_OFFLINE，否则已登录Expo Go身份匹配失败。
真实iOS检查 .supervision/exam-photo-preview-result.json PASS SDK58 manifest/bundle200，7281740bytes，cliIdentityMatchesPhone:true，examOcr:true；二维码 .supervision/phone-preview-exam-photo-20261028.png/current-qr.png。未改网络/防火墙/VPN。
下一步手机：重载→考试与复习→拍照／相册识别考试→选择原图→识别→下一步核对，三候选/两默认选中；第二场用滚轮补选正确时段或保留仅日期；确认导入后查看考试详情/任务原图/截图库，重开仍保留。之前手动考试与复习生成/进度/重开验收仍未回答，不与本轮照片验收混为已通过。