/**
 * 「截图转待办」运行状态机的行为测试（真异步、真取消、真重试）。
 *
 * 这些断言只读 `operation.getState()`（控制器内部会换掉 state 对象），
 * 每个外部依赖都能单独控制何时返回，因此能验证「迟到的结果绝不会写进当前状态」。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OcrClientError } from '../src/domain/photoOcrClient.ts'
import {
  createInitialNoticePhotoState,
  createNoticePhotoOperation,
  hasUnsavedNoticePhotoDraft,
  noticePhotoAdoption,
} from '../src/screens/noticePhotoController.ts'

const TEST_TIMEOUT_MS = 5_000

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function withTimeout(promise, label, ms = TEST_TIMEOUT_MS) {
  let timer
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${label}`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

async function waitFor(predicate, label, tries = 2000) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`等待失败：${label}`)
}

function noticeResponse(rawText, overrides = {}) {
  return {
    rawText,
    requestId: 'req-1',
    image: { width: 900, height: 1200, format: 'png', bytes: 12345 },
    warnings: [],
    ms: 42,
    ocrCalls: 1,
    diagnosticsMode: false,
    empty: rawText.length === 0,
    ...overrides,
  }
}

function prepared(overrides = {}) {
  return {
    base64: 'AAAA',
    mimeType: 'image/png',
    width: 900,
    height: 1200,
    byteLength: 3,
    ...overrides,
  }
}

/**
 * 造一个可精确控制每一步的操作。
 *
 * 选择 / 归档 / 识别都按调用顺序排队：第 N 次调用拿第 N 个 deferred，
 * 这样就能在 A 还挂着时精确触发取消或新一轮。
 */
function makeOperation(overrides = {}) {
  const calls = { pick: 0, camera: 0, archive: 0, prepare: 0, recognize: 0 }
  const pickQueue = []
  const archiveQueue = []
  const recognizeQueue = []
  const records = []
  const errors = []
  const toasts = []
  const archiveInputs = []
  const recognizeInputs = []

  const deps = {
    state: createInitialNoticePhotoState(),
    minVisibleMs: 0,
    pickFromLibrary: async () => {
      calls.pick += 1
      const next = pickQueue.shift()
      if (next) return next.promise
      return { status: 'picked', uri: `file:///notice-${calls.pick}.png`, source: { width: 900, height: 1200, mimeType: 'image/png' } }
    },
    captureFromCamera: async () => {
      calls.camera += 1
      return { status: 'picked', uri: 'file:///camera.png', source: { width: 800, height: 1000, mimeType: 'image/jpeg' } }
    },
    preparePhoto: async (uri) => {
      calls.prepare += 1
      return prepared({ uri })
    },
    archiveOriginal: async (uri, source, attemptSource) => {
      calls.archive += 1
      archiveInputs.push({ uri, source, attemptSource })
      const next = archiveQueue.shift()
      if (next) return next.promise
      return { ok: true, attemptId: 7, message: null }
    },
    recognize: async (endpoint, options) => {
      calls.recognize += 1
      recognizeInputs.push({ endpoint, options })
      const next = recognizeQueue.shift()
      if (next) return next.promise
      return noticeResponse('数据结构作业：请于2026年10月20日 22:00前提交。')
    },
    recordResult: async (input) => {
      records.push(input)
    },
    getEndpoint: () => 'http://192.168.31.73:8082',
    getInferredEndpoint: () => 'http://192.168.31.73:8082',
    emit: (event) => {
      if (event.type === 'toast') toasts.push(event.toast)
      else errors.push(event.error)
    },
    ...overrides,
  }

  const operation = createNoticePhotoOperation(deps)
  return { operation, deps, calls, records, errors, toasts, archiveInputs, recognizeInputs, pickQueue, archiveQueue, recognizeQueue }
}

test('正常路径：选图只归档、不自动 OCR；识别后文字可改，采用时原样返回完整文字', async () => {
  const harness = makeOperation()
  const { operation, calls } = harness

  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')
  assert.equal(calls.pick, 1)
  assert.equal(calls.archive, 1)
  assert.equal(calls.recognize, 0, '选完图不能自动识别')
  assert.equal(operation.getState().archivedAttemptId, 7)
  assert.equal(operation.getState().photoUri, 'file:///notice-1.png')

  const result = operation.requestRecognize()
  assert.equal(result, 'started')
  await waitFor(() => operation.getState().phase === 'done', '识别完成')
  assert.equal(operation.getState().text, '数据结构作业：请于2026年10月20日 22:00前提交。')
  assert.equal(operation.getState().requestId, 'req-1')

  // 用户手动改字：采用时必须原样带过去，不 trim、不截断。
  const edited = '\n  数据结构作业：改过的标题\n第二行  \n'
  operation.setText(edited)
  const adopted = operation.adoptText()
  assert.equal(adopted.ok, true)
  assert.equal(adopted.text, edited)

  // 采用后、回到本页之前，连点第二次会被同步守卫挡住。
  const second = operation.adoptText()
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-open')
  operation.focus()
  assert.equal(operation.adoptText().ok, true, '回到本页后可以再次采用')
})

