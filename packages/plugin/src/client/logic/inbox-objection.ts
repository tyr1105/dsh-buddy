/**
 * 「待你处理」里当场表示不同意并写一句话（P79，纯函数与文字）。
 *
 * 背景：约定确认、组队确认、验收、说明卡这四种条目原来只有确认按钮，主人在这一页里没有任何
 * 表示不同意的办法。现在每种条目多一个次要按钮（要修改、有不符、都不合适），点开写一句话，
 * 这句话等同于主人在对应的对话里亲口说的话：界面只调用输入框发消息用的那条路径（sendMessage），
 * 不新造「拒绝」记录，不改变约定、组队、验收现有的流程；总管照平常收到主人的话那样处理。
 *
 * 这个文件只做两件事：
 * 1. 判断某个条目有没有这个次要按钮、用哪一组文字、话该发到哪一条对话（objectionOf）；
 * 2. 记住「你已提出修改。」这一行（界面这一次打开期间有效，按条目编号加条目内容记，内容变了就不再显示）。
 *
 * 发到哪条对话，依据是「那张卡出现在哪条对话里」（核心发卡的位置）：
 * - 约定确认：约定卡发在 originThread，即总管的私聊（core project/agreement-cards.ts 的 postPendingVersion），
 *   所以即使条目带着主题编号（约定条目总带着），也发总管私聊；与「查看对话」的去向同一规则（feeds.ts 的 inboxThreadId）；
 * - 组队确认：组队卡发在总管的私聊（core team/cards.ts）；
 * - 说明卡：说明卡发在总管的私聊（core job/escalate.ts），条目虽带主题编号，也发总管私聊；
 * - 验收：交付卡发在这件事的主题里（core job/deliver.ts），发条目的主题。
 */
import type { InboxItemView } from '../../shared/views.js'

/** 一种条目用的一组文字。 */
export interface ObjectionSpec {
  /** 次要按钮上的字。 */
  buttonLabel: string
  /** 输入框的可达名称与占位文字（同一句）。 */
  fieldLabel: string
  /** 发送成功后，条目上多出的那一行。 */
  pendingLine: string
  /** 发送成功后，页面顶上的提示。 */
  successNotice: string
}

/**
 * 四种条目各自的文字（逐字登记在 docs/copy/strings.json，编号前缀 JOB-）。
 * P74i-m4（第 1 节）：「已提出……」那一行与成功提示只写主人自己做过的事，不替别人预告下一步
 * （原来写「在等总管出新一版」，条目内容变了之后就与事实不符；发到主题后被叫醒的也不一定是总管）。
 */
export const OBJECTION_TEXT = {
  agreement: {
    buttonLabel: '要修改',
    fieldLabel: '哪里要改，写一句',
    pendingLine: '你已提出修改。',
    successNotice: '已把这句话发给总管。',
  },
  accept: {
    buttonLabel: '有不符',
    fieldLabel: '第几条、什么问题',
    pendingLine: '你已指出不符。',
    successNotice: '已发到这件事的主题里。',
  },
  escalate: {
    buttonLabel: '都不合适',
    fieldLabel: '哪里不合适，写一句',
    pendingLine: '你已说明都不合适。',
    successNotice: '已把这句话发给总管。',
  },
} as const satisfies Record<string, ObjectionSpec>

/** 输入框旁两个按钮的文字（与卡片、弹窗里已有的「发送」「取消」同一说法）。 */
export const OBJECTION_SEND = '发送'
export const OBJECTION_CANCEL = '取消'

/** 组队确认条目发给总管的话前面的说明（条目没有可用的标题，写固定一句）。 */
export const TEAM_OBJECTION_PREFIX = '（关于组队方案）'

/**
 * 一个条目的次要按钮当前是否可用（P74i-m4，第 2 节）：
 * - none：正常可用；
 * - submitting：这个条目正在提交确认、选办法或验收，次要按钮与输入框禁用（避免与刚确认的事实相反）；
 * - done：已经处理完，次要按钮与输入框不再显示。
 * 反过来的方向不变：发了修改意见之后，确认按钮仍然可点。
 */
export type ObjectionLock = 'none' | 'submitting' | 'done'

/** 一个条目的判断结果：用哪组文字、话发到哪条对话、话前面由界面拼上的说明。 */
export interface ObjectionTarget {
  spec: ObjectionSpec
  /** 话发到的线程编号（总管的私聊或主题）。 */
  threadId: string
  /**
   * P74i-m4（第 3 节）：发出去的文字 = prefix + 主人写的话。
   * 发到总管私聊的三种条目带「（关于……）」，让总管看得出这句话针对哪一条；验收发在这件事自己的主题里，为空。
   */
  prefix: string
}

