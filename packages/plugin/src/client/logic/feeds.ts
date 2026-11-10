/**
 * 收件箱 / 活动流 / 应用内提示的纯逻辑：排序、筛选、新到判定。
 * 为什么放纯函数：这些是「规则计算」，输入显式、可单测（AGENTS.md 代码规范）。
 */
import type { ActivityRow, InboxItemView } from '../../shared/views.js'

/** 优先级从高到低的序号：P0 最前。 */
const PRIORITY_RANK: Readonly<Record<'P0' | 'P1' | 'P2', number>> = { P0: 0, P1: 1, P2: 2 }

/**
 * 收件箱平铺排序：先按优先级 P0 → P1 → P2，同级按创建时间新→旧。
 * 用副本排序，不改调用方数组；id 兜底保证同一毫秒内顺序稳定。
 */
export function sortInbox(items: readonly InboxItemView[]): InboxItemView[] {
  return [...items].sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || b.createdAt - a.createdAt
    || a.id.localeCompare(b.id),
  )
}

/** 活动流类型的中文名（页面筛选用；不出现英文状态码，16.0.3）。 */
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityRow['kind'], string>> = {
  wake: '唤醒', commit: '交账', approval: '审批', alert: '告警',
  handoff: '交接', peer: '同伴消息', lifecycle: '生命周期', system: '中心',
}

/**
 * 活动流每行的正文：去掉与类型标签重复的开头。
 * core 的唤醒行本身写成「唤醒：<原因>」，界面又在行首加了类型标签「唤醒」，
 * 不处理会读成「唤醒 探路：唤醒：……」。只去掉紧跟开头的同义前缀，正文原样保留。
 */
export function activityLine(kind: ActivityRow['kind'], text: string): string {
  const label = ACTIVITY_KIND_LABELS[kind]
  for (const sep of ['：', '——', ':']) {
    const prefix = `${label}${sep}`
    if (text.startsWith(prefix)) return text.slice(prefix.length)
  }
  return text
}

/** 活动流筛选：按队友与类型（空选项 = 不筛）。 */
export function filterActivity(
  rows: readonly ActivityRow[],
  filter: { botId?: string | null; kind?: ActivityRow['kind'] | null },
): ActivityRow[] {
  return rows.filter(row =>
    (filter.botId == null || filter.botId === '' || row.botId === filter.botId)
    && (filter.kind == null || row.kind === filter.kind),
  )
}

/**
 * P65：收件箱里一件事「查看对话」该去哪条线程。
 * 来自项目主题的事，主人处理后队友回到主题里接着做，所以去主题（主题 id 就是线程 id）；
 * 其余的去这位队友的私聊；全队事项没有队友，返回 null，不显示入口。
 */
export function inboxThreadId(item: Pick<InboxItemView, 'botId' | 'topicId'>): string | null {
  return item.topicId ?? item.botId ?? null
}

/** 新到的 P0/P1 收件箱项（应用内提示只提示这两级；P2 不打扰）。 */
export function newUrgentInbox(prev: readonly InboxItemView[], next: readonly InboxItemView[]): InboxItemView[] {
  const seen = new Set(prev.map(item => item.id))
  return next.filter(item => !seen.has(item.id) && (item.priority === 'P0' || item.priority === 'P1'))
}

/**
 * 从办公室门口点「具体那张卡」时，决定收件箱该用哪档筛选、目标还在不在。
 * 为什么需要：收件箱可能停在「审批」筛选上，而从门口点进来的是一张提问卡；
 * 不先切回「全部」，主人会以为卡丢了。目标已不存在（刚处理完）时返回 null。
 */
export function focusInboxTarget(
  items: readonly InboxItemView[],
  focusId: string | null | undefined,
  filter: string,
): { id: string; filter: string } | null {
  if (focusId === null || focusId === undefined || focusId === '') return null
  const item = items.find(entry => entry.id === focusId)
  if (item === undefined) return null
  return { id: item.id, filter: filter !== 'all' && filter !== item.type ? 'all' : filter }
}
