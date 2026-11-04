/**
 * 截图库仓库：把「用户提交过的每一张图」和它之后的识别/导入结果**持久地**串起来。
 *
 * 数据分层（与 `schema.ts` 的 v3 表一致）：
 *
 * ```
 * screenshot_attempts ──┬── ocr_results ── ocr_candidate_rows
 *                       ├── screenshot_refs（→ 课程 / 课表 / 任务 / 上一次尝试）
 *                       └── source_screenshots（历史已知来源，可恢复）
 * ```
 *
 * 硬约束（逐条对应授权范围）：
 * 1. **识别前先归档**：`recordAttempt` 在任何识别请求之前被调用，因此识别失败、
 *    用户取消、断网都留得下原图；`status` 如实写成 `FAILED` / `CANCELLED`。
 * 2. **不静默覆盖、不静默删除**：仓库里**没有任何** DELETE 语句；同一张图重复提交
 *    走 `dedup_of_attempt_id` 记录关联，新尝试照样留一行历史（字节可以共用一份）。
 * 3. **文件失败就回滚**：写库在单个事务里；调用方在写库失败时会删掉刚落盘的文件，
 *    绝不留下「数据库没有、文件却在」的孤儿文件，也绝不留下半条记录。
 * 4. **失败不影响识别**：调用方（`photoImportController`）把本仓库当成「尽力而为」的
 *    旁路 —— 归档/登记失败只提示，不阻断识别主流程。
 */

import type { SqlValue, SqliteDatabase } from '../db/types'
import type { ArchivedFormat } from './screenshotFiles'

export type ScreenshotAttemptSource = 'LIBRARY' | 'CAMERA' | 'ARCHIVE' | 'OTHER'
export type ScreenshotAttemptStatus =
  | 'ARCHIVED'
  | 'UPLOADING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ARCHIVE_FAILED'
export type ScreenshotRefTargetKind = 'COURSE' | 'SCHEDULE' | 'TASK' | 'ATTEMPT'
export type OcrResultStatus = 'SUCCESS' | 'FAILED' | 'CANCELLED'

