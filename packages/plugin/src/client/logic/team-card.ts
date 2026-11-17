/**
 * 组队卡与三问卡的界面规则（P73e，纯函数）。
 *
 * 背景：总管推荐员工时，先问三个固定问题（三问卡），再给一张组队卡，你在卡上改名、换一位、
 * 不要这位、改性格、改模型，最后点确认，员工才入职。卡片的内容（文字、人数、按钮文字、
 * 每位的性格四句话）都由 core 算好放在视图里（TeamQuestionView、TeamCardView），
 * 这里只管和界面有关的小规则：
 * 1. 命令参数：每个按钮点下去发什么命令、带什么参数；
 * 2. 性格四个维度二选一怎样拼回 4 个字母；
 * 3. 改名什么时候提交、按钮什么时候可点；
 * 4. 只读状态下每位一行怎样写；
 * 5. 本卡新增的界面文字（集中在 TEAM_TEXT，登记在 docs/copy/strings.json，编号前缀 TEAM-）。
 *
 * 为什么写成纯函数：组件只管画，规则能逐条单测；文字放一处，组件、测试和登记表引用同一份。
 * 视图里已有的文字（标题、状态、在册人数、确认按钮、备选、来历）不在这里重写，一律用 core 给的。
 */
import type { ThreadMessageView, TeamCandidateView, TeamCardView, TeamQuestionView } from '../../shared/views.js'

// ---------------------------------------------------------------------------
// 一、界面文字
// ---------------------------------------------------------------------------

/** 本卡新增的界面文字。带变量的用函数拼，登记表里对应的写法是 {} 占位。 */
export const TEAM_TEXT = {
  /** 卡片左上角的类别标签。 */
  tag: '组队',
  /** 三问卡里建议项旁的小标签，以及组队卡里「性格、模型」没改过时的标记。 */
  suggested: '建议',
  /** 性格、模型改过之后的标记。 */
  changed: '已改',
  /** 性格、模型两栏的栏名。 */
  mbtiLabel: '性格',
  modelLabel: '模型',
  /** 「换一位」下拉（P73f 起是下拉，原为展开按钮）：下拉的占位项，也是下拉的可访问名。 */
  swap: '换一位…',
  /** 下拉里选了备选后出现的提交按钮（选择变化时不直接提交，见无障碍契约 WCAG 3.2.2）。 */
  swapApply: '换为这位',
  /** 名字改了之后出现的提交按钮（不做失焦自动提交），以及名字没提交就点确认时的提示。 */
  rename: '改名',
  renamePending: '有名字改了还没提交。请先点「改名」或按回车，再确认。',
  /** 「不要这位」及其撤销。 */
  remove: '不要这位',
  undo: '撤销',
  removedFlag: '已选不要',
  /** 员工说明被总管按你的话改过时多一行。 */
  briefChanged: '员工说明已按你的话修改',
  /** 模型档位里当前不能选的档位。 */
  tierUnavailable: '不可用',
  /** 三问期间私聊输入框的占位文字。 */
  questionPlaceholder: '点选上面的选项，或写下你的回答',
  /** 第二问选「有」时选择窗口打不开、出错、没有返回结果（包括你关掉窗口）时的提示（P73r4）。 */
  folderUnavailable: '没有选到文件夹。请再点一次，或在输入框里写出项目文件夹的完整路径。',
  /** 入职后在册会超过上限时，确认按钮旁的说明（P73r4）；{} 为实际上限。 */
  rosterOverflowRemovable: (limit: number): string => `入职后在册会超过 ${limit} 位。先在卡上去掉一位，或在员工卡片里归档一位。`,
  rosterOverflowArchiveOnly: (limit: number): string => `入职后在册会超过 ${limit} 位。请先在员工卡片里归档一位。`,
  /** 待你处理里组队条目的说明（代替到期说明）。 */
  inboxNoAuto: '不会自动入职。你确认前没有员工入职。',
} as const

/** 「模板：工程师　执行」「模板：评审员　评审，全队一位」。 */
export function templateLine(candidate: Pick<TeamCandidateView, 'templateName' | 'dutyLabel' | 'uniqueNote'>): string {
  const note = candidate.uniqueNote === null ? '' : `，${candidate.uniqueNote}`
  return `模板：${candidate.templateName}　${candidate.dutyLabel}${note}`
}

