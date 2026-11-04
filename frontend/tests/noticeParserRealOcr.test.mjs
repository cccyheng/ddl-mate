/**
 * 真实 OCR 文本回归（**不是**把 expected 注入解析器，而是把识别结果当作输入）。
 *
 * 输入来自 `.supervision/notice-ocr-probe.json`（真实 Tesseract 识别 8 张合成样图的结果），
 * 这里只覆盖最关键的 4 张：
 *   - 03 两条编号任务 → 2 条候选，末条不串第一条的时间；
 *   - 07 三条编号任务 → 3 条候选，末条是 2027-01-08T12:00（第三条不能被吃掉）；
 *   - 04 邮箱被 OCR 换行断开 → 邮箱与正文仍是一条，DDL 2026-10-18T18:00；
 *   - 02/05/06 没有明确截止 → DDL 留空。
 *
 * 另外覆盖三个保守性要求：中午 1 点 = 13:00、活动开始时间不能当 DDL、
 * 两组都像截止又不能确定时留空。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_HINTS, extractDeadline, normalizeOcrText, parseNoticeText } from '../src/ocr/noticeParser.js';

const courses = [
  { id: 1, name: '数据结构' },
  { id: 2, name: '大学物理' },
  { id: 3, name: '大学英语' },
  { id: 4, name: '高等数学' },
  { id: 5, name: '软件工程' },
];

/** 真实 OCR 输出（逐字保留，包括 OCR 的错字与换行）。 */
const OCR = {
  notice01: [
    '数据结构课程群 Bi',
    '',
    '2026年10月8日 09:12 张老师',
    '',
    '各位同学:',
    '',
    '第三次作业请在 2026年10月20日 22:00 前提交到学习',
    '通，',
    '',
    '提交要求: 实验报告PDF，文件命名 学号-姓名。',
    '',
    '(合成示例图，不是真实聊天记录)',
    '',
  ].join('\n'),
  notice02: [
    '大学物理课程群 让',
    '2026年10月8日 08:30 王老师',
    '',
    '请下周一交实验预习报告，纸质稿安到课代表那里。',
    '(合成示例图: 只有聊天发送时间，不是截止时间)',
  ].join('\n'),
  notice03: [
    '本周作业通知 《合成示例) 让',
    '',
    '第 8 周作业清单',
    '',
    '1. 数据结构作业三: 2026年10月20日 22:00 前提交到',
    '学习通',
    '',
    '2. 大学物理第三次作业: 2026年11月3日 14:00 前交纸',
    '质稿',
    '',
    '(合成示例图: 两条任务各有自己的时间)',
  ].join('\n'),
  notice04: [
    '软件工程课程群 让',
    '',
    '2026年10月9日 15:40 李老师',
    '',
    '课程设计开题报告请于 2026年10月18日 18:00 前发送',
    '到',
    '',
    'a+b@example.edu.cn，主题写学号。',
    '',
    '(合成示例图; 邮箱地址不能被标点切碎)',
  ].join('\n'),
  notice05: [
    '班级群通知 部',
    '2026年9月28日 20:05 班长',
    '',
    '选课确认表请在 10月15日 交到教务处，过期不补。',
    '(合成示例图: 只有月日、没有年份)',
  ].join('\n'),
  notice06: [
    '实验课群 wm',
    '',
    '2026年10月7日 21:10 实验员',
    '',
    '下节课前把预习报告写好带过来，明天下午的实验照常',
    '进行。',
    '',
    '(合成示例图: 相对时间不能猜)',
  ].join('\n'),
  notice07: [
    '期末任务清单 〈合成示例) 让',
    '期末三项任务',
    '1. 高等数学作业册: 2026年12月20日 23:00 前交给学',
    '习委员',
    '2. 大学英语作文: 2026年12月25日 17:30 前提交到十',
    '课堂',
    '3. 数据结构课程设计: 2027年1月8日 12:00 前答辩',
    '(合成示例图: 批量识别 + 勾选)',
  ].join('\n'),
  notice08: [
    '教务通知 让',
    '',
    '2026年10月11日 10:00 教务处',
    '教学评价请在 2026年10月30日 16:00 前完成，',
    '人入口见 https:WVexample.edu/eval?term=2026F 。',
    '(合成示例图: URL 原样保留)',
  ].join('\n'),
};

