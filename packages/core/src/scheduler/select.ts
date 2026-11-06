/** 选择只是决策：返回第一个过闸者，成功投递后的移出与探针消耗由 C04 负责。 */
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/index.js';
import { listQueue, removeEntry } from './queue.js';
import { buildSnapshot, evaluateGates } from './gates.js';
import { explainSuppression, logAppraisal } from '../appraisal/log.js';
import { rollWindow } from '../quota/window.js';
import { discardRelatedPercepts } from './percept-consumption.js';
import { ownerReasonSummary } from '../util/owner-text.js';
/** 遍历候选并记录被拦原因，只选择可放行项而不提前消费队列。 */
export function selectNext(ctx: HubContext, now: number): QueueEntry | null {
  // 事件入口也会选择候选，不能要求它一定先经过下一次 tick 才滚动过期额度。
  rollWindow(ctx, now);
  for (const entry of listQueue(ctx)) {
    const snapshot = buildSnapshot(ctx, entry.botId, now);
    const gate = evaluateGates(entry, snapshot, now, ctx.settings);
    if (gate.pass) return entry;
    // 本轮感知可能刚刷新过原始期限；拦截时同步保存延后，防止健康步骤早于 pump 的时间缝误报。
    if (!gate.drop && snapshot.bot?.expectedBy != null) ctx.store.table('bots').patch(entry.botId, {
      expectedBy: Math.max(snapshot.bot.expectedBy, (gate.until ?? now + ctx.settings.tickMs) + ctx.settings.deadmanGraceMs),
    });
    const key = `${entry.botId}:${gate.by}`;
    const last = ctx.runtime.suppressionLogAt.get(key);
    if (last === undefined || now - last >= ctx.settings.c02.suppressionLogMs) {
      logAppraisal(ctx, { botId: entry.botId, at: now, perceptIds: entry.reason.evidence, score: entry.reason.score,
        threshold: entry.reason.threshold, decision: 'suppressed', suppressedBy: gate.by, until: gate.until,
        text: explainSuppression(entry, gate.by, gate.until, now, ctx.settings.timezone, snapshot.todayTurns, ownerReasonSummary(entry.reason, ctx)) });
      ctx.runtime.suppressionLogAt.set(key, now);
    }
    if (gate.drop) {
      // 暂停保留主人消息供恢复处理；等主人同一事项则已作出明确丢弃决定。
      if (gate.by === 'waiting_owner_same_subject') discardRelatedPercepts(ctx, entry, now);
      removeEntry(ctx, entry.id);
    }
  }
  return null;
}
