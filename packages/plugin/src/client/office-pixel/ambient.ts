/**
 * 像素办公室的动画叠加层（P54）：让房间活起来的那些小动静。
 *
 * 静态帧每分钟才重算一次，这一层每一拍都重画，内容叠在静态帧上面：
 * 窗外的云、秒针、门禁灯、机柜指示灯、会议室投屏、绿植微动、饮水机气泡、咖啡蒸汽、
 * 复印机灯、阳光里的浮尘、一只猫，还有队友的小动作。
 *
 * 两条纪律：
 * 1. 依然是纯函数。时间由页面传入，同样的时间永远画出同样的东西，测试能逐帧检查。
 * 2. 不演戏。队友的动作只翻译 core 给的真实状态（officeFigureAct），绝不凭空表现「很努力」。
 *    猫不是队友，不表示任何状态，只是办公室的吉祥物。
 *
 * motion 为 false（主人打开了「减少动态效果」）时，时间固定当成 0，并且不画秒针，
 * 整层变成一张不会动的画。
 */
import type { OfficeLight } from '../../shared/views.js'
import { officeHash } from './appearance.js'
import { OFFICE_CARD_READER_LED, OFFICE_CLOCK } from './decor.js'
import { FIGURE_EYE_COLUMNS, FIGURE_EYE_HEIGHT, FIGURE_EYE_ROW, figureEyesClosed, figureHeadTop, figureLeft } from './figure.js'
import { deskKeyboard, deskScreen } from './furniture.js'
import { OFFICE_SHARED_SPOTS, officeSeatAt, type OfficeSeatLayout } from './layout.js'
import { clockHandEnd, clockSecondAngle, officeDayPhase, type OfficeDayPhase, type OfficeMoment } from './moment.js'
import { DEFAULT_OFFICE_PALETTE, type OfficePalette } from './palette.js'
import { drawPixelLine, drawSprite, pushRect as push, type PixelRect, type SpriteColors } from './pixel-kit.js'
import type { OfficePixelFigure } from './render.js'
import {
  SPRITE_ALERT, SPRITE_CAT_SIT, SPRITE_CAT_SLEEP, SPRITE_CAT_SLEEP_TAIL, SPRITE_CAT_WALK_A, SPRITE_CAT_WALK_B,
  SPRITE_CLOUD_A, SPRITE_CLOUD_B, SPRITE_QUESTION, SPRITE_Z,
} from './sprites.js'
import { OFFICE_MEETING_SCREEN, OFFICE_SERVER_RACK, officePlantSprite } from './shared-furniture.js'
import { OFFICE_NIGHT_STARS, OFFICE_WINDOWS, officeWindowPanes } from './window-view.js'

export interface OfficeAmbientInput {
  /** 当前时间（毫秒）；所有动画都由它算出，不各自计数。 */
  timeMs: number
  /** 当前的年月日时分秒切片，秒针和白天黑夜要用。 */
  moment: OfficeMoment
  figures: readonly OfficePixelFigure[]
  palette?: Partial<OfficePalette>
  /** false 表示主人要求减少动态效果，整层静止。 */
  motion: boolean
}

/** 秒针的颜色，单独命名是为了测试能确认「减少动效时没有秒针」。 */
export const OFFICE_SECOND_HAND_COLOR = '#ef5b4c'
/** 流汗和打瞌睡的颜色，测试靠它们确认状态和动作对得上。 */
export const OFFICE_SWEAT_COLOR = '#6fc3ff'
export const OFFICE_SNORE_COLOR = '#7d90c8'
/** 屏幕上的深色内容（代码行、曲线、问号）。 */
export const OFFICE_SCREEN_INK = '#2c7f73'

/** 动画的一拍是 125 毫秒，也就是每秒 8 拍；像素画动得一顿一顿才对味。 */
export const OFFICE_AMBIENT_TICK_MS = 125

/** 队友的动作只有这几种，由真实状态决定。 */
export type OfficeFigureAct = 'typing' | 'queue' | 'scan' | 'ask' | 'alarm' | 'sleep' | 'still'

