/**
 * 「任务原图」仓库：把**截图库里已经归档的原图**显式关联到某条任务。
 *
 * 这一层只做四件事（界面不写 SQL、不直接碰数据库）：
 * 1. `listPhotos(taskId)`：读这条任务当前关联了哪些原图（按尝试分组，绝不重复）；
 * 2. `listAddable(taskId, limit)`：读最近保存、还没手动关联到这条任务的原图；
 * 3. `attach(taskId, attemptId)`：在**一个事务里**确认任务与原图都还在，再写关联；
 * 4. `detach(taskId, attemptId)`：只删这一条任务的 `MANUAL_TASK_PHOTO` 引用。
 *
 * 边界（逐条对应授权书）：
 * - 复用既有 `screenshot_refs` / `screenshot_attempts`，**没有迁移、没有新表、没有新依赖**；
 * - 只允许有归档文件、且不是 `ARCHIVE_FAILED` 的尝试被关联；
 *   识别失败 / 取消（`FAILED` / `CANCELLED`）但原图仍在的尝试**可以**关联；
 * - 重复添加是幂等的：同一条任务里的同一张原图（按尝试或按归档文件识别）只保留一条
 *   `MANUAL_TASK_PHOTO` 引用；
 * - 解除关联只删这条任务的这一种引用；原图字节、OCR 结果、课程 / 课表 / 其它任务的
 *   历史引用一律不动；
 * - 任务被删除后，关联读取返回「任务不在」，添加 / 解除都会被拒绝（零写入）。
 */

import type { SqliteDatabase } from '../db/types'
import type { ScreenshotAttemptSource, ScreenshotAttemptStatus } from './screenshotLibraryRepository'

/** 本模块唯一的规范关系名。只有这种关系是用户可解除的。 */
export const MANUAL_TASK_PHOTO = 'MANUAL_TASK_PHOTO'

/** 从截图库添加时可展示的最近原图上限（界面会明确写出这个数字）。 */
export const TASK_PHOTO_CANDIDATE_LIMIT = 300

export type TaskPhotoFailureCode =
  | 'INVALID_TASK_ID'
  | 'INVALID_PHOTO_ID'
  | 'TASK_MISSING'
  | 'PHOTO_MISSING'
  | 'PHOTO_NOT_ARCHIVED'
  | 'WRITE_FAILED'

/** 任务原图展示所需的截图尝试字段（不含全量上传 / 编码细节）。 */
export interface TaskPhotoAttempt {
  id: number
  capturedAt: string
  source: ScreenshotAttemptSource
  status: ScreenshotAttemptStatus
  archivedPath: string | null
  byteLength: number | null
  width: number | null
  height: number | null
  format: string | null
  mimeType: string | null
  note: string | null
}

/**
 * 一张挂在任务上的原图。
 *
 * `manual` 是**唯一**决定能不能解除关联的字段：只有本模块显式添加的
 * `MANUAL_TASK_PHOTO` 才是 `true`。历史 / 其它关系（例如 `SOURCE`）仍可展示，
 * 但只能只读，绝不冒充成可解除。
 */
export interface TaskPhoto {
  attempt: TaskPhotoAttempt
  manual: boolean
  manualRefId: number | null
  manualLinkedAt: string | null
  /** 同一张图上除本模块外的其它关系（去重，只读展示）。 */
  otherRelations: string[]
}

export interface TaskPhotosSnapshot {
  taskExists: boolean
  photos: TaskPhoto[]
}

export interface TaskPhotoCandidatesSnapshot {
  taskExists: boolean
  photos: TaskPhotoAttempt[]
}

export interface AttachTaskPhotoOutcome {
  /** 关联是否已经确定存在（包括本来就是幂等重复的情况）。 */
  committed: boolean
  /** 这次调用没有写新行，因为同一张原图已经手动关联到这条任务。 */
  idempotent: boolean
  taskId: number | null
  attemptId: number | null
  manualRefId: number | null
  code: TaskPhotoFailureCode | null
  reason: string | null
}

