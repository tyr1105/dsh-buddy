/**
 * P76k 办公室的额度装饰（纯函数）：窗口弧的角度与颜色、午休牌的文字与位置、
 * 挂钟下的一行小字；减少动态效果时只画静态的一帧（没有秒针），弧与牌子照常显示。
 *
 * 三种状态的样例都来自 core 的 buildQuotaWindowView（shared/fixture-budget.ts），
 * 不手写视图字段，core 改文字时这里跟着变。
 */
import { describe, expect, it } from 'vitest'
import { OFFICE_SECOND_HAND_COLOR, officeAmbient } from '../src/client/office-pixel/ambient.js'
import { DEFAULT_OFFICE_PALETTE } from '../src/client/office-pixel/palette.js'
import { OFFICE_SEATS } from '../src/client/office-pixel/layout.js'
import {
  OFFICE_QUOTA_WINDOW_MS, QUOTA_ARC_COLORS, clockTextOf, drawQuotaArc, quotaArcOf, quotaClockLabel,
  quotaSignRect, quotaSignText, quotaWindowStartOf,
} from '../src/client/office-pixel/quota-decor.js'
import { fixtureQuotaWindow } from '../src/shared/fixture-budget.js'
import type { OfficePixelFigure } from '../src/client/office-pixel/render.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-11-13T16:00:00+08:00')

