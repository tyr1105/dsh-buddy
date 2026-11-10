/**
 * 坐在工位上的小人（P54）：Q 版大头，有眼睛、腮红、头发和衣服。
 *
 * 人坐在桌子后面、面朝观众，所以这里只画桌面以上的部分：
 * 渲染时先画椅背和人，再画桌子，下半身自然被桌子挡住。
 *
 * 外观全部来自 appearance.ts 的固定外观（同一个队友永远长一个样）。
 * 这里唯一看状态的地方是眼睛：休息和离线时闭着。其余动作在 ambient.ts，也只认真实状态。
 */
import type { OfficeLight } from '../../shared/views.js'
import type { OfficeAppearance, OfficeHairStyle } from './appearance.js'
import type { OfficeSeatLayout } from './layout.js'
import type { OfficePalette } from './palette.js'
import { drawSprite, pushRect as push, shadeColor, type PixelRect, type SpriteColors } from './pixel-kit.js'

/** 小人左边缘的 x：16 像素宽，以座位中心对齐。 */
export function figureLeft(seat: OfficeSeatLayout): number {
  return seat.seatX - 8
}

/** 头顶的 y：头 14 行、身子 8 行，正好到桌子后沿。头大身子短才是 Q 版。 */
export function figureHeadTop(seat: OfficeSeatLayout): number {
  return seat.deskY - 22
}

/** 眼睛在头部字符画里的位置：左右各 2 像素宽、3 像素高。 */
export const FIGURE_EYE_ROW = 7
export const FIGURE_EYE_HEIGHT = 3
export const FIGURE_EYE_COLUMNS = [4, 10] as const

/** 这几种状态闭着眼。 */
export function figureEyesClosed(light: OfficeLight): boolean {
  return light === 'resting' || light === 'offline'
}

/** 头：o 描边、S 皮肤。五官另外画，方便按状态换。 */
const HEAD: readonly string[] = [
  '...oooooooooo...',
  '..oSSSSSSSSSSo..',
  '.oSSSSSSSSSSSSo.',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  'oSSSSSSSSSSSSSSo',
  '.oSSSSSSSSSSSSo.',
  '..oSSSSSSSSSSo..',
  '...oooooooooo...',
]

/** 身子：T 衣服、D 衣服暗部（手臂和身体的分界）、C 领口。 */
const BODY: readonly string[] = [
  '...oTTCCCCTTo...',
  '..oTTTTCCTTTTo..',
  '.oTTTTTTTTTTTTo.',
  '.oTTDTTTTTTDTTo.',
  '.oTTDTTTTTTDTTo.',
  '.oTTDTTTTTTDTTo.',
  '.oTTDTTTTTTDTTo.',
  '.oTTDTTTTTTDTTo.',
]

/** 六种发型叠在头上：H 头发、h 高光、o 描边，点号露出下面的脸。top 是相对头顶的起始行。 */
const HAIR: Readonly<Record<OfficeHairStyle, { top: number; rows: readonly string[] }>> = {
  short: { top: 0, rows: [
    '...oooooooooo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHhhhHHHHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHHH.HHH.HHHHHo',
    'oHH..........HHo',
  ] },
  bowl: { top: 0, rows: [
    '...oooooooooo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHhhhHHHHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHH........HHHo',
    'oHH..........HHo',
  ] },
  spiky: { top: -2, rows: [
    '....o..o..o.....',
    '...oHooHooHoo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHhhHHHHHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHH.HH.HH.HHHHo',
    'oHH..........HHo',
  ] },
  bob: { top: 0, rows: [
    '...oooooooooo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHhhhHHHHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHHHHHHo',
    'oHHHH......HHHHo',
    'oHHH........HHHo',
    'oHHH........HHHo',
    'oHHH........HHHo',
    'oHHH........HHHo',
    'oHHHo......oHHHo',
    '.oooo......oooo.',
  ] },
  buzz: { top: 0, rows: [
    '...oooooooooo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHHHHHHHHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHH..........HHo',
  ] },
  side: { top: 0, rows: [
    '...oooooooooo...',
    '..oHHHHHHHHHHo..',
    '.oHHHHHHHHhhHHo.',
    'oHHHHHHHHHHHHHHo',
    'oHHHHHHHHHH.....',
    'oHHHHHHH........',
    'oHHH............',
  ] },
}

/** 帽子：C 帽身、c 高光，帽檐比头宽一点。 */
const CAP: readonly string[] = [
  '...oooooooooo...',
  '..oCCCCCCCCCCo..',
  '.oCCcCCCCCCCCCo.',
  'oCCCcCCCCCCCCCCo',
  'oCCCCCCCCCCCCCCo',
  'oooooooooooooooooo',
]

/** 眼镜：只画框，眼睛露在框里。 */
const GLASSES: readonly string[] = [
  '...oooo..oooo...',
  '...o..oooo..o...',
  '...o..o..o..o...',
  '...o..o..o..o...',
  '...oooo..oooo...',
]

/** 画一个人：身子、头、五官、发型、配饰。 */
export function drawFigure(rects: PixelRect[], seat: OfficeSeatLayout, look: OfficeAppearance, light: OfficeLight, palette: OfficePalette): void {
  const x = figureLeft(seat)
  const top = figureHeadTop(seat)
  const outline = palette.outline

  const bodyColors: SpriteColors = {
    o: outline, T: look.shirt, D: shadeColor(look.shirt, 0.84), C: shadeColor(look.shirt, 1.22),
  }
  drawSprite(rects, x, top + 14, BODY, bodyColors)
  if (look.accessory === 'scarf') {
    push(rects, x + 3, top + 14, 10, 2, look.accessoryColor)
    push(rects, x + 10, top + 16, 3, 4, look.accessoryColor)
  }

  drawSprite(rects, x, top, HEAD, { o: outline, S: look.skin })

  // 五官：两只眼、两团腮红、一点嘴。
  for (const column of FIGURE_EYE_COLUMNS) {
    if (figureEyesClosed(light)) {
      push(rects, x + column, top + FIGURE_EYE_ROW + 1, 2, 1, outline)
    } else {
      push(rects, x + column, top + FIGURE_EYE_ROW, 2, FIGURE_EYE_HEIGHT, outline)
      push(rects, x + column, top + FIGURE_EYE_ROW, 1, 1, '#ffffff')
    }
  }
  push(rects, x + 2, top + 10, 2, 1, 'rgba(255, 130, 130, 0.6)')
  push(rects, x + 12, top + 10, 2, 1, 'rgba(255, 130, 130, 0.6)')
  push(rects, x + 7, top + 11, 2, 1, shadeColor(look.skin, 0.66))

  const hair = HAIR[look.hair]
  const hairColors: SpriteColors = { o: outline, H: look.hairColor, h: shadeColor(look.hairColor, 1.3) }
  drawSprite(rects, x, top + hair.top, hair.rows, hairColors)

  if (look.accessory === 'cap') {
    drawSprite(rects, x, top, CAP, { o: outline, C: look.accessoryColor, c: shadeColor(look.accessoryColor, 1.3) })
  } else if (look.accessory === 'glasses') {
    drawSprite(rects, x, top + 6, GLASSES, { o: outline })
  }
}
