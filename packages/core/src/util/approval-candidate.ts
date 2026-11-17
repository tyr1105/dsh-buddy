/** 识别候选里是否带有真实审批决定，防止更高优先级的主人消息掩盖审批后被合进只读复盘。 */
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/index.js';

/**
 * P76r1 小修：证据里有没有一条对应「主人亲手批准或拒绝」的审批记录（状态 approved、rejected，或批准后已被使用的 used）。
 * 证据编号可能是审批编号本身，也可能是审批结果感知的编号（感知的 location 形如「审批编号:状态」，取冒号前一段，与 wake/packet.ts 同一口径）；
 * 对应不回审批记录、或审批记录是到期（expired）、待处理（pending）的，一律不算「主人作出的决定」。
 */
export function ownerDecidedByEvidence(ctx: HubContext, botId: string, evidence: readonly string[]): boolean {
  return evidence.some(id => {
    const percept = ctx.store.table('percepts').get(id);
    const approvalId = percept?.source === 'inbox' && percept.kind === 'approval_decided' && percept.location ? percept.location.split(':')[0]! : id;
    const approval = ctx.store.table('approvals').get(approvalId);
    return approval?.botId === botId && ['approved', 'rejected', 'used'].includes(approval.status);
  });
}

/** 理由和证据一起检查；只认中心保存的同机器人审批记录，不解释外部文字。 */
export function hasApprovalDecision(ctx: HubContext, entry: Pick<QueueEntry, 'botId' | 'reason'>): boolean {
  return entry.reason.kind === 'approval_decided' || entry.reason.evidence.some(id => {
    const approval = ctx.store.table('approvals').get(id);
    if (approval?.botId === entry.botId) return true;
    const percept = ctx.store.table('percepts').get(id);
    return percept?.botId === entry.botId && percept.source === 'inbox' && percept.kind === 'approval_decided';
  });
}
