/**
 * P73f：像素办公室的「报到」（设计稿场景 F、方案 4.11）。
 *
 * 全是纯函数测试，时间由测试传入：
 * 1. 气泡：今天入职且灯是空闲类（盯守、休息、排队）时写「报到」；工作中、待确认、受阻按真实状态显示；
 * 2. 走位只在第一次播放：本机记住已播过的员工 id（模拟本地存储，最多 50 个）；
 *    本地存储抛错或读不到时不播放、不报错；减少动态效果时不走位，直接坐在工位上；
 * 3. 走位的坐标：从门口沿直线走到工位，走完停在工位上；
 * 4. 猫：走到今天入职里入职最晚的那位的工位旁，停留 CAT_STAY_MS（与 core 默认值一致），之后恢复原来的走动；
 *    减少动态效果时猫直接出现在那里；
 * 5. 6 个工位里没人的画成空桌椅，一直画着。
 */
import { describe, expect, it } from 'vitest'
import { TEAM_DEFAULTS } from '@agent-hub/core'
import type { OfficeLight } from '../src/shared/views.js'
import { officeAmbient, officeCatPose, officeCatVisitPose } from '../src/client/office-pixel/ambient.js'
import {
  ARRIVAL_WALK_MS, ARRIVED_MAX, ARRIVED_STORAGE_KEY, CAT_STAY_MS, OFFICE_DOOR_POINT, arrivalPose, mergeArrived, pickCatVisitSeat, planArrivals,
  readArrived, writeArrived, type ArrivedStore,
} from '../src/client/office-pixel/arrival.js'
import { ARRIVAL_BUBBLE, officeBubble } from '../src/client/office-pixel/bubble.js'
import { OFFICE_SEATS } from '../src/client/office-pixel/layout.js'
import { DEFAULT_OFFICE_MOMENT } from '../src/client/office-pixel/moment.js'
import { DEFAULT_OFFICE_PALETTE as palette, officePixelFrame, OFFICE_BUBBLE_TONES } from '../src/client/office-pixel/render.js'
import type { PixelRect } from '../src/client/office-pixel/pixel-kit.js'

/** 内存版本地存储。 */
function memoryStore(initial: Record<string, string> = {}): ArrivedStore & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value } }
}
/** 读写都抛错的存储（隐私模式、被禁用时的样子）。 */
const brokenStore: ArrivedStore = {
  getItem: () => { throw new Error('存储被禁用') },
  setItem: () => { throw new Error('存储被禁用') },
}

