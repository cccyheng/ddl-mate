# 番茄钟界面优化 · 2026-11-02

本次为已有番茄钟版本的界面细化，沿用本轮用户授权的 Codex 接手；不改计时、提醒、备份业务和依赖。

## 已阅读的开源参考

- [Pomotroid README](https://github.com/Splode/pomotroid/blob/main/README.md)：简洁计时主界面、阶段配色和紧凑操作。README 标明 MIT，作者 Christopher Murphy。本次参考信息层级和主题区分，不复制其图像、源码或桌面架构。
- [React Native Countdown Circle Timer](https://github.com/vydimitrov/react-countdown-circle-timer/blob/master/packages/mobile/README.md)：中心时间、圆环进度和颜色反馈。仓库标明 MIT；文档要求 SVG 依赖。本次独立使用 React Native View 制作 60 个刻度，不引入该库或 SVG，也不用其计时循环。

实际变化：森林绿专注／暖金休息、大号等宽数字（不足一小时显示分秒）、环形已完成进度、柔和中心圆面、主卡片和按钮间距、主次操作区分、双列自适应统计卡。减少动态效果沿用已有 MotionReveal，只有短入场动效，没有循环动画或独立计时器。无进度目标的正计时不显示虚假百分比。

组件 `FocusDial.tsx` 仅显示传入的时间和进度，业务计算仍在既有页面/领域层。主界面 `FocusTimeScreen.tsx` 保留所有按钮回调、写入锁、提醒错误提示及确认弹窗。

小屏和大字体适配：圆盘可用宽度不足 220 或系统字体缩放超过 1.3 时，改用自然高度的数字布局，避免文字挤在固定圆盘内。开始按钮放在本轮设置上方，便于直接开始；不影响时长和任务选择。

修改前副本 `.supervision/pomodoro-ui-before-20261102`；最终七项检查通过（两项实际圆盘组件检查、五项页面实际回调检查），TypeScript 检查通过，分别见 pomodoro-ui-final-tests.log、pomodoro-ui-tsc.log。组件检查覆盖半圈／整圈／无目标进度和窄屏／大字体布局分支。真实手机排版需用户确认，不能将源码检查当作截图验收。
