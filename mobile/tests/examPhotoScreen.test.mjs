// Runs the actual TSX callbacks with deterministic hooks. Native rendering still needs phone QA.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as photo from '../src/domain/examPhoto.ts'

import * as datetime from '../src/domain/datetime.ts'
import * as types from '../src/domain/types.ts'
import {createInitialNoticePhotoState} from '../src/screens/noticePhotoController.ts'
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

function fixture(){
  const h={slots:[],pos:0,effects:[],calls:[],nav:[]}
  const source='【考试 1】\n期末考试\n一号楼\n考试日期：2099-12-02\n座位号：7\n时间栏：12:00 13:00\n【结束】\n【考试 2】\n过去考试\n考试日期：2020-10-01\n时间栏：08:00 09:00\n【结束】'
  const params={sourceText:source,attemptId:1,generation:0}
  const store={notificationRouteGeneration:0,data:{tasks:[],courses:[]},refresh:async()=>{},importExamPhoto:async input=>{h.calls.push(input);if(h.wait)await h.wait;return {committed:true,created:[1],existing:[],refreshError:h.warning??null}}}
  const screen=compile('../src/screens/ExamPhotoReviewScreen.tsx',{react:React,'react-native':{Text:'Text',View:'View',Pressable:'Pressable',Alert:{alert:(...args)=>h.alert=args},StyleSheet:{create:x=>x}},
    '@react-navigation/native':{useRoute:()=>({params}),useNavigation:()=>({navigate:(...args)=>h.nav.push(args),dispatch:()=>{},getParent:()=>({navigate:(...args)=>h.nav.push(args)})}),usePreventRemove:(enabled,callback)=>h.guard={enabled,callback}},
    '../domain/examPhoto':photo,'../domain/datetime':datetime,'../store/AppStore':{useAppStore:()=>store},
    '../ui/components':Object.fromEntries(['AppButton','AppTextField','Badge','OptionGroup','SectionCard'].map(k=>[k,k])),
    './ExamPhotoCaptureView':{ExamPhotoSteps:'ExamPhotoSteps'},
    '../ui/timeWheel':{DateWheelSheet:'DateWheelSheet',ClockWheelSheet:'ClockWheelSheet'},'../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/theme':{colors:{},radius:{md:12},spacing:{sm:8},typography:{}}})
  h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=screen.ExamPhotoReviewScreen();active=null;h.effects.forEach(f=>f());return h.tree}
  h.all=p=>nodes(h.tree,p);h.find=p=>h.all(p)[0];h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
  h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled);b.props.onPress();h.render()}
  h.flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();h.render()}
  h.store=store;h.render();return h
}
test('review excludes past by default, editable fields and time wheel cancel/confirm preserve intended values',()=>{
  const h=fixture();assert.ok(h.button('导入已选 1 场考试'));assert.equal(h.calls.length,0)
  assert.equal(h.find(n=>n.type==='AppTextField'),undefined)
  h.find(n=>n.props.testID==='exam-edit-1').props.onPress();h.render()
  h.press('开始时间：12:00');h.find(n=>n.type==='ClockWheelSheet').props.onCancel();h.render();assert.ok(h.button('开始时间：12:00'))
  h.press('开始时间：12:00');h.find(n=>n.type==='ClockWheelSheet').props.onConfirm('11:30');h.render();assert.ok(h.button('开始时间：11:30'))
  h.press('查看原图');assert.equal(h.nav[0][1].params.focusAttemptId,1);assert.equal(h.nav[0][1].initial,false)
})
test('same render doubletap writes once with archived source; refresh failure remains committed success',async()=>{
  const h=fixture();let release;h.wait=new Promise(r=>release=r);h.warning='refresh failed'
  const save=h.button('导入已选 1 场考试').props.onPress;save();save();assert.equal(h.calls.length,1);assert.equal(h.calls[0].attemptId,1);assert.match(h.calls[0].sourceText,/期末考试/)
  h.render();h.guard.callback({data:{action:'back'}});assert.equal(h.alert[0],'正在导入');release();await h.flush()
  assert.match(text(h.tree),/已新增 1 场考试/);assert.match(text(h.tree),/保存已成功/);assert.equal(h.guard.enabled,false);assert.equal(h.button('导入已选 1 场考试'),undefined)
})
test('restore generation disables stale review; invalid end time produces no import',async()=>{
  const h=fixture();h.store.notificationRouteGeneration=1;h.render();assert.equal(h.button('导入已选 1 场考试').props.disabled,true)
  const second=fixture();second.find(n=>n.props.testID==='exam-edit-1').props.onPress();second.render();second.press('结束时间：13:00');second.find(n=>n.type==='ClockWheelSheet').props.onConfirm('10:00');second.render();second.press('收起编辑');second.press('导入已选 1 场考试');await second.flush();assert.equal(second.calls.length,0);assert.match(text(second.tree),/结束时间必须晚于/);assert.ok(second.button('结束时间：10:00'))
})

