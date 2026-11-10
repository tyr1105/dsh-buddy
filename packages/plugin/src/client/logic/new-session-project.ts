/**
 * 新会话页「选项目」的规则（P57 后半段，接 P60 的项目主题聊天）。
 *
 * 选了项目之后，这句话不进 DSH 会话，而是在项目里开一个主题。所以项目不登记成 DSH 工作区，
 * 「选了哪个项目」也不存在宿主那边，只由接线层的一个内存仓库记着，刷新页面就回到普通状态。
 *
 * 宿主的输入框只有一种办法接管回车：输入框最前面放一个「认领标签」。
 * 这里选项目后放一个 #项目名 的标签，既接管回车，也让主人看得见这句话要发到哪。
 * 标签和选中状态必须一致，这件事由 projectChipStep 这个纯函数决定，接线层只管执行。
 *
 * 全部写成纯函数：路径多（先打字后选项目、换项目、换回工作区、手动删标签），
 * 放在这里可以用固定输入把每条路钉死。
 */
import type { BotCard, ProjectView } from '../../shared/views.js'

/** 项目标签的认领名：用来认出输入框里的标签是不是这里放的。 */
export const PROJECT_CLAIM_NAME = 'dsh-buddy-project-topic'
/** 项目标签来源的名字。这个来源不出现在任何菜单里，只负责在切换工作区时把标签恢复回来。 */
export const PROJECT_SOURCE_NAME = 'dsh-buddy-project-chip'
/** 项目标签的开头字符：和 @ 队友、/ 指令都区分开。 */
export const PROJECT_TRIGGER = '#'

/** 项目里的一位成员（只取用得到的字段）。 */
export interface ProjectMemberChoice {
  botId: string
  name: string
  roleLabel: string
  isOwner: boolean
}

/** 能在新会话里选的项目。 */
export interface ProjectChoice {
  id: string
  name: string
  members: ProjectMemberChoice[]
}

/**
 * 能选的项目：只列进行中的。暂停、完成、归档的项目开不了主题（引擎也会拒绝）。
 * 项目视图还没读出来时返回空，下拉就不显示这一组。
 */
export function activeProjects(view: ProjectView | null): ProjectChoice[] {
  if (view === null) return []
  return view.projects
    .filter(row => row.project.status === 'active')
    .map(row => ({
      id: row.project.id,
      name: row.project.name,
      members: row.members.flatMap(member => (member.invalid || member.name === null ? [] : [{
        botId: member.botId,
        name: member.name,
        roleLabel: member.roleLabel ?? '',
        isOwner: member.isOwner,
      }])),
    }))
}

/** 输入框标签占用的文本：宿主要求带一个尾随空格，后面的字才算消息正文。 */
export function projectToken(name: string): string {
  return `${PROJECT_TRIGGER}${name} `
}

/** 从标签文字反查项目：切换工作区时宿主只给这段文字。名字完全相等才算。 */
export function projectFromToken(projects: readonly ProjectChoice[], token: string): ProjectChoice | undefined {
  const spelled = token.trim()
  if (!spelled.startsWith(PROJECT_TRIGGER)) return undefined
  const name = spelled.slice(PROJECT_TRIGGER.length)
  return projects.find(project => project.name === name)
}

/**
 * 没写字时输入框里的提示，也是下拉里项目行的悬停说明。
 * 新项目可能还没定负责人：引擎发送时会按规则选一位，这里就不写名字，免得说错人。
 */
export function projectHint(project: ProjectChoice): string {
  const owner = project.members.find(member => member.isOwner)
  return owner === undefined
    ? `发到项目 ${project.name}。不 @ 时默认发给项目负责人`
    : `发到项目 ${project.name}。不 @ 时默认发给负责人 ${owner.name}`
}

/** @ 菜单分组标题：写明列的是哪个项目的人。 */
export function projectMentionSection(name: string): string {
  return `项目成员 · ${name}`
}

/** @ 菜单里的一行成员。 */
export interface ProjectMentionRow {
  bot: BotCard
  /** 右侧说明：负责人标在最前面，一眼能看出 @ 谁、不 @ 又会发给谁。 */
  description: string
}

/**
 * 选了项目时 @ 列的人：项目成员，负责人排第一。
 * 已退役、已归档的不列；名册里查不到的（档案已删）也不列，因为引擎叫不动它。
 */
export function projectMentionRows(project: ProjectChoice, bots: readonly BotCard[], query: string): ProjectMentionRow[] {
  const q = query.trim().toLowerCase()
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const rows = project.members.flatMap(member => {
    const bot = byId.get(member.botId)
    if (bot === undefined || bot.archived === true || bot.lifecycle === 'retired') return []
    if (q !== '' && !`${member.name} ${member.roleLabel}`.toLowerCase().includes(q)) return []
    const owner = member.isOwner ? '负责人' : ''
    return [{ bot, isOwner: member.isOwner, description: [owner, member.roleLabel].filter(part => part !== '').join(' · ') }]
  })
  // sort 是稳定排序，其余成员保持项目里的顺序。
  return rows
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner))
    .map(({ bot, description }) => ({ bot, description }))
}

/** 宿主输入框状态里判断标签要用的部分。 */
export interface ComposerState {
  phase: string
  draft: string
  claim?: { name: string; token: string } | undefined
}

/** 写回输入框的草稿：带 command 时宿主会把开头那段文字重建成认领标签。 */
export interface ProjectChipDraft {
  text: string
  references: never[]
  command: { token: string }
}

/** 这一轮之间要记住的事。 */
export interface ProjectChipMemo {
  /** 已经放进去、等宿主建好的标签；没有就是 null。 */
  applied: string | null
  /** 标签已经真的出现过：之后再消失，才算主人自己删掉的。 */
  sawChip: boolean
}

