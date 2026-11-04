/**
 * 任务模板：纯逻辑 + **真实 SQLite** 仓库测试。
 *
 * 覆盖：
 * - 只保存用户显式勾选的可复用内容（不复制截止时间 / 完成状态 / 原文 / 截图 / 通知）；
 * - 空白预计用时保持空白，不补默认分钟；
 * - 应用模板只产生可编辑草稿，不写任务表；
 * - 源任务不存在时拒绝“存为模板”；
 * - 课程被删除后应用模板会提示复核，而不是静默挂错课程；
 * - 模板删除不影响任何已创建任务，也不影响规则内容快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTestDatabase, taskDraft, courseDraft } from './helpers/sqliteHarness.mjs'
import {
  applyTemplate,
  decodeTemplateStore,
  normalizeTemplateInput,
  TEMPLATE_LIMITS,
  templateFieldsOf,
} from '../src/domain/taskTemplate.ts'
import { TaskTemplateRepository } from '../src/domain/taskTemplateRepository.ts'
import { ValidationError } from '../src/domain/errors.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z')

function templateInput(overrides = {}) {
  return {
    name: '实验报告模板',
    fields: ['title', 'description', 'type', 'priority', 'estimatedMinutes', 'submitRequirement', 'submitMethod', 'courseId'],
    title: '实验报告',
    description: '按实验指导书写',
    type: 'HOMEWORK',
    priority: 4,
    estimatedMinutes: '90',
    submitRequirement: 'PDF',
    submitMethod: '教学网',
    courseId: null,
    ...overrides,
  }
}

test('模板只保留显式勾选的字段；未勾选的截止时间/状态/原文永远不会进入模板', () => {
  const normalized = normalizeTemplateInput(
    templateInput({
      fields: ['title', 'estimatedMinutes'],
      description: '这条说明没有被勾选，不应保存',
      submitRequirement: '也不应保存',
      courseId: 12,
    }),
  )
  assert.equal(normalized.title, '实验报告')
  assert.equal(normalized.estimatedMinutes, 90)
  assert.equal(normalized.description, null)
  assert.equal(normalized.submitRequirement, null)
  assert.equal(normalized.submitMethod, null)
  assert.equal(normalized.courseId, null)
  assert.equal(normalized.type, null)
  assert.equal(normalized.priority, null)
})

test('空白预计用时保持空白，不被补成 0 或默认分钟', () => {
  const normalized = normalizeTemplateInput(templateInput({ fields: ['title', 'estimatedMinutes'], estimatedMinutes: '' }))
  assert.equal(normalized.estimatedMinutes, null)
  const template = {
    id: 1,
    ...normalized,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }
  const applied = applyTemplate(template, new Set())
  assert.equal(applied.draft.estimatedMinutes, '')
  assert.equal(applied.draft.deadline, '')
  assert.equal(applied.draft.status, 'TODO')
  assert.equal(applied.draft.originalText, '')
})

test('模板校验：名称必填、至少一项内容、勾选标题必须填标题、非法分钟与课程拒绝', () => {
  const cases = [
    [{ name: '' }, 'name'],
    [{ fields: [], title: 'x' }, 'fields'],
    [{ fields: ['estimatedMinutes'], estimatedMinutes: '' }, 'fields'],
    [{ fields: ['title'], title: '   ' }, 'title'],
    [{ fields: ['estimatedMinutes'], estimatedMinutes: '1.5' }, 'estimatedMinutes'],
    [{ fields: ['courseId'], courseId: 0 }, 'courseId'],
  ]
  for (const [overrides, field] of cases) {
    assert.throws(
      () => normalizeTemplateInput(templateInput(overrides)),
      (cause) => cause instanceof ValidationError && Boolean(cause.fields[field]),
      `应拒绝 ${field}`,
    )
  }
})

test('应用模板：只产生草稿，可选字段来自模板，状态固定 TODO，课程缺失时提示复核', () => {
  const template = {
    id: 3,
    name: '作业',
    title: '第 3 次作业',
    description: null,
    type: 'HOMEWORK',
    priority: 2,
    estimatedMinutes: 45,
    submitRequirement: null,
    submitMethod: '邮箱',
    courseId: 99,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }
  const applied = applyTemplate(template, new Set([1, 2]))
  assert.equal(applied.draft.title, '第 3 次作业')
  assert.equal(applied.draft.courseId, null, '缺失课程绝不静默挂到别的课程上')
  assert.equal(applied.draft.submitMethod, '邮箱')
  assert.equal(applied.draft.status, 'TODO')
  assert.equal(applied.draft.deadline, '')
  assert.equal(applied.warnings.length, 1)
  assert.match(applied.warnings[0], /课程已不在本机/)
  assert.deepEqual(templateFieldsOf(template), ['title', 'type', 'priority', 'estimatedMinutes', 'submitMethod', 'courseId'])
})

test('模板仓库：从任务保存、读回、应用；源任务一个字段都不被改写', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft({ name: '数据结构' }))
    const task = (
      await ctx.tasks.create(
        taskDraft({
          title: '数据结构第 3 次作业',
          description: '写实验报告',
          courseId: course.id,
          status: 'DOING',
          priority: 5,
          deadline: '2026-10-15T22:00',
          estimatedMinutes: '120',
          submitRequirement: 'PDF + 源码',
          originalText: '原始通知：10 月 15 日交',
        }),
      )
    ).task
    assert.ok(task)

    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const template = await repo.createTemplateFromTask(task.id, {
      ...templateInput({ name: '数据作业模板', courseId: course.id }),
    })
    assert.equal(template.name, '数据作业模板')
    assert.equal(template.courseId, course.id)
    assert.equal(template.title, '实验报告')
    // 模板结构里没有 deadline / status / originalText / completedAt。
    assert.equal('deadline' in template, false)
    assert.equal('status' in template, false)
    assert.equal('originalText' in template, false)

    const before = await ctx.tasks.getById(task.id)
    const applied = await repo.applyTemplate(template.id)
    assert.equal(applied.draft.status, 'TODO')
    assert.equal(applied.draft.deadline, '')
    assert.equal(applied.draft.originalText, '')
    assert.equal(applied.draft.courseId, course.id)
    const after = await ctx.tasks.getById(task.id)
    assert.deepEqual(after, before, '应用模板绝不能修改源任务')

    // 新建仓库实例模拟重启后读回。
    const reopened = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const snapshot = await reopened.loadSnapshot()
    assert.equal(snapshot.error, null)
    assert.equal(snapshot.templates.length, 1)
    assert.equal(snapshot.templates[0].name, '数据作业模板')
  } finally {
    ctx.close()
  }
})

test('模板仓库：源任务已删除时拒绝保存为模板', async () => {
  const ctx = await createTestDatabase()
  try {
    const task = (await ctx.tasks.create(taskDraft({ title: '会被删掉的任务' }))).task
    assert.ok(task)
    await ctx.tasks.remove(task.id)
    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    await assert.rejects(
      () => repo.createTemplateFromTask(task.id, templateInput()),
      /不在本机/,
    )
    assert.equal((await repo.loadSnapshot()).templates.length, 0)
  } finally {
    ctx.close()
  }
})

test('模板仓库：编辑模板影响之后的应用；删除模板不影响任何既有任务', async () => {
  const ctx = await createTestDatabase()
  try {
    const source = (await ctx.tasks.create(taskDraft({ title: '源任务' }))).task
    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const created = await repo.createTemplateFromTask(source.id, templateInput({ name: '旧名字' }))
    const updated = await repo.updateTemplate(created.id, templateInput({ name: '新名字', title: '新标题' }))
    assert.equal(updated.createdAt, created.createdAt)
    const applied = await repo.applyTemplate(created.id)
    assert.equal(applied.draft.title, '新标题')

    // 先用模板生成一条真实任务（模拟“已经用模板建过任务”）。
    const existing = (await ctx.tasks.create(taskDraft({ title: '已经建好的任务' }))).task
    await repo.removeTemplate(created.id)
    assert.equal((await repo.loadSnapshot()).templates.length, 0)
    assert.deepEqual(await ctx.tasks.getById(existing.id), existing)
    assert.deepEqual(await ctx.tasks.getById(source.id), source)
  } finally {
    ctx.close()
  }
})

test('模板仓库：课程被删除后应用模板会提示复核并留空，而不是挂错课程', async () => {
  const ctx = await createTestDatabase()
  try {
    const course = await ctx.courses.create(courseDraft({ name: '会删除的课程' }))
    const source = (await ctx.tasks.create(taskDraft({ title: '源任务', courseId: course.id }))).task
    const repo = new TaskTemplateRepository(ctx.db, ctx.tasks, () => NOW)
    const template = await repo.createTemplateFromTask(source.id, templateInput({ courseId: course.id }))
    await ctx.courses.removeCourse(course.id, { confirmed: true })
    const applied = await repo.applyTemplate(template.id)
    assert.equal(applied.draft.courseId, null)
    assert.match(applied.warnings.join(''), /课程已不在本机/)
  } finally {
    ctx.close()
  }
})

test('模板存储解码：坏 JSON / 未知版本 / 超量 / 重复 ID 都返回可读原因', () => {
  assert.equal(decodeTemplateStore(null).ok, true)
  assert.equal(decodeTemplateStore('{').ok, false)
  assert.equal(decodeTemplateStore(JSON.stringify({ version: 2, nextId: 1, templates: [] })).ok, false)
  const tooMany = {
    version: 1,
    nextId: TEMPLATE_LIMITS.maxTemplates + 2,
    templates: Array.from({ length: TEMPLATE_LIMITS.maxTemplates + 1 }, (_, index) => ({
      id: index + 1,
      name: 't',
      title: 'x',
      description: null,
      type: null,
      priority: null,
      estimatedMinutes: null,
      submitRequirement: null,
      submitMethod: null,
      courseId: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
  }
  assert.equal(decodeTemplateStore(JSON.stringify(tooMany)).ok, false)
  const duplicate = {
    version: 1,
    nextId: 3,
    templates: [
      {
        id: 1,
        name: 'a',
        title: 'x',
        description: null,
        type: null,
        priority: null,
        estimatedMinutes: null,
        submitRequirement: null,
        submitMethod: null,
        courseId: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 1,
        name: 'b',
        title: 'y',
        description: null,
        type: null,
        priority: null,
        estimatedMinutes: null,
        submitRequirement: null,
        submitMethod: null,
        courseId: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ],
  }
  assert.equal(decodeTemplateStore(JSON.stringify(duplicate)).ok, false)
})
