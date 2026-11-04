// Execute the actual AppStore API block against a real SQLite repository and a controlled shared queue.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { createTestDatabase, taskDraft } from './helpers/sqliteHarness.mjs'
import { ExamRevisionRepository } from '../src/domain/examRevisionRepository.ts'
import { buildRevisionPreview } from '../src/domain/examRevision.ts'
import { shanghaiToday, addDaysToDateKey } from '../src/domain/datetime.ts'

const source=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8')
const start=source.indexOf('      examRevision: {'),end=source.indexOf('      taskTemplates:',start)
assert.ok(start>0&&end>start)
const block=source.slice(start,end)
async function fixture(){
  const f=await createTestDatabase(),today=shanghaiToday()
  const result=await f.tasks.create(taskDraft({type:'EXAM',title:'考试',status:'TODO',courseId:null,deadline:addDaysToDateKey(today,10)}))
  const exam=await f.tasks.getById(result.id),draft={startDate:today,endDate:addDaysToDateKey(today,1),weekdays:[1,2,3,4,5,6,7],topics:['复习'],minutes:20}
  const preview=buildRevisionPreview(exam,draft,new Date());assert.ok(preview.ok)
  const h={gate:false,refreshFailure:false,queue:Promise.resolve(),generation:{current:0},refreshError:{current:null}}
  const repos={db:f.db,tasks:f.tasks}
  const enqueueRead=fn=>{const next=h.queue.then(fn,fn);h.queue=next.then(()=>{},()=>{});return next}
  const api=vm.runInNewContext(ts.transpileModule('({'+block+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    Error,
    ExamRevisionRepository,repositories:{current:repos},notificationRouteGenerationRef:h.generation,refreshErrorRef:h.refreshError,
    assertBackupWritable:()=>{if(h.gate)throw Error('备份恢复中')},
    runSerializedRead:enqueueRead,enqueue:(fn,options)=>{assert.equal(options.refreshAfter,false);return enqueueRead(()=>fn(repos))},
    refresh:async()=>{if(h.refreshFailure)throw Error('refresh unavailable')},
  }).examRevision
  return {...f,h,api,input:{examId:exam.id,planId:1,draft,fingerprint:preview.preview.fingerprint,generation:0}}
}
test('actual store queue rejects restore generation changed while waiting, without writing',async()=>{
  const f=await fixture();try{
    let release;f.h.queue=new Promise(r=>release=r)
    const save=f.api.create(f.input);f.h.generation.current=1;release()
    await assert.rejects(save,/数据已恢复/);assert.equal((await f.tasks.listAll()).length,1)
    const snapshot=await f.api.load();assert.equal(snapshot.generation,1)
  }finally{f.close()}
})
test('actual store checks backup gate inside queue for both load and save',async()=>{
  const f=await fixture();try{
    let release;f.h.queue=new Promise(r=>release=r)
    const save=f.api.create(f.input);f.h.gate=true;release();await assert.rejects(save,/备份恢复中/)
    await assert.rejects(f.api.load(),/备份恢复中/);assert.equal((await f.tasks.listAll()).length,1)
  }finally{f.close()}
})
test('actual store preserves committed outcome when refresh throws, replay is idempotent',async()=>{
  const f=await fixture();try{
    f.h.refreshFailure=true
    const first=await f.api.create(f.input);assert.equal(first.committed,true);assert.match(first.refreshError,/refresh unavailable/)
    const second=await f.api.create(f.input);assert.equal(second.alreadyCreated,true);assert.deepEqual(first.plan.taskIds,second.plan.taskIds)
    assert.equal((await f.tasks.listAll()).length,3)
  }finally{f.close()}
})