export const PROJECT_CHIP_IDLE: ProjectChipMemo = { applied: null, sawChip: false }

/** 这一步要做什么。 */
export interface ProjectChipStep {
  memo: ProjectChipMemo
  /** 要写回输入框的内容；null 表示这一步不用动输入框。 */
  draft: ProjectChipDraft | string | null
  /** 主人把标签删掉了：等于退出项目。 */
  clearSelection: boolean
  /** 标签这一步刚建好：光标要挪到最后，主人接着打字才不会插到正文前面。 */
  chipAppeared: boolean
}

/** 标签后面的正文。 */
function bodyAfterToken(draft: string, token: string): string {
  return draft.startsWith(token) ? draft.slice(token.length) : draft
}

/**
 * 让输入框里的标签和选中的项目保持一致。
 *
 * - 没选项目但输入框里有标签：摘掉标签，正文留下（换回普通工作区时草稿不丢）；
 * - 选了项目但没有标签：把标签放到最前面，已有的字都留在后面；
 * - 换了另一个项目：换标签，正文不动；
 * - 标签建好后又没了：是主人自己删的，退出项目，不再塞回去。
 *
 * 放标签后宿主要异步建好，这段时间标签还没出现，靠 memo 区分「还没建好」和「被删了」。
 * 发送中输入框不能动，这时什么都不做，等结果出来再判断。
 */
export function projectChipStep(state: ComposerState, selected: ProjectChoice | null, memo: ProjectChipMemo): ProjectChipStep {
  if (state.phase !== 'plain' && state.phase !== 'claimed') return { memo, draft: null, clearSelection: false, chipAppeared: false }
  const own = state.phase === 'claimed' && state.claim?.name === PROJECT_CLAIM_NAME ? state.claim : null
  const wanted = selected === null ? null : projectToken(selected.name)

  if (wanted === null) {
    return { memo: PROJECT_CHIP_IDLE, draft: own === null ? null : bodyAfterToken(state.draft, own.token), clearSelection: false, chipAppeared: false }
  }
  if (own !== null && own.token === wanted) {
    return { memo: { applied: wanted, sawChip: true }, draft: null, clearSelection: false, chipAppeared: !memo.sawChip }
  }
  if (own === null && memo.applied === wanted) {
    return memo.sawChip
      ? { memo: PROJECT_CHIP_IDLE, draft: null, clearSelection: true, chipAppeared: false }
      : { memo, draft: null, clearSelection: false, chipAppeared: false }
  }
  const body = own === null ? state.draft : bodyAfterToken(state.draft, own.token)
  return {
    memo: { applied: wanted, sawChip: false },
    // 没有正文时不写尾随空格：宿主看到后面没有空格才会自己补一个，光标才落在空格之后。
    // 写了空格，光标会停在标签和空格中间，紧接着打 @ 不出菜单，打的字也跑到空格前面（实测）。
    draft: { text: body === '' ? wanted.trimEnd() : `${wanted}${body}`, references: [], command: { token: wanted } },
    clearSelection: false,
    chipAppeared: false,
  }
}

/** 宿主工作区列表里的一行（只取用得到的字段）。 */
export interface HostWorkspaceRow {
  workspaceId: string
  title: string
  path: string
}

/** 下拉里的一行。projectId 非空表示这行是项目。 */
export interface PickerEntry {
  key: string
  label: string
  /** 同名时跟在名字后面的路径片段；不同名时没有。 */
  suffix: string | null
  /** 悬停说明：工作区显示完整路径（和官方一致），项目说明消息会发给谁。 */
  title: string
  selected: boolean
  workspaceId: string | null
  projectId: string | null
}

export interface PickerEntries {
  projects: PickerEntry[]
  workspaces: PickerEntry[]
}

/** 目录路径最后两段，用来区分同名工作区。 */
function trailingSegments(path: string): string {
  return path.split('/').filter(part => part !== '').slice(-2).join('/')
}

/**
 * 组出下拉的两组内容。选中了项目时只勾项目那一行，
 * 否则宿主传来的工作区也打勾，会让人以为这句话还是发到工作区。
 */
export function buildPickerEntries(input: {
  projects: readonly ProjectChoice[]
  workspaces: readonly HostWorkspaceRow[]
  selectedWorkspaceId: string | undefined
  selectedProjectId: string | null
  defaultWorkspaceName: string
}): PickerEntries {
  const projects = input.projects.map((project): PickerEntry => ({
    key: `project:${project.id}`,
    label: project.name,
    suffix: null,
    title: projectHint(project),
    selected: project.id === input.selectedProjectId,
    workspaceId: null,
    projectId: project.id,
  }))
  // 官方把内部默认标题显示成本地化名字，这里保持一致，否则主人会看到英文标识。
  const labelOf = (row: HostWorkspaceRow): string => (row.title === 'default-workspace' ? input.defaultWorkspaceName : row.title)
  const labelCount = new Map<string, number>()
  for (const row of input.workspaces) labelCount.set(labelOf(row), (labelCount.get(labelOf(row)) ?? 0) + 1)
  const workspaces = input.workspaces.map((row): PickerEntry => ({
    key: `workspace:${row.workspaceId}`,
    label: labelOf(row),
    suffix: (labelCount.get(labelOf(row)) ?? 0) > 1 ? trailingSegments(row.path) : null,
    title: row.path,
    selected: input.selectedProjectId === null && row.workspaceId === input.selectedWorkspaceId,
    workspaceId: row.workspaceId,
    projectId: null,
  }))
  return { projects, workspaces }
}
