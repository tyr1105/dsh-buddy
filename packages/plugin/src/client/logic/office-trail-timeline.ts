/**
 * 办公室「员工动线」的纯逻辑（P62，决策 DC37）：把一位队友的唤醒账本行和项目任务，
 * 算成一行一行的时间段，例如「14:02～14:30：周报，抓取竞品」「14:30～现在：空闲」。
 *
 * 为什么单独成文件：主人只想看「这段时间它在干嘛」，颗粒度到「空闲」「项目，事项」
 * 「完成工作，等待验收」为止。合并、空闲、跨天这些规则全部在这里算成结果，面板只管画；
 * 写成纯函数，每条规则才能用单测钉死。
 *
 * 时间口径：沿用 office-trail.ts 的 buildOfficeTrail（时区偏移由调用方显式传入，
 * 按本地自然日分组）。本文件不读系统时区、不读 Date.now()，「现在」也由调用方传入，
 * 这样倒带时可以把时间停在所选时刻。
 *
 * 显示纪律：账本里的唤醒类型、id、摘要原文一律不进文案；唤醒本身的说法只来自下面那张映射表。
 */
import type { ProjectTask, ProjectView, WakeKind, WakeLedgerRow } from '../../shared/views.js'
import { buildOfficeTrail, timeTextOf, type OfficeTrail } from './office-trail.js'
import { trailEventsFromWakes } from './office.js'

/**
 * 相邻两段是同一件事、间隔小于这个值就并成一段（5 分钟）。
 * 原因：同一件事常被拆成好几次唤醒，中间只隔一两分钟（等工具、等下一轮调度）。
 * 主人想看到的是「这段时间在做这件事」，不是一串碎片；隔得更久就算回来接着做，
 * 中间也确实歇过，要如实显示。
 */
export const TRAIL_MERGE_GAP_MS = 5 * 60_000

/**
 * 小于这个值的空闲不单独成行（1 分钟）。
 * 原因：时间只显示到分钟，不到 1 分钟的空档写出来多半是「10:30～10:30：空闲」，
 * 看不出什么，还把列表拉长。这段空档也不算进前后的工作，工作段仍按真实起止显示。
 */
export const TRAIL_MIN_IDLE_MS = 60_000

/** 两段工作之间什么都没做。 */
const TRAIL_IDLE_TEXT = '空闲'
/** 做完等主人验收：只用在待验收任务最后一次工作之后的那段间隔。 */
export const TRAIL_PENDING_CHECK_TEXT = '完成工作，等待验收'
/** 映射表查不到时的兜底说法：不猜，也不把内部类型名露给主人。 */
export const TRAIL_UNKNOWN_WORK_TEXT = '处理自己的事'
/** 正在进行的那段写到这里。 */
const TRAIL_NOW_TEXT = '现在'

/**
 * 不属于任何项目任务的工作，按「为什么醒」说一句人话。全界面只认这一张表，要改说法只改这里。
 * 试跑（trial）、教学（teach）很少见，不单列，落到上面的兜底说法。
 */
const TRIGGER_TEXT: Readonly<Partial<Record<WakeKind, string>>> = {
  owner_message: '回你的消息',
  // 主人在收件箱回了话、批了审批：对主人来说都是「它在接我的话」。
  inbox_reply: '回你的消息',
  approval_decided: '回你的消息',
  peer_message: '回同事的消息',
  // 盯着的文件、日志、网页有变化；pile 是攒起来一起看的小变化。
  percept: '看外部变化',
  pile: '看外部变化',
  // 议程到期、自己定的下次思考时间到了、上次没跑成重来：都是照原来的安排往下走。
  agenda_due: '按计划继续',
  next_think: '按计划继续',
  retry: '按计划继续',
  // 自己想起来看一眼、轻量复查、停机后补看：都是主动查看进展。
  drive: '自己查看进展',
  light_check: '自己查看进展',
  catch_up: '自己查看进展',
  reflection: '复盘',
}

/** 一段工作是「哪件事」。key 判断是不是同一件事，label 是行里给人看的那句话。 */
export interface TrailWorkItem {
  key: string
  label: string
  /** 这件事现在是否在等主人验收；只有项目任务可能为 true。 */
  pendingCheck: boolean
}