/** 把 core 的状态灯翻译成动作：这是办公室「不演戏」的那道关。 */
export function officeFigureAct(light: OfficeLight): OfficeFigureAct {
  switch (light) {
    case 'working': return 'typing'
    case 'queued': return 'queue'
    case 'watching': return 'scan'
    case 'waiting': return 'ask'
    case 'blocked': return 'alarm'
    case 'resting': return 'sleep'
    default: return 'still'
  }
}

// —— 窗外 ——

/** 每扇窗两朵云：pace 是走 1 像素要多少毫秒，数字越大飘得越慢。 */
const CLOUDS: readonly (readonly { rows: readonly string[]; y: number; start: number; pace: number }[])[] = [
  [{ rows: SPRITE_CLOUD_A, y: 14, start: 8, pace: 900 }, { rows: SPRITE_CLOUD_B, y: 20, start: 58, pace: 1300 }],
  [{ rows: SPRITE_CLOUD_B, y: 14, start: 30, pace: 1100 }, { rows: SPRITE_CLOUD_A, y: 19, start: 72, pace: 1500 }],
]

function drawClouds(rects: PixelRect[], time: number, phase: OfficeDayPhase): void {
  const color = phase === 'night' ? 'rgba(255, 255, 255, 0.12)' : phase === 'day' ? '#ffffff' : 'rgba(255, 238, 230, 0.85)'
  OFFICE_WINDOWS.forEach((spec, windowIndex) => {
    const panes = officeWindowPanes(spec)
    for (const cloud of CLOUDS[windowIndex] ?? []) {
      // 云从窗左外侧飘到窗右外侧，走完一圈再绕回来。
      const span = spec.w + 24
      const x = spec.x - 16 + ((cloud.start + Math.floor(time / cloud.pace)) % span)
      for (const clip of panes) drawSprite(rects, x, spec.y + cloud.y, cloud.rows, { C: color }, { clip })
    }
  })
}

/** 夜里的星星轮流亮一下。 */
function drawStarTwinkle(rects: PixelRect[], tick: number): void {
  OFFICE_WINDOWS.forEach((spec, windowIndex) => {
    const panes = officeWindowPanes(spec)
    ;(OFFICE_NIGHT_STARS[windowIndex] ?? []).forEach(([dx, dy], starIndex) => {
      if ((Math.floor(tick / 6) + starIndex * 3) % 5 !== 0) return
      const x = spec.x + 2 + dx
      const y = spec.y + 2 + dy
      const inPane = panes.some(pane => x >= pane.x && x < pane.x + pane.w && y >= pane.y && y < pane.y + pane.h)
      if (inPane) push(rects, x, y, 1, 1, '#ffffff')
    })
  })
}

// —— 墙上 ——

/** 秒针：一根细红线，轴心压在上面。 */
function drawSecondHand(rects: PixelRect[], moment: OfficeMoment, palette: OfficePalette): void {
  const { cx, cy, secondLength } = OFFICE_CLOCK
  const end = clockHandEnd(cx, cy, clockSecondAngle(moment), secondLength)
  drawPixelLine(rects, cx, cy, end.x, end.y, OFFICE_SECOND_HAND_COLOR)
  push(rects, cx - 1, cy - 1, 3, 3, palette.coralDark)
}

/** 门禁读卡器的绿灯：慢慢地一亮一灭。 */
function drawCardReaderLed(rects: PixelRect[], tick: number): void {
  push(rects, OFFICE_CARD_READER_LED.x, OFFICE_CARD_READER_LED.y, 2, 2, tick % 16 < 12 ? '#62e08a' : '#3f9a60')
}

/** 服务器指示灯：每层三颗，亮灭由位置和时间算出来，看起来在忙碌地闪。 */
function drawServerLights(rects: PixelRect[], tick: number): void {
  const { x, y, units } = OFFICE_SERVER_RACK
  for (let unit = 0; unit < units; unit += 1) {
    for (let led = 0; led < 3; led += 1) {
      const lit = (Math.floor(tick / 2) * (led + 2) + unit * 5 + led * 3) % 7 < 4
      push(rects, x + 4 + led * 3, y + 5 + unit * 9, 2, 1, lit ? (led === 2 ? '#ffc94d' : '#62e08a') : '#5d6d85')
    }
  }
}

