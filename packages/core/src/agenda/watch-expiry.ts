/** 机器人自建关注项有明确寿命：到期停止关注，主人和中心建立的关注项不被自动撤销。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { Watch } from '../model/index.js';

/** 返回本次确实过期的记录，重复 tick 不再发出重复界面变更通知。 */
export function expireWatches(ctx: HubContext, now: number): Watch[] {
  const expired: Watch[] = [];
  for (const watch of ctx.store.table('watches').list(item => item.createdBy === 'bot' && item.status !== 'expired')) {
    const expiresAt = watch.expiresAt ?? watch.createdAt + ctx.settings.botWatchExpiryMs;
    if (expiresAt > now) continue;
    expired.push(ctx.store.table('watches').patch(watch.id, { status: 'expired', expiresAt, updatedAt: now }));
    ctx.emit(HUB_EVENT_SCOPES.bot, watch.botId);
  }
  return expired;
}

export const expireBotWatches = expireWatches;
