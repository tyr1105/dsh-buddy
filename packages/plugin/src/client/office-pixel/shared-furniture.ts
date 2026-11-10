/**
 * 共享区的陈设（P54）：白板、档案架、咖啡台、饮水机、复印机、文件柜、玻璃会议室、
 * 自动贩卖机、服务器机柜和绿植。
 *
 * 这些东西只负责让房间有办公室的样子，不承载任何状态：没有队友的时候它们也都在。
 * 画的顺序按远近排：靠墙的先画，离观众近的后画，这样前面的东西能自然挡住后面。
 * 需要动的部分（投屏图表、机柜指示灯、咖啡蒸汽等）在 ambient.ts，这里只画不动的底子。
 */
import { OFFICE_AISLE, OFFICE_SHARED_SPOTS, type OfficeSharedSpot } from './layout.js'
import { OFFICE_ACCENTS, type OfficePalette } from './palette.js'
import { drawSprite, pushBox, pushRect as push, shadeColor, type PixelRect, type SpriteColors } from './pixel-kit.js'
import {
  SPRITE_BUSH_PLANT, SPRITE_COFFEE_MACHINE, SPRITE_DESK_PLANT, SPRITE_FLOOR_PLANT, SPRITE_FOLDERS, SPRITE_MUG, SPRITE_OFFICE_CHAIR,
  SPRITE_PAPER_CUPS,
} from './sprites.js'

/** 玻璃会议室的范围：partition 是后墙玻璃的高度，下面才是地毯。 */
export const OFFICE_MEETING_ROOM = { x: 262, y: 120, w: 166, h: 142, partition: 40 } as const
/** 会议室投屏的屏幕区域；ambient.ts 在上面画会动的图表。 */
export const OFFICE_MEETING_SCREEN = { x: 314, y: 126, w: 62, h: 28 } as const
/** 服务器机柜的位置；ambient.ts 让它的指示灯闪。 */
export const OFFICE_SERVER_RACK = { x: 212, y: 176, w: 20, h: 50, units: 5 } as const
/** 自动贩卖机的位置。 */
export const OFFICE_VENDING = { x: 436, y: 176, w: 38, h: 54 } as const

/** 按 id 取一个共享陈设的位置；找不到说明布局表被改坏了，这里直接跳过不画。 */
function spotOf(id: string): OfficeSharedSpot | undefined {
  return OFFICE_SHARED_SPOTS.find(spot => spot.id === id)
}

/** 绿植共用的颜色表。 */
function plantColors(palette: OfficePalette): SpriteColors {
  return {
    d: palette.leafDark, l: palette.leaf, h: palette.leafLight, s: palette.leafDark, o: palette.outline,
    r: palette.board, p: palette.pot, P: palette.potDark,
  }
}

/** 落地物件脚下的一小片影子，让东西「站」在地上，而不是飘着。 */
function drawFootShadow(rects: PixelRect[], x: number, y: number, w: number, palette: OfficePalette): void {
  push(rects, x, y, w, 3, palette.deskShadow)
}

/** 地面分区：会议室的青绿地毯、工位之间的通道。要在所有家具之前画。 */
export function drawFloorZones(rects: PixelRect[], palette: OfficePalette): void {
  const room = OFFICE_MEETING_ROOM
  const floorTop = room.y + room.partition
  const tile = 12
  for (let y = floorTop, row = 0; y < room.y + room.h; y += tile, row += 1) {
    for (let x = room.x, column = 0; x < room.x + room.w; x += tile, column += 1) {
      const width = Math.min(tile, room.x + room.w - x)
      const height = Math.min(tile, room.y + room.h - y)
      push(rects, x, y, width, height, (row + column) % 2 === 0 ? palette.meetingA : palette.meetingB)
    }
  }
  // 通道：亮一点的地毯带，两边压一条细色线，像办公楼里的指引线。
  push(rects, OFFICE_AISLE.x, OFFICE_AISLE.y, OFFICE_AISLE.width, OFFICE_AISLE.height, palette.aisle)
  push(rects, OFFICE_AISLE.x, OFFICE_AISLE.y, OFFICE_AISLE.width, 1, palette.teal)
  push(rects, OFFICE_AISLE.x, OFFICE_AISLE.y + OFFICE_AISLE.height - 1, OFFICE_AISLE.width, 1, palette.teal)
}

