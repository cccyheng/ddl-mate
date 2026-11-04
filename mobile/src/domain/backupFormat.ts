/**
 * 「本机数据备份」的**单一便携文件格式**（纯逻辑，可跑在 Hermes 与 Node）。
 *
 * 为什么是 JSON 容器而不是 ZIP / SQLite 副本：
 * - 不新增依赖、不依赖电脑或服务器，用户能在系统「文件」里直接保存一份；
 * - 截图必须**真的在文件里**（不是只存手机上的绝对路径），因此每份字节以
 *   SHA-256 去重后内嵌一次，截图行通过 `imageId` 引用它；
 * - 文本结构可逐字段严格校验：格式 / 版本 / 计数 / 哈希 / 外键 / 业务规则
 *   任何一处不对，都能在**写库之前**拒绝，并给出可读原因。
 *
 * 这个文件只做「读 / 写 / 校验」，不接触文件系统、React 或原生模块。
 * 真正的导出、预览、恢复流程在 `backupService.ts`。
 */

import { SCHEMA_VERSION, APP_SETTINGS_KEYS, TASK_STEPS_KEY_PREFIX, taskStepsKey } from '../db/schema'
import { CLASS_REMINDER_KEY, decodeClassReminderSettings } from './classReminder'
import { FOCUS_KEY, decodeFocus } from './focusTime'
import { WEEKLY_GOAL_KEY, decodeWeeklyGoals } from './weeklyGoal'
import {
  COURSE_LIMITS,
  normalizeCourseDraft,
  normalizeScheduleDraft,
} from './courseDraft'
import {
  isDateOnlyDeadline,
  isValidDateKey,
  isMonday,
  offsetIsoToShanghaiParts,
  parseOffsetIso,
  shanghaiWallClockToOffset,
} from './datetime'
import { sha256Hex, sha256HexOfBase64 } from './hashing'
import { base64ByteLength, readEncodedSize, sniffBase64Format } from './photoFiles'
import { MAX_ARCHIVE_BYTES } from './screenshotFiles'
import { parseStudyReferenceMinutes } from './studyReference'
import { TASK_LIMITS } from './taskDraft'
import { decodeTaskSteps } from './taskSteps'
import {
  TASK_REMINDER_KEY_PREFIX,
  decodeTaskReminder,
  encodeTaskReminder,
  isReminderLeadMinutes,
  type TaskReminderIntent,
} from './taskReminder'
import { TASK_REMINDER_RECEIPT_KEY } from './taskReminderNotificationReceipts'
import { decodeTemplateStore } from './taskTemplate'
import { decodeRecurrenceStore } from './recurrence'
import { decodeExamRevisionStore, EXAM_REVISION_KEY } from './examRevisionRepository'
import { parseTodayPlanPayload } from './todayPlanRepository'
import { createCalibration } from './teachingWeek'
import { isValidTeachingWeek } from './teachingWeekRange'

/* ------------------------------- 格式常量 ------------------------------- */

export const BACKUP_FORMAT = 'ddlmate.native-backup' as const
export const BACKUP_FORMAT_VERSION = 1 as const
export const BACKUP_FILE_SUFFIX = '.ddlbackup.json'

/**
 * 上限（在**读取/解码大块数据之前**检查）：
 * - 单个备份文件 96 MiB；内嵌图片合计 64 MiB（base64 膨胀后仍在此文件上限内）；
 * - 单张图片沿用截图库已有的 25 MiB 原图上限；
 * - 其它行数 / 字符串长度都是防御性上限，超过直接拒绝，绝不截断。
 */
export const BACKUP_LIMITS = {
  maxFileBytes: 96 * 1024 * 1024,
  maxTotalImageBytes: 64 * 1024 * 1024,
  maxImageBytes: MAX_ARCHIVE_BYTES,
  maxImages: 300,
  maxTasks: 20_000,
  maxCourses: 5_000,
  maxSchedules: 50_000,
  maxTaskSources: 50_000,
  maxAttempts: 5_000,
  maxSources: 5_000,
  maxRefs: 200_000,
  maxOcrResults: 20_000,
  maxOcrCandidates: 400_000,
  maxSettings: 20_000,
  maxTextBytes: 1_000_000,
  maxJsonBytes: 2_000_000,
  maxSettingValueBytes: 2_000_000,
  maxShortText: 512,
} as const

export const INCLUDED_SETTINGS_DESCRIPTION = [
  '教学周校准（学期首周一 / 校准周次 / 校准日期）',
  '每日学习参考用时',
  '今日学习计划',
  '任务模板（只包含用户显式勾选的可复用内容，不含截止时间 / 完成状态 / 原始通知）',
  '重复任务规则与生成账本（用于恢复后仍避免同一规则同一天重复创建）',
  '考试复习安排与已创建任务的关联',
  '每一条任务的步骤清单',
  '每一条任务的提醒选择（恢复后一律先关闭，需重新开启）',
  '上课前提醒设置（恢复后关闭，需重新开启）',
] as const

export const EXCLUDED_SETTINGS_DESCRIPTION = [
  '本机 OCR 服务地址（恢复时保留当前手机的地址，不从备份注入）',
  '已消费的通知点击回执（旧设备/旧通知的 OS 标识不应带到恢复后的数据里）',
] as const

/* ------------------------------- 类型定义 ------------------------------- */

export interface BackupCounts {
  tasks: number
  courses: number
  schedules: number
  taskSources: number
  images: number
  attempts: number
  sources: number
  refs: number
  ocrResults: number
  ocrCandidates: number
  settings: number
  taskSteps: number
  reminders: number
  remindersEnabled: number
  totalImageBytes: number
}

export interface BackupImage {
  id: string
  sha256: string
  byteLength: number
  width: number | null
  height: number | null
  format: 'png' | 'jpeg'
  base64: string
}

export interface BackupTask {
  id: number
  title: string
  description: string | null
  courseId: number | null
  type: string
  status: string
  priority: number
  deadline: string | null
  estimatedMinutes: number | null
  submitRequirement: string | null
  submitMethod: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface BackupCourse {
  id: number
  code: string
  name: string
  instructor: string | null
  semester: string | null
  color: string | null
  note: string | null
  selectionSerial: string | null
  createdAt: string
  updatedAt: string
}

export interface BackupSchedule {
  id: number
  courseId: number
  weekday: number
  startTime: string
  endTime: string
  location: string | null
  periodStart: number | null
  periodEnd: number | null
  weekRange: string | null
  semesterStartDate: string | null
  startWeek: number | null
  endWeek: number | null
  weekPattern: string
  createdAt: string
  updatedAt: string
}

export interface BackupTaskSource {
  id: number
  taskId: number
  kind: string
  rawText: string
  createdAt: string
}

export interface BackupAttempt {
  id: number
  capturedAt: string
  source: string
  status: string
  /** 指向 `images[].id`；`null` = 这次尝试本来就没有落盘的图（ARCHIVE_FAILED）。 */
  imageId: string | null
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

export interface BackupSource {
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

export interface BackupRef {
  id: number
  attemptId: number
  targetKind: string
  targetId: number
  relation: string
  createdAt: string
}

export interface BackupOcrResult {
  id: number
  attemptId: number
  requestId: string | null
  layout: string | null
  week: number | null
  status: string
  errorCode: string | null
  errorMessage: string | null
  candidateCount: number
  warningsJson: string | null
  payloadJson: string | null
  rawText: string | null
  ocrCalls: number | null
  durationMs: number | null
  imageWidth: number | null
  imageHeight: number | null
  imageFormat: string | null
  imageBytes: number | null
  createdAt: string
}

export interface BackupOcrCandidate {
  id: number
  resultId: number
  rowIndex: number
  name: string | null
  weekday: number | null
  startTime: string | null
  endTime: string | null
  location: string | null
  startWeek: number | null
  endWeek: number | null
  weekPattern: string | null
  selectionSerial: string | null
  rawText: string | null
  warningsJson: string | null
  imported: boolean
  createdAt: string
}

export interface BackupSetting {
  key: string
  value: string
  updatedAt: string
}

export interface BackupData {
  tasks: BackupTask[]
  courses: BackupCourse[]
  schedules: BackupSchedule[]
  taskSources: BackupTaskSource[]
  images: BackupImage[]
  attempts: BackupAttempt[]
  sources: BackupSource[]
  refs: BackupRef[]
  ocrResults: BackupOcrResult[]
  ocrCandidates: BackupOcrCandidate[]
  settings: BackupSetting[]
}

export interface BackupManifest {
  counts: BackupCounts
  totalImageBytes: number
  isEmpty: boolean
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_FORMAT_VERSION
  createdAt: string
  appSchemaVersion: number
  manifest: BackupManifest
  integrity: { algorithm: 'sha256'; digest: string }
  data: BackupData
}

export interface ParsedBackup {
  file: BackupFile
  data: BackupData
  counts: BackupCounts
  totalImageBytes: number
  backupDigest: string
  /** 恢复时需要改写成「关闭、待复核」的提醒（按任务 id）。 */
  reminders: Array<{ taskId: number; intent: TaskReminderIntent }>
  taskSteps: Array<{ taskId: number; steps: ReturnType<typeof decodeTaskSteps> }>
}

export class BackupValidationError extends Error {
  override readonly name = 'BackupValidationError'
}

/* --------------------------- 通用编解码 / 哈希 --------------------------- */

function fail(path: string, message: string): never {
  throw new BackupValidationError(`${path}：${message}`)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 键排序后的规范 JSON；用于「内容摘要」与「预览指纹」，不受对象键顺序影响。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

/** UTF-8 字节长度（不分配大数组，只数一遍）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else bytes += 3
  }
  return bytes
}

/** 文本 → UTF-8 字节（两遍分配，避免 `number[]` 把大字符串撑爆）。 */
export function utf8Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8ByteLength(text))
  let offset = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes[offset++] = code
    } else if (code < 0x800) {
      bytes[offset++] = 0xc0 | (code >> 6)
      bytes[offset++] = 0x80 | (code & 0x3f)
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        bytes[offset++] = 0xf0 | (codePoint >> 18)
        bytes[offset++] = 0x80 | ((codePoint >> 12) & 0x3f)
        bytes[offset++] = 0x80 | ((codePoint >> 6) & 0x3f)
        bytes[offset++] = 0x80 | (codePoint & 0x3f)
        index += 1
      } else {
        bytes[offset++] = 0xe0 | (code >> 12)
        bytes[offset++] = 0x80 | ((code >> 6) & 0x3f)
        bytes[offset++] = 0x80 | (code & 0x3f)
      }
    } else {
      bytes[offset++] = 0xe0 | (code >> 12)
      bytes[offset++] = 0x80 | ((code >> 6) & 0x3f)
      bytes[offset++] = 0x80 | (code & 0x3f)
    }
  }
  return bytes
}

