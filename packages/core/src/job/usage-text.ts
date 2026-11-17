/**
 * 一件事的消耗文字（P76e）：进度行的第三行「消耗」、展开后的逐回合明细，以及回执里的「消耗」一行。
 *
 * 为什么单独一个文件：这些文字完全由记录决定，是纯函数，进度行（api/job-topic-views.ts）和以后的「在办的事」页（P76i）
 * 共用同一处，不会各说各话。token 数一律经 formatTokenCount 换算成带单位的短写法（380K、1.64M），不写「万」。
 * 给主人看的句子不出现内部编号、工具名、英文步骤名。
 */
import type { EstimateVersion, JobOwnerTurns, JobUsage, UsageStep } from '../model/budget.js';
import { formatTokenCount } from '../util/token-format.js';
import { localParts } from '../util/time.js';

/** 步骤的中文名（给主人看）。 */
export const STEP_LABELS: Record<UsageStep, string> = { align: '对齐', exec: '执行', review: '核对', rework: '返工', chief: '总管', launch: '发布' };

/** 分布里的步骤顺序。 */
const SPREAD_ORDER: UsageStep[] = ['align', 'exec', 'review', 'rework', 'chief', 'launch'];

/** 明细的一行。 */
export interface CostTurnRow { at: string; who: string; step: string; tokens: string }

const pad = (value: number): string => String(value).padStart(2, '0');

/** P87：「你发起的回合」一栏的数据（表 jobOwnerTurns 的行）；没有这一栏（旧数据、没记过）为 null。 */
export type OwnerTurnsInput = JobOwnerTurns | null | undefined;

/** P87：这一栏的合计；没有这一栏为 0。 */
export function ownerTotalsOf(owner: OwnerTurnsInput): { turns: number; tokens: number } {
  return { turns: owner?.total.turns ?? 0, tokens: owner?.total.tokens ?? 0 };
}

/** 明细里「你发起」的回合在「步骤」一栏写的字。 */
const OWNER_STEP_LABEL = '你发起';

/**
 * 回合明细：每项一行；时间「{M}月{D}日 {HH:mm}」；还没记账（回合没有结束）的写「进行中」。
 * P87：「你发起的回合」也列出，步骤一栏写「你发起」，与其余回合按开始时间合在一起排序（没有这一栏时顺序不变）。
 */
export function costTurnRows(usage: Pick<JobUsage, 'turns'>, names: Record<string, string>, timezone: string, owner: OwnerTurnsInput = null): CostTurnRow[] {
  const rowOf = (turn: { botId: string; startedAt: number; endedAt: number | null; tokens: number }, step: string): CostTurnRow => {
    const p = localParts(turn.startedAt, timezone);
    return {
      at: `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`,
      who: names[turn.botId] ?? '已删除的员工',
      step,
      tokens: turn.endedAt === null ? '进行中' : `${formatTokenCount(turn.tokens)} token`,
    };
  };
  const own = owner?.turns ?? [];
  if (own.length === 0) return usage.turns.map(turn => rowOf(turn, STEP_LABELS[turn.step]));
  // 合并后按开始时间排序（Array.sort 稳定：同一时刻保持六步明细在前）。
  return [...usage.turns.map(turn => ({ at: turn.startedAt, row: rowOf(turn, STEP_LABELS[turn.step]) })),
    ...own.map(turn => ({ at: turn.startedAt, row: rowOf(turn, OWNER_STEP_LABEL) }))]
    .sort((a, b) => a.at - b.at).map(item => item.row);
}

/** P87：进度行与「在办的事」里的补充句「另有你发起的 {n} 回合 {y} token」（前面的标点由调用处加）；这一栏为 0 返回 null。 */
export function ownerCostPhrase(owner: OwnerTurnsInput): string | null {
  const totals = ownerTotalsOf(owner);
  return totals.turns > 0 ? `另有你发起的 ${totals.turns} 回合 ${formatTokenCount(totals.tokens)} token` : null;
}

/** 六步合计的回合数与 token。 */
function totalsOf(usage: Pick<JobUsage, 'steps'>): { turns: number; tokens: number } {
  let turns = 0;
  let tokens = 0;
  for (const step of SPREAD_ORDER) { turns += usage.steps[step].turns; tokens += usage.steps[step].tokens; }
  return { turns, tokens };
}

