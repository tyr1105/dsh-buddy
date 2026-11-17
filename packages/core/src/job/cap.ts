/**
 * 回合用到预算线时停下这件事（P74c，方案 7.3 的前半；P76f 起条目与「将超出预计」合并，建条目交给 budget-ask.ts）。
 *
 * 为什么要有预算线：执行链的唤醒越过了员工的自主预算（见 scheduler/gates.ts），每件事的预算线（Job.turnCap）是唯一的消耗兜底。
 * 到预算线就不能悄悄停：一次做完三件事——
 *   1. 这件事转「受阻」（原因：回合用到上限），记 turn_cap 事件，清掉队列里这件事的全部候选；
 *   2. 总管私聊以总管名义落一句话，让主人知道它停了；
 *   3. 「待你处理」里放一条（没有默认选项、不会到期）：有预计的事是「追加 n 个回合」「缩小范围」「暂停」三个办法，
 *      之前已经因为「将超出预计」问过的不再建；没有预计的旧事沿用原来的文字与选项（再给 8 个回合、暂停）。
 * 主人选哪一项之后怎样继续，在 job/budget-answer.ts、blocked-answer.ts：本文件只负责「到预算线时判断并停下」。
 *
 * 两个地方会调用 blockForTurnCap：每个 tick 的巡检（job/sweep.ts），以及闸门丢弃了一条 job_cap 的候选之后（settleDroppedJobEntry）；
 * 交回、提交核对结论没能叫醒下一个人时也会（options.stuckText）。
 * 它是幂等的：已经停下、还没到预算线、最后一个回合还在跑，都直接返回 false。
 * P74r1（R2）：已经因为别的原因受阻的事（执行者做不下去、核对三轮不过、有人停用）也适用——状态和受阻原因保持不变，
 * 只补上这条「待你处理」和总管私聊一句，条目正文多一行现在卡在哪里。
 */
import type { HubContext } from '../engine/context.js';
import type { SuppressedBy } from '../appraisal/log.js';
import type { QueueEntry } from '../model/wake.js';
import { createInboxItem } from '../outreach/inbox.js';
import { isOpenWake } from '../turn/session.js';
import { jobTitleOf } from './chain.js';
import { stopLaunchForCap } from './launch-approval.js';
import { askBudget, stopAtCap } from './budget-ask.js';
import { capSubjectKey, HOLD_OPTION, LEGACY_TOP_UP_OPTION, LEGACY_TOP_UP_TURNS } from './block-options.js';
import { latestEstimate } from './estimate.js';
import { inLaunchPhase } from './launch-turns.js';
import { waitingReasonOf } from './wait-text.js';
import { applyJobAction } from './state.js';

export { capSubjectKey };

/** 这件事此刻有没有员工正在跑它的回合。 */
export function hasOpenJobWake(ctx: HubContext, jobId: string): boolean {
  return ctx.store.table('wakes').count(wake => wake.jobId === jobId && isOpenWake(wake)) > 0;
}

/** blockForTurnCap 的可选参数（P74e 修正）。 */
export interface TurnCapOptions {
  /**
   * 交回、提交核对结论因回合上限没有叫醒下一个人时，由那个动作立即调用：
   * 现在卡在什么（等谁做什么），写进条目正文的「现在卡在」；并且不再等「最后一个回合结束」——
   * 这个动作本身就是那个回合的最后一步，下一个人本来就叫不醒。
   */
  stuckText?: string;
}

/**
 * 到预算线就停下并告诉主人。返回是否真的做了。
 * 最后一个回合还在跑时不动它（否则这一回合想交回也交不了），等它结束后的下一次巡检再停；
 * 例外：交回、核对因回合上限没能叫醒下一个人时（options.stuckText），那个动作本身就是最后一步，立即处理。
 * 前置条件都满足之后：有预计的事交给 askBudget（reached）；没有预计的旧事沿用原来的条目。
 */