test('取消识别：迟到的响应被丢弃，不覆盖当前文字，并如实登记 CANCELLED', async () => {
  const harness = makeOperation()
  const { operation, recognizeQueue, records } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')

  const gate = deferred()
  recognizeQueue.push({ promise: gate.promise })
  operation.requestRecognize()
  await waitFor(() => operation.getState().phase === 'recognizing', '进入识别')

  assert.equal(operation.cancel(), true)
  assert.equal(operation.getState().busy, false)
  assert.equal(operation.getState().statusText, '已取消这次识别。')

  gate.resolve(noticeResponse('迟到的文字'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(operation.getState().text, '', '取消之后迟到的结果不能写进当前状态')
  assert.ok(
    records.some((record) => record.status === 'CANCELLED'),
    '取消要留下真实的取消历史',
  )
})

test('取消后换图：旧请求的迟到结果不会串到新图上', async () => {
  const harness = makeOperation()
  const { operation, recognizeQueue } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '第一张归档')

  const first = deferred()
  recognizeQueue.push({ promise: first.promise })
  operation.requestRecognize()
  await waitFor(() => operation.getState().phase === 'recognizing', '第一次识别')

  operation.cancel()
  operation.requestPick('library', { confirmReplace: true })
  await waitFor(() => operation.getState().photoUri === 'file:///notice-2.png', '第二张选中')
  await waitFor(() => operation.getState().archivedOriginal, '第二张归档')

  first.resolve(noticeResponse('第一张的迟到文字'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(operation.getState().photoUri, 'file:///notice-2.png')
  assert.equal(operation.getState().text, '', '旧图的结果不能写进新图')
})

test('连点：选择器与识别在忙的时候都只发起一次', async () => {
  const harness = makeOperation()
  const { operation, pickQueue, recognizeQueue, calls } = harness

  const pickGate = deferred()
  pickQueue.push({ promise: pickGate.promise })
  assert.equal(operation.requestPick('library'), 'started')
  assert.equal(operation.requestPick('library'), 'busy')
  assert.equal(calls.pick, 1, '第二次点击不能再打开一次选择器')
  pickGate.resolve({ status: 'cancelled' })
  await waitFor(() => operation.getState().busy === false, '选择器取消后释放')

  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal && !operation.getState().busy, '归档完成且空闲')

  const recognizeGate = deferred()
  recognizeQueue.push({ promise: recognizeGate.promise })
  assert.equal(operation.requestRecognize(), 'started')
  await waitFor(() => calls.recognize === 1, '识别请求已发出')
  assert.equal(operation.requestRecognize(), 'busy')
  assert.equal(calls.recognize, 1, '第二次点击不能重复请求')
  recognizeGate.resolve(noticeResponse('一次就够'))
  await waitFor(() => !operation.getState().busy, '识别结束')
})

test('选择器取消是 no-op：保留已选图片、文字与归档状态，也不新增归档', async () => {
  const harness = makeOperation()
  const { operation, pickQueue, calls } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')
  operation.setText('已经改好的文字')
  const archiveBefore = calls.archive

  const gate = deferred()
  pickQueue.push({ promise: gate.promise })
  operation.requestPick('library', { confirmReplace: true })
  await waitFor(() => operation.getState().phase === 'picking', '选择器打开')
  gate.resolve({ status: 'cancelled' })
  await waitFor(() => operation.getState().phase === 'done', '取消后回到可操作状态')

  assert.equal(operation.getState().photoUri, 'file:///notice-1.png')
  assert.equal(operation.getState().text, '已经改好的文字')
  assert.equal(operation.getState().archivedOriginal, true)
  assert.equal(calls.archive, archiveBefore, '取消选择不能重新归档')
  assert.equal(operation.getState().error, null)
})

test('权限被拒：中文可操作提示，不改动已有图片/文字', async () => {
  const harness = makeOperation()
  const { operation, pickQueue } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')
  operation.setText('保留我')

  pickQueue.push({
    promise: Promise.resolve({
      status: 'permission',
      canAskAgain: false,
      message: '还没有允许访问相册。',
    }),
  })
  operation.requestPick('library', { confirmReplace: true })
  await waitFor(() => operation.getState().error !== null, '权限提示出现')
  const error = operation.getState().error
  assert.equal(error.code, 'PERMISSION')
  assert.match(error.message, /设置/)
  assert.match(error.message, /权限/)
  assert.equal(operation.getState().text, '保留我')
  assert.equal(operation.getState().photoUri, 'file:///notice-1.png')
})

test('网络失败：保留图片与已改文字，可重试，并如实登记 FAILED', async () => {
  const harness = makeOperation()
  const { operation, recognizeQueue, records } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')

  recognizeQueue.push({ promise: Promise.reject(new OcrClientError('NETWORK', '连不上电脑。', { retryable: true })) })
  operation.requestRecognize()
  await waitFor(() => operation.getState().error !== null, '网络错误出现')
  assert.equal(operation.getState().error.code, 'NETWORK')
  assert.equal(operation.getState().photoUri, 'file:///notice-1.png')
  assert.equal(operation.getState().archivedOriginal, true)
  assert.ok(records.some((record) => record.status === 'FAILED' && record.errorCode === 'NETWORK'))

  // 用户先手改文字，再重试（明确确认替换）；新的失败仍然不能清掉它。
  operation.setText('我手改的文字')
  recognizeQueue.push({ promise: Promise.reject(new OcrClientError('TIMEOUT', '超时了。', { retryable: true })) })
  assert.equal(operation.requestRecognize({ confirmReplace: true }), 'started')
  await waitFor(() => operation.getState().error?.code === 'TIMEOUT', '第二次失败')
  assert.equal(operation.getState().text, '我手改的文字')
})

test('归档失败：不谎称已保存，可重试；成功后同一张图不再重复归档', async () => {
  const harness = makeOperation()
  const { operation, archiveQueue, calls } = harness
  archiveQueue.push({
    promise: Promise.resolve({ ok: false, attemptId: 11, message: '磁盘写满了。' }),
  })
  operation.requestPick('library')
  await waitFor(() => operation.getState().archiveError !== null, '归档失败显示')
  assert.equal(operation.getState().archivedOriginal, false)
  assert.equal(operation.getState().archiveError, '磁盘写满了。')
  assert.equal(calls.archive, 1)

  const retry = await operation.retryArchive()
  assert.equal(retry, 'started')
  assert.equal(operation.getState().archivedOriginal, true)
  assert.equal(operation.getState().archivedAttemptId, 7)
  assert.equal(calls.archive, 2)

  // 识别重试时已经归档成功：不再重复归档同一张图。
  operation.requestRecognize()
  await waitFor(() => operation.getState().phase === 'done', '识别完成')
  assert.equal(calls.archive, 2, '归档成功后重试 OCR 不能再写一份原图')
})

test('超长文字：禁止采用并给出中文缩短/拆分说明，绝不静默截断', () => {
  const harness = makeOperation()
  const { operation } = harness
  operation.setText('原'.repeat(10_001))
  const rejected = operation.adoptText()
  assert.equal(rejected.ok, false)
  assert.equal(rejected.reason, 'too-long')
  assert.match(rejected.message, /手动删减|分成两次/)
  assert.equal(operation.getState().text.length, 10_001, '文字不能被截断')

  operation.setText('原'.repeat(10_000))
  const accepted = operation.adoptText()
  assert.equal(accepted.ok, true)
  assert.equal(accepted.text.length, 10_000)

  const pure = noticePhotoAdoption({ text: '原'.repeat(10_001) })
  assert.equal(pure.allowed, false)
  assert.equal(pure.reason, 'too-long')
})

test('未保存判定与端点缺失', () => {
  assert.equal(hasUnsavedNoticePhotoDraft({ text: '' }), false)
  assert.equal(hasUnsavedNoticePhotoDraft({ text: '   ' }), false)
  assert.equal(hasUnsavedNoticePhotoDraft({ text: '有字' }), true)

  const harness = makeOperation({ getEndpoint: () => null, getInferredEndpoint: () => null })
  const { operation } = harness
  operation.requestPick('library')
  return withTimeout(
    (async () => {
      await waitFor(() => operation.getState().archivedOriginal, '归档完成')
      assert.equal(operation.requestRecognize(), 'needs-endpoint')
      assert.equal(operation.getState().error.code, 'NO_ENDPOINT')
      assert.equal(operation.getState().text, '')
    })(),
    '端点缺失检查',
  )
})

test('识别期间用户又改字：OCR 成功不能覆盖用户当前草稿，原始结果单独记录', async () => {
  const harness = makeOperation()
  const { operation, recognizeQueue } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')

  const gate = deferred()
  recognizeQueue.push({ promise: gate.promise })
  operation.requestRecognize()
  await waitFor(() => operation.getState().phase === 'recognizing', '进入识别')
  assert.equal(operation.busy, true)

  // 硬件键盘 / 无障碍输入可能在识别期间改字；运行时必须保留它。
  operation.setText('识别期间我改的草稿')
  gate.resolve(noticeResponse('电脑识别出来的原文'))
  await waitFor(() => !operation.getState().busy, '识别结束')

  assert.equal(operation.getState().text, '识别期间我改的草稿')
  assert.equal(operation.getState().recognizedText, '电脑识别出来的原文')
  assert.equal(operation.getState().empty, false)
})

test('卸载后：正在进行的识别不能改状态、也不能写任务（只可能记取消历史）', async () => {
  const harness = makeOperation()
  const { operation, recognizeQueue, records } = harness
  operation.requestPick('library')
  await waitFor(() => operation.getState().archivedOriginal, '归档完成')

  const gate = deferred()
  recognizeQueue.push({ promise: gate.promise })
  operation.requestRecognize()
  await waitFor(() => operation.getState().phase === 'recognizing', '进入识别')

  operation.dispose()
  const before = operation.getState()
  gate.resolve(noticeResponse('卸载后的迟到文字'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(operation.getState().text, before.text)
  assert.equal(operation.getState().phase, before.phase)
  assert.ok(records.some((record) => record.status === 'CANCELLED'))
})
