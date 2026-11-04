/**
 * 「只导入截图」：从一份**已严格校验**的完整备份里，只把图片字节与截图库记录
 * 复制到当前本机；绝不恢复 / 替换任务、课程、课表、设置或旧关联。
 *
 * 与整库恢复的区别（这也是用户最容易被误导的地方）：
 * - 恢复：整库替换，任务 / 课程 / 课表 / 截图一起变；
 * - 只导入截图：只写 `Documents/screenshots/` 与 `screenshot_attempts` 的新行；
 *   当前任务、课程、课表、设置一条都不动。
 *
 * 幂等保证（按**校验过的字节**，不按外部 id）：
 * - 写入前逐张校验大小 / 格式 / SHA-256；
 * - 同一 `sha256` 已经有一条能看到原图的记录 → 跳过，不新增行；
 * - 同一 `sha256` 的记录存在但文件不在 → 只把该记录指到本次已校验的文件
 *   （compare-and-swap，保留原 id / 历史），不新增行；
 * - 只有这样才为一张全新的图插入新行。重复导入同一份备份不会越导越多。
 *
 * 不导入任何旧 id：新记录使用本机 AUTOINCREMENT；不复制 `screenshot_refs`，
 * 因此不会因为「旧任务 id 恰好相同」把截图自动挂到当前任务 / 课程上。
 */

import type { SqliteDatabase } from '../db/types'
import { parseBackupText, BACKUP_LIMITS, sameBackupCounts, type BackupAttempt, type BackupImage, type ParsedBackup } from './backupFormat'
import { offsetIsoToShanghaiParts } from './datetime'
import { sha256HexOfBase64 } from './hashing'
import { base64ByteLength, readEncodedSize, sniffBase64Format } from './photoFiles'
import type { BackupFileSystem } from './backupService'
import { archiveFileName, MAX_ARCHIVE_BYTES, SCREENSHOT_DIR_NAME } from './screenshotFiles'
import { appOwnedScreenshotRelativePath } from './screenshotPathRecovery'
import type { ScreenshotLibraryRepository } from './screenshotLibraryRepository'

/** 一张待导入的图片；`base64` 与 `stagedUri` 二选一。 */
export interface BackupImportImageInput {
  id: string
  sha256: string
  byteLength: number
  width: number | null
  height: number | null
  format: 'png' | 'jpeg'
  /** 备份里第一次出现这张图的采集时间（没有就留空）。 */
  capturedAt?: string | null
  base64?: string
  stagedUri?: string
}

export interface ScreenshotImageImportSuccess {
  committed: true
  imported: number
  repaired: number
  skipped: number
  total: number
  message: string
  cleanupWarning: string | null
}

export interface ScreenshotImageImportFailure {
  committed: false
  code: 'INVALID_IMAGE' | 'WRITE_FAILED' | 'DB_FAILED'
  reason: string
  cleanupWarning: string | null
}

export type ScreenshotImageImportOutcome = ScreenshotImageImportSuccess | ScreenshotImageImportFailure

/** 预览摘要里与「文件是否还是同一份」有关的字段。 */
export interface StagedBackupExpectation {
  stagedUri: string
  fileByteLength: number
  backupDigest: string
  counts: ParsedBackup['counts']
  totalImageBytes: number
}

interface VerifiedImage {
  input: BackupImportImageInput
  finalUri: string
  /** 这个最终文件是不是本次新建的（不是复用既有内容寻址文件）。 */
  created: boolean
}

