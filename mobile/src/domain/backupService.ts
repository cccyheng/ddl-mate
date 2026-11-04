/**
 * 备份 / 预览 / 恢复的**文件与数据库编排**（无 React）。
 *
 * 关键顺序（每一阶段失败都在写库之前停下）：
 * 1. 导出：读当前 DB → 逐张读取并校验原图 → 生成带计数/摘要的单文件 → 由调用方
 *    选择的系统目录里「先写 .part、核对字节数、再改名」。
 * 2. 预览：把用户选中的文件复制进**应用私有**的唯一暂存目录 → 先看文件大小 →
 *    再读文本 → 严格解析/校验 → 记录「备份摘要 + 当前数据指纹」；不写数据库。
 * 3. 恢复：重算当前数据指纹并重新解析暂存文件（拒绝过期预览）→ 把图片再写进
 *    另一个唯一暂存目录并逐张回读校验 → 为当前数据生成完整恢复备份 → 在一个
 *    SQLite 事务里整库替换 → 提交后再刷新 / 取消旧通知。
 *
 * 导入文件里的任何路径都不会被当作本机路径使用：截图行只引用 `imageId`，
 * 恢复后统一写成应用自己生成的、内容寻址的新文件名。
 */

import { APP_SETTINGS_KEYS, SCHEMA_VERSION } from '../db/schema'
import { CLASS_REMINDER_KEY, decodeClassReminderSettings } from './classReminder'
import { FOCUS_KEY, focusForRestore } from './focusTime'
import type { SqlValue, SqliteDatabase } from '../db/types'
import {
  BACKUP_FILE_SUFFIX,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_LIMITS,
  BackupValidationError,
  assertSettingsRestorable,
  canonicalJson,
  disabledReminderValue,
  isExcludedSettingKey,
  isEmptyCounts,
  parseBackupText,
  sameBackupCounts,
  sealBackupData,
  sha256OfText,
  utf8ByteLength,
  type BackupAttempt,
  type BackupCounts,
  type BackupCourse,
  type BackupData,
  type BackupImage,
  type BackupOcrCandidate,
  type BackupOcrResult,
  type BackupRef,
  type BackupSchedule,
  type BackupSetting,
  type BackupSource,
  type BackupTask,
  type BackupTaskSource,
} from './backupFormat'
import { offsetIsoToShanghaiParts } from './datetime'
import { sha256HexOfBase64 } from './hashing'
import { decodeTemplateStore } from './taskTemplate'
import { decodeRecurrenceStore } from './recurrence'
import { decodeExamRevisionStore, EXAM_REVISION_KEY } from './examRevisionRepository'
import { base64ByteLength, readEncodedSize, sniffBase64Format } from './photoFiles'
import { archiveFileName, SCREENSHOT_DIR_NAME } from './screenshotFiles'

/* ------------------------------ 文件系统端口 ------------------------------ */

export interface BackupDirEntry {
  uri: string
  name: string
  isDirectory: boolean
  size: number | null
}

/**
 * 备份需要的最小文件系统能力。
 *
 * `createFile` / `renameFile` / `listNames` 是给**系统「文件」目录**用的：
 * iOS/Android 返回的目录可能是 security-scoped / SAF URI，不能靠字符串拼路径；
 * 必须让原生 Directory/File 对象在目录里创建子文件、再看名字决定唯一文件名。
 */
export interface BackupFileSystem {
  readonly documentDirectory: string
  readonly cacheDirectory: string
  exists(uri: string): Promise<boolean>
  size(uri: string): Promise<number | null>
  readText(uri: string): Promise<string>
  readBase64(uri: string): Promise<string>
  writeText(uri: string, text: string): Promise<void>
  writeBase64(uri: string, base64: string): Promise<void>
  ensureDirectory(uri: string): Promise<void>
  deleteFile(uri: string): Promise<void>
  deleteDirectory(uri: string): Promise<void>
  move(from: string, to: string): Promise<void>
  /** 在目录里创建一个空文件，返回它的 URI。 */
  createFile(directoryUri: string, name: string): Promise<string>
  /** 在同一目录里改名，返回新 URI。 */
  renameFile(uri: string, newName: string): Promise<string>
  /** 目录里的文件名（不递归）。 */
  listNames(directoryUri: string): Promise<string[]>
  list(directoryUri: string): Promise<BackupDirEntry[]>
  /** 复制到目录里的指定名字；目标必须不存在。 */
  copyToDirectory(fromUri: string, directoryUri: string, name: string): Promise<string>
  /** 调系统目录选择器；取消时返回 `{ canceled: true }`。 */
  pickDirectory(initialUri?: string): Promise<{ canceled: true } | { canceled: false; uri: string }>
  /** 调系统文件选择器；可从上次成功导出的目录开始（installed API 的 initialUri）。 */
  pickFile(initialUri?: string): Promise<{ canceled: true } | { canceled: false; uri: string; name: string }>
}

export class BackupFileCancelledError extends Error {
  override readonly name = 'BackupFileCancelledError'
}

/* ------------------------------- 常量 / 工具 ------------------------------- */

export const BACKUP_DIR_NAME = 'backups'
/** 用户主动创建的本机备份库（位于 `Documents/backups/library`）。 */
export const BACKUP_LIBRARY_DIR_NAME = 'library'
export const BACKUP_STAGING_DIR_NAME = 'backup-staging'

