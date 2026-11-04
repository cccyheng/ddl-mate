/**
 * `expo-file-system`（SDK 58 的新 API）上的备份文件系统适配器。
 *
 * 只在原生运行时动态 import：node 测试注入自己的文件系统实现，不会加载原生模块。
 *
 * 使用的确切接口来自**已安装的 v58 JS / iOS 源码**：
 * - `Directory.pickDirectoryAsync(initialUri?)` 返回 `Directory`；用户取消时**抛**
 *   `FilePickingCancelledException`（没有 `{canceled}` 返回值），因此这里捕获并转成
 *   `{ canceled: true }`；
 * - `File.pickFileAsync({ mimeTypes })` 返回 `{ result: File, canceled: false }` 或
 *   `{ result: null, canceled: true }`；
 * - 目录里的子文件用 `Directory.createFile(name, mimeType)` 创建（iOS/Android 的
 *   security-scoped / SAF 目录不能靠字符串拼接路径），改名用 `File.rename(newName)`。
 */

import type { BackupFileSystem } from './backupService'

function isCancelError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  const code = (cause as { code?: unknown } | null)?.code
  return (
    /cancel/i.test(message) ||
    /cancel/i.test(String(code ?? '')) ||
    /FilePickingCancelled/i.test(String((cause as { name?: unknown } | null)?.name ?? ''))
  )
}

export async function createExpoBackupFileSystem(): Promise<BackupFileSystem> {
  const { File, Directory, Paths } = await import('expo-file-system')

  return {
    documentDirectory: String(Paths.document.uri),
    cacheDirectory: String(Paths.cache.uri),

    async exists(uri) {
      try {
        return Paths.info(uri).exists
      } catch {
        return false
      }
    },

    async size(uri) {
      try {
        if (!Paths.info(uri).exists) return null
        return Number(new File(uri).size)
      } catch {
        return null
      }
    },

    async readText(uri) {
      return new File(uri).text()
    },

    async readBase64(uri) {
      return new File(uri).base64()
    },

    async writeText(uri, text) {
      // SDK 58 changed `File.write` to return a promise; await it so callers that
      // read the file immediately afterwards cannot observe a partial write.
      await new File(uri).write(text)
    },

    async writeBase64(uri, base64) {
      await new File(uri).write(base64, { encoding: 'base64' })
    },

    async ensureDirectory(uri) {
      new Directory(uri).create({ intermediates: true, idempotent: true })
    },

    async deleteFile(uri) {
      new File(uri).delete()
    },

    async deleteDirectory(uri) {
      new Directory(uri).delete()
    },

    async move(from, to) {
      await new File(from).move(new File(to))
    },

    async createFile(directoryUri, name) {
      const file = new Directory(directoryUri).createFile(name, null)
      return file.uri
    },

    async renameFile(uri, newName) {
      const file = new File(uri)
      file.rename(newName)
      return file.uri
    },

    async listNames(directoryUri) {
      return new Directory(directoryUri).list().map((entry) => entry.name)
    },

    async list(directoryUri) {
      return new Directory(directoryUri).list().map((entry) => {
        const isDirectory = entry instanceof Directory
        return {
          uri: entry.uri,
          name: entry.name,
          isDirectory,
          size: isDirectory ? null : Number(entry.size),
        }
      })
    },

    async copyToDirectory(fromUri, directoryUri, name) {
      // 安装的 SDK 58 源码：`File.copy(to, options)` 用 `copyItem(at:to:)`，
      // 目标已存在会失败；因此先用 `Directory.createFile` 在 security-scoped /
      // SAF 目录里拿到一个可写 URL，再删掉这个空文件，把源文件复制到同一 URL。
      // 这样既不覆盖用户已有文件，也不靠字符串拼接 content:// URI。
      const targetFile = new Directory(directoryUri).createFile(name, null)
      const target = targetFile.uri
      targetFile.delete()
      await new File(fromUri).copy(new File(target))
      return target
    },

    async pickDirectory(initialUri) {
      try {
        const directory = await Directory.pickDirectoryAsync(initialUri)
        return { canceled: false, uri: directory.uri }
      } catch (cause) {
        if (isCancelError(cause)) return { canceled: true }
        throw cause
      }
    },

    async pickFile(initialUri) {
      // installed SDK 58 `FilePickingOptions` 支持 initialUri；只把自己成功导出过的
      // 目录作为起点，不从导入的备份内容里取任何路径。
      const result = await File.pickFileAsync({ mimeTypes: ['*/*'], initialUri })
      if (result.canceled) return { canceled: true }
      return { canceled: false, uri: result.result.uri, name: result.result.name }
    },
  }
}
