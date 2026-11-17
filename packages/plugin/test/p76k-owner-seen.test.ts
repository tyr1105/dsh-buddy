/**
 * P76k 上报「你正在看」的节奏：挂载一次、之后每 5 分钟一次、由隐藏变可见时立刻一次、隐藏时停。
 * 用 vitest 的假计时器推进，不依赖真等 5 分钟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_SEEN_INTERVAL_MS, createOwnerSeenReporter } from '../src/client/logic/owner-seen.js'

describe('P76k ownerSeen 的上报节奏', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('间隔与 core 一样是 5 分钟', () => {
    expect(OWNER_SEEN_INTERVAL_MS).toBe(5 * 60 * 1000)
  })

  it('挂载时一次；之后每 5 分钟一次', () => {
    let count = 0
    const reporter = createOwnerSeenReporter({ report: () => { count += 1 }, hidden: () => false })
    // 页面挂载时的顺序：先报一次，再按间隔开始。
    reporter.reportNow()
    reporter.start()
    expect(count).toBe(1)
    vi.advanceTimersByTime(5 * 60 * 1000 - 1)
    expect(count).toBe(1)
    vi.advanceTimersByTime(1)
    expect(count).toBe(2)
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(count).toBe(4)
    reporter.stop()
  })

  it('页面隐藏时停止上报', () => {
    let count = 0
    let hidden = false
    const reporter = createOwnerSeenReporter({ report: () => { count += 1 }, hidden: () => hidden })
    reporter.reportNow()
    reporter.start()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(count).toBe(2)
    hidden = true
    reporter.onVisibilityChange()
    expect(reporter.isRunning()).toBe(false)
    vi.advanceTimersByTime(30 * 60 * 1000)
    expect(count).toBe(2)
  })

  it('由隐藏变可见时立刻再报一次并恢复间隔', () => {
    let count = 0
    let hidden = true
    const reporter = createOwnerSeenReporter({ report: () => { count += 1 }, hidden: () => hidden })
    // 挂载时页面是隐藏的：只报一次，不开始间隔。
    reporter.reportNow()
    if (!hidden) reporter.start()
    expect(count).toBe(1)
    expect(reporter.isRunning()).toBe(false)
    hidden = false
    reporter.onVisibilityChange()
    expect(count).toBe(2)
    expect(reporter.isRunning()).toBe(true)
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(count).toBe(3)
    reporter.stop()
  })

  it('重复调用 start / stop 不叠加定时器', () => {
    let count = 0
    const reporter = createOwnerSeenReporter({ report: () => { count += 1 }, hidden: () => false })
    reporter.start()
    reporter.start()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(count).toBe(1)
    reporter.stop()
    reporter.stop()
    vi.advanceTimersByTime(5 * 60 * 1000)
    expect(count).toBe(1)
  })

  it('上报函数抛错不会把定时器带崩', () => {
    const reporter = createOwnerSeenReporter({ report: () => { throw new Error('命令失败') }, hidden: () => false })
    expect(() => { reporter.reportNow(); reporter.start() }).not.toThrow()
    expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow()
    reporter.stop()
  })
})