/** 非空字符串判断。 */
function filled(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * 约定确认条目发给总管的话前面的说明（P74i-m5，第 1 节，走查 N-1）。
 * 核心 P74r14 在条目视图上给出 agreementTitle（约定的标题）和 agreementVersion（版本号），
 * 前缀写成「（关于约定「{标题}」第 {版本号} 版）」，例如「（关于约定「活动报名页」第 2 版）」；
 * 原来把条目的整句标题（「约定第 2 版待你确认：活动报名页」）塞进括号，读起来不通顺，还带着「待你确认」这个状态词。
 * 旧数据没有 agreementTitle（或没有版本号）时退回原来的写法「（关于{条目标题}）」。
 */
export function agreementPrefixOf(item: Pick<InboxItemView, 'title' | 'agreementTitle' | 'agreementVersion'>): string {
  const title = item.agreementTitle
  const version = item.agreementVersion
  if (filled(title) && typeof version === 'number') return `（关于约定「${title}」第 ${version} 版）`
  return `（关于${item.title}）`
}

/**
 * 判断一个条目有没有次要按钮；没有返回 null。
 * 只看条目上的结构化字段，不看标题和正文；没有地方可发（缺少对话编号）时也返回 null。
 */
export function objectionOf(item: InboxItemView): ObjectionTarget | null {
  const kind = item.jobEntry?.kind ?? null
  // 验收：发到这件事的主题里；没有主题编号就没有地方发，不显示按钮。
  if (kind === 'accept') return filled(item.topicId) ? { spec: OBJECTION_TEXT.accept, threadId: item.topicId, prefix: '' } : null
  // 说明卡：只有「还可以选」的卡（没选过、没失效）才有；已选或失效的卡不显示。发到总管的私聊，话前带上这张卡的标题。
  if (kind === 'escalate') {
    const card = item.escalationCard
    if (card === null || card === undefined) return null
    if (card.chosen !== null || card.selectable === false) return null
    return filled(item.botId) ? { spec: OBJECTION_TEXT.escalate, threadId: item.botId, prefix: `（关于${item.title}）` } : null
  }
  // 回合上限、没有进展：本卡不加按钮。
  if (kind !== null) return null
  // 约定确认、组队确认：都发到总管的私聊（条目的员工就是总管）；约定带条目标题，组队写固定的「组队方案」。
  if (filled(item.agreementId) || filled(item.teamProposalId)) {
    if (!filled(item.botId)) return null
    const prefix = filled(item.agreementId) ? agreementPrefixOf(item) : TEAM_OBJECTION_PREFIX
    return { spec: OBJECTION_TEXT.agreement, threadId: item.botId, prefix }
  }
  return null
}

/**
 * 「已提出……」这一行的记忆键：条目编号加条目内容（P74i-m4，第 1 节）。
 * 内容 = 标题、正文、选项、版本号（约定取约定版本号，组队取组队卡编号，说明卡取说明的修订号）。
 * 为什么带内容：总管改组队方案、改说明时是在原来那条条目上就地改，条目编号与版本号都不变，
 * 只用编号加版本号，新方案已经出来了，这一行还在，说的就不是现在这一版；
 * 内容中任何一样变了，键就变，旧的记忆不再对应当前条目，这一行也就不再显示。
 * 约定条目每一版都是新条目，本来就没有这个问题。
 */
export function objectionKey(item: InboxItemView): string {
  const card = item.escalationCard
  const version = item.agreementVersion ?? item.teamProposalId ?? (card !== null && card !== undefined ? card.revision ?? 0 : '')
  // 用 JSON 序列化拼成一个键：各部分有明确边界，不会因为内容里含分隔符而误判相同。
  return JSON.stringify([item.id, version, item.title, item.body, item.options])
}

/**
 * 已发送过的记录（模块级）：键是 objectionKey，值是条目上要多显示的那一行。
 * 只存在于界面这一次打开期间：重新打开界面后这一行不在（已知的局限，见 docs/progress/P79.md）。
 * 放在组件外是因为「待你处理」页离开再回来时组件会重新挂载，组件内的状态会丢。
 */
const sentLines = new Map<string, string>()

/** 读某个条目当前版本上记下的那一行；没有返回 null。 */
export function sentLineOf(key: string): string | null {
  return sentLines.get(key) ?? null
}

/** 记下某个条目当前版本已发送过。 */
export function rememberSent(key: string, line: string): void {
  sentLines.set(key, line)
}

/** 清空记录（测试用，保证各条测试互不影响）。 */
export function clearSentLines(): void {
  sentLines.clear()
}
