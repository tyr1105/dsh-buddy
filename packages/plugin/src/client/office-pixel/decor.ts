/**
 * 像素办公室的墙面与地面（P36 起，P54 改成明亮的写字楼风格）。
 *
 * 为什么单独一个文件：渲染核心负责「谁坐在哪、状态是什么」，属于数据投影；
 * 天花、墙、玻璃门、挂钟、日历、看板和地上的光只负责房间氛围，两者混在一起会越来越难读。
 *
 * 让它像办公室而不是家的几样东西都在这里：吸顶灯板、企业色带、玻璃门、门禁读卡器、
 * 安全出口灯、灭火器、组织架构图、方块地毯。
 *
 * 这里不读时间、不读随机数、也不碰 OfficeView：钟面和日历用的时间由调用方传进来，
 * 队友状态永远只来自投影。
 *
 * 调用顺序：地板和地面光影先画，家具后画，这样光斑只落在地上，不会把桌子和小人染色。
 */
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH } from './layout.js'
import {
  clockHandEnd, clockHourAngle, clockMinuteAngle, officeDayPhase, officeSunLean, type OfficeMoment,
} from './moment.js'
import type { OfficePalette } from './palette.js'
import { drawPixelLine, fillPixelDisc, pushBox, pushRect as push, type PixelRect } from './pixel-kit.js'
import { PIXEL_DIGITS } from './sprites.js'
import { OFFICE_WINDOWS, drawOfficeWindow } from './window-view.js'

/** 墙面高度；地面从这里开始。 */
export const OFFICE_WALL_HEIGHT = 86
/** 工作区与共享区的分界：左边六个工位，右边共享设备和会议室。 */
const ZONE_SPLIT = 234
/** 天花板占墙面最上面这几行。 */
const CEILING_HEIGHT = 8

/** 挂钟的位置和指针长度；秒针在 ambient.ts 里画，也要用这份数据。 */
export const OFFICE_CLOCK = { cx: 146, cy: 30, radius: 13, hourLength: 6, minuteLength: 10, secondLength: 11 } as const

/** 门禁读卡器的指示灯位置；ambient.ts 让它闪。 */
export const OFFICE_CARD_READER_LED = { x: 45, y: 44 } as const

// —— 墙 ——

/** 墙面底子：天花板、白墙、企业色带、下半截浅色墙、踢脚线。 */
export function drawWallBase(rects: PixelRect[], palette: OfficePalette): void {
  push(rects, 0, 0, OFFICE_PIXEL_WIDTH, OFFICE_WALL_HEIGHT, palette.wall)
  push(rects, 0, 60, OFFICE_PIXEL_WIDTH, 22, palette.wallLower)
  // 色带：一粗一细两道，写字楼走廊里常见的做法。
  push(rects, 0, 57, OFFICE_PIXEL_WIDTH, 3, palette.wallAccent)
  push(rects, 0, 60, OFFICE_PIXEL_WIDTH, 1, palette.wallAccentThin)
  push(rects, 0, 82, OFFICE_PIXEL_WIDTH, 3, palette.trim)
  push(rects, 0, 85, OFFICE_PIXEL_WIDTH, 1, palette.trimShadow)
}

/** 天花板：一格格的吊顶，嵌着长条的 LED 灯板。灯板全天亮着，这才是办公室。 */
function drawCeiling(rects: PixelRect[], palette: OfficePalette): void {
  push(rects, 0, 0, OFFICE_PIXEL_WIDTH, CEILING_HEIGHT, palette.ceiling)
  for (let x = 0; x < OFFICE_PIXEL_WIDTH; x += 30) push(rects, x, 0, 1, CEILING_HEIGHT, palette.ceilingGrid)
  for (let x = 18; x < OFFICE_PIXEL_WIDTH; x += 60) {
    push(rects, x - 1, 1, 36, 5, palette.ceilingGrid)
    push(rects, x, 2, 34, 3, palette.lampBulb)
  }
  push(rects, 0, CEILING_HEIGHT, OFFICE_PIXEL_WIDTH, 1, palette.trimShadow)
}

