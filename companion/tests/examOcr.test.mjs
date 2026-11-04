import test from 'node:test'
import assert from 'node:assert/strict'
import {PNG} from 'pngjs'
import {findExamCards} from '../src/examOcr.mjs'
import {startServer,createOcrService} from '../src/server.mjs'
const logger={info(){},warn(){},error(){}}
const png=new PNG({width:8,height:8});png.data.fill(255)
const body=Buffer.from(JSON.stringify({imageBase64:PNG.sync.write(png).toString('base64')}))
test('geometry joins dark title rows within each white card; ignores header and white fullpage',()=>{
  const width=300,height=700,data=new Uint8ClampedArray(width*height*4).fill(30)
  for(const y0 of [140,290,440])for(let y=y0;y<y0+120;y++)for(let x=62;x<290;x++){const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=(y>y0+22&&y<y0+30&&x<160)?35:250;data[i+3]=255}
  const cards=findExamCards({width,height,data});assert.equal(cards.length,3);assert.ok(cards[0].y0<=140);assert.ok(cards[0].y1>=259)
  data.fill(255);assert.equal(findExamCards({width,height,data}).length,0)
})
test('real HTTP exam route has request id, dedicated engine, health and shared method validation',async()=>{
  let calls=0;const engine={async recognizeExams(){calls++;return {rawText:'【考试 1】\n测试\n【结束】',warnings:[]}},async terminate(){}}
  const handle=await startServer(['--port','0'],logger,{engine})
  try{const base=`http://127.0.0.1:${handle.server.address().port}`
    const health=await(await fetch(`${base}/v1/health`)).json();assert.equal(health.examOcr,true)
    const res=await fetch(`${base}/v1/ocr/exams`,{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(res.status,200)
    const result=await res.json();assert.match(result.requestId,/^exams-/);assert.match(result.rawText,/测试/);assert.equal(calls,1)
    assert.equal((await fetch(`${base}/v1/ocr/exams`)).status,405)
  }finally{await handle.close()}
})
test('exam requests share concurrency and reject late cancelled results',async()=>{
  let finish;const pending=new Promise(r=>finish=r)
  const service=createOcrService({engine:{recognizeExams:()=>pending},logger}),abort=new AbortController()
  const request=()=>service.handleRequest({method:'POST',url:'/v1/ocr/exams',body,headers:{'content-type':'application/json'},signal:abort.signal})
  const a=request(),b=request();assert.equal((await request()).status,429);abort.abort();finish({rawText:'late',warnings:[]})
  assert.equal((await a).status,499);assert.equal((await b).status,499)
})
