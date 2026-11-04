# 考试照片识别界面参考

更新：2026-10-30。范围：原生端考试照片选择、识别状态、考试校对卡片。

用户要求参考 GitHub 开源界面。以下仓库通过 GitHub 读取 README、实际组件及许可证后用于布局参考；本次未复制第三方代码、图片、字体或品牌，也没有安装第三方组件库。

## React Native Paper / Callstack

- 项目：https://github.com/callstack/react-native-paper
- 实际参考：https://github.com/callstack/react-native-paper/blob/main/example/src/Examples/CardExample.tsx
- 许可证：https://github.com/callstack/react-native-paper/blob/main/LICENSE.md
- 核对结果：MIT，Copyright (c) 2017 Callstack。
- 采用的布局思路：照片封面、标题、内容、主要操作分区；主要按钮与次要按钮有明确层次；低对比背景承载次级信息。
- 在 DDL Mate 中独立实现：照片卡片、识别完成提示区域、展开式说明。沿用暖白与森林绿配色。

## TaskNexus / Son Nguyen

- 项目：https://github.com/hoangsonww/Task-Manager-ReactNative
- 实际参考：https://github.com/hoangsonww/Task-Manager-ReactNative/blob/master/components/TaskItem.tsx
- 许可证：https://github.com/hoangsonww/Task-Manager-ReactNative/blob/master/LICENSE
- 核对结果：MIT，Copyright (c) 2025 Son Nguyen。README 另说明这是教学项目，并请求使用代码时保留作者署名。
- 采用的布局思路：每条记录的选择状态、标题、日期和编辑入口相互分离，选中状态用边框及颜色提示。
- 在 DDL Mate 中独立实现：考试卡片、圆形勾选、选中边框、摘要与展开编辑。日期块及考场/座位分行是针对考试信息新增的设计。

## 实现与限制

- `mobile/src/screens/ExamPhotoCaptureView.tsx`：三步指示、原生 View 绘制的文档示意图、照片预览与操作、失败及缺失字段提示。
- `mobile/src/screens/ExamPhotoReviewScreen.tsx`：三项数量摘要、日期卡片、分行信息、单卡编辑与既有滚轮。
- 不修改 OCR 算法、考试解析、存储、原图归档、导入去重、应用身份或依赖。
- 文档示意图只用于空状态装饰，不代表识别成功。照片缩略图来自用户当前选择。
- 现有原生组件测试与类型检查不能代替 iPhone 真机排版验证。未将网页模拟预览作为真机验收证据。
