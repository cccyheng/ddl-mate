// 截图库：真实 SQLite + 真实事务 + 可注入的文件系统。
//
// 这一组测试守的是本轮授权范围里最硬的几条：
// - 迁移必须是 **additive**：旧库里已有的课程/课表/任务/原文一条都不能少；
// - 「识别前先归档」：失败的识别、取消的识别同样要留下原图与尝试记录；
// - 同一张图重复提交**不覆盖、不删除**历史，只记去重关联；
// - 文件落盘是**原子**的：中途失败不留半成品，也不留孤儿文件；
// - 选课序号与 App 的 AUTO- 内部编号分开存、分开取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyAdditiveColumns,
  createLegacyDatabase,
  readSchemaSql,
  readScreenshotLibrarySql,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { archiveImageBase64, MAX_ARCHIVE_BYTES } from '../src/domain/screenshotFiles.ts'
import { ScreenshotLibraryRepository } from '../src/domain/screenshotLibraryRepository.ts'
import { sha256HexOfBase64 } from '../src/domain/hashing.ts'

const here = dirname(fileURLToPath(import.meta.url))
const FIXED_NOW = () => new Date('2026-10-12T04:00:00.000Z')

/** 内存文件系统：行为与 `expo-file-system/legacy` 的那几个方法一致。 */
function createMemoryFs({ failWrite = false, corruptWrite = false } = {}) {
  const files = new Map()
  const directories = new Set(['file:///docs/'])
  let writeCount = 0
  /** 落盘字节：`binary`/`base64` 编码按真正的字节算，不是 JS 字符串长度。 */
  const toBytes = (contents, options) => {
    const encoding = String(options?.encoding ?? 'utf8').toLowerCase()
    if (encoding === 'base64') return Buffer.from(String(contents), 'base64')
    return Buffer.from(String(contents), 'utf8')
  }
  return {
    documentDirectory: 'file:///docs/',
    files,
    directories,
    get writeCount() {
      return writeCount
    },
    async makeDirectoryAsync(uri) {
      directories.add(uri.endsWith('/') ? uri : `${uri}/`)
    },
    async getInfoAsync(uri) {
      if (directories.has(uri.endsWith('/') ? uri : `${uri}/`)) return { exists: true, isDirectory: true }
      const value = files.get(uri)
      if (value === undefined) return { exists: false }
      return { exists: true, size: value.length, isDirectory: false }
    },
    async readAsStringAsync(uri, options) {
      const value = files.get(uri)
      if (value === undefined) throw new Error(`没有这个文件：${uri}`)
      return String(options?.encoding ?? 'utf8').toLowerCase() === 'base64' ? value.toString('base64') : value.toString('utf8')
    },
    async writeAsStringAsync(uri, contents, options) {
      writeCount += 1
      if (failWrite) throw new Error('磁盘写入失败（测试注入）')
      const bytes = toBytes(contents, options)
      files.set(uri, corruptWrite ? Buffer.concat([bytes, Buffer.from('X')]) : bytes)
    },
    async moveAsync({ from, to }) {
      const value = files.get(from)
      if (value === undefined) throw new Error(`move 的源文件不存在：${from}`)
      files.delete(from)
      files.set(to, value)
    },
    async deleteAsync(uri) {
      files.delete(uri)
    },
    async downloadAsync(remoteUri, fileUri) {
      files.set(fileUri, Buffer.from(`downloaded:${remoteUri}`, 'utf8'))
      return { uri: fileUri, status: 200 }
    },
  }
}

/** 1×1 的合法 PNG（base64）；测试只关心字节，不关心画面。 */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='

function legacyDbSetup() {
  const raw = new DatabaseSync(':memory:')
  const db = createLegacyDatabase(raw)
  return { raw, db }
}

/* ------------------------------- 迁移 ------------------------------- */

