/**
 * 项目页纯逻辑（V2-PH4-02）：把 core 的 ProjectView 翻译成页面直接用的分区、任务分组、
 * 动作表与队友选项——活跃/暂停/完成/归档四分区、任务状态分组（口径对齐 core 的
 * TASK_SORT_GROUP 但不 import core 运行时）、每个任务状态能发起哪些动作、失效队友如何
 * 点名。项目/任务/驳回三类表单的前置校验与命令入参拼装在 project-form.ts。
 *
 * 边界纪律与资料页一致：
 * - 能不能流转、驳回理由在状态机上是否合法、队友是否存在、负责人是否成员，最终都由
 *   core 判定；前端只拦「选了已失效队友」这类不用查数据就能发现的展示问题，
 *   core 的中文报错仍在提交时兜底。
 * - 状态中文标签一律用视图行里的 statusLabel，前端不自行翻译枚举。
 * - 派活统一走 core dispatchTask（V2-PH4-04）：todo 派活、blocked 恢复并派活、
 *   rejected 重新派活、doing 同队友催办/换人改派，全部先开对话框选队友、可附留言。
 *   项目非 active 时不出现任何派活类入口（core 也会拒，UI 不给注定失败的按钮）；
 *   队友是否在岗且是项目成员、议程是否超限仍由 core 兜底。
 * - 归档恢复（restoreProject）是 F08 尾巴补的命令，只给归档项目一个入口。
 */
import type {
  Lifecycle, ProjectMemberView, ProjectStatus, ProjectView, ProjectViewRow, ProjectTaskArtifactView,
  ProjectTaskView, ProjectTaskWakeView, TaskStatus,
} from '../../shared/views.js'

/**
 * 任务分组顺序：手工对齐 core project-summary 的 TASK_SORT_GROUP
 * （doing/blocked 最前，accepted/rejected 沉底）。值只能是 core 的六个任务状态。
 * 表单校验与命令入参拼装在同目录 project-form.ts。
 */
export const TASK_GROUP_ORDER: readonly TaskStatus[] = [
  'doing', 'blocked', 'todo', 'done_pending_check', 'accepted', 'rejected',
]

// ---------- 顶栏计数与分区 ----------

/**
 * 顶栏计数的一个分段（U01 第 41 轮）：页面要给「归档 N」挂锚点（点开归档区并滚动定位），
 * 不能再把整句拼死成一个字符串。分段是唯一事实源，projectSummary 直接由它拼回，
 * 保证纯文本口径与页面渲染永远一致，不允许两处各写一套状态名。
 */
export interface ProjectSummaryPart {
  /** 分段键：页面只对 archived 段挂跳转动作。 */
  key: 'total' | 'active' | 'paused' | 'done' | 'archived' | 'tasks' | 'pending'
  /** 分段正文，如「进行中 2」。 */
  text: string
  /** 该段计数（归档段为 0 时页面不渲染跳转，只显示纯文本）。 */
  count: number
}

/**
 * 把计数拆成固定顺序的七段：前五项（总数/进行中/暂停/完成/归档）用 · 连接，
 * 任务两项前用 ｜ 分隔。顺序与文案集中在此，projectSummary 与页面都从这里取。
 */
export function projectSummaryParts(view: ProjectView): ProjectSummaryPart[] {
  const c = view.counts
  return [
    { key: 'total', text: `${c.total} 个`, count: c.total },
    { key: 'active', text: `进行中 ${c.active}`, count: c.active },
    { key: 'paused', text: `暂停 ${c.paused}`, count: c.paused },
    { key: 'done', text: `完成 ${c.done}`, count: c.done },
    { key: 'archived', text: `归档 ${c.archived}`, count: c.archived },
    { key: 'tasks', text: `任务 ${c.tasksTotal} 个`, count: c.tasksTotal },
    { key: 'pending', text: `待验收 ${c.tasksPendingCheck} 个`, count: c.tasksPendingCheck },
  ]
}

/**
 * 顶部一句话计数：项目分状态数 + 任务总数 + 待主人验收数（全部取自 core 视图，不自己数）。
 * 由 projectSummaryParts 拼出，和页面带锚点的渲染共用同一事实源。
 */
