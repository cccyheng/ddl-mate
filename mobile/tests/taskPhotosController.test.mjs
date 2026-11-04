/**
 * 任务原图屏的**运行状态机**测试（不依赖 React / Expo）。
 *
 * 授权书点名要覆盖的运行边界：
 * - 同步 busy 闸门挡住同一帧的双击，写请求只发一次；
 * - 写入已提交、但随后的列表刷新失败：明确「已保存」，只允许重试刷新；
 * - 卸载 / 切换任务之后，迟到的旧读回一律忽略；
 * - 任务在读取之后、保存之前被删除：页面切成「任务不在」，不再允许写入；
 * - 只有手动关联可以解除，历史只读关联不会被误调；
 * - 解除成功后提示原图仍在截图库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createInitialTaskPhotosState,
  createTaskPhotosOperation,
} from '../src/screens/taskPhotosController.ts'

const TASK_ID = 7

function attempt(id, overrides = {}) {
  return {
    id,
    capturedAt: '2026-10-12T04:00:00.000Z',
    source: 'LIBRARY',
    status: 'ARCHIVED',
    archivedPath: `file:///docs/screenshots/shot-${id}.png`,
    byteLength: 2048,
    width: 1170,
    height: 2532,
    format: 'png',
    mimeType: 'image/png',
    note: null,
    ...overrides,
  }
}

function photo(id, overrides = {}) {
  return {
    attempt: attempt(id),
    manual: true,
    manualRefId: id,
    manualLinkedAt: '2026-10-12T04:01:00.000Z',
    otherRelations: [],
    ...overrides,
  }
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

async function waitFor(predicate, message = '等待状态超时', rounds = 100) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

function makeDeps(overrides = {}) {
  const calls = { listPhotos: 0, listAddable: 0, attach: 0, detach: 0 }
  const deps = {
    taskId: TASK_ID,
    listPhotos: async () => {
      calls.listPhotos += 1
      return { taskExists: true, photos: [] }
    },
    listAddable: async () => {
      calls.listAddable += 1
      return { taskExists: true, photos: [] }
    },
    attach: async (taskId, attemptId) => {
      calls.attach += 1
      return {
        committed: true,
        idempotent: false,
        taskId,
        attemptId,
        manualRefId: 1,
        code: null,
        reason: null,
      }
    },
    detach: async (taskId, attemptId) => {
      calls.detach += 1
      return { committed: true, removed: true, taskId, attemptId, code: null, reason: null }
    },
    ...overrides,
  }
  return { deps, calls }
}

function readyState(overrides = {}) {
  return createInitialTaskPhotosState(TASK_ID, {
    loaded: true,
    taskExists: true,
    ...overrides,
  })
}

function readyStateFor(taskId, overrides = {}) {
  return createInitialTaskPhotosState(taskId, {
    loaded: true,
    taskExists: true,
    ...overrides,
  })
}

test('同步 busy 闸门：同一帧连点两次只发一个写请求', async () => {
  const pending = deferred()
  const { deps, calls } = makeDeps({
    attach: () => {
      calls.attach += 1
      return pending.promise
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: readyState() })

  const first = operation.attach(11)
  const second = await operation.attach(11)
  assert.equal(second, 'busy')
  assert.equal(calls.attach, 1, '第二次点击没有发起第二个写请求')
  assert.equal(operation.busy, true)

  pending.resolve({
    committed: true,
    idempotent: false,
    taskId: TASK_ID,
    attemptId: 11,
    manualRefId: 1,
    code: null,
    reason: null,
  })
  await first
  assert.equal(operation.busy, false)
  assert.equal(operation.getState().busy, false)
  assert.match(operation.getState().notice?.text ?? '', /已把这张原图添加/)
})

test('写入已提交但刷新失败：显示「已保存」，只允许重试刷新，不允许重复写', async () => {
  let reads = 0
  const { deps, calls } = makeDeps({
    listPhotos: async () => {
      calls.listPhotos += 1
      reads += 1
      if (reads === 1) throw new Error('测试注入的列表读取失败')
      return { taskExists: true, photos: [photo(11)] }
    },
    listAddable: async () => {
      calls.listAddable += 1
      return { taskExists: true, photos: [] }
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: readyState() })

  await operation.attach(11)
  const failedReload = operation.getState()
  assert.equal(failedReload.busy, false)
  assert.match(failedReload.staleAfterCommit ?? '', /已经保存好了/)
  assert.match(failedReload.staleAfterCommit ?? '', /重新读取列表/)
  assert.equal(failedReload.photos.length, 0, '没有把旧数据当成新结果')
  assert.match(failedReload.notice?.text ?? '', /已把这张原图添加/, '提交事实仍然是成功提示')

  // 提交后刷新失败期间，任何写操作都被挡住：只允许重试读取。
  assert.equal(await operation.attach(12), 'blocked')
  assert.equal(await operation.detach(11), 'blocked')
  assert.equal(calls.attach, 1, '没有重复添加')
  assert.equal(calls.detach, 0)

  await operation.refresh()
  const recovered = operation.getState()
  assert.equal(recovered.staleAfterCommit, null, '重试成功之后解除「只能刷新」限制')
  assert.deepEqual(recovered.photos.map((item) => item.attempt.id), [11])
  assert.equal(recovered.notice?.text, failedReload.notice?.text, '重试刷新不清掉「已添加」的事实')
})

test('卸载之后迟到的旧读回被忽略，不再通知界面', async () => {
  const pending = deferred()
  let listPhotosCalls = 0
  let notifications = 0
  const { deps } = makeDeps({
    listPhotos: async () => {
      listPhotosCalls += 1
      return pending.promise
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: createInitialTaskPhotosState(TASK_ID) })
  operation.subscribe(() => {
    notifications += 1
  })

  const loading = operation.refresh()
  await waitFor(() => listPhotosCalls === 1, '读取没有发起')
  operation.dispose()
  pending.resolve({ taskExists: true, photos: [photo(1)] })
  await loading

  const state = operation.getState()
  assert.equal(state.loaded, false, '卸载后的读回不能把 loaded 改成 true')
  assert.deepEqual(state.photos, [])
  assert.equal(notifications, 1, '只有卸载前那次「开始读取」的通知；之后不再通知')
})

test('切换任务：旧任务的迟到读回不能盖掉新任务的内容', async () => {
  const oldRead = deferred()
  const { deps } = makeDeps({
    listPhotos: async (taskId) => {
      if (taskId === 1) return oldRead.promise
      return { taskExists: true, photos: [photo(22)] }
    },
    listAddable: async (taskId) => {
      if (taskId === 1) return oldRead.promise.then(() => ({ taskExists: true, photos: [] }))
      return { taskExists: true, photos: [attempt(23)] }
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, taskId: 1, state: createInitialTaskPhotosState(1) })

  const oldLoading = operation.refresh()
  await waitFor(() => String(operation.getState().loading) === 'true', '旧任务读取没有开始')
  operation.setTaskId(2)
  await waitFor(() => operation.getState().taskId === 2 && operation.getState().loaded, '新任务读取没有完成')

  const newState = operation.getState()
  assert.deepEqual(newState.photos.map((item) => item.attempt.id), [22])
  assert.deepEqual(newState.candidates.map((item) => item.id), [23])

  oldRead.resolve({ taskExists: true, photos: [photo(99)] })
  await oldLoading
  assert.deepEqual(
    operation.getState().photos.map((item) => item.attempt.id),
    [22],
    '旧任务的迟到读回被忽略',
  )
  assert.equal(operation.getState().taskId, 2)
})

test('任务在读取之后、保存之前被删除：页面切成任务不在，之后写入被挡住', async () => {
  const { deps, calls } = makeDeps({
    attach: async (taskId, attemptId) => {
      calls.attach += 1
      return {
        committed: false,
        idempotent: false,
        taskId,
        attemptId,
        manualRefId: null,
        code: 'TASK_MISSING',
        reason: '任务不在本机。',
      }
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: readyState() })

  await operation.attach(11)
  const state = operation.getState()
  assert.equal(state.taskExists, false)
  assert.deepEqual(state.photos, [])
  assert.match(state.notice?.text ?? '', /任务已经不在本机/)
  assert.equal(await operation.attach(12), 'blocked')
  assert.equal(calls.attach, 1, '任务不在之后没有再尝试写')
})

test('只有手动关联可以解除；解除成功提示原图仍保留在截图库', async () => {
  const { deps, calls } = makeDeps({
    listPhotos: async () => ({ taskExists: true, photos: [] }),
    detach: async (taskId, attemptId) => {
      calls.detach += 1
      return { committed: true, removed: true, taskId, attemptId, code: null, reason: null }
    },
  })
  const operation = createTaskPhotosOperation({
    ...deps,
    state: readyState({
      photos: [photo(11), photo(12, { manual: false, manualRefId: null, otherRelations: ['SOURCE'] })],
    }),
  })

  // 历史只读关联不能被误调解除。
  assert.equal(await operation.detach(12), 'invalid')
  assert.equal(calls.detach, 0)

  await operation.detach(11)
  assert.equal(calls.detach, 1)
  assert.match(operation.getState().notice?.text ?? '', /原图仍保留在截图库/)
  assert.deepEqual(operation.getState().photos, [])
})

test('读取中 / 读取失败时禁止写入；错误态不冒充空列表，也不允许偷偷补写', async () => {
  const { deps, calls } = makeDeps()
  const loadingOperation = createTaskPhotosOperation({ ...deps, state: readyState({ loading: true }) })
  assert.equal(await loadingOperation.attach(11), 'blocked')
  assert.equal(await loadingOperation.detach(11), 'blocked')
  assert.equal(calls.attach, 0)
  assert.equal(calls.detach, 0)

  const errorOperation = createTaskPhotosOperation({
    ...deps,
    state: readyState({ loadError: '读取失败，可能是数据库暂时不可用' }),
  })
  assert.equal(await errorOperation.attach(11), 'blocked')
  assert.equal(await errorOperation.detach(11), 'blocked')
  assert.equal(calls.attach, 0)
  assert.equal(calls.detach, 0)
})

test('写入已提交但 store 全量快照刷新失败：仍是「已保存」，只提示重试读取，不引导重做', async () => {
  const { deps, calls } = makeDeps({
    attach: async (taskId, attemptId) => {
      calls.attach += 1
      return {
        committed: true,
        idempotent: false,
        taskId,
        attemptId,
        manualRefId: 1,
        code: null,
        reason: null,
        refreshError: '任务快照读取失败（测试注入）',
      }
    },
    listPhotos: async () => ({ taskExists: true, photos: [photo(11)] }),
  })
  const operation = createTaskPhotosOperation({ ...deps, state: readyState() })

  await operation.attach(11)
  const committed = operation.getState()
  assert.equal(committed.notice?.tone, 'success', '写入提交这个事实不能被快照刷新失败改写')
  assert.equal(committed.staleAfterCommit, null, '本地列表读回来了，不是本地刷新失败')
  assert.match(committed.commitRefreshWarning ?? '', /已经保存好了/)
  assert.match(committed.commitRefreshWarning ?? '', /任务快照读取失败/)
  assert.equal(await operation.attach(12), 'blocked', '提示期间不再允许写入')
  assert.equal(calls.attach, 1, '没有重复添加')

  await operation.refresh()
  assert.equal(operation.getState().commitRefreshWarning, null, '重新读取成功后解除写入门禁')
})

test('切换任务后，旧任务写入完成不能提前放掉新任务正在进行的 busy 闸门', async () => {
  const oldWrite = deferred()
  const newWrite = deferred()
  let attachCalls = 0
  const { deps } = makeDeps({
    attach: async (taskId) => {
      attachCalls += 1
      return taskId === 1 ? oldWrite.promise : newWrite.promise
    },
    listPhotos: async (taskId) => ({ taskExists: true, photos: taskId === 2 ? [photo(22)] : [] }),
    listAddable: async () => ({ taskExists: true, photos: [] }),
  })
  const operation = createTaskPhotosOperation({
    ...deps,
    taskId: 1,
    state: readyStateFor(1, { photos: [photo(11)] }),
  })

  const first = operation.attach(11)
  operation.setTaskId(2)
  await waitFor(() => operation.getState().taskId === 2 && operation.getState().loaded, '新任务读取没有完成')

  const second = operation.attach(22)
  oldWrite.resolve({
    committed: true,
    idempotent: false,
    taskId: 1,
    attemptId: 11,
    manualRefId: 1,
    code: null,
    reason: null,
  })
  await first
  assert.equal(operation.busy, true, '旧任务完成不能放掉新任务的闸门')
  assert.equal(await operation.attach(23), 'busy')
  assert.equal(attachCalls, 2, '第三次点击没有多写')

  newWrite.resolve({
    committed: true,
    idempotent: false,
    taskId: 2,
    attemptId: 22,
    manualRefId: 2,
    code: null,
    reason: null,
  })
  await second
  assert.equal(operation.busy, false, '当前任务完成后才解除闸门')
})

test('切到无效任务编号：旧任务不再可写，添加 / 解除都被挡住', async () => {
  const { deps, calls } = makeDeps()
  const operation = createTaskPhotosOperation({
    ...deps,
    taskId: 1,
    state: readyStateFor(1, { photos: [photo(11)] }),
  })

  operation.setTaskId(0)
  const state = operation.getState()
  assert.equal(state.taskId, 0)
  assert.equal(state.taskExists, false)
  assert.equal(state.loaded, true)
  assert.deepEqual(state.photos, [])
  assert.equal(await operation.attach(11), 'blocked')
  assert.equal(await operation.detach(11), 'blocked')
  assert.equal(calls.attach, 0)
  assert.equal(calls.detach, 0)
})

test('普通读取失败如实显示错误，重试成功后才恢复；失败期间不冒充空列表', async () => {
  let reads = 0
  const { deps, calls } = makeDeps({
    listPhotos: async () => {
      reads += 1
      if (reads === 1) throw new Error('数据库暂时读不出来')
      return { taskExists: true, photos: [photo(11)] }
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: createInitialTaskPhotosState(TASK_ID) })

  await operation.refresh()
  const failed = operation.getState()
  assert.equal(failed.loaded, true)
  assert.equal(failed.taskExists, true, '读取失败不能被误判成任务不在')
  assert.match(failed.loadError ?? '', /读取这条任务的原图失败/)
  assert.equal(failed.staleAfterCommit, null, '普通读取失败不是「写入后刷新失败」')
  assert.deepEqual(failed.photos, [])
  assert.equal(await operation.attach(11), 'blocked', '读取失败期间不允许写入')
  assert.equal(calls.attach, 0)

  await operation.refresh()
  const recovered = operation.getState()
  assert.equal(recovered.loadError, null)
  assert.deepEqual(recovered.photos.map((item) => item.attempt.id), [11])
})

test('dispose → activate：作废旧快照、清 busy，重新读成功前禁止写入，读成功后恢复', async () => {
  const { deps, calls } = makeDeps()
  const operation = createTaskPhotosOperation({
    ...deps,
    state: readyState({
      photos: [photo(11)],
      busy: true,
      busyAttemptId: 11,
      busyAction: 'attach',
      staleAfterCommit: '旧的很旧的刷新失败',
      commitRefreshWarning: '旧的很旧的任务列表失败',
    }),
  })

  operation.dispose()
  assert.equal(operation.attached, false)
  assert.equal(await operation.attach(11), 'blocked', '卸载之后不能写入')
  assert.equal(calls.attach, 0)

  operation.activate()
  assert.equal(operation.attached, true)
  const reactivated = operation.getState()
  assert.equal(reactivated.loaded, false, '重新挂上必须重新读取')
  assert.deepEqual(reactivated.photos, [], '旧快照被清掉')
  assert.equal(reactivated.loading, false)
  assert.equal(reactivated.busy, false)
  assert.equal(reactivated.busyAttemptId, null)
  assert.equal(reactivated.busyAction, null)
  assert.equal(reactivated.staleAfterCommit, null)
  assert.equal(reactivated.commitRefreshWarning, null)

  assert.equal(await operation.attach(11), 'blocked', '新鲜读取成功之前不允许写入')
  assert.equal(calls.attach, 0)

  await operation.refresh()
  assert.equal(operation.getState().loaded, true)
  assert.equal(await operation.attach(11), 'started')
  assert.equal(calls.attach, 1, '重新读取之后只写一次')
})

test('activate 在已经挂上时是幂等的：不会把已加载的快照清掉', async () => {
  const { deps } = makeDeps({
    listPhotos: async () => ({ taskExists: true, photos: [photo(11)] }),
  })
  const operation = createTaskPhotosOperation({ ...deps, state: createInitialTaskPhotosState(TASK_ID) })
  await operation.refresh()
  const before = operation.getState()
  assert.equal(before.loaded, true)

  operation.activate()
  const after = operation.getState()
  assert.equal(after.loaded, true)
  assert.deepEqual(after.photos.map((item) => item.attempt.id), [11])
  assert.equal(operation.attached, true)
})

test('旧读取跨越 dispose → activate：迟到结果不能改新状态，之后的新鲜读取才生效', async () => {
  const oldRead = deferred()
  let reads = 0
  const { deps } = makeDeps({
    listPhotos: async () => {
      reads += 1
      if (reads === 1) return oldRead.promise
      return { taskExists: true, photos: [photo(22)] }
    },
  })
  const operation = createTaskPhotosOperation({ ...deps, state: createInitialTaskPhotosState(TASK_ID) })

  const oldLoading = operation.refresh()
  await waitFor(() => reads === 1, '旧读取没有开始')
  operation.dispose()
  operation.activate()
  oldRead.resolve({ taskExists: true, photos: [photo(11)] })
  await oldLoading

  const reactivated = operation.getState()
  assert.equal(reactivated.loaded, false, '旧读回不能把重新挂上的状态改成已加载')
  assert.deepEqual(reactivated.photos, [])

  await operation.refresh()
  assert.deepEqual(operation.getState().photos.map((item) => item.attempt.id), [22])
})

test('旧写入跨越 dispose → activate：只完成一次、不改新状态、不提前放掉新写入闸门', async () => {
  const oldWrite = deferred()
  const newWrite = deferred()
  let attachCalls = 0
  const success = (attemptId) => ({
    committed: true,
    idempotent: false,
    taskId: TASK_ID,
    attemptId,
    manualRefId: attemptId,
    code: null,
    reason: null,
  })
  const { deps } = makeDeps({
    attach: async () => {
      attachCalls += 1
      return attachCalls === 1 ? oldWrite.promise : newWrite.promise
    },
    listPhotos: async () => ({ taskExists: true, photos: [] }),
  })
  const operation = createTaskPhotosOperation({ ...deps, state: readyState() })

  const oldPending = operation.attach(11)
  operation.dispose()
  operation.activate()
  await operation.refresh()

  const currentPending = operation.attach(22)
  assert.equal(attachCalls, 2, '新任务只发起一次新的写入')

  oldWrite.resolve(success(11))
  await oldPending
  assert.equal(operation.busy, true, '旧写入完成不能放掉新写入的闸门')
  assert.equal(await operation.attach(33), 'busy')
  assert.equal(attachCalls, 2, '旧写入没有重放，也没有多写第三次')
  assert.equal(operation.getState().notice, null, '旧写入不能改新状态的提示')
  assert.equal(operation.getState().busyAttemptId, 22, '界面仍显示新写入')

  newWrite.resolve(success(22))
  await currentPending
  assert.equal(operation.busy, false)
  assert.match(operation.getState().notice?.text ?? '', /已把这张原图添加/)
})
