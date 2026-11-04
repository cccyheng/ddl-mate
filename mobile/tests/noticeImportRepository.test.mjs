// 通知原文 → 待办：**真实 SQLite** 的仓库层测试。
//
// 用的与应用完全相同的 schema 与 SQL（见 `tests/helpers/sqliteHarness.mjs` 的说明：
// Node 侧 SQLite 验证 SQL / 事务 / 外键语义，验证不了原生绑定与真机界面）。
//
// 授权书点名要证明的几件事都在这里：
//   1. 原文与任务**同一事务**：任一写入失败整批回滚，不留孤儿任务；
//   2. 幂等：原文 + 全部字段完全一致才跳过；同标题不同时间 / 课程 / 原文照旧新建；
//   3. 只写勾选的行；
//   4. 保存前被删除的课程**可见地拒绝**，不静默忽略；
//   5. 提交后读回失败**不谎报未保存**，且不允许重试；
//   6. 完整原文（含消息头）落库并能读回。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  applyAdditiveColumns,
  courseDraft,
  createTestDatabase,
  failingRunDatabase,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { NoticeImportRepository } from '../src/domain/noticeImportRepository.ts'
import { noticeRowsFromCandidates, parseNoticeSource } from '../src/domain/noticeImport.ts'

const NOW = () => new Date('2026-10-08T04:00:00.000Z')

const SOURCE = [
  '数据结构课程群',
  '2026年10月8日 09:12 张老师',
  '',
  '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
  '2. 大学物理第三次作业：2026年11月3日 14:00 前交纸质稿',
].join('\n')

/** 建库 + 两门课程 + 仓库实例。 */
async function seed() {
  const ctx = await createTestDatabase()
  const structure = await ctx.courses.create(courseDraft({ name: '数据结构', code: 'CS201' }))
  const physics = await ctx.courses.create(courseDraft({ name: '大学物理', code: 'PH101' }))
  const repo = new NoticeImportRepository(ctx.db, NOW)
  return { ctx, repo, structure, physics }
}

/** 从真实原文解析出可保存的行（与界面走同一条路径）。 */
function rowsOf(source, courses, { rowIndexes } = {}) {
  const summary = parseNoticeSource(source, courses)
  const rows = noticeRowsFromCandidates(summary.candidates, courses)
  return rowIndexes ? rows.filter((row) => rowIndexes.includes(row.rowIndex)) : rows
}

test('一次导入：任务 + 完整原文一起写入，可读回', async () => {
  const { ctx, repo, structure } = await seed()
  try {
    const rows = rowsOf(SOURCE, await ctx.courses.listAll())
    const outcome = await repo.importNoticeCandidates({ sourceText: SOURCE, rows })

    assert.equal(outcome.committed, true)
    assert.equal(outcome.readbackError, null)
    assert.equal(outcome.createdIds.length, 2)
    assert.equal(outcome.duplicateCount, 0)
    assert.deepEqual(
      outcome.created.map((created) => created.task.deadline),
      ['2026-10-20T22:00:00+08:00', '2026-11-03T14:00:00+08:00'],
    )
    assert.equal(outcome.created[0].task.courseId, structure.id)

    // 原文逐字留档（含群名与消息头），并且是**完整原文**而不是某一段
    const sources = await ctx.tasks.listSources(outcome.createdIds[0])
    assert.equal(sources.length, 1)
    assert.equal(sources[0].kind, 'ORIGINAL_TEXT')
    assert.equal(sources[0].rawText, SOURCE)
    assert.ok(sources[0].rawText.includes('2026年10月8日 09:12 张老师'))

    // 说明能放下时就是**这一组**的原文（含紧随其后的折行内容，不做摘录式改写）
    assert.equal(
      outcome.created[0].task.description,
      [
        '1. 数据结构作业三：2026年10月20日 22:00 前提交到学习通',
        '2. 大学物理第三次作业：2026年11月3日 14:00 前交纸质稿',
      ].join('\n'),
    )
  } finally {
    ctx.close()
  }
})

test('同一份原文再导入一次：只跳过完全重复的行，不产生重复任务', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const first = await repo.importNoticeCandidates({ sourceText: SOURCE, rows: rowsOf(SOURCE, courses) })
    assert.equal(first.createdIds.length, 2)

    const second = await repo.importNoticeCandidates({ sourceText: SOURCE, rows: rowsOf(SOURCE, courses) })
    assert.equal(second.committed, true)
    assert.equal(second.createdIds.length, 0, '完全重复不该再写一条')
    assert.equal(second.duplicateCount, 2)
    assert.equal(await ctx.tasks.countAll(), 2)
  } finally {
    ctx.close()
  }
})

