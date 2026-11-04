// 通知转待办与 store 队列的接线检查。
//
// 独立复核点名：通知导入**必须复用 store 的公共串行队列**（与任务 / 课程写入同一条），
// 不能像照片导入那样另开一条自己的队列 —— 同一个 SQLite 连接上，两条队列同时开事务
// 会互相穿插。Node 侧跑不了 React Native 的 store，所以这里用两条证据：
//   1. **源码检查**：`AppStore.tsx` 的通知导入走 `enqueue(...)`，且不存在独立队列 ref；
//   2. **真实 SQLite 行为**：把「通知导入 / 普通任务写入」放进同一条串行队列里依次执行
//      （中间都刷新一次快照），验证不会报事务嵌套、也不会写出重复任务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestDatabase, courseDraft, taskDraft } from './helpers/sqliteHarness.mjs'
import { noticeRowsFromCandidates, parseNoticeSource } from '../src/domain/noticeImport.ts'
import { NoticeImportRepository } from '../src/domain/noticeImportRepository.ts'

const here = dirname(fileURLToPath(import.meta.url))

test('AppStore：通知导入复用公共串行队列，没有新建独立写队列', () => {
  const source = readFileSync(join(here, '..', 'src', 'store', 'AppStore.tsx'), 'utf8')
  assert.match(
    source,
    /importNoticeCandidates:\s*\(request\)\s*=>\s*\n?\s*enqueue\(/,
    '通知导入必须走 enqueue（公共队列）',
  )
  assert.ok(!/noticeImportQueue/.test(source), '不应存在独立的通知导入队列')
  // 照片导入仍然保留它自己的队列（自带事务，不能套在 enqueue 里）
  assert.match(source, /const importQueue = useRef/)
})

test('NoticeImportScreen：离开守卫真的把 rowCount 传给了纯判定（复核第 10 条）', () => {
  const source = readFileSync(join(here, '..', 'src', 'screens', 'NoticeImportScreen.tsx'), 'utf8')
  // 守卫必须由界面真的调用（不是测试里另写一遍规则）
  assert.match(source, /hasUnsavedNoticeDraft\(\{/)
  // 参数里必须有 rowCount：清空原文之后靠它保住已有候选行
  assert.match(
    source,
    /hasUnsavedNoticeDraft\(\{[\s\S]{0,160}?rowCount:\s*rows\.length/,
    '离开守卫必须传 rowCount，否则清空原文会绕过提示',
  )
  // 同时仍然传 snapshot 与 committed（含 0 候选 / 已提交两种情况）
  assert.match(source, /hasUnsavedNoticeDraft\(\{[\s\S]{0,220}?snapshot:\s*sourceSnapshot/)
  assert.match(source, /hasUnsavedNoticeDraft\(\{[\s\S]{0,260}?committed:\s*outcome !== null/)
  // usePreventRemove 用的就是这个判定
  assert.match(source, /usePreventRemove\(hasUnsavedDraft \|\| saving/)
})

test('串行队列：导入与普通任务写入交错执行也能跑完，且同一原文只写一次', async () => {
  const ctx = await createTestDatabase()
  try {
    await ctx.courses.create(courseDraft({ name: '数据结构', code: 'CS101' }))
    const courses = await ctx.courses.listAll()
    const repo = new NoticeImportRepository(ctx.db, () => new Date('2026-10-15T02:00:00.000Z'))

    let refreshed = 0
    /** 与 store 的 refresh 等价：读一次快照（读取不进事务）。 */
    const refreshAll = async () => {
      refreshed += 1
      await ctx.tasks.listAll()
      await ctx.tasks.listAllOriginalSources()
    }

    /** 与 store 的 `enqueue` 相同形态的串行队列：写 → 刷新 → 下一个。 */
    let tail = Promise.resolve()
    const queue = (action) => {
      const run = async () => {
        const result = await action()
        await refreshAll()
        return result
      }
      const chained = tail.then(run, run)
      tail = chained.then(
        () => undefined,
        () => undefined,
      )
      return chained
    }

    const source = '数据结构作业三：请于2026年10月20日 22:00前提交到学习通。'
    const rows = noticeRowsFromCandidates(parseNoticeSource(source, courses).candidates, courses)

    const first = await queue(() => repo.importNoticeCandidates({ sourceText: source, rows }))
    assert.equal(first.createdIds.length, 1)
    // 中间插入一次普通任务写入（同一条连接、同一条队列）
    await queue(() => ctx.tasks.create(taskDraft({ title: '手工任务' })))
    const second = await queue(() => repo.importNoticeCandidates({ sourceText: source, rows }))
    assert.equal(second.createdIds.length, 0, '同一份原文必须跳过')
    assert.equal(second.duplicateCount, 1)

    assert.equal(await ctx.tasks.countAll(), 2, '一条导入任务 + 一条手工任务')
    assert.equal(refreshed, 3, '每个动作之后都刷新了一次')
  } finally {
    ctx.close()
  }
})
