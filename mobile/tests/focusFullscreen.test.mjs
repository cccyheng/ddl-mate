import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('../src/ui/FocusFullscreen.tsx',import.meta.url),'utf8')
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
const styles=n=>Object.assign({},...[n.props.style].flat(Infinity).filter(Boolean))
const textContent=n=>typeof n==='string'?n:Array.isArray(n)?n.map(textContent).join(''):n?.props?textContent(n.props.children):''
const button=(tree,label)=>nodes(tree,n=>n.type==='AppButton'&&n.props.label===label)[0]
const timerOf=tree=>nodes(tree,n=>n.type==='Text'&&n.props.accessibilityRole==='timer')[0]
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
function fixture(options={}){
 const h={width:390,height:844,fontScale:1,reduced:false,calls:[],slots:[],effects:[],currentExtra:{},...options}
 const React={Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}}),
  useState(value){const i=active.pos++;if(!(i in active.slots))active.slots[i]=typeof value==='function'?value():value;return[active.slots[i],v=>{active.slots[i]=typeof v==='function'?v(active.slots[i]):v}]},
  useEffect(fn,deps){const i=active.pos++;const old=active.effects[i];if(!old||!same(old.deps,deps))active.pendingEffects.push({i,fn,deps})}}
 const deps={react:React,'react-native':{
   Modal:'Modal',Pressable:'Pressable',ScrollView:'ScrollView',Text:'Text',View:'View',StyleSheet:{create:x=>x},
   useWindowDimensions:()=>({width:h.width,height:h.height,fontScale:h.fontScale}),
 },'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'./components':{AppButton:'AppButton'},
 './motion':{useReducedMotion:()=>h.reduced},'./theme':{MIN_TOUCH_SIZE:44,spacing:{xs:4,sm:8,md:12,lg:16,xl:24,xxl:32},
   typography:{label:{fontSize:13,lineHeight:18},title:{fontSize:22,lineHeight:28},caption:{fontSize:13,lineHeight:18},bodySoft:{fontSize:15,lineHeight:22}}}}
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 const call=name=>(...args)=>h.calls.push([name,...args])
 const base={visible:true,loading:false,active:true,countdown:true,rest:false,expired:false,paused:false,issue:null,
   time:'25:00',stateLabel:'番茄专注中',caption:'40% 已完成',taskTitle:'读《数据结构》第三章',courseName:'计算机基础',
   progress:0.4,error:'',message:'',busy:false,canStart:true,startHint:'',
   confirm:null,confirmTitle:'保存这次专注？',confirmMessage:'确认后计时结束。',confirmLabel:'确认',confirmDanger:false,
   onExit:call('exit'),onPauseResume:call('pauseResume'),onFinishAndRest:call('finishAndRest'),onNextFocus:call('nextFocus'),
   onFinish:call('finish'),onDiscard:call('discard'),onRecover:call('recover'),onRetry:call('retry'),onStart:call('start'),
   onCancelConfirm:call('cancelConfirm'),onConfirm:call('confirm')}
 h.render=(extra)=>{
  if(extra!==undefined)h.currentExtra=extra
  const renderOnce=()=>{active=h;h.pos=0;h.pendingEffects=[];h.tree=mod.exports.FocusFullscreen({...base,...h.currentExtra});return h.pendingEffects}
  const pending=renderOnce()
  for(const effect of pending){const old=h.effects[effect.i];old?.cleanup?.();const cleanup=effect.fn();h.effects[effect.i]={deps:effect.deps,cleanup}}
  if(pending.length){active=h;h.pos=0;h.pendingEffects=[];h.tree=mod.exports.FocusFullscreen({...base,...h.currentExtra})}
  return h.tree
 }
 h.press=label=>{const b=button(h.tree,label);assert.ok(b,label);b.props.onPress();h.render()}
 return h
}
test('fullscreen modal covers chrome inside safe areas, with a 44pt exit, tabular clock and shared controls',()=>{
 const h=fixture(),tree=h.render()
 const modals=nodes(tree,n=>n.type==='Modal');assert.equal(modals.length,1)
 assert.equal(modals[0].props.visible,true);assert.equal(modals[0].props.presentationStyle,'fullScreen');assert.equal(modals[0].props.transparent,false)
 const safe=nodes(tree,n=>n.type==='SafeAreaView')[0];assert.ok(safe);assert.equal(safe.props.edges.join(','),'top,bottom,left,right')
 const exit=nodes(tree,n=>n.type==='Pressable'&&n.props.accessibilityLabel==='退出全屏')[0];assert.ok(exit)
 assert.ok(styles(exit).minHeight>=44);assert.ok(styles(exit).minWidth>=44)
 exit.props.onPress();assert.deepEqual(h.calls.at(-1),['exit'])
 const timer=timerOf(tree);assert.ok(timer)
 assert.ok(styles(timer).fontSize>=64);assert.ok(styles(timer).fontVariant.includes('tabular-nums'))
 assert.equal(timer.props.numberOfLines,1);assert.equal(timer.props.adjustsFontSizeToFit,true)
 const task=nodes(tree,n=>n.type==='Text'&&textContent(n).includes('读《数据结构》'))[0];assert.ok(task)
 assert.equal(task.props.numberOfLines,2);assert.equal(task.props.ellipsizeMode,'tail')
 for(const label of ['暂停一下','结束并保存','更多操作'])assert.ok(button(tree,label),label)
 assert.equal(button(tree,'保存并开始休息'),undefined)
 assert.equal(button(tree,'放弃本次'),undefined)
 h.press('暂停一下');assert.deepEqual(h.calls.at(-1),['pauseResume'])
 h.press('结束并保存');assert.deepEqual(h.calls.at(-1),['finish'])
 h.press('更多操作')
 assert.ok(button(h.tree,'保存并开始休息'));assert.ok(button(h.tree,'放弃本次'))
 h.press('保存并开始休息');assert.deepEqual(h.calls.at(-1),['finishAndRest'])
 assert.equal(button(h.tree,'保存并开始休息'),undefined)
 h.press('更多操作');h.press('放弃本次');assert.deepEqual(h.calls.at(-1),['discard'])
})
test('finish confirmation stays inline (no second modal), cancel and confirm are separate, errors stay visible',()=>{
 const h=fixture();let tree=h.render({confirm:'finishAndRest',confirmTitle:'保存专注并开始休息？',confirmMessage:'保存实际专注时长。',confirmLabel:'确认',error:'测试保存失败'})
 assert.equal(nodes(tree,n=>n.type==='Modal').length,1)
 const modal=nodes(tree,n=>n.type==='Modal')[0]
 modal.props.onRequestClose();assert.deepEqual(h.calls.at(-1),['exit'])
 const cancel=button(tree,'取消'),confirm=button(tree,'确认');assert.ok(cancel);assert.ok(confirm)
 cancel.props.onPress();assert.deepEqual(h.calls.at(-1),['cancelConfirm'])
 confirm.props.onPress();assert.deepEqual(h.calls.at(-1),['confirm'])
 assert.match(textContent(tree),/测试保存失败/)
 const retry=button(tree,'重新读取状态');assert.ok(retry);retry.props.onPress();assert.deepEqual(h.calls.at(-1),['retry'])
 const hidden=nodes(tree,n=>n.type==='ScrollView'&&n.props.accessibilityElementsHidden===true)[0];assert.ok(hidden)
 tree=h.render({confirm:'discard',confirmTitle:'放弃这次专注？',confirmLabel:'确认舍弃',confirmDanger:true})
 assert.equal(button(tree,'确认舍弃').props.variant,'danger')
})
test('paused, rest, expired, issue, loading and ready states expose the matching shared actions',()=>{
 const h=fixture();let tree=h.render({paused:true})
 assert.ok(button(tree,'继续专注'));button(tree,'继续专注').props.onPress();assert.deepEqual(h.calls.at(-1),['pauseResume'])
 tree=h.render({rest:true,paused:true,stateLabel:'已暂停',time:'03:20'})
 assert.ok(button(tree,'继续休息'));assert.ok(button(tree,'结束休息'))
 h.press('继续休息');assert.deepEqual(h.calls.at(-1),['pauseResume'])
 assert.equal(button(h.tree,'开始下一轮专注'),undefined);assert.equal(button(h.tree,'放弃本次'),undefined)
 h.press('更多操作');assert.ok(button(h.tree,'开始下一轮专注'));assert.ok(button(h.tree,'放弃本次'))
 h.press('开始下一轮专注');assert.deepEqual(h.calls.at(-1),['nextFocus'])
 tree=h.render({rest:true,expired:true,stateLabel:'休息结束',time:'00:00'})
 assert.ok(button(tree,'开始下一轮专注'));assert.ok(button(tree,'结束休息'));assert.equal(button(tree,'暂停一下'),undefined)
 assert.equal(button(tree,'放弃本次'),undefined);assert.ok(button(tree,'更多操作'));assert.equal(button(tree,'收起更多操作'),undefined)
 h.press('更多操作');assert.ok(button(h.tree,'放弃本次'))
 tree=h.render({expired:true,stateLabel:'本轮完成 · 等待保存',time:'00:00'})
 assert.ok(button(tree,'保存并开始休息'));assert.ok(button(tree,'结束并保存'))
 assert.equal(button(tree,'放弃本次'),undefined);assert.ok(button(tree,'更多操作'));assert.equal(button(tree,'收起更多操作'),undefined)
 h.press('更多操作');assert.ok(button(h.tree,'放弃本次'))
 tree=h.render({issue:'系统时间发生变化，请先校准手机时间，再继续。'})
 assert.match(textContent(tree),/系统时间/);button(tree,'舍弃未确认时段').props.onPress();assert.deepEqual(h.calls.at(-1),['recover'])
 assert.equal(button(tree,'放弃本次'),undefined)
 h.press('更多操作');assert.ok(button(h.tree,'放弃本次'))
 tree=h.render({active:false,loading:true,canStart:false})
 assert.match(textContent(tree),/正在读取/);assert.equal(button(tree,'开始专注'),undefined)
 tree=h.render({active:false,loading:false,canStart:true,stateLabel:'准备好了，就开始吧',time:'25:00'})
 const start=button(tree,'开始专注');assert.equal(start.props.disabled,false);start.props.onPress();assert.deepEqual(h.calls.at(-1),['start'])
 tree=h.render({active:false,canStart:false,startHint:'请先保存或取消下方的记录编辑，再开始新专注。'})
 assert.equal(button(tree,'开始专注').props.disabled,true);assert.match(textContent(tree),/先保存或取消/)
 tree=h.render({active:false,canStart:true});button(tree,'返回设置').props.onPress();assert.deepEqual(h.calls.at(-1),['exit'])
})
test('small, landscape and large-text layouts keep 44pt controls reachable and scale the clock',()=>{
 const sizes=[{width:320,height:480,fontScale:1},{width:844,height:390,fontScale:1},{width:390,height:844,fontScale:2}]
 for(const size of sizes){
  const h=fixture(size),tree=h.render({taskTitle:'一个非常非常长的任务名称'.repeat(8)})
  const scroll=nodes(tree,n=>n.type==='ScrollView'&&n.props.accessibilityElementsHidden!==true)[0];assert.ok(scroll)
  const content=Object.assign({},...[scroll.props.contentContainerStyle].flat().filter(Boolean));assert.equal(content.flexGrow,1)
  assert.ok(styles(timerOf(tree)).fontSize>0)
  for(const label of ['暂停一下','结束并保存']){const b=button(tree,label);assert.ok(b,label);assert.ok(styles(b).minHeight>=44,label)}
  const more=button(tree,'更多操作');assert.ok(more);assert.ok(styles(more).minHeight>=44)
  const exit=nodes(tree,n=>n.type==='Pressable'&&n.props.accessibilityLabel==='退出全屏')[0]
  assert.ok(styles(exit).minHeight>=44)
  const task=nodes(tree,n=>n.type==='Text'&&textContent(n).includes('非常非常长'))[0];assert.equal(task.props.numberOfLines,2)
 }
 const normal=fixture({width:390,height:844,fontScale:1}).render(),large=fixture({width:390,height:844,fontScale:2}).render()
 assert.ok(styles(timerOf(large)).fontSize<styles(timerOf(normal)).fontSize)
 const landscape=fixture({width:844,height:390,fontScale:1}).render();assert.ok(styles(timerOf(landscape)).fontSize<=132)
})
test('closing and reopening fullscreen starts from a clean main surface',()=>{
 const h=fixture();h.render();h.press('更多操作');assert.ok(button(h.tree,'收起更多操作'))
 h.render({visible:false});h.render({visible:true})
 assert.ok(button(h.tree,'更多操作'));assert.equal(button(h.tree,'收起更多操作'),undefined)
 assert.equal(button(h.tree,'保存并开始休息'),undefined);assert.equal(button(h.tree,'放弃本次'),undefined)
})
test('busy keeps the single fullscreen surface visible and blocks exit until settled',()=>{
 const h=fixture();let tree=h.render({busy:true,confirm:'finish',confirmTitle:'保存这次专注？'})
 const modal=nodes(tree,n=>n.type==='Modal')[0];assert.equal(nodes(tree,n=>n.type==='Modal').length,1)
 assert.match(textContent(tree),/保存中/)
 const exit=nodes(tree,n=>n.type==='Pressable'&&n.props.accessibilityLabel==='退出全屏')[0]
 assert.equal(exit.props.disabled,true);assert.ok(styles(exit).opacity<1)
 modal.props.onRequestClose();assert.equal(h.calls.filter(c=>c[0]==='exit').length,0)
 assert.equal(button(tree,'更多操作').props.disabled,true)
 tree=h.render({busy:false,confirm:null})
 const settledExit=nodes(tree,n=>n.type==='Pressable'&&n.props.accessibilityLabel==='退出全屏')[0]
 assert.equal(settledExit.props.disabled,false)
 settledExit.props.onPress();assert.deepEqual(h.calls.at(-1),['exit'])
})