/** 会议室投屏上的柱状图：柱子高度缓慢起伏，像在播放一页数据。 */
function drawMeetingScreen(rects: PixelRect[], tick: number, palette: OfficePalette): void {
  const { x, y, w, h } = OFFICE_MEETING_SCREEN
  push(rects, x + 4, y + 3, 24, 2, palette.clockRim)
  push(rects, x + 4, y + h - 4, w - 8, 1, palette.outline)
  const colors = [palette.coralDark, palette.sun, palette.teal, palette.noteB, palette.coralDark, palette.teal]
  colors.forEach((color, index) => {
    const swing = Math.round(Math.sin(tick / 10 + index * 1.1) * 2)
    const height = 7 + ((index * 5) % 9) + swing
    push(rects, x + 8 + index * 8, y + h - 4 - height, 5, height, color)
  })
}

// —— 共享区的小动静 ——

/** 取一行字符画最左、最右的实心位置；绿植微动要贴着叶子的外缘长出来。 */
function solidEdges(row: string): { left: number; right: number } | null {
  const left = row.search(/[^.]/)
  if (left < 0) return null
  return { left, right: row.length - 1 - [...row].reverse().join('').search(/[^.]/) }
}

/** 绿植微动：风往哪边吹，叶子外缘就往哪边多长一像素；幅度小才像有风，而不是在抖。 */
function drawPlantSway(rects: PixelRect[], time: number, palette: OfficePalette): void {
  OFFICE_SHARED_SPOTS.filter(spot => spot.kind === 'plant').forEach((spot, plantIndex) => {
    const rows = officePlantSprite(spot.id)
    const top = spot.y + spot.height - rows.length - 6
    ;[3, 6, 8, 10].forEach((rowIndex, tipIndex) => {
      const swing = Math.sin(time / 1000 + plantIndex * 2 + tipIndex * 1.3)
      const edges = solidEdges(rows[rowIndex] ?? '')
      if (edges === null || Math.abs(swing) < 0.45) return
      push(rects, spot.x + (swing > 0 ? edges.right + 1 : edges.left - 1), top + rowIndex, 1, 2, palette.leaf)
    })
  })
}

/** 饮水机气泡：从桶底往上冒，三个气泡错开时间。 */
function drawCoolerBubbles(rects: PixelRect[], time: number): void {
  const cooler = OFFICE_SHARED_SPOTS.find(spot => spot.kind === 'cooler')
  if (cooler === undefined) return
  for (let index = 0; index < 3; index += 1) {
    const progress = ((time + index * 1250) % 3700) / 3700
    const y = cooler.y + 15 - Math.floor(progress * 13)
    const x = cooler.x + 8 + index * 2 + (Math.floor(time / 500 + index) % 2)
    push(rects, x, y, index === 1 ? 2 : 1, index === 1 ? 2 : 1, 'rgba(255, 255, 255, 0.85)')
  }
}

/** 一缕蒸汽：几个半透明小方块边升边晃；在奶油墙上要用淡蓝灰才看得见。 */
function drawSteam(rects: PixelRect[], x: number, y: number, time: number, seed: number): void {
  for (let puff = 0; puff < 3; puff += 1) {
    const rise = Math.floor((time / 240 + puff * 3 + seed) % 9)
    const sway = Math.round(Math.sin((time + puff * 500) / 420 + seed))
    const alpha = (0.62 - rise * 0.06).toFixed(2)
    push(rects, x + sway, y - rise, 1, 2, `rgba(150, 172, 196, ${alpha})`)
  }
}

