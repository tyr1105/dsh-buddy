/**
 * 办公室的额度装饰（P76k）：挂钟外圈的窗口弧、挂钟下的一行小字、工位上的午休牌。
 *
 * 为什么单独一个文件：这三样都只读额度窗口视图（core 的 quotaWindowView），不写状态、
 * 不调模型；把它们放在一起，画法、角度和文字都能用一个纯函数写测试，不用起浏览器。
 *
 * 三条约定（任务卡 3.3）：
 * 1. 弧从 12 点方向顺时针走，角度 =（现在 − 窗口起点）/ 5 小时 × 360°，超过一圈按一圈；
 *    颜色随额度灯取 palette 里的四种弧色。
 * 2. 员工份额用完、真实额度用完、你自己要用这三种状态下，每位在岗员工桌面前立一块小牌，
 *    写「{HH:mm} 回来」；额度恢复后不再画。牌子上的文字用页面浮层画（像素画里没有汉字字形），
 *    牌子的底板仍由这里画成像素画，位置由 quotaSignRect 统一给出，浮层才能严丝合缝地压在上面。
 * 3. 「减少动态效果」时页面不走动画帧，这两样只在静态刷新时重画，不做任何动画。
 */
import type { QuotaWindowView } from '../../shared/views.js'
import { OFFICE_CLOCK } from './decor.js'
import type { OfficeSeatLayout } from './layout.js'
import type { OfficePalette } from './palette.js'
import { pushBox, pushRect as push, type PixelRect } from './pixel-kit.js'

/** 额度灯四档 → 弧的颜色键；四种颜色都在 palette.ts 里，名字带 quota 前缀，只给这一处用。 */
export const QUOTA_ARC_COLORS = {
  green: 'quotaArcGreen',
  yellow: 'quotaArcYellow',
  orange: 'quotaArcOrange',
  red: 'quotaArcRed',
} as const

export type QuotaArcColorKey = typeof QUOTA_ARC_COLORS[keyof typeof QUOTA_ARC_COLORS]

/** 五分钟窗口的毫秒数（与 core 的 5 小时一致，写在这里只为算角度时读得懂）。 */
const OWNER_WINDOW_MS = 5 * 60 * 60 * 1000
/** 额度窗口长度：页面传给动画层算弧的角度，与 core 的默认设置同一个值。 */
export const OFFICE_QUOTA_WINDOW_MS = OWNER_WINDOW_MS

/** 弧的角度与颜色：纯函数，输入全部显式给出，测试直接给 now、窗口起点与灯。 */
export function quotaArcOf(input: { now: number; windowStartAt: number; windowMs: number; light: 'green' | 'yellow' | 'orange' | 'red' }): { angleDeg: number; colorKey: QuotaArcColorKey } {
  const span = input.windowMs > 0 ? input.windowMs : OWNER_WINDOW_MS
  const ratio = (input.now - input.windowStartAt) / span
  // 超过一圈按一圈；负值（时钟回拨或窗口起点在未来）按 0 处理，不画反向弧。
  const angleDeg = Math.max(0, Math.min(1, ratio)) * 360
  return { angleDeg, colorKey: QUOTA_ARC_COLORS[input.light] }
}