/** 白板：带支架和万向轮，上面画了柱状图和流程框，托盘里放着彩笔。 */
function drawWhiteboard(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const { x, y, width: w, height: h } = spot
  for (const legX of [x + 10, x + w - 12]) {
    push(rects, legX, y + h, 2, 14, palette.metalDark)
    push(rects, legX - 3, y + h + 14, 8, 2, palette.outline)
  }
  push(rects, x + 10, y + h + 8, w - 20, 2, palette.metalDark)
  drawFootShadow(rects, x + 6, y + h + 16, w - 12, palette)
  pushBox(rects, x, y, w, h, palette.metal, palette.outline)
  push(rects, x + 2, y + 2, w - 4, h - 4, palette.board)
  // 左边柱状图。
  push(rects, x + 8, y + 26, 22, 1, palette.outline)
  push(rects, x + 10, y + 19, 4, 7, palette.coralDark)
  push(rects, x + 16, y + 13, 4, 13, palette.sun)
  push(rects, x + 22, y + 8, 4, 18, palette.teal)
  // 右边三个方框连成流程。
  pushBox(rects, x + 38, y + 7, 12, 8, palette.noteB, palette.outline)
  pushBox(rects, x + 58, y + 7, 12, 8, palette.noteA, palette.outline)
  pushBox(rects, x + 58, y + 22, 12, 8, palette.noteC, palette.outline)
  push(rects, x + 50, y + 10, 8, 1, palette.outline)
  push(rects, x + 64, y + 15, 1, 7, palette.outline)
  push(rects, x + 38, y + 24, 14, 1, palette.metalDark)
  push(rects, x + 38, y + 27, 10, 1, palette.metalDark)
  // 托盘和彩笔。
  push(rects, x + 4, y + h - 1, w - 8, 3, palette.metalDark)
  push(rects, x + 12, y + h - 2, 8, 2, palette.coralDark)
  push(rects, x + 24, y + h - 2, 8, 2, palette.teal)
}

/**
 * 档案架：金属架子上整排一样高的文件夹，同一种颜色挨在一起，贴着白色标签。
 * 书架高矮不一像家里，档案盒整整齐齐才像公司。
 */
function drawFileShelf(rects: PixelRect[], palette: OfficePalette): void {
  const x = 338
  const y = 30
  const w = 50
  const h = 66
  drawFootShadow(rects, x + 2, y + h, w, palette)
  pushBox(rects, x, y, w, h, palette.metal, palette.outline)
  const shelfHeight = 19
  let binder = 0
  for (let shelf = 0; shelf < 3; shelf += 1) {
    const top = y + 3 + shelf * (shelfHeight + 2)
    const bottom = top + shelfHeight
    push(rects, x + 3, top, w - 6, shelfHeight, palette.metalDark)
    push(rects, x + 3, bottom, w - 6, 2, palette.outline)
    for (let bookX = x + 4; bookX + 6 < x + w - 2; bookX += 7) {
      // 每四个文件夹换一种颜色，一组一组的。
      const color = OFFICE_ACCENTS[Math.floor(binder / 4) % OFFICE_ACCENTS.length]!
      push(rects, bookX, bottom - 16, 6, 16, color)
      push(rects, bookX + 5, bottom - 16, 1, 16, shadeColor(color, 0.8))
      push(rects, bookX + 1, bottom - 13, 3, 4, palette.board)
      // 脊背上的小圆孔，手指勾着抽出来的那个。
      push(rects, bookX + 2, bottom - 5, 2, 2, palette.outline)
      binder += 1
    }
  }
  // 架顶放两个档案箱，档案室常见的样子。
  pushBox(rects, x + 4, y - 9, 18, 9, '#e8c594', palette.outline)
  push(rects, x + 11, y - 8, 4, 7, '#f5dcb6')
  pushBox(rects, x + 26, y - 7, 15, 7, palette.board, palette.outline)
  push(rects, x + 29, y - 5, 9, 1, palette.metalDark)
}

/** 窗下的咖啡台：不锈钢台面、白色柜门，上面是咖啡机、杯子和一摞纸杯。 */
function drawCoffeeStation(rects: PixelRect[], palette: OfficePalette): void {
  const x = 396
  const y = 64
  const w = 62
  const h = 36
  drawFootShadow(rects, x + 2, y + h, w, palette)
  pushBox(rects, x, y + 5, w, h - 5, palette.board, palette.outline)
  for (let door = 0; door < 3; door += 1) {
    const doorX = x + 3 + door * 19
    pushBox(rects, doorX, y + 9, 18, h - 13, palette.monitorBody, palette.metalDark)
    push(rects, doorX + 7, y + 13, 5, 1, palette.outline)
  }
  pushBox(rects, x - 2, y, w + 4, 6, palette.metal, palette.outline)
  push(rects, x - 1, y + 1, w + 2, 1, palette.board)
  drawSprite(rects, x + 5, y - 14, SPRITE_COFFEE_MACHINE, {
    o: palette.outline, M: palette.metalDark, D: palette.noteB, g: palette.leafDark, r: palette.coralDark,
    K: palette.outline, s: palette.metal, W: palette.trim,
  })
  drawSprite(rects, x + 26, y - 5, SPRITE_MUG, { o: palette.outline, W: palette.board })
  drawSprite(rects, x + 37, y - 5, SPRITE_MUG, { o: palette.outline, W: palette.board })
  drawSprite(rects, x + 49, y - 11, SPRITE_PAPER_CUPS, { o: palette.outline, W: palette.board, R: palette.coral })
}

