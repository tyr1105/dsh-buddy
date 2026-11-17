/**
 * 发布这一步的回合计数（P74g 复核后）。
 *
 * 为什么单独计：这件事验收之后已经是「已完成」，原来的每件事回合上限管的是做事的过程，不该再卡发布；
 * 但发布也不能无限消耗，所以发布这一步另有自己的上限（JOB_DEFAULTS.LAUNCH_TURN_CAP，4 个回合）。
 * 回合数不另存字段：数验收之后执行者在这件事上开始过的回合（唤醒单），读存储即可，闸门的快照也用它。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';

/**
 * 这件事是否在发布环节：已完成，发布状态是准备中、等批准，或「发布没有成功」（failed，P74r18b：
 * 执行者还要改正命令重新提交、或交账写 blocked，所以这一步还没有结束，回合同样计入发布这一步的上限）。
 */
export function inLaunchPhase(job: Pick<Job, 'state' | 'launch'>): boolean {
  return job.state === 'done' && (job.launch.state === 'preparing' || job.launch.state === 'approval' || job.launch.state === 'failed');
}

/**
 * P74r18b：发布命令已成功运行、这件事已记为已发布，但执行者还没有补记网址（link 为空）。
 * 这时中心会叫执行者一次：有网址就用 launched 补记，没有就直接交账。这个叫醒要能通过闸门，并计入发布这一步的回合上限；
 * 但它不属于「发布环节」（发布这一步已经结束），所以不单独并入 inLaunchPhase。
 */
export function launchLinkOpen(job: Pick<Job, 'state' | 'launch' | 'launchStep'>): boolean {
  return job.state === 'done' && job.launchStep && job.launch.state === 'done' && job.launch.link === null;
}

/** 验收之后执行者在这件事上已经开始了几个回合。 */
export function launchTurnsUsed(ctx: HubContext, job: Pick<Job, 'id' | 'executorId' | 'acceptedAt'>): number {
  const since = job.acceptedAt ?? 0;
  return ctx.store.table('wakes').count(wake => wake.botId === job.executorId && wake.jobId === job.id && wake.startedAt >= since);
}

/** 发布这一步还剩几个回合。 */
export function launchTurnsLeft(ctx: HubContext, job: Pick<Job, 'id' | 'executorId' | 'acceptedAt'>): number {
  return D.LAUNCH_TURN_CAP - launchTurnsUsed(ctx, job);
}
