/** tick 心跳防重入与清理测试。 */
import { describe, expect, it, vi } from 'vitest'
import { createTickScheduler } from '../src/host/tick.js'

function deferredHub() {
  const calls: Array<() => void> = []
  return {
    calls,
    tick: () => new Promise<void>(resolve => { calls.push(resolve) }),
  }
}

describe('createTickScheduler', () => {
  it('上一轮 tick 未结束时跳过本次（防重入）', async () => {
    const hub = deferredHub()
    const scheduler = createTickScheduler(hub, 1)
    scheduler.start()
    await new Promise(r => setTimeout(r, 5))
    expect(hub.calls.length).toBe(1)   // 第二次间隔因重入被跳过
    hub.calls[0]!()                    // 放行第一轮
    await new Promise(r => setTimeout(r, 5))
    expect(hub.calls.length).toBe(2)   // 下一轮恢复
    scheduler.stop()
  })
  it('stop 后不再触发', async () => {
    const hub = deferredHub()
    const scheduler = createTickScheduler(hub, 1)
    scheduler.start()
    await new Promise(r => setTimeout(r, 3))
    hub.calls[0]!()
    scheduler.stop()
    const before = hub.calls.length
    await new Promise(r => setTimeout(r, 8))
    expect(hub.calls.length).toBe(before)
  })
  it('tick 拒绝时兜住（不产生未处理拒绝），下一轮照常被调用（D07 第 28 条：真的数了次数）', async () => {
    let shouldFail = true
    let calls = 0
    const hub = { tick: () => { calls += 1; return shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve() } }
    const scheduler = createTickScheduler(hub, 1)
    scheduler.start()
    await new Promise(r => setTimeout(r, 5))
    expect(scheduler.isTicking()).toBe(false)
    const failedAt = calls
    shouldFail = false
    await new Promise(r => setTimeout(r, 8))
    scheduler.stop()
    // 失败后下一轮照常被调用（不能失败一次就 clearInterval / 永不再跑）。
    expect(calls).toBeGreaterThanOrEqual(failedAt + 2)
  })
  it('tick 同步抛错也兜住（D05 第 18 条：Promise.resolve(hub.tick()) 接不住同步异常）', async () => {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args[0]) }
    let calls = 0
    let scheduler: ReturnType<typeof createTickScheduler> | null = null
    try {
      const hub = { tick: () => { calls += 1; throw new Error('tick 同步抛错') } }
      scheduler = createTickScheduler(hub, 1)
      scheduler.start()
      await new Promise(r => setTimeout(r, 5))
      scheduler.stop()
    } finally { console.error = original }
    expect(calls).toBeGreaterThanOrEqual(1)      // 调度器照常跑了
    expect(scheduler!.isTicking()).toBe(false)    // 防重入标志被 finally 复位
    expect(errors.length).toBeGreaterThanOrEqual(1) // 异常被兜住并记日志，进程没崩
  })
})