export function projectSummary(view: ProjectView): string {
  const parts = projectSummaryParts(view)
  // 开头不重复"项目"——页面标题 <h2>项目</h2> 已经给过，这里直接跟计数
  return `${parts.slice(0, 5).map(p => p.text).join('·')}｜${parts.slice(5).map(p => p.text).join('·')}`
}

/** 项目分区：归档沉底；同一分区内保持视图顺序（core 已按创建时间排好）。 */
export type ProjectZone = 'active' | 'paused' | 'done' | 'archived'

/** 分区的中文标题与空态提示（顺序即页面铺陈顺序）。
 * 标题口径与 projectSummary 一致："进行中 · 暂停 · 完成 · 归档"，不加"已"字，
 * 与 summary 里的同一组状态名完全对齐，避免同一页面同一状态出现两种叫法。 */
export const PROJECT_ZONES: ReadonlyArray<{ zone: ProjectZone; title: string }> = [
  { zone: 'active', title: '进行中' },
  { zone: 'paused', title: '暂停' },
  { zone: 'done', title: '完成' },
  { zone: 'archived', title: '归档' },
]

/** 把视图行按项目状态分到四个区。 */
export function projectSections(view: ProjectView): Record<ProjectZone, ProjectViewRow[]> {
  const sections: Record<ProjectZone, ProjectViewRow[]> = { active: [], paused: [], done: [], archived: [] }
  for (const row of view.projects) sections[row.project.status].push(row)
  return sections
}

/** 空态文案：一个项目都没有时指引新建；只剩归档项目时指向归档折叠区。 */
export function projectEmptyText(view: ProjectView): string | null {
  const c = view.counts
  if (c.total === 0) {
    return '还没有项目。点「＋ 新项目」，写清要做什么、怎么算做完。然后把队友拉进来，分好谁做、谁评。'
  }
  const live = c.active + c.paused + c.done
  if (live === 0) return `暂无未归档项目。归档区还留着 ${c.archived} 个历史项目。`
  return null
}

/** 项目卡上的工作区目录展示（U05）：正文给人话目录名，完整路径只放进悬停提示。 */
export interface WorkspaceDirDisplay {
  /** 正文文案：目录名带结尾斜杠；空路径为「未设置」。 */
  label: string
  /** 悬停提示：完整路径；空路径不显示提示。 */
  title: string | undefined
}

/**
 * 把项目工作区的完整路径换成主人看得懂的目录名。
 * 正文不整行铺绝对路径：只取最后一个路径段并补 `/`（如 /Users/x/prj_weekly → prj_weekly/）；
 * 空字符串显示「未设置」，不渲染空白。根路径没有目录名时照实显示原路径，不伪装成未设置。
 */
export function workspaceDirDisplay(fullPath: string): WorkspaceDirDisplay {
  const value = fullPath.trim()
  if (value === '') return { label: '未设置', title: undefined }
  // 同时兼容 macOS/Linux 的 `/` 与 Windows 的 `\`，并忽略结尾分隔符。
  const segments = value.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return { label: value, title: value }
  return { label: `${segments[segments.length - 1] ?? value}/`, title: value }
}

// ---------- 任务分组与可发起动作 ----------

/** 一个任务分组：状态与中文标签都取自视图行，组内保持视图顺序。 */
export interface TaskGroup {
  status: TaskStatus
  label: string
  tasks: ProjectTaskView[]
}

/**
 * 按状态分组任务：只保留有任务的组，组序按 TASK_GROUP_ORDER。
 * 分组标签直接取第一行的 statusLabel（视图给的中文），不在前端翻译。
 */
export function taskGroups(tasks: readonly ProjectTaskView[]): TaskGroup[] {
  const groups: TaskGroup[] = []
  for (const status of TASK_GROUP_ORDER) {
    const inGroup = tasks.filter(t => t.task.status === status)
    if (inGroup.length > 0) groups.push({ status, label: inGroup[0]!.statusLabel, tasks: inGroup })
  }
  return groups
}

/**
 * 派活对话框的五种模式（逐一对齐 core dispatchTask 的状态机分支）：
 * - assign：todo 新派；resume：blocked 恢复并派活；rework：rejected 驳回后重新派活；
 * - nudge：doing 同队友催办（队友固定、状态不动、复用议程）；
 * - reassign：doing 换人改派（旧队友同任务的打开议程标撤销）。
 */
