/**
 * 候选池与保存 payload 的单元测试。
 *
 * 覆盖验收里最容易出错的地方：
 *   - 同一来源多任务、一条候选多来源；
 *   - 用户编辑过的字段不被重解析静默覆盖（返回冲突）；
 *   - 来源删改后候选映射跟着维护，不出现指向不存在来源的引用；
 *   - 未勾选的候选 / 未被引用的来源与图片不进 payload、不上传；
 *   - 保存前的大小与数量预校验、deadline 带 +08:00。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MERGE_STATUS,
  addManualCandidate,
  candidateIdentity,
  candidatesMissingSource,
  candidatesWithUnknownSource,
  createCandidate,
  createNoticeSource,
  detachSource,
  markEdited,
  mergeSourceCandidates,
  normalizeCandidateText,
  pruneOrphanCandidates,
  resetCandidateIds,
  resetSourceIds,
} from '../src/ocr/candidatePool.js';
import {
  DEFAULT_LIMITS,
  buildImportPayload,
  formatBytes,
  normalizeLimits,
  rawTextLength,
  sourceFiles,
  usedFilesBytes,
  validateSelection,
} from '../src/ocr/importPayload.js';
import { parseNoticeText } from '../src/ocr/noticeParser.js';
import { fromShanghaiWallClock, toShanghaiWallClock } from '../src/utils/datetime.js';

const courses = [{ id: 7, name: '数据结构', code: 'CS201' }];

function fakeFile(name, size) {
  return { name, size, type: 'image/png' };
}

function setup() {
  resetCandidateIds();
  resetSourceIds();
  const source = createNoticeSource({ name: '数据结构群', type: 'IMAGE', rawText: '', file: fakeFile('a.png', 1000) });
  return source;
}

test('解析结果合并进候选池：来源多任务共享同一个 sourceRef', () => {
  const source = setup();
  source.rawText = '1. 数据结构作业：2026年10月20日 22:00 前提交\n2. 数据结构实验报告';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref, sourceName: source.name });
  const candidates = mergeSourceCandidates([], source, parsed);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].sourceRefs, [source.ref]);
  assert.deepEqual(candidates[1].sourceRefs, [source.ref]);
  assert.notEqual(candidates[0].id, candidates[1].id);
});

test('候选身份由来源 + 片段 + 原文决定，文本没变时身份稳定', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const first = mergeSourceCandidates([], source, parsed);
  const second = mergeSourceCandidates(first, source, parsed);
  assert.equal(second.length, 1);
  assert.equal(second[0].id, first[0].id);
  assert.equal(candidateIdentity(second[0]), candidateIdentity(first[0]));
});

test('重新解析不会静默覆盖用户改过的标题，并标记冲突', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  markEdited(candidates[0], 'title');
  candidates[0].title = '我自己改的标题';

  const reparsed = parseNoticeText('数据结构作业：2026年10月25日 22:00 前提交（老师改了时间）', {
    courses,
    sourceRef: source.ref,
  });
  const merged = mergeSourceCandidates(candidates, source, reparsed);
  assert.equal(merged[0].title, '我自己改的标题');
  assert.ok(merged[0].conflictFields.includes('title'));
});

test('用户确认覆盖后才用新识别结果替换已编辑字段', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  markEdited(candidates[0], 'title');
  candidates[0].title = '旧标题';
  const reparsed = parseNoticeText('数据结构作业：2026年10月25日 22:00 前提交', { courses, sourceRef: source.ref });
  const merged = mergeSourceCandidates(candidates, source, reparsed, { applyConflicts: true });
  assert.equal(merged[0].title, reparsed[0].title);
  assert.ok(!(merged[0].conflictFields ?? []).includes('title'));
});

test('未编辑的截止时间会跟着原文更新（用户没动过就不算覆盖）', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  const reparsed = parseNoticeText('数据结构作业：2026年10月25日 22:00 前提交', { courses, sourceRef: source.ref });
  const merged = mergeSourceCandidates(candidates, source, reparsed);
  assert.equal(merged[0].deadline, '2026-10-25T22:00');
});

test('重识别后原文变短：旧候选标为 stale 而不是静默删除', () => {
  const source = setup();
  source.rawText = '1. 数据结构作业：2026年10月20日 22:00 前提交\n2. 数据结构实验报告';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  const shorter = parseNoticeText('1. 数据结构作业：2026年10月20日 22:00 前提交', {
    courses,
    sourceRef: source.ref,
  });
  const merged = mergeSourceCandidates(candidates, source, shorter);
  assert.equal(merged.length, 2);
  const stale = merged.filter((row) => row.stale);
  assert.equal(stale.length, 1);
  assert.ok(stale[0].title.includes('实验') || stale[0].rawText.includes('实验'));
});

test('手工新增的候选不受重新解析影响', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  let candidates = mergeSourceCandidates([], source, parsed);
  candidates = addManualCandidate(candidates, source.ref, { id: 'manual-1' });
  assert.equal(candidates.length, 2);
  const merged = mergeSourceCandidates(candidates, source, parsed);
  assert.equal(merged.filter((row) => row.manual).length, 1);
  assert.equal(merged.filter((row) => row.manual)[0].id, 'manual-1');
});

test('同一来源的多条候选互不干扰：删一条不影响另一条的来源引用', () => {
  const source = setup();
  source.rawText = '1. 数据结构作业：2026年10月20日 22:00 前提交\n2. 数据结构实验报告';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  const kept = candidates.filter((row) => row.id !== candidates[0].id);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].sourceRefs, [source.ref]);
});

test('删除来源：只引用它的候选一并移除，多来源候选保留并去掉该引用', () => {
  const sourceA = setup();
  const sourceB = createNoticeSource({ name: '教务通知', type: 'TEXT', rawText: '教务通知' });
  const candidates = [
    createCandidate(sourceA, { title: 'A', sourceRef: sourceA.ref, rawText: 'A' }),
    createCandidate(sourceB, { title: 'B', sourceRef: sourceB.ref, rawText: 'B' }),
    { ...createCandidate(sourceA, { title: 'AB', rawText: 'AB' }), sourceRefs: [sourceA.ref, sourceB.ref] },
  ];
  const { kept, dropped } = detachSource(candidates, sourceA);
  assert.equal(dropped.length, 1);
  assert.equal(kept.length, 2);
  const ab = kept.find((row) => row.title === 'AB');
  assert.deepEqual(ab.sourceRefs, [sourceB.ref]);
});

test('删除来源后不能出现「来源 0 条却有候选」（页面必须只保留 kept）', () => {
  const sourceA = setup();
  const sourceB = createNoticeSource({ name: '教务通知', type: 'TEXT', rawText: '教务通知' });
  const candidates = [
    createCandidate(sourceA, { title: '只属于 A', sourceRef: sourceA.ref, rawText: 'A' }),
    { ...createCandidate(sourceA, { title: 'A 和 B 都引用', rawText: 'AB' }), sourceRefs: [sourceA.ref, sourceB.ref] },
  ];
  const { kept, dropped } = detachSource(candidates, sourceA);

  // 页面上的正确写法：只保留 kept 中仍有其它有效来源的候选
  const remainingSources = [sourceB];
  const refs = new Set(remainingSources.map((item) => item.ref));
  const survivors = kept.filter((candidate) => (candidate.sourceRefs ?? []).length > 0);
  const uiCandidates = survivors;

  assert.equal(dropped.length, 1, '只引用 A 的候选必须被删掉');
  assert.equal(uiCandidates.length, 1, '只剩那条同时引用 B 的候选');
  assert.deepEqual(uiCandidates[0].sourceRefs, [sourceB.ref]);
  assert.equal(candidatesWithUnknownSource(uiCandidates, remainingSources).length, 0, '不允许留下指向已删除来源的候选');

  // 反例：把 dropped 里仍带旧 sourceRefs 的对象放回去，就会出现「来源 0 条、候选 1 条」的幽灵
  const resurrected = [...survivors, ...dropped.filter((candidate) => (candidate.sourceRefs ?? []).length > 0)];
  assert.equal(resurrected.length, 2, '复现旧缺陷：dropped 是原对象，仍带着指向已删来源的 sourceRefs');
  assert.ok(!resurrected.every((candidate) => (candidate.sourceRefs ?? []).some((ref) => refs.has(ref))));
});

test('pruneOrphanCandidates 找出引用已不存在来源的候选', () => {
  const source = setup();
  const candidates = [createCandidate(source, { title: 'x', rawText: 'x' })];
  const { kept, orphaned } = pruneOrphanCandidates(candidates, []);
  assert.equal(kept.length, 0);
  assert.equal(orphaned.length, 1);
});

test('candidatesMissingSource / candidatesWithUnknownSource 提示无效引用', () => {
  const source = setup();
  const broken = { ...createCandidate(source, { title: 'x', rawText: 'x' }), sourceRefs: ['ghost'] };
  const none = { ...createCandidate(source, { title: 'y', rawText: 'y' }), sourceRefs: [] };
  assert.equal(candidatesMissingSource([none]).length, 1);
  assert.equal(candidatesWithUnknownSource([broken], [source]).length, 1);
});

test('保存 payload：只带勾选的候选与被引用的来源图片', () => {
  const sourceA = createNoticeSource({ name: '图片通知', type: 'IMAGE', rawText: '通知一' });
  sourceA.files = [fakeFile('a.png', 100)];
  const sourceB = createNoticeSource({ name: '没被引用', type: 'IMAGE', rawText: '通知二' });
  sourceB.files = [fakeFile('b.png', 100)];
  const candidates = [
    { ...createCandidate(sourceA, { title: '任务一', deadline: '2026-10-20T22:00', rawText: '通知一' }), selected: true },
    { ...createCandidate(sourceB, { title: '不保存', rawText: '通知二' }), selected: false },
  ];
  const { payload, files, ignoredSourceRefs } = buildImportPayload({ sources: [sourceA, sourceB], candidates });
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].sourceRef, sourceA.ref);
  assert.deepEqual(payload.sources[0].attachmentIndexes, [0]);
  assert.equal(payload.attachments.length, 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'a.png');
  assert.deepEqual(ignoredSourceRefs, [sourceB.ref]);
});

test('保存 payload：只做文字通知时没有任何文件与附件声明', () => {
  const source = createNoticeSource({ name: '粘贴通知', type: 'TEXT', rawText: '下周三前交确认表' });
  const candidates = [{ ...createCandidate(source, { title: '交确认表', rawText: '下周三前交确认表' }), selected: true }];
  const { payload, files } = buildImportPayload({ sources: [source], candidates });
  assert.equal(files.length, 0);
  assert.deepEqual(payload.attachments, []);
  assert.deepEqual(payload.sources[0].attachmentIndexes, []);
  assert.equal(payload.tasks[0].deadline, null);
});

test('保存 payload：deadline 带 +08:00，缺少时给 null（不猜 23:59）', () => {
  const source = createNoticeSource({ name: '通知', type: 'TEXT' });
  const candidates = [
    { ...createCandidate(source, { title: '有截止', deadline: '2026-10-20T22:00', rawText: 'x' }), selected: true },
    { ...createCandidate(source, { title: '没截止', deadline: '', rawText: 'y' }), selected: true },
  ];
  const { payload } = buildImportPayload({ sources: [source], candidates });
  assert.equal(payload.tasks[0].deadline, '2026-10-20T22:00:00+08:00');
  assert.equal(payload.tasks[1].deadline, null);
});

test('保存 payload：同一来源多任务共用 sourceRef，同一张图只声明一次', () => {
  const source = createNoticeSource({ name: '一张图两条任务', type: 'IMAGE' });
  source.files = [fakeFile('one.png', 10), fakeFile('two.png', 20)];
  const candidates = [
    { ...createCandidate(source, { title: '任务甲', rawText: 'x' }), selected: true },
    { ...createCandidate(source, { title: '任务乙', rawText: 'y' }), selected: true },
  ];
  const { payload, files } = buildImportPayload({ sources: [source], candidates });
  assert.equal(payload.tasks.length, 2);
  assert.deepEqual(payload.tasks[0].sourceRefs, [source.ref]);
  assert.deepEqual(payload.tasks[1].sourceRefs, [source.ref]);
  assert.equal(payload.sources.length, 1);
  assert.deepEqual(payload.sources[0].attachmentIndexes, [0, 1]);
  assert.equal(files.length, 2);
});

test('保存 payload：多来源候选按来源顺序声明图片，fileIndex 与 files 对齐', () => {
  const sourceA = createNoticeSource({ name: 'A', type: 'IMAGE' });
  sourceA.files = [fakeFile('a.png', 10)];
  const sourceB = createNoticeSource({ name: 'B', type: 'IMAGE' });
  sourceB.files = [fakeFile('b1.png', 10), fakeFile('b2.png', 20)];
  const candidate = { ...createCandidate(sourceA, { title: '合并任务', rawText: 'x' }), sourceRefs: [sourceA.ref, sourceB.ref], selected: true };
  const { payload, files } = buildImportPayload({ sources: [sourceA, sourceB], candidates: [candidate] });
  assert.deepEqual(payload.sources.map((s) => s.attachmentIndexes), [[0], [1, 2]]);
  assert.deepEqual(payload.attachments.map((a) => a.fileIndex), [0, 1, 2]);
  assert.deepEqual(files.map((f) => f.name), ['a.png', 'b1.png', 'b2.png']);
});

test('保存 payload：候选里的重复来源会被去重，避免后端 400', () => {
  const source = createNoticeSource({ name: 'A', type: 'TEXT' });
  const candidate = { ...createCandidate(source, { title: 't', rawText: 'x' }), sourceRefs: [source.ref, source.ref], selected: true };
  const { payload } = buildImportPayload({ sources: [source], candidates: [candidate] });
  assert.deepEqual(payload.tasks[0].sourceRefs, [source.ref]);
});

test('预校验：不勾选任何候选时给出明确提示', () => {
  const source = createNoticeSource({ name: 'A' });
  const issues = validateSelection({ sources: [source], candidates: [{ ...createCandidate(source, { title: 't' }), selected: false }] });
  assert.ok(issues.some((issue) => issue.path === 'tasks'));
});

test('预校验：缺标题、缺来源、引用已删除来源、非法 deadline 都能提前发现', () => {
  const source = createNoticeSource({ name: 'A' });
  const issues = validateSelection({
    sources: [source],
    candidates: [
      { ...createCandidate(source, { title: '   ', rawText: 'a' }), selected: true },
      { ...createCandidate(source, { title: '无来源', rawText: 'b' }), sourceRefs: [], selected: true },
      { ...createCandidate(source, { title: '幽灵来源', rawText: 'c' }), sourceRefs: ['ghost'], selected: true },
      { ...createCandidate(source, { title: '坏时间', deadline: '2026-02-30T10:00', rawText: 'd' }), selected: true },
    ],
  });
  const paths = issues.map((issue) => issue.path);
  assert.ok(paths.includes('tasks[0].title'));
  assert.ok(paths.includes('tasks[1].sourceRefs'));
  assert.ok(paths.includes('tasks[2].sourceRefs'));
  assert.ok(paths.includes('tasks[3].deadline'));
});

test('预校验：图片数量、单张大小与总量超限都能提前发现', () => {
  const limits = normalizeLimits({ maxAttachments: 2, maxFileSizeBytes: 100, maxRequestSizeBytes: 250 });
  assert.deepEqual(limits, { ...DEFAULT_LIMITS, maxAttachments: 2, maxFileSizeBytes: 100, maxRequestSizeBytes: 250 });

  const source = createNoticeSource({ name: 'A', type: 'IMAGE' });
  source.files = [fakeFile('1.png', 100), fakeFile('2.png', 100), fakeFile('3.png', 100)];
  const candidate = { ...createCandidate(source, { title: 't', rawText: 'x' }), selected: true };
  const issues = validateSelection({ sources: [source], candidates: [candidate], limits });
  assert.ok(issues.some((issue) => issue.path === 'attachments'));

  const heavy = createNoticeSource({ name: 'B', type: 'IMAGE' });
  heavy.files = [fakeFile('big.png', 500)];
  const heavyCandidate = { ...createCandidate(heavy, { title: 't2', rawText: 'y' }), selected: true };
  const heavyIssues = validateSelection({ sources: [heavy], candidates: [heavyCandidate], limits });
  assert.ok(heavyIssues.some((issue) => issue.message.includes('单张上限')));
});

test('预校验：总量超限时给出总量提示', () => {
  const limits = normalizeLimits({ maxRequestSizeBytes: 150 });
  const source = createNoticeSource({ name: 'A', type: 'IMAGE' });
  source.files = [fakeFile('1.png', 100), fakeFile('2.png', 100)];
  const candidate = { ...createCandidate(source, { title: 't', rawText: 'x' }), selected: true };
  const totalBytes = usedFilesBytes({ sources: [source], candidates: [candidate] });
  assert.equal(totalBytes, 200);
  const issues = validateSelection({ sources: [source], candidates: [candidate], limits, totalBytes });
  assert.ok(issues.some((issue) => issue.path === 'files'));
});

test('usedFilesBytes 只统计被勾选候选引用的图片', () => {
  const used = createNoticeSource({ name: 'used', type: 'IMAGE' });
  used.files = [fakeFile('u.png', 30)];
  const unused = createNoticeSource({ name: 'unused', type: 'IMAGE' });
  unused.files = [fakeFile('x.png', 9999)];
  const candidates = [
    { ...createCandidate(used, { title: 't', rawText: 'a' }), selected: true },
    { ...createCandidate(unused, { title: 'u', rawText: 'b' }), selected: false },
  ];
  assert.equal(usedFilesBytes({ sources: [used, unused], candidates }), 30);
});

test('normalizeLimits 忽略非法值并回退默认', () => {
  const limits = normalizeLimits({ maxAttachments: 'abc', maxFileSizeBytes: -1, maxSources: 5 });
  assert.equal(limits.maxAttachments, DEFAULT_LIMITS.maxAttachments);
  assert.equal(limits.maxFileSizeBytes, DEFAULT_LIMITS.maxFileSizeBytes);
  assert.equal(limits.maxSources, 5);
});

test('formatBytes 给出可读大小', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('MERGE_STATUS 导出（界面按状态提示用户）', () => {
  assert.ok(Object.values(MERGE_STATUS).includes('conflict'));
  assert.ok(Object.values(MERGE_STATUS).includes('orphan'));
});

/* ------------------------------------------------ 第二轮修复的回归用例 */