/** 玻璃门：两扇对开，中间一道磨砂条，两根竖把手；门上方亮着安全出口灯。 */
function drawDoor(rects: PixelRect[], palette: OfficePalette): void {
  const x = 6
  const y = 20
  const w = 34
  const h = 66
  push(rects, x, y, w, h, palette.outline)
  push(rects, x + 1, y + 1, w - 2, h - 1, palette.metal)
  const leaves = [x + 3, x + 18]
  for (const leaf of leaves) {
    push(rects, leaf, y + 3, 13, h - 3, '#cfeaf7')
    // 两道斜着的反光，一看就是玻璃。
    drawPixelLine(rects, leaf + 2, y + 18, leaf + 10, y + 6, 'rgba(255, 255, 255, 0.75)')
    drawPixelLine(rects, leaf + 2, y + 24, leaf + 11, y + 12, 'rgba(255, 255, 255, 0.45)')
    push(rects, leaf, y + 34, 13, 7, palette.glassFrost)
  }
  push(rects, x + 13, y + 26, 2, 20, palette.metalDark)
  push(rects, x + 19, y + 26, 2, 20, palette.metalDark)
  // 地垫用深一点的灰蓝，是写字楼入口的除尘垫，不是家里的门垫。
  push(rects, x + 2, 87, w - 4, 7, palette.metalDark)
  push(rects, x + 3, 88, w - 6, 5, palette.clockRim)
  // 安全出口灯：绿底白人，全世界的办公楼都有。
  pushBox(rects, x + 7, 11, 20, 7, '#3fc27f', palette.outline)
  push(rects, x + 10, 13, 2, 3, palette.trim)
  push(rects, x + 13, 13, 11, 1, palette.trim)
  push(rects, x + 13, 15, 8, 1, palette.trim)
}

/** 门禁读卡器和灭火器：挂在门和窗之间的小件，最能说明这是公司。 */
function drawDoorSideItems(rects: PixelRect[], palette: OfficePalette): void {
  pushBox(rects, 43, 42, 6, 10, palette.clockRim, palette.outline)
  push(rects, 44, 47, 4, 3, palette.metal)
  // 灭火器：红色瓶身、银色喷嘴，上面贴一块小标志。
  pushBox(rects, 43, 62, 6, 4, palette.coralDark, palette.outline)
  push(rects, 44, 68, 4, 2, palette.metalDark)
  pushBox(rects, 42, 70, 8, 13, '#ef5b4c', palette.outline)
  push(rects, 44, 72, 1, 8, '#ff8d80')
}

/** 挂钟：圆形表盘、12 个刻度、粗短的时针和细长的分针，跟着传进来的时间走。 */
function drawClock(rects: PixelRect[], moment: OfficeMoment, palette: OfficePalette): void {
  const { cx, cy, radius, hourLength, minuteLength } = OFFICE_CLOCK
  fillPixelDisc(rects, cx + 1, cy + 2, radius, 'rgba(90, 110, 140, 0.22)')
  fillPixelDisc(rects, cx, cy, radius + 1, palette.outline)
  fillPixelDisc(rects, cx, cy, radius, palette.clockRim)
  fillPixelDisc(rects, cx, cy, radius - 2, palette.clockFace)
  for (let mark = 0; mark < 12; mark += 1) {
    const point = clockHandEnd(cx, cy, mark * 30, radius - 3)
    // 3、6、9、12 点的刻度粗一点，一眼能读出方向。
    if (mark % 3 === 0) push(rects, point.x - (point.x < cx ? 0 : point.x > cx ? 1 : 0), point.y - (point.y < cy ? 0 : point.y > cy ? 1 : 0), 2, 2, palette.outline)
    else push(rects, point.x, point.y, 1, 1, palette.metalDark)
  }
  // 先画分针再画时针，粗的时针压在上面；轴心最后点一颗红。
  const minuteEnd = clockHandEnd(cx, cy, clockMinuteAngle(moment), minuteLength)
  drawPixelLine(rects, cx, cy, minuteEnd.x, minuteEnd.y, palette.outline)
  const hourEnd = clockHandEnd(cx, cy, clockHourAngle(moment), hourLength)
  drawPixelLine(rects, cx, cy, hourEnd.x, hourEnd.y, palette.outline, 2)
  push(rects, cx - 1, cy - 1, 3, 3, palette.coralDark)
}

/** 用 3 乘 5 字形画一个数字；scale 是放大倍数。 */
function drawDigit(rects: PixelRect[], x: number, y: number, digit: string, scale: number, color: string): void {
  (PIXEL_DIGITS[digit] ?? []).forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column += 1) {
      if (row.charAt(column) === '1') push(rects, x + column * scale, y + rowIndex * scale, scale, scale, color)
    }
  })
}

