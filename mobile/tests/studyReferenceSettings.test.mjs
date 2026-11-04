// 每日参考用时：真实 SQLite 持久化测试。
//
// 授权书要求：用真实 SQLite 验证保存 / 读取 / 清除 / **重开数据库**、
// 脏值按「未设置」处理、被拒绝的输入一个字节都不写，并且**不动 tasks / courses**。
//
// 边界说明（不要夸大）：这里是 Node 侧 `node:sqlite`，验证 SQL 与仓库行为，
// 验证不了 iPhone 上的 expo-sqlite 原生绑定（与 tests/helpers/sqliteHarness.mjs 同一口径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyAdditiveColumns,
  courseDraft,
  readAppSettingsSql,
  readSchemaSql,
  readScreenshotLibrarySql,
  taskDraft,
  wrapDatabase,
} from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { SCHEMA_VERSION } from '../src/db/schema.ts'

const NOW = () => new Date('2026-10-15T12:00:00.000Z')
const KEY = 'pressure.daily_study_reference_minutes'

/** 打开一个真实文件库（与应用同样的 schema 版本），并返回仓库与原始连接。 */
async function openFileDatabase(file) {
  const raw = new DatabaseSync(file)
  raw.exec('PRAGMA foreign_keys = ON;')
  raw.exec(readSchemaSql())
  raw.exec(readAppSettingsSql())
  raw.exec(readScreenshotLibrarySql())
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
  applyAdditiveColumns(raw)
  const db = wrapDatabase(raw)
  const { AppSettingsRepository } = await import('../src/domain/settingsRepository.ts')
  return { raw, db, settings: new AppSettingsRepository(db, NOW) }
}

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ddl-pressure-'))
  return { dir, file: join(dir, 'settings.db') }
}

test('保存 → 读取 → 清除：只写这一个键，清除是删除而不是写 0', async () => {
  const { dir, file } = tempDbPath()
  try {
    const { raw, db, settings } = await openFileDatabase(file)
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), null, '默认必须是未设置')

    const saved = await settings.saveDailyStudyReferenceMinutes('120')
    assert.deepEqual(saved, { ok: true, minutes: 120 })
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), 120)

    const rows = raw.prepare('SELECT key, value FROM app_settings;').all()
    assert.equal(rows.length, 1, '只应该有这一个设置项')
    assert.equal(rows[0].key, KEY)
    assert.equal(String(rows[0].value), '120', '存的是十进制整数字符串')

    // 覆盖写入（UPSERT，不产生第二行）
    await settings.saveDailyStudyReferenceMinutes(90)
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), 90)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 1)

    // 空串 = 清除
    await settings.saveDailyStudyReferenceMinutes('')
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), null)
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_settings;').get().n, 0, '清除要真的删掉这一行')

    await settings.saveDailyStudyReferenceMinutes('1440')
    await settings.clearDailyStudyReferenceMinutes()
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), null)
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-pressure-')
  }
})

test('非法输入被仓库层拒绝，并且**一个字节都不写**（原值保持不变）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const { raw, db, settings } = await openFileDatabase(file)
    await settings.saveDailyStudyReferenceMinutes(120)
    const before = raw.prepare('SELECT key, value, updated_at FROM app_settings;').all()

    for (const bad of ['30.5', '1e3', '-5', '+30', '0', '1441', '30m', 'abc', 'NaN', '14401', true, [60], {}]) {
      const result = await settings.saveDailyStudyReferenceMinutes(bad)
      assert.equal(result.ok, false, `「${String(bad)}」必须被拒绝`)
      assert.match(result.reason, /1440/)
      assert.equal(await settings.loadDailyStudyReferenceMinutes(), 120, `「${String(bad)}」被拒后原值必须不变`)
    }
    const after = raw.prepare('SELECT key, value, updated_at FROM app_settings;').all()
    assert.deepEqual(after, before, '被拒绝的输入不能让设置表发生任何变化')
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-pressure-')
  }
})

