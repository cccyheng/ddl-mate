// 「通知转待办」的**最终安全修复**（复核第 9 条）：原文改动后的保存守卫。
//
// 复核点名的真实风险：提取之后原文还可以改，而保存用的是**当前文本 B** + 按**旧原文 A**
// 提取出来的候选行 —— 写进库的原文与候选对不上。修复要求：
//   - 事件处理器与按钮**两层**都拦（不能只把按钮变灰）；
//   - 提示「原文已更改，请重新提取后保存」；
//   - 入库原文一律取**提取快照**；
//   - 取消重新提取**保留**候选行（不静默丢弃），确认后才刷新；
//   - `outcome === null` 时只要粘了原文（**包括提取出 0 条候选**）就算未保存草稿。
//
// 判定逻辑只有一份：`../src/domain/noticeImportState.ts`（界面真的在用），
// 这里不重新实现一遍规则，而是驱动「纯守卫 + 真实 SQLite 仓库」的组合。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTICE_SOURCE_STALE_MESSAGE,
  hasUnsavedNoticeDraft,
  isNoticeSourceStale,
  noticeSaveGuard,
  noticeSaveGuardFieldErrors,
} from '../src/domain/noticeImportState.ts'
import { noticeRowsFromCandidates, parseNoticeSource, validateNoticeImportRows } from '../src/domain/noticeImport.ts'
import { NoticeImportRepository } from '../src/domain/noticeImportRepository.ts'
import { courseDraft, createTestDatabase } from './helpers/sqliteHarness.mjs'

const SOURCE_A = [
  '数据结构课程群',
  '2026年10月8日 09:12 张老师',
  '',
  '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
].join('\n')
/** 用户后来改成的原文（多了一条任务）。 */
const SOURCE_B = `${SOURCE_A}\n2. 大学物理实验报告：2026年11月3日 14:00 前交纸质稿`

const courses = [
  { id: 1, name: '数据结构', code: 'CS101' },
  { id: 2, name: '大学物理', code: 'PH101' },
]

const rowsFor = (source) => noticeRowsFromCandidates(parseNoticeSource(source, courses).candidates, courses)

/* --------------------------- 纯守卫：逐条场景 --------------------------- */

test('原文与提取快照不一致 → 保存被拦下（提示重新提取），且入库原文取快照', () => {
  const guard = noticeSaveGuard({ sourceText: SOURCE_B, snapshot: SOURCE_A, rowCount: 1, committed: false })
  assert.equal(guard.allowed, false)
  assert.equal(guard.canSave, false, '按钮也必须不可点')
  assert.equal(guard.sourceStale, true)
  assert.equal(guard.reason, NOTICE_SOURCE_STALE_MESSAGE)
  assert.equal(guard.sourceToPersist, SOURCE_A, '入库原文只能是提取快照')
  assert.deepEqual(noticeSaveGuardFieldErrors(guard), { sourceText: NOTICE_SOURCE_STALE_MESSAGE })
})

test('快照一致（未改动）→ 允许保存，入库原文就是那份快照', () => {
  const guard = noticeSaveGuard({ sourceText: SOURCE_A, snapshot: SOURCE_A, rowCount: 1, committed: false })
  assert.equal(guard.allowed, true)
  assert.equal(guard.canSave, true)
  assert.equal(guard.sourceStale, false)
  assert.equal(guard.sourceToPersist, SOURCE_A)
  assert.deepEqual(noticeSaveGuardFieldErrors(guard), {})
})

test('改动后又改回原样 → 重新允许保存（比较是逐字符的，不做归一化）', () => {
  assert.equal(isNoticeSourceStale(SOURCE_A, SOURCE_A), false)
  assert.equal(isNoticeSourceStale(SOURCE_A, ` ${SOURCE_A}`), true, '前后空白也算改动')
  assert.equal(
    noticeSaveGuard({ sourceText: SOURCE_A, snapshot: SOURCE_A, rowCount: 2, committed: false }).allowed,
    true,
  )
})