describe('P76k 窗口弧的角度与颜色', () => {
  it('从 12 点顺时针走：窗口走了一半是 180 度', () => {
    const arc = quotaArcOf({ now: NOW, windowStartAt: NOW - 2.5 * HOUR, windowMs: 5 * HOUR, light: 'green' })
    expect(arc.angleDeg).toBe(180)
    expect(arc.colorKey).toBe('quotaArcGreen')
  })

  it('刚开窗口是 0 度，超过一圈按一圈（360 度）', () => {
    expect(quotaArcOf({ now: NOW, windowStartAt: NOW, windowMs: 5 * HOUR, light: 'green' }).angleDeg).toBe(0)
    expect(quotaArcOf({ now: NOW, windowStartAt: NOW - 9 * HOUR, windowMs: 5 * HOUR, light: 'yellow' }).angleDeg).toBe(360)
  })

  it('时钟回拨或窗口起点在未来：按 0 处理，不画反向弧', () => {
    expect(quotaArcOf({ now: NOW, windowStartAt: NOW + HOUR, windowMs: 5 * HOUR, light: 'green' }).angleDeg).toBe(0)
  })

  it('画弧时超过一圈或负值也只画 0 到 360 度', () => {
    const count = (angle: number): number => {
      const rects: import('../src/client/office-pixel/pixel-kit.js').PixelRect[] = []
      drawQuotaArc(rects, angle, 'quotaArcGreen', DEFAULT_OFFICE_PALETTE)
      return rects.length
    }
    expect(count(720)).toBe(count(360))
    expect(count(-90)).toBe(0)
  })

  it('四种灯各取一种颜色，互不相同', () => {
    const colors = (['green', 'yellow', 'orange', 'red'] as const).map(light =>
      quotaArcOf({ now: NOW, windowStartAt: NOW, windowMs: 5 * HOUR, light }).colorKey)
    expect(colors).toEqual([QUOTA_ARC_COLORS.green, QUOTA_ARC_COLORS.yellow, QUOTA_ARC_COLORS.orange, QUOTA_ARC_COLORS.red])
    expect(new Set(colors).size).toBe(4)
    // 四种颜色都在调色板里，且都是真实颜色值。
    for (const key of colors) expect(DEFAULT_OFFICE_PALETTE[key]).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('画出来的弧压在当前角度上：90 度时有方块，0 度时没有', () => {
    const half = drawRects(NOW - 1.25 * HOUR)
    expect(half.length).toBeGreaterThan(0)
    // 左半边没有方块（只走了右上四分之一）。
    expect(half.every(rect => rect.x >= 130)).toBe(true)
    expect(drawRects(NOW).length).toBe(0)
  })

  function drawRects(startAt: number) {
    const arc = quotaArcOf({ now: NOW, windowStartAt: startAt, windowMs: 5 * HOUR, light: 'green' })
    const rects: import('../src/client/office-pixel/pixel-kit.js').PixelRect[] = []
    drawQuotaArc(rects, arc.angleDeg, arc.colorKey, DEFAULT_OFFICE_PALETTE)
    return rects
  }
})

describe('P76k 午休牌与挂钟小字', () => {
  it('员工份额用完、真实额度用完：牌上写「{HH:mm} 回来」，取恢复时刻', () => {
    const staffFull = fixtureQuotaWindow('staff_full')
    expect(staffFull.state).toBe('staff_full')
    const clock = clockTextOf(staffFull.resetAt, 'Asia/Shanghai')
    expect(quotaSignText(staffFull, 'Asia/Shanghai')).toBe(`${clock} 回来`)
    expect(quotaSignText(staffFull, 'Asia/Shanghai')).toMatch(/^\d{2}:\d{2} 回来$/)
  })

  it('正常状态不立牌', () => {
    expect(quotaSignText(fixtureQuotaWindow('normal'), 'Asia/Shanghai')).toBeNull()
  })

  it('你自己要用：牌上取你自己要用的结束时刻（来自 holdText）', () => {
    const hold = fixtureQuotaWindow('owner_hold')
    expect(hold.state).toBe('owner_hold')
    const clock = /用到 (\d{2}:\d{2})/.exec(hold.holdText ?? '')?.[1]
    expect(clock).toBeDefined()
    expect(quotaSignText(hold, 'Asia/Shanghai')).toBe(`${clock} 回来`)
  })

  it('没有视图或没有时刻时不写空牌', () => {
    expect(quotaSignText(null, 'Asia/Shanghai')).toBeNull()
    const noReset = { ...fixtureQuotaWindow('staff_full'), resetAt: null, resetText: '' }
    expect(quotaSignText(noReset, 'Asia/Shanghai')).toBeNull()
  })

  it('挂钟下一行：正常与你自己要用写「重置」，真实额度用完写「恢复」', () => {
    const normal = fixtureQuotaWindow('normal')
    const clock = /(\d{2}:\d{2})/.exec(normal.resetText)?.[1]
    expect(quotaClockLabel(normal, 'Asia/Shanghai')).toBe(`额度窗口 ${clock} 重置`)
    expect(quotaClockLabel(fixtureQuotaWindow('owner_hold'), 'Asia/Shanghai')).toContain('重置')
    // 真实额度用完：resetText 是「约 18:30 恢复」，小字跟着写「恢复」（主会话裁定）。
    const exhausted = { ...fixtureQuotaWindow('staff_full'), state: 'exhausted' as const, resetText: '约 18:30 恢复' }
    expect(quotaClockLabel(exhausted, 'Asia/Shanghai')).toBe('额度窗口 18:30 恢复')
    expect(quotaClockLabel(null, 'Asia/Shanghai')).toBeNull()
  })

  it('牌面位置：宽 22，不超过工位宽度的一半，落在桌面上', () => {
    const rect = quotaSignRect(OFFICE_SEATS[0]!)
    expect(rect.w).toBe(22)
    expect(rect.w).toBeLessThanOrEqual(OFFICE_SEATS[0]!.deskWidth / 2)
    expect(rect.x).toBeGreaterThan(OFFICE_SEATS[0]!.deskX)
    expect(rect.x + rect.w).toBeLessThan(OFFICE_SEATS[0]!.deskX + OFFICE_SEATS[0]!.deskWidth)
    expect(rect.y).toBeGreaterThanOrEqual(OFFICE_SEATS[0]!.deskY)
  })

  it('弧的窗口起点由 resetAt 减 5 小时得到；红灯没有可靠起点时为 null', () => {
    const normal = fixtureQuotaWindow('normal')
    expect(quotaWindowStartOf(normal)).toBe(normal.resetAt! - OFFICE_QUOTA_WINDOW_MS)
    expect(quotaWindowStartOf(fixtureQuotaWindow('staff_full'))).toBeNull()
    expect(quotaWindowStartOf(fixtureQuotaWindow('owner_hold'))).toBe(fixtureQuotaWindow('owner_hold').resetAt! - OFFICE_QUOTA_WINDOW_MS)
  })

  it('时刻按设置时区写 HH:mm', () => {
    expect(clockTextOf(NOW, 'Asia/Shanghai')).toBe('16:00')
    expect(clockTextOf(null, 'Asia/Shanghai')).toBeNull()
  })
})

describe('P76k 减少动态效果：弧与牌子照常画，但没有动画', () => {
  const figure: OfficePixelFigure = {
    seatIndex: 0, botId: 'b1', name: '探路',
    appearance: { skin: '#f0c8a0', hair: '#333', shirt: '#7fd8cc', pants: '#445', shoes: '#222', accessory: null } as unknown as OfficePixelFigure['appearance'],
    bubble: { light: 'resting', label: '在休息', short: '休息', tone: 'resting' }, arriving: false, x: 48, y: 162,
  }
  const quota = {
    now: NOW, windowStartAt: NOW - 2.5 * HOUR, windowMs: 5 * HOUR, light: 'green' as const, signText: '17:00 回来',
  }
  const base = {
    timeMs: NOW, moment: { month: 11, day: 13, hour: 16, minute: 0, second: 0 }, figures: [figure], motion: false,
  }

  it('静止时也画弧与牌子', () => {
    const rects = officeAmbient({ ...base, quota })
    expect(rects.some(rect => rect.color === DEFAULT_OFFICE_PALETTE.quotaArcGreen)).toBe(true)
    expect(rects.some(rect => rect.color === DEFAULT_OFFICE_PALETTE.board)).toBe(true)
  })

  it('静止时没有秒针（不做动画）', () => {
    expect(officeAmbient({ ...base, quota }).some(rect => rect.color === OFFICE_SECOND_HAND_COLOR)).toBe(false)
    // 同一天同一时刻，动与不动画出来的秒针只有一处差别；这里只钉住静止时确实没有。
    expect(officeAmbient({ ...base, motion: true, quota }).some(rect => rect.color === OFFICE_SECOND_HAND_COLOR)).toBe(true)
  })

  it('没有额度视图时什么装饰都不画', () => {
    const rects = officeAmbient({ ...base, quota: null })
    expect(rects.some(rect => rect.color === DEFAULT_OFFICE_PALETTE.quotaArcGreen)).toBe(false)
  })
})
