/**
 * `expo-sqlite` 适配器：把真实的原生 SQLite 包装成仓库层依赖的 `SqliteDatabase` 接口。
 *
 * 这里是**唯一** import `expo-sqlite` 的地方，因此纯领域模块与 node 测试
 * 都不会把原生模块拖进来（测试用内存假实现）。
 */

import type { SqlValue, SqliteDatabase } from './types'

/** 原生驱动的最小子集（`expo-sqlite` 的 `SQLiteDatabase` 满足该形态）。 */
interface NativeStatement {
  executeAsync(params?: readonly SqlValue[]): Promise<{ lastInsertRowId: number; changes: number }>
  finalizeAsync(): Promise<void>
}

interface NativeDatabase {
  execAsync(sql: string): Promise<void>
  prepareAsync(sql: string): Promise<NativeStatement>
  getFirstAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>
  getAllAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  withTransactionAsync(task: () => Promise<void>): Promise<void>
}

function wrap(native: NativeDatabase): SqliteDatabase {
  return {
    async execAsync(sql: string): Promise<void> {
      await native.execAsync(sql)
    },
    async runAsync(sql: string, params: readonly SqlValue[] = []) {
      // 一律走 prepare + 参数绑定，杜绝字符串拼接 SQL。
      const statement = await native.prepareAsync(sql)
      try {
        const result = await statement.executeAsync(params)
        return {
          lastInsertRowId: Number(result.lastInsertRowId ?? 0),
          changes: Number(result.changes ?? 0),
        }
      } finally {
        await statement.finalizeAsync()
      }
    },
    async getFirstAsync<T>(sql: string, params: readonly SqlValue[] = []) {
      return native.getFirstAsync<T>(sql, params)
    },
    async getAllAsync<T>(sql: string, params: readonly SqlValue[] = []) {
      return native.getAllAsync<T>(sql, params)
    },
    async withTransactionAsync(task: () => Promise<void>) {
      await native.withTransactionAsync(task)
    },
    async getUserVersion(): Promise<number> {
      // PRAGMA 不能用参数绑定；读回来可能是 number，也可能被驱动转成 string。
      const row = await native.getFirstAsync<{ user_version?: number | string }>('PRAGMA user_version;')
      const value = typeof row?.user_version === 'string' ? Number(row.user_version) : row?.user_version
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    },
    async setUserVersion(version: number): Promise<void> {
      // 强制取整后再拼接，杜绝任何注入可能。
      await native.execAsync(`PRAGMA user_version = ${Math.trunc(version)};`)
    },
    get userVersion() {
      return 0
    },
  }
}

export interface OpenOptions {
  databaseName?: string
}

export const DEFAULT_DATABASE_NAME = 'ddl-mate.db'

/**
 * 打开（并创建）本地数据库文件。
 *
 * 使用 `openDatabaseAsync` 的默认选项：文件位于应用私有目录（iOS 上是沙盒
 * `Documents/SQLite/`），卸载应用才会清除；不需要任何服务器或网络。
 */
export async function openAppDatabase(options: OpenOptions = {}): Promise<SqliteDatabase> {
  const { openDatabaseAsync } = await import('expo-sqlite')
  const native = (await openDatabaseAsync(options.databaseName ?? DEFAULT_DATABASE_NAME)) as unknown as NativeDatabase
  return wrap(native)
}