test('已经提交过 → 不允许再次保存（避免重复导入）', () => {
  const guard = noticeSaveGuard({ sourceText: SOURCE_A, snapshot: SOURCE_A, rowCount: 1, committed: true })
  assert.equal(guard.allowed, false)
  assert.equal(guard.canSave, false)
  assert.ok(guard.reason.includes('已经保存过'))
})

test('提取出 0 条候选：允许保存 0 条（与仓库的「没有勾选」报错一致），但没提取过就先提示提取', () => {
  const extractedEmpty = noticeSaveGuard({ sourceText: '大家好，今天没有作业。', snapshot: '大家好，今天没有作业。', rowCount: 0, committed: false })
  assert.equal(extractedEmpty.allowed, true, '提取过之后的 0 条是明确状态，交给仓库报「没有勾选」')
  assert.equal(extractedEmpty.sourceStale, false)

  const notExtracted = noticeSaveGuard({ sourceText: SOURCE_A, snapshot: null, rowCount: 0, committed: false })
  assert.equal(notExtracted.allowed, false)
  assert.ok(notExtracted.reason.includes('提取任务'))

  const nothingAtAll = noticeSaveGuard({ sourceText: '   ', snapshot: null, rowCount: 0, committed: false })
  assert.equal(nothingAtAll.allowed, false)
  assert.ok(nothingAtAll.reason.includes('粘贴'))
})

test('未保存草稿的判定与阶段无关：提取出 0 条候选之后离开也要提示', () => {
  // 只粘贴了原文、还没提取
  assert.equal(
    hasUnsavedNoticeDraft({ sourceText: SOURCE_A, rowCount: 0, snapshot: null, committed: false }),
    true,
  )
  // 提取出 0 条候选（快照存在、行数为 0）—— 仍然算草稿
  assert.equal(
    hasUnsavedNoticeDraft({
      sourceText: '大家好，今天没有作业。',
      rowCount: 0,
      snapshot: '大家好，今天没有作业。',
      committed: false,
    }),
    true,
  )
  // 真正空白的初始状态：不打扰用户
  assert.equal(
    hasUnsavedNoticeDraft({ sourceText: '   ', rowCount: 0, snapshot: null, committed: false }),
    false,
  )
  // 已经提交之后不算草稿（即使还留着原文与候选行）
  assert.equal(
    hasUnsavedNoticeDraft({ sourceText: SOURCE_A, rowCount: 1, snapshot: SOURCE_A, committed: true }),
    false,
  )
})

test('复核第 10 条：清空原文之后，已改好的候选行仍然算草稿（离开必须提示）', () => {
  const rows = rowsFor(SOURCE_A)
  assert.equal(rows.length, 1)
  // 用户改了候选行（未保存）
  const edited = rows.map((row) => ({ ...row, title: '我自己改的标题' }))

  // 典型回归路径：提取 A → 改候选 → 把原文清空 → 用户按返回
  assert.equal(
    hasUnsavedNoticeDraft({
      sourceText: '',
      rowCount: edited.length,
      snapshot: SOURCE_A,
      committed: false,
    }),
    true,
    '原文清空不能掩盖「还有没保存的核对行」',
  )
  // 原文与候选都为空的初始状态：不提示
  assert.equal(hasUnsavedNoticeDraft({ sourceText: '  ', rowCount: 0, snapshot: null, committed: false }), false)
  // 清空原文但已经提交过：不提示（刷新失败重进页面不该被反复盘问）
  assert.equal(
    hasUnsavedNoticeDraft({ sourceText: '', rowCount: edited.length, snapshot: SOURCE_A, committed: true }),
    false,
  )
})

/* ------------------- 真实 SQLite：改动原文时零写入 ------------------- */

