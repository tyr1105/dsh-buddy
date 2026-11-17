/**
 * 验收通过的五条途径（P74f，方案 5.5）：交付卡上的按钮、「待你处理」里的按钮、主题里打字、总管私聊里打字、
 * 在总管的 DSH 会话里直接打字。五条途径最后都落到同一个函数 acceptJob，写法照第一块「定了」的 finishLock：
 * 先校验（失败直接抛出，此时什么都没写），再写状态，状态全部写成功之后才做主人看得见的话。
 *
 * 总管没有任何工具能到达这里：验收只能由主人发起。打字途径只认整句口令（「通过吗」「先别通过」「通过，但把标题改一下」
 * 都不是验收，会照常交给总管理解）；口令识别规范化口径与确认约定相同。打字还要求这件事本阶段的交付卡已经落楼，
 * 且主人这句话不早于交付卡（防止对着旧卡说的话验收了没看过的新结果）；约定新版本在等确认期间，打字不识别、按钮被拒。
 * 打字识别成功后，那句话不再叫醒总管（调用方直接返回消息）。
 */
import { z } from 'zod';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { JobSchema, type Job } from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { emitInboxChange, JOB_ACCEPT_OPTION } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { normalizeConfirmText } from '../project/agreement-confirm.js';
import { onJobAccepted } from './after-accept.js';
import { jobTitleOf } from './chain.js';
import { agreementPendingNo, currentDeliveryRev, deliveryCardMessage } from './deliver.js';
import { computeReceiptRowsFor, receiptRefId } from './receipt.js';
import { reportTrialFeedback } from './trial.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { startLaunch } from './launch-approval.js';
import { voidJobApprovals } from './void-job-approvals.js';
import { softly } from './work-common.js';

/** 验收的五条途径。 */
export type AcceptVia = 'button' | 'inbox' | 'topic_text' | 'chat_text' | 'direct_text';

/** 这句话是不是验收口令：规范化后不超过字数上限，且完全等于名单中的一项。 */
export function isAcceptPhrase(text: string): boolean {
  const normalized = normalizeConfirmText(text);
  return [...normalized].length <= D.ACCEPT_PHRASE_MAX_CHARS && D.ACCEPT_PHRASES.includes(normalized);
}

/** 不是最新一张卡时的拒绝文字。 */
export const STALE_CARD_TEXT = '这张卡已不是最新的，请在最新的交付卡上验收';
/** 私聊里两件以上在等验收时，中心落的那句话。 */
export function ambiguousAcceptText(count: number): string {
  return `现在有 ${count} 件事在等你验收，请在要验收的那张卡上点「验收通过」。`;
}

/** revision：按钮所在的交付卡的修订号（P74f-2）；同一阶段重新交付之后，对着旧卡验收被拒。省略表示不检查（打字、「待你处理」按钮）。 */
interface AcceptInput { jobId: string; stage: number; via: AcceptVia; messageId: string | null; revision?: number }

/**
 * 验收通过。校验失败抛出中文错误且不写任何东西；状态写成功之后，主人看得见的话各自出错只记日志。
 * 返回验收后的这件事。
 */
