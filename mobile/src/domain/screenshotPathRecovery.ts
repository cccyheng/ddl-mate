/**
 * 旧截图**绝对路径**的只读校验与安全修复。
 *
 * ## 为什么需要这一层
 *
 * `screenshotFiles.ts` 把原图写进应用私有 `Documents/screenshots/`，数据库里
 * 保存的是当时的**完整 file:// 路径**。iOS 的应用数据容器路径带一个安装相关的
 * UUID；系统在应用更新 / 迁移后可能给同一个 App 换一个容器根目录，而
 * `expo-file-system` 的 `documentDirectory` 取自
 * `FileManager.default.urls(for: .documentDirectory, ...)`，也就是**当前**容器。
 *
 * 于是会出现这种真实情况：
 *
 * - 字节其实还在**当前**容器的 `Documents/screenshots/` 里；
 * - 数据库里那串旧绝对路径指向**旧**容器，`Image` / 文件读取都找不到；
 * - 界面看起来就像「升级后图片全没了」。
 *
 * 这不是「升级删了文件」的证据。这里绝不这样断言，只做可验证的事情：
 *
 * 1. 只从旧路径里提取**应用自己的** `screenshots/<内容寻址文件名>` 这一段；
 * 2. 只去**当前** `documentDirectory` 下找同一个相对路径；
 * 3. 文件必须真实存在，字节数 / SHA-256 / 图片格式必须与数据库登记一致
 *    （没有登记哈希时，至少要求文件名里的内容指纹与真实字节一致）；
 * 4. 只有全部通过，才用 compare-and-swap 只更新 `archived_path` 一列。
 *
 * 绝不按文件名猜、绝不跨任务分配、绝不接受 `..` / 反斜杠 / 百分比转义 /
 * 外部目录，也绝不因为「同名」就把另一张图塞给这条记录。校验失败时原记录原样保留。
 */

import { sha256HexOfBase64 } from './hashing'
import { base64ByteLength, sniffBase64Format } from './photoFiles'
import { MAX_ARCHIVE_BYTES } from './screenshotFiles'

/** 只依赖截图库真正用到的文件系统子集（native 侧是 `expo-file-system/legacy`）。 */
export interface ScreenshotPathFileSystem {
  readonly documentDirectory: string | null
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number; isDirectory?: boolean }>
  readAsStringAsync(uri: string, options?: { encoding?: string }): Promise<string>
}

/** 修复只需要读这些列；不要求界面把整个仓库对象交出来。 */
export interface ScreenshotPathRecord {
  id: number
  archivedPath: string | null
  sha256: string | null
  byteLength: number | null
  format: string | null
  status: string
}

export interface ScreenshotPathUpdate {
  attemptId: number
  oldPath: string
  newPath: string
  sha256: string
  byteLength: number
  format: 'png' | 'jpeg'
}

export type ScreenshotPathResolution =
  | { status: 'already-ok'; attemptId: number; archivedPath: string }
  | { status: 'missing'; attemptId: number; oldPath: string; relativePath: string | null; reason: string }
  | { status: 'rejected'; attemptId: number; oldPath: string; relativePath: string | null; reason: string }
  | { status: 'repaired'; update: ScreenshotPathUpdate }

export interface ScreenshotPathRepairReport {
  checked: number
  alreadyOk: number
  repaired: number
  missing: number
  rejected: number
  updates: ScreenshotPathUpdate[]
  missingAttemptIds: number[]
  rejectedAttemptIds: number[]
}

/**
 * 应用自己的截图文件名：内容寻址 `shot-<32hex>`，或恢复 / 导入冲突时的
 * `restore-YYYYMMDD-HHMMSS-<16hex>[-<数字>].png|jpg`。
 *
 * `-<数字>` 是 `uniqueName` 在同一秒内遇到同名文件时加的真实后缀；
 * 不支持下划线 / 任意后缀，避免把外部文件当成应用自己的图片。
 */