test('库里存了脏值时按「未设置」处理，不抛异常、不崩', async () => {
  const { dir, file } = tempDbPath()
  try {
    const { raw, db, settings } = await openFileDatabase(file)
    for (const dirty of ['abc', '30.5', '-1', '0', '1441', '1e3', '   ']) {
      raw.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;').run(
        KEY,
        dirty,
        '2026-10-15T12:00:00.000Z',
      )
      assert.equal(await settings.loadDailyStudyReferenceMinutes(), null, `「${dirty}」应该被当成未设置`)
    }
    // 并且还能照常写入一个合法值把它修好
    assert.deepEqual(await settings.saveDailyStudyReferenceMinutes(60), { ok: true, minutes: 60 })
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), 60)
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-pressure-')
  }
})

test('重开数据库之后参考用时仍然在（模拟关掉 App 再打开）', async () => {
  const { dir, file } = tempDbPath()
  try {
    const first = await openFileDatabase(file)
    assert.deepEqual(await first.settings.saveDailyStudyReferenceMinutes(180), { ok: true, minutes: 180 })
    first.raw.close()

    const second = await openFileDatabase(file)
    assert.equal(await second.settings.loadDailyStudyReferenceMinutes(), 180, '重开之后必须读得回来')
    // 清除之后同样要跨重开生效
    await second.settings.clearDailyStudyReferenceMinutes()
    second.raw.close()

    const third = await openFileDatabase(file)
    assert.equal(await third.settings.loadDailyStudyReferenceMinutes(), null)
    third.raw.close()
  } finally {
    removeTempDir(dir, 'ddl-pressure-')
  }
})

test('保存 / 清除参考用时**不修改任何任务或课程**', async () => {
  const { dir, file } = tempDbPath()
  try {
    const { raw, db, settings } = await openFileDatabase(file)
    const { CourseRepository } = await import('../src/domain/courseRepository.ts')
    const { TaskRepository } = await import('../src/domain/taskRepository.ts')
    const courses = new CourseRepository(db, NOW)
    const tasks = new TaskRepository(db, NOW)
    const course = await courses.create(courseDraft({ name: '数据结构', code: 'CS201' }))
    const created = await tasks.create(
      taskDraft({ title: '第 3 次作业', deadline: '2026-10-16T22:00', estimatedMinutes: '120', courseId: course.id }),
    )
    assert.equal(created.committed, true)

    const snapshot = () => ({
      taskRows: raw.prepare('SELECT * FROM tasks ORDER BY id;').all(),
      courseRows: raw.prepare('SELECT * FROM courses ORDER BY id;').all(),
      taskCount: raw.prepare('SELECT COUNT(*) AS n FROM tasks;').get().n,
      courseCount: raw.prepare('SELECT COUNT(*) AS n FROM courses;').get().n,
    })
    const before = snapshot()

    await settings.saveDailyStudyReferenceMinutes(240)
    await settings.saveDailyStudyReferenceMinutes(60)
    await settings.saveDailyStudyReferenceMinutes('')
    await settings.clearDailyStudyReferenceMinutes()
    await settings.saveDailyStudyReferenceMinutes(1440)

    assert.deepEqual(snapshot(), before, '参考用时的写入不得触碰任务 / 课程（包括 updated_at）')
    assert.equal(await settings.loadDailyStudyReferenceMinutes(), 1440)
    raw.close()
  } finally {
    removeTempDir(dir, 'ddl-pressure-')
  }
})

test('参考用时不需要新的表或版本变更：仍写在 v2 的 app_settings 里', async () => {
  const { dir, file } = tempDbPath()
  const { raw, settings } = await openFileDatabase(file)
  try {
    await settings.saveDailyStudyReferenceMinutes(75)
    const version = raw.prepare('PRAGMA user_version;').get().user_version
    assert.equal(Number(version), SCHEMA_VERSION, '写入设置不能改变 schema 版本')
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;")
      .all()
      .map((row) => String(row.name))
    assert.deepEqual(
      tables,
      [
        'app_settings',
        'courses',
        'ocr_candidate_rows',
        'ocr_results',
        'schedules',
        'screenshot_attempts',
        'screenshot_refs',
        'source_screenshots',
        'task_sources',
        'tasks',
      ],
      '不应该多出任何新表',
    )
  } finally {
    raw.close()
    removeTempDir(dir, 'ddl-pressure-')
  }
})