test('v2 → v3 迁移是 additive：旧数据一条不少，新表新列都在', async () => {
  const { initializeDatabase, SCHEMA_VERSION, ensureAdditiveColumns } = await import('../src/db/migrations.ts')
  const { raw, db } = legacyDbSetup()
  try {
    // 先按 v2 结构写入"用户的真实数据"。
    raw
      .prepare(
        `INSERT INTO courses (id, code, name, instructor, semester, color, note, created_at, updated_at)
         VALUES (7, 'CS201', '数据结构', '王老师', '2026 秋', '#b4573a', '手写备注', '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z');`,
      )
      .run()
    raw
      .prepare(
        `INSERT INTO schedules (id, course_id, weekday, start_time, end_time, location, week_pattern, start_week, end_week, created_at, updated_at)
         VALUES (3, 7, 4, '08:00', '09:40', '教三 305', 'ALL', 1, 16, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');`,
      )
      .run()
    raw
      .prepare(
        `INSERT INTO tasks (id, title, type, status, priority, created_at, updated_at)
         VALUES (11, '第 3 次作业', 'HOMEWORK', 'TODO', 3, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');`,
      )
      .run()
    raw
      .prepare(`INSERT INTO task_sources (task_id, kind, raw_text, created_at) VALUES (11, 'ORIGINAL_TEXT', '原始通知正文', '2026-09-01T00:00:00.000Z');`)
      .run()

    const result = await initializeDatabase(db)
    assert.equal(result.fromVersion, 2)
    assert.equal(result.toVersion, SCHEMA_VERSION)
    assert.deepEqual(result.applied, [3])

    // 旧数据：逐条核对，一个字都不能变。
    const course = raw.prepare('SELECT * FROM courses WHERE id = 7;').get()
    assert.equal(course.code, 'CS201')
    assert.equal(course.name, '数据结构')
    assert.equal(course.instructor, '王老师')
    assert.equal(course.note, '手写备注')
    assert.equal(course.selection_serial, null, '新列对旧行必须是 NULL，绝不瞎猜一个序号')
    assert.equal(course.updated_at, '2026-09-02T00:00:00.000Z', '迁移不能改 updated_at')

    assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM schedules;').get().c, 1)
    assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM tasks;').get().c, 1)
    assert.equal(raw.prepare('SELECT raw_text FROM task_sources;').get().raw_text, '原始通知正文')

    // 新表都在。
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
    for (const name of ['screenshot_attempts', 'source_screenshots', 'screenshot_refs', 'ocr_results', 'ocr_candidate_rows']) {
      assert.ok(tables.includes(name), `缺少表 ${name}`)
    }

    // 重复迁移 / 重复补列都必须幂等（用户中途杀进程也能恢复）。
    const again = await initializeDatabase(db)
    assert.equal(again.alreadyCurrent, true)
    assert.deepEqual(await ensureAdditiveColumns(db), [], '列已经存在时不能再 ALTER 一次')
    assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM courses;').get().c, 1)
  } finally {
    raw.close()
  }
})

test('v3 建表 SQL 里没有任何 DROP / DELETE 语句（不得静默删除用户数据）', () => {
  const sql = readScreenshotLibrarySql()
  assert.doesNotMatch(sql, /\bDROP\b/i)
  // 只允许 `ON DELETE CASCADE/SET NULL` 这种引用动作，不允许真的删数据。
  assert.doesNotMatch(sql, /DELETE\s+FROM/i)
})

test('仓库源码里没有 DELETE 语句：截图历史只增不减', () => {
  const source = readFileSync(join(here, '..', 'src', 'domain', 'screenshotLibraryRepository.ts'), 'utf8')
  assert.doesNotMatch(source, /DELETE\s+FROM/i, '截图库仓库不允许删除任何截图/识别历史')
})

/* --------------------------- 归档文件（原子性） --------------------------- */

