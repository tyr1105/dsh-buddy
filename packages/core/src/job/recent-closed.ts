/**
 * 这位总管名下「最近收尾的事」的取数（P88、P88r1 共用）。
 *
 * 为什么单独放一个文件：两处要用同一个口径——
 * 一、总管唤醒包「你手上的事」一览里的「最近收尾的事」（wake/job-section-chief.ts）；
 * 二、完成声明核对里「已验收完成的事」的名单（commit/claim-evidence.ts，说这件事「做完了」有中心的验收记录可查）。
 * 口径写在一处，两边才不会对「最近」「收尾」的理解不一致；commit/ 不引用 wake/，所以放在 job/ 下。
 *
 * 收尾时间：已完成取验收时间，已停止取停止时间，缺失（旧数据）取记录更新时间。
 * 范围：收尾时间在最近 RECENT_CLOSED_DAYS 天内（含整 7 天）。按收尾时间从近到远排列。
 * 只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import { JOB_DEFAULTS as D } from '../config/defaults.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 一件最近收尾的事和它的收尾时间。 */
export interface ClosedJob { job: Job; at: number }

/** 这件事的收尾时间。 */
function closedAt(job: Job): number {
  return (job.state === 'done' ? job.acceptedAt : job.stoppedAt) ?? job.updatedAt;
}

/**
 * 这位总管名下最近收尾的事。states 指定要哪几种（已完成、已停止）；max 不写表示不设件数上限。
 * 排序：收尾时间从近到远，相同时创建得晚的在前。
 */
export function recentClosedJobs(ctx: HubContext, chiefId: string, states: ReadonlyArray<'done' | 'stopped'>, max?: number): ClosedJob[] {
  const now = ctx.clock.now();
  const rows = ctx.store.table('jobs').list(job => job.chiefId === chiefId && (states as readonly string[]).includes(job.state))
    .map(job => ({ job, at: closedAt(job) }))
    .filter(row => now - row.at <= D.RECENT_CLOSED_DAYS * DAY_MS)
    .sort((a, b) => b.at - a.at || b.job.createdAt - a.job.createdAt);
  return max === undefined ? rows : rows.slice(0, max);
}

/** 这位总管名下最近验收完成的事的标题（不含已停止；不设件数上限）。完成声明核对用。 */
export function recentAcceptedTitles(ctx: HubContext, chiefId: string): string[] {
  return recentClosedJobs(ctx, chiefId, ['done']).map(row => ctx.store.table('agreements').get(row.job.agreementId)?.title ?? '');
}
