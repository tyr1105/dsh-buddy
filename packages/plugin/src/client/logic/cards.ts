/**
 * 卡片作答的提交规则（D06 第 4 条，纯函数）：
 * - 审批卡（card.approvalId 非 null）→ decideApproval(approvalId, option === '批准', note)；
 *   千万不能把 inboxId 当 approvalId。
 * - 其他卡（提议 / 提问 / 告警）→ answerInbox(inboxId, option)，原样回传用户点的那一项。
 * - 提问卡的自由文本同样走 answerInbox（core 接受选项以外的非空回答）。
 */
import type { ThreadMessageView } from '../../shared/views.js'

/** 与 Cards.tsx 的 CardPayload 同一形状（线程内嵌卡片）。 */
export type CardPayload = NonNullable<ThreadMessageView['card']>

/** 一次作答要执行的命令（name + input 直接交给 hub.command）。 */
export interface CardSubmission { name: 'decideApproval' | 'answerInbox'; input: Record<string, unknown> }

/** 审批选项的判定：视图给的 options 是 ['批准','拒绝']，点「批准」才算 approve。 */
export function isApproveOption(option: string): boolean { return option === '批准' }

/**
 * 卡片剩余有效期的含义（D07 第 18 条，规格第 5 节过期规则：提问 72 小时、审批
 * 24 小时、提议 7 天）：时间后面要说清「过了会怎样」，不能只给一个时间点。
 */
export function expiryMeaningOf(card: CardPayload): string | null {
  if (card.expiresText === null || card.expiresText === '') return null
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
 * 卡片结果文字（D07 第 11 条）：只有主人亲手作答才写「你选了：X」——过期按默认
 * 处理、提议到期撤回、中心关闭的告警都不是主人选的，照实写。
 */
export function cardResultText(card: CardPayload): string | null {
  if (card.status === 'answered') return `你选了：${card.answer ?? '已处理'}`
  if (card.status === 'expired') return `已过期，已按默认：${card.answer ?? '默认选项'}`
  if (card.status === 'withdrawn') return '已撤回'
  if (card.status === 'closed') return '已关闭'
  return null // open：还没结果
}

/** 算出一张卡某个选项对应的提交命令；非法输入返回中文错误。 */
export function cardSubmission(card: CardPayload, option: string, note?: string): CardSubmission | { error: string } {
  const picked = option.trim()
  if (picked === '') return { error: '回答：不能为空' }
  if (card.type === 'approval') {
    if (card.approvalId === null) {
      // 旧数据没有审批 id：按 core 的兼容路径走 answerInbox（core 会委托唯一的审批记录）。
      return { name: 'answerInbox', input: { id: card.inboxId, answer: picked } }
    }
    return { name: 'decideApproval', input: { id: card.approvalId, approve: isApproveOption(picked), ...(note !== undefined && note !== '' ? { note } : {}) } }
  }
  return { name: 'answerInbox', input: { id: card.inboxId, answer: picked } }
}
