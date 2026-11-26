/**
 * 总管按项目分线（W1b）：总管仍是一位、一个人设、一个工位，但每个项目有它自己的一条线。
 *
 * 一条线 = 一个项目编号（或主线 MAIN_LANE：总管私聊、组队、复盘这些不属于任何项目的事）。
 * 为什么要分线：宿主的一个会话同一时刻只能跑一个回合，原来「同一位员工同时只能有一个回合」把总管锁成了单线。
 * 分线之后：
 * - 宿主的一个会话同一时刻只能跑一个回合：几条线同时在跑时，原来的会话被占着就用备用会话（bot.extraSessions，见 pickSessionSlot）；
 * - 调度闸门里「这位员工正在跑」「冷却」「最短间隔」「等你回答」「每日上限」对总管按（总管、线）算，
 *   不同项目可以同时推进；全队的并发上限、额度、安静时段、推送上限仍是全局一份（打扰控制按人算）；
 * - 其他员工只有主线，行为一字不变。
 *
 * 线怎么定：候选或唤醒单带主题时取主题所属项目，带事情编号时取这件事的项目；都没有就是主线。
 * 本文件除 setSessionSlot、releaseSession 外只读存储。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { isOpenWake } from '../turn/session.js';
import { ownerReasonSummary } from '../util/owner-text.js';

/** 主线：总管私聊和不属于任何项目的事。 */
export const MAIN_LANE = 'main';

/** 决定线的几个字段（候选和唤醒单都有）。 */
export interface LaneFields { topicId?: string | null; jobId?: string | null }

/** 一个宿主会话位：slot 0 是 bot 上原来的会话，1 起是总管的备用会话。 */
export interface SessionSlotView { slot: number; sessionId: string | null; sessionStartedAt: number | null; sessionModel?: Bot['sessionModel'] }

/** 这位员工是不是分线的（只有总管分线）。 */
export function usesLanes(bot: Pick<Bot, 'role'> | null | undefined): boolean {
  return bot?.role === 'chief';
}

/** 不看员工角色，只按字段算出项目编号；没有项目时返回 MAIN_LANE。 */
export function laneOfFields(ctx: HubContext, fields: LaneFields): string {
  if (fields.topicId) {
    const topic = ctx.store.table('projectTopics').get(fields.topicId);
    if (topic) return topic.projectId;
  }
  if (fields.jobId) {
    const job = ctx.store.table('jobs').get(fields.jobId);
    if (job) return job.projectId;
  }
  return MAIN_LANE;
}

/** 这位员工的这条候选或唤醒单在哪条线上：不分线的员工永远是主线。 */
export function laneOf(ctx: HubContext, bot: Pick<Bot, 'role'> | null | undefined, fields: LaneFields): string {
  return usesLanes(bot) ? laneOfFields(ctx, fields) : MAIN_LANE;
}

/** 这位员工全部会话位：先是原来的会话，再是备用会话（按编号）。 */
export function sessionSlotsOf(bot: Bot): SessionSlotView[] {
  const main: SessionSlotView = { slot: 0, sessionId: bot.sessionId, sessionStartedAt: bot.sessionStartedAt,
    ...(bot.sessionModel === undefined ? {} : { sessionModel: bot.sessionModel }) };
  const extras = [...(bot.extraSessions ?? [])].sort((a, b) => a.slot - b.slot).map(row => ({ slot: row.slot, sessionId: row.sessionId,
    sessionStartedAt: row.sessionStartedAt, ...(row.sessionModel === undefined ? {} : { sessionModel: row.sessionModel }) }));
  return [main, ...extras];
}

/**
 * 这次投递用哪个会话位（W1b）。为什么是会话池而不是「一个项目一个会话」：宿主的一个会话同一时刻只能跑一个回合，
 * 只有几条线同时在跑时才需要第二个会话；平时总管照旧只用原来那个会话（上下文、主人在 DSH 里看到的会话都不变）。
 * 规则：第一个没有回合占着的会话位；都占着时新开一个备用位（不分线的员工永远是原来的会话）。
 * 占着：这位员工有还开着的回合用的就是这个会话；会话还没建（空）时，有开着的回合也没绑会话，也算占着（投递中的回合）。
 */