function joinUri(directory: string, ...names: string[]): string {
  const base = directory.endsWith('/') ? directory.slice(0, -1) : directory
  return `${base}/${names.join('/')}`
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function stampForFileName(date: Date): string {
  const parts = offsetIsoToShanghaiParts(date.toISOString())
  if (!parts) return date.toISOString().replace(/[-:]/g, '').slice(0, 15)
  return (
    `${parts.year}${String(parts.month).padStart(2, '0')}${String(parts.day).padStart(2, '0')}` +
    `-${String(parts.hour).padStart(2, '0')}${String(parts.minute).padStart(2, '0')}${String(parts.second).padStart(2, '0')}`
  )
}

function uniqueName(existing: ReadonlySet<string>, base: string): string {
  if (!existing.has(base)) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const suffix = dot > 0 ? base.slice(dot) : ''
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-${index}${suffix}`
    if (!existing.has(candidate)) return candidate
  }
  throw new Error('同名文件太多，无法生成唯一文件名。')
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/* ------------------------------- 数据库快照 ------------------------------- */

interface RawAttemptRow {
  id: number
  capturedAt: string
  source: string
  status: string
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
  resized: number
  dedupOfAttemptId: number | null
  errorCode: string | null
  errorMessage: string | null
  note: string | null
  createdAt: string
  updatedAt: string
}

interface RawSnapshot {
  tasks: BackupTask[]
  courses: BackupCourse[]
  schedules: BackupSchedule[]
  taskSources: BackupTaskSource[]
  attempts: RawAttemptRow[]
  sources: BackupSource[]
  refs: BackupRef[]
  ocrResults: BackupOcrResult[]
  ocrCandidates: BackupOcrCandidate[]
  settings: BackupSetting[]
}

function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

async function readRawSnapshot(db: SqliteDatabase): Promise<RawSnapshot> {
  const [tasks, courses, schedules, taskSources, attempts, sources, refs, ocrResults, ocrCandidates, settings] =
    await Promise.all([
      db.getAllAsync<{
        id: number
        title: string
        description: string | null
        course_id: number | null
        type: string
        status: string
        priority: number
        deadline: string | null
        estimated_minutes: number | null
        submit_requirement: string | null
        submit_method: string | null
        completed_at: string | null
        created_at: string
        updated_at: string
      }>(
        `SELECT id, title, description, course_id, type, status, priority, deadline,
                estimated_minutes, submit_requirement, submit_method, completed_at, created_at, updated_at
           FROM tasks ORDER BY id ASC;`,
      ),
      db.getAllAsync<{
        id: number
        code: string
        name: string
        instructor: string | null
        semester: string | null
        color: string | null
        note: string | null
        selection_serial: string | null
        created_at: string
        updated_at: string
      }>(
        `SELECT id, code, name, instructor, semester, color, note, selection_serial, created_at, updated_at
           FROM courses ORDER BY id ASC;`,
      ),
      db.getAllAsync<{
        id: number
        course_id: number
        weekday: number
        start_time: string
        end_time: string
        location: string | null
        period_start: number | null
        period_end: number | null
        week_range: string | null
        semester_start_date: string | null
        start_week: number | null
        end_week: number | null
        week_pattern: string
        created_at: string
        updated_at: string
      }>(
        `SELECT id, course_id, weekday, start_time, end_time, location, period_start, period_end,
                week_range, semester_start_date, start_week, end_week, week_pattern, created_at, updated_at
           FROM schedules ORDER BY id ASC;`,
      ),
      db.getAllAsync<{ id: number; task_id: number; kind: string; raw_text: string; created_at: string }>(
        'SELECT id, task_id, kind, raw_text, created_at FROM task_sources ORDER BY id ASC;',
      ),
      db.getAllAsync<{
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
      }>(
        `SELECT id, captured_at, source, status, archived_path, original_uri, sha256, byte_length,
                width, height, format, mime_type, upload_format, upload_scale, upload_quality,
                upload_byte_length, resized, dedup_of_attempt_id, error_code, error_message, note,
                created_at, updated_at
           FROM screenshot_attempts ORDER BY id ASC;`,
      ),
      db.getAllAsync<{
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
      }>(
        `SELECT id, catalog_key, title, description, archive_rel_path, sha256, byte_length, width,
                height, layout, captured_at, provenance, foreign_attempt_id, created_at, updated_at
           FROM source_screenshots ORDER BY id ASC;`,
      ),
      db.getAllAsync<{
        id: number
        attempt_id: number
        target_kind: string
        target_id: number
        relation: string
        created_at: string
      }>('SELECT id, attempt_id, target_kind, target_id, relation, created_at FROM screenshot_refs ORDER BY id ASC;'),
      db.getAllAsync<{
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
      }>(
        `SELECT id, attempt_id, request_id, layout, week, status, error_code, error_message,
                candidate_count, warnings_json, payload_json, raw_text, ocr_calls, duration_ms,
                image_width, image_height, image_format, image_bytes, created_at
           FROM ocr_results ORDER BY id ASC;`,
      ),
      db.getAllAsync<{
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
      }>(
        `SELECT id, result_id, row_index, name, weekday, start_time, end_time, location, start_week,
                end_week, week_pattern, selection_serial, raw_text, warnings_json, imported, created_at
           FROM ocr_candidate_rows ORDER BY id ASC;`,
      ),
      db.getAllAsync<{ key: string; value: string; updated_at: string }>(
        'SELECT key, value, updated_at FROM app_settings ORDER BY key ASC;',
      ),
    ])

  return {
    tasks: tasks.map((row) => ({
      id: Number(row.id),
      title: row.title,
      description: row.description,
      courseId: num(row.course_id),
      type: row.type,
      status: row.status,
      priority: Number(row.priority),
      deadline: row.deadline,
      estimatedMinutes: num(row.estimated_minutes),
      submitRequirement: row.submit_requirement,
      submitMethod: row.submit_method,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    courses: courses.map((row) => ({
      id: Number(row.id),
      code: row.code,
      name: row.name,
      instructor: row.instructor,
      semester: row.semester,
      color: row.color,
      note: row.note,
      selectionSerial: row.selection_serial,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    schedules: schedules.map((row) => ({
      id: Number(row.id),
      courseId: Number(row.course_id),
      weekday: Number(row.weekday),
      startTime: row.start_time,
      endTime: row.end_time,
      location: row.location,
      periodStart: num(row.period_start),
      periodEnd: num(row.period_end),
      weekRange: row.week_range,
      semesterStartDate: row.semester_start_date,
      startWeek: num(row.start_week),
      endWeek: num(row.end_week),
      weekPattern: row.week_pattern,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    taskSources: taskSources.map((row) => ({
      id: Number(row.id),
      taskId: Number(row.task_id),
      kind: row.kind,
      rawText: row.raw_text,
      createdAt: row.created_at,
    })),
    attempts: attempts.map((row) => ({
      id: Number(row.id),
      capturedAt: row.captured_at,
      source: row.source,
      status: row.status,
      archivedPath: row.archived_path,
      originalUri: row.original_uri,
      sha256: row.sha256,
      byteLength: num(row.byte_length),
      width: num(row.width),
      height: num(row.height),
      format: row.format,
      mimeType: row.mime_type,
      uploadFormat: row.upload_format,
      uploadScale: num(row.upload_scale),
      uploadQuality: num(row.upload_quality),
      uploadByteLength: num(row.upload_byte_length),
      resized: Number(row.resized),
      dedupOfAttemptId: num(row.dedup_of_attempt_id),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    sources: sources.map((row) => ({
      id: Number(row.id),
      catalogKey: row.catalog_key,
      title: row.title,
      description: row.description,
      archiveRelPath: row.archive_rel_path,
      sha256: row.sha256,
      byteLength: num(row.byte_length),
      width: num(row.width),
      height: num(row.height),
      layout: row.layout,
      capturedAt: row.captured_at,
      provenance: row.provenance,
      foreignAttemptId: num(row.foreign_attempt_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    refs: refs.map((row) => ({
      id: Number(row.id),
      attemptId: Number(row.attempt_id),
      targetKind: row.target_kind,
      targetId: Number(row.target_id),
      relation: row.relation,
      createdAt: row.created_at,
    })),
    ocrResults: ocrResults.map((row) => ({
      id: Number(row.id),
      attemptId: Number(row.attempt_id),
      requestId: row.request_id,
      layout: row.layout,
      week: num(row.week),
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      candidateCount: Number(row.candidate_count),
      warningsJson: row.warnings_json,
      payloadJson: row.payload_json,
      rawText: row.raw_text,
      ocrCalls: num(row.ocr_calls),
      durationMs: num(row.duration_ms),
      imageWidth: num(row.image_width),
      imageHeight: num(row.image_height),
      imageFormat: row.image_format,
      imageBytes: num(row.image_bytes),
      createdAt: row.created_at,
    })),
    ocrCandidates: ocrCandidates.map((row) => ({
      id: Number(row.id),
      resultId: Number(row.result_id),
      rowIndex: Number(row.row_index),
      name: row.name,
      weekday: num(row.weekday),
      startTime: row.start_time,
      endTime: row.end_time,
      location: row.location,
      startWeek: num(row.start_week),
      endWeek: num(row.end_week),
      weekPattern: row.week_pattern,
      selectionSerial: row.selection_serial,
      rawText: row.raw_text,
      warningsJson: row.warnings_json,
      imported: Number(row.imported) === 1,
      createdAt: row.created_at,
    })),
    settings: settings.map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at })),
  }
}

function assertSnapshotLimits(snapshot: RawSnapshot): void {
  const checks: Array<[number, number, string]> = [
    [snapshot.tasks.length, BACKUP_LIMITS.maxTasks, '任务'],
    [snapshot.courses.length, BACKUP_LIMITS.maxCourses, '课程'],
    [snapshot.schedules.length, BACKUP_LIMITS.maxSchedules, '课表'],
    [snapshot.taskSources.length, BACKUP_LIMITS.maxTaskSources, '任务原文'],
    [snapshot.attempts.length, BACKUP_LIMITS.maxAttempts, '截图尝试'],
    [snapshot.sources.length, BACKUP_LIMITS.maxSources, '历史截图来源'],
    [snapshot.refs.length, BACKUP_LIMITS.maxRefs, '截图关联'],
    [snapshot.ocrResults.length, BACKUP_LIMITS.maxOcrResults, '识别结果'],
    [snapshot.ocrCandidates.length, BACKUP_LIMITS.maxOcrCandidates, '识别候选行'],
    [snapshot.settings.length, BACKUP_LIMITS.maxSettings, '设置项'],
  ]
  for (const [count, max, label] of checks) {
    if (count > max) throw new BackupValidationError(`${label}有 ${count} 条，超过备份上限 ${max}。`)
  }
  const withFile = snapshot.attempts.filter((attempt) => attempt.archivedPath !== null)
  const declaredByPath = new Map<string, number>()
  for (const attempt of withFile) {
    if (attempt.archivedPath && !declaredByPath.has(attempt.archivedPath)) {
      declaredByPath.set(attempt.archivedPath, attempt.byteLength ?? 0)
    }
  }
  if (declaredByPath.size > BACKUP_LIMITS.maxImages) {
    throw new BackupValidationError(`截图有 ${declaredByPath.size} 张，超过备份上限 ${BACKUP_LIMITS.maxImages} 张。`)
  }
  const declaredBytes = [...declaredByPath.values()].reduce((total, bytes) => total + bytes, 0)
  if (declaredBytes > BACKUP_LIMITS.maxTotalImageBytes) {
    throw new BackupValidationError(
      `截图合计约 ${declaredBytes} 字节，超过备份上限 ${BACKUP_LIMITS.maxTotalImageBytes} 字节。`,
    )
  }
}

/** 当前数据指纹：预览之后数据库有任何变化（包括设置）都要让预览失效。 */
export async function datasetFingerprint(db: SqliteDatabase): Promise<string> {
  const snapshot = await readRawSnapshot(db)
  return sha256OfText(
    canonicalJson({
      tasks: snapshot.tasks,
      courses: snapshot.courses,
      schedules: snapshot.schedules,
      taskSources: snapshot.taskSources,
      attempts: snapshot.attempts,
      sources: snapshot.sources,
      refs: snapshot.refs,
      ocrResults: snapshot.ocrResults,
      ocrCandidates: snapshot.ocrCandidates,
      // OCR 地址与已消费回执不会因恢复而改变，也不参与替换，因此不放进指纹。
      settings: snapshot.settings.filter((setting) => !isExcludedSettingKey(setting.key)),
    }),
  )
}

/* ------------------------------- 导出 / 恢复 ------------------------------- */

export interface BackupBuildResult {
  data: BackupData
  excludedSettings: string[]
}

async function collectImages(
  fs: BackupFileSystem,
  attempts: readonly RawAttemptRow[],
): Promise<{ images: BackupImage[]; byPath: Map<string, BackupImage> }> {
  const images: BackupImage[] = []
  const byPath = new Map<string, BackupImage>()
  const bySha = new Map<string, BackupImage>()
  let totalBytes = 0

  for (const attempt of attempts) {
    if (!attempt.archivedPath) continue
    if (byPath.has(attempt.archivedPath)) continue
    const size = await fs.size(attempt.archivedPath)
    if (size === null) {
      throw new BackupValidationError(
        `截图 #${attempt.id} 的原图不在这台手机上了，不能生成「完整」备份。请先在截图库里处理这一条。`,
      )
    }
    if (size <= 0 || size > BACKUP_LIMITS.maxImageBytes) {
      throw new BackupValidationError(
        `截图 #${attempt.id} 的原图大小 ${size} 字节，不在 1–${BACKUP_LIMITS.maxImageBytes} 的允许范围内。`,
      )
    }
    if (totalBytes + size > BACKUP_LIMITS.maxTotalImageBytes) {
      throw new BackupValidationError(
        `截图合计超过 ${BACKUP_LIMITS.maxTotalImageBytes} 字节的备份上限，未生成不完整的备份。`,
      )
    }
    const base64 = await fs.readBase64(attempt.archivedPath)
    const decodedLength = base64ByteLength(base64)
    const format = sniffBase64Format(base64)
    const measured = readEncodedSize(base64)
    if (!format || !measured) {
      throw new BackupValidationError(`截图 #${attempt.id} 的原图不是可解析的 PNG / JPEG，已停止导出。`)
    }
    if (decodedLength !== size) {
      throw new BackupValidationError(
        `截图 #${attempt.id} 读出的字节数（${decodedLength}）与文件大小（${size}）不一致，已停止导出。`,
      )
    }
    if (attempt.format !== null && attempt.format !== format) {
      throw new BackupValidationError(`截图 #${attempt.id} 登记格式 ${attempt.format} 与实际字节 ${format} 不一致。`)
    }
    const sha256 = await sha256HexOfBase64(base64)
    if (attempt.sha256 !== null && attempt.sha256.toLowerCase() !== sha256) {
      throw new BackupValidationError(`截图 #${attempt.id} 登记的内容哈希与实际原图不一致。`)
    }
    if (attempt.byteLength !== null && attempt.byteLength !== size) {
      throw new BackupValidationError(`截图 #${attempt.id} 登记的字节数与实际原图不一致。`)
    }
    const existing = bySha.get(sha256)
    if (existing) {
      byPath.set(attempt.archivedPath, existing)
      continue
    }
    const image: BackupImage = {
      id: `img-${images.length + 1}`,
      sha256,
      byteLength: size,
      width: attempt.width ?? measured.width,
      height: attempt.height ?? measured.height,
      format,
      base64,
    }
    images.push(image)
    bySha.set(sha256, image)
    byPath.set(attempt.archivedPath, image)
    totalBytes += size
  }
  return { images, byPath }
}

