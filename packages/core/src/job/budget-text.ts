/**
 * 预计消耗条目给主人看的文字（P76f，方案 7.5、派活说明第一节）：标题、正文、总管私聊的话、追加的 token 区间。
 *
 * 为什么单独一个文件：条目的建立（budget-ask.ts）和答复（budget-answer.ts）都要写同一批句子，
 * 句子集中在这里，改字只改一处，测试也按这里的函数逐句对。
 * 给主人看的文字不含内部编号、工具名、英文步骤名。token 数一律经 formatTokenCount 换算成带单位的短写法，不写「万」。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { EstimateVersion } from '../model/budget.js';
import { agreementCategory } from '../project/agreement-category.js';
import { formatTokenCount } from '../util/token-format.js';
import { historyFor } from './estimate.js';

/** 条目为什么建：projected 是预计将超出（这件事还在做），reached 是已经用到预算线。 */
export type BudgetAskReason = 'projected' | 'reached';

/** 条目正文要用的数。 */
export interface BudgetBodyInput {
  reason: BudgetAskReason;
  /** 已用回合（含对齐）。 */
  usedAll: number;
  /** 当前预计总数（含对齐）。 */
  total: number;
  /** 估计共需（含对齐）。 */
  needAll: number;
  /** 超出预计的原因（短句，不含句末标点）。 */
  reasons: readonly string[];
  /** 追加的回合数（选项里的 n）。 */
  n: number;
  /** 追加 n 个回合的 token 区间。 */
  tokenLow: number;
  tokenHigh: number;
  /** 受阻或交回没能叫醒下一个人时，现在卡在哪里（可为空）。 */
  stuckLine?: string;
}

/** 条目标题。 */
export function budgetTitle(title: string, reason: BudgetAskReason): string {
  return reason === 'projected' ? `${title}：消耗将超出预计` : `${title}：已用到预计消耗`;
}

/** 追加 n 个回合的 token 区间写法：换算后两端相同时写一个。 */
export function tokenRangeText(low: number, high: number): string {
  const lo = formatTokenCount(low);
  const hi = formatTokenCount(high);
  return lo === hi ? `约 ${lo} token` : `约 ${lo} 到 ${hi} token`;
}

/** 条目正文，逐行用换行连接。 */
export function budgetBody(input: BudgetBodyInput): string {
  // P76r3（R7）：「已用到预计的回合数。」只在已经到预算线、并且别的原因都不成立时才写；
  // 「将超出预计」时原因一定成立（执行用满、核对用满……），万一没有，写一句事实，不把「已用到」提前说出来。
  const reasonLine = input.reasons.length > 0 ? `超出的部分：${input.reasons.join('；')}。`
    : input.reason === 'reached' ? '已用到预计的回合数。' : '按现在的进度，做完还需要的回合超过了预计。';
  const lines = [
    `已用 ${input.usedAll} 回合，预计 ${input.total}，估计共需 ${input.needAll} 回合。`,
    reasonLine,
    `追加：按原约定做完，多用 ${input.n} 回合，${tokenRangeText(input.tokenLow, input.tokenHigh)}。`,
    '缩小范围：总管用 1 个回合拟一版改动，你确认后照新版本做。',
    input.reason === 'reached' ? '暂停：现在停下，等你再定。' : `暂停：用到 ${input.total} 回合时停下，等你再定。`,
  ];
  if (input.reason === 'projected') lines.push('在这之前，预计之内的部分照常在做。');
  if (input.stuckLine !== undefined && input.stuckLine !== '') lines.push(input.stuckLine);
  return lines.join('\n');
}

/** 总管私聊：预计将超出（这件事不停）。 */
export function projectedChatText(title: string, needAll: number, total: number): string {
  return `${title}预计要用 ${needAll} 回合，超出约定的 ${total} 回合，在等你决定；预计之内的部分照常在做。`;
}

/** 总管私聊：用到预算线。asked 为真表示之前问过；held 为真表示你选过暂停。 */
export function reachedChatText(title: string, total: number, state: 'asked' | 'unasked' | 'held'): string {
  if (state === 'held') return `${title}已用到预计的 ${total} 回合，按你的选择已暂停。要接着做时告诉我。`;
  if (state === 'asked') return `${title}已用到预计的 ${total} 回合，超出的部分已停下，在等你决定。`;
  return `${title}已用到预计的 ${total} 回合，已停下，在等你决定。`;
}

/** 某一步每个回合的 token 区间：同类记录的样本不少于 TOKEN_SAMPLE_MIN 个时取最小、最大，否则用默认表。 */
export function stepTurnRange(ctx: HubContext, agreementId: string, step: 'exec' | 'chief' = 'exec'): readonly [number, number] {
  const samples = historyFor(ctx, agreementCategory(ctx, agreementId)).turnSamples[step] ?? [];
  return samples.length >= D.TOKEN_SAMPLE_MIN ? [Math.min(...samples), Math.max(...samples)] : D.TOKENS_PER_TURN_DEFAULT[step];
}

/** 这件事执行一步每个回合的 token 区间（保留原来的名字，追加、答复的条目正文用它）。 */
export function execTurnRange(ctx: HubContext, agreementId: string): readonly [number, number] {
  return stepTurnRange(ctx, agreementId, 'exec');
}

/** 追加 n 个回合：这件事的 token 区间（默认按执行一步算，缩小范围给总管的那一回合按总管一步算）。 */
export function topUpTokens(ctx: HubContext, agreementId: string, n: number, step: 'exec' | 'chief' = 'exec'): { low: number; high: number } {
  const [lo, hi] = stepTurnRange(ctx, agreementId, step);
  return { low: n * lo, high: n * hi };
}

/**
 * 追加或缩小范围之后的新预计一项：复制最后一项，按原因改总数、某一步的预留和 token 区间。
 * P76r3（R3）：预算线每抬高 n 个回合，这里就追加一项、总数加 n，保持「预计总数 − 对齐 == 预算线」。
 * step 指定加到哪一步的预留上：继续做事加返工预留（原做法），给总管拟新版本的那一回合加总管预留。
 */
export function nextEstimate(last: EstimateVersion, reason: 'top_up' | 'narrow', now: number,
  add: { n: number; low: number; high: number } | null, step: 'rework' | 'chief' = 'rework'): EstimateVersion {
  if (add === null) return { ...last, reason, createdAt: now };
  return { ...last, total: last.total + add.n, steps: { ...last.steps, [step]: last.steps[step] + add.n },
    tokenLow: last.tokenLow + add.low, tokenHigh: last.tokenHigh + add.high, reason, createdAt: now };
}
