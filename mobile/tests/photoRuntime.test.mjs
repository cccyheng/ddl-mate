/**
 * 照片导入运行时的**行为回归测试**（真异步、真取消、真重试，不是字符串断言）。
 *
 * 覆盖用户实际遇到的两类问题：
 * 1. **选完照片没有任何反应** —— 焦点回调被 store 变化重建，清理函数把正在进行的识别取消；
 * 2. **结果串台 / 永远转圈** —— 共享的取消标记在新一轮被重置，迟到的结果又写进界面。
 *
 * 纪律（上一轮 supervisor 复核点名的）：
 * - 断言一律读 `operation.getState()`（控制器内部会换掉 state 对象，缓存引用会永远读到旧值）；
 * - 每个尝试有**独立**的 deferred，绝不共用一个挂起的 Promise；
 * - 每个等待都有上限，绝不会挂住测试；
 * - 断言必须有意义（例如「已经发出识别请求」而不是 `>= 0`）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createPhotoImportFocusBinding,
  createPhotoImportOperation,
} from '../src/screens/photoImportController.ts'
import {
  base64ByteLength,
  buildEncodeLadder,
  planResizeTier,
  preparePhotoForUpload,
  selectSaveFormatValue,
  selectSavePlan,
  sniffBase64Format,
} from '../src/domain/photoFiles.ts'
import {
  OcrClientError,
  recognizeTimeoutMs,
  recognizeTimetableImage,
  resolveOcrEndpoint,
} from '../src/domain/photoOcrClient.ts'
import {
  isInternalCourseCode,
  normalizeCourseNameForCompare,
} from '../src/domain/courseDraft.ts'
import { rowFromCandidate, rowToDrafts } from '../src/domain/photoImport.ts'
import { ScheduleImportRepository } from '../src/domain/scheduleImportRepository.ts'
import { createTestDatabase } from './helpers/sqliteHarness.mjs'

/* --------------------------------- 通用夹具 -------------------------------- */

const TEST_TIMEOUT_MS = 5_000

function emptyState() {
  return {
    stage: 'idle',
    progress: '',
    photoUri: null,
    photoBytes: null,
    photoWidth: null,
    photoHeight: null,
    sourceWidth: null,
    sourceHeight: null,
    photoFormat: null,
    photoScaled: false,
    rows: [],
    response: null,
    endpointUsed: null,
    error: null,
    busy: false,
  }
}