test('归档：写 .part → 校验字节 → 改名，且目录会被创建', async () => {
  const fs = createMemoryFs()
  const archived = await archiveImageBase64(
    { base64: TINY_PNG, format: 'png', takenAtMs: Date.parse('2026-10-12T12:25:24Z') },
    { fs },
  )
  assert.ok(archived.fileName.startsWith('shot-'))
  assert.ok(archived.fileName.endsWith('.png'))
  assert.match(archived.fileName, /^shot-[0-9a-f]{32}\.png$/, '文件名只用内容指纹，保证同图同文件')
  assert.match(archived.sha256, /^[0-9a-f]{64}$/)
  assert.equal(archived.reusedExisting, false)
  assert.equal(archived.byteLength, Buffer.from(TINY_PNG, 'base64').length)
  assert.ok(fs.directories.has('file:///docs/screenshots/'), '归档目录必须自动创建')
  assert.ok(fs.files.has(archived.uri), '文件要落在归档目录里')
  assert.equal([...fs.files.keys()].some((key) => key.endsWith('.part')), false, '不能留下 .part 半成品')
})

test('归档：写入字节数不对时删掉半成品并报错，绝不留下坏文件', async () => {
  const fs = createMemoryFs({ corruptWrite: true })
  await assert.rejects(
    () => archiveImageBase64({ base64: TINY_PNG, format: 'png' }, { fs }),
    /字节数不对/,
  )
  assert.equal(fs.files.size, 0, '失败后不能留任何文件（包括 .part）')
})

test('归档：写盘抛错时原样抛出，且不留下临时文件', async () => {
  const fs = createMemoryFs({ failWrite: true })
  await assert.rejects(() => archiveImageBase64({ base64: TINY_PNG, format: 'png' }, { fs }), /磁盘写入失败/)
  assert.equal(fs.files.size, 0)
})

test('归档：同一张图重复提交复用已有文件（字节只存一份）', async () => {
  const fs = createMemoryFs()
  const first = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: 1 }, { fs })
  const second = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: 2 }, { fs })
  assert.equal(first.uri, second.uri, '内容相同 → 文件名相同 → 复用同一份字节')
  assert.equal(second.reusedExisting, true)
  assert.equal(fs.writeCount, 1, '第二次不能真的再写一遍')
})

test('归档：超过单张上限时明确失败，不静默截断', async () => {
  const fs = createMemoryFs()
  const huge = 'A'.repeat(Math.ceil(((MAX_ARCHIVE_BYTES + 1024) * 4) / 3))
  await assert.rejects(() => archiveImageBase64({ base64: huge, format: 'jpeg' }, { fs }), /超过单张保存上限/)
  assert.equal(fs.files.size, 0)
})

test('归档：空内容直接拒绝', async () => {
  const fs = createMemoryFs()
  await assert.rejects(() => archiveImageBase64({ base64: '', format: 'png' }, { fs }), /没有内容/)
})

test('hashing：SHA-256 与已知向量一致（Hermes 回退实现也要对）', async () => {
  // 空串的 SHA-256 是标准测试向量。
  assert.equal(
    await sha256HexOfBase64(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  // "abc"
  assert.equal(
    await sha256HexOfBase64(Buffer.from('abc').toString('base64')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

/* ------------------------ 导入：序号 / 关联 / 回滚 ------------------------ */

/** 造一条待导入候选（默认同名、同一天同一时段，只差选课序号）。 */
function importCandidate(serial, rowNumber = 1, overrides = {}) {
  return {
    rowNumber,
    include: true,
    course: { code: `AUTO-${String(rowNumber).padStart(2, '0')}`, name: '测试课程', instructor: '', semester: '', color: '', note: '', selectionSerial: serial },
    schedule: {
      weekday: 1,
      startTime: '08:00',
      endTime: '09:35',
      location: '',
      periodStart: '',
      periodEnd: '',
      semesterStartDate: '2026-08-31',
      startWeek: '1',
      endWeek: '16',
      weekPattern: 'ALL',
    },
    ...overrides,
  }
}

test('同批同名但选课序号不同：视为两门课，不再被误判成重复', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
    const outcome = await repository.importCandidates({
      candidates: [importCandidate('11111.01', 1), importCandidate('22222.02', 2)],
    })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.schedules.length, 2, '两门同名的不同课都要写进去')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 2)
    assert.deepEqual(
      ctx.raw.prepare('SELECT selection_serial FROM courses ORDER BY id ASC').all().map((row) => row.selection_serial),
      ['11111.01', '22222.02'],
    )
  } finally {
    ctx.close()
  }
})

test('同批同名同一天同一时段但序号相同：仍然当作真重复拦下来（保护不变）', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
    await assert.rejects(
      () => repository.importCandidates({ candidates: [importCandidate('11111.01', 1), importCandidate('11111.01', 2)] }),
      (error) => error.name === 'ValidationError',
    )
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 0, '被拒时一行都不写')
  } finally {
    ctx.close()
  }
})

