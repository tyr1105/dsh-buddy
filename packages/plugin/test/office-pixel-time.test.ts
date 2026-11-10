/**
 * 像素办公室的时间与动画测试（P54）。
 *
 * 为什么单测：挂钟走不走真实时间、夜里是不是真的天黑、队友的动作是不是只映射真实状态，
 * 这些靠肉眼很难逐条确认。渲染和动画都是纯函数，只要把时间当参数传进去，
 * 就能直接检查下午三点的钟面长什么样，不用真的等到下午三点。
 */
import { describe, expect, it } from 'vitest'
import type { OfficeLight } from '../src/shared/views.js'
import {
  OFFICE_SCREEN_INK, OFFICE_SECOND_HAND_COLOR, OFFICE_SNORE_COLOR, OFFICE_SWEAT_COLOR, officeAmbient, officeCatPose, officeFigureAct,
} from '../src/client/office-pixel/ambient.js'
import { OFFICE_CLOCK } from '../src/client/office-pixel/decor.js'
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH, OFFICE_SEATS } from '../src/client/office-pixel/layout.js'
import {
  DEFAULT_OFFICE_MOMENT, clockHandEnd, clockHourAngle, clockMinuteAngle, officeDayPhase, officeMomentFrom, officeSkyBody, officeSunLean,
  type OfficeMoment,
} from '../src/client/office-pixel/moment.js'
import { drawPixelLine, drawSprite, fillPixelDisc, pushClipped, pushRect, shadeColor, type PixelRect } from '../src/client/office-pixel/pixel-kit.js'
import { DEFAULT_OFFICE_PALETTE as palette, officePixelFrame, type OfficePixelFrame } from '../src/client/office-pixel/render.js'
import { OFFICE_WINDOWS, officeSkyBands, officeWindowPanes } from '../src/client/office-pixel/window-view.js'

/** 造一个时间：只关心时分，其余用默认值。 */
function at(hour: number, minute: number, extra: Partial<OfficeMoment> = {}): OfficeMoment {
  return { ...DEFAULT_OFFICE_MOMENT, hour, minute, ...extra }
}

/** 查某个像素最终显示的颜色：后画的盖住先画的，所以从列表末尾往前找。 */
function colorAt(rects: readonly PixelRect[], x: number, y: number): string | undefined {
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    const rect = rects[index]!
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return rect.color
  }
  return undefined
}

/** 放一个指定状态的队友在 4 号座位：这个位置远离窗光和猫，画面变化只来自这个人。 */
const SEAT = OFFICE_SEATS[4]!
function frameWith(light: OfficeLight, botId = 'bot-a'): OfficePixelFrame {
  return officePixelFrame({ occupants: [{ seatIndex: SEAT.index, botId, name: '阿蓝', light }] })
}

/** 只取这个座位范围内的动画矩形。 */
function seatMotion(light: OfficeLight, timeMs: number, motion = true, botId = 'bot-a'): PixelRect[] {
  const frame = frameWith(light, botId)
  return officeAmbient({ timeMs, moment: DEFAULT_OFFICE_MOMENT, figures: frame.figures, motion }).filter(rect =>
    rect.x >= SEAT.deskX - 12 && rect.x < SEAT.deskX + 62 && rect.y >= SEAT.deskY - 30 && rect.y < SEAT.deskY + 30)
}

