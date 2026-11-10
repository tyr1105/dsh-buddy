/**
 * 像素办公室的画图小工具（P54）：矩形、裁剪、字符画精灵、圆和直线。
 *
 * 为什么要有「字符画精灵」：像素画一个点一个点写坐标，又累又看不出长什么样。
 * 改成下面这种写法后，代码本身就是一张小图，改一只猫的耳朵只要改一个字符：
 *   '.oo.'
 *   'oOOo'
 * 点号代表透明，其他字符去颜色表里查。
 *
 * 这个文件只做计算、不碰 canvas，所有函数都往一个矩形列表里追加内容，方便单测逐块断言。
 */
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH } from './layout.js'

/** 一个可绘制矩形；颜色用 CSS 字符串，页面直接赋给 fillStyle。 */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
  color: string
}

/** 一块裁剪区：画到区域外的部分直接丢掉。窗外的云要靠它躲开窗框和窗帘。 */
export interface PixelClip {
  x: number
  y: number
  w: number
  h: number
}

/** 字符画的颜色表：键是一个字符，值是 CSS 颜色。 */
export type SpriteColors = Readonly<Record<string, string>>

export interface SpriteOptions {
  /** 左右翻转：同一张猫的图，朝左朝右都能用。 */
  flip?: boolean
  clip?: PixelClip
}

/** 把矩形裁到一个区域内；完全在区域外就返回 null。 */
function clipRect(x: number, y: number, w: number, h: number, clip: PixelClip): PixelClip | null {
  const left = Math.max(x, clip.x)
  const top = Math.max(y, clip.y)
  const right = Math.min(x + w, clip.x + clip.w)
  const bottom = Math.min(y + h, clip.y + clip.h)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 整张画布，所有矩形最后都要落在里面。 */
const CANVAS: PixelClip = { x: 0, y: 0, w: OFFICE_PIXEL_WIDTH, h: OFFICE_PIXEL_HEIGHT }

/** 追加一块矩形：超出画布的部分裁掉，面积为零的直接丢弃。 */
export function pushRect(rects: PixelRect[], x: number, y: number, w: number, h: number, color: string): void {
  const inside = clipRect(x, y, w, h, CANVAS)
  if (inside === null) return
  rects.push({ ...inside, color })
}

/** 追加一块矩形，并且只保留落在 clip 里的部分。 */
export function pushClipped(rects: PixelRect[], x: number, y: number, w: number, h: number, color: string, clip: PixelClip): void {
  const inside = clipRect(x, y, w, h, clip)
  if (inside === null) return
  pushRect(rects, inside.x, inside.y, inside.w, inside.h, color)
}

/** 带描边的方块：家具最常用的形状，外面一圈描边、里面一块填充色。 */
export function pushBox(rects: PixelRect[], x: number, y: number, w: number, h: number, fill: string, outline: string): void {
  pushRect(rects, x, y, w, h, outline)
  pushRect(rects, x + 1, y + 1, w - 2, h - 2, fill)
}

/**
 * 画一张字符画。
 * 同一行里连续相同的字符会并成一块矩形，一只猫从上百块降到几十块，画起来更省。
 */
export function drawSprite(
  rects: PixelRect[], x: number, y: number, rows: readonly string[], colors: SpriteColors, options: SpriteOptions = {},
): void {
  const { flip = false, clip } = options
  // 翻转时要按最宽的一行来算镜像位置，否则长短不一的行会错位。
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  rows.forEach((row, rowIndex) => {
    let start = 0
    while (start < row.length) {
      const key = row.charAt(start)
      let end = start + 1
      while (end < row.length && row.charAt(end) === key) end += 1
      const color = colors[key]
      if (color !== undefined) {
        const left = flip ? x + width - end : x + start
        if (clip === undefined) pushRect(rects, left, y + rowIndex, end - start, 1, color)
        else pushClipped(rects, left, y + rowIndex, end - start, 1, color, clip)
      }
      start = end
    }
  })
}

/** 实心像素圆：一行一行算出半宽。半径多加 0.5，圆边才不会尖。 */
export function fillPixelDisc(rects: PixelRect[], cx: number, cy: number, radius: number, color: string, clip?: PixelClip): void {
  for (let dy = -radius; dy <= radius; dy += 1) {
    const half = Math.floor(Math.sqrt((radius + 0.5) ** 2 - dy * dy))
    if (clip === undefined) pushRect(rects, cx - half, cy + dy, half * 2 + 1, 1, color)
    else pushClipped(rects, cx - half, cy + dy, half * 2 + 1, 1, color, clip)
  }
}

/** 像素直线（布雷森汉姆算法）：钟的指针要靠它，任何角度都是一条连续的线。 */
export function drawPixelLine(
  rects: PixelRect[], x0: number, y0: number, x1: number, y1: number, color: string, thickness = 1,
): void {
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const stepX = x0 < x1 ? 1 : -1
  const stepY = y0 < y1 ? 1 : -1
  let error = dx - dy
  let x = x0
  let y = y0
  for (let guard = 0; guard <= dx + dy + 1; guard += 1) {
    pushRect(rects, x, y, thickness, thickness, color)
    if (x === x1 && y === y1) break
    const doubled = 2 * error
    if (doubled > -dy) { error -= dy; x += stepX }
    if (doubled < dx) { error += dx; y += stepY }
  }
}

/**
 * 把十六进制颜色调亮或调暗：factor 小于 1 变暗，大于 1 变亮。
 * 衣服的暗部、头发的高光都从底色算出来，新增一种颜色时不用再配一套。
 * 传进来的不是 #rrggbb（比如半透明色）就原样返回。
 */
export function shadeColor(color: string, factor: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (match === null) return color
  const value = parseInt(match[1] ?? '000000', 16)
  const channel = (shift: number): number => Math.min(255, Math.round(((value >> shift) & 255) * factor))
  return `#${[channel(16), channel(8), channel(0)].map(part => part.toString(16).padStart(2, '0')).join('')}`
}
