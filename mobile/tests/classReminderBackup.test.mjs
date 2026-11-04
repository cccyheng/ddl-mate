import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTestDatabase, courseDraft, scheduleDraft, taskDraft } from './helpers/sqliteHarness.mjs'
import { createBackupFs } from './helpers/backupFs.mjs'
import { removeTempDir } from './helpers/tempDir.mjs'
import { exportBackupToDirectory, restoreStagedBackup, stageBackupForPreview } from '../src/domain/backupService.ts'
import { parseBackupText } from '../src/domain/backupFormat.ts'
import { CLASS_REMINDER_KEY, decodeClassReminderSettings } from '../src/domain/classReminder.ts'

for (const old of [false, true]) test(old ? 'restoring old backup removes newer class reminder opt-in' : 'real class reminder backup retains lead but restores OFF; courses/tasks unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ddl-class-backup-')), docs = join(root, 'docs'), output = join(root, 'output')
  mkdirSync(docs); mkdirSync(output); mkdirSync(join(docs, 'screenshots'))
  const c = await createTestDatabase(), fs = createBackupFs(docs), now = () => new Date('2026-10-26T01:00:00Z')
  const set = () => c.db.runAsync('INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)', [CLASS_REMINDER_KEY, JSON.stringify({ version: 1, enabled: true, leadMinutes: 15 }), now().toISOString()])
  try {
    await c.courses.create(courseDraft()); await c.tasks.create(taskDraft())
    const beforeCourses = await c.courses.listAll(), beforeTasks = await c.tasks.listAll()
    if (!old) await set()
    const exported = await exportBackupToDirectory(c.db, fs, pathToFileURL(output).href, { now })
    const parsed = await parseBackupText(await fs.readText(exported.uri))
    assert.equal(parsed.data.settings.some(x => x.key === CLASS_REMINDER_KEY), !old)
    if (old) await set()
    const preview = await stageBackupForPreview(c.db, fs, exported.uri, { sourceName: 'class.ddlbackup.json' })
    const restored = await restoreStagedBackup(c.db, fs, preview, { now })
    assert.equal(restored.committed, true)
    const row = await c.db.getFirstAsync('SELECT value FROM app_settings WHERE key=?', [CLASS_REMINDER_KEY])
    assert.equal(decodeClassReminderSettings(row?.value ?? null).enabled, false)
    if (!old) assert.equal(decodeClassReminderSettings(row.value).leadMinutes, 15)
    else assert.equal(row, null)
    assert.deepEqual(await c.courses.listAll(), beforeCourses); assert.deepEqual(await c.tasks.listAll(), beforeTasks)
  } finally { c.close(); removeTempDir(root, 'ddl-class-backup-') }
})