const APP_SCREENSHOT_FILE_RE =
  /^(?:shot-([0-9a-f]{32})|restore-(\d{8}-\d{6})-([0-9a-f]{16})(?:-\d+)?)\.(png|jpg)$/

const SHA256_RE = /^[0-9a-f]{64}$/

function joinUri(directory: string, name: string): string {
  return `${directory.endsWith('/') ? directory.slice(0, -1) : directory}/${name}`
}

/**
 * 只接受**本机 file URI**作为旧路径的来源。
 *
 * 不能因为任意 URL 里刚好有 `/Documents/screenshots/` 就把它当应用路径：
 * `http(s)://…`、`ph://…`、`content://…`、纯相对路径一律拒绝。`file://host/...`
 * 也拒绝，只接受空 host 的 `file:///…` 或 `file:/…`。
 */
function isAppOwnedPathSource(raw: string): boolean {
  const lower = raw.toLowerCase()
  // 旧路径由 expo-file-system 写入，正常都是 file:// URI；其他 scheme / 纯相对路径不认。
  if (!lower.startsWith('file:')) return false
  const afterScheme = raw.slice('file:'.length)
  // 只接受空 host：`file:///var/...`（三斜杠）或 `file:/var/...`；
  // `file://host/...`（两斜杠后接 host）拒绝。
  if (afterScheme.startsWith('///')) return true
  return afterScheme.startsWith('/') && !afterScheme.startsWith('//')
}

/** 只接受应用截图目录里、内容寻址命名的文件名；其它名字一律不猜。 */
export function isAppOwnedScreenshotFileName(fileName: string): boolean {
  const match = APP_SCREENSHOT_FILE_RE.exec(fileName)
  return match !== null && (match[1] !== undefined || match[3] !== undefined)
}

/**
 * 从旧绝对路径里提取**应用自己的相对路径**（`screenshots/<name>`）。
 *
 * 处理两种来源：
 * - 当前 documentDirectory 前缀（正常情况）；
 * - 旧容器根目录变化后，路径里仍有的 `/Documents/` 段（升级后的真实情况）。
 *
 * 只保留 `screenshots/` 这一层，不保留旧容器里的任何其它目录。
 */
