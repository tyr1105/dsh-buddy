/**
 * 选中的队友已经不存在时怎么办（看板 P58）。
 *
 * 事故：队友被删除或沙箱数据被清空后，界面可能还选中着它。选中状态在内存里有一份，
 * 在浏览器本地也有一份，刷新后会恢复。界面照旧拿这个 id 要详情，接口每次都报
 * 「机器人不存在」：每次推送重连多一条错误，整页还会闪「连不上」，
 * 主人则停在一条不存在的对话上。
 *
 * 这个文件只放判断规则（全是纯函数，方便逐条测试），接线在仓库 hub-state 里。规则有四条：
 * 1. 「不存在」只认名册：最新一次成功加载的总览里没有这个 id。不看错误文案，文案以后会变。
 * 2. 名册不可用就不下结论：还没加载、加载失败、形状不对、中心停用时的空占位，一律不清选中。
 * 3. 退役、归档的队友还在名册里，不算不存在；团队线程不是队友，永远不受影响。
 * 4. 名册可能比选中旧：刚建好的队友，选中那一刻手里的名册还没有它，这份旧名册不能判它不存在。
 *
 * P63 起选中的也可能是项目主题（id 以 ptp_ 开头）。主题不在队友名册里，上面四条对它一律不适用；
 * 它「还在不在」只看项目视图，判断方法和名册一样，规则在本文件后半段。
 */
import type { HubState } from '../hub-state.js'
import type { OverviewView, ProjectView } from '../../shared/views.js'
import { isTopicThreadId } from './topics.js'

/** 团队线程的固定 id：它不是某位队友，不用名册核对。 */
export const TEAM_THREAD_ID = 'team'

/**
 * 取名册里的全部队友 id。
 * 返回 null 表示「这份总览不能当名册用」，意思是不知道，不是没有：
 * 还没加载、接口返回形状不对、或者中心停用时的空占位，都不能拿来判断谁不在了。
 */
export function rosterIds(overview: OverviewView | null): ReadonlySet<string> | null {
  if (overview === null || overview.rosterUnavailable === true || !Array.isArray(overview.bots)) return null
  return new Set(overview.bots.map(bot => bot.id))
}

/** 这个线程是不是「名册明确说没有的队友」。团队线程和项目主题永远不算；名册不可用时一律不算。 */
export function isMissingFromRoster(threadId: string, overview: OverviewView | null): boolean {
  if (threadId === TEAM_THREAD_ID || isTopicThreadId(threadId)) return false
  const ids = rosterIds(overview)
  return ids !== null && !ids.has(threadId)
}

/**
 * 新名册到手后，更新「已确认不存在」的 id 集合。
 * 只收「上一份名册里有、这一份没有」的 id：从没见过的 id 可能是刚建好的队友，不能算消失。
 * 重新出现的 id 要移出去（比如沙箱数据被恢复），新名册不可用时什么都不改。
 */
export function nextGoneIds(
  gone: ReadonlySet<string>,
  previous: OverviewView | null,
  next: OverviewView | null,
): ReadonlySet<string> {
  const nextIds = rosterIds(next)
  if (nextIds === null) return gone
  const result = new Set(gone)
  for (const id of nextIds) result.delete(id)
  for (const id of rosterIds(previous) ?? []) {
    if (!nextIds.has(id)) result.add(id)
  }
  return result
}

/** 判断一份名册落地后要不要退出当前选中所需的信息。 */
export interface SelectionCheck {
  selectedThread: string
  roster: OverviewView | null
  /** 这份名册的请求发出之后，主人又主动选过线程：名册可能比这次选中旧。 */
  selectedAfterRequest: boolean
  /** 已确认不存在的 id（已经按这份名册更新过）。 */
  goneIds: ReadonlySet<string>
}

/** 这份名册落地后，当前选中是否该退回团队全景。 */
export function shouldExitSelection(check: SelectionCheck): boolean {
  if (!isMissingFromRoster(check.selectedThread, check.roster)) return false
  // 名册比选中旧时，「没有」说明不了问题，可能只是队友刚建好（规则 4）。
  // 例外：它曾经在名册里、现在不在了，那确实是没了，不用等下一份名册。
  return !check.selectedAfterRequest || check.goneIds.has(check.selectedThread)
}

