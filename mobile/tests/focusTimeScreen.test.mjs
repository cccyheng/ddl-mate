import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as domain from '../src/domain/focusTime.ts'
const source=readFileSync(new URL('../src/screens/FocusTimeScreen.tsx',import.meta.url),'utf8')
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
const React={
 Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
 useState(value){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=typeof value==='function'?value():value;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useRef(value){const h=active,i=h.pos++;return h.slots[i]??={current:value}},
 useCallback(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn};return h.slots[i].value},
 useEffect(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps)){const old=h.slots[i];h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}},
}
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
async function fixture(options={}){
 const h={slots:[],pos:0,effects:[],clock:Date.parse('2026-11-01T00:00:00Z'),focus:null,cleanup:null,pending:null,writes:0,fail:false,s:domain.emptyFocus()}
 h.readFailure=options.readFailure??false;h.tick=undefined
 const store={restoreEpoch:0,data:{tasks:[],courses:[]},focusTime:{getReminder:()=>null,load:async()=>{if(h.readFailure)throw Error('读取失败');return{...h.s,generation:0}},act:async(revision,generation,action)=>{
   h.writes++;if(h.pending)await h.pending;if(h.fail)throw Error('测试保存失败')
   assert.equal(revision,h.s.revision);h.s=domain.applyFocusAction(h.s,action,h.clock);return{...h.s,generation:0}
 }}}
 const deps={react:React,'react-native':{Text:'Text',View:'View',StyleSheet:{create:x=>x},Keyboard:{dismiss:()=>{h.keyboardDismissed=(h.keyboardDismissed??0)+1}}},
 '@react-navigation/native':{useRoute:()=>({key:'focus-route'}),useFocusEffect:fn=>{if(h.focus!==fn){h.cleanup?.();h.focus=fn;h.effect=fn}}},
 '../navigation/navigationDraftGuard':{setNavigationDraftDirty:(key,name,dirty)=>{h.dirty=dirty},clearNavigationDraft:()=>{}},
 '../store/AppStore':{useAppStore:()=>store},'../domain/focusTime':domain,
 '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/components':{AppButton:'AppButton',AppTextField:'AppTextField',SectionCard:'SectionCard',OptionGroup:'OptionGroup'},'../ui/timeWheel':{DurationWheelSheet:'DurationWheelSheet'},
 '../ui/dialog':{ConfirmDialog:'ConfirmDialog'},'../ui/useFocusClock':{useFocusClock:()=>h.tick??h.clock},
 '../ui/FocusDial':{FocusDial:'FocusDial'},'../ui/FocusFullscreen':{FocusFullscreen:'FocusFullscreen'},
 '../ui/FocusRecordManager':{FocusRecordManager:'FocusRecordManager'},
 '../ui/theme':{colors:{},spacing:{},typography:{}},}
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 class ClockDate extends Date { static now(){return h.clock} }
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{Date:ClockDate})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.store=store
 h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=mod.exports.FocusTimeScreen();if(h.effect){const fn=h.effect;h.effect=null;h.cleanup=fn()}h.effects.splice(0).forEach(fn=>fn())}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.button=label=>nodes(h.tree,n=>n.type==='AppButton'&&n.props.label===label)[0]
 h.press=label=>{const button=h.button(label);assert.ok(button,label);button.props.onPress();h.render()}
 h.dialog=()=>nodes(h.tree,n=>n.type==='ConfirmDialog')[0]
 h.fullscreen=()=>nodes(h.tree,n=>n.type==='FocusFullscreen')[0]
 h.find=p=>nodes(h.tree,p)[0]
 h.render();await h.flush();return h
}
test('actual screen locks double tap, cancels finish, persists pause/resume and confirmed save once',async()=>{
 const h=await fixture();let release;h.pending=new Promise(r=>release=r)
 const start=h.button('开始专注');start.props.onPress();start.props.onPress();assert.equal(h.writes,1)
 release();h.pending=null;await h.flush();h.clock+=60000
 h.press('暂停一下');await h.flush();assert.equal(h.s.active.runningSince,null)
 h.clock+=60000;h.press('继续专注');await h.flush();h.clock+=60000
 h.press('结束并保存');h.fullscreen().props.onCancelConfirm();h.render();assert.equal(h.s.records.length,0)
 h.press('结束并保存');h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.records.length,1);assert.equal(domain.focusDuration(h.s.records[0],h.clock),120000)
 h.cleanup?.()
})
test('actual screen surfaces save failure, rereads persisted state, can retry',async()=>{
 const h=await fixture();h.fail=true;h.press('开始专注');await h.flush()
 assert.equal(h.s.active,null);assert.ok(h.button('重新读取状态'))
 h.fail=false;h.press('开始专注');await h.flush();assert.ok(h.button('暂停一下'))
 h.cleanup?.()
})

