/**
 * 倒带轨道展示规则测试（交互审查第 6 轮，抬高上限）：
 * - framePercent：时刻到轨道百分比的换算与钳制；
 * - buildReplayTrack：帧成刻度、断点成色带（延伸到下一帧或现在），乱序/越界输入防御；
 * - previousFrameAt / nextFrameAt：键盘在「有记录的时刻」之间步进，到头返回 null。
 */
import { describe, expect, it } from 'vitest'
import {
  buildReplayTrack, framePercent, nextFrameAt, previousFrameAt,
  type ReplayTrackItem,
} from '../src/client/logic/replay-track.js'

/** 造一个帧或断点桩；时间用相对当天零点的毫秒数。 */
function item(id: string, offsetMs: number, kind: 'frame' | 'gap' = 'frame', reason: string | null = null): ReplayTrackItem {
  return { id, at: offsetMs, kind, reason }
}

const HOUR = 3_600_000
const DAY_START = 1_000_000_000_000
const NOW = DAY_START + 10 * HOUR

describe('framePercent：时刻换算成轨道位置', () => {
  it('正例：零点在 0、当前时刻在 100、中点在 50', () => {
    expect(framePercent(DAY_START, DAY_START, NOW)).toBe(0)
    expect(framePercent(NOW, DAY_START, NOW)).toBe(100)
    expect(framePercent(DAY_START + 5 * HOUR, DAY_START, NOW)).toBe(50)
  })
  it('反例：早于零点或晚于现在都钳在轨道内，不出现负位置/溢出', () => {
    expect(framePercent(DAY_START - HOUR, DAY_START, NOW)).toBe(0)
    expect(framePercent(NOW + HOUR, DAY_START, NOW)).toBe(100)
  })
  it('边界：dayStart 与 now 相同（极端空天）时不除零，返回 0', () => {
    expect(framePercent(NOW, NOW, NOW)).toBe(0)
  })
})

describe('buildReplayTrack：帧成刻度，断点成色带', () => {
  it('正例：三个帧得到三个刻度，位置按时间换算', () => {
    const track = buildReplayTrack(
      [item('f1', DAY_START + 2 * HOUR), item('f2', DAY_START + 4 * HOUR), item('f3', DAY_START + 8 * HOUR)],
      DAY_START, NOW,
    )
    expect(track.ticks.map(t => t.id)).toEqual(['f1', 'f2', 'f3'])
    expect(track.ticks.map(t => t.left)).toEqual([20, 40, 80])
    expect(track.gaps).toEqual([])
  })
  it('正例：首帧之前的断面色带从断点延伸到下一帧', () => {
    const track = buildReplayTrack(
      [item('g1', DAY_START + 1 * HOUR, 'gap', '中心已停止'), item('f1', DAY_START + 3 * HOUR)],
      DAY_START, NOW,
    )
    expect(track.gaps).toHaveLength(1)
    expect(track.gaps[0]!.left).toBe(10)
    expect(track.gaps[0]!.width).toBeCloseTo(20, 5)
    expect(track.gaps[0]!.reason).toBe('中心已停止')
  })
  it('正例：最后一帧之后的断面色带延伸到当前时刻', () => {
    const track = buildReplayTrack(
      [item('f1', DAY_START + 6 * HOUR), item('g2', DAY_START + 9 * HOUR, 'gap', '记录失败')],
      DAY_START, NOW,
    )
    expect(track.gaps[0]!.left).toBe(90)
    expect(track.gaps[0]!.width).toBeCloseTo(10, 5)
  })
  it('反例：越界点被丢弃，乱序输入也按时间排列', () => {
    const track = buildReplayTrack(
      [item('f2', DAY_START + 8 * HOUR), item('late', NOW + HOUR), item('early', DAY_START - HOUR), item('f1', DAY_START + 2 * HOUR)],
      DAY_START, NOW,
    )
    expect(track.ticks.map(t => t.id)).toEqual(['f1', 'f2'])
  })
  it('不修改调用方数组', () => {
    const rows = [item('f2', DAY_START + 8 * HOUR), item('f1', DAY_START + 2 * HOUR)]
    buildReplayTrack(rows, DAY_START, NOW)
    expect(rows.map(r => r.id)).toEqual(['f2', 'f1'])
  })
})

describe('previousFrameAt / nextFrameAt：键盘在帧之间步进', () => {
  const frames = [item('f1', DAY_START + 2 * HOUR), item('f2', DAY_START + 5 * HOUR), item('f3', DAY_START + 9 * HOUR)]
  it('正例：落在空档时，左键找上一帧、右键找下一帧', () => {
    expect(previousFrameAt(frames, DAY_START + 6 * HOUR)).toBe(DAY_START + 5 * HOUR)
    expect(nextFrameAt(frames, DAY_START + 6 * HOUR)).toBe(DAY_START + 9 * HOUR)
  })
  it('正例：正停在一帧上，再按一次走到相邻帧（不含当前时刻）', () => {
    expect(previousFrameAt(frames, DAY_START + 5 * HOUR)).toBe(DAY_START + 2 * HOUR)
    expect(nextFrameAt(frames, DAY_START + 5 * HOUR)).toBe(DAY_START + 9 * HOUR)
  })
  it('反例：断点不算可落的时刻', () => {
    const withGap = [item('g0', DAY_START + 3 * HOUR, 'gap'), ...frames]
    expect(nextFrameAt(withGap, DAY_START + 2.5 * HOUR)).toBe(DAY_START + 5 * HOUR)
  })
  it('反例：已经到头返回 null，由界面决定不移动', () => {
    expect(previousFrameAt(frames, DAY_START)).toBeNull()
    expect(nextFrameAt(frames, NOW)).toBeNull()
  })
})