export interface ScreenshotAttempt {
  id: number
  capturedAt: string
  source: ScreenshotAttemptSource
  status: ScreenshotAttemptStatus
  archivedPath: string | null
  originalUri: string | null
  sha256: string | null
  byteLength: number | null
  width: number | null
  height: number | null
  format: string | null
  mimeType: string | null
  uploadFormat: string | null
  uploadScale: number | null
  uploadQuality: number | null
  uploadByteLength: number | null
  resized: boolean
  dedupOfAttemptId: number | null
  errorCode: string | null
  errorMessage: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

export interface SourceScreenshot {
  id: number
  catalogKey: string
  title: string
  description: string | null
  archiveRelPath: string
  sha256: string | null
  byteLength: number | null
  width: number | null
  height: number | null
  layout: string | null
  capturedAt: string | null
  provenance: string | null
  foreignAttemptId: number | null
  createdAt: string
  updatedAt: string
}

export interface ScreenshotRef {
  id: number
  attemptId: number
  targetKind: ScreenshotRefTargetKind
  targetId: number
  relation: string
  createdAt: string
}

export interface OcrCandidateRowInput {
  rowIndex: number
  name?: string | null
  weekday?: number | null
  startTime?: string | null
  endTime?: string | null
  location?: string | null
  startWeek?: number | null
  endWeek?: number | null
  weekPattern?: string | null
  /** 选课序号（截图里课程名后面的括号数字）。 */
  selectionSerial?: string | null
  rawText?: string | null
  warnings?: readonly string[] | null
  imported?: boolean
}

export interface OcrCandidateRow extends OcrCandidateRowInput {
  id: number
  resultId: number
  createdAt: string
}

export interface OcrResult {
  id: number
  attemptId: number
  requestId: string | null
  layout: string | null
  week: number | null
  status: OcrResultStatus
  errorCode: string | null
  errorMessage: string | null
  candidateCount: number
  warnings: string[]
  payloadJson: string | null
  rawText: string | null
  ocrCalls: number | null
  durationMs: number | null
  imageWidth: number | null
  imageHeight: number | null
  imageFormat: string | null
  imageBytes: number | null
  createdAt: string
  candidates: OcrCandidateRow[]
}

export interface RecordAttemptInput {
  source: ScreenshotAttemptSource
  status: ScreenshotAttemptStatus
  capturedAt?: string
  archivedPath?: string | null
  originalUri?: string | null
  sha256?: string | null
  byteLength?: number | null
  width?: number | null
  height?: number | null
  format?: string | null
  mimeType?: string | null
  note?: string | null
  errorCode?: string | null
  errorMessage?: string | null
}

export interface RecordAttemptOutcome {
  attempt: ScreenshotAttempt
  /** 同一份归档字节之前已经登记过（本次只记历史 + 关联，不再存一份文件）。 */
  deduplicated: boolean
  /** 被复用的那一次尝试 id（`deduplicated` 为 true 时非空）。 */
  dedupOfAttemptId: number | null
}

export interface OcrResultInput {
  attemptId: number
  status: OcrResultStatus
  requestId?: string | null
  layout?: string | null
  week?: number | null
  errorCode?: string | null
  errorMessage?: string | null
  warnings?: readonly string[] | null
  payload?: unknown
  rawText?: string | null
  ocrCalls?: number | null
  durationMs?: number | null
  image?: { width?: number | null; height?: number | null; format?: string | null; bytes?: number | null } | null
  candidates?: readonly OcrCandidateRowInput[] | null
}

export interface SourceCatalogEntry {
  catalogKey: string
  title: string
  description?: string | null
  archiveRelPath: string
  sha256?: string | null
  byteLength?: number | null
  width?: number | null
  height?: number | null
  layout?: string | null
  capturedAt?: string | null
  provenance?: string | null
}

export interface ScreenshotLibraryRepositoryPorts {
  /** 测试注入固定时钟。 */
  now?: () => Date
}

/* --------------------------------- 行类型 -------------------------------- */

interface AttemptRow {
  id: number
  captured_at: string
  source: string
  status: string
  archived_path: string | null
  original_uri: string | null
  sha256: string | null
  byte_length: number | null
  width: number | null
  height: number | null
  format: string | null
  mime_type: string | null
  upload_format: string | null
  upload_scale: number | null
  upload_quality: number | null
  upload_byte_length: number | null
  resized: number
  dedup_of_attempt_id: number | null
  error_code: string | null
  error_message: string | null
  note: string | null
  created_at: string
  updated_at: string
}

interface SourceRow {
  id: number
  catalog_key: string
  title: string
  description: string | null
  archive_rel_path: string
  sha256: string | null
  byte_length: number | null
  width: number | null
  height: number | null
  layout: string | null
  captured_at: string | null
  provenance: string | null
  foreign_attempt_id: number | null
  created_at: string
  updated_at: string
}

interface ResultRow {
  id: number
  attempt_id: number
  request_id: string | null
  layout: string | null
  week: number | null
  status: string
  error_code: string | null
  error_message: string | null
  candidate_count: number
  warnings_json: string | null
  payload_json: string | null
  raw_text: string | null
  ocr_calls: number | null
  duration_ms: number | null
  image_width: number | null
  image_height: number | null
  image_format: string | null
  image_bytes: number | null
  created_at: string
}

interface CandidateRow {
  id: number
  result_id: number
  row_index: number
  name: string | null
  weekday: number | null
  start_time: string | null
  end_time: string | null
  location: string | null
  start_week: number | null
  end_week: number | null
  week_pattern: string | null
  selection_serial: string | null
  raw_text: string | null
  warnings_json: string | null
  imported: number
  created_at: string
}

const ATTEMPT_COLUMNS = `id, captured_at, source, status, archived_path, original_uri, sha256, byte_length,
  width, height, format, mime_type, upload_format, upload_scale, upload_quality, upload_byte_length,
  resized, dedup_of_attempt_id, error_code, error_message, note, created_at, updated_at`

const SOURCE_COLUMNS = `id, catalog_key, title, description, archive_rel_path, sha256, byte_length, width,
  height, layout, captured_at, provenance, foreign_attempt_id, created_at, updated_at`

const RESULT_COLUMNS = `id, attempt_id, request_id, layout, week, status, error_code, error_message,
  candidate_count, warnings_json, payload_json, raw_text, ocr_calls, duration_ms, image_width,
  image_height, image_format, image_bytes, created_at`

const CANDIDATE_COLUMNS = `id, result_id, row_index, name, weekday, start_time, end_time, location,
  start_week, end_week, week_pattern, selection_serial, raw_text, warnings_json, imported, created_at`

function nullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function nullableText(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim()
  return text.length > 0 ? text : null
}

function toAttempt(row: AttemptRow): ScreenshotAttempt {
  return {
    id: Number(row.id),
    capturedAt: row.captured_at,
    source: row.source as ScreenshotAttemptSource,
    status: row.status as ScreenshotAttemptStatus,
    archivedPath: row.archived_path,
    originalUri: row.original_uri,
    sha256: row.sha256,
    byteLength: row.byte_length === null ? null : Number(row.byte_length),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    format: row.format,
    mimeType: row.mime_type,
    uploadFormat: row.upload_format,
    uploadScale: row.upload_scale === null ? null : Number(row.upload_scale),
    uploadQuality: row.upload_quality === null ? null : Number(row.upload_quality),
    uploadByteLength: row.upload_byte_length === null ? null : Number(row.upload_byte_length),
    resized: Number(row.resized) === 1,
    dedupOfAttemptId: row.dedup_of_attempt_id === null ? null : Number(row.dedup_of_attempt_id),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toSource(row: SourceRow): SourceScreenshot {
  return {
    id: Number(row.id),
    catalogKey: row.catalog_key,
    title: row.title,
    description: row.description,
    archiveRelPath: row.archive_rel_path,
    sha256: row.sha256,
    byteLength: row.byte_length === null ? null : Number(row.byte_length),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    layout: row.layout,
    capturedAt: row.captured_at,
    provenance: row.provenance,
    foreignAttemptId: row.foreign_attempt_id === null ? null : Number(row.foreign_attempt_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : []
  } catch {
    return []
  }
}

function toCandidate(row: CandidateRow): OcrCandidateRow {
  return {
    id: Number(row.id),
    resultId: Number(row.result_id),
    rowIndex: Number(row.row_index),
    name: row.name,
    weekday: row.weekday === null ? null : Number(row.weekday),
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    startWeek: row.start_week === null ? null : Number(row.start_week),
    endWeek: row.end_week === null ? null : Number(row.end_week),
    weekPattern: row.week_pattern,
    selectionSerial: row.selection_serial,
    rawText: row.raw_text,
    warnings: parseJsonArray(row.warnings_json),
    imported: Number(row.imported) === 1,
    createdAt: row.created_at,
  }
}

function toResult(row: ResultRow, candidates: OcrCandidateRow[]): OcrResult {
  return {
    id: Number(row.id),
    attemptId: Number(row.attempt_id),
    requestId: row.request_id,
    layout: row.layout,
    week: row.week === null ? null : Number(row.week),
    status: row.status as OcrResultStatus,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    candidateCount: Number(row.candidate_count),
    warnings: parseJsonArray(row.warnings_json),
    payloadJson: row.payload_json,
    rawText: row.raw_text,
    ocrCalls: row.ocr_calls === null ? null : Number(row.ocr_calls),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    imageWidth: row.image_width === null ? null : Number(row.image_width),
    imageHeight: row.image_height === null ? null : Number(row.image_height),
    imageFormat: row.image_format,
    imageBytes: row.image_bytes === null ? null : Number(row.image_bytes),
    createdAt: row.created_at,
    candidates,
  }
}

/* --------------------------------- 仓库 --------------------------------- */

/**
 * 截图库的存储失败（写不进去 / 写了一半回滚）。
 *
 * 单独一个类型是为了让调用方能**明确区分**「识别本身失败」与
 * 「识别成功但结果没存住」—— 后者必须显式提示用户，绝不能当成保存成功。
 */
export class ScreenshotStorageError extends Error {
  override readonly name = 'ScreenshotStorageError'
  override readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.cause = cause ?? null
  }
}

export class ScreenshotLibraryRepository {  private readonly db: SqliteDatabase
  private readonly now: () => Date

  constructor(db: SqliteDatabase, ports: ScreenshotLibraryRepositoryPorts = {}) {
    this.db = db
    this.now = ports.now ?? (() => new Date())
  }

  private iso(): string {
    return this.now().toISOString()
  }

  /**
   * 登记一次尝试（识别**之前**调用）。
   *
   * 同一份归档字节（`sha256` + `archivedPath` 都一致）已经登记过时：
   * - 仍然插入一条**新的** attempt 行（尝试历史不能丢，用户重复提交过就是发生过）；
   * - `dedup_of_attempt_id` 指向第一次，文件字节共用一份，不重复占空间；
   * - 同时写一条 `ATTEMPT` 引用，方便「这张图被提交过几次」一次性查出来。
   */
  async recordAttempt(input: RecordAttemptInput): Promise<RecordAttemptOutcome> {
    const capturedAt = input.capturedAt ?? this.iso()
    const nowIso = this.iso()
    const archivedPath = nullableText(input.archivedPath)
    const sha256 = nullableText(input.sha256)

    let dedupOfAttemptId: number | null = null
    // 只按「真的能标识同一份字节」的字段查重：先看归档路径，再看内容哈希。
    // 刻意不看状态为 `ARCHIVE_FAILED` 的行（那种行本来就没有文件）。
    if (archivedPath) {
      const previous = await this.db.getFirstAsync<{ id: number }>(
        `SELECT id FROM screenshot_attempts
          WHERE status <> 'ARCHIVE_FAILED' AND archived_path = ?
          ORDER BY id ASC LIMIT 1;`,
        [archivedPath],
      )
      if (previous) dedupOfAttemptId = Number(previous.id)
    }
    if (dedupOfAttemptId === null && sha256) {
      const previous = await this.db.getFirstAsync<{ id: number }>(
        `SELECT id FROM screenshot_attempts
          WHERE status <> 'ARCHIVE_FAILED' AND sha256 = ?
          ORDER BY id ASC LIMIT 1;`,
        [sha256],
      )
      if (previous) dedupOfAttemptId = Number(previous.id)
    }

    const inserted = await this.db.runAsync(
      `INSERT INTO screenshot_attempts
         (captured_at, source, status, archived_path, original_uri, sha256, byte_length, width, height,
          format, mime_type, upload_format, upload_scale, upload_quality, upload_byte_length, resized,
          dedup_of_attempt_id, error_code, error_message, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        capturedAt,
        input.source,
        input.status,
        archivedPath,
        nullableText(input.originalUri),
        sha256,
        nullableNumber(input.byteLength),
        nullableNumber(input.width),
        nullableNumber(input.height),
        nullableText(input.format),
        nullableText(input.mimeType),
        null,
        null,
        null,
        null,
        0,
        dedupOfAttemptId,
        nullableText(input.errorCode),
        nullableText(input.errorMessage),
        nullableText(input.note),
        nowIso,
        nowIso,
      ],
    )

    const attemptId = inserted.lastInsertRowId
    if (dedupOfAttemptId !== null) {
      await this.db.runAsync(
        `INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at)
         VALUES (?, 'ATTEMPT', ?, 'DEDUP_OF', ?);`,
        [attemptId, dedupOfAttemptId, nowIso],
      )
    }

    const attempt = await this.getAttempt(attemptId)
    if (!attempt) throw new Error('截图记录写入后读不回来，请重试。')
    return { attempt, deduplicated: dedupOfAttemptId !== null, dedupOfAttemptId }
  }

  /** 更新一次尝试的状态 / 编码信息（失败原因、上传参数等）。 */
  async updateAttempt(id: number, patch: Partial<RecordAttemptInput> & {
    uploadFormat?: string | null
    uploadScale?: number | null
    uploadQuality?: number | null
    uploadByteLength?: number | null
    resized?: boolean
  }): Promise<ScreenshotAttempt | null> {
    const assignments: string[] = []
    const params: SqlValue[] = []
    const push = (column: string, value: SqlValue): void => {
      assignments.push(`${column} = ?`)
      params.push(value)
    }
    if (patch.status !== undefined) push('status', patch.status)
    if (patch.archivedPath !== undefined) push('archived_path', nullableText(patch.archivedPath))
    if (patch.originalUri !== undefined) push('original_uri', nullableText(patch.originalUri))
    if (patch.sha256 !== undefined) push('sha256', nullableText(patch.sha256))
    if (patch.byteLength !== undefined) push('byte_length', nullableNumber(patch.byteLength))
    if (patch.width !== undefined) push('width', nullableNumber(patch.width))
    if (patch.height !== undefined) push('height', nullableNumber(patch.height))
    if (patch.format !== undefined) push('format', nullableText(patch.format))
    if (patch.mimeType !== undefined) push('mime_type', nullableText(patch.mimeType))
    if (patch.note !== undefined) push('note', nullableText(patch.note))
    if (patch.errorCode !== undefined) push('error_code', nullableText(patch.errorCode))
    if (patch.errorMessage !== undefined) push('error_message', nullableText(patch.errorMessage))
    if (patch.uploadFormat !== undefined) push('upload_format', nullableText(patch.uploadFormat))
    if (patch.uploadScale !== undefined) push('upload_scale', patch.uploadScale ?? null)
    if (patch.uploadQuality !== undefined) push('upload_quality', patch.uploadQuality ?? null)
    if (patch.uploadByteLength !== undefined) push('upload_byte_length', nullableNumber(patch.uploadByteLength))
    if (patch.resized !== undefined) push('resized', patch.resized ? 1 : 0)
    if (assignments.length === 0) return this.getAttempt(id)
    push('updated_at', this.iso())
    params.push(id)
    await this.db.runAsync(`UPDATE screenshot_attempts SET ${assignments.join(', ')} WHERE id = ?;`, params)
    return this.getAttempt(id)
  }

  async getAttempt(id: number): Promise<ScreenshotAttempt | null> {
    const row = await this.db.getFirstAsync<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM screenshot_attempts WHERE id = ?;`,
      [id],
    )
    return row ? toAttempt(row) : null
  }

  /**
   * 按内容哈希找仍然有效的尝试（只读；供「从备份只导入截图」去重 / 修复旧路径）。
   *
   * 排除 `ARCHIVE_FAILED`：那种记录本来就没有文件，不能拿来当「已经导入过」。
   */
  async listAttemptsBySha256(sha256: string): Promise<ScreenshotAttempt[]> {
    const normalized = String(sha256 ?? '').trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalized)) return []
    const rows = await this.db.getAllAsync<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM screenshot_attempts
        WHERE status <> 'ARCHIVE_FAILED' AND sha256 = ?
        ORDER BY id ASC;`,
      [normalized],
    )
    return rows.map(toAttempt)
  }

  /**
   * 只改 `archived_path` 一列，并且带**旧值条件**（compare-and-swap）。
   *
   * 用途：iOS 容器根目录变化后，把一条已验证过字节的记录指到当前应用目录里的
   * 同一相对位置。任何其它列（sha / 字节数 / 时间 / 来源 / 关联）都不动；
   * 记录在检查之后被别人改过时返回 false，绝不覆盖。
   */
  async rebaseArchivedPath(input: {
    attemptId: number
    expectedArchivedPath: string | null
    nextArchivedPath: string
    /** 可选的哈希守卫：只更新仍然属于同一份内容的记录。 */
    expectedSha256?: string | null
  }): Promise<boolean> {
    if (!Number.isSafeInteger(input.attemptId) || input.attemptId <= 0) return false
    const next = String(input.nextArchivedPath ?? '').trim()
    if (next.length === 0) return false
    const expected = input.expectedArchivedPath === null ? null : String(input.expectedArchivedPath)
    const params: SqlValue[] = [next, this.iso(), input.attemptId, expected, expected]
    let sql = `UPDATE screenshot_attempts
                  SET archived_path = ?, updated_at = ?
                WHERE id = ?
                  AND status <> 'ARCHIVE_FAILED'
                  AND ((archived_path IS NULL AND ? IS NULL) OR archived_path = ?)`
    const guardedSha = String(input.expectedSha256 ?? '').trim().toLowerCase()
    if (/^[0-9a-f]{64}$/.test(guardedSha)) {
      sql += ' AND sha256 = ?'
      params.push(guardedSha)
    }
    sql += ';'
    const updated = await this.db.runAsync(sql, params)
    return updated.changes === 1
  }

  /** 全部尝试，最新在前（截图库列表）。 */
  async listAttempts(limit = 200): Promise<ScreenshotAttempt[]> {
    const rows = await this.db.getAllAsync<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM screenshot_attempts ORDER BY captured_at DESC, id DESC LIMIT ?;`,
      [Math.max(1, Math.min(1000, Math.round(limit)))],
    )
    return rows.map(toAttempt)
  }

  /** 有归档文件、可以正常查看的尝试（列表里过滤掉「文件都没落盘」的失败记录）。 */
  async listViewableAttempts(limit = 200): Promise<ScreenshotAttempt[]> {
    const rows = await this.db.getAllAsync<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM screenshot_attempts
        WHERE archived_path IS NOT NULL
        ORDER BY captured_at DESC, id DESC LIMIT ?;`,
      [Math.max(1, Math.min(1000, Math.round(limit)))],
    )
    return rows.map(toAttempt)
  }

  /**
   * 关联到某个业务对象的**截图**（每张尝试只出现一次）。
   *
   * 注意用 `DISTINCT`：同一张图可以同时以 `IMPORTED_SCHEDULE` 与 `IMPORTED_FROM`
   * 两种关系挂在同一条课表上，但界面问的是「有几张截图」，不是「有几条引用」。
   */
  async listAttemptsLinkedTo(targetKind: ScreenshotRefTargetKind, targetId: number): Promise<ScreenshotAttempt[]> {
    const rows = await this.db.getAllAsync<AttemptRow>(
      `SELECT DISTINCT ${ATTEMPT_COLUMNS.split(', ')
        .map((column) => `a.${column.trim()}`)
        .join(', ')}
         FROM screenshot_refs r JOIN screenshot_attempts a ON a.id = r.attempt_id
        WHERE r.target_kind = ? AND r.target_id = ?
        ORDER BY a.captured_at DESC, a.id DESC;`,
      [targetKind, targetId],
    )
    return rows.map(toAttempt)
  }

  /** 学号/课程维度的一次性查询：这张截图关联了哪些对象。 */
  async listRefsForAttempt(attemptId: number): Promise<ScreenshotRef[]> {
    const rows = await this.db.getAllAsync<{
      id: number
      attempt_id: number
      target_kind: string
      target_id: number
      relation: string
      created_at: string
    }>(
      `SELECT id, attempt_id, target_kind, target_id, relation, created_at
         FROM screenshot_refs WHERE attempt_id = ? ORDER BY id ASC;`,
      [attemptId],
    )
    return rows.map((row) => ({
      id: Number(row.id),
      attemptId: Number(row.attempt_id),
      targetKind: row.target_kind as ScreenshotRefTargetKind,
      targetId: Number(row.target_id),
      relation: row.relation,
      createdAt: row.created_at,
    }))
  }

  /**
   * 建立截图 → 业务对象的持久关联。
   *
   * `relation` 是个自由文本（`SOURCE` / `IMPORTED_COURSE` / `IMPORTED_SCHEDULE` …），
   * 同一对 (attempt, kind, id, relation) 只写一次（幂等），重复导入同一张图不会堆引用。
   */
  async linkRef(input: {
    attemptId: number
    targetKind: ScreenshotRefTargetKind
    targetId: number
    relation?: string
  }): Promise<void> {
    const relation = String(input.relation ?? 'SOURCE')
    const existing = await this.db.getFirstAsync<{ id: number }>(
      `SELECT id FROM screenshot_refs
        WHERE attempt_id = ? AND target_kind = ? AND target_id = ? AND relation = ? LIMIT 1;`,
      [input.attemptId, input.targetKind, input.targetId, relation],
    )
    if (existing) return
    await this.db.runAsync(
      `INSERT INTO screenshot_refs (attempt_id, target_kind, target_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?);`,
      [input.attemptId, input.targetKind, input.targetId, relation, this.iso()],
    )
  }

  async countRefsTo(targetKind: ScreenshotRefTargetKind, targetId: number): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM screenshot_refs WHERE target_kind = ? AND target_id = ?;',
      [targetKind, targetId],
    )
    return Number(row?.count ?? 0)
  }

  /**
   * 记录一次识别结果（成功 / 失败 / 取消都记）。
   *
   * 候选行连同**选课序号**一起落库：这样即使以后课程被改名，也能回看「当初图上
   * 那一串序号是什么」，而不会和 App 的 `AUTO-` 内部编号混为一谈。
   *
   * 返回 `null` 表示这次结果**没能落库**（调用方只需要提示，不应中断识别主流程）。
   */
  async recordOcrResult(input: OcrResultInput): Promise<OcrResult | null> {
    const createdAt = this.iso()
    const candidates = input.candidates ?? []
    try {
      await this.db.execAsync('BEGIN IMMEDIATE;')
      try {
        const inserted = await this.db.runAsync(
          `INSERT INTO ocr_results
             (attempt_id, request_id, layout, week, status, error_code, error_message, candidate_count,
              warnings_json, payload_json, raw_text, ocr_calls, duration_ms, image_width, image_height,
              image_format, image_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            input.attemptId,
            nullableText(input.requestId),
            nullableText(input.layout),
            nullableNumber(input.week),
            input.status,
            nullableText(input.errorCode),
            nullableText(input.errorMessage),
            candidates.length,
            input.warnings && input.warnings.length > 0 ? JSON.stringify([...input.warnings]) : null,
            input.payload === undefined || input.payload === null ? null : JSON.stringify(input.payload),
            nullableText(input.rawText),
            nullableNumber(input.ocrCalls),
            nullableNumber(input.durationMs),
            nullableNumber(input.image?.width),
            nullableNumber(input.image?.height),
            nullableText(input.image?.format),
            nullableNumber(input.image?.bytes),
            createdAt,
          ],
        )
        const resultId = inserted.lastInsertRowId
        for (const candidate of candidates) {
          await this.db.runAsync(
            `INSERT INTO ocr_candidate_rows
               (result_id, row_index, name, weekday, start_time, end_time, location, start_week, end_week,
                week_pattern, selection_serial, raw_text, warnings_json, imported, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              resultId,
              candidate.rowIndex,
              nullableText(candidate.name),
              nullableNumber(candidate.weekday),
              nullableText(candidate.startTime),
              nullableText(candidate.endTime),
              nullableText(candidate.location),
              nullableNumber(candidate.startWeek),
              nullableNumber(candidate.endWeek),
              nullableText(candidate.weekPattern),
              nullableText(candidate.selectionSerial),
              nullableText(candidate.rawText),
              candidate.warnings && candidate.warnings.length > 0 ? JSON.stringify([...candidate.warnings]) : null,
              candidate.imported ? 1 : 0,
              createdAt,
            ],
          )
        }

        /**
         * 尝试状态与结果**同一事务**更新（复核对点名的真实缺陷）。
         *
         * 旧实现只写 `ocr_results`，于是「识别失败 / 取消」的尝试在重开 App 之后
         * 仍然显示成 `ARCHIVED`（截图库读到错误状态）。
         *
         * 两条边界：
         * - 只有**归档成功**（`archived_path` 非空）时才把状态改成结果态；
         *   否则保留 `ARCHIVE_FAILED` 与它的错误信息 —— 那是「这张图没存住」的唯一线索，
         *   绝不能被后来的识别失败结果覆盖掉；
         * - `SUCCESS` 映射成 `SUCCEEDED`，与 `screenshot_attempts.status` 的取值域一致。
         */
        const nextStatus =
          input.status === 'SUCCESS' ? 'SUCCEEDED' : input.status === 'FAILED' ? 'FAILED' : 'CANCELLED'
        // 只有归档成功（有文件）的尝试才把状态改成结果态：
        // `status <> 'ARCHIVE_FAILED'` 这条条件保证「这张图没存住」的线索不会被覆盖。
        await this.db.runAsync(
          `UPDATE screenshot_attempts
              SET status = ?, error_code = ?, error_message = ?, updated_at = ?
            WHERE id = ? AND archived_path IS NOT NULL AND status <> 'ARCHIVE_FAILED';`,
          [
            nextStatus,
            nullableText(input.errorCode),
            nullableText(input.errorMessage),
            createdAt,
            input.attemptId,
          ],
        )
        await this.db.execAsync('COMMIT;')
      } catch (cause) {
        try {
          await this.db.execAsync('ROLLBACK;')
        } catch {
          // 回滚失败不掩盖原始错误
        }
        throw cause
      }
    } catch (cause) {
      // 识别结果落库失败**不能**影响用户看到识别结果本身，但也**绝不谎报保存成功**：
      // 抛出可读错误，由调用方（控制器 / 界面）显式提示「这次结果没存住」。
      throw new ScreenshotStorageError(
        `这次识别结果没能存进截图库：${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      )
    }
    return this.getOcrResultByAttempt(input.attemptId)
  }

  /** 最近一次识别结果（含候选行）。 */
  async getOcrResultByAttempt(attemptId: number): Promise<OcrResult | null> {
    const row = await this.db.getFirstAsync<ResultRow>(
      `SELECT ${RESULT_COLUMNS} FROM ocr_results WHERE attempt_id = ? ORDER BY id DESC LIMIT 1;`,
      [attemptId],
    )
    if (!row) return null
    const candidates = await this.db.getAllAsync<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM ocr_candidate_rows WHERE result_id = ? ORDER BY row_index ASC, id ASC;`,
      [Number(row.id)],
    )
    return toResult(row, candidates.map(toCandidate))
  }

  /** 某个业务对象相关的**所有**识别结果（用于「这条课表是哪几次识别导入的」）。 */
  async listOcrResultsForTarget(
    targetKind: ScreenshotRefTargetKind,
    targetId: number,
  ): Promise<Array<{ attempt: ScreenshotAttempt; relation: string; result: OcrResult | null }>> {
    const attempts = await this.listAttemptsLinkedTo(targetKind, targetId)
    const output: Array<{ attempt: ScreenshotAttempt; relation: string; result: OcrResult | null }> = []
    for (const attempt of attempts) {
      const refs = await this.listRefsForAttempt(attempt.id)
      const relation = refs.find((ref) => ref.targetKind === targetKind && ref.targetId === targetId)?.relation ?? 'SOURCE'
      output.push({ attempt, relation, result: await this.getOcrResultByAttempt(attempt.id) })
    }
    return output
  }

  /** 该截图最近一次识别是否成功（界面上的状态标签）。 */
  async latestResultStatus(attemptId: number): Promise<OcrResultStatus | null> {
    const row = await this.db.getFirstAsync<{ status: string }>(
      'SELECT status FROM ocr_results WHERE attempt_id = ? ORDER BY id DESC LIMIT 1;',
      [attemptId],
    )
    return row ? (row.status as OcrResultStatus) : null
  }

  /* ------------------------- 历史已知来源（可恢复） ------------------------- */

  /**
   * 登记 / 更新一条历史归档来源。
   *
   * 只按 `catalog_key` upsert，**不删除**任何既有记录：目录里条目改名、改描述、
   * 或者换成另一份文件，历史都会保留在 `screenshot_attempts` 里（来源文件本身由
   * 工作区保留）。这些条目是「PC 上已有的项目自有截图」，不是用户手机相册里的东西。
   */
  async upsertSourceEntry(entry: SourceCatalogEntry): Promise<SourceScreenshot> {
    const nowIso = this.iso()
    const existing = await this.db.getFirstAsync<{ id: number }>(
      'SELECT id FROM source_screenshots WHERE catalog_key = ?;',
      [entry.catalogKey],
    )
    if (existing) {
      await this.db.runAsync(
        `UPDATE source_screenshots SET title = ?, description = ?, archive_rel_path = ?, sha256 = ?,
           byte_length = ?, width = ?, height = ?, layout = ?, captured_at = ?, provenance = ?, updated_at = ?
         WHERE id = ?;`,
        [
          entry.title,
          nullableText(entry.description),
          entry.archiveRelPath,
          nullableText(entry.sha256),
          nullableNumber(entry.byteLength),
          nullableNumber(entry.width),
          nullableNumber(entry.height),
          nullableText(entry.layout),
          nullableText(entry.capturedAt),
          nullableText(entry.provenance),
          nowIso,
          Number(existing.id),
        ],
      )
      const updated = await this.getSourceByKey(entry.catalogKey)
      if (!updated) throw new Error('归档来源更新后读不回来。')
      return updated
    }

    await this.db.runAsync(
      `INSERT INTO source_screenshots
         (catalog_key, title, description, archive_rel_path, sha256, byte_length, width, height, layout,
          captured_at, provenance, foreign_attempt_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?);`,
      [
        entry.catalogKey,
        entry.title,
        nullableText(entry.description),
        entry.archiveRelPath,
        nullableText(entry.sha256),
        nullableNumber(entry.byteLength),
        nullableNumber(entry.width),
        nullableNumber(entry.height),
        nullableText(entry.layout),
        nullableText(entry.capturedAt),
        nullableText(entry.provenance),
        nowIso,
        nowIso,
      ],
    )
    const created = await this.getSourceByKey(entry.catalogKey)
    if (!created) throw new Error('归档来源写入后读不回来。')
    return created
  }

  async getSourceByKey(catalogKey: string): Promise<SourceScreenshot | null> {
    const row = await this.db.getFirstAsync<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM source_screenshots WHERE catalog_key = ?;`,
      [catalogKey],
    )
    return row ? toSource(row) : null
  }

  async listSources(): Promise<SourceScreenshot[]> {
    const rows = await this.db.getAllAsync<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM source_screenshots ORDER BY captured_at DESC, id ASC;`,
    )
    return rows.map(toSource)
  }

  /** 把一个来源文件在手机上的归档尝试挂到来源条目上（恢复完成后调用）。 */
  async attachSourceAttempt(catalogKey: string, attemptId: number): Promise<void> {
    await this.db.runAsync(
      'UPDATE source_screenshots SET foreign_attempt_id = ?, updated_at = ? WHERE catalog_key = ?;',
      [attemptId, this.iso(), catalogKey],
    )
  }

  /** 统计：库里一共有多少张能看的截图（界面副标题用）。 */
  async countAttemptsWithFile(): Promise<number> {
    const row = await this.db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM screenshot_attempts WHERE archived_path IS NOT NULL;',
    )
    return Number(row?.count ?? 0)
  }
}

export type { ArchivedFormat }
