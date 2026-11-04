/**
 * 保存请求的组装与预校验（纯函数）。
 *
 * 规则（与后端 NoticeImportService 的校验一一对应）：
 *   - 只有**勾选**的候选会进 tasks；没勾选的候选、没被任何勾选候选引用的来源与图片一律不提交；
 *   - `attachments[i].fileIndex` 是 multipart 里 files 的顺序，来源用 `attachmentIndexes` 引用；
 *     所以本模块同时返回 `files`：**按声明顺序排好的 File 列表**，调用方按顺序 append；
 *   - 保存前先在这里把明显问题找出来（缺来源、引用不存在的来源、超上限、总量超限），
 *     避免把用户等到后端 400 才知道哪里错了。
 */
import { toOffsetDateTime } from './noticeParser.js';

export const DEFAULT_LIMITS = {
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxRequestSizeBytes: 20 * 1024 * 1024,
  maxAttachments: 8,
  maxSources: 12,
  maxTasks: 30,
  /** 单条来源原文的长度上限：超长直接挡住保存，绝不静默截断用户的原通知。 */
  maxRawTextLength: 4000,
};

/** 把 /api/meta/storage-limits 的响应与默认值合并；缺字段时回退默认。 */
export function normalizeLimits(raw) {
  const limits = { ...DEFAULT_LIMITS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = Number(raw[key]);
      if (Number.isFinite(value) && value > 0) limits[key] = value;
    }
  }
  return limits;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 预校验：返回 [{ path, message }]（只返回真正会挡住保存的问题）。
 *
 * @param {object} params
 *   - sources: 所有来源
 *   - candidates: 所有候选（含未勾选）
 *   - limits: normalizeLimits 的结果
 *   - totalBytes: 被引用图片字节总量（可为 null，表示未知）
 */
export function validateSelection({ sources, candidates, limits = DEFAULT_LIMITS, totalBytes = null }) {
  const issues = [];
  const selected = candidates.filter((candidate) => candidate.selected);
  const refs = new Set(sources.map((source) => source.ref));

  if (!selected.length) {
    issues.push({ path: 'tasks', message: '请至少勾选一条要保存的任务候选（全部取消勾选就不会写库）。' });
  }
  selected.forEach((candidate, index) => {
    const key = `tasks[${index}]`;
    if (!String(candidate.title ?? '').trim()) {
      issues.push({ path: `${key}.title`, message: '勾选的候选缺少标题，请填写后再保存。' });
    }
    const refs0 = candidate.sourceRefs ?? [];
    if (!refs0.length) {
      issues.push({ path: `${key}.sourceRefs`, message: '这条候选没有关联来源，请指定它来自哪条通知。' });
    }
    for (const ref of refs0) {
      if (!refs.has(ref)) {
        issues.push({ path: `${key}.sourceRefs`, message: `引用了已删除的来源（${ref}），请重新选择来源。` });
      }
    }
    if (candidate.deadline && !toOffsetDateTime(candidate.deadline)) {
      issues.push({
        path: `${key}.deadline`,
        message: '截止时间格式不正确：请用日期 + 时间的完整格式（保存时会带 +08:00）。',
      });
    }
  });

  const usedRefs = new Set();
  for (const candidate of selected) for (const ref of candidate.sourceRefs ?? []) usedRefs.add(ref);
  const usedSources = sources.filter((source) => usedRefs.has(source.ref));
  if (usedSources.length > limits.maxSources) {
    issues.push({ path: 'sources', message: `一次最多 ${limits.maxSources} 个来源，当前 ${usedSources.length} 个。` });
  }
  if (selected.length > limits.maxTasks) {
    issues.push({ path: 'tasks', message: `一次最多 ${limits.maxTasks} 条候选，当前 ${selected.length} 条。` });
  }
  const usedFiles = collectUsedFiles(usedSources);
  // 原文长度：超长必须**挡住保存**（保留原文让用户自己删改），不能 slice 掉后半段
  const maxRawText = limits.maxRawTextLength ?? DEFAULT_LIMITS.maxRawTextLength;
  usedSources.forEach((source) => {
    const length = rawTextLength(source.rawText);
    if (length > maxRawText) {
      issues.push({
        path: `sources[${source.ref}].rawText`,
        message: `「${source.name || '未命名来源'}」的原文有 ${length} 字，超过单条上限 ${maxRawText} 字：请删到 ${maxRawText} 字以内再保存（原文一个字都不会被截断丢弃）。`,
      });
    }
  });
  if (usedFiles.length > limits.maxAttachments) {
    issues.push({ path: 'attachments', message: `一次最多 ${limits.maxAttachments} 张图片，当前 ${usedFiles.length} 张。` });
  }
  usedFiles.forEach(({ source, file }) => {
    if (file.size > limits.maxFileSizeBytes) {
      issues.push({
        path: `sources[${source.ref}].attachmentIndexes`,
        message: `「${source.name || source.ref}」的图片 ${file.name} 超过单张上限 ${formatBytes(limits.maxFileSizeBytes)}。`,
      });
    }
  });
  if (totalBytes !== null && totalBytes > limits.maxRequestSizeBytes) {
    issues.push({
      path: 'files',
      message: `图片总量 ${formatBytes(totalBytes)} 超过单次上限 ${formatBytes(limits.maxRequestSizeBytes)}，请少选几张或先压缩。`,
    });
  }
  return issues;
}