test('没有选课序号时，同名同天同时段仍然按真重复拦下来', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
    await assert.rejects(
      () => repository.importCandidates({ candidates: [importCandidate('', 1), importCandidate('', 2)] }),
      (error) => error.name === 'ValidationError',
    )
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 0)
  } finally {
    ctx.close()
  }
})

test('截图关联写入失败时整批回滚：课表/课程/引用一个都不留，且如实抛错', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const { attempt } = await ctx.screenshots.recordAttempt({ source: 'LIBRARY', status: 'ARCHIVED', archivedPath: 'file:///docs/x.png', sha256: 'a'.repeat(64) })
    // 让 screenshot_refs 的 INSERT 在事务中途失败。
    const failingDb = {
      ...ctx.db,
      async runAsync(sql, params) {
        if (/INSERT INTO screenshot_refs/i.test(sql)) throw new Error('注入的关联写入失败')
        return ctx.db.runAsync(sql, params)
      },
    }
    const repository = new ScheduleImportRepository(failingDb, FIXED_NOW)
    let error = null
    try {
      await repository.importCandidates({
        candidates: [{ ...importCandidate('11111.01', 1), originAttemptId: attempt.id }],
        originAttemptId: attempt.id,
      })
    } catch (cause) {
      error = cause
    }
    assert.ok(error, '关联写失败必须抛错，而不是静默返回成功')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 0, '整批课表必须回滚')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 0, '整批课程必须回滚')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM screenshot_refs').get().n, 0, '不能留下任何半条引用')
  } finally {
    ctx.close()
  }
})

test('导入新建课程时内部代码留空也会各自分配唯一编号（同名不同序号仍是两门课）', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
    // 页面不再暴露课程代码：这两行草稿的 code 就是空的（只有选课序号不同）。
    const outcome = await repository.importCandidates({
      candidates: [importCandidate('11111.01', 1, { course: { ...importCandidate('11111.01', 1).course, code: '' } }),
        importCandidate('22222.02', 2, { course: { ...importCandidate('22222.02', 2).course, code: '' } })],
    })
    assert.equal(outcome.committed, true)
    assert.equal(outcome.schedules.length, 2)
    const rows = ctx.raw.prepare('SELECT id, code, name, selection_serial FROM courses ORDER BY id ASC').all()
    assert.equal(rows.length, 2, '同名但选课序号不同 → 两门课，不能被合并')
    assert.deepEqual(rows.map((row) => row.selection_serial), ['11111.01', '22222.02'])
    for (const row of rows) {
      assert.match(row.code, /^AUTO-\d+$/, '空代码必须由仓库层分配一个内部编号')
      assert.ok(row.code.trim().length > 0)
    }
    assert.notEqual(rows[0].code, rows[1].code, '同一批里的两门新课程不能撞同一个内部编号')

    // 再导入一次同一行：复用已有课程（连同它的内部编号），课表按重复跳过。
    const again = await repository.importCandidates({
      candidates: [importCandidate('11111.01', 1, { course: { ...importCandidate('11111.01', 1).course, code: '' } })],
    })
    assert.equal(again.committed, true)
    assert.equal(again.skippedDuplicates, 1, '同一天同一时段已经存在 → 跳过，不重复写')
    assert.equal(again.courses[0].reused, true)
    assert.equal(again.courses[0].course.code, rows[0].code, '复用时要沿用库里那条课程的内部编号')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM courses').get().n, 2, '复用不能凭空多出一门课')
    assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, 2)
  } finally {
    ctx.close()
  }
})