test('手工输入的截止时间按上海墙上时间保存（不受运行电脑时区影响）', () => {
  // datetime-local 的值 → 候选里存的无偏移字符串 → payload 里补 +08:00
  assert.equal(fromShanghaiWallClock('2026-10-15T22:00'), '2026-10-15T22:00');
  assert.equal(fromShanghaiWallClock('2026-10-15T22:00:30'), '2026-10-15T22:00');
  assert.equal(fromShanghaiWallClock(''), '');
  assert.equal(fromShanghaiWallClock('不是时间'), '');

  const source = createNoticeSource({ name: '手填时间', type: 'TEXT', rawText: '作业' });
  const candidate = createCandidate(source, { title: '手填', rawText: '作业' });
  candidate.deadline = fromShanghaiWallClock('2026-10-15T22:00');
  candidate.selected = true;
  const issues = validateSelection({ sources: [source], candidates: [candidate] });
  assert.deepEqual(issues, [], '手工选好日期时间后必须能保存，不能被预校验挡住');
  const { payload } = buildImportPayload({ sources: [source], candidates: [candidate] });
  assert.equal(payload.tasks[0].deadline, '2026-10-15T22:00:00+08:00');
});

test('toShanghaiWallClock 把候选时间回填到 datetime-local，格式不合规时留空', () => {
  assert.equal(toShanghaiWallClock('2026-10-15T22:00'), '2026-10-15T22:00');
  assert.equal(toShanghaiWallClock('2026-10-15T22:00:00'), '2026-10-15T22:00');
  assert.equal(toShanghaiWallClock('2026-10-15T22:00:00+08:00'), '');
  assert.equal(toShanghaiWallClock(''), '');
});

