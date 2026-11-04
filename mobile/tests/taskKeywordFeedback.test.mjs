import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as datetime from '../src/domain/datetime.ts'
import * as types from '../src/domain/types.ts'
const source=readFileSync(new URL('../src/screens/TaskListScreen.tsx',import.meta.url),'utf8')
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment',
 useState(v){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=v;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useRef(v){const h=active,i=h.pos++;return h.slots[i]??={current:v}},
 useMemo(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn()};return h.slots[i].value},
}
React.useCallback=(fn,deps)=>React.useMemo(()=>fn,deps)
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
function fixture(){
 const h={slots:[],pos:0,refreshes:0,dismissed:0}
 h.store={status:'ready',data:{tasks:[{id:1,title:'物理作业',description:'实验报告',status:'TODO',deadline:null,courseId:1},{id:2,title:'英语复习',description:null,status:'DONE',deadline:null,courseId:1}],courses:[{id:1,name:'大学物理'}],originalTexts:new Map()},courseById:()=>({name:'大学物理'}),refresh:async()=>{h.refreshes++}}
 const deps={react:React,'react-native':{View:'View',Text:'Text',StyleSheet:{create:x=>x},Keyboard:{dismiss:()=>h.dismissed++}},
 '@react-navigation/native':{useNavigation:()=>({navigate:()=>{}}),useFocusEffect:()=>{}},'../domain/datetime':datetime,'../domain/types':types,
 '../store/AppStore':{useAppStore:()=>h.store},'../ui/TaskCard':{TaskCard:'TaskCard'},'../ui/TaskBatchManager':{TaskBatchManager:'TaskBatchManager'},
 '../ui/components':Object.fromEntries(['AppButton','AppTextField','EmptyState','OptionGroup','RefreshErrorBanner','SectionCard'].map(k=>[k,k])),
 '../ui/ReminderSyncNotice':{ReminderSyncNotice:'ReminderSyncNotice'},'../ui/dialog':{ConfirmDialog:'ConfirmDialog',Toast:'Toast'},
 '../ui/QuickActions':{QuickActions:'QuickActions',ToolDisclosure:'ToolDisclosure'},'../ui/motion':{MotionReveal:'MotionReveal'},
 '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/theme':{colors:{},spacing:{},typography:{}},
 }
 const mod={exports:{}},code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{Error})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{active=h;h.pos=0;h.tree=mod.exports.TaskListScreen()}
 h.find=p=>nodes(h.tree,p)[0]
 h.field=()=>h.find(n=>n.type==='AppTextField')
 h.query=v=>{h.field().props.onChangeText(v);h.render()}
 h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
 h.press=label=>{assert.ok(h.button(label),label);h.button(label).props.onPress();h.render()}
 h.feedback=()=>h.find(n=>n.props.testID==='task-keyword-feedback')
 h.render();return h
}
test('actual task keyword input shows found/zero feedback immediately, exposes default completed filter and can broaden scope',()=>{
 const h=fixture();h.query('物理');assert.match(JSON.stringify(h.feedback()),/找到 1 条任务/)
 h.query('英语');assert.match(JSON.stringify(h.feedback()),/没有找到任务/);assert.match(JSON.stringify(h.feedback()),/未完成/)
 h.press('在全部任务中查找');assert.match(JSON.stringify(h.feedback()),/找到 1 条任务/)
 assert.equal(nodes(h.tree,n=>n.type==='TaskCard')[0].props.task.id,2)
 h.query('没有这条任务');assert.match(JSON.stringify(h.feedback()),/没有找到任务/)
 assert.equal(h.button('在全部任务中查找'),undefined)
 h.press('清空关键词');assert.equal(h.feedback(),undefined);assert.equal(h.field().props.value,'')
})
test('task-page keyboard search uses final native text, button reads latest input and feedback appears before tools',()=>{
 const h=fixture(),button=h.button('搜索任务')
 h.field().props.onChangeText('物理');button.props.onPress();h.render()
 assert.equal(h.field().props.value,'物理');assert.match(JSON.stringify(h.feedback()),/找到 1 条任务/)
 h.field().props.onSubmitEditing({nativeEvent:{text:'完全不存在'}});h.render()
 assert.equal(h.field().props.value,'完全不存在');assert.match(JSON.stringify(h.feedback()),/没有找到任务/)
 assert.equal(h.dismissed,2);assert.equal(h.refreshes,2)
 const order=nodes(h.tree,n=>n.props.testID==='task-keyword-feedback'||n.type==='ToolDisclosure')
 assert.equal(order[0].props.testID,'task-keyword-feedback')
 h.store.status='error';h.render();assert.match(JSON.stringify(h.feedback()),/暂时无法读取/);assert.doesNotMatch(JSON.stringify(h.feedback()),/没有找到任务/)
})