export type DispatchMode = 'assign' | 'resume' | 'rework' | 'nudge' | 'reassign'

/** 任务行能发起的状态流转动作（编辑任务是另一套，见 canEditTask）。 */
export interface TaskTransitionAction {
  kind: 'dispatch' | 'block' | 'reportDone' | 'accept' | 'reject'
  /** 对应的界面命令名（host/real-hub 分发表同名字段）。五种派活模式统一走 dispatchTask。 */
  command: 'dispatchTask' | 'taskBlock' | 'reportDone' | 'acceptTask' | 'rejectTask'
  label: string
  tone: 'ghost' | 'primary' | 'danger'
  /** 驳回唯一需要理由：点击后先开驳回弹框，不直接发命令。 */
  needsReason: boolean
  /** kind=dispatch 时对话框按哪种模式换文案；其余动作为 null。 */
  dispatchMode: DispatchMode | null
}

/** 五种派活模式的全套文案：动作名/确认按钮/提交中/底部后果解释/成功轻提示。 */
export interface DispatchModeCopy {
  /** 动作名：拼标题与按钮，如「派活」「恢复并派活」「重新派活」「催办」「改派」。 */
  verb: string
  /** 确认按钮文案。 */
  confirm: string
  /** 提交进行中按钮文案。 */
  busy: string
  /** 对话框底部：如实说明这次操作的后果（催办不新建议程、改派对旧议程的影响等）。 */
  explain: string
  /** 成功轻提示（页面据此给 toast）。 */
  success: string
}

/** 五种模式文案集中一处，纯常量便于单测对照；措辞与 core dispatch.ts 的语义逐项对齐。 */
export const DISPATCH_MODE_COPY: Record<DispatchMode, DispatchModeCopy> = {
  assign: {
    verb: '派活', confirm: '确认派活', busy: '派活中…',
    explain: '派出去以后，任务会变成「进行中」。它会收到一条任务，被叫醒一次。做完它会回来汇报，等你验收。只能派给在岗或试岗的成员。',
    success: '已派活',
  },
  resume: {
    verb: '恢复并派活', confirm: '确认恢复派活', busy: '派活中…',
    explain: '确认后任务从「受阻」恢复为「进行中」：承接队友收到留言，并被叫醒一次。只能派给在岗或试岗的成员。',
    success: '已恢复派活',
  },
  rework: {
    verb: '重新派活', confirm: '确认重新派活', busy: '派活中…',
    explain: '确认后任务从「已驳回」重新进入「进行中」：承接队友带留言返工，并被叫醒一次。只能派给在岗或试岗的成员。',
    success: '已重新派活',
  },
  nudge: {
    verb: '催办', confirm: '确认催办', busy: '发送中…',
    explain: '催办会给队友再发一条原话，不新建议程、任务状态不变。留言可不填，建议写清后续要做什么。',
    success: '已催办',
  },
  reassign: {
    verb: '改派', confirm: '确认改派', busy: '改派中…',
    explain: '改派后任务转给新队友：新队友的议程新增一条任务，并被叫醒一次；旧队友该任务的打开议程标记撤销。',
    success: '已改派',
  },
}

/** 拼一个派活类动作（五种模式只在 label/语气/模式上不同，命令统一是 dispatchTask）。 */
function dispatchAction(mode: DispatchMode, label: string, tone: TaskTransitionAction['tone']): TaskTransitionAction {
  return { kind: 'dispatch', command: 'dispatchTask', label, tone, needsReason: false, dispatchMode: mode }
}

/** todo 任务的新派动作（core：todo→doing，并给目标队友新建议程）。 */
const DISPATCH_ASSIGN_ACTION = dispatchAction('assign', '派活', 'primary')
/** blocked 任务的恢复并派活动作（core：blocked→doing）。 */
const DISPATCH_RESUME_ACTION = dispatchAction('resume', '恢复并派活', 'primary')
/** rejected 任务的重新派活动作（core：rejected→doing，驳回后返工的入口）。 */
const DISPATCH_REWORK_ACTION = dispatchAction('rework', '重新派活', 'primary')
/** doing 同队友催办：次要按钮，对话框里固定为当前承接队友。 */
const DISPATCH_NUDGE_ACTION = dispatchAction('nudge', '催办', 'ghost')
/** doing 换人改派：次要按钮，对话框里另选成员队友。 */
const DISPATCH_REASSIGN_ACTION = dispatchAction('reassign', '改派', 'ghost')

