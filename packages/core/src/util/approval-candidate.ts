/** 识别候选里是否带有真实审批决定，防止更高优先级的主人消息掩盖审批后被合进只读复盘。 */
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/index.js';

/** 理由和证据一起检查；只认中心保存的同机器人审批记录，不解释外部文字。 */
export function hasApprovalDecision(ctx: HubContext, entry: Pick<QueueEntry, 'botId' | 'reason'>): boolean {
  return entry.reason.kind === 'approval_decided' || entry.reason.evidence.some(id => {
    const approval = ctx.store.table('approvals').get(id);
    if (approval?.botId === entry.botId) return true;
    const percept = ctx.store.table('percepts').get(id);
    return percept?.botId === entry.botId && percept.source === 'inbox' && percept.kind === 'approval_decided';
  });
}
