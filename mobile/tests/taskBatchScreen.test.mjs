import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as domain from '../src/domain/taskBatch.ts'
import {currentRouteBlocksNotificationOpen} from '../src/navigation/taskReminderNotificationRouter.ts'
import {setNavigationDraftDirty,clearNavigationDraft,isNavigationDraftDirty} from '../src/navigation/navigationDraftGuard.ts'
const source=readFileSync(new URL('../src/ui/TaskBatchManager.tsx',import.meta.url),'utf8')
test('real navigation guards defer notification while selecting and release after exit',async()=>{
 const route={name:'TaskList',key:'batch-test'}
 assert.equal(currentRouteBlocksNotificationOpen(route,isNavigationDraftDirty),false)
 setNavigationDraftDirty(route.key,'TaskList',true)
 assert.equal(currentRouteBlocksNotificationOpen(route,isNavigationDraftDirty),true)
 clearNavigationDraft(route.key);await Promise.resolve()
 assert.equal(currentRouteBlocksNotificationOpen(route,isNavigationDraftDirty),false)
})
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
const React={
 Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
 useState(value){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=value;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useRef(value){const h=active,i=h.pos++;return h.slots[i]??={current:value}},
 useEffect(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps)){const old=h.slots[i];h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}},
}
React.useLayoutEffect=React.useEffect
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
function fixture(){
 const h={slots:[],pos:0,effects:[],writes:0,dirty:false,pending:null,fail:false,filterKey:'all',generation:7,timers:new Map(),timerId:0}
 h.tasks=[{id:1,title:'物理',status:'TODO',deadline:null},{id:2,title:'英语',status:'DOING',deadline:'2026-11-09'},{id:3,title:'已完成',status:'DONE'},{id:4,title:'已取消',status:'CANCELLED'}]
 const store={courseById:()=>null,getNotificationRouteGeneration:()=>h.generation,refresh:async()=>{},applyTaskBatch:async(input)=>{
  h.writes++;h.input=input;if(h.pending)await h.pending;if(h.fail)throw Error('任务已变化，整批未保存')
  return{committed:true,updatedIds:input.targets.map(t=>t.id),unchangedIds:[],warning:h.warning??null}
 }}
 const deps={react:React,'react-native':{Text:'Text',View:'View',Pressable:'Pressable',StyleSheet:{create:x=>x}},
 '@react-navigation/native':{useRoute:()=>({key:'task-list'})},'../domain/taskBatch':domain,
 '../navigation/navigationDraftGuard':{setNavigationDraftDirty:(_key,_name,dirty)=>h.dirty=dirty,clearNavigationDraft:()=>h.dirty=false},
 '../store/AppStore':{useAppStore:()=>store},'./components':{AppButton:'AppButton',SectionCard:'SectionCard'},
 './datetimeField':{WallClockField:'WallClockField'},'./dialog':{ConfirmDialog:'ConfirmDialog'},'./theme':{colors:{},spacing:{},typography:{}},}
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{
  Error,
  setTimeout:(fn,delay)=>{const id=++h.timerId;h.timers.set(id,{fn,delay});return id},
  clearTimeout:id=>h.timers.delete(id),
 })(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=mod.exports.TaskBatchManager({tasks:h.tasks,filterKey:h.filterKey,onExit:()=>h.exited=true});h.effects.splice(0).forEach(fn=>fn())}
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.find=p=>nodes(h.tree,p)[0]
 h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
 h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled,label);b.props.onPress();h.render()}
 h.dialog=()=>h.find(n=>n.type==='ConfirmDialog')
 h.render();return h
}
test('actual TSX selects only eligible tasks, cancels preview, freezes titles, guards double submit and exits cleanly',async()=>{
 const h=fixture();assert.equal(h.dirty,true)
 assert.equal(nodes(h.tree,n=>n.type==='Pressable').length,2)
 h.press('全选当前列表');h.press('批量完成')
 assert.equal(h.dialog().props.details.length,2)
 h.dialog().props.onCancel();h.render();assert.equal(h.writes,0);assert.equal(h.dialog().props.visible,false)
 h.press('批量完成');h.tasks[0]={...h.tasks[0],title:'新的标题'};h.render()
 assert.match(h.dialog().props.details[0],/物理/)
 let release;h.pending=new Promise(r=>release=r);const confirm=h.dialog().props.onConfirm;confirm();confirm();h.render()
 assert.equal(h.writes,1);assert.equal(h.button('退出批量管理').props.disabled,true)
 release();await h.flush();assert.equal(h.input.generation,7);assert.equal(h.dialog().props.visible,false)
 assert.match(JSON.stringify(h.tree),/已保存：更新 2 条/)
 h.press('退出批量管理');assert.equal(h.exited,true)
 h.slots.forEach(slot=>slot?.cleanup?.());assert.equal(h.dirty,false)
})
test('date-only wheel input is previewed; blank does not clear; filter change clears selection and editor',()=>{
 const h=fixture();h.press('全选当前列表');h.press('统一截止日期');h.press('预览日期修改')
 assert.equal(h.dialog().props.visible,false)
 const field=h.find(n=>n.type==='WallClockField');assert.equal(field.props.allowDateOnly,true)
 field.props.onChange('2026-11-15');h.render();h.press('预览日期修改')
 assert.match(h.dialog().props.message,/只设日期/)
 h.dialog().props.onCancel();h.render();h.press('清除截止日期');assert.match(h.dialog().props.message,/清除/)
 h.filterKey='physics';h.tasks=h.tasks.slice(0,1);h.render();h.render()
 assert.equal(h.dialog().props.visible,false);assert.equal(h.button('批量完成').props.disabled,true)
 assert.match(JSON.stringify(h.tree),/已清空选择/);assert.equal(h.find(n=>n.type==='WallClockField'),undefined)
})
test('failed stale batch dismisses preview and requires new selection; postcommit warning never invites retry',async()=>{
 const h=fixture();h.fail=true;h.press('全选当前列表');h.press('批量完成');h.dialog().props.onConfirm();await h.flush()
 assert.equal(h.dialog().props.visible,false);assert.equal(h.button('批量完成').props.disabled,true)
 assert.match(JSON.stringify(h.tree),/整批未保存/)
 h.fail=false;h.warning='任务已保存，列表刷新失败，请刷新列表。'
 h.press('全选当前列表');h.press('批量完成');h.dialog().props.onConfirm();await h.flush()
 assert.match(JSON.stringify(h.tree),/任务已保存，列表刷新失败/);assert.equal(h.button('批量完成').props.disabled,true)
})
test('restored data clears old selected IDs and open deadline preview',()=>{
 const h=fixture();h.press('全选当前列表');h.press('批量完成')
 h.generation++;h.render();h.render()
 assert.equal(h.dialog().props.visible,false);assert.equal(h.button('批量完成').props.disabled,true)
 assert.match(JSON.stringify(h.tree),/数据已恢复，已清空选择/);assert.equal(h.writes,0)
})
test('success disappears after 3 seconds; newer errors/warnings survive; unmount clears timer',async()=>{
 const h=fixture()
 const save=async()=>{h.press('全选当前列表');h.press('批量完成');h.dialog().props.onConfirm();await h.flush()}
 await save();assert.equal(h.timers.size,1)
 const timer=[...h.timers.values()][0];assert.equal(timer.delay,3000)
 timer.fn();h.timers.clear();h.render();assert.doesNotMatch(JSON.stringify(h.tree),/已保存：更新/)
 await save();h.press('全选当前列表');h.press('统一截止日期');h.press('预览日期修改')
 assert.equal(h.timers.size,0);assert.match(JSON.stringify(h.tree),/请先选择截止日期/)
 h.warning='任务已保存，列表刷新失败，请刷新列表。';await save()
 assert.equal(h.timers.size,0);assert.match(JSON.stringify(h.tree),/列表刷新失败/)
 h.warning=null;await save();assert.equal(h.timers.size,1)
 h.slots.forEach(slot=>slot?.cleanup?.());assert.equal(h.timers.size,0)
})
