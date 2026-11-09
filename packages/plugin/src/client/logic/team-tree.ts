/**
 * 团队空间左栏树的纯逻辑（P28）：办公室 → 队友 → 工作区。
 *
 * 为什么单独成文件：左栏是团队空间的导航骨架，展开状态、排序、待领数量
 * 一旦散落在组件里，队友一多就会出现顺序漂移、加号跑到奇怪的位置。
 * 这里只接收只读子集，输出稳定的树节点；组件只负责画，不自己决定顺序。
 *
 * 纪律：
 * - 办公室永远第一，且不参与队友排序；
 * - 队友按「退役沉底 → 最近活动倒序 → 名字 → id」稳定排序，同一份输入永远同一棵树；
 * - 项目只挂在它是成员的项目下，不额外造项目实体；
 * - 新建队友加号的位置写在分组元数据里，组件不写死。
 */
import type { Activity, Lifecycle, ProjectStatus } from '../../shared/views.js'

/** 队友树上需要的最小字段，来自 OverviewView.bots；不直接依赖整个视图。 */
export interface TeamTreeBotInput {
  id: string
  name: string
  color: string
  initials: string
  lifecycle: Lifecycle
  activity: Activity
  unread: number
  waitingOwner: boolean
  /** 最近一次活动时间；没有记录给 null，排序时沉到有记录的人后面。 */
  lastActiveAt: number | null
}

/** 项目树上需要的最小字段；成员用队友 id，编制移除后不再有席位概念。 */
export interface TeamTreeProjectInput {
  id: string
  name: string
  status: ProjectStatus
  memberBotIds: readonly string[]
  /** 待领（todo/rejected）任务数，由调用方按 P29 的口径算好。 */
  openTaskCount: number
  /** 在做（doing/blocked）任务数。 */
  doingTaskCount: number
}

/** 办公室节点只放汇总数字，不复制办公室投影。 */
export interface TeamTreeOfficeInput {
  workingCount: number
  waitingCount: number
  blockedCount: number
}

export interface TeamTreeInput {
  office: TeamTreeOfficeInput
  bots: readonly TeamTreeBotInput[]
  projects: readonly TeamTreeProjectInput[]
  /** 已展开的队友；不传表示全部展开（与 Demo 的默认一致）。 */
  expandedBotIds?: readonly string[]
  /** 已展开的项目；不传表示全部收起。 */
  expandedProjectIds?: readonly string[]
  /** 当前选中的节点，用来画高亮。 */
  active?: { kind: 'office' | 'bot' | 'project'; id: string } | null
}

export interface TeamTreeProjectNode {
  kind: 'project'
  projectId: string
  name: string
  openCount: number
  doingCount: number
  archived: boolean
  expanded: boolean
  active: boolean
}

export interface TeamTreeBotNode {
  kind: 'bot'
  botId: string
  name: string
  color: string
  initials: string
  lifecycle: Lifecycle
  activity: Activity
  unread: number
  waitingOwner: boolean
  expanded: boolean
  active: boolean
  projects: TeamTreeProjectNode[]
  archivedProjects: TeamTreeProjectNode[]
}

export interface TeamTreeOfficeNode extends TeamTreeOfficeInput {
  kind: 'office'
  name: '办公室'
  active: boolean
}

/** 新建队友加号的位置：常驻「队友」分组标题右侧，由分组元数据给出。 */
export interface TeamTreeAddBotAction {
  groupId: 'teammates'
  anchor: 'group-header'
  label: '新建队友'
}

export interface TeamTreeGroup {
  id: 'teammates'
  title: '队友'
  addBot: TeamTreeAddBotAction
  bots: TeamTreeBotNode[]
}

export interface TeamTree {
  office: TeamTreeOfficeNode
  teammateGroup: TeamTreeGroup
}

export const TEAM_TREE_ADD_BOT: TeamTreeAddBotAction = {
  groupId: 'teammates',
  anchor: 'group-header',
  label: '新建队友',
}

/** 项目状态排序：进行中在前，归档沉底；同状态再按名字。 */
const PROJECT_STATUS_RANK: Record<ProjectStatus, number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
}

