import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFocusAction as act, emptyFocus, decodeFocus, focusClockIssue, focusDuration, focusTotal, focusDayStart, focusForRestore, MAX_FOCUS_INTERVAL } from '../src/domain/focusTime.ts'
import { loadFocus, saveFocusAction } from '../src/domain/focusTimeRepository.ts'
import { AppSettingsRepository } from '../src/domain/settingsRepository.ts'
import { createTestDatabase, failingRunDatabase } from './helpers/sqliteHarness.mjs'
const start={type:'start',title:'数学复习',courseName:'数学'}
const t=focusDayStart('2026-11-01')

test('timestamp timer survives serialized restart; pause excluded, start duplicates rejected',()=>{
  let s=act(emptyFocus(),start,t)
  assert.throws(()=>act(s,start,t+1),/已有专注/)
  s=decodeFocus(JSON.stringify(s))
  assert.equal(focusDuration(s.active,t+60000),60000)
  s=act(s,{type:'pause'},t+60000)
  assert.equal(focusDuration(s.active,t+120000),60000)
  s=act(s,{type:'resume'},t+180000)
  s=act(s,{type:'finish'},t+240000)
  assert.equal(s.active,null);assert.equal(focusDuration(s.records[0],t+500000),120000)
  assert.throws(()=>act(s,{type:'finish'},t+260000),/没有正在进行/)
})
test('Shanghai midnight/week boundary clips both days, pause not counted, future intervals excluded',()=>{
  const midnight=focusDayStart('2026-11-02')
  let s=act(emptyFocus(),start,midnight-60000)
  s=act(s,{type:'pause'},midnight+60000)
  s=act(s,{type:'resume'},midnight+120000)
  s=act(s,{type:'finish'},midnight+180000)
  assert.equal(focusTotal(s,t,midnight,midnight+180000),60000)
  assert.equal(focusTotal(s,midnight,midnight+86400000,midnight+180000),120000)
  assert.equal(focusTotal(s,midnight,midnight+86400000,midnight+30000),30000)
})
test('backward clock and forgotten timer require explicit recovery; invalid overlapping storage refused',()=>{
  let s=act(emptyFocus(),start,t)
  assert.ok(focusClockIssue(s.active,t-1));assert.throws(()=>act(s,{type:'finish'},t-1),/时间/)
  assert.throws(()=>act(s,{type:'pause'},t+MAX_FOCUS_INTERVAL+1),/12 小时/)
  assert.equal(focusDuration(s.active,t+MAX_FOCUS_INTERVAL+1),0)
  s=act(s,{type:'recover'},t+MAX_FOCUS_INTERVAL+1)
  assert.equal(s.active.runningSince,null)
  s=act(s,{type:'finish'},t+MAX_FOCUS_INTERVAL+1)
  assert.equal(focusDuration(s.records[0],t+MAX_FOCUS_INTERVAL+1),0)
  const bad=structuredClone(s);bad.records[0].intervals=[{start:t,end:t+10},{start:t+5,end:t+20}]
  assert.throws(()=>decodeFocus(JSON.stringify(bad)),/无效/)
  assert.throws(()=>decodeFocus('{"version":1}'))
})
test('restored active session is paused and keeps only sealed intervals; labels outlive deleted tasks',()=>{
  let s=act(emptyFocus(),start,t)
  s=act(s,{type:'pause'},t+1000);s=act(s,{type:'resume'},t+2000)
  const restored=decodeFocus(focusForRestore(JSON.stringify(s)))
  assert.equal(restored.active.runningSince,null);assert.equal(focusDuration(restored.active,t+900000),1000)
  assert.equal(restored.active.title,'数学复习');assert.equal(restored.active.courseName,'数学');assert.equal(restored.revision,s.revision+1)
})
test('real SQLite durable state, stale/replayed writes refused, failed save can retry exactly once',async()=>{
  const f=await createTestDatabase()
  try {
    const repo=new AppSettingsRepository(f.db)
    assert.deepEqual(await loadFocus(repo),emptyFocus())
    let s=await saveFocusAction(repo,0,start,t)
    assert.deepEqual(await loadFocus(new AppSettingsRepository(f.db)),s)
    await assert.rejects(saveFocusAction(repo,0,start,t),/已更新/)
    const failing=new AppSettingsRepository(failingRunDatabase(f.db,(_,sql)=>sql.includes('INSERT INTO app_settings')))
    await assert.rejects(saveFocusAction(failing,s.revision,{type:'finish'},t+3000),/测试注入/)
    assert.deepEqual(await loadFocus(repo),s)
    s=await saveFocusAction(repo,s.revision,{type:'finish'},t+3000)
    await assert.rejects(saveFocusAction(repo,s.revision-1,{type:'finish'},t+3000),/已更新/)
    assert.equal((await loadFocus(repo)).records.length,1)
  } finally {f.close()}
})