describe('挂钟跟着传入的时间走', () => {
  const { cx, cy, hourLength, minuteLength } = OFFICE_CLOCK

  it.each([
    [3, 0, hourLength, 0],
    [6, 0, 0, hourLength],
    [9, 0, -hourLength, 0],
    [12, 0, 0, -hourLength],
  ])('%i 点整，时针指向正确方向，分针朝上', (hour, minute, dx, dy) => {
    const moment = at(hour, minute)
    expect(clockHandEnd(cx, cy, clockHourAngle(moment), hourLength)).toEqual({ x: cx + dx, y: cy + dy })
    expect(clockHandEnd(cx, cy, clockMinuteAngle(moment), minuteLength)).toEqual({ x: cx, y: cy - minuteLength })
    const { rects } = officePixelFrame({ occupants: [], moment })
    // 钟面上真的画出来了，不只是算对了数。
    expect(colorAt(rects, cx + dx, cy + dy)).toBe(palette.outline)
    expect(colorAt(rects, cx, cy - minuteLength)).toBe(palette.outline)
  })

  it('反例：三点整时，九点方向的钟面是空的', () => {
    const { rects } = officePixelFrame({ occupants: [], moment: at(3, 0) })
    expect(colorAt(rects, cx - hourLength, cy)).toBe(palette.clockFace)
  })

  it('时针随分钟慢慢挪，下午和上午的钟面一样', () => {
    expect(clockHourAngle(at(3, 30))).toBe(105)
    expect(clockHourAngle(at(15, 30))).toBe(clockHourAngle(at(3, 30)))
    expect(hourLength).toBeLessThan(minuteLength)
  })

  it('不同时间画出来的钟面不一样', () => {
    expect(officePixelFrame({ occupants: [], moment: at(3, 0) }).rects)
      .not.toEqual(officePixelFrame({ occupants: [], moment: at(4, 20) }).rects)
  })

  it('officeMomentFrom 用的是本地时间', () => {
    const date = new Date(2026, 10, 9, 22, 30, 15)
    expect(officeMomentFrom(date)).toEqual({ month: 11, day: 9, hour: 22, minute: 30, second: 15 })
  })
})

describe('日历显示真实日期', () => {
  const calendar = { x: 166, y: 16, w: 22 }
  it('两位数的日期从左边开始画两个字', () => {
    const { rects } = officePixelFrame({ occupants: [], moment: at(10, 0, { day: 27 }) })
    expect(colorAt(rects, calendar.x + 4, calendar.y + 12)).toBe(palette.outline)
  })
  it('一位数的日期居中，左边是空白', () => {
    const { rects } = officePixelFrame({ occupants: [], moment: at(10, 0, { day: 7 }) })
    expect(colorAt(rects, calendar.x + 4, calendar.y + 12)).toBe(palette.board)
    expect(colorAt(rects, calendar.x + 8, calendar.y + 12)).toBe(palette.outline)
  })
  it('月份写在红色台头上', () => {
    const { rects } = officePixelFrame({ occupants: [], moment: at(10, 0, { month: 3 }) })
    expect(colorAt(rects, calendar.x + 9, calendar.y + 2)).toBe(palette.trim)
  })
})

