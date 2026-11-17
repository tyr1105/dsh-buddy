/**
 * 参与者的归档与停用对「一件事」的影响（P74b，方案 5.1.6）。
 *
 * 三件事：
 * 1. 归档：员工是某件进行中的事的执行者或核对人时不能归档（先请总管改派）。归档成功后顺带处理第二块留下的疑点——
 *    发给他的交接、他持有的认领、他名下待批的审批单，不能留着没人管；
 * 2. 停用（含系统隔离）：这件事转「受阻」（原因：参与者停用），总管私聊落一句话，记 participant_off 事件；
 * 3. 恢复在岗：因他停用而受阻的事自动回到停用前的状态，并叫他一次。
 *
 * 状态变化分两段（方案 6.4）：受阻、解除受阻写在状态表里（有备份，失败恢复）；主人看得见的话和事件日志放在后面，出错只记日志。
 * 本文件不决定谁能停用谁，生命周期的转换规则在 api/bots.ts。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { jobProgressView } from '../api/job-views.js';
import type { HubContext } from '../engine/context.js';
import { decideApproval } from '../gate/approvals.js';
import type { Bot } from '../model/bot.js';
import type { Job } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { closeHandoffForAgenda } from '../peer/handoffs.js';
import { enqueuePeerPercept } from '../peer/common.js';
import { recordPeerMessage } from '../perception/sources.js';
import { removeEntry } from '../scheduler/queue.js';
import { newId } from '../util/ids.js';
import { releaseBlockItems, withdrawBlockItems } from './block-items.js';
import { enqueueJobWakeUndoable, expectedActorOf, isOnDutyNow } from './chain.js';
import { resumeLaunchOfReinstated } from './launch-approval.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, eventsOf, isJobClosed, putJob } from './store.js';

/** 约定标题（一件事没有自己的标题，沿用约定的）。 */
function titleOf(ctx: HubContext, job: Job): string {
  return ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
}

