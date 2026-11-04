import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as rules from '../src/domain/focusReminder.ts'
import {applyFocusAction as act,emptyFocus,focusDayStart} from '../src/domain/focusTime.ts'
import {currentRouteBlocksNotificationOpen} from '../src/navigation/taskReminderNotificationRouter.ts'
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
async function fixture(){
 const t=focusDayStart('2026-11-02'),s=act(act(emptyFocus(),{type:'start',title:'复习',courseName:'',timer:{kind:'focus',focusMinutes:1,restMinutes:5}},t),{type:'reminder',enabled:true},t)
 const c=rules.focusReminderCandidate(s,0),h={slots:[],pos:0,effects:[],nav:[],generation:0,gate:'idle',ready:true,route:'TodayHome',dirty:false,wait:null,s,clears:0,removed:0}
 const response={actionIdentifier:'default',notification:{date:t+60000,request:{identifier:c.identifier,content:{data:c.data}}}}
 h.last=response
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState(v){const i=h.pos++;if(!(i in h.slots))h.slots[i]=typeof v==='function'?v():v;return[h.slots[i],x=>h.slots[i]=typeof x==='function'?x(h.slots[i]):x]},
  useRef(v){const i=h.pos++;return h.slots[i]??={current:v}},
  useEffect(fn,deps){const i=h.pos++,old=h.slots[i];if(!old||!same(old.deps,deps)){h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}}}
 const api={DEFAULT_ACTION_IDENTIFIER:'default',getLastNotificationResponse:()=>h.last,clearLastNotificationResponseAsync:async()=>{h.clears++;h.last=null},addNotificationResponseReceivedListener:fn=>{h.listener=fn;return{remove:()=>h.removed++}}}
 const store={status:'ready',get backup(){return{gate:h.gate}},getNotificationRouteGeneration:()=>h.generation,focusTime:{load:async()=>{if(h.wait)return h.wait;return{...h.s,generation:h.generation}}}}
 const nav={isReady:()=>h.ready,getCurrentRoute:()=>({name:h.route,key:'current'}),getRootState:()=>({routes:[{name:'Today',key:'today-tab',state:{routes:[{name:h.route,key:'current'}]}}]}),navigate:(...args)=>h.nav.push(args)}
 const deps={react:React,'react-native':{Text:'Text',View:'View',StyleSheet:{create:x=>x}},'react-native-safe-area-context':{useSafeAreaInsets:()=>({bottom:34})},
  '../navigation/navigationDraftGuard':{isNavigationDraftDirty:()=>h.dirty},'../navigation/taskReminderNotificationRouter':{currentRouteBlocksNotificationOpen},
  '../store/AppStore':{useAppStore:()=>store},'../domain/focusReminder':rules,'./components':{AppButton:'AppButton'},'./theme':{colors:{},radius:{},spacing:{},typography:{}},'expo-notifications':api}
 const code=ts.transpileModule(readFileSync(new URL('../src/ui/FocusReminderNotificationBanner.tsx',import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,mod={exports:{}}
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{h.pos=0;h.effects=[];h.tree=mod.exports.FocusReminderNotificationBanner({navigationRef:nav,ready:h.ready});h.effects.splice(0).forEach(fn=>fn())}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.button=label=>nodes(h.tree,n=>n.type==='AppButton'&&n.props.label===label)[0]
 h.close=()=>h.slots.forEach(x=>x?.cleanup?.())
 h.render();await h.flush();return h
}
test('cold tap waits for explicit open, navigates correct screen once and clears only matching response',async()=>{
 const h=await fixture();assert.ok(h.button('查看番茄钟'));assert.equal(h.nav.length,0)
 const button=h.button('查看番茄钟');button.props.onPress();button.props.onPress();await h.flush()
 assert.equal(h.nav.length,1);assert.equal(h.nav[0][0],'Today');assert.equal(h.nav[0][1].screen,'FocusTime');assert.equal(h.nav[0][1].initial,false)
 assert.equal(h.clears,1);h.close();assert.equal(h.removed,1)
})
test('editing and changed session remain safe, no navigation; old restore generation is invisible',async()=>{
 const h=await fixture();h.route='TaskForm';h.render();h.button('查看番茄钟').props.onPress();await h.flush()
 assert.equal(h.nav.length,0);assert.match(JSON.stringify(h.tree),/正在编辑/)
 h.route='TodayHome';h.s={...h.s,active:null};h.render();h.button('查看番茄钟').props.onPress();await h.flush()
 assert.equal(h.nav.length,0);assert.match(JSON.stringify(h.tree),/这一轮已结束/)
 h.generation++;h.render();assert.equal(h.tree,null);h.close()
})
test('restore or a newly dirty page while DB lookup waits prevents late navigation',async()=>{
 for(const change of ['generation','editing']){
  const h=await fixture();let release;h.wait=new Promise(r=>release=r)
  h.button('查看番茄钟').props.onPress();if(change==='generation')h.generation++;else h.dirty=true
  h.render();release({...h.s,generation:0});await h.flush();assert.equal(h.nav.length,0);h.close()
 }
})
