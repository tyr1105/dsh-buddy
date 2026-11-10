/**
 * 像素办公室的两扇窗（P54）：铝合金窗框、百叶帘、窗外的天色和写字楼群。
 *
 * 为什么单独一个文件：窗是房间里唯一「跟着真实时间变」的大块画面，
 * 规则比别的摆设多（四种天色、太阳从左窗走到右窗、夜里楼房亮灯）。
 * 这里只认传进来的 OfficeMoment，不自己读时间，同一时刻永远画出同一扇窗。
 *
 * 云和星星的闪烁属于动画，在 ambient.ts 里画。它们要躲开窗框和百叶帘，
 * 所以这里把「能看见天空的那几块玻璃」用 officeWindowPanes 算出来给 ambient 用。
 */
import { officeDayPhase, officeSkyBody, type OfficeDayPhase, type OfficeMoment } from './moment.js'
import type { OfficePalette } from './palette.js'
import { fillPixelDisc, pushRect as push, shadeColor, type PixelClip, type PixelRect } from './pixel-kit.js'

export interface OfficeWindowSpec {
  x: number
  y: number
  w: number
  h: number
}

/** 左窗在工作区，右窗在共享区，太阳按时间从左窗移动到右窗。 */
export const OFFICE_WINDOWS: readonly [OfficeWindowSpec, OfficeWindowSpec] = [
  { x: 52, y: 14, w: 72, h: 40 },
  { x: 398, y: 14, w: 70, h: 40 },
]

/** 白天太阳的颜色，单独命名方便测试确认太阳真的在窗外。 */
export const OFFICE_SUN_COLOR = '#ffe27a'

/** 百叶帘放下来的高度：挡住玻璃最上面这一段，看得见天空的只有下面的部分。 */
const BLIND_HEIGHT = 11

/** 玻璃的区域：窗框内侧。 */
function glassOf(spec: OfficeWindowSpec): PixelClip {
  return { x: spec.x + 2, y: spec.y + 2, w: spec.w - 4, h: spec.h - 4 }
}

/** 两根竖向窗框的 x 位置：写字楼的窗是一格格竖条，不是家里的十字窗。 */
function mullionsOf(spec: OfficeWindowSpec): [number, number] {
  const third = Math.floor(spec.w / 3)
  return [spec.x + third - 1, spec.x + third * 2 - 1]
}

/**
 * 能看见天空的三块玻璃：扣掉百叶帘和竖框。
 * 云只在这三块里画，飘过窗框时就像真的被挡住了。
 */
export function officeWindowPanes(spec: OfficeWindowSpec): PixelClip[] {
  const glass = glassOf(spec)
  const top = glass.y + BLIND_HEIGHT
  const height = glass.h - BLIND_HEIGHT
  const [first, second] = mullionsOf(spec)
  return [
    { x: glass.x, y: top, w: first - glass.x, h: height },
    { x: first + 2, y: top, w: second - first - 2, h: height },
    { x: second + 2, y: top, w: glass.x + glass.w - second - 2, h: height },
  ]
}

/** 四种天色，从上到下分几条色带；像素风里一条条的色带比平滑渐变更好看。 */
export function officeSkyBands(phase: OfficeDayPhase, palette: OfficePalette): string[] {
  switch (phase) {
    case 'dawn': return ['#9cc4f0', '#ffc9b4', '#ffe4b8']
    case 'day': return [palette.windowSky, palette.windowSkyDeep]
    case 'dusk': return ['#7f8fe0', '#ff9f92', '#ffd392']
    case 'night': return ['#2f3e80', '#46569e']
  }
}

/** 窗外的写字楼：相对玻璃左下角的位置，高矮错落，每扇窗各一组。 */
const SKYLINES: readonly (readonly { dx: number; w: number; h: number }[])[] = [
  [{ dx: 3, w: 11, h: 14 }, { dx: 16, w: 9, h: 20 }, { dx: 27, w: 12, h: 11 }, { dx: 41, w: 9, h: 18 }, { dx: 52, w: 12, h: 13 }],
  [{ dx: 2, w: 12, h: 12 }, { dx: 16, w: 10, h: 19 }, { dx: 28, w: 9, h: 13 }, { dx: 39, w: 12, h: 21 }, { dx: 53, w: 9, h: 11 }],
]

/** 楼的颜色按天色分几组：白天是浅蓝的玻璃幕墙，黄昏偏紫，夜里深蓝。 */
function buildingColors(phase: OfficeDayPhase): readonly string[] {
  if (phase === 'night') return ['#27316a', '#2f3b78', '#242c60']
  if (phase === 'dusk') return ['#a98ab0', '#8f83bb', '#b18aa6']
  if (phase === 'dawn') return ['#c4b2d0', '#aeb1da', '#cdb5c8']
  return ['#b9d3ec', '#d4e3f2', '#a7c7e6']
}

/** 夜里固定位置的星星，相对玻璃左上角，都在百叶帘下方。闪烁在 ambient.ts。 */
export const OFFICE_NIGHT_STARS: readonly (readonly (readonly [number, number])[])[] = [
  [[6, 13], [17, 16], [29, 14], [38, 17], [46, 13], [58, 15], [24, 18]],
  [[8, 15], [19, 13], [31, 16], [43, 14], [50, 17], [60, 13], [26, 18]],
]

