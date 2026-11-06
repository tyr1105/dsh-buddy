/** 额度窗口保存真实计量与恢复探针许可；红灯保持到探针结果，不能被普通滚窗悄悄解除。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { bool, nonempty } from '../model/primitives.js';
import type { QuotaState } from '../model/operations.js';
import type { Settings } from '../model/settings.js';
import { DEFAULTS } from '../config/defaults.js';
import { localParts } from '../util/time.js';
import { closeAlert, raiseAlert } from '../health/alerts.js';

/** 无历史回合时只返回快照；不提前写入窗口，第一笔机器人回合才建立窗口起点。 */
export function getQuotaState(ctx: HubContext, now: number): QuotaState {
  return ctx.store.table('quota').get('quota') ?? {
    id: 'quota', windowStartAt: now, botTurns: 0, botTokens: 0,
    turnLimit: ctx.settings.initialWindowTurnLimit, tokenLimit: null, light: 'green',
    redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null,
  };
}

/** 比率的零上限表示没有可用容量，不能用 0/0 得到的 NaN 绕过保护。 */
function usageRatio(used: number, limit: number): number { return limit > 0 ? used / limit : Number.POSITIVE_INFINITY; }

/** 取回合与 token 用量中的较高比例分档，任一资源耗尽都亮红灯。 */
export function computeLight(state: QuotaState, settings?: Settings): QuotaState['light'] {
  if (state.redUntil !== null || state.probeAllowed || state.light === 'red') return 'red';
  const ratio = Math.max(usageRatio(state.botTurns, state.turnLimit), state.tokenLimit === null ? 0 : usageRatio(state.botTokens, state.tokenLimit));
  if (ratio >= (settings?.quotaRedRatio ?? DEFAULTS.QUOTA_RED_RATIO)) return 'red';
  if (ratio >= (settings?.quotaOrangeRatio ?? DEFAULTS.QUOTA_ORANGE_RATIO)) return 'orange';
  if (ratio >= (settings?.quotaYellowRatio ?? DEFAULTS.QUOTA_YELLOW_RATIO)) return 'yellow';
  return 'green';
}

/** 额度期限用绝对日期；到期只说明等待试运行，不能让昨天的“今天”误导主人再等一天。 */
export function quotaProtectionText(state: QuotaState, now: number, timezone: string): string {
  if (state.probeInFlight) return '额度保护，正在试运行';
  if (state.redUntil === null || state.redUntil <= now) return '额度保护，等待一次试运行';
  const deadline = localParts(state.redUntil, timezone);
  const clock = `${String(deadline.hour).padStart(2, '0')}:${String(deadline.minute).padStart(2, '0')}`;
  const year = deadline.year === localParts(now, timezone).year ? '' : `${deadline.year}年`;
  return `额度保护，${year}${deadline.month}月${deadline.day}日 ${clock} 后继续`;
}

