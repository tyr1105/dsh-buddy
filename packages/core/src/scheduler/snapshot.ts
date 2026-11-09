/** 调度快照一次收齐可观察状态；纯闸门只读快照，便于逐条重放为何被拦。 */
import type { HubContext } from '../engine/context.js';
import type { Bot, QuotaState, WakeTicket } from '../model/index.js';
import { getQuotaState } from '../quota/window.js';
import { botUsageToday, botTurnsInWindow } from '../quota/usage.js';
export interface GateSnapshot {
  bot: Bot | null; running: boolean; runningCount: number; ownerActiveAt: number | null;
  lastDispatchAt: number | null; startedAt: number; quota: QuotaState;
  todayTurns: number; todayTokens: number; windowTurns: number;
  openQuestionSubjects: Set<string>; openOwnerAskCount: number; openOwnerAskUntil: number | null;
  subjectWakeAt: Map<string, number>; retryAt: number | null; authBlocked: boolean;
  ownerEvidenceIds?: Set<string>;
}

/** 老版本没有事项键的唤醒单，从证据恢复已知键；无法还原时只使用稳定来源键。 */
function subjectsForWake(ctx: HubContext, wake: WakeTicket): string[] {
  const keys = new Set<string>();
  if (wake.subjectKey) keys.add(wake.subjectKey);
  for (const id of wake.reason.evidence) {
    const percept = ctx.store.table('percepts').get(id);
    if (percept) keys.add(percept.watchId ? `watch:${percept.watchId}` : `src:${percept.source}:${percept.kind}`);
    const agenda = ctx.store.table('agenda').get(id);
    if (agenda && wake.reason.kind === 'agenda_due') keys.add(`agenda:${id}`);
    const inbox = ctx.store.table('inbox').get(id);
    if (inbox) keys.add(inbox.subjectKey);
  }
  if (!keys.size) keys.add(`src:system:${wake.reason.kind}`);
  return [...keys];
}
/** 汇总运行、预算和事项冷却事实，给闸门提供同一时刻的判断依据。 */
export function buildSnapshot(ctx: HubContext, botId: string, now: number): GateSnapshot {
  const wakes = ctx.store.table('wakes').list();
  // delivering 同样占位，避免异步投递尚未落 running 时重复选择。
  const running = wakes.filter(w => w.status === 'running' || w.status === 'delivering' || (w.status === 'committed' && w.endedAt === null));
  const subjectWakeAt = new Map<string, number>();
  for (const wake of wakes.filter(w => w.botId === botId && w.startedAt <= now && w.status !== 'delivering')) {
    // 无会话的 error 是投递失败，没有真正唤醒，不施加六小时冷却。
    if (wake.dispatchedAt === null || (wake.dispatchedAt === undefined && wake.status === 'error' && wake.sessionId === null)) continue;
    for (const key of subjectsForWake(ctx, wake)) subjectWakeAt.set(key, Math.max(subjectWakeAt.get(key) ?? -Infinity, wake.startedAt));
  }
  const usage = botUsageToday(ctx, botId, now);
  const bot = ctx.store.table('bots').get(botId);
  // F07：提问和审批是「有人在等你回复」；提议与告警只是告知，不冻结自唤醒。
  // 已过期但还没来得及关掉的卡片不参与判断，避免把一分钟的时间缝算成还在等。
  const ownerAsks = ctx.store.table('inbox').list(i => i.botId === botId && i.status === 'open'
    && (i.type === 'question' || i.type === 'approval') && (i.expiresAt === null || i.expiresAt > now));
  return { bot, running: running.some(w => w.botId === botId), runningCount: running.length,
    ownerActiveAt: ctx.runtime.ownerActiveAt, lastDispatchAt: ctx.runtime.lastDispatchAt, startedAt: ctx.runtime.startedAt,
    quota: getQuotaState(ctx, now), todayTurns: usage.turns, todayTokens: usage.tokens, windowTurns: botTurnsInWindow(ctx, botId, now),
    openQuestionSubjects: new Set(ctx.store.table('inbox').list(i => i.botId === botId && i.type === 'question' && i.status === 'open').map(i => i.subjectKey)),
    openOwnerAskCount: ownerAsks.length,
    openOwnerAskUntil: ownerAsks.length === 0 ? null
      : ownerAsks.some(i => i.expiresAt === null) ? null : Math.min(...ownerAsks.map(i => i.expiresAt!)),
    ownerEvidenceIds: new Set([
      ...ctx.store.table('percepts').list(p => p.botId === botId
        && ((p.source === 'owner' && p.kind === 'owner_message') || (p.source === 'inbox' && p.kind === 'inbox_reply'))).map(p => p.id),
      ...ctx.store.table('inbox').list(i => i.botId === botId && i.status === 'answered').map(i => i.id),
    ]),
    subjectWakeAt, retryAt: bot?.retryAt ?? null,
    authBlocked: ctx.store.table('alerts').list(a => a.code === 'auth' && a.status === 'open').length > 0 };
}