/** 动线只用得到任务的这几项。 */
export type TrailTaskInput = Pick<ProjectTask, 'id' | 'title' | 'status' | 'wakeIds' | 'createdAt' | 'updatedAt' | 'dueAt'>

export interface TrailProjectInput {
  name: string
  tasks: readonly TrailTaskInput[]
}

/** 「这次唤醒属于哪件事」能查的资料：账本行没带项目和事项时，从项目任务里找。 */
export interface TrailWorkSources {
  projects: readonly TrailProjectInput[]
}

/** 查找时要知道是哪次唤醒、它的起止时间，以及账本行自己带的项目和事项（旧数据可能没有）。 */
export type TrailWakeRef = Pick<WakeLedgerRow, 'wakeId' | 'openedAt' | 'sealedAt'>
  & Partial<Pick<WakeLedgerRow, 'projectName' | 'itemTitle'>>

/** 每天的一行。 */
export interface TrailSegment {
  /** 列表渲染用的稳定 key。 */
  id: string
  /** 工作 / 空闲 / 做完等验收；面板按它决定文字颜色。 */
  kind: 'work' | 'idle' | 'pending'
  startAt: number
  /** 真实结束时刻；写到「现在」的段是 null。 */
  endAt: number | null
  /** 例：14:02～14:30 或 14:02～现在。 */
  timeText: string
  /** 例：周报，抓取竞品。 */
  text: string
  /** 整行：14:02～14:30：周报，抓取竞品。 */
  line: string
}

export interface TrailTimeline {
  /** 按天分组的结果（沿用 buildOfficeTrail），翻页函数 officeTrailWindow、stepTrailDay 直接吃它。 */
  trail: OfficeTrail
  /** 每天的时间段，键是本地自然日 YYYY-MM-DD。 */
  segments: Record<string, TrailSegment[]>
}

export interface BuildTrailTimelineInput extends TrailWorkSources {
  rows: readonly WakeLedgerRow[]
  /** 当前时刻，UTC 毫秒；倒带时是所选时刻。 */
  now: number
  /** 时区偏移分钟数：东八区传 480，UTC 传 0。 */
  utcOffsetMinutes: number
  /** false=倒带回看：没结束的段写所选时刻，不写「现在」。缺省 true。 */
  live?: boolean
  /** 最多回看多少天（含今天），缺省沿用 buildOfficeTrail 的 30 天。 */
  maxDays?: number
}

/** 整理后的一次工作：起止已经修正好，属于哪件事也查好了。 */
interface WorkSpan {
  row: WakeLedgerRow
  startAt: number
  endAt: number
  /** 还没结束：endAt 此时等于 now。 */
  open: boolean
  item: TrailWorkItem
  /** 这是这件事最后一次工作（看全部账本行，不只看当天）。 */
  lastOfItem: boolean
}

/** 字符串比较，只用来让排序结果稳定。 */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 不属于任何任务时，按唤醒原因给一句人话。 */
export function trailTextForTrigger(triggerKind: string): string {
  return TRIGGER_TEXT[triggerKind as WakeKind] ?? TRAIL_UNKNOWN_WORK_TEXT
}

/**
 * 从项目任务里找这次唤醒属于哪一件（任务的 wakeIds 里有它）。
 *
 * 一次唤醒可能同时命中好几个任务：core 组唤醒包时把队友手上在做的任务都带上，
 * 并给每一个都记上这次唤醒，所以要有确定的选法：
 * 1. 哪个任务的更新时间落在这次工作时段内，说明这次真的动过它（比如交了验收），优先；
 * 2. 否则按 core 给任务排序的规矩取第一个：截止早的优先，没截止的靠后，再比创建时间。
 */