/** 「适合做：…」。 */
export function fitLine(candidate: Pick<TeamCandidateView, 'fitFor'>): string {
  return `适合做：${candidate.fitFor}`
}

/** 「预计 …」。 */
export function estimateLine(candidate: Pick<TeamCandidateView, 'estimateText'>): string {
  return `预计 ${candidate.estimateText}`
}

/** 候选名字输入框的可访问名。 */
export function nameInputLabel(name: string): string {
  return `${name}的名字`
}

/** 点开性格、模型修改面板的按钮的可访问名。 */
export function openEditorLabel(kind: 'mbti' | 'model', name: string): string {
  return kind === 'mbti' ? `修改${name}的性格` : `修改${name}的模型`
}

/** 三问一组选项的可访问名。 */
export function questionGroupLabel(step: number): string {
  return `第 ${step} 问的选项`
}

// ---------------------------------------------------------------------------
// 二、性格四个维度
// ---------------------------------------------------------------------------

/** 性格四个维度：每组二选一，顺序固定为 E/I、S/N、T/F、J/P（与 core 四句话的顺序一致）。 */
export const MBTI_AXES: ReadonlyArray<{ index: 0 | 1 | 2 | 3; options: readonly [{ code: string; name: string }, { code: string; name: string }] }> = [
  { index: 0, options: [{ code: 'E', name: '外向' }, { code: 'I', name: '内向' }] },
  { index: 1, options: [{ code: 'S', name: '实感' }, { code: 'N', name: '直觉' }] },
  { index: 2, options: [{ code: 'T', name: '思考' }, { code: 'F', name: '情感' }] },
  { index: 3, options: [{ code: 'J', name: '判断' }, { code: 'P', name: '知觉' }] },
]

/** 把当前类型的某一个维度换成另一个字母，拼出新类型：ISFJ 把第 1 个维度换成 E 得到 ESFJ。 */
export function mbtiWithAxis(type: string, axisIndex: 0 | 1 | 2 | 3, code: string): string {
  const letters = [...type]
  letters[axisIndex] = code
  return letters.join('')
}

/** 当前类型在某个维度上选的是哪个字母。 */
export function mbtiAxisChoice(type: string, axisIndex: 0 | 1 | 2 | 3): string {
  return [...type][axisIndex] ?? ''
}

// ---------------------------------------------------------------------------
// 三、命令参数
// ---------------------------------------------------------------------------

/** 组队卡上的编辑动作，与 core 的 editTeamCandidate 一致。 */
export type TeamEditAction = 'rename' | 'set_mbti' | 'set_model' | 'restore_mbti' | 'restore_model' | 'swap' | 'remove' | 'unremove'

/**
 * editTeamCandidate 的入参。每个编辑都带视图里的 rev：卡片被别处改过时 core 会拒绝，
 * 界面刷新后让你在最新内容上重做，不自动重试。
 */
export function editInput(card: Pick<TeamCardView, 'proposalId' | 'rev'>, key: string, action: TeamEditAction, value?: string | number): Record<string, unknown> {
  return { proposalId: card.proposalId, rev: card.rev, key, action, ...(value === undefined ? {} : { value }) }
}

/** confirmTeamProposal 的入参。 */
export function confirmInput(card: Pick<TeamCardView, 'proposalId' | 'rev'>): Record<string, unknown> {
  return { proposalId: card.proposalId, rev: card.rev }
}

/** answerTeamQuestion 的入参：点选；第二问选「有」时带上选好的文件夹。 */
export function answerInput(question: Pick<TeamQuestionView, 'setupId' | 'step'>, choice: string, folderPath?: string): Record<string, unknown> {
  return { setupId: question.setupId, step: question.step, choice, ...(folderPath === undefined ? {} : { folderPath }) }
}

/** 点了这个选项要不要先弹出选择文件夹：只有第二问的「有」。 */
export function needsFolder(question: Pick<TeamQuestionView, 'folderPick'>, choice: string): boolean {
  return question.folderPick && choice === 'yes'
}

/** 失败文字：命令返回的错误原样显示；异常取 message。 */
export function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 四、按钮与输入的可用性
// ---------------------------------------------------------------------------