export interface DetachTaskPhotoOutcome {
  /** 解除操作是否已经确定完成（包括本来就没有这条手动引用）。 */
  committed: boolean
  /** 这次真的删掉了一条手动引用。 */
  removed: boolean
  taskId: number | null
  attemptId: number | null
  code: TaskPhotoFailureCode | null
  reason: string | null
}

export interface TaskPhotoRepositoryPorts {
  /** 测试注入固定时钟。 */
  now?: () => Date
}

/** 严格正整数 ID：0 / 负数 / 小数 / NaN / 字符串一律拒绝。 */
export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

interface AttemptRow {
  attempt_id: number
  captured_at: string
  source: string
  status: string
  archived_path: string | null
  byte_length: number | null
  width: number | null
  height: number | null
  format: string | null
  mime_type: string | null
  note: string | null
}

interface PhotoRefRow extends AttemptRow {
  ref_id: number
  relation: string
  ref_created_at: string
}

const ATTEMPT_SELECT = `a.id AS attempt_id, a.captured_at, a.source, a.status, a.archived_path,
  a.byte_length, a.width, a.height, a.format, a.mime_type, a.note`

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value)
}

function toAttempt(row: AttemptRow): TaskPhotoAttempt {
  return {
    id: Number(row.attempt_id),
    capturedAt: row.captured_at,
    source: row.source as ScreenshotAttemptSource,
    status: row.status as ScreenshotAttemptStatus,
    archivedPath: row.archived_path,
    byteLength: nullableNumber(row.byte_length),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    format: row.format,
    mimeType: row.mime_type,
    note: row.note,
  }
}

function normalizeCandidateLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return TASK_PHOTO_CANDIDATE_LIMIT
  return Math.max(1, Math.min(TASK_PHOTO_CANDIDATE_LIMIT, Math.round(limit)))
}

class TaskPhotoWriteError extends Error {
  readonly code: 'TASK_MISSING' | 'PHOTO_MISSING' | 'PHOTO_NOT_ARCHIVED'

  constructor(code: 'TASK_MISSING' | 'PHOTO_MISSING' | 'PHOTO_NOT_ARCHIVED', message: string) {
    super(message)
    this.code = code
  }
}

function failureReason(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return `这条关联没有写入：${detail}。原图、识别结果和其它关联都没有被改动。`
}

export class TaskPhotoRepository {
  private readonly db: SqliteDatabase
  private readonly now: () => Date

  constructor(db: SqliteDatabase, ports: TaskPhotoRepositoryPorts = {}) {
    this.db = db
    this.now = ports.now ?? (() => new Date())
  }

  /**
   * 这条任务关联的原图（每张尝试只出现一次）。
   *
   * 只读：正常读取没有 INSERT / UPDATE / DELETE，也不会建表。
   */
  async listPhotos(taskId: number): Promise<TaskPhotosSnapshot> {
    if (!isPositiveSafeInteger(taskId)) return { taskExists: false, photos: [] }
    const task = await this.db.getFirstAsync<{ id: number }>('SELECT id FROM tasks WHERE id = ?;', [taskId])
    if (!task) return { taskExists: false, photos: [] }

    const rows = await this.db.getAllAsync<PhotoRefRow>(
      `SELECT r.id AS ref_id, r.relation, r.created_at AS ref_created_at, ${ATTEMPT_SELECT}
         FROM screenshot_refs r
         JOIN screenshot_attempts a ON a.id = r.attempt_id
        WHERE r.target_kind = 'TASK' AND r.target_id = ?
        ORDER BY a.captured_at DESC, a.id DESC, r.id ASC;`,
      [taskId],
    )

    const byAttempt = new Map<number, TaskPhoto>()
    for (const row of rows) {
      const attemptId = Number(row.attempt_id)
      let photo = byAttempt.get(attemptId)
      if (!photo) {
        photo = {
          attempt: toAttempt(row),
          manual: false,
          manualRefId: null,
          manualLinkedAt: null,
          otherRelations: [],
        }
        byAttempt.set(attemptId, photo)
      }
      if (row.relation === MANUAL_TASK_PHOTO) {
        photo.manual = true
        // 历史数据里万一出现重复手动引用，选最早的那条作为可解除引用；
        // 解除时按 (任务, 尝试, 关系) 精确删除，不会误伤其它关系。
        if (photo.manualRefId === null || Number(row.ref_id) < photo.manualRefId) {
          photo.manualRefId = Number(row.ref_id)
          photo.manualLinkedAt = row.ref_created_at
        }
      } else if (!photo.otherRelations.includes(row.relation)) {
        photo.otherRelations.push(row.relation)
      }
    }

    return { taskExists: true, photos: [...byAttempt.values()] }
  }

