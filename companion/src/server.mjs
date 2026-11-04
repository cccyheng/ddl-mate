/**
 * DDL Mate 本地 OCR 伴侣服务（`companion/`）。
 *
 * 它只做一件事：**在这台电脑上**把手机传来的课表截图用本地 OCR 识别成
 * 结构化候选，返回给手机。图片不出局域网、不上传任何第三方服务。
 *
 * 安全与边界（与任务书逐条对应）：
 * - 默认只监听 `127.0.0.1`；只有显式加 `--lan` 才绑到局域网，并在启动日志里说清楚；
 * - 只接受 `POST /v1/ocr/timetable`：请求体必须是 JSON + base64 图片，**有严格上限**；
 * - **不提供任何文件服务**：没有静态目录、不接受路径参数、不接受 URL 参数，
 *   因此不存在「读服务器上任意文件」或「让服务器去访问任意网址」的接口；
 * - Tesseract 与可选中文精读模型只从本地加载，运行时不联网下载；
 * - 并发上限 + 单请求超时 + 请求体上限，避免被一张大图或并发拖死；
 * - 日志里不打印图片内容、不打印 base64、不打印任何凭据。
 *
 * 端口：默认 **8082**（后端 8080 与 Metro 8081 保持不动），可用 `--port` 覆盖。
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { IMAGE_LIMITS, ImageError, decodeImage } from './imageCodec.mjs'
import { OcrEngine } from './ocrEngine.mjs'
import { createDiagnostics } from './diagnostics.mjs'
import { ArchiveError, loadArchiveCatalog, publicCatalogEntry, readArchiveSource } from './archive.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')

export const DEFAULT_PORT = 8082
export const MAX_CONCURRENT = 2
/** 单次识别超时（毫秒）。周视图照片在手机上通常是 20–60 秒。 */
export const REQUEST_TIMEOUT_MS = 180_000
/** 请求体上限：base64 比原图大约 4/3，这里给足原图上限的余量。 */
export const MAX_BODY_BYTES = Math.ceil((IMAGE_LIMITS.maxBytes * 4) / 3) + 1024
export const SERVICE_VERSION = '0.4.0'

/** 所有会进入 OCR 引擎的路由（超时 / 请求号 / 并发 / 请求体上限对它们**共同**生效）。 */
export const OCR_ROUTES = new Set(['/v1/ocr/timetable', '/v1/ocr/notice', '/v1/ocr/exams'])

/** 本机的局域网 IPv4 地址（只用于启动日志里提示该填什么）。 */
export function lanAddresses() {
  const result = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address)
    }
  }
  return result
}

function json(res, status, payload, requestId = null) {
  const body = JSON.stringify(payload)
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  }
  // 请求号同时放在响应头里：真机上可以直接对着这一号去找本机诊断文件。
  if (requestId) headers['x-ocr-request-id'] = String(requestId)
  res.writeHead(status, headers)
  res.end(body)
}

/**
 * 直接写出一份归档图片的**字节**（不是 JSON、不经过 base64）。
 *
 * 只允许目录里登记过、且校验和一致的那几份文件走到这里；响应里
 * 带上 SHA256 与来源 key，手机可以再校验一次。
 */