function toBackupAttempt(attempt: RawAttemptRow, byPath: ReadonlyMap<string, BackupImage>): BackupAttempt {
  const image = attempt.archivedPath ? byPath.get(attempt.archivedPath) : null
  if (attempt.archivedPath && !image) {
    throw new BackupValidationError(`截图 #${attempt.id} 缺少已读取的原图。`)
  }
  if (!image && (attempt.sha256 !== null || attempt.byteLength !== null)) {
    throw new BackupValidationError(`截图 #${attempt.id} 有哈希/字节数但没有原图文件，不能生成完整备份。`)
  }
  return {
    id: attempt.id,
    capturedAt: attempt.capturedAt,
    source: attempt.source,
    status: attempt.status,
    imageId: image?.id ?? null,
    sha256: image?.sha256 ?? null,
    byteLength: image?.byteLength ?? null,
    width: image?.width ?? attempt.width,
    height: image?.height ?? attempt.height,
    format: image?.format ?? attempt.format,
    mimeType: image ? (image.format === 'png' ? 'image/png' : 'image/jpeg') : attempt.mimeType,
    uploadFormat: attempt.uploadFormat,
    uploadScale: attempt.uploadScale,
    uploadQuality: attempt.uploadQuality,
    uploadByteLength: attempt.uploadByteLength,
    resized: attempt.resized === 1,
    dedupOfAttemptId: attempt.dedupOfAttemptId,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    note: attempt.note,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  }
}

export async function buildBackupData(db: SqliteDatabase, fs: BackupFileSystem): Promise<BackupBuildResult> {
  const snapshot = await readRawSnapshot(db)
  assertSnapshotLimits(snapshot)
  const { images, byPath } = await collectImages(fs, snapshot.attempts)
  const attempts = snapshot.attempts.map((attempt) => toBackupAttempt(attempt, byPath))
  const settings = snapshot.settings.filter((setting) => !isExcludedSettingKey(setting.key))
  const excludedSettings = snapshot.settings
    .filter((setting) => isExcludedSettingKey(setting.key))
    .map((setting) => setting.key)
  assertSettingsRestorable(settings, new Set(snapshot.tasks.map((task) => task.id)))

  return {
    data: {
      tasks: snapshot.tasks,
      courses: snapshot.courses,
      schedules: snapshot.schedules,
      taskSources: snapshot.taskSources,
      images,
      attempts,
      sources: snapshot.sources,
      refs: snapshot.refs,
      ocrResults: snapshot.ocrResults,
      ocrCandidates: snapshot.ocrCandidates,
      settings,
    },
    excludedSettings,
  }
}

async function readTextLimited(fs: BackupFileSystem, uri: string, maxBytes: number): Promise<string> {
  const size = await fs.size(uri)
  if (size === null) throw new BackupValidationError('备份文件不存在或读不到大小。')
  if (size <= 0) throw new BackupValidationError('备份文件是空文件。')
  if (size > maxBytes) throw new BackupValidationError(`备份文件有 ${size} 字节，超过 ${maxBytes} 字节上限。`)
  const text = await fs.readText(uri)
  if (utf8ByteLength(text) > maxBytes) {
    throw new BackupValidationError(`备份文本超过 ${maxBytes} 字节上限。`)
  }
  return text
}