/** 饮水机：蓝色水桶、白色机身、一红一蓝两个出水口。气泡在 ambient.ts。 */
function drawCooler(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const { x, y, width: w, height: h } = spot
  drawFootShadow(rects, x + 1, y + h, w, palette)
  push(rects, x + 3, y, w - 6, 18, palette.outline)
  push(rects, x + 4, y + 1, w - 8, 16, palette.water)
  push(rects, x + 5, y + 2, 2, 12, shadeColor(palette.water, 1.12))
  pushBox(rects, x, y + 18, w, h - 18, palette.board, palette.outline)
  push(rects, x + 1, y + h - 8, w - 2, 7, palette.metal)
  pushBox(rects, x + 3, y + 22, 6, 5, palette.coralDark, palette.outline)
  pushBox(rects, x + w - 9, y + 22, 6, 5, palette.water, palette.outline)
  push(rects, x + 3, y + 31, w - 6, 2, palette.metalDark)
}

/** 复印机：放在文件柜顶上，出纸口露着一张纸，指示灯在 ambient.ts。 */
function drawPrinter(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const { x, y, width: w, height: h } = spot
  pushBox(rects, x + 2, y + 6, w - 4, h - 6, palette.monitorBody, palette.outline)
  push(rects, x + 3, y + 7, w - 6, 2, palette.board)
  pushBox(rects, x + 8, y, w - 16, 8, palette.board, palette.outline)
  push(rects, x + 8, y + 15, w - 16, 3, palette.outline)
  push(rects, x + 11, y + 17, w - 22, 6, palette.board)
  push(rects, x + 14, y + 19, w - 28, 1, palette.metalDark)
}

/** 文件柜：三层金属抽屉，每层一个把手和一张小标签。 */
function drawCabinet(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const { x, y, width: w, height: h } = spot
  drawFootShadow(rects, x + 2, y + h, w, palette)
  pushBox(rects, x, y, w, h, palette.metalDark, palette.outline)
  for (let row = 0; row < 3; row += 1) {
    const drawerY = y + 3 + row * 13
    pushBox(rects, x + 3, drawerY, w - 6, 12, palette.metal, palette.metalDark)
    push(rects, x + 14, drawerY + 3, 16, 3, palette.board)
    push(rects, x + 16, drawerY + 8, 12, 1, palette.outline)
  }
}

/** 一把会议椅：靠背、支柱和五星脚。 */
function drawMeetingChair(rects: PixelRect[], x: number, y: number, palette: OfficePalette): void {
  drawSprite(rects, x, y, SPRITE_OFFICE_CHAIR, {
    o: palette.outline, C: palette.chair, h: shadeColor(palette.chair, 1.2), D: shadeColor(palette.chair, 0.84), l: palette.metalDark,
  })
}

/** 后墙玻璃：磨砂腰线、金属竖框，中间挂着投屏。 */
function drawMeetingBackWall(rects: PixelRect[], palette: OfficePalette): void {
  const { x, y, w, partition } = OFFICE_MEETING_ROOM
  push(rects, x, y, w, partition, palette.glass)
  push(rects, x, y + 18, w, 6, palette.glassFrost)
  for (let post = x + 33; post < x + w; post += 33) push(rects, post, y, 2, partition, palette.metal)
  push(rects, x, y - 3, w, 3, palette.outline)
  push(rects, x, y - 2, w, 2, palette.metal)
  push(rects, x, y + partition - 2, w, 2, palette.metalDark)
  // 投屏：深色边框里一块亮屏，图表在 ambient.ts 里动。
  pushBox(rects, 312, 124, 66, 32, palette.outline, palette.outline)
  push(rects, 314, 126, 62, 28, '#f4fbff')
  push(rects, 340, 156, 10, 2, palette.metalDark)
}

