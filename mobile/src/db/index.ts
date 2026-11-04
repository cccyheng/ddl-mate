/**
 * 应用级数据库引导：打开文件 → 安全迁移 → 返回仓库集合。
 *
 * 只在原生运行时调用（内部会 import `expo-sqlite`）。
 * 迁移失败时抛出明确错误，由 UI 显示可读的失败态，而不是静默降级到空数据。
 */

import { CourseRepository } from '../domain/courseRepository'
import { ScreenshotLibraryRepository } from '../domain/screenshotLibraryRepository'
import { TaskPhotoRepository } from '../domain/taskPhotoRepository'
import { TaskRepository } from '../domain/taskRepository'
import { openAppDatabase, type OpenOptions } from './expoSqliteAdapter'
import { initializeDatabase, type InitResult } from './migrations'
import type { SqliteDatabase } from './types'

export interface AppDatabase {
  db: SqliteDatabase
  tasks: TaskRepository
  courses: CourseRepository
  /** 截图库：用户提交过的每一张图 + 识别结果 + 关联（v3 schema）。 */
  screenshots: ScreenshotLibraryRepository
  /** 任务原图：只读写既有截图关联的显式读 / 链接 / 解除操作。 */
  taskPhotos: TaskPhotoRepository
  init: InitResult
}

export async function bootstrapDatabase(options: OpenOptions = {}): Promise<AppDatabase> {
  const db = await openAppDatabase(options)
  const init = await initializeDatabase(db)
  return {
    db,
    tasks: new TaskRepository(db),
    courses: new CourseRepository(db),
    screenshots: new ScreenshotLibraryRepository(db),
    taskPhotos: new TaskPhotoRepository(db),
    init,
  }
}

export { initializeDatabase } from './migrations'
export type { SqliteDatabase, SqlValue } from './types'
export { SCHEMA_VERSION } from './schema'