describe('窗外和光线跟着一天的时间变', () => {
  it.each([
    [4, 59, 'night'], [5, 0, 'dawn'], [6, 59, 'dawn'], [7, 0, 'day'], [16, 59, 'day'], [17, 0, 'dusk'], [18, 59, 'dusk'], [19, 0, 'night'],
  ])('%i:%i 属于 %s', (hour, minute, phase) => {
    expect(officeDayPhase(at(hour, minute))).toBe(phase)
  })

  it('四种天色各不相同', () => {
    const bands = (['dawn', 'day', 'dusk', 'night'] as const).map(phase => officeSkyBands(phase, palette).join(','))
    expect(new Set(bands).size).toBe(4)
  })

  it('只有一个太阳：上午在左窗，下午在右窗，正午被屋顶挡住', () => {
    expect(officeSkyBody(at(8, 0))).toMatchObject({ kind: 'sun', windowIndex: 0 })
    expect(officeSkyBody(at(16, 0))).toMatchObject({ kind: 'sun', windowIndex: 1 })
    expect(officeSkyBody(at(12, 15))).toBeNull()
  })

  it('夜里是月亮，过了零点也接得上', () => {
    expect(officeSkyBody(at(20, 30))).toMatchObject({ kind: 'moon', windowIndex: 0 })
    expect(officeSkyBody(at(3, 0))).toMatchObject({ kind: 'moon', windowIndex: 1 })
  })

  it('阳光上午往右斜、下午往左斜', () => {
    expect(officeSunLean(at(9, 0))).toBeGreaterThan(0)
    expect(officeSunLean(at(16, 0))).toBeLessThan(0)
  })

  it('白天有窗光，楼里没亮灯；夜里没有窗光，灯光加倍，楼里亮灯', () => {
    const day = officePixelFrame({ occupants: [], moment: at(11, 0) }).rects
    const night = officePixelFrame({ occupants: [], moment: at(22, 0) }).rects
    const count = (rects: PixelRect[], color: string): number => rects.filter(rect => rect.color === color).length
    expect(count(day, palette.sunbeamA)).toBeGreaterThan(0)
    expect(count(night, palette.sunbeamA)).toBe(0)
    expect(count(night, palette.lampHalo)).toBe(count(day, palette.lampHalo) * 2)
    expect(count(day, '#ffe08a')).toBe(0)
    expect(count(night, '#ffe08a')).toBeGreaterThan(0)
  })

  it('夜里房间依然明亮：地板和墙面的颜色不变', () => {
    const night = officePixelFrame({ occupants: [], moment: at(23, 0) }).rects
    expect(night.some(rect => rect.color === palette.floorA)).toBe(true)
    expect(night.some(rect => rect.color === palette.wall)).toBe(true)
  })
})

describe('同样的输入永远画出同样的东西', () => {
  it('静态帧和动画层都是确定的', () => {
    const moment = at(15, 42, { second: 7 })
    const frame = officePixelFrame({ occupants: [{ seatIndex: 0, botId: 'bot-a', name: '阿蓝', light: 'working' }], moment })
    expect(officePixelFrame({ occupants: [{ seatIndex: 0, botId: 'bot-a', name: '阿蓝', light: 'working' }], moment })).toEqual(frame)
    const input = { timeMs: 123456, moment, figures: frame.figures, motion: true }
    expect(officeAmbient(input)).toEqual(officeAmbient(input))
  })

  it('动画层的矩形都是落在画布内的整数像素', () => {
    const frame = frameWith('working')
    for (const timeMs of [0, 777, 54321, 91_000, 1_794_236_000_000]) {
      for (const rect of officeAmbient({ timeMs, moment: at(21, 0), figures: frame.figures, motion: true })) {
        expect(Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.w) && Number.isInteger(rect.h)).toBe(true)
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.y).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.w).toBeLessThanOrEqual(OFFICE_PIXEL_WIDTH)
        expect(rect.y + rect.h).toBeLessThanOrEqual(OFFICE_PIXEL_HEIGHT)
      }
    }
  })
})

describe('减少动态效果', () => {
  const frame = frameWith('working')
  it('时间怎么变，动画层都一模一样', () => {
    const still = (timeMs: number): PixelRect[] => officeAmbient({ timeMs, moment: at(10, 10, { second: 40 }), figures: frame.figures, motion: false })
    expect(still(1000)).toEqual(still(987_654_321))
  })
  it('不画秒针；正常模式下秒针指向当前秒', () => {
    const moment = at(10, 10, { second: 15 })
    const still = officeAmbient({ timeMs: 1000, moment, figures: [], motion: false })
    expect(still.some(rect => rect.color === OFFICE_SECOND_HAND_COLOR)).toBe(false)
    const moving = officeAmbient({ timeMs: 1000, moment, figures: [], motion: true })
    expect(colorAt(moving, OFFICE_CLOCK.cx + OFFICE_CLOCK.secondLength, OFFICE_CLOCK.cy)).toBe(OFFICE_SECOND_HAND_COLOR)
  })
})

