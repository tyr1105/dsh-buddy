/**
 * 「待你处理」里处理成功后的提示（P74i-m3，第 4 节；P74i-m5，第 3 节，纯函数）。
 *
 * 为什么单独成文件：此前所有条目处理成功后都写同一句「已提交。下一步：继续执行，负责人 {员工}。」，
 * 验收通过、拒绝、暂不发布、暂停之后也写「继续执行」，与操作之后的事实不符。
 * 现在按「条目的种类 + 主人点的按钮」给提示，句子逐字登记在 docs/copy/strings.json（编号前缀 JOB-），
 * 对话里的卡片（交付卡、说明卡、审批卡）没有这种成功提示，所以这套句子只有这一处使用，不会出现两处两种说法。
 *
 * P74i-m5（第 3 节，走查 N-4）：提示只写已经发生的事，不再写「下一步：……」——那是在预告别人接下来做什么，
 * 对「先保持」这类回答并不成立；条目上的员工名、「由……执行」也因此不再用于提示。
 *
 * 判断只看条目上的结构化字段（jobEntry.kind、approval.launch、agreementId、type）与按钮文字的
 * 固定前缀，不依赖条目标题或正文。没有列到的条目写通用句「已提交。」。
 */
import type { InboxItemView } from '../../shared/views.js'
import { isApproveOption } from './cards.js'

/** 提示用到的句子（动态部分用 {} 占位，与文案登记一致）。 */
export const INBOX_NOTICE_TEXT = {
  accepted: '已验收。',
  escalateChosen: '已提交你选的办法。',
  approved: '已批准。',
  rejected: '已拒绝，这一步不会执行。',
  launchApproved: '已批准发布。',
  launchDeclined: '已选择暂不发布，这次不会发布。',
  reminded: '已再提醒一次。',
  paused: '已暂停这件事。',
  // P74i-m4（第 5 节第 1 条）：回合数不写死，取自主人点的按钮「再给 N 个回合」；取不出数字时写没有数字的一句。
  capExtended: '已追加 {} 个回合。',
  capExtendedNoNumber: '已追加回合。',
  agreementConfirmed: '已确认约定。',
  // 提议：接受、不做各一句（P74i-m5 第 3 节）；告警点「知道了」。
  proposalAccepted: '已接受这条提议。',
  proposalDeclined: '已选择不做，这一项不会执行。',
  alertAcknowledged: '已知晓。',
  // 告警点「恢复在岗」（P74i-m7）：{} 取条目 reinstate.botName。
  reinstated: '已恢复{}在岗。',
  // 通用句：表里没有列到的条目。
  generic: '已提交。',
} as const

/** 把 {} 换成具体内容。 */
function fill(template: string, value: string): string {
  return template.replace('{}', value)
}

/**
 * 按条目与主人点的按钮，给出处理成功后的提示。
 * @param item 刚处理的条目
 * @param option 主人点的按钮的原始文字（审批为「批准」「拒绝」，其余为条目 options 里的文字）；
 *               说明卡条目的办法在卡片里选，不经过按钮，传空字符串即可。
 */
export function inboxHandledNotice(item: InboxItemView, option: string): string {
  const kind = item.jobEntry?.kind ?? null
  // 一件事的四类条目：按种类和按钮给提示。
  if (kind === 'accept') return INBOX_NOTICE_TEXT.accepted
  if (kind === 'escalate') return INBOX_NOTICE_TEXT.escalateChosen
  if (kind === 'stall') return option.startsWith('再提醒') ? INBOX_NOTICE_TEXT.reminded : INBOX_NOTICE_TEXT.paused
  if (kind === 'cap') {
    if (!option.startsWith('再给')) return INBOX_NOTICE_TEXT.paused
    // 按钮文字由核心按回合默认值生成（「再给 8 个回合」）；设置覆盖了默认值时数字不同，所以从按钮文字里取。
    const turns = /再给\s*(\d+)\s*个回合/.exec(option)
    return turns !== null ? fill(INBOX_NOTICE_TEXT.capExtended, turns[1]!) : INBOX_NOTICE_TEXT.capExtendedNoNumber
  }
  // 约定确认条目：只有「按建议，定了」一个按钮。
  if (typeof item.agreementId === 'string' && item.agreementId !== '') return INBOX_NOTICE_TEXT.agreementConfirmed
  // 审批：发布审批与普通审批分开，批准、拒绝各一句。
  if (item.type === 'approval') {
    const launch = item.approval?.launch === true
    if (isApproveOption(option)) return launch ? INBOX_NOTICE_TEXT.launchApproved : INBOX_NOTICE_TEXT.approved
    return launch ? INBOX_NOTICE_TEXT.launchDeclined : INBOX_NOTICE_TEXT.rejected
  }
  // 提议：接受、不做各一句；其余按钮（样例里的「先保持」等）写通用句。告警点「知道了」。
  if (item.type === 'proposal' && option === '接受') return INBOX_NOTICE_TEXT.proposalAccepted
  if (item.type === 'proposal' && option === '不做') return INBOX_NOTICE_TEXT.proposalDeclined
  // 告警：带恢复入口时，答复等于视图给的 answer 就是「恢复在岗」（成功才会走到这里，说的是已经发生的事）；其余点「知道了」。
  if (item.type === 'alert' && item.reinstate != null && option === item.reinstate.answer) return fill(INBOX_NOTICE_TEXT.reinstated, item.reinstate.botName)
  if (item.type === 'alert') return INBOX_NOTICE_TEXT.alertAcknowledged
  // 其余条目写通用句。
  return INBOX_NOTICE_TEXT.generic
}