/** 可控的延迟：测试自己决定远程结果什么时候到。 */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 有上限的等待：Promise 一直不 settle 时抛错，而不是把测试挂死。 */
function withTimeout(promise, label, ms = TEST_TIMEOUT_MS) {
  let timer
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`超时：${label}`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function candidate(index, overrides = {}) {
  return {
    layout: 'week-grid',
    name: `测试课程${index}`,
    weekday: ((index - 1) % 5) + 1,
    startTime: '08:00',
    endTime: '09:35',
    startWeek: 7,
    endWeek: 7,
    weekPattern: 'ALL',
    location: `测试地点${index}`,
    rawText: `raw-${index}`,
    warnings: [],
    ...overrides,
  }
}

function ocrResponse(count) {
  return {
    layout: 'week-grid',
    week: 7,
    candidates: Array.from({ length: count }, (_, index) => candidate(index + 1)),
    warnings: [],
    diagnostics: {},
    rawText: '',
    ocrCalls: 1,
    ms: 10,
    image: { width: 1279, height: 2781, format: 'jpeg', bytes: 400_000 },
  }
}

function preparedPhoto(overrides = {}) {
  return {
    uri: 'file:///prepared.png',
    base64: 'AAAA',
    byteLength: 3,
    mimeType: 'image/png',
    width: 1279,
    height: 2781,
    sourceWidth: 1279,
    sourceHeight: 2781,
    resized: false,
    scale: 1,
    quality: 1,
    format: 'png',
    preservedSource: false,
    attempts: 1,
    ...overrides,
  }
}

/** 轮转到条件成立为止（带上限，不依赖固定 `setTimeout` 次数）。 */
async function waitFor(predicate, label, tries = 2000) {
  for (let index = 0; index < tries; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`等待失败：${label}`)
}

/**
 * 造一个「只差外部边界」的操作。
 *
 * 每个外部边界都按**调用顺序**排队：第 N 次调用拿到第 N 个 deferred，
 * 这样测试可以精确控制「A 还挂着的时候开始 B」。
 */
function makeOperation(overrides = {}) {
  const events = []
  const calls = { pick: 0, prepare: 0, health: 0, recognize: 0 }
  const healthQueue = []
  const recognizeQueue = []
  /** 归档调用与结果登记（复核对要求：归档必须早于校验/转码，且结果必须落历史）。 */
  const archiveCalls = []
  const results = []

  const deps = {
    state: emptyState(),
    minVisibleMs: 0,
    emit: (event) => events.push(event),
    pickFromLibrary: async () => {
      calls.pick += 1
      return {
        status: 'picked',
        uri: 'file:///picked.jpg',
        source: { width: 1279, height: 2781, mimeType: 'image/jpeg' },
      }
    },
    captureFromCamera: async () => ({ status: 'cancelled' }),
    archiveOriginal: async (uri, _source, attemptSource) => {
      archiveCalls.push({ uri, attemptSource })
      return { ok: true, attemptId: 7, message: null }
    },
    recordResult: (input) => {
      results.push(input)
    },
    preparePhoto: async () => {
      calls.prepare += 1
      return preparedPhoto()
    },
    checkHealth: async () => {
      calls.health += 1
      const entry = deferred()
      healthQueue.push(entry)
      return entry.promise
    },
    recognize: async (_endpoint, options) => {
      calls.recognize += 1
      const entry = deferred()
      // 把这一轮**自己的**网络信号暴露给测试：验证「取消」要看这条信号，
      // 而不是看界面处理函数的 Promise（它按设计会把取消吞掉）。
      entry.abortSignal = options.abortSignal
      entry.signal = options.signal
      recognizeQueue.push(entry)
      // 真客户端的语义：**自己的** controller 一被 abort，请求立刻以 CANCELLED 结束，
      // 而不是等响应回来才发现被取消（这正是上一版共享 cancelled 布尔的 bug）。
      let cancelled = false
      const abortSignal = options.abortSignal
      const onAbort = () => {
        cancelled = true
        entry.resolve(ocrResponse(0))
      }
      abortSignal.addEventListener('abort', onAbort)
      try {
        const outcome = await entry.promise
        if (cancelled || options.signal.cancelled) {
          throw new OcrClientError('CANCELLED', '这次识别已经取消。', { retryable: true })
        }
        return outcome
      } finally {
        abortSignal.removeEventListener('abort', onAbort)
      }
    },
    subscribe: () => ({ unsubscribe: () => undefined }),
    getEndpoint: () => 'http://192.168.31.73:8082',
    getInferredEndpoint: () => null,
    refreshStore: async () => undefined,
    ...overrides,
  }

  const operation = createPhotoImportOperation(deps)
  return {
    operation,
    events,
    calls,
    archiveCalls,
    results,
    async healthAt(index) {
      await waitFor(() => healthQueue.length > index, `健康检查 #${index}`)
      return healthQueue[index]
    },
    async recognizeAt(index) {
      await waitFor(() => recognizeQueue.length > index, `识别请求 #${index}`)
      return recognizeQueue[index]
    },
    healthCount: () => healthQueue.length,
    recognizeCount: () => recognizeQueue.length,
  }
}

function eventsContain(events, pattern) {
  return events.some((event) => event.type === 'toast' && pattern.test(event.toast.text))
}

/* -------------------------- 1. 焦点回调不能被 store 重建 ------------------------- */

function shallowEqual(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

/**
 * 极小的 `useFocusEffect` 语义模拟器：依赖变化时先执行 cleanup，再执行 effect。
 *
 * 这正是旧代码出事的机制：`store` 每次刷新都是新对象 → 依赖变化 → cleanup 取消识别 →
 * effect 里又调用 `refresh()` → 又刷新……循环把用户刚选的照片结果丢掉。
 */
function simulateFocusEffect(runEffect) {
  let currentDeps = null
  let cleanup = null
  let runs = 0
  return {
    render(deps) {
      const changed = currentDeps === null || !shallowEqual(currentDeps, deps)
      currentDeps = deps
      if (!changed) return false
      if (cleanup) cleanup()
      cleanup = runEffect()
      runs += 1
      return true
    },
    runs: () => runs,
  }
}

test('焦点依赖只用稳定 refresh：反复渲染不会重建焦点回调，旧写法（依赖整个 store）会成环', () => {
  const fixture = makeOperation()
  let refreshCalls = 0
  const refresh = async () => {
    refreshCalls += 1
  }
  const binding = createPhotoImportFocusBinding(fixture.operation, { refresh })
  const simulator = simulateFocusEffect(() => {
    binding.onFocus()
    return binding.onCleanup
  })

  simulator.render([refresh])
  assert.equal(refreshCalls, 1)

  for (let render = 0; render < 25; render += 1) {
    assert.equal(simulator.render([refresh]), false, '依赖引用不变时不能重新执行焦点回调')
  }
  assert.equal(refreshCalls, 1, '稳定依赖下不得出现「刷新 → 新对象 → 再刷新」的环')

  // 真正演示旧写法为什么会失控：依赖里放每次刷新都换身份的 store 对象。
  let storeIdentity = { refresh }
  let loopRefreshes = 0
  const buggy = simulateFocusEffect(() => {
    const local = createPhotoImportFocusBinding(fixture.operation, { refresh: storeIdentity.refresh })
    local.onFocus()
    return local.onCleanup
  })
  for (let round = 0; round < 25; round += 1) {
    storeIdentity = { refresh }
    if (buggy.render([storeIdentity])) loopRefreshes += 1
  }
  assert.equal(loopRefreshes, 25, '旧写法（依赖整个 store）会一轮一轮重建并再次刷新')
})

/* ------------------- 2. 取消 / 串台 / busy 的真实交错（review #2 #3） ------------------ */

test('A 的 finally 不会清掉 B 的状态：A 挂着时离开→回来发起 B，B 必须自己拿到结果', async () => {
  const fixture = makeOperation()
  const { operation } = fixture
  operation.focus()

  // ---- 尝试 A：进入识别并挂住 ----
  const pickingA = withTimeout(operation.pickFromLibrary(), 'A 的选择流程')
  const healthA = await fixture.healthAt(0)
  healthA.resolve(true)
  const recognizeA = await fixture.recognizeAt(0)
  assert.equal(operation.getState().stage, 'uploading', 'A 已经进入上传/识别阶段')
  assert.equal(operation.getState().busy, true, 'A 在进行中必须是 busy')

  // ---- 用户在 A 还挂着的时候离开，然后回来 ----
  operation.blur()
  assert.equal(operation.getState().busy, false, '离开后必须立刻退出 busy')
  // 界面处理函数**故意**把网络取消吞掉（取消不是错误，不该弹错误框），所以这里不期待它的 Promise 拒绝；
  // 要验证的是「那条请求的网络信号真的被 abort 了」——这正是独立 controller 的意义。
  assert.equal(recognizeA.abortSignal.aborted, true, '离开页面必须真的 abort 掉这一轮的请求')
  assert.equal(recognizeA.signal.cancelled, true, '这一轮的取消读法必须保持为「已取消」')
  recognizeA.resolve(ocrResponse(7)) // A 的响应现在才到（但已经被取消）
  await pickingA
  assert.equal(operation.getState().rows.length, 0, 'A 的迟到结果绝不能写进界面')
  operation.focus()

  // ---- 尝试 B：必须正常跑完（A 的收尾绝不能把 B 清掉）----
  const pickingB = withTimeout(operation.pickFromLibrary(), 'B 的选择流程')
  const healthB = await fixture.healthAt(1)
  healthB.resolve(true)
  const recognizeB = await fixture.recognizeAt(1)
  assert.equal(operation.getState().busy, true, 'B 在进行中必须是 busy')
  assert.equal(operation.getState().stage, 'uploading')
  assert.equal(recognizeB.abortSignal.aborted, false, 'B 的请求不能被 A 的取消影响')
  recognizeB.resolve(ocrResponse(3))
  await pickingB

  const finalState = operation.getState()
  assert.equal(finalState.rows.length, 3, 'B 必须拿到自己的 3 条结果')
  assert.equal(finalState.busy, false, 'B 结束后 busy 必须收掉')
  assert.equal(finalState.stage, 'done')
  assert.ok(eventsContain(fixture.events, /识别完成：3 条候选/), 'B 应当给出「识别完成 3 条」的提示')
})

test('迟到的旧响应不会污染新一轮：每轮有独立 controller，重新聚焦不会「复活」旧请求', async () => {
  const fixture = makeOperation()
  const { operation } = fixture
  operation.focus()

  const pickingA = withTimeout(operation.pickFromLibrary(), 'A 的选择流程')
  ;(await fixture.healthAt(0)).resolve(true)
  const recognizeA = await fixture.recognizeAt(0)

  operation.blur() // A 被取消（自己的 controller.abort()）
  operation.focus() // 立刻回来：旧实现会把共享的 cancelled 又变回 false
  // 旧 bug 的判别点：重新聚焦后，A 那一次的取消状态**必须仍然是「已取消」**。
  assert.equal(recognizeA.abortSignal.aborted, true, '重新聚焦不能把旧请求的取消状态重置')
  assert.equal(recognizeA.signal.cancelled, true)
  recognizeA.resolve(ocrResponse(9))
  await pickingA

  assert.equal(operation.getState().rows.length, 0, '取消后重新聚焦也不能让旧结果落进界面')

  // 新一轮仍然可以拿到结果（说明取消没有把操作永久废掉）。
  const pickingB = withTimeout(operation.retryLastPhoto(), 'B 的重试流程')
  ;(await fixture.healthAt(1)).resolve(true)
  ;(await fixture.recognizeAt(1)).resolve(ocrResponse(2))
  await pickingB
  assert.equal(operation.getState().rows.length, 2)
  assert.equal(operation.getState().stage, 'done')
})

test('新一轮开始时先清掉上一张图的结果和错误（不会把旧结果当成新结果）', async () => {
  const fixture = makeOperation()
  const { operation } = fixture
  operation.focus()

  const first = withTimeout(operation.pickFromLibrary(), '第一轮')
  ;(await fixture.healthAt(0)).resolve(true)
  ;(await fixture.recognizeAt(0)).resolve(ocrResponse(4))
  await first
  assert.equal(operation.getState().rows.length, 4)

  // 第二轮：选图的瞬间就应该把上一轮的 rows / response 清掉。
  const second = withTimeout(operation.pickFromLibrary(), '第二轮')
  const midState = operation.getState()
  assert.equal(midState.busy, true, '新一轮一开始就是 busy（review #3）')
  assert.equal(midState.rows.length, 0, '上一张图的候选行不能留到新一轮')
  assert.equal(midState.response, null)
  ;(await fixture.healthAt(1)).resolve(false) // 让这一轮以失败结束
  await second
  assert.equal(operation.getState().rows.length, 0, '失败后也不能露出旧结果')
  assert.ok(operation.getState().error, '失败必须有可见错误')
})

test('离开页面（blur）真正取消：发出过请求、结果被丢弃、busy 立刻收掉、可重试', async () => {
  const fixture = makeOperation()
  const { operation } = fixture
  operation.focus()

  const picking = withTimeout(operation.pickFromLibrary(), '选择流程')
  ;(await fixture.healthAt(0)).resolve(true)
  const recognize = await fixture.recognizeAt(0)
  assert.equal(fixture.calls.recognize, 1, '必须真的发出过识别请求，才谈得上「取消它」')
  assert.equal(operation.getState().busy, true)

  operation.blur()
  assert.equal(operation.getState().busy, false)
  // 界面处理函数会把网络取消吞掉（不弹错误框），所以这里断言「网络信号真的被 abort」而不是 Promise 拒绝。
  assert.equal(recognize.abortSignal.aborted, true, '离开页面必须真的 abort 掉这一轮的请求')
  recognize.resolve(ocrResponse(2))
  await picking
  assert.equal(operation.getState().rows.length, 0)
  assert.equal(operation.getState().error, null, '取消不是失败，不该弹错误')

  // 回来以后还能重试（取消没有把操作废掉）。
  operation.focus()
  const retry = withTimeout(operation.retryLastPhoto(), '重试流程')
  ;(await fixture.healthAt(1)).resolve(true)
  ;(await fixture.recognizeAt(1)).resolve(ocrResponse(1))
  await retry
  assert.equal(operation.getState().rows.length, 1, '取消之后重试必须能拿到结果')
})

/* ------------------------------ 3. 其它生命周期 ----------------------------- */

test('结果登记失败会走错误出口（不静默、也不产生未处理拒绝）', async () => {
  const failing = makeOperation({
    recordResult: async () => {
      throw new Error('磁盘写不进去')
    },
  })
  failing.operation.focus()
  const run = failing.operation.pickFromLibrary()
  ;(await failing.healthAt(0)).resolve(true)
  ;(await failing.recognizeAt(0)).resolve(ocrResponse(1))
  await run
  // 识别结果本身照常显示给用户，但「没存进截图库」必须说清楚。
  assert.equal(failing.operation.getState().rows.length, 1)
  const errorEvent = failing.events.find((event) => event.type === 'error')
  assert.ok(errorEvent, '必须有一个明确的错误出口事件')
  assert.equal(errorEvent.error.code, 'SCREENSHOT_STORAGE')
  assert.match(errorEvent.error.message, /磁盘写不进去/)
  failing.operation.dispose()
})

test('选择器返回权限被拒 / 用户取消：不归档、不识别、无错误框', async () => {
  const denied = makeOperation({
    pickFromLibrary: async () => ({ status: 'permission', canAskAgain: false, message: '相机权限已被拒绝。' }),
  })
  denied.operation.focus()
  await denied.operation.pickFromLibrary()
  assert.deepEqual(denied.archiveCalls, [], '没有选到图 → 不归档')
  assert.deepEqual(denied.results, [], '没有选到图 → 没有尝试历史')
  assert.equal(denied.calls.recognize, 0)
  assert.equal(denied.operation.getState().error?.message, '相机权限已被拒绝。')

  const cancelled = makeOperation({ pickFromLibrary: async () => ({ status: 'cancelled' }) })
  cancelled.operation.focus()
  await cancelled.operation.pickFromLibrary()
  assert.deepEqual(cancelled.archiveCalls, [])
  assert.deepEqual(cancelled.results, [])
  assert.equal(cancelled.operation.getState().error, null)
})

test('系统相册弹窗导致失焦时不误杀流程（延后取消）；选到图后即使离开也先把原图留存', async () => {
  // 情形 A：选择器已经返回、用户还在页面 —— 失焦只标记延后取消，流程继续。
  const kept = makeOperation()
  kept.operation.focus()
  const picking = withTimeout(kept.operation.pickFromLibrary(), 'A 的选择流程')
  kept.operation.blur() // 权限弹窗 / 选择器导致的失焦
  kept.operation.focus() // 系统弹窗关掉后又回到页面
  ;(await kept.healthAt(0)).resolve(true)
  ;(await kept.recognizeAt(0)).resolve(ocrResponse(3))
  await picking
  assert.equal(kept.operation.getState().rows.length, 3, '系统弹窗导致的失焦不能杀掉正常流程')

  // 情形 B：选择器还开着的时候用户真的走了 —— **但图片已经选到了**。
  // 复核对明确要求：`no photo picked => no archive`，反之「选到了就必须归档」，
  // 不能因为用户随后离开页面就把这张图丢掉（那正是原来会丢原图的路径）。
  const left = makeOperation()
  left.operation.focus()
  const abandoned = withTimeout(left.operation.pickFromLibrary(), 'B 的选择流程')
  left.operation.blur() // 选择器还开着 → 用户随后真的离开
  await abandoned
  assert.deepEqual(
    left.archiveCalls.map((call) => call.uri),
    ['file:///picked.jpg'],
    '已经选到的图必须先归档，不能因为随后离开就丢掉',
  )
  assert.equal(left.calls.prepare, 0, '用户已经离开 → 不再继续转码 / 上传')
  assert.equal(left.calls.recognize, 0, '用户离开后不应该再发起识别')
  // 结果历史照样要有一条（取消），否则这张图在截图库里没有「那次没识别」的记录。
  assert.equal(left.results.at(-1)?.status, 'CANCELLED')
  assert.equal(left.results.at(-1)?.attemptId, 7)
  assert.equal(left.operation.getState().busy, false)
  assert.equal(left.operation.getState().rows.length, 0)
})

test('权限被拒 / 用户取消选择器 / 准备失败：都给可见结果并退出 busy', async () => {
  const denied = makeOperation({
    pickFromLibrary: async () => ({ status: 'permission', canAskAgain: true, message: '还没有允许访问相册。' }),
  })
  denied.operation.focus()
  await denied.operation.pickFromLibrary()
  assert.equal(denied.operation.getState().error?.message, '还没有允许访问相册。')
  assert.equal(denied.operation.getState().busy, false)
  assert.equal(denied.calls.prepare, 0)

  const cancelled = makeOperation({ pickFromLibrary: async () => ({ status: 'cancelled' }) })
  cancelled.operation.focus()
  await cancelled.operation.pickFromLibrary()
  assert.equal(cancelled.operation.getState().error, null)
  assert.equal(cancelled.operation.getState().busy, false)
  assert.equal(cancelled.operation.getState().stage, 'idle')

  const failed = makeOperation({
    preparePhoto: async () => {
      throw new OcrClientError('BAD_REQUEST', '这台手机没能处理这张图片', { retryable: true })
    },
  })
  failed.operation.focus()
  await failed.operation.pickFromLibrary()
  assert.equal(failed.operation.getState().error?.message, '这台手机没能处理这张图片')
  assert.equal(failed.operation.getState().busy, false)
  assert.equal(failed.operation.getState().stage, 'idle')
  assert.equal(failed.calls.recognize, 0)
})

test('没有可用的服务地址：给可读错误 + NO_ENDPOINT，不浪费时间去准备图片', async () => {
  const fixture = makeOperation({ getEndpoint: () => null, getInferredEndpoint: () => null })
  fixture.operation.focus()
  await fixture.operation.pickFromLibrary()
  const state = fixture.operation.getState()
  assert.equal(state.error?.code, 'NO_ENDPOINT')
  assert.match(String(state.error?.message), /识别服务设置/)
  assert.equal(fixture.calls.prepare, 0)
  assert.equal(state.busy, false)
})

test('健康检查不通过：报可读网络错误、不发识别请求、busy 收掉', async () => {
  const fixture = makeOperation()
  fixture.operation.focus()
  const picking = withTimeout(fixture.operation.pickFromLibrary(), '选择流程')
  ;(await fixture.healthAt(0)).resolve(false)
  await picking
  const state = fixture.operation.getState()
  assert.equal(fixture.calls.recognize, 0)
  assert.equal(state.error?.code, 'NETWORK')
  assert.equal(state.busy, false)
})

test('识别成功：候选行、教学周、结果文案都落到界面上', async () => {
  const fixture = makeOperation()
  fixture.operation.focus()
  const picking = withTimeout(fixture.operation.pickFromLibrary(), '选择流程')
  ;(await fixture.healthAt(0)).resolve(true)
  ;(await fixture.recognizeAt(0)).resolve(ocrResponse(4))
  await picking
  const state = fixture.operation.getState()
  assert.equal(state.stage, 'done')
  assert.equal(state.rows.length, 4)
  assert.equal(state.response?.week, 7)
  assert.equal(state.rows[0]?.startWeek, '7')
  assert.equal(state.rows[0]?.endWeek, '7')
  assert.equal(state.endpointUsed, 'http://192.168.31.73:8082')
  assert.equal(state.photoFormat, 'png')
  assert.ok(eventsContain(fixture.events, /识别完成：4 条候选/))
})

test('识别进行中再次点击不会并发启动，也不会重复识别', async () => {
  const fixture = makeOperation()
  fixture.operation.focus()
  const first = withTimeout(fixture.operation.pickFromLibrary(), '第一次')
  await fixture.healthAt(0)
  await fixture.operation.pickFromLibrary() // busy 状态下必须直接返回
  ;(await fixture.healthAt(0)).resolve(true)
  ;(await fixture.recognizeAt(0)).resolve(ocrResponse(1))
  await first
  assert.equal(fixture.calls.pick, 1)
  assert.equal(fixture.calls.recognize, 1)
})

test('dispose 之后不再提交状态；attach 之后同一个控制器又能用（StrictMode 生命周期）', async () => {
  const fixture = makeOperation()
  fixture.operation.focus()
  const picking = withTimeout(fixture.operation.pickFromLibrary(), '选择流程')
  ;(await fixture.healthAt(0)).resolve(true)
  const recognize = await fixture.recognizeAt(0)
  fixture.operation.dispose()
  assert.equal(recognize.abortSignal.aborted, true, 'dispose 必须真的 abort 掉在进行的请求')
  recognize.resolve(ocrResponse(9))
  await picking
  assert.equal(fixture.operation.getState().rows.length, 0, 'dispose 之后不能再写状态')

  // StrictMode：setup → cleanup → setup，重新 attach 后必须还能完整跑一轮。
  fixture.operation.attach()
  assert.equal(fixture.operation.attached, true)
  const second = withTimeout(fixture.operation.pickFromLibrary(), 'attach 后的新一轮')
  ;(await fixture.healthAt(1)).resolve(true)
  ;(await fixture.recognizeAt(1)).resolve(ocrResponse(2))
  await second
  assert.equal(fixture.operation.getState().rows.length, 2, 'attach 之后必须还能识别')
})

/* ------------------------- 4. 图片准备：不放大、不盲目缩小 ------------------------ */

test('planResizeTier：不放大、保持长宽比、并同时守住单边与像素上限', () => {
  const original = planResizeTier(1279, 2781, 1)
  assert.deepEqual([original.width, original.height, original.resized], [1279, 2781, false])

  const half = planResizeTier(1279, 2781, 0.5)
  // 用 floor 而不是 round：四舍五入会把尺寸推到「刚好超过上限」的位置（服务端会拒收）。
  assert.deepEqual([half.width, half.height, half.resized], [639, 1390, true])
  assert.ok(Math.abs(half.width / half.height - 1279 / 2781) < 0.003)

  const small = planResizeTier(320, 200, 1)
  assert.deepEqual([small.width, small.height, small.resized], [320, 200, false])

  // 4000×12000：单边超 10000、像素超 2600 万 → 两个上限都要守住，且不变形。
  const huge = planResizeTier(4000, 12000, 1, 10_000)
  assert.equal(huge.resized, true)
  assert.ok(huge.width <= 10_000 && huge.height <= 10_000)
  assert.ok(huge.width * huge.height <= 26_000_000, `像素数仍超限：${huge.width * huge.height}`)
  assert.ok(Math.abs(huge.width / huge.height - 4000 / 12000) < 0.002)
  assert.ok(huge.width <= 4000 && huge.height <= 12000, '这是缩小，不是放大')

  // 像素上限：6000×6000 = 3600 万 > 2600 万 → 必须缩到上限内，且不变形。
  const dense = planResizeTier(6000, 6000, 1)
  assert.equal(dense.resized, true)
  assert.ok(dense.width * dense.height <= 26_000_000, `像素数仍超限：${dense.width * dense.height}`)
  assert.ok(dense.width <= 6000, '绝不能放大')
  assert.ok(Math.abs(dense.width / dense.height - 1) < 0.002)

  // 未知尺寸：第一档不缩放（先渲染一次拿尺寸），缩小档只给宽度等比 —— 绝不传 null,null。
  const unknown = planResizeTier(0, 0, 1)
  assert.deepEqual([unknown.width, unknown.height, unknown.resized, unknown.known], [null, null, false, false])
  const unknownHalf = planResizeTier(0, 0, 0.5)
  assert.deepEqual([unknownHalf.width, unknownHalf.height, unknownHalf.resized], [null, null, true])
  assert.equal(
    selectSavePlan({ format: 'png', quality: 1, scale: 1 }, null, null).resize,
    null,
    '未知尺寸不能传 {null,null}',
  )
})

test('buildEncodeLadder / selectSavePlan：先原分辨率 PNG，再原分辨率 JPEG，最后才缩小', () => {
  const ladder = buildEncodeLadder()
  assert.deepEqual(ladder[0], { format: 'png', quality: 1, scale: 1 })
  assert.deepEqual(ladder[1], { format: 'jpeg', quality: 0.9, scale: 1 })
  assert.deepEqual(ladder[2], { format: 'jpeg', quality: 0.75, scale: 1 })
  assert.deepEqual(ladder[3], { format: 'jpeg', quality: 0.6, scale: 1 })
  assert.equal(ladder[4].scale, 0.8)
  assert.equal(ladder[4].format, 'png')

  const noResize = selectSavePlan(ladder[0], 1279, 2781)
  assert.equal(noResize.resize, null, '原分辨率档不能调用 resize')

  const downscaled = selectSavePlan({ format: 'jpeg', quality: 0.75, scale: 0.8 }, 1279, 2781)
  assert.deepEqual(downscaled.resize, { width: 1023, height: 2224 })
})

test('selectSaveFormatValue：原生枚举是对象，必须传标量（真机上的关键边界）', () => {
  const SaveFormat = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' }
  assert.equal(selectSaveFormatValue(SaveFormat, 'png'), 'png')
  assert.equal(selectSaveFormatValue(SaveFormat, 'jpeg'), 'jpeg')
  assert.notEqual(selectSaveFormatValue(SaveFormat, 'png'), SaveFormat)
  // 枚举缺项时退化成字符串常量，而不是把整个对象传下去。
  assert.equal(selectSaveFormatValue({ JPEG: 'jpeg' }, 'png'), 'png')
})

test('sniffBase64Format：按魔数识别 PNG / JPEG，失败返回 null（不信任 MIME）', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+3B0dAAAAAElFTkSuQmCC'
  assert.equal(sniffBase64Format(png), 'png')
  assert.equal(sniffBase64Format(`data:image/png;base64,${png}`), 'png')
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  assert.equal(sniffBase64Format(jpeg), 'jpeg')
  assert.equal(sniffBase64Format('aGVpYy1ub3QtYW4taW1hZ2U='), null)
})

test('preparePhotoForUpload：原图 PNG 且在上限内时原样直传（不重编码、零损失）', async () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+3B0dAAAAAElFTkSuQmCC'
  let manipulateCalls = 0
  const prepared = await preparePhotoForUpload('file:///picked.png', {
    source: { width: 1279, height: 2781, mimeType: 'image/png' },
    deps: {
      manipulator: {
        manipulate: () => {
          manipulateCalls += 1
          throw new Error('不应该走到重编码这一步')
        },
      },
      saveFormat: { JPEG: 'jpeg', PNG: 'png' },
      readSourceBase64: async () => png,
    },
  })
  assert.equal(prepared.preservedSource, true)
  assert.equal(prepared.format, 'png')
  assert.equal(prepared.base64, png)
  assert.equal(prepared.resized, false)
  assert.equal(prepared.byteLength, base64ByteLength(png))
  assert.equal(manipulateCalls, 0, '原图可直接上传时绝不能重编码')
})

