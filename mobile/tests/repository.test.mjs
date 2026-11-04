// SQLite 初始化与迁移测试 + **事务回归测试**。
//
// 这里的重头戏是「原始文本写入失败时任务不能落库」：
// Codex 用独立载荷复现过旧实现的缺陷（任务先提交、原文后写，失败留下孤儿任务）。
// 现在 create/update 都在一个事务里，下面的测试就是防回归的闸门。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { readSchemaSql, wrapDatabase, createTestDatabase, taskDraft, courseDraft } from './helpers/sqliteHarness.mjs'

/**
 * 捕获一次拒绝并返回错误对象。
 *
 * `ValidationError` 的最外层 message 是统一的「……还有问题需要修改。」，
 * 真正的原因在 `error.fields` 里（字段 → 中文说明），所以断言要看字段级信息，
 * 才能证明**具体是哪一条校验被触发**，而不是只证明「抛错了」。
 */
async function captureRejection(action) {
  try {
    await action()
  } catch (cause) {
    return cause
  }
  throw new Error('预期这次调用会失败，但它成功了。')
}

/**
 * 从写入结果里取回任务。
 *
 * `create` / `update` 返回 `SaveOutcome`：`committed` 表示事务是否已提交，
 * `task` 是提交后读回的结果。测试统一走这里，顺便强制断言
 * 「提交了就必须能读回」，避免把读回失败悄悄当成通过。
 */
function savedTask(outcome, label = '写入') {
  assert.equal(outcome.committed, true, `${label}后必须已提交`)
  assert.equal(outcome.readbackError, null, `${label}后读回不应出错`)
  assert.ok(outcome.task, `${label}后应该能读回任务`)
  return outcome.task
}

test('initializeDatabase 在空库上建表并把 user_version 提到当前版本', async () => {
  const { initializeDatabase, SCHEMA_VERSION } = await import('../src/db/migrations.ts')
  const raw = new DatabaseSync(':memory:')
  const db = wrapDatabase(raw)

  const result = await initializeDatabase(db)
  assert.equal(result.fromVersion, 0)
  assert.equal(result.toVersion, SCHEMA_VERSION)
  assert.deepEqual(result.applied, [1, 2, 3], 'v1 建表 + v2 建 app_settings + v3 截图库与选课序号')
  assert.equal(result.alreadyCurrent, false)

  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const expected of [
    'app_settings',
    'courses',
    'schedules',
    'task_sources',
    'tasks',
    'screenshot_attempts',
    'source_screenshots',
    'screenshot_refs',
    'ocr_results',
    'ocr_candidate_rows',
  ]) {
    assert.ok(tables.includes(expected), `缺少表 ${expected}`)
  }
  // v3 的选课序号列必须存在（与 App 的 AUTO- 内部编号分开存）。
  const courseColumns = raw.prepare('PRAGMA table_info(courses);').all().map((row) => row.name)
  assert.ok(courseColumns.includes('selection_serial'), 'courses 需要 selection_serial 列')
  raw.close()
})

test('initializeDatabase 可重复调用（幂等），不会重复执行迁移', async () => {
  const { initializeDatabase } = await import('../src/db/migrations.ts')
  const raw = new DatabaseSync(':memory:')
  const db = wrapDatabase(raw)

  await initializeDatabase(db)
  const second = await initializeDatabase(db)
  assert.equal(second.alreadyCurrent, true)
  assert.deepEqual(second.applied, [])

  // 数据不会被第二次初始化清掉
  raw.prepare("INSERT INTO courses (code, name, created_at, updated_at) VALUES ('A','B','x','x')").run()
  await initializeDatabase(db)
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM courses').get().c, 1)
  raw.close()
})

