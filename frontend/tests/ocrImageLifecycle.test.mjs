/**
 * 图片生命周期回归测试（用最小 DOM stub 在 Node 里跑）。
 *
 * 背景（真实浏览器 bug）：以前 prepareImage 对"不需要缩放的小图"直接返回 HTMLImageElement，
 * 而该元素的 src 是临时 blob URL 且已在 onload 时被 revoke。Tesseract 收到 HTMLImageElement
 * 会再 fetch 一次 image.src，于是报 net::ERR_FILE_NOT_FOUND，页面 0 候选 + Failed to fetch。
 *
 * 这里断言：
 *   1. prepareImage 始终返回 canvas（不缩放的小图也是）；
 *   2. 临时 objectURL 一定在 drawImage 之后才被 revoke；
 *   3. cropImage 接受 canvas 且不会调用 URL.createObjectURL（对 canvas 调用会抛 TypeError）；
 *   4. File / Blob / URL / HTMLImageElement / HTMLCanvasElement 都能被接受。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// ----------------------------------------------------------------- DOM stub
const events = []
let createdUrls = 0

class FakeCanvas {
  constructor() {
    this.width = 0
    this.height = 0
    this.kind = 'canvas'
  }

  getContext() {
    const canvas = this
    return {
      drawImage: (source, ...rest) => {
        // 模拟浏览器：传 undefined / 非 CanvasImageSource 时抛同样的 TypeError。
        // 之前漏掉这个检查，才让 drawable=undefined 的 bug 溜了过去。
        if (!(source instanceof FakeCanvas) && !(source instanceof FakeImage)) {
          throw new TypeError(
            `Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The provided value is not of type 'CanvasImageSource'. (got ${String(source)})`,
          )
        }
        events.push({ type: 'draw', target: canvas, source, args: [source, ...rest] })
      },
    }
  }

  toDataURL() {
    return 'data:image/png;base64,'
  }
}

class FakeImage {
  constructor() {
    this.naturalWidth = 0
    this.naturalHeight = 0
    this.kind = 'image'
  }

  set src(value) {
    this._src = value
    queueMicrotask(() => {
      this.naturalWidth = 1200
      this.naturalHeight = 800
      this.onload?.()
    })
  }

  get src() {
    return this._src
  }
}

globalThis.HTMLCanvasElement = FakeCanvas
globalThis.HTMLImageElement = FakeImage
globalThis.Image = FakeImage
globalThis.document = {
  createElement: (tag) => {
    if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
    return new FakeCanvas()
  },
}
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
URL.createObjectURL = () => {
  createdUrls += 1
  return `blob:fake/${createdUrls}`
}
URL.revokeObjectURL = (url) => {
  events.push({ type: 'revoke', url })
}

const { prepareImage, cropImage, toRecognizableImage } = await import('../src/ocr/tesseractClient.js')

function reset() {
  events.length = 0
  createdUrls = 0
}

test('prepareImage 对小图也返回 canvas，且临时 URL 在绘制之后才释放', async () => {
  reset()
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  const result = await prepareImage(file)

  assert.ok(result.image instanceof FakeCanvas, '必须返回 canvas，而不是 src 可能已失效的 HTMLImageElement')
  assert.equal(result.scaled, false)
  assert.equal(result.width, 1200)
  assert.equal(result.height, 800)

  const drawIndex = events.findIndex((event) => event.type === 'draw')
  const revokeIndex = events.findIndex((event) => event.type === 'revoke')
  assert.ok(drawIndex >= 0, '应该把图片画到 canvas')
  assert.ok(
    events[drawIndex].source instanceof FakeImage,
    'drawImage 的第一个参数必须是解码后的图片对象（不能是 undefined）',
  )
  assert.ok(revokeIndex >= 0, '临时 objectURL 最终要释放')
  assert.ok(drawIndex < revokeIndex, '必须先绘制再 revoke，否则 blob 地址已失效')
})

test('prepareImage 支持 URL 字符串（内置样例）且不创建临时 blob', async () => {
  reset()
  const result = await prepareImage('/samples/timetable-grid.png')
  assert.ok(result.image instanceof FakeCanvas)
  assert.equal(createdUrls, 0, '字符串 URL 不需要 createObjectURL')
  assert.equal(events.filter((event) => event.type === 'revoke').length, 0)
  assert.ok(events.find((event) => event.type === 'draw').source instanceof FakeImage)
})

test('prepareImage 支持已经解码好的 HTMLImageElement', async () => {
  reset()
  const image = new FakeImage()
  image.naturalWidth = 600
  image.naturalHeight = 400
  const result = await prepareImage(image)
  assert.ok(result.image instanceof FakeCanvas)
  assert.equal(createdUrls, 0)
  const draws = events.filter((event) => event.type === 'draw')
  assert.equal(draws.length, 1)
  assert.equal(draws[0].source, image, 'drawImage 的源应该就是传入的那张图片')
})

test('prepareImage 支持 HTMLCanvasElement（不再重复取图）', async () => {
  reset()
  const canvas = new FakeCanvas()
  canvas.width = 300
  canvas.height = 200
  const result = await prepareImage(canvas)
  assert.ok(result.image instanceof FakeCanvas)
  assert.equal(createdUrls, 0)
  assert.equal(events.find((event) => event.type === 'draw').source, canvas, 'canvas 应被直接绘制')
})

test('大图会等比缩放，且缩放结果仍是 canvas', async () => {
  reset()
  class HugeImage extends FakeImage {
    set src(value) {
      this._src = value
      queueMicrotask(() => {
        this.naturalWidth = 8000
        this.naturalHeight = 6000
        this.onload?.()
      })
    }
  }
  const image = new HugeImage()
  image.src = 'blob:x'
  await new Promise((resolve) => setTimeout(resolve, 0))
  const result = await prepareImage(image)
  assert.equal(result.scaled, true)
  assert.ok(result.width < 8000 && result.height < 6000)
  assert.ok(result.image instanceof FakeCanvas)
})

test('cropImage 接受 canvas，且不对 canvas 调用 createObjectURL', async () => {
  reset()
  const source = new FakeCanvas()
  source.width = 1000
  source.height = 600
  const cropped = await cropImage(source, { x: 10, y: 20, width: 200, height: 100 })

  assert.equal(createdUrls, 0, 'canvas 不能走 createObjectURL（浏览器会抛 TypeError）')
  assert.equal(cropped.width, 200)
  assert.equal(cropped.height, 100)
  const draw = events.find((event) => event.type === 'draw')
  assert.equal(draw.source, source, 'canvas 必须作为 drawImage 的第一个参数原样传入')
  assert.deepEqual(draw.args.slice(1), [10, 20, 200, 100, 0, 0, 200, 100])
})

test('cropImage 越界选区会被夹到图片范围内', async () => {
  reset()
  const source = new FakeCanvas()
  source.width = 300
  source.height = 200
  const cropped = await cropImage(source, { x: 280, y: 190, width: 500, height: 500 })
  assert.equal(cropped.width, 20)
  assert.equal(cropped.height, 10)
})

test('cropImage 支持 File/Blob，并在绘制后释放临时 URL', async () => {
  reset()
  const file = new Blob([new Uint8Array([1])], { type: 'image/png' })
  const cropped = await cropImage(file, { x: 0, y: 0, width: 100, height: 50 })
  assert.equal(cropped.width, 100)
  assert.equal(cropped.height, 50)
  const drawIndex = events.findIndex((event) => event.type === 'draw')
  const revokeIndex = events.findIndex((event) => event.type === 'revoke')
  assert.ok(drawIndex >= 0 && revokeIndex > drawIndex)
  assert.ok(
    events[drawIndex].source instanceof FakeImage,
    'cropImage 对 Blob 也必须传解码后的图片对象（不是 undefined）',
  )
})

test('toRecognizableImage：HTMLImageElement 转成 canvas，Blob/URL/Canvas 原样返回', async () => {
  reset()
  const image = new FakeImage()
  image.naturalWidth = 500
  image.naturalHeight = 400
  const converted = await toRecognizableImage(image)
  assert.ok(converted instanceof FakeCanvas, '图片元素必须换成 canvas，避免引擎再 fetch 一次 src')
  const draws = events.filter((event) => event.type === 'draw')
  assert.equal(draws.length, 1)
  assert.equal(draws[0].source, image, '转换时绘制的源就是传入的图片元素')
  assert.equal(createdUrls, 0)

  const blob = new Blob([new Uint8Array([1])], { type: 'image/png' })
  assert.equal(await toRecognizableImage(blob), blob, 'Blob 原样交给引擎')

  const canvas = new FakeCanvas()
  assert.equal(await toRecognizableImage(canvas), canvas, 'Canvas 原样交给引擎')

  assert.equal(await toRecognizableImage('/samples/timetable-grid.png'), '/samples/timetable-grid.png')
})

test.after(() => {
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
})