test('原文超过 4000 字：挡住保存并保留完整原文，不静默截断', () => {
  const long = `请于 2026年10月15日 22:00 前提交作业。${'补充说明'.repeat(1400)}`;
  assert.ok(rawTextLength(long) > 4000, '用例本身要真的超长');
  const source = createNoticeSource({ name: '超长通知', type: 'TEXT', rawText: long });
  const candidate = { ...createCandidate(source, { title: '作业', rawText: '作业' }), selected: true };

  const issues = validateSelection({ sources: [source], candidates: [candidate] });
  assert.ok(issues.some((issue) => issue.path.endsWith('.rawText')), '必须有一条指着原文长度的提示');

  // 即便有人绕过预校验直接组装，payload 里的原文也一个字都不能少
  const { payload } = buildImportPayload({ sources: [source], candidates: [candidate] });
  assert.equal(payload.sources[0].rawText, long);
});

test('原地改一个字（标题挡住日期时间）：保留编辑并标冲突，不另起一条', () => {
  const source = setup();
  source.rawText = '数据结构作业：2026年10月20日 22:00 前提交';
  const parsed = parseNoticeText(source.rawText, { courses, sourceRef: source.ref });
  const candidates = mergeSourceCandidates([], source, parsed);
  markEdited(candidates[0], 'title');
  candidates[0].title = '我自己改的标题';

  const reparsed = parseNoticeText('数据结构作业：2026年10月25日 22:00 前提交（老师改了时间）', {
    courses,
    sourceRef: source.ref,
  });
  const merged = mergeSourceCandidates(candidates, source, reparsed);
  assert.equal(merged.length, 1, '还是一段原文，不能变成两条候选');
  assert.equal(merged[0].title, '我自己改的标题');
  assert.ok(merged[0].conflictFields.includes('title'));
});

