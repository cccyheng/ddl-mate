/**
 * 模板 / 重复任务与备份恢复的真实往返测试。
 *
 * 只用系统临时目录与内存 SQLite，不读取任何用户手机数据。
 *
 * 覆盖：
 * - 新设置键（模板 + 规则 + 账本）真实导出、预览、恢复；
 * - 账本里“已删除任务”的历史引用在恢复后仍保持历史身份，且任务 ID 高水位不被复用；
 * - 旧 v1 备份（没有新键）仍能解析、预览、恢复；
 * - 恶意的规则 / 账本 / 模板引用在写库之前被拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createTestDatabase, courseDraft, taskDraft } from './helpers/sqliteHarness.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import {
  exportBackupToDirectory,
  restoreStagedBackup,
  stageBackupForPreview,
} from '../src/domain/backupService.ts'
import { parseBackupText, sealBackupData } from '../src/domain/backupFormat.ts'
import { emptyTemplateInput } from '../src/domain/taskTemplate.ts'
import { TaskTemplateRepository } from '../src/domain/taskTemplateRepository.ts'

const NOW = new Date('2026-10-26T01:00:00.000Z')
const TASK_TEMPLATES_KEY = 'task_templates.v1'
const TASK_RECURRENCE_KEY = 'task_recurrence.v1'

function tempRoot(prefix = 'ddl-templates-backup-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  return { root, docs }
}

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

async function previewRule(repo, draft, ruleId = null) {
  const snapshot = await repo.loadSnapshot()
  const tasks = await repo.db.getAllAsync('SELECT id FROM tasks ORDER BY id ASC;')
  return TaskTemplateRepository.previewWithSnapshot(
    draft,
    snapshot,
    new Set(),
    new Set(tasks.map((row) => Number(row.id))),
    ruleId,
  )
}

test('真实往返：模板 + 规则 + 账本随备份恢复；已删除任务引用保持历史且 ID 不被复用', async () => {
  const { root, docs } = tempRoot()
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  try {
    const course = await ctx.courses.create(courseDraft({ name: '数据结构' }))
    const source = (
      await ctx.tasks.create(
        taskDraft({
          title: '源任务',
          courseId: course.id,
          estimatedMinutes: '60',
          originalText: '原始通知不会被复制进模板',
        }),
      )
    ).task
    assert.ok(source)

    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const template = await repo.createTemplateFromTask(
      source.id,
      {
        ...emptyTemplateInput(),
        name: '实验报告模板',
        fields: ['title', 'estimatedMinutes', 'courseId'],
        title: '实验报告',
        estimatedMinutes: '90',
        courseId: course.id,
      },
    )
    const draft = ruleInput({ templateId: template.id })
    const p = await previewRule(repo, draft)
    assert.equal(p.ok, true)
    const generated = await repo.generateRecurrence(draft, {
      ruleId: null,
      expectedFingerprint: p.fingerprint,
    })
    assert.equal(generated.created, 3)
    const tasks = await ctx.tasks.listAll()
    const generatedTasks = tasks.filter((task) => task.id !== source.id)
    assert.equal(generatedTasks.length, 3)
    await ctx.tasks.remove(generatedTasks[0].id)

    const exported = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
    const parsed = await parseBackupText(await fs.readText(exported.uri))
    assert.ok(
      parsed.data.settings.some((setting) => setting.key === TASK_TEMPLATES_KEY),
      '备份必须包含模板设置键',
    )
    assert.ok(
      parsed.data.settings.some((setting) => setting.key === TASK_RECURRENCE_KEY),
      '备份必须包含规则 / 账本设置键',
    )

    const before = await repo.loadSnapshot()
    const deletedEntry = before.ledger.find((entry) => entry.taskId === generatedTasks[0].id)
    assert.ok(deletedEntry, '删除的任务必须仍留在账本里作为历史')

    const preview = await stageBackupForPreview(ctx.db, fs, exported.uri, { sourceName: 'templates.ddlbackup.json' })
    const restored = await restoreStagedBackup(ctx.db, fs, preview, { now: () => NOW })
    assert.equal(restored.committed, true, restored.committed ? '' : restored.reason)
    assert.equal(restored.refreshError, null)

    const reopened = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const after = await reopened.loadSnapshot()
    assert.equal(after.error, null)
    assert.equal(after.templates.length, 1)
    assert.equal(after.rules.length, 1)
    assert.equal(after.ledger.length, 3)
    assert.ok(after.templates[0].revision >= 1)
    assert.ok(after.rules[0].revision >= 1)
    assert.ok(after.ledger.some((entry) => entry.taskId === deletedEntry.taskId))
    const restoredTasks = await ctx.tasks.listAll()
    assert.equal(restoredTasks.length, 3, '源任务 + 两条未删除的生成任务')
    assert.equal(restoredTasks.some((task) => task.id === deletedEntry.taskId), false)

    // 高水位必须把历史账本任务 ID 也包含进去：恢复后新建任务不能复用那个 id。
    const created = await ctx.tasks.create(taskDraft({ title: '恢复后新建的任务' }))
    assert.ok(created.id > deletedEntry.taskId, '恢复后新建任务的 id 不能复用已删除账本里的历史 id')

    // 再次预览/生成：已存在的两条跳过，已删除的一条不重建。
    const next = await previewRule(reopened, draft, after.rules[0].id)
    assert.equal(next.createdCount, 2)
    assert.equal(next.deletedCount, 1)
    const again = await reopened.generateRecurrence(draft, {
      ruleId: after.rules[0].id,
      expectedFingerprint: next.fingerprint,
    })
    assert.equal(again.created, 0)
    assert.equal(again.skippedDeleted, 1)
    assert.equal((await ctx.tasks.listAll()).length, 4, '只多了恢复后手工新建的那条任务')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-templates-backup-')
  }
})

test('旧 v1 备份（没有模板 / 规则键）仍能解析和恢复；新键不会凭空出现', async () => {
  const { root, docs } = tempRoot('ddl-templates-old-')
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  try {
    const original = (await ctx.tasks.create(taskDraft({ title: '旧备份里的任务' }))).task
    assert.ok(original)
    const oldExport = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
    const oldParsed = await parseBackupText(await fs.readText(oldExport.uri))
    assert.equal(oldParsed.data.settings.some((setting) => setting.key === TASK_TEMPLATES_KEY), false)
    assert.equal(oldParsed.data.settings.some((setting) => setting.key === TASK_RECURRENCE_KEY), false)

    // 导出旧备份之后才启用模板 / 规则；恢复旧备份应把它们按“旧数据没有”处理。
    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const template = await repo.createTemplate({
      ...emptyTemplateInput(),
      name: '旧备份之后创建的模板',
      title: '新模板',
    })
    assert.ok(template.id > 0)
    const p = await previewRule(repo, ruleInput())
    await repo.generateRecurrence(ruleInput(), { ruleId: null, expectedFingerprint: p.fingerprint })

    const preview = await stageBackupForPreview(ctx.db, fs, oldExport.uri)
    const restored = await restoreStagedBackup(ctx.db, fs, preview, { now: () => NOW })
    assert.equal(restored.committed, true, restored.committed ? '' : restored.reason)

    const reopened = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const after = await reopened.loadSnapshot()
    assert.equal(after.templates.length, 0)
    assert.equal(after.rules.length, 0)
    assert.equal(after.ledger.length, 0)
    assert.equal(after.error, null)
    const keys = ctx.raw.prepare('SELECT key FROM app_settings WHERE key IN (?, ?)').all(TASK_TEMPLATES_KEY, TASK_RECURRENCE_KEY)
    assert.equal(keys.length, 0)
    assert.deepEqual(
      (await ctx.tasks.listAll()).map((task) => task.id),
      [original.id],
      '旧备份恢复后只应保留旧备份里的任务',
    )
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-templates-old-')
  }
})

function ruleRecord(overrides = {}) {
  return {
    id: 1,
    revision: 1,
    name: '规则',
    templateId: null,
    title: '任务',
    description: null,
    type: 'HOMEWORK',
    priority: 3,
    estimatedMinutes: null,
    submitRequirement: null,
    submitMethod: null,
    courseId: null,
    cadence: 'DAILY',
    weekdays: [],
    startDate: '2028-02-28',
    endDate: '2028-03-01',
    time: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

function recurrenceValue(rules, ledger) {
  return JSON.stringify({ version: 1, nextRuleId: 2, rules, ledger })
}

async function sealedBackupWithSetting(value) {
  const data = {
    tasks: [],
    courses: [],
    schedules: [],
    taskSources: [],
    images: [],
    attempts: [],
    sources: [],
    refs: [],
    ocrResults: [],
    ocrCandidates: [],
    settings: [{ key: TASK_RECURRENCE_KEY, value, updatedAt: NOW.toISOString() }],
  }
  return JSON.stringify(await sealBackupData(data, { now: () => NOW }))
}

test('恶意 / 损坏的规则账本引用在写库前被拒绝', async () => {
  const cases = [
    // 账本指向不存在的规则。
    recurrenceValue([ruleRecord()], [
      { ruleId: 99, date: '2028-02-28', taskId: null, status: 'SKIPPED', createdAt: NOW.toISOString() },
    ]),
    // 同一规则同一天重复。
    recurrenceValue(
      [ruleRecord()],
      [
        { ruleId: 1, date: '2028-02-28', taskId: 1, status: 'CREATED', createdAt: NOW.toISOString() },
        { ruleId: 1, date: '2028-02-28', taskId: 2, status: 'CREATED', createdAt: NOW.toISOString() },
      ],
    ),
    // 已创建但任务 ID 为 0。
    recurrenceValue([ruleRecord()], [
      { ruleId: 1, date: '2028-02-28', taskId: 0, status: 'CREATED', createdAt: NOW.toISOString() },
    ]),
    // 结束日期早于开始日期。
    recurrenceValue(
      [ruleRecord({ startDate: '2028-03-02', endDate: '2028-03-01' })],
      [],
    ),
    // 非法日期 / 空周几。
    recurrenceValue([ruleRecord({ cadence: 'WEEKLY', weekdays: [] })], []),
    recurrenceValue([ruleRecord({ startDate: '2027-02-29' })], []),
  ]
  for (const value of cases) {
    const text = await sealedBackupWithSetting(value)
    await assert.rejects(
      () => parseBackupText(text),
      /规则|账本|日期|周几|任务/,
      `应拒绝恶意规则：${value.slice(0, 80)}`,
    )
  }
})

test('恶意模板课程 / 未知设置键在写库前被拒绝', async () => {
  const badTemplate = JSON.stringify({
    version: 1,
    nextId: 2,
    templates: [
      {
        id: 1,
        revision: 1,
        name: '模板',
        title: '任务',
        description: null,
        type: null,
        priority: null,
        estimatedMinutes: null,
        submitRequirement: null,
        submitMethod: null,
        courseId: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
  })
  const data = {
    tasks: [],
    courses: [],
    schedules: [],
    taskSources: [],
    images: [],
    attempts: [],
    sources: [],
    refs: [],
    ocrResults: [],
    ocrCandidates: [],
    settings: [
      { key: TASK_TEMPLATES_KEY, value: badTemplate, updatedAt: NOW.toISOString() },
      { key: 'totally.unknown.setting', value: '1', updatedAt: NOW.toISOString() },
    ],
  }
  const text = JSON.stringify(await sealBackupData(data, { now: () => NOW }))
  await assert.rejects(() => parseBackupText(text), /课程|不认识的设置项/)
})
