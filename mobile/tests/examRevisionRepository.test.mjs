import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestDatabase, failingRunDatabase, taskDraft } from './helpers/sqliteHarness.mjs'
import { TaskRepository } from '../src/domain/taskRepository.ts'
import { buildRevisionPreview } from '../src/domain/examRevision.ts'
import { ExamRevisionRepository, decodeExamRevisionStore, EXAM_REVISION_KEY } from '../src/domain/examRevisionRepository.ts'
const fixedNow=()=>new Date('2026-10-28T00:00:00Z')
async function setup() {
  const f=await createTestDatabase(),saved=await f.tasks.create(taskDraft({title:'考试',type:'EXAM',deadline:'2026-11-05',courseId:null,status:'TODO'}))
  const exam=await f.tasks.getById(saved.id)
  const draft={startDate:'2026-10-28',endDate:'2026-10-30',weekdays:[1,2,3,4,5,6,7],topics:['第一章','第二章'],minutes:30}
  const p=buildRevisionPreview(exam,draft,fixedNow());assert.ok(p.ok)
  return {...f,exam,draft,request:{examId:exam.id,planId:1,draft,fingerprint:p.preview.fingerprint},repo:new ExamRevisionRepository(f.db,f.tasks,fixedNow)}
}
test('atomic plan creates dated ordinary tasks and persists exact links; replay never duplicates deleted tasks',async()=>{
  const f=await setup()
  try {
    const before=await f.tasks.getById(f.exam.id),result=await f.repo.create(f.request)
    assert.equal(result.plan.taskIds.length,3);assert.equal(result.alreadyCreated,false)
    assert.deepEqual(await f.tasks.getById(f.exam.id),before)
    for(const id of result.plan.taskIds){const t=await f.tasks.getById(id);assert.equal(t.type,'OTHER');assert.equal(t.estimatedMinutes,30);assert.match(t.deadline,/^2026-10-(28|29|30)$/)}
    f.raw.prepare('DELETE FROM tasks WHERE id=?').run(result.plan.taskIds[0])
    const replay=await new ExamRevisionRepository(f.db,f.tasks,fixedNow).create(f.request)
    assert.equal(replay.alreadyCreated,true);assert.deepEqual(replay.plan.taskIds,result.plan.taskIds)
    assert.equal((await f.tasks.listAll()).length,3);assert.equal((await f.repo.load()).nextId,2)
  } finally {f.close()}
})
test('second task failure and metadata failure roll back all tasks and plan',async()=>{
  for(const phase of ['task','metadata']){
    const f=await setup()
    try{
      let inserts=0
      const db=failingRunDatabase(f.db,(_,sql)=>phase==='metadata'?sql.includes('INSERT INTO app_settings'):sql.includes('INSERT INTO tasks')&&++inserts===2)
      const repo=new ExamRevisionRepository(db,new TaskRepository(db,fixedNow),fixedNow)
      await assert.rejects(repo.create(f.request),/测试注入/)
      assert.equal((await f.tasks.listAll()).length,1);assert.equal((await f.repo.load()).plans.length,0)
    }finally{f.close()}
  }
})
test('exam edits/deletion/completion/type change and date rollover reject stale preview without writes',async()=>{
  for(const change of ['title','delete','done','type','midnight']){
    const f=await setup()
    try{
      if(change==='title')f.raw.prepare("UPDATE tasks SET title='新考试' WHERE id=?").run(f.exam.id)
      if(change==='delete')f.raw.prepare('DELETE FROM tasks WHERE id=?').run(f.exam.id)
      if(change==='done')f.raw.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(f.exam.id)
      if(change==='type')f.raw.prepare("UPDATE tasks SET type='HOMEWORK' WHERE id=?").run(f.exam.id)
      const repo=change==='midnight'?new ExamRevisionRepository(f.db,f.tasks,()=>new Date('2026-10-28T16:00:00Z')):f.repo
      await assert.rejects(repo.create(f.request))
      assert.equal((await f.repo.load()).plans.length,0);assert.equal((await f.tasks.listAll()).length,change==='delete'?0:1)
    }finally{f.close()}
  }
})
test('tampered preview, conflicting plan id, invalid metadata all fail closed',async()=>{
  const f=await setup()
  try{
    await assert.rejects(f.repo.create({...f.request,draft:{...f.draft,topics:['changed']}}))
    await assert.rejects(f.repo.create({...f.request,planId:2}))
    await f.repo.create(f.request)
    await assert.rejects(f.repo.create({...f.request,fingerprint:'different'}))
    f.raw.prepare('UPDATE app_settings SET value=? WHERE key=?').run('{broken',EXAM_REVISION_KEY)
    await assert.rejects(f.repo.create(f.request),/无法读取/)
    assert.equal((await f.tasks.listAll()).length,4)
  }finally{f.close()}
})
test('strict decoder rejects extras, duplicate links, bad date, limits and future versions',async()=>{
  const f=await setup()
  try{
    await f.repo.create(f.request);const valid=await f.repo.load()
    assert.deepEqual(decodeExamRevisionStore(JSON.stringify(valid)),valid)
    assert.equal(decodeExamRevisionStore(null).plans.length,0)
    const mutations=[s=>s.version=2,s=>s.extra=true,s=>s.nextId=1,s=>s.plans[0].createdAt='2026-02-30T00:00:00Z',s=>s.plans[0].taskIds=[2,2],s=>s.plans[0].taskIds=[],s=>s.plans[0].taskIds=[s.plans[0].examId],s=>s.plans[0].extra=1,s=>s.plans[0].fingerprint='x'.repeat(20001)]
    for(const mutate of mutations){const s=structuredClone(valid);mutate(s);assert.throws(()=>decodeExamRevisionStore(JSON.stringify(s)))}
  }finally{f.close()}
})
