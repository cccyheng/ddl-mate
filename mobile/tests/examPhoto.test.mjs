import test from 'node:test'
import assert from 'node:assert/strict'
import {parseExamPhotoText,examPhotoTaskDraft} from '../src/domain/examPhoto.ts'
import {importExamPhoto} from '../src/domain/examPhotoRepository.ts'
import {createTestDatabase,failingRunDatabase} from './helpers/sqliteHarness.mjs'
import {TaskRepository} from '../src/domain/taskRepository.ts'

const sample='【考试 1】\n课程甲\n一号楼-101\n考试期：2026-12-02\n座位号：7\n时间栏：12:00 13:00\n【结束】\n【考试 2】\n课程乙\n二号楼-202\n考试日期：2026-12-20\n座位号：59\n时间栏：08.110 09.35\n【结束】\n【考试 3】\n课程丙\n考试日期：2026-10-20\n时间栏：10:00 11:35\n【结束】'
const rows=()=>parseExamPhotoText(sample,'2026-10-28')
async function setup(){const f=await createTestDatabase();f.raw.exec("INSERT INTO screenshot_attempts(id,captured_at,source,status,archived_path,created_at,updated_at) VALUES(1,'2026-10-28','LIBRARY','ARCHIVED','screenshots/test.jpg','2026-10-28','2026-10-28')");return {...f,input:{attemptId:1,generation:0,sourceText:sample,rows:rows()}}}
test('card text keeps dates, locations, seats paired; malformed single time cannot become start; past unchecked',()=>{
  const r=rows();assert.equal(r.length,3);assert.equal(r[0].start,'12:00');assert.equal(r[0].location,'一号楼-101');assert.equal(r[1].seat,'59');assert.equal(r[1].start,'');assert.equal(r[1].end,'');assert.equal(r[2].selected,false)
  assert.equal(examPhotoTaskDraft(r[0],sample).deadline,'2026-12-02T12:00');assert.equal(examPhotoTaskDraft(r[1],sample).deadline,'2026-12-20')
  assert.equal(parseExamPhotoText('2:49 考试安排 2026-2027-1').length,0)
  assert.throws(()=>examPhotoTaskDraft({...r[0],end:'11:00'},sample),/结束时间/)
  assert.throws(()=>examPhotoTaskDraft({...r[0],date:'2026-02-30'},sample),/日期/)
})
test('atomic exam import preserves full source and photo refs, dedupes replay and does not modify existing exam',async()=>{
  const f=await setup();try{
    const result=await importExamPhoto(f.db,f.tasks,f.input);assert.equal(result.created.length,2)
    const tasks=await f.tasks.listAll();assert.ok(tasks.every(t=>t.type==='EXAM'));assert.equal(tasks.length,2)
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM screenshot_refs').get().n,2)
    assert.equal(f.raw.prepare('SELECT count(*) AS n FROM task_sources').get().n,2)
    assert.match(tasks.find(t=>t.title==='课程甲').description,/座位号：7/)
    const again=await importExamPhoto(f.db,f.tasks,f.input);assert.equal(again.created.length,0);assert.equal(again.existing.length,2)
    assert.deepEqual(await f.tasks.listAll(),tasks)
    f.raw.exec("INSERT INTO screenshot_attempts(id,captured_at,source,status,archived_path,created_at,updated_at) SELECT 2,captured_at,source,status,archived_path,created_at,updated_at FROM screenshot_attempts WHERE id=1")
    const reupload=await importExamPhoto(f.db,f.tasks,{...f.input,attemptId:2});assert.equal(reupload.created.length,0);assert.equal((await f.tasks.listAll()).length,2)
  }finally{f.close()}
})
test('photo ref write failure rolls entire task batch back; missing photo and course reject with no writes',async()=>{
  const f=await setup();try{
    let refs=0;const db=failingRunDatabase(f.db,(_,sql)=>sql.includes('INSERT INTO screenshot_refs')&&++refs===2)
    await assert.rejects(importExamPhoto(db,new TaskRepository(db),f.input),/测试注入/)
    assert.equal((await f.tasks.listAll()).length,0);assert.equal(f.raw.prepare('SELECT count(*) AS n FROM screenshot_refs').get().n,0)
    await assert.rejects(importExamPhoto(f.db,f.tasks,{...f.input,attemptId:99}),/原图/)
    await assert.rejects(importExamPhoto(f.db,f.tasks,{...f.input,rows:[{...rows()[0],courseId:99}]}),/课程/)
    assert.equal((await f.tasks.listAll()).length,0)
  }finally{f.close()}
})