async function writeTextAtomic(
  fs: BackupFileSystem,
  directoryUri: string,
  baseName: string,
  text: string,
  expectedBytes: number,
): Promise<{ uri: string; name: string }> {
  const existing = new Set(await fs.listNames(directoryUri))
  const finalName = uniqueName(existing, baseName)
  const partName = uniqueName(existing, `${finalName}.part-${randomToken()}`)
  const partUri = await fs.createFile(directoryUri, partName)
  let moved = false
  try {
    await fs.writeText(partUri, text)
    const written = await fs.size(partUri)
    if (written !== expectedBytes) {
      throw new Error(`写入备份文件后字节数不对（期望 ${expectedBytes}，实际 ${written ?? '读不到'}）。`)
    }
    const finalUri = await fs.renameFile(partUri, finalName)
    moved = true
    const finalSize = await fs.size(finalUri)
    if (finalSize !== expectedBytes) {
      try {
        await fs.deleteFile(finalUri)
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw new Error(`改名后备份文件字节数不对（期望 ${expectedBytes}，实际 ${finalSize ?? '读不到'}）。`)
    }
    return { uri: finalUri, name: finalName }
  } catch (cause) {
    if (!moved) {
      try {
        await fs.deleteFile(partUri)
      } catch {
        // 清理失败不掩盖原始错误
      }
    }
    throw cause
  }
}

export interface BackupExportResult {
  fileName: string
  uri: string
  /** 用户选择的目录（仅用于显示保存位置 / 下次手动选择器的起始目录）。 */
  directoryUri: string
  byteLength: number
  format: string
  version: number
  createdAt: string
  counts: BackupCounts
  totalImageBytes: number
  excludedSettings: string[]
}

export interface BackupExportOptions {
  now?: () => Date
  fileNamePrefix?: string
  appSchemaVersion?: number
}

/** 导出到**调用方已经选择好**的目录（系统「文件」或应用私有恢复目录）。 */
export async function exportBackupToDirectory(
  db: SqliteDatabase,
  fs: BackupFileSystem,
  directoryUri: string,
  options: BackupExportOptions = {},
): Promise<BackupExportResult> {
  const now = options.now ?? (() => new Date())
  const at = now()
  const built = await buildBackupData(db, fs)
  const file = await sealBackupData(built.data, {
    now: () => at,
    appSchemaVersion: options.appSchemaVersion ?? SCHEMA_VERSION,
  })
  const json = JSON.stringify(file)
  const byteLength = utf8ByteLength(json)
  if (byteLength > BACKUP_LIMITS.maxFileBytes) {
    throw new BackupValidationError(
      `生成后的备份文件有 ${byteLength} 字节，超过 ${BACKUP_LIMITS.maxFileBytes} 字节上限，未写出不完整的文件。`,
    )
  }
  // 用**恢复时同一个 parser**验证生成物：自己的导出如果自己都恢复不了，绝不写文件。
  await parseBackupText(json)
  const baseName = `${options.fileNamePrefix ?? 'ddlmate-backup'}-${stampForFileName(at)}${BACKUP_FILE_SUFFIX}`
  const written = await writeTextAtomic(fs, directoryUri, baseName, json, byteLength)
  return {
    fileName: written.name,
    uri: written.uri,
    directoryUri,
    byteLength,
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: file.createdAt,
    counts: file.manifest.counts,
    totalImageBytes: file.manifest.totalImageBytes,
    excludedSettings: built.excludedSettings,
  }
}

/* ------------------------------ 本机备份库 ------------------------------ */

/**
 * `writeTextAtomic` 在同一秒内重名时用 `uniqueName` 生成
 * `...<timestamp>.ddlbackup-2.json`（后缀在最后一个点之前）。文件名是应用自己
 * 生成的权威名字，因此允许 `-N` 冲突后缀；仍然拒绝目录 / 穿越 / 任意名字。
 */
const LIBRARY_FILE_RE = /^ddlmate-library-\d{8}-\d{6}\.ddlbackup(?:-\d+)?\.json$/
const RECOVERY_FILE_RE = /^ddlmate-recovery-\d{8}-\d{6}\.ddlbackup(?:-\d+)?\.json$/

export function backupLibraryDirectory(fs: BackupFileSystem): string {
  return joinUri(fs.documentDirectory, BACKUP_DIR_NAME, BACKUP_LIBRARY_DIR_NAME)
}

function libraryBaseDirectory(fs: BackupFileSystem, kind: BackupLibraryKind): string {
  return kind === 'library' ? backupLibraryDirectory(fs) : joinUri(fs.documentDirectory, BACKUP_DIR_NAME)
}

function validLibraryFileName(kind: BackupLibraryKind, fileName: string): boolean {
  return kind === 'library' ? LIBRARY_FILE_RE.test(fileName) : RECOVERY_FILE_RE.test(fileName)
}

/** 从列表行的 kind + 权威文件名重建 app-private 路径；绝不接受调用方给任意 URI。 */
export async function resolveBackupLibraryFile(
  fs: BackupFileSystem,
  entry: Pick<BackupLibraryEntry, 'kind' | 'fileName'>,
): Promise<string> {
  if (!validLibraryFileName(entry.kind, entry.fileName)) {
    throw new Error('这不是本机备份库里的合法文件名。')
  }
  const source = joinUri(libraryBaseDirectory(fs, entry.kind), entry.fileName)
  if (!(await fs.exists(source))) throw new Error('这份备份已经不在本机了。')
  const size = await fs.size(source)
  if (size === null || size <= 0) throw new Error('备份文件读不到大小。')
  return source
}

/** 创建一份**本机**快照（不打开系统目录选择器）。 */
export async function createLocalBackup(
  db: SqliteDatabase,
  fs: BackupFileSystem,
  options: BackupExportOptions = {},
): Promise<BackupExportResult> {
  const directory = backupLibraryDirectory(fs)
  await fs.ensureDirectory(directory)
  return exportBackupToDirectory(db, fs, directory, { ...options, fileNamePrefix: 'ddlmate-library' })
}

async function readLibraryEntry(fs: BackupFileSystem, kind: BackupLibraryKind, fileName: string, uri: string, size: number): Promise<BackupLibraryEntry> {
  const base: BackupLibraryEntry = {
    kind,
    fileName,
    uri,
    byteLength: size,
    createdAt: '',
    counts: null,
    totalImageBytes: 0,
    valid: false,
    error: null,
  }
  try {
    const text = await readTextLimited(fs, uri, BACKUP_LIMITS.maxFileBytes)
    const parsed = await parseBackupText(text)
    return {
      ...base,
      createdAt: parsed.file.createdAt,
      counts: parsed.counts,
      totalImageBytes: parsed.totalImageBytes,
      valid: true,
      error: null,
    }
  } catch (cause) {
    return { ...base, error: errorMessage(cause) }
  }
}

/**
 * 从**实际存在的 app-private 文件**发现本机备份库 + 恢复备份。
 * 每一条都重新走严格 parser；坏文件保留为 `valid:false`，不删除、不静默跳过。
 */
export async function listBackupLibrary(fs: BackupFileSystem): Promise<BackupLibraryEntry[]> {
  const dirs: Array<{ kind: BackupLibraryKind; dir: string; pattern: RegExp }> = [
    { kind: 'library', dir: backupLibraryDirectory(fs), pattern: LIBRARY_FILE_RE },
    { kind: 'recovery', dir: joinUri(fs.documentDirectory, BACKUP_DIR_NAME), pattern: RECOVERY_FILE_RE },
  ]
  const entries: BackupLibraryEntry[] = []
  for (const { kind, dir, pattern } of dirs) {
    if (!(await fs.exists(dir))) continue
    const listed = await fs.list(dir)
    for (const item of listed) {
      if (item.isDirectory || !pattern.test(item.name)) continue
      entries.push(
        await readLibraryEntry(
          fs,
          kind,
          item.name,
          item.uri,
          item.size ?? (await fs.size(item.uri)) ?? 0,
        ),
      )
    }
  }
  return entries.sort((left, right) => {
    if (left.valid !== right.valid) return left.valid ? -1 : 1
    return right.createdAt.localeCompare(left.createdAt) || right.fileName.localeCompare(left.fileName)
  })
}

/** 把一个已经预览 / 校验过的暂存文件原子地保留进本机备份库。 */
export async function retainBackupInLibrary(
  fs: BackupFileSystem,
  sourceUri: string,
  options: { now?: () => Date } = {},
): Promise<BackupExportResult> {
  const now = options.now ?? (() => new Date())
  const at = now()
  const text = await readTextLimited(fs, sourceUri, BACKUP_LIMITS.maxFileBytes)
  const parsed = await parseBackupText(text)
  const directory = backupLibraryDirectory(fs)
  await fs.ensureDirectory(directory)
  const byteLength = utf8ByteLength(text)
  const written = await writeTextAtomic(
    fs,
    directory,
    `ddlmate-library-${stampForFileName(at)}${BACKUP_FILE_SUFFIX}`,
    text,
    byteLength,
  )
  return {
    fileName: written.name,
    uri: written.uri,
    directoryUri: directory,
    byteLength,
    format: parsed.file.format,
    version: parsed.file.version,
    createdAt: parsed.file.createdAt,
    counts: parsed.counts,
    totalImageBytes: parsed.totalImageBytes,
    excludedSettings: [],
  }
}

/** 把本机备份库 / 恢复备份的同一个文件另存到系统「文件」目录。 */
export async function saveBackupLibraryEntryToDirectory(
  fs: BackupFileSystem,
  entry: Pick<BackupLibraryEntry, 'kind' | 'fileName'>,
  directoryUri: string,
): Promise<{ fileName: string; uri: string; byteLength: number }> {
  if (!validLibraryFileName(entry.kind, entry.fileName)) {
    throw new Error('这不是本机备份库里的合法文件名。')
  }
  const source = joinUri(libraryBaseDirectory(fs, entry.kind), entry.fileName)
  if (!(await fs.exists(source))) throw new Error('这份备份已经不在本机了。')
  // 列表之后文件可能变坏：外部另存前重新走同一个 parser，绝不把坏文件/半成品写出去。
  const text = await readTextLimited(fs, source, BACKUP_LIMITS.maxFileBytes)
  await parseBackupText(text)
  const byteLength = utf8ByteLength(text)
  const written = await writeTextAtomic(fs, directoryUri, entry.fileName, text, byteLength)
  return { fileName: written.name, uri: written.uri, byteLength }
}

/**
 * 打开一份本机快照的**只读内容视图**。
 *
 * 重新复制 / 解析 / 校验备份，再把图片写入唯一 `view-*` 暂存目录；所有内容来自备份
 * 文件本身，绝不从当前 Live DB 重新生成。图片只把本地 URI 交给 React，不把 base64
 * 放进界面状态。
 */
export async function openBackupContentView(
  fs: BackupFileSystem,
  entry: Pick<BackupLibraryEntry, 'kind' | 'fileName'>,
): Promise<BackupContentView> {
  if (!validLibraryFileName(entry.kind, entry.fileName)) {
    throw new Error('这不是本机备份库里的合法文件名。')
  }
  const source = joinUri(libraryBaseDirectory(fs, entry.kind), entry.fileName)
  const sourceSize = await fs.size(source)
  if (sourceSize === null || sourceSize <= 0) throw new Error('这份备份已经不在本机了。')
  if (sourceSize > BACKUP_LIMITS.maxFileBytes) throw new Error(`备份文件超过 ${BACKUP_LIMITS.maxFileBytes} 字节上限。`)
  const stagingRoot = joinUri(fs.documentDirectory, BACKUP_STAGING_DIR_NAME)
  await fs.ensureDirectory(stagingRoot)
  const viewDir = joinUri(stagingRoot, `view-${randomToken()}`)
  await fs.ensureDirectory(viewDir)
  try {
    const localSource = await fs.copyToDirectory(source, viewDir, 'source.ddlbackup.json')
    const copiedSize = await fs.size(localSource)
    if (copiedSize !== sourceSize) {
      throw new Error(`复制备份后大小不一致（源 ${sourceSize}，副本 ${copiedSize ?? '读不到'}）。`)
    }
    const text = await readTextLimited(fs, localSource, BACKUP_LIMITS.maxFileBytes)
    const parsed = await parseBackupText(text)
    const imagesDir = joinUri(viewDir, 'images')
    await fs.ensureDirectory(imagesDir)
    const stagedByImage = new Map<string, string>()
    for (const image of parsed.data.images) {
      const target = joinUri(imagesDir, `${image.sha256}.${image.format === 'png' ? 'png' : 'jpg'}`)
      await fs.writeBase64(target, image.base64)
      const size = await fs.size(target)
      if (size !== image.byteLength) throw new Error(`图片 ${image.id} 写入后大小不对。`)
      const readBack = await fs.readBase64(target)
      if (base64ByteLength(readBack) !== image.byteLength) throw new Error(`图片 ${image.id} 回读字节数不对。`)
      if (sniffBase64Format(readBack) !== image.format) throw new Error(`图片 ${image.id} 回读格式不对。`)
      if ((await sha256HexOfBase64(readBack)) !== image.sha256) throw new Error(`图片 ${image.id} 回读哈希不对。`)
      stagedByImage.set(image.id, target)
    }
    const courseById = new Map(parsed.data.courses.map((course) => [course.id, course]))
    const attemptByImage = new Map<string, BackupAttempt>()
    for (const attempt of parsed.data.attempts) {
      if (attempt.imageId && !attemptByImage.has(attempt.imageId)) attemptByImage.set(attempt.imageId, attempt)
    }
    return {
      viewDir,
      sourceName: entry.fileName,
      kind: entry.kind,
      createdAt: parsed.file.createdAt,
      counts: parsed.counts,
      totalImageBytes: parsed.totalImageBytes,
      tasks: parsed.data.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        deadline: task.deadline,
        status: task.status,
        type: task.type,
        courseName: task.courseId === null ? null : (courseById.get(task.courseId)?.name ?? null),
      })),
      courses: parsed.data.courses.map((course) => ({
        id: course.id,
        name: course.name,
        instructor: course.instructor,
        semester: course.semester,
        selectionSerial: course.selectionSerial,
        color: course.color,
      })),
      schedules: parsed.data.schedules.map((schedule) => {
        const course = courseById.get(schedule.courseId)
        return {
          id: schedule.id,
          courseName: course?.name ?? '未知课程',
          instructor: course?.instructor ?? null,
          weekday: schedule.weekday,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
          location: schedule.location,
          weekRange: schedule.weekRange,
          startWeek: schedule.startWeek,
          endWeek: schedule.endWeek,
          weekPattern: schedule.weekPattern,
          semesterStartDate: schedule.semesterStartDate,
        }
      }),
      images: parsed.data.images.map((image) => {
        const attempt = attemptByImage.get(image.id)
        return {
          imageId: image.id,
          sha256: image.sha256,
          byteLength: image.byteLength,
          width: image.width,
          height: image.height,
          format: image.format,
          capturedAt: attempt?.capturedAt ?? null,
          source: attempt?.source ?? null,
          note: attempt?.note ?? null,
          stagedUri: stagedByImage.get(image.id) as string,
        }
      }),
    }
  } catch (cause) {
    try {
      await fs.deleteDirectory(viewDir)
    } catch {
      // 不掩盖原始错误
    }
    throw cause
  }
}