function joinUri(directory: string, ...names: string[]): string {
  const base = directory.endsWith('/') ? directory.slice(0, -1) : directory
  return `${base}/${names.join('/')}`
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 与 `backupService.stampForFileName` 完全同形：`YYYYMMDD-HHMMSS`（上海时区）。 */
function stampForFileName(date: Date): string {
  const parts = offsetIsoToShanghaiParts(date.toISOString())
  if (!parts) return date.toISOString().replace(/[-:]/g, '').slice(0, 15)
  return (
    `${parts.year}${String(parts.month).padStart(2, '0')}${String(parts.day).padStart(2, '0')}` +
    `-${String(parts.hour).padStart(2, '0')}${String(parts.minute).padStart(2, '0')}${String(parts.second).padStart(2, '0')}`
  )
}

function extOf(format: 'png' | 'jpeg'): 'png' | 'jpg' {
  return format === 'png' ? 'png' : 'jpg'
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

function sha256Of(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** 统一把一张图片的声明字段校验成可信值；失败抛可读错误（调用方整体回滚）。 */
function assertImageDeclaration(image: BackupImportImageInput, index: number): {
  sha256: string
  byteLength: number
  format: 'png' | 'jpeg'
} {
  const label = `第 ${index + 1} 张截图`
  const sha = sha256Of(image.sha256)
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`${label}的内容哈希不是 SHA-256。`)
  if (
    !Number.isSafeInteger(image.byteLength) ||
    image.byteLength <= 0 ||
    image.byteLength > MAX_ARCHIVE_BYTES
  ) {
    throw new Error(`${label}的图片大小不在允许范围内。`)
  }
  if (image.format !== 'png' && image.format !== 'jpeg') throw new Error(`${label}的图片格式不认识。`)
  return { sha256: sha, byteLength: image.byteLength, format: image.format }
}

async function readImageBase64(image: BackupImportImageInput, fs: BackupFileSystem): Promise<string> {
  if (typeof image.base64 === 'string' && image.base64.length > 0) return image.base64
  if (typeof image.stagedUri === 'string' && image.stagedUri.length > 0) {
    return fs.readBase64(image.stagedUri)
  }
  throw new Error('这张截图没有可读取的图片内容。')
}

/**
 * 把暂存的整份备份重新解析并核对摘要 / 计数，再返回图片列表。
 *
 * 预览之后文件被替换、被截断、摘要变化都会在这里被拒绝；调用方不得在失败时
 * 写数据库或删除预览。
 */
export async function readImagesFromStagedBackup(
  fs: BackupFileSystem,
  expected: StagedBackupExpectation,
): Promise<BackupImportImageInput[]> {
  const size = await fs.size(expected.stagedUri)
  if (size === null) throw new Error('暂存的备份文件读不到大小。')
  if (size <= 0) throw new Error('暂存的备份文件是空的。')
  if (size > BACKUP_LIMITS.maxFileBytes) {
    throw new Error('暂存的备份文件太大，超过允许上限。')
  }
  if (size !== expected.fileByteLength) {
    throw new Error('暂存的备份文件在预览之后发生了变化，请重新选择文件预览。')
  }
  const text = await fs.readText(expected.stagedUri)
  const parsed = await parseBackupText(text)
  if (
    parsed.backupDigest !== expected.backupDigest ||
    parsed.totalImageBytes !== expected.totalImageBytes ||
    !sameBackupCounts(parsed.counts, expected.counts)
  ) {
    throw new Error('备份文件在预览之后被改动过，已拒绝导入；请重新选择文件预览。')
  }
  return imagesFromParsedBackup(parsed)
}

/** 从严格解析结果里取「每张图片 + 第一次采集时间」，不复制任何关联。 */
export function imagesFromParsedBackup(parsed: Pick<ParsedBackup, 'data'>): BackupImportImageInput[] {
  const firstAttemptByImage = new Map<string, BackupAttempt>()
  for (const attempt of parsed.data.attempts) {
    if (attempt.imageId && !firstAttemptByImage.has(attempt.imageId)) {
      firstAttemptByImage.set(attempt.imageId, attempt)
    }
  }
  return parsed.data.images.map((image: BackupImage) => {
    const attempt = firstAttemptByImage.get(image.id)
    return {
      id: image.id,
      sha256: image.sha256,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      format: image.format,
      capturedAt: attempt?.capturedAt ?? null,
      base64: image.base64,
    }
  })
}

/** 从已经写入 `view-*` 的只读内容视图构造候选；字节仍会重新回读校验。 */
export function imagesFromBackupContentView(view: {
  images: ReadonlyArray<{
    imageId: string
    sha256: string
    byteLength: number
    width: number | null
    height: number | null
    format: 'png' | 'jpeg'
    capturedAt: string | null
    stagedUri: string
  }>
}): BackupImportImageInput[] {
  return view.images.map((image) => ({
    id: image.imageId,
    sha256: image.sha256,
    byteLength: image.byteLength,
    width: image.width,
    height: image.height,
    format: image.format,
    capturedAt: image.capturedAt,
    stagedUri: image.stagedUri,
  }))
}

async function writeVerifiedImage(
  input: BackupImportImageInput,
  index: number,
  fs: BackupFileSystem,
  screenshotsDir: string,
): Promise<VerifiedImage> {
  const declaration = assertImageDeclaration(input, index)
  const base64 = await readImageBase64(input, fs)
  const decodedLength = base64ByteLength(base64)
  if (decodedLength !== declaration.byteLength) {
    throw new Error(`第 ${index + 1} 张截图的图片大小与备份中的声明不一致。`)
  }
  const actualFormat = sniffBase64Format(base64)
  if (actualFormat !== declaration.format) {
    throw new Error(`第 ${index + 1} 张截图的真实格式与声明不一致。`)
  }
  if (!readEncodedSize(base64)) {
    throw new Error(`第 ${index + 1} 张截图的图片头不完整。`)
  }
  const actualSha = await sha256HexOfBase64(base64)
  if (actualSha !== declaration.sha256) {
    throw new Error(`第 ${index + 1} 张截图的真实内容哈希与声明不一致，已拒绝导入。`)
  }

  const contentName = archiveFileName(0, declaration.sha256, declaration.format)
  const contentTarget = joinUri(screenshotsDir, contentName)
  let target = contentTarget
  let created = false
  if (await fs.exists(contentTarget)) {
    const existingSize = await fs.size(contentTarget)
    let reusable = existingSize === declaration.byteLength
    if (reusable) {
      try {
        const existingBase64 = await fs.readBase64(contentTarget)
        reusable =
          base64ByteLength(existingBase64) === declaration.byteLength &&
          sniffBase64Format(existingBase64) === declaration.format &&
          (await sha256HexOfBase64(existingBase64)) === declaration.sha256
      } catch {
        reusable = false
      }
    }
    if (!reusable) {
      // 同名内容寻址文件却对不上字节：保留它，另写唯一名字，绝不覆盖既有图片。
      const existingNames = new Set(await fs.listNames(screenshotsDir))
      const unique = uniqueName(
        existingNames,
        `restore-${stampForFileName(new Date())}-${declaration.sha256.slice(0, 16)}.${extOf(declaration.format)}`,
      )
      target = joinUri(screenshotsDir, unique)
    }
  }
  if (!(await fs.exists(target))) {
    const staging = joinUri(screenshotsDir, `.import-${randomToken()}.part`)
    try {
      await fs.writeBase64(staging, base64)
      const stagedSize = await fs.size(staging)
      if (stagedSize !== declaration.byteLength) {
        throw new Error(`第 ${index + 1} 张截图写入后大小不对（期望 ${declaration.byteLength}，实际 ${stagedSize ?? '读不到'}）。`)
      }
      const readBack = await fs.readBase64(staging)
      if (base64ByteLength(readBack) !== declaration.byteLength) throw new Error('临时文件的大小不对。')
      if (sniffBase64Format(readBack) !== declaration.format) throw new Error('临时文件回读格式不对。')
      if ((await sha256HexOfBase64(readBack)) !== declaration.sha256) throw new Error('临时文件回读哈希不对。')
      await fs.move(staging, target)
      created = true
    } catch (cause) {
      try {
        await fs.deleteFile(staging)
      } catch {
        // 清理失败不掩盖原始错误
      }
      throw cause
    }
  }
  try {
    const finalSize = await fs.size(target)
    if (finalSize !== declaration.byteLength) {
      throw new Error(`第 ${index + 1} 张截图落到最终位置后大小不对。`)
    }
  } catch (cause) {
    // 这个函数已经成功改名的目标文件属于本次新建；失败时只清理它。
    if (created) {
      try {
        if (await fs.exists(target)) await fs.deleteFile(target)
      } catch {
        // 清理失败不掩盖原始错误
      }
    }
    throw cause
  }
  return { input: { ...input, sha256: declaration.sha256, byteLength: declaration.byteLength }, finalUri: target, created }
}

async function pathHasMatchingBytes(
  fs: BackupFileSystem,
  uri: string | null,
  sha256: string,
  byteLength: number,
  format: 'png' | 'jpeg',
): Promise<boolean> {
  if (!uri) return false
  /**
   * 只读**当前应用目录**里、内容寻址命名的截图文件。
   *
   * 数据库里的旧路径可能指向旧容器 / 外部 URL；这里绝不顺着它读任意文件。
   * 旧路径的修复走 `screenshotPathRecovery` 的独立校验（同样只读当前目录）。
   */
  const root = fs.documentDirectory.endsWith('/') ? fs.documentDirectory : `${fs.documentDirectory}/`
  if (!uri.startsWith(root)) return false
  const relative = appOwnedScreenshotRelativePath(uri, root)
  if (relative === null) return false
  if (`${root}${relative}` !== uri) return false
  try {
    const info = await fs.size(uri)
    if (info !== byteLength) return false
    const base64 = await fs.readBase64(uri)
    if (base64ByteLength(base64) !== byteLength) return false
    if (sniffBase64Format(base64) !== format) return false
    return (await sha256HexOfBase64(base64)) === sha256
  } catch {
    return false
  }
}

/**
 * 只导入截图的主入口。
 *
 * 文件先写进应用自己的 `screenshots/`（内容寻址、临时文件 + 校验后改名）；
 * 数据库写入在一个事务里，任何失败都回滚，并只清理**本次新建**的文件。
 */
export async function importScreenshotImagesFromBackup(input: {
  db: SqliteDatabase
  fs: BackupFileSystem
  repository: ScreenshotLibraryRepository
  images: readonly BackupImportImageInput[]
  /** 用于记录里的中性说明，不写任何个人课表事实。 */
  note?: string
}): Promise<ScreenshotImageImportOutcome> {
  const total = input.images.length
  if (total === 0) {
    return {
      committed: true,
      imported: 0,
      repaired: 0,
      skipped: 0,
      total: 0,
      message: '这份备份里没有可导入的截图，任务和课程也没有被改动。',
      cleanupWarning: null,
    }
  }

  const screenshotsDir = joinUri(input.fs.documentDirectory, SCREENSHOT_DIR_NAME)
  await input.fs.ensureDirectory(screenshotsDir)
  const staged: VerifiedImage[] = []
  const seenSha = new Set<string>()
  try {
    for (let index = 0; index < total; index += 1) {
      const image = input.images[index]!
      const declaration = assertImageDeclaration(image, index)
      if (seenSha.has(declaration.sha256)) {
        throw new Error(`第 ${index + 1} 张截图与前面某张的内容哈希相同（备份里不应重复）。`)
      }
      seenSha.add(declaration.sha256)
      staged.push(await writeVerifiedImage(image, index, input.fs, screenshotsDir))
    }
  } catch (cause) {
    // 文件阶段失败：只清理本次已经新建的文件；不动任何既有图片 / 记录。
    for (const item of staged) {
      if (!item.created) continue
      try {
        if (await input.fs.exists(item.finalUri)) await input.fs.deleteFile(item.finalUri)
      } catch {
        // 清理失败不掩盖原始错误
      }
    }
    return {
      committed: false,
      code: cause instanceof Error && /声明|哈希|格式|大小|图片头|字节/.test(cause.message) ? 'INVALID_IMAGE' : 'WRITE_FAILED',
      reason: `只导入截图没有完成：${cause instanceof Error ? cause.message : String(cause)}`,
      cleanupWarning: null,
    }
  }

  let imported = 0
  let repaired = 0
  let skipped = 0
  const kept = new Set<string>()
  try {
    await input.db.withTransactionAsync(async () => {
      for (const item of staged) {
        const { sha256, byteLength, format } = item.input
        const existing = await input.repository.listAttemptsBySha256(sha256)
        if (existing.length === 0) {
          await input.repository.recordAttempt({
            source: 'ARCHIVE',
            status: 'ARCHIVED',
            capturedAt: item.input.capturedAt ?? undefined,
            archivedPath: item.finalUri,
            originalUri: null,
            sha256,
            byteLength,
            width: item.input.width,
            height: item.input.height,
            format,
            mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
            note:
              input.note ??
              '从备份文件只导入截图（没有恢复或关联任务 / 课程；重复导入同一张图不会新增图片）',
          })
          imported += 1
          kept.add(item.finalUri)
          continue
        }

        /**
         * 同一个 SHA 可能对应多条历史尝试（用户重复提交、关联了不同任务）。
         * 不能因为其中一条还能看到图就跳过整张图：所有**文件丢失 / 字节不符**的
         * 同 SHA 记录都必须指向这份重新校验过的字节，才能保住各自的历史关联。
         * id 与 refs 一律不动，只做带旧值条件的路径更新。
         */
        let broken = 0
        for (const attempt of existing) {
          if (await pathHasMatchingBytes(input.fs, attempt.archivedPath, sha256, byteLength, format)) {
            continue
          }
          const applied = await input.repository.rebaseArchivedPath({
            attemptId: attempt.id,
            expectedArchivedPath: attempt.archivedPath,
            nextArchivedPath: item.finalUri,
            expectedSha256: sha256,
          })
          if (!applied) throw new Error(`截图 #${attempt.id} 的原图路径在导入过程中被改动，已回滚。`)
          broken += 1
        }
        if (broken > 0) {
          repaired += broken
          kept.add(item.finalUri)
        } else {
          skipped += 1
        }
      }
    })
  } catch (cause) {
    // 数据库事务已回滚：本次新建的文件如果没被其它已有记录引用，就清理掉。
    let cleanupWarning: string | null = null
    for (const item of staged) {
      if (!item.created) continue
      try {
        if (await input.fs.exists(item.finalUri)) await input.fs.deleteFile(item.finalUri)
      } catch (cleanupCause) {
        cleanupWarning = cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause)
      }
    }
    return {
      committed: false,
      code: 'DB_FAILED',
      reason: `截图已经校验，但写入截图库失败，当前数据没有被改动：${cause instanceof Error ? cause.message : String(cause)}`,
      cleanupWarning,
    }
  }

  // 成功提交后才清理本次未被任何记录使用的重复文件；只删本次新建的。
  let cleanupWarning: string | null = null
  for (const item of staged) {
    if (!item.created || kept.has(item.finalUri)) continue
    try {
      if (await input.fs.exists(item.finalUri)) await input.fs.deleteFile(item.finalUri)
    } catch (cause) {
      cleanupWarning = cause instanceof Error ? cause.message : String(cause)
    }
  }
  return {
    committed: true,
    imported,
    repaired,
    skipped,
    total,
    message:
      imported === 0 && repaired === 0
        ? `这份备份里的 ${total} 张截图本机都已经有了，没有重复导入；任务和课程没有被改动。`
        : `只导入截图完成：新增 ${imported} 张，修复 ${repaired} 张旧图片，跳过 ${skipped} 张已有图片；任务和课程没有被改动。`,
    cleanupWarning,
  }
}