describe('「报到」气泡：只在空闲类的灯下显示，真实状态优先', () => {
  const idle: OfficeLight[] = ['watching', 'resting', 'queued']
  const busy: OfficeLight[] = ['working', 'waiting', 'blocked']

  it('今天入职且灯为盯守、休息、排队：气泡是「报到」，完整文案「今天入职，报到」', () => {
    for (const light of idle) {
      const bubble = officeBubble(light, { joinedToday: true })
      expect(bubble).toMatchObject({ short: '报到', label: '今天入职，报到', tone: 'arrival', light })
    }
    expect(ARRIVAL_BUBBLE).toEqual({ label: '今天入职，报到', short: '报到' })
    expect(OFFICE_BUBBLE_TONES.arrival).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('反例：灯为工作中、待确认、受阻时，按原有状态显示，报到不盖住它们', () => {
    expect(officeBubble('working', { joinedToday: true }).short).toBe('工作')
    expect(officeBubble('waiting', { joinedToday: true }).short).toBe('待确认')
    expect(officeBubble('blocked', { joinedToday: true }).short).toBe('受阻')
    for (const light of busy) expect(officeBubble(light, { joinedToday: true })).toEqual(officeBubble(light))
  })

  it('反例：不是今天入职时没有「报到」（没传、传 false 都一样）', () => {
    for (const light of idle) {
      expect(officeBubble(light).short).not.toBe('报到')
      expect(officeBubble(light, { joinedToday: false })).toEqual(officeBubble(light))
    }
  })

  it('画出来的帧里，气泡文案跟着变：林舟（盯守、今天入职）写「报到」，受阻的新员工写「受阻」', () => {
    const frame = officePixelFrame({
      occupants: [
        { seatIndex: 0, botId: 'bot-new', name: '林舟', light: 'watching', joinedToday: true },
        { seatIndex: 1, botId: 'bot-stuck', name: '新手', light: 'blocked', joinedToday: true },
        { seatIndex: 2, botId: 'bot-old', name: '老员工', light: 'watching' },
      ],
    })
    expect(frame.figures.map(figure => figure.bubble.short)).toEqual(['报到', '受阻', '盯守'])
  })
})

describe('走位只在第一次播放', () => {
  const seats = [
    { botId: 'bot-new', joinedToday: true },
    { botId: 'bot-old', joinedToday: false },
  ]

  it('今天入职、本机没播过：安排走位，并记为已播过', () => {
    expect(planArrivals({ seats, arrived: [], reducedMotion: false })).toEqual({ play: ['bot-new'], remember: ['bot-new'] })
  })

  it('反例：已经播过的不再播（模拟本地存储里有这个 id）', () => {
    const store = memoryStore()
    const first = planArrivals({ seats, arrived: readArrived(store), reducedMotion: false })
    expect(first.play).toEqual(['bot-new'])
    expect(writeArrived(mergeArrived(readArrived(store) ?? [], first.remember), store)).toBe(true)
    expect(JSON.parse(store.data[ARRIVED_STORAGE_KEY]!)).toEqual(['bot-new'])
    // 第二次打开办公室：读到已播过，不再播。
    expect(planArrivals({ seats, arrived: readArrived(store), reducedMotion: false })).toEqual({ play: [], remember: [] })
  })

  it('键名固定为 dsh-buddy:office-arrived；最多存 50 个，超出时丢掉最早的', () => {
    expect(ARRIVED_STORAGE_KEY).toBe('dsh-buddy:office-arrived')
    expect(ARRIVED_MAX).toBe(50)
    const ids = Array.from({ length: 60 }, (_, index) => `bot-${index}`)
    const store = memoryStore()
    expect(writeArrived(ids, store)).toBe(true)
    const stored = JSON.parse(store.data[ARRIVED_STORAGE_KEY]!) as string[]
    expect(stored).toHaveLength(50)
    expect(stored[0]).toBe('bot-10')
    expect(stored[49]).toBe('bot-59')
    expect(mergeArrived(stored, ['bot-new']).length).toBe(50)
    expect(mergeArrived(stored, ['bot-new']).at(-1)).toBe('bot-new')
  })

  it('本地存储抛错：读不到，视为已播过，不播放、不记，也不报错', () => {
    expect(readArrived(brokenStore)).toBeNull()
    expect(() => planArrivals({ seats, arrived: readArrived(brokenStore), reducedMotion: false })).not.toThrow()
    expect(planArrivals({ seats, arrived: readArrived(brokenStore), reducedMotion: false })).toEqual({ play: [], remember: [] })
    expect(writeArrived(['bot-new'], brokenStore)).toBe(false)
  })

  it('没有存储对象、内容不是数组：同样读不到（null）；键不存在是正常的空列表', () => {
    expect(readArrived(null)).toBeNull()
    expect(readArrived(memoryStore({ [ARRIVED_STORAGE_KEY]: '不是 JSON' }))).toBeNull()
    expect(readArrived(memoryStore({ [ARRIVED_STORAGE_KEY]: '{"a":1}' }))).toBeNull()
    expect(readArrived(memoryStore())).toEqual([])
  })

  it('减少动态效果：不走位（play 为空），但记为已看过；之后关掉这个设置也不会补播', () => {
    const plan = planArrivals({ seats, arrived: [], reducedMotion: true })
    expect(plan).toEqual({ play: [], remember: ['bot-new'] })
    expect(planArrivals({ seats, arrived: plan.remember, reducedMotion: false }).play).toEqual([])
  })
})

describe('走位：从门口沿直线走到工位，走完停在工位上', () => {
  const seat = OFFICE_SEATS[1]!

  it('开始在门口，走完在自己的工位，时长在 2 到 3 秒之间', () => {
    expect(ARRIVAL_WALK_MS).toBeGreaterThanOrEqual(2000)
    expect(ARRIVAL_WALK_MS).toBeLessThanOrEqual(3000)
    const start = arrivalPose(seat, 0)
    expect([start.seatX, start.deskY, start.done]).toEqual([OFFICE_DOOR_POINT.x, OFFICE_DOOR_POINT.y, false])
    const end = arrivalPose(seat, ARRIVAL_WALK_MS)
    expect([end.seatX, end.deskY, end.done]).toEqual([seat.seatX, seat.deskY, true])
    // 走完以后再久也停在工位上。
    expect(arrivalPose(seat, ARRIVAL_WALK_MS * 5)).toEqual(end)
  })

  it('途中沿直线：到一半时正好在门口和工位的中点，坐标只增不减', () => {
    const mid = arrivalPose(seat, ARRIVAL_WALK_MS / 2)
    expect(mid.seatX).toBe(Math.round((OFFICE_DOOR_POINT.x + seat.seatX) / 2))
    expect(mid.deskY).toBe(Math.round((OFFICE_DOOR_POINT.y + seat.deskY) / 2))
    let lastX = -1
    for (let t = 0; t <= ARRIVAL_WALK_MS; t += 250) {
      const pose = arrivalPose(seat, t)
      expect(pose.seatX).toBeGreaterThanOrEqual(lastX)
      lastX = pose.seatX
    }
  })

  it('同样的输入永远同样的结果；两条腿交替迈', () => {
    expect(arrivalPose(seat, 700)).toEqual(arrivalPose(seat, 700))
    expect(arrivalPose(seat, 0).step).not.toBe(arrivalPose(seat, 200).step)
  })

  it('走位期间静态帧里不画这个人（坐在椅子上的样子等走完才出现），动画层把他画在路上；走完后静态帧里有他', () => {
    const arriving = officePixelFrame({ occupants: [{ seatIndex: 1, botId: 'bot-new', name: '林舟', light: 'watching', joinedToday: true, arriving: true }] })
    const seated = officePixelFrame({ occupants: [{ seatIndex: 1, botId: 'bot-new', name: '林舟', light: 'watching', joinedToday: true }] })
    expect(arriving.rects.length).toBeLessThan(seated.rects.length)
    expect(arriving.figures[0]!.arriving).toBe(true)
    expect(seated.figures[0]!.arriving).toBe(false)
    const mid = officeAmbient({ timeMs: 1_000_000 + ARRIVAL_WALK_MS / 2, moment: DEFAULT_OFFICE_MOMENT, figures: arriving.figures, motion: true, arrivals: { 'bot-new': 1_000_000 } })
    const withoutWalker = officeAmbient({ timeMs: 1_000_000 + ARRIVAL_WALK_MS / 2, moment: DEFAULT_OFFICE_MOMENT, figures: arriving.figures, motion: true })
    expect(mid.length).toBeGreaterThan(withoutWalker.length)
    // 反例：减少动态效果时页面不传 arrivals，动画层不画任何走位。
    const reduced = officeAmbient({ timeMs: 1_000_000, moment: DEFAULT_OFFICE_MOMENT, figures: seated.figures, motion: false })
    expect(reduced.length).toBeGreaterThan(0)
  })
})

describe('猫去最晚入职的那位的工位旁', () => {
  it('目标是今天入职里入职时间最晚的一位；没有今天入职的返回 null', () => {
    const seats = [
      { joinedToday: false, joinedAt: null },
      { joinedToday: true, joinedAt: 1000 },
      { joinedToday: true, joinedAt: 5000 },
      { joinedToday: true, joinedAt: 3000 },
    ]
    expect(pickCatVisitSeat(seats)).toBe(2)
    expect(pickCatVisitSeat(seats.map(seat => ({ ...seat, joinedToday: false })))).toBeNull()
    expect(pickCatVisitSeat([])).toBeNull()
  })

  it('入职时间相同：取座位靠后的一位（同样的输入永远同一个结果）', () => {
    expect(pickCatVisitSeat([{ joinedToday: true, joinedAt: 1 }, { joinedToday: true, joinedAt: 1 }])).toBe(1)
  })

  it('停留时长与 core 的 CAT_STAY_MS 一致（60 秒）', () => {
    expect(CAT_STAY_MS).toBe(TEAM_DEFAULTS.CAT_STAY_MS)
    expect(CAT_STAY_MS).toBe(60_000)
  })

  it('先走过去，坐满 60 秒，再走回来；走回去之后返回 null，恢复原来的走动', () => {
    const seat = OFFICE_SEATS[2]!
    const first = officeCatVisitPose(0, seat, true)!
    expect(first.pose).toBe('walk')
    // 找到刚好坐下的时刻：坐下后位置固定在工位旁。
    const sitting = officeCatVisitPose(30_000, seat, true)!
    expect(sitting.pose).toBe('sit')
    expect(sitting.x).toBe(seat.deskX + 4)
    expect(sitting.y).toBeGreaterThan(seat.deskY + seat.deskHeight)
    // 走过去约 6 秒（距离除以速度），所以第 60 秒还坐着；坐满 60 秒是从到位那一刻算起。
    expect(officeCatVisitPose(60_000, seat, true)!.pose).toBe('sit')
    // 坐满后开始往回走（朝向相反），走回睡觉的位置后返回 null。
    const back = officeCatVisitPose(68_000, seat, true)
    expect(back?.pose).toBe('walk')
    expect(back?.flip).toBe(true)
    expect(officeCatVisitPose(80_000, seat, true)).toBeNull()
    expect(officeCatVisitPose(10 * 60_000, seat, true)).toBeNull()
    // 反例：还没开始（负时间）不画。
    expect(officeCatVisitPose(-1, seat, true)).toBeNull()
  })

  it('减少动态效果：猫直接坐在工位旁（不走路），停留期过了就恢复原来的位置', () => {
    const seat = OFFICE_SEATS[2]!
    expect(officeCatVisitPose(0, seat, false)).toMatchObject({ pose: 'sit', x: seat.deskX + 4 })
    expect(officeCatVisitPose(CAT_STAY_MS - 1, seat, false)?.pose).toBe('sit')
    expect(officeCatVisitPose(CAT_STAY_MS, seat, false)).toBeNull()
  })

  it('动画层里：有拜访时猫画在工位旁；没有拜访时仍按原来的日程（和以前画的位置一样）', () => {
    const seat = OFFICE_SEATS[2]!
    const base = { timeMs: 5_000_000, moment: DEFAULT_OFFICE_MOMENT, figures: [], motion: true }
    const spot = officeCatVisitPose(30_000, seat, true)!
    const catColor = '#ffbe78'
    const hasCatNear = (rects: PixelRect[], x: number, y: number): boolean => rects.some(rect => rect.color === catColor && rect.x >= x && rect.x < x + 16 && rect.y >= y - 16 && rect.y < y)
    const visiting = officeAmbient({ ...base, catVisit: { seatIndex: seat.index, sinceMs: base.timeMs - 30_000 } })
    expect(hasCatNear(visiting, spot.x, spot.y!)).toBe(true)
    const normal = officeAmbient(base)
    expect(hasCatNear(normal, spot.x, spot.y!)).toBe(false)
    expect(officeAmbient({ ...base, catVisit: null })).toEqual(normal)
    // 平时的日程没被改动：0 秒时还在睡觉。
    expect(officeCatPose(0).pose).toBe('sleep')
  })
})

describe('6 个工位始终画出，没人的画成空桌椅', () => {
  /** 某个座位上椅背中心那一点的最终颜色：空位也应该是椅子的颜色。 */
  const chairColorAt = (rects: readonly PixelRect[], seatIndex: number): string | undefined => {
    const seat = OFFICE_SEATS[seatIndex]!
    const x = seat.seatX
    const y = seat.deskY - 19 + 8
    for (let index = rects.length - 1; index >= 0; index -= 1) {
      const rect = rects[index]!
      if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return rect.color
    }
    return undefined
  }

  it('只有 2 位员工时：6 个工位都有桌子和椅子，只有 2 个人和 2 个气泡', () => {
    const frame = officePixelFrame({
      occupants: [
        { seatIndex: 0, botId: 'a', name: '总管', light: 'watching' },
        { seatIndex: 1, botId: 'b', name: '林舟', light: 'watching', joinedToday: true },
      ],
    })
    expect(frame.figures).toHaveLength(2)
    expect(OFFICE_SEATS).toHaveLength(6)
    // 空位 2 至 5：椅背画出来了（椅子的颜色），没有人遮着。
    for (const index of [2, 3, 4, 5]) expect(chairColorAt(frame.rects, index)).toBe(palette.chair)
    // 空位没有气泡，也不出现在可点的小人列表里。
    expect(frame.figures.map(figure => figure.seatIndex)).toEqual([0, 1])
  })

  it('一个人都没有：6 个空桌椅一直画着', () => {
    const frame = officePixelFrame({ occupants: [] })
    for (let index = 0; index < 6; index += 1) expect(chairColorAt(frame.rects, index)).toBe(palette.chair)
    expect(frame.figures).toEqual([])
  })
})
