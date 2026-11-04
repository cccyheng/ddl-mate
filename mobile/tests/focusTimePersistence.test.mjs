import test from 'node:test'
import assert from 'node:assert/strict'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {wrapDatabase,readAppSettingsSql} from './helpers/sqliteHarness.mjs'
import {removeTempDir} from './helpers/tempDir.mjs'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {loadFocus,saveFocusAction} from '../src/domain/focusTimeRepository.ts'
import {focusDuration,focusDayStart} from '../src/domain/focusTime.ts'

test('close and reopen real on-disk SQLite retains running and paused timers plus completed records',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ddl-focus-disk-')),path=join(root,'test.sqlite'),t=focusDayStart('2026-11-01')
 let raw=new DatabaseSync(path)
 try{
  raw.exec(readAppSettingsSql())
  let repo=new AppSettingsRepository(wrapDatabase(raw))
  await saveFocusAction(repo,0,{type:'start',title:'数据库关闭重开',courseName:''},t)
  raw.close();raw=new DatabaseSync(path);repo=new AppSettingsRepository(wrapDatabase(raw))
  let s=await loadFocus(repo);assert.equal(focusDuration(s.active,t+60000),60000)
  await saveFocusAction(repo,s.revision,{type:'pause'},t+60000)
  raw.close();raw=new DatabaseSync(path);repo=new AppSettingsRepository(wrapDatabase(raw))
  s=await loadFocus(repo);assert.equal(s.active.runningSince,null)
  assert.equal(focusDuration(s.active,t+3600000),60000)
  s=await saveFocusAction(repo,s.revision,{type:'finish'},t+3600000)
  raw.close();raw=new DatabaseSync(path);repo=new AppSettingsRepository(wrapDatabase(raw))
  assert.deepEqual(await loadFocus(repo),s);assert.equal(s.records.length,1)
 }finally{raw.close();removeTempDir(root,'ddl-focus-disk-')}
})
