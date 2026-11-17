/**
 * 卡片作答的提交规则（D06 第 4 条，纯函数）：
 * - 审批卡（card.approvalId 非 null）→ decideApproval(approvalId, option === '批准', note)；
 *   千万不能把 inboxId 当 approvalId。
 * - 其他卡（提议 / 提问 / 告警）→ answerInbox(inboxId, option)，原样回传用户点的那一项。
 * - 提问卡的自由文本同样走 answerInbox（core 接受选项以外的非空回答）。
 * - P74i：一件事在「待你处理」里的四类条目（验收、向主人说明、回合上限、停住了）同样走
 *   answerInbox——core 的 answerJobInbox 按事项键把它们分流到 acceptJob / chooseJobOption /
 *   answerJobCap / answerJobStall（插件视图不带事项键，见 docs/questions.md）。
 */
import type { ThreadMessageView } from '../../shared/views.js'
import { AGR_TEXT } from './agreement.js'
import { JOB_TEXT } from './job.js'
import { TEAM_TEXT } from './team-card.js'

/**
 * 与 Cards.tsx 的 CardPayload 同一形状（线程内嵌卡片）。
 * P72：待你处理里的约定确认条目会带 agreementId，界面据此隐藏自由文本输入、改写有效期那一行；
 * 普通卡片没有这个字段。
 */
export type CardPayload = NonNullable<ThreadMessageView['card']> & {
  agreementId?: string | null
  teamProposalId?: string | null
  /**
   * P75r7：这张卡画的是「待你处理」里的条目（由 itemToCard 带入）；线程里的卡不带。
   * 学习选会话卡据此区分：「待你处理」里保留自由文本输入框（主人可以不选会话、自己写一句别的话，决策 DC64），线程里的不保留。
   */
  fromInbox?: boolean
  /** P74r4b/P74i-m1（第二次）：一件事的四类条目带 jobEntry（哪一类、属于哪件事）；界面据此显示对应操作。 */
  jobEntry?: { kind: JobEntryKind; jobId: string } | null
  /** P74h-m1 第 6 处：约定确认条目对应的待确认卡是否带两栏（有正在做的事）；
   *  有效期的说明据此换成「你确认前，暂停的部分不会做。」那句。 */
  agreementJobSplit?: boolean | null
  /** P74i：约定确认条目对应的待确认卡是否带「确认后这件事停止」一行（stopLine）；
   *  说明换成「你确认后这件事停止；确认前照常在做。」那句（优先于两栏那句）。 */
  agreementStop?: boolean | null
  /** P74r16b/P74i-m7：「员工被中心停用」的告警条目带恢复入口（核心只在这位员工此刻仍被中心停用时给出）；卡片据此多画「恢复在岗」按钮。 */
  reinstate?: { botId: string; botName: string; answer: 'reinstate' } | null
}

/** P74i-m7：告警条目上「恢复在岗」按钮的文字（登记在 docs/copy 的 JOB-137）。 */
export const REINSTATE_BUTTON_LABEL = '恢复在岗'

/** 这张卡有没有恢复入口：告警卡且带 reinstate 才有；没有时卡片与原来完全一样。 */
export function reinstateOf(card: Pick<CardPayload, 'type' | 'reinstate'>): NonNullable<CardPayload['reinstate']> | null {
  return card.type === 'alert' && card.reinstate != null ? card.reinstate : null
}

/** 这张卡是不是约定确认条目。 */
export function isAgreementCard(card: Pick<CardPayload, 'agreementId'>): boolean {
  return typeof card.agreementId === 'string' && card.agreementId !== ''
}

/** P75r7：这张卡是不是学习选会话卡（带学习记录编号）。线程里和「待你处理」里的都是。 */
export function isLearnCard(card: Pick<CardPayload, 'learnRunId'>): boolean {
  return typeof card.learnRunId === 'string' && card.learnRunId !== ''
}

/** P75r7：这张卡是不是来自「待你处理」（由 itemToCard 带入）。学习卡据此决定显示不显示自由文本输入框。 */
export function isInboxLearnCard(card: Pick<CardPayload, 'learnRunId' | 'fromInbox'>): boolean {
  return isLearnCard(card) && card.fromInbox === true
}

/** P73e：这张卡是不是组队确认条目。组队条目只有一个按钮，没有自由文本，不到期，不会自动入职。 */
export function isTeamCard(card: Pick<CardPayload, 'teamProposalId'>): boolean {
  return typeof card.teamProposalId === 'string' && card.teamProposalId !== ''
}

