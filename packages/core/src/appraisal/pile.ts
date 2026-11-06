/** 将尚未消费的小变化合并成一次思考理由，避免零碎变化各自占用回合。 */
import type { HubContext } from '../engine/context.js';
import { buildCandidate } from './think.js';
import type { Candidate } from './think.js';
/** 合并未消费的小变化，仅在总分够高时生成带完整证据的候选。 */
export function evaluatePile(ctx: HubContext, botId: string, now: number): Candidate | null {
  const rows = ctx.store.table('percepts').list(p => p.botId === botId && p.tier === 'pile' && p.consumedByWake === null
    && p.discardedAt === undefined && !p.deferredByOwner && p.createdAt <= now);
  const settings = ctx.settings;
  if (rows.reduce((sum, row) => sum + row.salience, 0) < settings.pileSalienceSum) return null;
  const score = Math.min(settings.pileScoreMax, settings.pileScoreBase + settings.pileScorePerExtra * (rows.length - settings.pileBaseCount));
  return buildCandidate(ctx, { botId, kind: 'pile', score, summary: `${rows.length} 条待处理变化合计达到门槛`, evidence: rows.map(row => row.id), now });
}
