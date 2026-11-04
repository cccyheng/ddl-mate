/**
 * 通知解析器单元测试（纯函数）。
 *
 * 重点验证「保守、可解释」：
 *   - 完整日期 + 时刻才给 DDL，并且必须带 +08:00；
 *   - 聊天发送时间不能当截止时间；
 *   - 月日无年 / 仅日期 / 明天 / 下周五 / 下节课前 → 留空 + 提示；
 *   - 不存在的日期（2 月 30 日 / 25:00）→ 留空 + 提示；
 *   - 多任务的标题、要求、截止时间不能互相串联；
 *   - 邮箱与 URL 不被标点切碎。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTICE_HINTS,
  extractDeadline,
  extractSubmitMethod,
  extractTitle,
  findDateTimes,
  guessTaskType,
  matchCourse,
  parseNoticeText,
  splitSegments,
  toOffsetDateTime,
  validYmd,
} from '../src/ocr/noticeParser.js';

const courses = [
  { id: 7, name: '数据结构', code: 'CS201' },
  { id: 8, name: '大学物理', code: 'PH101' },
];

test('完整中文日期时间 → 候选截止时间（不带时区，保存时补 +08:00）', () => {
  const result = extractDeadline('请于 2026年10月15日 22:00 前提交实验报告');
  assert.equal(result.deadline, '2026-10-15T22:00');
  assert.equal(toOffsetDateTime(result.deadline), '2026-10-15T22:00:00+08:00');
});

test('ISO 风格日期时间同样识别', () => {
  const result = extractDeadline('截止：2026-11-03 14:30，学习通提交');
  assert.equal(result.deadline, '2026-11-03T14:30');
});

test('中文时辰前缀换算成 24 小时制（晚上 8 点 → 20:00）', () => {
  assert.equal(extractDeadline('2026年10月15日晚上8点前交').deadline, '2026-10-15T20:00');
  assert.equal(extractDeadline('2026年10月15日下午3点前交').deadline, '2026-10-15T15:00');
});

test('聊天发送时间不能当截止时间：第一组日期时间是消息时间', () => {
  const result = extractDeadline('2026年10月8日 08:30 王老师：请下周一交作业');
  assert.equal(result.deadline, '');
  assert.ok(result.hints.includes(NOTICE_HINTS.deadlineChatTime));
  assert.ok(result.hints.some((hint) => hint.includes('相对说法')));
});

test('通知时间与截止时间同时存在时，必须选后者', () => {
  const result = extractDeadline('通知时间：2026-10-08 08:30；截止：2026-10-15 22:00');
  assert.equal(result.deadline, '2026-10-15T22:00');
});

test('带发送者冒号的 ISO 时间戳也不会被当成 DDL', () => {
  const result = extractDeadline('2026-10-08 20:15 李老师：请大家在本周日前完成阅读');
  assert.equal(result.deadline, '');
});

test('不存在的日期与非法时刻 → 留空并提示', () => {
  const result = extractDeadline('2026年2月30日23:59截止');
  assert.equal(result.deadline, '');
  assert.ok(result.hints.includes(NOTICE_HINTS.deadlineInvalid));
  const badHour = extractDeadline('2026-10-15 25:00截止');
  assert.equal(badHour.deadline, '');
  assert.ok(badHour.hints.some((hint) => hint.includes('不存在')));
});

test('月日无年 / 仅日期 / 仅时刻都不猜，保留原话提示', () => {
  const noYear = extractDeadline('10月15日交作业');
  assert.equal(noYear.deadline, '');
  assert.ok(noYear.hints.includes(NOTICE_HINTS.deadlineNoYear));

  const noTime = extractDeadline('2026年10月15日交作业');
  assert.equal(noTime.deadline, '');
  assert.ok(noTime.hints.includes(NOTICE_HINTS.deadlineNoTime));

  const timeOnly = extractDeadline('今晚 22:00 前提交');
  assert.equal(timeOnly.deadline, '');
  assert.ok(timeOnly.hints.length > 0);
});

test('明天 / 下周五 / 下节课前都不能按当前日期猜', () => {
  for (const text of ['明天下午交实验报告', '下周五前交作业', '下节课前把预习报告交了']) {
    const result = extractDeadline(text);
    assert.equal(result.deadline, '', text);
    assert.ok(result.hints.length > 0, text);
  }
});

test('月份与日期越界不算完整日期', () => {
  assert.equal(validYmd(2026, 13, 1), false);
  assert.equal(validYmd(2026, 4, 31), false);
  assert.equal(validYmd(2026, 2, 30), false);
  assert.equal(validYmd(2026, 2, 28), true);
  assert.equal(validYmd(2024, 2, 29), true);
  assert.equal(extractDeadline('2026-13-01 10:00 截止').deadline, '');
});

test('toOffsetDateTime 只接受完整本地日期时间并补 +08:00', () => {
  assert.equal(toOffsetDateTime('2026-10-15T22:00'), '2026-10-15T22:00:00+08:00');
  assert.equal(toOffsetDateTime('2026-10-15T22:00:30'), '2026-10-15T22:00:30+08:00');
  assert.equal(toOffsetDateTime('2026-10-15'), null);
  assert.equal(toOffsetDateTime(''), null);
  assert.equal(toOffsetDateTime('2026-02-30T10:00'), null);
  assert.equal(toOffsetDateTime('2026-10-15T24:00'), null);
});

test('findDateTimes 不会把长日期的尾部再当成一次短日期', () => {
  const items = findDateTimes('2026年10月15日 22:00 前提交');
  const dateRaws = items.filter((item) => item.kind === 'date').map((item) => item.raw);
  assert.deepEqual(dateRaws, ['2026年10月15日']);
});

test('标题去掉序号与日期时间，保留动作文字', () => {
  // 只移除日期/时刻片段本身：后面的任务内容（「提交实验报告」）必须保留，不能从日期处截断
  assert.equal(extractTitle('1. 请于 2026年10月15日 22:00 前提交实验报告'), '请于提交实验报告');
  assert.equal(extractTitle('作业二：撰写课程设计开题报告'), '撰写课程设计开题报告');
  assert.equal(extractTitle('3、完成课后习题 5.1-5.5'), '完成课后习题 5.1-5.5');
  // 聊天抬头行没有动作 / 任务名词，标题取下一行
  assert.equal(extractTitle('2026-10-08 08:30 王老师：\n提交要求：实验报告 PDF'), '提交要求：实验报告 PDF');
  // 标题只是可编辑初稿：至少不能把日期留进去，也不能把任务名截断丢掉
  const title = extractTitle('1. 请于 2026年10月15日 22:00 前提交实验报告');
  assert.ok(!title.includes('2026'));
  assert.ok(title.includes('实验报告'));
  // 序号后面直接是任务名：序号要清掉，任务名要完整（「第三次作业」不能变成「次作业」）
  assert.equal(extractTitle('1. 交数据结构作业：2026年10月20日 22:00 前'), '交数据结构作业');
  assert.equal(extractTitle('第三次作业请在 2026年10月20日 22:00 前提交到学习通'), '第三次作业请在提交到学习通');
});

test('任务类型按关键词保守推断', () => {
  assert.equal(guessTaskType('提交实验报告'), 'LAB');
  assert.equal(guessTaskType('课程设计开题报告'), 'PROJECT');
  assert.equal(guessTaskType('下周一随堂测验'), 'EXAM');
  assert.equal(guessTaskType('完成课后习题'), 'HOMEWORK');
});

test('提交方式保留邮箱等地址，不被标点切碎', () => {
  assert.equal(extractSubmitMethod('请提交到 a+b@example.edu.cn'), 'a+b@example.edu.cn');
  assert.equal(extractSubmitMethod('提交到学习通'), '学习通');
  assert.equal(extractSubmitMethod('交纸质稿到办公室'), '纸质');
  // 只有泛化词（平台/系统/网站）时不给「方式」，避免没有信息量
  assert.equal(extractSubmitMethod('在 https://example.edu/a?x=1 上提交'), '');
  assert.equal(extractSubmitMethod('提交到平台'), '');
  assert.equal(extractSubmitMethod('无任何平台线索'), '');
});

test('课程只做完全一致匹配，不把高等数学实验并进高等数学', () => {
  assert.equal(matchCourse('高等数学实验报告', [{ id: 1, name: '高等数学', code: 'MA101' }]), null);
  assert.equal(matchCourse('数据结构实验报告', courses), null);
  assert.equal(matchCourse('数据结构第三次作业', courses)?.id, 7);
  assert.equal(matchCourse('CS201 作业', courses)?.id, 7);
  assert.equal(matchCourse('数据结构', courses)?.id, 7);
  assert.equal(matchCourse('与两门课同名长度冲突', [
    { id: 1, name: '大学物理', code: 'PH101' },
    { id: 2, name: '大学化学', code: 'CH101' },
  ]), null);
});

test('多任务按序号拆分，各自独立、互不串联', () => {
  const text = [
    '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
    '2. 大学物理第三次作业：2026年11月3日 14:00 前交纸质稿',
  ].join('\n');
  const candidates = parseNoticeText(text, { courses, sourceRef: 'src-1' });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.equal(candidates[1].deadline, '2026-11-03T14:00');
  assert.equal(candidates[0].courseId, 7);
  assert.equal(candidates[1].courseId, 8);
  assert.equal(candidates[0].sourceRef, 'src-1');
  assert.ok(candidates[1].rawText.includes('大学物理'));
  assert.ok(!candidates[0].rawText.includes('大学物理'));
});

test('第二条缺时间时不能沿用第一条的 DDL', () => {
  const text = ['1. 交数据结构作业：2026年10月20日 22:00 前', '2. 交大学物理实验报告'].join('\n');
  const candidates = parseNoticeText(text, { courses });
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.equal(candidates[1].deadline, '');
  assert.ok(candidates[1].hints.length > 0);
});

test('同一行里两组任务也能拆开（作业一/作业二）', () => {
  const text = '作业一：2026年10月12日 18:00 前交大学物理实验报告；作业二：2026年10月20日 23:00 前提交数据结构作业';
  const segments = splitSegments(text);
  assert.equal(segments.length, 2);
  const candidates = parseNoticeText(text, { courses });
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].deadline, candidates[1].deadline);
});

test('没有年份的多任务也不互相借年份/时刻', () => {
  const text = ['1. 数据结构作业：10月20日交', '2. 大学物理实验：11月3日 14:00 交'].join('\n');
  const candidates = parseNoticeText(text, { courses });
  assert.equal(candidates[0].deadline, '');
  assert.equal(candidates[1].deadline, '');
});

test('纯文字通知也能生成一条候选（可编辑）', () => {
  const candidates = parseNoticeText('下周三前把选课确认表交到教务', { courses: [] });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].deadline, '');
  assert.equal(candidates[0].courseId, null);
  assert.ok(candidates[0].hints.some((hint) => hint.includes('课程')));
});

test('空文本不产生候选', () => {
  assert.deepEqual(parseNoticeText('', { courses }), []);
  assert.deepEqual(parseNoticeText('   \n  ', { courses }), []);
});

test('maxTasks 限制候选数量', () => {
  const text = Array.from({ length: 5 }, (_, i) => `${i + 1}. 任务${i + 1}：2026年10月${10 + i}日 10:00 前交`).join('\n');
  assert.equal(parseNoticeText(text, { maxTasks: 3 }).length, 3);
});

test('候选保留来源引用与原文，供保存时回填 sourceRefs', () => {
  const candidates = parseNoticeText('2026年10月15日 22:00 前提交数据结构作业', {
    courses,
    sourceRef: 'src-3',
    sourceName: '数据结构群',
  });
  assert.equal(candidates[0].sourceRef, 'src-3');
  assert.equal(candidates[0].sourceName, '数据结构群');
  assert.equal(candidates[0].rawText, '2026年10月15日 22:00 前提交数据结构作业');
});

test('通知时间与截止时间分行的截图文本也能选对截止时间', () => {
  const text = ['2026-10-08 08:30 王老师：', '本周作业：', '提交要求：实验报告 PDF', '截止 2026-10-15 22:00'].join('\n');
  const result = extractDeadline(text);
  assert.equal(result.deadline, '2026-10-15T22:00');
});
