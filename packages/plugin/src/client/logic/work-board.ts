/**
 * 工作看板的纯逻辑（P29）：把同一份任务记录映射成四列，并规定列内顺序与移动合法性。
 *
 * 为什么单独成文件：看板不能自己编状态，也不能和列表各存一份数据。
 * 这里只做「状态 → 列」的翻译、稳定排序和拖拽合法性判断；
 * 真正的状态流转仍由 core 的命令执行，界面只负责把命令发出去。
 *
 * 状态口径按 DC17：
 * - todo / rejected → 待领；
 * - doing → 在做；
 * - blocked → 在做，并带受阻标记；
 * - done_pending_check → 等你；
 * - accepted → 已完成。
 */
import type { TaskStatus } from '../../shared/views.js'

export type WorkBoardColumnId = 'open' | 'doing' | 'waiting' | 'done'

export interface WorkBoardColumnMeta {
  id: WorkBoardColumnId
  label: string
  emptyText: string
}

/** 四列的固定顺序与空列文案：界面不另写一套，避免两个页面说法不一致。 */
export const WORK_BOARD_COLUMNS: readonly WorkBoardColumnMeta[] = [
  { id: 'open', label: '待领', emptyText: '暂无待领任务。在项目中新建任务后在此显示。' },
  { id: 'doing', label: '在做', emptyText: '暂无进行中任务。领取待领任务后在此显示。' },
  { id: 'waiting', label: '待确认', emptyText: '暂无待确认事项。队友交账后在此显示。' },
  { id: 'done', label: '已完成', emptyText: '暂无已完成事项。验收通过后在此显示。' },
]

/** 看板需要的最小任务字段，来自 ProjectTaskView；不依赖整个视图。 */
export interface WorkBoardItemInput {
  id: string
  title: string
  projectId: string
  projectName: string
  status: TaskStatus
  ownerBotId: string | null
  ownerName: string | null
  ownerColor?: string | null
  createdAt: number
  updatedAt: number
  /** 所属项目已归档时整条不进入看板，避免归档项目继续占列。 */
  projectArchived?: boolean
  /** 任务已删除（软删）时整条不进入看板。 */
  deleted?: boolean
}

export interface WorkBoardCard {
  id: string
  title: string
  projectId: string
  projectName: string
  ownerBotId: string | null
  ownerName: string | null
  ownerColor: string | null
  status: TaskStatus
  blocked: boolean
  createdAt: number
  updatedAt: number
}

export interface WorkBoardColumn extends WorkBoardColumnMeta {
  cards: WorkBoardCard[]
}

export interface WorkBoard {
  columns: WorkBoardColumn[]
  total: number
}

/** 状态 → 列；rejected 是瞬时结论值，和 todo 一样回到待领。 */
export function workBoardColumnOf(status: TaskStatus): WorkBoardColumnId {
  switch (status) {
    case 'todo':
    case 'rejected': return 'open'
    case 'doing':
    case 'blocked': return 'doing'
    case 'done_pending_check': return 'waiting'
    case 'accepted': return 'done'
  }
}

/** 受阻只在 blocked 状态为真；界面据此画警示标记，不改列。 */
export function isWorkBlocked(status: TaskStatus): boolean {
  return status === 'blocked'
}

/** 归档项目与已删除任务不进入看板；两者都是「不该继续被看见」，但原因不同。 */
function isVisible(item: WorkBoardItemInput): boolean {
  return item.projectArchived !== true && item.deleted !== true
}

