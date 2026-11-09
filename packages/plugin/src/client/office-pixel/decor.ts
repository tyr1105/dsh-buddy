/**
 * 像素办公室的墙面陈设与地面光影（P36 画面补强）。
 *
 * 为什么单独一个文件：渲染核心负责「谁坐在哪、状态是什么」，属于数据投影；
 * 窗、挂钟、公告栏、壁灯和地上的光只负责房间氛围。两者混在一起会越来越难读，
 * 所以拆成一组独立的固定画法。这里不读时间、不读随机数、也不碰 OfficeView：
 * 氛围永远一样，队友状态永远只来自投影。
 *
 * 调用顺序：地面光影在铺完地板与过道之后、家具之前画；墙饰在墙面与踢脚线
 * 之后画。这样光斑只落在地板上，不会把桌子、小人或气泡染色。
 */
import type { OfficePalette, PixelRect } from './render.js'
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH } from './layout.js'

/** 墙面高度，与 render.ts 的 WALL_HEIGHT 保持一致；最后 4 像素是踢脚线。 */
const WALL_HEIGHT = 86
/** 工位区与共享区的分界：左边是六张桌子，右边是共享陈设。 */
const ZONE_SPLIT = 234

function push(rects: PixelRect[], x: number, y: number, w: number, h: number, color: string): void {
  if (w <= 0 || h <= 0) return
  rects.push({ x, y, w, h, color })
}

/** 一扇窗：墙面受光、窗外天空与远楼、太阳、十字窗框和窗台。 */
function drawWindow(rects: PixelRect[], x: number, y: number, w: number, h: number, palette: OfficePalette): void {
  // 窗框四周比墙面亮一档，像有外光从窗里透出来。
  push(rects, x - 3, y - 3, w + 6, h + 6, palette.wallGlow)
  push(rects, x, y, w, h, palette.outline)
  push(rects, x + 2, y + 2, w - 4, h - 4, palette.windowSky)
  // 天空下半更深；远楼贴着地平线，高低错开，不做整齐一条。
  const skyY = y + 2 + Math.floor((h - 4) / 2)
  push(rects, x + 2, skyY, w - 4, y + h - 2 - skyY, palette.windowSkyDeep)
  push(rects, x + 6, y + h - 12, 10, 8, palette.wallTrim)
  push(rects, x + 17, y + h - 9, 8, 5, palette.wallTrim)
  // 太阳放在右上角，偏一点才有生活感。
  push(rects, x + w - 15, y + 5, 8, 8, palette.lampBulb)
  // 十字窗框与窗台。
  push(rects, x + Math.floor(w / 2) - 1, y + 2, 2, h - 4, palette.outline)
  push(rects, x + 2, y + Math.floor(h / 2) - 1, w - 4, 2, palette.outline)
  push(rects, x - 2, y + h, w + 4, 3, palette.metal)
  push(rects, x - 2, y + h + 3, w + 4, 1, palette.wallTrim)
}

/** 挂钟：叠矩形拼出圆形；指针固定在十点十分，不跟真实时间走。 */
function drawClock(rects: PixelRect[], x: number, y: number, palette: OfficePalette): void {
  push(rects, x + 3, y, 16, 22, palette.outline)
  push(rects, x, y + 3, 22, 16, palette.outline)
  push(rects, x + 5, y + 2, 12, 18, palette.clockFace)
  push(rects, x + 2, y + 5, 18, 12, palette.clockFace)
  // 四个刻度。
  push(rects, x + 10, y + 3, 2, 1, palette.outline)
  push(rects, x + 10, y + 18, 2, 1, palette.outline)
  push(rects, x + 3, y + 10, 1, 2, palette.outline)
  push(rects, x + 18, y + 10, 1, 2, palette.outline)
  // 分针向上、时针向右，轴心点一颗暖色。
  push(rects, x + 10, y + 5, 2, 7, palette.outline)
  push(rects, x + 11, y + 11, 6, 2, palette.outline)
  push(rects, x + 10, y + 10, 2, 2, palette.noteC)
}

/** 公告栏：软木底板加三张错落的便签，图钉用小方点。 */
function drawNoticeBoard(rects: PixelRect[], x: number, y: number, w: number, h: number, palette: OfficePalette): void {
  push(rects, x, y, w, h, palette.outline)
  push(rects, x + 2, y + 2, w - 4, h - 4, palette.cork)
  // 三张纸高低错开，不和窗、钟排成一条线。
  push(rects, x + 6, y + 7, 18, 12, palette.noteA)
  push(rects, x + 28, y + 12, 14, 10, palette.noteB)
  push(rects, x + 48, y + 6, 22, 14, palette.noteC)
  push(rects, x + 14, y + 6, 2, 2, palette.outline)
  push(rects, x + 34, y + 11, 2, 2, palette.outline)
  push(rects, x + 58, y + 5, 2, 2, palette.outline)
  // 底边一条标题条，远看像公告栏的栏头。
  push(rects, x + 6, y + h - 8, w - 12, 4, palette.wallTrim)
}

