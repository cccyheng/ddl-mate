/**
 * 今日学习计划 —— **真实 SQLite 持久化**测试。
 *
 * 授权书点名要验证的：保存 / 读取 / **重开数据库**、坏 JSON 与不认识的版本
 * 返回可读原因而不是崩、提交时重新校验（任务被删 / 课表改了 / now 变了都拒绝）、
 * 乐观版本冲突、写入失败时**零改动**、提交后读回失败如实报告、
 * 以及「不碰 tasks / courses / schedules 等既有表」。
 *
 * 边界说明（不夸大）：这里是 Node 侧 `node:sqlite`，验证 SQL 与仓库逻辑，
 * 验证不了 iPhone 上的 expo-sqlite 原生绑定。所有库都是系统临时目录里的临时文件，
 * 绝不碰用户真实数据。
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
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { SCHEMA_VERSION } from '../src/db/schema.ts'

const TZ = '2026-10-15'
const NOW = new Date('2026-10-15T02:00:30.000Z') // 上海 10:00:30
const PLAN_KEY = 'daily_plan.today'

/* --------------------------------- 夹具 --------------------------------- */

function task(overrides = {}) {
  const id = overrides.id ?? 1
  return {
    id,
    title: overrides.title ?? `任务 ${id}`,
    description: null,
    courseId: overrides.courseId ?? null,
    type: 'HOMEWORK',
    status: overrides.status ?? 'TODO',
    priority: overrides.priority ?? 3,
    deadline: overrides.deadline ?? null,
    estimatedMinutes: overrides.estimatedMinutes ?? null,
    submitRequirement: null,
    submitMethod: null,
    completedAt: null,
    createdAt: '2026-10-01T00:00:00+08:00',
    updatedAt: '2026-10-01T00:00:00+08:00',
    ...overrides,
  }
}

function course(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    code: 'AUTO-01',
    name: overrides.name ?? '数据结构',
    instructor: null,
    semester: null,
    color: null,
    note: null,
    selectionSerial: null,
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
    ...overrides,
  }
}

function schedule(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    courseId: overrides.courseId ?? 1,
    weekday: 4,
    startTime: overrides.startTime ?? '10:30',
    endTime: overrides.endTime ?? '11:00',
    location: null,
    periodStart: null,
    periodEnd: null,
    weekRange: null,
    semesterStartDate: '2026-09-07',
    startWeek: 1,
    endWeek: 16,
    weekPattern: 'ALL',
    createdAt: '2026-09-01T00:00:00+08:00',
    updatedAt: '2026-09-01T00:00:00+08:00',
    ...overrides,
  }
}

function tempDbPath(prefix = 'ddl-todayplan-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, file: join(dir, 'plan.db') }
}

async function openFileDatabase(file) {
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  applyAdditiveColumns(raw)
  return { raw, db: wrapDatabase(raw) }
}

async function openRepository(db, context, now) {
  const { TodayPlanRepository } = await import('../src/domain/todayPlanRepository.ts')
  return new TodayPlanRepository(db, async () => context.value, now)
}

/** 生成一次「预览」：得到指纹 + 计划（与界面里的动作同一套调用）。 */
async function preview({ context, windows, selections, now = NOW, date = TZ }) {
  const { buildTodayPlan, todayPlanFingerprint, validateStudyWindows } = await import('../src/domain/todayPlan.ts')
  const validation = validateStudyWindows(windows)
  assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join(' / '))
  const fingerprint = todayPlanFingerprint({
    date,
    windows: validation.windows,
    selections,
    context: context.value,
  })
  const plan = buildTodayPlan({
    date,
    now,
    windows,
    selections,
    tasks: context.value.tasks,
    schedules: context.value.schedules,
    courses: context.value.courses,
  })
  return { fingerprint, plan }
}

function contextHolder(value = { tasks: [], schedules: [], courses: [] }) {
  return { value }
}

/* --------------------------------- 用例 --------------------------------- */

