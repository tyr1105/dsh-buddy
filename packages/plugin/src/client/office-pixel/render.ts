/**
 * 像素办公室渲染核心（P30 起，P54 改成明亮风格）：把固定布局、队友外观与真实状态画成一帧。
 *
 * 为什么输出「矩形列表」而不是直接摸 canvas：
 * 1. 纯函数可以在测试里逐块断言，不用起浏览器；
 * 2. 页面只负责把矩形刷到 canvas，缩放、导出图片、以后换渲染后端都不改规则；
 * 3. 这里不读时间、不读 Math.random，时间由调用方传入，渲染本身永远确定。
 *
 * 这个文件只负责编排先后顺序。墙和地在 decor.ts，窗在 window-view.ts，工位在 furniture.ts，
 * 共享区在 shared-furniture.ts，小人在 figure.ts，会动的部分在 ambient.ts。
 *
 * 纪律：空位也画桌椅；小人只坐固定工位；气泡只来自 core 的灯；
 * 座位越界或重复占用时给出中文警告并跳过，不猜一个位置硬画。
 */
import type { OfficeLight } from '../../shared/views.js'
import { officeAppearance, type OfficeAppearance } from './appearance.js'
import { officeBubble, type OfficeBubble, type OfficeBubbleTone } from './bubble.js'
import { drawFloor, drawFloorLighting, drawWallBase, drawWallDecor } from './decor.js'
import { drawFigure } from './figure.js'
import { drawChairBack, drawDesk, drawPartition } from './furniture.js'
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH, OFFICE_SEATS, officeSeatAt, type OfficeSeatLayout } from './layout.js'
import { DEFAULT_OFFICE_MOMENT, type OfficeMoment } from './moment.js'
import { DEFAULT_OFFICE_PALETTE, type OfficePalette } from './palette.js'
import { pushRect, type PixelRect } from './pixel-kit.js'
import { drawFloorZones, drawSharedFurniture } from './shared-furniture.js'

// 调色板和矩形类型搬到了独立文件，这里转出一次，原来从 render.js 引用的代码不用改。
export { DEFAULT_OFFICE_PALETTE, type OfficePalette } from './palette.js'
export type { PixelRect } from './pixel-kit.js'

/** 画一帧只需要 fillStyle 与 fillRect，真实 canvas 与测试替身都能满足。 */
export interface PixelPaintTarget {
  fillStyle: unknown
  fillRect(x: number, y: number, w: number, h: number): void
}

/** 气泡底色按语义分六种，不和房间调色板混在一起。都是浅色，上面的深色字才读得清。 */
export const OFFICE_BUBBLE_TONES: Record<OfficeBubbleTone, string> = {
  working: '#c8f3cb',
  waiting: '#ffe7a6',
  blocked: '#ffc4ba',
  resting: '#dfe5f4',
  offline: '#e6e6e6',
  unknown: '#f0ebf8',
}

/** 一帧里坐进工位的人；seatIndex 对应 OFFICE_SEATS 的下标。 */
export interface OfficePixelOccupant {
  seatIndex: number
  botId: string
  name: string
  light: OfficeLight
}

export interface OfficePixelInput {
  occupants: readonly OfficePixelOccupant[]
  palette?: Partial<OfficePalette>
  bubbleTones?: Partial<Record<OfficeBubbleTone, string>>
  /** 挂钟、日历和窗外天色用的时间；不传就是十点十分。 */
  moment?: OfficeMoment
}

export interface OfficePixelFigure {
  seatIndex: number
  botId: string
  name: string
  appearance: OfficeAppearance
  bubble: OfficeBubble
  /** 人的水平中心和气泡基准线（与布局同一套逻辑坐标），页面用它放点击热区与气泡浮层。 */
  x: number
  y: number
}

export interface OfficePixelFrame {
  width: number
  height: number
  rects: PixelRect[]
  figures: OfficePixelFigure[]
  warnings: string[]
}

/** 气泡宽度按字数算：两个字 22 像素，每多一个字加 8，「待确认」这样的长文案也装得下。 */
export function officeBubbleWidth(text: string): number {
  return 22 + Math.max(0, text.length - 2) * 8
}

