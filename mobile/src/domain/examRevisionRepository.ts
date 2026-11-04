/** Caller must serialize through AppStore's common write queue and restore-generation gate. */
import type { SqliteDatabase } from '../db/types'
import { parseOffsetIso } from './datetime'
import { buildRevisionPreview, type RevisionInput } from './examRevision'
import { TaskRepository } from './taskRepository'
import { emptyTaskDraft } from './types'

export const EXAM_REVISION_KEY = 'exam_revision.v1'
export const EXAM_PLAN_LIMIT = 100
export interface ExamRevisionPlan {
  id: number
  examId: number
  examTitle: string
  createdAt: string
  fingerprint: string
  taskIds: number[]
}
export interface ExamRevisionStore { version: 1; nextId: number; plans: ExamRevisionPlan[] }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
}
/** Strict decoder shared with backup validation; missing key is an empty store, corruption throws. */
export function decodeExamRevisionStore(raw: string | null): ExamRevisionStore {
  if (raw === null) return { version: 1, nextId: 1, plans: [] }
  const invalid = (): never => { throw new Error('复习安排记录无法读取，请保留备份后重试。') }
  if (raw.length > 500_000) return invalid()
  let data: unknown
  try { data = JSON.parse(raw) } catch { return invalid() }
  if (!keys(data, ['version', 'nextId', 'plans']) || data.version !== 1 || !positive(data.nextId) ||
      !Array.isArray(data.plans) || data.plans.length > EXAM_PLAN_LIMIT) return invalid()
  const ids = new Set<number>(), allTaskIds = new Set<number>()
  for (const plan of data.plans) {
    if (!keys(plan, ['id', 'examId', 'examTitle', 'createdAt', 'fingerprint', 'taskIds']) ||
        !positive(plan.id) || plan.id >= data.nextId || ids.has(plan.id) || !positive(plan.examId) ||
        typeof plan.examTitle !== 'string' || !plan.examTitle.trim() || plan.examTitle.length > 200 ||
        typeof plan.createdAt !== 'string' || !parseOffsetIso(plan.createdAt) ||
        typeof plan.fingerprint !== 'string' || plan.fingerprint.length < 1 || plan.fingerprint.length > 20_000 ||
        !Array.isArray(plan.taskIds) || plan.taskIds.length < 1 || plan.taskIds.length > 30) return invalid()
    ids.add(plan.id)
    for (const id of plan.taskIds) {
      if (!positive(id) || id === plan.examId || allTaskIds.has(id)) return invalid()
      allTaskIds.add(id)
    }
  }
  return data as unknown as ExamRevisionStore
}

export class ExamRevisionRepository {
  private readonly db: SqliteDatabase
  private readonly tasks: TaskRepository
  private readonly now: () => Date
  constructor(db: SqliteDatabase, tasks: TaskRepository, now: () => Date = () => new Date()) {
    this.db = db; this.tasks = tasks; this.now = now
  }
  async load(): Promise<ExamRevisionStore> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?;', [EXAM_REVISION_KEY])
    return decodeExamRevisionStore(row?.value ?? null)
  }
  async create(input: {
    examId: number
    planId: number
    draft: RevisionInput
    fingerprint: string
  }): Promise<{ committed: true; alreadyCreated: boolean; plan: ExamRevisionPlan }> {
    if (!positive(input.examId) || !positive(input.planId)) throw new Error('考试或安排编号无效，请重新预览。')
    let result: { committed: true; alreadyCreated: boolean; plan: ExamRevisionPlan } | undefined
    await this.db.withTransactionAsync(async () => {
      const store = await this.load()
      const existing = store.plans.find(plan => plan.id === input.planId)
      if (existing) {
        if (existing.examId !== input.examId || existing.fingerprint !== input.fingerprint) throw new Error('安排已经变化，请重新预览。')
        // Return the committed result even if generated tasks have since been edited/deleted.
        result = { committed: true, alreadyCreated: true, plan: existing }
        return
      }
      if (input.planId !== store.nextId) throw new Error('安排已经变化，请重新预览。')
      if (store.plans.length >= EXAM_PLAN_LIMIT) throw new Error('复习安排已达到保存上限。')
      const now = this.now(), exam = await this.tasks.getById(input.examId)
      const preview = buildRevisionPreview(exam, input.draft, now)
      if (!preview.ok) throw new Error(preview.reason)
      if (preview.preview.fingerprint !== input.fingerprint) throw new Error('考试或日期已变化，请重新预览后再创建。')
      if (exam!.courseId !== null) {
        const course = await this.db.getFirstAsync<{ id: number }>('SELECT id FROM courses WHERE id = ?;', [exam!.courseId])
        if (!course) throw new Error('课程已不存在，请重新选择考试。')
      }
      const taskIds: number[] = []
      for (const session of preview.preview.sessions) {
        taskIds.push(await this.tasks.createWithinTransaction({
          ...emptyTaskDraft(), title: session.title, description: `为「${exam!.title}」复习：${session.topic}`,
          courseId: exam!.courseId, type: 'OTHER', deadline: session.date,
          estimatedMinutes: String(session.minutes),
        }))
      }
      const plan: ExamRevisionPlan = {
        id: input.planId, examId: input.examId, examTitle: exam!.title,
        createdAt: now.toISOString(), fingerprint: input.fingerprint, taskIds,
      }
      const next: ExamRevisionStore = { version: 1, nextId: store.nextId + 1, plans: [...store.plans, plan] }
      const encoded = JSON.stringify(next)
      decodeExamRevisionStore(encoded)
      await this.db.runAsync(
        'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;',
        [EXAM_REVISION_KEY, encoded, now.toISOString()],
      )
      result = { committed: true, alreadyCreated: false, plan }
    })
    if (!result) throw new Error('复习安排未完成，请重试。')
    return result
  }
}
