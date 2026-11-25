/**
 * 项目页纯逻辑（P60，决策 DC35）：主人说项目看板「不知所云」，于是只留四块：
 * 有哪些队友、当前事务清单、项目背景、项目文件路径。
 *
 * 这个文件把 core 的项目视图翻译成这四块要的行和文案，再管项目状态能做哪些动作。
 * 能不能流转、负责人合不合规最终都由 core 判定，这里不复制规则，
 * 只决定「显示什么」和「按钮给不给」；表单校验和命令入参在 project-form.ts。
 */
import type {
  Lifecycle, ProjectBackgroundView, ProjectPathView, ProjectStatus, ProjectView, ProjectViewRow, Role,
} from '../../shared/views.js'
import { isArchivedBot } from './lifecycle.js'

/** 一个项目都没有时的说明。 */
export const PROJECT_EMPTY_TEXT = '还没有项目。点「＋ 新项目」，起个名字，把员工拉进来。'
/** 项目背景还是空的时候的说法。 */
export const PROJECT_BACKGROUND_EMPTY_TEXT = '还没有项目背景。负责人会随项目推进写在这里，也可以点「编辑」先写几句。'
/** 事务清单还是空的时候的说法。 */
export const PROJECT_TASKS_EMPTY_TEXT = '还没有事务。新开一条会话说说诉求，负责人会把要做的事列在这里。'
/** 成员名单还是空的时候的说法。 */
export const PROJECT_MEMBERS_EMPTY_TEXT = '还没有员工。点「编辑」把员工拉进来，并选一位负责人。'

/** 项目名列表的一行：从跳转面板进来、还没选项目时用。 */
export interface ProjectPickRow {
  id: string
  name: string
  statusLabel: string
}

/** 项目名列表。顺序沿用 core 给的：未归档在前，归档沉底。 */
export function projectPickRows(view: ProjectView): ProjectPickRow[] {
  return view.projects.map(row => ({ id: row.project.id, name: row.project.name, statusLabel: row.statusLabel }))
}

/** 「有哪些队友」的一行。 */
export interface ProjectMemberRow {
  botId: string
  name: string
  /** 执行风格；队友查不到时为 null。 */
  roleLabel: string | null
  isOwner: boolean
  /** 队友已删除或退役：名字标灰，提示主人换人。 */
  invalid: boolean
}

/** 成员名单：负责人排第一，其余保持项目里的顺序；失效的队友给固定说法，不露内部 id。 */
export function projectMemberRows(row: ProjectViewRow): ProjectMemberRow[] {
  const rows = row.members.map((member): ProjectMemberRow => ({
    botId: member.botId,
    name: member.invalid || member.name === null ? '员工已删除或归档' : member.name,
    roleLabel: member.invalid ? null : member.roleLabel,
    isOwner: member.isOwner,
    invalid: member.invalid,
  }))
  return [...rows.filter(item => item.isOwner), ...rows.filter(item => !item.isOwner)]
}

/** 「当前事务清单」的一行。只读：状态由负责人在主题里维护。 */
export interface ProjectTaskRow {
  id: string
  title: string
  /** 谁在跟进；还没人接时写「待安排」。 */
  assignee: string
  statusLabel: string
  /** 这件事所在的主题；有就能点进去。 */
  topicId: string | null
}

/** 事务清单：顺序沿用 core 给的（进行中和受阻在前，结束的沉底）。 */
export function projectTaskRows(row: ProjectViewRow): ProjectTaskRow[] {
  return row.tasks.map(item => ({
    id: item.task.id,
    title: item.title,
    assignee: item.assigneeName ?? '待安排',
    statusLabel: item.statusLabel,
    topicId: item.topicId,
  }))
}

/** 背景下面那一行小字：谁、什么时候更新的。从没记录过时返回 null，不编造。 */
export function backgroundMetaText(background: ProjectBackgroundView): string | null {
  if (background.updatedByName === null || background.updatedText === null) return null
  return `${background.updatedByName} 更新于 ${background.updatedText}`
}

/** 「项目文件路径」的一行。 */
export interface ProjectPathRow {
  label: string
  /** 完整路径：只给复制按钮和悬停提示用，不铺在正文里。 */
  value: string
  /** 正文显示：目录名加结尾 `/`；没设置时是「未设置」。 */
  display: string
  /** 悬停提示=完整路径；没设置时不挂提示。 */
  title?: string
}

/**
 * 把完整路径收成人话（U05）：正文只留最后一段目录名并补结尾 `/`，
 * 完整路径放进 title；纯空白算「未设置」，根路径照实显示 `/`。
 * 兼容 `/` 与 `\` 两种分隔符，结尾多写的分隔符先忽略。
 */
