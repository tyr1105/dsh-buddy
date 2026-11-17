/**
 * 改派的写入与收尾（P74b 建，P74r1、P74r2a 扩充）：hub_job_manage 的 reassign，换执行者、换核对人、或两个一起换。
 * 校验在 reassign-plan.ts，本文件按三段式（方案 6.4）写入：
 * 1. 校验（plan），一条都不写；
 * 2. 写状态：这件事的记录、项目成员、被换下的人排着的候选（丢弃）、该叫醒的人的唤醒、reassigned 事件。
 *    有备份，任何一步失败全部恢复，工具返回失败；所以返回成功时，该叫醒的人确实入了队；
 * 3. 最后才写主人看得见的话（工作往来、撤回「停住了」条目），出错只记日志，不影响已成功的状态。
 *
 * 被换下的人留下的东西怎样处理：
 * - 他的未回答提问随改派作废（提问人必须始终是这件事现在的执行者或核对人）：清掉 openAsk，作废的提问（事件编号和原文）
 *   记在 reassigned 事件的 data 里，工作往来落一句，新执行者的唤醒包里写明（wake/job-section.ts）；
 * - 他排着的候选全部丢弃，免得之后有人被叫去等一位已经换下的人；
 * - 因停用或核对环节没有动静而受阻的事，在换完之后执行者和核对人都在岗时解除受阻，回到受阻前的状态并叫醒该动的人；
 *   仍有人停用时保持受阻，如实说明，不给任何人排唤醒。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job, type JobSubmission } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import type { JobManageArgs } from './assign.js';
import type { JobWakeWhy } from './chain.js';
import { addProjectMembers, removeProjectMembers } from './members.js';
import { planReassign, type ReassignPlan } from './reassign-plan.js';
import { dropJobEntries } from './start-wake.js';
import { applyJobAction } from './state.js';
import { openBlockItems, withdrawBlockItems } from './block-items.js';
import { markReleased } from './escalation-expiry.js';
import { chosenOptionOf, exitReviewLimit } from './review-limit-exit.js';
import { appendJobEvent, putJob } from './store.js';
import { reviewStalled } from './version-stage.js';
import { queueWake, runUndo, softly, type UndoSteps } from './work-common.js';
import { voidJobApprovals } from './void-job-approvals.js';
import { jobCategory } from '../project/agreement-category.js';
import { restoreCollapsedForCategory } from '../skill/store.js';

/** 按完整字符截断，超过 max 加「…」。 */
function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** 改完之后这件事的新记录，以及是否解除了受阻。 */
function nextJobOf(ctx: HubContext, plan: ReassignPlan, now: number, stallOpen: boolean): { next: Job; unblocked: boolean; submission: JobSubmission | null } {
  const { job, newExecutor, voidedAsk, stillOff } = plan;
  const changes = {
    executorId: plan.executorId, reviewerId: plan.reviewerId, updatedAt: now,
    ...(voidedAsk === null ? {} : { openAsk: null }),
    ...(stallOpen ? { inboxId: null } : {}),
  };
  // 只有因执行者做不下去、核对环节没有动静、有人停用、核对三轮不过（主人已选办法）而受阻的事才会走到这里（其余原因在校验里已拒绝）。
  if (job.state !== 'blocked' || job.blocked === null) return { next: { ...job, ...changes }, unblocked: false, submission: null };
  // P74r6 第 1 节：核对三轮不过、主人已选办法之后改派，进入新的一个阶段（统一用 exitReviewLimit）：
  // 换了执行者：新阶段、返工中、轮数归零（要改的条目取最近一次核对里判不符的）；只换核对人：新阶段、核对中、第 1 轮（交回由中心重排）。
  // 换完之后仍有人停用的，先进入新阶段，再记为有人停用的受阻（解除后回到新阶段的返工中或核对中）。
  if (job.blocked.kind === 'review_limit') {
    const exit = exitReviewLimit(ctx, job, newExecutor !== null ? 'rework' : 'checking', now);
    const entered: Job = markReleased({ ...exit.job, ...changes }, 'reassigned');
    if (stillOff.length > 0) {
      return { next: applyJobAction(entered, { type: 'block', kind: 'participant_off', no: null, text: `${stillOff[0]!.name}已停用` }, now), unblocked: false, submission: exit.submission };
    }
    return { next: entered, unblocked: true, submission: exit.submission };
  }
  // 换完之后仍有人停用：保持受阻，受阻说明改为仍停用的那位。
  if (stillOff.length > 0) {
    // 受阻原因变了，这次说明针对的受阻已经过去：说明标为「总管已改派」（P74r4a-m1，P74r6 分清原因）。
    return { next: markReleased({ ...job, ...changes, blocked: { ...job.blocked, kind: 'participant_off', text: `${stillOff[0]!.name}已停用` } }, 'reassigned'), unblocked: false, submission: null };
  }
  const executorStuck = job.blocked.kind === 'executor' && !reviewStalled(job);
  let back: Job = markReleased({ ...applyJobAction(job, { type: 'unblock' }, now), ...changes }, 'reassigned');
  // 执行者做不下去：改派本身就是总管对它的处理，新执行者从「待开工」重新开始（返工中的事仍是返工中，要改的条目留给新执行者）。
  if (executorStuck && newExecutor !== null && back.state === 'doing') back = { ...back, state: 'ready', startedAt: null };
  // 主人已为这次做不下去选了办法：记下，新执行者的唤醒包写明（同一阶段，不进新阶段）。
  const choice = chosenOptionOf(job);
  if (choice !== null) back = { ...back, ownerChoice: { stage: back.stage, ...choice } };
  return { next: back, unblocked: true, submission: null };
}

