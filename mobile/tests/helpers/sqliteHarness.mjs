/**
 * 测试用 SQLite 夹具：用 Node 24 内置的 `node:sqlite` 开一个**真实的内存 SQLite**，
 * 把领域仓库直接跑在它上面。
 *
 * 为什么不用手写假数据库：本轮要验证的核心恰恰是**事务与外键语义**
 * （「原始文本写失败时任务不能落库」、`ON DELETE SET NULL` 保留任务），
 * 假对象无法证明这些行为。真 SQLite 才能。
 *
 * 注意边界：这是 **Node 侧** SQLite，不等于 iPhone 上的 `expo-sqlite` 原生运行时。
 * 它验证 SQL 与事务逻辑，验证不了原生绑定、UI 或真机文件持久化。
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 直接读源码里的建表 SQL，保证测试用的是**应用真正会执行的那份 schema**。 */
export function readSchemaSql() {
  // 本文件在 mobile/tests/helpers/ 下，schema 在 mobile/src/db/schema.ts。
  const source = readFileSync(join(here, '..', '..', 'src', 'db', 'schema.ts'), 'utf8')
  const match = /export const SCHEMA_SQL = `([\s\S]*?)`\s*\n/.exec(source)
  if (!match) throw new Error('无法从 src/db/schema.ts 里读出 SCHEMA_SQL。')
  return match[1]
}

/** v2 的 `app_settings` 建表 SQL（旧库夹具用）。 */
export function readAppSettingsSql() {
  const source = readFileSync(join(here, '..', '..', 'src', 'db', 'schema.ts'), 'utf8')
  const match = /export const APP_SETTINGS_SQL = `([\s\S]*?)`\s*\n/.exec(source)
  if (!match) throw new Error('无法从 src/db/schema.ts 里读出 APP_SETTINGS_SQL。')
  return match[1]
}

/** v3 的截图库建表 SQL。 */
export function readScreenshotLibrarySql() {
  const source = readFileSync(join(here, '..', '..', 'src', 'db', 'schema.ts'), 'utf8')
  const match = /export const SCREENSHOT_LIBRARY_SQL = `([\s\S]*?)`\s*\n/.exec(source)
  if (!match) throw new Error('无法从 src/db/schema.ts 里读出 SCREENSHOT_LIBRARY_SQL。')
  return match[1]
}

/**
 * 幂等补列：与 `migrations.ts` 的 `ensureAdditiveColumns` 同一份清单
 * （从 `SCREENSHOT_LIBRARY_COLUMNS` 里解析出来，避免两边手抄导致漂移）。
 */
