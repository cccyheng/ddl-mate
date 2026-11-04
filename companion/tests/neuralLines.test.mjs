import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCellLines, recognizeCellDetails } from '../src/neuralOcr.mjs'
import { decodeImage } from '../src/imageCodec.mjs'

test('line crops stay in their table cells, preserve row order, and ignore borders/empty cells', () => {
  const width = 120, height = 80, data = new Uint8ClampedArray(width * height * 4).fill(255)
  const rect = (x0,y0,x1,y1) => {
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)for(let c=0;c<3;c++)data[(y*width+x)*4+c]=0
  }
  rect(0,0,60,1); rect(0,79,60,80)
  rect(8,8,30,16); rect(15,35,45,43)
  const cells = [{x0:0,y0:0,width:60,height:80},{x0:60,y0:0,width:60,height:80}]
  const lines=extractCellLines({data,width,height},cells)
  assert.equal(lines.length,2)
  assert.deepEqual(lines.map(line=>line.cellIndex),[0,0])
  assert.deepEqual(lines.map(line=>line.id),['0','1'])
  const crops=lines.map(line=>decodeImage(Buffer.from(line.png,'base64')))
  assert.ok(crops[0].width<crops[1].width)
  assert.ok(crops.every(crop=>crop.height===12))
})

test('a short wrapped suffix joins its preceding full-width line without joining neighboring cells', () => {
  const width=100,height=60,data=new Uint8ClampedArray(width*height*4).fill(255)
  for(const [x0,y0,x1,y1]of [[5,5,85,13],[42,20,55,28]]) {
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)for(let c=0;c<3;c++)data[(y*width+x)*4+c]=0
  }
  const lines=extractCellLines({data,width,height},[{x0:0,y0:0,width,height}])
  assert.equal(lines.length,1)
  const crop=decodeImage(Buffer.from(lines[0].png,'base64'))
  assert.ok(crop.width>width, 'both image fragments are kept')
})

test('cancellation prevents launching a worker, missing runtime rejects cleanly', async () => {
  const width=60,height=30,data=new Uint8ClampedArray(width*height*4).fill(255)
  for(let y=6;y<16;y++)for(let x=5;x<40;x++)for(let c=0;c<3;c++)data[(y*width+x)*4+c]=0
  const image={data,width,height},cells=[{x0:0,y0:0,width,height}]
  const config={python:'definitely-not-a-python-executable',runtime:'.',model:'missing.onnx'}
  await assert.rejects(recognizeCellDetails(config,image,cells,{isCancelled:()=>true}),/cancelled/)
  await assert.rejects(recognizeCellDetails(config,image,cells),/unavailable/)
})
