/**
 * 每日成本只汇总已结账事实，包含主人发起的消耗，不能复用排除此类回合的自主预算。
 * 保存宿主/估算基数与记账值两个口径；旧日志来源未知，绝不按当前倍率倒推历史。
 */
import type { HubContext } from '../engine/context.js';
import type { LedgerEntry } from '../model/index.js';
import { C04_DEFAULTS } from '../config/defaults.js';
import { localDateKey, startOfLocalDay } from '../util/time.js';

export interface CostTotals {
  turns: number;
  ownerTurns: number;
  unknownOwnerTurns: number;
  tokens: number;
  hostTokens: number;
  estimatedTokens: number;
  unknownTokens: number;
  unknownMeasurements: number;
  pending: number;
}
export interface CostBotRow extends CostTotals {
  botId: string;
  name: string;
  archived: boolean;
}
export interface DailyCostView {
  date: string;
  total: CostTotals;
  bots: CostBotRow[];
}
export interface CostView {
  asOf: number;
  timezone: string;
  days: DailyCostView[];
  projectStatus: 'unallocated';
}

const empty = (): CostTotals => ({ turns: 0, ownerTurns: 0, unknownOwnerTurns: 0, tokens: 0,
  hostTokens: 0, estimatedTokens: 0, unknownTokens: 0, unknownMeasurements: 0, pending: 0 });

/** 已记录的主人标志优先；老账只有仍存在的唤醒单能证明发起者。 */
function addEntry(ctx: HubContext, total: CostTotals, entry: LedgerEntry): void {
  total.tokens += entry.tokens;
  if (entry.kind === 'turn') {
    total.turns += 1;
    const owner = entry.ownerInitiated ?? (entry.wakeId ? ctx.store.table('wakes').get(entry.wakeId)?.ownerInitiated : undefined);
    if (owner === true) total.ownerTurns += 1;
    else if (owner === undefined) total.unknownOwnerTurns += 1;
  }
  if (entry.tokenBase !== undefined && entry.tokenSource === 'host') total.hostTokens += entry.tokenBase;
  else if (entry.tokenBase !== undefined && entry.tokenSource === 'estimate') total.estimatedTokens += entry.tokenBase;
  else { total.unknownTokens += entry.tokens; total.unknownMeasurements += 1; }
}

/** 七个日历日逐日找午夜，夏令时或时区变化都不使用固定 24 小时推算午夜。 */
export function costView(ctx: HubContext, now: number): CostView {
  const timezone = ctx.settings.timezone;
  const rows = ctx.store.table('bots').list();
  const dayCount = C04_DEFAULTS.STATS_WINDOW_MS / (24 * 60 * 60 * 1_000);
  const days: DailyCostView[] = [];
  let start = startOfLocalDay(now, timezone);
  let end = now;
  const entries = ctx.store.log('ledger').all().filter(row => row.who !== 'owner' && row.at <= now);
  const settled = new Set(entries.filter(row => row.kind === 'turn').map(row => row.wakeId));
  // committed 可以早于回合 ended：最终结账前仍显示在途。投递失败没有消费事实，不算运行。
  const pending = ctx.store.table('wakes').list(row => row.startedAt <= now && row.endedAt === null
    && row.dispatchedAt !== null && (row.dispatchedAt !== undefined || ['running', 'committed'].includes(row.status))
    && (row.dispatchedAt === undefined || row.dispatchedAt <= now) && !settled.has(row.id));
  for (let index = 0; index < dayCount; index += 1) {
    const bots = new Map(rows.filter(bot => bot.createdAt <= end).map(bot => [bot.id, {
      ...empty(), botId: bot.id, name: bot.name, archived: bot.lifecycle === 'retired',
    }]));
    const total = empty();
    const rowFor = (botId: string): CostBotRow => {
      let row = bots.get(botId);
      if (!row) {
        const known = rows.find(bot => bot.id === botId);
        row = { ...empty(), botId, name: known?.name ?? botId, archived: true };
        bots.set(botId, row);
      }
      return row;
    };
    for (const entry of entries.filter(row => row.at >= start && row.at <= end)) {
      addEntry(ctx, total, entry);
      addEntry(ctx, rowFor(entry.who), entry);
    }
    // 成本归结账日；在途只展示今天，不给昨天的未结账回合伪造费用。
    if (index === 0) for (const wake of pending) {
      total.pending += 1;
      rowFor(wake.botId).pending += 1;
    }
    days.push({ date: localDateKey(start, timezone), total,
      bots: [...bots.values()].sort((a, b) => b.tokens - a.tokens || a.botId.localeCompare(b.botId)) });
    end = start - 1;
    start = startOfLocalDay(end, timezone);
  }
  return { asOf: now, timezone, days, projectStatus: 'unallocated' };
}
