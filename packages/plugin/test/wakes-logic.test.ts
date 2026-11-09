/**
 * 唤醒展示规则测试（交互审查第 4 轮，抬高上限）：
 * hasLiveWake 决定右栏「为什么醒 / 为什么没醒」分区要不要自动展开。
 * 只关心 status 字段，用最小桩对象构造，避免与视图其他字段耦合。
 */
import { describe, expect, it } from 'vitest'
import { hasLiveWake } from '../src/client/logic/wakes.js'
import type { WakeRow, WakeStatus } from '../src/shared/views.js'

/** 按状态造一条最小唤醒桩（hasLiveWake 只读 status）。 */
function wakeWith(status: WakeStatus): WakeRow {
  return { status } as unknown as WakeRow
}

describe('hasLiveWake：有进行中的唤醒才自动展开', () => {
  it('正例：running（正在想和做）与 delivering（正要交给主人）都算进行中', () => {
    expect(hasLiveWake([wakeWith('committed'), wakeWith('running')])).toBe(true)
    expect(hasLiveWake([wakeWith('delivering')])).toBe(true)
  })
  it('反例：已提交 / 未交账 / 出错 / 取消 / 超时等终态不算进行中', () => {
    for (const status of ['committed', 'no_commit', 'error', 'canceled', 'timeout'] as const) {
      expect(hasLiveWake([wakeWith(status)])).toBe(false)
    }
  })
  it('反例：没有唤醒记录时不展开', () => {
    expect(hasLiveWake([])).toBe(false)
  })
  it('不改调用方数组', () => {
    const rows = [wakeWith('committed'), wakeWith('running')]
    hasLiveWake(rows)
    expect(rows.map(w => w.status)).toEqual(['committed', 'running'])
  })
})
