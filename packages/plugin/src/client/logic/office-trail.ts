/**
 * 办公室「当日轨迹」的纯逻辑（P31）：按本地自然日分组、当天正序、只往前翻。
 *
 * 为什么单独成文件：轨迹是主人复盘队友一天做了什么的地方，日期边界必须
 * 跟主人所在时区一致；如果直接用 UTC 或宿主时区，跨零点的事件会跑到错误的一天。
 * 所以时区偏移由调用方显式传入，本文件不读系统时区、不读 Date.now()。
 *
 * 数据只来自现有唤醒账本：调用方把账本行整理成最小事件（id、队友、时间、文案），
 * 这里不做任何「补故事」；坏时间戳与未来时间一律丢弃并计数，界面如实说明。
 */

/** 一条轨迹事件的最小输入；不依赖账本视图的完整字段。 */
export interface OfficeTrailEventInput {
  id: string
  botId: string
  /** 事件发生时刻，UTC 毫秒。 */
  at: number
  text: string
  /** 可选标签（工作/等待/归档等），由调用方按账本字段决定；这里只原样携带。 */
  kindLabel?: string | null
}

export interface OfficeTrailEvent extends OfficeTrailEventInput {
  /** 本地时间 HH:mm，列表左侧显示。 */
  timeText: string
}

export interface OfficeTrailDay {
  /** 本地自然日键，YYYY-MM-DD。 */
  key: string
  /** 当天本地 0 点对应的 UTC 毫秒，用于窗口比较。 */
  startMs: number
  /** 今天 / 昨天 / 11 月 6 日 / 跨年时带年份。 */
  label: string
  isToday: boolean
  /** 当天事件按时间正序。 */
  events: OfficeTrailEvent[]
}

export interface OfficeTrail {
  /** 从今天往前倒序：days[0] 是今天，days[1] 是昨天。 */
  days: OfficeTrailDay[]
  /** 坏时间戳或未来时间被丢弃的条数。 */
  dropped: number
  /** 超出回看窗口被截掉的条数。 */
  truncated: number
}

export interface OfficeTrailInput {
  events: readonly OfficeTrailEventInput[]
  /** 当前时刻，UTC 毫秒；显式传入，方便测试。 */
  now: number
  /** 时区偏移分钟数：东八区传 480，UTC 传 0。 */
  utcOffsetMinutes: number
  /** 最多回看多少天（含今天），默认 30，避免异常数据把列表撑爆。 */
  maxDays?: number
}

export interface OfficeTrailWindow {
  trail: OfficeTrail
  index: number
  day: OfficeTrailDay
  canGoOlder: boolean
  canGoNewer: boolean
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 把 UTC 毫秒换成「本地日历」的年月日时分；只用于计算，不用于显示时区名。 */
function localParts(ms: number, offsetMinutes: number): {
  year: number; month: number; day: number; hour: number; minute: number
} {
  const date = new Date(ms + offsetMinutes * 60000)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  }
}

