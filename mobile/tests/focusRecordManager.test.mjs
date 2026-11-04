import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as domain from '../src/domain/focusTime.ts'
import * as history from '../src/domain/focusHistory.ts'
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
function fixture(initial=domain.emptyFocus()){
 const h={slots:[],pos:0,effects:[],now:Date.parse('2026-11-03T04:00:00Z'),calls:[],dirty:false,wait:null,fail:false}
 const React={Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState:v=>{const i=h.pos++;if(!(i in h.slots))h.slots[i]=v;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
  useRef:v=>{const i=h.pos++;return h.slots[i]??={current:v}},
  useEffect:(fn,deps)=>{const i=h.pos++,old=h.slots[i];if(!old||!same(old.deps,deps)){h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}}}
 h.props={snapshot:{...initial,generation:0},busy:false,onDirtyChange:value=>h.dirty=value,onAction:async(action,expected)=>{
  h.calls.push({action,expected});if(h.wait)await h.wait;if(h.throw)throw Error('服务暂不可用');if(h.fail)return false
  if(expected.revision!==h.props.snapshot.revision||expected.generation!==h.props.snapshot.generation)return false
  h.props.snapshot={...domain.applyFocusAction(h.props.snapshot,action,h.now),generation:h.props.snapshot.generation};return true
 }}
 const deps={react:React,'react-native':{Text:'Text',View:'View',StyleSheet:{create:x=>x}},'../domain/focusTime':domain,'../domain/focusHistory':history,
  './components':{AppButton:'AppButton',AppTextField:'Field',SectionCard:'SectionCard'},'./datetimeField':{WallClockField:'Clock'},'./dialog':{ConfirmDialog:'Confirm'},'./theme':{colors:{},typography:{}}}
 const mod={exports:{}},source=readFileSync(new URL('../src/ui/FocusRecordManager.tsx',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 class ClockDate extends Date{static now(){return h.now}}
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{Date:ClockDate})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{h.pos=0;h.tree=mod.exports.FocusRecordManager(h.props);h.effects.splice(0).forEach(fn=>fn())}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.find=p=>nodes(h.tree,p)[0]
 h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
 h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled,label);b.props.onPress();h.render()}
 h.field=(label,value)=>{const n=h.find(n=>n.props.label===label);assert.ok(n,label);(n.props.onChangeText??n.props.onChange)(value);h.render()}
 h.dialog=()=>h.find(n=>n.type==='Confirm');h.json=()=>JSON.stringify(h.tree)
 h.close=()=>h.slots.forEach(x=>x?.cleanup?.())
 h.render();return h
}
function fill(h){h.field('学习内容','补记复习');h.field('第 1 段开始','2026-11-02T10:00');h.field('第 1 段结束','2026-11-02T10:15')}
function timed(){const t=Date.parse('2026-11-02T00:00:01.234Z');let s=domain.applyFocusAction(domain.emptyFocus(),{type:'start',title:'原名称',courseName:'课程',timer:{kind:'focus',focusMinutes:25,restMinutes:5}},t);s=domain.applyFocusAction(s,{type:'pause'},t+60000);s=domain.applyFocusAction(s,{type:'resume'},t+120000);return domain.applyFocusAction(s,{type:'finish'},t+180000)}
test('actual manager validates before confirmation, cancel preserves draft, failed save retries and double taps save once',async()=>{
 const h=fixture();try{
  h.press('补记学习时段');assert.equal(h.dirty,true);h.press('核对并保存记录');assert.equal(h.dialog().props.visible,false);assert.match(h.json(),/完整的日期/)
  fill(h);h.field('第 1 段结束','2026-11-04T10:00');h.press('核对并保存记录');assert.equal(h.dialog().props.visible,false);assert.match(h.json(),/未来/)
  h.field('第 1 段结束','2026-11-02T10:15');h.press('核对并保存记录');assert.match(h.dialog().props.message,/00:15:00/)
  h.dialog().props.onCancel();h.render();assert.equal(h.calls.length,0);assert.equal(h.find(n=>n.type==='Field'&&n.props.label==='学习内容').props.value,'补记复习')
  h.fail=true;h.press('核对并保存记录');h.dialog().props.onConfirm();await h.flush();assert.match(h.json(),/草稿仍保留/);assert.equal(h.props.snapshot.records.length,0)
  h.fail=false;let release;h.wait=new Promise(r=>release=r);h.press('核对并保存记录');const confirm=h.dialog().props.onConfirm;confirm();confirm();assert.equal(h.calls.length,2);release();await h.flush()
  assert.equal(h.props.snapshot.records.length,1);assert.match(h.json(),/手动补记/);assert.equal(h.dirty,false)
  h.press('查看明细');assert.match(h.json(),/2026-11-02 10:00:00/);assert.match(h.json(),/00:15:00/)
 }finally{h.close()}
})
test('actual correction keeps paused intervals and exact seconds, stale edits stay stale after refresh, delete requires confirmation',async()=>{
 const initial=timed(),h=fixture(initial);try{
  h.press('查看明细');h.press('更正这条记录');h.field('学习内容','纠正名称')
  const captured=h.props.snapshot.revision;h.props.snapshot={...h.props.snapshot,revision:captured+1};h.render()
  h.press('核对并保存记录');h.dialog().props.onConfirm();await h.flush();assert.equal(h.calls.at(-1).expected.revision,captured);assert.equal(h.props.snapshot.records[0].title,'原名称')
  h.press('核对并保存记录');h.dialog().props.onConfirm();await h.flush();assert.equal(h.calls.at(-1).expected.revision,captured)
  h.press('取消编辑');h.press('更正这条记录');h.field('学习内容','纠正名称');h.press('核对并保存记录');h.dialog().props.onConfirm();await h.flush()
  assert.deepEqual(h.props.snapshot.records[0].intervals,initial.records[0].intervals);assert.equal(h.props.snapshot.records[0].title,'纠正名称');assert.equal(domain.focusDuration(h.props.snapshot.records[0],h.now),120000)
  h.press('查看明细');h.press('删除这条记录');assert.match(h.dialog().props.message,/00:02:00/);assert.equal(h.dialog().props.danger,true)
  h.dialog().props.onCancel();h.render();assert.equal(h.props.snapshot.records.length,1)
  h.press('删除这条记录');const confirm=h.dialog().props.onConfirm;confirm();confirm();await h.flush();assert.equal(h.props.snapshot.records.length,0);assert.equal(h.props.snapshot.nextId,2)
 }finally{h.close()}
})
test('active history is read-only; rejected callback retains edits and post-unmount completion does not resurrect UI',async()=>{
 const s=domain.applyFocusAction(timed(),{type:'start',title:'正在学习',courseName:''},Date.parse('2026-11-03T00:00:00Z'))
 const h=fixture(s);assert.equal(h.button('补记学习时段').props.disabled,true);h.press('查看明细');assert.equal(h.button('更正这条记录').props.disabled,true);assert.equal(h.button('删除这条记录').props.disabled,true);h.close()
 const e=fixture();e.press('补记学习时段');fill(e);e.throw=true;e.press('核对并保存记录');e.dialog().props.onConfirm();await e.flush();assert.match(e.json(),/服务暂不可用/);assert.ok(e.button('取消编辑'))
 e.throw=false;let release;e.wait=new Promise(r=>release=r);e.press('核对并保存记录');e.dialog().props.onConfirm();e.close();assert.equal(e.dirty,false);release();await new Promise(r=>setImmediate(r));assert.equal(e.dirty,false)
})
