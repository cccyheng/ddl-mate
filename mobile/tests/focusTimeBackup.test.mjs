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
import {loadFocus,saveFocusAction} from '../src/domain/focusTimeRepository.ts'
import {FOCUS_KEY,emptyFocus} from '../src/domain/focusTime.ts'

for (const timer of [undefined, {kind:'focus',focusMinutes:25,restMinutes:5}]) test(`real backup roundtrip preserves ${timer ? 'pomodoro' : 'elapsed'} history, pauses active, refuses corruption; old backups still restore`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'ddl-focus-backup-')),docs=join(root,'docs'),out=join(root,'out')
  mkdirSync(join(docs,'screenshots'),{recursive:true});mkdirSync(out)
  const f=await createTestDatabase(),fs=createBackupFs(docs),repo=new AppSettingsRepository(f.db),now=()=>new Date('2026-11-01T00:00:00Z'),t=now().getTime()
  try {
    let s=await saveFocusAction(repo,0,{type:'start',title:'复习',courseName:'数学',...(timer?{timer}:{})},t-60000)
    s=await saveFocusAction(repo,s.revision,{type:'finish'},t-30000)
    s=await saveFocusAction(repo,s.revision,{type:'start',title:'下一段',courseName:'',...(timer?{timer}:{})},t-20000)
    s=await saveFocusAction(repo,s.revision,{type:'pause'},t-10000)
    s=await saveFocusAction(repo,s.revision,{type:'resume'},t-5000)
    if(timer)s=await saveFocusAction(repo,s.revision,{type:'reminder',enabled:true},t)
    const exported=await exportBackupToDirectory(f.db,fs,pathToFileURL(out).href,{now})
    const parsed=await parseBackupText(await fs.readText(exported.uri))
    assert.ok(parsed.data.settings.some(x=>x.key===FOCUS_KEY))
    const bad=structuredClone(parsed.data);bad.settings.find(x=>x.key===FOCUS_KEY).value='{"version":999}'
    await assert.rejects(async()=>parseBackupText(JSON.stringify(await sealBackupData(bad,{now}))),/专注/)
    const preview=await stageBackupForPreview(f.db,fs,exported.uri,{sourceName:'focus.ddlbackup.json'})
    const outcome=await restoreStagedBackup(f.db,fs,preview,{now});assert.equal(outcome.committed,true,outcome.reason)
    const restored=await loadFocus(repo)
    assert.deepEqual(restored.records,s.records);assert.deepEqual(restored.active.intervals,s.active.intervals)
    assert.equal(restored.active.runningSince,null);assert.equal(restored.revision,s.revision+1)
    if(timer){assert.deepEqual(restored.active.timer,timer);assert.equal(restored.reminderEnabled,false)}
    const legacy=structuredClone(parsed.data);legacy.settings=legacy.settings.filter(x=>x.key!==FOCUS_KEY)
    const uri=pathToFileURL(join(out,'legacy.ddlbackup.json')).href
    await fs.writeText(uri,JSON.stringify(await sealBackupData(legacy,{now})))
    const old=await stageBackupForPreview(f.db,fs,uri,{sourceName:'legacy.ddlbackup.json'})
    const result=await restoreStagedBackup(f.db,fs,old,{now});assert.equal(result.committed,true,result.reason)
    assert.deepEqual(await loadFocus(repo),emptyFocus())
  }finally{f.close();removeTempDir(root,'ddl-focus-backup-')}
})
