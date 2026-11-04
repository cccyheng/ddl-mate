/**
 * 通知来源 ↔ 任务候选的映射与合并（纯函数，不依赖 Vue、不发请求）。
 *
 * 为什么单独一个模块：
 *   - 「来源 → 候选」的引用必须稳定：候选用 `sourceRefs` 数组指向来源，来源被删除/重命名时
 *     映射要跟着维护，不能出现指向不存在来源的候选（后端会 400）。
 *   - 重识别 / 重新解析**不能静默丢掉用户的编辑**：用户改过的字段标记为 edited，
 *     再次解析只把结果作为「建议」返回，由界面提示并让用户显式选择。
 *   - 同一来源可能对应多条候选；同一候选也可能引用多个来源。删除一条候选不能误删别人引用的来源。
 */

/** 合并结果里每条候选的状态。 */
export const MERGE_STATUS = {
  added: 'added',
  updated: 'updated',
  unchanged: 'unchanged',
  conflict: 'conflict',
  orphan: 'orphan',
  removed: 'removed',
};

/** 候选里允许用户编辑、需要保护不被重解析覆盖的字段。 */
export const EDITABLE_FIELDS = [
  'title',
  'type',
  'courseId',
  'deadline',
  'submitRequirement',
  'submitMethod',
];

/** 建一条可编辑候选（来源引用固定为 { ref, name }）。 */
export function createCandidate(source, parsed, { id } = {}) {
  return {
    id: id ?? `cand-${++idSeed}`,
    selected: true,
    title: parsed.title ?? '',
    type: parsed.type ?? 'HOMEWORK',
    courseId: parsed.courseId ?? null,
    deadline: parsed.deadline ?? '',
    submitRequirement: parsed.submitRequirement ?? '',
    submitMethod: parsed.submitMethod ?? '',
    sourceRefs: source?.ref ? [source.ref] : [],
    origin: {
      segmentId: parsed.segmentId ?? null,
      sourceRef: source?.ref ?? null,
      rawText: parsed.rawText ?? '',
    },
    hints: [...(parsed.hints ?? [])],
    /** 用户手动改过的字段名，重解析时不静默覆盖。 */
    editedFields: [],
    /** 文本不再是原文里的这一段了（来源被编辑/删除后候选可能失效）。 */
    stale: false,
    /** 用户手工新增的候选（没有解析来源）。 */
    manual: false,
  };
}

let idSeed = 0;

/** 仅供测试：重置 ID 序列，保证快照稳定。 */
export function resetCandidateIds() {
  idSeed = 0;
}

export function createNoticeSource({ name, type = 'TEXT', rawText = '', file = null, id } = {}) {
  return {
    id: id ?? `src-${++sourceSeed}`,
    ref: id ?? `src-${sourceSeed}`,
    name: name ?? '',
    type,
    rawText,
    file,
    ocrStatus: 'idle',
    ocrProgress: 0,
    ocrMessage: '',
    ocrError: '',
    edited: false,
  };
}

let sourceSeed = 0;

export function resetSourceIds() {
  sourceSeed = 0;
}

/** 候选的稳定「身份」：来源集合 + 解析出的片段 id + 原文片段。 */
export function candidateIdentity(candidate) {
  const refs = [...(candidate.sourceRefs ?? [])].sort().join(',');
  return `${refs}\u0000${candidate.origin?.segmentId ?? ''}\u0000${candidate.origin?.rawText ?? ''}`;
}

/**
 * 判断「是不是同一段话」的键：去掉段首的**纯数字序号**后压缩空白。
 *
 * 为什么必须去掉序号：解析器把片段原文写成「2.完成英语作业」，用户插入一段后同一条任务
 * 的序号会整体变化（变成「3.完成英语作业」）。如果只按原文精确比对就认不出是同一条，
 * 而退回 segmentId 比对又会把「第 2 段」这个位置上的**另一条**候选（新插入的物理作业）
 * 当成英语作业，用户的编辑就搬到了错误的候选上。
 * 去掉序号后先按整批文本精确匹配，插队 / 重排都不会错配。
 */