test('history callback uses original revision after refreshed state; dirty history blocks a new timer',async()=>{
 const h=await fixture(),manager=()=>h.find(n=>n.type==='FocusRecordManager')
 const expected=manager().props.snapshot,action={type:'historySave',title:'补记',courseName:'',intervals:[{start:h.clock-120000,end:h.clock-60000}]}
 manager().props.onDirtyChange(true);h.render();assert.equal(h.dirty,true);assert.equal(h.button('开始专注').props.disabled,true)
 h.s={...h.s,revision:1}
 assert.equal(await manager().props.onAction(action,expected),false);await h.flush()
 assert.equal(manager().props.snapshot.revision,1)
 assert.equal(await manager().props.onAction(action,expected),false);assert.equal(h.s.records.length,0)
 manager().props.onDirtyChange(false);h.render();assert.equal(h.button('开始专注').props.disabled,false)
 assert.equal(await manager().props.onAction(action,manager().props.snapshot),true);await h.flush();assert.equal(h.s.records.length,1)
 h.cleanup?.()
})
test('failed initial read is not presented as zero totals or an empty history, retry recovers',async()=>{
 const h=await fixture({readFailure:true})
 const content=JSON.stringify(h.tree)
 assert.match(content,/时长暂时无法读取/);assert.match(content,/原数据会保留/)
 assert.doesNotMatch(content,/今日 00:00:00|结束第一段专注后/)
 assert.equal(h.button('开始专注'),undefined)
 h.readFailure=false;h.press('重新读取状态');await h.flush()
 assert.ok(h.button('开始专注'));h.cleanup?.()
})
test('starting between timer ticks does not show a false backward-clock warning',async()=>{
 const h=await fixture();h.tick=h.clock-500;h.press('开始专注');await h.flush()
 assert.ok(h.button('暂停一下'));assert.equal(h.button('舍弃未确认时段'),undefined)
 h.clock-=1000;h.render();assert.ok(h.button('舍弃未确认时段'))
 h.cleanup?.()
})
test('fullscreen entry/exit is presentation only; start enters immersion; pause/resume share the screen act',async()=>{
 const h=await fixture()
 assert.equal(h.fullscreen().props.visible,false);assert.equal(h.writes,0)
 h.press('全屏准备');h.render()
 assert.equal(h.fullscreen().props.visible,true);assert.equal(h.writes,0)
 h.fullscreen().props.onStart();await h.flush()
 assert.equal(h.writes,1);assert.ok(h.s.active);assert.equal(h.fullscreen().props.visible,true)
 const running=h.s.active.runningSince
 h.clock+=60000;h.render()
 const revision=h.s.revision
 h.fullscreen().props.onExit();h.render()
 assert.equal(h.fullscreen().props.visible,false)
 assert.equal(h.writes,1);assert.equal(h.s.revision,revision);assert.equal(h.s.active.runningSince,running)
 h.clock+=1000;h.press('全屏专注');h.render()
 assert.equal(h.fullscreen().props.visible,true);assert.equal(h.writes,1)
 h.fullscreen().props.onPauseResume();await h.flush()
 assert.equal(h.s.active.runningSince,null);assert.equal(h.writes,2)
 h.fullscreen().props.onPauseResume();await h.flush()
 assert.equal(typeof h.s.active.runningSince,'number');assert.equal(h.writes,3)
 h.cleanup?.()
})
test('fullscreen finish confirmation cancel retains timer, confirm writes exactly once, failure stays in the active surface',async()=>{
 const h=await fixture();h.press('开始专注');await h.flush()
 assert.equal(h.fullscreen().props.visible,true)
 h.fullscreen().props.onFinish();h.render();assert.equal(h.fullscreen().props.confirm,'finish')
 h.fullscreen().props.onCancelConfirm();h.render()
 assert.equal(h.fullscreen().props.confirm,null);assert.equal(h.writes,1);assert.ok(h.s.active)
 h.fullscreen().props.onFinish();h.render()
 let release;h.pending=new Promise(r=>release=r)
 h.fullscreen().props.onConfirm();h.fullscreen().props.onConfirm()
 assert.equal(h.writes,2)
 release();h.pending=null;await h.flush()
 assert.equal(h.s.records.length,1);assert.equal(h.fullscreen().props.visible,true)
 h.press('开始专注');await h.flush();assert.equal(h.writes,3)
 h.fail=true
 h.fullscreen().props.onFinish();h.render();h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.records.length,1);assert.ok(h.s.active)
 assert.match(h.fullscreen().props.error,/测试保存失败/)
 assert.equal(h.fullscreen().props.confirm,null)
 h.fail=false;h.fullscreen().props.onRetry();await h.flush();assert.equal(h.fullscreen().props.error,'')
 h.fullscreen().props.onDiscard();h.render();assert.equal(h.fullscreen().props.confirm,'discard')
 h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.active,null);assert.match(h.fullscreen().props.message,/已放弃/)
 h.cleanup?.()
})
test('fullscreen exit is blocked while a finish write is in flight, no second modal, settled exit clears confirm',async()=>{
 const h=await fixture();h.press('开始专注');await h.flush()
 h.fullscreen().props.onFinish();h.render()
 let release;h.pending=new Promise(r=>release=r)
 h.fullscreen().props.onConfirm()
 h.fullscreen().props.onExit();h.render()
 assert.equal(h.fullscreen().props.visible,true)
 assert.equal(h.fullscreen().props.confirm,'finish')
 assert.equal(h.dialog(),undefined)
 h.fullscreen().props.onCancelConfirm();h.render()
 assert.equal(h.fullscreen().props.confirm,'finish')
 release();h.pending=null;await h.flush()
 assert.equal(h.s.records.length,1);assert.equal(h.fullscreen().props.visible,true)
 h.fullscreen().props.onExit();h.render()
 assert.equal(h.fullscreen().props.visible,false);assert.equal(h.fullscreen().props.confirm,null);assert.equal(h.dialog(),undefined)
 h.cleanup?.()
})
test('fullscreen expired focus saves and rests, explicit next round, cancel keeps the rest timer',async()=>{
 const h=await fixture()
 h.find(n=>n.type==='OptionGroup'&&n.props.label==='计时方式').props.onChange('countdown');h.render()
 h.press('开始专注');await h.flush()
 h.clock+=26*60000;h.render()
 assert.equal(h.fullscreen().props.expired,true);assert.match(h.fullscreen().props.stateLabel,/本轮完成/)
 assert.equal(h.fullscreen().props.rest,false)
 h.fullscreen().props.onFinishAndRest();h.render();assert.equal(h.fullscreen().props.confirm,'finishAndRest')
 h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.records.length,1);assert.equal(h.s.active.timer.kind,'rest');assert.equal(h.fullscreen().props.rest,true)
 h.clock+=26*60000;h.render()
 assert.equal(h.fullscreen().props.expired,true);assert.match(h.fullscreen().props.stateLabel,/休息结束/)
 h.fullscreen().props.onNextFocus();h.render();assert.equal(h.fullscreen().props.confirm,'nextFocus')
 h.fullscreen().props.onCancelConfirm();h.render();assert.equal(h.s.active.timer.kind,'rest')
 h.fullscreen().props.onNextFocus();h.render();h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.active.timer.kind,'focus');assert.equal(h.s.records.length,1);h.cleanup?.()
})
test('focus loss and restore epoch close fullscreen without touching the running timer',async()=>{
 const h=await fixture();h.press('开始专注');await h.flush()
 assert.equal(h.writes,1);assert.equal(h.fullscreen().props.visible,true)
 const running=h.s.active.runningSince,writes=h.writes
 h.cleanup?.();h.render()
 assert.equal(h.fullscreen().props.visible,false)
 assert.equal(h.writes,writes);assert.equal(h.s.active.runningSince,running)
 h.store.restoreEpoch++;h.render();await h.flush()
 assert.equal(h.fullscreen().props.visible,false);assert.equal(h.fullscreen().props.active,true)
 assert.equal(h.writes,writes);h.cleanup?.()
})
test('countdown selection, wheel cancel/confirm, expiry, save/rest/next round and reminder opt-in use real callbacks',async()=>{
 const h=await fixture()
 h.find(n=>n.type==='OptionGroup'&&n.props.label==='计时方式').props.onChange('countdown');h.render();assert.equal(h.dirty,true)
 h.press('专注 25 分钟 · 滚轮选择');h.find(n=>n.type==='DurationWheelSheet').props.onCancel();h.render();assert.ok(h.button('专注 25 分钟 · 滚轮选择'))
 h.press('专注 25 分钟 · 滚轮选择');h.find(n=>n.type==='DurationWheelSheet').props.onConfirm(1);h.render()
 h.find(n=>n.type==='OptionGroup'&&n.props.label==='手机通知').props.onChange('on');await h.flush();assert.equal(h.s.reminderEnabled,true)
 h.press('开始专注');await h.flush();assert.equal(h.s.active.timer.focusMinutes,1)
 h.clock+=120000;h.render();assert.match(JSON.stringify(h.tree),/本轮完成/);assert.equal(h.button('暂停一下'),undefined)
 h.press('保存并开始休息');h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.records.length,1);assert.equal(h.s.active.timer.kind,'rest');assert.equal(domain.focusDuration(h.s.records[0],h.clock),60000)
 assert.match(JSON.stringify(h.tree),/休息不会计入/)
 h.press('开始下一轮专注');h.fullscreen().props.onCancelConfirm();h.render();assert.equal(h.s.active.timer.kind,'rest')
 h.press('开始下一轮专注');h.fullscreen().props.onConfirm();await h.flush()
 assert.equal(h.s.active.timer.kind,'focus');assert.equal(h.s.records.length,1);h.cleanup?.()
})
