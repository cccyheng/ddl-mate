// Runs the actual TSX callbacks with deterministic hooks. Native rendering still needs phone QA.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as report from '../src/domain/learningReport.ts'
import * as state from '../src/screens/learningReportScreenState.ts'
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
const theme=compile('../src/ui/theme.ts',{'react-native':{Platform:{select:o=>o.ios}}})
const task=(id,extra={})=>({id,title:`任务${id}`,description:null,courseId:1,type:'HOMEWORK',status:'DONE',priority:3,deadline:'2026-10-26',estimatedMinutes:null,submitRequirement:null,submitMethod:null,completedAt:'2026-10-26T00:00:00Z',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z',...extra})
function fixture(tasks=Array.from({length:25},(_,i)=>task(i+1))) {
  const h={slots:[],pos:0,effects:[],now:Date.parse('2026-10-27T00:00:00Z'),nav:[],refreshes:0}
  const store={status:'ready',data:{tasks,courses:[{id:1,name:'同名课'},{id:2,name:'同名课'}]},refresh:async()=>{h.refreshes++},retryBootstrap:async()=>{},courseById:id=>store.data.courses.find(c=>c.id===id)??null}
  const widgets=Object.fromEntries(['AppButton','Badge','EmptyState','ErrorState','LoadingState','RefreshErrorBanner','SectionCard'].map(k=>[k,k]))
  const deps={react:React,'react-native':{Text:'Text',View:'View',Pressable:'Pressable',StyleSheet:{create:x=>x}},
    '@react-navigation/native':{useNavigation:()=>({navigate:(...args)=>h.nav.push(args)}),useFocusEffect:()=>{}},
    '../domain/calendarClock':{readShanghaiEpochClock:()=>{}},'../domain/datetime':datetime,'../domain/learningReport':report,'../domain/types':types,
    '../store/AppStore':{useAppStore:()=>store},'../ui/components':widgets,'../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/FocusWeekSummary':{FocusWeekSummary:'FocusWeekSummary'},'../ui/WeeklyGoalCard':{WeeklyGoalCard:'WeeklyGoalCard'},
    '../ui/useFocusClock':{useFocusClock:()=>({epochMs:h.now,dateKey:datetime.shanghaiToday(new Date(h.now))})},'../ui/theme':theme,'./learningReportScreenState':state}
  const screen=compile('../src/screens/LearningReportScreen.tsx',deps)
  h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=screen.LearningReportScreen();active=null;h.effects.forEach(f=>f());return h.tree}
  h.all=p=>nodes(h.tree,p);h.find=p=>h.all(p)[0];h.button=label=>h.find(n=>n.type==='AppButton'&&n.props.label===label)
  h.press=label=>{const b=h.button(label);assert.ok(b,label);assert.ok(!b.props.disabled);b.props.onPress();h.render()}
  h.tap=prefix=>{const n=h.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.startsWith(prefix));assert.ok(n,prefix);n.props.onPress();h.render()}
  h.cards=()=>h.all(n=>n.type==='SectionCard').map(n=>n.props.title)
  h.rows=()=>h.all(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.endsWith('打开任务详情'))
  h.store=store;h.render();return h
}

test('summary tap shows only detail, pages reset scroll, task return and data refresh preserve selection',()=>{
  const h=fixture(),summaryKey=h.tree.props.key
  h.tap('本周完成 25');assert.deepEqual(h.cards(),['选择周','本周完成的任务（25 条）']);assert.equal(h.rows().length,20)
  assert.notEqual(h.tree.props.key,summaryKey);const firstKey=h.tree.props.key
  h.press('下一页');assert.equal(h.rows().length,5);assert.notEqual(h.tree.props.key,firstKey)
  const secondKey=h.tree.props.key,label=h.rows()[0].props.accessibilityLabel
  h.rows()[0].props.onPress();assert.equal(h.nav[0][0],'TaskDetail');assert.ok(Number.isInteger(h.nav[0][1].id))
  h.store.data={...h.store.data,tasks:[...h.store.data.tasks]};h.render()
  assert.equal(h.tree.props.key,secondKey);assert.equal(h.rows()[0].props.accessibilityLabel,label)
  h.press('返回汇总');assert.ok(h.cards().includes('每日完成'));assert.equal(h.tree.props.key,summaryKey)
})

