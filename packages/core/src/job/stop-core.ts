/**
 * 停下一件事的共同动作（P74e 的 stop，P74f-2 起拆出来）。
 *
 * 为什么拆出来：停下一件事现在有两条路径，效果必须完全相同——
 * 一、总管在主人发起的回合里调用 stop（主人这一回合的原话直接说了不做，见 stop.ts）；
 * 二、主人确认了写明不再做的约定版本（stopsJob），由中心直接停下，不叫醒总管（见 stops-job.ts）。
 * 两条路径共用本文件：状态改成已停止、队列里这件事的全部候选清掉、这件事开着的「待你处理」条目撤回、
 * 约定正在重新确认时撤下待确认的那一版，然后才做主人看得见的话（主题里一句、总管私聊一句）。
 *
 * 分两段（方案 6.4）：第一段写状态，全部是同步写存储，任何一步失败就把已写的恢复原状并抛出中文错误；
 * 第二段是主人看得见的话，各自出错只记日志。工具返回成功时，状态确实已经改好。
 * 本文件是同步的：确认约定的几条途径都是同步函数，中心停下这件事不能等异步。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { clearReopenLinks } from './agreement-hooks.js';
import { jobTitleOf } from './chain.js';
import { postStopReopenNotice, withdrawReopenForStop, type StopReopenResult } from './stop-agreement.js';
import { dropJobEntries } from './start-wake.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { softly } from './work-common.js';
import { voidJobApprovals } from './void-job-approvals.js';
import { clearChiefBlockedAfterEscalation } from './chief-blocked.js';
import { finalizeJobUsage } from './usage.js';

/** 停下的方式：谁停的、写进记录的原因、主题里和总管私聊里落什么话。 */
export interface StopOptions {
  /** 事件的发出者：总管 id，或 'hub'（中心按主人确认的版本停下）。 */
  actor: string;
  /** 写进 stopped 事件和审计的原因。 */
  reason: string;
  /** 主题里的那句话：谁说、什么类型、说什么。 */
  topic: { from: string; kind: 'reply' | 'system'; text: string };
  /** 总管私聊里的那句话（中心名义）；省略时写「「标题」已停止。」 */
  chiefText?: string;
  /** 为真时一并清掉这件事没回答的提问，并在工作往来里写一句（主人确认「不再做」后，提问随之作废）。 */
  clearAsk?: boolean;
  /** 写进事件，说明是哪条路径停的（owner_words、agreement）。 */
  via: 'owner_words' | 'agreement';
}

/**
 * 停下这件事。校验由调用方做完；这里先写状态（有备份），再说话。
 * 失败时已写的全部恢复原状，抛出「停止失败，已恢复到停止前的状态：……」。返回这件事的标题。
 */
export function stopJobCore(ctx: HubContext, job: Job, options: StopOptions): string {
  const now = ctx.clock.now();
  // P74r2d 第 4 条：约定正在重新确认时，待确认的那一版一并撤下，这件事上与它有关的暂停信息、提问记号也回到一致（不叫醒执行者）。
  let stopped = clearReopenLinks(applyJobAction(job, { type: 'stop' }, now));
  const droppedAsk = options.clearAsk === true && stopped.openAsk !== null ? stopped.openAsk : null;
  if (droppedAsk !== null) stopped = { ...stopped, openAsk: null };
  const next = JobSchema.parse({ ...stopped, inboxId: null });
  const eventId = newId('jev', ctx.rng);
  const undo: Array<() => void> = [];
  let reopen: StopReopenResult | null = null;
  const open: InboxItem[] = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
  try {
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    reopen = withdrawReopenForStop(ctx, job, now);
    if (reopen !== null) for (const step of reopen.undo) undo.push(step);
    // 队列里这件事的全部候选清掉（各位员工的都有可能：执行者、核对人、总管）；每位各自能撤销。
    const botIds = [...new Set(ctx.store.table('queue').list(row => row.jobId === job.id).map(row => row.botId))];
    for (const botId of botIds) undo.push(dropJobEntries(ctx, botId, job.id));
    // 这件事开着的「待你处理」条目撤回；撤回前的样子记下来，失败时放回去。
    for (const item of open) {
      ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '这件事已停止', answeredAt: now });
      undo.push(() => { ctx.store.table('inbox').put(item); });
    }
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: options.actor, kind: 'stopped',
      to: [job.executorId, ...(job.reviewerId === null ? [] : [job.reviewerId])], refId: null, data: { reason: options.reason, via: options.via } });
    for (const item of open) emitInboxChange(ctx, item);
  } catch (error) {
    // 恢复原样：从后往前，某一步出错只记日志，保证剩下的步骤仍会执行。
    for (const step of [...undo].reverse()) {
      try { step(); } catch (undoError) { ctx.logger.warn('停止恢复时某一步没有撤销成功', { jobId: job.id, error: String(undoError) }); }
    }
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`停止失败，已恢复到停止前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_stop', { jobId: job.id, reason: options.reason, via: options.via }, options.actor, now);
  // P76e：停止也定稿这件事的用量（同类估计只读已验收的事，停止的不进同类记录；定稿只是让这行不再变化）；出错只记日志。
  finalizeJobUsage(ctx, job.id);
  // P74r9 第 2 节：这件事停止，还在等主人处理的普通审批由中心作废（发布这一步的那一张不动）；出错只记日志。
  softly(ctx, '作废这件事还开着的审批', () => { voidJobApprovals(ctx, job, 'stopped', now); });
  // P74r14：这件事停止，向主人的说明随之作废：清掉总管因为这次说明写下的受阻状态。
  clearChiefBlockedAfterEscalation(ctx, job.id);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.executorId);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);

  // ---- 第二段：主人看得见的话 ----
  const title = jobTitleOf(ctx, job);
  if (reopen !== null) softly(ctx, '私聊里的重新确认撤下说明', () => postStopReopenNotice(ctx, reopen!));
  softly(ctx, '主题里的话', () => {
    postThread(ctx, { thread: job.topicId, from: options.topic.from, kind: options.topic.kind, refId: job.id, text: options.topic.text });
  });
  if (droppedAsk !== null) {
    const asker = ctx.store.table('bots').get(droppedAsk.fromId)?.name ?? '员工';
    softly(ctx, '工作往来里的提问作废说明', () => {
      postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: `${asker}的问题随之作废，这件事已停止。` });
    });
  }
  softly(ctx, '总管私聊里的提示', () => {
    postThread(ctx, { thread: job.chiefId, from: 'hub', kind: 'system', refId: job.id, text: options.chiefText ?? `「${title}」已停止。` });
  });
  return title;
}
