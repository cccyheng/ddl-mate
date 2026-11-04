/**
 * 批量识别通知截图的**运行状态机**测试（不依赖 React / Expo / 真实网络）。
 *
 * 覆盖授权书点名的运行边界：
 * - 3 张顺序归档 + 顺序识别，同时最多 1 个在途请求；
 * - 中间一张失败不丢弃其它张，真实进度是张数不是百分比；
 * - 取消后不再推进，已完成结果与手改文字保留；迟到的旧结果不能改新状态；
 * - 双击选图 / 整轮识别 / 采用只发一次；旧 finally 不能放掉新一轮的 busy；
 * - 归档失败如实显示、可重试；归档失败 ≠ 识别失败；
 * - 成功归档的图在重试识别时不再重复归档；
 * - 选图取消 / 权限拒绝保留上一批；一次超过 8 张不静默丢弃；
 * - 手改文字逐字采用；空 / 超 10000 字不能采用，绝不截断；
 * - 替换一批需要显式确认；dispose → activate 不重放、不复活旧结果；
 * - 识别成功后历史写入失败只单独提示，不改写 OCR 结论、不清空文字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BATCH_NOTICE_MAX_IMAGES,
  batchNoticeProgress,
  batchNoticeTextAdoption,
  createBatchNoticeOperation,
} from '../src/screens/batchNoticeController.ts'
import { OcrClientError } from '../src/domain/photoOcrClient.ts'

const ENDPOINT = 'http://127.0.0.1:8082'

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, message = '等待状态超时', rounds = 400) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await delay(0)
  }
  throw new Error(message)
}

function asset(index) {
  return {
    uri: `file:///screenshots/shot-${index}.png`,
    source: { width: 1170, height: 2532, mimeType: 'image/png' },
  }
}

function assets(count) {
  return Array.from({ length: count }, (_value, index) => asset(index + 1))
}

function ocrResponse(rawText, overrides = {}) {
  return {
    rawText,
    requestId: 'req-1',
    image: { width: 900, height: 1600, format: 'png', bytes: 2048 },
    warnings: [],
    ms: 42,
    ocrCalls: 1,
    diagnosticsMode: false,
    empty: rawText.length === 0,
    ...overrides,
  }
}

function makeHarness() {
  const calls = { pick: 0, archive: [], prepare: [], recognize: [], record: [] }
  let archiveActive = 0
  let archiveMax = 0
  let recognizeActive = 0
  let recognizeMax = 0

  let nextPick = async () => ({ status: 'picked', assets: assets(2) })
  let archiveImpl = async (uri) => ({
    ok: true,
    attemptId: calls.archive.length,
    message: null,
    archivedUri: `file:///archive/${uri.split('/').pop()}`,
  })
  let resolveArchivedPathImpl = async () => null
  let recognizeImpl = async () => ocrResponse('识别文字')
  let recordImpl = async () => undefined

  const controller = createBatchNoticeOperation({
    pickFromLibrary: async () => {
      calls.pick += 1
      return nextPick()
    },
    preparePhoto: async (uri) => {
      calls.prepare.push(uri)
      return { base64: `base64:${uri}`, mimeType: 'image/png' }
    },
    archiveOriginal: async (uri, source, attemptSource) => {
      calls.archive.push({ uri, source, attemptSource })
      archiveActive += 1
      archiveMax = Math.max(archiveMax, archiveActive)
      try {
        return await archiveImpl(uri, source, attemptSource)
      } finally {
        archiveActive -= 1
      }
    },
    recognize: async (endpoint, options) => {
      const index = calls.recognize.length
      calls.recognize.push({ endpoint, signal: options.abortSignal })
      recognizeActive += 1
      recognizeMax = Math.max(recognizeMax, recognizeActive)
      try {
        return await recognizeImpl(endpoint, options, index)
      } finally {
        recognizeActive -= 1
      }
    },
    recordResult: async (input) => {
      calls.record.push(input)
      return recordImpl(input, calls.record.length - 1)
    },
    resolveArchivedPath: async (attemptId) => resolveArchivedPathImpl(attemptId),
    getEndpoint: () => ENDPOINT,
    getInferredEndpoint: () => null,
  })

  return {
    controller,
    calls,
    getState: () => controller.getState(),
    setNextPick: (value) => {
      nextPick = value
    },
    setArchiveImpl: (value) => {
      archiveImpl = value
    },
    setResolveArchivedPath: (value) => {
      resolveArchivedPathImpl = value
    },
    setRecognizeImpl: (value) => {
      recognizeImpl = value
    },
    setRecordImpl: (value) => {
      recordImpl = value
    },
    getArchiveMax: () => archiveMax,
    getRecognizeMax: () => recognizeMax,
  }
}

async function pickAndArchive(harness, count) {
  harness.setNextPick(async () => ({ status: 'picked', assets: assets(count) }))
  assert.equal(harness.controller.requestPick(), 'started')
  await waitFor(
    () => !harness.getState().busy && harness.getState().items.length === count,
    '等待选图与归档结束',
  )
}

async function runToIdle(harness) {
  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(() => !harness.getState().busy, '等待整轮识别结束')
}

/* --------------------------------- 顺序执行 -------------------------------- */