/** 按设置时区写 HH:mm；取不到时返回 null（不猜时刻）。 */
export function clockTextOf(at: number | null, timezone: string | undefined): string | null {
  if (at === null || !Number.isFinite(at)) return null
  try {
    return new Date(at).toLocaleTimeString('en-GB', { timeZone: timezone ?? 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' })
  } catch {
    return null
  }
}

/**
 * 「你自己要用」的结束时刻：额度视图只给了 holdText（「你要自己用到 18:30，员工不开新回合」），
 * 没有单独的时间字段。这里按 core 的固定句式取出那个 HH:mm，它已经是设置时区的时刻，
 * 不再换算时区；取不到时退回窗口重置时刻，不猜。
 * （core 若以后给出单独字段，这里改读那个字段，见 docs/questions.md 的 P76k 一节。）
 */
export function ownerHoldClockOf(holdText: string | null): string | null {
  if (holdText === null) return null
  return /用到 (\d{2}:\d{2})/.exec(holdText)?.[1] ?? null
}

/**
 * 午休牌上的文字：「{HH:mm} 回来」。三种状态下才立牌，其余（正常）返回 null；
 * 没有可写的时刻时也不立牌（不写一块空牌）。
 */
export function quotaSignText(quota: QuotaWindowView | null, timezone: string | undefined): string | null {
  if (quota === null) return null
  if (quota.state !== 'staff_full' && quota.state !== 'exhausted' && quota.state !== 'owner_hold') return null
  const clock = quota.state === 'owner_hold'
    ? ownerHoldClockOf(quota.holdText) ?? clockTextOf(quota.resetAt, timezone)
    : clockTextOf(quota.resetAt, timezone)
  return clock === null ? null : `${clock} 回来`
}

/**
 * 挂钟下方的一行小字：正常与「你自己要用」写「额度窗口 {HH:mm} 重置」；
 * 真实额度用完时这个时刻是恢复时刻，写「额度窗口 {HH:mm} 恢复」（主会话裁定，2026-11-14）。
 * 时刻取 resetText 里的那个（任务卡 3.3），取不到时用 resetAt 按设置时区写。
 */
export function quotaClockLabel(quota: QuotaWindowView | null, timezone: string | undefined): string | null {
  if (quota === null) return null
  const fromText = /(\d{2}:\d{2})/.exec(quota.resetText)?.[1] ?? null
  const clock = fromText ?? clockTextOf(quota.resetAt, timezone)
  if (clock === null) return null
  return quota.state === 'exhausted' ? `额度窗口 ${clock} 恢复` : `额度窗口 ${clock} 重置`
}

/**
 * 窗口弧的起点：额度视图只给结束时刻 resetAt（即窗口结束），
 * 起点 = resetAt − 5 小时（与 core 的默认窗口长度一致）。
 * 红灯时 resetAt 可能是「恢复时刻」，不一定是窗口结束，所以红灯不画弧（见 docs/questions.md 的 P76k 一节）。
 */
export function quotaWindowStartOf(quota: QuotaWindowView): number | null {
  if (quota.state !== 'normal' && quota.state !== 'owner_hold') return null
  if (quota.resetAt === null) return null
  return quota.resetAt - OWNER_WINDOW_MS
}

/**
 * 午休牌底板的矩形：宽 22（不超过工位宽度 50 的一半），立在桌面右侧、避开显示器（显示器占桌面左侧 5 到 25）。
 * 高三行文字的高度加边：两行（时刻、回来）各 4 像素，上下各留 2 像素。
 */
export function quotaSignRect(seat: OfficeSeatLayout): { x: number; y: number; w: number; h: number } {
  return { x: seat.deskX + 26, y: seat.deskY + 1, w: 22, h: 12 }
}

/** 画午休牌的底板：白牌面、深色描边、一条立脚，牌面留白给浮层的文字。 */
export function drawQuotaSign(rects: PixelRect[], seat: OfficeSeatLayout, palette: OfficePalette): void {
  const rect = quotaSignRect(seat)
  pushBox(rects, rect.x, rect.y, rect.w, rect.h, palette.board, palette.outline)
  // 牌面下方一条浅色横线，看起来是一块立着的小牌，而不是贴在桌上的一张纸。
  push(rects, rect.x + 1, rect.y + rect.h - 2, rect.w - 2, 1, palette.trimShadow)
  push(rects, rect.x + rect.w / 2 - 1, rect.y + rect.h, 2, 2, palette.metalDark)
}

/**
 * 画挂钟外圈的窗口弧。角度是 0 到 360，从 12 点方向顺时针；用 2 度一步的小方块连成弧，
 * 半径比表盘大 2 像素，压在钟框外沿上。减少动态效果时调用方只画一次。
 */
export function drawQuotaArc(rects: PixelRect[], angleDeg: number, colorKey: QuotaArcColorKey, palette: OfficePalette): void {
  const { cx, cy, radius } = OFFICE_CLOCK
  const color = palette[colorKey]
  const r = radius + 2
  // P76n：调用方已经用 quotaArcOf 截断过；这里再兜一次边界，负值、NaN 或超过一圈都只画 0 到 360。
  const limit = Number.isFinite(angleDeg) ? Math.max(0, Math.min(360, angleDeg)) : 0
  for (let deg = 0; deg < limit; deg += 2) {
    const rad = ((deg - 90) * Math.PI) / 180
    const x = Math.round(cx + r * Math.cos(rad))
    const y = Math.round(cy + r * Math.sin(rad))
    push(rects, x, y, 2, 2, color)
  }
}