/** 要叫醒的一位员工：叫谁、为什么、给模型看的摘要。 */
interface WakeSpec { botId: string; why: JobWakeWhy; summary: string; ownerSummary?: string }

/** 这次要叫醒谁、为什么；不需要叫醒返回 null。 */
function wakeOf(plan: ReassignPlan, next: Job, unblocked: boolean): WakeSpec | null {
  const { job, title, newExecutor, reviewerChanged } = plan;
  if (next.state === 'blocked') return null;
  const executorTurn = next.state === 'ready' || next.state === 'doing' || next.state === 'rework';
  if (newExecutor !== null && executorTurn) {
    return { botId: newExecutor.id, why: 'reassigned', summary: `总管把一件事改派给你：${title}` };
  }
  if (next.state === 'checking' && (unblocked || reviewerChanged)) {
    // 换了核对人，或解除受阻回到核对中：叫核对人（总管自己核对时叫总管）来核对这一轮交回。
    return { botId: plan.reviewerId ?? plan.chief.id, why: 'to_review', summary: `「${title}」已交回第 ${next.round} 轮，请对照约定逐条核对` };
  }
  if (executorTurn && unblocked && next.openAsk === null) {
    // 解除受阻回到执行环节（例如返工中核对人停用、换了核对人）：执行者的候选在受阻期间已被丢弃，要重新叫他。
    return { botId: plan.executorId, why: 'resumed', summary: `「${title}」可以接着做了`, ownerSummary: '核对人已更换，继续做这件事' };
  }
  return null;
}