test('3 张图顺序归档、顺序识别，同时最多 1 个本机请求，选图后不自动识别', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 3)

  assert.equal(harness.calls.archive.length, 3)
  assert.equal(harness.getArchiveMax(), 1, '归档必须顺序进行')
  assert.equal(harness.calls.recognize.length, 0, '选图后绝不自动 OCR')
  assert.match(harness.getState().statusText, /还没有识别/)

  harness.setRecognizeImpl(async (_endpoint, options) => {
    await delay(0)
    return ocrResponse(`通知正文 ${options.imageBase64}`)
  })
  await runToIdle(harness)

  assert.equal(harness.calls.recognize.length, 3)
  assert.equal(harness.getRecognizeMax(), 1, '一次只能有一个本机 OCR 请求')
  assert.deepEqual(
    harness.getState().items.map((item) => item.status),
    ['success', 'success', 'success'],
  )
  assert.deepEqual(
    harness.getState().items.map((item) => item.index),
    [1, 2, 3],
  )
  assert.ok(harness.getState().items.every((item) => item.text.length > 0))
  assert.match(harness.getState().statusText, /已完成 3 张/)
  assert.equal(batchNoticeProgress(harness.getState().items).remaining, 0)
})

test('中间一张失败不丢弃其它张：后续继续，真实进度是第 2/3 张，最后可重试', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 3)

  const second = deferred()
  harness.setRecognizeImpl(async (_endpoint, _options, index) => {
    if (index === 0) return ocrResponse('第一张的通知文字')
    if (index === 1) return second.promise
    return ocrResponse('第三张的通知文字')
  })
  assert.equal(harness.controller.startRun(), 'started')

  await waitFor(
    () => harness.calls.recognize.length === 2 && harness.getState().items[1]?.status === 'running',
    '等待第二张开始识别',
  )
  assert.match(harness.getState().statusText, /第 2\/3 张/)
  assert.equal(harness.getState().run?.done, 1, '第一张完成后进度应是 1/3')

  second.reject(new OcrClientError('NETWORK', '电脑连接断了', { retryable: true }))
  await waitFor(() => !harness.getState().busy, '等待整轮结束')

  const items = harness.getState().items
  assert.deepEqual(items.map((item) => item.status), ['success', 'failed', 'success'])
  assert.equal(items[1].error?.code, 'NETWORK')
  assert.match(items[1].error?.message ?? '', /电脑连接断了/)
  assert.equal(items[0].text, '第一张的通知文字', '失败一张不能清空已完成结果')
  assert.equal(items[2].text, '第三张的通知文字')
  assert.match(harness.getState().statusText, /已完成 2 张，待处理 1 张/)
  assert.equal(harness.calls.recognize.length, 3, '失败之后仍然继续下一张')
  assert.deepEqual(
    harness.calls.record.map((entry) => entry.status),
    ['SUCCESS', 'FAILED', 'SUCCESS'],
  )
})

/* --------------------------------- 取消 / 迟到 -------------------------------- */

test('取消当前请求后停止推进：已完成结果保留，迟到结果不改状态，不再发第三个请求', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 3)

  const second = deferred()
  harness.setRecognizeImpl(async (_endpoint, _options, index) => {
    if (index === 0) return ocrResponse('第一张文字')
    if (index === 1) return second.promise
    return ocrResponse('第三张不该被调用')
  })
  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(
    () => harness.calls.recognize.length === 2 && harness.getState().items[1]?.status === 'running',
    '等待第二张进入识别',
  )

  assert.equal(harness.controller.cancel(), true)
  assert.equal(harness.calls.recognize[1].signal.aborted, true, '取消必须 abort 当前请求')
  assert.equal(harness.getState().busy, false)

  const afterCancel = harness.getState()
  assert.equal(afterCancel.items[0].status, 'success')
  assert.equal(afterCancel.items[0].text, '第一张文字')
  assert.equal(afterCancel.items[1].status, 'cancelled')
  assert.equal(afterCancel.items[2].status, 'pending')
  assert.match(afterCancel.statusText, /已取消/)
  await waitFor(() => harness.calls.record.some((entry) => entry.status === 'CANCELLED'))

  // 客户端已经 abort，但注入的实现仍可能迟到返回；它不能改当前状态，也不能再发第三个请求。
  second.resolve(ocrResponse('迟到的第二张文字'))
  await delay(20)
  const afterLate = harness.getState()
  assert.equal(afterLate.items[1].status, 'cancelled')
  assert.equal(afterLate.items[1].text, '', '取消后迟到的文字不能写回')
  assert.equal(harness.calls.recognize.length, 2, '取消后不能再推进到第三张')
})