test('initializeDatabase 在库版本高于应用时拒绝打开，避免写坏新结构', async () => {
  const { initializeDatabase, SchemaVersionError, SCHEMA_VERSION } = await import('../src/db/migrations.ts')
  const raw = new DatabaseSync(':memory:')
  raw.exec(readSchemaSql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5};`)
  const db = wrapDatabase(raw)

  await assert.rejects(() => initializeDatabase(db), SchemaVersionError)
  raw.close()
})

/* ------------------------ 任务仓库：基本 CRUD ------------------------ */

test('任务创建后可读回，字段与草稿一致，且自动写入 created_at/updated_at', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(
      await ctx.tasks.create(
        taskDraft({
          title: '第 3 次作业',
          deadline: '2026-10-15T22:00',
          priority: 5,
          type: 'HOMEWORK',
        }),
      ),
      '新建',
    )
    assert.ok(created.id > 0)
    assert.equal(created.title, '第 3 次作业')
    assert.equal(created.deadline, '2026-10-15T22:00:00+08:00', '入库统一带 +08:00 偏移')
    assert.equal(created.priority, 5)
    assert.equal(created.createdAt, created.updatedAt)
    assert.equal(created.completedAt, null)

    const reloaded = await ctx.tasks.getById(created.id)
    assert.deepEqual(reloaded, created)
  } finally {
    ctx.close()
  }
})

test('数据在新的仓库实例里依然存在（模拟应用重启后重新打开数据库）', async () => {
  const ctx = await createTestDatabase()
  try {
    savedTask(await ctx.tasks.create(taskDraft({ title: '重启后应该还在' })))
    const { TaskRepository } = await import('../src/domain/taskRepository.ts')
    const freshRepo = new TaskRepository(ctx.db)
    const all = await freshRepo.listAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].title, '重启后应该还在')
  } finally {
    ctx.close()
  }
})

test('未设置截止时间就是 null，不会自动补一个时间', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ deadline: '' })))
    assert.equal(created.deadline, null)
  } finally {
    ctx.close()
  }
})

test('只填日期可保存；重新打开时日期保留、时间保持空白', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ deadline: '2026-10-15' })))
    assert.equal(created.deadline, '2026-10-15', '只到日期就存裸日期，不能补成 00:00 / 23:59')
    assert.equal(await ctx.tasks.countAll(), 1)

    const reloaded = await ctx.tasks.getById(created.id)
    assert.equal(reloaded?.deadline, '2026-10-15')

    const { taskToDraft } = await import('../src/domain/taskDraft.ts')
    const draft = taskToDraft(reloaded)
    assert.equal(draft.deadline, '2026-10-15', '编辑页重新打开时仍是裸日期')
    assert.equal(draft.deadline.includes('T'), false, '时间框不能出现被猜出来的时刻')
  } finally {
    ctx.close()
  }
})

test('已有精确时刻可改成只到日期，也可再补回精确时刻', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ deadline: '2026-10-15T22:00' })))
    assert.equal(created.deadline, '2026-10-15T22:00:00+08:00')

    const dateOnly = savedTask(await ctx.tasks.update(created.id, taskDraft({ deadline: '2026-10-15' })))
    assert.equal(dateOnly.deadline, '2026-10-15')

    const preciseAgain = savedTask(
      await ctx.tasks.update(created.id, taskDraft({ deadline: '2026-10-15T09:00' })),
    )
    assert.equal(preciseAgain.deadline, '2026-10-15T09:00:00+08:00')
  } finally {
    ctx.close()
  }
})

test('非法日期在进入数据库之前就被拒绝', async () => {
  const ctx = await createTestDatabase()
  try {
    for (const bad of ['2026-02-30T10:00', '2027-02-29T10:00', '2026-10-15T25:00', '2026-13-01T10:00']) {
      const error = await captureRejection(() => ctx.tasks.create(taskDraft({ deadline: bad })))
      assert.equal(error.name, 'ValidationError')
      assert.match(error.fields.deadline, /真实存在/, `${bad} 应被日期校验拒绝`)
    }
    assert.equal(await ctx.tasks.countAll(), 0, '拒绝之后库里不能留下任何任务')
  } finally {
    ctx.close()
  }
})

test('标题为空被拒绝；超长标题被拒绝', async () => {
  const ctx = await createTestDatabase()
  try {
    const empty = await captureRejection(() => ctx.tasks.create(taskDraft({ title: '   ' })))
    assert.match(empty.fields.title, /请填写任务标题/)

    const tooLong = await captureRejection(() => ctx.tasks.create(taskDraft({ title: 'x'.repeat(201) })))
    assert.match(tooLong.fields.title, /标题最长 200 字/)

    assert.equal(await ctx.tasks.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('参数化语句：恶意标题只会被当作普通文本存下来', async () => {
  const ctx = await createTestDatabase()
  try {
    const evil = "'); DROP TABLE tasks; --"
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: evil })))
    assert.equal(created.title, evil)
    const tables = ctx.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
    assert.ok(tables.includes('tasks'), 'tasks 表必须还在')
    assert.equal(await ctx.tasks.countAll(), 1)
  } finally {
    ctx.close()
  }
})

/**
 * 复核确认过的缺陷：原文保存曾经依赖 `originalText !== description` 这个**巧合判断**。
 * 当用户把说明原样粘贴成原文时，两者相等 → 原文被静默丢弃。
 * 现在「要不要存原文」只看原文本身与是否已有留存，与 description 无关。
 */
test('回归：说明与原文内容相同时，原文也必须被保存（不再静默丢弃）', async () => {
  const ctx = await createTestDatabase()
  try {
    const sameText = '请于 10 月 15 日 22:00 前提交第 3 次作业'
    const created = savedTask(
      await ctx.tasks.create(
        taskDraft({
          title: '内容相同的任务',
          description: sameText,
          originalText: sameText,
        }),
      ),
    )

    const source = await ctx.tasks.getOriginalSource(created.id)
    assert.ok(source, '原文必须已保存，不能因为与说明相同就被丢弃')
    assert.equal(source.rawText, sameText)

    const map = await ctx.tasks.listAllOriginalSources()
    assert.equal(map.get(created.id), sameText, '列表页读回的原文也必须存在')
  } finally {
    ctx.close()
  }
})

/* ------------------ 事务回归：这是 Codex 复现过的缺陷 ------------------ */

test('回归：原始文本写入失败时，任务**不能**留在库里（create 必须原子）', async () => {
  const ctx = await createTestDatabase()
  try {
    // 制造「第二步必失败」的环境：把 task_sources 表删掉，模拟原文写入报错。
    ctx.raw.exec('DROP TABLE task_sources;')

    await assert.rejects(
      () => ctx.tasks.create(taskDraft({ title: '带原文的任务', originalText: '通知原文……' })),
      /task_sources/,
      '原文写入失败必须向上抛出',
    )

    assert.equal(await ctx.tasks.countAll(), 0, '回滚后不能留下没有原文的孤儿任务')
  } finally {
    ctx.close()
  }
})

test('回归：不带原文时正常创建（事务不影响原有路径）', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '没有原文' })))
    assert.ok(created.id > 0)
    assert.equal(await ctx.tasks.countAll(), 1)
  } finally {
    ctx.close()
  }
})

test('回归：update 中补写原文失败时，标题修改也要一起回滚', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '原标题' })))
    ctx.raw.exec('DROP TABLE task_sources;')

    await assert.rejects(() =>
      ctx.tasks.update(created.id, taskDraft({ title: '新标题', originalText: '后来补的原文' })),
    )

    const after = await ctx.tasks.getById(created.id)
    assert.equal(after.title, '原标题', '原文写失败时标题修改也必须回滚')
  } finally {
    ctx.close()
  }
})

test('成功路径：任务与原始文本在同一个事务里一起写入', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(
      await ctx.tasks.create(
        taskDraft({ title: '带原文的任务', originalText: '各位同学，第 3 次作业 10 月 15 日 22:00 前提交。' }),
      ),
    )
    const source = await ctx.tasks.getOriginalSource(created.id)
    assert.ok(source, '原文必须已写入')
    assert.equal(source.rawText, '各位同学，第 3 次作业 10 月 15 日 22:00 前提交。')

    const map = await ctx.tasks.listAllOriginalSources()
    assert.equal(map.get(created.id), source.rawText)
  } finally {
    ctx.close()
  }
})

test('首次编辑可以补上原文（之前没留档时原文会保存）', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务' })))
    assert.equal(await ctx.tasks.getOriginalSource(created.id), null, '一开始没有原文')

    savedTask(await ctx.tasks.update(created.id, taskDraft({ title: '任务', originalText: '后来补的原文' })), '更新')

    const source = await ctx.tasks.getOriginalSource(created.id)
    assert.ok(source, '首次补写的原文必须保存')
    assert.equal(source.rawText, '后来补的原文')
  } finally {
    ctx.close()
  }
})

test('原始文本只增不改：已有原文时提交不同文本会报错，绝不静默丢弃输入', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务', originalText: '第一版原文' })))

    const error = await captureRejection(() =>
      ctx.tasks.update(created.id, taskDraft({ title: '任务改名', originalText: '试图覆盖的原文' })),
    )
    assert.equal(error.name, 'ValidationError')
    assert.match(error.fields.originalText, /不能覆盖/)
    assert.match(error.fields.originalText, /追加原文/, '要告诉用户正确的补充方式')

    const source = await ctx.tasks.getOriginalSource(created.id)
    assert.equal(source.rawText, '第一版原文', '已留存的原文不能被覆盖')
  } finally {
    ctx.close()
  }
})

test('原文与已有留存一致时，编辑其它字段可以正常保存', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务', originalText: '原文' })))
    const updated = savedTask(
      await ctx.tasks.update(created.id, taskDraft({ title: '改名后', originalText: '原文' })),
      '更新',
    )
    assert.equal(updated.title, '改名后')
    const source = await ctx.tasks.getOriginalSource(created.id)
    assert.equal(source.rawText, '原文')
  } finally {
    ctx.close()
  }
})

test('追加原文：新增一条记录，旧原文保持不变', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务', originalText: '第一版原文' })))
    await ctx.tasks.appendOriginalText(created.id, '后来又收到一条补充通知')

    const sources = await ctx.tasks.listSources(created.id)
    assert.equal(sources.length, 2, '追加应产生第二条来源记录')
    assert.equal(sources[0].rawText, '第一版原文', '旧原文保持原样')
    assert.equal(sources[1].rawText, '后来又收到一条补充通知')
    assert.equal(sources[1].kind, 'MANUAL')

    // 详情页读回的首条原文仍是第一版（只增不改）
    const map = await ctx.tasks.listAllOriginalSources()
    assert.equal(map.get(created.id), '第一版原文')
  } finally {
    ctx.close()
  }
})

test('追加空文本会被拒绝', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务' })))
    const error = await captureRejection(() => ctx.tasks.appendOriginalText(created.id, '   '))
    assert.equal(error.name, 'ValidationError')
    assert.equal((await ctx.tasks.listSources(created.id)).length, 0)
  } finally {
    ctx.close()
  }
})

/* ------------------------ 状态、删除、查询 ------------------------ */

test('标记完成会写入 completed_at，改回未完成会清空', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务' })))
    const done = await ctx.tasks.changeStatus(created.id, 'DONE')
    assert.equal(done.status, 'DONE')
    assert.ok(done.completedAt, '完成时必须记录 completed_at')

    const reopened = await ctx.tasks.changeStatus(created.id, 'TODO')
    assert.equal(reopened.status, 'TODO')
    assert.equal(reopened.completedAt, null, '回到未完成必须清空 completed_at')
  } finally {
    ctx.close()
  }
})

test('toggleComplete 在已完成与待办之间来回切换', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务', status: 'DOING' })))
    const first = await ctx.tasks.toggleComplete(created.id)
    assert.equal(first.status, 'DONE', '进行中 → 完成')
    const second = await ctx.tasks.toggleComplete(created.id)
    assert.equal(second.status, 'TODO', '完成 → 待办')
  } finally {
    ctx.close()
  }
})

test('删除任务会级联删除它的原始文本', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = savedTask(await ctx.tasks.create(taskDraft({ title: '任务', originalText: '原文' })))
    await ctx.tasks.remove(created.id)
    assert.equal(await ctx.tasks.countAll(), 0)
    assert.equal(await ctx.tasks.getOriginalSource(created.id), null)
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS c FROM task_sources').get().c, 0, '来源表也要清空')
  } finally {
    ctx.close()
  }
})

test('删除不存在的任务会报错，而不是静默成功', async () => {
  const ctx = await createTestDatabase()
  try {
    await assert.rejects(() => ctx.tasks.remove(999), /不存在/)
  } finally {
    ctx.close()
  }
})

test('listByShanghaiDate 按北京时间自然日筛选并按时间排序', async () => {
  const ctx = await createTestDatabase()
  try {
    await ctx.tasks.create(taskDraft({ title: 'A', deadline: '2026-10-15T22:00' }))
    await ctx.tasks.create(taskDraft({ title: 'B', deadline: '2026-10-15T09:00' }))
    await ctx.tasks.create(taskDraft({ title: 'C', deadline: '2026-10-16T09:00' }))
    await ctx.tasks.create(taskDraft({ title: 'D', deadline: '' }))
    await ctx.tasks.create(taskDraft({ title: 'E', deadline: '2026-10-15' }))

    const ofDay = await ctx.tasks.listByShanghaiDate('2026-10-15')
    assert.deepEqual(
      ofDay.map((task) => task.title),
      ['B', 'A', 'E'],
      '只到日期的任务归到当天，按当天结束参与排序',
    )
  } finally {
    ctx.close()
  }
})

test('list 的筛选与排序参数生效', async () => {
  const ctx = await createTestDatabase()
  try {
    await ctx.tasks.create(taskDraft({ title: '写作业', deadline: '2026-10-20T10:00' }))
    await ctx.tasks.create(taskDraft({ title: '复习', status: 'DONE' }))
    await ctx.tasks.create(taskDraft({ title: '没有时间' }))

    const open = await ctx.tasks.list({ status: 'OPEN' })
    assert.deepEqual(open.map((task) => task.title).sort(), ['写作业', '没有时间'])

    const done = await ctx.tasks.list({ status: 'DONE' })
    assert.deepEqual(done.map((task) => task.title), ['复习'])

    const keyword = await ctx.tasks.list({ status: 'ALL', keyword: '复习' })
    assert.deepEqual(keyword.map((task) => task.title), ['复习'])

    const byDeadline = await ctx.tasks.list({ status: 'ALL', orderBy: 'deadline' })
    assert.equal(byDeadline[byDeadline.length - 1].title, '没有时间', '没有 DDL 的排在最后')

    await ctx.tasks.create(taskDraft({ title: '只到日期', deadline: '2026-10-20' }))
    await ctx.tasks.create(taskDraft({ title: '当天更早', deadline: '2026-10-20T09:00' }))
    const sameDay = await ctx.tasks.list({ status: 'ALL', orderBy: 'deadline' })
    assert.deepEqual(
      sameDay.map((task) => task.title),
      ['当天更早', '写作业', '只到日期', '复习', '没有时间'],
      '同一天的精确时刻排在只到日期之前；只到日期按当天结束排序',
    )
  } finally {
    ctx.close()
  }
})

test('deadline 排序：同一天 23:59:59.999 的精确时刻排在只到日期之前', async () => {
  const ctx = await createTestDatabase()
  try {
    const dayOnly = savedTask(await ctx.tasks.create(taskDraft({ deadline: '2026-10-22' })))
    const precise = savedTask(await ctx.tasks.create(taskDraft({ deadline: '2026-10-22T23:59' })))
    // 模拟旧数据里的亚秒精度（表单只到分钟，但存储/导入可能已有 .999）。
    ctx.raw
      .prepare('UPDATE tasks SET deadline = ? WHERE id = ?')
      .run('2026-10-22T23:59:59.999+08:00', precise.id)

    const listed = await ctx.tasks.list({ orderBy: 'deadline' })
    assert.deepEqual(
      listed.map((task) => task.id),
      [precise.id, dayOnly.id],
      '只到日期表示当天结束，必须排在当天最晚的精确时刻之后',
    )
  } finally {
    ctx.close()
  }
})

/* --------------------- 课程外键与删除保护 --------------------- */

test('任务的 course_id 指向不存在的课程时被外键拒绝', async () => {
  const ctx = await createTestDatabase()
  try {
    await assert.rejects(() => ctx.tasks.create(taskDraft({ title: '坏关联', courseId: 999 })))
    assert.equal(await ctx.tasks.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('课程删除保护：未被引用时可直接删除', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const refs = await ctx.courses.describeReferences(course.id)
    assert.equal(refs.blocked, false)
    const result = await ctx.courses.removeCourse(course.id)
    assert.equal(result.detachedTasks, 0)
    assert.equal(await ctx.courses.countAll(), 0)
  } finally {
    ctx.close()
  }
})

test('课程删除保护：仍被任务引用时默认拒绝删除，且数据完全不变', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.tasks.create(taskDraft({ title: '关联任务', courseId: course.id }))

    await assert.rejects(() => ctx.courses.removeCourse(course.id), /仍被 1 个任务/)
    assert.equal(await ctx.courses.countAll(), 1, '拒绝后课程必须还在')
    assert.equal(await ctx.tasks.countAll(), 1, '拒绝后任务必须还在')
  } finally {
    ctx.close()
  }
})

test('课程删除保护：确认后课表删除、任务保留并解除关联（ON DELETE SET NULL）', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.tasks.create(taskDraft({ title: '关联任务', courseId: course.id }))
    await ctx.courses.createSchedule(course.id, {
      weekday: 4,
      startTime: '08:00',
      endTime: '09:40',
      location: '教三 305',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '2026-09-07',
      startWeek: '1',
      endWeek: '16',
      weekPattern: 'ALL',
    })

    const refs = await ctx.courses.describeReferences(course.id)
    assert.equal(refs.taskCount, 1)
    assert.equal(refs.scheduleCount, 1)
    assert.equal(refs.blocked, true)

    const result = await ctx.courses.removeCourse(course.id, { confirmed: true })
    assert.equal(result.detachedTasks, 1)
    assert.equal(result.removedSchedules, 1)

    assert.equal(await ctx.courses.countAll(), 0, '课程已删除')
    assert.equal(await ctx.courses.countSchedules(), 0, '课表随课程删除')
    assert.equal(await ctx.tasks.countAll(), 1, '任务绝不能被静默删除')
    const survivor = (await ctx.tasks.listAll())[0]
    assert.equal(survivor.courseId, null, '任务保留但解除关联')
  } finally {
    ctx.close()
  }
})

test('课表校验：学期首周一必须是周一，起止周必须成对', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const base = {
      weekday: 4,
      startTime: '08:00',
      endTime: '09:40',
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '2026-09-08',
      startWeek: '1',
      endWeek: '16',
      weekPattern: 'ALL',
    }

    const notMonday = await captureRejection(() => ctx.courses.createSchedule(course.id, base))
    assert.match(notMonday.fields.semesterStartDate, /必须是周一/)

    const missingEnd = await captureRejection(() =>
      ctx.courses.createSchedule(course.id, { ...base, semesterStartDate: '2026-09-07', endWeek: '' }),
    )
    assert.match(missingEnd.fields.endWeek, /同时填写/)

    assert.equal(await ctx.courses.countSchedules(), 0, '校验失败不能写入任何课表')
  } finally {
    ctx.close()
  }
})

test('课表校验：结束时间必须晚于开始时间', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const error = await captureRejection(() =>
      ctx.courses.createSchedule(course.id, {
        weekday: 4,
        startTime: '10:00',
        endTime: '09:00',
        location: '',
        periodStart: '',
        periodEnd: '',
        semesterStartDate: '',
        startWeek: '',
        endWeek: '',
        weekPattern: 'ALL',
      }),
    )
    assert.match(error.fields.endTime, /结束时间必须晚于开始时间/)
    assert.equal(await ctx.courses.countSchedules(), 0)
  } finally {
    ctx.close()
  }
})

test('课表可以不留教学周信息（旧数据兼容），此时按每周处理', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const schedule = await ctx.courses.createSchedule(course.id, {
      weekday: 4,
      startTime: '08:00',
      endTime: '09:40',
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '',
      startWeek: '',
      endWeek: '',
      weekPattern: 'ALL',
    })
    assert.equal(schedule.semesterStartDate, null)
    assert.equal(schedule.startWeek, null)
    assert.equal(schedule.weekRange, null)
    assert.equal(schedule.weekPattern, 'ALL')

    // 与教学周工具一致：没有 term 信息 → 每周都上
    const { occursOn } = await import('../src/domain/scheduleRules.ts')
    assert.equal(occursOn(schedule, '2026-10-15'), true)
  } finally {
    ctx.close()
  }
})

test('课表周次规律入库为 ODD/EVEN 并可被教学周工具正确读取', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const schedule = await ctx.courses.createSchedule(course.id, {
      weekday: 1,
      startTime: '08:00',
      endTime: '09:40',
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '2026-09-07',
      startWeek: '1',
      endWeek: '4',
      weekPattern: 'ODD',
    })
    assert.equal(schedule.weekPattern, 'ODD')
    assert.equal(schedule.weekRange, '1-4')

    const { occursOn } = await import('../src/domain/scheduleRules.ts')
    assert.equal(occursOn(schedule, '2026-09-07'), true, '第 1 周（奇数周）上课')
    assert.equal(occursOn(schedule, '2026-09-14'), false, '第 2 周（偶数周）不上课')
    assert.equal(occursOn(schedule, '2026-09-28'), false, '第 4 周超出单周规则')
  } finally {
    ctx.close()
  }
})

test('删除课表不影响课程与任务', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    await ctx.tasks.create(taskDraft({ title: '任务', courseId: course.id }))
    const schedule = await ctx.courses.createSchedule(course.id, {
      weekday: 4,
      startTime: '08:00',
      endTime: '09:40',
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '',
      startWeek: '',
      endWeek: '',
      weekPattern: 'ALL',
    })
    await ctx.courses.removeSchedule(schedule.id)
    assert.equal(await ctx.courses.countSchedules(), 0)
    assert.equal(await ctx.courses.countAll(), 1, '课程不能受影响')
    assert.equal(await ctx.tasks.countAll(), 1, '任务不能受影响')
  } finally {
    ctx.close()
  }
})

test('课程更新保留 id 与创建时间', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft())
    const updated = await ctx.courses.update(course.id, courseDraft({ name: '数据结构与算法', code: 'CS202' }))
    assert.equal(updated.id, course.id)
    assert.equal(updated.name, '数据结构与算法')
    assert.equal(updated.createdAt, course.createdAt)
    assert.equal(updated.updatedAt, course.updatedAt, '固定时钟下两次写入时间相同')
  } finally {
    ctx.close()
  }
})

test('课程校验：只有名称必填；课程代码是内部字段，不填也能建课', async () => {
  const ctx = await createTestDatabase()
  try {
    const noName = await captureRejection(() => ctx.courses.create(courseDraft({ name: '  ' })))
    assert.match(noName.fields.name, /请填写课程名称/)

    // 代码不再必填：留空 = 由仓库层分配一个唯一的内部编号（界面早已不再让用户填）。
    const created = await ctx.courses.create(courseDraft({ code: '', name: '不给代码的课' }))
    assert.match(created.code, /^AUTO-\d+$/, '新建课程必须拿到一个内部编号，而不是空代码')
    assert.equal(await ctx.courses.countAll(), 1)

    // 名称仍然必填：上面那次失败没有写进任何一行。
    const stillOne = await captureRejection(() => ctx.courses.create(courseDraft({ code: '', name: '   ' })))
    assert.match(stillOne.fields.name, /请填写课程名称/)
    assert.equal(await ctx.courses.countAll(), 1, '校验失败不能留下半条课程')
  } finally {
    ctx.close()
  }
})

test('两门新手工课程各自拿到唯一稳定的内部代码（不需要用户在界面上输入）', async () => {
  const ctx = await createTestDatabase()
  try {
    // 界面上已经没有「课程代码」输入框：新建时草稿里这一项是空的。
    const first = await ctx.courses.create(courseDraft({ code: '', name: '甲课' }))
    const second = await ctx.courses.create(courseDraft({ code: '', name: '乙课' }))
    assert.notEqual(first.code, second.code, '两门新课程不能共用同一个内部编号')
    for (const course of [first, second]) {
      assert.match(course.code, /^AUTO-\d+$/, `${course.name} 的内部编号形状不对`)
    }
    assert.equal(first.id === second.id, false, 'id 必须各自独立')

    // 稳定：再读回来还是同一个代码（不是每次读都重算）。
    const reread = await ctx.courses.getById(first.id)
    assert.equal(reread.code, first.code)

    // 分配要避开已被占用的号：手工占用 AUTO-01 / AUTO-02 之后，下一门课接着往下排。
    const third = await ctx.courses.create(courseDraft({ code: '', name: '丙课' }))
    assert.equal(new Set([first.code, second.code, third.code]).size, 3)
  } finally {
    ctx.close()
  }
})

test('编辑课程保留内部代码与选课序号：草稿里代码为空 = 不改代码', async () => {
  const ctx = await createTestDatabase()
  try {
    const created = await ctx.courses.create(
      courseDraft({ code: '', name: '数据结构', selectionSerial: '9913010460.01' }),
    )
    const originalCode = created.code
    assert.match(originalCode, /^AUTO-\d+$/)

    // 表单草稿：代码字段已经是空的（界面不显示它），只改用户可见的信息。
    const updated = await ctx.courses.update(created.id, {
      code: '',
      name: '数据结构（改过名字）',
      instructor: '李老师',
      semester: '2026 秋',
      color: '#285b47',
      note: '换了老师',
    })
    assert.equal(updated.code, originalCode, '空代码不能把已有内部代码冲掉 / 换一个新号')
    assert.equal(updated.id, created.id)
    assert.equal(updated.selectionSerial, '9913010460.01', '没提到选课序号 = 保留原值')
    assert.equal(updated.name, '数据结构（改过名字）')
    assert.equal(updated.instructor, '李老师')

    // 老库里已有的真实教务代码同样原样保留（不做任何迁移 / 改写）。
    const legacy = await ctx.courses.create(courseDraft({ code: 'CS201', name: '老数据课程' }))
    const legacyKept = await ctx.courses.update(legacy.id, { ...courseDraft({ code: '', name: '老数据课程' }), note: '改备注' })
    assert.equal(legacyKept.code, 'CS201', '老代码保留用于匹配，绝不改写')
  } finally {
    ctx.close()
  }
})
