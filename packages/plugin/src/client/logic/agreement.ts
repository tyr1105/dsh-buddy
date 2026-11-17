/**
 * 约定卡的界面规则（P72e，纯函数）。
 *
 * 「约定」是总管在动手前先和你对齐的那张卡：一句话、草图、待你定的事项、已定的事项、
 * 这次做与不做、怎样算做完。core 已经把卡片内容整理成视图（AgreementCardView），
 * 这里只管三类和界面有关的小规则，写成纯函数是为了能逐条测、组件只管画：
 *
 * 1. 选择：待定项怎么预选（取建议项）、你改了哪几项之后提交什么；
 * 2. 文字：状态标签、修订记录那一行、印章上的日期，以及本卡新增的全部界面文字
 *    （集中放在 AGR_TEXT，登记在 docs/copy/strings.json，编号前缀 AGR-）；
 * 3. 动效：「定」字印章只在这张卡被你点了「定了」、由待确认变成已固定的那一刻落一次章。
 *
 * 为什么文字放在这里：组件、测试和文案登记表引用同一份，改一处就够，不会各写一套慢慢走样。
 * 依据标签、来源标签、旁白由 core 决定，这里不重写。
 */
import type { AgreementCardView, AgreementRevisionRow } from '../../shared/views.js'

/** 草图的类型：直接取自视图，不另抄一份字段。 */
export type AgreementSketchValue = AgreementCardView['sketch']['value']

/** 约定卡的版本状态。 */
export type AgreementVersionState = AgreementCardView['state']

// ---------------------------------------------------------------------------
// 一、界面文字
// ---------------------------------------------------------------------------

/** 本卡新增的界面文字。动态部分用函数拼，文案登记表里对应的写法是 {} 占位。 */
export const AGR_TEXT = {
  tag: '约定',
  summary: '一句话',
  sketch: '草图',
  sketchHint: '圆圈数字对应下方待你定的事项',
  /** P76j：约定卡「预计消耗」一段的标题与页脚小字的样式类由组件决定，文字全部取视图。 */
  estimateTitle: '预计消耗',
  pendingHint: '已按建议选好，不同意就点别的选项',
  suggested: '建议',
  decidedHint: '不同意哪条，直接在输入框说',
  scopeIn: '这次做',
  scopeOut: '这次不做',
  scopeNone: '无',
  doneWhen: '怎样算做完',
  doneWhenHint: '你可以逐条亲自验证',
  confirm: '定了',
  confirmHint: '要改哪里，直接在下方输入框写，我改好后再给你看。',
  changes: '本版改动',
  expand: '展开全文',
  collapse: '收起全文',
  viewFull: '查看全文',
  hideFull: '收起全文',
  lockedChoice: '你选了：定了。之后要改约定，直接告诉我，我会出新版本请你确认。',
  stateLabelPending: '待你确认',
  withdrawn: '已撤下',
  noAutoAdopt: '不会自动按建议处理。你确认前不会开工。',
  /** P74h-m1 第 6 处：待确认的约定卡带两栏（有正在做的事）时用这一句——工作是照常在做的，只暂停被改动涉及的部分。 */
  noAutoAdoptJobSplit: '不会自动按建议处理。你确认前，暂停的部分不会做。',
  chiefRole: '有事先找我',
  chiefTag: '全队入口',
  chiefPlaceholder: '交代一件事。需要你拿主意的地方，总管会先和你对齐再开工。',
  sealLabel: '已盖章：定',
  revisionToggleHint: '查看改动',
  revisionLocked: '固定',
  sketchScreens: '草图：页面线框',
  sketchFlow: '草图：流程',
  sketchConcept: '草图：概念',
  sketchLinks: '连线',
  chiefPendingStatus: '等你确认约定。确认前不会开工。',
  /** P74h-m1 第 6 处：待确认的约定卡带两栏时用这一句（工作是照常在做的，只暂停被改动涉及的部分）。 */
  chiefPendingJobSplitStatus: '等你确认约定。确认前，暂停的部分不会做。',
  /** P74i：带「确认后这件事停止」一行（stopLine）的待确认约定用这一句（新编号登记，不改已有编号的原文）。 */
  chiefPendingStopStatus: '等你确认约定。确认后这件事停止。',
  /** P74i：带 stopLine 的待确认约定在「待你处理」里的说明（新编号登记）。 */
  noAutoAdoptStop: '不会自动按建议处理。你确认后这件事停止；确认前照常在做。',
  /** P73f：有待确认的组队卡时，总管私聊顶部状态行的文字；与上一行同一个位置、同一种写法，两种卡不会同时待确认。 */
  chiefPendingTeamStatus: '等你确认组队卡。确认前没有员工入职。',
} as const

