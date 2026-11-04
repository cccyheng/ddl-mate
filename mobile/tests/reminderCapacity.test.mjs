import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import * as datetime from '../src/domain/datetime.ts'
import * as reminder from '../src/domain/taskReminder.ts'
const require=createRequire(import.meta.url),ts=require('typescript')
test('actual Expo adapter serializes competing producers at the final 60-notification cap', async()=>{
 const pending=new Map(Array.from({length:59},(_,i)=>['old'+i,{identifier:'old'+i,content:{}}]))
 const api={SchedulableTriggerInputTypes:{DATE:'date',CALENDAR:'calendar'},setNotificationHandler(){},getAllScheduledNotificationsAsync:async()=>[...pending.values()],scheduleNotificationAsync:async r=>{await new Promise(resolve=>setImmediate(resolve));pending.set(r.identifier,r)},cancelScheduledNotificationAsync:async id=>pending.delete(id)}
 const deps={'react-native':{Platform:{OS:'ios'}},'expo-notifications':api,'./datetime':datetime,'./taskReminder':reminder}
 const code=ts.transpileModule(readFileSync(new URL('../src/domain/expoTaskReminderPort.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,mod={exports:{}}
 vm.runInNewContext('(function(require,module,exports){'+code+'})',{console,Date})(id=>{assert.ok(id in deps,id);return deps[id]},mod,mod.exports)
 const first=mod.exports.createExpoTaskReminderPort(),second=mod.exports.createExpoTaskReminderPort()
 const input=id=>({identifier:id,title:'test',body:'test',triggerAtMs:Date.now()+60_000,data:{}})
 const result=await Promise.allSettled([first.schedule(input('task')),second.schedule(input('class'))])
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(pending.size,60)
 await first.cancel('task');await second.schedule(input('class'));assert.equal(pending.size,60)
 await assert.rejects(second.schedule({...input('past'),triggerAtMs:Date.now()-1}),/过去/)
})