/** 头顶气泡：只画底框与描边，切掉四个角显得圆润；文案在 figures 里交给页面浮层。 */
function drawBubble(rects: PixelRect[], seat: OfficeSeatLayout, bubble: OfficeBubble, tones: Record<OfficeBubbleTone, string>, border: string): void {
  const width = officeBubbleWidth(bubble.short)
  const x = seat.seatX - Math.floor(width / 2)
  const y = seat.standY - 54
  pushRect(rects, x + 1, y, width - 2, 10, border)
  pushRect(rects, x, y + 1, width, 8, border)
  pushRect(rects, x + 1, y + 1, width - 2, 8, tones[bubble.tone])
  pushRect(rects, seat.seatX - 2, y + 10, 4, 1, border)
  pushRect(rects, seat.seatX - 1, y + 11, 2, 1, border)
}

/**
 * 生成一帧静止的房间：先铺地板和光影，再画墙和共享区，最后按座位放桌椅和小人。
 * 返回的 figures 供页面放点击热区与气泡文案；warnings 如实报告坏座位。
 */
export function officePixelFrame(input: OfficePixelInput): OfficePixelFrame {
  const palette: OfficePalette = { ...DEFAULT_OFFICE_PALETTE, ...input.palette }
  const tones: Record<OfficeBubbleTone, string> = { ...OFFICE_BUBBLE_TONES, ...input.bubbleTones }
  const moment = input.moment ?? DEFAULT_OFFICE_MOMENT
  const rects: PixelRect[] = []
  const figures: OfficePixelFigure[] = []
  const warnings: string[] = []

  // 光影必须在家具之前画：只染地板，不给桌子和小人蒙色。
  drawFloor(rects, palette)
  drawFloorLighting(rects, moment, palette)
  drawFloorZones(rects, palette)
  drawWallBase(rects, palette)
  drawWallDecor(rects, moment, palette)
  drawSharedFurniture(rects, palette)

  // 先按座位号去重：一个工位只认第一个人，后来的给警告。
  const bySeat = new Map<number, OfficePixelOccupant>()
  for (const occupant of input.occupants) {
    const seat = officeSeatAt(occupant.seatIndex)
    if (seat === null) {
      warnings.push(`队友「${occupant.name}」的座位序号 ${occupant.seatIndex} 超出办公室范围，已跳过`)
      continue
    }
    if (bySeat.has(seat.index)) {
      warnings.push(`座位 ${seat.index + 1} 被多个队友占用，只保留「${bySeat.get(seat.index)?.name ?? ''}」`)
      continue
    }
    bySeat.set(seat.index, occupant)
  }

  // 人坐在桌子后面：先画隔断、椅背和人，再画桌子，把下半身挡住。后排先画，前排后画。
  for (const seat of OFFICE_SEATS) {
    const occupant = bySeat.get(seat.index)
    drawPartition(rects, seat, palette)
    drawChairBack(rects, seat, palette)
    if (occupant !== undefined) drawFigure(rects, seat, officeAppearance(occupant.botId), occupant.light, palette)
    // 有人且在线才亮屏；屏幕亮灭不代表在不在干活，具体内容由 ambient.ts 按状态画。
    drawDesk(rects, seat, occupant !== undefined && occupant.light !== 'offline', palette)
  }

  // 气泡最后画，保证不被别的东西压住。
  for (const seat of OFFICE_SEATS) {
    const occupant = bySeat.get(seat.index)
    if (occupant === undefined) continue
    const look = officeAppearance(occupant.botId)
    const bubble = officeBubble(occupant.light)
    drawBubble(rects, seat, bubble, tones, palette.bubbleBorder)
    figures.push({
      seatIndex: seat.index,
      botId: occupant.botId,
      name: occupant.name,
      appearance: look,
      bubble,
      x: seat.seatX,
      y: seat.standY,
    })
  }

  return {
    width: OFFICE_PIXEL_WIDTH,
    height: OFFICE_PIXEL_HEIGHT,
    rects,
    figures,
    warnings,
  }
}

/** 把矩形列表刷到 canvas；静态帧和动画叠加层都走这一个入口。 */
export function paintOfficeRects(target: PixelPaintTarget, rects: readonly PixelRect[]): void {
  for (const rect of rects) {
    target.fillStyle = rect.color
    target.fillRect(rect.x, rect.y, rect.w, rect.h)
  }
}

/** 把一帧刷到 canvas；页面只调用这一句，不关心内部画了什么。 */
export function paintOfficeFrame(target: PixelPaintTarget, frame: OfficePixelFrame): void {
  paintOfficeRects(target, frame.rects)
}
