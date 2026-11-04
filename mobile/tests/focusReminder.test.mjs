import test from 'node:test'
import assert from 'node:assert/strict'
import {applyFocusAction as act,emptyFocus,focusDayStart} from '../src/domain/focusTime.ts'
import {focusReminderCandidate,parseFocusReminderTap,ownsFocusReminder} from '../src/domain/focusReminder.ts'
import {createFocusReminderService,withFocusReminderLifecycle} from '../src/domain/focusReminderService.ts'
const t=focusDayStart('2026-11-02'),start={type:'start',title:'复习',courseName:'',timer:{kind:'focus',focusMinutes:25,restMinutes:5}}
function fixture(){
 const h={now:t,s:act(act(emptyFocus(),start,t),{type:'reminder',enabled:true},t),pending:new Map(),requests:0,schedules:0,cancels:[],fail:null,wait:null,permission:{status:'granted',canAskAgain:false,detail:null}}
 const port={getPermission:async()=>h.permission,requestPermission:async()=>{h.requests++;return h.permission},listPending:async()=>{if(h.fail==='list')throw Error('list failed');return [...h.pending.values()]},
  schedule:async c=>{h.schedules++;if(h.wait)await h.wait;if(h.fail==='schedule')throw Error('schedule failed');h.pending.set(c.identifier,{identifier:c.identifier,data:c.data,trigger:{type:'date',timestamp:c.triggerAtMs}})},
  cancel:async id=>{h.cancels.push(id);if(h.fail==='cancel')throw Error('cancel failed');h.pending.delete(id)}}
 h.service=createFocusReminderService({port,read:async()=>{if(h.fail==='read')throw Error('read failed');return{...h.s,generation:2}},now:()=>h.now})
 h.act=action=>{h.s=act(h.s,action,h.now);h.service.changed()}
 return h
}
test('idempotent schedule, pause cancels only owned, resume replaces deadline, expiry never backfills',async()=>{
 const h=fixture();h.pending.set('foreign',{identifier:'foreign',data:{}})
 assert.equal((await h.service.reconcile()).queuedAt,t+25*60000)
 await h.service.reconcile();assert.equal(h.schedules,1)
 h.now+=60000;h.act({type:'pause'});await h.service.reconcile();assert.deepEqual([...h.pending.keys()],['foreign'])
 h.now+=60000;h.act({type:'resume'});assert.equal((await h.service.reconcile()).queuedAt,t+26*60000)
 h.now+=86400000;await h.service.reconcile();assert.equal(h.schedules,2);assert.deepEqual([...h.pending.keys()],['foreign'])
})
test('permission only on explicit opt-in; queue full, unavailable, failure never claim queued',async()=>{
 const h=fixture();h.permission={status:'denied',canAskAgain:true,detail:null}
 assert.ok((await h.service.reconcile()).error);assert.equal(h.requests,0)
 await h.service.reconcile(true);assert.equal(h.requests,1);assert.equal(h.schedules,0)
 const full=fixture();for(let i=0;i<60;i++)full.pending.set(`other-${i}`,{identifier:`other-${i}`,data:{}})
 assert.match((await full.service.reconcile()).error,/已满/);assert.equal(full.schedules,0)
 for(const failure of ['schedule','list','read']){const f=fixture();f.fail=failure;const r=await f.service.reconcile();assert.ok(r.error);assert.equal(r.queuedAt,null)}
})
test('cancellation failure is visible; disable cleans up exact namespace and no rest/focus leaks',async()=>{
 const h=fixture();await h.service.reconcile();h.act({type:'pause'});h.fail='cancel'
 assert.match((await h.service.reconcile()).error,/cancel failed/);assert.equal(h.schedules,1)
 h.fail=null;h.act({type:'reminder',enabled:false});await h.service.reconcile();assert.equal(h.pending.size,0)
 h.act({type:'reminder',enabled:true});h.act({type:'finishAndRest'});await h.service.reconcile()
 assert.match([...h.pending.keys()][0],/\.rest$/)
 h.act({type:'nextFocus'});await h.service.reconcile();assert.equal(h.pending.size,1);assert.match([...h.pending.keys()][0],/\.focus$/)
})
test('pause or backup during in-flight scheduling removes obsolete notification',async()=>{
 for(const action of ['pause','backup']){
  const h=fixture();let release;h.wait=new Promise(r=>release=r)
  const run=h.service.reconcile();while(!h.schedules)await new Promise(r=>setImmediate(r))
  const stopped=action==='backup'?h.service.suspend():null
  if(action==='pause')h.act({type:'pause'})
  release();await run;await stopped
  assert.equal(h.pending.size,0);assert.equal(h.service.getSnapshot().queuedAt,null)
  if(action==='backup'){assert.ok((await h.service.reconcile()).error);h.service.resume()}
 }
})
test('owned payload rejects restore generation, mismatched id, changed phase and forged fingerprint',()=>{
 const h=fixture(),c=focusReminderCandidate(h.s,2)
 assert.ok(parseFocusReminderTap(c.identifier,c.data,2))
 assert.equal(parseFocusReminderTap(c.identifier,c.data,3),null)
 assert.equal(parseFocusReminderTap(c.identifier,{...c.data,sessionId:9},2),null)
 assert.equal(parseFocusReminderTap(c.identifier,{...c.data,phase:'rest'},2),null)
 assert.equal(parseFocusReminderTap(c.identifier,{...c.data,fingerprint:'fake'},2),null)
 assert.equal(ownsFocusReminder('ddlmate.task-reminder.v1.1'),false)
})
test('lifecycle shares backup suspension, cleanup and foreground reconciliation without swallowing failures',async()=>{
 const h=fixture(),calls=[]
 const task={reconcile:async reason=>{calls.push(reason);return{ok:true,reason:null}},suspendForBackup:async()=>calls.push('suspend'),resumeAfterBackup:()=>calls.push('resume'),cancelAllOwnedNotifications:async()=>({ok:true,reason:null})}
 const wrapped=withFocusReminderLifecycle(task,h.service)
 await wrapped.reconcile('foreground');assert.equal(h.pending.size,1)
 await wrapped.suspendForBackup('restore');assert.equal((await wrapped.reconcile('blocked')).ok,false)
 assert.equal((await wrapped.cancelAllOwnedNotifications('restore')).ok,true);assert.equal(h.pending.size,0)
 wrapped.resumeAfterBackup();assert.ok(calls.includes('resume'))
})
