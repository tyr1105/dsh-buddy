/**
 * 看板数据源（P35）：把 core 的项目视图投影成 P29 看板要的条目，并规定每张卡片
 * 在看板里能发起哪些动作。
 *
 * 为什么单独成文件：项目页与队友主页都要画同一块四列看板，但「看哪些任务」不同——
 * - 项目页看板：全部未归档项目的任务（归档项目只读陈列，不进看板）；
 * - 队友主页看板：这个队友名下的任务 + 它所在进行中项目里还没被领走的待领事项。
 * 如果各页面自己过滤，就会出现列表说 3 件、看板说 4 件。这里只做只读投影与动作表，
 * 状态流转仍由 core 的命令执行，看板不本地改状态。
 *
 * 口径（DC17，与 P29 work-board、P33 work-session 一致）：
 * - todo / rejected → 待领；doing → 在做；blocked → 在做并标受阻；
 * - done_pending_check → 等你；accepted → 已完成；
 * - 归档项目不进入项目页看板；队友看板保留自己名下的归档任务，和「已归档」列表一致。
 */
import type {
  ProjectStatus, ProjectTaskView, ProjectView, ProjectViewRow, TaskStatus,
} from '../../shared/views.js'
import type { WorkBoardItemInput } from './work-board.js'

/** 看板所在的页面：决定卡片能出现哪些动作。 */
export type WorkBoardScope = 'project' | 'teammate'

/** 看板卡片可发起的动作；「放回待领」core 没有命令，workBoardMove 直接判该拖拽方向非法。 */
export type WorkBoardActionKind = 'claim' | 'submit' | 'reassign' | 'accept' | 'reject'

/** 一条任务是否属于「待领」：还没开工，谁领走谁负责。 */
export function isOpenTaskStatus(status: TaskStatus): boolean {
  return status === 'todo' || status === 'rejected'
}

/** 把一条任务展开行翻译成看板条目；项目名与负责人名字都取自视图，不反查。 */
function toItem(row: ProjectViewRow, task: ProjectTaskView, projectArchived: boolean): WorkBoardItemInput {
  return {
    id: task.task.id,
    title: task.task.title,
    projectId: row.project.id,
    projectName: row.project.name,
    status: task.task.status,
    ownerBotId: task.task.assigneeBotId,
    ownerName: task.assigneeBotName,
    createdAt: task.task.createdAt,
    updatedAt: task.task.updatedAt,
    projectArchived,
  }
}

/**
 * 项目页看板：全部项目（含归档）的任务都投影出来，归档项目由 P29 的可见性规则过滤。
 * 这样列表里的任务数就是看板 total 的上界，不会出现「列表有、看板找不到」。
 */
export function projectBoardItems(view: ProjectView): WorkBoardItemInput[] {
  const items: WorkBoardItemInput[] = []
  for (const row of view.projects) {
    const archived = row.project.status === 'archived'
    for (const task of row.tasks) items.push(toItem(row, task, archived))
  }
  return items
}

/**
 * 队友主页看板：
 * - 自己名下的任务（任何状态）都进来，和主页「在做 / 已归档」是同一份记录；
 * - 所属「进行中」项目里还没被领走的待领事项也进来（todo/rejected 且无指派），
 *   这是「待领清单」；领取会走 dispatchTask，core 只接受进行中项目，所以暂停/完成
 *   项目里的待领事项不列，避免给出注定失败的领取入口；
 * - 别人名下的任务一律不进来，避免把别人的活算到这个队友头上。
 */
export function teammateBoardItems(view: ProjectView, botId: string): WorkBoardItemInput[] {
  const claimableProjectIds = new Set(
    view.projects
      .filter(row => row.project.status === 'active' && row.project.memberBotIds.includes(botId))
      .map(row => row.project.id),
  )
  const items: WorkBoardItemInput[] = []
  for (const row of view.projects) {
    for (const task of row.tasks) {
      const mine = task.task.assigneeBotId === botId
      const claimable = task.task.assigneeBotId === null
        && isOpenTaskStatus(task.task.status)
        && claimableProjectIds.has(row.project.id)
      if (!mine && !claimable) continue
      // 队友看板刻意不传 projectArchived：归档项目里自己的活仍要在「已完成」列可见，
      // 与主页「已归档」列表同一份记录；这些卡片不会给任何写动作（见 boardCardActions）。
      items.push(toItem(row, task, false))
    }
  }
  return items
}

/**
 * 卡片动作表（纯函数）：
 * - 待领：项目进行中才能领取（core dispatchTask 只接受进行中项目）；
 * - 在做：可以交账（reportDone），项目页还可改派；受阻不能直接交账，core 也会拒；
 * - 等你：项目页可验收通过 / 驳回（驳回另要理由，页面弹框收集）；
 * - 已完成与归档项目：不给任何写动作。
 * 队友主页只给自己的活「交账」与「领取」，验收留给项目页统一处理。
 */
export function boardCardActions(
  status: TaskStatus,
  projectStatus: ProjectStatus,
  scope: WorkBoardScope,
): WorkBoardActionKind[] {
  if (projectStatus === 'archived') return []
  switch (status) {
    case 'todo':
    case 'rejected':
      return projectStatus === 'active' ? ['claim'] : []
    case 'doing': {
      const actions: WorkBoardActionKind[] = ['submit']
      if (scope === 'project') actions.push('reassign')
      return actions
    }
    case 'done_pending_check':
      return scope === 'project' ? ['accept', 'reject'] : []
    case 'accepted':
    case 'blocked':
      return []
  }
}

/** 卡片动作的中文按钮文案：集中一处，两个页面不用各写一套。 */
export const BOARD_ACTION_LABEL: Record<WorkBoardActionKind, string> = {
  claim: '领取',
  submit: '交账',
  reassign: '改派',
  accept: '验收通过',
  reject: '驳回',
}

/**
 * 卡片能不能拖（U01 第 35 轮，WCAG 2.5.1 指针手势）：
 * 必须「不忙碌、不是终态、没有受阻」并且至少存在一个按钮等价动作。这样每个拖得动的
 * 落点都有同名按钮走得通——暂停或已完成项目里的待领卡（core 会拒收 claim）、队友
 * 主页的待验收卡（验收按钮只在项目页）都拿不到拖拽入口，拖拽不成为「键盘用户没有、
 * 鼠标用户也注定失败」的死路。判定抽成纯函数，契约可被单元测试逐张夹具卡锁定。
 */
export function boardCardDraggable(input: {
  status: TaskStatus
  blocked: boolean
  actions: readonly WorkBoardActionKind[]
  busy: boolean
}): boolean {
  return !input.busy && input.status !== 'accepted' && !input.blocked && input.actions.length > 0
}
