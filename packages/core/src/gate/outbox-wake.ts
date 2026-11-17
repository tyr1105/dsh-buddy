/**
 * 出站动作运行完之后，给提交它的员工排一条带结果的唤醒（P74r18b 第 1 节第 3 条）。
 *
 * 为什么直接排、不走普通感知的评分：结果感知（outbox_done）的显著性只有 0.5，低于候选线，单条永远叫不醒人；
 * 而主人批准的动作，员工必须知道结果。批准的那一刻已经不再叫醒员工（命令由中心运行，他那时什么都做不了），
 * 所以结果出来之后要有人叫他。
 *
 * 两条路：
 * - 属于一件事的审批（审批旁表记着这件事的编号）：照执行链唤醒的写法排（job/chain.ts 的 enqueueJobWake），带这件事的编号；
 * - 不属于任何事的普通出站动作：建一条回复类候选直接入队；审批是在项目主题里申请的、主题还能接着聊时，回到那个主题。
 * 唤醒原因是结果本身（文字见 util/outbox-text.ts 的 outboxWakeReason）。
 */
import type { HubContext } from '../engine/context.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueueJobWake } from '../job/chain.js';
import { noteJobOf } from '../job/launch-approval.js';
import type { OutboxAction } from '../model/outreach.js';
import { followUpTopic, startTopicFollowUp } from '../project/topic-followup.js';
import { enqueue } from '../scheduler/queue.js';
import { describeAction } from '../util/action-text.js';
import { approvedActionText, outboxWakeReason } from '../util/outbox-text.js';
import { approvalOwnerSummary } from '../util/owner-text.js';

/**
 * 给提交者排结果唤醒；返回有没有排上。row 必须是已经批准（approved 或 used）的出站动作，且已是终点状态。
 * perceptId 是这次结果对应的感知：排上之后由调用方标成已评估，免得感知收集器再另建一条不带结果的候选。
 */
export function wakeSubmitterWithResult(ctx: HubContext, row: OutboxAction, perceptId: string | null): boolean {
  if (row.approvalId === null || row.approvalId === undefined) return false;
  const approval = ctx.store.table('approvals').get(row.approvalId);
  if (approval === null) return false;
  const action = approvedActionText(ctx, row) ?? describeAction('hub_outbox_execute', row, ctx.settings.c03.actionCommandMaxChars);
  const summary = outboxWakeReason(row, action);
  // 属于一件事：带这件事的编号，照执行链唤醒的写法排。
  const job = noteJobOf(ctx, approval.id);
  if (job !== null) return enqueueJobWake(ctx, { job, botId: row.botId, why: 'outbox_result', eventId: null, summary }) !== null;
  // 不属于任何事：回复类候选直接入队；在项目主题里申请的，回到那个主题。
  const topic = followUpTopic(ctx, row.botId, approval.topicId);
  // P76r2 第 1 节：审批是主人亲手批准的（approved 或 used），这条结果唤醒是主人决定之后的接续，不算员工自己发起：
  // 否则员工当天名额用完时，结果会被每天上限拦到第二天。批准之后没有运行（'rejected'）的那一路审批状态同样是 approved，一并带上。
  // 中心按到期处理的审批走 gate/approvals.ts 的另一条路，不经过这里，也不带这个标记。
  const ownerApproved = approval.status === 'approved' || approval.status === 'used';
  const candidate = buildCandidate(ctx, { botId: row.botId, kind: 'approval_decided', score: ctx.settings.c02.replySalience, summary,
    evidence: [approval.id, ...(perceptId === null ? [] : [perceptId])], subjectKey: `outbox:${row.id}`, now: ctx.clock.now(),
    ownerSummary: approvalOwnerSummary(approval, approval.status, '', ctx),
    ...(ownerApproved ? { ownerDecided: true } : {}),
    ...(topic ? { topicId: topic.id, ownerInitiated: true } : {}) });
  candidate.priority = ctx.settings.c02.priorities.reply;
  if (topic) return startTopicFollowUp(ctx, { topic, candidate, perceptId, note: approvalOwnerSummary(approval, approval.status, '', ctx), refId: row.id }) !== null;
  return enqueue(ctx, candidate) !== null;
}
