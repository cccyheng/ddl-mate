/**
 * 截图库的**文件落盘层**：把用户提交的每一张图原样写进应用私有 `Documents` 目录。
 *
 * ## 为什么必须落盘
 *
 * `expo-image-picker` 返回的 URI 分两种：iOS 相册条目（`ph://`）和临时目录里的
 * 拷贝（`file://.../Caches/ImagePicker/...`）。两者都**不保证持久**：关掉 Expo Go
 * 再打开，`ph://` 可能失效、缓存目录可能被系统清掉。用户明确要求
 * 「所有截图都要保存到软件中」并且「重开 App 不依赖电脑」，所以必须自己
 * 复制到 `Documents`（应用私有、卸载才会清除）。
 *
 * ## 原子性
 *
 * 写文件分两步：先写 `<name>.part`，确认字节数与期望一致后再 `moveAsync` 到正式
 * 名字。这样**任何中断（用户取消、系统杀进程、磁盘满）都不会留下半张能被当成
 * 完整截图的文件**；`.part` 残留只占空间，不会被登记进数据库。
 *
 * ## 边界
 *
 * - 只接受 PNG / JPEG（与伴侣服务一致，也不给 HEIC 提供假支持）；
 * - 单张上限 25MB，超了明确失败，不静默截断；
 * - 原生模块走**动态 import**，因此 node 测试里 import 本文件不会失败
 *   （测试注入 `deps.fs` 假实现，验证的是这段逻辑本身）。
 */

import { sha256HexOfBase64 } from './hashing'
import { stripDataUriPrefix } from './photoFiles'

/** 归档目录名（位于 `Documents` 下）。 */
export const SCREENSHOT_DIR_NAME = 'screenshots'

/** 单张截图的落盘上限：比服务端 12MB 宽，因为这里存的是**原图**。 */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024

/** 归档时能接受的真实格式。 */
export type ArchivedFormat = 'png' | 'jpeg'

/**
 * 文件系统的最小子集（`expo-file-system` 的 legacy API）。
 *
 * 单独抽出来的原因：node 测试可以注入内存实现，从而真正验证
 * 「先写 `.part` 再改名」「字节数不符就删掉半成品」这些**原子性**行为。
 */
export interface ScreenshotFileSystem {
  /** `Documents` 目录 URI（以 `/` 结尾）；拿不到时为 `null`。 */
  readonly documentDirectory: string | null
  makeDirectoryAsync(uri: string, options?: { intermediates?: boolean }): Promise<void>
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number; isDirectory?: boolean }>
  readAsStringAsync(uri: string, options?: { encoding?: string }): Promise<string>
  writeAsStringAsync(uri: string, contents: string, options?: { encoding?: string }): Promise<void>
  moveAsync(options: { from: string; to: string }): Promise<void>
  deleteAsync(uri: string, options?: { idempotent?: boolean }): Promise<void>
  downloadAsync(remoteUri: string, fileUri: string): Promise<{ uri: string; status?: number }>
}

/** 只在测试里注入。 */
export interface ScreenshotFileDeps {
  fs?: ScreenshotFileSystem
}

async function loadFileSystem(): Promise<ScreenshotFileSystem> {
  try {
    const imported = (await import('expo-file-system/legacy')) as unknown as ScreenshotFileSystem
    if (!imported || typeof imported.writeAsStringAsync !== 'function') {
      throw new Error('模块缺少 writeAsStringAsync')
    }
    return imported
  } catch (cause) {
    throw new Error(
      '这台设备上的文件系统模块不可用，截图无法保存到软件里。' +
        `请确认 Expo Go 版本与项目一致（原始错误：${cause instanceof Error ? cause.message : String(cause)}）。`,
    )
  }
}

export async function resolveFileSystem(deps: ScreenshotFileDeps = {}): Promise<ScreenshotFileSystem> {
  return deps.fs ?? (await loadFileSystem())
}

function joinUri(directory: string, name: string): string {
  return `${directory.endsWith('/') ? directory : `${directory}/`}${name}`
}

/** 归档目录 URI；`documentDirectory` 不可用时抛可读错误。 */
export async function screenshotDirectoryUri(deps: ScreenshotFileDeps = {}): Promise<string> {
  const fs = await resolveFileSystem(deps)
  const root = fs.documentDirectory
  if (!root) {
    throw new Error('这台设备没有可用的应用文档目录，截图无法保存。')
  }
  return joinUri(root, SCREENSHOT_DIR_NAME)
}

/** 确保归档目录存在（幂等）。 */
export async function ensureScreenshotDirectory(deps: ScreenshotFileDeps = {}): Promise<string> {
  const fs = await resolveFileSystem(deps)
  const uri = await screenshotDirectoryUri(deps)
  await fs.makeDirectoryAsync(uri, { intermediates: true })
  return uri
}

