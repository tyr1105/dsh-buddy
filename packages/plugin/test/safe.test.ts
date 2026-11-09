/** safe()：同步抛错与异步拒绝都被吞并记录、一律返回 undefined（verified-T1 Q4）。 */
import { describe, expect, it, vi } from 'vitest'
import { safe } from '../src/host/safe.js'

describe('safe()', () => {
  it('正常执行时不影响返回……不，一律返回 undefined（避免 serial/bail 短路）', () => {
    const fn = safe('ok', () => 42)
    expect(fn()).toBe(undefined)
  })
  it('同步抛错被吞并记录日志', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = safe('boom', () => { throw new Error('爆炸') })
    expect(() => fn()).not.toThrow()
    expect(fn()).toBe(undefined)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
  it('异步拒绝被吞并记录日志（不成为未处理拒绝）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fn = safe('async-boom', async () => { throw new Error('异步爆炸') })
    expect(fn()).toBe(undefined)
    await new Promise((r) => setTimeout(r, 0))
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
  it('异步成功也不返回值', async () => {
    const fn = safe('async-ok', async () => '值')
    expect(fn()).toBe(undefined)
    await new Promise((r) => setTimeout(r, 0))
  })
  it('参数原样透传给被包装函数', () => {
    const seen: unknown[] = []
    const fn = safe('args', (...args: unknown[]) => { seen.push(...args) })
    fn(1, 'a', { b: 2 })
    expect(seen).toEqual([1, 'a', { b: 2 }])
  })
})
