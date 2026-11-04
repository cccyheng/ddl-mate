import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdirSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createTestDatabase,taskDraft} from './helpers/sqliteHarness.mjs'
import {createBackupFs} from './helpers/backupFs.mjs'
import {removeTempDir} from './helpers/tempDir.mjs'
import {exportBackupToDirectory,stageBackupForPreview,restoreStagedBackup} from '../src/domain/backupService.ts'
import {parseBackupText,sealBackupData} from '../src/domain/backupFormat.ts'
import {EXAM_REVISION_KEY,ExamRevisionRepository} from '../src/domain/examRevisionRepository.ts'
import {buildRevisionPreview} from '../src/domain/examRevision.ts'
test('real backup roundtrip preserves plans, rejects malformed metadata, prevents deleted task/exam ID reuse',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ddl-exam-backup-')),docs=join(root,'docs'),out=join(root,'out')
  mkdirSync(join(docs,'screenshots'),{recursive:true});mkdirSync(out)
  const f=await createTestDatabase(),fs=createBackupFs(docs),now=()=>new Date('2026-10-28T00:00:00Z')
  try{
    const exam=await f.tasks.create(taskDraft({title:'考试',type:'EXAM',deadline:'2026-11-05',courseId:null,status:'TODO'}))
    const draft={startDate:'2026-10-28',endDate:'2026-10-29',weekdays:[1,2,3,4,5],topics:['第一章'],minutes:30}
    const p=buildRevisionPreview(await f.tasks.getById(exam.id),draft,now());assert.ok(p.ok)
    const repo=new ExamRevisionRepository(f.db,f.tasks,now)
    const result=await repo.create({examId:exam.id,planId:1,draft,fingerprint:p.preview.fingerprint})
    // Keep historical links while all their targets are gone. Restore must not reuse their IDs.
    f.raw.prepare('DELETE FROM tasks').run()
    const before=await repo.load(),exported=await exportBackupToDirectory(f.db,fs,pathToFileURL(out).href,{now})
    const parsed=await parseBackupText(await fs.readText(exported.uri))
    assert.ok(parsed.data.settings.some(s=>s.key===EXAM_REVISION_KEY))
    await parseBackupText(JSON.stringify(await sealBackupData(parsed.data,{now})))
    const corrupt=structuredClone(parsed.data);corrupt.settings.find(s=>s.key===EXAM_REVISION_KEY).value='{"version":999}'
    await assert.rejects(async()=>{const bad=await sealBackupData(corrupt,{now});await parseBackupText(JSON.stringify(bad))},/考试复习安排/)
    const staged=await stageBackupForPreview(f.db,fs,exported.uri,{sourceName:'exam.ddlbackup.json'})
    const restored=await restoreStagedBackup(f.db,fs,staged,{now});assert.equal(restored.committed,true,restored.reason)
    assert.deepEqual(await repo.load(),before)
    const fresh=await f.tasks.create(taskDraft({title:'新任务'}));assert.ok(fresh.id>Math.max(exam.id,...result.plan.taskIds))
    // A pre-feature backup must clear current plans instead of leaving stale links behind.
    const legacy=structuredClone(parsed.data)
    legacy.settings=legacy.settings.filter(s=>s.key!==EXAM_REVISION_KEY)
    const legacyUri=pathToFileURL(join(out,'legacy.ddlbackup.json')).href
    await fs.writeText(legacyUri,JSON.stringify(await sealBackupData(legacy,{now})))
    const oldStaged=await stageBackupForPreview(f.db,fs,legacyUri,{sourceName:'legacy.ddlbackup.json'})
    const oldRestored=await restoreStagedBackup(f.db,fs,oldStaged,{now});assert.equal(oldRestored.committed,true,oldRestored.reason)
    assert.deepEqual(await repo.load(),{version:1,nextId:1,plans:[]})
  }finally{f.close();removeTempDir(root,'ddl-exam-backup-')}
})