export function normalizeCandidateText(rawText) {
  return String(rawText ?? '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/^(?:(?:\d{1,3}\s*[.、)）:：]|[(（]\s*\d{1,3}\s*[)）]|\d{1,3}\s+)\s*)+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 与来源无关的文本键：删掉来源前缀后的 identity（① 全批精确匹配用）。 */
function textIdentityOf(candidate) {
  return candidateIdentity(candidate).split('\u0000').slice(2).join('\u0000');
}

/** 取一个还没被占用的候选 id（插入 / 重排时不与老候选撞号）。 */
function nextFreeId(base, taken) {
  let id = base;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${base}~${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * 同一来源内的匹配键：优先按原文片段比对。
 * 片段 id 由文本行号推导，重新解析时可能整体位移，所以不能只靠 segmentId。
 */
function findExistingCandidate(mine, usedIds, source, parsed, identity, newTexts) {
  const parsedText = parsed.rawText ?? '';
  const parsedTextKey = normalizeCandidateText(parsedText);
  return (
    // ① 完全同身份（来源 + 片段 + 原文）—— 文本一个字都没变
    mine.find((candidate) => !usedIds.has(candidate.id) && candidateIdentity(candidate) === identity) ??
    // ② 同一段原文（片段可能换了编号）—— 仍算同一条，用户编辑靠 editedFields 保护
    mine.find(
      (candidate) =>
        !usedIds.has(candidate.id) &&
        !candidate.manual &&
        candidate.origin?.sourceRef === source.ref &&
        (candidate.origin?.rawText ?? '') === parsedText,
    ) ??
    // ③ 忽略纯数字序号后的同一段文本（插入一段导致后面整体后移时，靠这一步认回原候选）
    mine.find(
      (candidate) =>
        !usedIds.has(candidate.id) &&
        !candidate.manual &&
        candidate.origin?.sourceRef === source.ref &&
        normalizeCandidateText(candidate.origin?.rawText) === parsedTextKey,
    ) ??
    // ④ 原文真的被改过（新一批里已经没有任何段落是这段文字）时，才退回片段位置比对
    (parsedTextKey && !newTexts.has(parsedTextKey) && newTexts.size <= mine.length
      ? mine.find(
          (candidate) =>
            !usedIds.has(candidate.id) &&
            !candidate.manual &&
            candidate.origin?.sourceRef === source.ref &&
            (candidate.origin?.segmentId ?? null) === (parsed.segmentId ?? null),
        )
      : undefined) ??
    // ⑤ 来源里只剩这一段、而且用户把原文里的日期时间改掉了：原文对不上但确实是同一条任务
    //    （用户的标题 / 课程编辑靠 editedFields 保留，并产生 conflict 提示）。
    //    只有「唯一候选对唯一段落 + 标题仍能对上」才允许，避免把插入的新段落接到旧候选上。
    (newTexts.size === 1 && mine.length === 1 && !usedIds.has(mine[0].id) && !mine[0].manual
      ? singleSegmentRewriteMatch(mine[0], parsed, source)
      : undefined)
  );
}

/** 来源只剩一段时的保守匹配：原文对不上，但解析出来的标题仍能在旧原文里找到。 */
function singleSegmentRewriteMatch(candidate, parsed, source) {
  if (candidate.origin?.sourceRef !== source.ref) return undefined;
  const stored = normalizeCandidateText(candidate.origin?.rawText);
  const title = normalizeCandidateText(parsed.title);
  if (!stored || !title) return undefined;
  return stored.includes(title) || title.includes(stored) ? candidate : undefined;
}

/**
 * 把某个来源的新解析结果合并进现有候选列表。
 *
 * @param {Array} candidates 现有候选（会被复制成新数组，不原地修改传入对象）
 * @param {object} source 来源（{ ref, id, name }）
 * @param {Array} parsedList 解析器输出的候选（同一来源）
 * @param {object} options
 *   - applyConflicts: 用户已确认「用新识别结果覆盖我改过的字段」时传 true
 * @returns {Array} 新候选列表（保留未涉及本来源的候选）
 */
export function mergeSourceCandidates(candidates, source, parsedList, { applyConflicts = false } = {}) {
  const others = candidates.filter((candidate) => !(candidate.sourceRefs ?? []).includes(source.ref));
  const mine = candidates.filter((candidate) => (candidate.sourceRefs ?? []).includes(source.ref));
  const next = [];
  const usedIds = new Set();
  // 先统计整批新文本（含未匹配的），④ 靠它判断「旧原文是否真的从原文里消失了」
  const newTexts = new Map();
  for (const parsed of parsedList) {
    const key = normalizeCandidateText(parsed.rawText);
    if (key) newTexts.set(key, (newTexts.get(key) ?? 0) + 1);
  }

  parsedList.forEach((parsed, index) => {
    const identity = `${source.ref}\u0000${parsed.segmentId ?? ''}\u0000${parsed.rawText ?? ''}`;
    const existing = findExistingCandidate(mine, usedIds, source, parsed, identity, newTexts);
    if (!existing) {
      const taken = new Set([
        ...usedIds,
        ...mine.filter((candidate) => !usedIds.has(candidate.id)).map((candidate) => candidate.id),
        ...next.map((candidate) => candidate.id),
        ...others.map((candidate) => candidate.id),
      ]);
      next.push(
        createCandidate(source, parsed, { id: nextFreeId(`${source.ref}-seg-${index + 1}`, taken) }),
      );
      return;
    }
    usedIds.add(existing.id);
    next.push(mergeParsedIntoExisting(existing, source, parsed, { applyConflicts }));
  });

  // 本次解析没有产出的旧候选：留成 stale 由用户决定，不静默删除
  for (const leftover of mine) {
    if (usedIds.has(leftover.id)) continue;
    next.push({ ...leftover, stale: true });
  }

  return [...others, ...next];
}

/** 把一次解析结果合并进一条已有候选；用户改过的字段默认不覆盖。 */
export function mergeParsedIntoExisting(existing, source, parsed, { applyConflicts = false } = {}) {
  const edited = new Set(existing.editedFields ?? []);
  const merged = {
    ...existing,
    stale: false,
    hints: [...(parsed.hints ?? [])],
    origin: {
      segmentId: parsed.segmentId ?? existing.origin?.segmentId ?? null,
      sourceRef: source.ref,
      rawText: parsed.rawText ?? existing.origin?.rawText ?? '',
    },
    sourceRefs: [...new Set([...(existing.sourceRefs ?? []), source.ref])],
  };
  for (const field of EDITABLE_FIELDS) {
    const incoming = field === 'courseId' ? (parsed.courseId ?? null) : (parsed[field] ?? '');
    const current = merged[field];
    if (edited.has(field) && !applyConflicts) {
      merged.conflictFields = [...new Set([...(merged.conflictFields ?? []), field])];
      continue;
    }
    merged[field] = incoming;
    if (edited.has(field) && applyConflicts) {
      merged.editedFields = (merged.editedFields ?? []).filter((name) => name !== field);
    }
  }
  if (!(merged.conflictFields ?? []).length) delete merged.conflictFields;
  return merged;
}

/** 标记用户编辑了某个字段（重解析时保护它）。 */
export function markEdited(candidate, field) {
  candidate.editedFields = [...new Set([...(candidate.editedFields ?? []), field])];
  candidate.conflictFields = (candidate.conflictFields ?? []).filter((name) => name !== field);
  return candidate;
}

/**
 * 删除来源：把只引用它的候选标记为失效；如果另一个来源的原文完全一致，则改指向那个来源。
 * 返回 { candidates, removedRefs, repointed }
 */
export function detachSource(candidates, source) {
  const remaining = candidates.filter(
    (candidate) => (candidate.sourceRefs ?? []).length > 0 && candidate.sourceRefs.some((ref) => ref !== source.ref),
  );
  const dropped = candidates.filter((candidate) => !remaining.includes(candidate));
  return {
    kept: remaining.map((candidate) => ({
      ...candidate,
      sourceRefs: candidate.sourceRefs.filter((ref) => ref !== source.ref),
    })),
    dropped,
  };
}

/**
 * 来源文字被编辑后：重新解析该来源，并**保留**用户的编辑（返回冲突提示）。
 * 这是「编辑原文 → 重新解析」的入口，与「重新识别 OCR」共用。
 */
export function reparseSource(candidates, source, parsedList, { applyConflicts = false } = {}) {
  return mergeSourceCandidates(candidates, source, parsedList, { applyConflicts });
}

/** 手工新增候选（不引用任何解析片段，但必须挂在至少一个来源上）。 */
export function addManualCandidate(candidates, sourceRef, { id } = {}) {
  return [
    ...candidates,
    {
      id: id ?? `manual-${++idSeed}`,
      selected: true,
      title: '',
      type: 'HOMEWORK',
      courseId: null,
      deadline: '',
      submitRequirement: '',
      submitMethod: '',
      sourceRefs: sourceRef ? [sourceRef] : [],
      origin: { segmentId: null, sourceRef: sourceRef ?? null, rawText: '' },
      hints: ['手工添加的候选：请填写标题；截止时间只有明确日期 + 时刻时再填。'],
      editedFields: [],
      stale: false,
      manual: true,
    },
  ];
}

/** 只保留引用仍然存在的来源的候选；返回 { kept, orphaned }。 */
export function pruneOrphanCandidates(candidates, sources) {
  const refs = new Set(sources.map((source) => source.ref));
  const kept = [];
  const orphaned = [];
  for (const candidate of candidates) {
    const alive = (candidate.sourceRefs ?? []).filter((ref) => refs.has(ref));
    if (alive.length === (candidate.sourceRefs ?? []).length && alive.length > 0) kept.push(candidate);
    else orphaned.push({ ...candidate, sourceRefs: alive });
  }
  return { kept, orphaned };
}

/** 候选被选中要保存时必须至少有一个来源。 */
export function candidatesMissingSource(candidates) {
  return candidates.filter((candidate) => (candidate.sourceRefs ?? []).length === 0);
}

/** 供界面显示：候选是否引用了不存在的来源。 */
export function candidatesWithUnknownSource(candidates, sources) {
  const refs = new Set(sources.map((source) => source.ref));
  return candidates.filter((candidate) => (candidate.sourceRefs ?? []).some((ref) => !refs.has(ref)));
}