/** 「其余 N 项与上一版相同」：第 2 版起待确认卡里没有改动的待定项收成这一行。 */
export function unchangedPendingText(count: number): string {
  return `其余 ${count} 项与上一版相同`
}

/** 「除上面标出的改动外，与第 N 版相同。」：没有改动的几块内容收成这一行，N 是上一版的版本号。 */
export function unchangedRestText(previousNo: number): string {
  return `除上面标出的改动外，与第 ${previousNo} 版相同。`
}

/** 「删去：某某」：本版有意删掉的条目，列在「本版改动」里（P72h）。 */
export function removedLineText(text: string): string {
  return `删去：${text}`
}

/** 「第 N 版」。 */
export function versionText(no: number): string {
  return `第 ${no} 版`
}

/** 「待你定（N 项）」。 */
export function pendingTitle(count: number): string {
  return `待你定（${count} 项）`
}

/**
 * P76j：约定卡「预计消耗」的 headline 里只把数字（含 K、M、B、T 单位）加粗显示，
 * 其余文字保持正文样式。返回按顺序拼的片段；不做任何改写，只决定哪几段加粗。
 */
export function estimateHeadlineParts(text: string): Array<{ text: string; strong: boolean }> {
  const out: Array<{ text: string; strong: boolean }> = []
  const pattern = /(\d+(?:\.\d+)?[KMBT]?)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    if (start > last) out.push({ text: text.slice(last, start), strong: false })
    out.push({ text: match[0], strong: true })
    last = start + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), strong: false })
  return out
}

/** 「我已定的（N 项）」。 */
export function decidedTitle(count: number): string {
  return `我已定的（${count} 项）`
}

/** 「改过 N 次，查看改动」。 */
export function revisionToggleText(count: number): string {
  return `改过 ${count} 次，查看改动`
}

/** 「已固定 时间」；没有时间文字时只写「已固定」。 */
export function lockedStateText(lockedText: string | null): string {
  return lockedText === null || lockedText === '' ? '已固定' : `已固定 ${lockedText}`
}

/** 「已由第 M 版取代」。 */
export function supersededStateText(by: number | null): string {
  return by === null ? '已被取代' : `已由第 ${by} 版取代`
}

/** 「已被第 M 版替换」。 */
export function replacedStateText(by: number | null): string {
  return by === null ? '已被替换' : `已被第 ${by} 版替换`
}

/** 「这次你采纳了总管 T 条建议中的 A 条。」 */
export function adoptionText(adopted: number, total: number): string {
  return `这次你采纳了总管 ${total} 条建议中的 ${adopted} 条。`
}

/** 「累计默契度 X / Y」。 */
export function rapportText(adopted: number, total: number): string {
  return `累计默契度 ${adopted} / ${total}`
}

/**
 * 采纳一行：「这次你采纳了总管 T 条建议中的 A 条。累计默契度 X / Y。」
 * rapport 为 null 时省略后半句；没有 adoption 时不显示（返回 null）。
 */
export function adoptionLine(card: Pick<AgreementCardView, 'adoption' | 'rapport'>): string | null {
  if (card.adoption === null) return null
  const head = adoptionText(card.adoption.adopted, card.adoption.total)
  return card.rapport === null ? head : `${head}${rapportText(card.rapport.adopted, card.rapport.total)}。`
}

/** 版本状态标签：待你确认、已固定 时间、已由第 M 版取代、已被第 M 版替换。 */
export function stateLabelOf(card: Pick<AgreementCardView, 'state' | 'supersededBy' | 'lockedText'>): string {
  switch (card.state) {
    case 'pending': return AGR_TEXT.stateLabelPending
    case 'locked': return lockedStateText(card.lockedText)
    case 'superseded': return supersededStateText(card.supersededBy)
    case 'replaced': return replacedStateText(card.supersededBy)
  }
}

// ---------------------------------------------------------------------------
// 二、选择：预选建议项、提交参数
// ---------------------------------------------------------------------------

/** 每个待定项当前选了哪一项：key → 选项原文。 */
export type AgreementChoices = Record<string, string>