/** 待验收任务的两个验收动作（本卡产品核心：执行者说完成不算，主人通过/驳回才落定）。 */
const ACCEPT_ACTIONS: TaskTransitionAction[] = [
  { kind: 'accept', command: 'acceptTask', label: '验收通过', tone: 'primary', needsReason: false, dispatchMode: null },
  { kind: 'reject', command: 'rejectTask', label: '驳回', tone: 'danger', needsReason: true, dispatchMode: null },
]

/**
 * doing 任务能不能催办/改派：必须指派了有效队友。待认领、队友失效两种异常都不给
 * 入口；队友是否在岗/试岗视图里没有生命周期字段，仍由 core 兜底中文报错。
 */
export function canNudgeTask(task: ProjectTaskView): boolean {
  return task.task.status === 'doing'
    && task.assigneeBotId !== null
    && !task.assigneeInvalid
}

/**
 * 按任务状态与项目状态给可发起的流转动作（纯函数，页面直接照表渲染按钮）。
 *
 * 派活类动作（派活/恢复并派活/重新派活/催办/改派）只在项目 active 时出现：core
 * dispatchTask 只接受进行中的项目，暂停/完成/归档项目不给注定失败的按钮。其余动作
 * （标记受阻/交账/验收）与历史口径一致，合法性仍由 core 在提交时兜底。
 * - todo 只给「派活」：派活本身会把任务推进到进行中，不存在裸的开工按钮。
 * - blocked 给「恢复并派活」、rejected 给「重新派活」：都先选队友再发 dispatchTask。
 * - doing 给「标记受阻 / 催办 / 改派 / 交账待验收」；催办/改派仅在有承接人时出现。
 * - accepted 是终态：任何动作按钮都不给。
 */
export function taskTransitionActions(task: ProjectTaskView, projectStatus: ProjectStatus): TaskTransitionAction[] {
  const dispatchAllowed = projectStatus === 'active'
  switch (task.task.status) {
    case 'todo':
      return dispatchAllowed ? [DISPATCH_ASSIGN_ACTION] : []
    case 'blocked':
      return dispatchAllowed ? [DISPATCH_RESUME_ACTION] : []
    case 'rejected':
      return dispatchAllowed ? [DISPATCH_REWORK_ACTION] : []
    case 'doing': {
      const actions: TaskTransitionAction[] = [
        { kind: 'block', command: 'taskBlock', label: '标记受阻', tone: 'ghost', needsReason: false, dispatchMode: null },
      ]
      // 催办在前、改派在后：先给最轻的提醒，换人才是重动作。
      if (dispatchAllowed && canNudgeTask(task)) {
        actions.push(DISPATCH_NUDGE_ACTION, DISPATCH_REASSIGN_ACTION)
      }
      actions.push({ kind: 'reportDone', command: 'reportDone', label: '交账待验收', tone: 'primary', needsReason: false, dispatchMode: null })
      return actions
    }
    case 'done_pending_check':
      return ACCEPT_ACTIONS
    case 'accepted':
      return []
  }
}

/** 任务能不能编辑：归档项目不动；accepted 终态不能改（core saveTask 同样拒绝）。 */
export function canEditTask(task: ProjectTaskView, projectStatus: ProjectStatus): boolean {
  return projectStatus !== 'archived' && task.task.status !== 'accepted'
}

/** 项目能不能做任何修改/流转：归档项目只读陈列（core 对归档项目拒绝全部写命令）。 */
export function canManageProject(status: ProjectStatus): boolean {
  return status !== 'archived'
}

/** 只有归档项目能恢复：与 core restoreProject 的白名单一致，页面据此决定是否给入口。 */
export function canRestoreProject(status: ProjectStatus): boolean {
  return status === 'archived'
}

/**
 * 任务能不能再关联产物（F08 尾巴）：归档项目只读；已通过验收是终态（core 同样拒绝）。
 * 已驳回/受阻状态下仍可关联：执行者可能补交了新产物，主人要在验收前挂上去。
 */
export function canAttachArtifact(task: ProjectTaskView, projectStatus: ProjectStatus): boolean {
  return projectStatus !== 'archived' && task.task.status !== 'accepted'
}