function findProjectTaskItem(row: TrailWakeRef, projects: readonly TrailProjectInput[]): TrailWorkItem | null {
  const hits = projects.flatMap(project => project.tasks
    .filter(task => task.wakeIds.includes(row.wakeId))
    .map(task => ({ project, task })))
  const touched = (task: TrailTaskInput): boolean =>
    task.updatedAt >= row.openedAt && (row.sealedAt === null || task.updatedAt <= row.sealedAt)
  hits.sort(({ task: a }, { task: b }) => {
    const aTouched = touched(a)
    if (aTouched !== touched(b)) return aTouched ? -1 : 1
    if (aTouched && a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    const dueA = a.dueAt ?? Number.MAX_SAFE_INTEGER
    const dueB = b.dueAt ?? Number.MAX_SAFE_INTEGER
    return dueA - dueB || a.createdAt - b.createdAt || compareText(a.id, b.id)
  })
  const first = hits[0]
  if (first === undefined) return null
  return {
    key: `task:${first.task.id}`,
    // 主人定的格式：全角逗号隔开，不带方括号，例如「dddd，来来」。
    label: `${first.project.name}，${first.task.title}`,
    pendingCheck: first.task.status === 'done_pending_check',
  }
}

/**
 * 这次唤醒属于哪件事；不属于任何具体的事时返回 null，由调用方按唤醒原因说一句人话。
 * core 的账本行已经算好了项目名和事项（主题回合就是主题名），有就优先用：
 * 主题讨论不一定对应某条任务，光查任务会落成「回你的消息」，看不出在忙哪件事。
 * 账本行没带（旧数据）时才回到按任务查。
 */
export function findTrailWorkItem(row: TrailWakeRef, sources: TrailWorkSources): TrailWorkItem | null {
  const fromTask = findProjectTaskItem(row, sources.projects)
  if (!row.projectName || !row.itemTitle) return fromTask
  const label = `${row.projectName}，${row.itemTitle}`
  // 「等待验收」只在说的是同一件事时才算数：一次主题回合可能顺带记在别的任务上。
  return { key: `item:${label}`, label, pendingCheck: fromTask?.label === label && fromTask.pendingCheck }
}

/** 项目页视图 → 动线要的最小形状；面板读到的 ProjectView 经这里转一次。 */
export function trailProjectsFromView(view: ProjectView): TrailProjectInput[] {
  return view.projects.map(row => ({ name: row.project.name, tasks: row.tasks.map(item => item.task) }))
}

/**
 * 把账本行整理成按时间排好的工作段：
 * - 同一次唤醒只算一行；开始时间坏了或晚于 now 的不算（倒带时未来的事不能提前出现）；
 * - 结束时间缺失或晚于 now：这段在 now 这一刻还没结束，写到「现在」；
 * - 后面还有更晚的一次工作时，这段最晚只到下一段开始：同一位队友同一时间只做一件事，
 *   这样异常残留的未封存账本不会一直写到「现在」，时间段也不会互相叠着。
 */
function workSpans(input: BuildTrailTimelineInput): WorkSpan[] {
  const byWake = new Map<string, WakeLedgerRow>()
  for (const row of input.rows) {
    if (Number.isFinite(row.openedAt) && row.openedAt <= input.now) byWake.set(row.wakeId, row)
  }
  const ordered = [...byWake.values()].sort((a, b) => a.openedAt - b.openedAt || compareText(a.wakeId, b.wakeId))

  const spans = ordered.map((row, index): WorkSpan => {
    const next = ordered[index + 1]
    const sealedAt = row.sealedAt !== null && Number.isFinite(row.sealedAt) && row.sealedAt <= input.now ? row.sealedAt : null
    const cutByNext = next !== undefined && (sealedAt === null || sealedAt > next.openedAt)
    // 封存时间早于开始时间属于坏数据，按零长度处理，不让这一行倒着走。
    const endAt = cutByNext ? next.openedAt : sealedAt === null ? input.now : Math.max(row.openedAt, sealedAt)
    const known = findTrailWorkItem(row, input)
    const text = trailTextForTrigger(row.triggerKind)
    return {
      row,
      startAt: row.openedAt,
      endAt,
      open: sealedAt === null && next === undefined,
      // 同一句人话算同一件事，相邻的「回你的消息」才能并成一段。
      item: known ?? { key: `trigger:${text}`, label: text, pendingCheck: false },
      lastOfItem: false,
    }
  })

  // 倒着扫：每件事第一次碰到的就是它最后一次工作。
  const seen = new Set<string>()
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]!
    if (!seen.has(span.item.key)) {
      seen.add(span.item.key)
      span.lastOfItem = true
    }
  }
  return spans
}

