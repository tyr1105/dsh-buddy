/**
 * 离开「核对三轮不过」的受阻：一律进入新的一个阶段（P74r6 第 1 节，对应独立复验的 N2 和主会话复核发现的主流程问题）。
 *
 * 为什么需要：三轮不过受阻时记下的「解除后回到」是返工中，而本阶段的轮数已经是 3。之前所有出口（总管改派、暂停之后恢复、
 * 改派后仍有人停用再恢复在岗）都只是把状态改回返工中、不动轮数，结果新执行者交回一律被拒（「本阶段已经交回 3 轮……不能再交回」），
 * 这件事只能停止。总则：这件事处在待开工、执行中、返工中时，本阶段的轮数必须小于上限；离开三轮不过的受阻而回到执行者或核对人手里时，
 * 阶段加 1、轮数重新算。
 *
 * 所以这里只有一个函数 exitReviewLimit，所有出口（reassign.ts、stop.ts 的 resume、participants.ts 的恢复在岗）都调用它，不各写各的：
 * - 回到执行者（to 为 rework）：新阶段、返工中、轮数归零；「这一轮要改的条目」取最近一次核对里判不符的条目（问题和改到什么程度算过都带上）；
 * - 回到核对人（to 为 checking）：新阶段、核对中、第 1 轮；最近一次交回由中心按原样重排成新阶段的一条交回记录（标明是中心重排的，
 *   与主人选了带改动的办法之后的重新核对同一种做法）；需要核对人给结论的是上一次判不符的条目（recheckNos）。
 * 同时记下主人选的办法（ownerChoice），执行者、核对人的唤醒包在这一阶段里写明。
 * 纯函数风格：只读存储、不写存储，返回新记录和新的交回记录，由调用方在自己的「写状态」一段里写入并登记撤销。
 */
import type { HubContext } from '../engine/context.js';
import type { Job, JobEscalation, JobSubmission, JobUnmet } from '../model/job.js';
import { newId } from '../util/ids.js';
import { lockedVersionOf } from './files.js';
import { buildOptionSubmission, remapItems, submissionTexts } from './item-remap.js';
import { applyJobAction } from './state.js';
import { latestSubmission, reviewsOf } from './store.js';

/**
 * 这件事现在是不是「受阻（三轮不过或执行者做不下去）、主人已经为这一次受阻选了办法」：是则返回主人选的那次说明；否则 null。
 * 记录里的受阻开始时间要和说明时一致（暂停之后恢复时，中心会把说明里的受阻开始时间同步改成恢复的时间，所以仍然一致）。
 */
export function chosenWhileBlocked(job: Job): JobEscalation | null {
  const escalation = job.escalation;
  if (escalation == null || escalation.chosen === null || job.state !== 'blocked' || job.blocked === null) return null;
  if (escalation.stage !== job.stage || job.blocked.kind !== escalation.kind) return null;
  if (escalation.blockedSince !== undefined && escalation.blockedSince !== job.blocked.since) return null;
  return escalation;
}

/** 主人选的办法（标题和做法）；没有这回事返回 null。 */
export function chosenOptionOf(job: Job): { title: string; detail: string } | null {
  const escalation = chosenWhileBlocked(job);
  const option = escalation === null || escalation.chosen === null ? undefined : escalation.options[escalation.chosen];
  return option === undefined ? null : { title: option.title, detail: option.detail };
}

/**
 * 最近一次核对里判不符的条目，换成现在约定里的序号（按条目原文对应，约定改过之后序号会变）；对不上的条目丢掉。
 * 一条都取不到时，退回用受阻时记下的条目和说明，免得新阶段的返工没有要改的内容。
 */
function lastUnmetOf(ctx: HubContext, job: Job): { unmet: JobUnmet[]; nos: number[] } {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const doneNow = agreement === null ? [] : lockedVersionOf(agreement).content.doneWhen;
  const sub = latestSubmission(ctx, job.id);
  const last = sub === null ? null : reviewsOf(ctx, job.id).filter(row => row.submissionId === sub.id).at(-1) ?? null;
  const unmet: JobUnmet[] = [];
  if (sub !== null && last !== null) {
    const toNow = remapItems(submissionTexts(sub), doneNow).toNew;
    for (const row of last.items) {
      const no = toNow.get(row.no);
      if (row.verdict === 'unmet' && no !== undefined) unmet.push({ no, problem: row.note ?? job.blocked?.text ?? '没有写明', fixTo: row.fixTo ?? '按主人选的办法处理' });
    }
  }
  if (unmet.length === 0) {
    const no = job.blocked?.no ?? 1;
    unmet.push({ no, problem: job.blocked?.text ?? '核对三轮没有通过', fixTo: '按主人选的办法处理' });
  }
  unmet.sort((a, b) => a.no - b.no);
  return { unmet, nos: unmet.map(item => item.no) };
}

/** exitReviewLimit 的结果：进入新阶段之后的这件事；核对中的情形还有重排出来的交回记录（由调用方写入）。 */
export interface ReviewLimitExit { job: Job; submission: JobSubmission | null }

/**
 * 离开三轮不过的受阻，进入新的一个阶段（见文件开头）。这件事必须是受阻状态。
 * 条目编号（inboxId）、说明失效标记由调用方按自己的路径处理（releaseBlockItems、markReleased 等）。
 */
export function exitReviewLimit(ctx: HubContext, job: Job, to: 'rework' | 'checking', now: number): ReviewLimitExit {
  if (job.state !== 'blocked' || job.blocked === null) throw new Error('这件事现在不在受阻状态，不能进入新阶段');
  const choice = chosenOptionOf(job);
  const { unmet, nos } = lastUnmetOf(ctx, job);
  const stageJob = applyJobAction(job, to === 'rework' ? { type: 'review_limit_exit', to, unmet } : { type: 'review_limit_exit', to }, now);
  const { ownerChoice: _old, ...rest } = stageJob;
  // 主人选的办法只在这一个新阶段里显示；没有选过办法（例如暂停之后恢复）就不写。
  const next: Job = choice === null ? rest : { ...rest, ownerChoice: { stage: stageJob.stage, ...choice } };
  if (to === 'rework') return { job: next, submission: null };

  // 核对中：最近一次交回按原样重排成新阶段第 1 轮的一条（标明中心重排），核对人只需要给上一次判不符的条目的结论。
  const sub = latestSubmission(ctx, job.id);
  if (sub === null) throw new Error('这件事还没有交回记录，不能换核对人重新核对');
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null) throw new Error('这件事的约定找不到了，不能换核对人重新核对');
  const locked = lockedVersionOf(agreement);
  const rebuilt = buildOptionSubmission(sub, locked.content.doneWhen, null, locked.no, newId('jsb', ctx.rng), now);
  return { job: { ...next, recheckNos: nos }, submission: { ...rebuilt, stage: next.stage, round: 1 } };
}
