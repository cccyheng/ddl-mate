/**
 * 模板 / 重复任务的持久化仓库。
 *
 * 两者都存放在既有 `app_settings` 键值表的**版本化 JSON** 里，因此：
 * - 不改变 `SCHEMA_VERSION`，旧 v1 备份仍可解析；
 * - 备份 / 恢复的严格设置白名单只需认识这两个键，恢复时与其它设置同事务替换；
 * - 模板和规则的删除都**不会**删除任何已创建的任务。
 *
 * 重复任务生成的关键约束（与 UI 契约一致）：
 * - 预览指纹在**事务内部**重新计算并比较，旧预览不能写库；
 * - 规则 + 多条任务 + 生成账本在**同一个事务**里写入，任何一步失败整体回滚；
 * - 任务作者路径复用 `TaskRepository.createWithinTransaction`（规范校验 + 原文写入），
 *   不嵌套事务、不手写另一套 INSERT；
 * - 账本按 `(规则ID, 日期)` 去重；用户删掉某次任务后账本保留，重试时明确跳过，不偷偷重建。
 */

import { APP_SETTINGS_KEYS } from '../db/schema'
import type { SqliteDatabase } from '../db/types'
import { NotFoundError, ValidationError } from './errors'
import {
  applyTemplate,
  decodeTemplateStore,
  emptyTemplateStore,
  encodeTemplateStore,
  normalizeTemplateInput,
  TEMPLATE_LIMITS,
  type ApplyTemplateResult,
  type TaskTemplate,
  type TaskTemplateInput,
  type TaskTemplateStore,
} from './taskTemplate'
import {
  buildRecurrencePreview,
  decodeRecurrenceStore,
  encodeRecurrenceStore,
  emptyRecurrenceStore,
  RECURRENCE_LIMITS,
  taskDraftForOccurrence,
  type RecurrenceLedgerEntry,
  type RecurrencePreview,
  type RecurrencePreviewResult,
  type RecurrenceRule,
  type RecurrenceRuleInput,
  type RecurrenceStore,
} from './recurrence'
import type { TaskRepository } from './taskRepository'

/** 预览之后规则 / 模板 / 课程发生了真实变化：拒绝写入，要求用户重新预览。 */
export class StalePreviewError extends Error {
  override readonly name = 'StalePreviewError'
}

export interface TemplateSnapshot {
  templates: TaskTemplate[]
  rules: RecurrenceRule[]
  ledger: RecurrenceLedgerEntry[]
  /**
   * 持久化的下一规则 ID。新建规则预览把它纳入指纹，第一次生成消耗后
   * 同一份确认预览就无法再次通过事务内权威校验（防重复系列）。
   */
  nextRuleId: number
  /** 任一键损坏时的可读原因；界面应显示它，而不是把坏数据当成空库。 */
  error: string | null
}

export interface GenerateRecurrenceOptions {
  /** 新建规则传 `null`；编辑既有规则传规则 id。 */
  ruleId: number | null
  /** 用户确认预览时拿到的指纹。 */
  expectedFingerprint: string
}

export interface GenerateRecurrenceOutcome {
  committed: true
  ruleId: number
  ruleRevision: number
  createdTaskIds: number[]
  created: number
  /** 账本里已经创建、且任务仍在：明确跳过。 */
  skippedExisting: number
  /** 账本里已经创建、但任务已被用户删除：明确跳过，绝不重建。 */
  skippedDeleted: number
  skippedExplicit: number
  /** 本次生成后仍可创建的候选数（正常为 0）。 */
  remainingAvailable: number
}

async function readSetting(db: SqliteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string; updated_at: string }>(
    'SELECT value, updated_at FROM app_settings WHERE key = ?;',
    [key],
  )
  return row ? String(row.value) : null
}

async function writeSetting(db: SqliteDatabase, key: string, value: string, nowIso: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
    [key, value, nowIso],
  )
}

