/**
 * 一件事的预算线（P76e、P76f）：Job.turnCap 只经这里改。
 *
 * 为什么只留一个入口：预算线从原来固定的 16 个回合，变成「预计总数减去已用的对齐回合」，
 * 以后还有追加（你给更多回合）、缩小范围两种改法。散在各处改，就没法保证「预算线」和「预计」对得上，
 * 也没法在一处统一记日志。
 * 两种用法：
 * - setJobBudget：直接读写存储（派活之外的单独改动用）；
 * - withJobBudget：纯改一份这件事的拷贝并记日志，不写存储。答复条目、选办法、恢复这几处本来就是「先算出下一个状态、
 *   在带备份的一次写入里写下」，所以用它。
 * 例外只有一处：建这件事时直接写初值（job/assign.ts，建记录和写预算线是同一次写入）。
 */
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job } from '../model/job.js';
import { putJob } from './store.js';

/** 为什么改：派活（assign）、你追加（top_up）、缩小范围（narrow）。 */
export type BudgetReason = 'assign' | 'top_up' | 'narrow';

/** 回合数规整：至少为 1 的整数。 */
function normalizedCap(cap: number): number {
  return Math.max(1, Math.floor(cap));
}

/** 返回预算线改成 cap 的这件事的拷贝（不写存储），并记一条日志。 */
export function withJobBudget(ctx: HubContext, job: Job, cap: number, reason: BudgetReason): Job {
  const next = normalizedCap(cap);
  ctx.logger.info('预算线已改', { jobId: job.id, from: job.turnCap, to: next, reason });
  return { ...job, turnCap: next };
}

/** 返回预算线增加 by 个回合的这件事的拷贝（不写存储）：追加回合的几处（答复、选办法、恢复）用它，不在别处做加法。 */
export function raiseJobBudget(ctx: HubContext, job: Job, by: number, reason: BudgetReason): Job {
  return withJobBudget(ctx, job, by + job.turnCap, reason);
}

/** 读存储里这件事的预算线，增加 by 个回合并写入；返回改后的预算线。 */
export function raiseBudgetBy(ctx: HubContext, jobId: string, by: number, reason: BudgetReason): number {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null) throw new Error('预算线：没有这件事');
  return setJobBudget(ctx, jobId, by + job.turnCap, reason);
}

/** 改这件事的预算线。回合数至少为 1；这件事不存在时抛出中文错误。返回改后的预算线。 */
export function setJobBudget(ctx: HubContext, jobId: string, cap: number, reason: BudgetReason): number {
  const job = ctx.store.table('jobs').get(jobId);
  if (job === null) throw new Error('预算线：没有这件事');
  const next = withJobBudget(ctx, job, cap, reason);
  putJob(ctx, JobSchema.parse({ ...next, updatedAt: ctx.clock.now() }));
  return next.turnCap;
}