/** 关闭只读内容视图时只删除本次唯一 `view-*` 暂存目录。 */
export async function closeBackupContentView(fs: BackupFileSystem, viewDir: string): Promise<void> {
  const root = joinUri(fs.documentDirectory, BACKUP_STAGING_DIR_NAME)
  const prefix = `${root}/`
  if (!viewDir.startsWith(prefix)) throw new Error('拒绝清理不属于备份暂存目录的路径。')
  const name = viewDir.slice(prefix.length)
  if (!/^view-[A-Za-z0-9-]{4,80}$/.test(name) || name.includes('..')) {
    throw new Error('拒绝清理不是本次只读视图暂存目录的路径。')
  }
  if (!(await fs.exists(viewDir))) return
  await fs.deleteDirectory(viewDir)
}

export type BackupLibraryKind = 'library' | 'recovery'

/** 本机备份库 / 恢复备份的一行元数据；只来自实际存在的 app-private 文件。 */
export interface BackupLibraryEntry {
  kind: BackupLibraryKind
  fileName: string
  uri: string
  byteLength: number
  createdAt: string
  counts: BackupCounts | null
  totalImageBytes: number
  valid: boolean
  error: string | null
}

export interface BackupContentTask {
  id: number
  title: string
  deadline: string | null
  status: string
  type: string
  courseName: string | null
}

export interface BackupContentCourse {
  id: number
  name: string
  instructor: string | null
  semester: string | null
  selectionSerial: string | null
  color: string | null
}

export interface BackupContentSchedule {
  id: number
  courseName: string
  instructor: string | null
  weekday: number
  startTime: string
  endTime: string
  location: string | null
  weekRange: string | null
  startWeek: number | null
  endWeek: number | null
  weekPattern: string
  semesterStartDate: string | null
}

export interface BackupContentImage {
  imageId: string
  sha256: string
  byteLength: number
  width: number | null
  height: number | null
  format: 'png' | 'jpeg'
  capturedAt: string | null
  source: string | null
  note: string | null
  /** 已从备份字节写入本次只读视图的 app-private 暂存文件。 */
  stagedUri: string
}

/** 只读内容视图：全部来自备份文件，不是 Live DB 实体。 */
export interface BackupContentView {
  viewDir: string
  sourceName: string
  kind: BackupLibraryKind
  createdAt: string
  counts: BackupCounts
  totalImageBytes: number
  tasks: BackupContentTask[]
  courses: BackupContentCourse[]
  schedules: BackupContentSchedule[]
  images: BackupContentImage[]
}

export interface BackupPreviewSummary {
  stageDir: string
  stagedUri: string
  sourceName: string
  fileByteLength: number
  format: string
  version: number
  createdAt: string
  appSchemaVersion: number
  counts: BackupCounts
  totalImageBytes: number
  isEmpty: boolean
  backupDigest: string
  datasetFingerprint: string
  includedSettings: readonly string[]
  excludedSettings: readonly string[]
  warnings: string[]
}

/**
 * 把系统文件选择器返回的文件复制到唯一暂存目录，再解析 / 校验。
 * 预览**只写这个暂存目录**，绝不改数据库或当前照片。
 */
