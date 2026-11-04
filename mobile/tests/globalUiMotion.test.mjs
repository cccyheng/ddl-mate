import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url),ts=require('typescript')
function compile(file,deps){
 const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 const mod={exports:{}}
 vm.runInNewContext('(function(require,module,exports){'+code+'})')(id=>{if(id in deps)return deps[id];throw Error(id)},mod,mod.exports)
 return mod.exports
}
function fixture(){
 const h={slots:[],pos:0,effects:[],reduced:false,animations:[],removed:0}
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),createContext:value=>({value,Provider:'Provider'}),useContext:()=>h.reduced,
  useState:v=>{const i=h.pos++;if(!(i in h.slots))h.slots[i]=v;return[h.slots[i],n=>{h.slots[i]=typeof n==='function'?n(h.slots[i]):n}]},
  useRef:v=>h.slots[h.pos++]??={current:v},
  useEffect:(fn,deps)=>{const i=h.pos++,old=h.slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){old?.cleanup?.();h.slots[i]={deps};h.effects.push(()=>{h.slots[i].cleanup=fn()})}},
 }
 class Value{constructor(v){this.value=v}setValue(v){this.value=v}interpolate(){return this}}
 const animation=(value,options)=>{const a={value,options,started:false,stopped:false,start(){this.started=true},stop(){this.stopped=true}};h.animations.push(a);return a}
 const native={Animated:{Value,spring:animation,timing:animation,View:'AnimatedView'},AccessibilityInfo:{
  addEventListener:(_,cb)=>{h.change=cb;return{remove:()=>h.removed++}},isReduceMotionEnabled:()=>new Promise(resolve=>{h.resolve=resolve})}}
 h.ui=compile('../src/ui/motion.tsx',{react:React,'react-native':native})
 h.render=fn=>{h.pos=0;h.effects=[];const result=fn();h.effects.forEach(f=>f());return result}
 h.unmount=()=>h.slots.forEach(s=>s?.cleanup?.())
 h.React=React;return h
}
test('system motion preference starts conservative, ignores stale initial read after event, removes listener',async()=>{
 const h=fixture(),render=()=>h.render(()=>h.ui.MotionProvider({children:'app'}))
 assert.equal(render().props.value,true)
 h.change(true);h.resolve(false);await Promise.resolve();assert.equal(render().props.value,true)
 h.change(false);assert.equal(render().props.value,false)
 h.unmount();assert.equal(h.removed,1);h.change(true);assert.equal(h.slots[0],false)
})
test('button motion never invokes business action; cancels on disable, preference change and unmount',()=>{
 const h=fixture();let disabled=false
 const render=()=>h.render(()=>h.ui.usePressMotion(disabled))
 let press=render();press.onPressIn();assert.equal(h.animations[0].options.toValue,0.97);assert.equal(h.animations[0].options.useNativeDriver,true)
 press.onPressOut();assert.equal(h.animations[0].stopped,true);assert.equal(h.animations[1].options.toValue,1)
 disabled=true;press=render();assert.equal(h.animations[1].stopped,true);assert.equal(press.scale.value,1)
 press.onPressIn();assert.equal(h.animations.length,2)
 disabled=false;h.reduced=true;press=render();press.onPressIn();assert.equal(h.animations.length,2)
 h.reduced=false;press=render();press.onPressIn();h.unmount();assert.equal(h.animations.at(-1).stopped,true)
})
test('short reveal stops on unmount and shows immediately with reduced motion',()=>{
 const h=fixture();h.render(()=>h.ui.MotionReveal({children:'content'}));assert.equal(h.animations[0].started,true)
 h.reduced=true;h.render(()=>h.ui.MotionReveal({children:'content'}));assert.equal(h.animations[0].stopped,true);assert.equal(h.slots[0].current.value,1)
 h.unmount()
})
test('tool disclosure only hides secondary tools; opening and action callbacks remain operable',()=>{
 const h=fixture(),ui=compile('../src/ui/QuickActions.tsx',{react:h.React,'react-native':{View:'View',Text:'Text',StyleSheet:{create:x=>x}},'./components':{AppButton:'Button',SectionCard:'Card'},'./motion':{MotionReveal:'Reveal'},'./theme':{colors:{},spacing:{},typography:{}}})
 let tree=h.render(()=>ui.ToolDisclosure({title:'工具',children:'tools'}));assert.equal(tree.props.children[1],null)
 tree.props.children[0].props.onPress();tree=h.render(()=>ui.ToolDisclosure({title:'工具',children:'tools'}));assert.equal(tree.props.children[1].type,'Reveal')
 let called=0;const grid=ui.QuickActions({title:'入口',actions:[{label:'备份',onPress:()=>called++}]})
 grid.props.children[0].props.children[0][0].props.onPress();assert.equal(called,1)
})

test('actual animated button preserves accessibility, layout and action; loading/disabled block submission',()=>{
 const h=fixture()
 const theme=compile('../src/ui/theme.ts',{'react-native':{Platform:{select:o=>o.ios}}})
 const ui=compile('../src/ui/components.tsx',{react:h.React,'react-native':{Animated:{View:'AnimatedView'},Pressable:'Pressable',Text:'Text',View:'View',ActivityIndicator:'Spinner',StyleSheet:{create:x=>x}},'./theme':theme,'./motion':{usePressMotion:h.ui.usePressMotion}})
 let calls=0;const props={label:'保存',onPress:()=>calls++,style:{flex:1,marginTop:8},testID:'save'}
 const render=()=>h.render(()=>ui.AppButton(props))
 let tree=render(),button=tree.props.children[0]
 assert.equal(tree.props.style[1],props.style);assert.equal(button.props.testID,'save');assert.equal(button.props.accessibilityRole,'button')
 button.props.onPressIn();assert.equal(calls,0);button.props.onPressOut();assert.equal(calls,0)
 button.props.onPress();assert.equal(calls,1)
 props.loading=true;button=render().props.children[0];assert.equal(button.props.accessibilityState.busy,true);button.props.onPress();assert.equal(calls,1)
 props.loading=false;props.disabled=true;button=render().props.children[0];assert.equal(button.props.disabled,true);button.props.onPress();assert.equal(calls,1)
 props.disabled=false;render().props.children[0].props.onPress();assert.equal(calls,2);h.unmount()
})
