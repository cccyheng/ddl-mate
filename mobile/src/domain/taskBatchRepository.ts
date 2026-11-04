import type { SqliteDatabase } from '../db/types'
import type { TaskRepository } from './taskRepository'
import { batchDeadline, isBatchEligible, taskFingerprint, validateBatch, type TaskBatchRequest, type TaskBatchResult } from './taskBatch'

/** Called within the AppStore write queue. One transaction; no nested repository writes. */
export async function applyTaskBatch(db: SqliteDatabase, tasks: TaskRepository, request: TaskBatchRequest, now = new Date()): Promise<TaskBatchResult> {
  validateBatch(request)
  const deadline = batchDeadline(request.action)
  const result: TaskBatchResult = { committed: true, updatedIds: [], unchangedIds: [] }
  const stamp = now.toISOString()
  await db.withTransactionAsync(async () => {
    const current = []
    for (const target of request.targets) {
      const task = await tasks.getById(target.id)
      if (!task || !isBatchEligible(task) || taskFingerprint(task) !== target.fingerprint) {
        throw new Error(`“${target.title}”已变化或不存在。整批未保存，请刷新后重新选择并预览。`)
      }
      current.push(task)
    }
    for (const task of current) {
      if (request.action.kind !== 'complete' && task.deadline === deadline) {
        result.unchangedIds.push(task.id)
        continue
      }
      const write = request.action.kind === 'complete'
        ? await db.runAsync('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', ['DONE', task.completedAt ?? stamp, stamp, task.id])
        : await db.runAsync('UPDATE tasks SET deadline = ?, updated_at = ? WHERE id = ?', [deadline, stamp, task.id])
      if (write.changes !== 1) throw new Error('任务已变化，整批未保存，请刷新后重新核对。')
      result.updatedIds.push(task.id)
    }
  })
  return result
}
