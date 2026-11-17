/**
 * 额度窗口保存真实计量与恢复探针许可（旧表 quota 一行 QuotaState）；员工份额、容量估计、真实额度报错的记录在新表 quotaWindows（quota/plan.ts）。
 *
 * P76d 起的分工：
 * - QuotaState.light、redUntil 仍是唯一的灯和恢复时刻（旧版本读得懂），但灯由 quota/plan.ts 的 computeStaffLight 按「员工份额已用比例」算；
 * - 红灯分两种：员工份额用完（staff_full，只拦员工发起的回合，到本窗口结束自动恢复，不需要探针）、
 *   真实额度用完（exhausted，全停，等恢复时刻放一个探针回合，探针成功才恢复）；
 * - 真实额度用完不再建「待你处理」告警条目、不推送：只让员工休息、在办的事的进度行写明恢复时间。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { bool, nonempty } from '../model/primitives.js';
import type { QuotaState } from '../model/operations.js';
import type { QuotaPlan } from '../model/quota-plan.js';
import type { Settings } from '../model/settings.js';
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import { closeAlert } from '../health/alerts.js';
import { quotaClockText } from './clock-text.js';
import { auditCapacityChange, calibrateCapacity, computeStaffLight, defaultLightSettings, defaultQuotaPlan, errorTextForRecord,
  getQuotaPlan, recoverCapacity, savePlan, windowHadError } from './plan.js';
import { parseResetAt } from './reset-text.js';

/** 员工休息时活动文字的前缀。P76d 起新前缀；旧前缀「额度保护，」是旧版本写在存档里的，两种都认。 */
export const QUOTA_REST_PREFIX = '在等额度恢复，';
const LEGACY_QUOTA_REST_PREFIX = '额度保护，';

/** 这段活动文字是不是中心写的「在等额度」说明（新旧前缀都认）。 */
export function isQuotaRestText(text: string): boolean {
  return text.startsWith(QUOTA_REST_PREFIX) || text.startsWith(LEGACY_QUOTA_REST_PREFIX);
}

/** 无历史回合时只返回快照；不提前写入窗口，第一笔机器人回合才建立窗口起点。 */
export function getQuotaState(ctx: HubContext, now: number): QuotaState {
  return ctx.store.table('quota').get('quota') ?? {
    id: 'quota', windowStartAt: now, botTurns: 0, botTokens: 0,
    turnLimit: ctx.settings.initialWindowTurnLimit, tokenLimit: null, light: 'green',
    redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null,
  };
}

/**
 * 灯（保留函数名，供其他地方引用）：P76d 起改为调用 quota/plan.ts 的 computeStaffLight，按员工份额已用比例分档。
 * plan 不给时用一份没有用量的默认记录（只能得到红灯标记以外的绿灯，调用方要判断用量时必须传 plan）。
 */
export function computeLight(state: QuotaState, settings?: Settings, plan?: QuotaPlan): QuotaState['light'] {
  return computeStaffLight(plan ?? defaultQuotaPlan(state.windowStartAt), state, settings ?? defaultLightSettings()).light;
}

/**
 * 员工休息时的活动文字：「在等额度恢复，约 {HH:mm} 继续」（跨日带月日）。
 * 为什么不写「额度保护」：主人看不懂是什么保护；写明在等什么、等到什么时候，才说的是事实。
 * 探针在等或在途时写没有时刻的两句。
 */
export function quotaProtectionText(state: QuotaState, now: number, timezone: string): string {
  if (state.probeInFlight) return `${QUOTA_REST_PREFIX}正在试运行`;
  if (state.redUntil === null || state.redUntil <= now) return `${QUOTA_REST_PREFIX}等待一次试运行`;
  return `${QUOTA_REST_PREFIX}约 ${quotaClockText(state.redUntil, now, timezone)} 继续`;
}