/** 这位员工作为执行者或核对人参与的、还没收尾的事（总管自己核对的不算在员工头上）。 */
export function participantJobs(ctx: HubContext, botId: string): Job[] {
  return ctx.store.table('jobs').list(job => !isJobClosed(job) && (job.executorId === botId || job.reviewerId === botId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 归档检查用：员工正在做一件事时给出拒绝文字；没有则为 null。 */
export function archiveBlockedByJob(ctx: HubContext, bot: Bot): string | null {
  const job = participantJobs(ctx, bot.id)[0];
  return job === undefined ? null : `${bot.name}正在做「${titleOf(ctx, job)}」，请先请总管改派。`;
}

// ---------------------------------------------------------------------------
// 停用
// ---------------------------------------------------------------------------

/** 停用的第一段：把他参与的、正在等他的事转为受阻（participant_off）。返回改动前的记录，失败时据此恢复。 */
export function blockJobsOfSuspended(ctx: HubContext, bot: Bot): { before: Job[]; after: Job[] } {
  const now = ctx.clock.now();
  const before: Job[] = [];
  const after: Job[] = [];
  for (const job of participantJobs(ctx, bot.id)) {
    // 已经受阻的保留原来的受阻原因；等主人验收的事不在等他，也不动。
    if (job.state === 'blocked' || job.state === 'awaiting_owner') continue;
    const next = applyJobAction(job, { type: 'block', kind: 'participant_off', no: null, text: `${bot.name}已停用` }, now);
    // P74r16b：经统一出口写入：这件事所在主题的进度行随之刷新（原来只发项目范围的事件，打开着的主题停在旧状态）。
    putJob(ctx, next);
    before.push(job);
    after.push(next);
  }
  if (after.length > 0) ctx.emit(HUB_EVENT_SCOPES.project, null);
  return { before, after };
}

/**
 * P74r16c 第 2 节：这件事停用期间主人已经选过办法（在这一次受阻里选的）时，唤醒摘要末尾接上选定的办法，
 * 执行者（或核对人）被叫醒就知道主人定了什么；没有选过返回空字符串。
 */
function chosenOptionSuffix(job: Job): string {
  const escalation = job.escalation;
  if (escalation == null || escalation.chosen === null || job.blocked === null) return '';
  if (escalation.blockedSince !== undefined && escalation.blockedSince !== job.blocked.since) return '';
  const option = escalation.options[escalation.chosen];
  return option === undefined ? '' : `；主人为这件事选了办法「${option.title}」：${option.detail}`;
}

/** 把停用第一段改动的事恢复原样。 */
export function restoreJobs(ctx: HubContext, before: readonly Job[]): void {
  for (const job of before) putJob(ctx, job);
}

/**
 * P74r4a 第 6 条：这位员工停用期间，约定新版本回答了他的提问（answered 事件，byAgreementNo 有值，当时没叫醒他：woken 为 false），
 * 并且那之后他还没有做过任何动作：返回那条回答事件；没有返回 null。
 */
function undeliveredAnswerTo(ctx: HubContext, job: Job, botId: string) {
  const events = eventsOf(ctx, job.id);
  const index = events.map(row => row.kind === 'answered' && row.to.includes(botId) && row.data.byAgreementNo !== undefined && row.data.woken === false).lastIndexOf(true);
  if (index < 0) return null;
  const acted = events.slice(index + 1).some(row => row.actor === botId);
  return acted ? null : events[index]!;
}

/** 受阻时停在进度行的哪一步（用进度行视图自己的口径，名字与主人看到的一致）。 */
export function stuckStepName(ctx: HubContext, job: Job): string {
  const names: Record<string, string> = {};
  for (const bot of ctx.store.table('bots').list()) names[bot.id] = bot.name;
  const view = jobProgressView({ agreementState: 'locked', agreementVersionNo: 1, job, names, delayNote: null, now: ctx.clock.now(), timezone: ctx.settings.timezone });
  return view?.steps.find(step => step.state === 'stuck' || step.state === 'current')?.label ?? '执行';
}

/** 停用的第二段：总管私聊一句中心提示，并追加 participant_off 事件。每件事各自兜底，出错只记日志。 */
export function announceParticipantOff(ctx: HubContext, bot: Bot, jobs: readonly Job[]): void {
  for (const job of jobs) {
    try {
      postThread(ctx, { thread: job.chiefId, from: 'hub', kind: 'system', refId: job.id,
        text: `${bot.name}已停用，「${titleOf(ctx, job)}」停在${stuckStepName(ctx, job)}。恢复在岗，或告诉总管改派。` });
      appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'participant_off', to: [job.chiefId], refId: null, data: { botId: bot.id, name: bot.name } });
    } catch (error) {
      ctx.logger.warn('停用后通知总管失败', { jobId: job.id, error: String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// 恢复在岗
// ---------------------------------------------------------------------------

/**
 * 恢复在岗：他参与的、因停用而受阻的事回到原来的状态；如果这件事此刻在等他，就给他入队一次。
 * 另一位参与者仍不在岗时不解除（否则马上又会卡住）。必须在员工的生命周期已经改成在岗之后调用。
 */
export function resumeJobsOfReinstated(ctx: HubContext, bot: Bot): void {
  const now = ctx.clock.now();
  // P74g 复核后：已验收、发布这一步在等他的事（他停用时发布保持准备中），由中心叫醒他接着做。
  resumeLaunchOfReinstated(ctx, bot.id);
  for (const job of participantJobs(ctx, bot.id)) {
    if (job.state !== 'blocked' || job.blocked?.kind !== 'participant_off') continue;
    const others = [job.executorId, job.reviewerId].filter((id): id is string => id !== null && id !== bot.id);
    if (!others.every(id => isOnDutyNow(ctx, id))) continue;
    // 解除之前先取（解除会清掉 blocked，取不到这一次受阻的开始时间）。
    const chosen = chosenOptionSuffix(job);
    // P74r4a 第 3 条：解除受阻统一撤回这件事开着的受阻条目、清编号（状态写好之后才撤回，出错只记日志）。
    const released = releaseBlockItems(ctx, applyJobAction(job, { type: 'unblock' }, now));
    const next = released.job;
    putJob(ctx, next);
    try { withdrawBlockItems(ctx, released.items, now, '员工已恢复在岗，这件事继续进行'); }
    catch (error) { ctx.logger.warn('恢复在岗后撤回受阻条目失败', { jobId: job.id, error: String(error) }); }
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    // 这件事现在在等谁：待开工、执行中、返工中等执行者；核对中等核对人。只叫他等的那个人，免得白耗一个回合。
    const waitingOnHim = (['ready', 'doing', 'rework'].includes(next.state) && next.executorId === bot.id)
      || (next.state === 'checking' && next.reviewerId === bot.id);
    if (!waitingOnHim) {
      // P74r3（H2）：恢复在岗的是核对人，而解除后这件事回到了执行环节（受阻期间约定改写了条目，回到的是返工中）：
      // 这时在等的是执行者，不是刚恢复的核对人：叫执行者去改（他排着的候选在受阻期间被闸门丢弃了；已经排着的不重复排）。
      // 在等谁按这件事所处的环节算（expectedActorOf）：执行环节是执行者，核对中是核对人。
      const executorTurn = ['ready', 'doing', 'rework'].includes(next.state);
      const actorId = next.openAsk === null ? expectedActorOf(next) : null;
      const queued = actorId !== null && ctx.store.table('queue').count(row => row.botId === actorId && row.jobId === job.id) > 0;
      if (actorId !== null && actorId !== bot.id && !queued) {
        const woken = enqueueJobWakeUndoable(ctx, executorTurn
          ? { job: next, botId: actorId, why: 'resumed', eventId: newId('jev', ctx.rng),
            summary: `「${titleOf(ctx, job)}」可以接着做了${chosen}`, ownerSummary: '参与者已恢复在岗，继续做这件事' }
          : { job: next, botId: actorId, why: 'to_review', eventId: newId('jev', ctx.rng),
            summary: `「${titleOf(ctx, job)}」已交回第 ${next.round} 轮，请对照约定逐条核对${chosen}` });
        if (woken.entry === null) ctx.logger.warn('恢复在岗后没有排上唤醒', { jobId: job.id, botId: actorId });
        writeOutreachAudit(ctx, 'job_resume_after_reinstate', { jobId: job.id, botId: actorId }, 'hub', now);
      }
      continue;
    }
    // 恢复在岗是主人亲手点的；执行链候选本来就越过冷却与最短思考间隔。给主人看的短句沿用「恢复在岗，接着做这件事」。
    // P74r4a 第 6 条：他停用期间，他的提问被约定新版本回答了（当时没叫醒他）：这次唤醒带上那条回答，用回答事件的编号叫醒，
    // 他的唤醒包里就会看到「总管刚回答你：按约定第 n 版处理：……」。
    const answer = undeliveredAnswerTo(ctx, job, bot.id);
    const wake = enqueueJobWakeUndoable(ctx, {
      job: next, botId: bot.id, why: 'resumed', eventId: answer === null ? newId('jev', ctx.rng) : answer.id,
      summary: `你已恢复在岗，接着做「${titleOf(ctx, job)}」${answer === null ? '' : `；总管刚回答你：${String(answer.data.text ?? '')}`}${chosen}`, ownerSummary: '恢复在岗，继续做这件事',
    });
    if (wake.entry === null) ctx.logger.warn('恢复在岗后没有排上唤醒', { jobId: job.id, botId: bot.id });
    writeOutreachAudit(ctx, 'job_resume_after_reinstate', { jobId: job.id, botId: bot.id }, 'hub', now);
  }
}

// ---------------------------------------------------------------------------
// 归档的收尾：交接、认领、待批的审批单
// ---------------------------------------------------------------------------

/** 第二段的一步：出错只记日志，不影响归档已经成功。 */
async function softly(ctx: HubContext, what: string, botId: string, work: () => void | Promise<void>): Promise<void> {
  try { await work(); } catch (error) { ctx.logger.warn(`归档收尾失败：${what}`, { botId, error: String(error) }); }
}

/**
 * 归档成功之后处理他留下的三样东西，各写一条审计：
 * 1. 发给他、还没处理的交接改为已拒绝，并通知发起人；
 * 2. 他持有的认领全部删除；
 * 3. 他名下待批的审批单改为拒绝，「待你处理」里对应的条目随之关闭；不叫醒他（他已归档，随后清掉被排上的队）。
 */
export async function settleArchivedLeftovers(ctx: HubContext, bot: Bot): Promise<void> {
  await softly(ctx, '未处理的交接', bot.id, () => {
    for (const handoff of ctx.store.table('handoffs').list(row => row.to === bot.id && (row.status === 'offered' || row.status === 'accepted'))) {
      if (handoff.agendaId !== null) closeHandoffForAgenda(ctx, bot.id, handoff.agendaId, 'dropped');
      else {
        // 没有议程联系的旧交接：直接改状态，口径与 closeHandoffForAgenda 相同，通知发起人。
        const now = ctx.clock.now();
        ctx.store.table('handoffs').patch(handoff.id, { status: 'declined', updatedAt: now });
        enqueuePeerPercept(ctx, recordPeerMessage(ctx, { botId: handoff.from, id: `${handoff.id}:dropped`, summary: `${bot.name} 拒绝了交接：${handoff.task}`, at: now }), { directed: true });
      }
      writeOutreachAudit(ctx, 'archive_handoff_declined', { botId: bot.id, handoffId: handoff.id, task: handoff.task }, 'owner');
    }
  });
  await softly(ctx, '持有的认领', bot.id, () => {
    for (const claim of ctx.store.table('claims').list(row => row.botId === bot.id)) {
      ctx.store.table('claims').remove(claim.id);
      writeOutreachAudit(ctx, 'archive_claim_released', { botId: bot.id, claimId: claim.id, resource: claim.resource }, 'owner');
    }
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  });
  await softly(ctx, '待批的审批单', bot.id, async () => {
    for (const approval of ctx.store.table('approvals').list(row => row.botId === bot.id && row.status === 'pending')) {
      await decideApproval(ctx, approval.id, false, '员工已归档');
      writeOutreachAudit(ctx, 'archive_approval_rejected', { botId: bot.id, approvalId: approval.id, tool: approval.tool }, 'owner');
    }
    // 决定审批会照常给申请人排一次「审批结果」的唤醒；他已归档，不该被叫醒，把排上的队清掉。
    for (const entry of ctx.store.table('queue').list(row => row.botId === bot.id)) removeEntry(ctx, entry.id);
  });
}