test('collapsed summaries preserve edits, selection, course and optional time warnings',()=>{
  const h=fixture();h.store.data.courses=[{id:9,name:'物理'}]
  const editButton=key=>{h.find(n=>n.props.testID===`exam-edit-${key}`).props.onPress();h.render()}
  editButton(1)
  h.find(n=>n.type==='AppTextField'&&n.props.label==='考试地点').props.onChangeText('新考场 301');h.render()
  h.press('关联课程：不关联');h.find(n=>n.type==='OptionGroup').props.onChange(9);h.render()
  h.press('开始时间：12:00');h.find(n=>n.type==='ClockWheelSheet').props.onClear();h.render()
  h.press('收起编辑');assert.match(text(h.tree),/新考场 301/);assert.match(text(h.tree),/课程：物理/);assert.match(text(h.tree),/时间未设置/)
  assert.equal(h.find(n=>n.type==='AppTextField'),undefined)
  editButton(1);assert.equal(h.find(n=>n.type==='AppTextField'&&n.props.label==='考试地点').props.value,'新考场 301')
  assert.ok(h.button('开始时间：未设置'));assert.ok(h.button('结束时间：未设置'))
  h.find(n=>n.props.testID==='exam-select-1').props.onPress();h.render();assert.equal(h.button('导入已选 0 场考试').props.disabled,true)
  const past=h.find(n=>n.props.testID==='exam-select-2');assert.equal(past.props.accessibilityState.checked,false)
  past.props.onPress();h.render();assert.ok(h.button('导入已选 1 场考试'))
})

test('manual row expands, invalid save identifies it, and rapid add respects maximum',async()=>{
  const h=fixture();h.press('补充一场未识别的考试')
  assert.ok(h.button('考试日期：请选择'));assert.match(text(h.tree),/待填写考试名称/)
  h.press('收起编辑');h.press('导入已选 2 场考试');await h.flush()
  assert.match(text(h.tree),/第 3 场/);assert.ok(h.find(n=>n.type==='AppTextField'&&n.props.label==='考试名称'))
  const add=h.button('补充一场未识别的考试').props.onPress
  for(let i=0;i<30;i++)add()
  h.render();assert.equal(h.all(n=>n.type==='Pressable'&&n.props.accessibilityRole==='checkbox').length,20)
  assert.equal(h.button('补充一场未识别的考试').props.disabled,true)
})

function captureFixture(overrides={}){
  const h={slots:[],pos:0,effects:[],calls:[]}
  const props={state:createInitialNoticePhotoState(),endpoint:'http://192.168.1.2:8082',lengthError:null,canAdopt:true,stale:false,...overrides}
  for(const name of ['onPick','onRecognize','onCancel','onAdopt','onRetryArchive','onSettings','onLibrary','onOriginal'])props[name]=(...args)=>h.calls.push([name,...args])
  props.onEditText=value=>{props.state={...props.state,text:value}}
  const screen=compile('../src/screens/ExamPhotoCaptureView.tsx',{react:React,
    'react-native':{Text:'Text',View:'View',Image:'Image',ActivityIndicator:'ActivityIndicator',StyleSheet:{create:x=>x}},
    '../domain/noticeImport':{MAX_NOTICE_SOURCE_CHARS:10000},
    '../ui/components':Object.fromEntries(['AppButton','AppTextField','Badge','SectionCard'].map(k=>[k,k])),
    '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/theme':{colors:{},spacing:{},radius:{},typography:{}}})
  h.render=()=>{active=h;h.pos=0;h.tree=screen.ExamPhotoCaptureView(props);active=null}
  h.find=p=>nodes(h.tree,p)[0];h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
  h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled);b.props.onPress();h.render()}
  h.props=props;h.render();return h
}
test('exam capture offers explicit photo/recognize flow, no automatic request, no false connection claim',()=>{
  const h=captureFixture();assert.equal(h.button('识别考试安排').props.disabled,true);assert.equal(h.calls.length,0)
  h.press('从相册选择');assert.equal(h.calls[0][0],'onPick');assert.equal(h.calls[0][1],'library')
  h.props.state={...h.props.state,photoUri:'file:///exam.jpg',archivedOriginal:true,archivedAttemptId:1};h.render()
  h.press('识别考试安排');assert.equal(h.calls[1][0],'onRecognize')
  assert.equal(h.find(n=>n.type==='AppTextField'),undefined)
  h.press('连接与识别详情');assert.match(text(h.tree),/是否连接成功以实际识别结果为准/)
})
test('capture next blocks unsaved original/stale/busy and cancellation is explicit',()=>{
  const h=captureFixture();h.props.state={...h.props.state,photoUri:'file:///exam.jpg',text:'考试文字'};h.render()
  assert.equal(h.button('下一步：核对考试').props.disabled,true)
  h.props.state={...h.props.state,archivedOriginal:true,archivedAttemptId:1};h.render();h.press('下一步：核对考试');assert.equal(h.calls[0][0],'onAdopt')
  h.props.stale=true;h.render();assert.equal(h.button('下一步：核对考试').props.disabled,true)
  h.props.stale=false;h.props.state={...h.props.state,busy:true,phase:'recognizing'};h.render()
  assert.equal(h.button('下一步：核对考试'),undefined);assert.equal(h.button('换一张照片').props.disabled,true)
  h.press('取消这次识别');assert.equal(h.calls[1][0],'onCancel')
})
test('raw editor stays accessible after clearing text; archive failures and OCR warnings stay visible',()=>{
  const h=captureFixture();h.props.state={...h.props.state,text:'考试文字',recognizedText:'考试文字',warnings:['时间未读清'],archiveError:'磁盘空间不足'};h.render()
  assert.match(text(h.tree),/时间未读清/);assert.match(text(h.tree),/磁盘空间不足/)
  h.press('查看或修改识别文字');h.find(n=>n.type==='AppTextField').props.onChangeText('');h.render()
  assert.ok(h.find(n=>n.type==='AppTextField'));h.press('收起识别文字');h.press('查看或修改识别文字')
  assert.equal(h.find(n=>n.type==='AppTextField').props.value,'')
  h.press('重试保存原图');assert.equal(h.calls[0][0],'onRetryArchive')
})