test('preparePhotoForUpload：原分辨率 PNG，且 format 传的是标量而不是枚举对象', async () => {
  const saveOptions = []
  const resizes = []
  const encoded =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+3B0dAAAAAElFTkSuQmCC'
  const prepared = await preparePhotoForUpload('file:///picked.heic', {
    source: { width: 1279, height: 2781, mimeType: 'image/heic' },
    deps: {
      manipulator: {
        manipulate: () => {
          const result = {
            width: 1279,
            height: 2781,
            saveAsync: async (options) => {
              saveOptions.push(options)
              return { uri: 'file:///out.png', width: 1279, height: 2781, base64: encoded }
            },
          }
          return {
            resize: (size) => {
              resizes.push(size)
              return { renderAsync: async () => result }
            },
            renderAsync: async () => result,
          }
        },
      },
      saveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    },
  })
  assert.equal(resizes.length, 0, '第一档必须是原分辨率，不能 resize')
  assert.equal(saveOptions.length, 1)
  assert.equal(saveOptions[0].format, 'png', 'format 必须是标量（传整个枚举对象在真机上会坏）')
  assert.equal(prepared.format, 'png')
  assert.equal(prepared.resized, false)
  assert.equal(prepared.attempts, 1)
})

/**
 * 造一个**头部合法**的 PNG base64（只有 IHDR 是真数据，后面是填充）。
 *
 * 为什么要这样：`preparePhotoForUpload` 会直接量**真正要发出去的字节**的尺寸
 * （PNG IHDR / JPEG SOF）来守服务端的单边与像素上限，所以测试里的假编码必须头部合法。
 */
