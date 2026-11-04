import test from 'node:test'
import assert from 'node:assert/strict'
import {buildSearchIndex,normalizeSearchText,searchLocal,SEARCH_PAGE_SIZE} from '../src/domain/globalSearch.ts'
const task=(id,extra={})=>({id,title:'实验报告',description:null,courseId:10,type:'HOMEWORK',status:'TODO',priority:3,deadline:null,estimatedMinutes:null,submitRequirement:null,submitMethod:null,completedAt:null,createdAt:'2026-11-01',updatedAt:'2026-11-01',...extra})
const course={id:10,name:'大学物理',instructor:'王老师',semester:'2026 秋',note:'光学实验：注意蓝色光源',code:'SECRET-AUTO-01',selectionSerial:'HIDDEN123',createdAt:'2026-11-01',updatedAt:'2026-11-01'}
const fixture=()=>({courses:[course],tasks:[task(1,{description:'记录光学实验现象',submitMethod:'校园平台'}),task(2,{type:'EXAM',title:'大学物理期末考试',description:'座位号 59',deadline:'2026-12-20'}),task(3,{status:'DONE',title:'光学实验总结'}),task(4,{status:'CANCELLED',title:'已取消实验'})],originalTexts:new Map([[1,'老师通知：实验报告交到校园平台'],[2,'物理考试安排'],[999,'不存在的任务不得出现']])})

test('Unicode width/case/whitespace normalization and literal special characters',()=>{
 assert.equal(normalizeSearchText('  Ｃ＋＋\n 编程  '),'c++ 编程')
 assert.equal(normalizeSearchText('e\u0301'),'é')
 const index=buildSearchIndex({tasks:[task(1,{title:'Ｃ＋＋ [a.*] 练习',courseId:null})],courses:[],originalTexts:new Map()})
 assert.equal(searchLocal(index,' c++   [A.*] ').total,1)
 assert.equal(searchLocal(index,'[other]').total,0)
 for(const query of ['', ' \n　 ']) { const r=searchLocal(index,query);assert.equal(r.hasQuery,false);assert.equal(r.total,0) }
})
test('correct category counts, exam separate from tasks, notes owner dedup and hidden codes excluded',()=>{
 const snapshot=fixture(),before=JSON.stringify([...snapshot.originalTexts]),index=buildSearchIndex(snapshot)
 const exams=searchLocal(index,'物理','EXAM');assert.equal(exams.total,1);assert.equal(exams.items[0].owner.id,2)
 assert.ok(searchLocal(index,'物理','TASK').items.every(x=>x.owner.id!==2))
 const notes=searchLocal(index,'实验','NOTE');assert.equal(notes.total,2)
 assert.deepEqual(new Set(notes.items.map(x=>x.key)),new Set(['NOTE:course:10','NOTE:task:1']))
 const all=searchLocal(index,'物理');assert.equal(all.counts.ALL,all.counts.TASK+all.counts.COURSE+all.counts.EXAM+all.counts.NOTE)
 assert.equal(searchLocal(index,'SECRET-AUTO-01').total,0);assert.equal(searchLocal(index,'HIDDEN123').total,0)
 assert.equal(searchLocal(index,'不存在的任务').total,0);assert.equal(JSON.stringify([...snapshot.originalTexts]),before)
})
test('multiple keywords match across real fields; original notifications, teacher, dates and completed tasks searchable',()=>{
 const index=buildSearchIndex(fixture())
 assert.equal(searchLocal(index,'王老师 校园平台','TASK').items[0].owner.id,1)
 assert.equal(searchLocal(index,'老师通知','NOTE').items[0].owner.id,1)
 assert.equal(searchLocal(index,'2026-12-20','EXAM').items[0].owner.id,2)
 assert.equal(searchLocal(index,'已完成','TASK').items[0].owner.id,3)
 assert.equal(searchLocal(index,'已取消','TASK').items[0].owner.id,4)
 assert.equal(searchLocal(index,'物理 不存在的词').total,0)
})
test('pagination is bounded, deterministic, clamped after deletion and ranks exact titles first',()=>{
 const snapshot={courses:[],tasks:Array.from({length:65},(_,i)=>task(i+1,{title:`报告 ${i}`,courseId:null})),originalTexts:new Map()}
 snapshot.tasks.push(task(80,{title:'报告',courseId:null}))
 const index=buildSearchIndex(snapshot),first=searchLocal(index,'报告'),last=searchLocal(index,'报告','ALL',99)
 assert.equal(first.total,66);assert.equal(first.items.length,SEARCH_PAGE_SIZE);assert.equal(first.items[0].owner.id,80)
 assert.equal(last.page,2);assert.equal(last.items.length,6);assert.equal(last.pages,3)
 const second=searchLocal(index,'报告','ALL',1)
 assert.equal(new Set([...first.items,...second.items,...last.items].map(x=>x.key)).size,66)
 assert.equal(searchLocal(index.slice(0,1),'报告','ALL',2).page,0)
 assert.deepEqual(searchLocal(index,'报告').items,first.items)
})
test('long snippets include matching text and remain bounded; refresh rebuild removes deleted/old matches',()=>{
 const snapshot={courses:[],tasks:[task(1,{description:'前文'.repeat(300)+'🪴关键字在这里'+'后文'.repeat(300)})],originalTexts:new Map()}
 const result=searchLocal(buildSearchIndex(snapshot),'关键字','NOTE')
 assert.match(result.items[0].snippet,/关键字在这里/);assert.ok(Array.from(result.items[0].snippet).length<140)
 snapshot.tasks=[];assert.equal(searchLocal(buildSearchIndex(snapshot),'关键字').total,0)
})
