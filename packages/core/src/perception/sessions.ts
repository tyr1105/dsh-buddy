/** 外部会话只按明确的关注规则产生感知；不会把所有宿主活动广播给每个机器人。 */
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ExternalSessionEventSchema, type ExternalSessionEvent } from '../model/host.js';
import type { Percept } from '../model/perception.js';
import { recordPercept } from './percept.js';
import { markWatchSatisfied } from './satisfaction.js';

/** 校验宿主会话事件，仅为匹配的关注项产生变化或异常感知。 */
export function onExternalSessionEvent(ctx: HubContext, raw: ExternalSessionEvent): Percept[] {
  const event = parseInput(ExternalSessionEventSchema, raw, '外部会话事件');
  const result: Percept[] = [];
  for (const watch of ctx.store.table('watches').list(w => w.status === 'active' && w.kind === 'session'
    && (w.target === 'any' || event.title.includes(w.target)))) {
    markWatchSatisfied(ctx, watch.id, event.at);
    const percept = recordPercept(ctx, { botId: watch.botId, watchId: watch.id, source: 'session',
      kind: event.type === 'error' ? 'session_error' : 'session_finished', summary: `${event.title}：${event.summary}`,
      location: event.sessionId, fingerprintMaterial: [watch.id, event.sessionId, event.type, event.at], magnitude: 1,
      anomaly: event.type === 'error', untrusted: true, occurredAt: event.at });
    if (percept) result.push(percept);
  }
  return result;
}