export async function sha256OfText(text: string): Promise<string> {
  return sha256Hex(utf8Bytes(text))
}

/**
 * 备份内容摘要：覆盖所有「可恢复数据」与图片的**元数据**（id/sha/大小/格式）。
 *
 * 刻意不把每张图的 base64 再拼进来：图片字节本身已由逐张 SHA-256 校验；
 * 这样摘要只处理很小的文本，避免为了完整性再复制一份几十 MB 的字符串。
 */
export async function backupDataDigest(data: BackupData): Promise<string> {
  const metadata = data.images.map((image) => ({
    id: image.id,
    sha256: image.sha256,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    format: image.format,
  }))
  return sha256OfText(
    canonicalJson({
      tasks: data.tasks,
      courses: data.courses,
      schedules: data.schedules,
      taskSources: data.taskSources,
      images: metadata,
      attempts: data.attempts,
      sources: data.sources,
      refs: data.refs,
      ocrResults: data.ocrResults,
      ocrCandidates: data.ocrCandidates,
      settings: data.settings,
    }),
  )
}

/* ------------------------------- 字段校验 ------------------------------- */

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, '必须是对象。')
  return value
}

function exactlyKeys(object: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(object).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(path, `字段不符合备份格式（期望 ${wanted.join(', ')}；实际 ${actual.join(', ') || '空'}）。`)
  }
}

function asArray(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, '必须是数组。')
  if (value.length > max) fail(path, `条数 ${value.length} 超过上限 ${max}。`)
  return value
}

function asString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable?: false },
): string
function asString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable: true },
): string | null
function asString(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable?: boolean } = {},
): string | null {
  if (value === null && options.nullable) return null
  if (typeof value !== 'string') fail(path, '必须是文本。')
  const min = options.min ?? 0
  const max = options.max ?? BACKUP_LIMITS.maxShortText
  if (value.length < min) fail(path, `至少需要 ${min} 个字符。`)
  if (value.length > max) fail(path, `超过 ${max} 个字符的上限（实际 ${value.length}）。`)
  return value
}

function asInt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable?: false },
): number
function asInt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable: true },
): number | null
function asInt(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; nullable?: boolean } = {},
): number | null {
  if (value === null && options.nullable) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(path, '必须是整数。')
  const min = options.min ?? Number.MIN_SAFE_INTEGER
  const max = options.max ?? Number.MAX_SAFE_INTEGER
  if (value < min || value > max) fail(path, `必须在 ${min}–${max} 之间（实际 ${value}）。`)
  return value
}

function asNumber(
  value: unknown,
  path: string,
  options: { nullable?: boolean } = {},
): number | null {
  if (value === null && options.nullable) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字。')
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, '必须是布尔值。')
  return value
}

function asEnum(value: unknown, allowed: readonly string[], path: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(path, `取值不认识（允许：${allowed.join(' / ')}）。`)
  }
  return value
}

function asIso(value: unknown, path: string): string {
  const text = asString(value, path, { min: 1, max: 64 })
  if (parseOffsetIso(text) === null) fail(path, '不是可解析的 ISO 时间。')
  return text
}

function asIsoNullable(value: unknown, path: string): string | null {
  if (value === null) return null
  return asIso(value, path)
}

function asDateKey(value: unknown, path: string): string {
  const text = asString(value, path, { min: 10, max: 10 })
  if (!isValidDateKey(text)) fail(path, '不是真实存在的 YYYY-MM-DD 日期。')
  return text
}

function asSha256(value: unknown, path: string, nullable = false): string | null {
  if (value === null && nullable) return null
  const text = asString(value, path, { min: 64, max: 64 })
  if (!/^[0-9a-fA-F]{64}$/.test(text)) fail(path, '不是 64 位十六进制 SHA-256。')
  return text.toLowerCase()
}

function unique<T>(items: readonly T[], key: (item: T) => string | number, path: string): Map<string | number, T> {
  const map = new Map<string | number, T>()
  for (const item of items) {
    const value = key(item)
    if (map.has(value)) fail(path, `出现重复记录（${String(value)}）。`)
    map.set(value, item)
  }
  return map
}

/** 安全相对路径：拒绝绝对路径、盘符、URL、反斜杠与 `..` 穿越。 */
export function isSafeRelativePath(raw: string): boolean {
  if (raw.length === 0 || raw.length > 512) return false
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.includes('\\') || raw.includes(':')) return false
  if (/[\u0000-\u001f]/.test(raw)) return false
  const segments = raw.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  return true
}

function decodeJsonArrayOfStrings(raw: string | null, path: string): void {
  if (raw === null) return
  if (utf8ByteLength(raw) > BACKUP_LIMITS.maxJsonBytes) fail(path, 'JSON 字段超过上限。')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(path, '不是有效 JSON。')
  }
  if (!Array.isArray(parsed)) fail(path, '必须是字符串数组。')
  if (parsed.length > 1000) fail(path, '数组条数超过上限。')
  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.length > BACKUP_LIMITS.maxShortText) {
      fail(path, '数组里含有非字符串或超长内容。')
    }
  }
}

function decodeJsonObject(raw: string | null, path: string): void {
  if (raw === null) return
  if (utf8ByteLength(raw) > BACKUP_LIMITS.maxJsonBytes) fail(path, 'JSON 字段超过上限。')
  try {
    JSON.parse(raw)
  } catch {
    fail(path, '不是有效 JSON。')
  }
}

/* ------------------------------ 图片校验 ------------------------------ */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
/** 25 MiB 原图 → base64 约 34.95 MiB；这里留一点余量但仍是硬上限。 */
const MAX_IMAGE_BASE64_CHARS = Math.ceil(BACKUP_LIMITS.maxImageBytes / 3) * 4

function isStrictBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false
  if (!BASE64_RE.test(text)) return false
  const paddingIndex = text.indexOf('=')
  if (paddingIndex !== -1 && paddingIndex < text.length - 2) return false
  return true
}

function imageFormatOf(value: unknown, path: string): 'png' | 'jpeg' {
  return asEnum(value, ['png', 'jpeg'], path) as 'png' | 'jpeg'
}

