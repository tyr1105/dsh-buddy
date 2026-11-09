/**
 * 像素办公室渲染核心（P30）：把固定布局、队友外观与真实状态画成一帧。
 *
 * 为什么输出「矩形列表」而不是直接摸 canvas：
 * 1. 纯函数可以在测试里逐块断言，不用起浏览器；
 * 2. 页面只负责把矩形刷到 canvas，缩放、导出图片、以后换渲染后端都不改规则；
 * 3. 这里不读时间、不读 Math.random，动画由页面按帧驱动，渲染本身永远确定。
 *
 * 纪律：空位也画桌椅；小人只坐固定工位；气泡只来自 core 的灯；
 * 座位越界或重复占用时给出中文警告并跳过，不猜一个位置硬画。
 */
import type { OfficeLight } from '../../shared/views.js'
import { officeAppearance, type OfficeAppearance } from './appearance.js'
import { officeBubble, type OfficeBubble, type OfficeBubbleTone } from './bubble.js'
import { drawFloorLighting, drawWallDecor } from './decor.js'
import {
  OFFICE_AISLE, OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH, OFFICE_SEATS, OFFICE_SHARED_SPOTS,
  officeSeatAt, type OfficeSeatLayout,
} from './layout.js'

/** 一个可绘制矩形；颜色用 CSS 字符串，页面直接赋给 fillStyle。 */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
  color: string
}

/** 画一帧只需要 fillStyle 与 fillRect，真实 canvas 与测试替身都能满足。 */
export interface PixelPaintTarget {
  fillStyle: unknown
  fillRect(x: number, y: number, w: number, h: number): void
}

/** 房间调色板；页面可整体换色，但布局坐标不变。 */
export interface OfficePalette {
  wall: string
  wallTrim: string
  floorA: string
  floorB: string
  aisle: string
  desk: string
  deskTop: string
  deskShadow: string
  chair: string
  screen: string
  screenOn: string
  outline: string
  bubbleBorder: string
  board: string
  metal: string
  water: string
  drawer: string
  table: string
  leaf: string
  pot: string
  /** P36 画面补强：墙饰与地面光影的颜色，全部只用在氛围上。 */
  wallGlow: string
  wallGlowDim: string
  windowSky: string
  windowSkyDeep: string
  clockFace: string
  cork: string
  noteA: string
  noteB: string
  noteC: string
  lampShade: string
  lampBulb: string
  floorShade: string
  floorLift: string
  sunbeamA: string
  sunbeamB: string
  lampHalo: string
  lampGlow: string
}

export const DEFAULT_OFFICE_PALETTE: OfficePalette = {
  wall: '#2f3444',
  wallTrim: '#3d4457',
  floorA: '#6b5844',
  floorB: '#63513f',
  aisle: '#7a6650',
  desk: '#8a6a45',
  deskTop: '#a78357',
  deskShadow: '#5a4730',
  chair: '#3f4658',
  screen: '#2a2f3a',
  screenOn: '#7fd0c0',
  outline: '#20242c',
  bubbleBorder: '#20242c',
  board: '#e8e4d8',
  metal: '#9aa3ad',
  water: '#79b8d8',
  drawer: '#6f7b86',
  table: '#7a5a3c',
  leaf: '#5f8a4a',
  pot: '#8a5a3a',
  // 墙面受光用半透明暖色铺在墙面上，不改变墙体本身的明度基准。
  wallGlow: 'rgba(255, 228, 176, 0.08)',
  wallGlowDim: 'rgba(255, 228, 176, 0.04)',
  windowSky: '#a9d6e2',
  windowSkyDeep: '#7fb6c8',
  clockFace: '#e8e4d8',
  cork: '#b08a5c',
  noteA: '#e6c96a',
  noteB: '#a8c8e8',
  noteC: '#d8a8a8',
  lampShade: '#5b6474',
  lampBulb: '#ffe6a8',
  // 工位区压暗、共享区提亮；窗光与灯下亮区都用低透明度，叠在地板上不糊成色块。
  floorShade: 'rgba(18, 14, 10, 0.12)',
  floorLift: 'rgba(255, 232, 190, 0.06)',
  sunbeamA: 'rgba(255, 214, 140, 0.18)',
  sunbeamB: 'rgba(255, 214, 140, 0.10)',
  lampHalo: 'rgba(255, 210, 130, 0.12)',
  lampGlow: 'rgba(255, 226, 160, 0.22)',
}

