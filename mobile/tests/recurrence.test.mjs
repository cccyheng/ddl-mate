/**
 * 重复任务：纯逻辑 + **真实 SQLite** 仓库测试。
 *
 * 重点验证：
 * - 每天 / 每周多选、闰年、上海自然日、可选时间（留空 = 裸日期）；
 * - 90 天 / 100 条上限、结束早于开始、空周几、非法日期；
 * - 同一份已确认预览重放不会生成第二条规则 / 重复任务；
 * - 删除某次生成的任务后账本明确跳过，不悄悄重建；
 * - 规则 / 模板 / 课程变化会让旧预览在事务内被拒绝；
 * - 多任务 + 账本单事务，任一步失败整体回滚；
 * - 删除规则不删除已创建任务；不同规则可以合法地有相同标题。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTestDatabase, taskDraft, courseDraft } from './helpers/sqliteHarness.mjs'
import {
  buildOccurrences,
  normalizeRecurrenceRule,
  RECURRENCE_LIMITS,
} from '../src/domain/recurrence.ts'
import { weekdayOfDateKey } from '../src/domain/datetime.ts'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import {
  StalePreviewError,
  TaskTemplateRepository,
} from '../src/domain/taskTemplateRepository.ts'
import { emptyTemplateInput } from '../src/domain/taskTemplate.ts'

const NOW = new Date('2026-10-26T01:00:00.000Z') // 上海 09:00

function ruleInput(overrides = {}) {
  return {
    name: '每周作业',
    templateId: null,
    title: '提交作业',
    description: '',
    type: 'HOMEWORK',
    priority: 3,
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    courseId: null,
    cadence: 'DAILY',
    weekdays: [],
    startDate: '2028-02-28',
    endDate: '2028-03-01',
    time: '',
    ...overrides,
  }
}

function makeRepo(ctx, db = ctx.db, now = () => NOW) {
  return new TaskTemplateRepository(db, new TaskRepository(db, now), now)
}

async function preview(repo, draft, ruleId = null) {
  const snapshot = await repo.loadSnapshot()
  const tasks = await repo['db'].getAllAsync('SELECT id FROM tasks ORDER BY id ASC;')
  return TaskTemplateRepository.previewWithSnapshot(
    draft,
    snapshot,
    new Set(),
    new Set(tasks.map((row) => Number(row.id))),
    ruleId,
  )
}

test('纯逻辑：每天规则生成闰年 2 月 29 日；无时间时 deadline 是裸日期', () => {
  const normalized = normalizeRecurrenceRule(ruleInput())
  const occurrences = buildOccurrences(normalized)
  assert.deepEqual(
    occurrences.map((row) => row.date),
    ['2028-02-28', '2028-02-29', '2028-03-01'],
  )
  assert.ok(occurrences.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.deadline)))
})

test('纯逻辑：每周多选只取选中的周几；可选的 HH:mm 保留精确时刻', () => {
  assert.equal(weekdayOfDateKey('2028-02-28'), 1)
  assert.equal(weekdayOfDateKey('2028-03-01'), 3)
  const normalized = normalizeRecurrenceRule(
    ruleInput({ cadence: 'WEEKLY', weekdays: [3, 1, 3], time: '7:05' }),
  )
  assert.deepEqual(normalized.weekdays, [1, 3])
  assert.equal(normalized.time, '07:05')
  const occurrences = buildOccurrences(normalized)
  assert.deepEqual(
    occurrences.map((row) => row.date),
    ['2028-02-28', '2028-03-01'],
  )
  assert.equal(occurrences[0].deadline, '2028-02-28T07:05')
})

test('纯逻辑：范围 / 周几 / 日期 / 时间边界都被拒绝', () => {
  const cases = [
    [{ endDate: '2028-02-27' }, 'endDate'],
    [{ cadence: 'WEEKLY', weekdays: [] }, 'weekdays'],
    [{ cadence: 'WEEKLY', weekdays: [0] }, 'weekdays'],
    [{ startDate: '2027-02-29' }, 'startDate'],
    [{ endDate: '2026-02-30' }, 'endDate'],
    [{ time: '24:00' }, 'time'],
    [{ time: '23:60' }, 'time'],
    [{ startDate: '2026-01-01', endDate: '2026-04-01' }, 'endDate'], // 91 天
    [{ title: '' }, 'task_title'],
  ]
  for (const [overrides, field] of cases) {
    assert.throws(
      () => normalizeRecurrenceRule(ruleInput(overrides)),
      (cause) => Boolean(cause.fields?.[field]),
      `应拒绝 ${field}`,
    )
  }
  // 90 天整（首尾都算）是允许的上限。
  const allowed = normalizeRecurrenceRule(ruleInput({ startDate: '2026-01-01', endDate: '2026-03-31' }))
  assert.equal(buildOccurrences(allowed).length, 90)
  assert.ok(RECURRENCE_LIMITS.maxOccurrences >= 90)
})

test('真实 SQLite：预览后生成 3 条 TODO 裸日期任务，不创建提醒', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput()
    const p = await preview(repo, draft)
    assert.equal(p.ok, true)
    assert.deepEqual(
      p.occurrences.map((row) => row.date),
      ['2028-02-28', '2028-02-29', '2028-03-01'],
    )
    const outcome = await repo.generateRecurrence(draft, {
      ruleId: null,
      expectedFingerprint: p.fingerprint,
    })
    assert.equal(outcome.created, 3)
    const tasks = await ctx.tasks.listAll()
    assert.equal(tasks.length, 3)
    assert.ok(tasks.every((task) => task.status === 'TODO'))
    assert.ok(tasks.every((task) => task.estimatedMinutes === null))
    assert.ok(tasks.every((task) => /^\d{4}-\d{2}-\d{2}$/.test(task.deadline)))
    const reminders = ctx.raw
      .prepare("SELECT key FROM app_settings WHERE key LIKE 'task_reminder.%'")
      .all()
    assert.equal(reminders.length, 0, '生成任务默认不创建提醒设置')
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：可选时间使用北京时间精确时刻入库，而不是本地时区', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput({ startDate: '2028-02-28', endDate: '2028-02-28', time: '07:05' })
    const p = await preview(repo, draft)
    assert.equal(p.ok, true)
    await repo.generateRecurrence(draft, { ruleId: null, expectedFingerprint: p.fingerprint })
    const tasks = await ctx.tasks.listAll()
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].deadline, '2028-02-28T07:05:00+08:00')
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：重试同一份新规则预览只得到一条规则 / 三条任务；重开预览显示已创建', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput()
    const p = await preview(repo, draft)
    const request = { ruleId: null, expectedFingerprint: p.fingerprint }
    const first = await repo.generateRecurrence(draft, request)
    await assert.rejects(() => repo.generateRecurrence(draft, request), StalePreviewError)
    assert.equal((await ctx.tasks.listAll()).length, 3)
    const snapshot = await repo.loadSnapshot()
    assert.equal(snapshot.rules.length, 1)

    // 重开 / 重新预览：账本显示已创建，再点生成不会重复。
    const reopened = makeRepo(ctx)
    const next = await preview(reopened, draft, first.ruleId)
    assert.equal(next.createdCount, 3)
    const again = await reopened.generateRecurrence(draft, {
      ruleId: first.ruleId,
      expectedFingerprint: next.fingerprint,
    })
    assert.equal(again.created, 0)
    assert.equal(again.skippedExisting, 3)
    assert.equal((await ctx.tasks.listAll()).length, 3)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：删除某次生成的任务后，账本明确跳过而不是悄悄重建', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput()
    const p = await preview(repo, draft)
    const first = await repo.generateRecurrence(draft, {
      ruleId: null,
      expectedFingerprint: p.fingerprint,
    })
    const tasks = await ctx.tasks.listAll()
    await ctx.tasks.remove(tasks[0].id)
    const next = await preview(repo, draft, first.ruleId)
    assert.equal(next.deletedCount, 1)
    assert.equal(next.createdCount, 2)
    const again = await repo.generateRecurrence(draft, {
      ruleId: first.ruleId,
      expectedFingerprint: next.fingerprint,
    })
    assert.equal(again.created, 0)
    assert.equal(again.skippedDeleted, 1)
    assert.equal((await ctx.tasks.listAll()).length, 2, '已删除的日期不会被悄悄补回来')
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：完整系列改规则后零可创建，仍能只保存规则且不碰任何已有任务', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const originalDraft = ruleInput()
    const p = await preview(repo, originalDraft)
    const generated = await repo.generateRecurrence(originalDraft, {
      ruleId: null,
      expectedFingerprint: p.fingerprint,
    })
    const tasks = await ctx.tasks.listAll()
    await ctx.tasks.remove(tasks[0].id)
    const taskRowsBefore = ctx.raw.prepare('SELECT * FROM tasks ORDER BY id ASC;').all()
    const ledgerBefore = (await repo.loadSnapshot()).ledger
    const ruleBefore = (await repo.loadSnapshot()).rules[0]
    assert.ok(ruleBefore)

    // 用户只改规则本身的名称 / 任务标题 / 时间：范围内的日期都已生成或被删除。
    const edited = {
      ...originalDraft,
      name: '改过的规则名',
      title: '改过的任务标题',
      time: '09:30',
    }
    const next = await preview(repo, edited, generated.ruleId)
    assert.equal(next.ok, true)
    assert.equal(next.availableCount, 0)
    assert.equal(next.createdCount, 2)
    assert.equal(next.deletedCount, 1)

    const saved = await repo.generateRecurrence(edited, {
      ruleId: generated.ruleId,
      expectedFingerprint: next.fingerprint,
    })
    assert.equal(saved.created, 0, '零新日期时只保存规则，不创建任务')
    assert.deepEqual(
      ctx.raw.prepare('SELECT * FROM tasks ORDER BY id ASC;').all(),
      taskRowsBefore,
      '已有任务必须逐字段保持不变',
    )
    assert.deepEqual((await repo.loadSnapshot()).ledger, ledgerBefore, '已创建 / 已删除记录不能被改写')
    const ruleAfter = (await repo.loadSnapshot()).rules[0]
    assert.equal(ruleAfter.name, '改过的规则名')
    assert.equal(ruleAfter.title, '改过的任务标题')
    assert.equal(ruleAfter.time, '09:30')
    assert.equal(ruleAfter.revision, ruleBefore.revision + 1)
    assert.equal(
      (await ctx.tasks.listAll()).some((task) => task.id === tasks[0].id),
      false,
      '已删除的日期在保存规则后仍然不存在',
    )
    assert.equal((await ctx.tasks.listAll()).length, 2)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：预览之后改标题会拒绝旧预览，一个任务都不写', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput()
    const p = await preview(repo, draft)
    await assert.rejects(
      () =>
        repo.generateRecurrence(
          { ...draft, title: '被改过的标题' },
          { ruleId: null, expectedFingerprint: p.fingerprint },
        ),
      StalePreviewError,
    )
    assert.equal((await ctx.tasks.listAll()).length, 0)
    assert.equal((await repo.loadSnapshot()).rules.length, 0)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：模板在同一毫秒内被编辑也会让旧预览失效（revision，而不是时间戳）', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const ti = { ...emptyTemplateInput(), name: '原模板', title: '原任务' }
    const template = await repo.createTemplate(ti)
    const draft = ruleInput({ templateId: template.id })
    const p = await preview(repo, draft)
    await repo.updateTemplate(template.id, { ...ti, title: '修改后的任务' })
    await assert.rejects(
      () => repo.generateRecurrence(draft, { ruleId: null, expectedFingerprint: p.fingerprint }),
      StalePreviewError,
    )
    assert.equal((await ctx.tasks.listAll()).length, 0)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：多任务 + 账本单事务；第 2 条任务写入失败时全部回滚', async () => {
  const ctx = await createTestDatabase()
  try {
    let taskInserts = 0
    const failingDb = {
      ...ctx.db,
      async runAsync(sql, params = []) {
        if (/INSERT INTO tasks/i.test(sql)) {
          taskInserts += 1
          if (taskInserts === 2) throw new Error('测试注入：第 2 条任务写入失败')
        }
        return ctx.db.runAsync(sql, params)
      },
    }
    const repo = makeRepo(ctx, failingDb)
    const draft = ruleInput()
    const p = await preview(repo, draft)
    await assert.rejects(
      () => repo.generateRecurrence(draft, { ruleId: null, expectedFingerprint: p.fingerprint }),
      /测试注入/,
    )
    assert.equal((await ctx.tasks.listAll()).length, 0, '第 1 条任务必须一起回滚')
    const stored = ctx.raw
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get('task_recurrence.v1')
    assert.equal(stored, undefined, '规则 / 账本不能在失败后留下半份数据')
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：课程被删除后预览标记阻塞，生成被拒绝', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft({ name: '会删除的课程' }))
    const repo = makeRepo(ctx)
    const draft = ruleInput({ courseId: course.id })
    const p = await preview(repo, draft)
    assert.equal(p.ok, true)
    await ctx.courses.removeCourse(course.id, { confirmed: true })
    const blocked = await preview(repo, draft)
    assert.equal(blocked.ok, true)
    assert.ok(blocked.blockedReason)
    await assert.rejects(
      () => repo.generateRecurrence(draft, { ruleId: null, expectedFingerprint: blocked.fingerprint }),
      /课程/,
    )
    assert.equal((await ctx.tasks.listAll()).length, 0)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：删除模板 / 删除规则都不删除已创建任务；不同规则可同名', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const ti = { ...emptyTemplateInput(), name: '模板', title: '模板任务' }
    const template = await repo.createTemplate(ti)

    const draftA = ruleInput({ templateId: template.id, name: '系列 A' })
    const previewA = await preview(repo, draftA)
    const a = await repo.generateRecurrence(draftA, { ruleId: null, expectedFingerprint: previewA.fingerprint })

    // 显式的新系列：全新预览（nextRuleId 已变化）允许创建一个内容相同但独立的规则。
    const draftB = ruleInput({ templateId: template.id, name: '系列 B' })
    const previewB = await preview(repo, draftB)
    const b = await repo.generateRecurrence(draftB, { ruleId: null, expectedFingerprint: previewB.fingerprint })
    assert.notEqual(a.ruleId, b.ruleId)
    assert.equal((await ctx.tasks.listAll()).length, 6, '不同系列可以合法地有相同标题 / 日期')

    await repo.removeTemplate(template.id)
    assert.equal((await ctx.tasks.listAll()).length, 6, '删除模板不删除任务')
    const snapshot = await repo.loadSnapshot()
    assert.ok(snapshot.rules.every((rule) => rule.templateId === null))

    await repo.removeRecurrenceRule(a.ruleId)
    assert.equal((await ctx.tasks.listAll()).length, 6, '删除规则不删除任务')
    assert.equal((await repo.loadSnapshot()).rules.length, 1)
  } finally {
    ctx.close()
  }
})

test('真实 SQLite：规则与账本跨仓库实例持久化，重复任务不复制原文 / 完成状态', async () => {
  const ctx = await createTestDatabase()
  try {
    const repo = makeRepo(ctx)
    const draft = ruleInput({ estimatedMinutes: '60', description: '复用说明' })
    const p = await preview(repo, draft)
    const generated = await repo.generateRecurrence(draft, {
      ruleId: null,
      expectedFingerprint: p.fingerprint,
    })
    const reopened = makeRepo(ctx)
    const snapshot = await reopened.loadSnapshot()
    assert.equal(snapshot.rules.length, 1)
    assert.equal(snapshot.rules[0].id, generated.ruleId)
    assert.equal(snapshot.ledger.length, 3)
    assert.equal(snapshot.ledger.every((entry) => entry.status === 'CREATED'), true)
    const tasks = await ctx.tasks.listAll()
    assert.ok(tasks.every((task) => task.description === '复用说明'))
    assert.ok(tasks.every((task) => task.estimatedMinutes === 60))
    assert.ok(tasks.every((task) => task.completedAt === null))
    assert.equal((await ctx.tasks.listAllOriginalSources()).size, 0, '生成任务不复制任何原始通知关联')
  } finally {
    ctx.close()
  }
})
