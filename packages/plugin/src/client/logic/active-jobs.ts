/**
 * 右侧栏「在办的事」的界面规则（P76j，纯函数）：视图行在前、旧的项目任务在后（组标题「其他事务」），
 * 都没有时显示空态；旧宿主（没有 activeJobs 路由）时退回现有的工作会话列表。
 *
 * 为什么单独成文件：排序由 core 定（「在等你的」在前、按交付时间），界面**不重排**；
 * 这里只决定「标题写哪一句、要不要画『其他事务』、现在是空态还是骨架」，
 * 四条分支写在一处、逐条单测，组件只管画。
 */
import type { ActiveJobsView } from '../../shared/views.js'
import { activeWorkGroups } from './teammate-panel.js'
import type { WorkSession, WorkSessionGroup } from './work-session.js'

/** 右侧栏「在办的事」一栏要画的东西。 */
export interface ActiveWorkPanel {
  /** 标题：视图给的整句（「在办的事　3 件　共用 …」），或旧宿主退回时的「在办的事」。 */
  headText: string
  /** 视图行（顺序就是显示顺序，界面不重排）。 */
  rows: ActiveJobsView['rows']
  /** 旧的项目任务（P33 的工作会话），排在视图行之后。 */
  groups: WorkSessionGroup[]
  /** 要不要画「其他事务」这个小标题（有旧任务才画）。 */
  showOtherTitle: boolean
  /** 什么都没有（视图行与旧任务都为空）：显示「现在没有在办的事」。 */
  empty: boolean
  /** 底部「查看全部记录」；旧宿主没有视图时为空（不画这个按钮）。 */
  footerText: string | null
  /** 还在读（项目视图与在办的事都没到）：画骨架，不假装没有工作。 */
  loading: boolean
}

/**
 * 算一栏的内容。
 * - view 非 null：视图行在前；旧任务有内容时画「其他事务」；
 *   视图本身是空态（rows 为空且头部写空态那句）而旧任务也没有时，显示空态。
 * - view 为 null（旧宿主、路由 404、还没读到）：退回现有的工作会话列表，不报错。
 */
export function buildActiveWorkPanel(view: ActiveJobsView | null, sessions: readonly WorkSession[] | null): ActiveWorkPanel {
  const groups = sessions === null ? [] : activeWorkGroups(sessions)
  const legacyCount = groups.reduce((sum, group) => sum + group.sessions.length, 0)
  if (view === null) {
    return {
      headText: '在办的事', rows: [], groups, showOtherTitle: false,
      empty: legacyCount === 0, footerText: null, loading: sessions === null,
    }
  }
  const empty = view.rows.length === 0 && legacyCount === 0
  return {
    headText: view.rows.length === 0 ? '在办的事' : view.headText,
    rows: view.rows,
    groups,
    showOtherTitle: legacyCount > 0 && view.rows.length > 0,
    empty,
    footerText: view.footerText,
    loading: false,
  }
}

/** 消耗条里已用部分的宽度（0 到 100 的百分数）；没有预计（null）时不画条，返回 null。 */
export function costBarWidth(ratio: number | null): string | null {
  if (ratio === null || !Number.isFinite(ratio)) return null
  const clamped = Math.min(1, Math.max(0, ratio))
  return `${Math.round(clamped * 100)}%`
}

/** 「其他事务」：旧的项目任务那一组的小标题。 */
export const OTHER_WORK_TITLE = '其他事务'