/** 气泡底色按语义分六种，不和房间调色板混在一起。 */
export const OFFICE_BUBBLE_TONES: Record<OfficeBubbleTone, string> = {
  working: '#bfe3c0',
  waiting: '#f0d9a8',
  blocked: '#f0b4ac',
  resting: '#d8d8d8',
  offline: '#c9c9c9',
  unknown: '#e6e6e6',
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
}

export interface OfficePixelFigure {
  seatIndex: number
  botId: string
  name: string
  appearance: OfficeAppearance
  bubble: OfficeBubble
  /** 小人脚底中心（与布局同一套逻辑坐标），页面用它放点击热区与气泡浮层。 */
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

/** 地板棋盘格：15 像素一格，480 与 270 都能整除，不会留下半格。 */
const FLOOR_TILE = 15
const WALL_HEIGHT = 86

function pushRect(rects: PixelRect[], x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return
  rects.push({ x, y, w, h, color })
}

/** 画固定工位：桌影、桌面、桌沿、显示器与椅子；空位也照画。 */
function drawSeatFurniture(rects: PixelRect[], seat: OfficeSeatLayout, occupied: boolean, palette: OfficePalette): void {
  pushRect(rects, seat.deskX + 2, seat.deskY + seat.deskHeight, seat.deskWidth, 3, palette.deskShadow)
  pushRect(rects, seat.deskX, seat.deskY, seat.deskWidth, seat.deskHeight, palette.desk)
  pushRect(rects, seat.deskX, seat.deskY, seat.deskWidth, 4, palette.deskTop)
  // 显示器：有人时亮屏，空位熄屏；屏色只表达是否有人，不冒充工作状态。
  pushRect(rects, seat.seatX - 7, seat.deskY + 5, 14, 10, palette.outline)
  pushRect(rects, seat.seatX - 6, seat.deskY + 6, 12, 8, occupied ? palette.screenOn : palette.screen)
  pushRect(rects, seat.seatX - 1, seat.deskY + 16, 2, 4, palette.outline)
  pushRect(rects, seat.seatX - 4, seat.deskY + 20, 8, 2, palette.outline)
  // 椅子：在桌子后面露出一截椅背。
  pushRect(rects, seat.seatX - 6, seat.standY - 10, 12, 4, palette.chair)
  pushRect(rects, seat.seatX - 5, seat.standY - 6, 10, 3, palette.outline)
}

/** 头发按固定样式画在头顶；样式由 id 哈希决定，同一人永远一样。 */
function drawHair(rects: PixelRect[], look: OfficeAppearance, headX: number, headY: number, outline: string): void {
  const x = headX
  const y = headY
  switch (look.hair) {
    case 'short':
      pushRect(rects, x, y - 1, 8, 3, look.hairColor)
      pushRect(rects, x, y + 2, 2, 2, look.hairColor)
      break
    case 'bowl':
      pushRect(rects, x - 1, y - 1, 10, 3, look.hairColor)
      pushRect(rects, x - 1, y + 2, 2, 4, look.hairColor)
      pushRect(rects, x + 7, y + 2, 2, 4, look.hairColor)
      break
    case 'spiky':
      pushRect(rects, x, y - 1, 8, 2, look.hairColor)
      pushRect(rects, x + 1, y - 3, 2, 3, look.hairColor)
      pushRect(rects, x + 5, y - 2, 2, 2, look.hairColor)
      break
    case 'bob':
      pushRect(rects, x - 1, y - 1, 10, 3, look.hairColor)
      pushRect(rects, x - 1, y + 2, 2, 6, look.hairColor)
      pushRect(rects, x + 7, y + 2, 2, 6, look.hairColor)
      break
    case 'buzz':
      pushRect(rects, x, y, 8, 2, look.hairColor)
      break
    case 'side':
      pushRect(rects, x, y - 1, 8, 2, look.hairColor)
      pushRect(rects, x, y + 1, 3, 3, look.hairColor)
      pushRect(rects, x + 5, y - 1, 3, 2, look.hairColor)
      break
  }
  if (look.accessory === 'cap') {
    pushRect(rects, x - 1, y - 3, 10, 3, look.accessoryColor)
    pushRect(rects, x + 7, y - 1, 4, 2, look.accessoryColor)
  } else if (look.accessory === 'glasses') {
    pushRect(rects, x + 1, y + 4, 2, 1, outline)
    pushRect(rects, x + 5, y + 4, 2, 1, outline)
  } else if (look.accessory === 'scarf') {
    pushRect(rects, x, y + 8, 8, 2, look.accessoryColor)
  }
}

/** 画一个小人：腿、身体、手臂、头、头发与配饰；脚底中心就是 seat.standX/standY。 */
function drawFigure(rects: PixelRect[], seat: OfficeSeatLayout, look: OfficeAppearance, outline: string): void {
  const x = seat.seatX
  const foot = seat.standY
  pushRect(rects, x - 5, foot - 8, 3, 8, look.pants)
  pushRect(rects, x + 2, foot - 8, 3, 8, look.pants)
  pushRect(rects, x - 6, foot - 22, 12, 14, look.shirt)
  pushRect(rects, x - 8, foot - 20, 2, 9, look.shirt)
  pushRect(rects, x + 6, foot - 20, 2, 9, look.shirt)
  pushRect(rects, x - 4, foot - 34, 8, 10, look.skin)
  drawHair(rects, look, x - 4, foot - 34, outline)
}

/** 头顶气泡：只画底框与描边，文案在 figures 里交给页面浮层。 */
function drawBubble(rects: PixelRect[], seat: OfficeSeatLayout, tone: OfficeBubbleTone, tones: Record<OfficeBubbleTone, string>, border: string): void {
  const x = seat.seatX - 11
  const y = seat.standY - 54
  pushRect(rects, x, y, 22, 10, border)
  pushRect(rects, x + 1, y + 1, 20, 8, tones[tone])
  pushRect(rects, seat.seatX - 2, y + 10, 4, 2, border)
}

/** 共享区的固定陈设：只画形状，不承载状态。 */
function drawShared(rects: PixelRect[], palette: OfficePalette): void {
  for (const spot of OFFICE_SHARED_SPOTS) {
    if (spot.kind === 'board') {
      pushRect(rects, spot.x, spot.y, spot.width, spot.height, palette.outline)
      pushRect(rects, spot.x + 2, spot.y + 2, spot.width - 4, spot.height - 4, palette.board)
      pushRect(rects, spot.x + 8, spot.y + 10, spot.width - 24, 2, palette.metal)
      pushRect(rects, spot.x + 8, spot.y + 16, spot.width - 32, 2, palette.metal)
    } else if (spot.kind === 'printer') {
      pushRect(rects, spot.x, spot.y, spot.width, spot.height, palette.metal)
      pushRect(rects, spot.x + 4, spot.y + 4, spot.width - 8, 4, palette.outline)
      pushRect(rects, spot.x + 6, spot.y + 14, spot.width - 12, 8, palette.board)
    } else if (spot.kind === 'cooler') {
      pushRect(rects, spot.x, spot.y + 10, spot.width, spot.height - 10, palette.metal)
      pushRect(rects, spot.x + 4, spot.y, spot.width - 8, 10, palette.water)
    } else if (spot.kind === 'cabinet') {
      pushRect(rects, spot.x, spot.y, spot.width, spot.height, palette.drawer)
      pushRect(rects, spot.x + 3, spot.y + 4, spot.width - 6, 14, palette.outline)
      pushRect(rects, spot.x + 3, spot.y + 22, spot.width - 6, 14, palette.outline)
    } else if (spot.kind === 'meeting') {
      pushRect(rects, spot.x, spot.y, spot.width, spot.height, palette.table)
      pushRect(rects, spot.x + 4, spot.y - 4, 16, 6, palette.chair)
      pushRect(rects, spot.x + spot.width - 20, spot.y - 4, 16, 6, palette.chair)
    } else {
      pushRect(rects, spot.x + 4, spot.y + 12, spot.width - 8, spot.height - 12, palette.pot)
      pushRect(rects, spot.x + 2, spot.y + 2, spot.width - 4, 12, palette.leaf)
    }
  }
}

/**
 * 生成一帧：先铺地板与墙，再画共享区与六个工位，最后按座位放小人。
 * 返回的 figures 供页面放点击热区与气泡文案；warnings 如实报告坏座位。
 */
export function officePixelFrame(input: OfficePixelInput): OfficePixelFrame {
  const palette: OfficePalette = { ...DEFAULT_OFFICE_PALETTE, ...input.palette }
  const tones: Record<OfficeBubbleTone, string> = { ...OFFICE_BUBBLE_TONES, ...input.bubbleTones }
  const rects: PixelRect[] = []
  const figures: OfficePixelFigure[] = []
  const warnings: string[] = []

  // 地板棋盘格；用行列序号判断奇偶，不能拿像素坐标除格子宽，否则会出现非整数。
  let row = 0
  for (let y = WALL_HEIGHT; y < OFFICE_PIXEL_HEIGHT; y += FLOOR_TILE, row += 1) {
    let col = 0
    for (let x = 0; x < OFFICE_PIXEL_WIDTH; x += FLOOR_TILE, col += 1) {
      const odd = (row + col) % 2 === 0
      pushRect(rects, x, y, FLOOR_TILE, Math.min(FLOOR_TILE, OFFICE_PIXEL_HEIGHT - y), odd ? palette.floorA : palette.floorB)
    }
  }
  // 分区明暗、窗光斜落与灯下亮区必须在家具之前：只染地板，不给桌子和小人蒙色。
  drawFloorLighting(rects, palette)
  pushRect(rects, OFFICE_AISLE.x, OFFICE_AISLE.y, OFFICE_AISLE.width, OFFICE_AISLE.height, palette.aisle)
  pushRect(rects, 0, 0, OFFICE_PIXEL_WIDTH, WALL_HEIGHT, palette.wall)
  pushRect(rects, 0, WALL_HEIGHT - 4, OFFICE_PIXEL_WIDTH, 4, palette.wallTrim)
  // 墙饰按房间分区铺开：窗、钟、公告栏、壁灯与管道，各自固定、不排成一条。
  drawWallDecor(rects, palette)

  drawShared(rects, palette)

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

  for (const seat of OFFICE_SEATS) {
    const occupant = bySeat.get(seat.index)
    drawSeatFurniture(rects, seat, occupant !== undefined, palette)
  }

  for (const seat of OFFICE_SEATS) {
    const occupant = bySeat.get(seat.index)
    if (!occupant) continue
    const look = officeAppearance(occupant.botId)
    const bubble = officeBubble(occupant.light)
    drawFigure(rects, seat, look, palette.outline)
    drawBubble(rects, seat, bubble.tone, tones, palette.bubbleBorder)
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

/** 把一帧刷到 canvas；页面只调用这一句，不关心内部画了什么。 */
export function paintOfficeFrame(target: PixelPaintTarget, frame: OfficePixelFrame): void {
  for (const rect of frame.rects) {
    target.fillStyle = rect.color
    target.fillRect(rect.x, rect.y, rect.w, rect.h)
  }
}