test('识别成功、历史还在写时停止：只停止推进，不给成功项补 CANCELLED', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)
  const saved = deferred()
  harness.setRecognizeImpl(async () => ocrResponse('第一张已经成功的文字'))
  harness.setRecordImpl(async (input) => {
    if (input.status === 'SUCCESS') await saved.promise
  })

  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(() => harness.calls.record.length === 1, '等待第一张的成功历史开始写入')
  assert.equal(harness.getState().items[0].status, 'success')

  assert.equal(harness.controller.cancel(), true)
  assert.equal(harness.getState().items[0].status, 'success', '成功项不能因为停止被改成取消')
  assert.equal(harness.getState().items[1].status, 'pending')
  assert.equal(harness.calls.recognize.length, 1, '停止后不能再识别第二张')

  saved.resolve()
  await waitFor(() => !harness.getState().busy)
  assert.deepEqual(
    harness.calls.record.map((entry) => entry.status),
    ['SUCCESS'],
    '识别已经成功时，停止绝不能补一条假的 CANCELLED 历史',
  )
  assert.equal(harness.getState().items[0].text, '第一张已经成功的文字')
})

test('取消后立刻开始新一轮：旧一轮的 finally 不能放掉新一轮的 busy', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)

  const oldAttempt = deferred()
  const newAttempt = deferred()
  harness.setRecognizeImpl(async (_endpoint, _options, index) => {
    if (index === 0) return oldAttempt.promise
    if (index === 1) return newAttempt.promise
    return ocrResponse('不该出现的第三张')
  })

  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(() => harness.calls.recognize.length === 1, '等待第一轮开始')
  assert.equal(harness.controller.cancel(), true)
  assert.equal(harness.getState().items[0].status, 'cancelled')

  // 第一张现在是 cancelled，仍在待识别范围内；第二轮可以马上开始。
  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(
    () => harness.calls.recognize.length === 2 && harness.getState().busy,
    '等待第二轮开始',
  )

  oldAttempt.resolve(ocrResponse('旧一轮的迟到结果'))
  await delay(20)
  assert.equal(harness.getState().busy, true, '旧一轮收尾不能清掉新一轮的 busy')
  assert.equal(harness.getState().phase, 'running')
  assert.equal(harness.calls.recognize.length, 2)

  assert.equal(harness.controller.cancel(), true)
  newAttempt.resolve(ocrResponse('第二轮迟到结果'))
  await delay(10)
})

test('dispose 中止当前并作废旧回调；activate 不重放选图 / 归档 / 识别', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  const pending = deferred()
  harness.setRecognizeImpl(async () => pending.promise)

  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(() => harness.calls.recognize.length === 1, '等待识别开始')
  const pickCalls = harness.calls.pick
  const archiveCalls = harness.calls.archive.length

  harness.controller.dispose()
  assert.equal(harness.controller.attached, false)
  assert.equal(harness.getState().busy, false)
  assert.equal(harness.getState().items[0].status, 'cancelled')

  harness.controller.activate()
  assert.equal(harness.controller.attached, true)
  assert.equal(harness.getState().busy, false)
  assert.equal(harness.calls.pick, pickCalls, 'activate 不能重放选图')
  assert.equal(harness.calls.archive.length, archiveCalls, 'activate 不能重放归档')
  assert.equal(harness.calls.recognize.length, 1, 'activate 不能重放识别')

  pending.resolve(ocrResponse('卸载之后才回来的文字'))
  await delay(20)
  assert.equal(harness.getState().items[0].status, 'cancelled')
  assert.equal(harness.getState().items[0].text, '')

  // 重新挂上之后仍然可以显式识别，但必须由用户动作触发。
  harness.setRecognizeImpl(async () => ocrResponse('重新打开后显式识别的文字'))
  await runToIdle(harness)
  assert.equal(harness.calls.recognize.length, 2)
  assert.equal(harness.getState().items[0].status, 'success')
  assert.equal(harness.calls.archive.length, archiveCalls, '成功归档的图重试时不再归档')
})