test('导入成功后：课表与课程都能从截图反查（关联条数如实上报）', async () => {
  const { ScheduleImportRepository } = await import('../src/domain/scheduleImportRepository.ts')
  const ctx = await libraryHarness()
  try {
    const { attempt } = await ctx.screenshots.recordAttempt({ source: 'LIBRARY', status: 'ARCHIVED', archivedPath: 'file:///docs/y.png', sha256: 'b'.repeat(64) })
    const repository = new ScheduleImportRepository(ctx.db, FIXED_NOW)
    const outcome = await repository.importCandidates({
      candidates: [{ ...importCandidate('33333.03', 1), originAttemptId: attempt.id }],
      originAttemptId: attempt.id,
    })
    assert.equal(outcome.screenshotLinks, 3, '课表 + 课程 + 整批来源 = 3 条引用')
    const scheduleId = outcome.schedules[0].id
    assert.equal(await ctx.screenshots.countRefsTo('SCHEDULE', scheduleId), 2)
    const linked = await ctx.screenshots.listAttemptsLinkedTo('SCHEDULE', scheduleId)
    assert.equal(linked.length, 1)
    assert.equal(linked[0].id, attempt.id)
    // 重复导入同一张图：引用不翻倍（幂等），课表也不重复。
    const again = await repository.importCandidates({
      candidates: [{ ...importCandidate('33333.03', 1), originAttemptId: attempt.id }],
      originAttemptId: attempt.id,
    })
    assert.equal(again.schedules.length, 0)
    assert.equal(again.skippedDuplicates, 1)
    assert.equal(again.screenshotLinks, 0, '已经存在的引用不再计数')
    assert.equal(await ctx.screenshots.countRefsTo('SCHEDULE', scheduleId), 2)
  } finally {
    ctx.close()
  }
})

/* ------------------------ 归档：识别之前先落盘原图 ------------------------ */

test('归档服务：PNG 原图先落盘再登记，识别之前就完成', async () => {
  const { archivePickedPhoto } = await import('../src/domain/screenshotArchive.ts')
  const ctx = await libraryHarness()
  try {
    const recorded = []
    const outcome = await archivePickedPhoto(
      { uri: 'file:///tmp/picked.png', attemptSource: 'LIBRARY', capturedAtMs: FIXED_NOW().getTime() },
      {
        fs: ctx.fs,
        readSourceBase64: async () => TINY_PNG,
        recordAttempt: async (input) => {
          recorded.push(input)
          return ctx.screenshots.recordAttempt(input)
        },
      },
    )
    assert.equal(outcome.ok, true)
    assert.equal(outcome.preservedOriginal, true, '原图字节原样落盘，没有转码')
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].status, 'ARCHIVED', '登记发生在识别之前')
    assert.equal(recorded[0].originalUri, 'file:///tmp/picked.png')
    assert.ok(outcome.archivedUri.startsWith('file:///docs/screenshots/'))
    assert.equal((await ctx.screenshots.listViewableAttempts()).length, 1)
  } finally {
    ctx.close()
  }
})

test('归档服务：读取失败 / 非 PNG-JPEG 时如实登记 ARCHIVE_FAILED，不假装存住了', async () => {
  const { archivePickedPhoto } = await import('../src/domain/screenshotArchive.ts')
  const ctx = await libraryHarness()
  try {
    const readFailure = await archivePickedPhoto(
      { uri: 'ph://gone', attemptSource: 'LIBRARY' },
      {
        fs: ctx.fs,
        readSourceBase64: async () => {
          throw new Error('原文件已经不在了')
        },
        recordAttempt: (input) => ctx.screenshots.recordAttempt(input),
      },
    )
    assert.equal(readFailure.ok, false)
    assert.match(readFailure.message, /没能读取/)
    assert.ok(readFailure.attemptId !== null, '失败也要留一条可回看的记录')

    // 不是 PNG/JPEG 的字节（这里用 UTF-8 文本冒充 HEIC）不能被当成归档成果。
    const wrongFormat = await archivePickedPhoto(
      { uri: 'file:///tmp/x.heic', attemptSource: 'CAMERA' },
      {
        fs: ctx.fs,
        readSourceBase64: async () => Buffer.from('not-an-image').toString('base64'),
        recordAttempt: (input) => ctx.screenshots.recordAttempt(input),
      },
    )
    assert.equal(wrongFormat.ok, false)
    assert.match(wrongFormat.message, /不是 PNG \/ JPEG/)
    assert.equal(ctx.fs.files.size, 0, '没能归档时必须一份文件都不留')

    const attempts = await ctx.screenshots.listAttempts()
    assert.equal(attempts.length, 2)
    assert.ok(attempts.every((attempt) => attempt.status === 'ARCHIVE_FAILED'))
    assert.equal(await ctx.screenshots.countAttemptsWithFile(), 0, '没有文件就不算「能看的截图」')
  } finally {
    ctx.close()
  }
})

