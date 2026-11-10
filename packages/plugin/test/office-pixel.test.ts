/**
 * 像素办公室渲染核心测试（P30）：固定布局、id 固定外观、状态气泡与整帧绘制。
 *
 * 为什么单测：办公室被定成「真实状态的投影」，座位、外观和气泡任何一项
 * 跟着随机数或渲染顺序漂移，都会让主人认错人、看错状态。这里用纯函数把
 * 这些规则逐条钉死，页面接线前就能验收。
 */
import { describe, expect, it } from 'vitest'
import type { OfficeLight } from '../src/shared/views.js'
import {
  OFFICE_AISLE, OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH, OFFICE_SEATS,
  OFFICE_SHARED_SPOTS, officeSeatAt,
} from '../src/client/office-pixel/layout.js'
import {
  OFFICE_ACCENT_COLORS, OFFICE_ACCESSORIES, OFFICE_HAIR_COLORS, OFFICE_HAIR_STYLES,
  OFFICE_PANTS, OFFICE_SHIRTS, OFFICE_SKINS, officeAppearance, officeHash,
} from '../src/client/office-pixel/appearance.js'
import { officeBubble } from '../src/client/office-pixel/bubble.js'
import {
  DEFAULT_OFFICE_PALETTE, OFFICE_BUBBLE_TONES, officePixelFrame, paintOfficeFrame,
  type OfficePalette,
} from '../src/client/office-pixel/render.js'
import { OFFICE_SUN_COLOR } from '../src/client/office-pixel/window-view.js'

describe('固定布局：两排三列，空位也留桌椅', () => {
  it('正好六个工位，两排三列，序号唯一', () => {
    expect(OFFICE_SEATS).toHaveLength(6)
    expect(new Set(OFFICE_SEATS.map(seat => seat.index)).size).toBe(6)
    expect(OFFICE_SEATS.filter(seat => seat.row === 0)).toHaveLength(3)
    expect(OFFICE_SEATS.filter(seat => seat.row === 1)).toHaveLength(3)
  })

  it('工位、共享区与过道都在 480x270 画布内', () => {
    for (const seat of OFFICE_SEATS) {
      expect(seat.deskX).toBeGreaterThanOrEqual(0)
      expect(seat.deskY).toBeGreaterThanOrEqual(0)
      expect(seat.deskX + seat.deskWidth).toBeLessThanOrEqual(OFFICE_PIXEL_WIDTH)
      expect(seat.deskY + seat.deskHeight).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
      expect(seat.standY).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
    }
    for (const spot of OFFICE_SHARED_SPOTS) {
      expect(spot.x).toBeGreaterThanOrEqual(0)
      expect(spot.y).toBeGreaterThanOrEqual(0)
      expect(spot.x + spot.width).toBeLessThanOrEqual(OFFICE_PIXEL_WIDTH)
      expect(spot.y + spot.height).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
    }
    expect(OFFICE_AISLE.x + OFFICE_AISLE.width).toBeLessThanOrEqual(OFFICE_PIXEL_WIDTH)
    expect(OFFICE_AISLE.y + OFFICE_AISLE.height).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
  })

  it('过道不压住任何一排桌子', () => {
    for (const seat of OFFICE_SEATS) {
      const overlaps = seat.deskY < OFFICE_AISLE.y + OFFICE_AISLE.height &&
        seat.deskY + seat.deskHeight > OFFICE_AISLE.y
      expect(overlaps).toBe(false)
    }
  })

  it('officeSeatAt 只接受有效整数序号，越界返回 null', () => {
    expect(officeSeatAt(0)?.index).toBe(0)
    expect(officeSeatAt(5)?.index).toBe(5)
    expect(officeSeatAt(-1)).toBeNull()
    expect(officeSeatAt(6)).toBeNull()
    expect(officeSeatAt(1.5)).toBeNull()
  })
})

describe('固定外观：同一个 id 永远同一套，且全部来自色板', () => {
  it('同一 id 连续两次完全一致，空 id 也稳定', () => {
    expect(officeAppearance('bot-a')).toEqual(officeAppearance('bot-a'))
    expect(officeAppearance('')).toEqual(officeAppearance(''))
    expect(officeHash('bot-a')).toBe(officeHash('bot-a'))
  })

  it('头发、肤色、衣服、配饰、裤子都落在公开色板里', () => {
    for (const id of ['bot-a', 'bot-b', 'bot-c', '', '队友-1']) {
      const look = officeAppearance(id)
      expect(OFFICE_HAIR_STYLES).toContain(look.hair)
      expect(OFFICE_HAIR_COLORS).toContain(look.hairColor)
      expect(OFFICE_SKINS).toContain(look.skin)
      expect(OFFICE_SHIRTS).toContain(look.shirt)
      expect(OFFICE_ACCESSORIES).toContain(look.accessory)
      expect(OFFICE_ACCENT_COLORS).toContain(look.accessoryColor)
      expect(OFFICE_PANTS).toContain(look.pants)
    }
  })

  it('不同 id 至少能分出两种外观，不是所有人都穿同一套', () => {
    const ids = ['bot-a', 'bot-b', 'bot-c', 'bot-d', 'bot-e', 'bot-f']
    const shirts = new Set(ids.map(id => officeAppearance(id).shirt))
    expect(shirts.size).toBeGreaterThan(1)
  })
})