test('同标题但时间 / 课程 / 原文不同：保留为不同的任务', async () => {
  const { ctx, repo, structure, physics } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const textA = '数据结构作业：2026年10月20日 22:00 前提交到学习通'
    const textB = '数据结构作业：2026年10月21日 22:00 前提交到学习通'
    const textC = '数据结构作业：2026年10月20日 22:00 前提交到雨课堂' // 同样的时间，不同的原文

    const a = await repo.importNoticeCandidates({ sourceText: textA, rows: rowsOf(textA, courses) })
    const b = await repo.importNoticeCandidates({ sourceText: textB, rows: rowsOf(textB, courses) })
    const c = await repo.importNoticeCandidates({ sourceText: textC, rows: rowsOf(textC, courses) })
    assert.equal(a.createdIds.length, 1)
    assert.equal(b.createdIds.length, 1, '不同截止时间必须新建')
    assert.equal(c.createdIds.length, 1, '不同原文必须新建')

    // 同一标题、同一时间，但换一门课程 → 也必须新建（课程是「有意义字段」）
    const sameTimeDifferentCourse = rowsOf(textA, courses).map((row) => ({
      ...row,
      courseId: row.courseId === structure.id ? physics.id : structure.id,
    }))
    const d = await repo.importNoticeCandidates({ sourceText: textA, rows: sameTimeDifferentCourse })
    assert.equal(d.createdIds.length, 1, '不同课程必须新建')

    assert.equal(await ctx.tasks.countAll(), 4)
    const titles = (await ctx.tasks.listAll()).map((task) => task.title)
    assert.equal(new Set(titles).size, 1, '四条任务标题相同，但都保留了')
  } finally {
    ctx.close()
  }
})

test('同一条原文里完全相同的两行：本批内也只写一条', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const text = '数据结构作业：2026年10月20日 22:00 前提交到学习通'
    const rows = rowsOf(text, courses)
    const duplicated = [...rows, { ...rows[0] }]
    const outcome = await repo.importNoticeCandidates({ sourceText: text, rows: duplicated })
    assert.equal(outcome.createdIds.length, 1)
    assert.equal(outcome.duplicateCount, 1)
    assert.equal(await ctx.tasks.countAll(), 1)
  } finally {
    ctx.close()
  }
})

test('只写勾选的行，未勾选的完全不参与校验与写入', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses).map((row, index) => ({ ...row, selected: index === 1 }))
    const outcome = await repo.importNoticeCandidates({ sourceText: SOURCE, rows })
    assert.equal(outcome.createdIds.length, 1)
    const stored = await ctx.tasks.getById(outcome.createdIds[0])
    assert.ok(stored.title.includes('物理') || stored.title.includes('实验'), stored.title)
    assert.equal(await ctx.tasks.countAll(), 1)
  } finally {
    ctx.close()
  }
})

test('保存前被删除的课程：可见地拒绝，且什么都没写', async () => {
  const { ctx, repo, physics } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses)
    // 用户在核对期间把「大学物理」删掉了
    await ctx.courses.removeCourse(physics.id, { confirmed: true })

    let thrown = null
    try {
      await repo.importNoticeCandidates({ sourceText: SOURCE, rows })
    } catch (cause) {
      thrown = cause
    }
    assert.ok(thrown, '课程已删除时必须报错，而不是静默忽略')
    assert.equal(thrown.name, 'ValidationError')
    const messages = Object.values(thrown.fields)
    assert.ok(
      messages.some((message) => message.includes('已经找不到')),
      Object.values(thrown.fields).join('|'),
    )
    assert.equal(await ctx.tasks.countAll(), 0, '被拒绝时不能写任何任务')
  } finally {
    ctx.close()
  }
})

test('原文写失败：任务与原文整批回滚，不留孤儿任务', async () => {
  const { ctx, structure } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses)
    // 第 2 次写入 = 第一条任务的 task_sources 插入 → 让它失败
    const failing = new NoticeImportRepository(
      failingRunDatabase(ctx.db, (count) => count === 2),
      NOW,
    )
    let thrown = null
    try {
      await failing.importNoticeCandidates({ sourceText: SOURCE, rows })
    } catch (cause) {
      thrown = cause
    }
    assert.ok(thrown, '原文写失败必须抛出')
    assert.equal(await ctx.tasks.countAll(), 0, '第一条任务也必须回滚')
    const sources = await ctx.db.getAllAsync('SELECT id FROM task_sources;')
    assert.deepEqual(sources, [])
    assert.equal(structure.code, 'CS201', '课程没有被这次失败影响')
  } finally {
    ctx.close()
  }
})