/** 一条已关联产物的一句话：版本号、标题与验收结论（没结论时明确写「未验收」）。 */
export function artifactBrief(artifact: ProjectTaskArtifactView): string {
  return `v${artifact.number} · ${artifact.title} · ${artifact.reviewLabel ?? '未验收'}`
}

/**
 * 关联产物弹窗首次打开时的默认队友建议：当前默认队友没有可关联版本时，
 * 按队友列表顺序挑第一位有版本的队友，避免弹窗停在「这个队友没有产物」的
 * 空态死胡同（主人可能以为根本没产物，不知道还要手动换人）。
 *
 * 保守边界：用户已手动换过人就绝不抢选择；当前队友有版本也不换；全部为空
 * （或队友 id 不在目录里）返回 null，调用方保持原选择。
 */
export function suggestArtifactBot(
  currentId: string,
  userChanged: boolean,
  order: ReadonlyArray<string>,
  hasVersions: (botId: string) => boolean,
): string | null {
  if (userChanged || currentId === '') return null
  if (hasVersions(currentId)) return null
  return order.find(id => id !== currentId && hasVersions(id)) ?? null
}

/**
 * 任务行「关联唤醒」能不能下钻：账本在且有归属队友才能打开右栏的这次唤醒；
 * 查不到账本（超过保留期/旧档没记）与队友已删除两种情况分开告诉主人，按钮都不假装能点。
 */
export type WakeLinkState = 'open' | 'bot_gone' | 'missing'

/** 判定链接状态；页面据此决定按钮是否可点与提示文案。 */
export function wakeLinkState(link: ProjectTaskWakeView): WakeLinkState {
  if (link.botId === null || link.ledgerId === null) return 'missing'
  if (link.botName === null) return 'bot_gone'
  return 'open'
}

/** 链接按钮的提示：可下钻时给唤醒标签＋理由，不可点时说明原因。 */
export function wakeLinkTitle(link: ProjectTaskWakeView): string {
  const state = wakeLinkState(link)
  if (state === 'missing') return '该次唤醒无账本记录（可能已超出保留期，或旧档无记录）。'
  if (state === 'bot_gone') return '所属队友已删除，账本保留但无法打开详情。'
  const parts = [link.variantLabel, link.statusLabel, link.triggerLabel].filter((part): part is string => Boolean(part))
  return `${parts.join(' · ')}${link.summary ? `：${link.summary}` : ''}`
}

/** 进度百分比（0–100）：core 给的是 accepted/total，空任务为 0。 */
export function progressPercent(row: ProjectViewRow): number {
  return Math.round(row.progress * 100)
}

/** 问题级别中文（错误在前、提醒在后，与资料页同一口径）。 */
export function issueLevelLabel(level: 'error' | 'warning'): string {
  return level === 'error' ? '错误' : '提醒'
}

// ---------- 队友与人员展示 ----------

/**
 * 人员一句话的统一结构：正文只说人话，内部 bot id 单独返回。
 * 纪律（主人定的口径）：id 绝不进正文或行内标签，只许界面放进悬停 title 作排障出口。
 */
export interface PersonBrief {
  text: string
  invalid: boolean
  /** 指向的队友 id（仅排障用）；未指派时为 null。 */
  botId: string | null
}

/** 负责人一句话：有效队友给名字；失效队友给固定中文占位，不猜名字也不露 id。 */
export function ownerBrief(row: ProjectViewRow): PersonBrief {
  if (row.ownerBotId === null) return { text: '未指定负责人', invalid: false, botId: null }
  if (row.ownerInvalid || row.ownerName === null) {
    return { text: '负责人已删除或退役，请重新指定', invalid: true, botId: row.ownerBotId }
  }
  return { text: row.ownerName, invalid: false, botId: row.ownerBotId }
}

/** 成员一句话；失效成员给固定中文占位，id 只在 brief.botId 里交给 title。 */
export function memberBrief(member: ProjectMemberView): PersonBrief {
  if (member.invalid || member.name === null) {
    return { text: '队友已删除或退役', invalid: true, botId: member.botId }
  }
  return { text: member.name, invalid: false, botId: member.botId }
}

/** 任务指派人一句话（含失效标记，供页面标红）。 */
export type AssigneeBrief = PersonBrief