/** 一个来源里被引用的图片（按来源内顺序）。 */
export function sourceFiles(source) {
  if (source?.dropImage) return []; // 用户已明确「移除损坏图片，只保留文字」
  return (source?.files ?? []).filter(Boolean);
}

/** 原文的字符数（按用户看到的一个个字符算，不是 UTF-16 码元数）。 */
export function rawTextLength(rawText) {
  return [...String(rawText ?? '')].length;
}

function collectUsedFiles(usedSources) {
  const used = [];
  for (const source of usedSources) {
    for (const file of sourceFiles(source)) used.push({ source, file });
  }
  return used;
}

/**
 * 组装 POST /api/tasks/import-notices 的请求体。
 *
 * @returns {{ payload, files, usedSourceRefs, uploadedFiles, ignoredSourceRefs, warnings }}
 *   - payload: notice JSON（不含文件本身）
 *   - files: 按 `attachments[i].fileIndex` 顺序排好的 File 列表（只含被引用的图片）
 */
export function buildImportPayload({ sources, candidates, limits = DEFAULT_LIMITS, capturedAt = null }) {
  const selected = candidates.filter((candidate) => candidate.selected);
  const warnings = [];
  const usedRefs = new Set();
  for (const candidate of selected) for (const ref of candidate.sourceRefs ?? []) usedRefs.add(ref);

  const usedSources = sources.filter((source) => usedRefs.has(source.ref));
  const ignoredSourceRefs = sources.filter((source) => !usedRefs.has(source.ref)).map((source) => source.ref);

  // 图片只在「被勾选候选引用的来源」里收集，并保持来源与来源内部的原始顺序
  const files = [];
  const attachmentIndexByKey = new Map(); // `${sourceRef}:${fileIndexInSource}` → 请求里的下标
  const attachments = [];
  const attachmentIndexesBySource = new Map();
  for (const source of usedSources) {
    const sourceFilesList = sourceFiles(source);
    const indexes = [];
    sourceFilesList.forEach((file, fileIndexInSource) => {
      const key = `${source.ref}:${fileIndexInSource}`;
      if (!attachmentIndexByKey.has(key)) {
        const index = files.length;
        files.push(file);
        attachments.push({ fileIndex: index, originalName: file.name || `通知图片${index + 1}` });
        attachmentIndexByKey.set(key, index);
      }
      indexes.push(attachmentIndexByKey.get(key));
    });
    attachmentIndexesBySource.set(source.ref, indexes);
  }

  const payloadSources = usedSources.map((source) => ({
    sourceRef: source.ref,
    sourceName: (source.name || '未命名来源').slice(0, 128),
    sourceType: source.type || 'TEXT',
    // 不截断：超长来源已在 validateSelection 里挡住保存，这里保留完整原文
    rawText: String(source.rawText ?? ''),
    capturedAt: source.capturedAt || capturedAt || null,
    attachmentIndexes: (attachmentIndexesBySource.get(source.ref) ?? []).slice(),
  }));

  const payloadTasks = selected.map((candidate) => ({
    title: String(candidate.title ?? '').trim().slice(0, 200),
    description: (candidate.description ?? '').trim().slice(0, 1000) || null,
    courseId: candidate.courseId ?? null,
    type: candidate.type || 'HOMEWORK',
    status: candidate.status || 'TODO',
    deadline: toOffsetDateTime(candidate.deadline),
    submitRequirement: (candidate.submitRequirement ?? '').trim().slice(0, 500) || null,
    submitMethod: (candidate.submitMethod ?? '').trim().slice(0, 128) || null,
    sourceRefs: [...new Set(candidate.sourceRefs ?? [])],
  }));

  if (ignoredSourceRefs.length) {
    warnings.push(`有 ${ignoredSourceRefs.length} 条来源没有被勾选的候选引用，不会上传、也不会写库。`);
  }
  const attachedSourceCount = usedSources.filter((source) => sourceFiles(source).length).length;
  if (attachedSourceCount && files.length) {
    warnings.push(`本次会上传 ${files.length} 张图片；同一张图被多条候选引用时，后端会为每条任务各存一份独立副本。`);
  }

  return {
    payload: { sources: payloadSources, attachments, tasks: payloadTasks },
    files,
    usedSourceRefs: [...usedRefs],
    ignoredSourceRefs,
    warnings,
  };
}

/** 只算被勾选候选引用的图片总字节数（保存前的总量预校验）。 */
export function usedFilesBytes({ sources, candidates }) {
  const usedRefs = new Set();
  for (const candidate of candidates.filter((row) => row.selected)) {
    for (const ref of candidate.sourceRefs ?? []) usedRefs.add(ref);
  }
  let total = 0;
  for (const source of sources) {
    if (!usedRefs.has(source.ref)) continue;
    for (const file of sourceFiles(source)) total += file.size || 0;
  }
  return total;
}

/** 把 payload 变成 multipart FormData（浏览器与测试共用同一套组装逻辑）。 */
export function toFormData(payload, files, { FormDataImpl = globalThis.FormData } = {}) {
  const formData = new FormDataImpl();
  formData.append('notice', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'notice.json');
  for (const file of files) formData.append('files', file, file.name);
  return formData;
}
