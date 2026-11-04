/**
 * 备份服务的真实磁盘文件系统替身（Node 测试用）。
 *
 * 形状与 `src/domain/backupService.ts` 的 `BackupFileSystem` 一致；所有路径都是
 * 临时目录下的 `file://` URL。测试用它验证「写入、改名、复制、逐字节校验」这些
 * 真实文件行为，不碰用户手机上的任何数据库 / 照片。
 */
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function toPath(uri) {
  return fileURLToPath(uri)
}

async function info(uri) {
  try {
    const value = await stat(toPath(uri))
    return { exists: true, size: value.size, isDirectory: value.isDirectory() }
  } catch {
    return { exists: false, size: null, isDirectory: false }
  }
}

export function createBackupFs(documentDirectory) {
  const documentUri = `${pathToFileURL(documentDirectory).href.replace(/\/$/, '')}/`
  return {
    documentDirectory: documentUri,
    cacheDirectory: documentUri,

    async exists(uri) {
      return (await info(uri)).exists
    },

    async size(uri) {
      const value = await info(uri)
      return value.exists && !value.isDirectory ? value.size : null
    },

    async readText(uri) {
      return readFile(toPath(uri), 'utf8')
    },

    async readBase64(uri) {
      return (await readFile(toPath(uri))).toString('base64')
    },

    async writeText(uri, text) {
      await writeFile(toPath(uri), text, 'utf8')
    },

    async writeBase64(uri, base64) {
      await writeFile(toPath(uri), Buffer.from(base64, 'base64'))
    },

    async ensureDirectory(uri) {
      await mkdir(toPath(uri), { recursive: true })
    },

    async deleteFile(uri) {
      await rm(toPath(uri), { force: true })
    },

    async deleteDirectory(uri) {
      await rm(toPath(uri), { recursive: true, force: true })
    },

    async move(from, to) {
      await mkdir(dirname(toPath(to)), { recursive: true })
      await rename(toPath(from), toPath(to))
    },

    async createFile(directoryUri, name) {
      await mkdir(toPath(directoryUri), { recursive: true })
      const target = join(toPath(directoryUri), name)
      await writeFile(target, '')
      return pathToFileURL(target).href
    },

    async renameFile(uri, newName) {
      const from = toPath(uri)
      const to = join(dirname(from), newName)
      await rename(from, to)
      return pathToFileURL(to).href
    },

    async listNames(directoryUri) {
      try {
        return await readdir(toPath(directoryUri))
      } catch {
        return []
      }
    },

    async list(directoryUri) {
      const entries = await readdir(toPath(directoryUri), { withFileTypes: true })
      const result = []
      for (const entry of entries) {
        const uri = pathToFileURL(join(toPath(directoryUri), entry.name)).href
        const value = await stat(toPath(uri))
        result.push({
          uri,
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : value.size,
        })
      }
      return result
    },

    async copyToDirectory(fromUri, directoryUri, name) {
      await mkdir(toPath(directoryUri), { recursive: true })
      const target = join(toPath(directoryUri), name)
      const existing = await info(pathToFileURL(target).href)
      if (existing.exists) throw new Error(`目标文件已存在：${name}`)
      await copyFile(toPath(fromUri), target)
      return pathToFileURL(target).href
    },

    async pickDirectory() {
      throw new Error('测试不打开系统目录选择器')
    },

    async pickFile() {
      throw new Error('测试不打开系统文件选择器')
    },
  }
}
