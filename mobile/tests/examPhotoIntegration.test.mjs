import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'
import {createBackupFs} from './helpers/backupFs.mjs'
import {removeTempDir} from './helpers/tempDir.mjs'
import {importExamPhoto} from '../src/domain/examPhotoRepository.ts'
import {parseExamPhotoText} from '../src/domain/examPhoto.ts'
import {exportBackupToDirectory,stageBackupForPreview,restoreStagedBackup} from '../src/domain/backupService.ts'
import {recognizeNoticeImage} from '../src/domain/noticeOcrClient.ts'
const source='【考试 1】\n测试考试\n一号楼\n考试日期：2099-12-02\n座位号：7\n时间栏：12:00 13:00\n【结束】'
const input={attemptId:1,generation:0,sourceText:source,rows:parseExamPhotoText(source)}
test('actual store photo import checks queued restore/gate and distinguishes committed refresh failure',async()=>{
  const file=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8'),start=file.indexOf('      importExamPhoto: async'),end=file.indexOf('      examRevision:',start)
  assert.ok(start>0&&end>start)
  let gate=false,writes=0,refreshFails=false,release
  const generation={current:0},refreshErrorRef={current:null}
  let queue=new Promise(r=>release=r)
  const api=vm.runInNewContext(ts.transpileModule('({'+file.slice(start,end)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    Error,importExamPhoto:async()=>{writes++;return {committed:true,created:[1],existing:[]}},notificationRouteGenerationRef:generation,refreshErrorRef,
    assertBackupWritable:()=>{if(gate)throw Error('备份中')},enqueue:fn=>{const next=queue.then(()=>fn({db:{},tasks:{}}));queue=next.catch(()=>{});return next},
    refresh:async()=>{if(refreshFails)throw Error('refresh failed')},
  }).importExamPhoto
  const pending=api(input);generation.current=1;release();await assert.rejects(pending,/数据已恢复/);assert.equal(writes,0)
  generation.current=0;gate=true;await assert.rejects(api(input),/备份中/);assert.equal(writes,0)
  gate=false;refreshFails=true;const result=await api(input);assert.equal(result.committed,true);assert.match(result.refreshError,/refresh failed/);assert.equal(writes,1)
})
test('exam client uses dedicated route, preserving normal notice default',async()=>{
  for(const kind of ['exams',undefined]){
    let url
    const result=await recognizeNoticeImage('http://127.0.0.1:8082',{kind,imageBase64:'aGVsbG8=',fetchImpl:async u=>{url=u;return {ok:true,status:200,json:async()=>({ok:true,rawText:source})}}})
    assert.ok(url.endsWith(kind==='exams'?'/v1/ocr/exams':'/v1/ocr/notice'));assert.equal(result.rawText,source)
  }
})
test('exam source image and task links survive real backup restore',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ddl-exam-photo-')),docs=join(root,'docs'),out=join(root,'out')
  mkdirSync(join(docs,'screenshots'),{recursive:true});mkdirSync(out)
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AGtE0wAAAAASUVORK5CYII=','base64')
  writeFileSync(join(docs,'screenshots','tiny.png'),bytes)
  const f=await createTestDatabase(),fs=createBackupFs(docs),now=()=>new Date('2026-10-28T00:00:00Z')
  try{
    f.raw.prepare("INSERT INTO screenshot_attempts(id,captured_at,source,status,archived_path,sha256,byte_length,width,height,format,mime_type,created_at,updated_at) VALUES(1,?,'LIBRARY','ARCHIVED',?,?,?,1,1,'png','image/png',?,?)").run(now().toISOString(),pathToFileURL(join(docs,'screenshots','tiny.png')).href,createHash('sha256').update(bytes).digest('hex'),bytes.length,now().toISOString(),now().toISOString())
    const saved=await importExamPhoto(f.db,f.tasks,input)
    const exported=await exportBackupToDirectory(f.db,fs,pathToFileURL(out).href,{now})
    const staged=await stageBackupForPreview(f.db,fs,exported.uri,{sourceName:'exam-photo.ddlbackup.json'})
    const result=await restoreStagedBackup(f.db,fs,staged,{now});assert.equal(result.committed,true,result.reason)
    assert.equal((await f.tasks.getById(saved.created[0])).type,'EXAM')
    const ref=f.raw.prepare('SELECT * FROM screenshot_refs').get();assert.equal(ref.target_id,saved.created[0]);assert.equal(ref.relation,'EXAM_PHOTO_1')
    const photo=f.raw.prepare('SELECT archived_path FROM screenshot_attempts WHERE id=1').get();assert.equal(await fs.readBase64(photo.archived_path.startsWith('file:')?photo.archived_path:fs.documentDirectory+photo.archived_path),bytes.toString('base64'))
  }finally{f.close();removeTempDir(root,'ddl-exam-photo-')}
})
