/**
 * 数据库初始化与版本迁移。
 *
 * 安全初始化顺序（任何一步失败都不会留下半成品 schema）：
 * 1. `PRAGMA foreign_keys = ON`（SQLite 默认关闭，必须显式打开才能让外键生效）；
 * 2. 读取 `PRAGMA user_version`；
 * 3. 在**单个事务**内按顺序执行版本大于当前 `user_version` 的迁移脚本；
 * 4. 事务成功后写回新的 `user_version`。
 *
 * 版本高于本程序支持的版本时**直接报错**而不是继续跑，避免旧代码写坏新结构。
 *
 * `user_version` 的读写走 `getUserVersion()` / `setUserVersion()`：
 * `PRAGMA` 不支持参数绑定、在部分驱动上也不能走 prepare 路径，因此单独封装。
 */

import { APP_SETTINGS_SQL, MIGRATIONS, SCHEMA_VERSION, SCREENSHOT_LIBRARY_COLUMNS } from './schema'
import type { SqliteDatabase } from './types'

export interface InitResult {
  fromVersion: number
  toVersion: number
  applied: number[]
  alreadyCurrent: boolean
}

export class SchemaVersionError extends Error {
  override readonly name = 'SchemaVersionError'
}

/**
 * 表里现有的列名。
 *
 * `ALTER TABLE ... ADD COLUMN` 在 SQLite 里**没有** `IF NOT EXISTS`，
 * 对同一列重复执行会直接报错；而迁移脚本必须能重复安全跑（用户可能中途杀进程、
 * 也可能手动把 `user_version` 回退）。所以加列之前先问一次表结构。
 */
async function tableColumns(db: SqliteDatabase, table: string): Promise<Set<string>> {
  const rows = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table});`)
  return new Set(rows.map((row) => String(row.name)))
}

/**
 * 幂等地补上新增列（v3 的 `courses.selection_serial`）。
 *
 * 只做 `ADD COLUMN`：既有行该列为 `NULL`，既有 `code` / `name` / 用户手改内容
 * 一个字节都不动。这是「迁移必须是 additive」这条硬约束的实现。
 */
export async function ensureAdditiveColumns(db: SqliteDatabase): Promise<string[]> {
  const added: string[] = []
  for (const entry of SCREENSHOT_LIBRARY_COLUMNS) {
    const existing = await tableColumns(db, entry.table)
    if (existing.has(entry.column)) continue
    await db.execAsync(`ALTER TABLE ${entry.table} ADD COLUMN ${entry.column} ${entry.definition};`)
    added.push(`${entry.table}.${entry.column}`)
  }
  return added
}

/** 建表 + 迁移；可重复调用（幂等）。 */
export async function initializeDatabase(db: SqliteDatabase): Promise<InitResult> {
  await db.execAsync('PRAGMA journal_mode = WAL;')
  await db.execAsync('PRAGMA foreign_keys = ON;')
  /**
   * `app_settings` 是 v2 迁移建的键值表，今日计划与**任务步骤清单**都复用它。
   *
   * 这里在版本判断之前**幂等**补一次 `CREATE TABLE IF NOT EXISTS`：
   * 手工改过 `user_version` 的库（或早期只跑到 v1 就被中断的库）可能缺这张表，
   * 缺了它任务步骤会「读也读不了、写也写不进」。只建表，不动任何已有数据。
   */
  await db.execAsync(APP_SETTINGS_SQL)

  const fromVersion = await db.getUserVersion()
  if (fromVersion > SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `本机数据库版本（${fromVersion}）高于当前应用支持的版本（${SCHEMA_VERSION}），请升级应用后再打开，避免写坏数据。`,
    )
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > fromVersion).sort(
    (a, b) => a.version - b.version,
  )
  if (pending.length === 0) {
    // 版本已经是最新：仍然补一次新增列，防止「手工改过 user_version」的库缺列。
    await ensureAdditiveColumns(db)
    return { fromVersion, toVersion: fromVersion, applied: [], alreadyCurrent: true }
  }

  await db.withTransactionAsync(async () => {
    for (const migration of pending) {
      await db.execAsync(migration.statements)
      await db.setUserVersion(migration.version)
    }
  })

  // `ADD COLUMN` 放在版本事务之后单独执行：SQLite 允许它和其它 DDL 同事务，
  // 但单独跑能让「加列失败」与「建表失败」的报错互不掩盖，且天然幂等。
  await ensureAdditiveColumns(db)

  const toVersion = await db.getUserVersion()
  if (toVersion !== SCHEMA_VERSION) {
    throw new SchemaVersionError(`迁移后版本应为 ${SCHEMA_VERSION}，实际为 ${toVersion}。`)
  }
  return {
    fromVersion,
    toVersion,
    applied: pending.map((migration) => migration.version),
    alreadyCurrent: false,
  }
}

/** 迁移期间必须关闭外键检查的场景（本版本不需要，保留显式说明）。 */
export const FOREIGN_KEYS_REQUIRED = true

export { SCHEMA_VERSION }