describe('小人的动作只翻译真实状态', () => {
  it('状态和动作一一对应', () => {
    const expected: Record<OfficeLight, string> = {
      working: 'typing', queued: 'queue', watching: 'scan', waiting: 'ask', blocked: 'alarm', resting: 'sleep',
      offline: 'still', vacant: 'still', unknown: 'still',
    }
    for (const [light, act] of Object.entries(expected)) expect(officeFigureAct(light as OfficeLight)).toBe(act)
  })

  it('工作中的人在打字，屏幕有内容', () => {
    expect(seatMotion('working', 0)).not.toEqual(seatMotion('working', 250))
    expect(seatMotion('working', 0).some(rect => rect.color === OFFICE_SCREEN_INK)).toBe(true)
  })

  it('反例：离线的人一动不动，屏幕上什么都没有', () => {
    expect(seatMotion('offline', 0)).toEqual(seatMotion('offline', 12_500))
    expect(seatMotion('offline', 0).some(rect => rect.color === OFFICE_SCREEN_INK)).toBe(false)
  })

  it('离线时屏幕是灭的，在线时是亮的', () => {
    const screenAt = (frame: OfficePixelFrame): string | undefined => colorAt(frame.rects, SEAT.deskX + 10, SEAT.deskY - 3)
    expect(screenAt(frameWith('offline'))).toBe(palette.screen)
    expect(screenAt(frameWith('resting'))).toBe(palette.screenOn)
  })

  it('只有受阻的人流汗', () => {
    expect(seatMotion('blocked', 0).some(rect => rect.color === OFFICE_SWEAT_COLOR)).toBe(true)
    for (const light of ['working', 'resting', 'waiting'] as const) {
      expect(seatMotion(light, 0).some(rect => rect.color === OFFICE_SWEAT_COLOR)).toBe(false)
    }
  })

  it('只有休息的人飘 z', () => {
    expect(seatMotion('resting', 0).some(rect => rect.color === OFFICE_SNORE_COLOR)).toBe(true)
    for (const light of ['working', 'blocked', 'offline'] as const) {
      expect(seatMotion(light, 0).some(rect => rect.color === OFFICE_SNORE_COLOR)).toBe(false)
    }
  })

  it('排队和盯守的屏幕会变化，等待确认的屏幕有问号', () => {
    expect(seatMotion('queued', 0)).not.toEqual(seatMotion('queued', 500))
    expect(seatMotion('watching', 0)).not.toEqual(seatMotion('watching', 500))
    expect(seatMotion('waiting', 0).some(rect => rect.color === OFFICE_SCREEN_INK)).toBe(true)
  })

  it('两个人不会同时眨眼', () => {
    // 找一个 A 正在眨眼的时刻，B 这时不应该也在眨眼（画面不同说明节奏被 id 错开了）。
    const differs = [...Array(200).keys()].some(step => {
      const timeMs = 1000 + step * 50
      return JSON.stringify(seatMotion('waiting', timeMs, true, 'bot-a')) !== JSON.stringify(seatMotion('waiting', timeMs, true, 'bot-long-id-b'))
    })
    expect(differs).toBe(true)
  })
})

describe('窗外的云不盖窗框和百叶帘', () => {
  it('三块玻璃都在窗内，互不重叠', () => {
    for (const spec of OFFICE_WINDOWS) {
      const panes = officeWindowPanes(spec)
      expect(panes).toHaveLength(3)
      for (const pane of panes) {
        expect(pane.x).toBeGreaterThanOrEqual(spec.x)
        expect(pane.x + pane.w).toBeLessThanOrEqual(spec.x + spec.w)
        expect(pane.y).toBeGreaterThan(spec.y)
        expect(pane.y + pane.h).toBeLessThanOrEqual(spec.y + spec.h)
      }
      expect(panes[0]!.x + panes[0]!.w).toBeLessThanOrEqual(panes[1]!.x)
      expect(panes[1]!.x + panes[1]!.w).toBeLessThanOrEqual(panes[2]!.x)
    }
  })

  it('云只落在玻璃里', () => {
    const allPanes = OFFICE_WINDOWS.flatMap(officeWindowPanes)
    const clouds = officeAmbient({ timeMs: 40_000, moment: at(11, 0), figures: [], motion: true })
      .filter(rect => rect.color === '#ffffff' && rect.y < 60)
    expect(clouds.length).toBeGreaterThan(0)
    for (const cloud of clouds) {
      expect(allPanes.some(pane => cloud.x >= pane.x && cloud.x + cloud.w <= pane.x + pane.w && cloud.y >= pane.y && cloud.y + cloud.h <= pane.y + pane.h)).toBe(true)
    }
  })
})

