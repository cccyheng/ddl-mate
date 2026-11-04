/**
 * 通知导入页面的并发守卫（纯函数，不依赖 Vue / DOM）。
 *
 * 这里放的是「容易在真实浏览器里出问题、又必须能单测」的几件事：
 *   1. 选择图片时的**准备阶段并发**：快速点两次选择文件时，第二次必须在第一次
 *      prepareImage 结束前就被挡住，否则两张新增图片都按「当前 imageCount」判断，
 *      会一起冲过 8 张上限。
 *   2. 保存时的**冻结快照**：请求发出后界面上的勾选不能再变，成功后也必须用
 *      「提交那一刻」的候选 id 清理，而不是用最新的勾选状态（否则会删掉没保存的草稿，
 *      同时留下已保存的候选导致重复提交）。
 *   3. 来源身份**只按稳定 id 判断**：页面用 `sources.value = [...sources.value, source]`
 *      展开赋值后，数组里存的是 Vue proxy，而准备阶段攒下来的 `created` 队列仍是 raw 对象。
 *      用 `sources.includes(rawSource)` 判存活会把前面每一张都判成「已删除」，
 *      所以这里统一提供按 id 查找 / 判存活。
 */

/** 按稳定 id 找来源：返回列表里**当前那个响应式对象**（找不到返回 undefined）。 */
export function findSourceById(sources, id) {
  if (id === null || id === undefined) return undefined;
  return (sources ?? []).find((source) => source?.id === id);
}

/** 来源是否还在列表里（按 id，不用对象引用）。 */
export function isSourceAlive(sources, id) {
  return Boolean(findSourceById(sources, id));
}

/** 图片总量的计数口径：只数真实已有的图片，可按调用方传入的真实预留数调整。 */
export function countableImageCount(sources, pendingCount = 0) {
  const inSources = (sources ?? []).reduce((sum, source) => sum + (source?.files?.length ?? 0), 0);
  return inSources + Math.max(0, pendingCount);
}

/** 按服务器上限逐张筛选文件，返回 { accepted, problems }（不修改入参）。 */
export function filterAcceptableFiles({
  files,
  currentCount = 0,
  limits = {},
  allow = () => true,
} = {}) {
  const maxAttachments = Number(limits.maxAttachments) || Number.POSITIVE_INFINITY;
  const maxBytes = Number(limits.maxFileSizeBytes) || Number.POSITIVE_INFINITY;
  const types = limits.imageTypes ?? ['image/png', 'image/jpeg', 'image/webp'];
  const accepted = [];
  const problems = [];
  for (const file of files ?? []) {
    if (currentCount + accepted.length >= maxAttachments) {
      problems.push(`一次最多 ${maxAttachments} 张图片，超出的已忽略（${file.name}）`);
      continue;
    }
    if (!types.includes(file.type)) {
      problems.push(`${file.name}：只支持 PNG / JPEG / WebP`);
      continue;
    }
    if ((file.size || 0) > maxBytes) {
      problems.push(`${file.name}：这张图超过单张上限，请先压缩`);
      continue;
    }
    if (!allow(file)) {
      problems.push(`${file.name}：这张图已经在列表里，没有重复添加`);
      continue;
    }
    accepted.push(file);
  }
  return { accepted, problems };
}

/**
 * 保存前的冻结快照：记住「提交了哪些候选 id」和「提交了哪些来源 ref」。
 * 成功后只按这份快照清理，忽略期间界面上的变化。
 */
export function createSaveSnapshot(candidates, sources) {
  const selected = (candidates ?? []).filter((candidate) => candidate?.selected);
  const selectedIds = selected.map((candidate) => candidate.id);
  const usedRefs = new Set();
  for (const candidate of selected) {
    for (const ref of candidate.sourceRefs ?? []) usedRefs.add(ref);
  }
  return {
    selectedIds,
    selectedIdSet: new Set(selectedIds),
    usedRefs,
    usedSources: (sources ?? []).filter((source) => usedRefs.has(source.ref)),
  };
}

/** 保存成功后按快照清理候选：只删掉这次真正提交过的那些，未提交的草稿原样保留。 */
export function removeSubmittedCandidates(candidates, snapshot) {
  if (!snapshot?.selectedIdSet?.size) return [...(candidates ?? [])];
  return (candidates ?? []).filter((candidate) => !snapshot.selectedIdSet.has(candidate.id));
}

/** 保存成功后按快照清理来源：只删掉这次真正提交过的来源。 */
export function removeSubmittedSources(sources, snapshot) {
  if (!snapshot?.usedRefs?.size) return [...(sources ?? [])];
  return (sources ?? []).filter((source) => !snapshot.usedRefs.has(source.ref));
}