async function validateImage(
  raw: unknown,
  path: string,
  seenIds: Set<string>,
  seenSha: Map<string, BackupImage>,
): Promise<BackupImage> {
  const object = asObject(raw, path)
  exactlyKeys(object, ['id', 'sha256', 'byteLength', 'width', 'height', 'format', 'base64'], path)
  const id = asString(object.id, `${path}.id`, { min: 1, max: 64 })
  if (seenIds.has(id)) fail(`${path}.id`, '图片 id 重复。')
  seenIds.add(id)
  const sha256 = asSha256(object.sha256, `${path}.sha256`) as string
  const byteLength = asInt(object.byteLength, `${path}.byteLength`, {
    min: 1,
    max: BACKUP_LIMITS.maxImageBytes,
  })
  const width = asInt(object.width, `${path}.width`, { min: 1, max: 100_000, nullable: true })
  const height = asInt(object.height, `${path}.height`, { min: 1, max: 100_000, nullable: true })
  const format = imageFormatOf(object.format, `${path}.format`)
  const base64 = asString(object.base64, `${path}.base64`, { min: 1, max: MAX_IMAGE_BASE64_CHARS })
  if (!isStrictBase64(base64)) fail(`${path}.base64`, '不是规范 base64（不接受空白、data: 前缀或非法字符）。')
  const decodedLength = base64ByteLength(base64)
  if (decodedLength !== byteLength) {
    fail(`${path}.byteLength`, `声明 ${byteLength} 字节，base64 实际解出 ${decodedLength} 字节。`)
  }
  const actualFormat = sniffBase64Format(base64)
  if (actualFormat !== format) {
    fail(`${path}.format`, `声明的格式 ${format} 与字节头 ${actualFormat ?? '未知'} 不一致。`)
  }
  const size = readEncodedSize(base64)
  if (!size) fail(`${path}.base64`, '图片头不完整或不是可解析的 PNG / JPEG。')
  const actualSha = await sha256HexOfBase64(base64)
  if (actualSha !== sha256) fail(`${path}.sha256`, '图片内容哈希不一致。')
  const image: BackupImage = { id, sha256, byteLength, width, height, format, base64 }
  const previous = seenSha.get(sha256)
  if (previous) {
    if (previous.byteLength !== byteLength || previous.format !== format) {
      fail(`${path}.sha256`, '同一张图片出现了互相矛盾的元数据。')
    }
    fail(`${path}.sha256`, '同一份图片字节在备份里重复出现（应当只存一份）。')
  }
  seenSha.set(sha256, image)
  return image
}

/* ------------------------------ 各表校验 ------------------------------ */

const TASK_TYPES = ['HOMEWORK', 'EXAM', 'PROJECT', 'READING', 'PRESENTATION', 'ADMIN', 'OTHER'] as const
const TASK_STATUSES = ['TODO', 'DOING', 'DONE', 'CANCELLED'] as const
const SOURCE_KINDS = ['ORIGINAL_TEXT', 'MANUAL'] as const
const ATTEMPT_SOURCES = ['LIBRARY', 'CAMERA', 'ARCHIVE', 'OTHER'] as const
const ATTEMPT_STATUSES = ['ARCHIVED', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'ARCHIVE_FAILED'] as const
const REF_TARGET_KINDS = ['COURSE', 'SCHEDULE', 'TASK', 'ATTEMPT'] as const
const OCR_STATUSES = ['SUCCESS', 'FAILED', 'CANCELLED'] as const
const WEEK_PATTERNS = ['ALL', 'ODD', 'EVEN'] as const

function parseCourse(raw: unknown, path: string): BackupCourse {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    ['id', 'code', 'name', 'instructor', 'semester', 'color', 'note', 'selectionSerial', 'createdAt', 'updatedAt'],
    path,
  )
  const course: BackupCourse = {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    code: asString(object.code, `${path}.code`, { min: 1, max: COURSE_LIMITS.CODE_MAX }),
    name: asString(object.name, `${path}.name`, { min: 1, max: COURSE_LIMITS.NAME_MAX }),
    instructor: asString(object.instructor, `${path}.instructor`, {
      max: COURSE_LIMITS.INSTRUCTOR_MAX,
      nullable: true,
    }),
    semester: asString(object.semester, `${path}.semester`, { max: COURSE_LIMITS.SEMESTER_MAX, nullable: true }),
    color: asString(object.color, `${path}.color`, { max: 7, nullable: true }),
    note: asString(object.note, `${path}.note`, { max: COURSE_LIMITS.NOTE_MAX, nullable: true }),
    selectionSerial: asString(object.selectionSerial, `${path}.selectionSerial`, { max: 40, nullable: true }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
  // 复用现有课程校验：教师 / 颜色 / 选课序号都按真实表单规则检查。
  let normalized: ReturnType<typeof normalizeCourseDraft>
  try {
    normalized = normalizeCourseDraft({
      code: course.code,
      name: course.name,
      instructor: course.instructor ?? '',
      semester: course.semester ?? '',
      color: course.color ?? '',
      note: course.note ?? '',
      selectionSerial: course.selectionSerial ?? '',
    })
  } catch (cause) {
    fail(path, cause instanceof Error ? cause.message : '课程字段不符合规则。')
  }
  if (normalized.code !== course.code || normalized.name !== course.name) {
    fail(path, '课程名或内部代码包含首尾空白，不符合保存规则。')
  }
  if ((normalized.instructor ?? null) !== course.instructor) fail(`${path}.instructor`, '教师字段不规范。')
  if ((normalized.selectionSerial ?? null) !== course.selectionSerial) {
    fail(`${path}.selectionSerial`, '选课序号不规范。')
  }
  return course
}

function parseSchedule(raw: unknown, path: string): BackupSchedule {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'courseId',
      'weekday',
      'startTime',
      'endTime',
      'location',
      'periodStart',
      'periodEnd',
      'weekRange',
      'semesterStartDate',
      'startWeek',
      'endWeek',
      'weekPattern',
      'createdAt',
      'updatedAt',
    ],
    path,
  )
  const schedule: BackupSchedule = {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    courseId: asInt(object.courseId, `${path}.courseId`, { min: 1 }),
    weekday: asInt(object.weekday, `${path}.weekday`, { min: 1, max: 7 }),
    startTime: asString(object.startTime, `${path}.startTime`, { min: 5, max: 5 }),
    endTime: asString(object.endTime, `${path}.endTime`, { min: 5, max: 5 }),
    location: asString(object.location, `${path}.location`, { max: COURSE_LIMITS.LOCATION_MAX, nullable: true }),
    periodStart: asInt(object.periodStart, `${path}.periodStart`, { min: 1, max: 20, nullable: true }),
    periodEnd: asInt(object.periodEnd, `${path}.periodEnd`, { min: 1, max: 20, nullable: true }),
    weekRange: asString(object.weekRange, `${path}.weekRange`, { min: 1, max: 32, nullable: true }),
    semesterStartDate: object.semesterStartDate === null ? null : asDateKey(object.semesterStartDate, `${path}.semesterStartDate`),
    startWeek: asInt(object.startWeek, `${path}.startWeek`, { min: 1, max: 53, nullable: true }),
    endWeek: asInt(object.endWeek, `${path}.endWeek`, { min: 1, max: 53, nullable: true }),
    weekPattern: asEnum(object.weekPattern, WEEK_PATTERNS, `${path}.weekPattern`),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
  let normalized: ReturnType<typeof normalizeScheduleDraft>
  try {
    normalized = normalizeScheduleDraft({
      weekday: schedule.weekday,
      startTime: schedule.startTime,
      endTime: schedule.endTime,
      location: schedule.location ?? '',
      periodStart: schedule.periodStart === null ? '' : String(schedule.periodStart),
      periodEnd: schedule.periodEnd === null ? '' : String(schedule.periodEnd),
      semesterStartDate: schedule.semesterStartDate ?? '',
      startWeek: schedule.startWeek === null ? '' : String(schedule.startWeek),
      endWeek: schedule.endWeek === null ? '' : String(schedule.endWeek),
      weekPattern: schedule.weekPattern as 'ALL' | 'ODD' | 'EVEN',
    })
  } catch (cause) {
    fail(path, cause instanceof Error ? cause.message : '课表字段不符合规则。')
  }
  if (normalized.weekday !== schedule.weekday || normalized.startTime !== schedule.startTime || normalized.endTime !== schedule.endTime) {
    fail(path, '星期或上课时间不符合规则。')
  }
  if ((normalized.location ?? null) !== schedule.location) fail(`${path}.location`, '地点不规范。')
  if (normalized.periodStart !== schedule.periodStart || normalized.periodEnd !== schedule.periodEnd) {
    fail(path, '节次不符合规则。')
  }
  if (normalized.semesterStartDate !== schedule.semesterStartDate) {
    fail(`${path}.semesterStartDate`, '学期首周一不是真实存在的周一。')
  }
  if (normalized.startWeek !== schedule.startWeek || normalized.endWeek !== schedule.endWeek) {
    fail(path, '教学周范围不符合规则。')
  }
  if (normalized.weekPattern !== schedule.weekPattern) fail(`${path}.weekPattern`, '单双周规律不符合规则。')
  if (normalized.weekRange !== schedule.weekRange) fail(`${path}.weekRange`, '周次范围与起止周不一致。')
  return schedule
}