export function applyAdditiveColumns(raw) {
  const source = readFileSync(join(here, '..', '..', 'src', 'db', 'schema.ts'), 'utf8')
  // 数组字面量以「单独一行的 `]`」收尾：用 `\n\]` 锚定真正的数组结束，
  // 否则 `[\s\S]*?\]` 会先停在类型注解 `}[]` 的那个 `]` 上，一条列都解析不出来。
  const block = /export const SCREENSHOT_LIBRARY_COLUMNS[\s\S]*?\n\]\s*\n/.exec(source)
  if (!block) throw new Error('无法从 src/db/schema.ts 里读出 SCREENSHOT_LIBRARY_COLUMNS。')
  const entries = [...block[0].matchAll(/table:\s*'([^']+)',\s*column:\s*'([^']+)',\s*definition:\s*'([^']+)'/g)]
  for (const [, table, column, definition] of entries) {
    const columns = raw.prepare(`PRAGMA table_info(${table});`).all().map((row) => row.name)
    if (columns.includes(column)) continue
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`)
  }
}

/** 把 `node:sqlite` 的 DatabaseSync 包装成应用的 `SqliteDatabase` 接口。 */
export function wrapDatabase(raw) {
  return {
    async execAsync(sql) {
      raw.exec(sql)
    },
    async runAsync(sql, params = []) {
      const statement = raw.prepare(sql)
      const result = statement.run(...params)
      return {
        lastInsertRowId: Number(result.lastInsertRowid ?? 0),
        changes: Number(result.changes ?? 0),
      }
    },
    async getFirstAsync(sql, params = []) {
      const statement = raw.prepare(sql)
      const row = statement.get(...params)
      return row === undefined ? null : row
    },
    async getAllAsync(sql, params = []) {
      const statement = raw.prepare(sql)
      return statement.all(...params)
    },
    async withTransactionAsync(task) {
      raw.exec('BEGIN IMMEDIATE;')
      try {
        await task()
        raw.exec('COMMIT;')
      } catch (cause) {
        try {
          raw.exec('ROLLBACK;')
        } catch {
          // 回滚失败不掩盖原始错误
        }
        throw cause
      }
    },
    async getUserVersion() {
      const row = raw.prepare('PRAGMA user_version;').get()
      const value = typeof row?.user_version === 'string' ? Number(row.user_version) : row?.user_version
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    },
    async setUserVersion(version) {
      // 与应用实现保持一致：PRAGMA 必须走 exec（不支持参数绑定）。
      raw.exec(`PRAGMA user_version = ${Math.trunc(version)};`)
    },
    get userVersion() {
      return 0
    },
  }
}

/** 建一个全新的内存库，并执行与应用相同的初始化流程（外键 + user_version + 建表）。 */
export async function createTestDatabase() {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec('PRAGMA user_version = 3;')
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)

  const { TaskRepository } = await import('../../src/domain/taskRepository.ts')
  const { CourseRepository } = await import('../../src/domain/courseRepository.ts')
  const { ScreenshotLibraryRepository } = await import('../../src/domain/screenshotLibraryRepository.ts')

  // 固定时钟，保证断言稳定（不依赖测试机器的真实时间）。
  const fixedNow = () => new Date('2026-10-08T04:00:00.000Z')

  return {
    raw,
    db,
    tasks: new TaskRepository(db, fixedNow),
    courses: new CourseRepository(db, fixedNow),
    screenshots: new ScreenshotLibraryRepository(db, { now: fixedNow }),
    /** 关闭底层连接，避免测试之间互相污染。 */
    close() {
      raw.close()
    },
  }
}

/**
 * 建一个**停在旧版本**的库（模拟真机上已经存在、装着用户数据的数据库），
 * 之后由测试自己调用应用真正的迁移流程升级它。
 *
 * 这是「迁移必须是 additive、不能丢用户数据」这条硬约束的可信证法：
 * 先在 v2 的结构里写入课程 / 课表 / 任务 / 原始文本，再调 `initializeDatabase`，
 * 然后断言旧数据一条不少、新列与新表都在。
 */
export function createLegacyDatabase(raw) {
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec('PRAGMA user_version = 2;')
  return wrapDatabase(raw)
}

/** 一个合法的任务草稿，测试里按需覆盖字段。 */
export function taskDraft(overrides = {}) {
  return {
    title: '数据结构第 3 次作业',
    description: '',
    courseId: null,
    type: 'HOMEWORK',
    status: 'TODO',
    priority: 3,
    deadline: '',
    estimatedMinutes: '',
    submitRequirement: '',
    submitMethod: '',
    originalText: '',
    ...overrides,
  }
}

export function courseDraft(overrides = {}) {
  return {
    code: 'CS201',
    name: '数据结构',
    instructor: '王老师',
    semester: '2026 秋',
    color: '#b4573a',
    note: '',
    selectionSerial: '',
    ...overrides,
  }
}

export function scheduleDraft(overrides = {}) {
  return {
    weekday: 4,
    startTime: '08:00',
    endTime: '09:40',
    location: '教三 305',
    periodStart: '',
    periodEnd: '',
    semesterStartDate: '2026-09-07',
    startWeek: '1',
    endWeek: '16',
    weekPattern: 'ALL',
    ...overrides,
  }
}

/**
 * 在真实数据库外面套一层「第 N 次写入就失败」的包装，用来证明**多天批量保存的原子性**：
 * 只有真的在同一事务里，第 2 条 INSERT 抛错后第 1 条也必须一起回滚。
 *
 * 只拦截 `runAsync`（写入）；`execAsync`（BEGIN/COMMIT/ROLLBACK）与读取照常走真实 SQLite。
 */
export function failingRunDatabase(db, shouldFail) {
  let runCount = 0
  return {
    ...db,
    async runAsync(sql, params = []) {
      runCount += 1
      if (shouldFail(runCount, sql)) {
        throw new Error(`测试注入的写入失败（第 ${runCount} 次写入）`)
      }
      return db.runAsync(sql, params)
    },
  }
}