export function workspaceDirDisplay(fullPath: string): { display: string; title?: string } {
  const trimmed = fullPath.trim()
  if (trimmed === '') return { display: '未设置' }
  const withoutTrailing = trimmed.replace(/[\\/]+$/, '')
  const parts = withoutTrailing.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  // 根路径（`/` 或 `\`）没有目录名，照实显示，不伪装成「未设置」。
  if (last === '') return { display: trimmed, title: trimmed }
  return { display: `${last}/`, title: trimmed }
}

/** 文件路径：工作目录和共享目录现在是同一个，相同时只列一行，免得看起来像两个地方。 */
export function projectPathRows(path: ProjectPathView): ProjectPathRow[] {
  const rows = path.workspaceDir === path.sharedDir
    ? [{ label: '项目目录', value: path.workspaceDir }]
    : [{ label: '工作目录', value: path.workspaceDir }, { label: '共享目录', value: path.sharedDir }]
  return rows.map(row => ({ ...row, ...workspaceDirDisplay(row.value) }))
}

/** 编辑弹窗底部的项目状态动作：命令和成功提示都在这里，页面照表画按钮。 */
export interface ProjectStatusAction {
  label: string
  command: 'pauseProject' | 'resumeProject' | 'completeProject'
  okText: string
}

const PAUSE: ProjectStatusAction = { label: '暂停', command: 'pauseProject', okText: '已暂停。下一步：恢复，负责人 待安排。' }
const RESUME: ProjectStatusAction = { label: '恢复', command: 'resumeProject', okText: '已恢复。下一步：待安排。' }
const COMPLETE: ProjectStatusAction = { label: '完成', command: 'completeProject', okText: '已完成。下一步：归档，负责人 待安排。' }

/** 按项目状态给动作：归档走二次确认，单独处理，不在这张表里。 */
export function projectStatusActions(status: ProjectStatus): ProjectStatusAction[] {
  if (status === 'active') return [PAUSE, COMPLETE]
  if (status === 'paused') return [RESUME, COMPLETE]
  return []
}

/** 能不能编辑、改状态：归档项目只读（core 对归档项目拒绝全部写命令）。 */
export function canManageProject(status: ProjectStatus): boolean {
  return status !== 'archived'
}

/** 只有进行中的项目能新开会话（core 同样拒绝其余状态）。 */
export function canOpenTopic(status: ProjectStatus): boolean {
  return status === 'active'
}

/** 编辑表单里一个可选的队友：role 决定能不能当负责人。 */
export interface BotOption {
  botId: string
  name: string
  lifecycle: Lifecycle
  role: Role | null
}

/**
 * 成员和负责人的候选：总览里没退役的队友，再加上项目里出现、总览里还没有的有效成员
 * （总览没加载完或比项目视图晚一拍时，保存不会把这些成员弄丢）。
 * 退役的队友永远不进候选，core 也不收。
 */
export function botOptions(
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle; role: Role }>,
  view: ProjectView | null,
): BotOption[] {
  const byId = new Map<string, BotOption>()
  const retired = new Set<string>()
  for (const bot of bots) {
    if (isArchivedBot(bot)) retired.add(bot.id)
    else byId.set(bot.id, { botId: bot.id, name: bot.name, lifecycle: bot.lifecycle, role: bot.role })
  }
  for (const row of view?.projects ?? []) {
    for (const member of row.members) {
      if (member.invalid || member.name === null || retired.has(member.botId) || byId.has(member.botId)) continue
      byId.set(member.botId, { botId: member.botId, name: member.name, lifecycle: 'active', role: member.role })
    }
  }
  return [...byId.values()]
}

/**
 * W7a：项目挂接的工作文件夹（主人电脑上已有的文件夹或代码仓库，成员只读）。
 * 没挂接时 value 为空、显示「未挂接」；挂了显示目录名，完整路径进悬停提示、可复制。
 */
export const WORK_FOLDER_LABEL = '工作文件夹（只读）'
export const WORK_FOLDER_EMPTY_TEXT = '未挂接。挂接后，项目成员能读这个文件夹（含代码仓库），不能改。'
export function workFolderRow(folder: { path: string } | null | undefined): ProjectPathRow | null {
  if (folder == null) return null
  return { label: WORK_FOLDER_LABEL, value: folder.path, ...workspaceDirDisplay(folder.path) }
}
/** 挂接前的确认话：说清谁能读、读不到什么、不能做什么。 */
export function workFolderConfirmText(projectName: string, path: string): string {
  return `挂接后，「${projectName}」的成员可以读 ${path} 里的文件（.env、密钥这类凭据文件除外），不能新建、修改或删除里面的任何东西。不是这个项目的员工要读，会先问你。随时可以更换或取消。`
}
export function workFolderDetachText(projectName: string, path: string): string {
  return `取消后，「${projectName}」的成员不再在资料里看到 ${path}，文件夹本身不受影响。`
}
