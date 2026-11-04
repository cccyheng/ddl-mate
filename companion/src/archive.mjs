/**
 * 伴侣服务的**只读历史归档**：把工作区里项目自己保留的那几份截图按需发给手机。
 *
 * 为什么要有这个模块（以及它刻意**不**做什么）：
 * - 用户要求「以前的截图也要能恢复到手机里」，而那几份图只在电脑工作区；
 * - 手机与电脑本来就在同一 Wi-Fi 上用同一个伴侣服务，所以不需要新的通道；
 * - **但它不是文件服务**：只有 `.tools/photo/archive-catalog.json` 里明确列出的
 *   那几个相对路径可以被读，且路径必须落在 `allowedRoots` 之内、不能含 `..`、
 *   不能是绝对路径、不能是符号链接逃逸；目录扫描 / 通配 / 任意路径一律拒绝。
 *
 * 对外只暴露两个能力：
 * - `listSources()`：返回目录（标题 / 相对路径 / SHA256 / 尺寸 / 说明），不含字节；
 * - `readSource(catalogKey)`：返回那一份文件的字节 + 元数据，读之前**校验 SHA256**，
 *   与目录不一致就报错（宁可让手机重试，也不发一份不知道是什么的东西）。
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

/** 目录里允许被读的根（相对工作区）。 */
const DEFAULT_ALLOWED_ROOTS = ['.tools/photo']

/** 单份归档文件上限：这些都是截图，给 40MB 足够，也挡住误配置读到大文件。 */
export const ARCHIVE_MAX_BYTES = 40 * 1024 * 1024

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