test('保存 → 读取 → 重开数据库：今天的计划还在，且只写 app_settings 里的一个键', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({
    tasks: [task({ id: 1, deadline: '2026-10-15T11:00:00+08:00' })],
    schedules: [],
    courses: [],
  })
  try {
    const { raw, db } = await openFileDatabase(file)
    const repo = await openRepository(db, context, () => NOW)

    const before = await repo.loadTodayPlan(TZ)
    assert.deepEqual(before, { ok: true, plan: null, revision: 0, storedOtherDate: false }, '没保存过 = 正常空状态')

    const previewed = await preview({
      context,
      windows: [{ start: '10:00', end: '11:00' }],
      selections: [{ taskId: 1, minutes: 45 }],
    })
    const saved = await repo.saveTodayPlan({
      date: TZ,
      windows: [{ start: '10:00', end: '11:00' }],
      selections: [{ taskId: 1, minutes: 45 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.committed, true)
    assert.equal(saved.revision, 1)
    assert.equal(saved.readbackError, null)

    const rows = raw.prepare('SELECT key, value FROM app_settings;').all()
    assert.equal(rows.length, 1, '只应该有这一个键')
    assert.equal(rows[0].key, PLAN_KEY)
    assert.ok(String(rows[0].value).length < 8_000, '载荷是有界的（不存整个 App 的数据）')

    const stored = JSON.parse(String(rows[0].value))
    assert.equal(stored.version, 1)
    assert.equal(stored.date, TZ)
    assert.equal(stored.revision, 1)
    assert.deepEqual(stored.selections, [{ taskId: 1, minutes: 45 }])
    assert.equal(stored.blocks.length, previewed.plan.blocks.length)
    assert.equal(stored.targetMinutes, 45)
    assert.equal(stored.scheduledMinutes, 45, '10:01–11:00 里放得下 45 分钟')
    assert.equal(stored.unscheduledMinutes, 0)
    assert.equal(stored.scheduledMinutes + stored.unscheduledMinutes, stored.targetMinutes)
    assert.equal(typeof stored.contextDigest, 'string')
    assert.equal(stored.anchorEpochMs, previewed.plan.anchorEpochMs)
    raw.close()

    // 重开数据库：计划必须还在（真正的持久化，不是内存态）。
    const reopened = await openFileDatabase(file)
    const repo2 = await openRepository(reopened.db, context, () => NOW)
    const loaded = await repo2.loadTodayPlan(TZ)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.revision, 1)
    assert.equal(loaded.plan.date, TZ)
    assert.equal(loaded.plan.scheduledMinutes, stored.scheduledMinutes)
    assert.equal(loaded.plan.blocks.length, previewed.plan.blocks.length)
    assert.equal(loaded.plan.outcomes[0].scheduledMinutes, 45)
    assert.equal(loaded.plan.outcomes[0].unscheduled, null)
    reopened.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('载荷被篡改 / 坏 JSON / 版本不认识：读回可读原因，且**不改动**那条记录', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1 })], schedules: [], courses: [] })
  try {
    const { raw, db } = await openFileDatabase(file)
    const repo = await openRepository(db, context, () => NOW)
    const insert = (value) =>
      raw
        .prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value;`)
        .run(PLAN_KEY, value, NOW.toISOString())

    insert('{ this is not json')
    const broken = await repo.loadTodayPlan(TZ)
    assert.equal(broken.ok, false)
    assert.match(broken.reason, /读不出来/)
    assert.equal(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value, '{ this is not json')

    insert(JSON.stringify({ version: 99, date: TZ, revision: 1 }))
    const unknownVersion = await repo.loadTodayPlan(TZ)
    assert.equal(unknownVersion.ok, false)
    assert.match(unknownVersion.reason, /版本|格式/)

    insert(JSON.stringify({ version: 1, date: TZ, revision: 1, selections: [], windows: [], blocks: [] }))
    const missingFields = await repo.loadTodayPlan(TZ)
    assert.equal(missingFields.ok, false)

    // 结构坏掉时保存必须**拒绝**，而不是把用户那条记录顺手覆盖掉。
    const previewed = await preview({
      context,
      windows: [{ start: '10:00', end: '11:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
    })
    const refused = await repo.saveTodayPlan({
      date: TZ,
      windows: [{ start: '10:00', end: '11:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(refused.committed, false)
    assert.match(refused.reason, /读不出来|已停止保存/)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 1, '坏记录仍然原样留着')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('存的是别的一天：读回 `plan: null` + storedOtherDate，绝不冒充今天的计划', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1, deadline: '2026-10-16T11:00:00+08:00' })], schedules: [], courses: [] })
  try {
    const { raw, db } = await openFileDatabase(file)
    const repo = await openRepository(db, context, () => new Date('2026-10-15T02:00:30.000Z'))
    const previewed = await preview({
      context,
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
    })
    const saved = await repo.saveTodayPlan({
      date: TZ,
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(saved.committed, true)

    const nextDay = await repo.loadTodayPlan('2026-10-16')
    assert.equal(nextDay.ok, true)
    assert.equal(nextDay.plan, null, '别的一天的计划不会被当成今天的')
    assert.equal(nextDay.storedOtherDate, true)
    assert.equal(nextDay.revision, 1, '版本号仍然读得出来（用于乐观锁）')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('提交前重算：预览之后任务被删 / 课表被改 / 任务完成，都拒绝且零改动', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({
    tasks: [task({ id: 1, deadline: '2026-10-15T11:00:00+08:00' })],
    schedules: [],
    courses: [course({ id: 1 })],
  })
  try {
    const { raw, db } = await openFileDatabase(file)
    const repo = await openRepository(db, context, () => NOW)
    const windows = [{ start: '10:00', end: '12:00' }]
    const selections = [{ taskId: 1, minutes: 30 }]
    const previewed = await preview({ context, windows, selections })

    const tableBefore = raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    assert.equal(tableBefore, 0)

    // 1) 任务被删
    context.value = { tasks: [], schedules: [], courses: [course({ id: 1 })] }
    const deleted = await repo.saveTodayPlan({ date: TZ, windows, selections, previewPlan: previewed.plan, expectedRevision: 0 })
    assert.equal(deleted.committed, false)
    assert.match(deleted.reason, /已经变化|重新生成/)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '一个字节都没写')

    // 2) 任务变成已完成
    context.value = {
      tasks: [task({ id: 1, status: 'DONE', deadline: '2026-10-15T11:00:00+08:00' })],
      schedules: [],
      courses: [course({ id: 1 })],
    }
    const completed = await repo.saveTodayPlan({ date: TZ, windows, selections, previewPlan: previewed.plan, expectedRevision: 0 })
    assert.equal(completed.committed, false)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0)

    // 3) 课表改了（多了今天的一节课）
    context.value = {
      tasks: [task({ id: 1, deadline: '2026-10-15T11:00:00+08:00' })],
      schedules: [schedule({ startTime: '10:00', endTime: '10:30' })],
      courses: [course({ id: 1 })],
    }
    const rescheduled = await repo.saveTodayPlan({ date: TZ, windows, selections, previewPlan: previewed.plan, expectedRevision: 0 })
    assert.equal(rescheduled.committed, false)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0)

    // 4) 上下文没变（只是外面重算了一次）→ 可以保存，而且块是**仓库自己重算**的
    context.value = {
      tasks: [task({ id: 1, deadline: '2026-10-15T11:00:00+08:00' })],
      schedules: [],
      courses: [course({ id: 1 })],
    }
    const ok = await repo.saveTodayPlan({ date: TZ, windows, selections, previewPlan: previewed.plan, expectedRevision: 0 })
    assert.equal(ok.committed, true)
    const stored = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.equal(stored.blocks[0].startTime, '10:01')
    assert.equal(stored.scheduledMinutes, 30)
    assert.equal(stored.contextDigest, previewed.fingerprint.contextDigest, '存的是提交时重算的指纹')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('now 变了：提交时已经有块落在过去 → 拒绝，不把过期预览写进去', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1, deadline: '2026-10-15T23:00:00+08:00' })], schedules: [], courses: [] })
  let raw = null
  try {
    const opened = await openFileDatabase(file)
    raw = opened.raw
    const db = opened.db
    const windows = [{ start: '10:00', end: '10:10' }]
    const selections = [{ taskId: 1, minutes: 10 }]

    // 预览在 10:00:30 生成（块 10:01–10:10），提交时已经 10:10:30。
    let currentNow = NOW
    const repo = await openRepository(db, context, () => currentNow)
    const previewed = await preview({ context, windows, selections, now: NOW })
    currentNow = new Date('2026-10-15T02:10:30.000Z')
    const rejected = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(rejected.committed, false)
    assert.match(rejected.reason, /过去|重新生成/)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '过期预览一个字节都不写')

    // 同一份输入在还能排进未来时（10:05）仍然可以保存，只是块更短。
    const midNow = new Date('2026-10-15T02:05:00.000Z')
    currentNow = midNow
    const midPreview = await preview({ context, windows, selections, now: midNow })
    const ok = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: midPreview.plan,
      expectedRevision: 0,
    })
    assert.equal(ok.committed, true)
    const stored = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.equal(stored.blocks[0].startTime, '10:05')
    assert.equal(stored.blocks[0].endTime, '10:10')

    // 反例（同一份输入、时间再往后一分钟）：块已经开始 → 拒绝，且**不覆盖**刚才那份。
    const bytesBefore = raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value
    currentNow = new Date('2026-10-15T02:06:30.000Z')
    const tooLate = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: midPreview.plan,
      expectedRevision: 1,
    })
    assert.equal(tooLate.committed, false)
    assert.match(tooLate.reason, /过去|重新生成/)
    assert.equal(
      raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value,
      bytesBefore,
      '被拒时已保存的那份一个字节都不动',
    )
  } finally {
    if (raw) raw.close()
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('乐观版本：两个实例并发保存时，后到的那个被拒绝（不静默覆盖）', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1, deadline: '2026-10-15T23:00:00+08:00' })], schedules: [], courses: [] })
  try {
    const { raw, db } = await openFileDatabase(file)
    const repoA = await openRepository(db, context, () => NOW)
    const repoB = await openRepository(db, context, () => NOW)
    const windows = [{ start: '10:00', end: '12:00' }]
    const selectionsA = [{ taskId: 1, minutes: 30 }]
    const selectionsB = [{ taskId: 1, minutes: 60 }]

    const previewA = await preview({ context, windows, selections: selectionsA })
    const previewB = await preview({ context, windows, selections: selectionsB })

    const first = await repoA.saveTodayPlan({
      date: TZ,
      windows,
      selections: selectionsA,
      previewPlan: previewA.plan,
      expectedRevision: 0,
    })
    assert.equal(first.committed, true)
    assert.equal(first.revision, 1)

    // B 还是按「没有保存过」提交 → 必须被拒绝。
    const second = await repoB.saveTodayPlan({
      date: TZ,
      windows,
      selections: selectionsB,
      previewPlan: previewB.plan,
      expectedRevision: 0,
    })
    assert.equal(second.committed, false)
    assert.match(second.reason, /别处已经保存过/)
    const stored = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.deepEqual(stored.selections, selectionsA, 'A 保存的内容没有被 B 覆盖')

    // B 拿到最新版本（1）后仍然可以明确替换。
    const replace = await repoB.saveTodayPlan({
      date: TZ,
      windows,
      selections: selectionsB,
      previewPlan: previewB.plan,
      expectedRevision: 1,
    })
    assert.equal(replace.committed, true)
    assert.equal(replace.revision, 2)
    const replaced = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.deepEqual(replaced.selections, selectionsB)
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('写入失败：事务回滚，一个字节都不留（零改动）', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1, deadline: '2026-10-15T23:00:00+08:00' })], schedules: [], courses: [] })
  try {
    const { raw, db } = await openFileDatabase(file)
    const windows = [{ start: '10:00', end: '12:00' }]
    const selections = [{ taskId: 1, minutes: 30 }]
    const previewed = await preview({ context, windows, selections })

    // 让「写 app_settings」那一次 runAsync 抛错（模拟磁盘 / SQLite 故障）。
    const failing = {
      ...db,
      async runAsync(sql, params = []) {
        throw new Error('测试注入的写入失败')
      },
    }
    const { TodayPlanRepository } = await import('../src/domain/todayPlanRepository.ts')
    const repo = new TodayPlanRepository(failing, async () => context.value, () => NOW)
    const failed = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.committed, false)
    assert.match(failed.reason, /写入失败/)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '失败后必须零改动')

    // 用真实连接再确认一次「事务没有留下半条记录」。
    const realRepo = await openRepository(db, context, () => NOW)
    const after = await realRepo.loadTodayPlan(TZ)
    assert.equal(after.ok, true)
    assert.equal(after.plan, null)
    assert.equal(after.revision, 0)
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('提交成功但读回失败：仍然 committed，并把真实错误交给界面', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1, deadline: '2026-10-15T23:00:00+08:00' })], schedules: [], courses: [] })
  try {
    const { raw, db } = await openFileDatabase(file)
    const windows = [{ start: '10:00', end: '12:00' }]
    const selections = [{ taskId: 1, minutes: 30 }]
    const previewed = await preview({ context, windows, selections })

    let reads = 0
    const flaky = {
      ...db,
      async getFirstAsync(sql, params = []) {
        reads += 1
        // 第 2 次读（提交之后的读回）开始报错。
        if (reads > 1 && String(sql).includes('app_settings')) throw new Error('读回时连接断了')
        return db.getFirstAsync(sql, params)
      },
    }
    const { TodayPlanRepository } = await import('../src/domain/todayPlanRepository.ts')
    const repo = new TodayPlanRepository(flaky, async () => context.value, () => NOW)
    const result = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(result.committed, true, '写入已经提交，这个事实不能被读回失败改写')
    assert.equal(result.revision, 1)
    assert.match(result.readbackError, /读回时连接断了/)
    const stored = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.equal(stored.revision, 1, '库里确实写进去了')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('不碰既有数据：保存计划不会改动 tasks / courses / schedules / 其它设置', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({
    tasks: [task({ id: 1, title: '原任务标题', estimatedMinutes: 90, deadline: '2026-10-15T23:00:00+08:00' })],
    schedules: [],
    courses: [course({ id: 1 })],
  })
  try {
    const { raw, db } = await openFileDatabase(file)
    // 造一条真实的课程 + 课表 + 任务 + 一条参考用时设置，然后确认保存计划不动它们。
    raw.exec(`INSERT INTO courses (id, code, name, instructor, semester, color, note, created_at, updated_at)
              VALUES (1, 'AUTO-01', '数据结构', NULL, NULL, NULL, NULL, '2026-09-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00');`)
    raw.exec(`INSERT INTO schedules (id, course_id, weekday, start_time, end_time, location, period_start, period_end,
              week_range, semester_start_date, start_week, end_week, week_pattern, created_at, updated_at)
              VALUES (1, 1, 4, '08:00', '09:40', NULL, NULL, NULL, NULL, '2026-09-07', 1, 16, 'ALL',
                      '2026-09-01T00:00:00+08:00', '2026-09-01T00:00:00+08:00');`)
    raw.exec(`INSERT INTO tasks (id, title, description, course_id, type, status, priority, deadline, estimated_minutes,
              submit_requirement, submit_method, completed_at, created_at, updated_at)
              VALUES (1, '原任务标题', NULL, 1, 'HOMEWORK', 'TODO', 3, '2026-10-15T23:00:00+08:00', 90,
                      NULL, NULL, NULL, '2026-10-01T00:00:00+08:00', '2026-10-01T00:00:00+08:00');`)
    raw.exec(`INSERT INTO app_settings (key, value, updated_at) VALUES ('pressure.daily_study_reference_minutes', '120', '2026-10-14T00:00:00+08:00');`)

    const snapshot = () => ({
      tasks: raw.prepare('SELECT * FROM tasks;').all(),
      courses: raw.prepare('SELECT * FROM courses;').all(),
      schedules: raw.prepare('SELECT * FROM schedules;').all(),
      reference: raw.prepare('SELECT * FROM app_settings WHERE key = ?;').get('pressure.daily_study_reference_minutes'),
    })
    const before = snapshot()

    const repo = await openRepository(db, context, () => NOW)
    const windows = [{ start: '10:00', end: '12:00' }]
    const selections = [{ taskId: 1, minutes: 45 }]
    const previewed = await preview({ context, windows, selections })
    const saved = await repo.saveTodayPlan({ date: TZ, windows, selections, previewPlan: previewed.plan, expectedRevision: 0 })
    assert.equal(saved.committed, true)
    assert.deepEqual(snapshot(), before, '既有表一条都不许变')
    const keys = raw.prepare('SELECT key FROM app_settings ORDER BY key;').all().map((row) => row.key)
    assert.deepEqual(keys, ['daily_plan.today', 'pressure.daily_study_reference_minutes'], '只多了一个计划键')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('非法输入在仓库层就被拒绝（零写入）：时段重叠 / 没填分钟数 / 日期不是今天', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({ tasks: [task({ id: 1 })], schedules: [], courses: [] })
  let raw = null
  try {
    const opened = await openFileDatabase(file)
    raw = opened.raw
    const repo = await openRepository(opened.db, context, () => NOW)
    const previewed = await preview({
      context,
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
    })
    const countRows = () => raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n
    assert.equal(countRows(), 0)

    const overlapping = await repo.saveTodayPlan({
      date: TZ,
      windows: [
        { start: '10:00', end: '11:00' },
        { start: '10:30', end: '12:00' },
      ],
      selections: [{ taskId: 1, minutes: 30 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(overlapping.committed, false)
    assert.match(overlapping.reason, /重叠/)

    const badMinutes = await repo.saveTodayPlan({
      date: TZ,
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: 1, minutes: 0 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(badMinutes.committed, false)
    assert.match(badMinutes.reason, /1440/)

    const notToday = await repo.saveTodayPlan({
      date: '2026-10-14',
      windows: [{ start: '10:00', end: '12:00' }],
      selections: [{ taskId: 1, minutes: 30 }],
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(notToday.committed, false)
    assert.match(notToday.reason, /不是这一天的计划|今天/)
    assert.equal(countRows(), 0, '被拒的输入一个字节都没写')
  } finally {
    if (raw) raw.close()
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('预览之后任务只改了标题（排布没变）也必须拒绝：不能拿旧内容去保存', async () => {
  const { dir, file } = tempDbPath()
  const context = contextHolder({
    tasks: [task({ id: 1, title: '原始标题', deadline: '2026-10-15T23:00:00+08:00' })],
    schedules: [],
    courses: [],
  })
  let raw = null
  try {
    const opened = await openFileDatabase(file)
    raw = opened.raw
    const db = opened.db
    const repo = await openRepository(db, context, () => NOW)
    const windows = [{ start: '10:00', end: '11:00' }]
    const selections = [{ taskId: 1, minutes: 30 }]
    const previewed = await preview({ context, windows, selections })
    assert.equal(previewed.plan.scheduledMinutes, 30)
    assert.equal(previewed.plan.blocks[0].taskTitle, '原始标题')

    // 仅改标题：排布结果一模一样，只有「用户看到的内容」变了。
    context.value = {
      tasks: [task({ id: 1, title: '改过的标题', deadline: '2026-10-15T23:00:00+08:00' })],
      schedules: [],
      courses: [],
    }
    const rejected = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(rejected.committed, false, '只改标题也必须让预览作废')
    assert.match(rejected.reason, /已经变化|重新生成/)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '零写入')

    // 重新生成预览之后（标题已经是新的）才能保存。
    const regenerated = await preview({ context, windows, selections })
    assert.equal(regenerated.plan.blocks[0].taskTitle, '改过的标题')
    const saved = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: regenerated.plan,
      expectedRevision: 0,
    })
    assert.equal(saved.committed, true)
    const stored = JSON.parse(raw.prepare('SELECT value FROM app_settings WHERE key = ?;').get(PLAN_KEY).value)
    assert.equal(stored.blocks[0].taskTitle, '改过的标题')
  } finally {
    if (raw) raw.close()
    removeTempDir(dir, 'ddl-todayplan-')
  }
})

test('只到日期的 DDL 可以被预览、保存并原样读回（按当天结束）', async () => {
  const ctx = await createTestDatabase()
  const context = contextHolder({
    tasks: [task({ id: 1, title: '只到日期', deadline: '2026-10-15', estimatedMinutes: 60 })],
    schedules: [],
    courses: [],
  })
  try {
    const repo = await openRepository(ctx.db, context, () => NOW)
    const windows = [{ start: '10:00', end: '11:00' }]
    const selections = [{ taskId: 1, minutes: 30 }]
    const previewed = await preview({ context, windows, selections })
    assert.equal(previewed.plan.scheduledMinutes, 30)

    const saved = await repo.saveTodayPlan({
      date: TZ,
      windows,
      selections,
      previewPlan: previewed.plan,
      expectedRevision: 0,
    })
    assert.equal(saved.committed, true)
    assert.equal(saved.readbackError, null)

    const loaded = await repo.loadTodayPlan(TZ)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.revision, 1)
    assert.equal(loaded.plan.outcomes[0].deadline, '2026-10-15', '裸日期原样持久化，不做时间换算')
    assert.equal(loaded.plan.outcomes[0].scheduledMinutes, 30)
  } finally {
    ctx.close()
  }
})
