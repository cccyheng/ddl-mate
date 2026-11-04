/**
 * 真实**浏览器** OCR 回归（本次新增案例）。
 *
 * 输入读固定 fixture `tests/fixtures/notice-browser-ocr.json`（真实 Chrome + Tesseract 识别
 * 8 张样图的原文），逐字使用 notice-01-homework 的文本。fixture 是当时
 * `.supervision/notice-browser-ocr-raw.json` 的**逐字节原样副本**（只改存放位置，
 * 让测试不依赖会被后续验收覆盖的 .supervision 证据文件）；不改字、不注入 expected。
 *
 * fixture 来源：Codex 真实浏览器验收（Chrome + Tesseract）对 `frontend/public/samples/notices/`
 * 下 8 张合成样图的识别原文，采集时保存于 `.supervision/notice-browser-ocr-raw.json`。
 *
 * 背景（Codex 浏览器验收发现）：notice-01 的 `提交要求: 实验报告PDF，文件命名学号-姓名。`
 * 被空行切成独立块，于是多出第二个没有截止时间的候选（8 张图共 12 个候选，期望 11 个）。
 * 该段是对第一条任务的附加说明，不是新任务。
 *
 * 本文件锁定：
 *   - notice-01 只 1 个候选，deadline = 2026-10-20T22:00，submitRequirement 含「实验报告PDF」；
 *   - 8 张真实 OCR 图合计 11 个候选；
 *   - 带明确序号的真实独立任务仍按编号拆分，附加信息段不会把它误并。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeOcrText, parseNoticeText } from '../src/ocr/noticeParser.js';

const courses = [
  { id: 1, name: '数据结构' },
  { id: 2, name: '大学物理' },
  { id: 3, name: '大学英语' },
  { id: 4, name: '高等数学' },
  { id: 5, name: '软件工程' },
];

/**
 * 固定 fixture：真实浏览器 OCR 原文（缺失即测试失败，而不是静默跳过）。
 * 内容与采集时的 `.supervision/notice-browser-ocr-raw.json` 完全一致（sha256 见 status JSON）。
 */
const rawOcr = JSON.parse(
  readFileSync(new URL('./fixtures/notice-browser-ocr.json', import.meta.url), 'utf8'),
);

function browserOcrText(name) {
  const entry = rawOcr.find((item) => item.name === name);
  assert.ok(entry, `缺少真实浏览器 OCR 证据：${name}`);
  return entry.text;
}

const parse = (text) => parseNoticeText(normalizeOcrText(text), { courses, sourceRef: 'src-browser-ocr' });

test('真实浏览器OCR notice-01：提交要求并入前一条任务，只 1 个候选', () => {
  const source = browserOcrText('notice-01-homework');
  // 证据原文必须逐字使用：先确认关键片段确实来自证据文件
  assert.ok(source.includes('提交要求: 实验报告PDF'), source);

  const candidates = parse(source);
  assert.equal(candidates.length, 1, JSON.stringify(candidates.map((candidate) => candidate.title)));
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.ok(
    candidates[0].submitRequirement.includes('实验报告PDF'),
    candidates[0].submitRequirement,
  );
  // 附加信息段是并入同一条任务，而不是被丢掉
  assert.ok(candidates[0].rawText.includes('提交要求'));
  assert.ok(candidates[0].rawText.includes('实验报告PDF'));
  // 群头发送时间不是截止时间
  assert.notEqual(candidates[0].deadline, '2026-10-08T09:12');
});

test('真实浏览器OCR 8 张图合计 11 个候选（notice-01 不再多出空候选）', () => {
  const counts = rawOcr.map((item) => ({ name: item.name, count: parse(item.text).length }));
  assert.equal(
    counts.reduce((sum, item) => sum + item.count, 0),
    11,
    JSON.stringify(counts),
  );
  assert.equal(counts.find((item) => item.name === 'notice-01-homework').count, 1);
});

test('带明确序号的真实独立任务仍按编号拆分，附加信息段不误并', () => {
  const text = [
    '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
    '提交要求：实验报告PDF',
    '',
    '2. 大学物理第三次作业：2026年11月3日 14:00 前交纸质稿',
    '备注：纸质稿交到课代表',
  ].join('\n');
  const candidates = parse(text);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].deadline, '2026-10-20T22:00');
  assert.equal(candidates[1].deadline, '2026-11-03T14:00');
  assert.ok(candidates[0].submitRequirement.includes('实验报告PDF'));
  assert.ok(candidates[1].rawText.includes('备注'));
  assert.ok(!candidates[0].rawText.includes('大学物理'));
});
