/**
 * 办公室界面的纯逻辑（F03）：把 core 投影好的座位再翻译成「点哪里、去哪」。
 *
 * 为什么单独成文件：下钻规则（点灯/点桌子/点门口分别打开什么）是交互契约，
 * 写成纯函数才能在测试里逐条断言；组件只负责渲染，不自己判断 ref 含义。
 * 所有判断都以 core 给的 refKind / refId 为准，界面不猜。
 */
import type {
  ArtifactVersionRow, OfficeLight, OfficeView, SeatView, WakeLedgerRow,
} from '../../shared/views.js'
import type { OfficeTrailEventInput } from './office-trail.js'

/** 灯的语义色调：只决定颜色，不改变文案（文案一律用 core 的 lightLabel）。 */
export type OfficeLightTone = 'success' | 'accent' | 'warning' | 'danger' | 'muted' | 'unknown'

/** 灯 → 色调（与 docs/plan/v2-transformation.md 3.5 的灯表一一对应）。 */
export function officeLightTone(light: OfficeLight): OfficeLightTone {
  switch (light) {
    case 'working': return 'success'
    case 'queued': return 'accent'
    case 'waiting': return 'warning'
    case 'blocked': return 'danger'
    case 'resting': return 'muted'
    case 'watching': return 'accent'
    case 'offline': return 'muted'
    case 'vacant': return 'muted'
    case 'unknown': return 'unknown'
  }
}

/** 点座位（或它的灯）去哪：座位必有占用者，直接打开那位队友。 */
export function seatTarget(seat: SeatView): { kind: 'bot'; botId: string } {
  return { kind: 'bot', botId: seat.occupant.botId }
}

/** 桌面下钻目标：产物、账本，或只打开队友详情（界面上现在统一落到该队友的对话或动态页）。 */
export type DeskTarget =
  | { kind: 'ledger'; botId: string; wakeId: string }
  | { kind: 'artifact'; botId: string; artifactId: string }
  | { kind: 'bot'; botId: string }

/**
 * 点桌上的产出去哪：
 * - 有产物（refKind='artifact'）→ 带上产物 id 去该队友那边（右栏产物面板已删除，界面直接进和它的对话）；
 * - 有账本（refKind='wake'）→ 带上唤醒 id，界面去动态页看这次唤醒的记录；
 * - 只有队友（refKind='bot'）→ 直接进和它的对话。
 */
export function deskTarget(seat: SeatView): DeskTarget {
  if (seat.desk.refKind === 'artifact' && seat.desk.refId !== '') {
    return { kind: 'artifact', botId: seat.occupant.botId, artifactId: seat.desk.refId }
  }
  if (seat.desk.refKind === 'wake' && seat.desk.refId !== '') {
    return { kind: 'ledger', botId: seat.occupant.botId, wakeId: seat.desk.refId }
  }
  return { kind: 'bot', botId: seat.occupant.botId }
}

/**
 * 从产物列表里挑出某个产物头下最新的一版：先比创建时间，再比版本号，最后比 id。
 * 为什么界面也要挑一次：core 的桌面只给产物头 id，要落到具体版本得自己挑；
 * 规则与 core 上桌时一致，保证「桌上看到的那份」就是「点开选中的那版」。
 * （右栏产物面板删除后，目前只有测试在用这个函数。）
 */
export function artifactFocusVersion(
  rows: ReadonlyArray<ArtifactVersionRow>,
  artifactId: string,
): ArtifactVersionRow | null {
  let best: ArtifactVersionRow | null = null
  for (const row of rows) {
    if (row.artifactId !== artifactId) continue
    const newer = best === null || row.createdAt > best.createdAt
      || (row.createdAt === best.createdAt && (row.number > best.number
        || (row.number === best.number && row.id > best.id)))
    if (newer) best = row
  }
  return best
}

/** 点门口的数字去哪：有未关闭收件箱项就回收到件箱页，并聚焦到具体那张卡（F04）。 */
export function doorTarget(seat: SeatView): { kind: 'inbox'; inboxIds: string[] } | null {
  return seat.door.count > 0 ? { kind: 'inbox', inboxIds: [...seat.door.inboxIds] } : null
}

/** 点房间总信箱去哪：团队级收件箱项；空的时候不可点。 */
export function doorwayTarget(office: OfficeView): { kind: 'inbox'; inboxIds: string[] } | null {
  return office.doorway.count > 0 ? { kind: 'inbox', inboxIds: office.doorway.items.map(item => item.inboxId) } : null
}

/** 顶部一句话汇总：让主人不用逐个座位数。 */
export interface OfficeSummary {
  /** 在座队友数：取消编制后每个座位就是一位在职队友。 */
  occupied: number
  waiting: number
  blocked: number
  doorTotal: number
}

/** 汇总计数全部来自投影本身（座位与门口），不另外推算。 */
export function officeSummary(office: OfficeView): OfficeSummary {
  let waiting = 0
  let blocked = 0
  let doorTotal = office.doorway.count
  for (const seat of office.seats) {
    if (seat.light === 'waiting') waiting += 1
    if (seat.light === 'blocked') blocked += 1
    doorTotal += seat.door.count
  }
  return { occupied: office.seats.length, waiting, blocked, doorTotal }
}

/** 首屏只根据真实投影判断：没有任何在岗队友时提示新建（倒带里不提示）。 */
export function officeStartState(office: OfficeView): 'empty' | null {
  return office.seats.length === 0 ? 'empty' : null
}

/**
 * 「今天」的时区偏移（分钟）：显式时区优先，缺失或非法时退回本机时区。
 * 轨迹按本地自然日分组，必须和主人所在时区一致；时区名由调用方显式传入。
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>()

export function utcOffsetMinutesAt(at: number, timezone?: string | null): number {
  if (!timezone) return -new Date(at).getTimezoneOffset()
  try {
    let formatter = offsetFormatters.get(timezone)
    if (formatter === undefined) {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
      offsetFormatters.set(timezone, formatter)
    }
    const parts = formatter.formatToParts(new Date(at))
    const valueOf = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0')
    // Intl 在部分 ICU 版本里把午夜给成 24 点，取模回到 0 点，避免多算一天。
    const hour = valueOf('hour') % 24
    const local = Date.UTC(
      valueOf('year'), valueOf('month') - 1, valueOf('day'), hour, valueOf('minute'), valueOf('second'),
    )
    return Math.round((local - at) / 60_000)
  } catch {
    // 时区名写错时不能让整个轨迹面板崩掉；按本机时区显示并如实继续。
    return -new Date(at).getTimezoneOffset()
  }
}

/**
 * 把唤醒账本行压成轨迹事件：id 用 wakeId，按天分组后还能对回原来的账本行。
 * 文案优先交账摘要，其次触发理由，最后退到「某类唤醒」；不编故事、不补空白。
 * P62 起员工动线只借这里的时间和 id 分天，面板上的文字另由 office-trail-timeline.ts 算，
 * 这里的文案不上屏。
 */
export function trailEventsFromWakes(rows: readonly WakeLedgerRow[]): OfficeTrailEventInput[] {
  return rows.map(row => {
    const summary = row.summary?.trim() ?? ''
    const trigger = row.triggerText?.trim() ?? ''
    return {
      id: row.wakeId,
      botId: row.botId,
      at: row.openedAt,
      text: summary || trigger || `${row.variantLabel}唤醒`,
      kindLabel: row.outcomeLabel ?? row.statusLabel,
    }
  })
}