/** 画窗外：天色、星星、日月、楼群。全部裁在玻璃范围内。 */
function drawOutside(rects: PixelRect[], spec: OfficeWindowSpec, index: number, moment: OfficeMoment, palette: OfficePalette): void {
  const glass = glassOf(spec)
  const phase = officeDayPhase(moment)
  const bands = officeSkyBands(phase, palette)
  const bandH = Math.ceil(glass.h / bands.length)
  bands.forEach((color, bandIndex) => {
    const y = glass.y + bandIndex * bandH
    push(rects, glass.x, y, glass.w, Math.min(bandH, glass.y + glass.h - y), color)
  })
  if (phase === 'night') {
    for (const [dx, dy] of OFFICE_NIGHT_STARS[index] ?? []) push(rects, glass.x + dx, glass.y + dy, 1, 1, '#c9d4ff')
  }

  // 只有一个太阳（或月亮），由时间决定它此刻在哪扇窗。它只在百叶帘下面露出来。
  const body = officeSkyBody(moment)
  if (body !== null && body.windowIndex === index) {
    const skyTop = glass.y + BLIND_HEIGHT
    const cx = glass.x + 10 + Math.round(body.u * (glass.w - 20))
    const cy = skyTop + 5 + Math.round(body.v * (glass.h - BLIND_HEIGHT - 12))
    const clip: PixelClip = { x: glass.x, y: skyTop, w: glass.w, h: glass.h - BLIND_HEIGHT }
    if (body.kind === 'sun') {
      const sunColor = phase === 'day' ? OFFICE_SUN_COLOR : '#ffc27a'
      fillPixelDisc(rects, cx, cy, 6, 'rgba(255, 255, 255, 0.32)', clip)
      fillPixelDisc(rects, cx, cy, 4, sunColor, clip)
    } else {
      fillPixelDisc(rects, cx, cy, 4, '#fff6d8', clip)
      push(rects, cx - 2, cy - 1, 2, 2, '#ece0bc')
      push(rects, cx + 1, cy + 1, 1, 1, '#ece0bc')
    }
  }

  // 写字楼贴着窗台，高低错开；夜里亮起一部分窗户，亮哪几扇由位置算出来，不会闪。
  const colors = buildingColors(phase)
  const groundY = glass.y + glass.h
  ;(SKYLINES[index] ?? []).forEach((building, buildingIndex) => {
    const color = colors[buildingIndex % colors.length]!
    const left = glass.x + building.dx
    const top = groundY - building.h
    push(rects, left, top, building.w, building.h, color)
    push(rects, left, top, building.w, 1, shadeColor(color, 1.12))
    for (let row = top + 2; row < groundY - 1; row += 2) {
      for (let column = left + 1; column < left + building.w - 1; column += 2) {
        const lit = phase === 'night' || phase === 'dusk' ? (row * 7 + column * 13) % 3 !== 0 : false
        push(rects, column, row, 1, 1, lit ? '#ffe08a' : shadeColor(color, 0.88))
      }
    }
  })
}

/** 百叶帘：一条白一条灰的横片，底下一根横杆和一根拉绳。 */
function drawBlind(rects: PixelRect[], spec: OfficeWindowSpec, palette: OfficePalette): void {
  const glass = glassOf(spec)
  for (let row = 0; row < BLIND_HEIGHT - 1; row += 1) {
    push(rects, glass.x, glass.y + row, glass.w, 1, row % 2 === 0 ? palette.blind : palette.blindShade)
  }
  push(rects, glass.x, glass.y + BLIND_HEIGHT - 1, glass.w, 1, palette.metalDark)
  push(rects, glass.x + glass.w - 5, glass.y + BLIND_HEIGHT, 1, 7, palette.metalDark)
  push(rects, glass.x + glass.w - 6, glass.y + BLIND_HEIGHT + 7, 3, 2, palette.metalDark)
}

/** 画一扇完整的窗：受光、窗框、窗外、竖框、百叶帘、窄窗台。 */
export function drawOfficeWindow(rects: PixelRect[], spec: OfficeWindowSpec, index: number, moment: OfficeMoment, palette: OfficePalette): void {
  // 窗框四周比墙面亮一档，像有光从窗里透出来。
  push(rects, spec.x - 3, spec.y - 3, spec.w + 6, spec.h + 6, palette.wallGlow)
  push(rects, spec.x - 1, spec.y - 1, spec.w + 2, spec.h + 2, palette.outline)
  push(rects, spec.x, spec.y, spec.w, spec.h, palette.windowFrame)
  drawOutside(rects, spec, index, moment, palette)
  for (const mullion of mullionsOf(spec)) push(rects, mullion, spec.y + 2, 2, spec.h - 4, palette.windowFrame)
  drawBlind(rects, spec, palette)
  push(rects, spec.x - 2, spec.y + spec.h, spec.w + 4, 2, palette.trim)
  push(rects, spec.x - 2, spec.y + spec.h + 2, spec.w + 4, 1, palette.trimShadow)
}