/** 打印机：绿灯慢闪，每隔 24 秒吐出一张纸。 */
function drawPrinterMotion(rects: PixelRect[], time: number, tick: number, palette: OfficePalette): void {
  const printer = OFFICE_SHARED_SPOTS.find(spot => spot.kind === 'printer')
  if (printer === undefined) return
  const on = tick % 16 < 10
  push(rects, printer.x + printer.width - 10, printer.y + 11, 3, 2, on ? '#62e08a' : '#3f9a60')
  const phase = time % 24000
  if (phase < 3000) {
    const grown = Math.floor((phase / 3000) * 5)
    push(rects, printer.x + 11, printer.y + 18, printer.width - 22, 5 + grown, palette.board)
  }
}

/** 阳光里的浮尘：白天左窗那道光里几粒亮点慢慢漂。 */
function drawDustMotes(rects: PixelRect[], time: number): void {
  for (let index = 0; index < 7; index += 1) {
    const x = 66 + Math.floor((index * 37 + time / 95) % 62)
    const y = 92 + Math.floor((index * 53 + time / 150) % 40)
    push(rects, x, y, 1, 1, 'rgba(255, 255, 255, 0.85)')
  }
}

// —— 猫 ——

/** 一轮 150 秒的固定日程：睡觉、起身、走到左边、坐一会儿、走回来。 */
const CAT_CYCLE_MS = 150_000
const CAT_SLEEP_X = 404
const CAT_WANDER_X = 296
const CAT_FLOOR_Y = 268

export interface OfficeCatPose {
  pose: 'sleep' | 'sit' | 'walk'
  x: number
  flip: boolean
  /** 走路时第几帧；睡觉时 1 表示尾巴抬起。 */
  frame: 0 | 1
}

/** 由时间算出猫此刻的样子：不用记任何状态，刷新页面也接得上。 */
export function officeCatPose(timeMs: number): OfficeCatPose {
  const at = ((timeMs % CAT_CYCLE_MS) + CAT_CYCLE_MS) % CAT_CYCLE_MS
  const step: 0 | 1 = Math.floor(at / 250) % 2 === 0 ? 0 : 1
  if (at < 80_000) return { pose: 'sleep', x: CAT_SLEEP_X, flip: false, frame: at % 7000 < 700 && at > 700 ? 1 : 0 }
  if (at < 86_000) return { pose: 'sit', x: CAT_SLEEP_X, flip: false, frame: 0 }
  if (at < 116_000) {
    const progress = (at - 86_000) / 30_000
    return { pose: 'walk', x: Math.round(CAT_SLEEP_X - progress * (CAT_SLEEP_X - CAT_WANDER_X)), flip: false, frame: step }
  }
  if (at < 126_000) return { pose: 'sit', x: CAT_WANDER_X, flip: true, frame: 0 }
  const progress = (at - 126_000) / 24_000
  return { pose: 'walk', x: Math.round(CAT_WANDER_X + progress * (CAT_SLEEP_X - CAT_WANDER_X)), flip: true, frame: step }
}

function drawCat(rects: PixelRect[], time: number): void {
  const cat = officeCatPose(time)
  const colors: SpriteColors = {
    o: '#7a5238', O: '#ffbe78', S: '#f4934a', W: '#fff4e3', n: '#ff8fa0', e: '#4a3428', T: '#ffbe78',
  }
  const rows = cat.pose === 'sleep'
    ? (cat.frame === 1 ? SPRITE_CAT_SLEEP_TAIL : SPRITE_CAT_SLEEP)
    : cat.pose === 'sit' ? SPRITE_CAT_SIT
      : cat.frame === 0 ? SPRITE_CAT_WALK_A : SPRITE_CAT_WALK_B
  push(rects, cat.x + 2, CAT_FLOOR_Y, rows === SPRITE_CAT_SIT ? 12 : 18, 2, 'rgba(150, 105, 55, 0.22)')
  drawSprite(rects, cat.x, CAT_FLOOR_Y - rows.length, rows, colors, { flip: cat.flip })
}

// —— 队友的小动作 ——

