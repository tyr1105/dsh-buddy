/**
 * 「报到」的规则（P73f，设计稿场景 F、方案 4.11）：新员工入职当天，在像素办公室里从门口走到自己的工位坐下，
 * 头顶气泡写「报到」，猫走到他的工位旁坐一会儿。这个文件只放不画图的部分：
 * 1. 哪些员工要播放走位：本机浏览器记住已经播过的员工 id（键名 dsh-buddy:office-arrived，最多 50 个），
 *    读写都包在 try/catch 里；读不到时视为已经播过，直接出现（宁可不播，也不重复播）；
 * 2. 减少动态效果（prefers-reduced-motion: reduce）时不走位，直接坐在工位上；
 * 3. 走位的坐标：从门口沿直线走到工位，时长 2.5 秒（任务卡要求 2 到 3 秒）；
 * 4. 猫去哪个工位：今天入职的员工里入职时间最晚的一位。
 *
 * 为什么写成纯函数：走位和猫的位置由「现在几点、从什么时候开始」直接算出，不记任何状态，
 * 测试可以逐帧检查，页面只负责把结果画出来。全部只用界面和规则，不调用模型、不发命令。
 */
import { OFFICE_SEATS, type OfficeSeatLayout } from './layout.js'

/** 浏览器本地存储里记录「已经播过报到」的键名。 */
export const ARRIVED_STORAGE_KEY = 'dsh-buddy:office-arrived'
/** 最多记 50 个员工 id，超出时丢掉最早的。 */
export const ARRIVED_MAX = 50
/** 从门口走到工位的时长（毫秒）：任务卡要求 2 到 3 秒。 */
export const ARRIVAL_WALK_MS = 2500
/**
 * 猫在新员工工位旁坐多久（毫秒）。数值取自 core 的默认值 TEAM_DEFAULTS.CAT_STAY_MS（60 秒，
 * packages/core/src/config/defaults.ts）；插件客户端不能从 core 根入口导入（会把 node 模块拖进浏览器包），
 * 所以在这里写同值，由 test/p73f-office-arrival.test.ts 校验两处一致。
 */
export const CAT_STAY_MS = 60_000
/** 门口落脚点：玻璃门前的地垫（逻辑坐标）。小人从这里出发，y 是脚底。 */
export const OFFICE_DOOR_POINT = { x: 23, y: 100 } as const

/** 读写本地存储只需要这两个方法；测试传内存版。 */
export type ArrivedStore = Pick<Storage, 'getItem' | 'setItem'>

/** 默认用浏览器的 localStorage；拿不到（隐私模式、被禁用、没有这个对象）时返回 null。 */
function defaultStore(): ArrivedStore | null {
  try {
    const store = (globalThis as { localStorage?: ArrivedStore }).localStorage
    return store ?? null
  } catch {
    return null
  }
}

/**
 * 读出已经播过报到的员工 id。读不到（没有存储、抛错、内容不是字符串数组）返回 null，
 * 调用方据此「视为已播过」，不播放也不报错。从没存过（键不存在）是正常情况，返回空数组。
 */
export function readArrived(store: ArrivedStore | null = defaultStore()): string[] | null {
  try {
    if (store === null) return null
    const raw = store.getItem(ARRIVED_STORAGE_KEY)
    if (raw === null) return []
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return null
    return value.filter((item): item is string => typeof item === 'string').slice(-ARRIVED_MAX)
  } catch {
    return null
  }
}

/** 把已播过的 id 写回本地存储（最多 50 个，保留最新的）；写不进去返回 false，不抛错。 */
export function writeArrived(ids: readonly string[], store: ArrivedStore | null = defaultStore()): boolean {
  try {
    if (store === null) return false
    store.setItem(ARRIVED_STORAGE_KEY, JSON.stringify(ids.slice(-ARRIVED_MAX)))
    return true
  } catch {
    return false
  }
}

/** 一次规划的结果：play 是这次要播放走位的员工，remember 是这次之后要记为「已播过」的员工。 */
export interface ArrivalPlan {
  play: string[]
  remember: string[]
}

/**
 * 决定谁要播放走位：
 * - 只看今天入职的员工（joinedToday）；已经播过的不再播；
 * - arrived 为 null（读不到本地存储）：谁都不播，也不记（宁可不播，不重复播）；
 * - 减少动态效果：谁都不播，直接坐在工位上，但记为已看过（以后关掉这个设置也不会补播）。
 */
export function planArrivals(input: {
  seats: ReadonlyArray<{ botId: string; joinedToday?: boolean }>
  arrived: readonly string[] | null
  reducedMotion: boolean
}): ArrivalPlan {
  if (input.arrived === null) return { play: [], remember: [] }
  const seen = new Set(input.arrived)
  const fresh = input.seats.filter(seat => seat.joinedToday === true && !seen.has(seat.botId)).map(seat => seat.botId)
  return { play: input.reducedMotion ? [] : fresh, remember: fresh }
}

/** 把新记下的 id 并进已有的列表：去重，最多 50 个，保留最新的。 */
export function mergeArrived(existing: readonly string[], add: readonly string[]): string[] {
  const merged = [...existing.filter(id => !add.includes(id)), ...add]
  return merged.slice(-ARRIVED_MAX)
}

/** 走位中某一刻的样子：小人水平中心、桌沿基准线（与布局里的 seatX、deskY 同一套坐标），以及迈哪条腿。 */
export interface ArrivalPose {
  seatX: number
  deskY: number
  /** 走路的两帧：交替迈腿。 */
  step: 0 | 1
  /** 走完了（已经到位）。 */
  done: boolean
}

/**
 * 走位的某一刻：从门口沿直线走到工位。elapsedMs 是从开始走起过去的毫秒数；
 * 同样的输入永远得到同样的结果（不读时间、不读随机数）。
 */
export function arrivalPose(seat: Pick<OfficeSeatLayout, 'seatX' | 'deskY'>, elapsedMs: number): ArrivalPose {
  const progress = Math.min(1, Math.max(0, elapsedMs / ARRIVAL_WALK_MS))
  const x = Math.round(OFFICE_DOOR_POINT.x + (seat.seatX - OFFICE_DOOR_POINT.x) * progress)
  const y = Math.round(OFFICE_DOOR_POINT.y + (seat.deskY - OFFICE_DOOR_POINT.y) * progress)
  const step: 0 | 1 = Math.floor(elapsedMs / 200) % 2 === 0 ? 0 : 1
  return { seatX: x, deskY: y, step, done: progress >= 1 }
}

/**
 * 猫去哪个工位：今天入职（joinedToday）的员工里，入职时间（joinedAt）最晚的一位。
 * 入职时间相同时取座位靠后的一位，保证同一份输入永远得到同一个结果；没有今天入职的员工返回 null。
 * 返回座位序号（OFFICE_SEATS 的下标），seats 的顺序就是座位顺序。
 */
export function pickCatVisitSeat(seats: ReadonlyArray<{ joinedToday?: boolean; joinedAt?: number | null }>): number | null {
  let bestIndex: number | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  const limit = Math.min(seats.length, OFFICE_SEATS.length)
  for (let index = 0; index < limit; index += 1) {
    const seat = seats[index]!
    if (seat.joinedToday !== true) continue
    const at = seat.joinedAt ?? Number.NEGATIVE_INFINITY
    if (bestIndex === null || at >= bestAt) { bestIndex = index; bestAt = at }
  }
  return bestIndex
}
