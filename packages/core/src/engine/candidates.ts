/** 把新感知与小变化堆接到统一候选队列；已评估证据不在每分钟重复写日志。 */
import { onDemandBlocks } from '../scheduler/on-demand.js';
import type { HubContext } from './context.js';
import type { Percept, QueueEntry, WakeKind } from '../model/index.js';
import { buildCandidate, type Candidate } from '../appraisal/think.js';
import { evaluatePile } from '../appraisal/pile.js';
import { enqueue } from '../scheduler/queue.js';
import { stableStringify } from '../util/hash.js';
import { refreshExpectedBy } from '../commit/process.js';

/** 评估游标存回感知；内存只缓存每个机器人当前候选，不随历史事项数量增长。 */
export function createCandidateCollector(ctx: HubContext) {
  const decisions = new Map<string, { subjectKey: string; signature: string }>();
  let legacyRecovered = false;
  /** 升级前的记录没有评估标记，只从已落盘的明确决定恢复；“等待候选评估”不算评估完成。 */
  function recoverLegacy(now: number): void {
    if (legacyRecovered) return;
    const pending = new Set(ctx.store.table('percepts').list(p => p.evaluatedAt === undefined
      && p.consumedByWake === null && p.createdAt <= now).map(p => p.id));
    const affectedBots = new Set<string>();
    // 现存队列是较新的待办事实，不能拿更早的一次拒绝覆盖它。
    for (const entry of ctx.store.table('queue').list()) for (const id of entry.reason.evidence) if (pending.has(id)) {
      ctx.store.table('percepts').patch(id, { evaluatedAt: entry.enqueuedAt });
      pending.delete(id);
    }
    for (const log of ctx.store.log('appraisals').all().reverse()) {
      if (log.at > now || !['suppressed', 'woke', 'record_only'].includes(log.decision)) continue;
      for (const id of log.perceptIds) if (pending.has(id)) {
        const percept = ctx.store.table('percepts').get(id)!;
        affectedBots.add(percept.botId);
        ctx.store.table('percepts').patch(id, { evaluatedAt: log.at,
          ...(log.suppressedBy === 'waiting_owner_same_subject'
            || (log.decision === 'suppressed' && log.suppressedBy === null && log.score < log.threshold)
            ? { discardedAt: log.at } : {}) });
        pending.delete(id);
      }
    }
    for (const botId of affectedBots) refreshExpectedBy(ctx, botId);
    legacyRecovered = true;
  }
  /** 同一份时间理由只入队一次；理由或门槛改变时重新评估。 */
  function offer(candidate: Candidate): QueueEntry | null {
    const signature = stableStringify({ ...candidate, notBefore: 0 });
    // P63：这里只管自主候选，排队中的主题回合是另一件事，不能让它冒充「这条候选已在排队」。
    const existing = ctx.store.table('queue').list(q => q.botId === candidate.botId && !q.topicId)[0];
    const previous = decisions.get(candidate.botId);
    if (previous?.subjectKey === candidate.subjectKey && previous.signature === signature && existing) return existing;
    const queued = enqueue(ctx, candidate);
    if (queued) decisions.set(candidate.botId, { subjectKey: candidate.subjectKey, signature });
    else decisions.delete(candidate.botId);
    return queued;
  }
  /** 感知来源决定理由类型，外部文字不能自行声明主人身份。 */
  function kindFor(p: Percept): WakeKind {
    if (p.source === 'owner' && p.kind === 'owner_message') return 'owner_message';
    if (p.source === 'inbox' && p.kind === 'inbox_reply') return 'inbox_reply';
    if (p.source === 'inbox' && p.kind === 'approval_decided') return 'approval_decided';
    if (p.kind === 'expectation_missed') return 'percept';
    if (p.source === 'peer') return 'peer_message';
    return 'percept';
  }
  /** 每条感知只评估一次；队列和处理标记一同落盘，重启不会复活旧的拒绝决定。 */
  function collect(now: number): void {
    recoverLegacy(now);
    const active = ctx.store.table('bots').list(b => ['active', 'probation'].includes(b.lifecycle));
    const ids = new Set(active.map(b => b.id));
    // 出队、退役或被清理后移除缓存；每个机器人最多一条，不保留感知 id 集合。
    const queuedIds = new Set(ctx.store.table('queue').list(q => !q.topicId).map(q => q.botId));
    for (const botId of decisions.keys()) if (!ids.has(botId) || !queuedIds.has(botId)) decisions.delete(botId);
    for (const p of ctx.store.table('percepts').list(p => p.consumedByWake === null && p.evaluatedAt === undefined
      && p.discardedAt === undefined && !p.deferredByOwner && p.createdAt <= now)) {
      if (!ids.has(p.botId)) continue;
      // P55：听吩咐的队友不因外界变化醒来；这条事实留着，下次被叫醒时一起看。
      const blocked = active.some(bot => bot.id === p.botId && onDemandBlocks(bot, kindFor(p)));
      const candidate = !blocked && (p.tier === 'urgent' || p.tier === 'candidate') ? buildCandidate(ctx, {
        botId: p.botId, kind: kindFor(p), score: p.salience, summary: p.summary || p.kind,
        evidence: [p.id], watchId: p.watchId, source: p.source, perceptKind: p.kind,
        urgent: p.tier === 'urgent', anomaly: p.anomaly, now,
      }) : null;
      const rejected = candidate !== null && offer(candidate) === null;
      // 门槛拒绝已是这份事实的处理结果；不能留作次日或重启后的隐形紧急预约。
      ctx.store.table('percepts').patch(p.id, { evaluatedAt: now, ...(rejected ? { discardedAt: now } : {}) });
      refreshExpectedBy(ctx, p.botId);
    }
    for (const bot of active) {
      if (bot.onDemand) continue;
      const pile = evaluatePile(ctx, bot.id, now);
      if (pile) offer(pile);
    }
  }
  // 暴露当前缓存量供中心诊断；它只应随在队机器人数量变化，不随历史消息增长。
  return { collect, offer, restore: recoverLegacy, get cachedDecisionCount() { return decisions.size; } };
}