function decodeOrThrow<T>(decoded: { ok: boolean; reason: string | null; store: T }, label: string): T {
  if (!decoded.ok) throw new ValidationError(`${label}读不出来，已停止写入。`, { storage: decoded.reason ?? '数据格式不合法。' })
  return decoded.store
}

function assertStoreSize(value: string, label: string, maxBytes: number): void {
  if (value.length > maxBytes) {
    throw new ValidationError(`${label}超过本机大小上限，未写入。`, { storage: '请先删除一些不再需要的模板或规则。' })
  }
}

export class TaskTemplateRepository {
  private readonly db: SqliteDatabase
  private readonly tasks: TaskRepository
  private readonly now: () => Date

  constructor(db: SqliteDatabase, tasks: TaskRepository, now: () => Date = () => new Date()) {
    this.db = db
    this.tasks = tasks
    this.now = now
  }

  /* ------------------------------ 读取 ------------------------------ */

  /** 只读快照：模板 + 规则 + 账本。任一键损坏时给出可读原因，不崩整个 App。 */
  async loadSnapshot(): Promise<TemplateSnapshot> {
    const [templateRaw, recurrenceRaw] = await Promise.all([
      readSetting(this.db, APP_SETTINGS_KEYS.TASK_TEMPLATES),
      readSetting(this.db, APP_SETTINGS_KEYS.TASK_RECURRENCE),
    ])
    const templates = decodeTemplateStore(templateRaw)
    const recurrence = decodeRecurrenceStore(recurrenceRaw)
    return {
      templates: templates.ok ? templates.store.templates : [],
      rules: recurrence.ok ? recurrence.store.rules : [],
      ledger: recurrence.ok ? recurrence.store.ledger : [],
      nextRuleId: recurrence.ok ? recurrence.store.nextRuleId : 1,
      error: !templates.ok ? `模板库读不出来：${templates.reason}` : !recurrence.ok ? `重复规则库读不出来：${recurrence.reason}` : null,
    }
  }

  private async readTemplateStore(): Promise<TaskTemplateStore> {
    return decodeOrThrow(decodeTemplateStore(await readSetting(this.db, APP_SETTINGS_KEYS.TASK_TEMPLATES)), '模板库')
  }

  private async readRecurrenceStore(): Promise<RecurrenceStore> {
    return decodeOrThrow(decodeRecurrenceStore(await readSetting(this.db, APP_SETTINGS_KEYS.TASK_RECURRENCE)), '重复规则库')
  }

  private async writeTemplateStore(store: TaskTemplateStore, nowIso: string): Promise<void> {
    const encoded = encodeTemplateStore(store)
    assertStoreSize(encoded, '模板库', TEMPLATE_LIMITS.maxStoreBytes)
    await writeSetting(this.db, APP_SETTINGS_KEYS.TASK_TEMPLATES, encoded, nowIso)
  }

  private async writeRecurrenceStore(store: RecurrenceStore, nowIso: string): Promise<void> {
    const encoded = encodeRecurrenceStore(store)
    assertStoreSize(encoded, '重复规则库', RECURRENCE_LIMITS.maxStoreBytes)
    await writeSetting(this.db, APP_SETTINGS_KEYS.TASK_RECURRENCE, encoded, nowIso)
  }

  private async courseIds(): Promise<Set<number>> {
    const rows = await this.db.getAllAsync<{ id: number }>('SELECT id FROM courses ORDER BY id ASC;')
    return new Set(rows.map((row) => Number(row.id)))
  }

  private async taskIds(): Promise<Set<number>> {
    const rows = await this.db.getAllAsync<{ id: number }>('SELECT id FROM tasks ORDER BY id ASC;')
    return new Set(rows.map((row) => Number(row.id)))
  }

  /* ------------------------------ 模板 ------------------------------ */