/** 路径必须落在允许的根之内（防 `..`、绝对路径、以及根之外的任何东西）。 */
export function resolveArchivePath(workspaceRoot, relPath, allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  const raw = String(relPath ?? '').trim()
  if (!raw) throw new ArchiveError('BAD_REQUEST', '归档条目缺少路径。')
  if (isAbsolute(raw)) throw new ArchiveError('FORBIDDEN', '归档路径必须是工作区内的相对路径。')
  const normalizedRel = normalize(raw).split(sep).join('/')
  if (normalizedRel.startsWith('..') || normalizedRel.includes('/../')) {
    throw new ArchiveError('FORBIDDEN', '归档路径不允许跳出工作区。')
  }
  const allowed = allowedRoots.some(
    (root) => normalizedRel === root || normalizedRel.startsWith(`${normalize(root).split(sep).join('/')}/`),
  )
  if (!allowed) {
    throw new ArchiveError('FORBIDDEN', '这份文件不在允许归档的目录里。')
  }
  const absolute = resolve(workspaceRoot, normalizedRel)
  // 双保险：解析之后再确认一次真的还在工作区里（符号链接 / 平台差异都挡住）。
  const rel = relative(workspaceRoot, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ArchiveError('FORBIDDEN', '归档路径解析后落在工作区之外。')
  }
  return absolute
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * **真实路径**必须落在允许根的真实路径之内。
 *
 * 为什么必须做这一步（复核对点名的缺陷）：`resolve` / `relative` 只做**字符串**层面的
 * 包含判断，符号链接（或 Windows 的 junction / 目录联接）可以让
 * `.tools/photo/link.png` 指向工作区外的任意文件 —— `stat` / `readFile` 会老老实实
 * 跟着链接去读。所以在真正读字节之前，用 `realpath` 把两边都解析成真实路径，
 * 再确认包含关系；解析失败（文件不存在 / 权限不足）一律按拒绝处理。
 *
 * 允许根本身也要 `realpath`：如果 `.tools/photo` 自己就是一个链接，我们以它**实际**
 * 指向的目录为边界，而不是以字符串边界为准。
 */
export async function assertRealPathInside({ workspaceRoot, absolutePath, allowedRoots = DEFAULT_ALLOWED_ROOTS }) {
  let realTarget
  try {
    realTarget = await realpath(absolutePath)
  } catch {
    throw new ArchiveError('NOT_FOUND', '这份归档文件在电脑上找不到了。')
  }
  const realRoots = []
  for (const root of allowedRoots) {
    const absoluteRoot = resolve(workspaceRoot, String(root))
    try {
      realRoots.push(await realpath(absoluteRoot))
    } catch {
      // 允许根本身不存在时跳过它（不该因此放行任何东西）。
    }
  }
  const inside = realRoots.some((realRoot) => {
    const rel = relative(realRoot, realTarget)
    return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!inside) {
    throw new ArchiveError('FORBIDDEN', '这份文件通过链接指向了归档目录之外，已拒绝发送。')
  }
  return realTarget
}

/**
 * 读取归档目录。
 *
 * 目录里可以给一个可选的 `root`：**相对路径（`archiveRelPath`）相对哪个目录**。
 * 缺省就是工作区。显式写出来是为了让「把整套 `.tools/photo` 复制到别处做验证」
 * 这种场景也能自洽 —— 路径基准始终来自文件里写明的内容，而不是靠猜测。
 *
 * 刻意不缓存：目录文件很小（几 KB），每次请求都读一遍可以让
 * 「改了目录但没重启服务」也立刻生效，避免出现「服务里还是旧清单」的困惑。
 */
export async function loadArchiveCatalog({ workspaceRoot, catalogPath, logger = console }) {
  const file = catalogPath ?? join(workspaceRoot, '.tools', 'photo', 'archive-catalog.json')
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    const sources = Array.isArray(parsed?.sources) ? parsed.sources : []
    const allowedRoots = Array.isArray(parsed?.allowedRoots) && parsed.allowedRoots.length > 0
      ? parsed.allowedRoots.map((entry) => String(entry))
      : DEFAULT_ALLOWED_ROOTS
    const root = typeof parsed?.root === 'string' && parsed.root.trim().length > 0 ? parsed.root.trim() : '.'
    return { ok: true, catalogPath: file, allowedRoots, root, sources }
  } catch (cause) {
    // 目录缺失不是致命错误：服务照常识别，只是恢复入口没有条目。
    logger?.warn?.(`归档目录不可用（恢复入口将为空）：${cause instanceof Error ? cause.message : String(cause)}`)
    return {
      ok: false,
      catalogPath: file,
      allowedRoots: DEFAULT_ALLOWED_ROOTS,
      root: '.',
      sources: [],
      error: String(cause?.message ?? cause),
    }
  }
}

/** 目录条目的**对外形状**（不含字节，也不含任何本机绝对路径）。 */
export function publicCatalogEntry(entry) {
  return {
    catalogKey: String(entry.catalogKey ?? ''),
    title: String(entry.title ?? ''),
    description: entry.description ?? null,
    archiveRelPath: String(entry.archiveRelPath ?? ''),
    sha256: entry.sha256 ?? null,
    byteLength: typeof entry.byteLength === 'number' ? entry.byteLength : null,
    width: entry.width ?? null,
    height: entry.height ?? null,
    layout: entry.layout ?? null,
    capturedAt: entry.capturedAt ?? null,
    provenance: entry.provenance ?? null,
    knownFacts: Array.isArray(entry.knownFacts) ? entry.knownFacts.map(String) : [],
    absentFacts: Array.isArray(entry.absentFacts) ? entry.absentFacts.map(String) : [],
  }
}

/**
 * 由允许的根推出「相对路径的解析基准」（第一个允许根的父目录）。
 *
 * 保留给调用方做兜底推导；正常路径走目录文件里显式写明的 `root`。
 */
export function resolveArchiveBaseDir(allowedRoots = DEFAULT_ALLOWED_ROOTS) {
  const first = String(allowedRoots[0] ?? '').trim()
  if (!first) return '.'
  const normalized = normalize(first).split(sep).filter((part) => part.length > 0)
  // 丢掉最后一段（允许根本身），剩下的就是工作区基准。
  const parentParts = normalized.slice(0, -1)
  return parentParts.length > 0 ? parentParts.join(sep) : '.'
}

/**
 * 按 `catalogKey` 读一份归档文件。
 *
 * 相对路径的基准来自目录文件里的 `root`（缺省 = 工作区），因此显式传
 * `workspaceRoot` 就够了；`baseDir` 只是给调用方（测试）一个更直接的覆盖手段。
 *
 * 返回 `{ entry, bytes, sha256, contentType }`；任何校验失败都抛 `ArchiveError`，
 * 由服务层翻成 HTTP 状态码。**不做任何写操作**。
 */
export async function readArchiveSource({ workspaceRoot, catalogPath, catalogKey, baseDir, logger = console }) {
  const key = String(catalogKey ?? '').trim()
  if (!key) throw new ArchiveError('BAD_REQUEST', '缺少 catalogKey。')
  const catalog = await loadArchiveCatalog({ workspaceRoot, catalogPath, logger })
  const entry = catalog.sources.find((item) => String(item.catalogKey ?? '') === key)
  if (!entry) throw new ArchiveError('NOT_FOUND', '这个来源不在归档目录里。')
  // 兼容两种写法：调用方直接给 baseDir，或者由目录文件的 root 指定（默认相对工作区）。
  const root = baseDir ?? (isAbsolute(catalog.root) ? catalog.root : resolve(workspaceRoot, catalog.root))
  const absolute = resolveArchivePath(root, entry.archiveRelPath, catalog.allowedRoots)
  // 符号链接 / junction 防护：字符串包含判断挡不住链接，必须比对**真实路径**。
  const realTarget = await assertRealPathInside({
    workspaceRoot: root,
    absolutePath: absolute,
    allowedRoots: catalog.allowedRoots,
  })
  let info
  try {
    info = await stat(realTarget)
  } catch {
    throw new ArchiveError('NOT_FOUND', '这份归档文件在电脑上找不到了。')
  }
  if (!info.isFile()) throw new ArchiveError('NOT_FOUND', '这个归档路径不是文件。')
  if (info.size > ARCHIVE_MAX_BYTES) {
    throw new ArchiveError('TOO_LARGE', `归档文件 ${(info.size / 1024 / 1024).toFixed(1)}MB，超过上限。`)
  }
  const bytes = await readFile(realTarget)
  const digest = sha256Hex(bytes)
  if (entry.sha256 && String(entry.sha256).toLowerCase() !== digest) {
    // 文件被改过 / 版本不对：明确报错，绝不发一份「不知道是什么」的图。
    throw new ArchiveError('CHECKSUM_MISMATCH', '这份归档文件与目录里登记的校验和不一致，已拒绝发送。')
  }
  if (typeof entry.byteLength === 'number' && entry.byteLength !== bytes.length) {
    throw new ArchiveError('CHECKSUM_MISMATCH', '这份归档文件的字节数与目录登记不一致，已拒绝发送。')
  }
  return {
    entry: publicCatalogEntry({ ...entry, sha256: entry.sha256 ?? digest }),
    bytes,
    sha256: digest,
    contentType: 'image/png',
  }
}
