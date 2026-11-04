// Runs the actual TSX callbacks with deterministic hooks. Native rendering still needs phone QA.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as examDomain from '../src/domain/examRevision.ts'

import * as datetime from '../src/domain/datetime.ts'
import * as types from '../src/domain/types.ts'
const require = createRequire(import.meta.url), ts = require('typescript')
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
let active
const same = (a,b) => a && b && a.length === b.length && a.every((v,i) => Object.is(v,b[i]))
const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const p = {...props, children}
    return typeof type === 'function' ? type(p) : {type,props:p}
  },
  useState(value) { const h=active,i=h.pos++; if(!(i in h.slots)) h.slots[i]=typeof value==='function'?value():value; return [h.slots[i],v=>{h.slots[i]=typeof v==='function'?v(h.slots[i]):v}] },
  useRef(value) { const h=active,i=h.pos++; return h.slots[i]??={current:value} },
  useMemo(fn,deps) { const h=active,i=h.pos++; if(!h.slots[i] || !same(h.slots[i].deps,deps)) h.slots[i]={deps,value:fn()}; return h.slots[i].value },
  useCallback(fn,deps) { return React.useMemo(()=>fn,deps) },
  useEffect(fn,deps) { const h=active,i=h.pos++; if(!h.slots[i] || !same(h.slots[i].deps,deps)){h.slots[i]={deps};h.effects.push(fn)} },
}
function nodes(n, predicate, result=[]) {
  if(Array.isArray(n)) n.forEach(v=>nodes(v,predicate,result))
  else if(n?.props) {if(predicate(n))result.push(n);nodes(n.props.children,predicate,result)}
  return result
}
function text(n) { return Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):typeof n==='string'||typeof n==='number'?String(n):'' }
function compile(path,deps) {
  const code=ts.transpileModule(read(path),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
  const mod={exports:{}}
  vm.runInNewContext('(function(require,module,exports){'+code+'})',{Date})(id=>{if(id in deps)return deps[id];throw Error(id)},mod,mod.exports)
  return mod.exports
}

function fixture(screenName='ExamRevisionScreen') {
  const today=datetime.shanghaiToday(), end=datetime.addDaysToDateKey(today,2), examDate=datetime.addDaysToDateKey(today,10)
  const h={slots:[],pos:0,effects:[],now:Date.now(),nav:[],writes:[],alerts:[],plans:[],generation:0}
  const exam={id:1,title:'数学考试',type:'EXAM',status:'TODO',deadline:examDate,courseId:null,updatedAt:new Date().toISOString()}
  const store={status:'ready',data:{tasks:[exam]},notificationRouteGeneration:0,refresh:async()=>{},courseById:()=>null,examRevision:{
    load:async()=>({version:1,nextId:1,plans:h.plans,generation:store.notificationRouteGeneration}),
    create:async input=>{h.writes.push(input);if(h.fail)throw Error(h.fail);if(h.wait)await h.wait;return {committed:true,plan:{taskIds:[2,3,4]},refreshError:h.warning??null}},
  }}
  const deps={react:React,'react-native':{Alert:{alert:(...args)=>h.alerts.push(args)},Text:'Text',View:'View',StyleSheet:{create:x=>x}},
    '@react-navigation/native':{useNavigation:()=>({navigate:(...args)=>h.nav.push(args),dispatch:action=>h.nav.push(action)}),useRoute:()=>({params:{id:1}}),useFocusEffect:()=>{},usePreventRemove:(enabled,callback)=>{h.guard={enabled,callback}}},
    '../domain/calendarClock':{readShanghaiEpochClock:()=>{}},'../domain/examRevision':examDomain,'../domain/types':types,
    '../store/AppStore':{useAppStore:()=>store},'../ui/components':Object.fromEntries(['AppButton','AppTextField','LoadingState','SectionCard'].map(x=>[x,x])),
    '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/timeWheel':{DateWheelSheet:'DateWheelSheet'},
    '../ui/useFocusClock':{useFocusClock:()=>({epochMs:h.now,dateKey:datetime.shanghaiToday(new Date(h.now))})},
    '../ui/theme':{colors:{},spacing:{sm:8,md:12,xs:4},typography:{}}}
  const screens=compile('../src/screens/ExamScreens.tsx',deps)
  h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=screens[screenName]();active=null;h.effects.forEach(f=>f());return h.tree}
  h.find=p=>nodes(h.tree,p)[0];h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
  h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled,label);b.props.onPress();h.render()}
  h.fill=(label,value)=>{h.find(n=>n.type==='AppTextField'&&n.props.label===label).props.onChangeText(value);h.render()}
  h.flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();h.render()}
  h.draft=async()=>{await h.flush();h.press('结束日期：请选择');h.find(n=>n.type==='DateWheelSheet').props.onConfirm(end);h.render();h.fill('复习主题（每行一个）','第一章\n错题');h.press('预览复习安排')}
  h.store=store;h.exam=exam;h.end=end;h.render();return h
}

