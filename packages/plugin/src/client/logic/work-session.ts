/**
 * 工作会话投影（P33）：把项目任务收成队友主页上的一行「工作」。
 *
 * 为什么单独成文件：队友主页、左栏树与看板以后都要看同一份「谁在做什么」，
 * 如果每个组件自己按任务状态过滤，就会出现主页说 3 件、看板说 4 件。
 * 这里只做只读投影与排序，不写状态、不发命令。
 *
 * 口径（DC17，与 P29 看板一致）：
 * - 工作会话与项目任务同一记录同一 id，不另造工作实体；
 * - doing / blocked 算「在做」，blocked 额外带受阻标记；
 * - done_pending_check / accepted 算「已归档」（工作已经交出去，从在做里消失）；
 * - todo / rejected 还没开工，不算工作会话，仍留在项目待领清单里；
 * - 项目已归档时，它的任务一律沉到已归档，且不能再交账（只读陈列）。
 */
import type { ProjectStatus, ProjectTaskView, ProjectView, ProjectViewRow, TaskStatus } from '../../shared/views.js'

/** 工作会话的两个分区：在做、已归档。 */
export type WorkSessionPhase = 'doing' | 'archived'

/** 一条工作会话：只保留界面需要的字段，id 与项目任务一致。 */
export interface WorkSession {
  id: string
  projectId: string
  projectName: string
  projectStatus: ProjectStatus
  /** 项目已归档：只读陈列，不允许再交账。 */
  projectArchived: boolean
  title: string
  status: TaskStatus
  statusLabel: string
  phase: WorkSessionPhase
  /** 受阻：在「在做」里单独标出来。 */
  blocked: boolean
  /** 待验收：已归档但仍等主人处理。 */
  pendingCheck: boolean
  /** 只有进行中可以交账；受阻要先恢复，待验收/已通过不能再交。 */
  canComplete: boolean
  assigneeBotId: string
  /** 最近一条可下钻的唤醒；没有就 null。 */
  latestWakeId: string | null
  createdAt: number
  /** 最后变动时间：分区内按它倒序，最近有进展的排在前面。 */
  updatedAt: number
}

/** 一个项目下的工作会话（队友主页的母子结构：项目是母，会话是子）。 */
export interface WorkSessionGroup {
  projectId: string
  projectName: string
  projectStatus: ProjectStatus
  archived: boolean
  /** 组内最近变动时间：组排序按它倒序。 */
  updatedAt: number
  sessions: WorkSession[]
}

/** 队友主页摘要的数字。 */
export interface WorkSessionSummary {
  doing: number
  blocked: number
  archived: number
  pendingCheck: number
  total: number
}

/** 项目状态排序：进行中在前，归档沉底（与团队树、项目页同一顺序）。 */
const PROJECT_STATUS_RANK: Record<ProjectStatus, number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
}

/**
 * 任务状态落到哪个分区；null 表示还不是工作会话。
 * 注意：项目归档的转换在 toWorkSession 里做，这里只看任务本身。
 */
export function phaseOf(status: TaskStatus): WorkSessionPhase | null {
  if (status === 'doing' || status === 'blocked') return 'doing'
  if (status === 'done_pending_check' || status === 'accepted') return 'archived'
  return null
}

/** 能否交账：只有进行中可以；受阻要先恢复，避免把卡住的事直接算完成。 */
export function canCompleteWorkSession(status: TaskStatus, projectStatus: ProjectStatus): boolean {
  return status === 'doing' && projectStatus !== 'archived'
}

/** 最近一条唤醒链接：取记录里最后一条能打开账本的（队友被删的旧链接跳过）。 */
function latestWakeIdOf(task: ProjectTaskView): string | null {
  for (let i = task.wakes.length - 1; i >= 0; i -= 1) {
    const wake = task.wakes[i]!
    if (wake.botId !== null) return wake.wakeId
  }
  return null
}

/**
 * 把一条任务展开行投影成工作会话；未开工（todo/rejected）或还没指派的返回 null。
 * 未指派的任务不属于任何队友的主页，等领走后才出现（P35 的待领清单）。
 */
