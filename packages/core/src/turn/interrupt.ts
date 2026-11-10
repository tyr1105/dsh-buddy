/** 主人打断是主动停止，不是机器人故障；先同步记终态，宿主后续结束事件才不会合成未交账。 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { recordUsage } from '../quota/usage.js';
import { removeEntry } from '../scheduler/queue.js';
import { refreshExpectedBy } from '../commit/process.js';
import { postThread } from '../outreach/thread.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { sealLedgerForWake } from '../ledger/service.js';
import { settleInterruptedTopicWake } from '../project/topics.js';

/** 此函数无 await：标记、恢复感知、解绑旧会话与释放投递等待必须先于宿主 cancel。 */
export function interruptWake(ctx: HubContext, wakeId: string, at: number): WakeTicket | null {
  const wake = ctx.store.table('wakes').get(wakeId);
  if (!wake || wake.endedAt !== null || !['running', 'delivering'].includes(wake.status)) return null;
  const canceled = ctx.store.table('wakes').patch(wake.id, {
    status: 'canceled', canceledBy: 'owner', endedAt: at, lastEventAt: Math.max(at, wake.lastEventAt), error: null,
  });
  // 只恢复该回合实际消费的感知；保留评估事实，等下一次有理由唤醒再带上，避免按打断即重启。
  for (const percept of ctx.store.table('percepts').list(p => p.botId === wake.botId && p.consumedByWake === wake.id)) {
    ctx.store.table('percepts').patch(percept.id, { consumedByWake: null, deferredByOwner: true });
  }
  // 投递中还没有消费感知，同样保留这次候选的原始证据，移除旧候选而不删除期间的新消息。
  for (const id of wake.reason.evidence) {
    const percept = ctx.store.table('percepts').get(id);
    if (percept?.botId === wake.botId && percept.consumedByWake === null) {
      ctx.store.table('percepts').patch(id, { deferredByOwner: true, evaluatedAt: percept.evaluatedAt ?? at });
    }
  }
  for (const entry of ctx.store.table('queue').list(q => q.botId === wake.botId && q.enqueuedAt <= wake.startedAt
    && (q.topicId ?? null) === (wake.topicId ?? null)
    && q.reason.kind === wake.reason.kind && q.reason.evidence.every(id => wake.reason.evidence.includes(id)))) removeEntry(ctx, entry.id);
  const bot = ctx.store.table('bots').get(wake.botId)!;
  // TurnEvent 没有 wakeId。下一回合用新工作会话隔离旧 ended/error；界面线程仍是同一个 botId。
  ctx.store.table('bots').patch(bot.id, { sessionId: null, sessionStartedAt: null,
    activity: ['paused', 'retired'].includes(bot.lifecycle) ? 'resting' : 'watching',
    activityText: bot.lifecycle === 'paused' ? '已暂停（你暂停的）' : bot.lifecycle === 'retired' ? '已退役' : '继续关注变化',
    updatedAt: at });
  ctx.runtime.deliveryInterrupts.get(wake.id)?.();
  // 已实际运行的资源照实记账，但不调用故障/未交账/隔离收尾；纯投递占位不虚增用量。
  if (wake.status === 'running' || wake.dispatchedAt != null) recordUsage(ctx, { botId: wake.botId, wakeId: wake.id,
    tokens: wake.tokensKnown ? wake.tokens : null, steps: wake.steps, packetBytes: wake.packetBytes });
  refreshExpectedBy(ctx, wake.botId);
  // P63：主题回合的说明落回主题；主题里不会自动续上，要主人再点它一次。
  postThread(ctx, { thread: wake.topicId ?? wake.botId, from: 'hub', kind: 'system',
    text: wake.topicId ? '你打断了它。想让它接着说，再 @ 它一次就行。' : '你打断了它；它会在下次醒来时接着处理', refId: wake.id });
  settleInterruptedTopicWake(ctx, canceled);
  writeOutreachAudit(ctx, 'owner_interrupted', { botId: wake.botId, wakeId: wake.id }, 'owner', at);
  // 打断是明确的终态，账本必须同步收口；投递中还没有开账的唤醒没有账本行，直接跳过。
  try { sealLedgerForWake(ctx, wake.id); }
  catch (error) { try { ctx.logger.error('打断后封存唤醒账本失败', error); } catch { /* 账本故障不阻断打断。 */ } }
  ctx.emit(HUB_EVENT_SCOPES.bot, wake.botId);
  ctx.emit(HUB_EVENT_SCOPES.activity, wake.botId);
  return canceled;
}