test('exam overview routes create as EXAM and existing detail/revision by actual id',()=>{
  const h=fixture('ExamsScreen');assert.match(text(h.tree),/距考试 10 天/)
  h.press('新增考试');h.press('查看考试');h.press('安排复习')
  assert.equal(JSON.stringify(h.nav),JSON.stringify([['TaskForm',{defaultType:'EXAM'}],['TaskDetail',{id:1}],['ExamRevision',{id:1}]]))
})
test('preview is read-only, date cancel preserves input, dirty leave protected, double confirmation commits once',async()=>{
  const h=fixture();await h.draft();assert.equal(h.writes.length,0);assert.equal(h.guard.enabled,true)
  h.press(`结束日期：${h.end}`);h.find(n=>n.type==='DateWheelSheet').props.onCancel();h.render();assert.ok(h.button(`结束日期：${h.end}`))
  let release;h.wait=new Promise(r=>{release=r});const save=h.button('确认创建复习任务').props.onPress
  save();save();assert.equal(h.writes.length,1);h.render();h.guard.callback({data:{action:'back'}});assert.equal(h.alerts[0][0],'正在保存')
  release();await h.flush();assert.match(text(h.tree),/已创建 3 条/);assert.equal(h.guard.enabled,false);assert.equal(h.button('预览复习安排').props.disabled,true)
})
test('exam edit, restore generation, and midnight invalidate preview before save',async()=>{
  for(const change of [h=>{h.exam.updatedAt='changed'},h=>{h.store.notificationRouteGeneration++},h=>{h.now+=86400000}]){
    const h=fixture();await h.draft();change(h);h.render();assert.equal(h.button('确认创建复习任务').props.disabled,true)
    h.button('确认创建复习任务').props.onPress();await h.flush();assert.equal(h.writes.length,0)
  }
})
test('committed refresh failure remains success; repository failure retains editable preview',async()=>{
  const h=fixture();await h.draft();h.warning='刷新失败';h.press('确认创建复习任务');await h.flush();assert.match(text(h.tree),/保存已成功/);assert.equal(h.writes.length,1)
  const other=fixture();await other.draft();other.fail='考试已改变';other.press('确认创建复习任务');await other.flush();assert.match(text(other.tree),/考试已改变/);assert.ok(other.button('确认创建复习任务'));assert.equal(other.guard.enabled,true)
})
test('saved plans show actual progress and deleted tasks; task link opens correct id',async()=>{
  const h=fixture();h.plans=[{id:9,examId:1,taskIds:[2,3]}];h.store.data.tasks.push({id:2,title:'复习一',status:'DONE',deadline:h.end});h.press('刷新已保存安排');await h.flush()
  assert.match(text(h.tree),/已完成 1\/2/);assert.match(text(h.tree),/任务 #3 已删除/)
  h.press(`复习一 · ${h.end} · ${types.taskStatusLabels.DONE}`);assert.equal(JSON.stringify(h.nav[0]),JSON.stringify(['TaskDetail',{id:2}]))
})