test('归档服务：写盘失败时登记失败并且不留半成品文件', async () => {
  const { archivePickedPhoto } = await import('../src/domain/screenshotArchive.ts')
  const ctx = await libraryHarness()
  const failingFs = createMemoryFs({ failWrite: true })
  try {
    const outcome = await archivePickedPhoto(
      { uri: 'file:///tmp/picked.png', attemptSource: 'LIBRARY' },
      {
        fs: failingFs,
        readSourceBase64: async () => TINY_PNG,
        recordAttempt: (input) => ctx.screenshots.recordAttempt(input),
      },
    )
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /没能保存到软件里/)
    assert.equal(failingFs.files.size, 0)
    assert.equal((await ctx.screenshots.listAttempts())[0].status, 'ARCHIVE_FAILED')
  } finally {
    ctx.close()
  }
})

/* ------------------------------ 尝试与识别 ------------------------------ */

async function libraryHarness() {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec('PRAGMA user_version = 3;')
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const fs = createMemoryFs()
  const screenshots = new ScreenshotLibraryRepository(db, { now: FIXED_NOW })
  return { raw, db, fs, screenshots, close: () => raw.close() }
}

test('识别前先归档：成功识别的截图带着关联与选课序号落库', async () => {
  const ctx = await libraryHarness()
  try {
    const archived = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: FIXED_NOW().getTime() }, { fs: ctx.fs })
    const { attempt } = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      originalUri: 'ph://asset-1',
      sha256: archived.sha256,
      byteLength: archived.byteLength,
      width: 1279,
      height: 2781,
      format: 'png',
      mimeType: 'image/png',
    })
    assert.equal(attempt.status, 'ARCHIVED')
    assert.equal(attempt.archivedPath, archived.uri)
    assert.equal(attempt.originalUri, 'ph://asset-1')

    const result = await ctx.screenshots.recordOcrResult({
      attemptId: attempt.id,
      status: 'SUCCESS',
      layout: 'table-grid',
      week: null,
      requestId: 'req-test-1',
      rawText: '大学物理(B-2)(9913000172.08)',
      candidates: [
        {
          rowIndex: 0,
          name: '大学物理(B-2)',
          weekday: 1,
          startTime: '08:00',
          endTime: '09:35',
          startWeek: 1,
          endWeek: 16,
          weekPattern: 'ALL',
          location: '励志楼-204',
          selectionSerial: '9913000172.08',
          rawText: '大学物理(B-2)(9913000172.08)',
        },
      ],
      image: { width: 1279, height: 2781, format: 'png', bytes: 521579 },
    })
    assert.ok(result)
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0].selectionSerial, '9913000172.08')
    assert.equal(result.candidates[0].startWeek, 1)
    assert.equal(result.candidates[0].endWeek, 16)

    await ctx.screenshots.linkRef({ attemptId: attempt.id, targetKind: 'COURSE', targetId: 7, relation: 'IMPORTED_COURSE' })
    await ctx.screenshots.linkRef({ attemptId: attempt.id, targetKind: 'COURSE', targetId: 7, relation: 'IMPORTED_COURSE' })
    assert.equal(await ctx.screenshots.countRefsTo('COURSE', 7), 1, '同一关联只写一次（幂等）')
    const linked = await ctx.screenshots.listAttemptsLinkedTo('COURSE', 7)
    assert.equal(linked.length, 1)
    assert.equal(linked[0].id, attempt.id)

    const outcome = await ctx.screenshots.listOcrResultsForTarget('COURSE', 7)
    assert.equal(outcome.length, 1)
    assert.equal(outcome[0].relation, 'IMPORTED_COURSE')
    assert.equal(outcome[0].result?.candidates[0].selectionSerial, '9913000172.08')
  } finally {
    ctx.close()
  }
})

