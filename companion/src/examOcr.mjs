import { recognizeCellDetails } from './neuralOcr.mjs'

// Locate wide light cards on a darker background. All geometry is derived from pixels.
export function findExamCards(image) {
  const {width:w,height:h,data}=image, rows=[]
  for(let y=0;y<h;y++) {
    let bright=0,total=0
    for(let x=Math.floor(w*.3);x<w*.9;x+=3) {
      const i=(y*w+x)*4;total++;if(Math.min(data[i],data[i+1],data[i+2])>220)bright++
    }
    rows.push(bright/total>.55)
  }
  const bands=[];let first=-1,last=-1
  for(let y=0;y<=h;y++) {
    if(rows[y]){if(first<0)first=y;last=y}
    if(first>=0&&(y-last>Math.max(4,h*.01)||y===h)) {
      if(last-first>h*.045&&last-first<h*.4) bands.push({y0:first,y1:last})
      first=-1
    }
  }
  const cards=bands.map(b=>{
    const y=Math.min(b.y1,b.y0+Math.round((b.y1-b.y0)*.06))
    let left=Math.floor(w*.5),right=left
    const light=x=>{const i=(y*w+x)*4;return Math.min(data[i],data[i+1],data[i+2])>220}
    while(left>0&&light(left-1))left--
    while(right<w-1&&light(right+1))right++
    return {...b,x0:left,x1:right}
  }).filter(b=>b.x0>w*.08&&b.x1-b.x0>w*.5)
  if(cards.length>20)throw new Error('一张图片超过 20 场考试，请分图识别。')
  return cards
}

// Percentile stretch makes pale text/dark timeline ink readable without inventing characters.
function cropContrast(image,box,dark=false) {
  const x0=Math.max(0,Math.floor(box.x0)),y0=Math.max(0,Math.floor(box.y0))
  const width=Math.max(1,Math.min(image.width,Math.ceil(box.x1))-x0),height=Math.max(1,Math.min(image.height,Math.ceil(box.y1))-y0)
  const gray=new Uint8Array(width*height),hist=new Uint32Array(256)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const p=((y0+y)*image.width+x0+x)*4
    let v=Math.round((image.data[p]+image.data[p+1]+image.data[p+2])/3)
    if(dark)v=255-image.data[p+2]
    gray[y*width+x]=v;hist[v]++
  }
  let low=0,count=0
  for(;low<254;low++){count+=hist[low];if(count>gray.length*.015)break}
  let high=255;count=0
  for(;high>low+1;high--){count+=hist[high];if(count>gray.length*.02)break}
  const data=new Uint8ClampedArray(width*height*4)
  for(let i=0;i<gray.length;i++){const v=Math.max(0,Math.min(255,Math.round((gray[i]-low)*255/Math.max(1,high-low))));data[i*4]=data[i*4+1]=data[i*4+2]=v;data[i*4+3]=255}
  return {data,width,height}
}
export async function recognizeExamCards(engine,image,{isCancelled=()=>false}={}) {
  const started=Date.now(),cards=findExamCards(image),chunks=[],warnings=[]
  let ocrCalls=0
  if(!cards.length) {
    const fallback=await engine.recognizeNotice(image,{isCancelled})
    return {...fallback,warnings:[...fallback.warnings,'没有定位到考试卡片，请逐项核对文字；可手动填写遗漏考试。']}
  }
  async function read(crop) {
    if(isCancelled())throw Object.assign(new Error('识别已取消'),{code:'CANCELLED'})
    ocrCalls++
    if(engine.neuralConfig){
      const result=await recognizeCellDetails(engine.neuralConfig,crop,[{x0:0,y0:0,width:crop.width,height:crop.height}],{isCancelled})
      return result[0]?.text??''
    }
    const gray=new Uint8Array(crop.width*crop.height)
    for(let i=0;i<gray.length;i++)gray[i]=crop.data[i*4]
    return (await engine.recognizeGray(gray,crop.width,crop.height,{psm:'6'}))?.text??''
  }
  for(const [index,card] of cards.entries()) {
    const cw=card.x1-card.x0,ch=card.y1-card.y0
    const body=await read(cropContrast(image,{x0:card.x0+cw*.035,x1:card.x1-cw*.13,y0:card.y0+ch*.08,y1:card.y1-ch*.07}))
    const timeCrop=cropContrast(image,{x0:image.width*.025,x1:card.x0-image.width*.04,y0:card.y0+ch*.07,y1:card.y0+ch*.65},true)
    let times=await read(timeCrop)
    const timeMatches=text=>[...text.matchAll(/(?<!\d)(?:[01]?\d|2[0-3])[:：.][0-5]\d(?!\d)/g)]
    if(timeMatches(times).length!==2) {
      const gray=new Uint8Array(timeCrop.width*timeCrop.height)
      for(let i=0;i<gray.length;i++)gray[i]=timeCrop.data[i*4]
      ocrCalls++
      const fallback=(await engine.recognizeGray(gray,timeCrop.width,timeCrop.height,{psm:'6'}))?.text??''
      if(timeMatches(fallback).length===2)times=fallback
    }
    chunks.push(`【考试 ${index+1}】\n${body}\n时间栏：${times.replace(/\n/g,' ')}\n【结束】`)
    if(timeMatches(times).length!==2) warnings.push(`第 ${index+1} 场的时间较暗或未读清，请对照原图确认。`)
  }
  warnings.push('识别结果需逐场核对；灰色卡片也会保留，过去的考试默认不勾选。')
  return {rawText:chunks.join('\n\n'),warnings,empty:false,cancelled:isCancelled(),ms:Date.now()-started,ocrCalls}
}
