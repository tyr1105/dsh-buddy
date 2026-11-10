/** 回合用量按唤醒单幂等记账；个人预算排除主人发起，全局额度仍记录真实机器人消耗。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { LedgerEntry } from '../model/operations.js';
import { count, nonempty } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { startOfLocalDay } from '../util/time.js';
import { beginQuotaWindow, computeLight, getQuotaState, restForQuota, rollWindow } from './window.js';

const UsageInputSchema = z.strictObject({ botId: nonempty, wakeId: nonempty, tokens: count.nullable(), steps: count, packetBytes: count });
export type UsageInput = z.infer<typeof UsageInputSchema>;

/** 可能后开始的回合先结束；起窗必须找最早真实开始且尚未记账的回合，不能按结束顺序猜测。 */
function firstWindowStart(ctx: HubContext, now: number): number {
  const settled = new Set(ctx.store.log('ledger').all().filter(entry => entry.kind === 'turn').map(entry => entry.wakeId));
  const starts = ctx.store.table('wakes').list(wake => !settled.has(wake.id) && wake.startedAt <= now
    && wake.dispatchedAt !== null && (wake.dispatchedAt === undefined || wake.dispatchedAt <= now)
    // 老记录没有 dispatchedAt 时，running 或已完成回合可作为投递事实；投递中或 error 则不猜测。
    && (wake.dispatchedAt !== undefined || !['delivering', 'error'].includes(wake.status)))
    .map(wake => wake.startedAt);
  return starts.length === 0 ? now : Math.min(...starts);
}

/** 不能拿到 token 时才估算；向上取整，避免小数记账低估资源。 */
export function recordUsage(ctx: HubContext, input: UsageInput): LedgerEntry {
  const value = parseInput(UsageInputSchema, input, '用量');
  const duplicate = ctx.store.log('ledger').all().find(entry => entry.kind === 'turn' && entry.wakeId === value.wakeId);
  if (duplicate) {
    if (duplicate.who !== value.botId) throw new Error('wakeId 已有的账项与 botId 不一致');
    return duplicate;
  }
  const wake = ctx.store.table('wakes').get(value.wakeId);
  if (wake && wake.botId !== value.botId) throw new Error('wakeId 对应的机器人与 botId 不一致');
  const now = ctx.clock.now();
  const tokenBase = value.tokens ?? value.packetBytes / ctx.settings.estimatedBytesPerToken + value.steps * ctx.settings.estimatedTokensPerStep;
  const entry: LedgerEntry = { id: newId('le', ctx.rng), who: value.botId, wakeId: value.wakeId,
    tokens: Math.ceil(tokenBase * ctx.settings.tokenAccountingMultiplier), kind: 'turn', at: now,
    tokenSource: value.tokens === null ? 'estimate' : 'host', tokenBase,
    accountingMultiplier: ctx.settings.tokenAccountingMultiplier,
    ...(wake ? { ownerInitiated: wake.ownerInitiated } : {}) };
  const existed = ctx.store.table('quota').get('quota');
  const rolled = existed ? rollWindow(ctx, now) : null;
  const state = !rolled || rolled.windowPending ? beginQuotaWindow(ctx, firstWindowStart(ctx, now)) : rolled;
  // P63：主题回合只记账本（成本表能看到），不占窗口的自我保护上限：窗口上限连私聊都算，
  // 到顶全队暂停，一次讨论就能用光。单次成本靠发言上限兜住，服务商真报额度错误时仍会亮红灯。
  if (!wake?.topicId) {
    state.botTurns += 1;
    state.botTokens += entry.tokens;
  }
  const previousLight = state.light;
  state.light = computeLight(state, ctx.settings);
  if (state.light === 'red' && previousLight !== 'red') {
    state.redUntil = Math.max(now, state.windowStartAt + ctx.settings.quotaWindowMs) + ctx.settings.quotaResetGraceMs;
    state.probeAllowed = false;
  }
  ctx.store.log('ledger').append(entry);
  ctx.store.table('quota').put(state);
  if (state.light === 'red' && previousLight !== 'red') restForQuota(ctx, state, now);
  ctx.emit(HUB_EVENT_SCOPES.overview, value.botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, value.botId);
  return entry;
}

/** 主人直接发起的回合仍留在账本，但不压缩机器人自发工作的日预算。 */
function automatedUsage(ctx: HubContext, botId: string, from: number, now: number): LedgerEntry[] {
  return ctx.store.log('ledger').since(from, entry => entry.who === botId && entry.at <= now)
    .filter(entry => entry.wakeId === null || !ctx.store.table('wakes').get(entry.wakeId)?.ownerInitiated);
}

/** 按本地当天汇总自主回合与 token，排除主人发起回合以保持个人预算口径。 */
export function botUsageToday(ctx: HubContext, botId: string, now: number, after?: number): { turns: number; tokens: number } {
  const entries = automatedUsage(ctx, botId, startOfLocalDay(now, ctx.settings.timezone), now)
    .filter(entry => after === undefined || entry.at > after);
  return { turns: entries.filter(entry => entry.kind === 'turn').length, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0) };
}

/** 统计当前额度窗口内的自主回合，供个人窗口预算闸门使用。 */
export function botTurnsInWindow(ctx: HubContext, botId: string, now: number): number {
  const state = getQuotaState(ctx, now);
  // 新窗口尚未开始时旧账不能挡住恢复探针，否则投递前永远无法推进窗口锚点。
  if (state.windowPending) return 0;
  if (state.light !== 'red' && now >= state.windowStartAt + ctx.settings.quotaWindowMs) return 0;
  return automatedUsage(ctx, botId, state.windowStartAt, now).filter(entry => entry.kind === 'turn').length;
}