test('插入新段落不会把旧候选的编辑搬给新段落，且新 id 唯一', () => {
  const source = createNoticeSource({ name: 'QA source', rawText: '1.完成数学作业\n2.完成英语作业' });
  let rows = mergeSourceCandidates([], source, parseNoticeText(source.rawText));
  rows[1].title = 'QA 人工英语标题';
  markEdited(rows[1], 'title');
  source.rawText = '1.完成数学作业\n2.完成物理作业\n3.完成英语作业';
  rows = mergeSourceCandidates(rows, source, parseNoticeText(source.rawText));

  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'id 必须唯一');
  assert.equal(rows.filter((row) => row.title === 'QA 人工英语标题').length, 1);
  const english = rows.find((row) => row.title === 'QA 人工英语标题');
  assert.ok(english.origin.rawText.includes('英语'), '编辑必须留在英语那条上');
  const physics = rows.find((row) => row.origin.rawText.includes('物理'));
  assert.ok(physics && physics.title !== 'QA 人工英语标题', '新插入的物理段落必须是一条新候选');
});

test('normalizeCandidateText 只去掉段首的纯数字序号', () => {
  assert.equal(normalizeCandidateText('2.完成英语作业'), '完成英语作业');
  assert.equal(normalizeCandidateText('3、完成英语作业'), '完成英语作业');
  assert.equal(normalizeCandidateText('(4) 完成英语作业'), '完成英语作业');
  assert.equal(normalizeCandidateText('完成课后习题 5.1-5.5'), '完成课后习题 5.1-5.5');
  assert.equal(normalizeCandidateText('2026年10月15日 22:00 前提交'), '2026年10月15日 22:00 前提交');
});

