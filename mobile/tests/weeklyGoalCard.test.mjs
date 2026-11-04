import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as goals from '../src/domain/weeklyGoal.ts'
import {emptyFocus} from '../src/domain/focusTime.ts'
import * as guard from '../src/navigation/navigationDraftGuard.ts'
import {currentRouteBlocksNotificationOpen} from '../src/navigation/taskReminderNotificationRouter.ts'
import * as wheelRules from '../src/domain/timeWheel.ts'
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
function compile(path,deps){const mod={exports:{}},source=readFileSync(new URL(path,import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports);return mod.exports}
function fixture(){
 guard.resetNavigationDraftGuardForTests()
 const h={slots:[],pos:0,effects:[],props:{now:Date.parse('2026-11-02T02:00:00Z')},calls:0,state:{goals:goals.emptyWeeklyGoals(),focus:emptyFocus(),generation:0}}
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState:v=>{const i=h.pos++;if(!(i in h.slots))h.slots[i]=v;return[h.slots[i],v=>h.slots[i]=v]},useRef:v=>{const i=h.pos++;return h.slots[i]??={current:v}},
  useCallback:(fn,deps)=>{const i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn};return h.slots[i].value},
  useEffect:(fn,deps)=>{const i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps)){const old=h.slots[i];h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}}}
 const store={restoreEpoch:0,backup:{gate:'idle'},weeklyGoal:{load:async()=>{if(h.wait)return h.wait;if(h.readFail)throw Error('读取失败');return h.state},save:async(revision,generation,week,minutes)=>{h.calls++;if(h.writeWait)await h.writeWait;if(h.saveFail)throw Error('保存失败');assert.equal(revision,h.state.goals.revision);assert.equal(generation,h.state.generation);h.state={...h.state,goals:goals.changeWeeklyGoal(h.state.goals,week,minutes,h.props.now)};return h.state.goals}}}
 const module=compile('../src/ui/WeeklyGoalCard.tsx',{react:React,'react-native':{Text:'Text',View:'View',StyleSheet:{create:x=>x}},'@react-navigation/native':{useRoute:()=>({name:'Today',key:'today'}),useFocusEffect:fn=>{if(h.focus!==fn){h.cleanup?.();h.focus=fn;h.effect=fn}}},'../store/AppStore':{useAppStore:()=>store},'../domain/weeklyGoal':goals,'../navigation/navigationDraftGuard':guard,'./components':{AppButton:'AppButton',SectionCard:'SectionCard'},'./timeWheel':{WeeklyGoalWheelSheet:'Wheel'},'./theme':{colors:{},typography:{}}})
 h.render=()=>{h.pos=0;h.tree=module.WeeklyGoalCard(h.props);if(h.effect){const fn=h.effect;h.effect=null;h.cleanup=fn()}h.effects.splice(0).forEach(fn=>fn())}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render();await Promise.resolve();h.render()}
 h.button=label=>nodes(h.tree,n=>n.type==='AppButton'&&n.props.label===label)[0]
 h.press=label=>{assert.ok(h.button(label),label);h.button(label).props.onPress();h.render()}
 h.json=()=>JSON.stringify(h.tree)
 h.restore=()=>{store.restoreEpoch++;h.render()};h.close=()=>{h.cleanup?.();guard.resetNavigationDraftGuardForTests()}
 return h
}
test('actual goal card wheel draft/cancel, dirty protection, save retry/double tap and disable',async()=>{
 const h=fixture();try{
  h.render();await h.flush();h.press('设置本周目标')
  assert.equal(currentRouteBlocksNotificationOpen({name:'Today',key:'today'},guard.isNavigationDraftDirty),true)
  h.press('目标时长：5 小时 · 滚轮选择');nodes(h.tree,n=>n.type==='Wheel')[0].props.onCancel();h.render()
  h.press('目标时长：5 小时 · 滚轮选择');nodes(h.tree,n=>n.type==='Wheel')[0].props.onConfirm(90);h.render()
  h.saveFail=true;h.press('保存目标');await h.flush();assert.match(h.json(),/保存失败/);assert.ok(h.button('目标时长：1 小时 30 分钟 · 滚轮选择'))
  h.saveFail=false;let release;h.writeWait=new Promise(r=>release=r)
  const press=h.button('保存目标').props.onPress;press();press();h.render();assert.equal(h.calls,2);release();await h.flush()
  assert.equal(h.state.goals.weeks['2026-11-02'],90);assert.match(h.json(),/0%/)
  assert.equal(currentRouteBlocksNotificationOpen({name:'Today',key:'today'},guard.isNavigationDraftDirty),false)
  h.press('调整本周目标');h.press('关闭本周目标');await h.flush();assert.equal(h.state.goals.weeks['2026-11-02'],undefined)
  h.press('设置本周目标');h.press('取消');assert.equal(h.calls,3)
 }finally{h.close()}
})
test('actual card separates failed read, rejects stale async restore data, and historical week has no edit',async()=>{
 const h=fixture();try{
  h.readFail=true;h.render();await h.flush();assert.match(h.json(),/暂时无法读取/);assert.doesNotMatch(h.json(),/目标已达成|0%/)
  h.readFail=false;let release;h.wait=new Promise(r=>release=r);h.press('重新读取学习目标')
  h.wait=null;h.restore();await h.flush();release({...h.state,goals:goals.changeWeeklyGoal(h.state.goals,'2026-11-02',600,h.props.now)})
  await h.flush();assert.ok(h.button('设置本周目标'));assert.doesNotMatch(h.json(),/10 小时/)
  h.props.week='2026-10-26';h.render();await h.flush();assert.match(h.json(),/没有设置学习目标/);assert.equal(h.button('设置本周目标'),undefined)
 }finally{h.close()}
})
test('actual weekly wheel commits final synchronous columns, clamps edges, cancel does not commit',()=>{
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),useMemo:fn=>fn(),useState:v=>[v,()=>{}],useRef:v=>({current:v})}
 const mod=compile('../src/ui/timeWheel.tsx',{react:React,'react-native':{StyleSheet:{create:x=>x},View:'View',Text:'Text'},'react-native-safe-area-context':{},'./motion':{},'../domain/datetime':{},'../domain/timeWheel':wheelRules,'./components':{},'./theme':{colors:{},spacing:{},radius:{},typography:{},MIN_TOUCH_SIZE:44}})
 const saved=[];let cancelled=0
 const sheet=mod.WeeklyGoalWheelSheet({value:300,onCancel:()=>cancelled++,onConfirm:v=>saved.push(v)})
 const [hours,minutes]=sheet.props.children[0].props.children
 hours.props.onChange(1);minutes.props.onChange(3);sheet.props.onConfirm();assert.deepEqual(saved,[105])
 hours.props.onChange(168);sheet.props.onConfirm();assert.equal(saved.at(-1),10080)
 hours.props.onChange(0);minutes.props.onChange(0);sheet.props.onConfirm();assert.equal(saved.at(-1),15)
 sheet.props.onCancel();assert.equal(cancelled,1);assert.equal(saved.length,3)
})