/* --------------------------------- 双击闸门 -------------------------------- */

test('取消后换成新一批：旧 OCR 的迟到结果不能覆盖新队列', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)
  const oldAttempt = deferred()
  harness.setRecognizeImpl(async () => oldAttempt.promise)

  assert.equal(harness.controller.startRun(), 'started')
  await waitFor(() => harness.calls.recognize.length === 1, '等待第一张开始识别')
  assert.equal(harness.controller.cancel(), true)

  harness.setNextPick(async () => ({ status: 'picked', assets: [asset(9)] }))
  assert.equal(harness.controller.requestPick({ confirmReplace: true }), 'started')
  await waitFor(
    () => !harness.getState().busy && harness.getState().items.length === 1,
    '等待新一批归档结束',
  )
  const newUri = harness.getState().items[0].uri
  assert.match(newUri, /shot-9\.png/)

  oldAttempt.resolve(ocrResponse('旧一批的迟到文字'))
  await delay(20)
  assert.equal(harness.getState().items.length, 1)
  assert.equal(harness.getState().items[0].uri, newUri, '旧结果不能改动新一批的图片')
  assert.equal(harness.getState().items[0].status, 'pending', '新一批仍在等待显式识别')
  assert.equal(harness.getState().items[0].text, '')
  assert.equal(harness.calls.recognize.length, 1, '旧结果不能触发新一批的 OCR')
})

test('归档中途 dispose / activate：同一批的在途归档按真实结果对账，不重放也不重复保存', async () => {
  const harness = makeHarness()
  const archiving = deferred()
  harness.setNextPick(async () => ({ status: 'picked', assets: assets(2) }))
  harness.setArchiveImpl(async () => archiving.promise)

  assert.equal(harness.controller.requestPick(), 'started')
  await waitFor(() => harness.calls.archive.length === 1, '等待第一张开始归档')
  assert.equal(harness.getState().items[0].archiveStatus, 'archiving')

  harness.controller.dispose()
  assert.equal(harness.getState().items[0].archiveStatus, 'archiving', '卸载时不能丢在途归档 job')

  harness.controller.activate()
  assert.equal(harness.getState().busy, true, '在途归档未结束前保持 busy')
  assert.match(harness.getState().statusText, /正在确认原图保存结果/)
  assert.equal(harness.getState().items[0].archiveStatus, 'archiving')

  archiving.resolve({ ok: true, attemptId: 5, message: null, archivedUri: 'file:///archive/shot-1.png' })
  await waitFor(() => !harness.getState().busy, '等待归档对账收尾')
  const item = harness.getState().items[0]
  assert.equal(item.archiveStatus, 'archived', '真实成功的归档结果必须对账回来')
  assert.equal(item.archivedAttemptId, 5)
  assert.equal(item.archivedUri, 'file:///archive/shot-1.png')
  assert.equal(harness.calls.archive.length, 1, 'dispose 后不能继续归档第二张，也不能重复归档第一张')

  // 重新挂上后显式识别：第二张这时才归档，但第一张绝不重复保存。
  harness.setRecognizeImpl(async () => ocrResponse('重新挂上后的文字'))
  await runToIdle(harness)
  assert.equal(harness.calls.archive.length, 2, '第一张 + 显式识别前补齐的第二张')
  assert.equal(
    harness.calls.archive.filter((entry) => entry.uri.endsWith('shot-1.png')).length,
    1,
    '已成功归档的第一张不能再保存一次',
  )
  assert.equal(harness.getState().items[0].status, 'success')
})

test('同步 busy 闸门：选图、整轮识别、采用连点两次都只生效一次', async () => {
  const harness = makeHarness()
  const picking = deferred()
  let pickCount = 0
  harness.setNextPick(async () => {
    pickCount += 1
    return picking.promise
  })

  assert.equal(harness.controller.requestPick(), 'started')
  assert.equal(harness.controller.requestPick(), 'busy')
  await delay(0)
  assert.equal(pickCount, 1, '同一帧连点只打开一次相册')

  picking.resolve({ status: 'picked', assets: assets(1) })
  await waitFor(() => !harness.getState().busy && harness.getState().items.length === 1)

  const runGate = deferred()
  harness.setRecognizeImpl(async () => runGate.promise)
  assert.equal(harness.controller.startRun(), 'started')
  assert.equal(harness.controller.startRun(), 'busy')
  await waitFor(() => harness.calls.recognize.length === 1)
  assert.equal(harness.calls.recognize.length, 1, '同一帧连点只发一个识别请求')

  runGate.resolve(ocrResponse('可以采用的文字'))
  await waitFor(() => !harness.getState().busy && harness.getState().items[0]?.status === 'success')

  const first = harness.controller.adoptText('batch-1')
  const second = harness.controller.adoptText('batch-1')
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'already-open', '采用一次之后不能原地重复打开第二个核对页')
  harness.controller.focus()
  assert.equal(harness.controller.adoptText('batch-1').ok, true, '从子页面返回后可以再次采用')
})