function fakePngBase64(width, height, paddingBytes = 0) {
  const header = new Uint8Array(24 + paddingBytes)
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  header.set([0, 0, 0, 13], 8)
  header.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(header.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return Buffer.from(header).toString('base64')
}

test('preparePhotoForUpload：超过预算才缩小，且绝不放大、from-PNG-first', async () => {
  const resizes = []
  const saves = []
  const prepared = await preparePhotoForUpload('file:///picked.heic', {
    maxBytes: 1000,
    source: { width: 1279, height: 2781, mimeType: 'image/heic' },
    deps: {
      manipulator: {
        manipulate: () => {
          const mk = (size, small) => ({
            width: size.width,
            height: size.height,
            saveAsync: async (options) => {
              saves.push(`${options.format}:${size.width}x${size.height}`)
              // 小图档给出头部合法的 PNG（尺寸与真实输出一致），大图档用填充撑爆预算。
              return {
                uri: 'file:///out',
                width: size.width,
                height: size.height,
                base64: fakePngBase64(size.width, size.height, small ? 8 : 40_000),
              }
            },
          })
          return {
            resize: (size) => {
              resizes.push(size)
              return { renderAsync: async () => mk(size, (size.width ?? 0) <= 1030) }
            },
            renderAsync: async () => mk({ width: 1279, height: 2781 }, false),
          }
        },
      },
      saveFormat: { JPEG: 'jpeg', PNG: 'png' },
    },
  })
  // 原分辨率三档都超预算；0.8 倍的无损 PNG 才够小 —— 说明顺序确实是
  // 「先保分辨率 → 再保无损 → 最后才牺牲分辨率」。
  assert.deepEqual(saves, [
    'png:1279x2781',
    'jpeg:1279x2781',
    'jpeg:1279x2781',
    'jpeg:1279x2781',
    'png:1023x2224',
  ])
  for (const size of resizes) {
    assert.ok((size.width ?? 0) <= 1279 && (size.height ?? 0) <= 2781, '绝不允许放大')
  }
  assert.equal(resizes[0].width, 1023)
  assert.equal(prepared.resized, true)
  assert.equal(prepared.scale, 0.8)
  assert.deepEqual([prepared.width, prepared.height], [1023, 2224])
  assert.equal(prepared.format, 'png')
  assert.equal(prepared.quality, 1)
})

test('preparePhotoForUpload：真的量输出字节的尺寸，超硬上限的档会被跳过', async () => {
  const resizes = []
  // 外部声称已经是小图，但真实编码回来的 PNG 头部是 20000×20000（超单边上限）。
  const prepared = await preparePhotoForUpload('file:///picked.heic', {
    source: { width: 900, height: 900, mimeType: 'image/heic' },
    deps: {
      manipulator: {
        manipulate: () => ({
          resize: (size) => {
            resizes.push(size)
            return {
              renderAsync: async () => ({
                width: size.width,
                height: size.height,
                saveAsync: async () => ({
                  uri: 'file:///out.png',
                  width: size.width,
                  height: size.height,
                  base64: fakePngBase64(size.width ?? 900, size.height ?? 900),
                }),
              }),
            }
          },
          renderAsync: async () => ({
            width: 900,
            height: 900,
            saveAsync: async () => ({
              uri: 'file:///out.png',
              width: 900,
              height: 900,
              base64: fakePngBase64(20_000, 20_000),
            }),
          }),
        }),
      },
      saveFormat: { JPEG: 'jpeg', PNG: 'png' },
    },
  })
  // 第一档（原分辨率）编码出来是 20000×20000 → 必须被拒绝，随后走缩小档。
  assert.ok(resizes.length > 0, '超硬上限的那一档必须被跳过，继续往下压')
  assert.ok(prepared.width <= 10_000 && prepared.height <= 10_000)
  assert.ok(prepared.width * prepared.height <= 26_000_000)
})

test('preparePhotoForUpload：尺寸未知时先渲染一次拿尺寸，且不会传 {null,null}', async () => {
  const resizes = []
  const prepared = await preparePhotoForUpload('file:///picked.heic', {
    source: { width: 0, height: 0, mimeType: 'image/heic' },
    deps: {
      manipulator: {
        manipulate: () => {
          const result = {
            width: 800,
            height: 600,
            saveAsync: async () => ({ uri: 'file:///out.png', width: 800, height: 600, base64: 'AAAA' }),
          }
          return {
            resize: (size) => {
              resizes.push(size)
              return { renderAsync: async () => result }
            },
            renderAsync: async () => result,
          }
        },
      },
      saveFormat: { JPEG: 'jpeg', PNG: 'png' },
    },
  })
  assert.deepEqual(resizes, [], '取尺寸/首档都不能传 resize')
  assert.deepEqual([prepared.width, prepared.height], [800, 600])
  assert.equal(prepared.sourceWidth, 800, '尺寸未知时要通过真实渲染补上尺寸')
  assert.equal(prepared.resized, false)
})

test('base64ByteLength：按 base64 长度算字节数（含 padding）', () => {
  assert.equal(base64ByteLength(''), 0)
  assert.equal(base64ByteLength('AAAA'), 3)
  assert.equal(base64ByteLength('AAA='), 2)
  assert.equal(base64ByteLength('AA=='), 1)
})

/* --------------------- 5. 网络层：取消 / 超时 / 地址解析语义 --------------------- */

test('recognizeTimetableImage：外部取消抛 CANCELLED，而不是被误报成超时', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })

  const pending = recognizeTimetableImage('http://192.168.31.73:8082', {
    imageBase64: 'AAAA',
    signal: controller.signal,
    fetchImpl,
  })
  controller.abort()
  await assert.rejects(withTimeout(pending, '取消'), (error) => {
    assert.ok(error instanceof OcrClientError)
    assert.equal(error.code, 'CANCELLED')
    return true
  })
})