test('提交后读回失败：不谎报未保存，给出已提交的 id 且不允许重试', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses)
    const failingRepo = new NoticeImportRepository(
      {
        ...ctx.db,
        async getFirstAsync(sql, params) {
          if (String(sql).includes('FROM tasks WHERE id =')) {
            throw new Error('测试注入的读回失败')
          }
          return ctx.db.getFirstAsync(sql, params)
        },
      },
      NOW,
    )
    const outcome = await failingRepo.importNoticeCandidates({ sourceText: SOURCE, rows })
    assert.equal(outcome.committed, true, '提交已经发生，这是唯一事实')
    assert.ok(outcome.readbackError, '读回失败要如实报告')
    assert.equal(outcome.created.length, 0)
    assert.equal(outcome.createdIds.length, 2, '已经提交的 id 仍然要返回')
    assert.equal(await ctx.tasks.countAll(), 2, '数据真的在里面')

    // 重试同一次导入：只会有完全重复被跳过，不会再多出两条
    const retry = await repo.importNoticeCandidates({ sourceText: SOURCE, rows })
    assert.equal(retry.createdIds.length, 0)
    assert.equal(retry.duplicateCount, 2)
    assert.equal(await ctx.tasks.countAll(), 2)
  } finally {
    ctx.close()
  }
})

test('超长原文进不了库：显式拒绝，且什么都不写', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses)
    const huge = `${SOURCE}\n${'多'.repeat(10_001)}`
    let thrown = null
    try {
      await repo.importNoticeCandidates({ sourceText: huge, rows })
    } catch (cause) {
      thrown = cause
    }
    assert.ok(thrown)
    assert.equal(thrown.name, 'ValidationError')
    assert.equal(await ctx.tasks.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('没有勾选任何一条：显式报错，不写空批', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses).map((row) => ({ ...row, selected: false }))
    await assert.rejects(() => repo.importNoticeCandidates({ sourceText: SOURCE, rows }), /没有勾选/)
    assert.equal(await ctx.tasks.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('完整原文在**重开数据库**之后仍然读得回来（模拟关掉 App 再打开）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-notice-'))
  const file = join(dir, 'reopen.db')
  let raw = new DatabaseSync(file)
  try {
    raw.exec('PRAGMA foreign_keys = ON;')
    raw.exec(readSchemaSql())
    raw.exec(readAppSettingsSql())
    raw.exec(readScreenshotLibrarySql())
    raw.exec('PRAGMA user_version = 3;')
    applyAdditiveColumns(raw)
    const db = wrapDatabase(raw)
    const { CourseRepository } = await import('../src/domain/courseRepository.ts')
    const { TaskRepository } = await import('../src/domain/taskRepository.ts')
    const courses = new CourseRepository(db, NOW)
    const tasks = new TaskRepository(db, NOW)
    await courses.create(courseDraft({ name: '数据结构', code: 'CS201' }))
    const repo = new NoticeImportRepository(db, NOW)
    const available = await courses.listAll()
    const outcome = await repo.importNoticeCandidates({ sourceText: SOURCE, rows: rowsOf(SOURCE, available) })
    assert.equal(outcome.createdIds.length, 2)

    // 关掉并重新打开（真实文件库）
    raw.close()
    raw = new DatabaseSync(file)
    const reopened = wrapDatabase(raw)
    const reopenedTasks = new TaskRepository(reopened, NOW)
    const stored = await reopenedTasks.listAllOriginalSources()
    assert.equal(stored.size, 2)
    for (const text of stored.values()) {
      assert.equal(text, SOURCE, '原文逐字留存，包括消息头与空行')
    }
  } finally {
    try {
      raw.close()
    } catch {
      // 已经关过就算了
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('并发保存（连点）：后一次被明确拒绝，不会写出重复任务', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const rows = rowsOf(SOURCE, courses)
    const [first, second] = await Promise.allSettled([
      repo.importNoticeCandidates({ sourceText: SOURCE, rows }),
      repo.importNoticeCandidates({ sourceText: SOURCE, rows }),
    ])
    const rejected = [first, second].filter((result) => result.status === 'rejected')
    const fulfilled = [first, second].filter((result) => result.status === 'fulfilled')
    assert.equal(rejected.length, 1, '并发的第二次必须被拒绝')
    assert.equal(fulfilled.length, 1)
    assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /上一次保存还没有结束/)
    assert.equal(await ctx.tasks.countAll(), 2, '只写了一批')
  } finally {
    ctx.close()
  }
})

