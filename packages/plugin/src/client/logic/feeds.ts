/**
 * 收件箱 / 活动流 / 入口计数 / 应用内提示的纯逻辑：分组排序、筛选、新到判定。
 * 为什么放纯函数：这些是「规则计算」，输入显式、可单测（AGENTS.md 代码规范）。
 */
import type { ActivityRow, InboxItemView } from '../../shared/views.js'

/** 收件箱优先级分组（P0 最前）；组内按创建时间新→旧。 */
export interface InboxGroup { priority: 'P0' | 'P1' | 'P2'; label: string; items: InboxItemView[] }

const PRIORITY_ORDER: ReadonlyArray<'P0' | 'P1' | 'P2'> = ['P0', 'P1', 'P2']
const PRIORITY_LABEL: Readonly<Record<'P0' | 'P1' | 'P2', string>> = {
  P0: 'P0 马上要你处理', P1: 'P1 等你拍板', P2: 'P2 有空再看',
}

/** 按 P0/P1/P2 分组（空组不出现），组内按类型分组不做（一页平铺、卡片自带类型标签）。 */
export function groupInbox(items: readonly InboxItemView[]): InboxGroup[] {
  const groups: InboxGroup[] = []
  for (const priority of PRIORITY_ORDER) {
    const list = items
      .filter(item => item.priority === priority)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    if (list.length > 0) groups.push({ priority, label: PRIORITY_LABEL[priority], items: list })
  }
  return groups
}

/** 活动流类型的中文名（页面筛选用；不出现英文状态码，16.0.3）。 */
export const ACTIVITY_KIND_LABELS: Readonly<Record<ActivityRow['kind'], string>> = {
  wake: '唤醒', commit: '交账', approval: '审批', alert: '告警',
  handoff: '交接', peer: '同伴消息', lifecycle: '生命周期', system: '中心',
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

/** 左栏入口 label：有待处理收件箱时显示「队友 · N」。 */
export function entryLabel(inboxTotal: number): string {
  return inboxTotal > 0 ? `队友 · ${inboxTotal > 99 ? '99+' : inboxTotal}` : '队友'
}

/** 新到的 P0/P1 收件箱项（应用内提示只提示这两级；P2 不打扰）。 */
export function newUrgentInbox(prev: readonly InboxItemView[], next: readonly InboxItemView[]): InboxItemView[] {
  const seen = new Set(prev.map(item => item.id))
  return next.filter(item => !seen.has(item.id) && (item.priority === 'P0' || item.priority === 'P1'))
}