function binary(res, status, { entry, bytes, sha256, contentType }) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-archive-key': String(entry?.catalogKey ?? ''),
    'x-archive-sha256': sha256,
  })
  res.end(bytes)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ImageError('BODY_TOO_LARGE', `请求体超过上限（${limit} 字节）。`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 创建服务实例（测试可以直接调用 `handleRequest` 而不监听端口）。
 *
 * @param {{engine?: OcrEngine, logger?: object, diagnostics?: object}} options
 *   `diagnostics` 只在启动时显式给出目录（`--diagnostics-dir`）才存在；
 *   不给时整个服务不写任何诊断文件，行为与以前完全一致。
 */
export function createOcrService(options = {}) {
  const engine = options.engine ?? new OcrEngine()
  const log = options.logger ?? console
  const diagnostics = options.diagnostics?.enabled ? options.diagnostics : { enabled: false, available: false }
  let active = 0
  let total = 0
  let rejected = 0

  /** 诊断是否真的落盘可用（目录建不出来 / 写失败时是 false）。 */
  const diagnosticsAvailable = () => diagnostics.enabled === true && diagnostics.available !== false

  /**
   * 两条 OCR 路由共用的请求体校验与解码。
   *
   * 行为与之前的 `handleOcr` 完全一致（同样的字段校验、base64 粗筛、字节上限、
   * 魔数解码），只是抽出来让通知路由复用**同一套**边界，而不是各写一份。
   */
  function decodeImageBody(body) {
    if (!body || typeof body !== 'object') {
      throw new ImageError('BAD_REQUEST', '请求体必须是 JSON 对象。')
    }
    const base64 = body.imageBase64
    if (typeof base64 !== 'string' || base64.length === 0) {
      throw new ImageError('BAD_REQUEST', '缺少 imageBase64 字段（base64 编码的 PNG / JPEG）。')
    }
    // 先按 base64 长度粗筛，避免把超大字符串解码进内存。
    if (base64.length > MAX_BODY_BYTES) {
      throw new ImageError('IMAGE_TOO_LARGE', '图片太大，请在手机上先缩小或裁剪后再试。')
    }
    const normalized = base64.replace(/^data:image\/[a-zA-Z+]+;base64,/, '')
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(normalized)) {
      throw new ImageError('BAD_REQUEST', 'imageBase64 不是合法的 base64 数据。')
    }
    const bytes = Buffer.from(normalized, 'base64')
    if (bytes.length === 0) {
      throw new ImageError('BAD_REQUEST', '图片数据为空。')
    }
    if (bytes.length > IMAGE_LIMITS.maxBytes) {
      throw new ImageError(
        'IMAGE_TOO_LARGE',
        `图片 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过上限 ${(IMAGE_LIMITS.maxBytes / 1024 / 1024).toFixed(0)}MB。`,
      )
    }
    return { bytes, decoded: decodeImage(bytes) }
  }

  async function handleOcr(body, { signal, requestId }) {
    const { bytes, decoded } = decodeImageBody(body)
    const isCancelled = () => signal?.aborted === true
    let result
    try {
      result = await engine.recognizeTimetable(decoded, { isCancelled })
    } catch (cause) {
      // 诊断模式下把失败也落盘：真机上最需要看的恰恰是失败那一次。
      // `capture` 内部已经吞掉所有写盘错误，这里不会再抛出新的异常。
      diagnostics.capture?.({
        requestId,
        imageBytes: bytes,
        image: { width: decoded.width, height: decoded.height, format: decoded.format, bytes: bytes.length },
        response: { ok: false, code: cause?.code ?? 'OCR_FAILED', message: cause?.message ?? String(cause) },
        extra: {
          error: {
            name: cause?.name ?? 'Error',
            code: cause?.code ?? null,
            message: cause?.message ?? String(cause),
            layout: cause?.layout ?? null,
            headerOnly: cause?.headerOnly ?? null,
            candidateCount: cause?.candidateCount ?? null,
          },
        },
      })
      throw cause
    }

    const payload = {
      ok: true,
      serviceVersion: SERVICE_VERSION,
      requestId: requestId ?? null,
      diagnosticsMode: diagnosticsAvailable(),
      image: { width: decoded.width, height: decoded.height, format: decoded.format, bytes: bytes.length },
      layout: result.layout,
      week: result.week ?? null,
      candidates: result.candidates ?? [],
      warnings: result.warnings ?? [],
      diagnostics: result.diagnostics ?? {},
      rawText: result.rawText ?? '',
      ocrCalls: result.ocrCalls ?? null,
      ms: result.ms ?? null,
      cancelled: result.cancelled === true,
    }

    // 捕获失败（写盘错误）会被 `capture` 内部吞掉并记日志；这里只把"是否真的落盘成功"
    // 如实反映到响应上，绝不因为诊断问题改变识别结果本身。
    const captured = diagnostics.capture?.({
      requestId,
      imageBytes: bytes,
      image: payload.image,
      response: payload,
      extra: { geometryReason: result.diagnostics?.reason ?? null },
    })
    if (captured && captured.available === false) payload.diagnosticsMode = false
    return payload
  }

  /**
   * `POST /v1/ocr/notice`：一张通知截图 → 按行保留的纯文字。
   *
   * 这是**加性**接口：没有课表解析、没有「只读到表头」拒绝逻辑。
   * 读到空文字也是成功（`ok: true, rawText: ''`），客户端据此显示「没有识别到文字」，
   * 绝不伪造候选。请求体校验 / 并发 / 超时 / 取消与课表路由完全共用。
   */
  async function handleNotice(body, { signal, requestId, exams = false }) {
    const { bytes, decoded } = decodeImageBody(body)
    const isCancelled = () => signal?.aborted === true
    // 客户端在请求体刚解析完时就已经断开 / 超时：根本不要启动引擎。
    if (isCancelled()) {
      throw new ImageError('CANCELLED', '这次识别在完成前被取消（客户端断开或超时）。')
    }
    let result
    try {
      result = exams ? await engine.recognizeExams(decoded, { isCancelled }) : await engine.recognizeNotice(decoded, { isCancelled })
    } catch (cause) {
      diagnostics.capture?.({
        requestId,
        imageBytes: bytes,
        image: { width: decoded.width, height: decoded.height, format: decoded.format, bytes: bytes.length },
        response: { ok: false, code: cause?.code ?? 'OCR_FAILED', message: cause?.message ?? String(cause) },
        extra: { route: exams ? 'exams' : 'notice', error: { name: cause?.name ?? 'Error', code: cause?.code ?? null } },
      })
      throw cause
    }

    // 引擎返回之后**独立再看一次**取消信号：不依赖引擎自己是否遵守 `isCancelled`。
    // 迟到的引擎结果绝不能变成 HTTP 200 的成功响应。
    if (isCancelled()) {
      throw new ImageError('CANCELLED', '这次识别在完成前被取消（客户端断开或超时）。')
    }
    // 引擎契约：rawText 必须是字符串。**不对非法结果做 `String()` 强转**，
    // 否则上游 bug 会变成一份看起来成功的空/伪造文字。
    if (typeof result?.rawText !== 'string') {
      const cause = new Error('通知识别引擎返回的 rawText 不是字符串。')
      cause.code = 'OCR_FAILED'
      throw cause
    }
    const rawText = result.rawText
    const payload = {
      ok: true,
      serviceVersion: SERVICE_VERSION,
      requestId: requestId ?? null,
      diagnosticsMode: diagnosticsAvailable(),
      image: { width: decoded.width, height: decoded.height, format: decoded.format, bytes: bytes.length },
      rawText,
      empty: result.empty === true || rawText.length === 0,
      warnings: Array.isArray(result.warnings)
        ? result.warnings.filter((warning) => typeof warning === 'string')
        : [],
      ms: result.ms ?? null,
      ocrCalls: result.ocrCalls ?? null,
      cancelled: result.cancelled === true,
    }
    // 被取消 / 超时的请求绝不返回「成功」：客户端要能把它和「确实没读到字」区分开。
    // 容量释放仍然发生在 finally（引擎工作真的结束之后）。
    if (payload.cancelled) {
      throw new ImageError('CANCELLED', '这次识别在完成前被取消（客户端断开或超时）。')
    }
    // 诊断目录是用户**显式开启**的本机目录（与课表路由同一套本地策略）；
    // 普通日志永远不打印通知正文。
    const captured = diagnostics.capture?.({
      requestId,
      imageBytes: bytes,
      image: payload.image,
      response: payload,
      extra: { route: exams ? 'exams' : 'notice' },
    })
    if (captured && captured.available === false) payload.diagnosticsMode = false
    return payload
  }

  /**
   * 处理一次请求；返回 `{ status, payload }`，由调用方决定怎么写出。
   *
   * `handleRequest` 只返回 JSON；二进制归档走 `readArchiveBytes`（见下）。
   */
  async function handleRequest({ method, url, body, signal, headers = {}, requestId = null, baseDir = null }) {
    const path = (url || '/').split('?')[0]
    if (method === 'GET' && path === '/v1/health') {
      return {
        status: 200,
        payload: {
          ok: true,
          service: 'ddl-mate-ocr-companion',
          serviceVersion: SERVICE_VERSION,
          localChineseDetails: Boolean(engine.neuralConfig),
          /** 本机引擎是否提供「通知截图 → 纯文字」能力（旧版伴侣服务为 `undefined`）。 */
          noticeOcr: typeof engine.recognizeNotice === 'function',
          examOcr: typeof engine.recognizeExams === 'function',
          /** 只用于用户确认「连上的是同一台电脑」，不含任何凭据。 */
          pairCode: process.env.DDLMATE_OCR_PAIR_CODE ?? null,
          busy: active > 0,
          processed: total,
          /**
           * 诊断模式是否**可用**（开启且磁盘真的写得进去）。
           * 不暴露目录，只暴露这个布尔值；GET 健康检查既不写文件也不消耗任何诊断名额。
           */
          diagnosticsMode: diagnosticsAvailable(),
          langPath: join(workspaceRoot, 'frontend', 'public', 'tesseract', 'lang'),
        },
      }
    }

    if (OCR_ROUTES.has(path)) {
      const isNotice = path === '/v1/ocr/notice' || path === '/v1/ocr/exams'
      if (method !== 'POST') {
        return { status: 405, payload: { ok: false, code: 'METHOD_NOT_ALLOWED', message: '这个接口只支持 POST。' } }
      }
      const contentType = String(headers['content-type'] ?? '')
      if (!contentType.includes('application/json')) {
        return {
          status: 415,
          payload: { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '请求体必须是 application/json。' },
        }
      }
      // 并发上限两条 OCR 路由**共用**：通知和课表用的是同一个本机 Tesseract worker。
      if (active >= MAX_CONCURRENT) {
        rejected += 1
        return {
          status: 429,
          payload: { ok: false, code: 'BUSY', message: '这台电脑正在识别上一张图片，请稍后重试。' },
        }
      }
      active += 1
      const startedAt = Date.now()
      try {
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8'))
        } catch {
          return { status: 400, payload: { ok: false, code: 'BAD_JSON', message: '请求体不是合法 JSON。' } }
        }
        const payload = isNotice
          ? await handleNotice(parsed, { signal, requestId, exams: path === '/v1/ocr/exams' })
          : await handleOcr(parsed, { signal, requestId })
        total += 1
        // 日志只说尺寸 / 条数 / 耗时，**绝不打印通知正文**（rawText）。
        if (isNotice) {
          log.info(
            `[notice] ${payload.requestId ?? '-'} ${payload.image.width}x${payload.image.height} ${payload.image.format} ` +
              `${(payload.image.bytes / 1024).toFixed(0)}KB → ${payload.rawText.length} 字 ` +
              `(${Date.now() - startedAt}ms)`,
          )
        } else {
          log.info(
            `[ocr] ${payload.requestId ?? '-'} ${payload.image.width}x${payload.image.height} ${payload.image.format} ` +
              `${(payload.image.bytes / 1024).toFixed(0)}KB → ${payload.candidates.length} 条候选 ` +
              `(${payload.layout}, ${Date.now() - startedAt}ms)`,
          )
        }
        return { status: 200, payload }
      } catch (cause) {
        // 取消 / 超时：不能返回 200 的「成功空结果」；499 是 nginx 约定的客户端关闭状态码。
        // 只对通知路由生效，课表路由的行为保持原样。
        if (isNotice && cause?.code === 'CANCELLED') {
          log.warn(`[notice] ${requestId ?? '-'} 取消：${cause.message}`)
          return {
            status: 499,
            payload: { ok: false, requestId, code: 'CANCELLED', message: '这次识别在完成前被取消（客户端断开或超时）。' },
          }
        }
        if (cause instanceof ImageError) {
          log.warn(`[ocr] ${requestId ?? '-'} 拒绝：${cause.code} ${cause.message}`)
          return { status: cause.code === 'IMAGE_TOO_LARGE' ? 413 : 400, payload: { ok: false, requestId, code: cause.code, message: cause.message } }
        }
        // 只读到表头/时间栏：明确失败，绝不返回"看起来成功"的空结果（仅课表路由会走到）。
        if (cause?.code === 'STRUCTURE_NOT_FOUND') {
          log.warn(`[ocr] ${requestId ?? '-'} 只读到表头/时间栏：${cause.message}`)
          return {
            status: 422,
            payload: {
              ok: false,
              requestId,
              code: 'STRUCTURE_NOT_FOUND',
              message: cause.message,
              layout: cause.layout ?? null,
              headerOnly: cause.headerOnly ?? null,
              candidateCount: cause.candidateCount ?? null,
            },
          }
        }
        log.error(`[ocr] ${requestId ?? '-'} 识别失败：${cause instanceof Error ? cause.message : String(cause)}`)
        return { status: 500, payload: { ok: false, requestId, code: 'OCR_FAILED', message: '识别失败，请重试或换一张更清晰的截图。' } }
      } finally {
        // 只有引擎真的跑完（或抛错）才释放容量：abort/timeout 不会提前把名额还回去。
        active -= 1
      }
    }

    if (path === '/v1/archive/sources') {
      if (method !== 'GET') {
        return { status: 405, payload: { ok: false, code: 'METHOD_NOT_ALLOWED', message: '这个接口只支持 GET。' } }
      }
      const catalog = await loadArchiveCatalog({ workspaceRoot, catalogPath: options.archiveCatalogPath, logger: log })
      return {
        status: 200,
        payload: {
          ok: true,
          available: catalog.ok,
          /** 只暴露目录条目，不暴露工作区绝对路径。 */
          sources: catalog.sources.map(publicCatalogEntry),
          note: '这里只列出项目自己保留的截图；不含图片字节，也不做任何目录扫描。',
        },
      }
    }

    if (path.startsWith('/v1/archive/source/')) {
      if (method !== 'GET') {
        return { status: 405, payload: { ok: false, code: 'METHOD_NOT_ALLOWED', message: '这个接口只支持 GET。' } }
      }
      const key = decodeURIComponent(path.slice('/v1/archive/source/'.length))
      try {
        const source = await readArchiveSource({
          workspaceRoot,
          catalogPath: options.archiveCatalogPath,
          // 相对路径的基准：正常就是工作区，目录被换到别处时由调用方给出（见 archiveBaseDir）。
          baseDir: baseDir ?? undefined,
          catalogKey: key,
          logger: log,
        })
        // 二进制由调用方直接写出（`readArchiveBytes`），这里只回报元数据。
        return { status: 200, payload: null, binary: source }
      } catch (cause) {
        if (cause instanceof ArchiveError) {
          const status =
            cause.code === 'NOT_FOUND' ? 404 : cause.code === 'FORBIDDEN' ? 403 : cause.code === 'TOO_LARGE' ? 413 : 409
          log.warn(`[archive] 拒绝 ${key}：${cause.code} ${cause.message}`)
          return { status, payload: { ok: false, code: cause.code, message: cause.message } }
        }
        log.error(`[archive] 读取 ${key} 失败：${cause instanceof Error ? cause.message : String(cause)}`)
        return { status: 500, payload: { ok: false, code: 'ARCHIVE_FAILED', message: '读取归档文件失败。' } }
      }
    }

    return { status: 404, payload: { ok: false, code: 'NOT_FOUND', message: '没有这个接口。' } }
  }

  return {
    engine,
    handleRequest,
    diagnostics,
    stats: () => ({ active, total, rejected }),
    close: () => engine.terminate(),
  }
}

