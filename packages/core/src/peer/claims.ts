/** 资源认领锁：同一资源只保留一个有效持有者，重复认领只能延长自己的锁。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, positive } from '../model/primitives.js';
import { ClaimSchema, type Claim } from '../model/team.js';
import { newId } from '../util/ids.js';
import { formatShort } from '../util/time.js';
import { peerBot } from './common.js';
export const ClaimInputSchema = z.strictObject({ resource: nonempty, minutes: positive.optional(), why: nonempty });
export type ClaimResult = {
    ok: true;
    claim: Claim;
    text: string;
} | {
    ok: false;
    holder: Claim;
    text: string;
};
/** 校验并创建或续期自己的资源锁；资源由他人持有时明确返回持有人。 */
export function claim(ctx: HubContext, botId: string, input: z.infer<typeof ClaimInputSchema>): ClaimResult {
    const args = parseInput(ClaimInputSchema, input, '认领');
    peerBot(ctx, botId);
    const now = ctx.clock.now();
    expireClaims(ctx, now);
    const duration = args.minutes === undefined ? ctx.settings.claimDefaultMs : args.minutes * 60000;
    if (duration > ctx.settings.claimMaxMs)
        throw new Error(`minutes：认领时长不能超过 ${ctx.settings.claimMaxMs / 60000} 分钟`);
    const old = ctx.store.table('claims').list(row => row.resource === args.resource)[0];
    if (old && old.botId !== botId)
        return { ok: false, holder: old, text: `资源已由 ${peerBot(ctx, old.botId).name} 认领，到期：${formatShort(old.expiresAt, now, ctx.settings.timezone)}` };
    const row = ClaimSchema.parse({ id: old?.id ?? newId('cl', ctx.rng), resource: args.resource, botId, why: args.why,
        expiresAt: now + duration, createdAt: old?.createdAt ?? now });
    ctx.store.table('claims').put(row);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return { ok: true, claim: row, text: `已认领 ${args.resource}，到期：${formatShort(row.expiresAt, now, ctx.settings.timezone)}` };
}
/** 只允许持有人释放有效认领锁，避免一个机器人解除他人的互斥保护。 */
export function release(ctx: HubContext, botId: string, resource: string): boolean {
    parseInput(nonempty, resource, 'resource');
    peerBot(ctx, botId);
    const row = ctx.store.table('claims').list(item => item.resource === resource && item.expiresAt > ctx.clock.now())[0];
    if (!row)
        return false;
    if (row.botId !== botId)
        throw new Error('resource：不能释放其他机器人的认领锁');
    ctx.store.table('claims').remove(row.id);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return true;
}
/** 移除显式时间之前到期的认领锁，让资源能够被后续任务重新使用。 */
export function expireClaims(ctx: HubContext, now: number): void {
    parseInput(z.number().int(), now, '当前时间');
    for (const row of ctx.store.table('claims').list(item => item.expiresAt <= now))
        ctx.store.table('claims').remove(row.id);
}
