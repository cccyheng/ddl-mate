import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createTestDatabase,taskDraft,courseDraft} from './helpers/sqliteHarness.mjs'
const source=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8')
const start=source.indexOf('      readSearchTarget: async'),end=source.indexOf('      applyTaskBatch:',start)
assert.ok(start>0&&end>start)
test('actual store reads current SQL targets, keeps identity kinds, rejects stale generation/gates and never writes',async()=>{
 const f=await createTestDatabase();try{
 await f.tasks.create(taskDraft());await f.courses.create(courseDraft())
 const task=(await f.tasks.listAll())[0],course=(await f.courses.listAll())[0]
 const h={queue:Promise.resolve(),gate:false,generation:{current:0}},repos={tasks:f.tasks,courses:f.courses}
 const api=vm.runInNewContext(ts.transpileModule('({'+source.slice(start,end)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  Error,repositories:{current:repos},notificationRouteGenerationRef:h.generation,
  assertBackupWritable:()=>{if(h.gate)throw Error('备份中')},runSerializedRead:fn=>{const p=h.queue.then(fn,fn);h.queue=p.then(()=>{},()=>{});return p},
 }).readSearchTarget
 const input=(kind,id)=>({owner:{kind,id},generation:h.generation.current})
 assert.equal(await api(input('task',task.id)),true);assert.equal(await api(input('course',course.id)),true)
 assert.deepEqual((await f.tasks.listAll())[0],task);assert.deepEqual((await f.courses.listAll())[0],course)
 await f.tasks.remove(task.id);assert.equal(await api(input('task',task.id)),false);assert.equal(await api(input('course',course.id)),true)
 h.gate=true;await assert.rejects(api(input('course',course.id)),/备份中/);h.gate=false
 let release;h.queue=new Promise(r=>release=r);let pending=api(input('course',course.id));h.gate=true;release();await assert.rejects(pending,/备份中/);h.gate=false
 h.queue=new Promise(r=>release=r);pending=api(input('course',course.id));h.generation.current++;release();await assert.rejects(pending,/数据已恢复/)
 h.queue=new Promise(r=>release=r);const draft=input('course',course.id);pending=api(draft);draft.owner.id=999;release();assert.equal(await pending,true)
 await assert.rejects(api(input('unknown',1)),/无效/);await assert.rejects(api(input('task',NaN)),/无效/)
 repos.courses={getById:async()=>{throw Error('数据库读取失败')}};await assert.rejects(api(input('course',course.id)),/读取失败/)
 repos.courses={getById:async()=>{h.generation.current++;return course}};await assert.rejects(api(input('course',course.id)),/数据已恢复/)
 }finally{f.close()}
})
