/** 总览和主动性统计只投影既有事实，不推进额度或修改机器人状态，保证读取界面没有副作用。 */
import type { HubContext } from '../engine/context.js';
import { ownerActivityText } from '../util/owner-text.js';
import { proposalAnswer } from '../outreach/inbox-options.js';
import type { Bot, WakeTicket } from '../model/index.js';
import { ACTIVITY_LABELS, LIFECYCLE_LABELS, OUTCOME_LABELS, QUOTA_LIGHT_LABELS, ROLE_LABELS } from '../model/enums.js';
import { botBudgetFor, C04_DEFAULTS, dailyThinkCapFor } from '../config/defaults.js';
import { botUsageToday } from '../quota/usage.js';
import { getQuotaState, quotaProtectionText } from '../quota/window.js';
import { threadMessages } from '../outreach/thread.js';
import { pushesLeft } from '../outreach/push.js';
import { coefficientOfVariation } from '../util/stats.js';
import { isInQuietHours, formatDuration, parseFlexibleTime } from '../util/time.js';
import { agoTime, shortTime } from './common.js';
import type { BotCard, BotView, OverviewView } from './types.js';
import { costView } from './cost-views.js';

/** 只统计真实投递的回合；失败的投递尝试仍在活动流，但不能冒充一次模型思考。 */
export function isDispatched(wake: WakeTicket): boolean {
  return wake.dispatchedAt !== null && (wake.dispatchedAt !== undefined || !['delivering', 'error'].includes(wake.status));
}
/** 单张卡统一预算、未读和下一次思考文案，详细档案复用以免两处数字打架。 */
export function botCard(ctx: HubContext, bot: Bot): BotCard {
  const usage = botUsageToday(ctx, bot.id, ctx.clock.now());
  const last = ctx.store.table('commits').list(row => row.botId === bot.id).reverse().sort((a, b) => b.createdAt - a.createdAt).at(0);
  const waits = ctx.store.table('inbox').count(row => row.botId === bot.id && row.status === 'open' && ['question', 'approval'].includes(row.type)) > 0;
  const when = shortTime(ctx, bot.nextThinkAt);
  const fallback = shortTime(ctx, bot.lightCheckAt);
  const quota = getQuotaState(ctx, ctx.clock.now());
  const activityText = bot.activity === 'resting' && bot.activityText.startsWith('额度保护，')
    && ['active', 'probation'].includes(bot.lifecycle) && quota.light === 'red'
    ? quotaProtectionText(quota, ctx.clock.now(), ctx.settings.timezone) : ownerActivityText(ctx, bot);
  const nextThinkText = bot.onDemand ? '等你点名或派活' : when ? `${when}${bot.nextThinkBy === 'bot' ? `（它自己定的：${bot.nextThinkReason ?? '跟进变化'}）` : ''}`
    : `有变化时${fallback ? `，最晚${fallback}` : ''}`;
  return { id: bot.id, name: bot.name, role: bot.role, roleLabel: ROLE_LABELS[bot.role], color: bot.color,
    archived: bot.archivedAt != null,
    initials: Array.from(bot.name).slice(0, 2).join(''), lifecycle: bot.lifecycle, lifecycleLabel: LIFECYCLE_LABELS[bot.lifecycle],
    activity: bot.activity, activityLabel: ACTIVITY_LABELS[bot.activity], activityText,
    nextThinkAt: bot.nextThinkAt, nextThinkText, lightCheckAt: bot.lightCheckAt,
    lastOutcome: last?.outcome ?? null, lastOutcomeLabel: last ? OUTCOME_LABELS[last.outcome] : null,
    lastActiveAt: bot.lastThinkAt, lastActiveText: agoTime(ctx, bot.lastThinkAt),
    unread: threadMessages(ctx, bot.id).filter(row => row.from !== 'owner' && row.readAt === null).length,
    todayThinks: usage.turns, todayBudget: Math.min(botBudgetFor(bot.lifecycle, ctx.settings).dailyTurns,
      dailyThinkCapFor(bot.autonomy, bot.lifecycle, ctx.settings)), todayTokens: usage.tokens, waitingOwner: waits };
}
/** 七日主动性指标使用相同时间窗；没有样本时返回 null，不能把未知比例显示为零表现。 */
export function botStats(ctx: HubContext, botId: string): BotView['stats'] {
  const now = ctx.clock.now();
  const from = now - C04_DEFAULTS.STATS_WINDOW_MS;
  const inWindow = (at: number) => at >= from && at <= now;
  const wakes = ctx.store.table('wakes').list(row => row.botId === botId && inWindow(row.startedAt) && isDispatched(row))
    .sort((a, b) => a.startedAt - b.startedAt);
  const intervals = wakes.slice(1).map((row, index) => row.startedAt - wakes[index]!.startedAt);
  const commits = ctx.store.table('commits').list(row => row.botId === botId && inWindow(row.createdAt)
    && !ctx.store.table('wakes').get(row.wakeId)?.syntheticCommit);
  const selfPaced = commits.filter(row => row.nextThink.mode !== 'auto' && row.nextThink.reason.trim()
    && (row.nextThink.mode !== 'at' || parseFlexibleTime(row.nextThink.at ?? '', ctx.settings.timezone) !== null));
  const proposals = ctx.store.table('inbox').list(row => row.botId === botId && row.type === 'proposal' && inWindow(row.createdAt));
  const decided = proposals.filter(row => row.status === 'answered' && proposalAnswer(row.answer ?? '') !== null);
  return { thinks7d: wakes.length, intervalCv: intervals.length < 2 ? null : coefficientOfVariation(intervals),
    selfPacedRatio: commits.length ? selfPaced.length / commits.length : null,
    selfInitiated7d: ctx.store.table('agenda').count(row => row.botId === botId && row.source === 'bot' && inWindow(row.createdAt)) + proposals.length,
    proposalAcceptRate: decided.length ? decided.filter(row => proposalAnswer(row.answer ?? '') === '接受').length / decided.length : null,
    tokens7d: ctx.store.log('ledger').since(from, row => row.who === botId && row.at <= now).reduce((sum, row) => sum + row.tokens, 0) };
}
/** 总览汇总全体状态与注意力预算，不把心跳存在直接当作当前健康。 */
export function overview(ctx: HubContext): OverviewView {
  const now = ctx.clock.now();
  const items = ctx.store.table('inbox').list(row => row.status === 'open');
  const team = threadMessages(ctx, 'team');
  const quota = getQuotaState(ctx, now);
  const resetAt = ctx.store.table('quota').get('quota') ? quota.redUntil ?? quota.windowStartAt + ctx.settings.quotaWindowMs : null;
  const alerts = ctx.store.table('alerts').list(row => row.status === 'open');
  const downtime = ctx.store.table('downtime').list().sort((a, b) => b.to - a.to)[0];
  const heartbeatAt = ctx.runtime.lastHeartbeatAt;
  return { bots: ctx.store.table('bots').list().map(bot => botCard(ctx, bot)), costs: costView(ctx, now),
    inbox: { total: items.length, approvals: items.filter(row => row.type === 'approval').length,
      questions: items.filter(row => row.type === 'question').length, proposals: items.filter(row => row.type === 'proposal').length,
      alerts: items.filter(row => row.type === 'alert').length },
    team: { unread: team.filter(row => row.readAt === null && row.from !== 'owner').length, lastMessageText: team.at(-1)?.text ?? null },
    quota: { light: quota.light, lightLabel: QUOTA_LIGHT_LABELS[quota.light], usedText: `${quota.botTurns} / ${quota.turnLimit} 回合，${quota.botTokens} token`,
      resetAt, resetText: shortTime(ctx, resetAt) },
    health: { ok: alerts.length === 0 && heartbeatAt !== null && now - heartbeatAt <= ctx.settings.hostDownAfterMs
        && ctx.runtime.sandboxUnavailable === null,
      heartbeatAt, heartbeatText: agoTime(ctx, heartbeatAt) ?? '尚无心跳', downtimeAt: downtime?.to ?? null,
      downtimeText: downtime ? `${shortTime(ctx, downtime.to)}恢复，停机 ${formatDuration(downtime.to - downtime.from)}` : null, openAlerts: alerts.length,
      // 沙箱不可用时宿主命令全部失败关闭；把原因放到总览，主人不至于以为命令只是执行失败。
      sandboxWarning: ctx.runtime.sandboxUnavailable },
    nowAt: now, nowText: shortTime(ctx, now)!, quietNow: isInQuietHours(now, ctx.settings.quietHours, ctx.settings.timezone), pushesLeftToday: pushesLeft(ctx) };
}