function parseTask(raw: unknown, path: string): BackupTask {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'title',
      'description',
      'courseId',
      'type',
      'status',
      'priority',
      'deadline',
      'estimatedMinutes',
      'submitRequirement',
      'submitMethod',
      'completedAt',
      'createdAt',
      'updatedAt',
    ],
    path,
  )
  const task: BackupTask = {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    title: asString(object.title, `${path}.title`, { min: 1, max: TASK_LIMITS.TITLE_MAX }),
    description: asString(object.description, `${path}.description`, {
      max: TASK_LIMITS.DESCRIPTION_MAX,
      nullable: true,
    }),
    courseId: asInt(object.courseId, `${path}.courseId`, { min: 1, nullable: true }),
    type: asEnum(object.type, TASK_TYPES, `${path}.type`),
    status: asEnum(object.status, TASK_STATUSES, `${path}.status`),
    priority: asInt(object.priority, `${path}.priority`, { min: 1, max: 5 }),
    deadline: parseDeadline(object.deadline, `${path}.deadline`),
    estimatedMinutes: asInt(object.estimatedMinutes, `${path}.estimatedMinutes`, {
      min: 0,
      max: 100_000,
      nullable: true,
    }),
    submitRequirement: asString(object.submitRequirement, `${path}.submitRequirement`, {
      max: TASK_LIMITS.SUBMIT_REQUIREMENT_MAX,
      nullable: true,
    }),
    submitMethod: asString(object.submitMethod, `${path}.submitMethod`, {
      max: TASK_LIMITS.SUBMIT_METHOD_MAX,
      nullable: true,
    }),
    completedAt: asIsoNullable(object.completedAt, `${path}.completedAt`),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
  if (task.title !== task.title.trim()) fail(`${path}.title`, '标题包含首尾空白，不符合保存规则。')
  if (task.description !== null && task.description !== task.description.trim()) {
    fail(`${path}.description`, '说明包含首尾空白，不符合保存规则。')
  }
  return task
}

function parseDeadline(value: unknown, path: string): string | null {
  if (value === null) return null
  const text = asString(value, path, { min: 1, max: 64 })
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!isDateOnlyDeadline(text)) fail(path, '只到日期的截止时间不是真实日期。')
    return text
  }
  const parsed = parseOffsetIso(text)
  if (!parsed) fail(path, '截止时间不是可解析的带偏移 ISO。')
  const parts = offsetIsoToShanghaiParts(text)
  if (!parts) fail(path, '截止时间无法换算成北京时间。')
  const canonical = shanghaiWallClockToOffset(
    `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` +
      `T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`,
  )
  if (canonical !== text) fail(path, '截止时间不是规范的 +08:00 北京时间写法。')
  return text
}

function parseTaskSource(raw: unknown, path: string): BackupTaskSource {
  const object = asObject(raw, path)
  exactlyKeys(object, ['id', 'taskId', 'kind', 'rawText', 'createdAt'], path)
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    taskId: asInt(object.taskId, `${path}.taskId`, { min: 1 }),
    kind: asEnum(object.kind, SOURCE_KINDS, `${path}.kind`),
    rawText: asString(object.rawText, `${path}.rawText`, { min: 1, max: BACKUP_LIMITS.maxTextBytes }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
  }
}

function parseAttempt(raw: unknown, path: string): BackupAttempt {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'capturedAt',
      'source',
      'status',
      'imageId',
      'sha256',
      'byteLength',
      'width',
      'height',
      'format',
      'mimeType',
      'uploadFormat',
      'uploadScale',
      'uploadQuality',
      'uploadByteLength',
      'resized',
      'dedupOfAttemptId',
      'errorCode',
      'errorMessage',
      'note',
      'createdAt',
      'updatedAt',
    ],
    path,
  )
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    capturedAt: asIso(object.capturedAt, `${path}.capturedAt`),
    source: asEnum(object.source, ATTEMPT_SOURCES, `${path}.source`),
    status: asEnum(object.status, ATTEMPT_STATUSES, `${path}.status`),
    imageId: asString(object.imageId, `${path}.imageId`, { min: 1, max: 64, nullable: true }),
    sha256: asSha256(object.sha256, `${path}.sha256`, true),
    byteLength: asInt(object.byteLength, `${path}.byteLength`, {
      min: 1,
      max: BACKUP_LIMITS.maxImageBytes,
      nullable: true,
    }),
    width: asInt(object.width, `${path}.width`, { min: 1, max: 100_000, nullable: true }),
    height: asInt(object.height, `${path}.height`, { min: 1, max: 100_000, nullable: true }),
    format: object.format === null ? null : imageFormatOf(object.format, `${path}.format`),
    mimeType: asString(object.mimeType, `${path}.mimeType`, { max: 64, nullable: true }),
    uploadFormat: asString(object.uploadFormat, `${path}.uploadFormat`, { max: 64, nullable: true }),
    uploadScale: asNumber(object.uploadScale, `${path}.uploadScale`, { nullable: true }),
    uploadQuality: asNumber(object.uploadQuality, `${path}.uploadQuality`, { nullable: true }),
    uploadByteLength: asInt(object.uploadByteLength, `${path}.uploadByteLength`, { min: 1, nullable: true }),
    resized: asBoolean(object.resized, `${path}.resized`),
    dedupOfAttemptId: asInt(object.dedupOfAttemptId, `${path}.dedupOfAttemptId`, { min: 1, nullable: true }),
    errorCode: asString(object.errorCode, `${path}.errorCode`, { max: 128, nullable: true }),
    errorMessage: asString(object.errorMessage, `${path}.errorMessage`, { max: 2000, nullable: true }),
    note: asString(object.note, `${path}.note`, { max: 2000, nullable: true }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
}

function parseSource(raw: unknown, path: string): BackupSource {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'catalogKey',
      'title',
      'description',
      'archiveRelPath',
      'sha256',
      'byteLength',
      'width',
      'height',
      'layout',
      'capturedAt',
      'provenance',
      'foreignAttemptId',
      'createdAt',
      'updatedAt',
    ],
    path,
  )
  const archiveRelPath = asString(object.archiveRelPath, `${path}.archiveRelPath`, { min: 1, max: 512 })
  if (!isSafeRelativePath(archiveRelPath)) {
    fail(`${path}.archiveRelPath`, '必须是安全的相对路径（不能是绝对路径、盘符或含 ..）。')
  }
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    catalogKey: asString(object.catalogKey, `${path}.catalogKey`, { min: 1, max: 128 }),
    title: asString(object.title, `${path}.title`, { min: 1, max: 300 }),
    description: asString(object.description, `${path}.description`, { max: 2000, nullable: true }),
    archiveRelPath,
    sha256: asSha256(object.sha256, `${path}.sha256`, true),
    byteLength: asInt(object.byteLength, `${path}.byteLength`, { min: 1, max: BACKUP_LIMITS.maxImageBytes, nullable: true }),
    width: asInt(object.width, `${path}.width`, { min: 1, max: 100_000, nullable: true }),
    height: asInt(object.height, `${path}.height`, { min: 1, max: 100_000, nullable: true }),
    layout: asString(object.layout, `${path}.layout`, { max: 64, nullable: true }),
    capturedAt: asIsoNullable(object.capturedAt, `${path}.capturedAt`),
    provenance: asString(object.provenance, `${path}.provenance`, { max: 1000, nullable: true }),
    foreignAttemptId: asInt(object.foreignAttemptId, `${path}.foreignAttemptId`, { min: 1, nullable: true }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
}