test('用户把任务标记完成后，再导入同一份原文不会把它「复活」成新的 TODO', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const source = '英语作业二：请于2026年10月20日 18:00前提交作文。'
    const first = await repo.importNoticeCandidates({ sourceText: source, rows: rowsOf(source, courses) })
    assert.equal(first.createdIds.length, 1)
    const id = first.createdIds[0]

    // 用户把这条任务标记为已完成（状态与 completedAt 都变了）
    await ctx.tasks.changeStatus(id, 'DONE')
    const done = await ctx.tasks.getById(id)
    assert.equal(done.status, 'DONE')
    assert.ok(done.completedAt)

    const again = await repo.importNoticeCandidates({ sourceText: source, rows: rowsOf(source, courses) })
    assert.equal(again.createdIds.length, 0, '已存在的任务必须被跳过，不能再建一条 TODO')
    assert.equal(again.duplicateCount, 1)
    assert.equal(await ctx.tasks.countAll(), 1)

    // 已有那条**原样保留**：仍然完成、completed_at 没有被清掉
    const reloaded = await ctx.tasks.getById(id)
    assert.equal(reloaded.status, 'DONE')
    assert.equal(reloaded.completedAt, done.completedAt)
  } finally {
    ctx.close()
  }
})

test('原文逐字留档：前后的空白与空行也不能被 trim 掉', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const source = '\n  2026年10月15日 08:00 张老师\n数据结构作业一：请于2026年10月18日 22:00前提交报告。\n  '
    const rows = rowsOf(source, courses)
    assert.ok(rows.length >= 1)
    const outcome = await repo.importNoticeCandidates({ sourceText: source, rows })
    const saved = ctx.raw
      .prepare('SELECT raw_text FROM task_sources WHERE task_id = ?')
      .get(outcome.createdIds[0])
    assert.equal(saved.raw_text, source, '原文必须逐字保存')

    // 再导入一次同样逐字跳过（写入与读回用的是同一份原文口径）
    const again = await repo.importNoticeCandidates({ sourceText: source, rows })
    assert.equal(again.createdIds.length, 0)
    assert.equal(again.duplicateCount, rows.length)
  } finally {
    ctx.close()
  }
})

test('原文里有群名与消息头时，31 条真实任务仍然被如实判成超限', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const tasks = Array.from(
      { length: 31 },
      (_, index) => `${index + 1}. 数据结构作业${index + 1}：请于2026年10月18日22:00前提交报告。`,
    )
    const source = ['数据结构课程群', '2026年10月15日 08:00 张老师', '', ...tasks].join('\n')
    const summary = parseNoticeSource(source, courses)
    assert.equal(summary.overflow, true, '解析器的 maxTasks 在过滤之前生效，不能因此少算')
    assert.equal(summary.actualCount, 31)
    assert.equal(summary.candidates.length, 30)

    // 就算调用方硬把第 31 行也塞进请求，仓库也会在写库之前拒绝
    const rows = noticeRowsFromCandidates(summary.candidates, courses)
    await assert.rejects(
      () => repo.importNoticeCandidates({ sourceText: source, rows: [...rows, { ...rows[0], rowIndex: 31 }] }),
      /最多保存 30 条/,
    )
    assert.equal(await ctx.tasks.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('去重键用 JSON 元组：原文里出现 NUL / 竖线也不会互相撞键', async () => {
  const { ctx, repo } = await seed()
  try {
    const courses = await ctx.courses.listAll()
    const sourceA = '数据结构作业三：请于2026年10月20日 22:00前提交\u0000实验报告。'
    const sourceB = '数据结构作业三：请于2026年10月20日 22:00前提交|实验报告。'
    const a = await repo.importNoticeCandidates({ sourceText: sourceA, rows: rowsOf(sourceA, courses) })
    const b = await repo.importNoticeCandidates({ sourceText: sourceB, rows: rowsOf(sourceB, courses) })
    assert.equal(a.createdIds.length, 1)
    assert.equal(b.createdIds.length, 1, '内容不同的原文必须各自保留')
    assert.equal(await ctx.tasks.countAll(), 2)
    const stored = await ctx.db.getAllAsync('SELECT raw_text FROM task_sources ORDER BY id ASC;')
    assert.deepEqual(
      stored.map((row) => row.raw_text),
      [sourceA, sourceB],
    )
  } finally {
    ctx.close()
  }
})

test('既有任务不会因为这次导入被改写', async () => {
  const { ctx, repo, structure } = await seed()
  try {
    const existing = await ctx.tasks.create(
      taskDraft({ title: '老任务', courseId: structure.id, deadline: '2026-09-30T09:00', priority: 5 }),
    )
    const courses = await ctx.courses.listAll()
    await repo.importNoticeCandidates({ sourceText: SOURCE, rows: rowsOf(SOURCE, courses) })
    const reloaded = await ctx.tasks.getById(existing.id)
    assert.equal(reloaded.title, '老任务')
    assert.equal(reloaded.deadline, '2026-09-30T09:00:00+08:00')
    assert.equal(reloaded.priority, 5)
  } finally {
    ctx.close()
  }
})
