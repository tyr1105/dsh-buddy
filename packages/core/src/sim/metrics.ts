/** 仿真指标从中心事实表重新计算，不依赖大脑自报成功；推送时段使用注入设置的时区和免打扰窗口。 */
import { coefficientOfVariation } from '../util/stats.js';
import { isInQuietHours, localDateKey } from '../util/time.js';
import type { WakeKind } from '../model/index.js';
import { readAuditDetail } from '../outreach/audit.js';
import type { PushAudit } from '../outreach/push.js';
import type { SimWorld } from './runner.js';

export interface BotMetrics {
  botId: string;
  turns: number;
  intervalsMs: number[];
  intervalCv: number | null;
  selfPacedRatio: number | null;
  selfInitiated: number;
  /** 主人发起回合不计预算；仍在 turns 总数中保留。 */
  turnsByDay: Record<string, number>;
  reasons: Partial<Record<WakeKind, number>>;
}
export interface SimulationMetrics {
  elapsedMs: number;
  bots: BotMetrics[];
  pushes: { daytime: number; quiet: number; quietP0: number; byDay: Record<string, { daytime: number; quiet: number; quietP0: number }> };
  /** 宿主实际通知含日报；单推预算指标 pushes 单独计算，不混入每天一次的日报。 */
  notifications: SimulationMetrics['pushes'];
  digests: number;
  reasons: Partial<Record<WakeKind, number>>;
  maxRunning: number;
}

/** 给分组计数累加一条事实，空分组不制造无意义的键。 */
function count<T extends string>(target: Partial<Record<T, number>>, key: T): void {
  target[key] = (target[key] ?? 0) + 1;
}

/** 按免打扰窗口汇总某组已发生通知，P0 另计以便核对例外。 */
function periods(world: SimWorld, rows: Array<{ at: number; level: string }>): SimulationMetrics['pushes'] {
  const result: SimulationMetrics['pushes'] = { daytime: 0, quiet: 0, quietP0: 0, byDay: {} };
  for (const row of rows) {
    const key = localDateKey(row.at, world.settings.timezone);
    const day = result.byDay[key] ??= { daytime: 0, quiet: 0, quietP0: 0 };
    if (isInQuietHours(row.at, world.settings.quietHours, world.settings.timezone)) {
      result.quiet += 1;
      day.quiet += 1;
      if (row.level === 'P0') { result.quietP0 += 1; day.quietP0 += 1; }
    } else { result.daytime += 1; day.daytime += 1; }
  }
  return result;
}

/** 计算整个实验期间的回合、节奏、意图、自发事项、推送与理由分布。 */
export function metrics(world: SimWorld): SimulationMetrics {
  const { store, settings, startAt, host } = world;
  const now = world.clock.now();
  const wakes = store.table('wakes').list(w => w.startedAt >= startAt && w.startedAt <= now && w.dispatchedAt !== null);
  const allReasons: Partial<Record<WakeKind, number>> = {};
  const bots = store.table('bots').list().map(bot => {
    const turns = wakes.filter(w => w.botId === bot.id).sort((a, b) => a.startedAt - b.startedAt);
    const intervalsMs = turns.slice(1).map((wake, index) => wake.startedAt - turns[index]!.startedAt);
    const commits = turns.filter(w => !w.syntheticCommit).flatMap(w => {
      const commit = w.commitId ? store.table('commits').get(w.commitId) : null;
      return commit ? [commit] : [];
    });
    const turnsByDay: Record<string, number> = {};
    const reasons: Partial<Record<WakeKind, number>> = {};
    for (const wake of turns) {
      count(reasons, wake.reason.kind);
      count(allReasons, wake.reason.kind);
      if (!wake.ownerInitiated) count(turnsByDay, localDateKey(wake.startedAt, settings.timezone));
    }
    const agendaCount = store.table('agenda').count(a => a.botId === bot.id && a.source === 'bot' && a.createdAt >= startAt && a.createdAt <= now);
    // 提议在收件箱只有一份事实；不能同时累加 Commit.proposals 而重复计算同一条建议。
    const proposalCount = store.table('inbox').count(i => i.botId === bot.id && i.type === 'proposal' && i.createdAt >= startAt && i.createdAt <= now);
    return { botId: bot.id, turns: turns.length, intervalsMs, intervalCv: intervalsMs.length < 2 ? null : coefficientOfVariation(intervalsMs),
      selfPacedRatio: commits.length ? commits.filter(c => c.nextThink.mode !== 'auto').length / commits.length : null,
      selfInitiated: agendaCount + proposalCount, turnsByDay, reasons };
  });
  const audit = store.log('audit').since(startAt, row => row.at <= now);
  const sent = audit.filter(row => row.action === 'push').flatMap(row => {
    const detail = readAuditDetail<PushAudit>(row.detail);
    return detail?.result === 'sent' ? [{ at: row.at, level: detail.level }] : [];
  });
  return { elapsedMs: now - startAt, bots, pushes: periods(world, sent),
    notifications: periods(world, host.notifications.filter(row => row.at >= startAt && row.at <= now)),
    digests: audit.filter(row => row.action === 'digest_sent').length, reasons: allReasons, maxRunning: host.maxRunning };
}