/** 判断现在能不能按 id 请求详情和对话所需的信息。 */
export interface RequestCheck {
  id: string
  goneIds: ReadonlySet<string>
  selectedThread: string
  /** 是否已经有名册（包括旧的）。 */
  rosterLoaded: boolean
  /** 这次打开以来主人是否主动选过线程；没选过时，当前选中就是从本地恢复出来的。 */
  selectedThisSession: boolean
}

/**
 * 现在能不能按这个 id 请求详情和对话。
 * 两种情况不能：名册已确认它不存在；或者它是从本地恢复出来的选中，第一份名册还没到，
 * 这时不知道它还在不在，等名册回来再决定，免得一打开页面就白打一次报错请求。
 */
export function canRequestById(check: RequestCheck): boolean {
  if (check.id === TEAM_THREAD_ID) return true
  if (check.goneIds.has(check.id)) return false
  // 主题不用等名册：它的线程接口不依赖队友，还在不在由项目视图判断。
  if (isTopicThreadId(check.id)) return true
  const restoredUnchecked = check.id === check.selectedThread && !check.rosterLoaded && !check.selectedThisSession
  return !restoredUnchecked
}

/**
 * 把选中退回团队全景。
 * - 只改「选中了谁」，不改 view：主人正在看项目页或设置页时不把他拽走，
 *   他回到主视图时自然落在团队全景；正在看这条对话时就立刻回到团队全景。
 * - 不顺手标已读：这不是主人点进来的。
 * - 本地记住的选中不用单独清：入口文件订阅着仓库，selectedThread 一变就写回本地。
 */
export function exitMissingSelection(state: HubState): HubState {
  return { ...state, selectedThread: TEAM_THREAD_ID, selectionExitSeq: state.selectionExitSeq + 1 }
}

// ---------- 项目主题（P63）：还在不在只看项目视图，判断方法和名册同一套 ----------

/**
 * 取项目视图里的全部主题 id。返回 null 表示「这份视图不能用来判断」：
 * 还没加载、形状不对、或者中心停用时的空占位，都不能拿来说哪个主题没了。
 */
export function projectTopicIds(view: ProjectView | null): ReadonlySet<string> | null {
  if (view === null || view.rosterUnavailable === true || !Array.isArray(view.projects)) return null
  return new Set(view.projects.flatMap(row => (row.topics ?? []).map(topic => topic.id)))
}

/** 这个线程是不是「项目视图明确说没有的主题」。不是主题或视图不可用时一律不算。 */
export function isMissingTopic(threadId: string, view: ProjectView | null): boolean {
  if (!isTopicThreadId(threadId)) return false
  const ids = projectTopicIds(view)
  return ids !== null && !ids.has(threadId)
}

/** 新的项目视图到手后，更新「已确认不存在的主题」：上一份有、这一份没有的才算。 */
export function nextGoneTopicIds(
  gone: ReadonlySet<string>,
  previous: ProjectView | null,
  next: ProjectView | null,
): ReadonlySet<string> {
  const nextIds = projectTopicIds(next)
  if (nextIds === null) return gone
  const result = new Set(gone)
  for (const id of nextIds) result.delete(id)
  for (const id of projectTopicIds(previous) ?? []) {
    if (!nextIds.has(id)) result.add(id)
  }
  return result
}

/** 判断一份项目视图落地后要不要退出当前选中的主题所需的信息。 */
export interface TopicSelectionCheck {
  selectedThread: string
  project: ProjectView | null
  /** 这份视图的请求发出之后，主人又主动选过线程：视图可能比这次选中旧。 */
  selectedAfterRequest: boolean
  goneIds: ReadonlySet<string>
}

/** 这份项目视图落地后，当前选中的主题是否该退回团队全景。刚建好的主题不能被旧视图判没了。 */
export function shouldExitTopicSelection(check: TopicSelectionCheck): boolean {
  if (!isMissingTopic(check.selectedThread, check.project)) return false
  return !check.selectedAfterRequest || check.goneIds.has(check.selectedThread)
}
