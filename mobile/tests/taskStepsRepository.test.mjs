/**
 * 任务步骤清单 —— **真实 SQLite 持久化**测试。
 *
 * 授权书点名要验证的：保存 / 读取 / **重开数据库**、过期版本冲突、父任务不存在或被删
 * 时**零写入**、坏记录原样保留、写入失败时全有或全无、删任务时**精确**清掉它那一个键
 * 并保留别的任务的清单、提交后读回失败如实报告、以及「全部步骤做完之后父任务的
 * DDL / 状态 / 预计用时一个字节都不变」。
 *
 * 边界说明（不夸大）：这里是 Node 侧 `node:sqlite`，验证 SQL 与仓库逻辑，
 * 验证不了 iPhone 上的 expo-sqlite 原生绑定。所有库都是系统临时目录里的临时文件
 * （或内存库），**绝不碰用户真实数据**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyAdditiveColumns,
  createTestDatabase,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { SCHEMA_VERSION } from '../src/db/schema.ts'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import { TaskStepsRepository } from '../src/domain/taskStepsRepository.ts'

const NOW = new Date('2026-10-15T02:00:30.000Z')

const step = (id, title, done = false) => ({ id, title, done })

function tempDbPath(prefix = 'ddl-tasksteps-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, file: join(dir, 'steps.db') }
}

/** 打开一个真实文件库（与应用同一份 schema + user_version）。 */
function openFileDatabase(file) {
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const tasks = new TaskRepository(db, () => NOW)
  const steps = new TaskStepsRepository(db, tasks, () => NOW)
  return { raw, db, tasks, steps }
}

/** 建一条真实任务，返回它的 id。 */
async function createTask(tasks, overrides = {}) {
  const outcome = await tasks.create(taskDraft(overrides))
  return outcome.id
}

/* --------------------------------- 用例 --------------------------------- */