function parseRef(raw: unknown, path: string): BackupRef {
  const object = asObject(raw, path)
  exactlyKeys(object, ['id', 'attemptId', 'targetKind', 'targetId', 'relation', 'createdAt'], path)
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    attemptId: asInt(object.attemptId, `${path}.attemptId`, { min: 1 }),
    targetKind: asEnum(object.targetKind, REF_TARGET_KINDS, `${path}.targetKind`),
    targetId: asInt(object.targetId, `${path}.targetId`, { min: 1 }),
    relation: asString(object.relation, `${path}.relation`, { min: 1, max: 64 }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
  }
}

function parseOcrResult(raw: unknown, path: string): BackupOcrResult {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'attemptId',
      'requestId',
      'layout',
      'week',
      'status',
      'errorCode',
      'errorMessage',
      'candidateCount',
      'warningsJson',
      'payloadJson',
      'rawText',
      'ocrCalls',
      'durationMs',
      'imageWidth',
      'imageHeight',
      'imageFormat',
      'imageBytes',
      'createdAt',
    ],
    path,
  )
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    attemptId: asInt(object.attemptId, `${path}.attemptId`, { min: 1 }),
    requestId: asString(object.requestId, `${path}.requestId`, { max: 128, nullable: true }),
    layout: asString(object.layout, `${path}.layout`, { max: 64, nullable: true }),
    week: asInt(object.week, `${path}.week`, { min: 0, max: 53, nullable: true }),
    status: asEnum(object.status, OCR_STATUSES, `${path}.status`),
    errorCode: asString(object.errorCode, `${path}.errorCode`, { max: 128, nullable: true }),
    errorMessage: asString(object.errorMessage, `${path}.errorMessage`, { max: 2000, nullable: true }),
    candidateCount: asInt(object.candidateCount, `${path}.candidateCount`, { min: 0, max: BACKUP_LIMITS.maxOcrCandidates }),
    warningsJson: asString(object.warningsJson, `${path}.warningsJson`, { max: BACKUP_LIMITS.maxJsonBytes, nullable: true }),
    payloadJson: asString(object.payloadJson, `${path}.payloadJson`, { max: BACKUP_LIMITS.maxJsonBytes, nullable: true }),
    rawText: asString(object.rawText, `${path}.rawText`, { max: BACKUP_LIMITS.maxTextBytes, nullable: true }),
    ocrCalls: asInt(object.ocrCalls, `${path}.ocrCalls`, { min: 0, nullable: true }),
    durationMs: asInt(object.durationMs, `${path}.durationMs`, { min: 0, nullable: true }),
    imageWidth: asInt(object.imageWidth, `${path}.imageWidth`, { min: 1, max: 100_000, nullable: true }),
    imageHeight: asInt(object.imageHeight, `${path}.imageHeight`, { min: 1, max: 100_000, nullable: true }),
    imageFormat: asString(object.imageFormat, `${path}.imageFormat`, { max: 64, nullable: true }),
    imageBytes: asInt(object.imageBytes, `${path}.imageBytes`, { min: 0, nullable: true }),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
  }
}

function parseOcrCandidate(raw: unknown, path: string): BackupOcrCandidate {
  const object = asObject(raw, path)
  exactlyKeys(
    object,
    [
      'id',
      'resultId',
      'rowIndex',
      'name',
      'weekday',
      'startTime',
      'endTime',
      'location',
      'startWeek',
      'endWeek',
      'weekPattern',
      'selectionSerial',
      'rawText',
      'warningsJson',
      'imported',
      'createdAt',
    ],
    path,
  )
  return {
    id: asInt(object.id, `${path}.id`, { min: 1 }),
    resultId: asInt(object.resultId, `${path}.resultId`, { min: 1 }),
    rowIndex: asInt(object.rowIndex, `${path}.rowIndex`, { min: 0 }),
    name: asString(object.name, `${path}.name`, { max: 300, nullable: true }),
    weekday: asInt(object.weekday, `${path}.weekday`, { min: 1, max: 7, nullable: true }),
    startTime: asString(object.startTime, `${path}.startTime`, { max: 8, nullable: true }),
    endTime: asString(object.endTime, `${path}.endTime`, { max: 8, nullable: true }),
    location: asString(object.location, `${path}.location`, { max: 300, nullable: true }),
    startWeek: asInt(object.startWeek, `${path}.startWeek`, { min: 1, max: 53, nullable: true }),
    endWeek: asInt(object.endWeek, `${path}.endWeek`, { min: 1, max: 53, nullable: true }),
    weekPattern: object.weekPattern === null ? null : asEnum(object.weekPattern, WEEK_PATTERNS, `${path}.weekPattern`),
    selectionSerial: asString(object.selectionSerial, `${path}.selectionSerial`, { max: 64, nullable: true }),
    rawText: asString(object.rawText, `${path}.rawText`, { max: BACKUP_LIMITS.maxTextBytes, nullable: true }),
    warningsJson: asString(object.warningsJson, `${path}.warningsJson`, { max: BACKUP_LIMITS.maxJsonBytes, nullable: true }),
    imported: asBoolean(object.imported, `${path}.imported`),
    createdAt: asIso(object.createdAt, `${path}.createdAt`),
  }
}

function parseSetting(raw: unknown, path: string): BackupSetting {
  const object = asObject(raw, path)
  exactlyKeys(object, ['key', 'value', 'updatedAt'], path)
  return {
    key: asString(object.key, `${path}.key`, { min: 1, max: 128 }),
    value: asString(object.value, `${path}.value`, { max: BACKUP_LIMITS.maxSettingValueBytes }),
    updatedAt: asIso(object.updatedAt, `${path}.updatedAt`),
  }
}

/* ------------------------------ 设置校验 ------------------------------ */

export function isExcludedSettingKey(key: string): boolean {
  return (
    key === APP_SETTINGS_KEYS.OCR_COMPANION_ENDPOINT ||
    key === APP_SETTINGS_KEYS.NOTIFICATION_ROUTE_GENERATION ||
    key === TASK_REMINDER_RECEIPT_KEY
  )
}

