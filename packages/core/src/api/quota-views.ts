/**
 * 额度文字的唯一出口（P76d，方案 7.1、任务卡 4.7）：本窗口额度的状态、恢复时间、员工用了多少、给你留出多少，
 * 全部由这一个视图拼成文字；员工的活动文字、在办的事的进度行、顶栏、总览的额度字段都读它，几处说的才不会各说各话。
 *
 * 分两层：
 * - buildQuotaWindowView：纯函数，输入全部显式给出（额度记录、额度单例、设置、当前时刻、每回合 token 数），好测；
 * - quotaWindowView：读取函数，只读存档（不滚动窗口、不改任何状态），算出每回合 token 数后调用上面的纯函数。
 *
 * 文字规矩：用「员工」和「你」；不出现工具名、编号、英文标识；说的必须是事实。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { QuotaState } from '../model/operations.js';
import type { QuotaPlan } from '../model/quota-plan.js';
import type { Settings } from '../model/settings.js';
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import { quotaClockText } from '../quota/clock-text.js';
import { computeStaffLight, getQuotaPlan, isOwnerSide, staffLimitOf } from '../quota/plan.js';
import { getQuotaState } from '../quota/window.js';
import { formatTokenCount } from '../util/token-format.js';

/** 额度视图的结构（插件在 P76j 使用）。类型由它推出，校验与类型共用一份定义。 */
export const QuotaWindowViewSchema = z.strictObject({
  state: z.enum(['normal', 'staff_full', 'exhausted', 'owner_hold']),
  light: z.enum(['green', 'yellow', 'orange', 'red']),
  resetAt: z.number().int().nullable(),
  resetText: z.string(),
  staffUsedTurnsText: z.string(),
  staffLeftTurnsText: z.string(),
  /**
   * P86：本窗口内员工已用的 token 数量，文字写法与原始数字各给一项，界面不另算、不拼：
   * - staffUsedTokensText：按 formatTokenCount 换算单位后加「token」，例「1.76M token」，顶栏与总管右侧栏直接显示；
   * - staffUsedTokens：原始数字（取整、不小于 0），给悬停提示显示完整数字用。
   * 与「员工已用约 N 回合」同源（都来自 plan.staffTokens），所以两处不会各说各话。
   */
  staffUsedTokensText: z.string(),
  staffUsedTokens: z.number().int().nonnegative(),
  reserveText: z.string(),
  holdText: z.string().nullable(),
  barParts: z.strictObject({ staffUsed: z.number(), staffLeft: z.number(), reserved: z.number() }),
  lightLabel: z.string(),
  lightHint: z.string(),
  waitText: z.string().nullable(),
});
export type QuotaWindowView = z.infer<typeof QuotaWindowViewSchema>;

/** 纯函数的输入：只含需要的设置项，测试可以直接给。 */
export interface QuotaViewInput {
  plan: QuotaPlan;
  quota: QuotaState;
  /** 是否已经有额度窗口（存档里有额度单例）；没有时不写恢复时刻。 */
  hasWindow: boolean;
  settings: Pick<Settings, 'botQuotaShare' | 'quotaWindowMs' | 'timezone' | 'quotaRedRatio' | 'quotaOrangeRatio' | 'quotaYellowRatio'>;
  now: number;
  /** 每个员工回合大约用多少 token（实测中位数，样本不足时用默认值）。 */
  tokensPerTurn: number;
}

/** 「给你留出三成」：份额 0.9、0.7、0.5 写一成、三成、五成，其他写百分数。 */
function reserveTextOf(share: number): string {
  const percent = Math.round((1 - share) * 100);
  const word = percent === 10 ? '一成' : percent === 30 ? '三成' : percent === 50 ? '五成' : null;
  return `给你留出${word ?? ` ${percent}%`}`;
}

/** 按 token 换算「约几回合」（四舍五入）。 */
function turnsOf(tokens: number, perTurn: number): number {
  return perTurn > 0 ? Math.round(Math.max(0, tokens) / perTurn) : 0;
}