test('recognizeTimetableImage：超时抛 TIMEOUT（与取消区分开）', async () => {
  const fetchImpl = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  await assert.rejects(
    withTimeout(
      recognizeTimetableImage('http://192.168.31.73:8082', { imageBase64: 'AAAA', timeoutMs: 5, fetchImpl }),
      '超时',
    ),
    (error) => {
      assert.equal(error.code, 'TIMEOUT')
      return true
    },
  )
})

test('recognizeTimeoutMs：随图片增大，但有明确上限', () => {
  const small = recognizeTimeoutMs('A'.repeat(100))
  const medium = recognizeTimeoutMs('A'.repeat(60_000_000))
  const huge = recognizeTimeoutMs('A'.repeat(40_000_000))
  assert.ok(small >= 200_000)
  assert.ok(medium > small)
  assert.ok(huge <= 300_000)
})

test('resolveOcrEndpoint：区分「没填」和「填错」', () => {
  assert.deepEqual(resolveOcrEndpoint(null), { ok: false, reason: 'empty' })
  assert.deepEqual(resolveOcrEndpoint('   '), { ok: false, reason: 'empty' })
  assert.deepEqual(resolveOcrEndpoint('ftp://192.168.1.5:8082'), { ok: false, reason: 'invalid' })
  assert.deepEqual(resolveOcrEndpoint('192.168.31.73:8082'), { ok: true, endpoint: 'http://192.168.31.73:8082' })
  assert.deepEqual(resolveOcrEndpoint('http://192.168.31.73:8082/v1/ocr/timetable'), {
    ok: true,
    endpoint: 'http://192.168.31.73:8082',
  })
})

