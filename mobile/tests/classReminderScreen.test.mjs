// Execute actual screen callbacks with deterministic hooks; native layout/delivery still require phone QA.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import * as rules from '../src/domain/classReminder.ts'
const require=createRequire(import.meta.url),ts=require('typescript')
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]))
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
 useState(v){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=typeof v==='function'?v():v;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useRef(v){const h=active,i=h.pos++;return h.slots[i]??={current:v}},
 useEffect(fn,deps){const h=active,i=h.pos++,old=h.slots[i];if(!old||!same(old.deps,deps)){h.slots[i]={deps,cleanup:old?.cleanup};h.effects.push(()=>{h.slots[i].cleanup?.();h.slots[i].cleanup=fn()})}},
}
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(v=>nodes(v,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
const tick=()=>new Promise(r=>setImmediate(r))
async function fixture(){let notify,release;const calls={save:[],test:0};let snapshot={settings:rules.defaultClassReminderSettings(),busy:false,error:null,queued:[],eligibleCount:0,checkedAt:1,permission:'granted',testQueued:false}
 const service={getSnapshot:()=>snapshot,subscribe:fn=>{notify=fn;return()=>{}},reconcile:async()=>snapshot,save:async input=>{calls.save.push(input);await new Promise(r=>release=r);snapshot={...snapshot,settings:input};return snapshot},test:async()=>{calls.test++;return{...snapshot,testQueued:true}}}
 const nav={dispatch:()=>{},navigate:()=>{}},widgets=new Proxy({},{get:(_,key)=>String(key)}),h={slots:[],pos:0,effects:[]}
 const deps={react:React,'react-native':{Linking:{openSettings:async()=>{}},Text:'Text',View:'View',StyleSheet:{create:x=>x}},'@react-navigation/native':{useNavigation:()=>nav,usePreventRemove:(dirty,fn)=>{h.blocked=dirty;h.prevent=fn}},'../store/AppStore':{useAppStore:()=>({getClassReminder:()=>service})},'../domain/classReminder':rules,'../ui/theme':{colors:{},spacing:{},typography:{}}}
 const code=ts.transpileModule(readFileSync(new URL('../src/screens/ClassReminderScreen.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,mod={exports:{}}
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{if(id in deps)return deps[id];if(id.startsWith('../ui/'))return widgets;throw Error(id)},mod,mod.exports)
 h.render=()=>{h.pos=0;h.effects=[];active=h;h.tree=mod.exports.ClassReminderScreen();active=null;h.effects.splice(0).forEach(f=>f());return h.tree};h.find=p=>nodes(h.tree,p)[0];h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
 h.render();await tick();h.render();return{h,calls,release:()=>release(),push:v=>{snapshot={...snapshot,...v};notify()}}
}
test('dirty edits survive service refresh; save double tap calls store once, commits then clears guard',async()=>{
 const f=await fixture(),h=f.h
 h.find(n=>n.type==='OptionGroup'&&n.props.label==='课前提醒').props.onChange('ON');h.render()
 h.find(n=>n.type==='OptionGroup'&&n.props.label==='提前多久').props.onChange(30);h.render();assert.equal(h.blocked,true)
 f.push({settings:{version:1,enabled:false,leadMinutes:5}});h.render();assert.equal(h.find(n=>n.type==='OptionGroup'&&n.props.label==='提前多久').props.value,30)
 const save=h.button('保存设置');save.props.onPress();save.props.onPress();assert.equal(f.calls.save.length,1);assert.equal(f.calls.save[0].leadMinutes,30)
 f.release();await tick();h.render();assert.equal(h.blocked,false)
})
test('test action does not save opt-in; unknown queue never claims confirmed zero',async()=>{
 const f=await fixture();f.h.button('测试提醒（10 秒后）').props.onPress();await tick();f.h.render();assert.equal(f.calls.test,1);assert.equal(f.calls.save.length,0)
 f.push({checkedAt:null,error:'OS unavailable'});f.h.render();assert.ok(f.h.find(n=>n.type==='SectionCard'&&n.props.title==='近期提醒（尚未确认）'))
})