/**
 * 归档目录文件所在的「路径基准」。
 *
 * 目录里的 `archiveRelPath` 一律相对这个基准写，例如基准下的
 * `.tools/photo/known.png`。默认目录就在工作区里，所以基准 = 工作区；
 * 如果目录文件被换到工作区之外（把整套 `.tools/photo` 复制到临时目录做验证），
 * 基准 = 那份文件所在目录的父目录（即它上面那层 `.tools` 的父目录）。
 *
 * 它只决定**相对路径挂在哪**；到底能读哪些文件仍然由目录条目 + `allowedRoots` 校验。
 */
export function archiveBaseDirFor(workspaceRoot, catalogPath) {
  if (!catalogPath) return workspaceRoot
  const absoluteCatalog = isAbsolute(catalogPath) ? catalogPath : join(workspaceRoot, catalogPath)
  const insideWorkspace = relative(workspaceRoot, absoluteCatalog)
  if (!insideWorkspace.startsWith('..') && !isAbsolute(insideWorkspace)) {
    // 就在工作区里（默认位置）→ 基准就是工作区。
    return workspaceRoot
  }
  // 工作区之外：目录形如 <base>/.tools/photo/archive-catalog.json → 基准是 `<base>`。
  return dirname(dirname(dirname(absoluteCatalog)))
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { lan: false, port: DEFAULT_PORT, host: null, diagnosticsDir: null, archiveCatalogPath: null }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--lan') args.lan = true
    else if (token === '--localhost') args.lan = false
    else if (token === '--port') {
      const value = Number(argv[i + 1])
      // 0 是合法的「让系统随便挑一个空闲端口」，只给测试脚本用。
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`--port 需要 0–65535 的整数，收到「${argv[i + 1]}」。`)
      }
      args.port = value
      i += 1
    } else if (token === '--host') {
      args.host = String(argv[i + 1] ?? '')
      if (!args.host) throw new Error('--host 需要一个地址。')
      i += 1
    } else if (token === '--diagnostics-dir') {
      // 只有启动者显式给出目录才开启本地诊断捕获；不给就是完全关闭。
      const value = String(argv[i + 1] ?? '')
      if (!value) throw new Error('--diagnostics-dir 需要一个目录路径（诊断文件只会写到这里）。')
      args.diagnosticsDir = value
      i += 1
    } else if (token === '--archive-catalog') {
      // 可选：换一份归档目录文件（默认 .tools/photo/archive-catalog.json）。
      const value = String(argv[i + 1] ?? '')
      if (!value) throw new Error('--archive-catalog 需要一个 JSON 文件路径。')
      args.archiveCatalogPath = value
      i += 1
    } else if (token === '--diagnostics-limit') {
      // 兼容旧参数：现在只保留"最近一次"，没有次数上限这个概念了。
      throw new Error('--diagnostics-limit 已不再需要：诊断只保留最近一次（latest-* 三个固定文件）。')
    } else if (token === '--help' || token === '-h') {
      args.help = true
    } else {
      throw new Error(
        `无法识别的参数「${token}」（支持 --lan / --localhost / --port / --host / --diagnostics-dir / --archive-catalog）。`,
      )
    }
  }
  return args
}

