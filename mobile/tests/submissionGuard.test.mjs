/**
 * 同步提交闸门：真正执行“渲染前连续两次调用”的行为测试。
 *
 * 无 React renderer、无新增依赖；直接验证页面使用的同步 guard：
 * 第一次进入后，第二次在同一个事件循环 / 同一轮渲染之前必须被拒绝；
 * finally 释放后可以再次提交。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createImmediateSubmissionGuard } from '../src/domain/submissionGuard.ts'

test('连续两次同步提交只放行一次；释放后可再次提交', () => {
  const guard = createImmediateSubmissionGuard()
  assert.equal(guard.tryEnter(), true)
  assert.equal(guard.tryEnter(), false, '第二次同步调用必须在 state 渲染前被拒绝')
  assert.equal(guard.busy, true)
  guard.release()
  assert.equal(guard.busy, false)
  assert.equal(guard.tryEnter(), true, 'finally 释放后允许用户重试')
  guard.release()
})

test('两次并发异步提交（中间没有重新渲染）只执行一次副作用', async () => {
  const guard = createImmediateSubmissionGuard()
  let writes = 0
  let resolveFirst
  const firstGate = new Promise((resolve) => {
    resolveFirst = resolve
  })
  const submit = async () => {
    if (!guard.tryEnter()) return false
    try {
      writes += 1
      await firstGate
      return true
    } finally {
      guard.release()
    }
  }
  const first = submit()
  const second = submit()
  assert.equal(writes, 1, '第二个提交不能在第一次等待期间再次写入')
  resolveFirst()
  const results = await Promise.all([first, second])
  assert.deepEqual(results, [true, false])
  assert.equal(writes, 1)
  assert.equal(guard.busy, false)
})

test('抛错也在 finally 释放，不会永久锁死', async () => {
  const guard = createImmediateSubmissionGuard()
  const submit = async () => {
    if (!guard.tryEnter()) return false
    try {
      throw new Error('模拟写入失败')
    } finally {
      guard.release()
    }
  }
  await assert.rejects(() => submit(), /模拟写入失败/)
  assert.equal(guard.busy, false)
  assert.equal(guard.tryEnter(), true)
  guard.release()
})