describe('头顶气泡：只映射九种真实状态', () => {
  it('在跑、在等、受阻、休息、离线、未知各有正确色调', () => {
    expect(officeBubble('working').tone).toBe('working')
    expect(officeBubble('queued').tone).toBe('working')
    expect(officeBubble('watching').tone).toBe('working')
    expect(officeBubble('waiting').tone).toBe('waiting')
    expect(officeBubble('blocked').tone).toBe('blocked')
    expect(officeBubble('resting').tone).toBe('resting')
    expect(officeBubble('offline').tone).toBe('offline')
    expect(officeBubble('unknown').tone).toBe('unknown')
  })

  it('空位说「空位」，不冒充离线；所有文案都短于五个字', () => {
    expect(officeBubble('vacant').label).toBe('空位')
    const lights: OfficeLight[] = ['working', 'queued', 'waiting', 'blocked', 'resting', 'watching', 'offline', 'vacant', 'unknown']
    for (const light of lights) {
      const bubble = officeBubble(light)
      expect(bubble.light).toBe(light)
      expect(bubble.label.length).toBeGreaterThan(0)
      expect(bubble.short.length).toBeLessThanOrEqual(4)
    }
  })

  it('反例：waiting 与 blocked 不会共用同一种气泡', () => {
    expect(officeBubble('waiting').tone).not.toBe(officeBubble('blocked').tone)
    expect(officeBubble('waiting').label).not.toBe(officeBubble('blocked').label)
  })
})

describe('墙面陈设与地面光影（P36 画面补强）', () => {
  const palette = DEFAULT_OFFICE_PALETTE
  const frame = officePixelFrame({ occupants: [] })

  it('两扇窗分居工位区与共享区，窗外有天空、远楼和太阳', () => {
    const sky = frame.rects.filter(rect => rect.color === palette.windowSky)
    expect(sky.length).toBeGreaterThanOrEqual(2)
    expect(sky.some(rect => rect.x < 234)).toBe(true)
    expect(sky.some(rect => rect.x > 234)).toBe(true)
    expect(frame.rects.filter(rect => rect.color === palette.windowSkyDeep).length).toBeGreaterThanOrEqual(2)
    // 默认十点十分：只有一个太阳，这个时间在工作区那扇窗里。
    const sun = frame.rects.filter(rect => rect.color === OFFICE_SUN_COLOR)
    expect(sun.length).toBeGreaterThan(0)
    expect(sun.every(rect => rect.x < 234 && rect.y < 86)).toBe(true)
  })

  it('挂钟、公告栏、吸顶灯与立柱都在墙带内，且高度错开', () => {
    const clock = frame.rects.find(rect => rect.color === palette.clockFace)
    expect(clock).toBeDefined()
    expect(clock!.y + clock!.h).toBeLessThanOrEqual(86)
    const cork = frame.rects.filter(rect => rect.color === palette.cork)
    expect(cork).toHaveLength(1)
    // 公告栏在共享区，不跟工位区的窗、钟挤在一起。
    expect(cork[0]!.x).toBeGreaterThanOrEqual(234)
    // 吸顶灯板都用灯色，而且都在墙带以内，地面的物件不许用这个颜色。
    const bulbs = frame.rects.filter(rect => rect.color === palette.lampBulb)
    expect(bulbs.length).toBeGreaterThanOrEqual(3)
    expect(bulbs.every(rect => rect.y < 86)).toBe(true)
    // 立柱是一根贯通墙面的竖条，不是又一件小摆设。
    expect(frame.rects.some(rect => rect.color === palette.metal && rect.h >= 60 && rect.y === 0)).toBe(true)
    // 墙饰顶边至少两种高度，避免排成一条。
    const tops = new Set([clock!.y, cork[0]!.y, ...bulbs.map(rect => rect.y)])
    expect(tops.size).toBeGreaterThan(1)
  })

  it('地面光影只铺在地板上，并在家具之前绘制', () => {
    const shade = frame.rects.findIndex(rect => rect.color === palette.floorShade)
    const lift = frame.rects.findIndex(rect => rect.color === palette.floorLift)
    const beam = frame.rects.findIndex(rect => rect.color === palette.sunbeamA)
    const desk = frame.rects.findIndex(rect => rect.color === palette.desk)
    expect(shade).toBeGreaterThan(-1)
    expect(lift).toBeGreaterThan(shade)
    expect(frame.rects[shade]!.x).toBe(0)
    expect(frame.rects[lift]!.x).toBeGreaterThan(0)
    expect(beam).toBeGreaterThan(lift)
    // 桌子在光影之后画：光斑不会给桌面和小人蒙色。
    expect(desk).toBeGreaterThan(beam)
    const lightColors = new Set([palette.sunbeamA, palette.sunbeamB, palette.lampHalo, palette.lampGlow])
    const lightRects = frame.rects.filter(rect => lightColors.has(rect.color))
    expect(lightRects.length).toBeGreaterThan(0)
    expect(lightRects.every(rect => rect.y >= 86)).toBe(true)
  })

  it('六个工位与小人的固定坐标不受墙饰影响', () => {
    const seated = officePixelFrame({
      occupants: OFFICE_SEATS.map(seat => ({
        seatIndex: seat.index, botId: `bot-${seat.index}`, name: `队友${seat.index}`, light: 'working' as OfficeLight,
      })),
    })
    expect(seated.figures).toHaveLength(6)
    expect(seated.figures.map(figure => [figure.x, figure.y]))
      .toEqual(OFFICE_SEATS.map(seat => [seat.seatX, seat.standY]))
  })
})