/** 相邻同一件事且间隔够短的并成一段：起点取前一段，其余（结束、是否还在进行）跟后一段。 */
function mergeSpans(spans: readonly WorkSpan[]): WorkSpan[] {
  const merged: WorkSpan[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last !== undefined && last.item.key === span.item.key && span.startAt - last.endAt < TRAIL_MERGE_GAP_MS) {
      merged[merged.length - 1] = { ...span, startAt: last.startAt }
    } else {
      merged.push(span)
    }
  }
  return merged
}

/** 拼一行。endAt 为 null 表示写到「现在」；倒带时写所选时刻，那一刻对主人来说不是现在。 */
function segmentOf(
  kind: TrailSegment['kind'], startAt: number, endAt: number | null, text: string, input: BuildTrailTimelineInput,
): TrailSegment {
  const offset = input.utcOffsetMinutes
  const openEnd = input.live === false ? timeTextOf(input.now, offset) : TRAIL_NOW_TEXT
  const timeText = `${timeTextOf(startAt, offset)}～${endAt === null ? openEnd : timeTextOf(endAt, offset)}`
  return { id: `${kind}-${startAt}-${endAt ?? 'open'}`, kind, startAt, endAt, timeText, text, line: `${timeText}：${text}` }
}

/** 某段工作之后到 gapEnd 的间隔；不足 1 分钟不成行。showEnd 为 null 时写到「现在」。 */
function gapAfter(span: WorkSpan, gapEnd: number, showEnd: number | null, input: BuildTrailTimelineInput): TrailSegment | null {
  if (gapEnd - span.endAt < TRAIL_MIN_IDLE_MS) return null
  // 只有「现在待验收」且「这是这件事最后一次工作」才算做完了在等验收，否则就是普通空闲。
  return span.item.pendingCheck && span.lastOfItem
    ? segmentOf('pending', span.endAt, showEnd, TRAIL_PENDING_CHECK_TEXT, input)
    : segmentOf('idle', span.endAt, showEnd, TRAIL_IDLE_TEXT, input)
}

/**
 * 一天的时间段：从当天第一段活动开始，不补 00:00 起的空闲。
 * 今天的最后一段如果已经结束，后面补一行写到「现在」的间隔；往日到最后一段结束为止。
 */
function daySegments(spans: readonly WorkSpan[], isToday: boolean, input: BuildTrailTimelineInput): TrailSegment[] {
  const merged = mergeSpans(spans)
  const segments: TrailSegment[] = []
  merged.forEach((span, index) => {
    segments.push(segmentOf('work', span.startAt, span.open ? null : span.endAt, span.item.label, input))
    const next = merged[index + 1]
    const gap = next !== undefined
      ? gapAfter(span, next.startAt, next.startAt, input)
      : isToday && !span.open ? gapAfter(span, input.now, null, input) : null
    if (gap !== null) segments.push(gap)
  })
  return segments
}

/**
 * 主函数：账本行 + 项目任务 → 按天的时间段。
 * 跨午夜的工作按开始那天算（分天用的就是开始时间），也只在同一天里合并，
 * 否则今天的第一段工作会被并进昨天，今天的列表反而少了它。
 */
export function buildTrailTimeline(input: BuildTrailTimelineInput): TrailTimeline {
  const spans = workSpans(input)
  const trail = buildOfficeTrail({
    events: trailEventsFromWakes(spans.map(span => span.row)),
    now: input.now,
    utcOffsetMinutes: input.utcOffsetMinutes,
    maxDays: input.maxDays,
  })
  const spanOf = new Map(spans.map(span => [span.row.wakeId, span]))
  const segments: Record<string, TrailSegment[]> = {}
  for (const day of trail.days) {
    const daySpans = day.events.flatMap(event => spanOf.get(event.id) ?? [])
    segments[day.key] = daySegments(daySpans, day.isToday, input)
  }
  return { trail, segments }
}
