/**
 * 满员时的归档建议（P73c 接入，P73d 的按需加人工具和唤醒包使用）。
 *
 * 规则本身在 rules.ts 的 suggestArchive（纯函数）；这里负责读存储，为每位在册员工算出规则需要的事实：
 * 是否是某个未归档项目的负责人（真实值，不是写死的 false）、在办几件事、最近一次接活、最近一次思考。
 * 归档的检查本身仍由 api/bots.ts 的 archiveBotCheck 负责（本卡不另写一套）：这里只是挑出「现在确实能归档」的人，
 * 所以建议的人，主人照做时不会被归档检查拒绝。
 *
 * P73d：「最近一次接活时间」取下面三类时间里最晚的一个（只取能可靠拿到的字段，晚于 now 的忽略）：
 * 一、最近一次被交接（交接单的最近修改时间，收件人是他）；
 * 二、最近一次被指派事务（事务的最近修改时间，指派给他）；
 * 三、最近一次常规回合结束（唤醒单的结束时间，只算常规回合：轻复查、复盘、补课、试跑不是「接活」）。
 */
import { archiveBotCheck } from '../api/bots.js';
import type { HubContext } from '../engine/context.js';
import { suggestArchive, type ArchiveRow } from './rules.js';
import { liveBots } from './roster.js';

/** 算出每位在册员工的归档规则输入；now 用来忽略晚于当前时间的记录。 */
export function archiveCandidates(ctx: HubContext, now: number): ArchiveRow[] {
  const projects = ctx.store.table('projects').list(project => project.archivedAt === null);
  const tasks = ctx.store.table('projectTasks').list();
  const handoffs = ctx.store.table('handoffs').list();
  const wakes = ctx.store.table('wakes').list(wake => wake.variant === 'regular' && wake.endedAt !== null);
  return liveBots(ctx).map(bot => {
    const mine = tasks.filter(task => task.assigneeBotId === bot.id);
    const openTasks = mine.filter(task => task.status === 'doing' || task.status === 'done_pending_check').length;
    // 还没做完的交接也算在办（对方已接收、还没完成）。
    const openHandoffs = handoffs.filter(row => row.to === bot.id && row.status === 'accepted').length;
    const workTimes = [
      ...mine.map(task => task.updatedAt),
      ...handoffs.filter(row => row.to === bot.id).map(row => row.updatedAt),
      ...wakes.filter(wake => wake.botId === bot.id).map(wake => wake.endedAt as number),
    ].filter(at => at <= now);
    return {
      botId: bot.id, name: bot.name, role: bot.role,
      templateId: ctx.store.table('botOrigins').get(bot.id)?.templateId ?? null,
      lastWorkAt: workTimes.length === 0 ? null : Math.max(...workTimes),
      openWorkCount: openTasks + openHandoffs,
      lastThinkAt: bot.lastThinkAt,
      // 真实值：它是不是某个未归档项目的负责人。
      ownsProject: projects.some(project => project.ownerBotId === bot.id),
    };
  });
}

/** 与 archiveCandidates 相同，时间取注入时钟的当前时间（P73c 起的调用点沿用这个名字）。 */
export function archiveRows(ctx: HubContext): ArchiveRow[] {
  return archiveCandidates(ctx, ctx.clock.now());
}

/**
 * 在册满员时建议归档谁；没有合适的人返回 null。
 * 先按规则挑，再用归档检查核对一次：核对不通过的人不建议（避免建议了却归档不了）。
 */
export function suggestArchiveFor(ctx: HubContext): { botId: string; name: string; reasonText: string } | null {
  const now = ctx.clock.now();
  let candidates = archiveCandidates(ctx, now);
  while (candidates.length > 0) {
    const pick = suggestArchive(candidates, now);
    if (pick === null) return null;
    if (archiveBotCheck(ctx, pick.botId).canArchive) return pick;
    candidates = candidates.filter(row => row.botId !== pick.botId);
  }
  return null;
}
