/** 同一事项的感知一起收尾：明确丢弃与真实唤醒分开记账，避免旧紧急变化反复触发死人开关。 */
import type { HubContext } from '../engine/context.js';
import type { Percept, QueueEntry } from '../model/index.js';
import { computeExpectedBy } from '../health/deadman.js';

/** 以可信来源和关联记录恢复事项键，外部正文不能决定自己属于哪个主人请求。 */
export function perceptSubject(ctx: HubContext, percept: Percept): string {
  if (percept.source === 'inbox' && percept.location) {
    const item = ctx.store.table('inbox').get(percept.location);
    if (item?.botId === percept.botId) return item.subjectKey;
  }
  if (percept.source === 'owner' && percept.kind === 'owner_message') return `owner:${percept.location ?? percept.id}`;
  return percept.watchId ? `watch:${percept.watchId}` : `src:${percept.source}:${percept.kind}`;
}

/** 不跨机器人、不消费放行之后的新事实；合并候选的每个证据来源都能带上同事项积压。 */
function relatedPercepts(ctx: HubContext, entry: QueueEntry, now: number): Percept[] {
  const evidence = new Set(entry.reason.evidence);
  const subjects = new Set([entry.subjectKey]);
  const watches = new Set<string>();
  for (const id of evidence) {
    const percept = ctx.store.table('percepts').get(id);
    if (percept?.botId === entry.botId) {
      subjects.add(perceptSubject(ctx, percept));
      if (percept.watchId) watches.add(percept.watchId);
    }
    const item = ctx.store.table('inbox').get(id);
    if (item?.botId === entry.botId) subjects.add(item.subjectKey);
  }
  return ctx.store.table('percepts').list(p => p.botId === entry.botId && p.consumedByWake === null && p.createdAt <= now
    && (evidence.has(p.id) || subjects.has(perceptSubject(ctx, p)) || (p.watchId !== null && watches.has(p.watchId))));
}

/** 消费或丢弃后立即移除已处理紧急事实形成的旧截止时间。 */
function refreshDeadline(ctx: HubContext, botId: string): void {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) return;
  const urgent = ctx.store.table('percepts').list(p => p.botId === botId && p.tier === 'urgent'
    && p.consumedByWake === null && p.discardedAt === undefined && !p.deferredByOwner);
  ctx.store.table('bots').patch(botId, { expectedBy: computeExpectedBy(bot,
    urgent.length ? Math.min(...urgent.map(p => p.createdAt)) : null, ctx.settings) });
}

/** 只有宿主实际接收唤醒后才写 consumedByWake，失败投递保留完整待处理事实。 */
export function consumeRelatedPercepts(ctx: HubContext, entry: QueueEntry, wakeId: string, now: number): void {
  for (const percept of relatedPercepts(ctx, entry, now)) ctx.store.table('percepts').patch(percept.id,
    { consumedByWake: wakeId, evaluatedAt: percept.evaluatedAt ?? now });
  refreshDeadline(ctx, entry.botId);
}

/** 等主人同一件事已明确丢弃，持久化处理标记，不制造一次并不存在的回合。 */
export function discardRelatedPercepts(ctx: HubContext, entry: QueueEntry, now: number): void {
  for (const percept of relatedPercepts(ctx, entry, now)) ctx.store.table('percepts').patch(percept.id,
    { discardedAt: percept.discardedAt ?? now, evaluatedAt: percept.evaluatedAt ?? now });
  refreshDeadline(ctx, entry.botId);
}
