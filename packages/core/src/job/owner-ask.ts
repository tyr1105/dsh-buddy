/**
 * 「这件事跟主人要的东西」的两种口径（P76r3，方案 7.6、7.11；审查 R1）。
 *
 * 为什么分成两种：以前「job.inboxId 指向的条目开着」一个条件同时回答两个问题，结果停滞通知会撤掉主人正在决定的
 * 「消耗将超出预计」条目（R1），逾期的条目也会因为这件事有新记录而消失（R2）。
 * - 甲（ownerAskOpenOf）：这件事真的停下在等你。与闸门（scheduler/snapshot.ts 的 ownerAskOpen）同一口径：
 *   开着的 job:<编号>: 条目里，「将超出预计」（cap）只在因预算线受阻时算，「没有进展」（stall）只在已受阻时算。
 *   成立时停滞判断返回「不算」，重新唤醒和通知都不做。
 *   P84：逾期条目在任何状态下都只算乙，不算甲（这件事转受阻后也一样，条目会在下一次巡检撤回）。
 * - 乙（hasAnyOpenJobItem）：这件事有没有任何一条开着的 job:<编号>: 条目，含不记进 job.inboxId 的「将超出预计」条目。
 *   成立时不发新的停滞通知，但停摆的重新唤醒照做（通知与推进是两件事）。
 *
 * 这两条以后只在这里写一份：闸门、停滞判断、预算线判断、视图都引用这里，口径才不会走偏。
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';

/** 甲：这件事有没有一条「真的停下在等你」的条目（口径与闸门相同）。 */
export function ownerAskOpenOf(ctx: HubContext, job: Pick<Job, 'id' | 'state' | 'blocked'>): boolean {
  const prefix = `job:${job.id}:`;
  // P84（K2）：逾期条目在任何状态下都不算甲：它写的是「这件事在做、已过交付时间」，这件事转受阻之后也不是在等你；
  // 条目是不是逾期的，看这件事的提醒记号（建条目时写 overdue，了结时清空）。
  const overdueOpen = ctx.store.table('jobNotices').get(job.id)?.stallKind === 'overdue';
  return ctx.store.table('inbox').count(item => item.status === 'open' && item.subjectKey.startsWith(prefix)
    // 「将超出预计」只在因预算线受阻时算在等你：问过之后这件事仍在做，不能因为通知了你就让它停下。
    && !(!(job.state === 'blocked' && job.blocked?.kind === 'turn_cap') && item.subjectKey.startsWith(`${prefix}cap:`))
    // 「没有进展」对进行中的事只是通知：只有已经受阻、且不是逾期条目时才算在等你（停摆、空转的条目在受阻的事上仍算）。
    && !((job.state !== 'blocked' || overdueOpen) && item.subjectKey.startsWith(`${prefix}stall:`))) > 0;
}

/** 乙：这件事有没有任何一条开着的 job:<编号>: 条目（含「将超出预计」条目，不看 job.inboxId）。 */
export function hasAnyOpenJobItem(ctx: HubContext, jobId: string): boolean {
  return ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith(`job:${jobId}:`)) > 0;
}
