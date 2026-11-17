/**
 * 一件事里的回合被中心结束之后的处理（P74r13 第 3 节）。
 *
 * 为什么需要：P74r11 之后，带 jobId 的回合（执行者做事、核对人核对、发布准备、总管在这件事里被叫醒）不发收口提醒，
 * 只剩两道保护：10 分钟没有任何事件、总时长 60 分钟。一个一直有事件、不断消耗的回合没有别的东西能停下它，
 * 所以另加一条很宽的 token 兜底线（JOB_DEFAULTS.CHAIN_TURN_TOKEN_GUARD）。
 *
 * 这个文件管「结束之后」：两种结束原因（总时长超过 60 分钟；到兜底线、提醒之后 3 分钟仍未结束被取消）
 * 都说明这个回合在失控地消耗，自动重试只会把同一种失控重复一遍，所以不再自动重试：
 * 1. 回合记为超时结束，原因写事实，不按「出错」退避、不排重试（finishTurn 的 noRetry）；
 * 2. 这件事转为受阻，并照现有的受阻流程叫醒总管（job/stuck.ts 的 blockExecutor；受阻原因沿用「执行者」一类，
 *    说明里写明是哪位员工的回合、为什么被结束），由总管判断是换办法、换人，还是告诉主人；
 *    P74r15：写给总管和主人的话直接用这句事实（被结束的是谁的回合就写谁的名字），不写「无法继续」「叫了你两次」；
 *    例外一：总管自己核对（核对人写「总管」）时总管的核对回合被结束，不转受阻（转了之后总管自己也提交不了结论），
 *    走 P74r2a 现有的路：这一轮第一次再叫总管核对一次，第二次由中心建「没有进展」条目告诉主人、不再叫醒总管；
 *    例外二：执行者交回之后还没收尾的回合被结束，这件事在等核对人，不改状态；
 * 3. 已验收、在发布准备中的事，这件事已完成，不转受阻；发布这一步记为「暂不发布」（中心结束的，进度行写没有发布），
 *    总管私聊落一句事实（launchTurnEndedText）；
 *    其余状态（等主人验收、已经受阻、已完成、已停止）这件事本来就不在被中心推进，不再改状态。
 * 「10 分钟没有任何事件」被结束的不走这里，仍按原样自动重试。
 */
import { JOB_DEFAULTS } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { WakeTicket } from '../model/wake.js';
import { postThread } from '../outreach/thread.js';
import { finishTurn } from '../turn/events.js';
import { newId } from '../util/ids.js';
import { closeSentence } from '../util/sentence.js';
import { enqueueJobWake, jobTitleOf } from './chain.js';
import { markDeclined } from './launch-approval.js';
import { inLaunchPhase } from './launch-turns.js';
import { reportStall } from './stall.js';
import { appendJobEvent, eventsOf } from './store.js';
import { blockExecutor } from './stuck.js';

/** 结束的两种原因：overtime 总时长超过上限；overuse 用量超过兜底线。 */
export type ChainEndKind = 'overtime' | 'overuse';

/** 这类回合总时长上限的分钟数（取自默认值，不写死 60）。 */
export function chainHardMinutes(): number {
  return Math.round(JOB_DEFAULTS.CHAIN_TURN_HARD_MS / 60000);
}

/** 受阻说明、发布结束说明用的事实句：{员工}的一个回合……中心已结束它。 */
export function chainEndFact(name: string, kind: ChainEndKind): string {
  return kind === 'overtime' ? `${name}的一个回合超过 ${chainHardMinutes()} 分钟，中心已结束它。` : `${name}的一个回合用量超过上限，中心已结束它。`;
}

/** 回合记录上的原因文字（给界面的员工活动行用，写事实，不写「并安排重试」，因为这类回合不重试）。 */
export function chainEndWakeText(kind: ChainEndKind): string {
  return kind === 'overtime' ? `回合超过 ${chainHardMinutes()} 分钟，中心已结束本回合` : '回合用量超过上限，中心已结束本回合';
}

/** 这件事此刻能不能转为受阻（状态机允许受阻的几个状态）。 */
function canBlock(job: Job): boolean {
  return job.state === 'ready' || job.state === 'doing' || job.state === 'checking' || job.state === 'rework';
}

/** 原因的短语：{超过 60 分钟|用量超过上限}（给发布这一步的那句话用）。 */
export function chainEndReason(kind: ChainEndKind): string {
  return kind === 'overtime' ? `超过 ${chainHardMinutes()} 分钟` : '用量超过上限';
}

/** 事件、受阻记录里标记原因的值（唤醒包据此判断说明本身是不是「中心结束了回合」的事实句）。 */
export function chainEndReasonCode(kind: ChainEndKind): 'turn_overtime' | 'turn_overuse' {
  return kind === 'overtime' ? 'turn_overtime' : 'turn_overuse';
}

/** 发布准备的回合被结束时，总管私聊里的那句话（逐字固定）。 */
export function launchTurnEndedText(executor: string, title: string, kind: ChainEndKind): string {
  return `${executor}准备发布「${title}」的回合${chainEndReason(kind)}，中心已结束它，这次没有发布。`;
}

/** 工作往来里事实句后面接的话：被结束的是总管的回合写「已再叫总管」，其余写「已告诉总管」。 */
function chiefWordsText(chiefTurn: boolean): string {
  return chiefTurn ? '已再叫总管。' : '已告诉总管。';
}

