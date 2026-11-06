/** 到期轮询采用有限工作池；每个关注项单独兜底，失败不会阻塞其他机器人的感知。 */
import type { HubContext } from '../engine/context.js';
import type { Percept, Watch } from '../model/perception.js';
import { raiseAlert, closeAlert } from '../health/alerts.js';
import { pollHttp } from './http.js';
import { pollRss } from './rss.js';
import { pollScript } from './script.js';
import { encodeWatchState, readWatchState } from './watch-state.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';

/** 保留旧基线并累计失败，达到阈值才告警避免偶发错误反复打扰。 */
export function recordWatchError(ctx: HubContext, watch: Watch, error: unknown, now: number): void {
  const current = ctx.store.table('watches').get(watch.id) ?? watch;
  const state = readWatchState(current);
  const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
  const lastError = error instanceof Error ? error.message : String(error);
  ctx.store.table('watches').patch(watch.id, { lastCheckedAt: now, updatedAt: now,
    lastValue: encodeWatchState(ctx, { ...state, consecutiveFailures, lastError }) });
  ctx.emit(HUB_EVENT_SCOPES.bot, watch.botId);
  ctx.logger.warn(`关注项 ${watch.id} 执行失败：${lastError}`);
  if (consecutiveFailures >= ctx.settings.c02.watchFailureAlertCount) raiseAlert(ctx, {
    code: `watch_failed:${watch.id}`, botId: watch.botId, text: `关注项连续 ${consecutiveFailures} 次失败：${lastError}`,
    level: 'P2', immediate: true,
  });
}
/** 用有限并发执行到期关注项，各项独立捕获错误以保护其他机器人。 */
export async function pollDueWatches(ctx: HubContext, now: number): Promise<Percept[]> {
  const due = ctx.store.table('watches').list(w => w.status === 'active' && ['http', 'rss', 'script'].includes(w.kind)
    && (w.lastCheckedAt === null || now >= w.lastCheckedAt + Math.max(w.intervalMs ?? 0,
      w.kind === 'script' ? ctx.settings.scriptMinIntervalMs : ctx.settings.httpMinIntervalMs)));
  const results: Percept[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < due.length) {
      const watch = due[next++]!;
      try {
        const percept = await (watch.kind === 'http' ? pollHttp(ctx, watch, now) : watch.kind === 'rss' ? pollRss(ctx, watch, now) : pollScript(ctx, watch, now));
        if (percept) results.push(percept);
        closeAlert(ctx, `watch_failed:${watch.id}`, watch.botId);
      } catch (error) { recordWatchError(ctx, watch, error, now); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(due.length, ctx.settings.c02.pollConcurrency) }, worker));
  return results;
}