const HELP = `DDL Mate 本地 OCR 伴侣服务

用法：
  node src/server.mjs                 只监听 127.0.0.1:${DEFAULT_PORT}（模拟器 / 本机）
  node src/server.mjs --lan           监听 0.0.0.0:${DEFAULT_PORT}，供同一 Wi-Fi 的手机使用
  node src/server.mjs --port 8083     换端口

本地诊断（默认关闭；排查真机失败时才开，文件只写在本机这个目录里）：
  node src/server.mjs --lan --diagnostics-dir .tools/ocr-diagnostics
                                      每次识别都覆盖更新最近一次的原图 + 结果：
                                        latest-image.bin     手机实际发来的图片字节（原样）
                                        latest-response.json 那一次的完整识别响应
                                        latest-summary.json  请求号 / 尺寸 / 版面 / 候选名（最后写）
                                      健康检查等其它请求不写文件；文件名固定，不会越积越多。

接口：
  GET  /v1/health             健康检查（手机用来确认「连上的是这台电脑」）
  POST /v1/ocr/timetable      { imageBase64 } → 课表候选
  POST /v1/ocr/notice         { imageBase64 } → 通知纯文字（按行保留；不解析课表）
  GET  /v1/archive/sources    列出项目自己保留的历史截图来源（只有元数据，没有字节）
  GET  /v1/archive/source/:key 取回**其中一份**登记过的原图（逐字节校验 SHA256）

历史归档（手机恢复旧截图用；默认读 .tools/photo/archive-catalog.json）：
  node src/server.mjs --lan --archive-catalog .tools/photo/archive-catalog.json
                                        只允许读目录里列出的相对路径，且必须落在
                                        allowedRoots（默认 .tools/photo）之内；
                                        不做目录扫描、不接受绝对路径、不写任何文件。

不会做的事：不提供通用文件服务、不访问任意网址、不上传图片到第三方。
`

