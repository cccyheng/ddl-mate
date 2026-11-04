import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {loadFocus,saveFocusAction} from '../src/domain/focusTimeRepository.ts'
const source=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8')
const start=source.indexOf('      focusTime: {'),end=source.indexOf('      examRevision:',start)
assert.ok(start>0&&end>start)
async function fixture(){
  const f=await createTestDatabase(),repos={settings:new AppSettingsRepository(f.db)}
  const h={gate:false,queue:Promise.resolve(),generation:{current:0},reminder:{current:null}}
  const enqueueRead=fn=>{const next=h.queue.then(fn,fn);h.queue=next.then(()=>{},()=>{});return next}
  const api=vm.runInNewContext(ts.transpileModule('({'+source.slice(start,end)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    Error,loadFocus,saveFocusAction,repositories:{current:repos},notificationRouteGenerationRef:h.generation,focusReminderServiceRef:h.reminder,
    assertBackupWritable:()=>{if(h.gate)throw Error('备份恢复中')},runSerializedRead:enqueueRead,
    enqueue:(fn,options)=>{assert.equal(options.refreshAfter,false);return enqueueRead(()=>fn(repos))},
  }).focusTime
  return {...f,h,api}
}
const startAction={type:'start',title:'任务快照',courseName:'课程快照'}
test('actual queued focus API prevents duplicate start/finish and stale restore writes',async()=>{
 const f=await fixture();try {
  const results=await Promise.allSettled([f.api.act(0,0,startAction),f.api.act(0,0,startAction)])
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
  let s=await f.api.load();assert.equal(s.active.title,'任务快照')
  await f.api.act(s.revision,0,{type:'finish'})
  await assert.rejects(f.api.act(s.revision,0,{type:'finish'}),/已更新/)
  s=await f.api.load();assert.equal(s.records.length,1)
  let release;f.h.queue=new Promise(r=>release=r)
  const pending=f.api.act(s.revision,0,startAction);f.h.generation.current=1;release()
  await assert.rejects(pending,/数据已恢复/);assert.equal((await f.api.load()).active,null)
 }finally{f.close()}
})
test('backup gate is checked inside shared queue for reads and writes',async()=>{
 const f=await fixture();try {
  let release;f.h.queue=new Promise(r=>release=r)
  const pending=f.api.act(0,0,startAction);f.h.gate=true;release()
  await assert.rejects(pending,/备份恢复中/);await assert.rejects(f.api.load(),/备份恢复中/)
  f.h.gate=false;assert.equal((await f.api.load()).revision,0)
 }finally{f.close()}
})

test('actual history queue prevents duplicate add/delete and rejects editor from before restore',async()=>{
 const f=await fixture();try{
  const now=Date.now(),action={type:'historySave',title:'补记',courseName:'',intervals:[{start:now-120000,end:now-60000}]}
  const results=await Promise.allSettled([f.api.act(0,0,action),f.api.act(0,0,action)])
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1)
  let s=await f.api.load();assert.equal(s.records.length,1)
  let release;f.h.queue=new Promise(r=>release=r)
  const pending=f.api.act(s.revision,0,{type:'historyDelete',id:s.records[0].id});f.h.generation.current=1;release()
  await assert.rejects(pending,/数据已恢复/);s=await f.api.load();assert.equal(s.records.length,1)
  await f.api.act(s.revision,1,{type:'historyDelete',id:s.records[0].id})
  await assert.rejects(f.api.act(s.revision,1,{type:'historyDelete',id:s.records[0].id}),/已更新/)
  assert.equal((await f.api.load()).records.length,0)
 }finally{f.close()}
})
test('actual store keeps committed timer if notification sync rejects; permission only for explicit enable',async()=>{
 const f=await fixture();try{
  let changes=0;const requests=[]
  f.h.reminder.current={changed:()=>changes++,reconcile:async request=>{requests.push(request);throw Error('系统通知失败')}}
  let s=await f.api.act(0,0,startAction)
  assert.ok(s.active);assert.match(s.reminder.error,/计时已保存/);assert.equal(changes,1);assert.deepEqual(requests,[false])
  s=await f.api.act(s.revision,0,{type:'reminder',enabled:true})
  assert.equal(s.reminderEnabled,true);assert.equal(requests.at(-1),true)
  assert.equal((await f.api.load()).reminderEnabled,true)
 }finally{f.close()}
})