  /**
   * 可添加到这条任务的最近原图。
   *
   * 排除条件：
   * - 没有归档文件 / `ARCHIVE_FAILED`（本来就没有可查看的原图）；
   * - 已经**手动关联**到这条任务的同一张原图。这里同时按尝试 id 与归档路径判断，
   *   因为同一份字节可能登记过多次尝试（内容寻址 + 去重）。
   */
  async listAddable(taskId: number, limit: number = TASK_PHOTO_CANDIDATE_LIMIT): Promise<TaskPhotoCandidatesSnapshot> {
    if (!isPositiveSafeInteger(taskId)) return { taskExists: false, photos: [] }
    const task = await this.db.getFirstAsync<{ id: number }>('SELECT id FROM tasks WHERE id = ?;', [taskId])
    if (!task) return { taskExists: false, photos: [] }

    const rows = await this.db.getAllAsync<AttemptRow>(
      `SELECT ${ATTEMPT_SELECT}
         FROM screenshot_attempts a
        WHERE a.archived_path IS NOT NULL
          AND TRIM(a.archived_path) <> ''
          AND a.status <> 'ARCHIVE_FAILED'
          AND NOT EXISTS (
            SELECT 1
              FROM screenshot_refs r
              JOIN screenshot_attempts linked ON linked.id = r.attempt_id
             WHERE r.target_kind = 'TASK'
               AND r.target_id = ?
               AND r.relation = ?
               AND (
                 r.attempt_id = a.id
                 OR (a.archived_path IS NOT NULL AND linked.archived_path = a.archived_path)
               )
          )
        ORDER BY a.captured_at DESC, a.id DESC
        LIMIT ?;`,
      [taskId, MANUAL_TASK_PHOTO, normalizeCandidateLimit(limit)],
    )
    return { taskExists: true, photos: rows.map(toAttempt) }
  }

  /**
   * 显式添加一条「任务原图」关联。
   *
   * 校验与写入在同一个事务里：任务 / 尝试 / 归档文件任一不满足就整体失败、零写入。
   * 同一个 (任务, 原图) 已经有手动引用时直接返回 `idempotent: true`，不会再写一行。
   */
  async attach(taskId: number, attemptId: number): Promise<AttachTaskPhotoOutcome> {
    if (!isPositiveSafeInteger(taskId)) {
      return this.attachFailure('INVALID_TASK_ID', null, null, '任务编号无效，无法添加原图。')
    }
    if (!isPositiveSafeInteger(attemptId)) {
      return this.attachFailure('INVALID_PHOTO_ID', taskId, null, '原图编号无效，无法添加。')
    }

    let idempotent = false
    let manualRefId: number | null = null
    try {
      await this.db.withTransactionAsync(async () => {
        const task = await this.db.getFirstAsync<{ id: number }>('SELECT id FROM tasks WHERE id = ?;', [taskId])
        if (!task) {
          throw new TaskPhotoWriteError('TASK_MISSING', `任务 #${taskId} 不在本机（可能已被删除），无法添加原图。`)
        }

        const attempt = await this.db.getFirstAsync<{
          id: number
          archived_path: string | null
          status: string
        }>('SELECT id, archived_path, status FROM screenshot_attempts WHERE id = ?;', [attemptId])
        if (!attempt) {
          throw new TaskPhotoWriteError('PHOTO_MISSING', `原图 #${attemptId} 不在本机截图库里，无法添加。`)
        }
        const archivedPath = typeof attempt.archived_path === 'string' ? attempt.archived_path.trim() : ''
        if (attempt.status === 'ARCHIVE_FAILED' || archivedPath.length === 0) {
          throw new TaskPhotoWriteError(
            'PHOTO_NOT_ARCHIVED',
            '这张图当时没有保存成功（没有可查看的归档原图），不能关联到任务。',
          )
        }

        const existing = await this.db.getFirstAsync<{ id: number }>(
          `SELECT r.id AS id
             FROM screenshot_refs r
             JOIN screenshot_attempts a ON a.id = r.attempt_id
            WHERE r.target_kind = 'TASK'
              AND r.target_id = ?
              AND r.relation = ?
              AND (r.attempt_id = ? OR a.archived_path = ?)
            ORDER BY r.id ASC
            LIMIT 1;`,
          [taskId, MANUAL_TASK_PHOTO, attemptId, archivedPath],
        )
        if (existing) {
          idempotent = true
          manualRefId = Number(existing.id)
          return
        }

        const inserted = await this.db.runAsync(
          `INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at)
           VALUES (?, 'TASK', ?, ?, ?);`,
          [attemptId, taskId, MANUAL_TASK_PHOTO, this.now().toISOString()],
        )
        manualRefId = inserted.lastInsertRowId
      })
    } catch (cause) {
      if (cause instanceof TaskPhotoWriteError) {
        return this.attachFailure(cause.code, taskId, attemptId, cause.message)
      }
      return this.attachFailure('WRITE_FAILED', taskId, attemptId, failureReason(cause))
    }

    return {
      committed: true,
      idempotent,
      taskId,
      attemptId,
      manualRefId,
      code: null,
      reason: null,
    }
  }

