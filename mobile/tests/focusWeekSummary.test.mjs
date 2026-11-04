import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as domain from '../src/domain/focusTime.ts'
const source=readFileSync(new URL('../src/ui/FocusWeekSummary.tsx',import.meta.url),'utf8')
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function fixture(){
 const h={slots:[],pos:0,focus:null,cleanup:null,loads:0,fail:false,snapshot:domain.emptyFocus(),
  props:{startDateKey:'2026-10-26',now:Date.parse('2026-11-03T00:00:00Z')}}
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState(value){const i=h.pos++;if(!(i in h.slots))h.slots[i]=value;return[h.slots[i],v=>h.slots[i]=v]},
  useRef(value){const i=h.pos++;return h.slots[i]??={current:value}},
  useCallback(fn,deps){const i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn};return h.slots[i].value}}
 const store={restoreEpoch:0,focusTime:{load:async()=>{h.loads++;if(h.wait)return h.wait;if(h.fail)throw Error('无法读取');return h.snapshot}}}
 const deps={react:React,'react-native':{Text:'Text'},'@react-navigation/native':{useFocusEffect:fn=>{
  if(h.focus!==fn){h.cleanup?.();h.focus=fn;h.effect=fn}}},'../store/AppStore':{useAppStore:()=>store},
  '../domain/focusTime':domain,'./components':{AppButton:'AppButton',SectionCard:'SectionCard'},'./theme':{typography:{}}}
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{h.pos=0;h.tree=mod.exports.FocusWeekSummary(h.props);if(h.effect){const fn=h.effect;h.effect=null;h.cleanup=fn()}}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.refocus=()=>{h.cleanup?.();h.focus=null;h.render()}
 h.restore=()=>{store.restoreEpoch++;h.render()}
 h.json=()=>JSON.stringify(h.tree)
 return h
}
function recordAcrossMonday(){
 const midnight=domain.focusDayStart('2026-11-02')
 let s=domain.applyFocusAction(domain.emptyFocus(),{type:'start',title:'跨周学习',courseName:''},midnight-60000)
 return domain.applyFocusAction(s,{type:'finish'},midnight+120000)
}
test('actual summary displays selected week, splits a cross-week record, and refreshes on return',async()=>{
 const h=fixture();h.snapshot=recordAcrossMonday();h.render();await h.flush()
 assert.match(h.json(),/00:01:00/)
 h.props.startDateKey='2026-11-02';h.render();assert.match(h.json(),/00:02:00/)
 assert.equal(h.loads,1)
 h.snapshot=domain.emptyFocus();h.refocus();await h.flush()
 assert.match(h.json(),/00:00:00/);assert.equal(h.loads,2);h.cleanup?.()
})
test('actual summary distinguishes failed reads and ignores old async data after restore',async()=>{
 const h=fixture();h.fail=true;h.render();await h.flush()
 assert.match(h.json(),/暂时无法读取/);assert.doesNotMatch(h.json(),/00:00:00/)
 h.fail=false;let release;h.wait=new Promise(r=>release=r);h.refocus()
 h.wait=null;h.snapshot=domain.emptyFocus();h.restore();await h.flush()
 release(recordAcrossMonday());await h.flush()
 assert.match(h.json(),/00:00:00/);assert.doesNotMatch(h.json(),/00:01:00/);h.cleanup?.()
})