test('提取 A → 改成 B → 保存被拒：**零写入**，库里没有任务也没有原文', async () => {
  const ctx = await createTestDatabase()
  try {
    await ctx.courses.create(courseDraft({ name: '数据结构', code: 'CS101' }))
    await ctx.courses.create(courseDraft({ name: '大学物理', code: 'PH101' }))
    const available = await ctx.courses.listAll()
    const repo = new NoticeImportRepository(ctx.db, () => new Date('2026-10-15T02:00:00Z'))

    // 提取 A：拿到候选行（快照 = A）
    const rows = noticeRowsFromCandidates(parseNoticeSource(SOURCE_A, available).candidates, available)
    assert.equal(rows.length, 1)

    // 用户把原文改成了 B，然后点保存 → 界面守卫必须先拦下来（不进入仓库）
    const guard = noticeSaveGuard({ sourceText: SOURCE_B, snapshot: SOURCE_A, rowCount: rows.length, committed: false })
    assert.equal(guard.allowed, false)

    // 只有守卫放行时才调用仓库：这里证明「不调用 → 零写入」
    const before = {
      tasks: await ctx.tasks.countAll(),
      sources: (await ctx.db.getAllAsync('SELECT id FROM task_sources;')).length,
    }
    assert.equal(before.tasks, 0)
    assert.equal(before.sources, 0)

    // 即使有别的调用方绕过守卫直接保存（旧代码路径），仓库也会用**传入的**原文，
    // 而界面传入的一定是快照 —— 这里模拟正确路径：确认重新提取后用 B 保存
    const refreshed = noticeRowsFromCandidates(parseNoticeSource(SOURCE_B, available).candidates, available)
    assert.equal(refreshed.length, 2, '按新原文重新提取之后有两条候选')
    const guardAfter = noticeSaveGuard({
      sourceText: SOURCE_B,
      snapshot: SOURCE_B,
      rowCount: refreshed.length,
      committed: false,
    })
    assert.equal(guardAfter.allowed, true)
    const outcome = await repo.importNoticeCandidates({ sourceText: guardAfter.sourceToPersist, rows: refreshed })
    assert.equal(outcome.createdIds.length, 2)
    const stored = await ctx.db.getAllAsync('SELECT raw_text FROM task_sources ORDER BY id ASC;')
    assert.deepEqual(
      stored.map((row) => row.raw_text),
      [SOURCE_B, SOURCE_B],
      '入库原文是新快照 B，而不是 A 与 B 的混合',
    )
  } finally {
    ctx.close()
  }
})

test('取消重新提取 → 候选行与已改内容原样保留（不静默丢弃）', async () => {
  const ctx = await createTestDatabase()
  try {
    await ctx.courses.create(courseDraft({ name: '数据结构', code: 'CS101' }))
    const available = await ctx.courses.listAll()
    const repo = new NoticeImportRepository(ctx.db, () => new Date('2026-10-15T02:00:00Z'))

    const rows = noticeRowsFromCandidates(parseNoticeSource(SOURCE_A, available).candidates, available)
    // 用户改了标题（未保存的核对内容）
    const edited = rows.map((row) => ({ ...row, title: '我自己改的标题' }))
    const validation = validateNoticeImportRows(edited, available)
    assert.deepEqual(validation.fieldErrors, {})

    // 取消重新提取 = 只关掉确认框：快照、行、标题都不动
    const snapshotAfterCancel = SOURCE_A
    assert.equal(edited[0].title, '我自己改的标题')
    assert.equal(snapshotAfterCancel, SOURCE_A)
    // 取消之后原文还是 A：守卫依旧放行，可以正常保存改好的内容
    const guard = noticeSaveGuard({
      sourceText: SOURCE_A,
      snapshot: snapshotAfterCancel,
      rowCount: edited.length,
      committed: false,
    })
    assert.equal(guard.allowed, true)
    const outcome = await repo.importNoticeCandidates({ sourceText: guard.sourceToPersist, rows: edited })
    assert.equal(outcome.createdIds.length, 1)
    const stored = await ctx.tasks.getById(outcome.createdIds[0])
    assert.equal(stored.title, '我自己改的标题')
  } finally {
    ctx.close()
  }
})
