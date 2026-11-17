/**
 * 续排（P74c，方案 7.2 的「续排」）：执行链的回合交账之后，由中心决定「这位员工还要不要接着做」。
 *
 * 为什么由中心续排、不靠员工自己约「下次思考」：已约定的事不该因为员工醒来发现「没事做」而停住，
 * 也不该靠员工记得去约时间。中心看得见这一回合有没有产生交回、提问、做不下去，没有产生就是还没做完，接着叫他。
 *
 * 调用位置：commit/process.ts 在交账处理完成、routeCommit 之后调用；出错只记日志，不影响已保存的交账。
 *
 * 规则（唤醒单带 jobId、交账成功时）：
 * - 执行者，事处于「执行中」或「返工中」：这一回合开始以后，他没有 submitted、asked、executor_blocked 事件，
 *   这件事没有未回答的提问，才续排。交账结果是 progress 或 done：叫他再来一次（why continue）；
 *   no_change、blocked（或 needs_owner，执行者不能直接问主人，按做不下去处理）：这件事转受阻，叫总管（见 stuck.ts）。
 *   中心替没交账的回合合成的交账（syntheticCommit）不是员工自己说的「做不下去」，按「还没做完」再叫一次，次数受回合上限约束。
 * - 核对人（或没有核对人时的总管），事处于「核对中」：这一回合开始以后没有 reviewed 事件，续排一次。
 *   「同一阶段同一轮只续排一次」用 resumed 事件计数：续排时追加一条 data.continue 为真、带阶段与轮次的事件，
 *   再次判断时看有没有同一阶段同一轮的这种事件。
 * - 总管的执行链回合：不续排（总管回答、写说明之后，下一步由对应的中心动作叫人）。
 */
import type { HubContext } from '../engine/context.js';
import type { Commit, WakeTicket } from '../model/wake.js';
import { JobSchema, type JobEvent } from '../model/job.js';
import { newId } from '../util/ids.js';
import { enqueueJobWake, jobTitleOf } from './chain.js';
import { checkBudget } from './budget-ask.js';
import { appendJobEvent, emitJobTopic, eventsOf, putJob } from './store.js';
import { blockExecutor, clipReason } from './stuck.js';
import { continueLaunchAfterCommit } from './launch-blocked.js';

/** 这位员工在本唤醒单开始以后产生过的事件。 */
function eventsSince(ctx: HubContext, jobId: string, botId: string, wake: WakeTicket): JobEvent[] {
  return eventsOf(ctx, jobId).filter(event => event.actor === botId && event.at >= wake.startedAt);
}

/**
 * 交账之后续排。出错由调用方记日志。
 * P76f：续排判断做完之后（不论走了哪条分支、有没有提前返回）看一眼预计消耗：已用加余下大于预算线就问主人一次（这件事不停）。
 * 超时、出错结束的回合由中心合成交账（syntheticCommit），同样经过这里。
 */
export function continueJobAfterCommit(ctx: HubContext, commit: Commit, wake: WakeTicket): void {
  if (!wake.jobId || wake.ownerInitiated) return;
  try {
    continueAfterCommitCore(ctx, commit, wake);
  } finally {
    checkBudget(ctx, wake.jobId);
  }
}

/** 续排的判断本体。 */
function continueAfterCommitCore(ctx: HubContext, commit: Commit, wake: WakeTicket): void {
  if (!wake.jobId) return;
  const job = ctx.store.table('jobs').get(wake.jobId);
  if (!job) return;
  // P74r16b：这一回合交账了：这件事的延迟说明（「排队中」等）随之变化，通知打开着的主题重新读取进度行。
  emitJobTopic(ctx, job);
  // P74r7：这件事已验收（已完成）：发布准备的回合结束了，交给发布这一步的接续（做不下去就结束，否则接着排）。
  if (job.state === 'done') { continueLaunchAfterCommit(ctx, commit, wake, job); return; }
  const botId = commit.botId;
  const now = ctx.clock.now();
  const mine = eventsSince(ctx, job.id, botId, wake);

  // 执行者：执行中或返工中。
  if (botId === job.executorId && (job.state === 'doing' || job.state === 'rework')) {
    // P74r3（L2）：只有执行者自己的提问才拦续排；别人（例如核对人）的提问不拦他。
    if (job.openAsk !== null && job.openAsk.fromId === botId) return;
    if (mine.some(event => event.kind === 'submitted' || event.kind === 'asked' || event.kind === 'executor_blocked')) return;
    // P74r2b：约定有新版本在等主人确认期间，执行者做完照常在做的部分之后，不再续排，也不当作做不下去：
    // 信号一是他的交回因等确认被拒（work.ts 已记下 executorWaiting），信号二是这一回合交账的结果写了 no_change、blocked、needs_owner。
    // 出现任一信号就记下「执行者在等确认」：这件事此刻在等谁为空，兜底巡检不叫人；确认或撤销时随暂停一起清掉，中心叫醒他。
    // 交账结果是 progress、done 且没有信号的，照旧续排（受回合上限约束）。
    if (job.pause !== null) {
      const noProgress = commit.outcome === 'no_change' || commit.outcome === 'blocked' || commit.outcome === 'needs_owner';
      if (job.pause.executorWaiting === true || noProgress) {
        if (job.pause.executorWaiting !== true) {
          putJob(ctx, JobSchema.parse({ ...job, pause: { ...job.pause, executorWaiting: true }, updatedAt: now }));
        }
        return;
      }
    }
    const progressed = commit.outcome === 'progress' || commit.outcome === 'done' || wake.syntheticCommit === true;
    if (progressed) {
      const entry = enqueueJobWake(ctx, { job, botId, why: 'continue', eventId: null,
        summary: `接着做「${jobTitleOf(ctx, job)}」：上一回合还没有交回，也没有提问或说明做不下去` });
      if (entry === null) ctx.logger.warn('续排没有排上（员工此刻可能不在岗），等兜底巡检再叫', { jobId: job.id, botId });
      return;
    }
    // 空手而归（no_change、blocked、needs_owner）：当作做不下去，说明取交账的受阻说明，没有就取摘要。
    blockExecutor(ctx, job, clipReason(commit.blocker ?? commit.summary, '没有说明原因'), now, botId);
    return;
  }

  // 核对人：核对中，且是这位员工的核对（核对人为空时是总管）。
  if (job.state === 'checking' && botId === (job.reviewerId ?? job.chiefId) && job.openAsk === null) {
    if (mine.some(event => event.kind === 'reviewed')) return;
    const continued = eventsOf(ctx, job.id).some(event => event.kind === 'resumed' && event.data.continue === true
      && event.data.stage === job.stage && event.data.round === job.round);
    if (continued) return;
    const eventId = newId('jev', ctx.rng);
    const entry = enqueueJobWake(ctx, { job, botId, why: 'continue', eventId,
      summary: `接着核对「${jobTitleOf(ctx, job)}」：上一回合还没有提交核对结论` });
    if (entry === null) { ctx.logger.warn('核对的续排没有排上（核对人此刻可能不在岗），等兜底巡检再叫', { jobId: job.id, botId }); return; }
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: 'hub', kind: 'resumed', to: [botId], refId: null,
      data: { continue: true, stage: job.stage, round: job.round } });
  }
}
