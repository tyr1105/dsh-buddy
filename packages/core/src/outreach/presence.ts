/**
 * 主人上次打开的读写（P76i，方案 7.9）：表 ownerPresence（一行，id 固定为 owner）。
 *
 * 做什么：
 * - ownerSeen：界面在页面可见时上报「你正在看」（打开时一次、之后每 5 分钟一次）。
 *   第一次上报只记时间；距上次上报超过 AWAY_SUMMARY_MS（8 小时）就按 [上次上报, 现在] 生成离开期间摘要（覆盖旧的），
 *   再把上次上报时间更新为现在；不到 8 小时只更新时间。
 * - dismissAwaySummary：你点「收起」，写 dismissedAt；没有摘要时什么都不做。
 *
 * 为什么由界面上报：中心自己看不到你有没有在看界面（内存里的 runtime.ownerActiveAt 只在你发消息、确认约定时更新，用途不同，保留不动）。
 * 摘要只按记录拼文字：不调用模型、不落消息、不推送（away.notified 恒为 false，保留给以后）。
 * 时间全部来自注入的 Clock。
 */
import type { HubContext } from '../engine/context.js';
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import type { OwnerPresence } from '../model/presence.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { awayInputOf } from '../api/away-input.js';
import { buildAwaySummary } from '../api/away-views.js';

/** 读上次打开记录；没有（从没上报过）返回 null。 */
export function getPresence(ctx: HubContext): OwnerPresence | null {
  return ctx.store.table('ownerPresence').get('owner');
}

/** 上报一次「你正在看」。返回这次是否生成了新的离开期间摘要。 */
export function ownerSeen(ctx: HubContext): { generated: boolean } {
  const now = ctx.clock.now();
  const existing = getPresence(ctx);
  const lastSeenAt = existing?.lastSeenAt ?? null;
  // 离开够久才生成：now 小于 lastSeenAt（时钟回拨）时差为负，只更新时间。
  const away = lastSeenAt !== null && now - lastSeenAt >= BUDGET_DEFAULTS.AWAY_SUMMARY_MS
    ? buildAwaySummary(awayInputOf(ctx, lastSeenAt, now, now)) : null;
  ctx.store.table('ownerPresence').put({
    id: 'owner', lastSeenAt: now,
    away: away === null ? existing?.away ?? null
      : { from: lastSeenAt!, to: now, lines: away.lines, totalTurns: away.totalTurns, totalTokens: away.totalTokens, notified: false, dismissedAt: null },
    updatedAt: now,
  });
  ctx.emit(HUB_EVENT_SCOPES.presence, null);
  return { generated: away !== null };
}

/** 收起离开期间摘要。返回是否真的收起了（没有摘要或已收起过返回 false，什么都不改）。 */
export function dismissAwaySummary(ctx: HubContext): boolean {
  const existing = getPresence(ctx);
  if (existing === null || existing.away === null || existing.away.dismissedAt !== null) return false;
  const now = ctx.clock.now();
  ctx.store.table('ownerPresence').put({ ...existing, away: { ...existing.away, dismissedAt: now }, updatedAt: now });
  ctx.emit(HUB_EVENT_SCOPES.presence, null);
  return true;
}