export async function stageBackupForPreview(
  db: SqliteDatabase,
  fs: BackupFileSystem,
  pickedUri: string,
  options: { sourceName?: string } = {},
): Promise<BackupPreviewSummary> {
  const sourceSize = await fs.size(pickedUri)
  if (sourceSize === null) throw new BackupValidationError('选中的备份文件读不到大小。')
  if (sourceSize <= 0) throw new BackupValidationError('选中的备份文件是空的。')
  if (sourceSize > BACKUP_LIMITS.maxFileBytes) {
    throw new BackupValidationError(
      `选中的备份文件有 ${sourceSize} 字节，超过 ${BACKUP_LIMITS.maxFileBytes} 字节上限，未读取内容。`,
    )
  }

  const stagingRoot = joinUri(fs.documentDirectory, BACKUP_STAGING_DIR_NAME)
  await fs.ensureDirectory(stagingRoot)
  const stageDir = joinUri(stagingRoot, `import-${randomToken()}`)
  await fs.ensureDirectory(stageDir)
  try {
    const stagedUri = await fs.copyToDirectory(pickedUri, stageDir, 'source.ddlbackup.json')
    const copiedSize = await fs.size(stagedUri)
    if (copiedSize !== sourceSize) {
      throw new BackupValidationError(`复制备份文件后大小不一致（源 ${sourceSize}，副本 ${copiedSize ?? '读不到'}）。`)
    }
    const text = await readTextLimited(fs, stagedUri, BACKUP_LIMITS.maxFileBytes)
    const parsed = await parseBackupText(text)
    const fingerprint = await datasetFingerprint(db)
    const warnings: string[] = [
      '恢复会替换当前全部任务、课程、课表、截图库与可恢复的设置。',
      '恢复后所有任务提醒都会保持关闭，需要逐条重新开启。',
      '当前手机的 OCR 服务地址会保留，不会从备份注入。',
    ]
    if (parsed.counts.reminders > 0) {
      warnings.push(
        `备份里有 ${parsed.counts.reminders} 条提醒选择；其中 ${parsed.counts.remindersEnabled} 条原本开启，恢复后都会关闭并等待复核。`,
      )
    }
    if (isEmptyCounts(parsed.counts)) {
      warnings.push('这是一份没有任何任务、课程、课表、截图或设置的空备份。')
    }
    return {
      stageDir,
      stagedUri,
      sourceName: options.sourceName ?? '所选备份文件',
      fileByteLength: sourceSize,
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: parsed.file.createdAt,
      appSchemaVersion: parsed.file.appSchemaVersion,
      counts: parsed.counts,
      totalImageBytes: parsed.totalImageBytes,
      isEmpty: isEmptyCounts(parsed.counts),
      backupDigest: parsed.backupDigest,
      datasetFingerprint: fingerprint,
      includedSettings: INCLUDED_SETTINGS,
      excludedSettings: EXCLUDED_SETTINGS,
      warnings,
    }
  } catch (cause) {
    try {
      await fs.deleteDirectory(stageDir)
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw cause
  }
}

export interface RecoveryBackupInfo {
  fileName: string
  uri: string
  byteLength: number
  createdAt: string
  counts: BackupCounts
}

export interface BackupRestoreSuccess {
  committed: true
  counts: BackupCounts
  recoveryBackup: RecoveryBackupInfo
  refreshError: string | null
  warnings: string[]
  /** 恢复事务里递增后的本机通知路由代次（不来自备份）。 */
  notificationGeneration: number
}

export interface BackupRestoreFailure {
  committed: false
  code:
    | 'STALE_PREVIEW'
    | 'STALE_FILE'
    | 'INVALID_BACKUP'
    | 'IMAGE_STAGE_FAILED'
    | 'RECOVERY_FAILED'
    | 'DB_WRITE_FAILED'
    | 'CLEANUP_FAILED'
  reason: string
  recoveryBackup: RecoveryBackupInfo | null
  cleanupWarning: string | null
}

export type BackupRestoreOutcome = BackupRestoreSuccess | BackupRestoreFailure

export interface RestoreOptions {
  now?: () => Date
  /**
   * 事务提交后调用（刷新 / 重置导航）。
   *
   * 它失败时**不能**把已经提交的恢复说成失败：返回值 / 抛出的错误会进入
   * `refreshError`，界面只提供「重新读取」，不引导用户再恢复一次。
   */
  postCommit?: () => Promise<string | null>
}

async function deleteCreatedFiles(fs: BackupFileSystem, files: readonly string[]): Promise<string | null> {
  const failures: string[] = []
  for (const uri of [...files].reverse()) {
    try {
      await fs.deleteFile(uri)
    } catch (cause) {
      failures.push(errorMessage(cause))
    }
  }
  return failures.length > 0 ? failures.join('；') : null
}

async function countTable(db: SqliteDatabase, table: string): Promise<number> {
  const row = await db.getFirstAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table};`)
  return Number(row?.count ?? 0)
}

const AUTOINCREMENT_TABLES = new Set(['tasks', 'courses', 'schedules', 'screenshot_attempts', 'task_sources', 'source_screenshots', 'screenshot_refs', 'ocr_results', 'ocr_candidate_rows'])

/**
 * 把 AUTOINCREMENT 高水位**只往上推**到至少 `value`。
 *
 * 恢复历史截图关联时，目标实体可能已被合法删除；如果新库只把 sequence 推到
 * 现存最大 id，未来新建的任务 / 课程 / 课表可能复用那个缺失的历史 id，把旧截图
 * 误挂到新实体上。因此恢复事务里必须把 sequence 抬到「现存 id 与历史 target id
 * 的较大者」。只升不降；不存在的 sequence 行补一条。
 */
async function ensureSequenceAtLeast(db: SqliteDatabase, table: string, value: number): Promise<void> {
  if (!AUTOINCREMENT_TABLES.has(table)) throw new Error(`未知的 AUTOINCREMENT 表：${table}`)
  if (!Number.isSafeInteger(value) || value <= 0) return
  const updated = await db.runAsync(
    'UPDATE sqlite_sequence SET seq = ? WHERE name = ? AND seq < ?;',
    [value, table, value],
  )
  if (updated.changes > 0) return
  const row = await db.getFirstAsync<{ seq: number }>('SELECT seq FROM sqlite_sequence WHERE name = ?;', [table])
  if (!row) {
    await db.runAsync('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?);', [table, value])
  }
}

function expectedTableCounts(counts: BackupCounts): Array<[string, number]> {
  return [
    ['tasks', counts.tasks],
    ['courses', counts.courses],
    ['schedules', counts.schedules],
    ['task_sources', counts.taskSources],
    ['screenshot_attempts', counts.attempts],
    ['source_screenshots', counts.sources],
    ['screenshot_refs', counts.refs],
    ['ocr_results', counts.ocrResults],
    ['ocr_candidate_rows', counts.ocrCandidates],
  ]
}

export type RestorePreflight =
  | { ok: true; parsed: Awaited<ReturnType<typeof parseBackupText>> }
  | { ok: false; code: 'STALE_PREVIEW' | 'STALE_FILE' | 'INVALID_BACKUP'; reason: string }

/**
 * 恢复前的**无副作用预检**：数据指纹、暂存文件大小、备份文本 / 摘要 / 计数。
 *
 * 调用方必须在暂停通知、取消旧 OS 提醒之前调用它：过期预览或损坏文件被拒绝时，
 * 当前提醒与数据库都应保持原样，而不是先取消通知再报错。
 */
export async function preflightRestore(
  db: SqliteDatabase,
  fs: BackupFileSystem,
  preview: BackupPreviewSummary,
): Promise<RestorePreflight> {
  try {
    const currentFingerprint = await datasetFingerprint(db)
    if (currentFingerprint !== preview.datasetFingerprint) {
      return {
        ok: false,
        code: 'STALE_PREVIEW',
        reason: '预览之后本机数据有变化（任务 / 课程 / 课表 / 截图或设置被改动），请重新选择并预览备份后再恢复。',
      }
    }
    const stagedSize = await fs.size(preview.stagedUri)
    if (stagedSize === null || stagedSize !== preview.fileByteLength) {
      return { ok: false, code: 'STALE_FILE', reason: '暂存的备份文件已经变化或读不到，请重新选择文件预览。' }
    }
    const text = await readTextLimited(fs, preview.stagedUri, BACKUP_LIMITS.maxFileBytes)
    const parsed = await parseBackupText(text)
    if (
      parsed.backupDigest !== preview.backupDigest ||
      !sameBackupCounts(parsed.counts, preview.counts) ||
      parsed.totalImageBytes !== preview.totalImageBytes
    ) {
      return {
        ok: false,
        code: 'STALE_FILE',
        reason: '备份文件在预览之后被改动过，已拒绝恢复；请重新选择文件预览。',
      }
    }
    return { ok: true, parsed }
  } catch (cause) {
    return {
      ok: false,
      code: 'INVALID_BACKUP',
      reason: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

/**
 * 恢复一份已经预览过的暂存备份。
 *
 * 任何失败都返回 `committed: false`（数据库仍是原地数据）；只有事务提交后
 * `postCommit` 失败才会出现 `committed: true` + `refreshError`。
 */
export async function restoreStagedBackup(
  db: SqliteDatabase,
  fs: BackupFileSystem,
  preview: BackupPreviewSummary,
  options: RestoreOptions = {},
): Promise<BackupRestoreOutcome> {
  const now = options.now ?? (() => new Date())
  let recovery: RecoveryBackupInfo | null = null
  let stageDir: string | null = null
  const createdFinal: string[] = []
  let phase: 'validate' | 'images' | 'recovery' | 'database' = 'validate'

  try {
    // 1) 无副作用预检：过期预览 / 文件变化 / 损坏文件都在写任何东西之前拒绝。
    const preflight = await preflightRestore(db, fs, preview)
    if (!preflight.ok) {
      return {
        committed: false,
        code: preflight.code,
        reason: preflight.reason,
        recoveryBackup: null,
        cleanupWarning: null,
      }
    }
    const parsed = preflight.parsed

    // 2) 把每张图写进唯一暂存目录，并回读校验字节 / 哈希 / 格式。
    phase = 'images'
    const stagingRoot = joinUri(fs.documentDirectory, BACKUP_STAGING_DIR_NAME)
    await fs.ensureDirectory(stagingRoot)
    stageDir = joinUri(stagingRoot, `restore-${randomToken()}`)
    await fs.ensureDirectory(stageDir)
    const staged = new Map<string, string>()
    for (const image of parsed.data.images) {
      const part = joinUri(stageDir, `${image.id}.part`)
      await fs.writeBase64(part, image.base64)
      const size = await fs.size(part)
      if (size !== image.byteLength) {
        throw new Error(`图片 ${image.id} 写入后大小不对（期望 ${image.byteLength}，实际 ${size ?? '读不到'}）。`)
      }
      const readBack = await fs.readBase64(part)
      if (base64ByteLength(readBack) !== image.byteLength) throw new Error(`图片 ${image.id} 回读字节数不对。`)
      if (sniffBase64Format(readBack) !== image.format) throw new Error(`图片 ${image.id} 回读格式不对。`)
      const sha = await sha256HexOfBase64(readBack)
      if (sha !== image.sha256) throw new Error(`图片 ${image.id} 回读哈希不对。`)
      staged.set(image.id, part)
    }

    // 3) 生成应用自己的最终文件名（绝不使用导入的路径）。已存在的同内容文件复用；
    //    同名但内容不一致时使用唯一新名字，绝不覆盖既有照片。
    const screenshotsDir = joinUri(fs.documentDirectory, SCREENSHOT_DIR_NAME)
    await fs.ensureDirectory(screenshotsDir)
    const finalByImage = new Map<string, string>()
    for (const image of parsed.data.images) {
      const part = staged.get(image.id)
      if (!part) throw new Error(`图片 ${image.id} 没有暂存文件。`)
      const contentName = archiveFileName(0, image.sha256, image.format)
      const contentTarget = joinUri(screenshotsDir, contentName)
      let target: string | null = null
      if (await fs.exists(contentTarget)) {
        const existingSize = await fs.size(contentTarget)
        if (existingSize === image.byteLength) {
          const existingBase64 = await fs.readBase64(contentTarget)
          if ((await sha256HexOfBase64(existingBase64)) === image.sha256) target = contentTarget
        }
      }
      if (target === null) {
        if (!(await fs.exists(contentTarget))) {
          await fs.move(part, contentTarget)
          const movedSize = await fs.size(contentTarget)
          if (movedSize !== image.byteLength) throw new Error(`图片 ${image.id} 迁移后大小不对。`)
          createdFinal.push(contentTarget)
          target = contentTarget
        } else {
          // 既有文件同名但内容不一致：保留它，另写一个唯一名字。
          const existingNames = new Set(await fs.listNames(screenshotsDir))
          const unique = uniqueName(
            existingNames,
            `restore-${stampForFileName(now())}-${image.sha256.slice(0, 16)}.${image.format === 'png' ? 'png' : 'jpg'}`,
          )
          const uniqueTarget = joinUri(screenshotsDir, unique)
          await fs.move(part, uniqueTarget)
          const movedSize = await fs.size(uniqueTarget)
          if (movedSize !== image.byteLength) throw new Error(`图片 ${image.id} 迁移后大小不对。`)
          createdFinal.push(uniqueTarget)
          target = uniqueTarget
        }
      }
      if (target === null) throw new Error(`图片 ${image.id} 没有可用的最终文件。`)
      finalByImage.set(image.id, target)
    }

    // 4) 当前数据的完整恢复备份（必须在替换前成功）。
    phase = 'recovery'
    const backupsDir = joinUri(fs.documentDirectory, BACKUP_DIR_NAME)
    await fs.ensureDirectory(backupsDir)
    const recoveryExport = await exportBackupToDirectory(db, fs, backupsDir, {
      now,
      fileNamePrefix: 'ddlmate-recovery',
    })
    recovery = {
      fileName: recoveryExport.fileName,
      uri: recoveryExport.uri,
      byteLength: recoveryExport.byteLength,
      createdAt: recoveryExport.createdAt,
      counts: recoveryExport.counts,
    }
    if (!recovery) throw new Error('恢复备份没有生成成功，已停止替换数据。')
    const recoveryInfo = recovery

    // 5) 单个 SQLite 事务整库替换。
    phase = 'database'
    const endpoint = await db.getFirstAsync<{ value: string; updated_at: string }>(
      'SELECT value, updated_at FROM app_settings WHERE key = ?;',
      [APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT],
    )
    const generationRow = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?;',
      [APP_SETTINGS_KEYS.NOTIFICATION_ROUTE_GENERATION],
    )
    const previousGeneration = Number(generationRow?.value)
    const notificationGeneration =
      Number.isSafeInteger(previousGeneration) && previousGeneration >= 0 ? previousGeneration + 1 : 1
    const nowIso = now().toISOString()
    const reminderByTask = new Map(parsed.reminders.map((entry) => [entry.taskId, entry.intent]))
    const settingsToInsert: BackupSetting[] = []
    for (const setting of parsed.data.settings) {
      if (setting.key === FOCUS_KEY) {
        settingsToInsert.push({ ...setting, value: focusForRestore(setting.value), updatedAt: nowIso })
        continue
      }
      if (setting.key === CLASS_REMINDER_KEY) {
        settingsToInsert.push({ ...setting, value: JSON.stringify({ ...decodeClassReminderSettings(setting.value), enabled: false }), updatedAt: nowIso })
        continue
      }
      if (reminderByTask.has(Number(setting.key.slice('task_reminder.'.length)))) {
        const taskId = Number(setting.key.slice('task_reminder.'.length))
        const intent = reminderByTask.get(taskId)
        if (!intent) continue
        settingsToInsert.push({ key: setting.key, value: disabledReminderValue(intent, nowIso), updatedAt: nowIso })
      } else {
        settingsToInsert.push(setting)
      }
    }
    if (endpoint && endpoint.value.trim().length > 0) {
      settingsToInsert.push({
        key: APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT,
        value: endpoint.value,
        updatedAt: endpoint.updated_at,
      })
    }
    /**
     * 历史截图关联可能指向已被合法删除的任务 / 课程 / 课表。恢复后新库必须把
     * 对应 AUTOINCREMENT 高水位推到「现存最大 id」和「历史 target id」的较大者，
     * 否则未来新建实体会复用缺失 id，把旧截图误挂到新实体上。
     */
    const restoredCourseIds = new Set(parsed.data.courses.map((row) => row.id))
    const restoredScheduleIds = new Set(parsed.data.schedules.map((row) => row.id))
    const restoredTaskIds = new Set(parsed.data.tasks.map((row) => row.id))
    const historicalMax = { COURSE: 0, SCHEDULE: 0, TASK: 0 }
    for (const ref of parsed.data.refs) {
      if (ref.targetKind === 'COURSE' && !restoredCourseIds.has(ref.targetId)) {
        historicalMax.COURSE = Math.max(historicalMax.COURSE, ref.targetId)
      } else if (ref.targetKind === 'SCHEDULE' && !restoredScheduleIds.has(ref.targetId)) {
        historicalMax.SCHEDULE = Math.max(historicalMax.SCHEDULE, ref.targetId)
      } else if (ref.targetKind === 'TASK' && !restoredTaskIds.has(ref.targetId)) {
        historicalMax.TASK = Math.max(historicalMax.TASK, ref.targetId)
      }
    }
    /**
     * 模板 / 重复规则里的历史引用也必须参与 AUTOINCREMENT 高水位：
     * - 模板可能保留一个已被删除课程的 id；若恢复后新课程复用了该 id，
     *   下次应用模板就会**悄悄挂错课程**（必须避免）；
     * - 生成账本可能指向用户已删除的任务；若恢复后新任务复用了该 id，
     *   账本就会把“已删除的历史”误认成“仍然存在的已创建任务”。
     *
     * 这里只升高水位，不重建任何缺失实体，也不改写任何引用。
     */
    const templateSetting = parsed.data.settings.find((setting) => setting.key === APP_SETTINGS_KEYS.TASK_TEMPLATES)
    if (templateSetting) {
      const decoded = decodeTemplateStore(templateSetting.value)
      if (decoded.ok) {
        for (const template of decoded.store.templates) {
          if (template.courseId !== null) historicalMax.COURSE = Math.max(historicalMax.COURSE, template.courseId)
        }
      }
    }
    const recurrenceSetting = parsed.data.settings.find((setting) => setting.key === APP_SETTINGS_KEYS.TASK_RECURRENCE)
    if (recurrenceSetting) {
      const decoded = decodeRecurrenceStore(recurrenceSetting.value)
      if (decoded.ok) {
        for (const rule of decoded.store.rules) {
          if (rule.courseId !== null) historicalMax.COURSE = Math.max(historicalMax.COURSE, rule.courseId)
        }
        for (const entry of decoded.store.ledger) {
          if (entry.taskId !== null) historicalMax.TASK = Math.max(historicalMax.TASK, entry.taskId)
        }
      }
    }
    const revisionSetting = parsed.data.settings.find((setting) => setting.key === EXAM_REVISION_KEY)
    if (revisionSetting) {
      for (const plan of decodeExamRevisionStore(revisionSetting.value).plans) {
        historicalMax.TASK = Math.max(historicalMax.TASK, plan.examId, ...plan.taskIds)
      }
    }
    const restoredMax = {
      courses: parsed.data.courses.reduce((max, row) => Math.max(max, row.id), 0),
      schedules: parsed.data.schedules.reduce((max, row) => Math.max(max, row.id), 0),
      tasks: parsed.data.tasks.reduce((max, row) => Math.max(max, row.id), 0),
    }
    const sequenceHighWater = {
      courses: Math.max(restoredMax.courses, historicalMax.COURSE),
      schedules: Math.max(restoredMax.schedules, historicalMax.SCHEDULE),
      tasks: Math.max(restoredMax.tasks, historicalMax.TASK),
    }
    // 本机通知路由代次绝不从备份导入：只保留当前值并 +1，作为旧通知的失效边界。
    settingsToInsert.push({
      key: APP_SETTINGS_KEYS.NOTIFICATION_ROUTE_GENERATION,
      value: String(notificationGeneration),
      updatedAt: nowIso,
    })

    await db.withTransactionAsync(async () => {
      // 子表 → 父表；app_settings 没有外键，放最后。
      for (const table of [
        'ocr_candidate_rows',
        'ocr_results',
        'screenshot_refs',
        'source_screenshots',
        'screenshot_attempts',
        'task_sources',
        'tasks',
        'schedules',
        'courses',
        'app_settings',
      ]) {
        await db.runAsync(`DELETE FROM ${table};`)
      }

      for (const course of parsed.data.courses) {
        await db.runAsync(
          `INSERT INTO courses (id, code, name, instructor, semester, color, note, selection_serial, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            course.id,
            course.code,
            course.name,
            course.instructor,
            course.semester,
            course.color,
            course.note,
            course.selectionSerial,
            course.createdAt,
            course.updatedAt,
          ],
        )
      }
      for (const schedule of parsed.data.schedules) {
        await db.runAsync(
          `INSERT INTO schedules
             (id, course_id, weekday, start_time, end_time, location, period_start, period_end, week_range,
              semester_start_date, start_week, end_week, week_pattern, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            schedule.id,
            schedule.courseId,
            schedule.weekday,
            schedule.startTime,
            schedule.endTime,
            schedule.location,
            schedule.periodStart,
            schedule.periodEnd,
            schedule.weekRange,
            schedule.semesterStartDate,
            schedule.startWeek,
            schedule.endWeek,
            schedule.weekPattern,
            schedule.createdAt,
            schedule.updatedAt,
          ],
        )
      }
      for (const task of parsed.data.tasks) {
        await db.runAsync(
          `INSERT INTO tasks
             (id, title, description, course_id, type, status, priority, deadline, estimated_minutes,
              submit_requirement, submit_method, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            task.id,
            task.title,
            task.description,
            task.courseId,
            task.type,
            task.status,
            task.priority,
            task.deadline,
            task.estimatedMinutes,
            task.submitRequirement,
            task.submitMethod,
            task.completedAt,
            task.createdAt,
            task.updatedAt,
          ],
        )
      }
      for (const source of parsed.data.taskSources) {
        await db.runAsync(
          'INSERT INTO task_sources (id, task_id, kind, raw_text, created_at) VALUES (?, ?, ?, ?, ?);',
          [source.id, source.taskId, source.kind, source.rawText, source.createdAt],
        )
      }
      for (const attempt of parsed.data.attempts) {
        const image = attempt.imageId ? parsed.data.images.find((entry) => entry.id === attempt.imageId) : null
        const archivedPath = attempt.imageId ? (finalByImage.get(attempt.imageId) ?? null) : null
        if (attempt.imageId && !archivedPath) throw new Error(`截图 #${attempt.id} 没有可写入的最终图片路径。`)
        await db.runAsync(
          `INSERT INTO screenshot_attempts
             (id, captured_at, source, status, archived_path, original_uri, sha256, byte_length, width, height,
              format, mime_type, upload_format, upload_scale, upload_quality, upload_byte_length, resized,
              dedup_of_attempt_id, error_code, error_message, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            attempt.id,
            attempt.capturedAt,
            attempt.source,
            attempt.status,
            archivedPath,
            // 绝不把旧设备的原始 URI 带进恢复后的数据。
            null,
            image?.sha256 ?? null,
            image?.byteLength ?? null,
            image?.width ?? attempt.width,
            image?.height ?? attempt.height,
            image?.format ?? attempt.format,
            image ? (image.format === 'png' ? 'image/png' : 'image/jpeg') : attempt.mimeType,
            attempt.uploadFormat,
            attempt.uploadScale,
            attempt.uploadQuality,
            attempt.uploadByteLength,
            attempt.resized ? 1 : 0,
            attempt.dedupOfAttemptId,
            attempt.errorCode,
            attempt.errorMessage,
            attempt.note,
            attempt.createdAt,
            attempt.updatedAt,
          ],
        )
      }
      for (const source of parsed.data.sources) {
        await db.runAsync(
          `INSERT INTO source_screenshots
             (id, catalog_key, title, description, archive_rel_path, sha256, byte_length, width, height,
              layout, captured_at, provenance, foreign_attempt_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            source.id,
            source.catalogKey,
            source.title,
            source.description,
            source.archiveRelPath,
            source.sha256,
            source.byteLength,
            source.width,
            source.height,
            source.layout,
            source.capturedAt,
            source.provenance,
            source.foreignAttemptId,
            source.createdAt,
            source.updatedAt,
          ],
        )
      }
      for (const ref of parsed.data.refs) {
        await db.runAsync(
          `INSERT INTO screenshot_refs (id, attempt_id, target_kind, target_id, relation, created_at)
           VALUES (?, ?, ?, ?, ?, ?);`,
          [ref.id, ref.attemptId, ref.targetKind, ref.targetId, ref.relation, ref.createdAt],
        )
      }
      for (const result of parsed.data.ocrResults) {
        await db.runAsync(
          `INSERT INTO ocr_results
             (id, attempt_id, request_id, layout, week, status, error_code, error_message, candidate_count,
              warnings_json, payload_json, raw_text, ocr_calls, duration_ms, image_width, image_height,
              image_format, image_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            result.id,
            result.attemptId,
            result.requestId,
            result.layout,
            result.week,
            result.status,
            result.errorCode,
            result.errorMessage,
            result.candidateCount,
            result.warningsJson,
            result.payloadJson,
            result.rawText,
            result.ocrCalls,
            result.durationMs,
            result.imageWidth,
            result.imageHeight,
            result.imageFormat,
            result.imageBytes,
            result.createdAt,
          ],
        )
      }
      for (const candidate of parsed.data.ocrCandidates) {
        await db.runAsync(
          `INSERT INTO ocr_candidate_rows
             (id, result_id, row_index, name, weekday, start_time, end_time, location, start_week, end_week,
              week_pattern, selection_serial, raw_text, warnings_json, imported, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            candidate.id,
            candidate.resultId,
            candidate.rowIndex,
            candidate.name,
            candidate.weekday,
            candidate.startTime,
            candidate.endTime,
            candidate.location,
            candidate.startWeek,
            candidate.endWeek,
            candidate.weekPattern,
            candidate.selectionSerial,
            candidate.rawText,
            candidate.warningsJson,
            candidate.imported ? 1 : 0,
            candidate.createdAt,
          ],
        )
      }
      for (const setting of settingsToInsert) {
        await db.runAsync(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [setting.key, setting.value, setting.updatedAt],
        )
      }

      // 只升不降；包含历史 target id，防止恢复后新实体复用缺失 id。
      await ensureSequenceAtLeast(db, 'tasks', sequenceHighWater.tasks)
      await ensureSequenceAtLeast(db, 'courses', sequenceHighWater.courses)
      await ensureSequenceAtLeast(db, 'schedules', sequenceHighWater.schedules)

      const fkRows = await db.getAllAsync<{ table: string; rowid: number; parent: string; fkid: number }>(
        'PRAGMA foreign_key_check;',
      )
      if (fkRows.length > 0) {
        const first = fkRows[0]!
        throw new Error(`恢复后的外键检查失败（${first.table} rowid=${first.rowid} → ${first.parent}）。`)
      }
      for (const [table, expected] of expectedTableCounts(parsed.counts)) {
        const actual = await countTable(db, table)
        if (actual !== expected) {
          throw new Error(`恢复后的 ${table} 行数不对（期望 ${expected}，实际 ${actual}）。`)
        }
      }
      const expectedSettings = new Set(settingsToInsert.map((setting) => setting.key))
      const actualSettings = await db.getAllAsync<{ key: string }>('SELECT key FROM app_settings ORDER BY key ASC;')
      const actualKeys = new Set(actualSettings.map((row) => row.key))
      if (actualKeys.size !== expectedSettings.size || [...expectedSettings].some((key) => !actualKeys.has(key))) {
        throw new Error('恢复后的设置项集合与备份不一致（可能包含设备专属设置或漏写）。')
      }
    })

    // 6) 提交后刷新：失败只报告，绝不把已提交的恢复说成失败。
    let refreshError: string | null = null
    if (options.postCommit) {
      try {
        refreshError = await options.postCommit()
      } catch (cause) {
        refreshError = errorMessage(cause)
      }
    }
    return {
      committed: true,
      counts: parsed.counts,
      recoveryBackup: recoveryInfo,
      refreshError,
      notificationGeneration,
      warnings: [
        '数据已整库替换；当前照片与恢复操作新建的图片都在应用私有目录里。',
        '所有任务提醒已改为关闭；请到「提醒设置」逐条复核并重新开启。',
        '任务模板与重复规则已随备份恢复；生成账本会避免同一规则同一天被重复创建。',
        '恢复前的完整恢复备份已保存在本机「备份与恢复」页，可再次保存到系统文件。',
      ],
    }
  } catch (cause) {
    const cleanupWarning = await deleteCreatedFiles(fs, createdFinal)
    const code: BackupRestoreFailure['code'] =
      cause instanceof BackupValidationError
        ? 'INVALID_BACKUP'
        : phase === 'images'
          ? 'IMAGE_STAGE_FAILED'
          : phase === 'recovery'
            ? 'RECOVERY_FAILED'
            : phase === 'database'
              ? 'DB_WRITE_FAILED'
              : 'INVALID_BACKUP'
    return {
      committed: false,
      code,
      reason: errorMessage(cause),
      recoveryBackup: recovery,
      cleanupWarning,
    }
  } finally {
    if (stageDir) {
      try {
        await fs.deleteDirectory(stageDir)
      } catch {
        // 暂存目录清理失败不影响数据库事实；下一次备份会重新建唯一目录。
      }
    }
  }
}