test('week navigation keeps filter, resets pagination, uses historical copy and anchors refresh',()=>{
  const h=fixture();h.tap('本周完成 25');h.press('下一页');h.press('上一周')
  assert.deepEqual(h.cards(),['选择周','所选周完成的任务（0 条）']);assert.ok(h.find(n=>n.type==='EmptyState'))
  assert.match(h.tree.props.key,/2026-10-19\|1\|completedThisWeek/)
  const key=h.tree.props.key;h.now=Date.parse('2026-11-02T00:00:00Z');h.render();assert.equal(h.tree.props.key,key)
  h.press('返回汇总');assert.ok(h.cards().includes('所选周概览'));assert.ok(h.cards().includes('按课程看所选周到期'))
  assert.ok(h.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel.startsWith('所选周到期 0')))
  h.press('回到本周');assert.match(h.tree.props.key,/2026-11-02/);assert.equal(h.button('下一周').props.disabled,true)
})

test('day and same-name course drilldowns match their tasks; changing filter resets page',()=>{
  const h=fixture([task(1),task(2,{courseId:2}),task(3,{courseId:1,completedAt:'2026-10-27T00:00:00Z'})])
  const days=h.all(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.includes('查看当天完成的任务'))
  assert.equal(days.length,7);days[0].props.onPress();h.render();assert.equal(h.rows().length,2)
  h.press('返回汇总')
  const courses=h.all(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.startsWith('同名课，'))
  assert.equal(courses.length,2);courses[1].props.onPress();h.render();assert.equal(h.rows().length,1)
  assert.match(h.rows()[0].props.accessibilityLabel,/^任务2，/)
  assert.deepEqual(h.cards(),['选择周','同名课 · 本周到期（1 条）'])
})

test('actual rendered day styles fit 320pt including shared padding, keep 44pt targets and wrap',()=>{
  const h=fixture(),days=h.all(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.includes('查看当天完成的任务'))
  const column=days[0].props.style({pressed:false})[0]
  const row=h.find(n=>n.type==='View'&&n.props.style?.gap===state.LEARNING_REPORT_DAY_COLUMN_GAP&&n.props.style?.alignItems==='flex-end').props.style
  const ui=compile('../src/ui/components.tsx',{react:React,'react-native':{StyleSheet:{create:x=>x},Platform:{OS:'ios'}},'./theme':theme,'./motion':{usePressMotion:()=>({})}})
  const card=ui.SectionCard({title:'x',children:null}),cardStyle=card.props.style
  const merged=Object.assign({},...[cardStyle].flat().filter(Boolean))
  const scaffold=compile('../src/ui/ScreenScaffold.tsx',{react:React,'react-native':{StyleSheet:{create:x=>x},Platform:{OS:'ios'},useWindowDimensions:()=>({width:320,fontScale:1}),ScrollView:'ScrollView',SafeAreaView:'SafeAreaView',View:'View'},'react-native-safe-area-context':{SafeAreaView:'SafeAreaView'},'./theme':theme})
  const scroll=nodes(scaffold.ScreenScaffold({title:'x',children:null}),n=>n.type==='ScrollView')[0]
  const content=Object.assign({},...scroll.props.contentContainerStyle.filter(Boolean))
  const width=320-2*content.paddingHorizontal-2*(merged.paddingHorizontal??merged.padding??0)-2*(merged.borderWidth??0)
  const colWidth=Math.max(column.minWidth,width*parseFloat(column.flexBasis)/100)
  const perRow=Math.floor((width+row.gap)/(colWidth+row.gap))
  assert.equal(row.flexWrap,'wrap');assert.equal(column.flexShrink,0)
  assert.ok(colWidth>=44);assert.ok(column.minHeight>=44);assert.equal(Math.ceil(7/perRow),2)
  assert.ok(perRow*colWidth+(perRow-1)*row.gap<=width)
})

test('empty report has no fake rate or completion; explanation toggles without losing position',()=>{
  const h=fixture([]),key=h.tree.props.key
  const rate=h.find(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.startsWith('本周到期完成率'))
  assert.match(text(rate),/—/);assert.match(text(h.tree),/本周还没有完成记录/)
  assert.doesNotMatch(text(h.tree),/完成时间缺失的已完成任务仍算进/)
  h.press('统计说明');assert.match(text(h.tree),/完成时间缺失的已完成任务仍算进/);assert.equal(h.tree.props.key,key)
  h.press('收起统计说明');assert.equal(h.tree.props.key,key)
})

test('shrinking data clamps displayed page and scroll key; loading and retry stay available',()=>{
  const h=fixture();h.tap('本周完成 25');h.press('下一页');const key=h.tree.props.key
  h.store.data={...h.store.data,tasks:[task(1)]};h.render();assert.equal(h.rows().length,1);assert.notEqual(h.tree.props.key,key)
  assert.match(h.tree.props.key,/\|1\|completedThisWeek/)
  h.store.status='loading';h.render();assert.equal(h.cards().length,0);assert.ok(h.find(n=>n.type==='LoadingState'))
  h.store.status='error';h.render();assert.ok(h.find(n=>n.type==='ErrorState'))
})
