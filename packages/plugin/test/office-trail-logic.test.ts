/**
 * 当日轨迹纯逻辑测试（P31）：本地自然日分组、当天正序、空日保留与前翻边界。
 *
 * 为什么单测：跨零点、空日、未来时间戳和坏时间戳最容易把「今天」算错；
 * 这里用显式时区偏移和固定 now 把每条边界钉死，页面接线时不用再猜。
 */
import { describe, expect, it } from 'vitest'
import {
  buildOfficeTrail, officeTrailWindow, stepTrailDay,
  type OfficeTrailEventInput,
} from '../src/client/logic/office-trail.js'

/** 东八区 2026-11-08 12:00。 */
const NOW = Date.UTC(2026, 10, 8, 4, 0)
const OFFSET = 480

/** 按东八区本地时间造一个 UTC 毫秒值。 */
function atLocal(month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(2026, month - 1, day, hour - 8, minute)
}

function event(id: string, at: number, patch: Partial<OfficeTrailEventInput> = {}): OfficeTrailEventInput {
  return { id, botId: 'bot-a', at, text: id, ...patch }
}

describe('buildOfficeTrail：按本地自然日分组', () => {
  it('正例：今天、昨天、前天各归各日，今天事件按时间正序', () => {
    const trail = buildOfficeTrail({
      now: NOW,
      utcOffsetMinutes: OFFSET,
      events: [
        event('today-late', atLocal(11, 8, 18, 0)),
        event('today-early', atLocal(11, 8, 9, 0)),
        event('yesterday', atLocal(11, 7, 23, 30)),
        event('older', atLocal(11, 6, 8, 15)),
      ],
    })
    expect(trail.days.map(day => day.key)).toEqual(['2026-11-08', '2026-11-07', '2026-11-06'])
    expect(trail.days[0]?.events.map(item => item.id)).toEqual(['today-early', 'today-late'])
    expect(trail.days[0]?.events.map(item => item.timeText)).toEqual(['09:00', '18:00'])
    expect(trail.days[1]?.events.map(item => item.id)).toEqual(['yesterday'])
    expect(trail.days[0]?.isToday).toBe(true)
    expect(trail.days[1]?.isToday).toBe(false)
  })

  it('时区偏移决定跨零点事件属于哪一天', () => {
    const crossMidnight = Date.UTC(2026, 10, 7, 16, 30)
    const shanghai = buildOfficeTrail({
      now: NOW, utcOffsetMinutes: 480, events: [event('cross', crossMidnight)],
    })
    const utc = buildOfficeTrail({
      now: Date.UTC(2026, 10, 8, 4, 0), utcOffsetMinutes: 0, events: [event('cross', crossMidnight)],
    })
    expect(shanghai.days[0]?.key).toBe('2026-11-08')
    expect(shanghai.days[0]?.events[0]?.timeText).toBe('00:30')
    expect(utc.days[0]?.key).toBe('2026-11-08')
    expect(utc.days[1]?.key).toBe('2026-11-07')
    expect(utc.days[1]?.events[0]?.id).toBe('cross')
  })

  it('中间没有事件的空日也保留，界面能给出空态', () => {
    const trail = buildOfficeTrail({
      now: NOW, utcOffsetMinutes: OFFSET, events: [event('older', atLocal(11, 6, 9, 0))],
    })
    expect(trail.days.map(day => day.key)).toEqual(['2026-11-08', '2026-11-07', '2026-11-06'])
    expect(trail.days[0]?.events).toEqual([])
    expect(trail.days[1]?.events).toEqual([])
    expect(trail.days[2]?.events).toHaveLength(1)
  })

  it('反例：未来时间与坏时间戳不进入轨迹，分别计数', () => {
    const trail = buildOfficeTrail({
      now: NOW,
      utcOffsetMinutes: OFFSET,
      events: [
        event('future', atLocal(11, 9, 8, 0)),
        event('bad', Number.NaN),
        event('good', atLocal(11, 8, 8, 0)),
      ],
    })
    expect(trail.days[0]?.events.map(item => item.id)).toEqual(['good'])
    expect(trail.dropped).toBe(2)
  })

  it('完全没事件时仍给今天一个空日，不返回空列表', () => {
    const trail = buildOfficeTrail({ now: NOW, utcOffsetMinutes: OFFSET, events: [] })
    expect(trail.days).toHaveLength(1)
    expect(trail.days[0]?.key).toBe('2026-11-08')
    expect(trail.days[0]?.events).toEqual([])
    expect(trail.dropped).toBe(0)
    expect(trail.truncated).toBe(0)
  })

  it('超出回看窗口的事件计数为截断，窗口天数受 maxDays 限制', () => {
    const trail = buildOfficeTrail({
      now: NOW,
      utcOffsetMinutes: OFFSET,
      maxDays: 2,
      events: [event('old', atLocal(11, 3, 9, 0)), event('recent', atLocal(11, 8, 9, 0))],
    })
    expect(trail.days).toHaveLength(2)
    expect(trail.days[0]?.events.map(item => item.id)).toEqual(['recent'])
    expect(trail.truncated).toBe(1)
    expect(trail.days.some(day => day.events.some(item => item.id === 'old'))).toBe(false)
  })

  it('同一时刻按 id 稳定排序', () => {
    const at = atLocal(11, 8, 9, 0)
    const trail = buildOfficeTrail({
      now: NOW, utcOffsetMinutes: OFFSET, events: [event('b', at), event('a', at)],
    })
    expect(trail.days[0]?.events.map(item => item.id)).toEqual(['a', 'b'])
  })
})