export function acceptJob(ctx: HubContext, input: AcceptInput): Job {
  // ---- 第一段：校验 ----
  const job = ctx.store.table('jobs').get(input.jobId);
  if (job === null) throw new Error('jobId：没有这件事');
  if (job.state !== 'awaiting_owner') throw new Error(job.state === 'done' ? '这件事已经验收过了' : '这件事现在不在等你验收');
  if (job.stage !== input.stage) throw new Error(STALE_CARD_TEXT);
  if (input.revision !== undefined && input.revision !== currentDeliveryRev(job)) throw new Error(STALE_CARD_TEXT);
  const pending = agreementPendingNo(ctx, job);
  if (pending !== null) throw new Error(`约定第 ${pending} 版在等你确认，确认后再验收。`);

  // ---- 第二段：写状态（有备份），全部成功才算数 ----
  const now = ctx.clock.now();
  let next = applyJobAction(job, { type: 'owner_accept' }, now);
  if (job.launchStep) next = { ...next, launch: { ...next.launch, state: 'preparing' } };
  // P74r4a 第 5 条：回执的五行在验收通过时一次算好、存在这件事的记录上，之后查看回执用存下的数字。
  next = JobSchema.parse({ ...next, inboxId: null, receipt: computeReceiptRowsFor(ctx, next) });
  const items = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
  try {
    putJob(ctx, next);
    for (const item of items) ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: JOB_ACCEPT_OPTION, answeredAt: now });
    appendJobEvent(ctx, { jobId: job.id, actor: 'owner', kind: 'owner_accepted', to: [job.chiefId], refId: input.messageId, data: { via: input.via, stage: job.stage } });
    // P74g：有发布步骤时记一条 launch_requested；叫执行者准备发布放在第三段（验收一定成功，不因为叫不醒而恢复原状）。
    if (job.launchStep) appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'launch_requested', to: [job.executorId], refId: null, data: { step: 'prepare' } });
  } catch (error) {
    putJob(ctx, job);
    for (const item of items) ctx.store.table('inbox').put(item);
    throw new Error(`验收没有记下，已恢复到验收前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_accept', { jobId: job.id, via: input.via, stage: job.stage }, 'owner', now);
  ctx.runtime.ownerActiveAt = now;
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  for (const item of items) emitInboxChange(ctx, item);

  // P74r9 第 2 节：这件事已完成，执行中途还在等主人处理的普通审批由中心作废（此刻还没有发布审批，所以全部作废）；
  // 出错只记日志，验收结果不受影响。
  softly(ctx, '作废这件事还开着的审批', () => { voidJobApprovals(ctx, ctx.store.table('jobs').get(job.id) ?? next, 'done', now); });

  // ---- 第三段：主人看得见的话（顺序固定，各自出错只记日志）----
  const title = jobTitleOf(ctx, job);
  // 1. 按钮、「待你处理」两条途径以主人名义在主题落「验收通过」；打字途径主人的话本来就在线程里，不重复。
  if (input.via === 'button' || input.via === 'inbox') {
    softly(ctx, '主题里主人的验收', () => { postThread(ctx, { thread: job.topicId, from: 'owner', kind: 'chat', refId: job.id, text: JOB_ACCEPT_OPTION }); });
  }
  // 2. 中心提示。
  softly(ctx, '主题里的完成提示', () => { postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'system', refId: job.id, text: `${title}已完成。` }); });
  // 3. 总管名义的一句；有发布步骤时接发布预告（发布准备的唤醒在 P74g）。
  softly(ctx, '主题里总管的记录', () => {
    postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'reply', refId: job.id,
      text: job.launchStep ? '已记为完成。下一步是对外发布，需要你批准，我会单独发给你；批准前不会发布。' : '已记为完成。' });
  });
  // 3.5 发布这一步起头：叫执行者准备发布；他停用就等他恢复在岗、已归档就记为暂不发布（各落一句，见 launch-approval.ts）。
  if (job.launchStep) startLaunch(ctx, ctx.store.table('jobs').get(job.id) ?? next);
  // 4. 回执。
  softly(ctx, '回执', () => { postThread(ctx, { thread: job.topicId, from: job.chiefId, kind: 'job_card', refId: receiptRefId(job.id), text: `交付回执　${title}` }); });
  // 5. 试用反馈。
  reportTrialFeedback(ctx, job.id);
  // 6. 后续动作的位置（第四块在这里写同类任务记录、安排复盘）：出错只记日志，不影响验收结果。
  softly(ctx, '验收后的后续动作', () => { onJobAccepted(ctx, job.id); });
  ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
  return ctx.store.table('jobs').get(job.id) ?? next;
}

// ---------------------------------------------------------------------------
// 途径一：交付卡上的按钮（界面命令 acceptJob）
// ---------------------------------------------------------------------------

const AcceptCommandSchema = z.strictObject({
  jobId: recordId('job'),
  stage: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '阶段从 1 起'),
  revision: z.number({ error: '必须是整数' }).int('必须是整数').min(0, '修订号从 0 起').optional(),
});

/** 点「验收通过」按钮：入参校验后落到 acceptJob。 */
export function acceptJobCommand(ctx: HubContext, raw: unknown): { jobId: string; stage: number } {
  const input = parseInput(AcceptCommandSchema, raw, '验收');
  acceptJob(ctx, { jobId: input.jobId, stage: input.stage, via: 'button', messageId: null, ...(input.revision === undefined ? {} : { revision: input.revision }) });
  return { jobId: input.jobId, stage: input.stage };
}

// ---------------------------------------------------------------------------
// 途径二的入口在 inbox-answer.ts；途径三、四、五：打字
// ---------------------------------------------------------------------------

/** 打字验收的结果：验收了哪一件（没有为 null）；私聊里同时有几件在等而没有识别（没有为 0）。 */
export interface AcceptByTextResult { accepted: Job | null; ambiguous: number }

/**
 * 本阶段交付卡的消息编号和落楼时间。P74r4a 第 5 条：读这件事记录上的交付信息（job.delivery，交付时记下）；
 * 内存里的线程日志只保留 14 天，交付 15 天后再到日志里找卡就找不到了，主人隔两周回来打「验收通过」是正常情形。
 * 旧数据没有记下时间，才回头找线程日志。
 */
export function deliveryCardInfo(ctx: HubContext, job: Pick<Job, 'id' | 'topicId' | 'stage' | 'delivery'>): { id: string; at: number } | null {
  const delivery = job.delivery;
  if (delivery != null && delivery.stage === job.stage && delivery.cardMessageId !== null && delivery.cardAt != null) {
    return { id: delivery.cardMessageId, at: delivery.cardAt };
  }
  const message = deliveryCardMessage(ctx, job);
  return message === null ? null : { id: message.id, at: message.createdAt };
}

/** 能被打字验收的事：待你验收、本阶段交付卡已落楼、约定没有新版本在等确认。 */
function acceptableByText(ctx: HubContext, job: Job): boolean {
  return job.state === 'awaiting_owner' && agreementPendingNo(ctx, job) === null && deliveryCardInfo(ctx, job) !== null;
}

/**
 * 主人在某个线程里发了一句话：是验收口令，且有一件事等着验收，就验收它。
 * - 主题线程：只认这个主题自己的那件事；
 * - 总管私聊（含 DSH 会话直聊）：总管名下恰好一件在等时识别；两件以上不识别，中心落一句说明，返回 ambiguous。
 * 同步函数，任何异常都捕获后记日志并返回「没有验收」，绝不能让主人发消息失败。
 */
export function acceptByText(ctx: HubContext, threadId: string, message: ThreadMessage, via: Exclude<AcceptVia, 'button' | 'inbox'>): AcceptByTextResult {
  const none: AcceptByTextResult = { accepted: null, ambiguous: 0 };
  try {
    if (!isAcceptPhrase(message.text)) return none;
    let job: Job | null;
    if (ctx.store.table('projectTopics').get(threadId)) {
      job = ctx.store.table('jobs').list(row => row.topicId === threadId && row.state === 'awaiting_owner')[0] ?? null;
    } else {
      const bot = ctx.store.table('bots').get(threadId);
      if (!bot || bot.role !== 'chief') return none;
      const waiting = ctx.store.table('jobs').list(row => row.chiefId === bot.id && acceptableByText(ctx, row));
      if (waiting.length >= 2) {
        postThread(ctx, { thread: threadId, from: 'hub', kind: 'system', text: ambiguousAcceptText(waiting.length), refId: message.id });
        return { accepted: null, ambiguous: waiting.length };
      }
      job = waiting[0] ?? null;
    }
    if (job === null || !acceptableByText(ctx, job)) return none;
    // 主人这句话必须不早于交付卡落楼。
    const card = deliveryCardInfo(ctx, job);
    if (card === null || card.at > message.createdAt) return none;
    return { accepted: acceptJob(ctx, { jobId: job.id, stage: job.stage, via, messageId: message.id }), ambiguous: 0 };
  } catch (error) {
    ctx.logger.error('按口令验收失败', error);
    return none;
  }
}

/**
 * 主题里发话之前先判断：这句话会不会被识别成验收（不改任何东西）。
 * sendOwnerTopicMessage 用它决定要不要叫醒总管：识别成功的话不叫（与确认约定的做法一致）。
 */
export function wouldAcceptByText(ctx: HubContext, topicId: string, text: string): Job | null {
  if (!isAcceptPhrase(text)) return null;
  const job = ctx.store.table('jobs').list(row => row.topicId === topicId && row.state === 'awaiting_owner')[0] ?? null;
  return job !== null && acceptableByText(ctx, job) ? job : null;
}
