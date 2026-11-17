/**
 * 额度窗口的记账、灯与容量估计（P76d，方案 7.1）。表 quotaWindows 只有一行，id 为 quota；
 * 结构定义在 model/quota-plan.ts（P76b）。本文件放读写它的函数和全部纯函数规则。
 *
 * 为什么这样设计：
 * - DSH 的模型额度按 5 小时一个窗口计，主人自己用 DSH 也算在里面，中心看不到插件之外的用量，只能估计窗口容量。
 * - 员工只能用到「员工份额」（窗口估计容量 x 给主人留出之后的比例）；主人发起的回合不受它约束。
 * - 灯、容量校准、容量回升都写成纯函数（输入显式给出），好测、好重放。
 */
import type { HubContext } from '../engine/context.js';
import type { QuotaState } from '../model/operations.js';
import type { QuotaPlan } from '../model/quota-plan.js';
import { QUOTA_ERROR_TEXT_MAX } from '../model/quota-plan.js';
import type { Settings } from '../model/settings.js';
import type { WakeTicket } from '../model/wake.js';
import { BUDGET_DEFAULTS, DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';

/** 红灯的两种：员工份额用完（只拦员工发起的回合），真实额度用完（全停，等探针）。 */
export type RedKind = 'staff_full' | 'exhausted';

/** 灯的判断只用到这四个设置，纯函数的入参用这个窄类型，调用方可以只给这几项。 */
export type LightSettings = Pick<Settings, 'botQuotaShare' | 'quotaRedRatio' | 'quotaOrangeRatio' | 'quotaYellowRatio'>;

/** 没有存档时的默认额度记录（不写入）：容量按起步值，来源 initial。 */
export function defaultQuotaPlan(now: number, windowStartAt = now): QuotaPlan {
  return { id: 'quota', capacityTokens: BUDGET_DEFAULTS.INITIAL_WINDOW_TOKENS, capacitySource: 'initial', windowStartAt,
    staffTokens: 0, ownerTokens: 0, staffTurns: 0, ownerTurns: 0, exhausted: null, ownerHoldUntil: null, borrowJobIds: [],
    errors: [], updatedAt: now };
}

/** 读额度记录；没有时返回一份不写入的默认（旧存档没有这张表时按空读）。 */
export function getQuotaPlan(ctx: HubContext, now: number): QuotaPlan {
  const stored = ctx.store.table('quotaWindows').get('quota');
  if (stored) return stored;
  // 窗口起点沿用旧额度单例里的（还没有就用 now），两处保持同一个起点。
  const legacy = ctx.store.table('quota').get('quota');
  return defaultQuotaPlan(now, legacy?.windowStartAt ?? now);
}

/** 写额度记录（整行替换）。 */
export function savePlan(ctx: HubContext, plan: QuotaPlan): QuotaPlan {
  const next = { ...plan };
  ctx.store.table('quotaWindows').put(next);
  return next;
}

/**
 * 这一笔用量记在「主人一侧」还是「员工一侧」：唤醒单是主人发起的（ownerInitiated），或属于主题对话（topicId 不为空）记主人一侧，
 * 其余（执行链、总管派活、复盘类、员工自己发起）记员工一侧。
 * 注意：它与「员工自己发起的回合」（quota/usage.ts 的 isSelfWork）是两件事，不要混用。
 */
export function isOwnerSide(wake: Pick<WakeTicket, 'ownerInitiated' | 'topicId'>): boolean {
  return wake.ownerInitiated === true || (typeof wake.topicId === 'string' && wake.topicId !== '');
}

/** 员工份额（token）：窗口估计容量乘以员工份额比例。 */
export function staffLimitOf(plan: Pick<QuotaPlan, 'capacityTokens'>, settings: Pick<Settings, 'botQuotaShare'>): number {
  return plan.capacityTokens * settings.botQuotaShare;
}

/** 员工份额的已用比例；份额为 0 视为已满（不能拿 0/0 的 NaN 绕过保护）。 */
export function staffRatioOf(plan: Pick<QuotaPlan, 'capacityTokens' | 'staffTokens'>, settings: Pick<Settings, 'botQuotaShare'>): number {
  const limit = staffLimitOf(plan, settings);
  return limit > 0 ? plan.staffTokens / limit : Number.POSITIVE_INFINITY;
}

/**
 * 灯（纯函数，方案 7.1）：
 * - 真实额度用完（plan.exhausted 不为空），或探针已放行、在途 -> 红、exhausted；
 * - 员工份额已用比例达到红线 -> 红、staff_full；达到橙线 -> 橙；达到黄线 -> 黄；其余绿。
 * 主人发起的回合不进员工份额，所以不改变这个比例。
 */
export function computeStaffLight(plan: QuotaPlan, quotaState: Pick<QuotaState, 'probeAllowed' | 'probeInFlight'>, settings: LightSettings):
  { light: QuotaState['light']; redKind: RedKind | null } {
  if (plan.exhausted !== null || quotaState.probeAllowed || quotaState.probeInFlight === true) return { light: 'red', redKind: 'exhausted' };
  const ratio = staffRatioOf(plan, settings);
  if (ratio >= settings.quotaRedRatio) return { light: 'red', redKind: 'staff_full' };
  if (ratio >= settings.quotaOrangeRatio) return { light: 'orange', redKind: null };
  if (ratio >= settings.quotaYellowRatio) return { light: 'yellow', redKind: null };
  return { light: 'green', redKind: null };
}

/**
 * 当前存档里的灯是红色时，红的是哪一种；灯不是红色为 null。
 * 以存档里的灯为准（闸门读的就是它），种类再由额度记录判断：记录里有真实额度用完的标记（exhausted），或探针放行、在途，是真实额度用完 exhausted；
 * 其余红灯是员工份额用完 staff_full。P76r2（R5）：不再用当前设置重算来反推，主人改了份额比例之后种类不会跟着变。
 * settings 参数保留（旧调用方照给），不再使用。
 */
export function redKindOf(plan: QuotaPlan, quota: Pick<QuotaState, 'light' | 'probeAllowed' | 'probeInFlight'>, _settings?: LightSettings): RedKind | null {
  if (quota.light !== 'red') return null;
  return plan.exhausted !== null || quota.probeAllowed || quota.probeInFlight === true ? 'exhausted' : 'staff_full';
}

/** 没有 Settings 时（旧调用方）灯的判断用默认值。 */
export function defaultLightSettings(): LightSettings {
  return { botQuotaShare: DEFAULTS.BOT_QUOTA_SHARE, quotaRedRatio: DEFAULTS.QUOTA_RED_RATIO,
    quotaOrangeRatio: DEFAULTS.QUOTA_ORANGE_RATIO, quotaYellowRatio: DEFAULTS.QUOTA_YELLOW_RATIO };
}

/**
 * 真实额度报错之后的容量校准（纯函数，只往小处校准）。
 * pluginTokens = 报错时本窗口插件看得到的全部用量（员工加主人）。理由：报错时主人在插件之外的用量看不到，
 * 插件看得到的部分就是容量的下限；取下限，员工份额只会偏小，不会让员工挤占主人。
 * - 来源是 initial（第一次报错）：容量 = max(下限, pluginTokens)；
 * - 来源是 calibrated：容量 = max(下限, min(当前容量, 最近三次报错的 pluginTokens 的最小值))，其中最近三次包含这一次。
 * plan.errors 是这一次报错之前已记下的；这一次的 pluginTokens 由第二个参数给出。
 */
export function calibrateCapacity(plan: Pick<QuotaPlan, 'capacitySource' | 'capacityTokens' | 'errors'>, pluginTokens: number): number {
  const floor = BUDGET_DEFAULTS.MIN_WINDOW_TOKENS;
  if (plan.capacitySource === 'initial') return Math.max(floor, pluginTokens);
  const recent = [...plan.errors.map(row => row.pluginTokens), pluginTokens].slice(-3);
  return Math.max(floor, Math.min(plan.capacityTokens, ...recent));
}

/** 这个窗口里有没有真实额度报错：报错记录里有不早于窗口起点的一条，或当前正处在真实额度用完的状态。 */
export function windowHadError(plan: Pick<QuotaPlan, 'errors' | 'exhausted'>, windowStartAt: number): boolean {
  return plan.exhausted !== null || plan.errors.some(row => row.at >= windowStartAt);
}

/**
 * 回升规则一：看到了更大的用量（纯函数）。
 * 本窗口插件看得到的用量（员工加主人）超过了当前估计容量、而没有报错：把容量提高到这个用量。
 * 理由：容量不可能小于已经实际用掉的量；只往小处校准会让主人自己用得多的一天之后员工份额一直偏小。
 * 返回新容量；不需要提高返回 null。
 */
export function raiseCapacityToUsage(plan: Pick<QuotaPlan, 'capacityTokens' | 'staffTokens' | 'ownerTokens'>): number | null {
  const seen = plan.staffTokens + plan.ownerTokens;
  return seen > plan.capacityTokens ? seen : null;
}

/**
 * 回升规则二：估计的容量确实限制了员工、而整个窗口没有报错（纯函数，窗口滚动时对刚结束的窗口判断）。
 * 条件：刚结束的窗口没有真实额度报错，且员工份额用到了橙灯线以上（staffTokens 不小于员工份额乘橙灯比例）。
 * 满足时容量乘以 CAPACITY_RECOVER_FACTOR，上限为 INITIAL_WINDOW_TOKENS（规则一实测到更大用量而超过这个上限时，不往下压）。
 * 返回新容量；不满足返回 null。
 */
export function recoverCapacity(plan: Pick<QuotaPlan, 'capacityTokens' | 'staffTokens'>, settings: Pick<Settings, 'botQuotaShare' | 'quotaOrangeRatio'>,
  windowHadError: boolean): number | null {
  if (windowHadError) return null;
  const limit = staffLimitOf(plan, settings);
  if (!(limit > 0) || plan.staffTokens < limit * settings.quotaOrangeRatio) return null;
  const next = Math.max(plan.capacityTokens, Math.min(Math.floor(plan.capacityTokens * BUDGET_DEFAULTS.CAPACITY_RECOVER_FACTOR), BUDGET_DEFAULTS.INITIAL_WINDOW_TOKENS));
  return next > plan.capacityTokens ? next : null;
}

/** 容量变化记一条审计：原来的值、新的值、依据是哪一条规则。 */
export function auditCapacityChange(ctx: HubContext, now: number, from: number, to: number, basis: string): void {
  ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: now, actor: 'hub', action: 'quota_capacity_change',
    detail: JSON.stringify({ from, to, basis }) });
}

/** 报错正文入账前的整理：去掉换行、最多 300 字。 */
export function errorTextForRecord(text: string): string {
  return [...text.replace(/[\r\n]+/g, ' ').trim()].slice(0, QUOTA_ERROR_TEXT_MAX).join('');
}
