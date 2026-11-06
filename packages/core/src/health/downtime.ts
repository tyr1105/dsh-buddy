/** 停机与睡眠是时间证据；补课只生成一次候选，真正放行仍交给调度闸门。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { Downtime } from '../model/operations.js';
import { buildCandidate, type Candidate } from '../appraisal/think.js';
import { newId } from '../util/ids.js';
import { formatDuration } from '../util/time.js';
import { readLastHeartbeat } from './heartbeat.js';

/** 重复启动观察到同一段历史时复用记录，避免生成多份补课。 */
function recordDowntime(ctx: HubContext, from: number, to: number, kind: Downtime['kind']): Downtime {
  const previous = ctx.store.table('downtime').list(item => item.kind === kind && item.from === from && item.to === to)[0];
  if (previous) return previous;
  const downtime: Downtime = { id: newId('d', ctx.rng), from, to, kind, handled: false };
  ctx.store.table('downtime').put(downtime);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  return downtime;
}

/** 读取上次心跳判定宿主停机，仅超过容忍间隔才记录停机证据。 */
export async function detectDowntimeOnStart(ctx: HubContext, now: number): Promise<Downtime | null> {
  const heartbeat = await readLastHeartbeat(ctx);
  if (!heartbeat || now - heartbeat.at <= ctx.settings.hostDownAfterMs) return null;
  return recordDowntime(ctx, heartbeat.at, now, 'host_down');
}

/** 本次调用就是 tick 时间锚点；小间隔也更新，以便下一次只计算真实两次 tick 之差。 */
export function detectSleep(ctx: HubContext, now: number): Downtime | null {
  const previous = ctx.runtime.lastTickAt;
  ctx.runtime.lastTickAt = now;
  if (previous === null || now - previous <= ctx.settings.sleepGapMs) return null;
  return recordDowntime(ctx, previous, now, 'sleep');
}

/** handled 是“已收集补课”的幂等标记；暂停、草稿和已退役机器人不安排补课。 */
export function catchUpCandidates(ctx: HubContext, downtime: Downtime, now: number): Candidate[] {
  if (downtime.handled || ctx.store.table('downtime').get(downtime.id)?.handled) return [];
  const result: Candidate[] = [];
  if (downtime.to - downtime.from >= ctx.settings.catchUpAfterMs) {
    for (const bot of ctx.store.table('bots').list(item => item.lifecycle === 'active' || item.lifecycle === 'probation')) {
      const percepts = ctx.store.table('percepts').list(item => item.botId === bot.id && item.createdAt >= downtime.from
        && item.createdAt <= now && item.consumedByWake === null);
      result.push(buildCandidate(ctx, { botId: bot.id, kind: 'catch_up', variant: 'catch_up', score: ctx.settings.c02.catchUpScore,
        summary: `DSH 停了 ${formatDuration(downtime.to - downtime.from)}，补看期间变化`,
        ownerSummary: `停机 ${formatDuration(downtime.to - downtime.from)}，补看期间的变化`,
        evidence: [downtime.id, ...percepts.map(item => item.id)], subjectKey: `downtime:${downtime.id}`, now }));
    }
  }
  ctx.store.table('downtime').put({ ...downtime, handled: true });
  return result;
}
