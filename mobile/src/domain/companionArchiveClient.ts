/**
 * 从伴侣服务读取**历史归档来源的元数据**（`GET /v1/archive/sources`）。
 *
 * 为什么要走这个接口、而不是把「哪张图上有体育」这类事实永久写在 App 常量里
 * （复核对明确要求）：
 * - App 里不该固化某个人的课表事实 —— 那是**数据**，不是产品默认值；
 * - 元数据由电脑上那份显式目录文件提供（项目自己保留的截图），手机只做展示；
 * - 目录改了不需要重新发版，也不会把个人来源信息打进 JS bundle。
 *
 * 仍然保留本地目录做**离线兜底**：没配地址 / 电脑没开机时，界面至少能列出
 * 「有哪些历史截图、各自多大」，只是不能取回字节。
 *
 * 边界：只读、只 GET 一个固定路径、超时可控；返回内容逐项做形状校验，
 * 任何一项不合格就整条丢掉（不把脏数据展示给用户）。
 */

import { normalizeEndpoint } from './photoOcrClient'

export interface CompanionArchiveSource {
  catalogKey: string
  title: string
  description: string | null
  archiveRelPath: string
  sha256: string | null
  byteLength: number | null
  width: number | null
  height: number | null
  knownFacts: string[]
  absentFacts: string[]
}

export interface CompanionArchiveFetchResult {
  ok: boolean
  sources: CompanionArchiveSource[]
  /** 失败原因（可读中文）；成功时为 `null`。 */
  error: string | null
}

const SHA256_RE = /^[0-9a-f]{64}$/

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

/**
 * 一条远端条目的形状校验。
 *
 * 必须有的：稳定的 `catalogKey`（取回文件时用它）、`title`（界面标题）、
 * `archiveRelPath`（说明来源，界面只在需要时展示）。
 * `sha256` 要么是合法的 64 位十六进制，要么为 `null`（那就只能靠服务端校验）。
 */
export function normalizeRemoteSource(raw: unknown): CompanionArchiveSource | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const catalogKey = String(entry.catalogKey ?? '').trim()
  const title = String(entry.title ?? '').trim()
  const archiveRelPath = String(entry.archiveRelPath ?? '').trim()
  if (!catalogKey || !title || !archiveRelPath) return null
  const sha256Raw = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : ''
  const sha256 = SHA256_RE.test(sha256Raw) ? sha256Raw : null
  return {
    catalogKey,
    title,
    description: typeof entry.description === 'string' ? entry.description : null,
    archiveRelPath,
    sha256,
    byteLength: asNumber(entry.byteLength),
    width: asNumber(entry.width),
    height: asNumber(entry.height),
    knownFacts: asStringArray(entry.knownFacts),
    absentFacts: asStringArray(entry.absentFacts),
  }
}

/**
 * 拉取归档来源清单。
 *
 * 刻意**不抛异常**：界面调用它只是为了拿到更好的元数据，失败时退回本地目录，
 * 因此这里返回结构化结果而不是让调用方去 catch。
 */
export async function fetchCompanionArchiveSources(
  endpoint: string | null | undefined,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CompanionArchiveFetchResult> {
  const normalized = normalizeEndpoint(endpoint ?? '')
  if (!normalized) {
    return { ok: false, sources: [], error: '还没有可用的电脑地址。' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6_000)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${normalized}/v1/archive/sources`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      return { ok: false, sources: [], error: `电脑上的服务返回 ${response.status}。` }
    }
    const payload = (await response.json()) as { ok?: boolean; sources?: unknown[] }
    const list = Array.isArray(payload?.sources) ? payload.sources : []
    const sources = list.map(normalizeRemoteSource).filter((entry): entry is CompanionArchiveSource => entry !== null)
    return { ok: true, sources, error: null }
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === 'AbortError'
        ? '读取归档目录超时。'
        : `连不上电脑上的归档目录：${cause instanceof Error ? cause.message : String(cause)}`
    return { ok: false, sources: [], error: message }
  } finally {
    clearTimeout(timer)
  }
}
