/**
 * 团队空间左栏的三组导航模型（P44）：办公室 → 队友 → 工作区。
 *
 * 为什么单独成文件：主人定的 IA 是「一套左栏、三组、顺序固定」，
 * 之前办公室只在顶栏、工作区留在原生侧栏，导致两套侧栏并存。
 * 把「哪些项目进工作区、项目下挂哪些会话、默认展开谁」写成纯函数，
 * 宿主侧栏与页面内降级列就能画出完全一样的一棵树，测试也不用起 DOM。
 *
 * 口径（P63）：
 * - 项目下面的一行就是一个主题聊天，点开进聊天；事务清单只在项目页看，不再进左栏；
 * - 主题的顺序沿用 core 给的（最近有消息的在前），这里不重排；
 * - 归档项目整组不出现：归档代表这件事结束了，左栏只留还在推进的工作。
 */
import type { ProjectStatus, ProjectView } from '../../shared/views.js'

/** 三组的固定顺序：办公室永远第一，工作区最后。 */
export const SIDEBAR_GROUP_ORDER = ['office', 'teammates', 'workspaces'] as const
export type SidebarGroupId = (typeof SIDEBAR_GROUP_ORDER)[number]

/** 分组标题：组件直接取这里，不在 JSX 里写死第二份文案。 */
export const SIDEBAR_GROUP_TITLES: Record<SidebarGroupId, string> = {
  office: '办公室',
  teammates: '队友',
  workspaces: '工作区',
}

/** 左栏里的一个主题：只保留画一行需要的字段。 */
export interface SidebarTopic {
  id: string
  projectId: string
  title: string
  /** 未读条数：大于 0 时标题后面有一个点。 */
  unread: number
  /** 最后一条消息的预览，悬停时显示；还没有消息时为 null。 */
  preview: string | null
}

/** 工作区组里的一个项目：项目是母，主题是子。 */
export interface SidebarProjectNode {
  projectId: string
  name: string
  status: ProjectStatus
  /** 项目名后面的小计数：这个项目下有几条会话。 */
  topicCount: number
  topics: SidebarTopic[]
  /** 是否展开子行；默认有主题就展开。 */
  expanded: boolean
  /** 当前是否停在这个项目的项目页。 */
  active: boolean
}

/** 构建工作区组需要的输入；项目少时仍保持稳定顺序。 */
export interface SidebarWorkspaceInput {
  projects: readonly SidebarProjectInput[]
  /** 显式展开的项目；不传表示「有主题的项目默认展开」。 */
  expandedProjectIds?: readonly string[]
  /** 当前打开的项目 id（停在项目页时高亮）。 */
  activeProjectId?: string | null
}

/** 项目输入：主题由 collectSidebarProjects 从项目视图里取好。 */
export interface SidebarProjectInput {
  id: string
  name: string
  status: ProjectStatus
  /** 项目成员：队友行加号新建会话时，只列它参与的项目。 */
  memberBotIds: readonly string[]
  topics: readonly SidebarTopic[]
}

/** 项目状态排序：进行中在前，归档最后；归档项目由收集阶段直接剔除。 */
const PROJECT_STATUS_RANK: Record<ProjectStatus, number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
}

/**
 * 从项目视图取出「非归档项目 + 各自的主题」。
 * 项目视图还没加载时为 null：返回空数组，界面显示「读不出来」与重试，而不是假装没有工作。
 */
export function collectSidebarProjects(view: ProjectView | null): SidebarProjectInput[] {
  if (view === null) return []
  const out: SidebarProjectInput[] = []
  for (const row of view.projects) {
    if (row.project.status === 'archived') continue
    const topics = (row.topics ?? []).map((topic): SidebarTopic => ({
      id: topic.id,
      projectId: row.project.id,
      title: topic.title,
      unread: topic.unread,
      preview: topic.lastMessagePreview,
    }))
    out.push({ id: row.project.id, name: row.project.name, status: row.project.status, memberBotIds: row.project.memberBotIds, topics })
  }
  return out
}

/** 项目排序：状态 → 名字 → id，同一份输入永远同一顺序。 */
function compareProjects(a: SidebarProjectInput, b: SidebarProjectInput): number {
  const rank = PROJECT_STATUS_RANK[a.status] - PROJECT_STATUS_RANK[b.status]
  if (rank !== 0) return rank
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN')
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 生成工作区组的项目节点。展开规则：
 * - 调用方显式给了 expandedProjectIds 就完全照它（用户手动折叠/展开优先）；
 * - 没给时，有主题的项目默认展开——主人一眼能看到项目下正在聊的事；
 * - 没主题的项目收起，只留项目名，避免空行占满左栏。
 */
export function buildWorkspaceProjects(input: SidebarWorkspaceInput): SidebarProjectNode[] {
  const explicit = input.expandedProjectIds === undefined ? null : new Set(input.expandedProjectIds)
  return [...input.projects].sort(compareProjects).map((project): SidebarProjectNode => ({
    projectId: project.id,
    name: project.name,
    status: project.status,
    topicCount: project.topics.length,
    topics: [...project.topics],
    expanded: explicit === null ? project.topics.length > 0 : explicit.has(project.id),
    active: input.activeProjectId === project.id,
  }))
}

/** 分组是否展开：只记「被手动收起」的组，其余按默认展开。 */
export function isGroupExpanded(collapsedGroups: readonly SidebarGroupId[], groupId: SidebarGroupId): boolean {
  return !collapsedGroups.includes(groupId)
}

/** 收起/展开一组：返回新数组，不改入参。 */
export function toggleGroup(collapsedGroups: readonly SidebarGroupId[], groupId: SidebarGroupId): SidebarGroupId[] {
  const next = collapsedGroups.filter(item => item !== groupId)
  if (next.length === collapsedGroups.length) next.push(groupId)
  return next
}

/** 新建会话时「这条会话开在哪个项目」：队友行加号只列它所在的项目。 */
export function projectsForBot(projects: readonly SidebarProjectInput[], botId: string): SidebarProjectInput[] {
  return projects.filter(project => project.memberBotIds.includes(botId))
}

/** 滚动提示判定的输入：两个容器的真实溢出事实 + 工作区组是否展开。 */
export interface WorkspaceScrollHintFacts {
  /** 内层 .ah-nav-rows 撞到 360px 限高，列表自身需要滚动。 */
  rowsOverflow: boolean
  /** 外层 .ah-nav-scroll 在矮视口下把工作区内容裁掉了。 */
  outerClip: boolean
  /** 工作区组收起时没有列表可滚，任何溢出都不该报提示。 */
  groupExpanded: boolean
}

/**
 * 工作区要不要显示「列表内滚动」提示（U01 第 43 轮，替代旧的「项目数 > 4」阈值）。
 * 只认真实裁切：内层限高溢出、外层视口裁切，任一发生且组处于展开态才提示。
 * 项目少但视口矮（4 个项目在 620px 高窗口被裁）同样要提示；
 * 项目多但都放得下时不许报假警。几何测量在组件里做，这里只做布尔判定，方便单测。
 */
export function shouldShowWorkspaceScrollHint(facts: WorkspaceScrollHintFacts): boolean {
  if (!facts.groupExpanded) return false
  return facts.rowsOverflow || facts.outerClip
}