  /**
   * 解除这条任务与一张原图的手动关联。
   *
   * **只**删除 `relation = MANUAL_TASK_PHOTO` 的那一条引用；原图文件、OCR 结果、
   * 课程 / 课表 / 其它任务的引用都不在本 SQL 的范围内。本来就没有这条引用时
   * 返回 `committed: true, removed: false`（幂等，不报错）。
   */
  async detach(taskId: number, attemptId: number): Promise<DetachTaskPhotoOutcome> {
    if (!isPositiveSafeInteger(taskId)) {
      return this.detachFailure('INVALID_TASK_ID', null, null, '任务编号无效，无法解除关联。')
    }
    if (!isPositiveSafeInteger(attemptId)) {
      return this.detachFailure('INVALID_PHOTO_ID', taskId, null, '原图编号无效，无法解除关联。')
    }

    let removed = false
    try {
      await this.db.withTransactionAsync(async () => {
        const task = await this.db.getFirstAsync<{ id: number }>('SELECT id FROM tasks WHERE id = ?;', [taskId])
        if (!task) {
          throw new TaskPhotoWriteError('TASK_MISSING', `任务 #${taskId} 不在本机（可能已被删除），无法解除关联。`)
        }
        const result = await this.db.runAsync(
          `DELETE FROM screenshot_refs
            WHERE target_kind = 'TASK'
              AND target_id = ?
              AND attempt_id = ?
              AND relation = ?;`,
          [taskId, attemptId, MANUAL_TASK_PHOTO],
        )
        removed = result.changes > 0
      })
    } catch (cause) {
      if (cause instanceof TaskPhotoWriteError) {
        return this.detachFailure(cause.code, taskId, attemptId, cause.message)
      }
      return this.detachFailure(
        'WRITE_FAILED',
        taskId,
        attemptId,
        `这条关联没有解除：${cause instanceof Error ? cause.message : String(cause)}。原图和其它关联都没有被改动。`,
      )
    }

    return {
      committed: true,
      removed,
      taskId,
      attemptId,
      code: null,
      reason: null,
    }
  }

  private attachFailure(
    code: TaskPhotoFailureCode,
    taskId: number | null,
    attemptId: number | null,
    reason: string,
  ): AttachTaskPhotoOutcome {
    return { committed: false, idempotent: false, taskId, attemptId, manualRefId: null, code, reason }
  }

  private detachFailure(
    code: TaskPhotoFailureCode,
    taskId: number | null,
    attemptId: number | null,
    reason: string,
  ): DetachTaskPhotoOutcome {
    return { committed: false, removed: false, taskId, attemptId, code, reason }
  }
}
