import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase, taskDraft, failingRunDatabase } from './helpers/sqliteHarness.mjs'
import { batchTarget, batchDeadline, validateBatch } from '../src/domain/taskBatch.ts'
import { applyTaskBatch } from '../src/domain/taskBatchRepository.ts'

const request = (tasks, action = {kind:'complete'}) => ({targets:tasks.map(batchTarget),action,generation:0})
async function seed(f) {
  for(const title of ['任务一','任务二']) await f.tasks.create(taskDraft({title,description:'保留说明', originalText:'原始通知',estimatedMinutes:'40'}))
  return f.tasks.listAll()
}
test('date-only, precise Shanghai deadline, explicit clear, invalid dates and limits',()=>{
 assert.equal(batchDeadline({kind:'deadline',value:'2026-11-10'}),'2026-11-10')
 assert.equal(batchDeadline({kind:'deadline',value:'2026-11-10T9:05'}),'2026-11-10T09:05:00+08:00')
 assert.equal(batchDeadline({kind:'clearDeadline'}),null)
 for(const value of ['', '2026-02-30','2026-11-10T25:00']) assert.throws(()=>batchDeadline({kind:'deadline',value}))
 assert.throws(()=>validateBatch(request([])))
 assert.throws(()=>validateBatch({targets:Array.from({length:101},(_,i)=>({id:i+1,fingerprint:'x'})),action:{kind:'complete'}}))
 assert.throws(()=>validateBatch({targets:[{id:1,fingerprint:'x'},{id:1,fingerprint:'x'}],action:{kind:'complete'}}))
})
test('real SQL completion preserves unrelated columns/source text, repeated preview refuses and timestamp stays',async()=>{
 const f=await createTestDatabase();try{
 const original=await seed(f), sources=await f.tasks.listAllOriginalSources(), input=request(original)
 const result=await applyTaskBatch(f.db,f.tasks,input,new Date('2026-11-03T02:00:00Z'))
 assert.equal(result.updatedIds.length,2)
 const rows=await f.tasks.listAll()
 rows.forEach((row,i)=>assert.deepEqual(row,{...original[i],status:'DONE',completedAt:'2026-11-03T02:00:00.000Z',updatedAt:'2026-11-03T02:00:00.000Z'}))
 assert.deepEqual(await f.tasks.listAllOriginalSources(),sources)
 await assert.rejects(applyTaskBatch(f.db,f.tasks,input),/整批未保存/)
 assert.deepEqual(await f.tasks.listAll(),rows)
 }finally{f.close()}
})
test('second SQL write failure rolls back first; stale and missing targets prevent whole batch',async()=>{
 const f=await createTestDatabase();try{
 const original=await seed(f),input=request(original,{kind:'deadline',value:'2026-11-08'})
 let writes=0
 const failing=failingRunDatabase(f.db,sql=>sql.startsWith('UPDATE tasks')&&++writes===2)
 await assert.rejects(applyTaskBatch(failing,f.tasks,input))
 assert.deepEqual(await f.tasks.listAll(),original)
 await f.db.runAsync('UPDATE tasks SET title = ? WHERE id = ?',['新标题',original[1].id])
 await assert.rejects(applyTaskBatch(f.db,f.tasks,input),/已变化/)
 assert.equal((await f.tasks.getById(original[0].id)).deadline,null)
 await f.tasks.remove(original[1].id)
 await assert.rejects(applyTaskBatch(f.db,f.tasks,input),/不存在/)
 assert.equal((await f.tasks.getById(original[0].id)).deadline,null)
 }finally{f.close()}
})
test('unified date and clear preserve completion/status, unchanged deadline does not write',async()=>{
 const f=await createTestDatabase();try{
 const rows=await seed(f)
 await applyTaskBatch(f.db,f.tasks,request(rows,{kind:'deadline',value:'2026-11-08'}))
 const dated=await f.tasks.listAll()
 assert.ok(dated.every(t=>t.deadline==='2026-11-08'&&t.status==='TODO'&&t.completedAt===null))
 const unchanged=await applyTaskBatch(f.db,f.tasks,request(dated,{kind:'deadline',value:'2026-11-08'}))
 assert.equal(unchanged.updatedIds.length,0);assert.equal(unchanged.unchangedIds.length,2)
 assert.deepEqual(await f.tasks.listAll(),dated)
 await applyTaskBatch(f.db,f.tasks,request(dated,{kind:'clearDeadline'}))
 assert.ok((await f.tasks.listAll()).every(t=>t.deadline===null))
 }finally{f.close()}
})
