import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {StackRouter,StackActions,CommonActions} from '@react-navigation/routers'
const source=readFileSync(new URL('../src/navigation/RootNavigator.tsx',import.meta.url),'utf8')
const React={createElement:(type,props,...children)=>({type,props:{...props,children}})}
const navigator=()=>({Screen:'Screen',Navigator:'Navigator'})
const deps={react:React,'react-native':{StyleSheet:{create:x=>x}},
 '@react-navigation/bottom-tabs':{createBottomTabNavigator:navigator},'@react-navigation/native-stack':{createNativeStackNavigator:navigator},
 '../ui/motion':{useReducedMotion:()=>true},'../ui/theme':{colors:{},spacing:{},typography:{}},
}
const mod={exports:{}}
const code=ts.transpileModule(source+'\nexport {TodayStackNavigator,TaskStackNavigator,CourseStackNavigator}',{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>deps[id]??new Proxy({},{get:(_,key)=>String(key)}),mod,mod.exports)
const registrations=fn=>fn().props.children.flat(Infinity).filter(Boolean).map(x=>x.props)
test('both search entry stacks register real details and all course dependent routes without duplicate names',()=>{
 const courseNames=registrations(mod.exports.CourseStackNavigator).map(x=>x.name)
 for(const stack of [mod.exports.TodayStackNavigator,mod.exports.TaskStackNavigator]){
  const screens=registrations(stack),names=screens.map(x=>x.name)
  assert.equal(new Set(names).size,names.length)
  for(const name of ['GlobalSearch','TaskDetail','TaskForm','TaskSteps','TaskReminder','TaskPhotos',...courseNames]) assert.ok(names.includes(name),name)
  assert.equal(screens.find(x=>x.name==='GlobalSearch').component,'GlobalSearchScreen')
  assert.equal(screens.find(x=>x.name==='CourseDetail').component,'CourseDetailScreen')
 }
})
test('actual stack router preserves the same search route key through detail/edit/back for both entry stacks',()=>{
 for(const stack of [mod.exports.TodayStackNavigator,mod.exports.TaskStackNavigator]){
  const screens=registrations(stack),routeNames=screens.map(x=>x.name)
  const opts={routeNames,routeParamList:{},routeGetIdList:Object.fromEntries(screens.filter(x=>x.getId).map(x=>[x.name,x.getId]))}
  const router=StackRouter({initialRouteName:routeNames[0]})
  let state=router.getInitialState(opts)
  const act=action=>{state=router.getStateForAction(state,action,opts);assert.ok(state)}
  act(CommonActions.navigate('GlobalSearch'));const searchKey=state.routes.at(-1).key
  for(const [detail,edit] of [['CourseDetail','CourseForm'],['TaskDetail','TaskForm']]){
   act(CommonActions.navigate(detail,{id:7}));act(CommonActions.navigate(edit,{id:7}));act(StackActions.pop());assert.equal(state.routes.at(-1).name,detail)
   act(StackActions.pop());assert.equal(state.routes.at(-1).key,searchKey)
  }
 }
})
