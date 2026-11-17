/**
 * 停止与恢复（P74e，方案 6，裁定 6；P74f-2 改了停止的依据）：hub_job_manage 的 stop、resume。
 *
 * 停下一件事只有两种依据（补充要求第 1 节）：
 * 一、主人确认了一个写明不再做的约定版本（stopsJob）：由中心直接停下，不经过这里，见 stops-job.ts；
 * 二、主人在这一回合的原话里直接说了不做：总管在主人发起的回合里调用 stop，中心检查三点——
 *    这一回合是主人发消息叫醒的；那条消息不是确认口令、也不是任何版本的确认消息；那条消息晚于这件事的派活时间。
 *    不满足就拒绝：总管不能自己决定停掉一件事，也不能在派活的那一回合（叫醒它的是主人的「定了」）里把事停掉。
 * 以前「某个已固定版本的确认消息在本回合证据里」也算依据，已删去：总管在派活的那一回合里就能借它停事。
 *
 * 停止的结果：这件事转「已停止」；队列里这件事的全部候选（含别的员工的）清掉；这件事开着的「待你处理」条目撤回；
 * 之后不再续排、不再兜底（状态机的终态，闸门对已停止的事一律丢弃，巡检只看没收尾的事）。具体动作在 stop-core.ts。
 * 恢复（只对「你让先停下」的事）：回到停下前的状态；回合已用完的追加 LEGACY_TOP_UP_TURNS（8）个；叫醒该叫的人，恰好一位。
 *
 * 和别的服务一样分三段（方案 6.4）：校验、写状态（有备份，全部成功才算数）、主人看得见的话。
 * 工具返回成功时，状态确实已经改好。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { JobSchema, type Job } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { isConfirmPhrase } from '../project/agreement-confirm.js';
import { ownerMessageOfWake } from '../project/agreements.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import type { JobManageArgs } from './assign.js';
import { mentionsOwnerWord, ownerTextProblem } from './owner-text.js';
import { openBlockItems, releaseBlockItems, withdrawBlockItems } from './block-items.js';
import { LEGACY_TOP_UP_TURNS } from './block-options.js';
import { raiseJobBudget } from './budget-line.js';
import { chosenOptionOf, chosenWhileBlocked, exitReviewLimit } from './review-limit-exit.js';
import { appendEstimateVersion, latestEstimate } from './estimate.js';
import { nextEstimate, topUpTokens } from './budget-text.js';
import { expectedActorOf, jobTitleOf } from './chain.js';
import { assertOpen, chiefJobOf, currentWake, isOwnerTurn, requireChief, requireFields } from './manage-common.js';
import { stopJobCore } from './stop-core.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { queueWake, runUndo, softly, type UndoSteps } from './work-common.js';

/** 不满足停止条件时的报错（原文）。 */
export const STOP_REFUSED_TEXT = '只有主人说不做了，才能停下这件事：这一回合不是主人这样说之后叫醒的。主人要是还没拿定，用 hub_agreement_submit 的 mode revise 并写 stopsJob，请主人确认。';

/**
 * 这一回合是不是「主人说了不做」之后叫醒的：叫醒这一回合的是主人的一条消息，它不是确认口令、
 * 不是这份约定任何版本的确认消息，并且晚于这件事的派活时间（派活那一回合里叫醒总管的是主人的「定了」，早于派活）。
 */
function ownerSaidStop(ctx: HubContext, tc: ToolContext, job: Job): boolean {
  const wake = currentWake(ctx, tc);
  if (!wake) return false;
  const message = ownerMessageOfWake(ctx, wake);
  if (message === null) return false;
  if (isConfirmPhrase(message.text)) return false;
  // P74r4a 第 7 条：叫醒这一回合的必须是主人自己发的话，不是主人对条目的答复（点办法、验收、「定了」这类由中心代主人落的话，
  // 消息上带着它们所属的记录编号，不是 null，也不是这一回合的唤醒单编号）；
  // 并且这句话发在这件事的主题里，或发在总管的私聊、与总管的直接对话里；发在别的事的主题里的不算。
  if (message.refId !== null && message.refId !== wake.id) return false;
  if (message.thread !== job.topicId && message.thread !== job.chiefId) return false;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement?.versions.some(version => version.confirmMessageId === message.id)) return false;
  return message.createdAt > job.assignedAt;
}

/** stop 的入口：返回给模型看的一句话。 */
export async function runJobStop(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '停止这件事');
  requireFields('stop', args, ['jobId', 'reason']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '停止');
  if (!isOwnerTurn(ctx, tc)) throw new Error('停止这件事只能在主人发话、确认或回答叫醒的回合里进行');
  if (!ownerSaidStop(ctx, tc, job)) throw new Error(STOP_REFUSED_TEXT);
  const reason = args.reason!.trim();
  if (reason === '' || [...reason].length > D.NOTE_MAX_CHARS) throw new Error(`reason：1 到 ${D.NOTE_MAX_CHARS} 个字`);
  // P74r14：停止的原因会原样显示给主人（「这件事已停止：……」），称呼写「你」。
  const addressProblem = ownerTextProblem('reason', reason, { noOwnerWord: true });
  if (addressProblem !== null && mentionsOwnerWord(reason)) throw new Error(addressProblem);

  // ---- 第二、三段：写状态、说话（共用 stop-core.ts）----
  const title = stopJobCore(ctx, job, { actor: chief.id, reason, via: 'owner_words',
    topic: { from: chief.id, kind: 'reply', text: `这件事已停止：${reason}` } });
  return `「${title}」已停止，队列里这件事的叫醒已全部清掉。`;
}