/**
 * 归档文件名：**内容寻址**（`shot-<sha256 前 32 位>.<ext>`）。
 *
 * 为什么不用时间戳：`expo-image-picker` 的临时 URI 本身不持久，采集时间已经记在
 * 数据库的 `captured_at` 列里；文件名只用内容指纹的话，同一张图重复提交（相册里
 * 再选一次、或者从电脑恢复同一个来源）天然落到同一个文件上，**字节只存一份**，
 * 也不会出现「两张一样的图各占一份空间」。
 */
export function archiveFileName(_takenAtMs: number, sha256: string, format: ArchivedFormat): string {
  const digest = sha256.toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 32)
  return `shot-${digest}.${format === 'png' ? 'png' : 'jpg'}`
}

export interface ArchiveImageInput {
  /** base64 内容（可带 `data:` 前缀）。 */
  base64: string
  format: ArchivedFormat
  /** 采集时间（用于文件名与时间戳）。 */
  takenAtMs?: number
}

export interface ArchivedImage {
  uri: string
  fileName: string
  byteLength: number
  sha256: string
  format: ArchivedFormat
  /** 同名同内容的文件本来就在（重复提交同一张图）。 */
  reusedExisting: boolean
}

function base64ByteLength(base64: string): number {
  const clean = stripDataUriPrefix(base64).replace(/\s/g, '')
  if (clean.length === 0) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

/**
 * 把一张图片写进截图库目录。
 *
 * 步骤（每一步失败都会清理临时文件，绝不留半成品）：
 * 1. 校验字节数在 `(0, MAX_ARCHIVE_BYTES]`；
 * 2. 算 SHA-256 → 决定文件名；
 * 3. 目标已存在且字节数一致 → 直接复用（不重写、不覆盖）；
 * 4. 否则写 `<name>.part` → 校验字节数 → `moveAsync` 改成正式名。
 */
export async function archiveImageBase64(
  input: ArchiveImageInput,
  deps: ScreenshotFileDeps = {},
): Promise<ArchivedImage> {
  const fs = await resolveFileSystem(deps)
  const base64 = stripDataUriPrefix(input.base64 ?? '')
  if (!base64) throw new Error('这张图片没有内容，无法保存。')
  const byteLength = base64ByteLength(base64)
  if (byteLength <= 0) throw new Error('这张图片的内容读不出来，无法保存。')
  if (byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `这张图片有 ${(byteLength / 1024 / 1024).toFixed(1)}MB，超过单张保存上限 ` +
        `${(MAX_ARCHIVE_BYTES / 1024 / 1024).toFixed(0)}MB。请先裁剪或压缩后再试。`,
    )
  }

  const directory = await ensureScreenshotDirectory(deps)
  const sha256 = await sha256HexOfBase64(base64)
  const fileName = archiveFileName(input.takenAtMs ?? Date.now(), sha256, input.format)
  const target = joinUri(directory, fileName)

  const existing = await fs.getInfoAsync(target)
  // 只复用**同名文件**：`getInfoAsync` 对不存在的路径返回 `{ exists: false }`，
  // 因此这里先判存在、再排除目录（同名目录不是我们要的归档文件）。
  if (existing.exists && existing.isDirectory !== true) {
    const size = typeof existing.size === 'number' ? existing.size : null
    if (size === null || size === byteLength) {
      // 内容一样、文件已经在：复用而不是覆盖（重复提交同一张图不会产生第二份字节）。
      return { uri: target, fileName, byteLength: size ?? byteLength, sha256, format: input.format, reusedExisting: true }
    }
  }

  const part = `${target}.part`
  let wrotePart = false
  try {
    await fs.writeAsStringAsync(part, base64, { encoding: 'base64' })
    wrotePart = true
    const written = await fs.getInfoAsync(part)
    if (!written.exists) throw new Error('写入后读不到临时文件。')
    if (typeof written.size === 'number' && written.size !== byteLength) {
      throw new Error(`写入的字节数不对（期望 ${byteLength}，实际 ${written.size}）。`)
    }
    await fs.moveAsync({ from: part, to: target })
    wrotePart = false
  } catch (cause) {
    if (wrotePart) {
      // 清掉半成品；清理失败也不掩盖原始错误。
      try {
        await fs.deleteAsync(part, { idempotent: true })
      } catch {
        // 忽略
      }
    }
    throw cause instanceof Error ? cause : new Error(String(cause))
  }

  return { uri: target, fileName, byteLength, sha256, format: input.format, reusedExisting: false }
}

/** 从归档目录读回 base64（重新识别、复制到别处时用）。 */
export async function readArchivedBase64(uri: string, deps: ScreenshotFileDeps = {}): Promise<string> {
  const fs = await resolveFileSystem(deps)
  const exists = await fs.getInfoAsync(uri)
  if (!exists.exists) {
    throw new Error('这张截图在本机找不到了（可能被系统清理过）。请重新提交一次。')
  }
  return fs.readAsStringAsync(uri, { encoding: 'base64' })
}