/** 取消预览 / 离开页面时清理**本次操作唯一**的暂存目录。 */
export async function discardBackupStaging(fs: BackupFileSystem, stageDir: string): Promise<void> {
  const root = joinUri(fs.documentDirectory, BACKUP_STAGING_DIR_NAME)
  // 只允许清理**本模块刚创建的唯一 import-* 直接子目录**：
  // - 根目录本身不能删（否则会连带删掉别的会话）；
  // - restore-* / 其它兄弟目录不能删；
  // - 路径分隔符 / `..` 不能出现在名字里。
  const prefix = `${root}/`
  if (!stageDir.startsWith(prefix)) {
    throw new Error('拒绝清理不属于备份暂存目录的路径。')
  }
  const name = stageDir.slice(prefix.length)
  if (!/^import-[A-Za-z0-9-]{4,80}$/.test(name) || name.includes('..')) {
    throw new Error('拒绝清理不是本次唯一 import 暂存目录的路径。')
  }
  if (!(await fs.exists(stageDir))) return
  await fs.deleteDirectory(stageDir)
}

/* ------------------------------- 恢复备份列表 ------------------------------- */

export interface RecoveryBackupFile {
  fileName: string
  uri: string
  byteLength: number | null
}

export async function listRecoveryBackups(fs: BackupFileSystem): Promise<RecoveryBackupFile[]> {
  const dir = joinUri(fs.documentDirectory, BACKUP_DIR_NAME)
  if (!(await fs.exists(dir))) return []
  const entries = await fs.list(dir)
  return entries
    .filter(
      (entry) =>
        !entry.isDirectory &&
        entry.name.startsWith('ddlmate-recovery-') &&
        entry.name.endsWith(BACKUP_FILE_SUFFIX) &&
        !entry.name.includes('.part-'),
    )
    .map((entry) => ({ fileName: entry.name, uri: entry.uri, byteLength: entry.size }))
    .sort((left, right) => right.fileName.localeCompare(left.fileName))
}