export function parseTaskStepsKey(key: string): number | null {
  if (!key.startsWith(TASK_STEPS_KEY_PREFIX)) return null
  const raw = key.slice(TASK_STEPS_KEY_PREFIX.length)
  if (!/^[1-9]\d*$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && taskStepsKey(id) === key ? id : null
}

export function parseReminderKey(key: string): number | null {
  if (!key.startsWith(TASK_REMINDER_KEY_PREFIX)) return null
  const raw = key.slice(TASK_REMINDER_KEY_PREFIX.length)
  if (!/^[1-9]\d*$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) ? id : null
}

function validateSettings(
  settings: readonly BackupSetting[],
  taskIds: ReadonlySet<number>,
): { taskSteps: Array<{ taskId: number; steps: ReturnType<typeof decodeTaskSteps> }>; reminders: Array<{ taskId: number; intent: TaskReminderIntent }> } {
  const byKey = unique(settings, (setting) => setting.key, 'data.settings')
  const taskSteps: Array<{ taskId: number; steps: ReturnType<typeof decodeTaskSteps> }> = []
  const reminders: Array<{ taskId: number; intent: TaskReminderIntent }> = []

  for (const setting of settings) {
    if (setting.key === WEEKLY_GOAL_KEY) {
      try { decodeWeeklyGoals(setting.value) } catch { fail('data.settings', '每周学习目标无效。') }
    }
    if (setting.key === FOCUS_KEY) {
      try { decodeFocus(setting.value) } catch { fail('data.settings', '专注计时记录无效。') }
    }
    if (setting.key === CLASS_REMINDER_KEY) {
      try { decodeClassReminderSettings(setting.value) } catch { fail('data.settings', '上课前提醒设置无效。') }
      continue
    }
    const key = setting.key
    if (isExcludedSettingKey(key)) {
      fail('data.settings', `包含设备专属设置「${key}」，这类设置不允许随备份恢复。`)
    }
  }

  const teachingKeys = [
    APP_SETTINGS_KEYS.SEMESTER_START_MONDAY,
    APP_SETTINGS_KEYS.CALIBRATED_WEEK,
    APP_SETTINGS_KEYS.CALIBRATED_TODAY,
    APP_SETTINGS_KEYS.CALIBRATED_AT,
  ]
  const presentTeaching = teachingKeys.filter((key) => byKey.has(key))
  if (presentTeaching.length > 0 && presentTeaching.length !== teachingKeys.length) {
    fail('data.settings', '教学周校准缺少部分键（要么全有，要么全无）。')
  }
  if (presentTeaching.length === teachingKeys.length) {
    const monday = byKey.get(APP_SETTINGS_KEYS.SEMESTER_START_MONDAY)!.value
    const weekText = byKey.get(APP_SETTINGS_KEYS.CALIBRATED_WEEK)!.value
    const today = byKey.get(APP_SETTINGS_KEYS.CALIBRATED_TODAY)!.value
    const setAt = byKey.get(APP_SETTINGS_KEYS.CALIBRATED_AT)!.value
    if (!isValidDateKey(monday) || !isMonday(monday)) fail('data.settings', '教学周校准的学期首周一不是真实周一。')
    if (!/^[1-9]\d*$/.test(weekText) || !isValidTeachingWeek(Number(weekText))) {
      fail('data.settings', '教学周校准的周次不是 1–53 的整数。')
    }
    if (!isValidDateKey(today)) fail('data.settings', '教学周校准的校准日期不是真实日期。')
    if (setAt.length > 0 && parseOffsetIso(setAt) === null) fail('data.settings', '教学周校准时间不是 ISO。')
    const created = createCalibration(today, weekText, setAt)
    if (!created.ok || created.calibration.semesterStartMonday !== monday) {
      fail('data.settings', '教学周校准的日期与周次互相矛盾。')
    }
  }

  const reference = byKey.get(APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES)
  if (reference) {
    const parsed = parseStudyReferenceMinutes(reference.value)
    if (!parsed.ok || parsed.unset) fail('data.settings', '每日学习参考用时不是 1–1440 的整数分钟。')
  }

  const plan = byKey.get(APP_SETTINGS_KEYS.TODAY_PLAN)
  if (plan && parseTodayPlanPayload(plan.value) === null) {
    fail('data.settings', '今日学习计划读不出来（格式 / 版本 / 结构不合法）。')
  }

  /**
   * 模板 / 重复规则：**必须**经过与运行时同一套严格解码，不能只检查“是 JSON”。
   *
   * 账本里的 `taskId` 允许指向备份里已不存在的任务（用户生成后删除是合法历史）；
   * 这种历史引用会由恢复流程把任务 AUTOINCREMENT 高水位推到它之上，
   * 确保恢复后新建任务不会复用那个 id、把旧账本错误地指向一条新任务。
   */
  const templateSetting = byKey.get(APP_SETTINGS_KEYS.TASK_TEMPLATES)
  if (templateSetting) {
    const decoded = decodeTemplateStore(templateSetting.value)
    if (!decoded.ok) fail('data.settings', `任务模板库读不出来：${decoded.reason}`)
  }
  const recurrenceSetting = byKey.get(APP_SETTINGS_KEYS.TASK_RECURRENCE)
  if (recurrenceSetting) {
    const decoded = decodeRecurrenceStore(recurrenceSetting.value)
    if (!decoded.ok) fail('data.settings', `重复任务规则 / 账本读不出来：${decoded.reason}`)
  }
  const revisionSetting = byKey.get(EXAM_REVISION_KEY)
  if (revisionSetting) {
    try { decodeExamRevisionStore(revisionSetting.value) }
    catch { fail('data.settings', '考试复习安排读不出来，已拒绝整份备份。') }
  }

  for (const setting of settings) {
    const stepTaskId = parseTaskStepsKey(setting.key)
    if (stepTaskId !== null) {
      if (!taskIds.has(stepTaskId)) fail('data.settings', `步骤清单指向不存在的任务 #${stepTaskId}。`)
      const decoded = decodeTaskSteps(setting.value)
      if (!decoded.ok || decoded.taskId !== stepTaskId) {
        fail('data.settings', `任务 #${stepTaskId} 的步骤清单读不出来。`)
      }
      taskSteps.push({ taskId: stepTaskId, steps: decoded })
      continue
    }
    const reminderTaskId = parseReminderKey(setting.key)
    if (reminderTaskId !== null) {
      if (!taskIds.has(reminderTaskId)) fail('data.settings', `提醒设置指向不存在的任务 #${reminderTaskId}。`)
      const decoded = decodeTaskReminder(setting.value, reminderTaskId)
      if (!decoded.ok) fail('data.settings', `任务 #${reminderTaskId} 的提醒设置读不出来。`)
      if (!isReminderLeadMinutes(decoded.intent.leadMinutes)) {
        fail('data.settings', `任务 #${reminderTaskId} 的提醒提前量不认识。`)
      }
      reminders.push({ taskId: reminderTaskId, intent: decoded.intent })
      continue
    }
    if (
      setting.key === APP_SETTINGS_KEYS.SEMESTER_START_MONDAY ||
      setting.key === APP_SETTINGS_KEYS.CALIBRATED_WEEK ||
      setting.key === APP_SETTINGS_KEYS.CALIBRATED_TODAY ||
      setting.key === APP_SETTINGS_KEYS.CALIBRATED_AT ||
      setting.key === APP_SETTINGS_KEYS.DAILY_STUDY_REFERENCE_MINUTES ||
      setting.key === APP_SETTINGS_KEYS.TODAY_PLAN ||
      setting.key === APP_SETTINGS_KEYS.TASK_TEMPLATES ||
      setting.key === APP_SETTINGS_KEYS.TASK_RECURRENCE ||
      setting.key === EXAM_REVISION_KEY ||
      setting.key === CLASS_REMINDER_KEY || setting.key === FOCUS_KEY || setting.key === WEEKLY_GOAL_KEY
    ) {
      continue
    }
    fail('data.settings', `不认识的设置项「${setting.key}」，为避免静默遗漏已拒绝整份备份。`)
  }

  return { taskSteps, reminders }
}

/** 导出流程用：确保当前库里的设置都能被恢复流程重新解释（否则宁可拒绝导出）。 */
export function assertSettingsRestorable(settings: readonly BackupSetting[], taskIds: ReadonlySet<number>): void {
  for (const setting of settings) {
    if (parseOffsetIso(setting.updatedAt) === null) {
      fail('data.settings', `设置项「${setting.key}」的更新时间不是 ISO。`)
    }
  }
  validateSettings(settings, taskIds)
}

/* ------------------------------ 主解析入口 ------------------------------ */

export function countBackupData(data: BackupData): BackupCounts {
  let taskSteps = 0
  let reminders = 0
  let remindersEnabled = 0
  for (const setting of data.settings) {
    if (parseTaskStepsKey(setting.key) !== null) taskSteps += 1
    const reminderTaskId = parseReminderKey(setting.key)
    if (reminderTaskId !== null) {
      reminders += 1
      const decoded = decodeTaskReminder(setting.value, reminderTaskId)
      if (decoded.ok && decoded.intent.enabled) remindersEnabled += 1
    }
  }
  return {
    tasks: data.tasks.length,
    courses: data.courses.length,
    schedules: data.schedules.length,
    taskSources: data.taskSources.length,
    images: data.images.length,
    attempts: data.attempts.length,
    sources: data.sources.length,
    refs: data.refs.length,
    ocrResults: data.ocrResults.length,
    ocrCandidates: data.ocrCandidates.length,
    settings: data.settings.length,
    taskSteps,
    reminders,
    remindersEnabled,
    totalImageBytes: data.images.reduce((total, image) => total + image.byteLength, 0),
  }
}

export function isEmptyCounts(counts: BackupCounts): boolean {
  return (
    counts.tasks === 0 &&
    counts.courses === 0 &&
    counts.schedules === 0 &&
    counts.taskSources === 0 &&
    counts.images === 0 &&
    counts.attempts === 0 &&
    counts.sources === 0 &&
    counts.refs === 0 &&
    counts.ocrResults === 0 &&
    counts.ocrCandidates === 0 &&
    counts.settings === 0
  )
}

export function sameBackupCounts(left: BackupCounts, right: BackupCounts): boolean {
  return (Object.keys(left) as Array<keyof BackupCounts>).every((key) => left[key] === right[key])
}

async function parseImageList(raw: unknown): Promise<BackupImage[]> {
  const rows = asArray(raw, 'data.images', BACKUP_LIMITS.maxImages)
  const seenIds = new Set<string>()
  const seenSha = new Map<string, BackupImage>()
  const images: BackupImage[] = []
  let total = 0
  for (let index = 0; index < rows.length; index += 1) {
    const image = await validateImage(rows[index], `data.images[${index}]`, seenIds, seenSha)
    total += image.byteLength
    if (total > BACKUP_LIMITS.maxTotalImageBytes) {
      fail('data.images', `图片字节合计超过 ${BACKUP_LIMITS.maxTotalImageBytes} 字节上限。`)
    }
    images.push(image)
  }
  return images
}

function parseData(raw: unknown): BackupData {
  const object = asObject(raw, 'data')
  exactlyKeys(
    object,
    [
      'tasks',
      'courses',
      'schedules',
      'taskSources',
      'images',
      'attempts',
      'sources',
      'refs',
      'ocrResults',
      'ocrCandidates',
      'settings',
    ],
    'data',
  )
  return {
    tasks: asArray(object.tasks, 'data.tasks', BACKUP_LIMITS.maxTasks).map((row, index) => parseTask(row, `data.tasks[${index}]`)),
    courses: asArray(object.courses, 'data.courses', BACKUP_LIMITS.maxCourses).map((row, index) =>
      parseCourse(row, `data.courses[${index}]`),
    ),
    schedules: asArray(object.schedules, 'data.schedules', BACKUP_LIMITS.maxSchedules).map((row, index) =>
      parseSchedule(row, `data.schedules[${index}]`),
    ),
    taskSources: asArray(object.taskSources, 'data.taskSources', BACKUP_LIMITS.maxTaskSources).map((row, index) =>
      parseTaskSource(row, `data.taskSources[${index}]`),
    ),
    images: [],
    attempts: asArray(object.attempts, 'data.attempts', BACKUP_LIMITS.maxAttempts).map((row, index) =>
      parseAttempt(row, `data.attempts[${index}]`),
    ),
    sources: asArray(object.sources, 'data.sources', BACKUP_LIMITS.maxSources).map((row, index) =>
      parseSource(row, `data.sources[${index}]`),
    ),
    refs: asArray(object.refs, 'data.refs', BACKUP_LIMITS.maxRefs).map((row, index) => parseRef(row, `data.refs[${index}]`)),
    ocrResults: asArray(object.ocrResults, 'data.ocrResults', BACKUP_LIMITS.maxOcrResults).map((row, index) =>
      parseOcrResult(row, `data.ocrResults[${index}]`),
    ),
    ocrCandidates: asArray(object.ocrCandidates, 'data.ocrCandidates', BACKUP_LIMITS.maxOcrCandidates).map((row, index) =>
      parseOcrCandidate(row, `data.ocrCandidates[${index}]`),
    ),
    settings: asArray(object.settings, 'data.settings', BACKUP_LIMITS.maxSettings).map((row, index) =>
      parseSetting(row, `data.settings[${index}]`),
    ),
  }
}

/** 跨表 / 外键 / 业务语义校验（在图片校验之后调用）。 */
function validateReferences(data: BackupData, images: readonly BackupImage[]): void {
  const courseMap = unique(data.courses, (row) => row.id, 'data.courses')
  const taskMap = unique(data.tasks, (row) => row.id, 'data.tasks')
  const courseIds = new Set<number>()
  for (const key of courseMap.keys()) if (typeof key === 'number') courseIds.add(key)
  const taskIds = new Set<number>()
  for (const key of taskMap.keys()) if (typeof key === 'number') taskIds.add(key)
  unique(data.schedules, (row) => row.id, 'data.schedules')
  unique(data.taskSources, (row) => row.id, 'data.taskSources')
  unique(data.attempts, (row) => row.id, 'data.attempts')
  unique(data.sources, (row) => row.id, 'data.sources')
  unique(data.refs, (row) => row.id, 'data.refs')
  unique(data.ocrResults, (row) => row.id, 'data.ocrResults')
  unique(data.ocrCandidates, (row) => row.id, 'data.ocrCandidates')
  unique(data.settings, (row) => row.key, 'data.settings')

  const imageById = new Map(images.map((image) => [image.id, image]))
  const attemptById = new Map(data.attempts.map((row) => [row.id, row]))
  const usedImages = new Set<string>()

  for (const task of data.tasks) {
    if (task.courseId !== null && !courseIds.has(task.courseId)) {
      fail(`data.tasks[${task.id}].courseId`, `指向不存在的课程 #${task.courseId}。`)
    }
  }
  for (const schedule of data.schedules) {
    if (!courseIds.has(schedule.courseId)) {
      fail(`data.schedules[${schedule.id}].courseId`, `指向不存在的课程 #${schedule.courseId}。`)
    }
  }
  for (const source of data.taskSources) {
    if (!taskIds.has(source.taskId)) {
      fail(`data.taskSources[${source.id}].taskId`, `指向不存在的任务 #${source.taskId}。`)
    }
  }

  for (const attempt of data.attempts) {
    if (attempt.dedupOfAttemptId !== null) {
      if (attempt.dedupOfAttemptId === attempt.id) fail(`data.attempts[${attempt.id}].dedupOfAttemptId`, '不能指向自己。')
      if (!attemptById.has(attempt.dedupOfAttemptId)) {
        fail(`data.attempts[${attempt.id}].dedupOfAttemptId`, `指向不存在的尝试 #${attempt.dedupOfAttemptId}。`)
      }
    }
    if (attempt.imageId === null) {
      if (attempt.sha256 !== null || attempt.byteLength !== null) {
        fail(`data.attempts[${attempt.id}]`, '没有图片引用的尝试不能带图片哈希 / 字节数。')
      }
      if (attempt.status !== 'ARCHIVE_FAILED') {
        fail(`data.attempts[${attempt.id}].status`, '没有图片的尝试只能是 ARCHIVE_FAILED。')
      }
      continue
    }
    const image = imageById.get(attempt.imageId)
    if (!image) fail(`data.attempts[${attempt.id}].imageId`, `指向不存在的图片 ${attempt.imageId}。`)
    if (attempt.status === 'ARCHIVE_FAILED') {
      fail(`data.attempts[${attempt.id}].status`, '有图片的尝试不能是 ARCHIVE_FAILED。')
    }
    if (attempt.sha256 !== image.sha256) fail(`data.attempts[${attempt.id}].sha256`, '与图片哈希不一致。')
    if (attempt.byteLength !== image.byteLength) fail(`data.attempts[${attempt.id}].byteLength`, '与图片字节数不一致。')
    if (attempt.format !== image.format) fail(`data.attempts[${attempt.id}].format`, '与图片格式不一致。')
    if (attempt.mimeType !== null && attempt.mimeType !== (image.format === 'png' ? 'image/png' : 'image/jpeg')) {
      fail(`data.attempts[${attempt.id}].mimeType`, '与图片格式不一致。')
    }
    usedImages.add(image.id)
  }
  for (const image of images) {
    if (!usedImages.has(image.id)) fail(`data.images[${image.id}]`, '这张图片没有被任何截图记录引用。')
  }

  for (const source of data.sources) {
    if (source.foreignAttemptId !== null && !attemptById.has(source.foreignAttemptId)) {
      fail(`data.sources[${source.id}].foreignAttemptId`, `指向不存在的尝试 #${source.foreignAttemptId}。`)
    }
  }

  const refComposite = new Set<string>()
  for (const ref of data.refs) {
    if (!attemptById.has(ref.attemptId)) fail(`data.refs[${ref.id}].attemptId`, `指向不存在的尝试 #${ref.attemptId}。`)
    /**
     * `screenshot_refs` 的 COURSE / SCHEDULE / TASK 是**多态历史关联**，没有真实
     * SQLite 外键。仓库删除任务 / 课程 / 课表时**刻意保留**这些关联（schema 注释写明
     * 历史关联没有自动删除路径），因此目标缺失是合法的；绝不能把用户历史截图丢掉，
     * 也不能为了通过校验而重建已删除的实体。
     *
     * ATTEMPT 不同：截图尝试没有删除路径，指向不存在的尝试仍是坏数据，必须拒绝。
     */
    if (ref.targetKind === 'ATTEMPT' && !attemptById.has(ref.targetId)) {
      fail(`data.refs[${ref.id}].targetId`, `指向不存在的 ATTEMPT #${ref.targetId}。`)
    }
    const key = `${ref.attemptId}|${ref.targetKind}|${ref.targetId}|${ref.relation}`
    if (refComposite.has(key)) fail(`data.refs[${ref.id}]`, '同一条关联重复出现。')
    refComposite.add(key)
  }

  const candidatesByResult = new Map<number, number>()
  const candidateRowKeys = new Set<string>()
  for (const candidate of data.ocrCandidates) {
    candidatesByResult.set(candidate.resultId, (candidatesByResult.get(candidate.resultId) ?? 0) + 1)
    // O(n) 查重：上限允许 40 万行，不能对每一行再扫一遍整张数组。
    const rowKey = `${candidate.resultId}|${candidate.rowIndex}`
    if (candidateRowKeys.has(rowKey)) {
      fail(`data.ocrCandidates[${candidate.id}].rowIndex`, `结果 #${candidate.resultId} 里行号 ${candidate.rowIndex} 重复。`)
    }
    candidateRowKeys.add(rowKey)
    decodeJsonArrayOfStrings(candidate.warningsJson, `data.ocrCandidates[${candidate.id}].warningsJson`)
  }
  const resultIds = new Set<number>()
  for (const result of data.ocrResults) {
    if (!attemptById.has(result.attemptId)) fail(`data.ocrResults[${result.id}].attemptId`, `指向不存在的尝试 #${result.attemptId}。`)
    resultIds.add(result.id)
    if (result.candidateCount !== (candidatesByResult.get(result.id) ?? 0)) {
      fail(`data.ocrResults[${result.id}].candidateCount`, '候选条数与实际候选行不一致。')
    }
    decodeJsonArrayOfStrings(result.warningsJson, `data.ocrResults[${result.id}].warningsJson`)
    decodeJsonObject(result.payloadJson, `data.ocrResults[${result.id}].payloadJson`)
  }
  for (const candidate of data.ocrCandidates) {
    if (!resultIds.has(candidate.resultId)) {
      fail(`data.ocrCandidates[${candidate.id}].resultId`, `指向不存在的识别结果 #${candidate.resultId}。`)
    }
  }
}

/**
 * 解析并**完整校验**一份备份文本。任何错误都抛 `BackupValidationError`，
 * 调用方必须在写库之前把它变成可读失败，绝不能先删再试。
 */
export async function parseBackupText(raw: string): Promise<ParsedBackup> {
  if (typeof raw !== 'string') fail('备份文件', '不是文本。')
  if (raw.trim().length === 0) fail('备份文件', '是空文件。')
  if (raw.length > BACKUP_LIMITS.maxFileBytes) {
    fail('备份文件', `超过 ${BACKUP_LIMITS.maxFileBytes} 字节上限。`)
  }
  if (utf8ByteLength(raw) > BACKUP_LIMITS.maxFileBytes) {
    fail('备份文件', `超过 ${BACKUP_LIMITS.maxFileBytes} 字节上限。`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail('备份文件', '不是有效 JSON（可能没传完或被改坏）。')
  }
  const root = asObject(parsed, '备份文件')
  exactlyKeys(
    root,
    ['format', 'version', 'createdAt', 'appSchemaVersion', 'manifest', 'integrity', 'data'],
    '备份文件',
  )
  if (root.format !== BACKUP_FORMAT) {
    fail('备份文件.format', `不是 DDL Mate 备份（实际 ${String(root.format)}）。`)
  }
  const version = asInt(root.version, '备份文件.version', { min: 1 })
  if (version > BACKUP_FORMAT_VERSION) {
    fail('备份文件.version', `备份格式版本 ${version} 高于当前应用支持的 ${BACKUP_FORMAT_VERSION}，请升级应用后再恢复。`)
  }
  if (version !== BACKUP_FORMAT_VERSION) fail('备份文件.version', `不支持这个备份格式版本（${version}）。`)
  const appSchemaVersion = asInt(root.appSchemaVersion, '备份文件.appSchemaVersion', { min: 1 })
  if (appSchemaVersion > SCHEMA_VERSION) {
    fail('备份文件.appSchemaVersion', `备份来自更新的数据结构（${appSchemaVersion}），请升级应用后再恢复。`)
  }
  if (appSchemaVersion !== SCHEMA_VERSION) {
    fail('备份文件.appSchemaVersion', `备份数据结构版本 ${appSchemaVersion} 与当前应用 ${SCHEMA_VERSION} 不一致。`)
  }
  const createdAt = asIso(root.createdAt, '备份文件.createdAt')

  const manifestObject = asObject(root.manifest, '备份文件.manifest')
  exactlyKeys(manifestObject, ['counts', 'totalImageBytes', 'isEmpty'], '备份文件.manifest')
  const countsObject = asObject(manifestObject.counts, '备份文件.manifest.counts')
  const countKeys: Array<keyof BackupCounts> = [
    'tasks',
    'courses',
    'schedules',
    'taskSources',
    'images',
    'attempts',
    'sources',
    'refs',
    'ocrResults',
    'ocrCandidates',
    'settings',
    'taskSteps',
    'reminders',
    'remindersEnabled',
    'totalImageBytes',
  ]
  exactlyKeys(countsObject, countKeys, '备份文件.manifest.counts')
  const declaredCounts = {} as BackupCounts
  for (const key of countKeys) {
    declaredCounts[key] = asInt(countsObject[key], `备份文件.manifest.counts.${key}`, { min: 0 })
  }
  const totalImageBytes = asInt(manifestObject.totalImageBytes, '备份文件.manifest.totalImageBytes', {
    min: 0,
    max: BACKUP_LIMITS.maxTotalImageBytes,
  })
  const declaredEmpty = asBoolean(manifestObject.isEmpty, '备份文件.manifest.isEmpty')

  const integrity = asObject(root.integrity, '备份文件.integrity')
  exactlyKeys(integrity, ['algorithm', 'digest'], '备份文件.integrity')
  if (integrity.algorithm !== 'sha256') fail('备份文件.integrity.algorithm', '只支持 sha256。')
  const declaredDigest = asSha256(integrity.digest, '备份文件.integrity.digest') as string

  const data = parseData(root.data)
  data.images = await parseImageList((root.data as Record<string, unknown>).images)
  const counts = countBackupData(data)
  if (!sameBackupCounts(declaredCounts, counts)) {
    fail('备份文件.manifest.counts', '声明计数与实际内容不一致（可能被截断或改动）。')
  }
  if (totalImageBytes !== counts.totalImageBytes) {
    fail('备份文件.manifest.totalImageBytes', '声明图片字节数与实际内容不一致。')
  }
  if (declaredEmpty !== isEmptyCounts(counts)) {
    fail('备份文件.manifest.isEmpty', '空数据标记与实际内容不一致。')
  }
  const digest = await backupDataDigest(data)
  if (digest !== declaredDigest) {
    fail('备份文件.integrity.digest', '内容摘要不一致（文件可能被改动或损坏）。')
  }

  validateReferences(data, data.images)
  const settingsDerived = validateSettings(data.settings, new Set(data.tasks.map((task) => task.id)))

  return {
    file: {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt,
      appSchemaVersion,
      manifest: { counts, totalImageBytes: counts.totalImageBytes, isEmpty: isEmptyCounts(counts) },
      integrity: { algorithm: 'sha256', digest },
      data,
    },
    data,
    counts,
    totalImageBytes: counts.totalImageBytes,
    backupDigest: digest,
    reminders: settingsDerived.reminders,
    taskSteps: settingsDerived.taskSteps,
  }
}

/**
 * 构造一份可写出的备份文件（导出流程用）。
 *
 * 注意：这里**不重算每张图的哈希**（导出读取时已经算过），只做计数与内容摘要；
 * 真正的严格校验由恢复前的 {@link parseBackupText} 完成。
 */
export async function sealBackupData(
  data: BackupData,
  options: { appSchemaVersion?: number; now?: () => Date } = {},
): Promise<BackupFile> {
  const now = options.now ?? (() => new Date())
  const counts = countBackupData(data)
  if (counts.totalImageBytes > BACKUP_LIMITS.maxTotalImageBytes) {
    fail('备份', `图片合计 ${counts.totalImageBytes} 字节，超过 ${BACKUP_LIMITS.maxTotalImageBytes} 上限。`)
  }
  const digest = await backupDataDigest(data)
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: now().toISOString(),
    appSchemaVersion: options.appSchemaVersion ?? SCHEMA_VERSION,
    manifest: {
      counts,
      totalImageBytes: counts.totalImageBytes,
      isEmpty: isEmptyCounts(counts),
    },
    integrity: { algorithm: 'sha256', digest },
    data,
  }
}

/** 把提醒意图改写成「保留选择、但明确关闭并待复核」的持久化值。 */
export function disabledReminderValue(intent: TaskReminderIntent, nowIso: string): string {
  return encodeTaskReminder({
    version: intent.version,
    taskId: intent.taskId,
    enabled: false,
    leadMinutes: intent.leadMinutes,
    revision: intent.revision + 1,
    updatedAt: nowIso,
  })
}

/** 仅用于测试 / 诊断：把规范 JSON 摘要成短字符串。 */
export async function fingerprintOf(value: unknown): Promise<string> {
  return sha256OfText(canonicalJson(value))
}