test('归档失败后双击「重试保存原图」只发一次归档请求', async () => {
  const harness = makeHarness()
  harness.setArchiveImpl(async () => ({ ok: false, attemptId: null, message: '磁盘写入失败' }))
  await pickAndArchive(harness, 1)
  assert.equal(harness.getState().items[0].archiveStatus, 'failed')

  const retry = deferred()
  harness.setArchiveImpl(async () => retry.promise)
  const first = harness.controller.retryArchive('batch-1')
  const second = harness.controller.retryArchive('batch-1')
  assert.equal(await second, 'busy')
  assert.equal(harness.calls.archive.length, 2, '一次失败 + 一次重试')
  retry.resolve({ ok: true, attemptId: 99, message: null, archivedUri: 'file:///archive/shot-1.png' })
  assert.equal(await first, 'started')
  await waitFor(() => !harness.getState().busy)
  assert.equal(harness.getState().items[0].archiveStatus, 'archived')
  assert.equal(harness.getState().items[0].archivedAttemptId, 99)
})

/* --------------------------------- 归档 / 重试 -------------------------------- */

test('归档失败如实显示、可显式重试；重试不触发 OCR，也不谎称已保存', async () => {
  const harness = makeHarness()
  let archiveCalls = 0
  harness.setArchiveImpl(async () => {
    archiveCalls += 1
    if (archiveCalls === 1) return { ok: false, attemptId: 7, message: '相册文件读不出来' }
    return { ok: true, attemptId: 8, message: null, archivedUri: 'file:///archive/shot-1.png' }
  })
  await pickAndArchive(harness, 1)

  let item = harness.getState().items[0]
  assert.equal(item.archiveStatus, 'failed')
  assert.equal(item.archiveError, '相册文件读不出来')
  assert.equal(item.archivedAttemptId, 7, '失败的尝试 id 也如实保留')
  assert.equal(item.archivedUri, null)
  assert.equal(harness.getState().notice?.tone, 'error')
  assert.equal(harness.calls.recognize.length, 0, '归档失败不能自动识别')

  harness.setNextPick(async () => ({ status: 'picked', assets: assets(1) }))
  assert.equal(await harness.controller.retryArchive('batch-1'), 'started')
  await waitFor(() => !harness.getState().busy)
  item = harness.getState().items[0]
  assert.equal(item.archiveStatus, 'archived')
  assert.equal(item.archivedAttemptId, 8)
  assert.equal(item.archivedUri, 'file:///archive/shot-1.png')
  assert.equal(harness.calls.recognize.length, 0, '只重试保存原图时绝不顺带 OCR')
})

test('归档只返回 attemptId 时，用只读仓库解析真实 archivedPath；解析不到就如实留空', async () => {
  const harness = makeHarness()
  harness.setNextPick(async () => ({ status: 'picked', assets: assets(2) }))
  harness.setArchiveImpl(async (uri) => ({
    ok: true,
    attemptId: uri.endsWith('shot-1.png') ? 41 : 42,
    message: null,
    // 故意不返回 archivedUri：模拟只登记了 attemptId 的归档端口。
  }))
  harness.setResolveArchivedPath(async (attemptId) =>
    attemptId === 41 ? { archivedPath: 'file:///real/archived-shot-1.png' } : null,
  )

  assert.equal(harness.controller.requestPick(), 'started')
  await waitFor(() => !harness.getState().busy && harness.getState().items.length === 2)
  assert.equal(harness.getState().items[0].archiveStatus, 'archived')
  assert.equal(harness.getState().items[0].archivedUri, 'file:///real/archived-shot-1.png')
  assert.equal(harness.getState().items[1].archiveStatus, 'archived')
  assert.equal(
    harness.getState().items[1].archivedUri,
    null,
    '读不到真实路径时要留空，不能拿相册临时 URI 冒充已保存原图',
  )
})