/** 任务指派人一句话：待认领 / 队友名 / 失效队友固定占位（id 走 botId 进 title）。 */
export function assigneeBrief(task: ProjectTaskView): AssigneeBrief {
  if (task.assigneeBotId === null) return { text: '待认领', invalid: false, botId: null }
  if (task.assigneeInvalid || task.assigneeBotName === null) {
    return { text: '指派的队友已删除或退役', invalid: true, botId: task.assigneeBotId }
  }
  return { text: task.assigneeBotName, invalid: false, botId: task.assigneeBotId }
}

// ---------- 队友选项（项目成员/负责人/任务指派三个选择器共用） ----------

/** 一个可选队友：botId 是命令入参值，name 给主人看，lifecycle 决定能不能接活。 */
export interface BotOption {
  botId: string
  name: string
  lifecycle: Lifecycle
}

/** 已被项目引用但失效（退役/删除）的队友：不能再被选择，只在问题区点名。 */
export interface InvalidBotRef {
  botId: string
  label: string
}

/** 队友目录：可选项 + 失效点名表；表单选择器与页面问题区都用它。 */
export interface BotCatalogue {
  options: BotOption[]
  invalid: InvalidBotRef[]
}

/** 能接活的生命周期：与 core 的 ON_TEAM_LIFECYCLES 一致（在岗、试岗）。 */
const ON_TEAM_LIFECYCLES: readonly Lifecycle[] = ['probation', 'active']

/**
 * 从总览队友构造可选队友，并用项目视图补齐/点名：
 * - 退役队友绝不进选项（core 也拒绝）；
 * - 项目成员里出现、总览里却没有的有效队友（旧档/总览未加载）防御性补进选项；
 * - 已失效的队友绝不进选项，汇总到 invalid 里由问题区展示。
 * bots 为空（总览还没加载）时仍能从项目视图拼出已出现过的队友。
 */
export function botCatalogue(
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle }>,
  view: ProjectView | null,
): BotCatalogue {
  const byId = new Map<string, BotOption>()
  const invalidById = new Map<string, InvalidBotRef>()
  /** 总览里明确退役的队友：即使项目视图行还没刷新（invalid 仍是 false），也绝不能再进候选。 */
  const retiredIds = new Set<string>()

  for (const bot of bots) {
    if (bot.lifecycle === 'retired') {
      retiredIds.add(bot.id)
      continue
    }
    byId.set(bot.id, { botId: bot.id, name: bot.name, lifecycle: bot.lifecycle })
  }

  for (const project of view?.projects ?? []) {
    for (const member of project.members) {
      if (member.invalid || member.name === null) {
        // 失效队友只给固定中文占位；真实 id 留在 botId 字段里供界面放 title。
        invalidById.set(member.botId, { botId: member.botId, label: '队友已删除或退役' })
      } else if (retiredIds.has(member.botId)) {
        // 真机回归：项目视图可能比总览晚一拍，退役队友的成员行仍标记为有效；
        // 以总览生命周期为准，绝不把「力工 · 已退役」塞回成员候选。
        invalidById.set(member.botId, { botId: member.botId, label: '队友已退役' })
      } else if (!byId.has(member.botId)) {
        byId.set(member.botId, { botId: member.botId, name: member.name, lifecycle: 'active' })
      }
    }
    // 任务指到失效队友：项目问题里有点名，这里同样收集，供指派选择器之外的提示复用。
    for (const task of project.tasks) {
      if (task.assigneeInvalid && task.assigneeBotId !== null && !invalidById.has(task.assigneeBotId)) {
        invalidById.set(task.assigneeBotId, { botId: task.assigneeBotId, label: '队友已删除或退役' })
      }
    }
  }

  return { options: [...byId.values()], invalid: [...invalidById.values()] }
}

/** 一个项目当前可指派任务的队友：有效成员里在岗/试岗的那些（空=待认领）。 */
export function taskAssigneeOptions(row: ProjectViewRow, catalogue: BotCatalogue): BotOption[] {
  const memberIds = new Set(row.members.filter(m => !m.invalid).map(m => m.botId))
  return catalogue.options.filter(option =>
    memberIds.has(option.botId) && ON_TEAM_LIFECYCLES.includes(option.lifecycle))
}
