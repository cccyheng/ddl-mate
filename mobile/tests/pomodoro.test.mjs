import test from 'node:test'
import assert from 'node:assert/strict'
import {applyFocusAction as act,emptyFocus,decodeFocus,focusDuration,focusRemaining,focusDeadline,focusTotal,focusDayStart,focusForRestore} from '../src/domain/focusTime.ts'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {loadFocus,saveFocusAction} from '../src/domain/focusTimeRepository.ts'
import {createTestDatabase,failingRunDatabase} from './helpers/sqliteHarness.mjs'
const t=focusDayStart('2026-11-02'),minute=60000
const start={type:'start',title:'番茄专注',courseName:'数学',timer:{kind:'focus',focusMinutes:25,restMinutes:5}}
test('countdown caps at deadline after closed app, no unattended rounds, ended interval is exact',()=>{
 let s=act(emptyFocus(),start,t)
 assert.equal(focusDeadline(s.active),t+25*minute)
 assert.equal(focusRemaining(s.active,t+10*minute),15*minute)
 s=decodeFocus(JSON.stringify(s))
 assert.equal(focusDuration(s.active,t+3*86400000),25*minute)
 assert.equal(s.records.length,0)
 s=act(s,{type:'finish'},t+3*86400000)
 assert.equal(s.records[0].endedAt,t+25*minute)
 assert.equal(s.records[0].intervals[0].end,t+25*minute)
 assert.equal(focusTotal(s,t,t+86400000,t+3*86400000),25*minute)
})
test('pause excludes elapsed break; resume shifts deadline; early finish saves only actual intervals',()=>{
 let s=act(emptyFocus(),start,t)
 s=act(s,{type:'pause'},t+5*minute)
 assert.equal(focusDeadline(s.active),null);assert.equal(focusRemaining(s.active,t+3*3600000),20*minute)
 s=act(s,{type:'resume'},t+3*3600000)
 assert.equal(focusDeadline(s.active),t+3*3600000+20*minute)
 s=act(s,{type:'finish'},t+3*3600000+2*minute)
 assert.equal(focusDuration(s.records[0],t+5*3600000),7*minute)
})
test('save-and-rest atomic, rest excluded, explicit next focus uses same settings and distinct id',()=>{
 let s=act(emptyFocus(),start,t)
 s=act(s,{type:'finishAndRest'},t+30*minute)
 assert.equal(s.records.length,1);assert.equal(s.active.timer.kind,'rest');assert.equal(s.active.id,2)
 assert.equal(focusTotal(s,t,t+86400000,t+90*minute),25*minute)
 assert.equal(focusRemaining(s.active,t+90*minute),0)
 s=act(s,{type:'nextFocus'},t+90*minute)
 assert.equal(s.records.length,1);assert.equal(s.active.timer.kind,'focus');assert.equal(s.active.id,3)
 s=act(s,{type:'finish'},t+100*minute)
 assert.equal(s.records.length,2);assert.equal(focusTotal(s,t,t+86400000,t+100*minute),35*minute)
})
test('early rest end has no study record; zero countdown cannot resume; invalid timers rejected',()=>{
 let s=act(emptyFocus(),start,t);s=act(s,{type:'pause'},t+25*minute)
 assert.throws(()=>act(s,{type:'resume'},t+26*minute),/已结束/)
 s=act(s,{type:'finishAndRest'},t+26*minute);s=act(s,{type:'finish'},t+27*minute)
 assert.equal(s.records.length,1);assert.equal(s.active,null)
 for(const timer of [{kind:'rest',focusMinutes:25,restMinutes:5},{kind:'focus',focusMinutes:0,restMinutes:5},{kind:'focus',focusMinutes:181,restMinutes:5},{kind:'focus',focusMinutes:25,restMinutes:61}])assert.throws(()=>act(emptyFocus(),{...start,timer},t))
 const bad=act(emptyFocus(),start,t);bad.active.intervals=[{start:t,end:t+26*minute}];bad.active.runningSince=null
 assert.throws(()=>decodeFocus(JSON.stringify(bad)))
})
test('cross-midnight effective intervals split; restoring focus/rest preserves sealed progress and disables notifications',()=>{
 let s=act(emptyFocus(),{...start,timer:{kind:'focus',focusMinutes:2,restMinutes:5}},t-minute)
 s=act(s,{type:'finishAndRest'},t+minute)
 assert.equal(focusTotal(s,t-86400000,t,t+minute),minute);assert.equal(focusTotal(s,t,t+86400000,t+minute),minute)
 s=act(s,{type:'reminder',enabled:true},t+minute)
 s=act(s,{type:'pause'},t+2*minute);s=act(s,{type:'resume'},t+3*minute)
 const restored=decodeFocus(focusForRestore(JSON.stringify(s)))
 assert.equal(restored.active.timer.kind,'rest');assert.equal(restored.active.runningSince,null);assert.equal(restored.reminderEnabled,false)
 assert.equal(focusRemaining(restored.active,t+20*minute),4*minute)
 const legacy=emptyFocus();assert.deepEqual(decodeFocus(JSON.stringify(legacy)),legacy)
})
test('real SQLite save-and-rest failure rolls back whole transition, retry records one study session',async()=>{
 const f=await createTestDatabase();try{
  const repo=new AppSettingsRepository(f.db);let s=await saveFocusAction(repo,0,start,t)
  const broken=new AppSettingsRepository(failingRunDatabase(f.db,(_,sql)=>sql.includes('INSERT INTO app_settings')))
  await assert.rejects(saveFocusAction(broken,s.revision,{type:'finishAndRest'},t+25*minute))
  assert.deepEqual(await loadFocus(repo),s)
  s=await saveFocusAction(repo,s.revision,{type:'finishAndRest'},t+25*minute)
  await assert.rejects(saveFocusAction(repo,s.revision-1,{type:'finishAndRest'},t+25*minute),/已更新/)
  assert.deepEqual(await loadFocus(new AppSettingsRepository(f.db)),s);assert.equal(s.records.length,1)
 }finally{f.close()}
})
