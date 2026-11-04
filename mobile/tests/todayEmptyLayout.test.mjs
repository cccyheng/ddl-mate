import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as calendar from '../src/domain/calendar.ts'
import * as datetime from '../src/domain/datetime.ts'
import * as pressure from '../src/domain/ddlPressure.ts'
import * as live from '../src/domain/timetableLive.ts'
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment',useState:v=>[v,()=>{}],useCallback:fn=>fn,useMemo:fn=>fn()}
const native={View:'View',Text:'Text',Pressable:'Pressable',TextInput:'TextInput',ActivityIndicator:'ActivityIndicator',Animated:{View:'AnimatedView'},StyleSheet:{create:x=>x},Platform:{OS:'ios',select:x=>x.ios},useWindowDimensions:()=>({width:320,fontScale:1.5}),ScrollView:'ScrollView',KeyboardAvoidingView:'KeyboardAvoidingView'}
function load(path,deps){
 const mod={exports:{}}
 const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{Error})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 return mod.exports
}
const theme=load('../src/ui/theme.ts',{'react-native':native})
const components=load('../src/ui/components.tsx',{react:React,'react-native':native,'./theme':theme,'./motion':{usePressMotion:()=>({scale:1})}})
const flatten=s=>Object.assign({},...[s].flat(Infinity).filter(Boolean))
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
test('real empty-state/button styles size to content, no nested border or expanding button; scaffold remains scrollable at large font',()=>{
 const empty=components.EmptyState({title:'待办已清空',description:'可以休息一下',compact:true,actionLabel:'新建任务',onAction:()=>{}})
 const style=flatten(empty.props.style);assert.equal(style.flexGrow,0);assert.equal(style.borderWidth,0)
 const button=components.AppButton({label:'新建任务',onPress:()=>{},compact:true})
 const press=nodes(button,n=>n.type==='Pressable')[0],bs=flatten(press.props.style({pressed:false}))
 assert.equal(bs.flexGrow,0);assert.ok(bs.minHeight>=44);assert.equal(bs.height,undefined)
 const {ScreenScaffold}=load('../src/ui/ScreenScaffold.tsx',{react:React,'react-native':native,'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'./theme':theme})
 const tree=ScreenScaffold({title:'首页',children:empty}),scroll=nodes(tree,n=>n.type==='ScrollView')[0]
 assert.ok(scroll);assert.notEqual(scroll.props.scrollEnabled,false)
 assert.equal(flatten(scroll.props.style).flex,1);assert.equal(flatten(scroll.props.contentContainerStyle).flex,undefined)
})
function today(tasks){
 const store={data:{tasks,courses:[],schedules:[]},courseById:()=>null,refresh:async()=>{},studyReferenceMinutes:60}
 const widgets=Object.fromEntries(['AppButton','Badge','EmptyState','RefreshErrorBanner','SectionCard'].map(k=>[k,k]))
 const {TodayScreen}=load('../src/screens/TodayScreen.tsx',{
  react:React,'react-native':native,'@react-navigation/native':{useNavigation:()=>({navigate:()=>{}}),useFocusEffect:()=>{}},
  '../domain/calendar':calendar,'../domain/calendarClock':{readShanghaiEpochClock:()=>{}},'../domain/datetime':datetime,
  '../domain/ddlPressure':pressure,'../domain/timetableLive':live,'../store/AppStore':{useAppStore:()=>store},
  '../ui/TaskCard':{TaskCard:'TaskCard'},'../ui/components':widgets,'../ui/ReminderSyncNotice':{ReminderSyncNotice:'ReminderSyncNotice'},
  '../ui/dialog':{ConfirmDialog:'ConfirmDialog',Toast:'Toast'},'../ui/QuickActions':{QuickActions:'QuickActions',ToolDisclosure:'ToolDisclosure'},
  '../ui/WeeklyGoalCard':{WeeklyGoalCard:'WeeklyGoalCard'},'../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},
  '../ui/useFocusClock':{useFocusClock:()=>({dateKey:'2026-11-03',minutes:720,epochMs:Date.parse('2026-11-03T12:00:00+08:00')})},'../ui/theme':theme,
 })
 return TodayScreen()
}
test('actual home is compact when empty and after 100 completions; active tasks stay visible',()=>{
 const empty=today([]),cards=nodes(empty,n=>n.type==='SectionCard')
 assert.equal(cards.some(n=>['已逾期','今天截止'].includes(n.props.title)),false)
 assert.equal(nodes(empty,n=>n.type==='EmptyState')[0].props.compact,true)
 const tasks=Array.from({length:100},(_,i)=>({id:i+1,title:`任务${i}`,status:'DONE',deadline:null,completedAt:'2026-11-03T10:00:00+08:00'}))
 const done=today(tasks),disclosure=nodes(done,n=>n.type==='ToolDisclosure')[0]
 assert.match(disclosure.props.title,/100/);assert.equal(nodes(disclosure,n=>n.type==='TaskCard').length,6)
 assert.equal(nodes(done,n=>n.type==='EmptyState')[0].props.title,'待办已清空')
 const active=today([{id:1,title:'待办',status:'TODO',deadline:'2026-11-03',estimatedMinutes:30}])
 assert.ok(nodes(active,n=>n.type==='SectionCard'&&n.props.title==='今天截止').length)
 assert.equal(nodes(active,n=>n.type==='EmptyState')[0].props.title,'暂无后续安排')
})