function toCard(item: WorkBoardItemInput): WorkBoardCard {
  return {
    id: item.id,
    title: item.title,
    projectId: item.projectId,
    projectName: item.projectName,
    ownerBotId: item.ownerBotId,
    ownerName: item.ownerName,
    ownerColor: item.ownerColor ?? null,
    status: item.status,
    blocked: isWorkBlocked(item.status),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * 列内排序：
 * - 待领：最早创建的在上，等得最久的最先被看见；
 * - 在做：受阻的置顶，其余按最近更新倒序，让刚动过的最先被看见；
 * - 等你：最早进入待验收的在上，避免主人漏掉拖得最久的；
 * - 已完成：最近完成的在上。
 * 所有分支最后都用 id 兜底，保证同一时间戳也有稳定顺序。
 */
function compareCards(column: WorkBoardColumnId, a: WorkBoardCard, b: WorkBoardCard): number {
  if (column === 'open') {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  } else if (column === 'doing') {
    if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  } else if (column === 'waiting') {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt
  } else if (a.updatedAt !== b.updatedAt) {
    return b.updatedAt - a.updatedAt
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 构建四列看板；空列也保留，界面才能画出固定骨架。 */
export function buildWorkBoard(items: readonly WorkBoardItemInput[]): WorkBoard {
  const columns = WORK_BOARD_COLUMNS.map((meta): WorkBoardColumn => ({
    ...meta,
    cards: [],
  }))
  const byId = new Map(columns.map(column => [column.id, column]))

  for (const item of items) {
    if (!isVisible(item)) continue
    const columnId = workBoardColumnOf(item.status)
    byId.get(columnId)?.cards.push(toCard(item))
  }

  for (const column of columns) {
    column.cards.sort((a, b) => compareCards(column.id, a, b))
  }

  return {
    columns,
    total: columns.reduce((sum, column) => sum + column.cards.length, 0),
  }
}

/** 拖拽能发出的命令；界面不直接改状态，只把命令交给 core。
 *  不含「放回待领」：core 没有 release 命令，进行中的任务不能退回待办，
 *  该方向在下面直接判非法并给出替代路径，保证按钮与拖拽能力完全等价（WCAG 2.5.1）。 */
export type WorkBoardCommand = 'claim' | 'submit' | 'accept' | 'reject'

export type WorkBoardMoveResult =
  | { ok: true; command: WorkBoardCommand }
  | { ok: false; reason: string }

/**
 * 跨列移动合法性：
 * - 待领 → 在做：领走（claim）；
 * - 在做 → 等你：交活（submit）；受阻时先解决受阻，不允许交活；
 * - 等你 → 已完成：验收通过（accept）；
 * - 等你 → 在做：驳回（reject）；
 * - 其余方向都不合法，尤其 accepted 是终态，不能拖回去；
 *   在做 → 待领也不合法：core 无「放回」命令，只能改派、标记受阻或交账。
 * 同列移动返回不合法（没有命令可发），避免界面把无操作当成成功。
 */
export function workBoardMove(status: TaskStatus, to: WorkBoardColumnId): WorkBoardMoveResult {
  const from = workBoardColumnOf(status)
  if (from === to) return { ok: false, reason: '已经在目标列，不需要移动' }

  if (from === 'open' && to === 'doing') return { ok: true, command: 'claim' }
  if (from === 'doing' && to === 'waiting') {
    if (status === 'blocked') return { ok: false, reason: '这条还处于受阻状态，先解除受阻再交活' }
    return { ok: true, command: 'submit' }
  }
  // U01 第 35 轮（WCAG 2.5.1）：原先这里返回假合法的 release，页面落列时只能再报错，
  // 且没有任何按钮等价物，键盘用户走不通、鼠标用户拿到死路。直接判非法并给出真实替代。
  if (from === 'doing' && to === 'open') {
    return { ok: false, reason: '进行中的事不能直接退回待领：可以改派给别的队友，或交账等主人验收' }
  }
  if (from === 'waiting' && to === 'done') return { ok: true, command: 'accept' }
  if (from === 'waiting' && to === 'doing') return { ok: true, command: 'reject' }

  if (from === 'done') return { ok: false, reason: '已完成的条目是终态，不能拖回其他列' }
  if (to === 'waiting') return { ok: false, reason: '只有正在做的条目才能交给主人验收' }
  if (to === 'done') return { ok: false, reason: '仅「待验收」条目可标记完成' }
  return { ok: false, reason: '这个移动方向不允许' }
}