/** 撕页日历：红色台头写月份，下面大字写今天几号，用的是主人电脑上的真实日期。 */
function drawCalendar(rects: PixelRect[], moment: OfficeMoment, palette: OfficePalette): void {
  const x = 166
  const y = 16
  const w = 22
  const h = 28
  push(rects, x + 1, y + 1, w, h, 'rgba(90, 110, 140, 0.22)')
  pushBox(rects, x, y, w, h, palette.board, palette.outline)
  push(rects, x + 1, y + 1, w - 2, 8, palette.coralDark)
  // 两个挂环压在台头上。
  push(rects, x + 5, y - 2, 2, 4, palette.outline)
  push(rects, x + w - 7, y - 2, 2, 4, palette.outline)
  // 台头的月份：一位数居中，两位数并排。
  const month = String(moment.month)
  const monthWidth = month.length * 4 - 1
  ;[...month].forEach((digit, index) => drawDigit(rects, x + Math.floor((w - monthWidth) / 2) + index * 4, y + 2, digit, 1, palette.trim))
  // 今天的日期放大两倍。
  const day = String(moment.day)
  const dayWidth = day.length * 8 - 2
  ;[...day].forEach((digit, index) => drawDigit(rects, x + Math.floor((w - dayWidth) / 2) + index * 8, y + 12, digit, 2, palette.outline))
}

/** 组织架构图：挂在饮水机上方，一个方块下面连着三个方块，公司味最浓的一张纸。 */
function drawOrgChart(rects: PixelRect[], x: number, y: number, palette: OfficePalette): void {
  push(rects, x + 1, y + 1, 30, 32, 'rgba(90, 110, 140, 0.22)')
  pushBox(rects, x, y, 30, 32, palette.board, palette.outline)
  pushBox(rects, x + 10, y + 4, 10, 6, palette.coral, palette.outline)
  push(rects, x + 15, y + 10, 1, 4, palette.outline)
  push(rects, x + 6, y + 14, 19, 1, palette.outline)
  for (const [dx, color] of [[2, palette.teal], [11, palette.sun], [20, palette.noteB]] as const) {
    push(rects, x + dx + 4, y + 14, 1, 4, palette.outline)
    pushBox(rects, x + dx, y + 18, 9, 6, color, palette.outline)
  }
  push(rects, x + 8, y + 27, 14, 1, palette.metalDark)
}

/**
 * 项目看板：软木底板上分三列（待办、进行中、完成），便签按列贴。
 * 软木只铺一整块，别的都叠在上面。
 */
function drawProjectBoard(rects: PixelRect[], x: number, y: number, w: number, h: number, palette: OfficePalette): void {
  push(rects, x + 1, y + 2, w, h, 'rgba(90, 110, 140, 0.22)')
  push(rects, x, y, w, h, palette.outline)
  push(rects, x + 1, y + 1, w - 2, h - 2, palette.metalDark)
  push(rects, x + 3, y + 3, w - 6, h - 6, palette.cork)
  // 三列表头，颜色对应待办、进行中、完成。
  const columns: readonly (readonly [number, string])[] = [[6, palette.coral], [33, palette.sun], [60, palette.teal]]
  for (const [dx, color] of columns) push(rects, x + dx, y + 6, 22, 3, color)
  // 列与列之间两条分隔线。
  push(rects, x + 30, y + 5, 1, h - 10, palette.woodDark)
  push(rects, x + 57, y + 5, 1, h - 10, palette.woodDark)
  // 便签：每张里写两行，高低略有错落。
  const notes: readonly (readonly [number, number, string])[] = [
    [7, 12, palette.noteA], [18, 13, palette.noteB], [7, 25, palette.noteC], [18, 26, palette.noteA],
    [34, 12, palette.noteB], [45, 12, palette.noteA], [34, 25, palette.noteD],
    [61, 12, palette.noteD], [72, 13, palette.noteD], [61, 25, palette.noteD], [72, 26, palette.noteD],
  ]
  for (const [dx, dy, color] of notes) {
    push(rects, x + dx, y + dy, 9, 10, color)
    push(rects, x + dx + 1, y + dy + 3, 6, 1, palette.metalDark)
    push(rects, x + dx + 1, y + dy + 6, 5, 1, palette.metalDark)
    push(rects, x + dx + 4, y + dy - 1, 2, 2, palette.coralDark)
  }
}

/** 立柱：分隔工作区和共享区，中间一条亮面，让房间有前后层次。 */
function drawColumn(rects: PixelRect[], x: number, palette: OfficePalette): void {
  push(rects, x - 1, 0, 10, OFFICE_WALL_HEIGHT, palette.outline)
  push(rects, x, 0, 8, OFFICE_WALL_HEIGHT, palette.trim)
  push(rects, x + 2, 0, 4, OFFICE_WALL_HEIGHT, palette.metal)
  push(rects, x - 2, 80, 12, 6, palette.trim)
  push(rects, x - 2, 79, 12, 1, palette.outline)
}

