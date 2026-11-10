/**
 * 办公室用到的真实时间（P54）：挂钟、日历、窗外的天色都从这里算。
 *
 * 为什么要先切成一个 OfficeMoment：渲染层有一条老规矩，不许自己读时间。
 * 页面每分钟把当前时间切成这样一个小对象传进来，渲染依然是「同样输入、同样画面」，
 * 测试只要传一个 15:30 就能检查钟面对不对，不用真的等到下午三点半。
 *
 * 这里全是纯函数，用的是主人电脑的本地时间：墙上的钟就该和主人手表一样。
 */

export interface OfficeMoment {
  /** 1 到 12 月。 */
  month: number
  /** 当月第几天。 */
  day: number
  /** 0 到 23 点。 */
  hour: number
  minute: number
  second: number
}

/** 没传时间时用的默认值：十点十分，天气晴朗，方便测试和静态预览。 */
export const DEFAULT_OFFICE_MOMENT: OfficeMoment = { month: 1, day: 1, hour: 10, minute: 10, second: 0 }

/** 把浏览器的 Date 切成办公室用的本地时间。 */
export function officeMomentFrom(date: Date): OfficeMoment {
  return {
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  }
}

/** 一天里的四段天色；窗外、地上的阳光和灯光都按它变。 */
export type OfficeDayPhase = 'dawn' | 'day' | 'dusk' | 'night'

/** 当天过去了多少分钟。 */
function minuteOfDay(moment: OfficeMoment): number {
  return moment.hour * 60 + moment.minute
}

/** 五点到七点是清晨，七点到十七点是白天，十七点到十九点是傍晚，其余是夜里。 */
export function officeDayPhase(moment: OfficeMoment): OfficeDayPhase {
  const minutes = minuteOfDay(moment)
  if (minutes < 5 * 60 || minutes >= 19 * 60) return 'night'
  if (minutes < 7 * 60) return 'dawn'
  if (minutes < 17 * 60) return 'day'
  return 'dusk'
}

/** 时针角度：12 点方向是 0 度，顺时针增加；时针会随分钟慢慢挪，和真钟一样。 */
export function clockHourAngle(moment: OfficeMoment): number {
  return ((moment.hour % 12) + moment.minute / 60) * 30
}

/** 分针角度：每分钟走 6 度。 */
export function clockMinuteAngle(moment: OfficeMoment): number {
  return moment.minute * 6
}

/** 秒针角度：每秒走 6 度。 */
export function clockSecondAngle(moment: OfficeMoment): number {
  return moment.second * 6
}

/** 指针末端的像素坐标：角度换成弧度，再用四舍五入对齐到像素格。 */
export function clockHandEnd(centerX: number, centerY: number, angle: number, length: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180
  return {
    x: Math.round(centerX + Math.sin(radians) * length),
    y: Math.round(centerY - Math.cos(radians) * length),
  }
}

/** 太阳或月亮在窗里的位置：第几扇窗，横向比例 u（0 左 1 右），纵向比例 v（0 高 1 低）。 */
export interface OfficeSkyBody {
  kind: 'sun' | 'moon'
  windowIndex: 0 | 1
  u: number
  v: number
}

/**
 * 把一段时间映射到两扇窗上：前 46% 在左窗，后 46% 在右窗，中间一小段正好在屋顶上方，看不见。
 * 只有一个太阳，它从左窗慢慢移到右窗。
 */
function placeBody(kind: OfficeSkyBody['kind'], progress: number): OfficeSkyBody | null {
  if (progress < 0 || progress > 1) return null
  // 用半个正弦波模拟东升西落：两头低，中间高。
  const v = 1 - Math.sin(Math.PI * progress)
  if (progress <= 0.46) return { kind, windowIndex: 0, u: progress / 0.46, v }
  if (progress >= 0.54) return { kind, windowIndex: 1, u: (progress - 0.54) / 0.46, v }
  return null
}

/** 算当前时刻天上的太阳或月亮；正好被屋顶挡住时返回 null。 */
export function officeSkyBody(moment: OfficeMoment): OfficeSkyBody | null {
  const minutes = minuteOfDay(moment)
  // 太阳：5:30 升起，19:00 落下。
  if (minutes >= 5 * 60 + 30 && minutes < 19 * 60) {
    return placeBody('sun', (minutes - (5 * 60 + 30)) / (13.5 * 60))
  }
  // 月亮：19:00 升起，第二天 5:30 落下；过了零点要把时间接到前一晚后面。
  const sinceDusk = minutes >= 19 * 60 ? minutes - 19 * 60 : minutes + 5 * 60
  return placeBody('moon', sinceDusk / (10.5 * 60))
}

/** 地上阳光的倾斜程度：上午往右斜，正午接近垂直，下午往左斜，限制在正负 1 之间。 */
export function officeSunLean(moment: OfficeMoment): number {
  const hour = moment.hour + moment.minute / 60
  return Math.max(-1, Math.min(1, (13 - hour) / 6))
}