  async createTemplate(input: TaskTemplateInput): Promise<TaskTemplate> {
    const normalized = normalizeTemplateInput(input)
    const nowIso = this.now().toISOString()
    let created: TaskTemplate | null = null
    await this.db.withTransactionAsync(async () => {
      const store = await this.readTemplateStore()
      if (store.templates.length >= TEMPLATE_LIMITS.maxTemplates) {
        throw new ValidationError(`模板最多保存 ${TEMPLATE_LIMITS.maxTemplates} 个，请先删除不用的模板。`, {
          name: '模板数量已达上限。',
        })
      }
      created = {
        id: store.nextId,
        revision: 1,
        name: normalized.name,
        title: normalized.title,
        description: normalized.description,
        type: normalized.type,
        priority: normalized.priority,
        estimatedMinutes: normalized.estimatedMinutes,
        submitRequirement: normalized.submitRequirement,
        submitMethod: normalized.submitMethod,
        courseId: normalized.courseId,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      store.templates.push(created)
      store.nextId += 1
      await this.writeTemplateStore(store, nowIso)
    })
    if (!created) throw new ValidationError('模板没有写入。', { storage: '未知错误。' })
    return created
  }

  async updateTemplate(id: number, input: TaskTemplateInput): Promise<TaskTemplate> {
    const normalized = normalizeTemplateInput(input)
    const nowIso = this.now().toISOString()
    let updated: TaskTemplate | null = null
    await this.db.withTransactionAsync(async () => {
      const store = await this.readTemplateStore()
      const index = store.templates.findIndex((template) => template.id === id)
      if (index < 0) throw new NotFoundError(`模板 #${id} 不存在（可能已被删除）。`)
      const existing = store.templates[index]!
      updated = {
        id: existing.id,
        // 单调 +1：即使编辑发生在同一毫秒，旧预览也一定会失效。
        revision: existing.revision + 1,
        name: normalized.name,
        title: normalized.title,
        description: normalized.description,
        type: normalized.type,
        priority: normalized.priority,
        estimatedMinutes: normalized.estimatedMinutes,
        submitRequirement: normalized.submitRequirement,
        submitMethod: normalized.submitMethod,
        courseId: normalized.courseId,
        createdAt: existing.createdAt,
        updatedAt: nowIso,
      }
      store.templates = store.templates.map((template) => (template.id === id ? updated! : template))
      await this.writeTemplateStore(store, nowIso)
    })
    if (!updated) throw new ValidationError('模板没有更新。', { storage: '未知错误。' })
    return updated
  }

  /**
   * 保存“把这条任务存为模板”。
   *
   * 源任务必须**现在仍然存在**：删除后从旧页面点保存会得到 `NotFoundError`，
   * 绝不会用一份过期快照凭空造出一个来源不明的模板。
   */
  async createTemplateFromTask(taskId: number, input: TaskTemplateInput): Promise<TaskTemplate> {
    const normalized = normalizeTemplateInput(input)
    const nowIso = this.now().toISOString()
    let created: TaskTemplate | null = null
    await this.db.withTransactionAsync(async () => {
      const source = await this.tasks.getById(taskId)
      if (!source) throw new NotFoundError(`任务 #${taskId} 不在本机（可能已被删除），不能保存为模板。`)
      const store = await this.readTemplateStore()
      if (store.templates.length >= TEMPLATE_LIMITS.maxTemplates) {
        throw new ValidationError(`模板最多保存 ${TEMPLATE_LIMITS.maxTemplates} 个，请先删除不用的模板。`, {
          name: '模板数量已达上限。',
        })
      }
      created = {
        id: store.nextId,
        revision: 1,
        name: normalized.name,
        title: normalized.title,
        description: normalized.description,
        type: normalized.type,
        priority: normalized.priority,
        estimatedMinutes: normalized.estimatedMinutes,
        submitRequirement: normalized.submitRequirement,
        submitMethod: normalized.submitMethod,
        courseId: normalized.courseId,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
      store.templates.push(created)
      store.nextId += 1
      await this.writeTemplateStore(store, nowIso)
    })
    if (!created) throw new ValidationError('模板没有写入。', { storage: '未知错误。' })
    return created
  }

  /** 删除模板：只删模板本身；已有任务、以及引用它的规则内容都不动。 */
  async removeTemplate(id: number): Promise<void> {
    const nowIso = this.now().toISOString()
    await this.db.withTransactionAsync(async () => {
      const templateStore = await this.readTemplateStore()
      if (!templateStore.templates.some((template) => template.id === id)) {
        throw new NotFoundError(`模板 #${id} 不存在（可能已被删除）。`)
      }
      templateStore.templates = templateStore.templates.filter((template) => template.id !== id)
      await this.writeTemplateStore(templateStore, nowIso)

      /**
       * 规则里的内容已经是快照；这里只把“来源模板”引用置空，避免界面上继续指向
       * 一个不存在的模板。不会碰规则内容，也不会碰任何已创建任务。
       */
      const recurrenceStore = await this.readRecurrenceStore()
      let changed = false
      recurrenceStore.rules = recurrenceStore.rules.map((rule) => {
        if (rule.templateId !== id) return rule
        changed = true
        return { ...rule, templateId: null, updatedAt: nowIso }
      })
      if (changed) await this.writeRecurrenceStore(recurrenceStore, nowIso)
    })
  }

  /** 应用模板 → 可编辑草稿（只读；不写任务表）。 */
  async applyTemplate(templateId: number): Promise<ApplyTemplateResult> {
    const store = await this.readTemplateStore()
    const template = store.templates.find((row) => row.id === templateId)
    if (!template) throw new NotFoundError(`模板 #${templateId} 不存在（可能已被删除）。`)
    const courses = await this.courseIds()
    return applyTemplate(template, courses)
  }

  /* --------------------------- 重复任务生成 --------------------------- */

  /**
   * 在单个事务里创建规则（或更新规则）+ 该规则尚未生成的候选任务 + 账本。
   *
   * 调用前界面必须已经展示过实际日期 / 任务预览；`expectedFingerprint` 在事务内
   * 重新计算，规则内容、来源模板 revision、课程是否存在、规则 revision 任一变化
   * 都会抛 {@link StalePreviewError}，一个字节都不写。
   */
  async generateRecurrence(
    input: RecurrenceRuleInput,
    options: GenerateRecurrenceOptions,
  ): Promise<GenerateRecurrenceOutcome> {
    const nowIso = this.now().toISOString()
    let outcome: GenerateRecurrenceOutcome | null = null

    await this.db.withTransactionAsync(async () => {
      const templateStore = await this.readTemplateStore()
      const recurrenceStore = await this.readRecurrenceStore()
      const existingRule =
        options.ruleId === null ? null : (recurrenceStore.rules.find((rule) => rule.id === options.ruleId) ?? null)
      if (options.ruleId !== null && !existingRule) {
        throw new NotFoundError(`重复规则 #${options.ruleId} 不存在（可能已被删除）。`)
      }
      if (options.ruleId === null && recurrenceStore.rules.length >= RECURRENCE_LIMITS.maxRules) {
        throw new ValidationError(`重复规则最多保存 ${RECURRENCE_LIMITS.maxRules} 条，请先删除不用的规则。`, {
          name: '规则数量已达上限。',
        })
      }

      const [courseIds, taskIds] = await Promise.all([this.courseIds(), this.taskIds()])
      const preview = buildRecurrencePreview(input, {
        courseIds,
        templates: new Map(
          templateStore.templates.map((template) => [
            template.id,
            { updatedAt: template.updatedAt, revision: template.revision },
          ]),
        ),
        ledger: recurrenceStore.ledger,
        existingTaskIds: taskIds,
        ruleId: options.ruleId,
        ruleRevision: existingRule?.revision ?? 0,
        // 事务里读到的持久化值：第一次生成后 nextRuleId 必然已 +1，
        // 同一份新规则确认预览的重放会在指纹比较处被拒绝。
        nextRuleId: recurrenceStore.nextRuleId,
      })
      if (!preview.ok) throw new ValidationError(preview.reason, preview.fields)
      if (preview.blockedReason) {
        throw new ValidationError(preview.blockedReason, { courseId: '请重新选择课程或改为不关联课程。' })
      }
      if (preview.fingerprint !== options.expectedFingerprint) {
        throw new StalePreviewError('预览之后规则、来源模板或课程发生了变化；请重新预览并确认后再创建。')
      }

      const nextLedgerCount = recurrenceStore.ledger.length + preview.availableCount
      if (nextLedgerCount > RECURRENCE_LIMITS.maxLedgerEntries) {
        throw new ValidationError(`生成账本最多保存 ${RECURRENCE_LIMITS.maxLedgerEntries} 条记录，请先清理不再使用的规则。`, {
          storage: '账本已满。',
        })
      }

      const ruleId = existingRule ? existingRule.id : recurrenceStore.nextRuleId
      const rule: RecurrenceRule = {
        ...preview.rule,
        id: ruleId,
        revision: existingRule ? existingRule.revision + 1 : 1,
        createdAt: existingRule ? existingRule.createdAt : nowIso,
        updatedAt: nowIso,
      }

      const createdTaskIds: number[] = []
      const createdEntries: RecurrenceLedgerEntry[] = []
      for (const occurrence of preview.occurrences) {
        if (occurrence.status !== 'AVAILABLE') continue
        const taskId = await this.tasks.createWithinTransaction(taskDraftForOccurrence(preview.rule, occurrence))
        createdTaskIds.push(taskId)
        createdEntries.push({
          ruleId,
          date: occurrence.date,
          taskId,
          status: 'CREATED',
          createdAt: nowIso,
        })
      }

      recurrenceStore.rules = existingRule
        ? recurrenceStore.rules.map((row) => (row.id === ruleId ? rule : row))
        : [...recurrenceStore.rules, rule]
      if (!existingRule) recurrenceStore.nextRuleId = ruleId + 1
      recurrenceStore.ledger = [...recurrenceStore.ledger, ...createdEntries]
      await this.writeRecurrenceStore(recurrenceStore, nowIso)

      outcome = {
        committed: true,
        ruleId,
        ruleRevision: rule.revision,
        createdTaskIds,
        created: createdTaskIds.length,
        skippedExisting: preview.createdCount,
        skippedDeleted: preview.deletedCount,
        skippedExplicit: preview.skippedCount,
        remainingAvailable: 0,
      }
    })

    if (!outcome) throw new ValidationError('重复任务没有写入。', { storage: '未知错误。' })
    return outcome
  }

  /** 删除规则 + 它的账本；**不删除**任何已经创建的任务。 */
  async removeRecurrenceRule(id: number): Promise<void> {
    const nowIso = this.now().toISOString()
    await this.db.withTransactionAsync(async () => {
      const store = await this.readRecurrenceStore()
      if (!store.rules.some((rule) => rule.id === id)) {
        throw new NotFoundError(`重复规则 #${id} 不存在（可能已被删除）。`)
      }
      store.rules = store.rules.filter((rule) => rule.id !== id)
      store.ledger = store.ledger.filter((entry) => entry.ruleId !== id)
      await this.writeRecurrenceStore(store, nowIso)
    })
  }

  /* --------------------------- 只读预览 --------------------------- */

  /** 供 store 在**内存快照**上计算预览（真正的权威复查在生成事务内）。 */
  static previewWithSnapshot(
    input: RecurrenceRuleInput,
    snapshot: TemplateSnapshot,
    courseIds: ReadonlySet<number>,
    taskIds: ReadonlySet<number>,
    ruleId: number | null,
  ): RecurrencePreviewResult {
    const rule = ruleId === null ? null : (snapshot.rules.find((row) => row.id === ruleId) ?? null)
    return buildRecurrencePreview(input, {
      courseIds,
      templates: new Map(
        snapshot.templates.map((template) => [
          template.id,
          { updatedAt: template.updatedAt, revision: template.revision },
        ]),
      ),
      ledger: snapshot.ledger,
      existingTaskIds: taskIds,
      ruleId,
      ruleRevision: rule?.revision ?? 0,
      nextRuleId: snapshot.nextRuleId,
    })
  }
}

export { emptyRecurrenceStore, emptyTemplateStore }
export type { RecurrencePreview, RecurrencePreviewResult }
