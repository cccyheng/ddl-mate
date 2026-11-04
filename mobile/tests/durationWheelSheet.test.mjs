import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as rules from '../src/domain/timeWheel.ts'
const source=readFileSync(new URL('../src/ui/timeWheel.tsx',import.meta.url),'utf8')
test('actual duration wheel commits last synchronous scroll choice; cancel never commits',()=>{
 const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),useMemo:fn=>fn(),useState:v=>[v,()=>{}],useRef:v=>({current:v})}
 const deps={react:React,'react-native':{StyleSheet:{create:x=>x},View:'View',Text:'Text'},'react-native-safe-area-context':{},'./motion':{},'../domain/datetime':{},'../domain/timeWheel':rules,'./components':{},'./theme':{colors:{},spacing:{},radius:{},typography:{},MIN_TOUCH_SIZE:44}}
 const mod={exports:{}},code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 const saved=[];let cancelled=0
 const sheet=mod.exports.DurationWheelSheet({value:25,max:180,title:'专注时长',onCancel:()=>cancelled++,onConfirm:v=>saved.push(v)})
 const column=sheet.props.children[0].props.children[0]
 assert.equal(column.props.values.length,180);assert.equal(column.props.selectedIndex,24)
 column.props.onChange(0);column.props.onChange(179);sheet.props.onConfirm()
 assert.deepEqual(saved,[180])
 const second=mod.exports.DurationWheelSheet({value:5,max:60,title:'休息时长',onCancel:()=>cancelled++,onConfirm:v=>saved.push(v)})
 second.props.children[0].props.children[0].props.onChange(9);second.props.onCancel()
 assert.equal(cancelled,1);assert.deepEqual(saved,[180])
})
