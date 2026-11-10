/**
 * 六个工位的家具（P54）：彩色隔断、办公椅、白面办公桌、显示器、键盘和桌上的办公用品。
 *
 * 画的时候分前后两步，因为人坐在桌子后面：
 * 第一步 drawPartition、drawChairBack 画在人后面；第二步 drawDesk 画在人前面，把下半身挡住。
 *
 * 隔断是让这里看起来像办公室的关键：一整排隔板连在一起，每个座位一块彩色布面，
 * 上面钉着便签。桌上的东西按座位号固定，只是摆设，不表示任何状态，也不随队友变化。
 */
import type { OfficeSeatLayout } from './layout.js'
import { OFFICE_PANEL_COLORS, type OfficePalette } from './palette.js'
import { drawSprite, pushBox, pushRect as push, shadeColor, type PixelClip, type PixelRect, type SpriteColors } from './pixel-kit.js'
import {
  SPRITE_DESK_PHONE, SPRITE_DESK_PLANT, SPRITE_DOC_TRAY, SPRITE_FOLDERS, SPRITE_MUG, SPRITE_PENCIL_CUP,
} from './sprites.js'

/** 显示器屏幕的区域；ambient.ts 要在这里面画滚动的代码、问号等内容。 */
export function deskScreen(seat: OfficeSeatLayout): PixelClip {
  return { x: seat.deskX + 7, y: seat.deskY - 6, w: 16, h: 10 }
}

/** 键盘的区域；ambient.ts 把手放在这上面。 */
export function deskKeyboard(seat: OfficeSeatLayout): PixelClip {
  return { x: seat.seatX - 7, y: seat.deskY + 8, w: 15, h: 4 }
}

/** 每个座位隔板上钉的小东西：相对隔板左上角的位置、大小、颜色键。 */
const PINNED: readonly (readonly (readonly [number, number, number, number, 'noteA' | 'noteB' | 'noteC' | 'noteD' | 'board'])[])[] = [
  [[12, 5, 9, 8, 'noteA'], [24, 7, 8, 7, 'board'], [54, 5, 9, 9, 'noteC']],
  [[11, 6, 8, 8, 'noteB'], [22, 5, 9, 8, 'noteD'], [55, 7, 8, 8, 'noteA']],
  [[13, 5, 10, 7, 'board'], [26, 7, 7, 7, 'noteC'], [54, 5, 9, 8, 'noteD']],
  [[12, 7, 8, 7, 'noteD'], [23, 5, 9, 8, 'noteA'], [55, 5, 8, 9, 'board']],
  [[11, 5, 9, 9, 'noteC'], [23, 6, 8, 8, 'board'], [54, 6, 9, 8, 'noteB']],
  [[13, 6, 8, 8, 'board'], [24, 5, 9, 8, 'noteB'], [55, 7, 8, 7, 'noteC']],
]

/** 工位隔断：一块彩色布面，上沿一根金属横杆，两侧立柱，布面上钉着便签。 */
export function drawPartition(rects: PixelRect[], seat: OfficeSeatLayout, palette: OfficePalette): void {
  const color = OFFICE_PANEL_COLORS[seat.index % OFFICE_PANEL_COLORS.length]!
  const x = seat.deskX - 9
  const top = seat.deskY - 27
  const width = 68
  const height = 30
  push(rects, x, top, width, height, palette.outline)
  push(rects, x + 1, top + 1, width - 2, height - 1, color)
  // 布面上一行行浅色小点，看起来是织物，不是一块塑料。
  const weave = shadeColor(color, 1.08)
  for (let row = top + 5; row < top + height - 2; row += 3) {
    for (let dot = x + 4 + ((row - top) % 2) * 2; dot < x + width - 3; dot += 4) push(rects, dot, row, 1, 1, weave)
  }
  push(rects, x + 1, top + 1, width - 2, 2, palette.metal)
  // 左右两根金属立柱，相邻座位的隔板就连成了一整排。
  push(rects, x, top - 1, 3, height + 1, palette.metalDark)
  push(rects, x + width - 3, top - 1, 3, height + 1, palette.metalDark)
  for (const [dx, dy, w, h, key] of PINNED[seat.index % PINNED.length] ?? []) {
    push(rects, x + dx, top + dy, w, h, palette[key])
    push(rects, x + dx + 1, top + dy + 3, w - 3, 1, palette.metalDark)
    push(rects, x + dx + Math.floor(w / 2), top + dy - 1, 2, 2, palette.coralDark)
  }
}

/** 办公椅：高靠背、头枕和两个扶手，空位时也整整齐齐摆着。 */
export function drawChairBack(rects: PixelRect[], seat: OfficeSeatLayout, palette: OfficePalette): void {
  const left = seat.seatX - 10
  const top = seat.deskY - 19
  const width = 20
  const height = 20
  // 靠背切掉两个顶角，看起来是圆润的软包。
  push(rects, left + 2, top, width - 4, height, palette.outline)
  push(rects, left, top + 2, width, height - 2, palette.outline)
  push(rects, left + 1, top + 1, width - 2, height - 1, palette.outline)
  push(rects, left + 2, top + 1, width - 4, height - 1, palette.chair)
  push(rects, left + 1, top + 3, width - 2, height - 3, palette.chair)
  push(rects, left + 3, top + 2, width - 6, 2, shadeColor(palette.chair, 1.2))
  push(rects, left + 1, top + height - 4, width - 2, 4, shadeColor(palette.chair, 0.84))
  // 扶手从靠背两侧伸出来。
  push(rects, left - 2, top + 12, 3, 2, palette.outline)
  push(rects, left + width - 1, top + 12, 3, 2, palette.outline)
}

