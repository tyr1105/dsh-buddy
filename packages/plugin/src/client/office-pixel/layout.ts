/**
 * 像素办公室的固定布局（P30）：480x270 逻辑画布、两排三列工位、过道与共享区。
 *
 * 为什么先定布局：Demo 里每人有固定工位，空位也要画出来；如果座位坐标跟着
 * 队友数量或渲染顺序变化，主人昨天看到的位置今天就变了，办公室就不再是
 * 「真实工作状态的投影」。这里只给常量与查表函数，不掺任何界面状态。
 *
 * 坐标口径：左上角为原点，x 向右、y 向下，单位是逻辑像素；
 * 画布可以整体放大显示，但所有命中判断都用这套逻辑坐标。
 */

export const OFFICE_PIXEL_WIDTH = 480
export const OFFICE_PIXEL_HEIGHT = 270

/** 一个固定工位：桌子矩形、椅子位置与小人站立点。 */
export interface OfficeSeatLayout {
  id: string
  index: number
  row: number
  col: number
  /** 桌子左上角与尺寸。 */
  deskX: number
  deskY: number
  deskWidth: number
  deskHeight: number
  /** 椅子中心与小人站立点（脚底中心）。 */
  seatX: number
  standY: number
}

/** 两排桌子的基线：第一排靠里、第二排靠外，中间留过道。 */
const ROW_BASES = [194, 248] as const
/** 三列桌子的左边距。 */
const DESK_XS = [16, 78, 140] as const
const DESK_WIDTH = 50
const DESK_HEIGHT = 28

/** 六个固定工位；index 越小越靠里，座位分配沿用 index 顺序。 */
export const OFFICE_SEATS: readonly OfficeSeatLayout[] = ROW_BASES.flatMap((base, row) =>
  DESK_XS.map((deskX, col) => ({
    id: `seat-${row}-${col}`,
    index: row * DESK_XS.length + col,
    row,
    col,
    deskX,
    deskY: base - DESK_HEIGHT,
    deskWidth: DESK_WIDTH,
    deskHeight: DESK_HEIGHT,
    seatX: deskX + 34,
    standY: base + 15,
  })),
)

/** 过道：两排工位之间横向留空，小人走动不会被桌子挡住。 */
export const OFFICE_AISLE = { x: 12, y: 196, width: 200, height: 18 } as const

export type OfficeSharedKind = 'board' | 'printer' | 'cooler' | 'cabinet' | 'meeting' | 'plant'

/** 共享区的一个物件；x/y/w/h 是绘制矩形，walkX/walkY 是小人走过去的落脚点。 */
export interface OfficeSharedSpot {
  id: string
  kind: OfficeSharedKind
  x: number
  y: number
  width: number
  height: number
  walkX: number
  walkY: number
}

/** 共享区固定摆位：白板、打印机、饮水机、文件柜、会议角与两盆绿植。 */
export const OFFICE_SHARED_SPOTS: readonly OfficeSharedSpot[] = [
  { id: 'board', kind: 'board', x: 258, y: 96, width: 92, height: 36, walkX: 304, walkY: 158 },
  { id: 'printer', kind: 'printer', x: 356, y: 148, width: 40, height: 30, walkX: 340, walkY: 196 },
  { id: 'cooler', kind: 'cooler', x: 424, y: 146, width: 24, height: 42, walkX: 416, walkY: 196 },
  { id: 'cabinet', kind: 'cabinet', x: 400, y: 214, width: 40, height: 44, walkX: 390, walkY: 262 },
  { id: 'meeting', kind: 'meeting', x: 312, y: 226, width: 66, height: 30, walkX: 345, walkY: 218 },
  { id: 'plant-a', kind: 'plant', x: 246, y: 132, width: 20, height: 22, walkX: 256, walkY: 160 },
  { id: 'plant-b', kind: 'plant', x: 268, y: 240, width: 20, height: 22, walkX: 278, walkY: 266 },
]

/** 按座位序号取工位；越界返回 null，调用方据此报警而不是瞎画。 */
export function officeSeatAt(index: number): OfficeSeatLayout | null {
  if (!Number.isInteger(index) || index < 0 || index >= OFFICE_SEATS.length) return null
  return OFFICE_SEATS[index] ?? null
}