export function appOwnedScreenshotRelativePath(
  archivedPath: string | null | undefined,
  documentDirectory: string | null | undefined,
): string | null {
  const raw = String(archivedPath ?? '')
  if (raw.length === 0) return null
  let relative: string | null = null
  if (documentDirectory && raw.startsWith(documentDirectory)) {
    relative = raw.slice(documentDirectory.length)
  } else {
    if (!isAppOwnedPathSource(raw)) return null
    const marker = '/Documents/'
    const index = raw.lastIndexOf(marker)
    if (index >= 0) relative = raw.slice(index + marker.length)
  }
  if (relative === null || relative.length === 0 || relative.length > 512) return null
  // 内容寻址文件名只含 ASCII；任何转义 / 反斜杠 / 查询串都拒绝，避免绕过目录约束。
  if (/[\\%?#:\u0000-\u001f]/.test(relative)) return null
  const segments = relative.split('/')
  if (segments.length !== 2) return null
  if (segments[0] !== 'screenshots') return null
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null
  if (!isAppOwnedScreenshotFileName(segments[1]!)) return null
  return relative
}

/** 文件名里的内容指纹（`shot-` 为 32 位，`restore-` 为 16 位）。 */
export function contentHashPrefixOfFileName(fileName: string): string | null {
  const match = APP_SCREENSHOT_FILE_RE.exec(fileName)
  if (!match) return null
  return match[1] ?? match[3] ?? null
}

function expectedFormatOf(record: ScreenshotPathRecord, fileName: string): 'png' | 'jpeg' | null {
  const ext = fileName.endsWith('.png') ? 'png' : fileName.endsWith('.jpg') ? 'jpeg' : null
  if (!ext) return null
  const stored = String(record.format ?? '').trim().toLowerCase()
  if (stored.length === 0) return ext
  const normalized = stored === 'jpg' ? 'jpeg' : stored
  if (normalized !== 'png' && normalized !== 'jpeg') return null
  return normalized === ext ? ext : null
}

/**
 * 尝试把一条旧路径解析到**当前**应用目录中的同一相对位置。
 *
 * 只读取候选文件；不写数据库、不删除、不改原记录。调用方拿到 `repaired` 后
 * 才通过仓库做一次带条件的单列更新。
 */
export async function resolveScreenshotPath(
  record: ScreenshotPathRecord,
  fs: ScreenshotPathFileSystem,
): Promise<ScreenshotPathResolution> {
  const oldPath = record.archivedPath
  const attemptId = record.id
  if (!oldPath) {
    return { status: 'missing', attemptId, oldPath: '', relativePath: null, reason: '这条记录没有归档路径。' }
  }
  if (record.status === 'ARCHIVE_FAILED') {
    return { status: 'rejected', attemptId, oldPath, relativePath: null, reason: '这条记录本来就没有保存成功。' }
  }
  /**
   * 只有「旧路径**就是**当前 documentDirectory 下的同一相对位置」时才直接
   * 当作 already-ok。旧容器 / 外部 URL 即使碰巧还存在，也不 stat、不读、不信任。
   */
  const relativePath = appOwnedScreenshotRelativePath(oldPath, fs.documentDirectory)
  const currentCandidate =
    relativePath !== null && fs.documentDirectory ? joinUri(fs.documentDirectory, relativePath) : null
  const currentIsAppOwned = currentCandidate !== null && currentCandidate === oldPath
  if (currentIsAppOwned) {
    const current = await fs.getInfoAsync(oldPath)
    if (current.exists && current.isDirectory !== true) {
      return { status: 'already-ok', attemptId, archivedPath: oldPath }
    }
  }

  if (relativePath === null) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath: null,
      reason: '旧路径不在应用自己的 screenshots 目录里，拒绝改写到其它位置。',
    }
  }
  const fileName = relativePath.slice('screenshots/'.length)
  const expectedFormat = expectedFormatOf(record, fileName)
  if (expectedFormat === null) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: '文件名扩展名与登记的图片格式不一致，拒绝按同名猜测。',
    }
  }
  const prefix = contentHashPrefixOfFileName(fileName)
  const registeredSha = String(record.sha256 ?? '').trim().toLowerCase()
  const hasRegisteredSha = SHA256_RE.test(registeredSha)
  if (!hasRegisteredSha && prefix === null) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: '没有可校验的内容哈希，拒绝按文件名猜测。',
    }
  }

  if (!fs.documentDirectory) {
    return { status: 'missing', attemptId, oldPath, relativePath, reason: '这台设备没有可用的应用文档目录。' }
  }
  const candidateUri = joinUri(fs.documentDirectory, relativePath)
  const info = await fs.getInfoAsync(candidateUri)
  if (!info.exists || info.isDirectory === true) {
    return {
      status: 'missing',
      attemptId,
      oldPath,
      relativePath,
      reason: '当前应用目录里找不到同一相对位置的图片文件。',
    }
  }
  if (typeof record.byteLength === 'number' && Number.isFinite(record.byteLength)) {
    if (record.byteLength <= 0 || record.byteLength > MAX_ARCHIVE_BYTES) {
      return {
        status: 'rejected',
        attemptId,
        oldPath,
        relativePath,
        reason: `登记的字节数 ${record.byteLength} 不在 1–${MAX_ARCHIVE_BYTES} 的允许范围内。`,
      }
    }
    if (typeof info.size !== 'number' || info.size !== record.byteLength) {
      return {
        status: 'rejected',
        attemptId,
        oldPath,
        relativePath,
        reason: `候选文件字节数（${info.size ?? '读不到'}）与登记值（${record.byteLength}）不一致。`,
      }
    }
  }
  // 先看大小再哈希：不把任意大的外部 / 损坏文件读进内存。
  if (typeof info.size === 'number' && (info.size <= 0 || info.size > MAX_ARCHIVE_BYTES)) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: `候选文件大小 ${info.size} 不在 1–${MAX_ARCHIVE_BYTES} 的允许范围内。`,
    }
  }

  let base64: string
  try {
    base64 = await fs.readAsStringAsync(candidateUri, { encoding: 'base64' })
  } catch (cause) {
    return {
      status: 'missing',
      attemptId,
      oldPath,
      relativePath,
      reason: `候选文件读不出来：${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
  const decodedLength = base64ByteLength(base64)
  if (decodedLength <= 0 || decodedLength > MAX_ARCHIVE_BYTES) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: `候选文件解码后大小 ${decodedLength} 不在 1–${MAX_ARCHIVE_BYTES} 的允许范围内。`,
    }
  }
  const actualSha = await sha256HexOfBase64(base64)
  if (hasRegisteredSha) {
    if (actualSha !== registeredSha) {
      return {
        status: 'rejected',
        attemptId,
        oldPath,
        relativePath,
        reason: '候选文件内容哈希与登记值不一致，拒绝把另一张图接到这条记录上。',
      }
    }
  } else if (prefix !== null && !actualSha.startsWith(prefix)) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: '候选文件内容与文件名里的内容指纹不一致。',
    }
  }
  const actualFormat = sniffBase64Format(base64)
  if (actualFormat !== expectedFormat) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: '候选文件实际格式与登记格式不一致。',
    }
  }
  const byteLength = decodedLength
  if (typeof record.byteLength === 'number' && byteLength !== record.byteLength) {
    return {
      status: 'rejected',
      attemptId,
      oldPath,
      relativePath,
      reason: '候选文件解码后的字节数与登记值不一致。',
    }
  }
  return {
    status: 'repaired',
    update: {
      attemptId,
      oldPath,
      newPath: candidateUri,
      sha256: actualSha,
      byteLength,
      format: actualFormat,
    },
  }
}

/**
 * 批量检查并修复（调用方提供带条件的单列更新函数）。
 *
 * `rebase` 必须只在「记录的旧路径仍然是 expected 的旧路径」时返回 true，
 * 这样并发的另一次修复 / 恢复不会把新路径覆盖掉。
 */
export async function repairScreenshotPaths(
  records: readonly ScreenshotPathRecord[],
  fs: ScreenshotPathFileSystem,
  rebase: (update: ScreenshotPathUpdate) => Promise<boolean>,
): Promise<ScreenshotPathRepairReport> {
  const report: ScreenshotPathRepairReport = {
    checked: 0,
    alreadyOk: 0,
    repaired: 0,
    missing: 0,
    rejected: 0,
    updates: [],
    missingAttemptIds: [],
    rejectedAttemptIds: [],
  }
  for (const record of records) {
    if (!record.archivedPath || record.status === 'ARCHIVE_FAILED') continue
    report.checked += 1
    const resolution = await resolveScreenshotPath(record, fs)
    if (resolution.status === 'already-ok') {
      report.alreadyOk += 1
      continue
    }
    if (resolution.status === 'missing') {
      report.missing += 1
      report.missingAttemptIds.push(record.id)
      continue
    }
    if (resolution.status === 'rejected') {
      report.rejected += 1
      report.rejectedAttemptIds.push(record.id)
      continue
    }
    const applied = await rebase(resolution.update)
    if (applied) {
      report.repaired += 1
      report.updates.push(resolution.update)
    } else {
      // 记录在检查与更新之间被改过：不覆盖，保持原样并如实计数。
      report.rejected += 1
      report.rejectedAttemptIds.push(record.id)
    }
  }
  return report
}
