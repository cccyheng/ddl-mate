import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createTestDatabase,taskDraft} from './helpers/sqliteHarness.mjs'
import {batchTarget} from '../src/domain/taskBatch.ts'
import {applyTaskBatch} from '../src/domain/taskBatchRepository.ts'
const source=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8')
const start=source.indexOf('      applyTaskBatch: async'),end=source.indexOf('      createTask:',start)
assert.ok(start>0&&end>start)
test('actual store serializes, rechecks gate/generation, freezes caller preview and reports committed refresh failure',async()=>{
 const f=await createTestDatabase();try{
 await f.tasks.create(taskDraft());const task=(await f.tasks.listAll())[0]
 const h={queue:Promise.resolve(),gate:false,generation:{current:0},reminders:0,refreshFail:false,syncFail:false}
 const api=vm.runInNewContext(ts.transpileModule('({'+source.slice(start,end)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  Error,applyTaskBatch,notificationRouteGenerationRef:h.generation,refreshErrorRef:{current:null},
  assertBackupWritable:()=>{if(h.gate)throw Error('备份中')},
  enqueue:(fn,opts)=>{assert.equal(opts.refreshAfter,false);const p=h.queue.then(()=>fn({db:f.db,tasks:f.tasks}));h.queue=p.then(()=>{},()=>{});return p},
  afterTaskMutation:reason=>{assert.equal(reason,'task-batch');h.reminders++;if(h.syncFail)throw Error('sync')},
  refresh:async()=>{if(h.refreshFail)throw Error('refresh')},
 }).applyTaskBatch
 const input=()=>({targets:[batchTarget(task)],action:{kind:'deadline',value:'2026-11-09'},generation:h.generation.current})
 let release;h.queue=new Promise(r=>release=r);let pending=api(input());h.gate=true;release();await assert.rejects(pending,/备份中/)
 h.gate=false;h.queue=new Promise(r=>release=r);pending=api(input());h.generation.current++;release();await assert.rejects(pending,/数据已恢复/)
 assert.equal((await f.tasks.getById(task.id)).deadline,null);assert.equal(h.reminders,0)
 h.queue=new Promise(r=>release=r);const draft=input();pending=api(draft);draft.action.value='2026-12-12';draft.targets[0].id=999
 h.refreshFail=true;h.syncFail=true;release();const result=await pending
 assert.equal(result.committed,true);assert.match(result.warning,/已保存/)
 assert.equal((await f.tasks.getById(task.id)).deadline,'2026-11-09');assert.equal(h.reminders,1)
 await assert.rejects(api(input()),/已变化/);assert.equal(h.reminders,1)
 }finally{f.close()}
})