/** 代码行的缩进和长度：屏幕滚动时循环显示，看起来像在写东西。 */
const CODE_LINES: readonly (readonly [number, number])[] = [[1, 8], [3, 6], [3, 10], [1, 5], [5, 7], [3, 9], [1, 11], [3, 4]]
/** 盯守时屏幕上的曲线高低。 */
const SCAN_WAVE: readonly number[] = [5, 4, 4, 3, 5, 6, 4, 2, 3, 5, 6, 5, 3, 4]

/** 显示器内容：屏幕显示什么，完全由状态决定。 */
function drawScreenContent(rects: PixelRect[], seat: OfficeSeatLayout, act: OfficeFigureAct, tick: number, hash: number): void {
  const screen = deskScreen(seat)
  const ink = OFFICE_SCREEN_INK
  if (act === 'typing') {
    const scroll = Math.floor(tick / 4) + (hash % 8)
    for (let line = 0; line < 4; line += 1) {
      const [indent, length] = CODE_LINES[(scroll + line) % CODE_LINES.length]!
      push(rects, screen.x + indent + 1, screen.y + 1 + line * 2, Math.min(length, screen.w - indent - 2), 1, ink)
    }
    // 光标闪烁。
    if (tick % 8 < 4) push(rects, screen.x + 12, screen.y + 7, 2, 1, ink)
  } else if (act === 'queue') {
    const active = Math.floor(tick / 3) % 3
    for (let dot = 0; dot < 3; dot += 1) {
      push(rects, screen.x + 4 + dot * 3, screen.y + 4, 2, 2, dot === active ? ink : 'rgba(44, 127, 115, 0.3)')
    }
  } else if (act === 'scan') {
    const shift = Math.floor(tick / 2)
    for (let column = 0; column < screen.w - 2; column += 1) {
      push(rects, screen.x + 1 + column, screen.y + SCAN_WAVE[(column + shift) % SCAN_WAVE.length]!, 1, 1, ink)
    }
  } else if (act === 'ask') {
    drawSprite(rects, screen.x + 6, screen.y + 2, SPRITE_QUESTION, { o: ink })
  } else if (act === 'alarm') {
    if (tick % 8 < 5) push(rects, screen.x, screen.y, screen.w, screen.h, 'rgba(255, 120, 108, 0.75)')
    drawSprite(rects, screen.x + 7, screen.y + 2, SPRITE_ALERT, { o: '#b3261e' }, {})
    drawSprite(rects, screen.x + 8, screen.y + 2, SPRITE_ALERT, { o: '#b3261e' }, {})
  } else if (act === 'sleep') {
    // 休息时屏幕转暗，一颗小星星慢慢挪动，像屏保。
    push(rects, screen.x, screen.y, screen.w, screen.h, 'rgba(72, 92, 136, 0.72)')
    push(rects, screen.x + 2 + (Math.floor(tick / 8) % (screen.w - 4)), screen.y + 3 + (Math.floor(tick / 12) % 4), 1, 1, '#ffffff')
  }
}

/** 手臂搭在键盘上：o 描边、T 袖子、S 手。 */
const FOREARM: readonly string[] = ['oTTo', 'oTTo', 'oTTo', 'oSSo', '.oo.']

/** 双手：打字时左右手交替抬一下，别的状态放着不动。 */
function drawHands(rects: PixelRect[], seat: OfficeSeatLayout, figure: OfficePixelFigure, act: OfficeFigureAct, tick: number, palette: OfficePalette): void {
  const board = deskKeyboard(seat)
  const colors: SpriteColors = { o: palette.outline, T: figure.appearance.shirt, S: figure.appearance.skin }
  const leftUp = act === 'typing' && tick % 4 < 2 ? 1 : 0
  const rightUp = act === 'typing' && tick % 4 >= 2 ? 1 : 0
  drawSprite(rects, board.x, seat.deskY + 4 - leftUp, FOREARM, colors)
  drawSprite(rects, board.x + board.w - 4, seat.deskY + 4 - rightUp, FOREARM, colors)
}