/** 显示器：浅色外壳，屏幕亮或灭。底座落在桌面上。 */
function drawMonitor(rects: PixelRect[], seat: OfficeSeatLayout, screenOn: boolean, palette: OfficePalette): void {
  const x = seat.deskX + 5
  const y = seat.deskY - 8
  pushBox(rects, x, y, 20, 14, palette.monitorBody, palette.outline)
  const screen = deskScreen(seat)
  push(rects, screen.x, screen.y, screen.w, screen.h, screenOn ? palette.screenOn : palette.screen)
  // 熄屏时左上角一道斜光，看得出是块玻璃，而不是一个灰方块。
  if (!screenOn) {
    push(rects, screen.x + 2, screen.y + 2, 3, 1, shadeColor(palette.screen, 1.25))
    push(rects, screen.x + 2, screen.y + 3, 1, 2, shadeColor(palette.screen, 1.25))
  }
  push(rects, x + 8, y + 14, 4, 2, palette.metalDark)
  push(rects, x + 5, y + 16, 10, 2, palette.outline)
  push(rects, x + 6, y + 16, 8, 1, palette.metal)
}

/** 键盘：一块浅色板，上面两行小点当按键。 */
function drawKeyboard(rects: PixelRect[], seat: OfficeSeatLayout, palette: OfficePalette): void {
  const board = deskKeyboard(seat)
  pushBox(rects, board.x, board.y, board.w, board.h, palette.monitorBody, palette.outline)
  for (let x = board.x + 2; x < board.x + board.w - 2; x += 2) {
    push(rects, x, board.y + 1, 1, 1, palette.metalDark)
    push(rects, x, board.y + 2, 1, 1, palette.metalDark)
  }
}

/** 桌上小物件的共用颜色表。 */
function itemColors(palette: OfficePalette): SpriteColors {
  return {
    o: palette.outline, d: palette.leafDark, l: palette.leaf, h: palette.leafLight, r: palette.trim,
    p: palette.pot, P: palette.potDark,
  }
}

/** 按座位号摆桌上的办公用品，放在键盘右边的桌角。 */
function drawDeskItems(rects: PixelRect[], seat: OfficeSeatLayout, palette: OfficePalette): void {
  const x = seat.deskX + 41
  const y = seat.deskY
  const colors = itemColors(palette)
  switch (seat.index) {
    case 0:
      drawSprite(rects, x, y + 3, SPRITE_PENCIL_CUP, { ...colors, W: palette.noteB, r: palette.coralDark, b: palette.teal, y: palette.sunDark })
      break
    case 1:
      drawSprite(rects, x - 1, y + 4, SPRITE_DESK_PHONE, { o: palette.outline, H: palette.clockRim, B: palette.metal, k: palette.metalDark })
      break
    case 2:
      drawSprite(rects, x, y + 6, SPRITE_MUG, { o: palette.outline, W: palette.coral })
      break
    case 3:
      drawSprite(rects, x - 1, y + 5, SPRITE_DOC_TRAY, { o: palette.outline, W: palette.board, L: palette.metalDark, T: palette.noteB })
      break
    case 4:
      drawSprite(rects, x - 2, y - 2, SPRITE_DESK_PLANT, colors)
      break
    default:
      drawSprite(rects, x - 1, y + 5, SPRITE_FOLDERS, { o: palette.outline, R: palette.coral, B: palette.noteB, Y: palette.sun })
      break
  }
}

/** 办公桌：地上一道影子、白色桌面、亮边、浅钢蓝桌身。每张桌只用一块 palette.desk 铺桌身。 */
export function drawDesk(rects: PixelRect[], seat: OfficeSeatLayout, screenOn: boolean, palette: OfficePalette): void {
  const { deskX: x, deskY: y, deskWidth: w, deskHeight: h } = seat
  push(rects, x + 2, y + h, w, 3, palette.deskShadow)
  push(rects, x, y, w, h, palette.outline)
  push(rects, x + 1, y + 1, w - 2, 11, palette.deskTop)
  push(rects, x + 1, y + 12, w - 2, 1, palette.deskEdge)
  push(rects, x + 1, y + 14, w - 2, h - 15, palette.desk)
  push(rects, x + 1, y + 14, w - 2, 1, shadeColor(palette.desk, 1.12))
  // 右边一组活动柜，左边是挡板，桌身就不是一大块纯色。
  const drawerX = x + w - 18
  for (let row = 0; row < 2; row += 1) {
    const drawerY = y + 16 + row * 5
    push(rects, drawerX, drawerY, 15, 4, shadeColor(palette.desk, 1.12))
    push(rects, drawerX + 5, drawerY + 1, 5, 1, palette.outline)
  }
  push(rects, x + 6, y + 18, 22, 1, shadeColor(palette.desk, 0.9))
  push(rects, x + 6, y + 22, 22, 1, shadeColor(palette.desk, 0.9))
  drawMonitor(rects, seat, screenOn, palette)
  drawKeyboard(rects, seat, palette)
  drawDeskItems(rects, seat, palette)
}