/** resume 的入口：返回给模型看的一句话。 */
export async function runJobResume(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '恢复这件事');
  requireFields('resume', args, ['jobId']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '恢复');
  if (!isOwnerTurn(ctx, tc)) throw new Error('恢复这件事只能在主人发话、确认或回答叫醒的回合里进行');
  // P74r6：除了主人已暂停的事，主人已为这次受阻（三轮不过、执行者做不下去）选了不带改动的办法、这件事仍受阻的事也能 resume。
  const held = job.blocked?.kind === 'owner_hold';
  if (!held && chosenWhileBlocked(job) === null) {
    throw new Error('只有主人已暂停的事、或主人已为这次受阻选了办法的事才能恢复；这件事现在不是这两种状态');
  }

  // ---- 第二段：写状态，有备份 ----
  const now = ctx.clock.now();
  let next: Job;
  let restoredBlock = false;
  const was = job.blocked!;
  if (held && (was.heldFrom?.kind === 'review_limit' || was.heldFrom?.kind === 'executor')) {
    // 暂停前是三轮不过或执行者做不下去：恢复成原来的受阻（受阻开始时间记为恢复的时间，算新的一次受阻），由总管处理。
    const { heldFrom, ...rest } = was;
    const e = job.escalation;
    // 主人暂停之前已经选过办法的：说明里的受阻开始时间同步改成现在，仍算「这一次受阻」的已选办法。
    const keepChoice = e != null && e.chosen !== null && e.stage === job.stage && e.kind === heldFrom!.kind;
    next = { ...job, updatedAt: now, inboxId: null, blocked: { ...rest, kind: heldFrom!.kind, no: heldFrom!.no, text: heldFrom!.text, since: now },
      ...(keepChoice ? { escalation: { ...e!, blockedSince: now } } : {}) };
    restoredBlock = true;
  } else if (held && was.heldFrom === undefined && was.resumeTo === 'rework' && job.round >= D.REVIEW_ROUNDS_MAX) {
    // 旧数据：三轮不过之后暂停的事没有记下原来的受阻原因，但本阶段轮数已满，回到返工中交回会被拒：同样进入新阶段。
    const exit = exitReviewLimit(ctx, job, 'rework', now);
    next = releaseBlockItems(ctx, exit.job).job;
  } else if (job.blocked?.kind === 'review_limit') {
    // 主人已选办法、不换人：进入新的一个阶段（返工中、轮数归零），叫醒执行者。
    const exit = exitReviewLimit(ctx, job, 'rework', now);
    next = releaseBlockItems(ctx, exit.job).job;
  } else {
    // 回合上限等其余原因、或执行者做不下去：回到受阻前的环节（P74r4a 第 3 条：统一走 releaseBlockItems）。
    const choice = chosenOptionOf(job);
    next = releaseBlockItems(ctx, applyJobAction(job, { type: 'unblock' }, now)).job;
    if (choice !== null) next = { ...next, ownerChoice: { stage: next.stage, ...choice } };
  }
  const released = { job: next, items: openBlockItems(ctx, job.id) };
  // 回合已经用完的，追加一次（与主人在回合上限条目里选「再给回合」同一个数）。
  // P76r3（R3）：有预计的事同时追加一项预计，保持「预计总数 − 对齐 == 预算线」，给主人看的「预计 N」不再写旧数。
  const toppedUp = next.turnsUsed >= next.turnCap;
  if (toppedUp) next = raiseJobBudget(ctx, next, LEGACY_TOP_UP_TURNS, 'top_up');
  next = JobSchema.parse(next);
  const actorId = expectedActorOf(next);
  const actor = actorId === null ? null : ctx.store.table('bots').get(actorId);
  if (actor === null) throw new Error('恢复后没有该叫醒的人，不能恢复');
  const eventId = newId('jev', ctx.rng);
  const undo: UndoSteps = [];
  try {
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    if (toppedUp) {
      const last = latestEstimate(ctx, job.agreementId);
      if (last !== null) {
        const tokens = topUpTokens(ctx, job.agreementId, LEGACY_TOP_UP_TURNS);
        undo.push(appendEstimateVersion(ctx, job.agreementId,
          nextEstimate(last, 'top_up', now, { n: LEGACY_TOP_UP_TURNS, low: tokens.low, high: tokens.high })));
      }
    }
    // 恢复成三轮不过、执行者做不下去的受阻时，叫醒的是总管，请他向主人说明（why 为 escalate，唤醒包里有写说明的做法）。
    queueWake(ctx, { job: next, botId: actor.id, why: restoredBlock ? 'escalate' : 'resumed', eventId,
      summary: restoredBlock ? `主人让这件事接着做：「${jobTitleOf(ctx, job)}」仍卡在原来的地方，请向主人说明` : `主人让这件事接着做：「${jobTitleOf(ctx, job)}」` }, undo, actor.name);
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: chief.id, kind: 'resumed', to: [actor.id], refId: null,
      data: { resume: true, cap: next.turnCap } });
  } catch (error) {
    await runUndo(ctx, undo, '恢复', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`恢复失败，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_resume', { jobId: job.id, to: actor.id }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, actor.id);

  // ---- 第三段：主人看得见的话 ----
  softly(ctx, '撤回受阻条目', () => { withdrawBlockItems(ctx, released.items, now, '这件事已恢复，继续进行'); });
  softly(ctx, '工作往来里的提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: '总管按你的话恢复了这件事。' });
  });
  if (restoredBlock) return `已恢复，这件事回到原来的受阻，${actor.id === job.chiefId ? '你' : actor.name}会被叫醒向主人说明办法。`;
  // 离开三轮不过的受阻进入了新阶段：写明核对从新的三轮算起。
  if (next.stage > job.stage) return `已恢复，进入新的一个阶段，核对从新的三轮算起，${actor.name}会接着做。`;
  return `已恢复，${actor.name}会接着做。`;
}
