/**
 * 解除受阻时，这件事开着的「待你处理」条目（停住了、回合上限、三轮不过的说明）要撤回（P74f-2，P74r2a 第 1 条）。
 *
 * 为什么需要：之前只有总管提交核对结论、换核对人、改派这三条路径会撤回「停住了」条目。让这件事接着做的其余路径
 * （总管回答、转交材料、主人选了办法、主人答复回合上限条目）没有撤回，条目一直开在主人面前，而事情早已在往前走；
 * 主人再点它，答复落在已经过时的事上。主人面前同一件事同一时刻只有一个入口，入口随事情的进展消失。
 *
 * 用法分两步，对应「先改状态、全部成功之后才做主人看得见的动作」：
 * 一、第一段写状态时，用 openBlockItems 取出开着的条目，job.inboxId 一并清空（clearedInboxId）；
 * 二、状态全部写成功之后，第三段用 withdrawBlockItems 把条目撤回（出错只记日志）。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { markReleased } from './escalation-expiry.js';
import { clearOverdueMark } from './notices.js';

/** 这件事开着的 job: 条目里属于「受阻」一类的（不含验收条目：验收条目只在待你验收时有，不会和受阻同时存在）。 */
export function openBlockItems(ctx: HubContext, jobId: string): InboxItem[] {
  return ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:`)
    && !row.subjectKey.startsWith(`job:${jobId}:accept:`));
}

/** 状态里要记的条目编号：开着的受阻条目被撤回之后清空；没有受阻条目时保持原样。 */
export function clearedInboxId(job: Pick<Job, 'inboxId'>, items: readonly InboxItem[]): string | null {
  return items.length > 0 ? null : job.inboxId;
}

/**
 * P74r4a 第 3 条：所有让这件事离开受阻的路径（回答、转交、改派、换核对人、恢复在岗、主人选办法、答复回合上限、再叫一次、
 * 先停下之后的恢复……）统一用这一个函数收拢「受阻条目」的处理，不再各写各的。
 * 第一段（写状态时）：返回把条目编号清空的这件事，和开着的受阻条目（说明、「停住了」、回合上限）；
 * 第三段（状态全部写成功之后）：调用方对 items 调 withdrawBlockItems。
 * 编号一律清空（不看有没有条目）：离开受阻之后，这件事不会再有指向受阻条目的编号，免得旧编号让兜底巡检不叫总管。
 */
export function releaseBlockItems(ctx: HubContext, job: Job): { job: Job; items: InboxItem[] } {
  // P74r4a-m1：主人没有选的说明，随这次受阻的解除标为「已接着做」（released），卡片据此写事实。
  return { job: markReleased({ ...job, inboxId: null }), items: openBlockItems(ctx, job.id) };
}

/**
 * P74r4a 第 3 条第 2 点：巡检里的自我修复，让「条目编号」「开着的受阻条目」与这件事的状态一致。返回是否修复了什么。
 * 一、条目编号指向的条目已经不存在、或不是开着的：清掉编号；
 * 二、这件事不在受阻，却有开着的说明条目：撤回（说明只对受阻有意义）；
 *    「没有进展」条目（P76g）不在这里撤回：它对待开工、执行中、核对中、返工中的事同样有效（见下面的说明）。
 * 回合上限条目不在这里处理：进行中的事到上限时本来就会有。每次修复记一条日志。
 */
export function repairBlockItems(ctx: HubContext, jobId: string, now: number): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null || job.state === 'done' || job.state === 'stopped') return false;
  let repaired = false;
  if (job.inboxId !== null) {
    const item = ctx.store.table('inbox').get(job.inboxId);
    if (item === null || item.status !== 'open') {
      ctx.store.table('jobs').patch(job.id, { inboxId: null, updatedAt: now });
      ctx.logger.warn('这件事记的条目编号指向的条目已不在或已关闭，已清掉编号', { jobId: job.id, inboxId: job.inboxId });
      repaired = true;
    }
  }
  // P76g：「没有进展」条目不再只存在于受阻或总管自己核对的事：停摆、空转、逾期的事本来就在待开工、执行中、核对中、返工中，
  // 条目在这些状态下都是有效的，不在这里撤回；它随新记录撤回（job/stall-check.ts）、随你的答复了结、随事进入待你验收时被取代。
  const stale = job.state === 'blocked' || job.state === 'awaiting_owner' ? [] : openBlockItems(ctx, job.id).filter(item =>
    item.subjectKey.startsWith(`job:${job.id}:escalate:`));
  if (stale.length > 0) {
    withdrawBlockItems(ctx, stale, now, '这件事已不在等你处理');
    const fresh = ctx.store.table('jobs').get(job.id);
    if (fresh !== null && fresh.inboxId !== null && stale.some(item => item.id === fresh.inboxId)) {
      ctx.store.table('jobs').patch(job.id, { inboxId: null, updatedAt: now });
    }
    ctx.logger.warn('这件事不在受阻，却有开着的说明或「停住了」条目，已撤回', { jobId: job.id, count: stale.length });
    repaired = true;
  }
  return repaired;
}

/** 撤回条目（答复栏写明原因）。出错由调用方只记日志。 */
export function withdrawBlockItems(ctx: HubContext, items: readonly InboxItem[], now: number, why: string): void {
  for (const item of items) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: why, answeredAt: now });
    emitInboxChange(ctx, item);
    // P84（K4）：撤回的是「没有进展」条目时，逾期记号一并清掉（事项键 job:<编号>:stall:<序号>）。
    const stallOf = /^(job_[^:]+):stall:/.exec(item.subjectKey);
    if (stallOf !== null) clearOverdueMark(ctx, stallOf[1]!);
  }
}