/** 总管自己核对时，同一轮核对里核对回合被中心结束的次数（只数这一轮、这一阶段的记录）。 */
function chiefReviewEndsThisRound(ctx: HubContext, job: Job): number {
  return eventsOf(ctx, job.id).filter(row => row.kind === 'resumed' && typeof row.data.turnEnded === 'string'
    && row.data.round === job.round && row.data.stage === job.stage).length;
}

/**
 * 总管自己核对（核对人写「总管」）时，总管的核对回合被中心结束（P74r15 第 2 节第 1 条）：
 * 不转受阻（转了之后总管自己也提交不了结论），走 P74r2a 现有的那条路：这件事仍在等核对。
 * - 这一轮第一次：再叫总管一次来核对（记一条事件作为计数依据）；
 * - 这一轮第二次：中心建「没有进展」条目告诉主人（正文写事实），不再叫醒总管，避免反复消耗。
 */
function settleChiefReview(ctx: HubContext, job: Job, wake: WakeTicket, now: number, kind: ChainEndKind, fact: string): void {
  const title = jobTitleOf(ctx, job);
  const earlier = chiefReviewEndsThisRound(ctx, job);
  const eventId = newId('jev', ctx.rng);
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: 'hub', kind: 'resumed', to: [job.chiefId], refId: null,
    data: { turnEnded: chainEndReasonCode(kind), round: job.round, stage: job.stage, reason: chainEndReasonCode(kind) } });
  if (earlier === 0) {
    const entry = enqueueJobWake(ctx, { job, botId: job.chiefId, why: 'to_review', eventId,
      summary: `「${title}」第 ${job.round} 轮的核对：${fact}请重新核对，对照约定逐条提交核对结论。` });
    if (entry === null) ctx.logger.warn('总管的核对回合被结束之后没有排上再次核对（总管此刻可能不在岗），等兜底巡检再叫', { jobId: job.id, wakeId: wake.id });
    return;
  }
  const name =ctx.store.table('bots').get(wake.botId)?.name ?? '总管';
  const text = `${name}的核对回合在第 ${job.round} 轮里已被中心结束两次（最近一次：${chainEndReason(kind)}），中心不再自动叫醒${name}。`;
  reportStall(ctx, job, 'ended', now, { actorId: wake.botId, facts: { body: text, thread: `「${title}」停住了：${text}已在「待你处理」里放了一条，请你决定。` } });
}

/**
 * 结束一个带 jobId 的回合，并处理这件事。调用方已经确认 wake.jobId 有值。
 * 宿主取消失败也要写终态（finally），避免永远占住并发位置。
 */
export async function endChainTurn(ctx: HubContext, wake: WakeTicket, now: number, kind: ChainEndKind): Promise<void> {
  try {
    if (wake.sessionId) await ctx.host.cancel(wake.sessionId);
  } finally {
    await finishTurn(ctx, wake.id, now, 'timeout', chainEndWakeText(kind), { noRetry: true });
  }
  settleJobAfterChainEnd(ctx, wake, now, kind);
}

/** 回合结束之后处理这件事（见文件开头第 2、3 条）；出错只记日志，不影响回合已经结束这一事实。 */
function settleJobAfterChainEnd(ctx: HubContext, wake: WakeTicket, now: number, kind: ChainEndKind): void {
  try {
    const job = wake.jobId ? ctx.store.table('jobs').get(wake.jobId) : null;
    if (job === null) return;
    const name = ctx.store.table('bots').get(wake.botId)?.name ?? '员工';
    const fact = chainEndFact(name, kind);
    const title = jobTitleOf(ctx, job);
    if (job.state === 'checking') {
      // 这件事在等核对：被结束的若不是核对人的回合（例如执行者交回之后还没收尾的回合），这件事不在等他，不改状态。
      if (wake.botId !== (job.reviewerId ?? job.chiefId)) return;
      // 总管自己核对：不转受阻，走 P74r2a 现有的路（第一次再叫一次，第二次告诉主人）。
      if (job.reviewerId === null) { settleChiefReview(ctx, job, wake, now, kind, fact); return; }
    }
    if (canBlock(job)) {
      // P74r15：说明本身就是完整的事实句，写的是「谁的回合被结束」：不套「无法继续」「叫了你两次」，也不把别人的回合写成执行者的。
      const text = chiefWordsText(wake.botId === job.chiefId);
      blockExecutor(ctx, job, fact, now, 'hub', { reason: chainEndReasonCode(kind) }, wake.botId === job.executorId ? undefined : wake.botId,
        { summary: `「${title}」：${fact}`, work: `${closeSentence(fact)}${text}` });
      return;
    }
    if (inLaunchPhase(job) && job.launch.state === 'preparing') {
      // 发布准备中的回合：这件事已完成，不转受阻；这一步到此结束（中心结束的，进度行写「已完成（没有发布）」），总管私聊落一句事实。
      markDeclined(ctx, job, now, { reason: chainEndReasonCode(kind) }, 'hub');
      postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: launchTurnEndedText(name, title, kind) });
    }
  } catch (error) {
    ctx.logger.warn('一件事里的回合被结束之后，这件事的处理没有完成', { wakeId: wake.id, jobId: wake.jobId, error: String(error) });
  }
}