test('识别失败/被取消的截图同样保留原图与尝试状态', async () => {
  const ctx = await libraryHarness()
  try {
    const archived = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: FIXED_NOW().getTime() }, { fs: ctx.fs })
    const { attempt: failed } = await ctx.screenshots.recordAttempt({
      source: 'CAMERA',
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      sha256: archived.sha256,
    })
    await ctx.screenshots.recordOcrResult({
      attemptId: failed.id,
      status: 'FAILED',
      errorCode: 'NO_STRUCTURE',
      errorMessage: '这张图里没有读到课程方块。',
      candidates: [],
    })
    await ctx.screenshots.updateAttempt(failed.id, { status: 'FAILED', errorCode: 'NO_STRUCTURE' })

    const { attempt: cancelled } = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'CANCELLED',
      archivedPath: `${archived.uri}.other`,
      sha256: 'f'.repeat(64),
      note: '用户在选择后取消识别',
    })
    await ctx.screenshots.recordOcrResult({ attemptId: cancelled.id, status: 'CANCELLED', candidates: [] })

    const attempts = await ctx.screenshots.listAttempts()
    assert.equal(attempts.length, 2, '失败与取消都要留下历史记录')
    const stored = await ctx.screenshots.getAttempt(failed.id)
    assert.equal(stored.status, 'FAILED')
    assert.equal(stored.errorCode, 'NO_STRUCTURE')
    assert.equal(await ctx.screenshots.latestResultStatus(failed.id), 'FAILED')
    assert.equal(await ctx.screenshots.latestResultStatus(cancelled.id), 'CANCELLED')
    assert.equal(await ctx.screenshots.countAttemptsWithFile(), 2, '两张图都还看得到')
  } finally {
    ctx.close()
  }
})

test('同一张图重复提交：新历史照记，字节复用并挂上去重关联', async () => {
  const ctx = await libraryHarness()
  try {
    const archived = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: 1 }, { fs: ctx.fs })
    const first = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      sha256: archived.sha256,
      capturedAt: '2026-10-12T12:25:24.000Z',
    })
    const second = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      sha256: archived.sha256,
      capturedAt: '2026-10-12T20:25:26.000Z',
    })
    assert.equal(first.deduplicated, false)
    assert.equal(second.deduplicated, true)
    assert.equal(second.dedupOfAttemptId, first.attempt.id)
    assert.equal(second.attempt.dedupOfAttemptId, first.attempt.id)
    assert.equal((await ctx.screenshots.listAttempts()).length, 2, '两次提交必须都能看到，不能假装只有一次')
    const refs = await ctx.screenshots.listRefsForAttempt(second.attempt.id)
    assert.equal(refs.length, 1)
    assert.equal(refs[0].targetKind, 'ATTEMPT')
    assert.equal(refs[0].relation, 'DEDUP_OF')
  } finally {
    ctx.close()
  }
})

