/**
 * 便携备份 / 恢复的**真实 SQLite + 真实临时磁盘**往返测试。
 *
 * 只用系统临时目录里的数据库和图片，绝不读取用户真实手机数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createTestDatabase, taskDraft, courseDraft, scheduleDraft } from './helpers/sqliteHarness.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import {
  discardBackupStaging,
  exportBackupToDirectory,
  listRecoveryBackups,
  restoreStagedBackup,
  saveRecoveryBackupToDirectory,
  stageBackupForPreview,
} from '../src/domain/backupService.ts'
import { parseBackupText } from '../src/domain/backupFormat.ts'
import { AppSettingsRepository } from '../src/domain/settingsRepository.ts'
import { TaskStepsRepository } from '../src/domain/taskStepsRepository.ts'
import { TaskReminderRepository } from '../src/domain/taskReminderRepository.ts'
import { TaskReminderNotificationReceiptsRepository } from '../src/domain/taskReminderNotificationReceiptsRepository.ts'
import { TodayPlanRepository } from '../src/domain/todayPlanRepository.ts'
import { buildTodayPlan, todayPlanFingerprint, validateStudyWindows } from '../src/domain/todayPlan.ts'
import { decodeTaskReminder } from '../src/domain/taskReminder.ts'
import { sha256HexOfBase64 } from '../src/domain/hashing.ts'

const NOW = new Date('2026-10-08T04:00:00.000Z') // 上海 12:00
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII='

function tempRoot(prefix = 'ddl-backup-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const docs = join(root, 'docs')
  mkdirSync(join(docs, 'screenshots'), { recursive: true })
  return { root, docs }
}

function sha(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function writeImage(docs, name, bytes) {
  const file = join(docs, 'screenshots', name)
  writeFileSync(file, bytes)
  return {
    uri: pathToFileURL(file).href,
    sha256: sha(bytes),
    byteLength: bytes.length,
    base64: bytes.toString('base64'),
  }
}

function snapshot(raw) {
  const tables = [
    'courses',
    'schedules',
    'tasks',
    'task_sources',
    'screenshot_attempts',
    'source_screenshots',
    'screenshot_refs',
    'ocr_results',
    'ocr_candidate_rows',
  ]
  const result = {}
  for (const table of tables) result[table] = raw.prepare(`SELECT * FROM ${table} ORDER BY id ASC;`).all()
  result.app_settings = raw.prepare('SELECT key, value, updated_at FROM app_settings ORDER BY key ASC;').all()
  return result
}

async function seed(ctx, docs) {
  const settings = new AppSettingsRepository(ctx.db, () => NOW)
  const course = await ctx.courses.create(
    courseDraft({
      code: 'CS201',
      name: '数据结构',
      instructor: '王老师',
      semester: '2026 秋',
      color: '#b4573a',
      note: '周三实验课',
      selectionSerial: '9913000172.08',
    }),
  )
  const scheduleAll = await ctx.courses.createSchedule(
    course.id,
    scheduleDraft({ weekday: 4, startTime: '08:00', endTime: '09:40', weekPattern: 'ALL', startWeek: '1', endWeek: '16' }),
  )
  await ctx.courses.createSchedule(
    course.id,
    scheduleDraft({ weekday: 2, startTime: '10:00', endTime: '11:40', weekPattern: 'ODD', startWeek: '3', endWeek: '15' }),
  )

  const t1 = await ctx.tasks.create(
    taskDraft({
      title: '数据结构第 3 次作业',
      description: '写实验报告',
      courseId: course.id,
      type: 'HOMEWORK',
      status: 'TODO',
      priority: 4,
      deadline: '2026-12-31',
      estimatedMinutes: '120',
      submitRequirement: 'PDF + 源码',
      submitMethod: '教学平台',
      originalText: '【原始通知】\n第 3 次作业，12 月 31 日前提交。',
    }),
  )
  const t2 = await ctx.tasks.create(
    taskDraft({
      title: '线性代数作业',
      courseId: null,
      deadline: '2026-11-01T23:59',
      estimatedMinutes: '90',
      originalText: '',
    }),
  )
  // 直接写一个带秒的 DDL，验证恢复保留精确精度而不是只保留到分钟。
  ctx.raw
    .prepare('UPDATE tasks SET deadline = ?, updated_at = ? WHERE id = ?;')
    .run('2026-11-01T23:59:30+08:00', NOW.toISOString(), t2.id)
  await ctx.tasks.appendOriginalText(t1.id, '追加：老师补充说明，允许迟交一天。')

  const steps = new TaskStepsRepository(ctx.db, ctx.tasks, () => NOW)
  const reminders = new TaskReminderRepository(ctx.db, ctx.tasks, () => NOW)
  ctx.tasks.setRemoveCleanup(async (taskId) => {
    await steps.removeStepsForTask(taskId)
    await reminders.removeReminderForTask(taskId)
  })
  const stepsSaved = await steps.saveSteps({
    taskId: t1.id,
    steps: [
      { id: 's1', title: '读题', done: true },
      { id: 's2', title: '写代码', done: false },
    ],
    expectedRevision: 0,
  })
  assert.equal(stepsSaved.committed, true)
  const enabledReminder = await reminders.saveReminder({
    taskId: t2.id,
    enabled: true,
    leadMinutes: 1440,
    expectedRevision: 0,
  })
  assert.equal(enabledReminder.committed, true, enabledReminder.reason ?? '提醒应可保存')
  const disabledReminder = await reminders.saveReminder({
    taskId: t1.id,
    enabled: false,
    leadMinutes: 180,
    expectedRevision: 0,
  })
  assert.equal(disabledReminder.committed, true, disabledReminder.reason ?? '关闭的提醒也应保存')

  const calibration = await settings.saveTeachingWeekCalibration({ today: '2026-10-08', currentWeek: 5 })
  assert.equal(calibration.ok, true)
  assert.equal((await settings.saveDailyStudyReferenceMinutes(120)).ok, true)
  await settings.saveOcrEndpoint('http://192.168.1.9:8082')

  // 已消费回执是设备专属状态：导出应排除，恢复后不应带回旧 token。
  const receipts = new TaskReminderNotificationReceiptsRepository(ctx.db, () => NOW)
  const receipt = await receipts.recordConsumption({
    version: 1,
    token: 'old-device-receipt-token',
    taskId: t2.id,
    identifier: 'ddlmate.task-reminder.v1.2',
    deliveryDate: NOW.getTime(),
    evidence: 'old-evidence',
    actionIdentifier: 'default',
    consumedAt: NOW.toISOString(),
  })
  assert.equal(receipt.ok, true, receipt.reason ?? '回执应可写入')

  // 今日计划：只有显式采用才写入，与真实界面同一套纯函数。
  const context = {
    tasks: await ctx.tasks.listAll(),
    schedules: await ctx.courses.listSchedules(),
    courses: await ctx.courses.listAll(),
  }
  const windows = [{ start: '13:00', end: '14:00' }]
  const selections = [{ taskId: t2.id, minutes: 30 }]
  const validation = validateStudyWindows(windows)
  assert.equal(validation.ok, true)
  const preview = {
    fingerprint: todayPlanFingerprint({ date: '2026-10-08', windows: validation.windows, selections, context }),
    plan: buildTodayPlan({
      date: '2026-10-08',
      now: NOW,
      windows,
      selections,
      tasks: context.tasks,
      schedules: context.schedules,
      courses: context.courses,
    }),
  }
  const plans = new TodayPlanRepository(ctx.db, async () => context, () => NOW)
  const savedPlan = await plans.saveTodayPlan({
    date: '2026-10-08',
    windows,
    selections,
    previewPlan: preview.plan,
    expectedRevision: 0,
  })
  assert.equal(savedPlan.committed, true, savedPlan.reason ?? '计划应可保存')

  // 两张不同字节的图：第一张提交两次（去重历史），第二张为不同内容。
  const pngBytes = Buffer.from(TINY_PNG, 'base64')
  const variantBytes = Buffer.concat([pngBytes, Buffer.from([0])])
  const imageA = writeImage(docs, 'one.png', pngBytes)
  const imageB = writeImage(docs, 'two.png', variantBytes)
  const attemptA = await ctx.screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    capturedAt: '2026-10-01T10:00:00.000Z',
    archivedPath: imageA.uri,
    sha256: imageA.sha256,
    byteLength: imageA.byteLength,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
    note: '第一张',
  })
  const attemptADup = await ctx.screenshots.recordAttempt({
    source: 'LIBRARY',
    status: 'ARCHIVED',
    capturedAt: '2026-10-02T10:00:00.000Z',
    archivedPath: imageA.uri,
    sha256: imageA.sha256,
    byteLength: imageA.byteLength,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
    note: '同一张再次提交',
  })
  const attemptB = await ctx.screenshots.recordAttempt({
    source: 'CAMERA',
    status: 'ARCHIVED',
    capturedAt: '2026-10-03T10:00:00.000Z',
    archivedPath: imageB.uri,
    sha256: imageB.sha256,
    byteLength: imageB.byteLength,
    width: 1,
    height: 1,
    format: 'png',
    mimeType: 'image/png',
  })
  await ctx.screenshots.recordAttempt({
    source: 'CAMERA',
    status: 'ARCHIVE_FAILED',
    capturedAt: '2026-10-04T10:00:00.000Z',
    errorCode: 'ARCHIVE_FAILED',
    errorMessage: '测试：没有落盘',
  })

  const ocr = await ctx.screenshots.recordOcrResult({
    attemptId: attemptA.attempt.id,
    status: 'SUCCESS',
    requestId: 'ocr-1',
    layout: 'table-grid',
    week: 5,
    warnings: ['测试警告'],
    payload: { rawText: 'ocr raw', candidates: [] },
    rawText: 'ocr raw',
    ocrCalls: 1,
    durationMs: 123,
    image: { width: 1, height: 1, format: 'png', bytes: imageA.byteLength },
    candidates: [
      {
        rowIndex: 0,
        name: '数据结构',
        weekday: 4,
        startTime: '08:00',
        endTime: '09:40',
        location: '教三 305',
        startWeek: 1,
        endWeek: 16,
        weekPattern: 'ALL',
        selectionSerial: '9913000172.08',
        rawText: '数据结构 08:00-09:40',
        warnings: ['候选警告'],
        imported: true,
      },
    ],
  })
  assert.ok(ocr)
  await ctx.screenshots.linkRef({
    attemptId: attemptA.attempt.id,
    targetKind: 'COURSE',
    targetId: course.id,
    relation: 'IMPORTED_COURSE',
  })
  await ctx.screenshots.linkRef({
    attemptId: attemptA.attempt.id,
    targetKind: 'SCHEDULE',
    targetId: scheduleAll.id,
    relation: 'IMPORTED_SCHEDULE',
  })
  await ctx.screenshots.linkRef({
    attemptId: attemptA.attempt.id,
    targetKind: 'TASK',
    targetId: t1.id,
    relation: 'SOURCE',
  })
  await ctx.screenshots.upsertSourceEntry({
    catalogKey: 'fixture-source',
    title: '历史截图（测试）',
    description: '只用于临时夹具',
    archiveRelPath: '.tools/photo/fixture.png',
    sha256: 'a'.repeat(64),
    byteLength: 123,
    width: 10,
    height: 20,
    layout: 'table-grid',
    capturedAt: '2026-10-01T00:00:00.000Z',
    provenance: 'test',
  })

  return {
    course,
    t1,
    t2,
    imageA,
    imageB,
    attemptA,
    attemptADup,
    attemptB,
    original: snapshot(ctx.raw),
  }
}

function normalizeAttempts(rows) {
  return rows.map((row) => {
    const { archived_path: _archived, original_uri: _original, ...rest } = row
    return rest
  })
}

async function assertRestored(ctx, original, expectedEndpoint) {
  const after = snapshot(ctx.raw)
  for (const table of [
    'courses',
    'schedules',
    'tasks',
    'task_sources',
    'source_screenshots',
    'screenshot_refs',
    'ocr_results',
    'ocr_candidate_rows',
  ]) {
    assert.deepEqual(after[table], original[table], `${table} 应逐字段恢复`)
  }
  assert.deepEqual(
    normalizeAttempts(after.screenshot_attempts),
    normalizeAttempts(original.screenshot_attempts),
    '截图行除本机路径 / 原始 URI 外应逐字段恢复',
  )
  for (const attempt of after.screenshot_attempts) {
    assert.equal(attempt.original_uri, null, '不把旧设备的原始 URI 带进恢复后的数据')
    if (attempt.archived_path) {
      const base64 = readFileSync(fileURLToPath(attempt.archived_path)).toString('base64')
      assert.equal(await sha256HexOfBase64(base64), attempt.sha256, '恢复后文件字节必须与登记哈希一致')
    }
  }

  const originalSettings = new Map(original.app_settings.map((row) => [row.key, row]))
  const afterSettings = new Map(after.app_settings.map((row) => [row.key, row]))
  assert.equal(afterSettings.has('task_reminder.notification_receipts.v1'), false, '不复制旧的通知回执')
  assert.equal(afterSettings.get('photo_ocr.companion_endpoint')?.value, expectedEndpoint, '保留当前设备的 OCR 地址')
  for (const [key, row] of originalSettings) {
    if (
      key === 'photo_ocr.companion_endpoint' ||
      key === 'task_reminder.notification_receipts.v1' ||
      key.startsWith('task_reminder.')
    ) {
      continue
    }
    assert.equal(afterSettings.get(key)?.value, row.value, `设置 ${key} 应原样恢复`)
  }
  for (const row of original.app_settings) {
    if (!row.key.startsWith('task_reminder.') || row.key === 'task_reminder.notification_receipts.v1') continue
    const taskId = Number(row.key.slice('task_reminder.'.length))
    const before = decodeTaskReminder(row.value, taskId)
    const afterReminder = decodeTaskReminder(afterSettings.get(row.key)?.value, taskId)
    assert.equal(before.ok, true)
    assert.equal(afterReminder.ok, true)
    assert.equal(afterReminder.intent.enabled, false, '恢复后提醒必须明确关闭')
    assert.equal(afterReminder.intent.leadMinutes, before.intent.leadMinutes, '保留用户选的提前量')
    assert.equal(afterReminder.intent.revision, before.intent.revision + 1, '关闭动作要产生新修订号')
  }
  return after
}

test('往返：任务/课表/原文/截图字节/关联/设置/步骤/计划逐字段恢复，并保留恢复备份', async () => {
  const { root, docs } = tempRoot()
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  try {
    const seeded = await seed(ctx, docs)
    const exported = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
    assert.equal(exported.counts.tasks, 2)
    assert.equal(exported.counts.courses, 1)
    assert.equal(exported.counts.schedules, 2)
    assert.equal(exported.counts.images, 2, '同一份图片字节只嵌入一次')
    assert.equal(exported.counts.attempts, 4)
    assert.equal(exported.counts.refs, seeded.original.screenshot_refs.length)
    assert.equal(exported.format, 'ddlmate.native-backup')
    assert.equal(exported.version, 1)
    assert.ok(exported.byteLength > 0)
    const text = fs.readText(exported.uri)
    assert.ok((await text).includes('【原始通知】'), '备份文件里必须有原始通知文本')

    // 导出后改动当前数据：新增任务 + 改标题 + 改设置 + 改本机地址。
    const extra = await ctx.tasks.create(taskDraft({ title: '导出之后新增的任务' }))
    await ctx.tasks.update(
      seeded.t1.id,
      taskDraft({
        title: '被改过的标题',
        courseId: seeded.course.id,
        deadline: '2026-12-31',
        originalText: '',
      }),
    )
    const settings = new AppSettingsRepository(ctx.db, () => NOW)
    await settings.saveDailyStudyReferenceMinutes(30)
    await settings.clearTeachingWeekCalibration()
    const currentEndpoint = 'http://10.0.0.7:9999'
    await settings.saveOcrEndpoint(currentEndpoint)

    const preview = await stageBackupForPreview(ctx.db, fs, exported.uri, { sourceName: 'roundtrip.ddlbackup.json' })
    assert.equal(preview.isEmpty, false)
    assert.equal(preview.counts.tasks, 2)
    assert.equal(preview.counts.images, 2)
    assert.equal(preview.sourceName, 'roundtrip.ddlbackup.json')
    assert.equal(JSON.stringify(preview.counts), JSON.stringify(exported.counts))

    const restored = await restoreStagedBackup(ctx.db, fs, preview, { now: () => NOW })
    assert.equal(restored.committed, true, restored.committed ? '' : restored.reason)
    assert.ok(restored.recoveryBackup)
    assert.equal(restored.refreshError, null)

    const after = await assertRestored(ctx, seeded.original, currentEndpoint)
    assert.equal(after.tasks.some((row) => row.id === extra.id), false, '恢复必须删除导出之后新增的任务')
    assert.equal(after.tasks.find((row) => row.id === seeded.t1.id).title, '数据结构第 3 次作业')
    assert.equal(after.tasks.find((row) => row.id === seeded.t2.id).deadline, '2026-11-01T23:59:30+08:00')
    assert.equal(after.tasks.find((row) => row.id === seeded.t1.id).deadline, '2026-12-31')
    assert.equal(after.task_sources.length, seeded.original.task_sources.length)
    assert.ok(after.task_sources.some((row) => row.raw_text === '【原始通知】\n第 3 次作业，12 月 31 日前提交。'))
    assert.ok(after.task_sources.some((row) => row.raw_text === '追加：老师补充说明，允许迟交一天。'))

    const recoveryFiles = await listRecoveryBackups(fs)
    assert.equal(recoveryFiles.length, 1)
    const recoveryParsed = await parseBackupText(await fs.readText(recoveryFiles[0].uri))
    assert.ok(recoveryParsed.data.tasks.some((row) => row.id === extra.id), '恢复备份必须保存恢复前的当前数据')
    assert.ok(recoveryParsed.data.tasks.some((row) => row.title === '被改过的标题'))
    const saveDir = join(root, 'saved')
    mkdirSync(saveDir, { recursive: true })
    const saved = await saveRecoveryBackupToDirectory(fs, recoveryFiles[0].fileName, pathToFileURL(saveDir).href)
    assert.deepEqual(
      readFileSync(fileURLToPath(saved.uri)),
      readFileSync(fileURLToPath(recoveryFiles[0].uri)),
      '恢复备份保存到另一个目录后字节不变',
    )
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-')
  }
})

test('空备份：预览明确标记 empty，恢复后只保留本机 OCR 地址并清空数据', async () => {
  const { root, docs } = tempRoot('ddl-backup-empty-')
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  try {
    const exported = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
    assert.equal(exported.counts.tasks, 0)
    assert.equal(exported.counts.images, 0)

    const settings = new AppSettingsRepository(ctx.db, () => NOW)
    await settings.saveOcrEndpoint('http://127.0.0.1:8082')
    await ctx.tasks.create(taskDraft({ title: '空备份之前的任务' }))
    // 预览必须在当前数据最后一次改动之后；否则过期预览会被正确拒绝。
    const preview = await stageBackupForPreview(ctx.db, fs, exported.uri)
    assert.equal(preview.isEmpty, true)

    const restored = await restoreStagedBackup(ctx.db, fs, preview, { now: () => NOW })
    assert.equal(restored.committed, true, restored.committed ? '' : restored.reason)
    const after = snapshot(ctx.raw)
    assert.equal(after.tasks.length, 0)
    assert.equal(after.courses.length, 0)
    assert.equal(after.schedules.length, 0)
    assert.equal(after.screenshot_attempts.length, 0)
    const settingsMap = new Map(after.app_settings.map((row) => [row.key, row.value]))
    assert.equal(settingsMap.get('photo_ocr.companion_endpoint'), 'http://127.0.0.1:8082')
    assert.equal(settingsMap.get('notification.route_generation'), '1')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-empty-')
  }
})

test('取消预览：只删除本次唯一暂存目录，数据库一个字节都不动', async () => {
  const { root, docs } = tempRoot('ddl-backup-cancel-')
  const ctx = await createTestDatabase()
  const fs = createBackupFs(docs)
  const systemDir = join(root, 'system')
  mkdirSync(systemDir, { recursive: true })
  try {
    await ctx.tasks.create(taskDraft({ title: '取消预览前的任务' }))
    const exported = await exportBackupToDirectory(ctx.db, fs, pathToFileURL(systemDir).href, { now: () => NOW })
    const before = snapshot(ctx.raw)
    const preview = await stageBackupForPreview(ctx.db, fs, exported.uri)
    assert.equal(await fs.exists(preview.stageDir), true)
    assert.deepEqual(snapshot(ctx.raw), before, '预览不写数据库')
    await discardBackupStaging(fs, preview.stageDir)
    assert.equal(await fs.exists(preview.stageDir), false)
    assert.deepEqual(snapshot(ctx.raw), before, '取消只清理暂存目录')
  } finally {
    ctx.close()
    removeTempDir(root, 'ddl-backup-cancel-')
  }
})