test('保存 → 读取 → **重开数据库**：步骤还在，且只写 app_settings 里那一个键', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, { title: '数据结构第 3 次作业' })

    const before = await opened.steps.loadSteps(taskId)
    assert.deepEqual(before, { ok: true, steps: [], revision: 0 }, '没保存过 = 正常空状态，不是错误')

    const saved = await opened.steps.saveSteps({
      taskId,
      steps: [step('s1', '看第 3 章例题', true), step('s2', '写第 1–5 题')],
      expectedRevision: 0,
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.committed, true)
    assert.equal(saved.revision, 1)
    assert.equal(saved.readbackError, null)

    const rows = opened.raw.prepare('SELECT key, value FROM app_settings;').all()
    assert.equal(rows.length, 1, '只应该有这一个键')
    assert.equal(rows[0].key, `task_steps.${taskId}`)
    const stored = JSON.parse(String(rows[0].value))
    assert.equal(stored.version, 1)
    assert.equal(stored.taskId, taskId)
    assert.equal(stored.revision, 1)
    assert.deepEqual(stored.steps, [step('s1', '看第 3 章例题', true), step('s2', '写第 1–5 题')])
    assert.ok(String(rows[0].value).length < 8_000, '载荷是有界的（不存整个 App 的数据）')
    opened.raw.close()

    // 重开数据库：步骤必须还在（真正的持久化，不是内存态）。
    const reopened = openFileDatabase(file)
    const loaded = await reopened.steps.loadSteps(taskId)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.revision, 1)
    assert.deepEqual(loaded.steps, [step('s1', '看第 3 章例题', true), step('s2', '写第 1–5 题')])
    const other = await reopened.steps.loadSteps(taskId + 1)
    assert.equal(other.ok, false, '别的任务（且不存在）不该有清单')
    assert.equal(other.code, 'PARENT_MISSING')
    reopened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('顺序稳定：再次保存时编号与顺序原样保留（不重排、不重新编号）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const first = [step('b', '第二步'), step('a', '第一步'), step('c', '第三步')]
    assert.equal((await opened.steps.saveSteps({ taskId, steps: first, expectedRevision: 0 })).committed, true)

    // 勾掉中间一条，再保存一次：顺序与编号必须不变。
    const second = [first[0], { ...first[1], done: true }, first[2]]
    const saved = await opened.steps.saveSteps({ taskId, steps: second, expectedRevision: 1 })
    assert.equal(saved.revision, 2)
    const loaded = await opened.steps.loadSteps(taskId)
    assert.deepEqual(loaded.steps, second)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('过期版本冲突：两个实例并发保存，后到的被拒绝且不覆盖（之后仍可显式替换）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const other = new TaskStepsRepository(opened.db, opened.tasks, () => NOW)

    const a = await opened.steps.saveSteps({ taskId, steps: [step('a', 'A 的清单')], expectedRevision: 0 })
    assert.equal(a.revision, 1)

    // 另一个实例还按「没有保存过」提交 → 必须被拒绝，并回传库里当前的版本号。
    const b = await other.saveSteps({ taskId, steps: [step('b', 'B 的清单')], expectedRevision: 0 })
    assert.equal(b.committed, false)
    assert.equal(b.revision, 1, '被拒时回传当前版本号，界面才能提示「载入最新」')
    assert.match(b.reason, /别处已经保存过/)
    assert.deepEqual((await opened.steps.loadSteps(taskId)).steps, [step('a', 'A 的清单')], 'A 的内容没被覆盖')

    // B 拿到最新版本后仍然可以明确替换。
    const replace = await other.saveSteps({ taskId, steps: [step('b', 'B 的清单')], expectedRevision: 1 })
    assert.equal(replace.committed, true)
    assert.equal(replace.revision, 2)
    assert.deepEqual((await opened.steps.loadSteps(taskId)).steps, [step('b', 'B 的清单')])
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('父任务不存在 / 已被删除：拒绝保存且**零写入**（草稿仍由内存保留）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)

    // 1) 任务 ID 压根不存在。
    const ghost = await opened.steps.saveSteps({ taskId: taskId + 99, steps: [step('a', 'A')], expectedRevision: 0 })
    assert.equal(ghost.committed, false)
    assert.match(ghost.reason, /不在本机/)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '一个字节都没写')

    // 2) 读取时任务还在，保存前被删掉 → 读取变成「父任务不在」，保存仍然零写入。
    assert.equal((await opened.steps.loadSteps(taskId)).revision, 0)
    await opened.tasks.remove(taskId)
    const afterDeleteLoad = await opened.steps.loadSteps(taskId)
    assert.equal(afterDeleteLoad.ok, false, '公开读取入口也要确认父任务还在')
    assert.equal(afterDeleteLoad.code, 'PARENT_MISSING')
    const afterDelete = await opened.steps.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })
    assert.equal(afterDelete.committed, false)
    assert.match(afterDelete.reason, /不在本机/)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '零写入')

    // 2b) 孤儿记录：键还在、任务没了 → 绝不把它当成「这条任务的清单」展示。
    opened.raw
      .prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);')
      .run(`task_steps.${taskId}`, JSON.stringify({ version: 1, taskId, revision: 1, steps: [step('x', '孤儿')] }), NOW.toISOString())
    const orphan = await opened.steps.loadSteps(taskId)
    assert.equal(orphan.ok, false)
    assert.equal(orphan.code, 'PARENT_MISSING')
    assert.equal('steps' in orphan, false, '不可用结果里不带任何步骤内容')
    opened.raw.prepare('DELETE FROM app_settings WHERE key = ?;').run(`task_steps.${taskId}`)

    // 3) 非法任务 ID 也拒绝（不会去拼一个 task_steps.NaN 之类的键）。
    const invalid = await opened.steps.saveSteps({ taskId: 0, steps: [step('a', 'A')], expectedRevision: 0 })
    assert.equal(invalid.committed, false)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('坏记录（坏 JSON / 不认识的版本 / 结构不合法）：读回可读原因，且**原样保留、拒绝覆盖**', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const key = `task_steps.${taskId}`
    const insert = (value) =>
      opened.raw
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
        )
        .run(key, value, NOW.toISOString())

    for (const broken of [
      '{ 这不是 json',
      JSON.stringify({ version: 99, taskId, revision: 1, steps: [] }),
      JSON.stringify({ version: 1, taskId, revision: 1, steps: [{ id: 'a', title: '   ', done: false }] }),
      JSON.stringify({ version: 1, taskId, revision: 1, steps: [{ id: 'a', title: 'A', done: 'yes' }] }),
      JSON.stringify({ version: 1, taskId: taskId + 1, revision: 1, steps: [step('a', 'A')] }),
    ]) {
      insert(broken)
      const loaded = await opened.steps.loadSteps(taskId)
      assert.equal(loaded.ok, false, `这条必须读不出来：${broken.slice(0, 40)}`)
      assert.match(loaded.reason, /读不出来/)
      assert.equal(
        opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(key).value,
        broken,
        '坏记录必须一个字节都不动',
      )
      // 结构坏掉时保存必须**拒绝**，而不是把用户那条记录顺手覆盖掉。
      const refused = await opened.steps.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })
      assert.equal(refused.committed, false)
      assert.match(refused.reason, /读不出来|已停止保存/)
      assert.equal(opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(key).value, broken)
    }
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('写入失败：事务回滚，全有或全无（零改动）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const steps = [step('a', 'A'), step('b', 'B')]

    const failing = {
      ...opened.db,
      async runAsync(sql, params = []) {
        throw new Error('测试注入的写入失败')
      },
    }
    const repo = new TaskStepsRepository(failing, opened.tasks, () => NOW)
    const failed = await repo.saveSteps({ taskId, steps, expectedRevision: 0 })
    assert.equal(failed.ok, false)
    assert.equal(failed.committed, false)
    assert.match(failed.reason, /写入失败/)
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '失败后必须零改动')

    // 用真实连接再确认一次：事务没有留下半条记录，而且还能正常保存。
    const after = await opened.steps.loadSteps(taskId)
    assert.deepEqual(after, { ok: true, steps: [], revision: 0 })
    assert.equal((await opened.steps.saveSteps({ taskId, steps, expectedRevision: 0 })).committed, true)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('提交成功但读回失败：仍然 committed，并把真实错误交给界面', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)

    let reads = 0
    const flaky = {
      ...opened.db,
      async getFirstAsync(sql, params = []) {
        if (String(sql).includes('app_settings')) {
          reads += 1
          // 第 1 次读是事务里的「既有记录」，第 2 次就是提交之后的读回。
          if (reads >= 2) throw new Error('读回时连接断了')
        }
        return opened.db.getFirstAsync(sql, params)
      },
    }
    const repo = new TaskStepsRepository(flaky, opened.tasks, () => NOW)
    const result = await repo.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })
    assert.equal(result.committed, true, '写入已经提交，这个事实不能被读回失败改写')
    assert.equal(result.revision, 1)
    assert.match(result.readbackError, /读回时连接断了/)
    const stored = JSON.parse(
      opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(`task_steps.${taskId}`).value,
    )
    assert.equal(stored.revision, 1, '库里确实写进去了')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('删除任务：只清它自己那一个键（连同来源文本一起原子完成），别的任务清单不受影响', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    // 真实装配：把「精确删这一个键」注入给任务仓库（与 store 里的做法一致）。
    opened.tasks.setRemoveCleanup((id) => opened.steps.removeStepsForTask(id))

    const targetId = await createTask(opened.tasks, { title: '要删的任务', originalText: '原始通知文本' })
    const keeperId = await createTask(opened.tasks, { title: '保留的任务' })
    assert.equal(
      (await opened.steps.saveSteps({ taskId: targetId, steps: [step('t1', '要被删的步骤')], expectedRevision: 0 })).committed,
      true,
    )
    assert.equal(
      (await opened.steps.saveSteps({ taskId: keeperId, steps: [step('k1', '要保留的步骤')], expectedRevision: 0 })).committed,
      true,
    )
    // 一条无关设置：删除任务绝不能顺手把它删掉。
    opened.raw.exec(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('pressure.daily_study_reference_minutes', '120', '${NOW.toISOString()}');`,
    )

    await opened.tasks.remove(targetId)

    const keys = opened.raw.prepare('SELECT key FROM app_settings ORDER BY key;').all().map((row) => row.key)
    assert.deepEqual(
      keys,
      ['pressure.daily_study_reference_minutes', `task_steps.${keeperId}`],
      '只少了被删任务的那一个键',
    )
    assert.equal(opened.raw.prepare('SELECT COUNT(*) AS n FROM task_sources WHERE task_id = ?;').get(targetId).n, 0, '来源文本同样清掉')
    assert.deepEqual((await opened.steps.loadSteps(keeperId)).steps, [step('k1', '要保留的步骤')], '别的任务的清单原样保留')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('清理步骤键失败：任务 / 来源文本 / 步骤键**一起回滚**（删任务要么全成、要么全不动）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, { title: '删到一半会失败的任务', originalText: '原始通知文本' })
    assert.equal((await opened.steps.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })).committed, true)
    const key = `task_steps.${taskId}`
    const snapshot = () => ({
      task: opened.raw.prepare('SELECT COUNT(*) AS n FROM tasks WHERE id = ?;').get(taskId).n,
      sources: opened.raw.prepare('SELECT COUNT(*) AS n FROM task_sources WHERE task_id = ?;').get(taskId).n,
      steps: opened.raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(key)?.value ?? null,
    })
    const before = snapshot()
    assert.deepEqual(before, { task: 1, sources: 1, steps: before.steps }, '前置：任务 + 来源 + 步骤键都在')
    assert.ok(before.steps !== null)

    // 注入一个「清理时抛错」的钩子：任务与来源文本必须跟着回滚。
    opened.tasks.setRemoveCleanup(async () => {
      throw new Error('测试注入的清理失败')
    })
    await assert.rejects(() => opened.tasks.remove(taskId), /清理失败/)
    assert.deepEqual(snapshot(), before, '清理失败时任务 / 来源 / 步骤键一个都不许少')

    // 恢复真实的清理动作之后，删除仍然可以完整完成。
    opened.tasks.setRemoveCleanup((id) => opened.steps.removeStepsForTask(id))
    await opened.tasks.remove(taskId)
    assert.deepEqual(snapshot(), { task: 0, sources: 0, steps: null }, '恢复正常后一起删干净')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('删除不存在的任务：仍然报错，且绝不顺手删掉任何步骤键', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    opened.tasks.setRemoveCleanup((id) => opened.steps.removeStepsForTask(id))
    const taskId = await createTask(opened.tasks)
    assert.equal((await opened.steps.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })).committed, true)

    await assert.rejects(() => opened.tasks.remove(taskId + 123), /不存在/)
    assert.deepEqual((await opened.steps.loadSteps(taskId)).steps, [step('a', 'A')], '别人的清单一个字节都没动')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('全部步骤做完：父任务的 DDL / 状态 / 预计用时一个字节都不变', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks, {
      title: '要交的实验报告',
      deadline: '2026-10-20T22:00',
      estimatedMinutes: '180',
      status: 'DOING',
      priority: 4,
    })
    const snapshot = () => opened.raw.prepare('SELECT * FROM tasks WHERE id = ?;').get(taskId)
    const before = snapshot()

    assert.equal(
      (
        await opened.steps.saveSteps({
          taskId,
          steps: [step('a', '写提纲', true), step('b', '写正文', true)],
          expectedRevision: 0,
        })
      ).committed,
      true,
    )
    assert.deepEqual(snapshot(), before, '步骤全部勾完也不许动父任务一个字段')
    assert.equal(snapshot().status, 'DOING', '父任务不会被自动标成完成')
    assert.equal(snapshot().deadline, before.deadline)
    assert.equal(snapshot().estimated_minutes, before.estimated_minutes)
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('读取绝不写库：没保存过时读一次，库里仍然一条记录都没有', async () => {
  const ctx = await createTestDatabase()
  try {
    const taskId = await createTask(ctx.tasks)
    const stepsRepo = new TaskStepsRepository(ctx.db, ctx.tasks, () => NOW)
    assert.deepEqual(await stepsRepo.loadSteps(taskId), { ok: true, steps: [], revision: 0 })
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '读不会创建任何记录')
  } finally {
    ctx.close()
  }
})

test('空清单是合法的显式清除：保存空数组 = 删除那一条记录，读回 0 步', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    assert.equal((await opened.steps.saveSteps({ taskId, steps: [step('a', 'A')], expectedRevision: 0 })).revision, 1)

    const cleared = await opened.steps.saveSteps({ taskId, steps: [], expectedRevision: 1 })
    assert.equal(cleared.committed, true)
    assert.equal(cleared.revision, 2)
    const loaded = await opened.steps.loadSteps(taskId)
    assert.deepEqual(loaded, { ok: true, steps: [], revision: 2 })

    // 空数组 ≠ 没有记录：版本号还在，因此仍然可以继续往后写。
    const rows = opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    assert.equal(rows, 1, '记录还在（存的是「空清单 + 版本号」，不是删掉记录）')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('非法输入在仓库层就被拒绝（零写入）：步骤不合法 / 超过上限 / 重复编号', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const countRows = () => opened.raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    assert.equal(countRows(), 0)

    const blank = await opened.steps.saveSteps({ taskId, steps: [step('a', '   ')], expectedRevision: 0 })
    assert.equal(blank.committed, false)
    assert.match(blank.reason, /1–120/)

    const tooMany = await opened.steps.saveSteps({
      taskId,
      steps: Array.from({ length: 31 }, (_, index) => step(`s${index}`, `第 ${index} 步`)),
      expectedRevision: 0,
    })
    assert.equal(tooMany.committed, false)
    assert.match(tooMany.reason, /最多只能有 30 步/)

    const duplicate = await opened.steps.saveSteps({
      taskId,
      steps: [step('same', 'A'), step('same', 'B')],
      expectedRevision: 0,
    })
    assert.equal(duplicate.committed, false)
    assert.match(duplicate.reason, /重复/)
    assert.equal(countRows(), 0, '被拒的输入一个字节都没写')
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})

test('缺失 / null 的 steps 不能把已保存清单清空（显式空数组才是清空）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const opened = openFileDatabase(file)
    const taskId = await createTask(opened.tasks)
    const saved = await opened.steps.saveSteps({ taskId, steps: [step('a', '已保存的一步')], expectedRevision: 0 })
    assert.equal(saved.committed, true)
    assert.equal(saved.revision, 1)

    // 畸形调用：根本没有 steps 字段。绝不能把它当成「用户要清空」。
    const missing = await opened.steps.saveSteps({ taskId, expectedRevision: 1 })
    assert.equal(missing.committed, false)
    assert.match(missing.reason, /格式/)
    assert.deepEqual((await opened.steps.loadSteps(taskId)).steps, [step('a', '已保存的一步')], '清单原样保留')

    // 畸形调用：steps: null，同样拒绝且不改动。
    const nullSteps = await opened.steps.saveSteps({ taskId, steps: null, expectedRevision: 1 })
    assert.equal(nullSteps.committed, false)
    const after = await opened.steps.loadSteps(taskId)
    assert.equal(after.revision, 1, '版本号也没动')
    assert.deepEqual(after.steps, [step('a', '已保存的一步')])

    // 对比：显式的空数组是合法的「清空」，照常写入新版本。
    const cleared = await opened.steps.saveSteps({ taskId, steps: [], expectedRevision: 1 })
    assert.equal(cleared.committed, true)
    assert.equal(cleared.revision, 2)
    assert.deepEqual((await opened.steps.loadSteps(taskId)).steps, [])
    opened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-tasksteps-')
  }
})