export function blockForTurnCap(ctx: HubContext, jobId: string, now: number, options: TurnCapOptions = {}): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  if (!job) return false;
  const running = ['ready', 'doing', 'checking', 'rework'].includes(job.state);
  // P74r1（R2）：已经因为别的原因受阻（执行者做不下去、核对三轮不过、有人停用）的事，回合用到上限时也要让主人知道，
  // 否则总管那次写说明的唤醒被上限丢弃，这件事就既停下又没人知道。回合上限本身造成的受阻（含主人选了先停下）已经告诉过主人，不再重复。
  const waiting = job.state === 'blocked' && job.blocked !== null && job.blocked.kind !== 'turn_cap' && job.blocked.kind !== 'owner_hold';
  if (!running && !waiting) return false;
  if (job.turnsUsed < job.turnCap) return false;
  if (options.stuckText === undefined && hasOpenJobWake(ctx, job.id)) return false;
  // P74r6：这件事有开着的说明条目（在等主人选办法）时，不另建预算线条目：主人面前同一件事只有一个入口，
  // 选办法时回合已用完的，由选办法本身追加回合（choose-option.ts）。
  if (ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:escalate:`)) > 0) return false;
  // 同一件事同一个预算线只建一条（不论那一条是开着还是已经答复过）：巡检每个 tick 都会来，必须幂等。
  // 已经受阻的事（waiting）再查一次：同一个预算线已经建过条目，不重复建。
  const subjectKey = capSubjectKey(job.id, job.turnCap);
  if (waiting && ctx.store.table('inbox').count(row => row.subjectKey === subjectKey) > 0) return false;
  // 有预计的事：统一经 askBudget。
  if (latestEstimate(ctx, job.agreementId) !== null) return askBudget(ctx, job.id, 'reached', options.stuckText === undefined ? {} : { stuckText: options.stuckText });
  return blockWithoutEstimate(ctx, job.id, waiting, now, options);
}

/**
 * 没有预计的旧事到上限：沿用原来的「回合用到上限」条目（文字和选项都不变：再给 8 个回合、暂停）。
 * 为什么保留：旧数据没有预计，没法算「估计共需」；改文字会让旧事的主人看到突然不同的话。
 */
function blockWithoutEstimate(ctx: HubContext, jobId: string, waiting: boolean, now: number, options: TurnCapOptions): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  if (!job) return false;
  // 这一个预算线已经建过条目（开着或已答复）：不重复建。
  if (options.stuckText !== undefined && ctx.store.table('inbox').count(row => row.subjectKey === capSubjectKey(job.id, job.turnCap)) > 0) return false;
  const title = jobTitleOf(ctx, job);
  // 受阻的事再写一行「现在卡在哪里」，取当时的受阻原因；没有受阻原因就不写。
  // P74e：交回、核对结论因回合上限没能叫醒下一个人时，由那个动作写明「在等谁做什么」，优先于受阻原因。
  // P74r2b：约定有新版本在等主人确认时，「现在卡在」写这一句（优先于受阻原因；交回、核对没能叫醒下一个人的说明仍然最优先）。
  // P74f-2（G10）：真正在等什么按事实写（有未回答的提问、约定待确认、核对人没有动静，其余取受阻说明并过内部名称检查），见 wait-text.ts。
  const real = waitingReasonOf(ctx, job, { ignoreBlockText: !waiting });
  const stuckSource = options.stuckText ?? (real === null ? '' : real.startsWith('约定第') ? `${real}。` : real);
  const stuckLine = stuckSource.trim() !== '' ? `\n目前停在：${stuckSource}` : '';
  // 先做会出错的一步（建主人要处理的条目），成功之后才改状态：出错时这件事保持原样，下一次巡检再试。
  const item = createInboxItem(ctx, {
    botId: job.chiefId, type: 'question', title: `${title}：回合用到上限`,
    body: `已用 ${job.turnsUsed} 个回合。继续做最多再用 ${LEGACY_TOP_UP_TURNS} 个回合。${stuckLine}`,
    options: [LEGACY_TOP_UP_OPTION, HOLD_OPTION], defaultOption: null, expiresAt: null, priority: 'P1',
    refId: job.id, subjectKey: capSubjectKey(job.id, job.turnCap),
  });
  // 进行中的事转「受阻（回合用到上限）」；已经受阻的事保持原来的受阻原因，只记下这条目（原来没有条目时）。
  const next = waiting ? job : applyJobAction(job, { type: 'block', kind: 'turn_cap', no: null, text: '回合用到上限' }, now);
  stopAtCap(ctx, job, { ...next, inboxId: item.id }, item.id, `${title}已用到本件事的回合上限（${job.turnCap} 个），在等你决定是否继续。`);
  return true;
}

/**
 * 闸门丢弃了一条执行链候选之后（scheduler/select.ts 调用）：
 * - job_cap：这件事的剩余回合已经是 0，立刻停下并告诉主人（不必等下一个 tick）；
 * - job_inactive：这件事的状态本来就是事实（已完成、已停止、等你验收、受阻……），进度行如实显示，不用再改什么；
 * - paused：员工已停用。参与者停用时 P74b 已把这件事转成受阻；总管停用时不改状态，兜底巡检在他恢复在岗后重新叫他。
 * 三种丢弃都已经由 select.ts 写进评估日志（带原因码和短句），这里只处理 job_cap。
 */
export function settleDroppedJobEntry(ctx: HubContext, entry: QueueEntry, by: SuppressedBy, now: number): void {
  if (!entry.jobId) return;
  if (by !== 'job_cap') return;
  // P74g 复核后：已验收、在发布环节的事被丢弃的是发布自己的回合上限：这一步记为「暂不发布」，不走回合上限的条目。
  const job = ctx.store.table('jobs').get(entry.jobId);
  if (job !== null && inLaunchPhase(job)) { stopLaunchForCap(ctx, job.id); return; }
  blockForTurnCap(ctx, entry.jobId, now);
}