test('历史来源登记是 upsert：同一 key 更新而不是新增，地址变了也不删历史', async () => {
  const ctx = await libraryHarness()
  try {
    const created = await ctx.screenshots.upsertSourceEntry({
      catalogKey: 'retained-original-vertical-21',
      title: '旧竖版课表截图（21 段）',
      archiveRelPath: '.tools/photo/retained-original.png',
      sha256: 'a'.repeat(64),
      width: 1170,
      height: 2532,
      provenance: '项目工作区保留的原始上传',
    })
    assert.equal(created.catalogKey, 'retained-original-vertical-21')
    const updated = await ctx.screenshots.upsertSourceEntry({
      catalogKey: 'retained-original-vertical-21',
      title: '旧竖版课表截图（21 段 · 周一体育）',
      archiveRelPath: '.tools/photo/retained-original.png',
      sha256: 'a'.repeat(64),
      width: 1170,
      height: 2532,
      provenance: '项目工作区保留的原始上传',
    })
    assert.equal(updated.id, created.id, '同一个 catalog_key 只能有一条')
    assert.match(updated.title, /周一体育/)
    assert.equal((await ctx.screenshots.listSources()).length, 1)

    const { attempt } = await ctx.screenshots.recordAttempt({ source: 'ARCHIVE', status: 'ARCHIVED', note: '从电脑恢复' })
    await ctx.screenshots.attachSourceAttempt('retained-original-vertical-21', attempt.id)
    assert.equal((await ctx.screenshots.getSourceByKey('retained-original-vertical-21')).foreignAttemptId, attempt.id)
  } finally {
    ctx.close()
  }
})

test('识别结果落库失败时抛出可读错误：不谎报保存成功，也不产生未处理拒绝', async () => {
  const { ScreenshotStorageError } = await import('../src/domain/screenshotLibraryRepository.ts')
  const ctx = await libraryHarness()
  try {
    const { attempt } = await ctx.screenshots.recordAttempt({ source: 'LIBRARY', status: 'ARCHIVED' })
    // 故意传入不存在的 attempt_id 触发外键失败。
    await assert.rejects(
      () =>
        ctx.screenshots.recordOcrResult({
          attemptId: attempt.id + 999,
          status: 'SUCCESS',
          candidates: [],
        }),
      (error) => error instanceof ScreenshotStorageError && /没能存进截图库/.test(error.message),
    )
    assert.equal(await ctx.screenshots.getOcrResultByAttempt(attempt.id), null)
  } finally {
    ctx.close()
  }
})

test('识别结果写入时同一事务更新尝试状态（重开库之后状态才对）', async () => {
  const ctx = await libraryHarness()
  try {
    const archived = await archiveImageBase64({ base64: TINY_PNG, format: 'png', takenAtMs: 1 }, { fs: ctx.fs })
    const { attempt } = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVED',
      archivedPath: archived.uri,
      sha256: archived.sha256,
    })
    assert.equal((await ctx.screenshots.getAttempt(attempt.id))?.status, 'ARCHIVED')
    await ctx.screenshots.recordOcrResult({ attemptId: attempt.id, status: 'FAILED', errorCode: 'NETWORK' })
    const afterFailure = await ctx.screenshots.getAttempt(attempt.id)
    assert.equal(afterFailure?.status, 'FAILED', '失败结果必须把尝试状态一起改成 FAILED')
    assert.equal(afterFailure?.errorCode, 'NETWORK')

    await ctx.screenshots.recordOcrResult({ attemptId: attempt.id, status: 'SUCCESS', candidates: [] })
    assert.equal((await ctx.screenshots.getAttempt(attempt.id))?.status, 'SUCCEEDED', '成功映射成 SUCCEEDED')
  } finally {
    ctx.close()
  }
})

test('归档失败的尝试：状态与错误原因不会被后来的识别结果覆盖', async () => {
  const ctx = await libraryHarness()
  try {
    const { attempt } = await ctx.screenshots.recordAttempt({
      source: 'LIBRARY',
      status: 'ARCHIVE_FAILED',
      errorCode: 'ARCHIVE_FAILED',
      errorMessage: '这张图没能保存到软件里：磁盘写入失败',
    })
    await ctx.screenshots.recordOcrResult({
      attemptId: attempt.id,
      status: 'FAILED',
      errorCode: 'NETWORK',
      errorMessage: '连不上服务',
    })
    const stored = await ctx.screenshots.getAttempt(attempt.id)
    assert.equal(stored?.status, 'ARCHIVE_FAILED', '「没存住」这条线索必须留着')
    assert.match(stored?.errorMessage ?? '', /磁盘写入失败/)
  } finally {
    ctx.close()
  }
})