/**
 * 入职后在册人数会不会超过上限（P73r4）。core 的视图只给了文字「入职后在册 7 / 6 位（含总管）」，
 * 没有单独的数字字段，所以从这句话里取出两个数；取不到（格式变了、卡已处理）一律当作没超，
 * 不会误把确认按钮锁死——真超了的话，core 的确认校验仍会拦住并给出原因。
 * 返回 null 表示没超；超了返回实际上限和应显示的说明。
 */
export function rosterOverflow(card: Pick<TeamCardView, 'state' | 'candidates' | 'footer'>): { limit: number; text: string } | null {
  if (card.state !== 'pending') return null
  const match = /入职后在册\s*(\d+)\s*\/\s*(\d+)\s*位/.exec(card.footer.rosterText)
  if (match === null) return null
  const after = Number(match[1])
  const limit = Number(match[2])
  if (!(after > limit)) return null
  // 初始组队卡上能去掉人；按需加人卡不能去掉，说明里就不提「在卡上去掉」。
  const removable = card.candidates.some(candidate => candidate.canRemove && !candidate.removed)
  return { limit, text: removable ? TEAM_TEXT.rosterOverflowRemovable(limit) : TEAM_TEXT.rosterOverflowArchiveOnly(limit) }
}

/** 卡片还在等你确认。只有这时才有输入框和按钮。 */
export function isPendingCard(card: Pick<TeamCardView, 'state'>): boolean {
  return card.state === 'pending'
}

/**
 * 名字输入框回车、或点「改名」按钮时要不要提交（不做失焦提交，见 questions P73e）：去掉首尾空白后不为空，且与原名不同。
 * 与原值相同不提交，避免白白让卡片的修订号加 1；空名字不提交，输入框恢复原名。
 */
export function shouldSubmitRename(current: string, typed: string): boolean {
  const next = typed.trim()
  return next !== '' && next !== current
}

/** 一位候选当前能做的编辑：被去掉的只能撤销，其余都不能点。 */
export function candidateEditable(candidate: Pick<TeamCandidateView, 'removed'>, pending: boolean): boolean {
  return pending && !candidate.removed
}

/**
 * 「换一位」下拉里选中的备选序号：选中值（字符串）对应到这位候选的备选里、且可选时返回序号，
 * 没选、序号不在备选里、备选置灰（已在册、卡上已有）时返回 null，调用方据此不显示提交按钮、也不发命令。
 */
export function swapIndexOf(candidate: Pick<TeamCandidateView, 'alternates'>, chosen: string | undefined): number | null {
  if (chosen === undefined || chosen === '') return null
  const index = Number(chosen)
  const alternate = candidate.alternates.find(item => item.index === index)
  return alternate !== undefined && alternateClickable(alternate) ? index : null
}

/** 备选里能不能点：置灰的不可点。 */
export function alternateClickable(alternate: Pick<TeamCandidateView['alternates'][number], 'disabled'>): boolean {
  return !alternate.disabled
}

/** 模型档位里能不能点：不可用的不能点，当前已选的不重复提交。 */
export function tierClickable(option: Pick<TeamCandidateView['model']['options'][number], 'available' | 'tier'>, currentTier: string): boolean {
  return option.available && option.tier !== currentTier
}

// ---------------------------------------------------------------------------
// 五、只读状态
// ---------------------------------------------------------------------------

/**
 * 确认后每位一行：{名字}　{角色}　{类型}{　档位，仅改过时}　{来历}。
 * 被去掉的只写名字和「你选了不要」；没有来历（没改过）的不写这一段。
 */
export function readonlyLine(candidate: TeamCandidateView): string {
  if (candidate.removed) return [candidate.name, candidate.historyText ?? TEAM_TEXT.removedFlag].join('　')
  const parts = [candidate.name, candidate.dutyLabel, candidate.personality.type]
  if (candidate.model.changed) parts.push(candidate.model.label)
  if (candidate.historyText !== null) parts.push(candidate.historyText)
  return parts.join('　')
}

// ---------------------------------------------------------------------------
// 六、线程里的判断
// ---------------------------------------------------------------------------

/**
 * 三问进行中：线程里最新一条三问消息的 current 为真。
 * 判断依据是视图的 current 字段（core 给出），不在界面里另算。
 */
export function questionInProgress(messages: ReadonlyArray<Pick<ThreadMessageView, 'teamQuestion'>>): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const question = messages[index]?.teamQuestion
    if (question !== undefined && question !== null) return question.current
  }
  return false
}
