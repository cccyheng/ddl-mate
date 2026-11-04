import type { Task } from './types'
import { emptyTaskDraft } from './types'
import { normalizeTaskDraft } from './taskDraft'

export const TASK_BATCH_LIMIT = 100
export type TaskBatchAction = { kind: 'complete' } | { kind: 'deadline'; value: string } | { kind: 'clearDeadline' }
export interface TaskBatchTarget { id: number; title: string; fingerprint: string }
export interface TaskBatchRequest { targets: TaskBatchTarget[]; action: TaskBatchAction; generation: number }
export interface TaskBatchResult { committed: true; updatedIds: number[]; unchangedIds: number[] }
export const isBatchEligible = (task: Task): boolean => task.status === 'TODO' || task.status === 'DOING'

export function taskFingerprint(t: Task): string {
  return JSON.stringify([t.id, t.title, t.description, t.courseId, t.type, t.status, t.priority,
    t.deadline, t.estimatedMinutes, t.submitRequirement, t.submitMethod, t.completedAt, t.createdAt, t.updatedAt])
}
export function batchTarget(task: Task): TaskBatchTarget {
  return { id: task.id, title: task.title, fingerprint: taskFingerprint(task) }
}
export function batchDeadline(action: TaskBatchAction): string | null {
  if (action.kind === 'complete' || action.kind === 'clearDeadline') return null
  if (action.kind !== 'deadline' || !action.value?.trim()) throw new Error('请先选择截止日期；清除日期请使用“清除截止日期”。')
  try { return normalizeTaskDraft({ ...emptyTaskDraft(), title: '批量任务', deadline: action.value }).deadline }
  catch { throw new Error('请选择真实有效的截止日期和时间。') }
}
export function validateBatch(request: TaskBatchRequest): void {
  const ids = request.targets.map(t => t.id)
  if (!ids.length || ids.length > TASK_BATCH_LIMIT || new Set(ids).size !== ids.length ||
      request.targets.some(t => !Number.isSafeInteger(t.id) || t.id <= 0 || !t.fingerprint)) {
    throw new Error('请选择 1–100 条不同的未完成任务。')
  }
  batchDeadline(request.action)
}