export function toWorkSession(row: ProjectViewRow, task: ProjectTaskView): WorkSession | null {
  const assigneeBotId = task.task.assigneeBotId
  if (assigneeBotId === null) return null
  const basePhase = phaseOf(task.task.status)
  if (basePhase === null) return null
  const projectArchived = row.project.status === 'archived'
  const phase: WorkSessionPhase = projectArchived ? 'archived' : basePhase
  return {
    id: task.task.id,
    projectId: row.project.id,
    projectName: row.project.name,
    projectStatus: row.project.status,
    projectArchived,
    title: task.task.title,
    status: task.task.status,
    statusLabel: task.statusLabel,
    phase,
    blocked: phase === 'doing' && task.task.status === 'blocked',
    pendingCheck: phase === 'archived' && task.task.status === 'done_pending_check',
    canComplete: canCompleteWorkSession(task.task.status, row.project.status),
    assigneeBotId,
    latestWakeId: latestWakeIdOf(task),
    createdAt: task.task.createdAt,
    updatedAt: task.task.updatedAt,
  }
}

/** 摊平整份项目视图：所有可展示的工作会话（不限队友，由调用方再按 bot 过滤）。 */
export function collectWorkSessions(view: ProjectView): WorkSession[] {
  const out: WorkSession[] = []
  for (const row of view.projects) {
    for (const task of row.tasks) {
      const session = toWorkSession(row, task)
      if (session !== null) out.push(session)
    }
  }
  return out
}

/** 按队友过滤：主页只看自己的活；不修改入参数组。 */
export function sessionsForBot(sessions: readonly WorkSession[], botId: string): WorkSession[] {
  return sessions.filter(session => session.assigneeBotId === botId)
}

/** 会话排序：最近变动的在前；时间相同按 id 兜底，保证刷新不跳位。 */
function compareSessions(a: WorkSession, b: WorkSession): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 组排序：项目状态 → 组内最近变动 → 项目名 → id，同一份输入永远同一顺序。 */
function compareGroups(a: WorkSessionGroup, b: WorkSessionGroup): number {
  const rank = PROJECT_STATUS_RANK[a.projectStatus] - PROJECT_STATUS_RANK[b.projectStatus]
  if (rank !== 0) return rank
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  const byName = a.projectName.localeCompare(b.projectName, 'zh-Hans-CN')
  if (byName !== 0) return byName
  return a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0
}

/**
 * 按项目分组成母子结构：同一项目只出现一次，组内按最近变动倒序。
 * 传入的会话应已经过滤到某个分区（在做或已归档）。
 */
export function groupSessionsByProject(sessions: readonly WorkSession[]): WorkSessionGroup[] {
  const groups = new Map<string, WorkSessionGroup>()
  for (const session of sessions) {
    const existing = groups.get(session.projectId)
    if (existing === undefined) {
      groups.set(session.projectId, {
        projectId: session.projectId,
        projectName: session.projectName,
        projectStatus: session.projectStatus,
        archived: session.projectArchived,
        updatedAt: session.updatedAt,
        sessions: [session],
      })
      continue
    }
    existing.sessions.push(session)
    if (session.updatedAt > existing.updatedAt) existing.updatedAt = session.updatedAt
  }
  const out = [...groups.values()]
  for (const group of out) group.sessions.sort(compareSessions)
  out.sort(compareGroups)
  return out
}

/** 摘要数字：在做、受阻、已归档、待验收与总数。 */
export function summarizeWorkSessions(sessions: readonly WorkSession[]): WorkSessionSummary {
  let doing = 0
  let blocked = 0
  let archived = 0
  let pendingCheck = 0
  for (const session of sessions) {
    if (session.phase === 'doing') {
      doing += 1
      if (session.blocked) blocked += 1
    } else {
      archived += 1
      if (session.pendingCheck) pendingCheck += 1
    }
  }
  return { doing, blocked, archived, pendingCheck, total: doing + archived }
}
