import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {loadFocus} from '../src/domain/focusTimeRepository.ts'
import {loadWeeklyGoals,saveWeeklyGoal} from '../src/domain/weeklyGoalRepository.ts'
import {goalWeek} from '../src/domain/weeklyGoal.ts'
const source=readFileSync(new URL('../src/store/AppStore.tsx',import.meta.url),'utf8')
const start=source.indexOf('      weeklyGoal: {'),end=source.indexOf('      focusTime:',start)
assert.ok(start>0&&end>start)
test('actual AppStore shared queue refuses double writes, restored generation and backup gate',async()=>{
 const f=await createTestDatabase(),repos={settings:new AppSettingsRepository(f.db)}
 const h={queue:Promise.resolve(),gate:false,generation:{current:0}}
 const serial=fn=>{const p=h.queue.then(fn,fn);h.queue=p.then(()=>{},()=>{});return p}
 const api=vm.runInNewContext(ts.transpileModule('({'+source.slice(start,end)+'})',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
  Error,loadFocus,loadWeeklyGoals,saveWeeklyGoal,repositories:{current:repos},notificationRouteGenerationRef:h.generation,
  assertBackupWritable:()=>{if(h.gate)throw Error('备份中')},runSerializedRead:serial,
  enqueue:(fn,opts)=>{assert.equal(opts.refreshAfter,false);return serial(()=>fn(repos))},
 }).weeklyGoal
 try {
  const week=goalWeek(Date.now()),attempts=await Promise.allSettled([api.save(0,0,week,60),api.save(0,0,week,90)])
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
  assert.equal((await api.load()).goals.weeks[week],60)
  let release;h.queue=new Promise(r=>release=r)
  const pending=api.save(1,0,week,120);h.generation.current++;release()
  await assert.rejects(pending,/数据已恢复/)
  h.queue=new Promise(r=>release=r)
  const read=api.load(),write=api.save(1,1,week,120);h.gate=true;release()
  await assert.rejects(read,/备份中/);await assert.rejects(write,/备份中/)
  h.gate=false;assert.equal((await api.load()).goals.revision,1)
 }finally{f.close()}
})