test('已移除损坏图片的来源按文字保存：不再带原图，文本仍是完整的', () => {
  const source = createNoticeSource({ name: '坏图来源', type: 'IMAGE', rawText: '2026年10月15日 22:00 前提交实验报告' });
  source.files = [fakeFile('broken.png', 1000)];
  source.dropImage = true;
  const candidate = { ...createCandidate(source, { title: '实验报告', rawText: '通知' }), selected: true };
  assert.deepEqual(sourceFiles(source), []);
  const { payload, files } = buildImportPayload({ sources: [source], candidates: [candidate] });
  assert.equal(files.length, 0, '移除后的坏图不能继续上传');
  assert.deepEqual(payload.attachments, []);
  assert.deepEqual(payload.sources[0].attachmentIndexes, []);
  assert.equal(payload.sources[0].rawText, '2026年10月15日 22:00 前提交实验报告');
});

/**
 * 页面上两个已真实发生的缺陷（Codex 浏览器验收抓到），用源码守卫钉住：
 *   1. removeSource 不能再把 dropped 里仍带旧 sourceRefs 的候选放回列表（会出现来源 0 条、候选 1 条）；
 *   2. dropBrokenImage 的成功提示不能写进 pageError（会被渲染成错误并要求重试）。
 */
test('页面源码守卫：删除来源只保留 kept，坏图成功提示不写 pageError', () => {
  const view = readFileSync(new URL('../src/views/ImportNoticesView.vue', import.meta.url), 'utf8');

  const removeSourceBody = view.slice(view.indexOf('function removeSource'), view.indexOf('function dropBrokenImage'));
  assert.ok(removeSourceBody.includes('candidates.value = survivors'), '删除来源后候选列表只能取 survivors');
  assert.ok(
    !/\.\.\.\s*dropped/.test(removeSourceBody),
    '不能把 dropped 重新放回候选列表（dropped 是原对象，sourceRefs 仍指向已删来源）',
  );
  assert.ok(
    removeSourceBody.includes('const removedCount = dropped.length'),
    '数量提示要按实际删除的候选数 dropped.length（多来源候选保留时不能用 affected.length）',
  );
  assert.ok(!removeSourceBody.includes('affected.length'), 'affected.length 会把保留下来多来源候选也算成删除');

  const dropBody = view.slice(view.indexOf('function dropBrokenImage'), view.indexOf('function renameSource'));
  assert.ok(dropBody.includes("pageError.value = ''"), '坏图成功操作要先清掉真正的错误');
  assert.ok(dropBody.includes('pageInfo.value ='), '成功提示走普通信息提示');
  assert.ok(!/pageError\.value\s*=\s*`/.test(dropBody), '成功提示不能写进 pageError');
});

test('页面源码守卫：选图计数不虚构预留，准备阶段有离页/代次检查', () => {
  const view = readFileSync(new URL('../src/views/ImportNoticesView.vue', import.meta.url), 'utf8');

  const counted = view.slice(view.indexOf('function countedImages'), view.indexOf('async function addImageFiles'));
  assert.ok(
    !/addingImages\s*\?\s*1\s*:\s*0/.test(counted),
    'countedImages 不能因为「正在准备」就虚构 1 张（空列表首次 8 张会只收 7 张）',
  );
  assert.ok(counted.includes('countableImageCount(sources.value, pendingCount)'), '只统计真实已有图 + 真实预留数');

  const addBody = view.slice(view.indexOf('async function addImageFiles'), view.indexOf('function bytesOf'));
  assert.ok(addBody.includes('const myRun = ++prepareRunId'), '准备阶段要有独立代次');
  assert.ok(addBody.includes('const isStale = () => unmounted || myRun !== prepareRunId'), '离页/失效判定');
  assert.ok(/if \(isStale\(\)\) \{\s*releaseStarted\(\)\s*return/.test(addBody), '失效时必须释放本轮新 URL 且不入列表');
  assert.ok(addBody.includes('startedSources.push(source)'), '要记录本轮已建 URL 的来源以便释放');

  const sampleBody = view.slice(view.indexOf('async function loadSample'), view.indexOf('function addTextSource'));
  assert.ok(sampleBody.includes('const isStale = () => unmounted || myRun !== prepareRunId'), 'loadSample 也要有离页/代次检查');
  assert.ok(sampleBody.includes('releaseSourceUrl(source)'), 'loadSample 失效时要释放已建 URL');
  assert.ok(
    view.includes('prepareRunId += 1'),
    'onBeforeUnmount 必须让在途 prepare 失效',
  );
});

test('页面源码守卫：来源存活按稳定 id，队列每次取响应式对象，pendingOcr 只在手改后保留', () => {
  const view = readFileSync(new URL('../src/views/ImportNoticesView.vue', import.meta.url), 'utf8');

  // 身份判断：不能再出现对象引用比较（sources.value.includes / .indexOf）
  assert.ok(!/sources\.value\.includes\s*\(/.test(view), 'sources.value.includes(raw) 在展开赋值后会误判为已删除');
  assert.ok(!/sources\.value\.indexOf\s*\(/.test(view), '也不能用 indexOf 比较对象');
  assert.ok(view.includes('isSourceAlive as isAliveInList'), '存活判断来自 noticeImportGuards 的按 id 实现');
  assert.ok(view.includes('findSourceById(sources.value, targetId)'), 'processQueue 每次按 id 取当前响应式 source');

  const queueBody = view.slice(view.indexOf('async function processQueue'), view.indexOf('function isSourceAlive'));
  assert.ok(queueBody.includes('const targetIds = targets.map((source) => source.id)'), '队列只记 id');
  assert.ok(!/for \(const source of targets\)/.test(queueBody), '不能直接拿 raw 队列对象做判断');
  assert.ok(queueBody.includes('if (!current) continue'), '按 id 找不到（已删除）时跳过，余下继续');

  // pendingOcrText：只在「人工编辑过且新文不同」分支里赋值，自动采用分支要清掉
  const ocrBody = view.slice(view.indexOf('function applyOcrResult'), view.indexOf('function adoptPendingOcrText'));
  const setIndex = ocrBody.indexOf('source.pendingOcrText = text');
  const clearIndex = ocrBody.indexOf("source.pendingOcrText = ''");
  assert.ok(setIndex > 0 && clearIndex > 0, '既要能设置也要能清除 pendingOcrText');
  assert.ok(setIndex < clearIndex, '先判断是否人工编辑，再在自动采用分支清除');
  assert.ok(
    ocrBody.slice(0, setIndex).includes('source.edited && source.rawText?.trim()'),
    '只有确实人工编辑过、且新识别文字不同才保留待采用',
  );
});