/** 更新既有保护展示，不重报故障、不改次数和发生时间，也不覆盖暂停或等待主人等独立状态。 */
function refreshQuotaProtectionText(ctx: HubContext, state: QuotaState, now: number): void {
  if (state.light !== 'red') return;
  const text = quotaProtectionText(state, now, ctx.settings.timezone);
  for (const bot of ctx.store.table('bots').list(item => ['active', 'probation'].includes(item.lifecycle)
    && item.activity === 'resting' && isQuotaRestText(item.activityText))) {
    if (bot.activityText === text) continue;
    ctx.store.table('bots').patch(bot.id, { activityText: text, updatedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  }
  // 旧版本留下的、仍开着的「中心告警：额度」条目：文字跟着更新（新版本不再建这种条目）。
  for (const alert of ctx.store.table('alerts').list(item => item.code === 'quota' && item.status === 'open')) {
    if (alert.text === text) continue;
    ctx.store.table('alerts').patch(alert.id, { text });
    ctx.emit(HUB_EVENT_SCOPES.overview, alert.botId);
    ctx.emit(HUB_EVENT_SCOPES.activity, alert.botId);
  }
}

/** 额度灯恢复（员工份额用完的窗口结束、探针成功）：把因额度休息的员工放回原来的状态。 */
export function restoreBotsFromQuota(ctx: HubContext, now: number): void {
  for (const bot of ctx.store.table('bots').list(item => item.activity === 'resting' && isQuotaRestText(item.activityText))) {
    if (!['active', 'probation'].includes(bot.lifecycle)) continue;
    ctx.store.table('bots').patch(bot.id, { activity: bot.quotaRest?.activity ?? 'watching',
      activityText: bot.quotaRest?.activityText ?? '额度已恢复，继续关注', quotaRest: null, updatedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  }
}

/** 额度状态变化（转红、恢复、报错）时让界面刷新：总览，以及读着额度挡住说明的进度行（项目页与主题）。 */
export function emitQuotaChange(ctx: HubContext): void {
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}

/** 旧起始回合数。P73r5 把起始值改为 40；存档里仍是它、且从未被真实额度报错校准的，视为旧起始估计。 */
const LEGACY_INITIAL_TURN_LIMIT = 8;

/**
 * 旧存档迁移（纯函数）：回合上限仍是旧起始值 8，且没有被真实额度报错校准过
 * （没有 calibratedAt，也没有任何额度报错记录 lastErrorAt），就换成当前设置的起始值。
 * 为什么这样判断：校准只会在首次额度报错时写入 calibratedAt 与 lastErrorAt；
 * 两者都没有，说明 8 只是当初的起始估计，不是服务商实际给出的额度。红灯中的状态不动，等探针结果。
 * P76d：回合上限不再参与灯的判断；这样的旧存档本来就没有额度记录（没有员工份额的用量），灯按没有用量重算，即回到绿灯。
 */
export function migrateLegacyTurnLimit(state: QuotaState, settings: Settings): QuotaState {
  if (state.turnLimit !== LEGACY_INITIAL_TURN_LIMIT || state.calibratedAt !== undefined || state.lastErrorAt !== null) return state;
  if (state.light === 'red' || settings.initialWindowTurnLimit === state.turnLimit) return state;
  const next = { ...state, turnLimit: settings.initialWindowTurnLimit };
  next.light = computeLight(next, settings);
  return next;
}

/**
 * 旧存档里的红灯：P76d 之前真实额度报错留下的红灯没有 quotaWindows.exhausted。
 * 判断依据：灯是红的、没有探针标记、没有 exhausted，且恢复时刻不等于「窗口起点加一个窗口」
 * （员工份额用完的红灯恢复时刻恰好是窗口结束，真实额度用完的恢复时刻带 5 分钟等待，两者不会相等）。
 * 这样的红灯按「真实额度用完」补上 exhausted，等探针，行为与升级前一致。
 */
function adoptLegacyRed(ctx: HubContext, state: QuotaState, plan: QuotaPlan, now: number): QuotaPlan {
  if (state.light !== 'red' || plan.exhausted !== null || state.probeAllowed || state.probeInFlight === true) return plan;
  const windowEnd = state.windowStartAt + ctx.settings.quotaWindowMs;
  if (state.redUntil !== null && state.redUntil === windowEnd) return plan;
  const redUntil = state.redUntil ?? Math.max(now, windowEnd) + ctx.settings.quotaResetGraceMs;
  return savePlan(ctx, { ...plan, exhausted: { at: state.lastErrorAt ?? state.windowStartAt,
    resetAt: Math.max(0, redUntil - ctx.settings.quotaResetGraceMs), resetFromText: false }, updatedAt: now });
}

/** 窗口滚动或探针放行时，额度记录的用量同一时刻清零；exhausted 不清（等探针），容量与报错记录保留。 */
function clearPlanUsage(plan: QuotaPlan, now: number): QuotaPlan {
  return { ...plan, staffTokens: 0, ownerTokens: 0, staffTurns: 0, ownerTurns: 0, borrowJobIds: [], updatedAt: now };
}

/**
 * 到窗口边界清零普通用量。
 * - 真实额度用完（exhausted）的红灯必须等待恢复探针，不能直接回到绿灯；
 * - 员工份额用完的红灯到本窗口结束自动恢复（不需要探针，因为没有真实报错）；
 * - 滚动的同一时刻：QuotaState 的用量与额度记录的四个计数一起清零，borrowJobIds 清空；
 *   并对刚结束的窗口判一次容量回升（quota/plan.ts 的 recoverCapacity：员工份额用到橙灯线以上而整个窗口没有报错）。
 */
export function rollWindow(ctx: HubContext, now: number): QuotaState {
  const stored = ctx.store.table('quota').get('quota');
  if (!stored) return getQuotaState(ctx, now);
  // 兼容旧零上限与无期限红灯；在途身份不再借用 null 截止时间表示。
  const state = { ...migrateLegacyTurnLimit(stored, ctx.settings), tokenLimit: stored.tokenLimit === 0 ? null : stored.tokenLimit };
  let plan = adoptLegacyRed(ctx, state, getQuotaPlan(ctx, now), now);
  const exhaustedKind = plan.exhausted !== null || state.probeAllowed || state.probeInFlight === true;
  const windowEnd = state.windowStartAt + ctx.settings.quotaWindowMs;
  if (exhaustedKind) {
    state.light = 'red';
    if (state.redUntil === null) state.redUntil = Math.max(now, windowEnd) + ctx.settings.quotaResetGraceMs;
  } else if (now >= windowEnd) {
    const wasRed = state.light === 'red';
    const recovered = recoverCapacity(plan, ctx.settings, windowHadError(plan, state.windowStartAt));
    if (recovered !== null) {
      auditCapacityChange(ctx, now, plan.capacityTokens, recovered, '窗口滚动：员工份额用到橙灯线以上，整个窗口没有额度报错');
      plan = { ...plan, capacityTokens: recovered };
    }
    plan = savePlan(ctx, clearPlanUsage(plan, now));
    Object.assign(state, { botTurns: 0, botTokens: 0, windowPending: true, light: 'green', redUntil: null, probeAllowed: false });
    const verdict = computeStaffLight(plan, state, ctx.settings);
    state.light = verdict.light;
    if (verdict.redKind === 'staff_full') state.redUntil = now + ctx.settings.quotaWindowMs;
    if (wasRed && state.light !== 'red') restoreBotsFromQuota(ctx, now);
  }
  refreshQuotaProtectionText(ctx, state, now);
  if (JSON.stringify(state) === JSON.stringify(stored)) return stored;
  ctx.store.table('quota').put(state);
  emitQuotaChange(ctx);
  return state;
}

/**
 * P76r2 第 4 节：按当前设置和额度记录重算灯并保存（界面改了员工份额比例或灯的三档比例之后调用）。
 * 做法与 quota/usage.ts 的 recordUsage 记账之后那一段相同：computeStaffLight 重算；员工份额用完时恢复时刻是本窗口结束，
 * 不是红灯就清掉恢复时刻；从非红变红时让员工休息，由红变成不红时恢复被额度挡住的员工；灯变了就通知界面刷新。
 * 重复说明：usage.ts 的 recordUsage 里仍有一份同样的写法（那个文件本卡不能改，另一张卡正在改），等合并之后再收成调用这个函数。
 * 先 rollWindow：与记账同一口径，窗口到期、旧存档里的红灯（没有 exhausted 的）先按既有规则处理，不会被这里误清。
 * 还没有额度状态（从没有回合）时什么都不做；灯没有变化时不写。
 */
export function recomputeLightAndSave(ctx: HubContext, now: number): QuotaState | null {
  if (!ctx.store.table('quota').get('quota')) return null;
  const state = { ...rollWindow(ctx, now) };
  const plan = getQuotaPlan(ctx, now);
  const previousLight = state.light;
  const verdict = computeStaffLight(plan, state, ctx.settings);
  state.light = verdict.light;
  if (verdict.redKind === 'staff_full') {
    state.redUntil = state.windowStartAt + ctx.settings.quotaWindowMs;
    state.probeAllowed = false;
  } else if (verdict.redKind === null) state.redUntil = null;
  ctx.store.table('quota').put(state);
  if (state.light === 'red' && previousLight !== 'red') restBotsForQuota(ctx, state, now);
  else if (previousLight === 'red' && state.light !== 'red') restoreBotsFromQuota(ctx, now);
  if (state.light !== previousLight) emitQuotaChange(ctx);
  return state;
}

/** 只有实际回合开始才启用新窗口；空闲滚窗只清计数，不推进锚点。额度记录的窗口起点同步。 */
export function beginQuotaWindow(ctx: HubContext, startedAt: number): QuotaState {
  const stored = ctx.store.table('quota').get('quota');
  const state = rollWindow(ctx, startedAt);
  if (!stored || state.windowPending) {
    const next = { ...state, windowStartAt: startedAt, windowPending: false };
    ctx.store.table('quota').put(next);
    const plan = ctx.store.table('quotaWindows').get('quota');
    if (plan && plan.windowStartAt !== startedAt) savePlan(ctx, { ...plan, windowStartAt: startedAt, updatedAt: startedAt });
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
  emitQuotaChange(ctx);
}

/**
 * 真实额度错误的入口（P76d）。
 * 不建告警条目、不推送：额度用完是员工在等，主人不用做任何事（设计稿场景 E）；主人在在办的事的进度行里看得到恢复时间。
 * 做的事：
 * 1. 解析恢复时间：宿主交来的报错正文里有恢复时刻（P76a：正文完整到达）就按它，redUntil = 恢复时刻加 5 分钟等待，
 *    窗口起点回推为「恢复时刻减一个窗口」；解析不到退回估计（窗口起点加一个窗口加 5 分钟），exhausted.resetFromText 为 false。
 * 2. 校准容量（只往小处）：按报错时插件看得到的用量，见 calibrateCapacity。
 * 3. 被动记录这次报错（正文前 300 字、恢复时间、当时用量），供以后校准。
 * 4. 旧的回合数、token 上限校准照旧写（不参与判断）。
 */
export function onQuotaError(ctx: HubContext, now: number, errorText?: string): QuotaState {
  const current = rollWindow(ctx, now);
  const plan = getQuotaPlan(ctx, now);
  const calibrate = current.calibratedAt === undefined && current.lastErrorAt === null && !current.probeInFlight;
  const grace = ctx.settings.quotaResetGraceMs;
  const resetAt = errorText === undefined ? null : parseResetAt(errorText, now, ctx.settings.timezone);
  const redUntil = resetAt !== null ? resetAt + grace
    : (current.probeInFlight ? now + ctx.settings.quotaWindowMs : Math.max(now, current.windowStartAt + ctx.settings.quotaWindowMs)) + grace;
  const windowStartAt = resetAt !== null ? Math.max(0, resetAt - ctx.settings.quotaWindowMs) : current.windowStartAt;
  const pluginTokens = plan.staffTokens + plan.ownerTokens;
  // P76r2（R8）：同一个窗口里已经记了真实额度用完（exhausted 有值、发生在当前窗口起点之后、不是探针回合报的错）时，
  // 几位员工的回合在同一次额度用完时各报一次，只更新恢复时刻，不再往报错记录里追加、也不再校准容量：
  // 「最近三次报错」要的是三次不同的额度事件，不能被同一次事件填满。下一个窗口（探针回合开始后窗口起点后移）再报错照常追加。
  const sameWindow = plan.exhausted !== null && !current.probeInFlight && plan.exhausted.at >= current.windowStartAt;
  if (sameWindow) {
    savePlan(ctx, { ...plan, windowStartAt, exhausted: { ...plan.exhausted!, resetAt: redUntil - grace, resetFromText: resetAt !== null }, updatedAt: now });
  } else {
    savePlan(ctx, { ...plan, capacityTokens: calibrateCapacity(plan, pluginTokens), capacitySource: 'calibrated', windowStartAt,
      exhausted: { at: now, resetAt: redUntil - grace, resetFromText: resetAt !== null },
      errors: [...plan.errors, { at: now, text: errorTextForRecord(errorText ?? ''), resetAt, pluginTokens }].slice(-BUDGET_DEFAULTS.QUOTA_ERRORS_MAX),
      updatedAt: now });
  }
  const state: QuotaState = {
    ...current, light: 'red', probeAllowed: false, probeInFlight: false, probeWakeId: null, windowStartAt,
    ...(calibrate ? { calibratedAt: now,
      turnLimit: Math.max(ctx.settings.minCalibratedTurnLimit, Math.floor(current.botTurns * ctx.settings.quotaCalibrationMultiplier)),
      tokenLimit: current.botTokens > 0 ? Math.max(1, Math.floor(current.botTokens * ctx.settings.quotaCalibrationMultiplier)) : current.tokenLimit } : {}),
    redUntil, lastError: '额度不足', lastErrorAt: now,
  };
  ctx.store.table('quota').put(state);
  restBotsForQuota(ctx, state, now);
  return state;
}

/** 只授予一次探针许可，重复 tick 不会重发；实际投递前由调用方 consumeProbe 原子扣除。只对真实额度用完的红灯放探针。 */
export function maybeAllowProbe(ctx: HubContext, now: number): boolean {
  if (!ctx.store.table('quota').get('quota')) return false;
  const state = rollWindow(ctx, now);
  const plan = getQuotaPlan(ctx, now);
  // 员工份额用完的红灯没有真实报错，到窗口结束自动恢复，不需要探针。
  if (plan.exhausted === null) return false;
  if (state.light !== 'red' || state.probeAllowed || state.probeInFlight || state.redUntil === null || now < state.redUntil) return false;
  ctx.store.table('quota').patch('quota', { probeAllowed: true, probeWakeId: null, windowPending: true, botTurns: 0, botTokens: 0 });
  // 探针放行就是新窗口的开始：额度记录的用量同一时刻清零（exhausted 保留，等探针结果）。
  savePlan(ctx, clearPlanUsage(plan, now));
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

/** 探针成功恢复（exhausted 清空、灯重算），失败再等一个完整窗口；额度故障不替主人解除生命周期或鉴权暂停。 */
export function onProbeResult(ctx: HubContext, ok: boolean): QuotaState {
  ok = parseInput(bool, ok, '额度探针结果');
  const now = ctx.clock.now();
  const state = ctx.store.table('quota').get('quota');
  if (!state || state.light !== 'red' || state.probeAllowed || !state.probeInFlight) {
    throw new Error('没有已消费且正在等待结果的额度探针，不能处理探针结果');
  }
  const plan = getQuotaPlan(ctx, now);
  const failedUntil = now + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs;
  let result: QuotaState;
  if (ok) {
    const cleared = savePlan(ctx, { ...plan, exhausted: null, updatedAt: now });
    const verdict = computeStaffLight(cleared, { probeAllowed: false, probeInFlight: false }, ctx.settings);
    result = { ...state, light: verdict.light, probeAllowed: false, probeInFlight: false, probeWakeId: null,
      tokenLimit: state.tokenLimit === 0 ? null : state.tokenLimit,
      redUntil: verdict.redKind === 'staff_full' ? state.windowStartAt + ctx.settings.quotaWindowMs : null };
  } else {
    savePlan(ctx, { ...plan, exhausted: { at: plan.exhausted?.at ?? now, resetAt: failedUntil - ctx.settings.quotaResetGraceMs,
      resetFromText: false }, updatedAt: now });
    result = { ...state, light: 'red', probeAllowed: false, probeInFlight: false, probeWakeId: null,
      tokenLimit: state.tokenLimit === 0 ? null : state.tokenLimit, redUntil: failedUntil };
  }
  ctx.store.table('quota').put(result);
  if (ok) {
    // 旧版本留下的「中心告警：额度」条目随恢复关闭（新版本不再建这种条目）。
    closeAlert(ctx, 'quota', null);
    if (result.light !== 'red') restoreBotsFromQuota(ctx, now);
  // 真实额度错误已由 onQuotaError 处理并清除探针身份；这里的失败仅延长保护，不能重开已确认告警。
  } else restBotsForQuota(ctx, result, now);
  emitQuotaChange(ctx);
  return result;
}