/** 墙面陈设：门、左窗、钟、日历、组织架构图、立柱、项目看板、右窗。 */
export function drawWallDecor(rects: PixelRect[], moment: OfficeMoment, palette: OfficePalette): void {
  drawCeiling(rects, palette)
  drawDoor(rects, palette)
  drawDoorSideItems(rects, palette)
  OFFICE_WINDOWS.forEach((spec, index) => drawOfficeWindow(rects, spec, index, moment, palette))
  drawClock(rects, moment, palette)
  drawCalendar(rects, moment, palette)
  drawOrgChart(rects, 193, 14, palette)
  drawColumn(rects, 226, palette)
  drawProjectBoard(rects, 244, 12, 88, 42, palette)
}

// —— 地面 ——

/** 方块地毯：工作区和共享区深浅不同，都是一格格的，这是办公楼最典型的地面。 */
export function drawFloor(rects: PixelRect[], palette: OfficePalette): void {
  const tile = 15
  let row = 0
  for (let y = OFFICE_WALL_HEIGHT; y < OFFICE_PIXEL_HEIGHT; y += tile, row += 1) {
    let column = 0
    for (let x = 0; x < OFFICE_PIXEL_WIDTH; x += tile, column += 1) {
      const odd = (row + column) % 2 === 0
      const inWorkZone = x < ZONE_SPLIT
      push(rects, x, y, tile, tile, inWorkZone ? (odd ? palette.floorA : palette.floorB) : (odd ? palette.tileA : palette.tileB))
      push(rects, x, y, tile, 1, palette.floorSeam)
      push(rects, x, y, 1, tile, palette.floorSeam)
    }
  }
  // 两种地面交界处压一条金属收边。
  push(rects, ZONE_SPLIT, OFFICE_WALL_HEIGHT, 2, OFFICE_PIXEL_HEIGHT - OFFICE_WALL_HEIGHT, palette.metalDark)
}

/** 窗光：竖格窗投到地上的三块光，中间留窗框的影子，上午往右斜、下午往左斜。 */
function drawSunbeam(rects: PixelRect[], x: number, width: number, rows: number, lean: number, color: string): void {
  const pane = Math.floor(width / 3)
  for (let row = 0; row < rows; row += 1) {
    const offset = Math.round(row * lean * 1.4)
    const y = OFFICE_WALL_HEIGHT + row * 2
    for (let index = 0; index < 3; index += 1) push(rects, x + offset + index * pane, y, pane - 2, 2, color)
  }
}

/** 吸顶灯在地上的亮区：三层方斑，中心亮、边缘淡，贴在墙脚。 */
function drawLampPool(rects: PixelRect[], centerX: number, y: number, palette: OfficePalette): void {
  push(rects, centerX - 28, y, 56, 4, palette.lampHalo)
  push(rects, centerX - 20, y + 4, 40, 4, palette.lampHalo)
  push(rects, centerX - 12, y + 8, 24, 3, palette.lampGlow)
}

/**
 * 地面光影：工作区压暗一点点、共享区提亮一点点，窗光随时间倾斜。
 * 夜里没有窗光，灯光多叠一层；房间整体还是亮的。全部落在墙面以下，只染地板。
 */
export function drawFloorLighting(rects: PixelRect[], moment: OfficeMoment, palette: OfficePalette): void {
  const height = OFFICE_PIXEL_HEIGHT - OFFICE_WALL_HEIGHT
  push(rects, 0, OFFICE_WALL_HEIGHT, ZONE_SPLIT, height, palette.floorShade)
  push(rects, ZONE_SPLIT, OFFICE_WALL_HEIGHT, OFFICE_PIXEL_WIDTH - ZONE_SPLIT, height, palette.floorLift)
  const phase = officeDayPhase(moment)
  if (phase !== 'night') {
    const lean = officeSunLean(moment)
    // 清晨和傍晚光线更短；左窗宽所以光更强，右窗柔一些。
    const rows = phase === 'day' ? 22 : 13
    drawSunbeam(rects, 58, 60, rows, lean, palette.sunbeamA)
    drawSunbeam(rects, 404, 58, Math.floor(rows * 0.6), lean, palette.sunbeamB)
  }
  const pools = phase === 'night' ? 2 : 1
  for (let layer = 0; layer < pools; layer += 1) {
    drawLampPool(rects, 110, OFFICE_WALL_HEIGHT + 2, palette)
    drawLampPool(rects, 350, OFFICE_WALL_HEIGHT + 2, palette)
  }
}