test('成功归档的图在识别失败后重试：不再重复归档，直接重新识别', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  assert.equal(harness.calls.archive.length, 1)

  harness.setRecognizeImpl(async () => {
    throw new OcrClientError('TIMEOUT', '电脑太久没有响应', { retryable: true })
  })
  await runToIdle(harness)
  assert.equal(harness.getState().items[0].status, 'failed')
  assert.equal(harness.calls.archive.length, 1)

  harness.setRecognizeImpl(async () => ocrResponse('重试成功后的通知文字'))
  assert.equal(harness.controller.retryItem('batch-1'), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.equal(harness.getState().items[0].status, 'success')
  assert.equal(harness.getState().items[0].text, '重试成功后的通知文字')
  assert.equal(harness.calls.archive.length, 1, '成功归档的同一张图不能重复归档')
  assert.equal(harness.calls.recognize.length, 2)
})

test('归档失败 ≠ 识别失败：原图没保存住，文字识别成功仍如实分开显示', async () => {
  const harness = makeHarness()
  harness.setArchiveImpl(async () => ({ ok: false, attemptId: null, message: '磁盘已满' }))
  await pickAndArchive(harness, 1)
  assert.equal(harness.getState().items[0].archiveStatus, 'failed')

  harness.setRecognizeImpl(async () => ocrResponse('原图没存住，但文字仍在'))
  await runToIdle(harness)

  const item = harness.getState().items[0]
  assert.equal(item.status, 'success', 'OCR 成功不能被归档失败改写')
  assert.equal(item.error, null, '归档失败不能塞进 OCR error')
  assert.equal(item.archiveStatus, 'failed')
  assert.match(item.archiveError ?? '', /磁盘已满/)
  assert.equal(item.text, '原图没存住，但文字仍在')
  assert.equal(harness.calls.recognize.length, 1)
  // 选图时归档失败一次，识别前再尝试归档一次；两次都不算识别错误。
  assert.equal(harness.calls.archive.length, 2)
})

/* --------------------------------- 选图边界 -------------------------------- */

test('选图取消 / 权限拒绝都保留上一批，不改动识别结果或手改文字', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  harness.controller.setText('batch-1', '用户手动改过的文字')
  const before = harness.getState()

  harness.setNextPick(async () => ({ status: 'cancelled' }))
  assert.equal(harness.controller.requestPick({ confirmReplace: true }), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.deepEqual(
    harness.getState().items.map((item) => ({ id: item.id, uri: item.uri, text: item.text })),
    before.items.map((item) => ({ id: item.id, uri: item.uri, text: item.text })),
    '取消选择器不能改动上一批',
  )
  assert.equal(harness.getState().error, null)

  harness.setNextPick(async () => ({ status: 'permission', message: '没有相册权限', canAskAgain: true }))
  assert.equal(harness.controller.requestPick({ confirmReplace: true }), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.equal(harness.getState().error?.code, 'PERMISSION')
  assert.deepEqual(
    harness.getState().items.map((item) => ({ id: item.id, uri: item.uri, text: item.text })),
    before.items.map((item) => ({ id: item.id, uri: item.uri, text: item.text })),
    '权限拒绝不能改动上一批',
  )
  assert.equal(harness.calls.pick, 3)
})

test('一次选超过 8 张：整次拒绝并显示说明，绝不静默截断或丢弃', async () => {
  const harness = makeHarness()
  harness.setNextPick(async () => ({ status: 'picked', assets: assets(BATCH_NOTICE_MAX_IMAGES + 1) }))
  const before = harness.calls.archive.length

  assert.equal(harness.controller.requestPick(), 'started')
  await waitFor(() => !harness.getState().busy && harness.getState().error !== null)
  assert.equal(harness.getState().items.length, 0, '超限时一张都不采用')
  assert.equal(harness.calls.archive.length, before, '超限时不能悄悄归档前 8 张')
  const message = harness.getState().error?.message ?? ''
  assert.match(message, /9 张/)
  assert.match(message, /8 张/)
  assert.equal(harness.getState().error?.code, 'TOO_MANY')

  // 上一批存在时同样整次拒绝，旧队列保持原样。
  await pickAndArchive(harness, 1)
  const oldUri = harness.getState().items[0].uri
  harness.setNextPick(async () => ({ status: 'picked', assets: assets(BATCH_NOTICE_MAX_IMAGES + 1) }))
  assert.equal(harness.controller.requestPick({ confirmReplace: true }), 'started')
  await waitFor(() => !harness.getState().busy && harness.getState().error?.code === 'TOO_MANY')
  assert.equal(harness.getState().items.length, 1)
  assert.equal(harness.getState().items[0].uri, oldUri)
})

test('替换一批必须先确认；没有确认时连相册都不会打开', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  const picking = deferred()
  let pickCalls = 0
  harness.setNextPick(async () => {
    pickCalls += 1
    return picking.promise
  })

  assert.equal(harness.controller.requestPick(), 'needs-replace-confirm')
  await delay(0)
  assert.equal(pickCalls, 0, '未确认前不能打开相册')
  assert.equal(harness.calls.pick, 1)
  assert.equal(harness.getState().items.length, 1)

  assert.equal(harness.controller.requestPick({ confirmReplace: true }), 'started')
  await waitFor(() => pickCalls === 1)
  picking.resolve({ status: 'picked', assets: assets(2) })
  await waitFor(() => !harness.getState().busy && harness.getState().items.length === 2)
  assert.deepEqual(
    harness.getState().items.map((item) => item.uri),
    ['file:///screenshots/shot-1.png', 'file:///screenshots/shot-2.png'],
  )
})

