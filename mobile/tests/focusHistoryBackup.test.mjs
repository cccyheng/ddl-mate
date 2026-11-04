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
import {FOCUS_KEY} from '../src/domain/focusTime.ts'
test('real backup preserves manual/corrected provenance and restores legacy records without provenance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ddl-history-backup-')),docs=join(root,'docs'),out=join(root,'out')
 mkdirSync(join(docs,'screenshots'),{recursive:true});mkdirSync(out)
 const f=await createTestDatabase(),fs=createBackupFs(docs),r=new AppSettingsRepository(f.db),now=()=>new Date('2026-11-02T00:00:00Z'),t=now().getTime()
 try {
  let s=await saveFocusAction(r,0,{type:'historySave',title:'补记',courseName:'',intervals:[{start:t-3600000,end:t-3000000}]},t)
  s=await saveFocusAction(r,s.revision,{type:'historySave',title:'纠错',courseName:'',intervals:[{start:t-2400000,end:t-1800000}]},t)
  s=await saveFocusAction(r,s.revision,{type:'historySave',id:2,title:'纠错',courseName:'',intervals:[{start:t-2400000,end:t-1200000}]},t)
  const exp=await exportBackupToDirectory(f.db,fs,pathToFileURL(out).href,{now}),parsed=await parseBackupText(await fs.readText(exp.uri))
  const preview=await stageBackupForPreview(f.db,fs,exp.uri,{sourceName:'history.ddlbackup.json'})
  assert.equal((await restoreStagedBackup(f.db,fs,preview,{now})).committed,true)
  assert.deepEqual((await loadFocus(r)).records,s.records)
  const old=structuredClone(parsed.data),setting=old.settings.find(x=>x.key===FOCUS_KEY),state=JSON.parse(setting.value)
  state.records.forEach(x=>delete x.history);setting.value=JSON.stringify(state)
  const uri=pathToFileURL(join(out,'legacy.ddlbackup.json')).href;await fs.writeText(uri,JSON.stringify(await sealBackupData(old,{now})))
  const legacy=await stageBackupForPreview(f.db,fs,uri,{sourceName:'legacy.ddlbackup.json'})
  assert.equal((await restoreStagedBackup(f.db,fs,legacy,{now})).committed,true)
  assert.ok((await loadFocus(r)).records.every(x=>x.history===undefined))
 }finally{f.close();removeTempDir(root,'ddl-history-backup-')}
})