/**
 * 进度行的消耗一行与明细（纯函数）。
 * - 这件事已经有（aligning 为假）：
 *   有预计：「消耗：{used} / {total} 回合，已用 {x} token　{分布}」，分布是「对齐 {a}，执行 {e}，核对 {r}，返工 {w}，总管 {c}，发布 {l}」
 *   中回合数大于 0 的项（对齐总写）；没有预计：「消耗：已用 {used} 回合，{x} token」。
 *   没有用量行（旧数据，没有记过账）：没有这一行，明细为空。
 * - P87：「你发起的总管回合」一栏有回合时，在「已用 {x} token」之后、分布之前加「，另有你发起的 {n} 回合 {y} token」（没有预计时加在末尾）；
 *   明细里这些回合步骤写「你发起」。这一栏不进回合数、不进预计的比较。
 * - 还没有这件事（aligning 为真，对齐中）：「消耗：已用 {a} 回合（对齐）」；有预计时「消耗：预计 {total} 回合，已用 {a} 回合（对齐）」。
 * 「　」是全角空格，把合计和分布隔开。
 */
export function costLineOf(
  usage: JobUsage | null, estimate: EstimateVersion | null, names: Record<string, string>, timezone: string, aligning = false,
  owner: OwnerTurnsInput = null,
): { costLine: string | null; costTurns: CostTurnRow[] } {
  if (usage === null) return { costLine: null, costTurns: [] };
  const costTurns = costTurnRows(usage, names, timezone, owner);
  if (aligning) {
    const used = `已用 ${usage.steps.align.turns} 回合（对齐）`;
    return { costLine: `消耗：${estimate === null ? '' : `预计 ${estimate.total} 回合，`}${used}`, costTurns };
  }
  const totals = totalsOf(usage);
  const { tokens } = totals;
  // P84（K5）：「已用 / 预计」的已用不含发布这一步的回合（预计本来就不含发布），与「在办的事」一致；分布里的「发布 n」与回合明细照旧。
  const turns = totals.turns - usage.steps.launch.turns;
  // P87：这一栏有回合时，在「已用 {x} token」之后、分布之前加「，另有你发起的 {n} 回合 {y} token」；没有时与原来逐字相同。
  const ownerPhrase = ownerCostPhrase(owner);
  const ownerPart = ownerPhrase === null ? '' : `，${ownerPhrase}`;
  if (estimate === null) return { costLine: `消耗：已用 ${turns} 回合，${formatTokenCount(tokens)} token${ownerPart}`, costTurns };
  const spread = SPREAD_ORDER.filter(step => step === 'align' || usage.steps[step].turns > 0)
    .map(step => `${STEP_LABELS[step]} ${usage.steps[step].turns}`).join('，');
  return { costLine: `消耗：${turns} / ${estimate.total} 回合，已用 ${formatTokenCount(tokens)} token${ownerPart}　${spread}`, costTurns };
}

/**
 * 总管唤醒包「你手上的事」里每件事的一行（给模型看，照任务卡逐字）：「消耗：已用 {used} / 预计 {total} 回合」；没有预计「消耗：已用 {used} 回合」。
 * 没有用量行的事按已用 0 回合。
 */
export function chiefCostLine(usage: JobUsage | null, estimate: EstimateVersion | null): string {
  const used = usage === null ? 0 : totalsOf(usage).turns;
  return estimate === null ? `消耗：已用 ${used} 回合` : `消耗：已用 ${used} / 预计 ${estimate.total} 回合`;
}

/**
 * 回执里的「消耗」一行的值（纯函数）：有预计「{实际} 回合，预计 {total}；约 {x} token」，没有「{实际} 回合；约 {x} token」。
 * 实际与 token 取验收（定稿）那一刻的合计：验收之后发布这一步的回合不计入；没有定稿数的旧行按现有合计。
 * 没有用量行时返回 null（回执不加这一行）。
 */
export function receiptCostValue(usage: JobUsage | null, estimate: EstimateVersion | null, ownerRow: OwnerTurnsInput = null): string | null {
  if (usage === null) return null;
  const totals = totalsOf(usage);
  const used = usage.finalUsed ?? totals.turns;
  const tokens = usage.finalTokens ?? totals.tokens;
  // P87：另有「你发起的总管回合」时在末尾加「；另有你发起的 {n} 回合，约 {x} token」。已定稿的读定稿数（没写定稿数按 0），
  // 定稿之后再发生的你发起的回合不改变回执；还没定稿的读现有合计。这一栏为 0 时与原来逐字相同。
  const owner = usage.finalizedAt !== null ? { turns: ownerRow?.finalTurns ?? 0, tokens: ownerRow?.finalTokens ?? 0 } : ownerTotalsOf(ownerRow);
  const ownerPart = owner.turns > 0 ? `；另有你发起的 ${owner.turns} 回合，约 ${formatTokenCount(owner.tokens)} token` : '';
  return `${used} 回合${estimate === null ? '' : `，预计 ${estimate.total}`}；约 ${formatTokenCount(tokens)} token${ownerPart}`;
}