/* --------------------------------- 文字 / 采用 -------------------------------- */

test('可编辑文字逐字采用；空 / 超过 10000 字都拒绝，绝不截断', () => {
  const exact = '  2026年10月8日 张老师\n第三次作业请在 2026年10月20日 22:00 前提交。\n\n'
  assert.deepEqual(batchNoticeTextAdoption(exact), { allowed: true, text: exact })

  const empty = batchNoticeTextAdoption('   \n\t ')
  assert.equal(empty.allowed, false)
  assert.equal(empty.reason, 'empty')

  const tooLong = batchNoticeTextAdoption('字'.repeat(10_001))
  assert.equal(tooLong.allowed, false)
  assert.equal(tooLong.reason, 'too-long')
  assert.match(tooLong.message, /10000/)
  assert.match(tooLong.message, /不会替你截断/)

  const exactLimit = batchNoticeTextAdoption('字'.repeat(10_000))
  assert.equal(exactLimit.allowed, true)
  assert.equal(exactLimit.text.length, 10_000)
})

test('控制器采用不存在的 / 空文字 / 超长文字都拒绝；采用后只标记「已打开核对」', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)

  assert.equal(harness.controller.adoptText('batch-1').ok, false)
  assert.equal(harness.controller.adoptText('batch-1').reason, 'empty')
  assert.equal(harness.controller.adoptText('missing').reason, 'not-found')

  const exact = '  原文的空格与换行都要保留\n第二行  '
  assert.equal(harness.controller.setText('batch-1', exact), true)
  const adopted = harness.controller.adoptText('batch-1')
  assert.equal(adopted.ok, true)
  assert.equal(adopted.text, exact, '采用必须逐字，不能 trim / 截断')
  assert.equal(harness.getState().items[0].reviewOpened, true)
  assert.equal(harness.getState().items[0].status, 'pending', '采用文字不等于识别成功')
  assert.equal(harness.getState().openedReviewItemId, 'batch-1')

  harness.controller.focus()
  assert.equal(harness.controller.setText('batch-1', '字'.repeat(10_001)), true)
  const tooLong = harness.controller.adoptText('batch-1')
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.reason, 'too-long')
})

/* --------------------------------- 失败 / 空结果 -------------------------------- */

test('空结果显式显示；手改后可核对；重试前有手改文字必须确认，确认后才替换', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  harness.setRecognizeImpl(async () => ocrResponse(''))
  await runToIdle(harness)

  assert.equal(harness.getState().items[0].status, 'empty')
  assert.equal(harness.getState().items[0].empty, true)
  assert.equal(harness.getState().items[0].text, '')
  assert.match(harness.getState().statusText, /已完成 1 张/)

  // 空结果没有待识别项：显式整轮识别会明确说没有待识别图片。
  assert.equal(harness.controller.startRun(), 'nothing')
  assert.equal(harness.controller.setText('batch-1', '手动补上的通知文字'), true)
  harness.controller.focus()
  const adopted = harness.controller.adoptText('batch-1')
  assert.equal(adopted.ok, true)
  assert.equal(adopted.text, '手动补上的通知文字')

  // 有手改文字时，单张重试必须先确认，不能静默覆盖。
  assert.equal(harness.controller.retryItem('batch-1'), 'needs-replace-confirm')
  assert.equal(harness.calls.recognize.length, 1, '未确认前不能再发请求')

  harness.setRecognizeImpl(async () => ocrResponse('第二次识别出来的文字'))
  assert.equal(harness.controller.retryItem('batch-1', { confirmReplace: true }), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.equal(harness.getState().items[0].status, 'success')
  assert.equal(harness.getState().items[0].text, '第二次识别出来的文字')
  assert.equal(harness.calls.archive.length, 1, '重试复用已归档原图')
})