const parse = (text) => parseNoticeText(normalizeOcrText(text), { courses, sourceRef: 'src-ocr' });

test('真实OCR 03：两条编号任务各带自己的时间', () => {
  const candidates = parse(OCR.notice03);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.equal(candidates[1].deadline, '2026-11-03T14:00');
  assert.ok(candidates[0].rawText.includes('数据结构'));
  assert.ok(!candidates[0].rawText.includes('大学物理'));
});

test('真实OCR 07：三条编号任务，末条是 2027-01-08T12:00', () => {
  const candidates = parse(OCR.notice07);
  assert.equal(candidates.length, 3);
  assert.deepEqual(
    candidates.map((candidate) => candidate.deadline),
    ['2026-12-20T23:00', '2026-12-25T17:30', '2027-01-08T12:00'],
  );
  assert.ok(candidates[2].title.includes('数据结构课程设计'), candidates[2].title);
});

test('真实OCR 04：邮箱被 OCR 断行也还是一条，DDL 18:00', () => {
  const candidates = parse(OCR.notice04);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].deadline, '2026-10-18T18:00');
  assert.ok(candidates[0].rawText.includes('a+b@example.edu.cn'));
  assert.ok(candidates[0].rawText.includes('课程设计开题报告'));
  assert.equal(candidates[0].submitMethod, 'a+b@example.edu.cn');
});

test('真实OCR 01：群头时间不是 DDL，明确截止正确', () => {
  const candidates = parse(OCR.notice01);
  // 主任务 + 「提交要求」字段段（都是真实内容，不会被当成空候选丢掉）
  assert.ok(candidates.length >= 1 && candidates.length <= 2, String(candidates.length));
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.equal(candidates[0].submitMethod, '学习通');
  assert.ok(candidates[0].title.includes('作业'), candidates[0].title);
  assert.ok(candidates[0].rawText.includes('学习通'));
  assert.ok(candidates.some((candidate) => candidate.submitRequirement.includes('实验报告PDF')));
  for (const candidate of candidates) {
    assert.notEqual(candidate.deadline, '2026-10-08T09:12', '群头发送时间不能当 DDL');
  }
});

test('真实OCR 08：正文里的明确截止正确，群头时间被忽略', () => {
  const candidates = parse(OCR.notice08);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].deadline, '2026-10-30T16:00');
});

test('真实OCR 02/05/06：没有明确截止时间 → DDL 留空并给提示', () => {
  for (const key of ['notice02', 'notice05', 'notice06']) {
    const candidates = parse(OCR[key]);
    assert.ok(candidates.length >= 1, key);
    for (const candidate of candidates) {
      assert.equal(candidate.deadline, '', `${key} 不应猜出 DDL`);
      assert.ok(candidate.hints.length > 0, key);
    }
  }
});

test('中午 1 点是 13:00，不能变成 01:00', () => {
  const result = extractDeadline('请于2026年10月15日中午1点前提交作业');
  assert.equal(result.deadline, '2026-10-15T13:00');
});

test('活动开始时间不是截止时间：不能因为只有一组就自动填入', () => {
  const result = extractDeadline('课程通知：2026年10月15日09:00开始讲座，报告下周交');
  assert.equal(result.deadline, '');
  assert.ok(result.hints.length > 0);
});

test('两组都带截止语境时留空让用户选，不静默猜', () => {
  const result = extractDeadline('提交截止 2026年10月15日 22:00，补交截止 2026年10月20日 22:00');
  assert.equal(result.deadline, '');
  assert.ok(result.hints.includes(NOTICE_HINTS.deadlineAmbiguous));
  assert.equal(result.options.length, 2);
});
