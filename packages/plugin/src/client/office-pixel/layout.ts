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
  /**
   * seatX 是人和椅子的水平中心。
   * standY 是头顶气泡和点击热区的基准线：人坐在桌子后面、下半身被桌子挡住，
   * 所以它落在桌面中段，不再是脚底。气泡固定画在它上方 54 像素处。
   */
  seatX: number
  standY: number
}

/**
 * 两排桌子的基线（桌子最下沿的 y）。
 * 排距 74 是算出来的：一个人从气泡到桌沿要占 64 像素，再留 10 像素过道，
 * 后排的气泡才不会压到前排的桌子。
 */
const ROW_BASES = [172, 246] as const
/** 三列桌子的左边距：三张桌子间距相同，右边留出放饮水机和绿植的空档。 */
const DESK_XS = [14, 82, 150] as const
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
    standY: base - 10,
  })),
)

/** 过道：两排工位之间横向留空，小人走动不会被桌子挡住。 */
export const OFFICE_AISLE = { x: 12, y: 176, width: 200, height: 16 } as const

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

/** 固定摆位：白板、打印机、饮水机、文件柜、会议角与三盆绿植。 */
export const OFFICE_SHARED_SPOTS: readonly OfficeSharedSpot[] = [
  { id: 'board', kind: 'board', x: 248, y: 56, width: 86, height: 38, walkX: 291, walkY: 116 },
  { id: 'printer', kind: 'printer', x: 430, y: 100, width: 44, height: 26, walkX: 420, walkY: 176 },
  { id: 'cooler', kind: 'cooler', x: 203, y: 56, width: 20, height: 44, walkX: 213, walkY: 104 },
  { id: 'cabinet', kind: 'cabinet', x: 430, y: 126, width: 44, height: 44, walkX: 420, walkY: 176 },
  { id: 'meeting', kind: 'meeting', x: 288, y: 186, width: 114, height: 34, walkX: 345, walkY: 262 },
  { id: 'plant-a', kind: 'plant', x: 237, y: 122, width: 24, height: 36, walkX: 249, walkY: 162 },
  { id: 'plant-b', kind: 'plant', x: 440, y: 233, width: 24, height: 36, walkX: 452, walkY: 268 },
  { id: 'plant-c', kind: 'plant', x: 205, y: 226, width: 24, height: 36, walkX: 217, walkY: 266 },
]

/** 按座位序号取工位；越界返回 null，调用方据此报警而不是瞎画。 */
export function officeSeatAt(index: number): OfficeSeatLayout | null {
  if (!Number.isInteger(index) || index < 0 || index >= OFFICE_SEATS.length) return null
  return OFFICE_SEATS[index] ?? null
}