test('识别成功后历史写入失败：只单独提示，不改写 success / 不清空文字', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 1)
  harness.setRecognizeImpl(async () =>
    ocrResponse('这段通知文字必须保留', { requestId: 'req-real', ms: 1234 }),
  )
  harness.setRecordImpl(async () => {
    throw new Error('截图库写入失败')
  })
  await runToIdle(harness)

  const item = harness.getState().items[0]
  assert.equal(item.status, 'success', '历史写入失败不能把 OCR 结论改成失败')
  assert.equal(item.error, null)
  assert.equal(item.text, '这段通知文字必须保留')
  assert.equal(item.rawText, '这段通知文字必须保留')
  assert.match(item.historyError ?? '', /历史没有写进去/)
  assert.equal(harness.calls.record.length, 1)
  assert.equal(harness.calls.record[0].requestId, 'req-real')
  assert.equal(harness.calls.record[0].durationMs, 1234)
  assert.equal(harness.calls.record[0].rawText, '这段通知文字必须保留')
  assert.equal(harness.calls.record[0].image.width, 900)

  harness.controller.focus()
  assert.equal(harness.controller.adoptText('batch-1').ok, true, '历史写失败不影响采用')
})

test('待识别项里有手改文字时，整轮识别也必须先确认，确认后才替换', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)
  harness.controller.setText('batch-1', '我手动输入的第一张通知')

  assert.equal(harness.controller.startRun(), 'needs-replace-confirm')
  assert.equal(harness.calls.recognize.length, 0)

  harness.setRecognizeImpl(async (_endpoint, _options, index) => ocrResponse(`识别结果${index + 1}`))
  assert.equal(harness.controller.startRun({ confirmReplace: true }), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.deepEqual(
    harness.getState().items.map((item) => item.text),
    ['识别结果1', '识别结果2'],
  )
})

/* --------------------------------- 重试范围 -------------------------------- */

test('单张重试只允许 failed / cancelled / empty；success 与 pending 不能被单张重试', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)
  assert.equal(harness.controller.retryItem('batch-1'), 'invalid', 'pending 不在单张重试范围')

  harness.setRecognizeImpl(async (_endpoint, _options, index) =>
    index === 0 ? ocrResponse('第一张成功') : Promise.reject(new OcrClientError('NETWORK', '断网', { retryable: true })),
  )
  await runToIdle(harness)
  assert.equal(harness.getState().items[0].status, 'success')
  assert.equal(harness.getState().items[1].status, 'failed')

  assert.equal(harness.controller.retryItem('batch-1'), 'invalid', 'success 的图绝不重新 OCR / 覆盖手改')
  assert.equal(harness.calls.recognize.length, 2)

  harness.setRecognizeImpl(async () => ocrResponse('第二张重试成功'))
  assert.equal(harness.controller.retryItem('batch-2'), 'started')
  await waitFor(() => !harness.getState().busy)
  assert.equal(harness.getState().items[1].status, 'success')
  assert.equal(harness.getState().items[0].text, '第一张成功', '重试第二张不能动第一张')
})

/* --------------------------------- 进度 / 无任务写入 -------------------------------- */

test('真实进度按张数统计，没有假百分比；整批识别不产生任何任务写入调用', async () => {
  const harness = makeHarness()
  await pickAndArchive(harness, 2)
  harness.setRecognizeImpl(async (_endpoint, _options, index) => ocrResponse(index === 0 ? '文字一' : ''))
  await runToIdle(harness)

  const progress = batchNoticeProgress(harness.getState().items)
  assert.deepEqual(progress, {
    total: 2,
    completed: 2,
    remaining: 0,
    success: 1,
    empty: 1,
    failed: 0,
    cancelled: 0,
    running: 0,
  })
  assert.match(harness.getState().statusText, /已完成 2 张/)
  assert.ok(!/%/.test(harness.getState().statusText), '进度文案不能出现假百分比')

  // 控制器的依赖里没有任务写入通道：只记录截图历史，任务只能由 NoticeImport 写入。
  const dependencyKeys = Object.keys(harness.calls)
  assert.deepEqual(dependencyKeys.sort(), ['archive', 'pick', 'prepare', 'recognize', 'record'])
  assert.ok(harness.calls.record.every((entry) => entry.status === 'SUCCESS'))
})
