import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyFocus,applyFocusAction as act,focusDayStart,focusTotal,decodeFocus} from '../src/domain/focusTime.ts'
import {historyDrafts,historyIntervals} from '../src/domain/focusHistory.ts'
import {emptyWeeklyGoals,changeWeeklyGoal,weeklyGoalProgress} from '../src/domain/weeklyGoal.ts'
import {loadFocus,saveFocusAction} from '../src/domain/focusTimeRepository.ts'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'
const t=focusDayStart('2026-11-02'),now=t+12*3600000
const save=(intervals,extra={})=>({type:'historySave',title:'复习',courseName:'数学',intervals,...extra})
test('manual history inserts chronologically, stable IDs, clipped week totals and correction/delete update goals',()=>{
 let s=act(emptyFocus(),save([{start:t+3600000,end:t+7200000}]),now)
 s=act(s,save([{start:t-60000,end:t+60000}]),now)
 assert.deepEqual(s.records.map(r=>r.id),[2,1]);assert.equal(s.records[0].history.kind,'manual')
 assert.equal(focusTotal(s,t-7*86400000,t,now),60000)
 const g=changeWeeklyGoal(emptyWeeklyGoals(),'2026-11-02',60,now)
 assert.equal(weeklyGoalProgress(g,s,'2026-11-02',now).percent,100)
 s=act(s,save([{start:t+3600000,end:t+4500000}],{id:1}),now)
 assert.equal(s.records[1].history.kind,'corrected');assert.equal(weeklyGoalProgress(g,s,'2026-11-02',now).percent,26)
 s=act(s,{type:'historyDelete',id:2},now)
 assert.equal(weeklyGoalProgress(g,s,'2026-11-02',now).percent,25)
 s=act(s,save([{start:t+7200000,end:t+7260000}]),now)
 assert.equal(s.records[1].id,3);assert.equal(s.nextId,4)
})
test('history refuses future, empty, reversed, overlapping, excessive intervals and active mutations',()=>{
 let s=act(emptyFocus(),save([{start:t,end:t+60000},{start:t+120000,end:t+180000}]),now)
 for(const intervals of [[],[{start:now,end:now+1}],[{start:t,end:t}],[{start:t+300000,end:t+299999}],[{start:t-86400000,end:t-1}],[{start:t+60000,end:t+120000}],[{start:t+200000,end:t+300000},{start:t+299999,end:t+400000}]])assert.throws(()=>act(s,save(intervals),now))
 assert.throws(()=>act(s,{type:'historyDelete',id:99},now),/不存在/)
 s=act(s,{type:'start',title:'进行中',courseName:''},now)
 assert.throws(()=>act(s,save([{start:t-60000,end:t}]),now),/先结束/)
 assert.throws(()=>act(s,{type:'historyDelete',id:1},now),/先结束/)
})
test('unchanged editor fields preserve seconds and pauses; changed time strips timer cap without counting gaps',()=>{
 let s=act(emptyFocus(),{type:'start',title:'原记录',courseName:'',timer:{kind:'focus',focusMinutes:5,restMinutes:1}},t+1234)
 s=act(s,{type:'pause'},t+61234);s=act(s,{type:'resume'},t+121234);s=act(s,{type:'finish'},t+181234)
 const original=s.records[0],drafts=historyDrafts(original.intervals)
 assert.deepEqual(historyIntervals(drafts),original.intervals)
 // Field order is irrelevant: imported backups may serialize interval properties differently.
 s=act(s,save(historyIntervals(drafts).map(i=>({end:i.end,start:i.start})),{id:1,title:'改名'}),now)
 assert.deepEqual(s.records[0].intervals,original.intervals);assert.deepEqual(s.records[0].timer,original.timer)
 assert.equal(focusTotal(s,t,t+86400000,now),120000)
 s=act(s,save([{start:t,end:t+600000}],{id:1}),now)
 assert.equal(s.records[0].timer,undefined);assert.equal(focusTotal(s,t,t+86400000,now),600000)
 assert.throws(()=>historyIntervals([{start:'2026-02-30T10:00',end:'2026-03-01T10:00'}]),/无效/)
 const corrupted=JSON.parse(JSON.stringify(s));corrupted.records[0].history.kind='automatic';assert.throws(()=>decodeFocus(JSON.stringify(corrupted)))
})
test('real SQLite history mutations enforce revision and failed write retries atomically',async()=>{
 const f=await createTestDatabase(),r=new AppSettingsRepository(f.db)
 try {
  let s=await saveFocusAction(r,0,save([{start:t,end:t+60000}]),now)
  await assert.rejects(saveFocusAction(r,0,{type:'historyDelete',id:1},now),/已更新/)
  const bad={get:r.get.bind(r),set:async()=>{throw Error('写入失败')}}
  await assert.rejects(saveFocusAction(bad,s.revision,{type:'historyDelete',id:1},now),/写入失败/)
  assert.equal((await loadFocus(r)).records.length,1)
  s=await saveFocusAction(r,s.revision,{type:'historyDelete',id:1},now)
  assert.equal(s.records.length,0);assert.equal(s.nextId,2)
 }finally{f.close()}
})
