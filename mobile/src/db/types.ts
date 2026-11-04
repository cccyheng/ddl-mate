/**
 * SQLite 访问层对外暴露的最小接口。
 *
 * 仓库只依赖这个接口，因此：
 * - 真机/模拟器上由 `expo-sqlite` 的实现注入（`openDatabase`）；
 * - node 测试里可以注入一个内存假实现，验证 SQL 参数绑定与仓库行为（无需真机）。
 */

export type SqlValue = string | number | null

export interface SqlRunResult {
  lastInsertRowId: number
  changes: number
}

export interface SqliteDatabase {
  /** 逐条执行多条语句（建表/迁移用，不含参数绑定）。 */
  execAsync(sql: string): Promise<void>
  /** 参数化写入，返回自增 id 与影响行数。 */
  runAsync(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>
  /** 参数化查询首行。 */
  getFirstAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>
  /** 参数化查询全部行。 */
  getAllAsync<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
  /** 事务包装（内部实现需保证失败回滚）。 */
  withTransactionAsync(task: () => Promise<void>): Promise<void>
  /** 读取 `PRAGMA user_version`（schema 版本）。 */
  getUserVersion(): Promise<number>
  /**
   * 写入 `PRAGMA user_version`。
   *
   * 单独开一个方法而不是走 `runAsync`：`PRAGMA` 不支持参数绑定，在部分驱动上
   * 也无法通过 prepare 路径执行，必须走 exec。版本号在此处强制取整，杜绝拼接注入。
   */
  setUserVersion(version: number): Promise<void>
  readonly userVersion: number
}

export class DatabaseError extends Error {
  override readonly name = 'DatabaseError'
}