/** 眼睛的动作：盯守时左右看，其余状态隔几秒眨一下；每个人的节奏由 id 错开。 */
function drawEyes(rects: PixelRect[], seat: OfficeSeatLayout, figure: OfficePixelFigure, act: OfficeFigureAct, time: number, hash: number, palette: OfficePalette): void {
  if (figureEyesClosed(figure.bubble.light)) return
  const x = figureLeft(seat)
  const y = figureHeadTop(seat) + FIGURE_EYE_ROW
  const period = 4300 + (hash % 1900)
  const blinking = time !== 0 && (time + (hash % 2000)) % period < 170
  for (const column of FIGURE_EYE_COLUMNS) {
    if (blinking) {
      push(rects, x + column, y, 2, FIGURE_EYE_HEIGHT, figure.appearance.skin)
      push(rects, x + column, y + 1, 2, 1, palette.outline)
    } else if (act === 'scan') {
      const lookLeft = Math.floor(time / 1100) % 2 === 0
      push(rects, x + column, y, 1, FIGURE_EYE_HEIGHT, lookLeft ? palette.outline : '#ffffff')
      push(rects, x + column + 1, y, 1, FIGURE_EYE_HEIGHT, lookLeft ? '#ffffff' : palette.outline)
    }
  }
}

/** 流汗和打呼：只有受阻的人流汗，只有休息的人飘 z。 */
function drawMoodMarks(rects: PixelRect[], seat: OfficeSeatLayout, act: OfficeFigureAct, tick: number): void {
  const x = figureLeft(seat)
  const top = figureHeadTop(seat)
  if (act === 'alarm') {
    const drop = tick % 8
    push(rects, x + 16, top + 2 + drop, 2, 3, OFFICE_SWEAT_COLOR)
    push(rects, x + 16, top + 2 + drop, 1, 1, '#ffffff')
  } else if (act === 'sleep') {
    for (let index = 0; index < 2; index += 1) {
      const rise = (Math.floor(tick / 3) + index * 5) % 10
      drawSprite(rects, x + 16 + rise, top + 4 - rise, SPRITE_Z, { o: OFFICE_SNORE_COLOR })
    }
  }
}

/** 一个队友这一拍的全部小动作。离线的人不动，屏幕也是灭的。 */
function drawFigureMotion(rects: PixelRect[], figure: OfficePixelFigure, time: number, tick: number, palette: OfficePalette): void {
  const seat = officeSeatAt(figure.seatIndex)
  if (seat === null) return
  const act = officeFigureAct(figure.bubble.light)
  const hash = officeHash(figure.botId)
  drawScreenContent(rects, seat, act, tick, hash)
  drawHands(rects, seat, figure, act, tick, palette)
  if (figure.bubble.light !== 'offline') drawEyes(rects, seat, figure, act, time, hash, palette)
  drawMoodMarks(rects, seat, act, tick)
}

/** 生成这一拍的全部动画矩形。 */
export function officeAmbient(input: OfficeAmbientInput): PixelRect[] {
  const palette: OfficePalette = { ...DEFAULT_OFFICE_PALETTE, ...input.palette }
  // 减少动效时把时间固定成 0：所有按时间算的东西都停在同一个样子。
  const time = input.motion ? input.timeMs : 0
  const tick = Math.floor(time / OFFICE_AMBIENT_TICK_MS)
  const phase = officeDayPhase(input.moment)
  const rects: PixelRect[] = []

  drawClouds(rects, time, phase)
  if (phase === 'night') drawStarTwinkle(rects, tick)
  if (input.motion) drawSecondHand(rects, input.moment, palette)
  drawCardReaderLed(rects, tick)
  drawServerLights(rects, tick)
  drawMeetingScreen(rects, tick, palette)
  if (phase === 'day') drawDustMotes(rects, time)
  drawPlantSway(rects, time, palette)
  drawCoolerBubbles(rects, time)
  drawPrinterMotion(rects, time, tick, palette)
  // 蒸汽两处：咖啡机顶、第三张桌子上的杯子。
  drawSteam(rects, 409, 49, time, 0)
  drawSteam(rects, 194, 148, time, 4)
  drawCat(rects, time)
  for (const figure of input.figures) drawFigureMotion(rects, figure, time, tick, palette)
  return rects
}