/** 初始选择：每项取建议项（点「定了」时不改就等于采纳全部建议）。 */
export function initialChoices(card: Pick<AgreementCardView, 'pending'>): AgreementChoices {
  const out: AgreementChoices = {}
  for (const item of card.pending) out[item.key] = item.suggested
  return out
}

/**
 * 提交参数里的 choices：以当前选择为准，没改的项取建议项。
 * 选择里出现了不在选项里的值（例如视图刷新后选项变了）一律退回建议项，不把脏值交给 core。
 */
export function submitChoices(card: Pick<AgreementCardView, 'pending'>, picked: AgreementChoices): AgreementChoices {
  const out: AgreementChoices = {}
  for (const item of card.pending) {
    const value = picked[item.key]
    out[item.key] = value !== undefined && item.options.includes(value) ? value : item.suggested
  }
  return out
}

/**
 * 某个待定项当前应显示选中的选项：
 * 已固定的卡用 core 记下的 chosen；还在选的卡用当前选择；两者都没有退回建议项。
 */
export function selectedOptionOf(
  item: AgreementCardView['pending'][number],
  picked: AgreementChoices,
  locked: boolean,
): string {
  if (locked && item.chosen !== null) return item.chosen
  const value = picked[item.key]
  return value !== undefined && item.options.includes(value) ? value : item.suggested
}

// ---------------------------------------------------------------------------
// 三、改动标记、草图圆圈
// ---------------------------------------------------------------------------

/** 一块内容是不是「本版改动」处：changed 或 added 任一为真。 */
export function isChangedItem(item: { changed?: boolean; added?: boolean }): boolean {
  return item.changed === true || item.added === true
}

/**
 * 待确认的第 2 版及以后默认只显示改动（P72g B3）：你要看的是和上一版比哪里变了，不是把整张卡再读一遍。
 * applies 为假（第 1 版，或不是待确认）时按原样整张展开。
 * 规则：
 * - 「本版改动」、一句话、草图始终显示；
 * - 待你定里有改动的项照常显示，没有改动的收成一行「其余 N 项与上一版相同」（N 为没改动的项数）；
 * - 「我已定的」「这次做与这次不做」「怎样算做完」三块：整块没有任何改动才收起，有改动的整块照常显示；
 * - 只要收起了任何东西，卡片底部给一行「除上面标出的改动外，与第 N 版相同」和「展开全文」。
 */
export interface CondensedPlan {
  applies: boolean
  /** 待你定里没有改动的项数；0 表示没有这一行。 */
  unchangedPending: number
  showDecided: boolean
  showScope: boolean
  showDoneWhen: boolean
  /** 有任何内容被收起（决定底部那行提示和按钮要不要出现）。 */
  anyFolded: boolean
}

export function condensedPlan(card: Pick<AgreementCardView, 'state' | 'versionNo' | 'pending' | 'decided' | 'scopeIn' | 'scopeOut' | 'doneWhen' | 'removedUnlisted'>): CondensedPlan {
  // P72h：只有「本版改动」确实覆盖了全部差异，才敢写「除上面标出的改动外，与第 N 版相同」。
  // 有删除条目但没记下原文（removedUnlisted 大于 0，旧数据）时，改动区说不全，整张卡照原样展开，不写这句话。
  // 有意删去的条目（removed）已经逐条列在「本版改动」里，算已覆盖。
  const applies = card.state === 'pending' && card.versionNo > 1 && card.removedUnlisted === 0
  if (!applies) {
    return { applies: false, unchangedPending: 0, showDecided: true, showScope: true, showDoneWhen: true, anyFolded: false }
  }
  const unchangedPending = card.pending.filter(item => !isChangedItem(item)).length
  // 整块没有内容时本来就不画，不算「收起」。
  const folds = (items: ReadonlyArray<{ changed?: boolean }>): boolean => items.length > 0 && !items.some(item => item.changed === true)
  const showDecided = !folds(card.decided)
  const showScope = !(folds([...card.scopeIn, ...card.scopeOut]))
  const showDoneWhen = !folds(card.doneWhen)
  return {
    applies, unchangedPending, showDecided, showScope, showDoneWhen,
    anyFolded: unchangedPending > 0 || !showDecided || !showScope || !showDoneWhen,
  }
}

/** 草图里有没有任何圆圈数字：有才在草图小标题后注明「圆圈数字对应下方待你定的事项」。 */
export function sketchHasMark(sketch: AgreementSketchValue): boolean {
  if (sketch.screens?.some(screen => screen.blocks.some(block => block.mark !== undefined)) === true) return true
  if (sketch.steps?.some(step => step.mark !== undefined) === true) return true
  if (sketch.nodes?.some(node => node.mark !== undefined) === true) return true
  return false
}

