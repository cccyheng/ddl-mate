/**
 * 「用户提交的图片 → 软件里的持久截图」这条生命周期（**识别之前**就完成归档）。
 *
 * 为什么单独一层：`photoImportController` 是纯状态机，不该同时管文件系统、数据库和
 * 编码策略。这里把「先落盘、再登记、最后识别」这段顺序收成一个可直接单测的函数，
 * 控制器只负责在正确的时机调用它并把结果放进界面状态。
 *
 * 关键顺序（授权范围里点名要求）：
 * 1. **先把原图完整字节落盘**（`archiveImageBase64`，原子写、不缩小、不裁剪）；
 * 2. 再登记一次尝试（`screenshot_attempts`）—— 识别失败、用户取消、断网都留得下原图；
 * 3. 只有这两步都做完，才允许发起 OCR。
 *
 * 失败语义：
 * - 原图格式不是 PNG/JPEG（例如 HEIC）时**不落盘**，状态如实标成
 *   `ARCHIVE_FAILED` 并给出可读原因 —— 绝不把「软件里打不开的字节」当成归档成果；
 * - 任何一步失败都**不阻断**识别（识别用的是内存里的 base64），只影响「以后能不能回看」。
 */

import { readEncodedSize, sniffBase64Format } from './photoFiles'
import { archiveImageBase64, type ScreenshotFileDeps, type ScreenshotFileSystem } from './screenshotFiles'
import type { RecordAttemptInput, ScreenshotAttemptSource } from './screenshotLibraryRepository'

export interface ArchiveCaptureInput {
  /** 用户刚选中的图片 URI（可能是 `ph://` 或临时文件 URI）。 */
  uri: string
  source?: { width?: number | null; height?: number | null; mimeType?: string | null }
  /** 采集来源（相册 / 相机）。 */
  attemptSource: ScreenshotAttemptSource
  /** 采集时间（默认现在）。 */
  capturedAtMs?: number
}

export interface ScreenshotArchiveDeps extends ScreenshotFileDeps {
  /** 读原图字节；native 侧由 `expo-file-system/legacy` 提供。 */
  readSourceBase64?: (uri: string) => Promise<string>
  /** 把归档结果写进数据库（识别**之前**调用）。 */
  recordAttempt: (input: RecordAttemptInput) => Promise<{ attempt: { id: number } }>
}

export interface ScreenshotArchiveOk {
  ok: true
  attemptId: number
  /** 落盘后的本机 URI（关闭 App 再打开仍然有效）。 */
  archivedUri: string
  sha256: string
  byteLength: number
  format: 'png' | 'jpeg'
  /** 归档时复用了一个内容完全相同的已有文件。 */
  reusedExisting: boolean
  /** 原图字节就是最终归档字节（没有做任何转码）。 */
  preservedOriginal: boolean
}

export interface ScreenshotArchiveFailed {
  ok: false
  /** 已经登记的尝试 id（`ARCHIVE_FAILED`）；连登记都失败时为 `null`。 */
  attemptId: number | null
  message: string
}

export type ScreenshotArchiveOutcome = ScreenshotArchiveOk | ScreenshotArchiveFailed

/**
 * 把刚选中的图片先归档，再登记尝试。
 *
 * 刻意**不**抛异常：调用方（识别流程）必须在归档失败时照样能继续，
 * 只是把失败原因放进状态里提示用户。
 */
export async function archivePickedPhoto(
  input: ArchiveCaptureInput,
  deps: ScreenshotArchiveDeps,
): Promise<ScreenshotArchiveOutcome> {
  const capturedAtMs = input.capturedAtMs ?? Date.now()
  const capturedAt = new Date(capturedAtMs).toISOString()
  const base: Pick<RecordAttemptInput, 'source' | 'capturedAt' | 'originalUri'> = {
    source: input.attemptSource,
    capturedAt,
    originalUri: input.uri,
  }

  let base64: string
  try {
    if (!deps.readSourceBase64) throw new Error('这台设备没有可用的文件读取能力。')
    base64 = await deps.readSourceBase64(input.uri)
    if (!base64) throw new Error('没有读到图片内容。')
  } catch (cause) {
    const message = `没能读取这张图片的原始内容：${cause instanceof Error ? cause.message : String(cause)}`
    const attemptId = await tryRecordFailure(base, message, deps)
    return { ok: false, attemptId, message }
  }

  // 格式化判断只看**真正的字节**（魔数），不看扩展名或 MIME：
  // iOS 相册有时报 `image/heic`，取回来其实已经是 JPEG，反过来也有。
  const format = sniffBase64Format(base64)
  const measured = readEncodedSize(base64)
  const width = measured?.width ?? input.source?.width ?? null
  const height = measured?.height ?? input.source?.height ?? null
  if (!format) {
    const message =
      '这张图片不是 PNG / JPEG（可能是 iPhone 的 HEIC 实况图），软件里没法原样保存。' +
      '请在相册里把它导出成 JPG/PNG 再选一次。'
    const attemptId = await tryRecordFailure(base, message, deps, { width, height })
    return { ok: false, attemptId, message }
  }

  try {
    const archived = await archiveImageBase64(
      { base64, format, takenAtMs: capturedAtMs },
      { fs: deps.fs as ScreenshotFileSystem | undefined },
    )
    const outcome = await deps.recordAttempt({
      ...base,
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      sha256: archived.sha256,
      byteLength: archived.byteLength,
      width,
      height,
      format,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      note: archived.reusedExisting ? '同一张图之前已经保存过，这次复用已有文件' : null,
    })
    return {
      ok: true,
      attemptId: outcome.attempt.id,
      archivedUri: archived.uri,
      sha256: archived.sha256,
      byteLength: archived.byteLength,
      format,
      reusedExisting: archived.reusedExisting,
      preservedOriginal: true,
    }
  } catch (cause) {
    const message = `这张图没能保存到软件里：${cause instanceof Error ? cause.message : String(cause)}`
    // 归档失败时**不留下半份文件**（`archiveImageBase64` 自己保证），
    // 但要把这次失败登记下来，用户才能在截图库里看到「有张图没存住」。
    const attemptId = await tryRecordFailure(base, message, deps, {
      sha256: null,
      byteLength: null,
      width,
      height,
      format,
    })
    return { ok: false, attemptId, message }
  }
}

/** 登记一条 `ARCHIVE_FAILED` 记录；连登记都失败就返回 `null`（不抛异常）。 */
async function tryRecordFailure(
  base: Pick<RecordAttemptInput, 'source' | 'capturedAt' | 'originalUri'>,
  message: string,
  deps: ScreenshotArchiveDeps,
  extra: Partial<RecordAttemptInput> = {},
): Promise<number | null> {
  try {
    const outcome = await deps.recordAttempt({
      ...base,
      ...extra,
      status: 'ARCHIVE_FAILED',
      errorCode: 'ARCHIVE_FAILED',
      errorMessage: message,
    })
    return outcome.attempt.id
  } catch {
    return null
  }
}
