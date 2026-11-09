/** 主人维护志向、目标和关注项：先校验关联和边界再落表，主人编辑不会伪装成机器人自发事项。 */
import { posix } from 'node:path';
import type { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { Bot, Goal, Watch } from '../model/index.js';
import { AspirationSchema, GoalSchema } from '../model/bot.js';
import { WatchSchema } from '../model/perception.js';
import { newId } from '../util/ids.js';
import { localDateKey, parseLocalDateTime, startOfLocalDay } from '../util/time.js';
import { refreshBotFiles } from '../memory/files.js';
import { answerInbox } from '../outreach/inbox.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { parseFileTarget, syncFileWatches } from '../perception/files.js';
import { validateCommand } from '../perception/script.js';
import { validateWatchFilter } from '../perception/filter.js';
import { assertHttpWatchAccess, assertWatchPathAccess } from '../perception/access.js';
import { refreshLightCheck } from '../agenda/next-think.js';
import { AspirationInputSchema, GoalInputSchema, WatchInputSchema } from './schemas.js';
import { input, requireBot } from './common.js';
import { HUB_EVENT_SCOPES } from './event-scopes.js';
import { checkGoalAnswer } from '../commit/result-check.js';

/** 周期按本地日历结束，避免把一个月固定当作三十天。 */
export function goalPeriodEnd(ctx: HubContext, period: Goal['period']): number | null {
  if (period === 'one_off') return null;
  const date = new Date(`${localDateKey(ctx.clock.now(), ctx.settings.timezone)}T00:00:00Z`);
  if (period === 'month') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
  } else date.setUTCDate(date.getUTCDate() + (period === 'day' ? 1 : 7 - ((date.getUTCDay() + 6) % 7)));
  // 午夜可能被夏令时跳过：先定位日期的中午，再求该日第一个真实存在的分钟。
  return startOfLocalDay(parseLocalDateTime(`${date.toISOString().slice(0, 10)} 12:00`, ctx.settings.timezone), ctx.settings.timezone);
}
/** 目标只依附同一机器人已批准的志向，修改时保留原始来源和进展。 */
export function makeGoal(ctx: HubContext, args: z.infer<typeof GoalInputSchema>, old: Goal | null): Goal {
  const now = ctx.clock.now();
  return input(GoalSchema, { id: old?.id ?? newId('g', ctx.rng), botId: args.botId, aspirationId: args.aspirationId,
    title: args.title, doneWhen: args.doneWhen, period: args.period,
    periodEndsAt: args.periodEndsAt === undefined ? old?.period === args.period ? old.periodEndsAt : goalPeriodEnd(ctx, args.period) : args.periodEndsAt,
    importance: args.importance ?? old?.importance ?? ctx.settings.goalImportance,
    patienceMs: args.patienceMs ?? (old?.period === args.period ? old.patienceMs : ctx.settings.goalPatienceMsByPeriod[args.period]),
    status: old?.status === 'proposed' ? 'active' : old?.status ?? 'active', verification: args.verification ?? old?.verification ?? 'owner',
    lastProgressAt: old?.lastProgressAt ?? now, createdBy: old?.createdBy ?? 'owner', createdAt: old?.createdAt ?? now, updatedAt: now }, '目标');
}
/** 主人可维护任意明确授权范围，但轮询下限、工作数据授权和格式边界仍然生效。 */
export function makeWatch(ctx: HubContext, bot: Bot, args: z.infer<typeof WatchInputSchema>, old: Watch | null): Watch {
  let intervalMs: number | null = null;
  if (['http', 'rss', 'script'].includes(args.kind)) {
    const min = args.kind === 'script' ? ctx.settings.scriptMinIntervalMs : ctx.settings.httpMinIntervalMs;
    intervalMs = args.intervalMinutes === undefined ? old?.kind === args.kind ? old.intervalMs ?? min : min : args.intervalMinutes * 60_000;
    if (intervalMs < min) throw new Error('intervalMinutes：低于此来源最短轮询间隔');
  } else if (args.intervalMinutes !== undefined) throw new Error('intervalMinutes：事件驱动的关注项不能设轮询间隔');
  // 创建与读取共用访问检查；传入已校验的 Bot，预检不依赖机器人先落表。
  if (['http', 'rss'].includes(args.kind)) assertHttpWatchAccess(ctx, { botId: bot.id, target: args.target }, bot);
  if (['file', 'log'].includes(args.kind)) {
    parseFileTarget(args.target);
    assertWatchPathAccess(ctx, bot, args.target);
    const target = posix.normalize(args.target);
    if (!bot.workDataAllowed && ctx.settings.workDataPaths.some(base => target === posix.normalize(base) || target.startsWith(`${posix.normalize(base)}/`)))
      throw new Error('target：尚未授权读取工作数据目录');
  }
  validateWatchFilter(args.filter === undefined ? old?.filter : args.filter, ctx.settings);
  if (args.expectation && !args.expectation.everyMs && !args.expectation.byLocalTime) throw new Error('expectation：必须指定 everyMs 或 byLocalTime');
  const now = ctx.clock.now();
  const unchangedSource = old?.kind === args.kind && old.target === args.target;
  const status = args.status ?? 'active';
  // 原关注项恢复 active 时重新起算；原样保存期望保留满足、落空和生效事实。
  const activating = status === 'active' && old?.status !== 'active';
  const oldExpectation = old?.expectation;
  const sameExpectation = args.expectation && oldExpectation
    && args.expectation.text === oldExpectation.text
    && (args.expectation.everyMs ?? null) === oldExpectation.everyMs
    && (args.expectation.byLocalTime ?? null) === oldExpectation.byLocalTime
    && JSON.stringify(args.expectation.weekdays ?? null) === JSON.stringify(oldExpectation.weekdays ?? null);
  const expectation = args.expectation === undefined || sameExpectation ? oldExpectation ?? null : args.expectation === null ? null : {
    text: args.expectation.text, everyMs: args.expectation.everyMs ?? null, byLocalTime: args.expectation.byLocalTime ?? null,
    weekdays: args.expectation.weekdays ?? null, effectiveAt: now,
    lastSatisfiedAt: oldExpectation?.lastSatisfiedAt ?? null, lastMissedAt: null };
  const effectiveExpectation = expectation && activating
    ? { ...expectation, effectiveAt: Math.max(now, expectation.effectiveAt ?? old?.createdAt ?? now), lastMissedAt: null }
    : expectation;
  // 主人明确恢复已到期关注时续期；保留 bot 来源，仍可追溯注意力由谁发起。
  const expiresAt = old?.createdBy === 'bot' && status === 'active' && (old.expiresAt ?? old.createdAt + ctx.settings.botWatchExpiryMs) <= now
    ? now + ctx.settings.botWatchExpiryMs : old?.expiresAt ?? null;
  return input(WatchSchema, { id: old?.id ?? newId('wt', ctx.rng), botId: bot.id, kind: args.kind, target: args.target,
    filter: args.filter === undefined ? old?.filter ?? null : args.filter, intervalMs,
    expectation: effectiveExpectation,
    relevance: args.relevance ?? old?.relevance ?? ctx.settings.watchRelevanceByCreator.owner, createdBy: old?.createdBy ?? 'owner',
    status, expiresAt, lastCheckedAt: unchangedSource ? old.lastCheckedAt : null,
    lastFingerprint: unchangedSource ? old.lastFingerprint : null, lastValue: unchangedSource ? old.lastValue : null,
    why: args.why, createdAt: old?.createdAt ?? now, updatedAt: now }, '关注项');
}
/** 志向数量限制按有效条目计算；归档不会删掉旧目标的历史关联。 */
export async function upsertAspiration(ctx: HubContext, raw: unknown) {
  const args = input(AspirationInputSchema, raw, '志向');
  requireBot(ctx, args.botId);
  const old = args.id ? ctx.store.table('aspirations').get(args.id) : null;
  if (args.id && (!old || old.botId !== args.botId)) throw new Error('id：志向不存在或不属于该机器人');
  const status = args.status ?? old?.status ?? 'active';
  const count = ctx.store.table('aspirations').count(row => row.botId === args.botId && row.status === 'active' && row.id !== args.id);
  if (status === 'active' && count >= 3) throw new Error('志向：每个机器人最多三个有效志向');
  if (status === 'archived' && count === 0) throw new Error('志向：至少保留一个有效志向');
  const row = input(AspirationSchema, { ...args, id: old?.id ?? newId('asp', ctx.rng), status,
    createdBy: old?.createdBy ?? 'owner', approved: true, createdAt: old?.createdAt ?? ctx.clock.now() }, '志向');
  ctx.store.table('aspirations').put(row);
  await refreshBotFiles(ctx, args.botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, args.botId);
  return row;
}
/** 完整预检后更新目标，无法跨机器人引用或覆盖别人的目标。 */
export async function upsertGoal(ctx: HubContext, raw: unknown) {
  const args = input(GoalInputSchema, raw, '目标');
  requireBot(ctx, args.botId);
  const aspiration = ctx.store.table('aspirations').get(args.aspirationId);
  if (!aspiration || aspiration.botId !== args.botId || aspiration.status !== 'active' || !aspiration.approved)
    throw new Error('aspirationId：必须是该机器人已批准的有效志向');
  const old = args.id ? ctx.store.table('goals').get(args.id) : null;
  if (args.id && (!old || old.botId !== args.botId)) throw new Error('id：目标不存在或不属于该机器人');
  const row = makeGoal(ctx, args, old);
  ctx.store.table('goals').put(row);
  refreshGoalClock(ctx, args.botId);
  await refreshBotFiles(ctx, args.botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, args.botId);
  return row;
}
/** 验收必须有待验收目标；放弃可显式关闭其他未结束目标。 */
export async function closeGoal(ctx: HubContext, id: string, outcome: 'done' | 'active' | 'abandoned' | 'not_done' | 'incorrect' | 'mismatch') {
  const old = ctx.store.table('goals').get(id);
  if (!old) throw new Error('id：目标不存在');
  if (outcome !== 'abandoned' && old.status !== 'done_pending_check') throw new Error('目标尚未提交验收，不能决定验收结果');
  if (['done', 'abandoned'].includes(old.status)) throw new Error('目标已经关闭');
  const questions = ctx.store.table('inbox').list(row => row.refId === id && row.type === 'question' && row.status === 'open');
  const answer = outcome === 'done' ? '验收通过' : outcome === 'not_done' ? '没做'
    : outcome === 'incorrect' ? '做错' : outcome === 'mismatch' ? '不是你要的' : '验收不通过';
  if (outcome !== 'abandoned' && questions.length) {
    await answerInbox(ctx, questions[0]!.id, answer);
  } else {
    if (outcome !== 'abandoned') await checkGoalAnswer(ctx, old, answer, false, ctx.clock.now());
    ctx.store.table('goals').patch(id, { status: outcome === 'done' || outcome === 'abandoned' ? outcome : 'active', updatedAt: ctx.clock.now() });
  }
  if (outcome === 'abandoned') for (const item of questions)
    ctx.store.table('inbox').patch(item.id, { status: 'closed', answer: '目标已放弃', answeredAt: ctx.clock.now() });
  refreshGoalClock(ctx, old.botId);
  await refreshBotFiles(ctx, old.botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, old.botId);
  if (questions.length) {
    ctx.emit(HUB_EVENT_SCOPES.inbox, old.botId);
    ctx.emit(HUB_EVENT_SCOPES.thread, old.botId);
  }
  return ctx.store.table('goals').get(id)!;
}
/** 关注项保存后立即同步文件监听，下一条文件事件就能进入新注意力范围。 */
export async function upsertWatch(ctx: HubContext, raw: unknown) {
  const args = input(WatchInputSchema, raw, '关注项');
  const bot = requireBot(ctx, args.botId);
  const old = args.id ? ctx.store.table('watches').get(args.id) : null;
  if (args.id && (!old || old.botId !== bot.id)) throw new Error('id：关注项不存在或不属于该机器人');
  if (ctx.store.table('watches').count(row => row.botId === bot.id && row.status !== 'expired' && row.id !== args.id) >= ctx.settings.maxWatchesPerBot)
    throw new Error('关注项数量已达上限');
  const row = makeWatch(ctx, bot, args, old);
  if (row.kind === 'script') await validateCommand(ctx, bot, row.target);
  ctx.store.table('watches').put(row);
  writeOutreachAudit(ctx, 'watch_owner_update', { id: row.id, status: row.status }, 'owner');
  await refreshBotFiles(ctx, bot.id);
  await syncFileWatches(ctx);
  ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  return row;
}
/** 优先通过原收件箱落实提议，保留接受率、拒绝冷却和结果唤醒的现有语义。 */
export async function decideWatchProposal(ctx: HubContext, id: string, approve: boolean) {
  const watch = ctx.store.table('watches').get(id);
  if (!watch || watch.status !== 'proposed') throw new Error('id：关注提议不存在或已经处理');
  const item = ctx.store.table('inbox').list(row => row.refId === id && row.type === 'proposal' && row.status === 'open')[0];
  if (!item) throw new Error('此关注项没有待处理提议，不能直接绕过已关闭或撤回的决定');
  if (approve) validateWatchFilter(watch.filter, ctx.settings);
  if (approve && ['file', 'log'].includes(watch.kind)) { parseFileTarget(watch.target); assertWatchPathAccess(ctx, watch.botId, watch.target); }
  if (approve && watch.kind === 'script') await validateCommand(ctx, requireBot(ctx, watch.botId), watch.target);
  const result = await answerInbox(ctx, item.id, approve ? '接受' : '拒绝');
  await syncFileWatches(ctx);
  return result;
}

/** 目标集合变化后重新计算最长沉默窗口，沿用最后思考锚点而不是把计时重新往后推。 */
export function refreshGoalClock(ctx: HubContext, botId: string): void {
  const bot = requireBot(ctx, botId);
  const hasActiveGoal = ctx.store.table('goals').count(row => row.botId === botId && row.status === 'active') > 0;
  ctx.store.table('bots').patch(botId, refreshLightCheck(bot, ctx.clock.now(), ctx.settings, hasActiveGoal));
}