describe('办公室的猫按固定日程活动', () => {
  it('先睡觉，再起身，走过去，坐一会儿，再走回来', () => {
    expect(officeCatPose(0).pose).toBe('sleep')
    expect(officeCatPose(83_000).pose).toBe('sit')
    const going = officeCatPose(100_000)
    expect(going.pose).toBe('walk')
    expect(going.flip).toBe(false)
    expect(officeCatPose(120_000).pose).toBe('sit')
    const back = officeCatPose(140_000)
    expect(back.pose).toBe('walk')
    expect(back.flip).toBe(true)
  })
  it('一轮结束回到原处，同一时刻永远一样', () => {
    expect(officeCatPose(150_000)).toEqual(officeCatPose(0))
    expect(officeCatPose(1_794_236_000_000)).toEqual(officeCatPose(1_794_236_000_000))
  })
})

describe('画图小工具', () => {
  it('pushRect 把超出画布的部分裁掉，完全在外面就不画', () => {
    const rects: PixelRect[] = []
    pushRect(rects, -5, -5, 10, 10, '#111111')
    pushRect(rects, 500, 0, 10, 10, '#222222')
    expect(rects).toEqual([{ x: 0, y: 0, w: 5, h: 5, color: '#111111' }])
  })

  it('pushClipped 只保留裁剪区里的部分', () => {
    const rects: PixelRect[] = []
    pushClipped(rects, 0, 0, 10, 10, '#111111', { x: 4, y: 4, w: 2, h: 20 })
    expect(rects).toEqual([{ x: 4, y: 4, w: 2, h: 6, color: '#111111' }])
  })

  it('字符画：点号透明，连续同色并成一块，翻转后左右对调', () => {
    const rects: PixelRect[] = []
    drawSprite(rects, 10, 20, ['aa.b'], { a: '#aaaaaa', b: '#bbbbbb' })
    expect(rects).toEqual([
      { x: 10, y: 20, w: 2, h: 1, color: '#aaaaaa' },
      { x: 13, y: 20, w: 1, h: 1, color: '#bbbbbb' },
    ])
    const flipped: PixelRect[] = []
    drawSprite(flipped, 10, 20, ['aa.b'], { a: '#aaaaaa', b: '#bbbbbb' }, { flip: true })
    expect(flipped).toEqual([
      { x: 12, y: 20, w: 2, h: 1, color: '#aaaaaa' },
      { x: 10, y: 20, w: 1, h: 1, color: '#bbbbbb' },
    ])
  })

  it('直线包含两个端点，圆左右对称', () => {
    const line: PixelRect[] = []
    drawPixelLine(line, 10, 10, 15, 13, '#111111')
    expect(colorAt(line, 10, 10)).toBe('#111111')
    expect(colorAt(line, 15, 13)).toBe('#111111')
    const disc: PixelRect[] = []
    fillPixelDisc(disc, 50, 50, 4, '#111111')
    for (const rect of disc) expect(rect.x - 50).toBe(50 - (rect.x + rect.w - 1))
  })

  it('shadeColor 调亮调暗，半透明色原样返回', () => {
    expect(shadeColor('#808080', 0.5)).toBe('#404040')
    expect(shadeColor('#ffffff', 2)).toBe('#ffffff')
    expect(shadeColor('rgba(0, 0, 0, 0.5)', 0.5)).toBe('rgba(0, 0, 0, 0.5)')
  })
})