/**
 * P74i/P74i-m1（第二次，任务卡 1.3）：「待你处理」里一件事的条目有四类（验收、向主人说明、
 * 回合上限、没有进展）。P74r4b 起视图带 jobEntry（core 按事项键判断，与回答时分流同一套），
 * 界面只看 jobEntry.kind，不再按按钮文字的形状猜（P74r5 改了几句按钮文字，按文字猜会失灵）。
 * 没有 jobEntry 的条目（按钮文字形状相同也一样）按普通条目处理，返回 null。
 */
export type JobEntryKind = 'accept' | 'escalate' | 'cap' | 'stall'

export function jobEntryKindOf(card: Pick<CardPayload, 'jobEntry'>): JobEntryKind | null {
  const entry = card.jobEntry
  if (entry === null || entry === undefined) return null
  return entry.kind === 'accept' || entry.kind === 'escalate' || entry.kind === 'cap' || entry.kind === 'stall' ? entry.kind : null
}

/**
 * 审批卡的结构化内容（P69，core 的 ApprovalCardParts 同形）：
 * 一句人话、原因、风险提示、原始命令（最多 300 字），P74g 起多三行说明（费用、能否撤回、
 * 批准之后，core 保证每项有文字）与「由{员工}执行」一行；旧审批记录没有这些字段。
 */
export interface ApprovalParts {
  actionText: string
  ownerReason: string | null
  riskNote: string | null
  argsPreview: string
  /** P74r20：命令全文（可省略）；展开「查看原始命令」时优先显示，没有（旧数据）就显示 argsPreview。 */
  argsFull?: string
  /** P74g：三行说明；C、D 类审批有，其他类别（和旧记录）为 null。 */
  notes: { cost: string; undo: string; after: string } | null
  /** P74g：「由{员工}执行」一行；属于一件事的审批才有，否则 null。 */
  onBehalfOf: string | null
  /** P74r4b：这是某件事「发布这一步」的审批；按钮写「批准发布」「暂不发布」，答复处理不变。 */
  launch: boolean
  /** P74r4b-m1：中心作废的审批（界面写「已作废」，不给按钮）。 */
  voided: boolean
}

/** 一次作答要执行的命令（name + input 直接交给 hub.command）。 */
export interface CardSubmission { name: 'decideApproval' | 'answerInbox' | 'chooseLearnSession'; input: Record<string, unknown> }

/** 审批选项的判定：视图给的 options 是 ['批准','拒绝']，点「批准」才算 approve。 */
export function isApproveOption(option: string): boolean { return option === '批准' }

/**
 * 卡片剩余有效期的含义（D07 第 18 条，规格第 5 节过期规则：提问 72 小时、审批
 * 24 小时、提议 7 天）：时间后面要说清「过了会怎样」，不能只给一个时间点。
 */
export function expiryMeaningOf(card: CardPayload): string | null {
  // P72：约定确认条目到期不会自动按建议处理（否则到期自动开工就绕过了「定了」这道闸），固定写这一句。
  // P74h-m1 第 6 处：那张待确认卡带两栏时，工作是照常在做的，换成「暂停的部分不会做。」那句。
  // P74i：那张待确认卡带「确认后这件事停止」一行时，换成「你确认后这件事停止；确认前照常在做。」那句。
  if (isAgreementCard(card)) {
    if (card.agreementStop === true) return AGR_TEXT.noAutoAdoptStop
    return card.agreementJobSplit === true ? AGR_TEXT.noAutoAdoptJobSplit : AGR_TEXT.noAutoAdopt
  }
  // P73e：组队确认条目不到期、没有默认处理，固定写「不会自动入职」。
  if (isTeamCard(card)) return TEAM_TEXT.inboxNoAuto
  // P74i：一件事的四类条目没有期限、没有默认选项，不显示任何「到期」文字。
  if (jobEntryKindOf(card) !== null) return null
  if (card.expiresText === null || card.expiresText === '') return null
  // 视图可能已经带上了后果说明（样例数据、旧版本或后续接口变化），
  // 再拼一遍会得到「今晚 20:00 前有效前有效，过期视为拒绝」这种重复句。
  if (/前有效|按默认|自动撤回|前未答复|视为拒绝/.test(card.expiresText)) return card.expiresText
  // 视图给的时间常以「后」结尾（如「72 小时后」）；拼「…前」前先去掉，避免「后前」。
  const at = card.expiresText.endsWith('后') ? card.expiresText.slice(0, -1) : card.expiresText
  if (card.type === 'question') {
    const fallback = card.defaultOption ?? '默认选项'
    return `${at}前未答复按默认「${fallback}」处理`
  }
  if (card.type === 'approval') return `${at}前有效，过期视为拒绝`
  if (card.type === 'proposal') return `${at}前未答复自动撤回`
  return card.expiresText // 告警：恢复即关闭，没有固定时限
}