/* ---------------------- 6. 课程名归一化：跨 OCR 排版变体合并 ---------------------- */

test('normalizeCourseNameForCompare：括号/连字符等排版差异算同一门课，语义差异不算', () => {
  // 真实截图上的问题：同一门课在周一格子里是 大学物理(B-2)，周三格子里是 大学物理B-2。
  assert.equal(
    normalizeCourseNameForCompare('大学物理(B-2)'),
    normalizeCourseNameForCompare('大学物理B-2'),
  )
  assert.equal(normalizeCourseNameForCompare('电路与电子技术(双语)'), normalizeCourseNameForCompare('电路与电子技术（双语）'))
  assert.equal(normalizeCourseNameForCompare('计算机 基础'), normalizeCourseNameForCompare('计算机基础'))

  // 绝对不能并掉的差异：加号、数字、不同课程。
  assert.notEqual(normalizeCourseNameForCompare('面向对象程序设计(C++)'), normalizeCourseNameForCompare('面向对象程序设计(C)'))
  assert.notEqual(normalizeCourseNameForCompare('大学物理实验(2)'), normalizeCourseNameForCompare('大学物理实验(3)'))
  assert.notEqual(normalizeCourseNameForCompare('大学物理(B-2)'), normalizeCourseNameForCompare('大学物理(B-1)'))
  assert.notEqual(normalizeCourseNameForCompare('数据结构'), normalizeCourseNameForCompare('数据结构实验'))
})