/** 概念草图的连线文字：「A → B：文字」；节点 id 对不上时退回 id 原文。 */
export function conceptLinkTexts(sketch: AgreementSketchValue): string[] {
  const nameOf = new Map((sketch.nodes ?? []).map(node => [node.id, node.text] as const))
  return (sketch.links ?? []).map(link => {
    const head = `${nameOf.get(link.from) ?? link.from} → ${nameOf.get(link.to) ?? link.to}`
    return link.text !== undefined && link.text !== '' ? `${head}：${link.text}` : head
  })
}

// ---------------------------------------------------------------------------
// 四、修订记录的一行
// ---------------------------------------------------------------------------

/** 句末已经有标点就不再补句号。 */
function withPeriod(text: string): string {
  const trimmed = text.trim()
  return /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`
}

/**
 * 修订记录的一行，例如：
 * 「第 2 版 11月11日 15:39 固定 报名信息加入「公司名（选填）」。来源：你在对齐时的修改。」
 * 已固定的版本在时间后面加「固定」；来源标签为空就不写。
 */
export function revisionLineText(row: AgreementRevisionRow): string {
  const head = `${versionText(row.no)} ${row.timeText}${row.locked ? ` ${AGR_TEXT.revisionLocked}` : ''}`
  const source = row.sourceLabel.trim() === '' ? '' : withPeriod(row.sourceLabel)
  return `${head} ${withPeriod(row.text)}${source}`
}

// ---------------------------------------------------------------------------
// 五、印章
// ---------------------------------------------------------------------------

/**
 * 印章上的日期「月.日」，例如「11.11」。
 * 优先从 core 给的 lockedText（「11月11日 15:39」）里取，这样和卡片上显示的是同一个日期；
 * 取不到再用时间戳（按本机时区）；两者都没有返回空串，印章不写日期。
 */
export function stampDateText(card: Pick<AgreementCardView, 'lockedText' | 'lockedAt'>): string {
  const match = card.lockedText === null ? null : /(\d{1,2})月(\d{1,2})日/.exec(card.lockedText)
  if (match !== null) return `${Number(match[1])}.${Number(match[2])}`
  if (card.lockedAt === null) return ''
  const date = new Date(card.lockedAt)
  return `${date.getMonth() + 1}.${date.getDate()}`
}

/**
 * 这一次渲染要不要播落章动效：
 * 只有「上一次是待确认、这一次变成已固定」才播；系统要求减少动态效果时不播；
 * 页面加载时就已经是已固定（上一次也是已固定）的卡直接显示静态印章。
 */
export function shouldPlayStamp(
  prevState: AgreementVersionState | null,
  nextState: AgreementVersionState,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion) return false
  return prevState === 'pending' && nextState === 'locked'
}

/** 读系统的「减少动态效果」设置；读不到（没有 matchMedia 的环境）按「不减少」处理。 */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 六、总管置顶与私聊占位
// ---------------------------------------------------------------------------

/** 名册里需要的最小字段。P74i：总管的 chiefJobLine（名下进行中的事的一句话，core 给的）可选。 */
interface ChiefLike { role: string; lifecycle: string; staffStatus?: string; archived?: boolean; chiefJobLine?: string | null }

/** 是不是在册的总管：未归档的总管才置顶，已归档的总管按普通员工沉底（P73f：旧的退役判断统一为归档）。 */
export function isChiefEntry(bot: ChiefLike): boolean {
  if (bot.staffStatus !== undefined) return bot.role === 'chief' && bot.staffStatus !== 'archived'
  return bot.role === 'chief' && bot.lifecycle !== 'retired' && bot.archived !== true
}

/**
 * 员工列表：未归档的总管永远排第一，其余员工保持原来的相对顺序（稳定）。
 * 只改展示顺序，不改 core 数据；没有总管时返回和原来顺序完全一致的新数组。
 */
export function chiefFirst<T extends ChiefLike>(bots: readonly T[]): T[] {
  return [...bots.filter(isChiefEntry), ...bots.filter(bot => !isChiefEntry(bot))]
}

/**
 * 员工行第二行：总管写「有事先找我」，其余是角色标签，后面接员工状态（设计稿 A4「工程师　在岗」，
 * 停用的写「停用」）。旧形状的数据没有状态标签时只写角色标签。
 * P74i：总管名下有进行中的事时（chiefJobLine 不为 null），角色行改用它（core 给的现成一句话，
 * 如「活动报名页　核对中」或「3 件在办」）。「等你确认约定」「等你确认新员工」这类等你的状态
 * 在左栏是名字旁的「待确认」标签（waitingOwner），不占角色行，因此不存在优先级冲突；
 * 没有进行中的事（字段为 null）保持「有事先找我」。
 */
export function roleLineOf(bot: ChiefLike & { roleLabel: string; templateLabel?: string | null; staffStatusLabel?: string }): string {
  if (isChiefEntry(bot)) return bot.chiefJobLine ?? AGR_TEXT.chiefRole
  const role = displayRoleLabel(bot)
  return bot.staffStatusLabel === undefined || bot.staffStatusLabel === '' ? role : `${role}　${bot.staffStatusLabel}`
}

/**
 * P73r4：员工在左栏、右侧栏、编辑弹窗标题、对话顶部显示的角色。
 * 由模板创建且模板有显示标签的（评审员的「评审」）显示模板标签，其余照旧显示角色标签，各处写法一致。
 */
export function displayRoleLabel(bot: { roleLabel: string; templateLabel?: string | null }): string {
  return bot.templateLabel !== undefined && bot.templateLabel !== null && bot.templateLabel !== '' ? bot.templateLabel : bot.roleLabel
}

/**
 * 这条线程里有没有「等你确认」的约定卡（P72g B5）：总管私聊顶部据此把状态行换成
 * 「等你确认约定。确认前不会开工。」。只看最新版、还能点「定了」的那张（canConfirm）。
 */
export function hasPendingAgreement(messages: ReadonlyArray<{ agreement?: Pick<AgreementCardView, 'canConfirm' | 'state'> | null }>): boolean {
  return messages.some(message => message.agreement?.canConfirm === true && message.agreement.state === 'pending')
}

/**
 * 待确认的约定卡是否带两栏（jobSplit 不为空，P74h-m1 第 6 处）：
 * 约定有一件正在做的事、新版本在等确认时，工作是照常在做的（只暂停被改动涉及的部分），
 * 状态行与「待你处理」里的说明要用与之相符的句子。只看还能点「定了」的那张（canConfirm）。
 */
export function pendingAgreementHasJobSplit(
  messages: ReadonlyArray<{ agreement?: Pick<AgreementCardView, 'canConfirm' | 'state' | 'jobSplit'> | null }>,
): boolean {
  return messages.some(message => message.agreement?.canConfirm === true
    && message.agreement.state === 'pending' && message.agreement.jobSplit != null)
}

/** 总管私聊顶部状态行的文字：带「确认后这件事停止」一行的用停止那句，带两栏的用「暂停的部分不会做」那句，否则用原句。 */
export function chiefPendingStatusOf(
  messages: ReadonlyArray<{ agreement?: Pick<AgreementCardView, 'canConfirm' | 'state' | 'jobSplit' | 'stopLine'> | null }>,
): string {
  const stop = messages.some(message => message.agreement?.canConfirm === true
    && message.agreement.state === 'pending' && message.agreement.stopLine != null)
  if (stop) return AGR_TEXT.chiefPendingStopStatus
  return pendingAgreementHasJobSplit(messages) ? AGR_TEXT.chiefPendingJobSplitStatus : AGR_TEXT.chiefPendingStatus
}

/**
 * 这条线程里有没有「等你确认」的组队卡（P73f）：总管私聊顶部据此把状态行换成
 * 「等你确认组队卡。确认前没有员工入职。」，与约定卡待确认时是同一个位置、同一种写法。
 * 只看状态为待确认（pending）的卡；确认、不新增、已撤下的卡不算。
 */
export function hasPendingTeamCard(messages: ReadonlyArray<{ teamCard?: { state: string } | null }>): boolean {
  return messages.some(message => message.teamCard?.state === 'pending')
}

/**
 * 私聊输入框的占位：总管用「交代一件事……」那句，其他员工仍是「向 名字 发送消息…」。
 * chief 为真且不是项目主题时才用新句子（主题里的占位由主题自己决定）。
 */
export function composerPlaceholder(input: { chief: boolean; name: string }): string {
  return input.chief ? AGR_TEXT.chiefPlaceholder : `向 ${input.name} 发送消息…`
}
