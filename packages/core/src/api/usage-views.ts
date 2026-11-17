/**
 * 设置页「最近 7 天的用量」表（P76i，方案 7.11）。
 *
 * 范围：最近 7 个本地日（含今天）开始的回合；token 一律按账本里的实测数（tokenBase 向上取整，与分步记账同一口径）。
 * 行：每件在范围内有回合的事一行（回合数、当前预计、实测 token，按 token 从多到少），其后固定三行：
 * 「员工自己发起」「复盘、学习与整理」「你发起的对话」。固定行回合数为 0 时也列出（写 0）。
 *
 * 一个回合只归一行，归属按下面的先后顺序取第一个成立的（三个口径互不重叠）：
 * 1 这个回合已记在某件事的用量行里（jobUsage.turns）：归那件事；
 * 2 技能类回合（复盘、核对、整理，isSkillWork）或学习回合（isLearnWork）：归「复盘、学习与整理」；
 * 3 你发起的、或主题里的回合（isOwnerSide，quota/plan.ts 的现成判断）：归「你发起的对话」；
 * 4 员工自己发起的（isSelfWork，quota/usage.ts 的现成判断）：归「员工自己发起」；
 * 5 其余（总管为你派出而不属于一件事的、团队异常信号、同伴消息等）不进表：它们不属于这四类里的任何一类，
 *   硬塞进某一行会让那一行的口径说不清。
 * 本文件只读存储，不写任何东西。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { latestEstimate } from '../job/estimate.js';
import { isOwnerSide } from '../quota/plan.js';
import { isSelfWork } from '../quota/usage.js';
import { isLearnWork, isSkillWork } from '../skill/keys.js';
import { startOfLocalDay } from '../util/time.js';
import { formatTokenCount } from '../util/token-format.js';

export const WeeklyUsageViewSchema = z.strictObject({
  head: z.tuple([z.literal('事'), z.literal('回合'), z.literal('预计'), z.literal('token')]),
  rows: z.array(z.strictObject({ label: z.string(), turns: z.string(), estimate: z.string(), tokens: z.string() })),
});
export type WeeklyUsageView = z.infer<typeof WeeklyUsageViewSchema>;

/** 固定三行的名字（顺序即显示顺序）。 */
export const FIXED_USAGE_LABELS = ['员工自己发起', '复盘、学习与整理', '你发起的对话'] as const;
const NOT_APPLICABLE = '不适用';

/** 这张唤醒单是否真正投递过（投递失败、投递前被打断的不算回合）；判断与额度记账同一口径，老记录没有 dispatchedAt 时投递中或出错的不猜测。 */
function wasDelivered(wake: WakeTicket, now: number): boolean {
  return wake.dispatchedAt !== null && (wake.dispatchedAt === undefined || wake.dispatchedAt <= now)
    && (wake.dispatchedAt !== undefined || !['delivering', 'error'].includes(wake.status));
}

/** 最近 7 个本地日（含今天）的起点：从今天 0 点起往前退 6 个本地日（每次退到前一天的 0 点，跨夏令时也不会错）。 */
export function weekStartOf(now: number, timezone: string): number {
  let start = startOfLocalDay(now, timezone);
  for (let i = 0; i < 6; i += 1) start = startOfLocalDay(start - 1, timezone);
  return start;
}

/** 最近 7 天的用量表。 */
export function weeklyUsageView(ctx: HubContext): WeeklyUsageView {
  const now = ctx.clock.now();
  const from = weekStartOf(now, ctx.settings.timezone);
  const inRange = (at: number): boolean => at >= from && at <= now;

  // 一、每件事：用量行里开始时间在范围内的回合；同时记下哪些回合已经归了某件事（后面固定行要排除）。
  const jobTurnIds = new Set<string>();
  const jobRows: { label: string; turns: number; estimate: number | null; tokens: number }[] = [];
  for (const usage of ctx.store.table('jobUsage').list()) {
    const turns = usage.turns.filter(turn => inRange(turn.startedAt));
    for (const turn of usage.turns) jobTurnIds.add(turn.wakeId);
    if (turns.length === 0) continue;
    jobRows.push({
      label: ctx.store.table('agreements').get(usage.agreementId)?.title ?? '未命名',
      turns: turns.length, tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
      estimate: latestEstimate(ctx, usage.agreementId)?.total ?? null,
    });
  }
  jobRows.sort((a, b) => b.tokens - a.tokens || b.turns - a.turns || a.label.localeCompare(b.label));

  // 二、固定三行：逐个回合归一行（见文件头的顺序），token 取账本里这张唤醒单的实测数。
  const tokenOf = new Map<string, number>();
  for (const entry of ctx.store.log('ledger').since(from, row => row.kind === 'turn' && row.wakeId !== null)) {
    if (!tokenOf.has(entry.wakeId!)) tokenOf.set(entry.wakeId!, Math.ceil(entry.tokenBase ?? entry.tokens));
  }
  const fixed = { self: { turns: 0, tokens: 0 }, skill: { turns: 0, tokens: 0 }, owner: { turns: 0, tokens: 0 } };
  const roles = new Map(ctx.store.table('bots').list().map(bot => [bot.id, bot.role]));
  for (const wake of ctx.store.table('wakes').list(row => inRange(row.startedAt) && wasDelivered(row, now))) {
    if (jobTurnIds.has(wake.id)) continue;
    const bucket = isSkillWork(wake.reason.kind, wake.subjectKey) || isLearnWork(wake.reason.kind, wake.subjectKey) ? fixed.skill
      : isOwnerSide(wake) ? fixed.owner
        : isSelfWork(wake, roles.get(wake.botId)) ? fixed.self : null;
    if (bucket === null) continue;
    bucket.turns += 1;
    bucket.tokens += tokenOf.get(wake.id) ?? 0;
  }

  const rows: WeeklyUsageView['rows'] = [
    ...jobRows.map(row => ({ label: row.label, turns: String(row.turns), estimate: row.estimate === null ? NOT_APPLICABLE : String(row.estimate),
      tokens: formatTokenCount(row.tokens) })),
    ...([fixed.self, fixed.skill, fixed.owner] as const)
      .map((value, index) => ({ label: FIXED_USAGE_LABELS[index]!, turns: String(value.turns), estimate: NOT_APPLICABLE, tokens: formatTokenCount(value.tokens) })),
  ];
  return { head: ['事', '回合', '预计', 'token'], rows };
}