/** 额度视图（纯函数）。 */
export function buildQuotaWindowView(input: QuotaViewInput): QuotaWindowView {
  const { plan, quota, settings, now } = input;
  const clock = (at: number) => quotaClockText(at, now, settings.timezone);
  const redKind = quota.light !== 'red' ? null
    : computeStaffLight(plan, quota, settings).redKind === 'staff_full' ? 'staff_full' : 'exhausted';
  const holdActive = plan.ownerHoldUntil !== null && now < plan.ownerHoldUntil;
  const state: QuotaWindowView['state'] = redKind === 'exhausted' ? 'exhausted' : redKind === 'staff_full' ? 'staff_full' : holdActive ? 'owner_hold' : 'normal';

  // 恢复时刻：真实额度用完、员工份额用完都是 redUntil；没有红灯时是本窗口结束。
  const windowEnd = quota.windowStartAt + settings.quotaWindowMs;
  const resetAt = !input.hasWindow ? null : quota.light === 'red' && quota.redUntil !== null ? quota.redUntil : windowEnd;
  const resetText = resetAt === null ? ''
    : state === 'exhausted' ? `约 ${clock(resetAt)} 恢复${plan.exhausted?.resetFromText === true ? '' : '（估计）'}`
      : `${clock(resetAt)} 重置`;

  // 员工用量：按实测 token 换算成回合数。
  const staffLimit = staffLimitOf(plan, settings);
  const full = state === 'staff_full' || state === 'exhausted';
  const staffUsedTurnsText = `员工已用约 ${turnsOf(plan.staffTokens, input.tokensPerTurn)} 回合`;
  const staffLeftTurnsText = full ? '已到上限' : `员工还可用约 ${turnsOf(staffLimit - plan.staffTokens, input.tokensPerTurn)} 回合`;

  // 三段条：员工已用、员工还剩、给你留出的，相对窗口估计容量，相加为 1。
  const share = settings.botQuotaShare;
  const usedRatio = staffLimit > 0 ? Math.min(1, plan.staffTokens / staffLimit) : 1;
  const barParts = { staffUsed: share * usedRatio, staffLeft: share * (1 - usedRatio), reserved: 1 - share };

  const holdText = holdActive ? `你要自己用到 ${clock(plan.ownerHoldUntil!)}，员工不开新回合` : null;

  // 灯的名称与说明（逐字照任务卡）。
  let lightLabel: string;
  let lightHint: string;
  if (state === 'exhausted') {
    lightLabel = '额度已用完';
    lightHint = `${resetText}，到时先试一个回合。`;
  } else if (state === 'staff_full') {
    lightLabel = '员工份额已用完';
    lightHint = `员工在 ${resetAt === null ? '' : clock(resetAt)} 前不开新回合；你发起的对话不受影响。`;
  } else if (quota.light === 'orange') {
    lightLabel = '额度紧张';
    lightHint = '员工份额用到八成，只有你交代的事和你发起的对话继续。';
  } else if (quota.light === 'yellow') {
    lightLabel = '额度过半';
    lightHint = '员工份额用过一半，员工自己发起的工作放慢节奏。';
  } else {
    lightLabel = '额度充足';
    lightHint = '员工按正常节奏开工。';
  }
  if (holdActive) lightHint = `你要自己用到 ${clock(plan.ownerHoldUntil!)}。${lightHint}`;

  // 员工被挡住时在办的事、进度行用的一句：员工份额用完或真实额度用完等到恢复时刻；你自己要用等到截止时刻；两样都有取较晚的。
  const blockedUntil = [state === 'exhausted' || state === 'staff_full' ? resetAt : null, holdActive ? plan.ownerHoldUntil : null]
    .filter((value): value is number => value !== null);
  const waitText = blockedUntil.length === 0 ? null : `额度恢复，约 ${clock(Math.max(...blockedUntil))} 继续`;

  // P86：token 数量与回合数同源（plan.staffTokens）；非有限数、负数按 0（formatTokenCount 的口径一致）。
  const staffUsedTokens = Number.isFinite(plan.staffTokens) && plan.staffTokens > 0 ? Math.round(plan.staffTokens) : 0;
  const staffUsedTokensText = `${formatTokenCount(staffUsedTokens)} token`;

  return { state, light: quota.light, resetAt, resetText, staffUsedTurnsText, staffLeftTurnsText, staffUsedTokensText, staffUsedTokens, reserveText: reserveTextOf(share),
    holdText, barParts, lightLabel, lightHint, waitText };
}

/**
 * 每个员工回合大约用多少 token：最近 TOKENS_PER_TURN_SAMPLE 个员工发起回合的实测 token（账本的 tokenBase，来源是宿主）的中位数；
 * 样本不足 TOKENS_PER_TURN_SAMPLE_MIN 个时用 TOKENS_PER_TURN_FALLBACK。「员工发起」与记账口径一致：不是你发起、不是主题回合。
 */
export function tokensPerTurnOf(ctx: HubContext): number {
  const wakes = ctx.store.table('wakes');
  const samples = ctx.store.log('ledger').recent(BUDGET_DEFAULTS.TOKENS_PER_TURN_SAMPLE, entry => {
    if (entry.kind !== 'turn' || entry.tokenSource !== 'host' || entry.tokenBase === undefined) return false;
    const wake = entry.wakeId === null ? null : wakes.get(entry.wakeId);
    return wake ? !isOwnerSide(wake) : entry.ownerInitiated !== true;
  }).map(entry => entry.tokenBase!).sort((a, b) => a - b);
  if (samples.length < BUDGET_DEFAULTS.TOKENS_PER_TURN_SAMPLE_MIN) return BUDGET_DEFAULTS.TOKENS_PER_TURN_FALLBACK;
  const middle = Math.floor(samples.length / 2);
  const median = samples.length % 2 === 1 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
  return median > 0 ? median : BUDGET_DEFAULTS.TOKENS_PER_TURN_FALLBACK;
}

/** 读取当前的额度视图（只读，不滚动窗口、不改任何状态）。 */
export function quotaWindowView(ctx: HubContext, now: number): QuotaWindowView {
  return buildQuotaWindowView({ plan: getQuotaPlan(ctx, now), quota: getQuotaState(ctx, now),
    hasWindow: ctx.store.table('quota').get('quota') !== null, settings: ctx.settings, now, tokensPerTurn: tokensPerTurnOf(ctx) });
}
