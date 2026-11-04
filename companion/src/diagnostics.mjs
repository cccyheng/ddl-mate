/**
 * 本地诊断捕获（**默认关闭**，只有显式给出目录才启用）。
 *
 * 为什么需要它：用户真机上的失败无法在这台电脑上复现 —— 我们看不到手机实际发出去的字节。
 * 这个模式把「最近一次真机识别」的**输入与结果**落成几个有界的固定文件，供随后离线分析。
 *
 * 设计要点（与任务书、复核对齐）：
 * - **默认完全关闭**：不加 `--diagnostics-dir` 时一个文件都不写，正常使用零开销；
 * - **只保留"最近一次"**：固定文件名 `latest-image.bin` / `latest-response.json` /
 *   `latest-summary.json`，每次成功捕获**覆盖**上一次；不累积、不遍历、不删除别的文件。
 *   跨重启也是覆盖同样三个文件，所以永远不会因为"健康检查很多次"而把名额用光。
 * - **只有 POST /v1/ocr/timetable 会捕获**：`GET /v1/health` 不占用任何东西、不写文件；
 * - **请求号不可变**：`requestId` 只出现在 `latest-summary.json` 的字段里，不做文件名；
 * - **元数据最后写**：先写原图与响应，最后写 `latest-summary.json`（原子改名），
 *   于是"能看到 summary"就意味着这一组文件是完整的；
 * - **写盘失败绝不影响识别**：所有写入都包了 try/catch，失败只记一条日志，
 *   并把 `available` 置为 false；真实识别结果照常返回；
 * - 名字与内容里**不含 token / URL / 凭据**；目录必须由启动者显式提供，只写这一个目录。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 诊断文件里绝不出现这些键（token / 地址 / 凭据）。 */
const FORBIDDEN_KEY_RE = /token|secret|password|authorization|cookie|url|endpoint|paircode/i

/** 固定的诊断文件名（永远只有这三个，跨重启覆盖）。 */
export const DIAGNOSTICS_FILES = {
  image: 'latest-image.bin',
  response: 'latest-response.json',
  summary: 'latest-summary.json',
}

function atomicWrite(filePath, bufferOrText) {
  const tempPath = `${filePath}.tmp`
  writeFileSync(tempPath, bufferOrText)
  renameSync(tempPath, filePath)
}

/** 防御性清理：即使调用方误传，也不把凭据/地址写进诊断文件。 */
export function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY_RE.test(key)) continue
    out[key] = redact(item, depth + 1)
  }
  return out
}

/**
 * 创建一个有界的诊断写入器。
 *
 * @param {{dir?: string|null, logger?: object}} options
 */
export function createDiagnostics(options = {}) {
  if (!options.dir) {
    return {
      enabled: false,
      available: false,
      dir: null,
      nextRequestId: () => null,
      capture: () => ({ written: false, reason: 'disabled', available: false }),
    }
  }
  const log = options.logger ?? console
  const dir = resolve(String(options.dir))
  let available = true
  // 目录建不出来（权限 / 路径非法）时**不抛错**：识别必须继续可用。
  try {
    mkdirSync(dir, { recursive: true })
  } catch (cause) {
    available = false
    log.warn?.(`[ocr] 诊断目录不可用（识别不受影响）：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  let sequence = 0

  return {
    enabled: true,
    get available() {
      return available
    },
    dir,
    /** 给本次请求一个新的、不可变的请求号（时间 + 序号）。 */
    nextRequestId() {
      sequence += 1
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      return `req-${stamp}-${String(sequence).padStart(3, '0')}`
    },
    /**
     * 落一次捕获（覆盖上一次）。任何写盘错误都被吞掉并记日志，绝不冒泡到 OCR 流程。
     *
     * @param {{requestId?: string|null, imageBytes?: Buffer, image?: object, response?: object, extra?: object}} capture
     * @returns {{written: boolean, reason?: string}}
     */
    capture({ requestId, imageBytes, image, response, extra = {} }) {
      if (!available) return { written: false, reason: 'unavailable', available: false }
      try {
        const safeResponse = redact(response ?? {})
        const summary = {
          requestId: requestId ?? null,
          capturedAt: new Date().toISOString(),
          service: 'ddl-mate-ocr-companion',
          image: { ...(image ?? {}) },
          // 失败时响应里没有 layout：从错误对象上补回来，否则"那次失败"最关键的版面信息就丢了。
          layout: safeResponse.layout ?? extra.error?.layout ?? null,
          week: safeResponse.week ?? null,
          candidateCount: Array.isArray(safeResponse.candidates)
            ? safeResponse.candidates.length
            : (extra.error?.candidateCount ?? 0),
          candidateNames: Array.isArray(safeResponse.candidates)
            ? safeResponse.candidates.map((candidate) => candidate?.name ?? null)
            : [],
          warnings: safeResponse.warnings ?? [],
          diagnostics: safeResponse.diagnostics ?? {},
          headerOnly: extra.error?.headerOnly ?? safeResponse.headerOnly ?? null,
          ocrCalls: safeResponse.ocrCalls ?? null,
          ms: safeResponse.ms ?? null,
          error: extra.error ?? null,
        }
        if (Buffer.isBuffer(imageBytes) && imageBytes.length > 0) {
          atomicWrite(join(dir, DIAGNOSTICS_FILES.image), imageBytes)
        }
        atomicWrite(join(dir, DIAGNOSTICS_FILES.response), JSON.stringify(safeResponse, null, 2))
        // 元数据最后写：看到它就意味着这一组文件是完整的一组。
        atomicWrite(join(dir, DIAGNOSTICS_FILES.summary), JSON.stringify(summary, null, 2))
        log.info?.(
          `[ocr] 诊断已更新 ${join(dir, DIAGNOSTICS_FILES.summary)}（仅本地，${imageBytes?.length ?? 0} 字节原图）`,
        )
        return { written: true, available: true }
      } catch (cause) {
        available = false
        log.warn?.(
          `[ocr] 诊断写入失败（识别结果不受影响）：${cause instanceof Error ? cause.message : String(cause)}`,
        )
        return { written: false, reason: 'write-failed', available: false }
      }
    },
  }
}
