/**
 * 这件事结束时，还开着的普通审批由中心作废（P74r9 第 2 节）。
 *
 * 为什么需要：执行者做事时有几条命令被拦下，各生成一张审批挂在主人的「待你处理」里；主人没有处理，执行者换了办法把事做完。
 * 验收通过之后这些审批还开着，主人此时批准，命令仍会运行，而这件事已经完成了；停止、改派之后同理（已经不需要的事不该再被执行）。
 *
 * 做法：这件事完成（验收通过）、停止，或执行者被改派走时，属于这件事、还在等主人处理（状态为待审批）、
 * 或已经批准而执行者还没有用掉（状态为已批准，P74r13 起）的审批，
 * 除了发布这一步的那一张之外，全部用统一的作废写法（gate/void-approval.ts，状态记已过期并带 voided，卡片撤回，答复栏写原因）作废。
 * 作废之后主人批准不了（审批不再是待审批），命令也不会运行。
 *
 * 「属于这件事」按审批旁表里记的事的编号认（job/launch-approval.ts 的 noteJobOf 用同一张旁表）；不属于任何事的审批不动。
 * 本文件只作废，不改这件事的记录，也不说话（原因写在撤回的卡片的答复栏里）。出错由调用方记日志，不影响这件事本身的结果。
 */
import type { HubContext } from '../engine/context.js';
import { voidApproval } from '../gate/void-approval.js';
import type { Job } from '../model/job.js';

/** 作废的三种原因，对应撤回的卡片答复栏里的话（逐字）。 */
export const VOID_JOB_DONE_TEXT = '这件事已完成，这条审批不再需要，已作废';
export const VOID_JOB_STOPPED_TEXT = '这件事已停止，这条审批不再需要，已作废';
export const VOID_JOB_REASSIGNED_TEXT = '这件事已改派，这条审批不再需要，已作废';

// P74r18a：执行者交回时，他自己为这件事提交的审批作废（自测引出的审批在交回之后已不再需要）。
export const VOID_JOB_DELIVERED_TEXT = '这件事已交回核对，这条审批不再需要，已作废';

// P74r19：发布这一步结束（暂不发布、已发布）时，这件事还在等批准的其余审批作废，答复栏写这句。
export const VOID_JOB_LAUNCH_ENDED_TEXT = '这件事的发布已结束';
// P74r19：执行者在发布这一步提交了新的发布命令、取代了还在等批准的那一条时，旧的那条答复栏写这句。
export const VOID_LAUNCH_REPLACED_TEXT = '执行者提交了新的发布命令';

export type VoidJobWhy = 'done' | 'stopped' | 'reassigned' | 'delivered' | 'launch_ended';
const REASONS: Record<VoidJobWhy, string> = {
  done: VOID_JOB_DONE_TEXT, stopped: VOID_JOB_STOPPED_TEXT, reassigned: VOID_JOB_REASSIGNED_TEXT, delivered: VOID_JOB_DELIVERED_TEXT,
  launch_ended: VOID_JOB_LAUNCH_ENDED_TEXT,
};

/**
 * P74r19：作废一张审批，并让它对应的出站记录立刻跟着变成「已拒绝」（原因写进记录）。
 * 为什么：统一作废写法（gate/void-approval.ts）只改审批单和「待你处理」条目；出站记录原来要等下一次巡检才被改成已拒绝，
 * 这个空档里同一条命令原样再提交，去重会返回旧记录。发布这一步的「取代」和「结束」都要求各处状态立刻一致，所以这里一并改。
 * 只动还在等批准或就绪的出站记录；已经运行、已经有结果的不动。总管私聊里那张卡的状态来自「待你处理」条目，随条目一起变化。
 */
export function voidApprovalAndOutbox(ctx: HubContext, approvalId: string, reason: string, now: number): void {
  voidApproval(ctx, approvalId, reason, now);
  for (const row of ctx.store.table('outbox').list(item => item.approvalId === approvalId && (item.status === 'pending_approval' || item.status === 'ready'))) {
    ctx.store.table('outbox').patch(row.id, { status: 'rejected', result: reason, executionStarted: false, doneAt: now });
  }
}

/**
 * 作废这件事还在等主人处理、或已批准还没有执行的普通审批，返回作废了几张。
 * - 发布这一步的那一张（job.launch.approvalId）不动：它的结局由发布这一步自己的规则管；
 * - why 为 reassigned、delivered 时只作废 byBotId（被换下的执行者、刚交回的执行者）提交的那几张：别人提交的、之后重新提交的不受影响。
 */
export function voidJobApprovals(ctx: HubContext, job: Job, why: VoidJobWhy, now: number, byBotId?: string): number {
  // P74r13：除了「还在等主人处理」（待审批），主人已经批准、执行者还没有用掉（已批准）的同样作废，
  // 否则这件事结束之后执行者仍能用掉这张批准票（主人批准的是一件当时还没结束的事）。已经使用的不在此列。
  const open = ctx.store.table('approvals').list(row => (row.status === 'pending' || row.status === 'approved')
    && row.id !== job.launch.approvalId
    && ctx.store.table('approvalNotes').get(row.id)?.jobId === job.id
    && (byBotId === undefined || row.botId === byBotId));
  for (const approval of open) {
    // 发布这一步结束时（P74r19）出站记录一并立刻作废；其余原因照旧，出站记录由下一次巡检收尾。
    if (why === 'launch_ended') voidApprovalAndOutbox(ctx, approval.id, REASONS[why], now);
    else voidApproval(ctx, approval.id, REASONS[why], now);
    // 主人已经批准的那种：它的卡片已是「已答复（批准）」，统一作废写法只撤回还开着的卡片；
    // 这里把答复栏也改成作废原因，与「还在等主人处理」的那种一致，主人回头看不会以为这条批准还有效。
    if (approval.status === 'approved') {
      for (const card of ctx.store.table('inbox').list(item => item.type === 'approval' && item.refId === approval.id && item.status === 'answered')) {
        ctx.store.table('inbox').patch(card.id, { status: 'withdrawn', answer: REASONS[why], answeredAt: now });
      }
    }
  }
  return open.length;
}
