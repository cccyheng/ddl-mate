import {
  splitSegments,
  extractDeadline,
  extractTitle,
  extractSubmitMethod,
  matchCourse,
  findDateTimes,
  isChatTimestamp,
} from '../src/ocr/noticeParser.js';

const show = (label, value) => console.log(label, JSON.stringify(value, null, 1));

show('chat-deadline', extractDeadline('2026年10月8日 08:30 王老师：请下周一交作业'));
show('chat-items', findDateTimes('2026年10月8日 08:30 王老师：请下周一交作业'));
show('iso-chat', extractDeadline('2026-10-08 20:15 李老师：请大家在本周日前完成阅读'));
show('iso-items', findDateTimes('2026-10-08 20:15 李老师：请大家在本周日前完成阅读'));
show('title1', extractTitle('1. 请于 2026年10月15日 22:00 前提交实验报告'));
show('title2', extractTitle('2026-10-08 08:30 王老师：\n提交要求：实验报告 PDF'));
show('method-email', extractSubmitMethod('请提交到 a+b@example.edu.cn'));
show('method-paper', extractSubmitMethod('交纸质稿到办公室'));
show('method-platform', extractSubmitMethod('提交到平台'));
const courses = [
  { id: 7, name: '数据结构', code: 'CS201' },
  { id: 8, name: '大学物理', code: 'PH101' },
];
show('course-exp', matchCourse('数据结构实验报告', courses));
show('course-hw', matchCourse('数据结构第三次作业', courses));
show('course-exact', matchCourse('数据结构', courses));
const text = ['1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通', '2. 大学物理实验报告：2026年11月3日 14:00 前交纸质稿'].join('\n');
show('segments', splitSegments(text));
show('chat-ts-check', [
  isChatTimestamp('2026年10月8日 08:30 王老师：请下周一交作业', findDateTimes('2026年10月8日 08:30 王老师：请下周一交作业')[0]),
]);