export function pickSessionSlot(ctx: HubContext, bot: Bot): SessionSlotView {
  const slots = sessionSlotsOf(bot);
  if (!usesLanes(bot)) return slots[0]!;
  const open = ctx.store.table('wakes').list(row => row.botId === bot.id && isOpenWake(row));
  const busy = (slot: SessionSlotView): boolean => open.some(row => (row.sessionId ?? null) === slot.sessionId);
  return slots.find(slot => !busy(slot)) ?? { slot: Math.max(...slots.map(slot => slot.slot)) + 1, sessionId: null, sessionStartedAt: null };
}

/** 把一个会话位写回（0 写 bot 上的三项，其余写 extraSessions 里那一行）。 */
export function setSessionSlot(ctx: HubContext, botId: string, view: SessionSlotView): void {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) return;
  if (view.slot === 0) {
    ctx.store.table('bots').patch(botId, { sessionId: view.sessionId, sessionStartedAt: view.sessionStartedAt,
      ...(view.sessionModel === undefined ? {} : { sessionModel: view.sessionModel }) });
    return;
  }
  const others = (bot.extraSessions ?? []).filter(row => row.slot !== view.slot);
  const row = { slot: view.slot, sessionId: view.sessionId, sessionStartedAt: view.sessionStartedAt,
    ...(view.sessionModel === undefined ? {} : { sessionModel: view.sessionModel }) };
  ctx.store.table('bots').patch(botId, { extraSessions: [...others, row].sort((a, b) => a.slot - b.slot) });
}

/** 解绑某个会话（打断、投递超时之后）：哪个会话位用的是它就清空哪个位；没有就什么都不做。 */
export function releaseSession(ctx: HubContext, botId: string, sessionId: string | null | undefined): void {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || !sessionId) return;
  const slot = sessionSlotsOf(bot).find(row => row.sessionId === sessionId);
  if (slot) setSessionSlot(ctx, botId, { slot: slot.slot, sessionId: null, sessionStartedAt: null });
}

/** 宿主会话属于哪位员工（原来的会话或备用会话）；不是任何员工的会话返回 null。 */
export function botForSession(ctx: HubContext, sessionId: string | null | undefined): Bot | null {
  if (!sessionId) return null;
  return ctx.store.table('bots').list(bot => bot.sessionId === sessionId || (bot.extraSessions ?? []).some(row => row.sessionId === sessionId))[0] ?? null;
}

/** 这位员工某条线的展示名：主线写「私聊」，项目线写项目名。 */
export function laneLabel(ctx: HubContext, lane: string): string {
  if (lane === MAIN_LANE) return '私聊';
  return ctx.store.table('projects').get(lane)?.name ?? '已删除的项目';
}

/** 这位员工除 exceptWakeId 之外还开着几条线的回合（同一条线只算一次）。 */
export function openLaneCount(ctx: HubContext, botId: string, exceptWakeId: string | null = null): number {
  const bot = ctx.store.table('bots').get(botId);
  const lanes = new Set(ctx.store.table('wakes').list(row => row.botId === botId && row.id !== exceptWakeId && isOpenWake(row))
    .map(row => laneOf(ctx, bot, row)));
  return lanes.size;
}

/** 总管同时在几条线上做事时的状态句（办公室小人下面那一行）。 */
export function multiLaneText(count: number): string {
  return `同时在处理 ${count} 个项目`;
}

/**
 * 一个回合结束或被打断后，这位员工别的线还开着回合时的状态句：还剩一条线写「正在处理：那件事」，几条写「同时在处理 n 个项目」；
 * 别的线都没有回合时返回 null（照原来的规则写状态）。
 */
export function remainingLanesText(ctx: HubContext, botId: string, exceptWakeId: string): string | null {
  const bot = ctx.store.table('bots').get(botId);
  const open = ctx.store.table('wakes').list(row => row.botId === botId && row.id !== exceptWakeId && isOpenWake(row))
    .sort((a, b) => a.startedAt - b.startedAt);
  const lanes = new Set(open.map(row => laneOf(ctx, bot, row)));
  if (lanes.size === 0) return null;
  if (lanes.size > 1) return multiLaneText(lanes.size);
  return `正在处理：${ownerReasonSummary(open[0]!.reason, ctx)}`;
}

/** 这个宿主会话是不是这位员工的（原来的会话或备用会话）：工具和交账按它核对身份。 */
export function ownsSession(bot: Pick<Bot, 'sessionId' | 'extraSessions'>, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return bot.sessionId === sessionId || (bot.extraSessions ?? []).some(row => row.sessionId === sessionId);
}