/**
 * 卡片结果文字（D07 第 11 条）：只有主人亲手作答才写「已选：X」——过期按默认
 * 处理、提议到期撤回、中心关闭的告警都不是主人选的，照实写。
 */
export function cardResultText(card: CardPayload): string | null {
  if (card.status === 'answered') {
    // P74i-m3（第 6 节）：发布审批的按钮写「批准发布」「暂不发布」，答案原文仍是「批准」「拒绝」；
    // 结果文字与按钮用词一致。普通审批和其他卡不变。
    if (approvalPartsOf(card)?.launch === true) {
      if (card.answer === '批准') return `已选：${JOB_TEXT.approvalLaunchApprove}`
      if (card.answer === '拒绝') return `已选：${JOB_TEXT.approvalLaunchDecline}`
    }
    return `已选：${card.answer ?? '已处理'}`
  }
  if (card.status === 'expired') return `已过期，已按默认：${card.answer ?? '默认选项'}`
  if (card.status === 'withdrawn') return '已撤回'
  if (card.status === 'closed') return '已关闭'
  return null // open：还没结果
}

/** 算出一张卡某个选项对应的提交命令；非法输入返回中文错误。 */
export function cardSubmission(card: CardPayload, option: string, note?: string): CardSubmission | { error: string } {
  const picked = option.trim()
  if (picked === '') return { error: '回答：不能为空' }
  // P75r7（B6）：总管私聊线程里的学习选会话卡（带学习记录编号、不是来自「待你处理」）点选项时调用 chooseLearnSession，
  // 审计里记的入口就是这张提问卡；「待你处理」里的同一类条目仍走 answerInbox（核心按 learn: 分流，自由文本也只能走这条）。
  if (isLearnCard(card) && card.fromInbox !== true) return { name: 'chooseLearnSession', input: { runId: card.learnRunId as string, option: picked } }
  if (card.type === 'approval') {
    if (card.approvalId === null) {
      // 旧数据没有审批 id：按 core 的兼容路径走 answerInbox（core 会委托唯一的审批记录）。
      return { name: 'answerInbox', input: { id: card.inboxId, answer: picked } }
    }
    return { name: 'decideApproval', input: { id: card.approvalId, approve: isApproveOption(picked), ...(note !== undefined && note !== '' ? { note } : {}) } }
  }
  // P79：提议可以附一句话（可不填）；核心去掉首尾空白并限制 200 字，这里只在非空时带上。
  if (card.type === 'proposal' && note !== undefined && note.trim() !== '') {
    return { name: 'answerInbox', input: { id: card.inboxId, answer: picked, note: note.trim() } }
  }
  return { name: 'answerInbox', input: { id: card.inboxId, answer: picked } }
}

/**
 * 从卡片里取出可信的审批结构化内容；缺失或形状不对（旧记录、异常数据）返回 null，
 * 界面就退回显示原来的标题和正文，不报错。
 */
export function approvalPartsOf(card: { type: string; approval?: unknown }): ApprovalParts | null {
  if (card.type !== 'approval') return null
  const a = card.approval as Partial<ApprovalParts> | undefined | null
  if (a === undefined || a === null || typeof a !== 'object' || typeof a.actionText !== 'string' || a.actionText === '') return null
  const notes = a.notes as Partial<{ cost: string; undo: string; after: string }> | null | undefined
  return {
    actionText: a.actionText,
    ownerReason: typeof a.ownerReason === 'string' && a.ownerReason !== '' ? a.ownerReason : null,
    riskNote: typeof a.riskNote === 'string' && a.riskNote !== '' ? a.riskNote : null,
    argsPreview: typeof a.argsPreview === 'string' ? a.argsPreview : '',
    // 只在有命令全文时才带这一项（旧数据没有，保持原来的形状）。
    ...(typeof a.argsFull === 'string' && a.argsFull !== '' ? { argsFull: a.argsFull } : {}),
    // 三行说明：三项都是非空字符串才算有（core 保证 C、D 类一定给全）。
    notes: notes != null && typeof notes.cost === 'string' && typeof notes.undo === 'string' && typeof notes.after === 'string'
      ? { cost: notes.cost, undo: notes.undo, after: notes.after } : null,
    onBehalfOf: typeof a.onBehalfOf === 'string' && a.onBehalfOf !== '' ? a.onBehalfOf : null,
    // P74r4b/P74i-m1（第二次）：发布审批与已作废的标记（旧记录与样例数据缺省按否）。
    launch: a.launch === true,
    voided: a.voided === true,
  }
}