describe('日期文案', () => {
  it('今天、昨天用相对说法，更早给月日', () => {
    const trail = buildOfficeTrail({
      now: NOW,
      utcOffsetMinutes: OFFSET,
      events: [
        event('today', atLocal(11, 8, 9, 0)),
        event('yesterday', atLocal(11, 7, 9, 0)),
        event('older', atLocal(11, 5, 9, 0)),
      ],
    })
    expect(trail.days[0]?.label).toBe('今天 · 11 月 8 日')
    expect(trail.days[1]?.label).toBe('昨天 · 11 月 7 日')
    expect(trail.days[2]?.label).toBe('11 月 6 日')
    expect(trail.days[3]?.label).toBe('11 月 5 日')
  })

  it('跨年时补年份', () => {
    const trail = buildOfficeTrail({
      now: Date.UTC(2027, 0, 2, 4, 0),
      utcOffsetMinutes: OFFSET,
      events: [event('last-year', Date.UTC(2026, 11, 30, 1, 0))],
    })
    const older = trail.days.find(day => day.key === '2026-12-30')
    expect(older?.label).toBe('2026 年 12 月 30 日')
  })
})

describe('窗口与前翻边界', () => {
  const trail = buildOfficeTrail({
    now: NOW,
    utcOffsetMinutes: OFFSET,
    events: [
      event('today', atLocal(11, 8, 9, 0)),
      event('yesterday', atLocal(11, 7, 9, 0)),
      event('older', atLocal(11, 6, 9, 0)),
    ],
  })

  it('今天只能前翻，最早一天只能后翻', () => {
    const today = officeTrailWindow(trail, 0)
    expect(today?.canGoOlder).toBe(true)
    expect(today?.canGoNewer).toBe(false)
    const oldest = officeTrailWindow(trail, 2)
    expect(oldest?.canGoOlder).toBe(false)
    expect(oldest?.canGoNewer).toBe(true)
  })

  it('索引越界自动夹住，不抛错', () => {
    expect(officeTrailWindow(trail, 99)?.index).toBe(2)
    expect(officeTrailWindow(trail, -3)?.index).toBe(0)
  })

  it('stepTrailDay 前翻不越过最早一天，后翻不越过今天', () => {
    expect(stepTrailDay(trail, 0, 'older')).toBe(1)
    expect(stepTrailDay(trail, 2, 'older')).toBe(2)
    expect(stepTrailDay(trail, 0, 'newer')).toBe(0)
    expect(stepTrailDay(trail, 1, 'newer')).toBe(0)
  })

  it('空轨迹的窗口返回 null，翻页停在 0', () => {
    const empty = buildOfficeTrail({ now: NOW, utcOffsetMinutes: OFFSET, events: [] })
    expect(officeTrailWindow(empty, 0)?.day.events).toEqual([])
    expect(stepTrailDay(empty, 0, 'older')).toBe(0)
  })
})