/** 更新既有保护展示，不重报故障、不改次数和发生时间，也不覆盖暂停或等待主人等独立状态。 */
function refreshQuotaProtectionText(ctx: HubContext, state: QuotaState, now: number): void {
  if (state.light !== 'red') return;
  const text = quotaProtectionText(state, now, ctx.settings.timezone);
  for (const bot of ctx.store.table('bots').list(item => ['active', 'probation'].includes(item.lifecycle)
    && item.activity === 'resting' && item.activityText.startsWith('额度保护，'))) {
    if (bot.activityText === text) continue;
    ctx.store.table('bots').patch(bot.id, { activityText: text, updatedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  }
  for (const alert of ctx.store.table('alerts').list(item => item.code === 'quota' && item.status === 'open')) {
    if (alert.text === text) continue;
    ctx.store.table('alerts').patch(alert.id, { text });
    ctx.emit(HUB_EVENT_SCOPES.overview, alert.botId);
    ctx.emit(HUB_EVENT_SCOPES.activity, alert.botId);
  }
}

/** 到窗口边界清零普通用量；红灯必须等待恢复探针，不能直接回到绿灯。 */
export function rollWindow(ctx: HubContext, now: number): QuotaState {
  const stored = ctx.store.table('quota').get('quota');
  if (!stored) return getQuotaState(ctx, now);
  // 兼容旧零上限与无期限红灯；在途身份不再借用 null 截止时间表示。
  const state = { ...stored, tokenLimit: stored.tokenLimit === 0 ? null : stored.tokenLimit };
  if (state.light === 'red') {
    if (state.redUntil === null) state.redUntil = Math.max(now, state.windowStartAt + ctx.settings.quotaWindowMs) + ctx.settings.quotaResetGraceMs;
  } else if (now >= state.windowStartAt + ctx.settings.quotaWindowMs) {
    Object.assign(state, { botTurns: 0, botTokens: 0, windowPending: true, light: 'green', redUntil: null, probeAllowed: false });
    state.light = computeLight(state, ctx.settings);
    if (state.light === 'red') state.redUntil = now + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs;
  }
  refreshQuotaProtectionText(ctx, state, now);
  if (JSON.stringify(state) === JSON.stringify(stored)) return stored;
  ctx.store.table('quota').put(state);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  return state;
}

/** 只有实际回合开始才启用新窗口；空闲滚窗只清计数，不推进锚点。 */
export function beginQuotaWindow(ctx: HubContext, startedAt: number): QuotaState {
  const stored = ctx.store.table('quota').get('quota');
  const state = rollWindow(ctx, startedAt);
  if (!stored || state.windowPending) {
    const next = { ...state, windowStartAt: startedAt, windowPending: false };
    ctx.store.table('quota').put(next);
    return next;
  }
  return state;
}

/** 保护仍在持续时只安排休息、刷新开放告警；正常收尾和非额度探针失败不是新的额度故障。 */
export function restBotsForQuota(ctx: HubContext, state: QuotaState, now: number): void {
  const text = quotaProtectionText(state, now, ctx.settings.timezone);
  refreshQuotaProtectionText(ctx, state, now);
  for (const bot of ctx.store.table('bots').list()) {
    if (!['active', 'probation'].includes(bot.lifecycle) || !['watching', 'queued'].includes(bot.activity)) continue;
    ctx.store.table('bots').patch(bot.id, { activity: 'resting', activityText: text,
      quotaRest: { activity: bot.activity as 'watching' | 'queued', activityText: bot.activityText }, updatedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  }
  ctx.emit(HUB_EVENT_SCOPES.overview);
}

/** 仅真实额度错误或用量首次转红调用此入口；故障记录与日常保护状态刷新分开计数。 */
export function restForQuota(ctx: HubContext, state: QuotaState, now: number): void {
  restBotsForQuota(ctx, state, now);
  raiseAlert(ctx, { code: 'quota', botId: null, text: quotaProtectionText(state, now, ctx.settings.timezone),
    level: 'P0', immediate: true, at: now });
}

/** 首次额度报错才校准；探针失败保留容量，只重新等待一个窗口。 */
export function onQuotaError(ctx: HubContext, now: number): QuotaState {
  const current = rollWindow(ctx, now);
  const calibrate = current.calibratedAt === undefined && current.lastErrorAt === null && !current.probeInFlight;
  const state: QuotaState = {
    ...current, light: 'red', probeAllowed: false, probeInFlight: false, probeWakeId: null,
    ...(calibrate ? { calibratedAt: now,
      turnLimit: Math.max(ctx.settings.minCalibratedTurnLimit, Math.floor(current.botTurns * ctx.settings.quotaCalibrationMultiplier)),
      tokenLimit: current.botTokens > 0 ? Math.max(1, Math.floor(current.botTokens * ctx.settings.quotaCalibrationMultiplier)) : current.tokenLimit } : {}),
    redUntil: (current.probeInFlight ? now + ctx.settings.quotaWindowMs
      : Math.max(now, current.windowStartAt + ctx.settings.quotaWindowMs)) + ctx.settings.quotaResetGraceMs,
    lastError: '额度不足', lastErrorAt: now,
  };
  ctx.store.table('quota').put(state);
  restForQuota(ctx, state, now);
  return state;
}

/** 只授予一次探针许可，重复 tick 不会重发；实际投递前由调用方 consumeProbe 原子扣除。 */
export function maybeAllowProbe(ctx: HubContext, now: number): boolean {
  if (!ctx.store.table('quota').get('quota')) return false;
  const state = rollWindow(ctx, now);
  if (state.light !== 'red' || state.probeAllowed || state.probeInFlight || state.redUntil === null || now < state.redUntil) return false;
  ctx.store.table('quota').patch('quota', { probeAllowed: true, probeWakeId: null, windowPending: true, botTurns: 0, botTokens: 0 });
  ctx.emit(HUB_EVENT_SCOPES.overview);
  return true;
}

/** 用独立在途标记消费许可，所有红灯都保留明确恢复截止时间。 */
export function consumeProbe(ctx: HubContext, wakeId?: string): boolean {
  if (wakeId !== undefined) wakeId = parseInput(nonempty, wakeId, '探针唤醒单');
  const state = ctx.store.table('quota').get('quota');
  if (!state || state.light !== 'red' || !state.probeAllowed) return false;
  ctx.store.table('quota').patch('quota', { probeAllowed: false, probeInFlight: true, probeWakeId: wakeId ?? null });
  return true;
}

/** 探针成功恢复，失败再等一个完整窗口；额度故障不替主人解除生命周期或鉴权暂停。 */
export function onProbeResult(ctx: HubContext, ok: boolean): QuotaState {
  ok = parseInput(bool, ok, '额度探针结果');
  const now = ctx.clock.now();
  const state = ctx.store.table('quota').get('quota');
  if (!state || state.light !== 'red' || state.probeAllowed || !state.probeInFlight) {
    throw new Error('没有已消费且正在等待结果的额度探针，不能处理探针结果');
  }
  const result: QuotaState = { ...state, light: ok ? 'green' : 'red', probeAllowed: false, probeInFlight: false, probeWakeId: null,
    tokenLimit: state.tokenLimit === 0 ? null : state.tokenLimit,
    redUntil: ok ? null : now + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs };
  ctx.store.table('quota').put(result);
  if (ok) {
    closeAlert(ctx, 'quota', null);
    for (const bot of ctx.store.table('bots').list(item => item.activity === 'resting' && item.activityText.startsWith('额度保护，'))) {
      if (!['active', 'probation'].includes(bot.lifecycle)) continue;
      ctx.store.table('bots').patch(bot.id, { activity: bot.quotaRest?.activity ?? 'watching',
        activityText: bot.quotaRest?.activityText ?? '额度已恢复，继续关注', quotaRest: null, updatedAt: now });
      ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    }
  // 真实额度错误已由 onQuotaError 处理并清除探针身份；这里的失败仅延长保护，不能重开已确认告警。
  } else restBotsForQuota(ctx, result, now);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  return result;
}
