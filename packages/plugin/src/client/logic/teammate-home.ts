/**
 * 队友主页模型（P33）：把一个队友的工作会话收成「摘要 + 在做 + 已归档」。
 *
 * 为什么单独成文件：主页、左栏树与以后的通知深链都要回答同一个问题——
 * 「这个队友现在手上有什么、哪些已经交出去了」。规则集中在这里，
 * 页面只负责画，换布局时不会把口径带跑。
 * 口径全部来自 work-session.ts，本文件不重新判断任务状态。
 */
import {
  groupSessionsByProject, sessionsForBot, summarizeWorkSessions,
  type WorkSession, type WorkSessionGroup, type WorkSessionSummary,
} from './work-session.js'

/** 主页需要的队友信息：来自总览里的 BotCard，页面不自己拼。 */
export interface TeammateHomeInput {
  botId: string
  botName: string
  roleLabel: string | null
  activityText: string | null
  unread: number
  /** 全部工作会话（不限队友）；模型内部按 botId 过滤。 */
  sessions: readonly WorkSession[]
}

/** 主页模型：摘要、母子分组与空态文案。 */
export interface TeammateHomeModel {
  botId: string
  botName: string
  roleLabel: string | null
  activityText: string | null
  unread: number
  summary: WorkSessionSummary
  /** 一句话摘要（数字 + 受阻 + 待验收）。 */
  summaryText: string
  /** 在做：项目分组，组内最近变动的在前。 */
  doing: WorkSessionGroup[]
  /** 已归档：同样按项目分组；页面默认折叠整段。 */
  archived: WorkSessionGroup[]
  /** 没有任何工作会话时的说明；有内容时为 null。 */
  emptyText: string | null
}

/** 摘要句：没有数字时直接说空；有受阻/待验收时点名，避免主人只看总数。 */
export function workSummaryText(summary: WorkSessionSummary): string {
  if (summary.total === 0) return '暂无工作会话。派发任务后在此显示。'
  const doing = summary.blocked > 0
    ? `在做 ${summary.doing} 件（${summary.blocked} 件受阻）`
    : `在做 ${summary.doing} 件`
  const archived = summary.pendingCheck > 0
    ? `已归档 ${summary.archived} 件（${summary.pendingCheck} 件待验收）`
    : `已归档 ${summary.archived} 件`
  return `${doing} · ${archived}`
}

/** 主页空态：区分「没活」与「项目数据还没到」由页面处理，这里只说没活。 */
export const TEAMMATE_HOME_EMPTY = '这个队友还没接手项目里的工作。等它在项目里领到任务，这里会出现工作会话。'

/** 构建主页模型；这是页面唯一需要的入口。 */
export function buildTeammateHome(input: TeammateHomeInput): TeammateHomeModel {
  const own = sessionsForBot(input.sessions, input.botId)
  const summary = summarizeWorkSessions(own)
  return {
    botId: input.botId,
    botName: input.botName,
    roleLabel: input.roleLabel,
    activityText: input.activityText,
    unread: input.unread,
    summary,
    summaryText: workSummaryText(summary),
    doing: groupSessionsByProject(own.filter(session => session.phase === 'doing')),
    archived: groupSessionsByProject(own.filter(session => session.phase === 'archived')),
    emptyText: summary.total === 0 ? TEAMMATE_HOME_EMPTY : null,
  }
}