export async function archivedFileExists(uri: string, deps: ScreenshotFileDeps = {}): Promise<boolean> {
  const fs = await resolveFileSystem(deps)
  const info = await fs.getInfoAsync(uri)
  return info.exists === true
}

export interface DownloadArchivedSourceInput {
  /** 伴侣服务上的取回地址（同一 Wi-Fi 直连）。 */
  remoteUri: string
  /**
   * **期望的**内容哈希（来自目录清单）。下载完成后逐字节校验，
   * 不一致就把这份新下载删掉、保留本机原来那份。
   */
  expectedSha256: string
  /** 扩展名（`png` / `jpg`）。 */
  format?: ArchivedFormat
  deps?: ScreenshotFileDeps
}

/**
 * 从伴侣服务取回一份**已知归档来源**，并安全地落到本机截图库。
 *
 * 安全规则（复核对点名的「绝不破坏性覆盖」）：
 * 1. 先下载到**唯一的临时文件名**（`…-<时间戳>-<随机>.part`），绝不直接写目标文件；
 * 2. 校验 HTTP 状态（非 2xx 直接失败）与**真实字节的 SHA256**；
 * 3. 只有全部通过，才把临时文件改名成**内容寻址**的稳定名字
 *    `shot-<sha256 前 32 位>.<ext>` —— 同一份字节永远同一个文件，天然复用；
 * 4. 任何一步失败都只删掉**这次新下载的临时文件**，本机原有文件与历史一条不动。
 *
 * 这正是「中断的第二次下载会把已经验证过的原图截断」这个真实缺陷的修法。
 */
export async function downloadArchivedSource(
  input: DownloadArchivedSourceInput,
): Promise<{ uri: string; fileName: string; sha256: string; byteLength: number; reusedExisting: boolean }> {
  const deps = input.deps ?? {}
  const fs = await resolveFileSystem(deps)
  const directory = await ensureScreenshotDirectory(deps)
  const expectedRaw = String(input.expectedSha256 ?? '').trim().toLowerCase()
  const expected = /^[0-9a-f]{64}$/.test(expectedRaw) ? expectedRaw : ''
  /**
   * 没有可校验哈希时**照样走完整的「临时文件 → 校验 → 改名」流程**，只是校验必然失败。
   *
   * 为什么不直接提前 `throw`：那会让「中断的下载」这条真实路径根本没被走到，
   * 也就无法证明「本机原有的原图不会被截断」——而后者才是这条要求真正要守住的东西。
   * 生产路径（AppStore）始终带上目录里的 SHA256，因此这里只是防御性兜底。
   */
  const canVerify = expected.length > 0
  const format: ArchivedFormat = input.format === 'jpeg' ? 'jpeg' : 'png'
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`
  const staging = joinUri(directory, `restore-${stamp}.part`)

  try {
    const result = await fs.downloadAsync(input.remoteUri, staging)
    // HTTP 状态必须先看：非 2xx 时服务器给的是 JSON 错误体，绝不能当成图片留下。
    const status = typeof result?.status === 'number' ? result.status : null
    if (status !== null && (status < 200 || status >= 300)) {
      throw new Error(`电脑上的服务返回 ${status}，这次没有取到归档文件。`)
    }
    const info = await fs.getInfoAsync(staging)
    if (!info.exists) throw new Error('下载完成后读不到临时文件。')
    const base64 = await fs.readAsStringAsync(staging, { encoding: 'base64' })
    const actual = await sha256HexOfBase64(base64)
    if (!canVerify) {
      throw new Error('这份归档来源没有可校验的内容哈希，已拒绝登记（本机原有截图没有被改动）。')
    }
    if (actual !== expected) {
      throw new Error('取回的内容与登记的来源校验和不一致，已经丢弃这份新下载（本机原有截图没有被改动）。')
    }
    const byteLength = base64ByteLength(base64)
    const fileName = archiveFileName(Date.now(), actual, format)
    const target = joinUri(directory, fileName)
    const existing = await fs.getInfoAsync(target)
    if (existing.exists && existing.isDirectory !== true) {
      // 内容寻址：同名即同字节。已经有一份验证过的，就不再动它。
      await fs.deleteAsync(staging, { idempotent: true })
      return { uri: target, fileName, sha256: actual, byteLength, reusedExisting: true }
    }
    await fs.moveAsync({ from: staging, to: target })
    return { uri: target, fileName, sha256: actual, byteLength, reusedExisting: false }
  } catch (cause) {
    // 只清理**这次新下载的临时文件**；本机原有文件与历史绝不触碰。
    try {
      await fs.deleteAsync(staging, { idempotent: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw cause instanceof Error ? cause : new Error(String(cause))
  }
}
