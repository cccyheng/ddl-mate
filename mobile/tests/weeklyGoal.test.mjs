import test from 'node:test'
import assert from 'node:assert/strict'
import {goalWeek, emptyWeeklyGoals, changeWeeklyGoal, decodeWeeklyGoals, weeklyGoalProgress} from '../src/domain/weeklyGoal.ts'
import {emptyFocus, applyFocusAction, focusDayStart} from '../src/domain/focusTime.ts'
import {loadWeeklyGoals, saveWeeklyGoal} from '../src/domain/weeklyGoalRepository.ts'
import {AppSettingsRepository} from '../src/domain/settingsRepository.ts'
import {createTestDatabase} from './helpers/sqliteHarness.mjs'

const monday=focusDayStart('2026-11-02'), previous=monday-7*86400000
test('Shanghai Monday boundary, per-week history, disabling and invalid data',()=>{
 assert.equal(goalWeek(monday-1),'2026-10-26');assert.equal(goalWeek(monday),'2026-11-02')
 let g=changeWeeklyGoal(emptyWeeklyGoals(),'2026-10-26',60,previous)
 g=changeWeeklyGoal(g,'2026-11-02',120,monday)
 assert.equal(g.weeks['2026-10-26'],60)
 g=changeWeeklyGoal(g,'2026-11-02',null,monday);assert.equal(g.weeks['2026-11-02'],undefined)
 assert.equal(g.weeks['2026-10-26'],60)
 for(const minutes of [0,14,16,10095,Infinity])assert.throws(()=>changeWeeklyGoal(g,'2026-11-02',minutes,monday))
 assert.throws(()=>changeWeeklyGoal(g,'2026-10-26',60,monday),/新的一周/)
 for(const weeks of [{'2026-11-03':60},{'2026-02-30':60},{'2026-11-02':0},[]])assert.throws(()=>decodeWeeklyGoals(JSON.stringify({version:1,revision:0,weeks})))
 assert.deepEqual(decodeWeeklyGoals(null),emptyWeeklyGoals())
})
test('progress clips across weeks, excludes active and rest, caps percent but retains overtime',()=>{
 let s=applyFocusAction(emptyFocus(),{type:'start',title:'复习',courseName:''},monday-60000)
 s=applyFocusAction(s,{type:'finish'},monday+30*60000)
 const g=changeWeeklyGoal(emptyWeeklyGoals(),'2026-11-02',15,monday)
 let p=weeklyGoalProgress(g,s,'2026-11-02',monday+3600000)
 assert.equal(p.elapsedMs,30*60000);assert.equal(p.percent,100);assert.equal(p.remainingMs,0)
 assert.equal(weeklyGoalProgress(g,s,'2026-10-26',monday+3600000).elapsedMs,60000)
 assert.equal(weeklyGoalProgress(g,s,'2026-10-26',monday+3600000).percent,null)
 s=applyFocusAction(s,{type:'start',title:'番茄',courseName:'',timer:{kind:'focus',focusMinutes:1,restMinutes:5}},monday+40*60000)
 assert.equal(weeklyGoalProgress(g,s,'2026-11-02',monday+41*60000).elapsedMs,p.elapsedMs)
 s=applyFocusAction(s,{type:'finishAndRest'},monday+41*60000)
 s=applyFocusAction(s,{type:'finish'},monday+46*60000)
 assert.equal(weeklyGoalProgress(g,s,'2026-11-02',monday+50*60000).elapsedMs,31*60000)
})
test('actual SQLite persistence rejects stale revision and failed write remains retryable',async()=>{
 const f=await createTestDatabase(),r=new AppSettingsRepository(f.db)
 try {
  const first=await saveWeeklyGoal(r,0,'2026-11-02',45,monday)
  assert.deepEqual(await loadWeeklyGoals(r),first)
  await assert.rejects(saveWeeklyGoal(r,0,'2026-11-02',60,monday),/已更新/)
  const failing={get:r.get.bind(r),set:async()=>{throw Error('disk full')}}
  await assert.rejects(saveWeeklyGoal(failing,1,'2026-11-02',60,monday),/disk full/)
  assert.equal((await loadWeeklyGoals(r)).weeks['2026-11-02'],45)
  await saveWeeklyGoal(r,1,'2026-11-02',60,monday)
  assert.equal((await loadWeeklyGoals(r)).weeks['2026-11-02'],60)
 }finally{f.close()}
})