test('isInternalCourseCode：只认自动内部编号，用户手写代码不会被当成内部编号', () => {
  assert.equal(isInternalCourseCode('AUTO-01'), true)
  assert.equal(isInternalCourseCode('auto-7'), true)
  assert.equal(isInternalCourseCode('CS101'), false)
  assert.equal(isInternalCourseCode('AUTOMATION-1'), false)
  assert.equal(isInternalCourseCode(''), false)
})

test('真实导入：同一门课的 OCR 排版变体只建一门课程，重复导入不产生重复课表', async () => {
  const harness = await createTestDatabase()
  const repository = new ScheduleImportRepository(harness.db, () => new Date('2026-10-08T04:00:00.000Z'))
  try {
    // 直接模拟界面走完的路径：候选行 → rowToDrafts → 导入。
    const candidates = [
      {
        name: '大学物理(B-2)',
        weekday: 1,
        startTime: '08:00',
        endTime: '09:35',
        location: '励志楼-204(多媒体)',
      },
      {
        // 同一门课，OCR 拆行把括号丢了。
        name: '大学物理B-2',
        weekday: 3,
        startTime: '10:00',
        endTime: '11:35',
        location: '励志楼-204(多媒体)',
      },
      {
        name: '面向对象程序设计(C++)',
        weekday: 4,
        startTime: '10:00',
        endTime: '11:35',
        location: '扬帆楼-101',
      },
      {
        // 与 C++ 那门只差一个加号：必须保持为**独立**的一门课。
        name: '面向对象程序设计(C)',
        weekday: 4,
        startTime: '13:30',
        endTime: '15:05',
        location: '扬帆楼-102',
      },
    ].map((entry, index) =>
      rowToDrafts(rowFromCandidate({ ...entry, startWeek: 7, endWeek: 7 }, index), {
        semesterStartMonday: '2026-08-31',
        applySemesterStart: true,
      }),
    )

    const first = await repository.importCandidates({
      candidates: candidates.map((drafts, index) => ({ rowNumber: index + 1, include: true, ...drafts })),
    })
    assert.equal(first.committed, true)
    assert.equal(first.schedules.length, 4, '4 条课表都要写进去')
    assert.equal(first.courses.length, 3, '大学物理的两个排版变体只能建一门课')

    const courseNames = (
      await harness.db.getAllAsync('SELECT name FROM courses ORDER BY id ASC;')
    ).map((row) => String(row.name))
    assert.deepEqual(courseNames, ['大学物理(B-2)', '面向对象程序设计(C++)', '面向对象程序设计(C)'])

    // 再导入一次同一批：课表不能翻倍。
    await repository.importCandidates({
      candidates: candidates.map((drafts, index) => ({ rowNumber: index + 1, include: true, ...drafts })),
    })
    const count = await harness.db.getFirstAsync('SELECT count(*) AS n FROM schedules;')
    assert.equal(Number(count.n), 4, '重复导入不能产生重复课表')
  } finally {
    harness.close()
  }
})








