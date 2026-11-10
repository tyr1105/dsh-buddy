/** 死人开关用明确的承诺时刻兜底；卡住检测只报告唤醒单，取消会话由 C04 调用宿主完成。 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Settings } from '../model/settings.js';
import type { WakeTicket } from '../model/wake.js';
import { DEFAULTS } from '../config/defaults.js';
import { buildCandidate, fatigueFor, thresholdFor, type Candidate } from '../appraisal/think.js';
import { buildSnapshot, evaluateGates } from '../scheduler/gates.js';
import { nextLocalTime } from '../util/time.js';
import { raiseAlert } from './alerts.js';

/** 选最早的下一次思考或紧急变化再加宽限，形成掉线检测截止点。 */
export function computeExpectedBy(bot: Pick<Bot, 'nextThinkAt'>, earliestUrgentPerceptAt: number | null, settings?: Settings): number | null {
  const values = [bot.nextThinkAt, earliestUrgentPerceptAt].filter((value): value is number => value !== null);
  return values.length === 0 ? null : Math.min(...values) + (settings?.deadmanGraceMs ?? DEFAULTS.DEADMAN_GRACE_MS);
}

/** 闸门有意延后的工作不是掉线；无固定解除时刻的并发/鉴权，每次只延到下一次检查。 */
function postponedUntil(ctx: HubContext, bot: Bot, now: number): number | null {
  const entry = ctx.store.table('queue').list(q => q.botId === bot.id)[0];
  if (entry) {
    const gate = evaluateGates(entry, buildSnapshot(ctx, bot.id, now), now, ctx.settings);
    if (!gate.pass && !gate.drop) return Math.max(gate.until ?? now + ctx.settings.tickMs, now);
  }
  const last = ctx.store.log('appraisals').recent(1, row => row.botId === bot.id && row.at <= now)[0];
  if (last?.decision === 'suppressed' && last.until != null && last.until > now) return last.until;
  // 疲劳门槛在午夜恢复。意图时钟主动略过低于门槛的预约，也不能用 retry 绕过它。
  const threshold = thresholdFor(fatigueFor(ctx, bot.id, now), bot.pace, ctx.settings);
  const belowThreshold = bot.nextThinkAt !== null && bot.nextThinkAt <= now && ctx.settings.c02.nextThinkScore < threshold;
  const pendingUrgent = ctx.store.table('percepts').list(p => p.botId === bot.id && p.tier === 'urgent'
    && p.consumedByWake === null && p.discardedAt === undefined && !p.deferredByOwner && p.createdAt <= now);
  if (!entry && (belowThreshold || (pendingUrgent.length > 0 && pendingUrgent.every(p => p.evaluatedAt !== undefined && p.salience < threshold)))) {
    return nextLocalTime('00:00', now, ctx.settings.timezone);
  }
  return null;
}

/** 六小时限频以持久化告警时间为准，重启也不会反复报告同一个超时。 */
export function checkDeadman(ctx: HubContext, now: number): Candidate[] {
  const result: Candidate[] = [];
  // 本次同步检查只写告警，不改唤醒单；取一次快照供全队复用，避免每个机器人重拷历史。
  const openWakes = ctx.store.table('wakes').list(w => w.endedAt === null);
  for (const bot of ctx.store.table('bots').list()) {
    const open = openWakes.filter(w => w.botId === bot.id);
    const orphan = open.some(w => w.status === 'delivering' && now - w.startedAt > ctx.settings.c02.deliveryTimeoutMs);
    // P55：听吩咐的队友不承诺自己什么时候醒，没醒不算掉线；投递卡住（orphan）仍要处理。
    if ((bot.onDemand && !orphan) || !['active', 'probation'].includes(bot.lifecycle) || bot.activity === 'waiting_owner'
      || (!orphan && (bot.activity === 'thinking' || bot.expectedBy === null))) continue;
    if (open.some(w => w.status === 'running' || w.status === 'committed'
      || (w.status === 'delivering' && now - w.startedAt <= ctx.settings.c02.deliveryTimeoutMs))) continue;
    const until = orphan ? null : postponedUntil(ctx, bot, now);
    if (until !== null) {
      ctx.store.table('bots').patch(bot.id, { expectedBy: Math.max(bot.expectedBy ?? 0, until + ctx.settings.deadmanGraceMs) });
      continue;
    }
    // 即使尚未超时也先记录合法延后，避免闸门恰在下一 tick 解开时被旧截止时间误报。
    if (!orphan && bot.expectedBy !== null && bot.expectedBy >= now) continue;
    const latest = ctx.store.table('alerts').list(item => item.botId === bot.id && item.code === 'deadman')
      .sort((a, b) => b.lastAt - a.lastAt)[0];
    if (latest && now - latest.lastAt < ctx.settings.deadmanAlertCooldownMs) continue;
    const alert = raiseAlert(ctx, { code: 'deadman', botId: bot.id, text: `${bot.name} 该动没动，尝试重新唤醒`, level: 'P1', immediate: true, at: now });
    result.push(buildCandidate(ctx, { botId: bot.id, kind: 'retry', score: ctx.settings.c02.deadmanRetryScore,
      summary: `${bot.name} 超过应思考时刻，检查是否掉线`, ownerSummary: '超过约定时间没有响应，重新唤醒',
      evidence: [alert.id], subjectKey: `deadman:${bot.id}`, now }));
  }
  return result;
}

/** 无事件在十分钟整即判卡住；总时长按规格的“超过三十分钟”采用严格大于。 */
export function findStuckWakes(ctx: HubContext, now: number): WakeTicket[] {
  return ctx.store.table('wakes').list(wake => (wake.status === 'delivering' && now - wake.startedAt > ctx.settings.c02.deliveryTimeoutMs)
    || (wake.status === 'running' && !wake.commitId
      && (now - wake.lastEventAt >= ctx.settings.turnIdleTimeoutMs || now - wake.startedAt > ctx.settings.turnHardTimeoutMs)));
}
