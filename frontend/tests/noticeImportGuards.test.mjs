/**
 * 通知导入并发守卫的单元测试（纯函数 + 真实 Vue ref）。
 *
 * 覆盖真实浏览器里踩过的几件事：
 *   1. 快速两次「选择图片」时不能突破 8 张上限，也不能因为「正在准备」就少收图片；
 *   2. 保存成功后必须按「提交那一刻」的快照清理，不能按最新的勾选状态清理
 *      （否则会删掉没保存的草稿，同时留下已保存的候选导致重复提交）；
 *   3. 来源存活必须按稳定 id 判断：页面每次都 `sources.value = [...sources.value, source]` 展开赋值，
 *      数组里是 Vue proxy、而准备阶段攒下的队列仍是 raw 对象，用 `includes(raw)` 会把前面每张都判成已删除
 *      （真实浏览器里 7 张图只有最后 1 张被识别）。这里用**真的 ref** 复现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import {
  countableImageCount,
  createSaveSnapshot,
  filterAcceptableFiles,
  findSourceById,
  isSourceAlive,
  removeSubmittedCandidates,
  removeSubmittedSources,
} from '../src/ocr/noticeImportGuards.js'

function file(name, size = 1000, type = 'image/png') {
  return { name, size, type }
}

test('countableImageCount 只数真实图片，可另加真实预留数', () => {
  const sources = [{ files: [file('a.png')] }, { files: [file('b.png'), file('c.png')] }]
  assert.equal(countableImageCount(sources), 3)
  // 第二参数是「本次准备中确实会占用的文件数」，不是「正在忙」的布尔值
  assert.equal(countableImageCount(sources, 2), 5)
  assert.equal(countableImageCount([], 0), 0)
})

test('空列表第一次选 8 张全部接收（旧的虚构预留会只收 7 张）', () => {
  const limits = { maxAttachments: 8, maxFileSizeBytes: 5 * 1024 * 1024 }
  const eight = Array.from({ length: 8 }, (_, i) => file(`n${i}.png`))
  const { accepted, problems } = filterAcceptableFiles({
    files: eight,
    currentCount: countableImageCount([], 0),
    limits,
  })
  assert.equal(accepted.length, 8, '8 张必须全部接收')
  assert.deepEqual(problems, [])

  // 旧缺陷的非空洞复现：多算 1 张时，同一个输入只会收 7 张
  const buggy = filterAcceptableFiles({ files: eight, currentCount: countableImageCount([], 1), limits })
  assert.equal(buggy.accepted.length, 7, '虚构预留 1 张就会少收一张（正是浏览器验收卡住的原因）')
})

test('已有 1 张图片再加 7 张全部接收，9 张只收 8 张', () => {
  const limits = { maxAttachments: 8, maxFileSizeBytes: 5 * 1024 * 1024 }
  const existing = [{ files: [file('have.png')] }]
  const seven = Array.from({ length: 7 }, (_, i) => file(`m${i}.png`))
  const added = filterAcceptableFiles({ files: seven, currentCount: countableImageCount(existing, 0), limits })
  assert.equal(added.accepted.length, 7, '第 8 张还能进来')
  assert.deepEqual(added.problems, [])

  const nine = Array.from({ length: 9 }, (_, i) => file(`k${i}.png`))
  const capped = filterAcceptableFiles({ files: nine, currentCount: countableImageCount([], 0), limits })
  assert.equal(capped.accepted.length, 8, '一次最多 8 张')
  assert.equal(capped.problems.length, 1)
  assert.ok(capped.problems[0].includes('最多 8 张'))
})

test('filterAcceptableFiles 按已用真实额度截断，不越过 8 张上限', () => {
  const limits = { maxAttachments: 8, maxFileSizeBytes: 5 * 1024 * 1024 }
  // 已有 7 张（真实计数）→ 这次只能再进 1 张
  const first = filterAcceptableFiles({
    files: [file('x1.png'), file('x2.png')],
    currentCount: countableImageCount([{ files: Array.from({ length: 7 }, (_, i) => file(`p${i}.png`)) }], 0),
    limits,
  })
  assert.equal(first.accepted.length, 1)
  assert.ok(first.problems.some((message) => message.includes('最多 8 张')))
})

test('filterAcceptableFiles 逐张挡掉类型、大小与重复', () => {
  const limits = { maxAttachments: 8, maxFileSizeBytes: 100, imageTypes: ['image/png'] }
  const { accepted, problems } = filterAcceptableFiles({
    files: [file('ok.png', 50), file('big.png', 500), file('x.gif', 10, 'image/gif'), file('dup.png', 10)],
    currentCount: 0,
    limits,
    allow: (item) => item.name !== 'dup.png',
  })
  assert.deepEqual(
    accepted.map((item) => item.name),
    ['ok.png'],
  )
  assert.equal(problems.length, 3)
})

test('createSaveSnapshot 记住提交那一刻的候选与来源', () => {
  const sources = [
    { ref: 'src-1', files: [file('a.png')] },
    { ref: 'src-2', files: [file('b.png')] },
  ]
  const candidates = [
    { id: 'c1', selected: true, sourceRefs: ['src-1'] },
    { id: 'c2', selected: false, sourceRefs: ['src-2'] },
    { id: 'c3', selected: true, sourceRefs: ['src-1', 'src-2'] },
  ]
  const snapshot = createSaveSnapshot(candidates, sources)
  assert.deepEqual(snapshot.selectedIds, ['c1', 'c3'])
  assert.deepEqual([...snapshot.usedRefs].sort(), ['src-1', 'src-2'])
  assert.deepEqual(
    snapshot.usedSources.map((source) => source.ref),
    ['src-1', 'src-2'],
  )
})

test('保存成功按快照清理：没提交的草稿必须留下', () => {
  const candidates = [
    { id: 'c1', selected: true, sourceRefs: ['src-1'] },
    { id: 'c2', selected: false, sourceRefs: ['src-2'] }, // 没提交的草稿
    { id: 'c3', selected: true, sourceRefs: ['src-1'] },
  ]
  const snapshot = createSaveSnapshot(candidates, [{ ref: 'src-1' }, { ref: 'src-2' }])
  // 提交期间用户（或别的代码路径）把 c2 也勾上了：清理仍必须按快照来
  const mutated = candidates.map((candidate) => (candidate.id === 'c2' ? { ...candidate, selected: true } : candidate))
  const left = removeSubmittedCandidates(mutated, snapshot)
  assert.deepEqual(
    left.map((candidate) => candidate.id),
    ['c2'],
  )
})

test('保存成功按快照清理来源：只删掉提交过的来源', () => {
  const sources = [{ ref: 'src-1' }, { ref: 'src-2' }, { ref: 'src-3' }]
  const snapshot = createSaveSnapshot([{ id: 'c1', selected: true, sourceRefs: ['src-1'] }], sources)
  const left = removeSubmittedSources(sources, snapshot)
  assert.deepEqual(
    left.map((source) => source.ref),
    ['src-2', 'src-3'],
  )
})

test('空快照不误删任何东西', () => {
  const candidates = [{ id: 'c1', selected: false, sourceRefs: [] }]
  const sources = [{ ref: 'src-1' }]
  const snapshot = createSaveSnapshot(candidates, sources)
  assert.deepEqual(removeSubmittedCandidates(candidates, snapshot), candidates)
  assert.deepEqual(removeSubmittedSources(sources, snapshot), sources)
})

test('删除正在识别的来源：后续队列继续，只有被删来源被跳过（按 id 判存活）', () => {
  // 复刻页面里的队列判定：队列只记 id，runId 没变但来源已从列表里消失 → 回调必须失效
  const list = ref([{ id: 'a', removed: false }, { id: 'b', removed: false }])
  const targetIds = list.value.map((source) => source.id)
  const processed = []
  for (const targetId of targetIds) {
    const current = findSourceById(list.value, targetId)
    if (!isSourceAlive(list.value, targetId)) continue
    processed.push(targetId)
    // 第一张识别期间，用户删掉了还没识别的第二张来源（页面同样是展开赋值）
    if (targetId === 'a') {
      const removed = list.value.find((source) => source.id === 'b')
      removed.removed = true
      list.value = list.value.filter((source) => source !== removed)
    }
  }
  assert.deepEqual(processed, ['a'], '被删除的来源不能进入识别，但循环不能中断')
  assert.equal(list.value.length, 1)

  // 删除发生在回调返回之前：迟到回调不能再写回（不生成悬空候选）
  const after = []
  if (isSourceAlive(list.value, 'a')) after.push('还在')
  if (isSourceAlive(list.value, 'b')) after.push('悬空候选')
  assert.deepEqual(after, ['还在'])
})

test('真实 Vue ref：连续展开赋值后，7 张准备中的队列全部按 id 判为存活', () => {
  const sources = ref([])
  const queue = [] // 准备阶段攒下来的 raw 对象（页面里的 created / targets）
  for (let i = 0; i < 7; i += 1) {
    const raw = { id: `src-${i + 1}`, name: `图${i + 1}`, files: [file(`p${i}.png`)], ocrStatus: 'idle', removed: false }
    queue.push(raw)
    sources.value = [...sources.value, raw]
  }
  assert.equal(sources.value.length, 7)

  // 旧写法（对象引用）在真实 ref 下会把前面 6 张全判成「已删除」，只放行最后 1 张
  const byReference = queue.map((raw) => sources.value.includes(raw))
  assert.equal(byReference.filter(Boolean).length, 1, '真实 ref 下 includes(raw) 只有最后一张为 true')
  assert.equal(byReference[0], false, '第一张 raw 也不在 proxy 数组里')

  // 新写法（稳定 id）：7 张全部存活，并且拿到的是当前响应式对象
  const byId = queue.map((raw) => isSourceAlive(sources.value, raw.id))
  assert.deepEqual(byId, [true, true, true, true, true, true, true])

  for (const raw of queue) {
    const current = findSourceById(sources.value, raw.id)
    assert.ok(current, `${raw.id} 必须能按 id 找到`)
    assert.equal(current.id, raw.id)
    // 通过对 proxy 赋值必须能写回列表里的那份数据（raw 对象不是响应式的）
    current.ocrStatus = 'done'
  }
  assert.deepEqual(
    sources.value.map((source) => source.ocrStatus),
    Array(7).fill('done'),
    '7 张的状态更新都要落到列表里',
  )
  // 删掉中间一张后，只有它变成不存活
  const removed = sources.value[2]
  removed.removed = true
  sources.value = sources.value.filter((source) => source !== removed)
  assert.deepEqual(
    queue.map((raw) => isSourceAlive(sources.value, raw.id)),
    [true, true, false, true, true, true, true],
  )
})