/** 本地自然日键：YYYY-MM-DD，补零后可直接按字符串比较。 */
function dayKeyOf(ms: number, offsetMinutes: number): string {
  const parts = localParts(ms, offsetMinutes)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/** 本地自然日 0 点对应的 UTC 毫秒。 */
function dayStartOf(ms: number, offsetMinutes: number): number {
  const parts = localParts(ms, offsetMinutes)
  return Date.UTC(parts.year, parts.month - 1, parts.day) - offsetMinutes * 60000
}

/** 两个自然日相隔的天数；用本地正午避免夏令时边界，时区固定时也稳定。 */
function dayDistance(fromMs: number, toMs: number, offsetMinutes: number): number {
  const from = localParts(fromMs, offsetMinutes)
  const to = localParts(toMs, offsetMinutes)
  const fromDay = Date.UTC(from.year, from.month - 1, from.day)
  const toDay = Date.UTC(to.year, to.month - 1, to.day)
  return Math.round((toDay - fromDay) / DAY_MS)
}

/** 日期文案：今天/昨天用相对说法，更早的给月日，跨年补年份。 */
function dayLabelOf(ms: number, now: number, offsetMinutes: number): string {
  const parts = localParts(ms, offsetMinutes)
  const today = localParts(now, offsetMinutes)
  const base = `${parts.month} 月 ${parts.day} 日`
  if (parts.year === today.year && parts.month === today.month && parts.day === today.day) {
    return `今天 · ${base}`
  }
  const yesterdayMs = Date.UTC(today.year, today.month - 1, today.day - 1)
  const yesterday = {
    year: new Date(yesterdayMs).getUTCFullYear(),
    month: new Date(yesterdayMs).getUTCMonth() + 1,
    day: new Date(yesterdayMs).getUTCDate(),
  }
  if (parts.year === yesterday.year && parts.month === yesterday.month && parts.day === yesterday.day) {
    return `昨天 · ${base}`
  }
  return parts.year === today.year ? base : `${parts.year} 年 ${base}`
}

/** 本地 HH:mm。 */
function timeTextOf(ms: number, offsetMinutes: number): string {
  const parts = localParts(ms, offsetMinutes)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

/**
 * 构建轨迹：
 * 1. 丢掉非有限时间戳与未来事件（未来不是「今天发生过的事」）；
 * 2. 从今天往回到最早一条有效事件，逐日生成，空日也保留；
 * 3. 最多回看 maxDays 天，更早的计数为 truncated；
 * 4. 每天事件按时间正序，同一时刻按 id 稳定排序。
 */
export function buildOfficeTrail(input: OfficeTrailInput): OfficeTrail {
  const offset = input.utcOffsetMinutes
  const maxDays = Math.max(1, Math.floor(input.maxDays ?? 30))
  const todayKey = dayKeyOf(input.now, offset)
  const todayStart = dayStartOf(input.now, offset)

  const valid: OfficeTrailEventInput[] = []
  let dropped = 0
  for (const event of input.events) {
    if (!Number.isFinite(event.at)) {
      dropped += 1
      continue
    }
    // 未来事件不进入轨迹；按天比较，允许今天稍晚发生但仍在今天的事件。
    if (dayKeyOf(event.at, offset) > todayKey) {
      dropped += 1
      continue
    }
    valid.push(event)
  }

  let earliestStart = todayStart
  for (const event of valid) {
    const start = dayStartOf(event.at, offset)
    if (start < earliestStart) earliestStart = start
  }

  const span = Math.max(0, dayDistance(earliestStart, todayStart, offset))
  const dayCount = Math.min(span + 1, maxDays)
  const oldestIncluded = todayStart - (dayCount - 1) * DAY_MS

  const byDay = new Map<string, OfficeTrailEvent[]>()
  let truncated = 0
  for (const event of valid) {
    const start = dayStartOf(event.at, offset)
    if (start < oldestIncluded) {
      truncated += 1
      continue
    }
    const key = dayKeyOf(event.at, offset)
    const list = byDay.get(key) ?? []
    list.push({ ...event, timeText: timeTextOf(event.at, offset) })
    byDay.set(key, list)
  }

  const days: OfficeTrailDay[] = []
  for (let i = 0; i < dayCount; i += 1) {
    const startMs = todayStart - i * DAY_MS
    const key = dayKeyOf(startMs, offset)
    const events = byDay.get(key) ?? []
    events.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    days.push({
      key,
      startMs,
      label: dayLabelOf(startMs, input.now, offset),
      isToday: i === 0,
      events,
    })
  }

  return { days, dropped, truncated }
}

/**
 * 当前窗口：索引越界时夹到合法范围，绝不抛错；没有天数时返回 null。
 * canGoOlder 只取决于「后面还有没有更早的一天」，canGoNewer 取决于「前面还有没有更新的一天」。
 */
export function officeTrailWindow(trail: OfficeTrail, index: number): OfficeTrailWindow | null {
  if (trail.days.length === 0) return null
  const safe = Math.max(0, Math.min(trail.days.length - 1, Math.floor(index)))
  const day = trail.days[safe]!
  return {
    trail,
    index: safe,
    day,
    canGoOlder: safe < trail.days.length - 1,
    canGoNewer: safe > 0,
  }
}

/** 往前/往后翻一天并夹住边界：前翻不会越过最早一天，后翻不会越过今天。 */
export function stepTrailDay(trail: OfficeTrail, index: number, direction: 'older' | 'newer'): number {
  if (trail.days.length === 0) return 0
  const delta = direction === 'older' ? 1 : -1
  const next = Math.floor(index) + delta
  return Math.max(0, Math.min(trail.days.length - 1, next))
}