const SAFE_BACKUP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ddlbackup\.json$/

export async function saveRecoveryBackupToDirectory(
  fs: BackupFileSystem,
  fileName: string,
  directoryUri: string,
): Promise<{ fileName: string; uri: string; byteLength: number }> {
  if (!SAFE_BACKUP_FILE_NAME.test(fileName)) throw new Error('恢复备份文件名不合法。')
  const source = joinUri(fs.documentDirectory, BACKUP_DIR_NAME, fileName)
  if (!(await fs.exists(source))) throw new Error('这份恢复备份已经不在本机了。')
  const size = await fs.size(source)
  if (size === null || size <= 0) throw new Error('恢复备份读不到大小。')
  const existing = new Set(await fs.listNames(directoryUri))
  const targetName = uniqueName(existing, fileName)
  const target = await fs.copyToDirectory(source, directoryUri, targetName)
  const copied = await fs.size(target)
  if (copied !== size) throw new Error(`保存后字节数不对（期望 ${size}，实际 ${copied ?? '读不到'}）。`)
  return { fileName: targetName, uri: target, byteLength: size }
}

/** 只给 UI 显示用的短说明；不包含任何文件路径或 SQL 细节。 */
export function describeBackupCounts(counts: BackupCounts): string {
  return `${counts.tasks} 个任务、${counts.courses} 门课程、${counts.schedules} 条课表、${counts.images} 张截图`
}

export const BACKUP_SETTINGS_INCLUDED = [
  '教学周校准',
  '每日学习参考用时',
  '今日学习计划',
  '任务步骤清单',
  '任务提醒选择（恢复后关闭待复核）',
  '上课前提醒设置（恢复后关闭待复核）',
] as const

export const BACKUP_SETTINGS_EXCLUDED = [
  '本机 OCR 服务地址（保留当前手机设置）',
  '已消费的通知点击回执（旧 OS 标识不复制）',
] as const

const INCLUDED_SETTINGS = BACKUP_SETTINGS_INCLUDED
const EXCLUDED_SETTINGS = BACKUP_SETTINGS_EXCLUDED
