/** 总览和主动性统计只投影既有事实，不推进额度或修改机器人状态，保证读取界面没有副作用。 */
import type { HubContext } from '../engine/context.js';
import { ownerActivityText } from '../util/owner-text.js';
import { proposalAnswer } from '../outreach/inbox-options.js';
import type { Bot, WakeTicket } from '../model/index.js';
import { staffStatus } from '../model/bot.js';
import { originOf } from '../model/bot-origin.js';
import { templateById } from '../team/templates.js';
import { ACTIVITY_LABELS, LIFECYCLE_LABELS, OUTCOME_LABELS, QUOTA_LIGHT_LABELS, ROLE_LABELS } from '../model/enums.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { botUsageToday, selfWorkUsageToday } from '../quota/usage.js';
import { getQuotaState, isQuotaRestText, quotaProtectionText } from '../quota/window.js';
import { quotaWindowView } from './quota-views.js';
import { threadMessages } from '../outreach/thread.js';
import { pushHistory } from '../outreach/push.js';
import { coefficientOfVariation } from '../util/stats.js';
import { formatTokenCount } from '../util/token-format.js';
import { isInQuietHours, formatDuration, parseFlexibleTime, startOfLocalDay } from '../util/time.js';
import { agoTime, shortTime } from './common.js';
import type { BotCard, BotView, OverviewView } from './types.js';
import { costView } from './cost-views.js';
import { agreementRapport } from './agreement-views.js';
import { chiefJobLineFor } from './job-topic-views.js';
import { memoryCount } from './memory-page-views.js';

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
  // P76d：员工因额度休息时的文字由额度状态现算（新前缀「在等额度恢复，」，兼容旧存档里的旧前缀「额度保护，」）。
  const activityText = bot.activity === 'resting' && isQuotaRestText(bot.activityText)
    && ['active', 'probation'].includes(bot.lifecycle) && quota.light === 'red'
    ? quotaProtectionText(quota, ctx.clock.now(), ctx.settings.timezone) : ownerActivityText(ctx, bot);
  const staff = staffStatus(bot);
  const nextThinkText = bot.onDemand ? '等你点名或派活' : when ? `${when}${bot.nextThinkBy === 'bot' ? `（它自己定的：${bot.nextThinkReason ?? '跟进变化'}）` : ''}`
    : `有变化时${fallback ? `，最晚${fallback}` : ''}`;
  // P73r4：员工由模板创建且模板有显示标签（如评审员的「评审」）时带上它，界面各处统一显示这一个；
  // 没有来历、从头配置或模板已不存在的为 null，界面照旧显示角色标签。
  const originTemplateId = originOf(ctx, bot.id).templateId;
  const templateLabel = originTemplateId === null ? null : (templateById(originTemplateId)?.dutyLabel ?? null);
  return { id: bot.id, name: bot.name, role: bot.role, roleLabel: ROLE_LABELS[bot.role], templateLabel, color: bot.color,
    archived: bot.archivedAt != null,
    initials: Array.from(bot.name).slice(0, 2).join(''), lifecycle: bot.lifecycle, lifecycleLabel: LIFECYCLE_LABELS[bot.lifecycle],
    // P73a：主人看到的员工状态（在岗、停用、归档），停用带原因；lifecycle 字段保留不删。
    staffStatus: staff.status, staffStatusLabel: staff.label, staffStatusReason: staff.reason,
    activity: bot.activity, activityLabel: ACTIVITY_LABELS[bot.activity], activityText,
    nextThinkAt: bot.nextThinkAt, nextThinkText, lightCheckAt: bot.lightCheckAt,
    lastOutcome: last?.outcome ?? null, lastOutcomeLabel: last ? OUTCOME_LABELS[last.outcome] : null,
    lastActiveAt: bot.lastThinkAt, lastActiveText: agoTime(ctx, bot.lastThinkAt),
    unread: threadMessages(ctx, bot.id).filter(row => row.from !== 'owner' && row.readAt === null).length,
    // P76c：字段名不变，含义改为「今天自己发起的回合数 / 每天上限」（只数员工自己发起的回合，口径同闸门）；todayTokens 仍是今天的 token 合计。
    todayThinks: selfWorkUsageToday(ctx, bot.id, ctx.clock.now()).turns, todayBudget: ctx.settings.botDailyTurnBudget,
    todayTokens: usage.tokens, waitingOwner: waits,
    // P72c：只有总管且累计确认过约定（total 大于 0）才带默契度。
    ...(bot.role === 'chief' ? chiefRapport(ctx, bot.id) : {}),
    // P74a：总管名下进行中的事的一句话（一件写「标题　状态」，多件写「n 件在办」）。
    ...(bot.role === 'chief' ? { chiefJobLine: chiefJobLineFor(ctx, bot.id) } : {}) };
}
/** P72c：总管员工卡片上的默契度；没有累计（或 total 为 0）时不带这个字段。 */
function chiefRapport(ctx: HubContext, botId: string): Pick<BotCard, 'rapport'> {
  const rapport = agreementRapport(ctx, botId);
  return rapport && rapport.total > 0 ? { rapport: { ...rapport, text: `默契度 ${rapport.adopted} / ${rapport.total}` } } : {};
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
  return { bots: ctx.store.table('bots').list().map(bot => botCard(ctx, bot)), costs: costView(ctx, now), memoryCount: memoryCount(ctx),
    inbox: { total: items.length, approvals: items.filter(row => row.type === 'approval').length,
      questions: items.filter(row => row.type === 'question').length, proposals: items.filter(row => row.type === 'proposal').length,
      alerts: items.filter(row => row.type === 'alert').length },
    team: { unread: team.filter(row => row.readAt === null && row.from !== 'owner').length, lastMessageText: team.at(-1)?.text ?? null },
    quota: { light: quota.light, lightLabel: QUOTA_LIGHT_LABELS[quota.light], usedText: `${quota.botTurns} / ${quota.turnLimit} 回合，${formatTokenCount(quota.botTokens)} token`,
      resetAt, resetText: shortTime(ctx, resetAt),
      // P76d：额度文字的唯一出口；上面的原字段原样保留（设置页「模型额度」一行和顶栏现在读它们，P76j、P76k 才改）。
      window: quotaWindowView(ctx, now) },
    health: { ok: alerts.length === 0 && heartbeatAt !== null && now - heartbeatAt <= ctx.settings.hostDownAfterMs
        && ctx.runtime.sandboxUnavailable === null,
      heartbeatAt, heartbeatText: agoTime(ctx, heartbeatAt) ?? '尚无心跳', downtimeAt: downtime?.to ?? null,
      downtimeText: downtime ? `${shortTime(ctx, downtime.to)}恢复，停机 ${formatDuration(downtime.to - downtime.from)}` : null, openAlerts: alerts.length,
      // 沙箱不可用时宿主命令全部失败关闭；把原因放到总览，主人不至于以为命令只是执行失败。
      sandboxWarning: ctx.runtime.sandboxUnavailable },
    nowAt: now, nowText: shortTime(ctx, now)!, quietNow: isInQuietHours(now, ctx.settings.quietHours, ctx.settings.timezone), pushesLeftToday: legacyPushesLeftToday(ctx, now) };
}
/**
 * 总览视图里「今天还能通知几条」的旧字段（pushesLeftToday）。P76c 起每日推送条数上限已取消，推送不再按条数拦截；
 * 但设置页（packages/plugin，P76k 才改）仍在显示这个字段，所以这里只为它保留一个展示用的数：旧设置里的全队上限减去今天已发出的普通推送（不为 0 以下）。
 * 它不参与任何判断。设置页那一行删除之后，这个函数和字段一并删除（见 docs/questions.md P76c）。
 */
function legacyPushesLeftToday(ctx: HubContext, now: number): number {
  const start = startOfLocalDay(now, ctx.settings.timezone);
  const sent = pushHistory(ctx).filter(row => row.result === 'sent' && row.level !== 'P0' && row.at >= start && row.at <= now).length;
  return Math.max(0, ctx.settings.dailyPushCap - sent);
}
