/** 期望满足是来源执行成功的事实，独立于感知指纹去重，避免真实更新被当作未出现。 */
import type { HubContext } from '../engine/context.js';
import { newId } from '../util/ids.js';

/** 记录最近满足时刻并保留日报所需事实；重复同一时刻不额外写审计。 */
export function markWatchSatisfied(ctx: HubContext, watchId: string, occurredAt: number): void {
  const watch = ctx.store.table('watches').get(watchId);
  if (!watch?.expectation || watch.expectation.lastSatisfiedAt === occurredAt) return;
  // 晚到的历史事件仍写入真实日期的审计；最新满足时刻不能因此倒退。
  const lastSatisfiedAt = Math.max(watch.expectation.lastSatisfiedAt ?? occurredAt, occurredAt);
  ctx.store.table('watches').patch(watchId, { expectation: { ...watch.expectation, lastSatisfiedAt }, updatedAt: ctx.clock.now() });
  ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: occurredAt, actor: watch.botId,
    action: 'expectation_satisfied', detail: JSON.stringify({ watchId }) });
}