/** 会议桌：长条桌，四周摆办公椅，桌上是电脑、文件、水瓶和中间的会议电话。 */
function drawMeetingTable(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const { x, y, width: w, height: h } = spot
  const seats = [x + 10, x + Math.floor(w / 2) - 8, x + w - 26]
  for (const seatX of seats) drawMeetingChair(rects, seatX, y - 10, palette)
  // 桌板和两条桌腿。
  push(rects, x + 3, y + h + 2, w - 2, 3, palette.deskShadow)
  push(rects, x + 8, y + h - 6, 4, 8, palette.metalDark)
  push(rects, x + w - 12, y + h - 6, 4, 8, palette.metalDark)
  pushBox(rects, x, y, w, h - 6, palette.table, palette.outline)
  push(rects, x + 1, y + 1, w - 2, 3, palette.woodLight)
  push(rects, x + 1, y + h - 9, w - 2, 2, palette.woodDark)
  // 桌上：两台笔记本、一叠文件、会议电话、水瓶。
  pushBox(rects, x + 12, y + 7, 15, 11, palette.monitorBody, palette.outline)
  push(rects, x + 14, y + 9, 11, 7, palette.screenOn)
  pushBox(rects, x + w - 28, y + 7, 15, 11, palette.monitorBody, palette.outline)
  push(rects, x + w - 26, y + 9, 11, 7, palette.screenOn)
  push(rects, x + 34, y + 8, 12, 9, palette.board)
  push(rects, x + 36, y + 10, 8, 1, palette.metalDark)
  push(rects, x + 36, y + 13, 6, 1, palette.metalDark)
  pushBox(rects, x + Math.floor(w / 2) - 3, y + 11, 12, 6, palette.metalDark, palette.outline)
  push(rects, x + Math.floor(w / 2) + 1, y + 13, 4, 2, palette.leaf)
  pushBox(rects, x + w - 40, y + 8, 5, 9, palette.water, palette.outline)
  for (const seatX of seats) drawMeetingChair(rects, seatX, y + h - 5, palette)
}

/** 左右两侧的玻璃墙：挡在椅子前面，所以最后画；左墙带门把手。 */
function drawMeetingSideGlass(rects: PixelRect[], palette: OfficePalette): void {
  const { x, y, w, h, partition } = OFFICE_MEETING_ROOM
  for (const wallX of [x, x + w - 6]) {
    push(rects, wallX, y, 6, h, palette.glass)
    push(rects, wallX, y + partition + 26, 6, 12, palette.glassFrost)
    push(rects, wallX, y, 1, h, palette.metalDark)
    push(rects, wallX + 5, y, 1, h, palette.metalDark)
    push(rects, wallX, y + h - 2, 6, 2, palette.metalDark)
  }
  push(rects, x + 2, y + partition + 44, 2, 12, palette.outline)
}

/** 自动贩卖机：红色机身、玻璃橱窗里三排饮料、右边按钮和投币口、下面取货口。 */
function drawVendingMachine(rects: PixelRect[], palette: OfficePalette): void {
  const { x, y, w, h } = OFFICE_VENDING
  drawFootShadow(rects, x + 2, y + h, w, palette)
  pushBox(rects, x, y, w, h, palette.coral, palette.outline)
  push(rects, x + 1, y + 1, w - 2, 2, shadeColor(palette.coral, 1.12))
  pushBox(rects, x + 3, y + 5, 25, 32, '#eaf7ff', palette.outline)
  for (let row = 0; row < 3; row += 1) {
    const shelfY = y + 7 + row * 10
    for (let column = 0; column < 4; column += 1) {
      const color = OFFICE_ACCENTS[(row * 2 + column) % OFFICE_ACCENTS.length]!
      push(rects, x + 5 + column * 6, shelfY + 1, 4, 7, color)
      push(rects, x + 6 + column * 6, shelfY, 2, 1, palette.metalDark)
    }
    push(rects, x + 4, shelfY + 8, 23, 1, palette.metalDark)
  }
  // 右边一列按钮和投币口。
  pushBox(rects, x + 30, y + 7, 6, 8, palette.board, palette.outline)
  for (let button = 0; button < 3; button += 1) push(rects, x + 32, y + 18 + button * 4, 3, 2, palette.sun)
  push(rects, x + 32, y + 31, 3, 1, palette.outline)
  pushBox(rects, x + 3, y + h - 13, 25, 9, palette.metalDark, palette.outline)
  push(rects, x + 5, y + h - 11, 21, 2, palette.outline)
}

