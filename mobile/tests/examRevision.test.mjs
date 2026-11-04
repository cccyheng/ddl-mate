import test from 'node:test'
import assert from 'node:assert/strict'
import { describeExam, listExams, buildRevisionPreview } from '../src/domain/examRevision.ts'
const now = new Date('2026-10-28T00:00:00Z')
const exam = (patch={}) => ({ id:1, title:'期中考试', type:'EXAM', status:'TODO', deadline:'2026-11-05', courseId:2, updatedAt:'2026-10-27T00:00:00Z', ...patch })
const input = (patch={}) => ({startDate:'2026-10-28',endDate:'2026-11-04',weekdays:[1,2,3,4,5],topics:['第一章','第二章'],minutes:30,...patch})
const preview = (task=exam(), draft=input(), at=now) => buildRevisionPreview(task,draft,at)
test('countdown uses Shanghai days across midnight, never elapsed 24-hour rounding',()=>{
  const task=exam({deadline:'2026-10-29'})
  assert.equal(describeExam(task,new Date('2026-10-28T15:59:59Z')).days,1)
  assert.equal(describeExam(task,new Date('2026-10-28T16:00:00Z')).phase,'today')
  assert.equal(describeExam(task,new Date('2026-10-29T15:59:59Z')).phase,'today')
  assert.equal(describeExam(task,new Date('2026-10-29T16:00:00Z')).phase,'overdue')
})
test('exact exam time and undated, completed, cancelled states remain distinct',()=>{
  assert.equal(describeExam(exam({deadline:'2026-10-28T07:00:00+08:00'}),now).label,'考试时间已过')
  assert.equal(describeExam(exam({deadline:null}),now).phase,'undated')
  assert.equal(describeExam(exam({deadline:'2026-02-30'}),now).phase,'undated')
  assert.equal(describeExam(exam({status:'DONE'}),now).phase,'done')
  assert.equal(describeExam(exam({status:'CANCELLED'}),now).phase,'cancelled')
  assert.equal(listExams([exam(),exam({id:2,type:'HOMEWORK'}),exam({id:3,deadline:'2026-10-28'})],now)[0].task.id,3)
})
test('leap day and year boundary countdowns are correct',()=>{
  assert.equal(describeExam(exam({deadline:'2028-03-01'}),new Date('2028-02-28T00:00:00Z')).days,2)
  assert.equal(describeExam(exam({deadline:'2027-01-01'}),new Date('2026-12-31T00:00:00Z')).days,1)
})
test('preview is deterministic, preserves input, cycles all topics on selected days only',()=>{
  const draft=input(), original=JSON.stringify(draft), p=preview(exam(),draft)
  assert.ok(p.ok);assert.deepEqual(p.preview.sessions.map(s=>s.date),['2026-10-28','2026-10-29','2026-10-30','2026-11-02','2026-11-03','2026-11-04'])
  assert.deepEqual(p.preview.sessions.map(s=>s.topic),['第一章','第二章','第一章','第二章','第一章','第二章'])
  assert.equal(JSON.stringify(draft),original);assert.equal(preview().preview.fingerprint,p.preview.fingerprint)
  assert.equal(preview(exam(),input({weekdays:[5,4,3,2,1]})).preview.fingerprint,p.preview.fingerprint)
})
test('reject missing/non-exam, completed/cancelled and today/past/invalid exam dates',()=>{
  for(const task of [null,exam({type:'OTHER'}),exam({status:'DONE'}),exam({status:'CANCELLED'}),exam({deadline:'2026-10-28'}),exam({deadline:'2026-10-27'}),exam({deadline:null})]) assert.equal(preview(task).ok,false)
  assert.equal(preview(exam(),input(),new Date(NaN)).ok,false)
})
test('reject past start, reversed range, exam-day sessions and unavailable weekdays',()=>{
  for(const patch of [{startDate:'2026-10-27'},{endDate:'2026-10-27'},{endDate:'2026-11-05'},{startDate:'invalid'},{endDate:'2026-10-28',weekdays:[1]}]) assert.equal(preview(exam(),input(patch)).ok,false)
})
test('bounded input rejects invalid weekdays, topics and minutes without silent loss',()=>{
  for(const patch of [{weekdays:[]},{weekdays:[0]},{weekdays:[8]},{weekdays:[1.5]},{topics:[]},{topics:[' ']},{topics:['x'.repeat(101)]},{minutes:0},{minutes:1.5},{minutes:1441},{endDate:'2026-10-28'}]) assert.equal(preview(exam(),input(patch)).ok,false,JSON.stringify(patch))
  assert.equal(preview(exam({deadline:'2027-05-01'}),input({endDate:'2027-02-01'})).ok,false)
  assert.equal(preview(exam({deadline:'2027-05-01'}),input({endDate:'2026-12-20',weekdays:[1,2,3,4,5,6,7]})).ok,false)
})
test('authority fingerprints change after exam edits or Shanghai date rollover',()=>{
  const a=preview().preview.fingerprint
  for(const patch of [{title:'改名'},{deadline:'2026-11-06'},{courseId:3},{updatedAt:'2026-10-28T01:00:00Z'},{status:'DOING'}]) assert.notEqual(preview(exam(patch)).preview.fingerprint,a)
  const draft=input({startDate:'2026-10-29'})
  assert.notEqual(preview(exam(),draft,now).preview.fingerprint,preview(exam(),draft,new Date('2026-10-28T16:00:00Z')).preview.fingerprint)
})