/** 壁灯：挂臂、灯罩、灯泡，墙上带一圈越往下越宽的光。 */
function drawWallLamp(rects: PixelRect[], x: number, y: number, palette: OfficePalette): void {
  push(rects, x - 2, y + 9, 20, 5, palette.wallGlow)
  push(rects, x - 6, y + 14, 28, 4, palette.wallGlowDim)
  push(rects, x + 6, y, 4, 3, palette.metal)
  push(rects, x, y + 3, 16, 3, palette.lampShade)
  push(rects, x + 2, y + 6, 12, 2, palette.lampShade)
  push(rects, x + 4, y + 8, 8, 2, palette.lampBulb)
}

/** 竖管：从天花板落到踢脚线，两道法兰，给墙面一点工业感。 */
function drawPipe(rects: PixelRect[], x: number, palette: OfficePalette): void {
  push(rects, x, 0, 8, WALL_HEIGHT, palette.wallTrim)
  push(rects, x + 2, 0, 4, WALL_HEIGHT, palette.metal)
  push(rects, x - 1, 20, 10, 3, palette.wallTrim)
  push(rects, x - 1, 56, 10, 3, palette.wallTrim)
  push(rects, x + 2, 38, 4, 6, palette.outline)
}

/**
 * 墙面陈设：左右两个分区各一扇窗，中间偏左挂钟，右侧公告栏，
 * 两盏壁灯高度不同，管道落在分区交界。按分区摆，不排成一条。
 */
export function drawWallDecor(rects: PixelRect[], palette: OfficePalette): void {
  // 天花板下沿一条暗带，让墙和天花有层次。
  push(rects, 0, 0, OFFICE_PIXEL_WIDTH, 3, palette.wallTrim)
  drawWindow(rects, 44, 16, 64, 34, palette)
  drawClock(rects, 120, 18, palette)
  drawWallLamp(rects, 176, 8, palette)
  drawPipe(rects, 226, palette)
  drawNoticeBoard(rects, 250, 12, 84, 38, palette)
  drawWallLamp(rects, 352, 8, palette)
  drawWindow(rects, 392, 20, 58, 28, palette)
}

/** 窗光斜落：每行向右错开并加宽，形成从窗口斜铺到地面的光斑。 */
function drawSunbeam(
  rects: PixelRect[], x: number, y: number, width: number,
  steps: number, stepH: number, shift: number, widen: number, color: string,
): void {
  for (let i = 0; i < steps; i += 1) {
    push(rects, x + i * shift, y + i * stepH, width + i * widen, stepH, color)
  }
}

/** 灯下亮区：三层方斑，中心亮、边缘淡，贴在墙脚。 */
function drawLampPool(rects: PixelRect[], centerX: number, y: number, palette: OfficePalette): void {
  push(rects, centerX - 28, y, 56, 4, palette.lampHalo)
  push(rects, centerX - 20, y + 4, 40, 4, palette.lampHalo)
  push(rects, centerX - 12, y + 8, 24, 3, palette.lampGlow)
}

/**
 * 地面光影：工位区压暗一档、共享区提亮一档，两扇窗各落一道斜光，
 * 两盏壁灯在墙脚各留一块亮区。全部落在 y=86 以下，只染地板。
 */
export function drawFloorLighting(rects: PixelRect[], palette: OfficePalette): void {
  push(rects, 0, WALL_HEIGHT, ZONE_SPLIT, OFFICE_PIXEL_HEIGHT - WALL_HEIGHT, palette.floorShade)
  push(rects, ZONE_SPLIT, WALL_HEIGHT, OFFICE_PIXEL_WIDTH - ZONE_SPLIT, OFFICE_PIXEL_HEIGHT - WALL_HEIGHT, palette.floorLift)
  // 左窗光更强、右窗光更柔；台阶做细，斜落边缘才像光斑而不是楼梯。
  drawSunbeam(rects, 48, WALL_HEIGHT, 58, 21, 3, 2, 1, palette.sunbeamA)
  drawSunbeam(rects, 396, WALL_HEIGHT, 44, 9, 3, 2, 1, palette.sunbeamB)
  drawLampPool(rects, 184, WALL_HEIGHT + 2, palette)
  drawLampPool(rects, 360, WALL_HEIGHT + 2, palette)
}