/**
 * 队友排序：
 * 1. 退役的沉底（还在名单里，但不该抢视线）；
 * 2. 最近有活动的在前；
 * 3. 名字按中文习惯比较；
 * 4. id 兜底，保证完全同名的队友也有稳定顺序。
 */
function compareBots(a: TeamTreeBotInput, b: TeamTreeBotInput): number {
  const aRetired = a.lifecycle === 'retired' ? 1 : 0
  const bRetired = b.lifecycle === 'retired' ? 1 : 0
  if (aRetired !== bRetired) return aRetired - bRetired
  if (a.lastActiveAt !== b.lastActiveAt) {
    if (a.lastActiveAt === null) return 1
    if (b.lastActiveAt === null) return -1
    return b.lastActiveAt - a.lastActiveAt
  }
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN')
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 项目排序：状态 → 名字 → id，保证同一队友下的工作区顺序不漂移。 */
function compareProjects(a: TeamTreeProjectInput, b: TeamTreeProjectInput): number {
  const rank = PROJECT_STATUS_RANK[a.status] - PROJECT_STATUS_RANK[b.status]
  if (rank !== 0) return rank
  const byName = a.name.localeCompare(b.name, 'zh-Hans-CN')
  if (byName !== 0) return byName
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 展开集合转查表；顺带去重，避免调用方传重复 id 让计数虚高。 */
function expandedSet(ids: readonly string[] | undefined, defaultExpanded: boolean, allIds: readonly string[]): Set<string> {
  if (ids === undefined) return new Set(defaultExpanded ? allIds : [])
  return new Set(ids)
}

function buildProjectNode(
  project: TeamTreeProjectInput,
  expanded: Set<string>,
  active: TeamTreeInput['active'],
): TeamTreeProjectNode {
  return {
    kind: 'project',
    projectId: project.id,
    name: project.name,
    openCount: project.openTaskCount,
    doingCount: project.doingTaskCount,
    archived: project.status === 'archived',
    expanded: expanded.has(project.id),
    active: active?.kind === 'project' && active.id === project.id,
  }
}

/** 构建整棵树；这是组件唯一需要的入口。 */
export function buildTeamTree(input: TeamTreeInput): TeamTree {
  const botIds = input.bots.map(bot => bot.id)
  const botExpanded = expandedSet(input.expandedBotIds, true, botIds)
  const projectExpanded = expandedSet(input.expandedProjectIds, false, [])

  const bots = [...input.bots].sort(compareBots).map((bot): TeamTreeBotNode => {
    const own = input.projects
      .filter(project => project.memberBotIds.includes(bot.id))
      .sort(compareProjects)
    const projects: TeamTreeProjectNode[] = []
    const archivedProjects: TeamTreeProjectNode[] = []
    for (const project of own) {
      const node = buildProjectNode(project, projectExpanded, input.active)
      if (node.archived) archivedProjects.push(node)
      else projects.push(node)
    }
    return {
      kind: 'bot',
      botId: bot.id,
      name: bot.name,
      color: bot.color,
      initials: bot.initials,
      lifecycle: bot.lifecycle,
      activity: bot.activity,
      unread: bot.unread,
      waitingOwner: bot.waitingOwner,
      expanded: botExpanded.has(bot.id),
      active: input.active?.kind === 'bot' && input.active.id === bot.id,
      projects,
      archivedProjects,
    }
  })

  return {
    office: {
      kind: 'office',
      name: '办公室',
      workingCount: input.office.workingCount,
      waitingCount: input.office.waitingCount,
      blockedCount: input.office.blockedCount,
      active: input.active?.kind === 'office',
    },
    teammateGroup: {
      id: 'teammates',
      title: '队友',
      addBot: TEAM_TREE_ADD_BOT,
      bots,
    },
  }
}

/** 收起/展开一个节点：返回新数组，不改入参；已存在就移除。 */
export function toggleExpanded(expandedIds: readonly string[], id: string): string[] {
  const next = expandedIds.filter(item => item !== id)
  if (next.length === expandedIds.length) next.push(id)
  return next
}

/** 某个节点当前是否展开；默认策略与 buildTeamTree 保持一致。 */
export function isExpanded(expandedIds: readonly string[] | undefined, id: string, defaultExpanded: boolean): boolean {
  if (expandedIds === undefined) return defaultExpanded
  return expandedIds.includes(id)
}
