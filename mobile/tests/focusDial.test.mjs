import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('../src/ui/FocusDial.tsx',import.meta.url),'utf8')
function fixture({width=248,fontScale=1}={}){
 const h={width,fontScale}
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useState:()=>[h.width,v=>h.width=v]}
 const deps={react,'react-native':{StyleSheet:{create:x=>x},Text:'Text',View:'View',useWindowDimensions:()=>({fontScale:h.fontScale})},'./motion':{MotionReveal:'MotionReveal'},'./theme':{colors:{},typography:{}}}
 const mod={exports:{}},code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 h.render=(extra={})=>mod.exports.FocusDial({value:'25:00',label:'番茄专注中',progress:0.5,rest:false,caption:'50% 已完成',...extra})
 return h
}
function nodes(n,p,out=[]){if(Array.isArray(n))n.forEach(x=>nodes(x,p,out));else if(n?.props){if(p(n))out.push(n);nodes(n.props.children,p,out)}return out}
const styles=n=>Object.assign({},...[n.props.style].flat().filter(Boolean))
test('normal phone width constrains dial, real progress paints half/full/no ticks without fake elapsed progress',()=>{
 const h=fixture(),tree=h.render()
 const dial=nodes(tree,n=>styles(n).height===248)[0];assert.ok(dial)
 const marks=nodes(tree,n=>n.props.importantForAccessibility==='no-hide-descendants')[0]
 const ticks=nodes(marks,n=>styles(n).width===3)
 assert.equal(ticks.length,60);assert.equal(ticks.filter(n=>styles(n).backgroundColor==='#285B47').length,30)
 for(const tick of ticks){const s=styles(tick);assert.ok(s.left>=0&&s.left+s.width<=248);assert.ok(s.top>=0&&s.top+s.height<=248)}
 assert.equal(nodes(h.render({progress:1}),n=>styles(n).width===3&&styles(n).backgroundColor==='#285B47').length,60)
 assert.equal(nodes(h.render({progress:null}),n=>styles(n).width===3&&styles(n).backgroundColor==='#285B47').length,0)
})
test('large accessibility text or very narrow content uses unconstrained flow, retains time and rest semantics',()=>{
 for(const options of [{width:248,fontScale:2},{width:180,fontScale:1}]){
  const tree=fixture(options).render({rest:true,label:'休息结束',value:'00:00',caption:'100% 已完成'})
  assert.equal(nodes(tree,n=>n.props.importantForAccessibility==='no-hide-descendants').length,0)
  assert.equal(nodes(tree,n=>typeof styles(n).height==='number').length,0)
  const value=nodes(tree,n=>n.props.accessibilityLabel==='休息结束，00:00')[0];assert.ok(value);assert.equal(styles(value).color,'#98702C')
 }
})
