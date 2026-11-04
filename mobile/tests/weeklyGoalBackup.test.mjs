import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'
import {createBackupFs} from './helpers/backupFs.mjs'
import {removeTempDir} from './helpers/tempDir.mjs'
import {exportBackupToDirectory,stageBackupForPreview,restoreStagedBackup} from '../src/domain/backupService.ts'
import {parseBackupText,sealBackupData} from '../src/domain/backupFormat.ts'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {loadWeeklyGoals,saveWeeklyGoal} from '../src/domain/weeklyGoalRepository.ts'
import {WEEKLY_GOAL_KEY,emptyWeeklyGoals} from '../src/domain/weeklyGoal.ts'
test('real backup roundtrip keeps weekly targets; corrupted target rejected and old backup clears current goal',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ddl-weekly-backup-')),docs=join(root,'docs'),out=join(root,'out')
 mkdirSync(join(docs,'screenshots'),{recursive:true});mkdirSync(out)
 const f=await createTestDatabase(),fs=createBackupFs(docs),r=new AppSettingsRepository(f.db),now=()=>new Date('2026-11-02T00:00:00Z')
 try {
  const s=await saveWeeklyGoal(r,0,'2026-11-02',300,now().getTime())
  const exp=await exportBackupToDirectory(f.db,fs,pathToFileURL(out).href,{now}),parsed=await parseBackupText(await fs.readText(exp.uri))
  assert.ok(parsed.data.settings.some(x=>x.key===WEEKLY_GOAL_KEY))
  const bad=structuredClone(parsed.data);bad.settings.find(x=>x.key===WEEKLY_GOAL_KEY).value='{"version":9}'
  await assert.rejects(async()=>parseBackupText(JSON.stringify(await sealBackupData(bad,{now}))),/学习目标/)
  await saveWeeklyGoal(r,1,'2026-11-02',600,now().getTime())
  const preview=await stageBackupForPreview(f.db,fs,exp.uri,{sourceName:'goal.ddlbackup.json'})
  const restored=await restoreStagedBackup(f.db,fs,preview,{now});assert.equal(restored.committed,true,restored.reason)
  assert.deepEqual(await loadWeeklyGoals(r),s)
  const old=structuredClone(parsed.data);old.settings=old.settings.filter(x=>x.key!==WEEKLY_GOAL_KEY)
  const uri=pathToFileURL(join(out,'old.ddlbackup.json')).href
  await fs.writeText(uri,JSON.stringify(await sealBackupData(old,{now})))
  const legacy=await stageBackupForPreview(f.db,fs,uri,{sourceName:'old.ddlbackup.json'})
  assert.equal((await restoreStagedBackup(f.db,fs,legacy,{now})).committed,true)
  assert.deepEqual(await loadWeeklyGoals(r),emptyWeeklyGoals())
 }finally{f.close();removeTempDir(root,'ddl-weekly-backup-')}
})