export async function startServer(argv = process.argv.slice(2), logger = console, options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    logger.info(HELP)
    return null
  }
  // 可选注入只给测试用：默认引擎与默认 180s 超时完全不变。
  const requestTimeoutMs =
    typeof options.requestTimeoutMs === 'number' &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : REQUEST_TIMEOUT_MS
  const host = args.host ?? (args.lan ? '0.0.0.0' : '127.0.0.1')
  const diagnostics = createDiagnostics({
    dir: args.diagnosticsDir,
    logger,
  })
  const service = createOcrService({
    logger,
    diagnostics,
    archiveCatalogPath: args.archiveCatalogPath,
    engine: options.engine,
  })

  const server = http.createServer((req, res) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    let settled = false
    // 只有 OCR 请求需要请求号：GET 健康检查既不写诊断、也不占用任何序号。
    // 通知路由与课表路由**一样**享受超时 / 请求体上限 / 取消 / 请求号。
    // 课表行为保持原样（只有开启诊断才生成请求号）；通知则**总是**给一个只用于
    // 手机界面显示 / 对日志的关联号，不写任何文件、不含图片或正文。
    const ocrPath = (req.url || '').split('?')[0]
    const isOcrRequest = req.method === 'POST' && OCR_ROUTES.has(ocrPath)
    const isNoticeRequest = req.method === 'POST' && (ocrPath === '/v1/ocr/notice' || ocrPath === '/v1/ocr/exams')
    const requestId = isOcrRequest
      ? diagnostics.enabled
        ? diagnostics.nextRequestId()
        : isNoticeRequest
          ? `${ocrPath.endsWith('/exams') ? 'exams' : 'notice'}-${randomUUID()}`
          : null
      : null

    const done = (result) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      // 客户端可能已经断开（用户取消、切后台、超时）：这时绝不能再去写响应，
      // 否则会抛 ERR_STREAM_WRITE_AFTER_END / ERR_STREAM_DESTROYED。
      if (res.writableEnded || res.destroyed || !res.socket || res.socket.destroyed) return
      // 归档请求返回的是图片字节，不是 JSON。
      if (result?.binary) {
        binary(res, result.status, result.binary)
        return
      }
      json(res, result.status, result.payload, requestId)
    }

    // 连接断开 / 请求出错：取消这次识别，并且什么都不写。
    const abort = () => {
      controller.abort()
      clearTimeout(timer)
    }
    req.on('aborted', abort)
    req.on('error', abort)
    res.on('close', () => {
      if (!settled) abort()
    })

    if (req.method === 'GET' || req.method === 'HEAD') {
      void service
        .handleRequest({
          method: req.method,
          url: req.url,
          body: Buffer.alloc(0),
          headers: req.headers,
          requestId,
          // 归档入口要用它决定相对路径的解析基准（见 archiveBaseDir 的说明）。
          baseDir: archiveBaseDirFor(workspaceRoot, args.archiveCatalogPath),
        })
        .then(done)
        .catch(() => done({ status: 500, payload: { ok: false, code: 'INTERNAL', message: '服务内部错误。' } }))
      return
    }

    readBody(req, MAX_BODY_BYTES)
      .then((body) =>
        service.handleRequest({
          method: req.method,
          url: req.url,
          body,
          headers: req.headers,
          signal: controller.signal,
          requestId,
        }),
      )
      .then(done)
      .catch((cause) => {
        if (cause instanceof ImageError && cause.code === 'BODY_TOO_LARGE') {
          done({ status: 413, payload: { ok: false, requestId, code: cause.code, message: cause.message } })
          return
        }
        // 客户端已经断开时不再尝试写响应（连接没了，写也写不出去）。
        if (controller.signal.aborted) {
          clearTimeout(timer)
          return
        }
        done({ status: 500, payload: { ok: false, requestId, code: 'INTERNAL', message: '服务内部错误。' } })
      })
  })

  server.headersTimeout = 30_000
  server.requestTimeout = requestTimeoutMs + 30_000
  server.keepAliveTimeout = 5_000

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(args.port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addresses = lanAddresses()
  logger.info(`OCR 伴侣服务已启动：http://127.0.0.1:${args.port}（监听 ${host}:${args.port}）`)
  if (diagnostics.enabled) {
    if (diagnostics.available) {
      logger.info(
        `本地诊断已开启：每次识别都会覆盖更新最近一次的原图 + 结果（${diagnostics.dir}）；` +
          '文件名固定为 latest-*，健康检查不写文件，只写在本机这个目录里，不上传。',
      )
    } else {
      logger.warn('本地诊断目录不可用：识别照常工作，但这次不会落盘任何诊断文件。')
    }
  }
  if (args.lan) {
    if (addresses.length === 0) {
      logger.warn('没有检测到局域网 IPv4 地址：请确认这台电脑已经连上 Wi-Fi。')
    } else {
      for (const address of addresses) {
        logger.info(`手机端地址可以填：http://${address}:${args.port}`)
      }
    }
    logger.info('当前仅监听局域网（同一 Wi-Fi 才能访问）；没有开隧道、没有改防火墙。')
  } else {
    logger.info('当前只监听本机。要在手机上用，请重新用 --lan 启动。')
  }

  const close = async () => {
    // 先不再接受新连接，再让正在识别的请求跑完（或断开后自然结束）。
    const closed = new Promise((resolve) => server.close(resolve))
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
    await closed
    await service.close()
  }

  return { server, service, args, host, close }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirectRun) {
  startServer().catch((cause) => {
    console.error(`启动失败：${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  })
}