/** 服务器机柜：五层设备，每层一行散热孔。指示灯在 ambient.ts。 */
function drawServerRack(rects: PixelRect[], palette: OfficePalette): void {
  const { x, y, w, h, units } = OFFICE_SERVER_RACK
  drawFootShadow(rects, x + 1, y + h, w, palette)
  pushBox(rects, x, y, w, h, palette.clockRim, palette.outline)
  for (let unit = 0; unit < units; unit += 1) {
    const unitY = y + 3 + unit * 9
    pushBox(rects, x + 2, unitY, w - 4, 8, palette.metalDark, shadeColor(palette.metalDark, 0.78))
    push(rects, x + 4, unitY + 5, w - 8, 1, palette.clockRim)
  }
}

/** 窗下的矮柜：白色台面放文件和小绿植，靠墙的地方不空着。 */
function drawLowCredenza(rects: PixelRect[], palette: OfficePalette): void {
  const x = 60
  const y = 70
  const w = 60
  const h = 30
  drawFootShadow(rects, x + 2, y + h, w, palette)
  pushBox(rects, x, y + 4, w, h - 4, palette.monitorBody, palette.outline)
  for (let door = 0; door < 3; door += 1) {
    const doorX = x + 3 + door * 18
    pushBox(rects, doorX, y + 8, 18, h - 12, palette.board, palette.metalDark)
    push(rects, doorX + 7, y + 12, 5, 1, palette.outline)
  }
  pushBox(rects, x - 2, y, w + 4, 5, palette.board, palette.outline)
  drawSprite(rects, x + 3, y - 12, SPRITE_DESK_PLANT, plantColors(palette))
  drawSprite(rects, x + 18, y - 7, SPRITE_FOLDERS, { o: palette.outline, R: palette.teal, B: palette.sun, Y: palette.coral })
  pushBox(rects, x + 34, y - 7, 18, 7, palette.board, palette.outline)
  push(rects, x + 37, y - 5, 12, 1, palette.metalDark)
  push(rects, x + 37, y - 3, 9, 1, palette.metalDark)
}

/** 垃圾桶：放在第三列桌子旁边，顶上露出一团纸。 */
function drawBin(rects: PixelRect[], x: number, y: number, palette: OfficePalette): void {
  drawFootShadow(rects, x + 1, y + 18, 13, palette)
  pushBox(rects, x + 3, y - 2, 8, 4, palette.board, palette.outline)
  pushBox(rects, x, y, 14, 18, palette.metalDark, palette.outline)
  push(rects, x + 1, y + 1, 12, 2, palette.metal)
  push(rects, x + 4, y + 5, 1, 10, palette.clockRim)
  push(rects, x + 9, y + 5, 1, 10, palette.clockRim)
}

/** 某盆落地绿植用哪张图：茂盛的和舒展的搭配着摆，不会千篇一律。ambient.ts 也要用。 */
export function officePlantSprite(spotId: string): readonly string[] {
  return spotId === 'plant-b' ? SPRITE_FLOOR_PLANT : SPRITE_BUSH_PLANT
}

/** 落地绿植：影子压在花盆脚下。 */
function drawFloorPlant(rects: PixelRect[], spot: OfficeSharedSpot, palette: OfficePalette): void {
  const rows = officePlantSprite(spot.id)
  drawFootShadow(rects, spot.x + 5, spot.y + spot.height - 7, spot.width - 8, palette)
  drawSprite(rects, spot.x, spot.y + spot.height - rows.length - 6, rows, plantColors(palette))
}

/** 共享区全部陈设，按从远到近的顺序画。 */
export function drawSharedFurniture(rects: PixelRect[], palette: OfficePalette): void {
  const board = spotOf('board')
  if (board !== undefined) drawWhiteboard(rects, board, palette)
  drawFileShelf(rects, palette)
  drawCoffeeStation(rects, palette)
  drawLowCredenza(rects, palette)
  const cooler = spotOf('cooler')
  if (cooler !== undefined) drawCooler(rects, cooler, palette)
  drawMeetingBackWall(rects, palette)
  const cabinet = spotOf('cabinet')
  if (cabinet !== undefined) drawCabinet(rects, cabinet, palette)
  const printer = spotOf('printer')
  if (printer !== undefined) drawPrinter(rects, printer, palette)
  drawBin(rects, 214, 150, palette)
  drawServerRack(rects, palette)
  const meeting = spotOf('meeting')
  if (meeting !== undefined) drawMeetingTable(rects, meeting, palette)
  drawMeetingSideGlass(rects, palette)
  drawVendingMachine(rects, palette)
  for (const id of ['plant-a', 'plant-c', 'plant-b']) {
    const plant = spotOf(id)
    if (plant !== undefined) drawFloorPlant(rects, plant, palette)
  }
}