/** reassign 的入口：返回给模型看的一句话。 */
export async function runJobReassign(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  const plan = planReassign(ctx, tc, args);
  const { chief, job, newExecutor, newReviewer, reviewerChanged, voidedAsk } = plan;
  const now = ctx.clock.now();
  const eventId = newId('jev', ctx.rng);
  // P74r4a 第 3 条：改派之后，这件事开着的说明条目和「停住了」条目一并撤回、编号清空（回合上限条目不是改派能解决的，保留）。
  const staleItems = openBlockItems(ctx, job.id).filter(row => !row.subjectKey.startsWith(`job:${job.id}:cap:`));
  const stallOpen = job.inboxId !== null && staleItems.some(row => row.id === job.inboxId);
  const { next, unblocked, submission } = nextJobOf(ctx, plan, now, stallOpen);
  const wake = wakeOf(plan, next, unblocked);
  const wasBlockedExecutor = job.state === 'blocked' && job.blocked?.kind === 'executor';

  // 第二段：状态写入，有备份。
  const undo: UndoSteps = [];
  try {
    putJob(ctx, JobSchema.parse(next));
    undo.push(() => { putJob(ctx, job); });
    // 只换核对人时，最近一次交回由中心重排成新阶段的一条（写入，失败时撤销）。
    if (submission !== null) {
      ctx.store.table('jobSubmissions').put(submission);
      undo.push(() => { ctx.store.table('jobSubmissions').remove(submission.id); });
    }
    const joining = [newExecutor?.id, newReviewer?.id].filter((id): id is string => id !== undefined);
    const added = addProjectMembers(ctx, job.projectId, joining, chief.id, { byJob: job.id });
    undo.push(() => removeProjectMembers(ctx, job.projectId, added, chief.id, { byJob: job.id, recovered: true }));
    // 丢弃被换下的人在这件事上排着的候选（候选不要留着等一位已经不在这件事里的人）。
    if (newExecutor !== null) undo.push(dropJobEntries(ctx, job.executorId, job.id));
    if (reviewerChanged && job.reviewerId !== null) undo.push(dropJobEntries(ctx, job.reviewerId, job.id));
    // 总管那次因做不下去、核对环节没有动静、提问而排的唤醒已经处理完了（被换下的是总管自己核对时同理），一并丢弃，
    // 免得总管被无事可做地再叫一次。
    if (wasBlockedExecutor || voidedAsk !== null || (reviewerChanged && job.reviewerId === null)) {
      undo.push(dropJobEntries(ctx, chief.id, job.id));
    }
    // 排唤醒并确认闸门不会直接丢弃；叫不醒（对方不在岗、回合用尽等）整体失败，由下面的 catch 恢复原状。
    if (wake !== null) queueWake(ctx, { ...wake, job: next, eventId }, undo, ctx.store.table('bots').get(wake.botId)?.name ?? '对方');
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: chief.id, kind: 'reassigned',
      to: [...(newExecutor ? [newExecutor.id] : []), ...(reviewerChanged ? [newReviewer?.id ?? chief.id] : [])], refId: null,
      data: {
        changed: [...(newExecutor ? ['executor'] : []), ...(reviewerChanged ? ['reviewer'] : [])],
        ...(newExecutor ? { from: job.executorId, to: newExecutor.id } : {}),
        ...(reviewerChanged ? { reviewerFrom: job.reviewerId, reviewerTo: newReviewer?.id ?? null } : {}),
        ...(voidedAsk === null ? {} : { voidedAsk: { by: voidedAsk.by, eventId: voidedAsk.eventId, text: clip(voidedAsk.text, 400) } }),
      } });
  } catch (error) {
    await runUndo(ctx, undo, '改派', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`改派失败，已恢复到改派前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_reassign', {
    jobId: job.id, from: job.executorId, to: plan.executorId, reviewerFrom: job.reviewerId, reviewerTo: plan.reviewerId,
  }, chief.id, now);
  // P74r9 第 2 节：执行者被改派走，他提交的、属于这件事、还在等主人处理的普通审批由中心作废（发布这一步的那一张不动）；出错只记日志。
  if (newExecutor !== null) softly(ctx, '作废被换下的执行者提交的审批', () => { voidJobApprovals(ctx, job, 'reassigned', now, job.executorId); });
  // P75e 第 7 节：换了执行者（派活路径之外的第二条路径，含经 exitReviewLimit 进新阶段的那一种）之后，
  // 新执行者收起原因为「久未用」的同类技能自动放回；出错只记日志，不影响改派结果。
  if (newExecutor !== null) {
    try { await restoreCollapsedForCategory(ctx, plan.executorId, jobCategory(ctx, job.id)); }
    catch (error) { ctx.logger.warn('改派后放回同类技能失败', { jobId: job.id, error: String(error) }); }
  }
  // P75r5c（第 5 节第 3 条）：换了执行者或换了核对人时，（新的）核对人的同类技能也放回；与新执行者是同一人时上面已放回，不重复。
  if (newExecutor !== null || reviewerChanged) {
    const checkerId = plan.reviewerId ?? chief.id;
    if (checkerId !== plan.executorId) {
      try { await restoreCollapsedForCategory(ctx, checkerId, jobCategory(ctx, job.id)); }
      catch (error) { ctx.logger.warn('改派后放回核对人的同类技能失败', { jobId: job.id, error: String(error) }); }
    }
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  for (const id of new Set([job.executorId, plan.executorId, job.reviewerId, plan.reviewerId])) {
    if (id !== null) ctx.emit(HUB_EVENT_SCOPES.bot, id);
  }

  // 第三段：撤回过期的「停住了」条目；工作往来里的话。
  if (staleItems.length > 0) softly(ctx, '撤回说明和「停住了」条目', () => { withdrawBlockItems(ctx, staleItems, now, '总管已改派'); });
  const nameOf = (id: string | null, fallback: string): string => (id === null ? '总管' : ctx.store.table('bots').get(id)?.name ?? fallback);
  const post = (text: string): void => softly(ctx, '工作往来', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text });
  });
  if (newExecutor !== null) post(`总管把这件事改派给${newExecutor.name}。`);
  if (reviewerChanged) {
    post(newReviewer === null ? '核对改由总管来做。' : `核对人由${nameOf(job.reviewerId, '核对人')}换成${newReviewer.name}。`);
  }
  const askerName = voidedAsk?.asker?.name ?? '原来的提问人';
  if (voidedAsk !== null) {
    const successor = voidedAsk.by === 'executor' ? newExecutor?.name ?? '新执行者' : newReviewer?.name ?? '总管';
    post(`${askerName}问的「${clip(voidedAsk.text, 60)}」随改派作废；${successor}需要时会重新提问。`);
  }

  // 返回文字：如实说明做了什么、这件事现在能不能继续。
  const parts: string[] = [];
  if (newExecutor !== null) {
    parts.push(`已改派给${newExecutor.name}。`);
    if (next.state === 'checking') parts.push('这件事在核对中，核对退回后才轮到他返工。');
  }
  if (reviewerChanged) {
    const who = newReviewer?.name ?? '总管';
    if (next.state === 'checking') {
      parts.push(newReviewer === null ? `核对改由你来做，第 ${job.round} 轮交回等你核对。` : `已把核对人换成${who}，他会核对第 ${job.round} 轮交回。`);
    } else {
      parts.push(`已把核对人换成${who}。`);
    }
  }
  if (voidedAsk !== null) parts.push(`${askerName}有一个没回答的提问，已随改派作废。`);
  // P74r6：离开三轮不过的受阻，进入了新的一个阶段，核对从新的三轮算起。
  if (job.blocked?.kind === 'review_limit' && next.stage > job.stage) parts.push('这件事进入新的一个阶段，核对从新的三轮算起。');
  if (next.state === 'blocked' && next.blocked !== null && plan.stillOff.length > 0) {
    const off = plan.stillOff[0]!;
    const isReviewerOff = off.id === plan.reviewerId;
    parts.push(`${off.name}仍处于停用，这件事还不能继续：再换一位${isReviewerOff ? '核对人（reviewer）' : '执行者（executor）'}，或等他恢复在岗。`);
  }
  return parts.join('');
}
