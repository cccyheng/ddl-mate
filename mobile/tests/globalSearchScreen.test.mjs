import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as search from '../src/domain/globalSearch.ts'
const source=readFileSync(new URL('../src/screens/GlobalSearchScreen.tsx',import.meta.url),'utf8')
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),
 useState(v){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=v;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useRef(v){const h=active,i=h.pos++;return h.slots[i]??={current:v}},
 useMemo(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn()};return h.slots[i].value},
}
React.useCallback=(fn,deps)=>React.useMemo(()=>fn,deps)
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
function fixture(){
 const h={slots:[],pos:0,focus:null,cleanup:null,refreshes:0,reads:0,generation:0,navigations:[],exists:true,pending:null,fail:false}
 const tasks=Array.from({length:65},(_,i)=>({id:i+1,title:`物理作业 ${i}`,status:'TODO',type:i===0?'EXAM':'HOMEWORK',courseId:1,deadline:null,description:i===2?'光学笔记':null}))
 h.store={status:'ready',data:{tasks,courses:[{id:1,name:'大学物理',instructor:'王老师',semester:'秋',note:'课程笔记'}],originalTexts:new Map()},
  refresh:async()=>{h.refreshes++},getNotificationRouteGeneration:()=>h.generation,retryBootstrap:async()=>{h.retried=true},
  readSearchTarget:async(input)=>{h.reads++;h.input=input;if(h.pending)await h.pending;if(h.fail)throw Error('读取失败');return h.exists},
 }
 const components=Object.fromEntries(['AppButton','AppTextField','Badge','EmptyState','LoadingState','OptionGroup','RefreshErrorBanner','SectionCard'].map(k=>[k,k]))
 const deps={react:React,'react-native':{View:'View',Text:'Text',Pressable:'Pressable',Keyboard:{dismiss:()=>{h.dismissed=(h.dismissed??0)+1}},StyleSheet:{create:x=>x}},
  '@react-navigation/native':{useNavigation:()=>({navigate:(name,params)=>h.navigations.push({name,params})}),useFocusEffect:fn=>{if(h.focus!==fn){h.cleanup?.();h.focus=fn;h.cleanup=fn()}}},
  '../domain/globalSearch':search,'../store/AppStore':{useAppStore:()=>h.store},'../ui/components':components,
  '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/theme':{colors:{},radius:{},spacing:{},typography:{}},
 }
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{Error})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{active=h;h.pos=0;h.tree=mod.exports.GlobalSearchScreen()}
 h.find=p=>nodes(h.tree,p)[0]
 h.flush=async()=>{await new Promise(r=>setImmediate(r));h.render()}
 h.query=value=>{h.find(n=>n.type==='AppTextField').props.onChangeText(value);h.render()}
 h.filter=value=>{h.find(n=>n.type==='OptionGroup').props.onChange(value);h.render()}
 h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
 h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled);b.props.onPress();h.render()}
 h.results=()=>nodes(h.tree,n=>n.type==='Pressable')
 h.summary=()=>h.find(n=>n.type==='Text'&&n.props.accessibilityLiveRegion==='polite')?.props.children.join('')
 h.open=async()=>{h.results()[0].props.onPress();await h.flush()}
 h.back=()=>{h.cleanup?.();h.cleanup=h.focus();h.render()}
 h.render();return h
}
test('real screen queries, category counts, pagination, clear, and same search state after detail return',async()=>{
 const h=fixture();assert.equal(h.results().length,0);assert.equal(h.find(n=>n.type==='EmptyState').props.title,'从一个关键词开始')
 h.tree.props.scrollRef.current={scrollTo:position=>h.scroll=position}
 h.query('物理');assert.equal(h.results().length,30);h.filter('TASK');h.press('下一页')
 assert.equal(h.scroll.y,0)
 assert.match(h.summary(),/第 2 \/ 3 页/)
 const selected=h.results()[0].props.accessibilityLabel;await h.open()
 assert.equal(h.navigations[0].name,'TaskDetail')
 h.back();assert.equal(h.results()[0].props.accessibilityLabel,selected);assert.match(h.summary(),/第 2 \/ 3 页/)
 assert.equal(h.find(n=>n.type==='AppTextField').props.value,'物理');assert.equal(h.find(n=>n.type==='OptionGroup').props.value,'TASK')
 h.filter('EXAM');assert.equal(h.results().length,1);await h.open();assert.equal(h.navigations.at(-1).params.id,1)
 h.filter('COURSE');await h.open();assert.equal(h.navigations.at(-1).name,'CourseDetail')
 h.query('光学');h.filter('NOTE');await h.open();assert.equal(h.navigations.at(-1).params.id,3)
 h.press('清空搜索');assert.equal(h.results().length,0);assert.equal(h.find(n=>n.type==='OptionGroup').props.value,'ALL')
})
test('double tap protected; changed query and blur cancel in-flight navigation',async()=>{
 const h=fixture();h.query('物理');let release;h.pending=new Promise(r=>release=r)
 const open=h.results()[0].props.onPress;open();open();assert.equal(h.reads,1)
 h.query('光学');release();await h.flush();assert.equal(h.navigations.length,0)
 h.pending=new Promise(r=>release=r);h.results()[0].props.onPress();h.cleanup();release();await h.flush();assert.equal(h.navigations.length,0)
})
test('missing records refresh, DB failure and restore never navigate; loading/error not shown as empty search',async()=>{
 const h=fixture();h.query('物理');h.exists=false;await h.open();assert.equal(h.navigations.length,0);assert.match(JSON.stringify(h.tree),/已被删除/);assert.equal(h.refreshes,2)
 h.exists=true;h.fail=true;await h.open();assert.match(JSON.stringify(h.tree),/读取失败/)
 h.fail=false;let release;h.pending=new Promise(r=>release=r);h.results()[0].props.onPress();h.generation++;release();await h.flush()
 assert.equal(h.navigations.length,0);assert.match(JSON.stringify(h.tree),/数据已恢复/)
 h.store.status='loading';h.render();assert.equal(h.results().length,0);assert.ok(h.find(n=>n.type==='LoadingState'))
 h.store.status='error';h.store.error='磁盘读取失败';h.render();assert.equal(h.find(n=>n.type==='EmptyState'),undefined);h.press('重新读取');assert.equal(h.retried,true)
})
test('focus refresh rebuilds edited/deleted result counts and clamps pagination without losing query',()=>{
 const h=fixture();h.query('物理');h.filter('TASK');h.press('下一页')
 h.store.data={...h.store.data,tasks:[h.store.data.tasks[3]]};h.back()
 assert.equal(h.results().length,1);assert.match(h.summary(),/第 1 \/ 1 页/)
 h.store.data={...h.store.data,tasks:[]};h.back();assert.equal(h.results().length,0)
 assert.equal(h.find(n=>n.type==='EmptyState').props.title,'没有找到相关内容')
 h.store.refreshError='刷新失败';h.render();assert.ok(h.find(n=>n.type==='RefreshErrorBanner'))
 assert.equal(h.find(n=>n.type==='AppTextField').props.value,'物理')
})
test('native search submit uses final IME text, dismisses keyboard and gives immediate visible feedback',()=>{
 const h=fixture();h.tree.props.scrollRef.current={scrollTo:position=>h.scroll=position}
 const field=h.find(n=>n.type==='AppTextField')
 field.props.onChangeText('物');field.props.onSubmitEditing({nativeEvent:{text:'物理'}});h.render()
 assert.equal(h.find(n=>n.type==='AppTextField').props.value,'物理')
 assert.match(h.summary(),/“物理”.*找到 68 条结果/);assert.equal(h.results().length,30)
 assert.equal(h.dismissed,1);assert.equal(h.scroll.y,0);assert.equal(h.refreshes,2)
 h.query('完全没有这段文字');h.press('搜索');assert.match(h.summary(),/没有匹配结果/)
 assert.equal(h.find(n=>n.type==='EmptyState').props.title,'没有找到相关内容')
 h.press('清空搜索');assert.match(h.summary(),/已读取 65 条任务与考试、1 门课程/)
})
test('search button reads latest text before rerender; zero category can switch to matching results',()=>{
 const h=fixture(),button=h.button('搜索'),field=h.find(n=>n.type==='AppTextField')
 field.props.onChangeText('光学');button.props.onPress();h.render()
 assert.match(h.summary(),/“光学”/);assert.equal(h.results().length,2)
 h.filter('COURSE');assert.match(h.summary(),/没有匹配结果/)
 h.press('查看全部 2 条');assert.equal(h.results().length,2);assert.equal(h.find(n=>n.type==='OptionGroup').props.value,'ALL')
})
