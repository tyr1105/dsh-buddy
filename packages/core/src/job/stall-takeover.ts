/**
 * 「换{名字}接手」：挑一位可以接手的人，答复时再核对一次他现在还能不能接手（P76g，方案 7.6）。
 *
 * 为什么中心要挑人：「没有进展」条目要让你一键换人，按钮上必须写明换谁；让你自己去翻名单就不是一键了。
 * 可接手的人（四条同时成立）：
 * - 与卡住的人同一个角色（卡住的是执行者就换执行者，是核对人就换核对人）；
 * - 此刻在岗（没有停用、没有归档）；
 * - 不是这件事的参与者（总管、执行者、核对人都不是）；
 * - 此刻手上没有没收尾的事（既不是别的事的执行者、核对人，也没有正在跑的回合）。
 * 多位都可以时，取最久没有接活的一位：沿用归档建议里「最近一次接活时间」的算法（team/archive-suggestion.ts 的
 * archiveCandidates，从未接过活的排最前），时间相同时按编号，保证每次挑的是同一位。
 * 卡住的是总管时没有这一项：总管不能被别人替换。
 *
 * 只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Job } from '../model/job.js';
import { isOnDutyNow } from './chain.js';
import { isJobClosed } from './store.js';

/**
 * 每位员工最近一次接活的时间（取不到的不在表里，按「从未接过」排最前）。
 * 口径与 team/archive-suggestion.ts 的 archiveCandidates 一致：被指派事务、被交接、常规回合结束三类时间里最晚的一个；
 * 不直接调用它，是因为它所在的文件会引入 api/bots.ts，与本文件所在的一件事相关模块形成循环引用，启动时会读不到部分定义。
 */
function lastWorkTimes(ctx: HubContext, now: number): Map<string, number> {
  const latest = new Map<string, number>();
  const note = (botId: string, at: number): void => { if (at <= now && at > (latest.get(botId) ?? -Infinity)) latest.set(botId, at); };
  for (const task of ctx.store.table('projectTasks').list(row => row.assigneeBotId !== null && row.assigneeBotId !== undefined)) note(task.assigneeBotId!, task.updatedAt);
  for (const handoff of ctx.store.table('handoffs').list()) note(handoff.to, handoff.updatedAt);
  for (const wake of ctx.store.table('wakes').list(row => row.variant === 'regular' && row.endedAt !== null)) note(wake.botId, wake.endedAt!);
  return latest;
}

/** 这位员工此刻是否是某件没收尾的事的执行者或核对人，或有回合在跑。 */
function isBusy(ctx: HubContext, botId: string): boolean {
  if (ctx.store.table('jobs').count(row => !isJobClosed(row) && (row.executorId === botId || row.reviewerId === botId)) > 0) return true;
  return ctx.store.table('wakes').count(wake => wake.botId === botId && wake.endedAt === null
    && ['delivering', 'running', 'committed'].includes(wake.status)) > 0;
}

/**
 * 这位员工能不能接手这件事里 stalledId 的位置：同角色、在岗（没有停用、没有归档）、不是这件事的参与者。
 * 答复「换{名字}接手」时用这一条核对（挑人时另加「手上没有没收尾的事」）。
 */
export function canTakeOver(ctx: HubContext, job: Job, stalledId: string, candidate: Bot): boolean {
  const stalled = ctx.store.table('bots').get(stalledId);
  if (stalled === null || stalled.role === 'chief' || candidate.role !== stalled.role) return false;
  if (candidate.id === job.chiefId || candidate.id === job.executorId || candidate.id === job.reviewerId) return false;
  return isOnDutyNow(ctx, candidate.id);
}

/** 挑一位可接手的人；没有（或卡住的是总管）返回 null。 */
export function takeoverCandidateOf(ctx: HubContext, job: Job, stalledId: string, now: number): Bot | null {
  if (stalledId === job.chiefId) return null;
  const lastWork = lastWorkTimes(ctx, now);
  const pool = ctx.store.table('bots').list(bot => canTakeOver(ctx, job, stalledId, bot) && !isBusy(ctx, bot.id));
  if (pool.length === 0) return null;
  const at = (bot: Bot): number => lastWork.get(bot.id) ?? -Infinity;
  return pool.reduce((best, bot) => (at(bot) < at(best) || (at(bot) === at(best) && bot.id < best.id) ? bot : best));
}
