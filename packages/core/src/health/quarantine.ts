/** 隔离依据连续故障或失控用量；只改变单个机器人的生命周期，恢复必须由主人明确操作。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { botBudgetFor } from '../config/defaults.js';
import { botUsageToday } from '../quota/usage.js';
import { raiseAlert } from './alerts.js';
import { newId } from '../util/ids.js';

/** 连续回合错误只数真实回合 error/timeout，投递错误的四次重排规则独立由 scheduler 处理。 */
export function checkQuarantine(ctx: HubContext, botId: string, now: number): string | null {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.lifecycle === 'quarantined') return null;
  const wakes = ctx.store.table('wakes').list(item => item.botId === botId && item.endedAt !== null
    && item.endedAt <= now && (bot.releasedAt === undefined || item.startedAt > bot.releasedAt) && item.dispatchedAt !== null)
    // 同毫秒结束时按表插入顺序取最后一轮，避免读到最早的未交账变体。
    .reverse().sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const recentErrors = wakes.slice(0, ctx.settings.errorQuarantineCount);
  if (bot.consecutiveErrors >= ctx.settings.errorQuarantineCount && recentErrors.length >= ctx.settings.errorQuarantineCount
    && recentErrors.every(item => item.status === 'error' || item.status === 'timeout')) {
    return `连续 ${ctx.settings.errorQuarantineCount} 次回合出错`;
  }
  if (bot.violations >= ctx.settings.violationQuarantineCount) return `越界尝试达到 ${ctx.settings.violationQuarantineCount} 次`;
  const latest = wakes[0];
  if (bot.consecutiveNoCommit > ctx.settings.noCommitReflectionCount && latest?.variant === 'reflection' && latest.status === 'no_commit') {
    return '连续未交账后，复盘仍未交账';
  }
  const budget = botBudgetFor(bot.lifecycle, ctx.settings);
  const usage = botUsageToday(ctx, botId, now, bot.releasedAt);
  if ((usage.turns > 0 && usage.turns >= budget.dailyTurns * ctx.settings.usageQuarantineMultiplier)
    || (usage.tokens > 0 && usage.tokens >= budget.dailyTokens * ctx.settings.usageQuarantineMultiplier)) {
    return '单日用量达到三倍预算';
  }
  return null;
}

/** 隔离单个机器人并清队告警，保留事件供总管观察且不影响其他机器人。 */
export function quarantine(ctx: HubContext, botId: string, reason: string, now = ctx.clock.now()): void {
  reason = parseInput(nonempty.trim().min(1, '隔离原因不能为空'), reason, '隔离原因');
  now = parseInput(timestamp, now, '隔离时间');
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error(`找不到机器人：${botId}`);
  if (bot.lifecycle !== 'quarantined') ctx.store.log('audit').append({ id: newId('au', ctx.rng),
    at: now, actor: 'hub', action: 'quarantine_event', detail: botId });
  ctx.store.table('bots').patch(botId, { lifecycle: 'quarantined', activity: 'blocked', activityText: `已隔离：${reason}`,
    quarantineReason: reason, retryAt: null, updatedAt: now });
  for (const entry of ctx.store.table('queue').list(item => item.botId === botId)) ctx.store.table('queue').remove(entry.id);
  raiseAlert(ctx, { code: 'quarantine', botId, text: `${bot.name} 已隔离：${reason}`, level: 'P1', immediate: true, at: now });
  ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
}
