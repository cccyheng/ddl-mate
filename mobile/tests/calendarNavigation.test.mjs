import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as calendar from '../src/domain/calendar.ts'
import * as clock from '../src/domain/calendarClock.ts'
import * as datetime from '../src/domain/datetime.ts'
import * as live from '../src/domain/timetableLive.ts'

// Execute the real screen callbacks; the navigation harness distinguishes stack back from tab press.
const source=readFileSync(new URL('../src/screens/CalendarMonthScreen.tsx',import.meta.url),'utf8')
let active
const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
const React={
 createElement:(type,props,...children)=>({type,props:{...props,children}}),
 useState(value){const h=active,i=h.pos++;if(!(i in h.slots))h.slots[i]=typeof value==='function'?value():value;return[h.slots[i],v=>h.slots[i]=typeof v==='function'?v(h.slots[i]):v]},
 useMemo(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps))h.slots[i]={deps,value:fn()};return h.slots[i].value},
 useEffect(fn,deps){const h=active,i=h.pos++;if(!h.slots[i]||!same(h.slots[i].deps,deps)){const old=h.slots[i];h.slots[i]={deps};h.effects.push(()=>{old?.cleanup?.();h.slots[i].cleanup=fn()})}},
}
React.useCallback=(fn,deps)=>React.useMemo(()=>fn,deps)
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out);if(n.props.headerAccessory)nodes(n.props.headerAccessory,p,out)}return out}
function fixture(){
 const h={slots:[],pos:0,effects:[],now:new Date('2026-11-03T12:00:00+08:00'),refreshes:0,focused:true,focus:null,routes:[{name:'CalendarMonth'}],tabs:new Set(),pops:0}
 const store={data:{tasks:[],courses:[],schedules:[]},refresh:async()=>{h.refreshes++}}
 const tab={addListener:(event,fn)=>{assert.equal(event,'tabPress');h.tabs.add(fn);return()=>h.tabs.delete(fn)}}
 const navigation={getParent:()=>tab,getState:()=>({routes:h.routes}),
  navigate:(name,params)=>{h.routes.push({name,params});h.focused=false},
  popToTop:()=>{h.pops++;h.routes=h.routes.slice(0,1);h.focused=true;h.focus?.()},
 }
 const deps={react:React,'react-native':{View:'View',Text:'Text',Pressable:'Pressable',ScrollView:'ScrollView',StyleSheet:{create:x=>x}},
  '@react-navigation/native':{useNavigation:()=>navigation,useFocusEffect:fn=>{if(h.focus!==fn){h.focus=fn;if(h.focused)h.effects.push(fn)}}},
  '../domain/calendar':calendar,'../domain/calendarClock':{...clock,calendarFocusTarget:()=>clock.calendarFocusTarget(h.now)},
  '../domain/datetime':{...datetime,shanghaiToday:()=>datetime.shanghaiToday(h.now)},'../domain/timetableLive':live,
  '../store/AppStore':{useAppStore:()=>store},'../ui/components':{AppButton:'AppButton',SectionCard:'SectionCard'},
  '../ui/ScreenScaffold':{ScreenScaffold:'ScreenScaffold'},'../ui/QuickActions':{ToolDisclosure:'ToolDisclosure'},
  '../ui/useFocusClock':{useFocusClock:()=>clock.readShanghaiClock(h.now)},'../ui/theme':{colors:{},spacing:{},radius:{},typography:{},MIN_TOUCH_SIZE:44},
 }
 const mod={exports:{}}
 const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=()=>{active=h;h.pos=0;h.effects=[];h.tree=mod.exports.CalendarMonthScreen();h.effects.splice(0).forEach(fn=>fn())}
 h.press=label=>{const button=nodes(h.tree,n=>n.type==='AppButton'&&n.props.label===label)[0];assert.ok(button,label);button.props.onPress();h.render()}
 h.title=()=>h.tree.props.title
 h.open=dateKey=>{const day=nodes(h.tree,n=>n.props.cell?.dateKey===dateKey)[0];assert.ok(day,dateKey);day.props.onPress(day.props.cell);h.render()}
 h.back=()=>{h.routes.pop();h.focused=true;h.focus();h.render()}
 h.tab=()=>{for(const fn of h.tabs)fn();h.focused=true;h.focus();h.render()}
 h.newRefresh=()=>{store.refresh=async()=>{h.refreshes++};h.render()}
 h.dispose=()=>h.slots.forEach(s=>s?.cleanup?.())
 h.render();return h
}
test('next month → date details → back preserves browsed month and refreshes data',()=>{
 const h=fixture();assert.equal(h.title(),'2026 年 11 月')
 h.press('下一月');h.open('2026-12-15');assert.equal(h.routes.at(-1).params.dateKey,'2026-12-15')
 const before=h.refreshes;h.back();assert.equal(h.title(),'2026 年 12 月');assert.equal(h.refreshes,before+1)
 h.render();h.newRefresh();assert.equal(h.title(),'2026 年 12 月')
 h.dispose();assert.equal(h.tabs.size,0)
})
test('previous months and year boundary survive repeated detail returns',()=>{
 const h=fixture();h.press('上一月');h.open('2026-10-08');h.back();assert.equal(h.title(),'2026 年 10 月')
 for(let i=0;i<3;i++)h.press('下一月')
 h.open('2027-01-02');h.back();h.open('2027-01-20');h.back();assert.equal(h.title(),'2027 年 1 月');h.dispose()
})
test('tab entry resets current month and pops details; explicit today and repeat tab press still work',()=>{
 const h=fixture();h.press('下一月');h.open('2026-12-15');h.tab()
 assert.equal(h.title(),'2026 年 11 月');assert.equal(h.routes.length,1);assert.equal(h.pops,1)
 h.press('下一月');h.tab();assert.equal(h.title(),'2026 年 11 月');assert.equal(h.pops,1)
 h.press('上一月');h.press('回到今天');assert.equal(h.title(),'2026 年 11 月');h.dispose()
})
test('cross-month clock update refreshes today without moving browsed month; tab entry reads fresh date',()=>{
 const h=fixture();h.press('下一月');h.press('下一月');h.open('2027-01-20')
 h.now=new Date('2026-12-01T00:01:00+08:00');h.back();assert.equal(h.title(),'2027 年 1 月')
 h.tab();assert.equal(h.title(),'2026 年 12 月');h.dispose()
})