describe('整帧绘制', () => {
  it('没人时六个工位桌椅都在，没有小人也没有警告', () => {
    const frame = officePixelFrame({ occupants: [] })
    expect(frame.figures).toEqual([])
    expect(frame.warnings).toEqual([])
    // 每张桌子一块台面 + 一块桌沿，六张桌子至少十二块。
    const deskRects = frame.rects.filter(rect => rect.color === DEFAULT_OFFICE_PALETTE.desk)
    expect(deskRects).toHaveLength(6)
  })

  it('坐下的人有固定外观、真实气泡与亮屏，空位保持熄屏', () => {
    const frame = officePixelFrame({
      occupants: [{ seatIndex: 0, botId: 'bot-a', name: '阿蓝', light: 'working' }],
    })
    expect(frame.figures).toHaveLength(1)
    const figure = frame.figures[0]
    expect(figure?.botId).toBe('bot-a')
    expect(figure?.bubble.label).toBe('正在工作')
    expect(figure?.appearance).toEqual(officeAppearance('bot-a'))
    expect(figure?.x).toBe(OFFICE_SEATS[0]?.seatX)
    expect(frame.rects.some(rect => rect.color === DEFAULT_OFFICE_PALETTE.screenOn)).toBe(true)
    expect(frame.rects.some(rect => rect.color === DEFAULT_OFFICE_PALETTE.screen)).toBe(true)
  })

  it('重复占座只保留第一个人，越界座位跳过并给中文警告', () => {
    const frame = officePixelFrame({
      occupants: [
        { seatIndex: 1, botId: 'bot-first', name: '先来', light: 'resting' },
        { seatIndex: 1, botId: 'bot-second', name: '后到', light: 'working' },
        { seatIndex: 99, botId: 'bot-ghost', name: '幽灵', light: 'unknown' },
      ],
    })
    expect(frame.figures).toHaveLength(1)
    expect(frame.figures[0]?.botId).toBe('bot-first')
    expect(frame.warnings).toHaveLength(2)
    expect(frame.warnings.join('；')).toContain('超出办公室范围')
    expect(frame.warnings.join('；')).toContain('只保留')
  })

  it('所有矩形都落在画布内', () => {
    const frame = officePixelFrame({
      occupants: OFFICE_SEATS.map((seat, index) => ({
        seatIndex: seat.index, botId: `bot-${index}`, name: `队友${index}`, light: 'waiting' as OfficeLight,
      })),
    })
    for (const rect of frame.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.w).toBeGreaterThan(0)
      expect(rect.h).toBeGreaterThan(0)
      expect(rect.x + rect.w).toBeLessThanOrEqual(OFFICE_PIXEL_WIDTH)
      expect(rect.y + rect.h).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
    }
  })

  it('调色板与气泡色可覆盖，布局坐标不变', () => {
    const palette: Partial<OfficePalette> = { floorA: '#010101', desk: '#020202' }
    const frame = officePixelFrame({
      occupants: [{ seatIndex: 0, botId: 'bot-a', name: '阿蓝', light: 'blocked' }],
      palette,
      bubbleTones: { blocked: '#030303' },
    })
    expect(frame.rects.some(rect => rect.color === '#010101')).toBe(true)
    expect(frame.rects.some(rect => rect.color === '#020202')).toBe(true)
    expect(frame.rects.some(rect => rect.color === '#030303')).toBe(true)
    expect(frame.figures[0]?.x).toBe(OFFICE_SEATS[0]?.seatX)
  })

  it('paintOfficeFrame 按顺序把所有矩形刷到目标上', () => {
    const frame = officePixelFrame({
      occupants: [{ seatIndex: 2, botId: 'bot-a', name: '阿蓝', light: 'waiting' }],
    })
    const painted: Array<{ color: string; x: number; y: number; w: number; h: number }> = []
    const target = {
      fillStyle: '' as unknown,
      fillRect(x: number, y: number, w: number, h: number) {
        painted.push({ color: String(this.fillStyle), x, y, w, h })
      },
    }
    paintOfficeFrame(target, frame)
    expect(painted).toHaveLength(frame.rects.length)
    expect(painted[painted.length - 1]?.color).toBe(frame.rects[frame.rects.length - 1]?.color)
    expect(OFFICE_BUBBLE_TONES.waiting).toBeTruthy()
  })
})
